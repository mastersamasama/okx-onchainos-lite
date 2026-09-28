#!/usr/bin/env node
// Parity runner: upstream CLI (built with its API origin = this proxy) vs lite.
//
//   node test/parity/run.mjs [--cases <glob-substring>] [--id <case-id>] [--mode both|record|replay] [--json]
//
// Case files: test/parity/cases/*.json → [{ id, argv, home?, network?, fixtures?, masks?, stdin?, timeoutMs?, env? }]
//   home     : template dir under test/parity/homes (default "anon" = empty state)
//   network  : "real" (default) forward read-only endpoints to the real API | "fixture" never forward
//   fixtures : fixture file names under test/parity/fixtures (answers for non-forwarded endpoints)
//   masks    : paths masked before comparison, e.g. "stdout.data.timestamp", "req.body.nonce", "home.session.json.x"
//   exact    : true | ["stdout","stderr"] — also compare raw stdout bytes / stderr text
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, cpSync, existsSync, statSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createProxy } from './proxy.mjs';
import { comparableRequest, applyMasks, sortKeysAt, DEFAULT_HOME_MASKS } from './canon.mjs';
import { wsSettle, compareWs, normalizeWatchSnapshot, loadWsFixture, maskHomePath } from './ws-proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const UPSTREAM_BIN = process.env.PARITY_UPSTREAM_BIN || join(ROOT, '.cache', 'bin', process.platform === 'win32' ? 'onchainos-4.6.3-proxy.exe' : 'onchainos-4.6.3-proxy');
const LITE = join(ROOT, 'skill', 'onchainos-lite', 'bin', 'ocl.mjs');
const PORT = 18899;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
// auto: record only when the cassette is missing or the case changed; always replay lite.
const MODE = opt('mode', 'auto');
// Hash of the case JSON only (cassettes recorded before fixture/home hashing was added).
const legacyCaseHash = (c) => createHash('sha256').update(JSON.stringify({ ...c, file: undefined })).digest('hex').slice(0, 16);
// A case is re-recorded when its JSON, a referenced fixture file or its home template changes.
function caseHash(c) {
  const h = createHash('sha256').update(JSON.stringify({ ...c, file: undefined }));
  for (const n of c.fixtures || []) { try { h.update(readFileSync(join(HERE, 'fixtures', n.endsWith('.json') ? n : n + '.json'))); } catch {} }
  const homeDir = join(HERE, 'homes', c.home || 'anon');
  const walk = (d) => { try { for (const n of readdirSync(d).sort()) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : h.update(n).update(readFileSync(p)); } } catch {} };
  walk(homeDir);
  return h.digest('hex').slice(0, 16);
}

// Upstream proxy build has its API origin compiled to 127.0.0.1:18899, so upstream
// recordings are serialised across processes with a directory lock.
async function withRecordLock(fn) {
  const lock = join(ROOT, '.cache', 'parity-record.lock');
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 180000) rmSync(lock, { recursive: true, force: true }); } catch {}
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    }
  }
  // heartbeat: long recordings (ws daemons) keep the lock fresh so nobody breaks it as stale
  const beat = setInterval(() => { try { const t = new Date(); utimesSync(lock, t, t); } catch {} }, 20000);
  try { return await fn(); } finally { clearInterval(beat); rmSync(lock, { recursive: true, force: true }); }
}

const endpointClass = loadJson(join(HERE, 'endpoints.json'), {});
function loadJson(p, def) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } }

function policyFor(testCase) {
  return (req) => {
    if (testCase.network === 'fixture') return 'fixture';
    const key = `${req.method} ${req.path}`;
    const cls = endpointClass[key] ?? matchTemplate(key);
    if (cls === 'read') return 'forward';
    if (cls === undefined && req.method === 'GET') return 'forward';
    return 'fixture';
  };
}
// endpoints.json may contain templated paths like "/priapi/v1/aieco/task/{jobId}/detail"
function matchTemplate(key) {
  for (const [k, v] of Object.entries(endpointClass)) {
    if (!k.includes('{')) continue;
    const re = new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+') + '$');
    if (re.test(key)) return v;
  }
  return undefined;
}

function loadFixtures(names = []) {
  const entries = names.flatMap((n) => loadJson(join(HERE, 'fixtures', n.endsWith('.json') ? n : n + '.json'), []));
  const used = new Map();
  return (req) => {
    for (const [i, f] of entries.entries()) {
      if (f.method && f.method !== req.method) continue;
      if (f.path && f.path !== req.path && !(f.pathRegex && new RegExp(f.pathRegex).test(req.path))) continue;
      if (!f.path && f.pathRegex && !new RegExp(f.pathRegex).test(req.path)) continue;
      if (f.match && !subset(f.match, { query: req.query, body: req.body })) continue;
      const n = used.get(i) || 0;
      if (f.times && n >= f.times) continue;
      used.set(i, n + 1);
      return f.response;
    }
    return null;
  };
}
function subset(want, have) {
  if (want && typeof want === 'object') return have && typeof have === 'object' && Object.entries(want).every(([k, v]) => subset(v, have[k]));
  return String(want) === String(have);
}

function prepareHome(template, label) {
  const dir = mkdtempSync(join(tmpdir(), `ocl-parity-${label}-`));
  const src = join(HERE, 'homes', template || 'anon');
  if (existsSync(src)) cpSync(src, dir, { recursive: true });
  return dir;
}

function snapshotHome(dir, c = {}) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(dir, p).replaceAll('\\', '/');
        if (/^(audit\.jsonl|keyring\.enc|machine-identity|doh-cache\.json|last_check|.*\.tmp)$/.test(rel)) { out[rel] = '<present>'; continue; }
        // watch sessions (ws): raw bytes — JSON.parse would hide number formatting (2.0 vs 2,
        // -0.0, u64 digits), key order and the pretty layout of config.json.
        if (rel.startsWith('watch/')) {
          const buf = readFileSync(p);
          const t = buf.toString('utf8');
          out[rel] = Buffer.from(t, 'utf8').equals(buf) ? t : { b64: buf.toString('base64') };
          continue;
        }
        const text = readFileSync(p, 'utf8');
        try { out[rel] = JSON.parse(text); } catch { out[rel] = text; }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return normalizeWatchSnapshot(out, c);
}

// stdinHold: { lines, ms } keeps stdin open until stdout has `lines` lines or `ms` elapsed
// (rmcp waits only 5 s for in-flight tool calls after stdin closes).
function run(cmd, argv, env, { stdin, timeoutMs = 90000, ws, stdinHold } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ exit: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); };
    p.on('close', finish);
    // A daemon spawned by the command (ws start) may inherit the stdio pipes (Rust's Command
    // on Windows), so 'close' would wait for the daemon: settle shortly after the exit instead.
    if (ws?.daemon) p.on('exit', (code) => setTimeout(() => finish(code), 500));
    if (stdin) p.stdin.write(stdin);
    if (!stdinHold) { p.stdin.end(); return; }
    const holdTimer = setTimeout(() => p.stdin.end(), stdinHold.ms ?? 30000);
    if (stdinHold.lines) p.stdout.on('data', () => {
      if (parseLines(Buffer.concat(out).toString('utf8')).length >= stdinHold.lines) { clearTimeout(holdTimer); p.stdin.end(); }
    });
  });
}

const parseLines = (s) => s.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });

const COMMON_ENV = { NO_COLOR: '1', ONCHAINOS_NO_BROWSER: '1', ONCHAINOS_CREDENTIAL_STORE: 'file', ONCHAINOS_FORCE_FILE_KEYRING: '1', RUST_BACKTRACE: '0' };

async function recordCase(c) {
  const home = prepareHome(c.home, 'up');
  const cassette = { id: c.id, argv: c.argv, upstream: '4.6.3', caseHash: caseHash(c), exchanges: [] };
  const r = await withRecordLock(async () => {
    const proxy = createProxy({ port: PORT, mode: 'record', cassette, policy: policyFor(c), fixtures: loadFixtures(c.fixtures),
      ws: { network: c.network, fixture: loadWsFixture(join(HERE, 'fixtures'), c.wsFixtures) } });
    await proxy.listen();
    try {
      const res = await run(UPSTREAM_BIN, c.argv, { ...COMMON_ENV, ONCHAINOS_HOME: home, ...(c.env || {}) }, c);
      await wsSettle(c, proxy, home, join(HERE, 'homes', c.home || 'anon'));
      if (proxy.ws.sessions.length) cassette.ws = proxy.ws.sessions;
      return res;
    }
    finally { await proxy.close(); }
  });
  cassette.result = { exit: r.exit, stdout: parseLines(maskHomePath(r.stdout, home, c)), stdoutText: maskHomePath(r.stdout, home, c), stderr: maskHomePath(r.stderr, home, c), home: snapshotHome(home, c) };
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(HERE, 'cassettes'), { recursive: true });
  writeFileSync(join(HERE, 'cassettes', `${c.id}.json`), JSON.stringify(cassette, null, 2));
  return cassette;
}

async function replayCase(c, cassette) {
  const home = prepareHome(c.home, 'lite');
  // random port; retry when Windows reserves the range (EACCES) or it is taken (EADDRINUSE)
  let port, proxy;
  for (let attempt = 0; ; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    proxy = createProxy({ port, mode: 'replay', cassette });
    try { await proxy.listen(); break; } catch (e) {
      if (attempt > 20 || !['EACCES', 'EADDRINUSE'].includes(e.code)) throw e;
    }
  }
  const base = `http://127.0.0.1:${port}`;
  const r = await run(process.execPath, [LITE, ...c.argv], {
    ...COMMON_ENV, OCL_HOME: home, ONCHAINOS_HOME: home, OCL_BASE_URL: base,
    OCL_WS_URL: `ws://127.0.0.1:${port}/ws/v6/dex`, OCL_AGENT_WS_URL: `ws://127.0.0.1:${port}/ws/v5/private`, ...(c.env || {}),
  }, c);
  await wsSettle(c, proxy, home, join(HERE, 'homes', c.home || 'anon'));
  await proxy.close();
  const lite = { exit: r.exit, stdout: parseLines(maskHomePath(r.stdout, home, c)), stdoutText: maskHomePath(r.stdout, home, c), stderr: maskHomePath(r.stderr, home, c), home: snapshotHome(home, c), requests: proxy.log, ws: proxy.ws.sessions };
  rmSync(home, { recursive: true, force: true });
  return lite;
}

function compare(c, cassette, lite) {
  const masks = c.masks || [];
  const pick = (prefix) => masks.filter((m) => m.startsWith(prefix + '.')).map((m) => m.slice(prefix.length + 1));
  const diffs = [];
  if (cassette.result.exit !== lite.exit) diffs.push({ kind: 'exit', upstream: cassette.result.exit, lite: lite.exit });
  // clap's "Usage:" lines name the running executable (the proxy build's file name) — in help
  // text on stdout as well as in errors on stderr.
  const binName = (s) => String(s ?? '').replace(/onchainos-[0-9.]+-proxy(?:\.exe)?/g, 'onchainos');
  const upStdout = (cassette.result.stdout || []).map((l) => (typeof l === 'string' ? binName(l) : l));
  const so = JSON.stringify(applyMasks({ v: upStdout }, pick('stdout').map((m) => 'v.' + m.replace(/^/, '*.'))));
  const sl = JSON.stringify(applyMasks({ v: lite.stdout }, pick('stdout').map((m) => 'v.' + m.replace(/^/, '*.'))));
  if (so !== sl) diffs.push({ kind: 'stdout', upstream: upStdout, lite: lite.stdout });
  // case option "exact": true | ["stdout","stderr"] — compare raw stdout bytes (the parsed
  // comparison above cannot see number formatting such as 2.0 vs 2) and/or stderr text.
  const exact = c.exact === true ? ['stdout', 'stderr'] : [].concat(c.exact || []);
  if (exact.includes('stdout') && binName(cassette.result.stdoutText) !== lite.stdoutText) diffs.push({ kind: 'stdout-bytes', upstream: binName(cassette.result.stdoutText), lite: lite.stdoutText });
  const upErr = binName(cassette.result.stderr);
  if (exact.includes('stderr') && upErr !== lite.stderr) diffs.push({ kind: 'stderr', upstream: upErr, lite: lite.stderr });
  const reqMasks = pick('req');
  const up = cassette.exchanges.map((x) => JSON.stringify(comparableRequest(x.request, reqMasks)));
  const lr = lite.requests.map((x) => JSON.stringify(comparableRequest(x, reqMasks)));
  if (up.join('\n') !== lr.join('\n')) {
    const sameSet = [...up].sort().join('\n') === [...lr].sort().join('\n');
    diffs.push({ kind: sameSet ? 'request-order' : 'requests', upstream: up.map((s) => JSON.parse(s)), lite: lr.map((s) => JSON.parse(s)) });
  }
  const homeMasks = [...DEFAULT_HOME_MASKS, ...pick('home')];
  const ho = JSON.stringify(sortKeysAt(applyMasks(cassette.result.home, homeMasks)));
  const hl = JSON.stringify(sortKeysAt(applyMasks(lite.home, homeMasks)));
  if (ho !== hl) diffs.push({ kind: 'home', upstream: cassette.result.home, lite: lite.home });
  const wsDiff = compareWs(c, cassette.ws, lite.ws);
  if (wsDiff) diffs.push(wsDiff);
  return diffs;
}

async function main() {
  const filter = opt('cases', '');
  const only = opt('id');
  const files = readdirSync(join(HERE, 'cases')).filter((f) => f.endsWith('.json') && f.includes(filter));
  const cases = files.flatMap((f) => loadJson(join(HERE, 'cases', f), []).map((c) => ({ ...c, file: f }))).filter((c) => !only || c.id === only);
  const report = [];
  for (const c of cases) {
    let cassette = loadJson(join(HERE, 'cassettes', `${c.id}.json`));
    const stale = !cassette || (cassette.caseHash !== caseHash(c) && cassette.caseHash !== legacyCaseHash(c));
    if (MODE === 'record' || MODE === 'both' || (MODE === 'auto' && stale)) cassette = await recordCase(c);
    if (MODE === 'record') { report.push({ id: c.id, recorded: true, exit: cassette.result.exit }); continue; }
    if (!cassette) { report.push({ id: c.id, error: 'no cassette' }); continue; }
    const lite = await replayCase(c, cassette);
    const diffs = compare(c, cassette, lite);
    report.push({ id: c.id, file: c.file, pass: diffs.filter((d) => d.kind !== 'request-order').length === 0, diffs, unmatched: lite.requests.filter((r) => r.unmatched).length });
    if (!args.includes('--json')) console.log(`${diffs.length ? (diffs.every((d) => d.kind === 'request-order') ? '~' : '✖') : '✔'} ${c.id}${diffs.length ? '  [' + diffs.map((d) => d.kind).join(',') + ']' : ''}`);
  }
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  const reportFile = join(ROOT, '.cache', `parity-report${filter ? '-' + filter : ''}${only ? '-' + only : ''}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  const failed = report.filter((r) => r.pass === false || r.error);
  if (!args.includes('--json')) console.log(`\n${report.length - failed.length}/${report.length} passed — details: ${relative(ROOT, reportFile)}`);
  process.exitCode = failed.length ? 1 : 0;
}

main();
