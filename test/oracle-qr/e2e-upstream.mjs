#!/usr/bin/env node
// End-to-end QR parity against the real upstream binary (no network, no real state):
//   node test/oracle-qr/e2e-upstream.mjs
//
// Runs `.cache/bin/onchainos-4.6.3-proxy.exe wallet receive` (API origin compiled to
// 127.0.0.1:18899) with a hermetic logged-in home (file keyring forced via
// ONCHAINOS_CREDENTIAL_STORE=file, far-future JWTs, so no refresh call) and a local
// stub answering only the two read-only wallet endpoints the command calls. The
// display mode is pinned through Codex session metadata (CODEX_THREAD_ID/CODEX_HOME).
// Upstream `payload.evmQr` (serde json! → sorted keys) is compared with lite's
// lib/core/qr.mjs: terminalQr text, PNG bytes on disk, image dir choice, markdown
// (cwd-relative and absolute), notifyCommandArgs, and the detected display mode.
//
// Phase 2 (adversarial probes): each probe runs upstream and a lite child process
// (same env, cwd, piped stdio) and compares the whole evmQr (file name normalised),
// the PNG bytes and the directories each side created — serde_json acceptance of the
// Codex first line, DFS order, CODEX_THREAD_ID trimming, dirs::home_dir, the PNG
// directory chain with odd ONCHAINOS_FUNDING_IMAGE_DIR / TMP values, Win32 path
// normalisation and verbatim paths, create_dir_all side effects, encode degradation.
//   QR_E2E_PHASE1=0  skip phase 1      QR_E2E_PROBES=0   skip phase 2
//   QR_E2E_VERBOSE=1 list the directories upstream created per probe
//   QR_E2E_LITE_QR_URL=file:///…/qr.mjs  run the probes against another lite qr.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BIN = process.env.PARITY_UPSTREAM_BIN || join(ROOT, '.cache', 'bin', process.platform === 'win32' ? 'onchainos-4.6.3-proxy.exe' : 'onchainos-4.6.3-proxy');
const PORT = 18899;
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'ocl-qr-e2e-')));
process.env.OCL_HOME = join(SANDBOX, 'lite-home');        // lite's state dir is irrelevant here; keep it sandboxed
for (const k of ['ONCHAINOS_FUNDING_IMAGE_DIR', 'CODEX_THREAD_ID', 'CODEX_HOME', 'ONCHAINOS_HOME']) delete process.env[k];
const qr = await import('../../skill/onchainos-lite/lib/core/qr.mjs');
const { stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { encryptBlob } = await import('../../skill/onchainos-lite/lib/core/keyring.mjs');

const ADDRESSES = [
  '0x1234567890abcdef1234567890abcdef12345678',
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0x0000000000000000000000000000000000000001',
  '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359',
];

// ── stub API (only the endpoints `wallet receive` calls) ─────────────────────
let currentAddress = ADDRESSES[0];
const seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(`${req.method} ${req.url}`);
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/priapi/v5/wallet/agentic/account/list') {
      return send({ code: 0, msg: '', data: [{ projectId: 'proj-qr', accountId: 'acc-qr', accountName: 'Account 1', isDefault: true }] });
    }
    if (req.url === '/priapi/v5/wallet/agentic/account/address/list') {
      return send({ code: 0, msg: '', data: [{ accounts: [{ accountId: 'acc-qr', addresses: [
        { accountId: 'acc-qr', address: currentAddress, chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: '' },
        { accountId: 'acc-qr', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', chainIndex: '501', chainName: 'sol', addressType: 'eoa', chainPath: '' },
      ] }] }] });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, msg: `stub: unexpected ${req.method} ${req.url}` }));
  });
});
// Port 18899 is shared with test/parity/run.mjs recordings: take the same directory lock
// (never breaking someone else's), and back off while another process still holds the port.
const LOCK = join(ROOT, '.cache', 'parity-record.lock');
mkdirSync(join(ROOT, '.cache'), { recursive: true });
const releaseLock = () => rmSync(LOCK, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + Number(process.env.QR_E2E_WAIT_MS ?? 600000);
for (;;) {
  let locked = false;
  try { mkdirSync(LOCK); locked = true; } catch {}
  if (locked) {
    const bound = await new Promise((resolve) => {
      const onError = () => { server.off('listening', onListening); resolve(false); };
      const onListening = () => { server.off('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(PORT, '127.0.0.1');
    });
    if (bound) break;
    releaseLock();
  }
  if (Date.now() > deadline) { console.error(`port ${PORT} / parity lock busy; giving up`); rmSync(SANDBOX, { recursive: true, force: true }); process.exit(2); }
  await sleep(1000 + Math.random() * 1000);
}

// ── hermetic logged-in upstream home ────────────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp })}.sig`;
function makeHome(dir) {
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const identity = randomBytes(32).toString('hex');
  writeFileSync(join(dir, 'machine-identity'), identity);
  writeFileSync(join(dir, 'keyring.enc'), encryptBlob({ access_token: jwt(now + 864000), refresh_token: jwt(now + 2592000) }, identity));
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ saTeeId: '', sessionCert: '', encryptedSessionSk: '', sessionKeyExpireAt: String(now + 864000), deviceId: '' }, null, 2));
  writeFileSync(join(dir, 'wallets.json'), JSON.stringify({ email: 'qr@example.invalid', isNew: false, projectId: 'proj-qr', selectedAccountId: 'acc-qr', accountsMap: {}, accounts: [], loginType: '' }, null, 2));
}
function codexHome(dir, threadId, originator) {
  mkdirSync(join(dir, 'sessions', '2026'), { recursive: true });
  writeFileSync(join(dir, 'sessions', '2026', `rollout-${threadId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { originator, source: 'cli' } }) + '\n');
}

function runUpstream(args, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

// ── phase 2: adversarial probes ─────────────────────────────────────────────
// Each probe runs upstream `wallet receive` and lite's buildQrOutput (in a child node
// process with the same env, cwd and piped stdio, so the runtime detection sees the same
// world) and compares the whole evmQr after normalising the volatile file name
// (`onchainos-funding-qr-<pid>-<nanos>.png`), plus the PNG bytes both wrote.
const LITE_PROBE = `
const qr = await import(process.env.QR_PROBE_QR_URL);
const { stringify } = await import(process.env.QR_PROBE_JSON_URL);
process.stdout.write(stringify({ ...qr.buildQrOutput(process.env.QR_PROBE_ADDRESS) }));
`;
const QR_URL = process.env.QR_E2E_LITE_QR_URL || new URL('../../skill/onchainos-lite/lib/core/qr.mjs', import.meta.url).href;
const JSON_URL = new URL('../../skill/onchainos-lite/lib/core/json.mjs', import.meta.url).href;
const PNG_RE = /onchainos-funding-qr-\d+-\d+\.png/g;
const STRIP_ENV = ['OCL_HOME', 'ONCHAINOS_HOME', 'ONCHAINOS_FUNDING_IMAGE_DIR', 'CODEX_THREAD_ID', 'CODEX_HOME'];
function runLite(address, { env, cwd }) {
  const base = { ...process.env };
  for (const k of STRIP_ENV) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', LITE_PROBE], {
      cwd, env: { ...base, ...env, QR_PROBE_QR_URL: QR_URL, QR_PROBE_JSON_URL: JSON_URL, QR_PROBE_ADDRESS: address },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const resolveIn = (cwd, p) => (qr.rustIsAbsolute(p) ? p : join(cwd, p));
// Literal (un-normalised) path for Node fs: names with trailing dots/spaces stay as they are.
const literalPath = (p) => (process.platform === 'win32' ? `\\\\?\\${p}` : p);
// All directories below `root` ('/'-joined relative paths, sorted), names taken literally.
function dirTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(literalPath(dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      walk(join(dir, e.name), r);
    }
  };
  walk(root, '');
  return out.sort();
}

async function probe(name, { address = ADDRESSES[0], env = {}, cwd, setup, platform } = {}) {
  if (platform && platform !== process.platform) return;
  const base = join(SANDBOX, `probe-${name}`);
  const home = join(base, 'home');
  makeHome(home);
  const work = join(base, 'cwd');
  mkdirSync(work, { recursive: true });
  const ctx = { base, home, work, threadId: randomUUID() };
  const extra = (await setup?.(ctx)) ?? {};
  const runCwd = extra.cwd ?? cwd ?? work;
  const allEnv = { ONCHAINOS_HOME: home, ONCHAINOS_CREDENTIAL_STORE: 'file', ...env, ...(extra.env ?? {}) };
  currentAddress = address;
  // Directories each side creates under the probe sandbox (upstream's home internals aside,
  // except home/tmp): upstream runs first, its new directories are recorded and removed,
  // then lite runs against the same starting tree.
  const tree = () => dirTree(base).filter((rel) => rel === 'home' || !rel.startsWith('home/') || rel.startsWith('home/tmp'));
  const before = new Set(tree());
  const up = await runUpstream(['wallet', 'receive'], { env: allEnv, cwd: runCwd });
  let upQr;
  try { upQr = JSON.parse(up.stdout).data.payload.evmQr; } catch {
    check(`probe ${name}`, false, `upstream exit ${up.code} stdout=${up.stdout.slice(0, 300)} stderr=${up.stderr.slice(0, 300)}`);
    return;
  }
  // Address files the way Win32 does (trailing dots/spaces etc.), not via path.resolve.
  const at = (p) => { try { return qr.fsPath(resolveIn(runCwd, p)); } catch { return null; } };
  const readAt = (p) => { const f = p && at(p); try { return f ? readFileSync(f) : null; } catch { return null; } };
  const upPng = readAt(upQr.imagePath);
  const upTree = tree();
  for (const rel of upTree.filter((r) => !before.has(r)).sort((x, y) => y.length - x.length)) {
    rmSync(literalPath(join(base, rel)), { recursive: true, force: true });
  }
  const lite = await runLite(address, { env: allEnv, cwd: runCwd });
  let liteQr;
  try { liteQr = JSON.parse(lite.stdout); } catch {
    check(`probe ${name}`, false, `lite exit ${lite.code} stdout=${lite.stdout.slice(0, 300)} stderr=${lite.stderr.slice(0, 300)}`);
    return;
  }
  const norm = (v) => JSON.stringify(v).replace(PNG_RE, 'onchainos-funding-qr-PID-NANOS.png');
  const detail = `\n    upstream ${norm(upQr).slice(0, 400)}\n    lite     ${norm(liteQr).slice(0, 400)}`;
  check(`probe ${name}: evmQr`, norm(upQr) === norm(liteQr), detail);
  if (extra.expectMode) check(`probe ${name}: upstream mode is ${extra.expectMode}`, upQr.displayMode === extra.expectMode, upQr.displayMode);
  if (upQr.imagePath && liteQr.imagePath) {
    const litePng = readAt(liteQr.imagePath);
    check(`probe ${name}: PNG bytes`, !!upPng && !!litePng && upPng.equals(litePng), `${upQr.imagePath} / ${liteQr.imagePath}`);
  }
  const liteTree = tree();
  if (process.env.QR_E2E_VERBOSE) console.log(`  ${name}: upstream created ${JSON.stringify(upTree.filter((r) => !before.has(r)))}`);
  check(`probe ${name}: directories created`, JSON.stringify(upTree) === JSON.stringify(liteTree),
    `\n    upstream +${JSON.stringify(upTree.filter((r) => !before.has(r)))}\n    lite     +${JSON.stringify(liteTree.filter((r) => !before.has(r)))}`);
}

async function runProbes() {
  const WIN = process.platform === 'win32';
  const S = WIN ? '\\' : '/';
  // Codex session helpers: one file per entry of `files` ({rel, content}) under <codexHome>/sessions.
  const sessions = (ctx, files, { codexHome = join(ctx.base, 'codex') } = {}) => {
    for (const f of files) {
      const p = join(codexHome, 'sessions', f.rel.replaceAll('{id}', ctx.threadId));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    return { CODEX_THREAD_ID: ctx.threadId, CODEX_HOME: codexHome };
  };
  const tuiLine = (extra = '') => `{"source":"cli"${extra}}\n`;
  const one = (content) => (ctx) => ({ env: sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content }]) });

  // serde_json::from_str acceptance of the first line (features as upstream links them).
  await probe('codex-number-overflow', { setup: one(tuiLine(',"n":1e400')) });
  await probe('codex-number-negative-overflow', { setup: one(tuiLine(',"n":-1e400')) });
  await probe('codex-number-big-integer', { setup: one(tuiLine(',"n":123456789012345678901234567890')) });
  await probe('codex-lone-surrogate-value', { setup: one(tuiLine(',"k":"\\ud800"')) });
  await probe('codex-lone-surrogate-key', { setup: one(tuiLine(',"\\udc00":1')) });
  await probe('codex-depth-127', { setup: one(`${'['.repeat(126)}{"source":"cli"}${']'.repeat(126)}\n`) });
  await probe('codex-depth-128', { setup: one(`${'['.repeat(127)}{"source":"cli"}${']'.repeat(127)}\n`) });
  await probe('codex-bom', { setup: one(`﻿${tuiLine()}`) });
  await probe('codex-crlf', { setup: one(tuiLine().replace('\n', '\r\n')) });
  await probe('codex-empty-first-line', { setup: one(`\n${tuiLine()}`) });
  await probe('codex-invalid-utf8', {
    setup: (ctx) => ({ env: sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: Buffer.concat([Buffer.from('{"source":"cli","x":"'), Buffer.from([0xff]), Buffer.from('"}\n')]) }]) }),
  });
  await probe('codex-duplicate-key-last-wins', { setup: one('{"source":"vscode","source":"cli"}\n') });
  await probe('codex-sorted-walk', { setup: one('{"b":{"source":"vscode"},"a":{"source":"cli"}}\n') });
  // Search order: DFS with a LIFO stack in OS directory order; first file yielding a mode wins.
  await probe('codex-dfs-order', {
    setup: (ctx) => ({ env: sessions(ctx, [
      { rel: '{id}.json', content: 'not json\n' },
      { rel: `a${S}x${S}rollout-{id}.jsonl`, content: '{"payload":{"originator":"Codex Desktop"}}\n' },
      { rel: `b${S}rollout-{id}.jsonl`, content: '{"payload":{"originator":"codex-tui"}}\n' },
      { rel: `c-{id}.jsonl${S}inner-{id}.jsonl`, content: '{"payload":{"originator":"codex_exec"}}\n' },
      { rel: `d${S}rollout-{id}.txt`, content: tuiLine() },
    ]) }),
  });
  await probe('codex-thread-id-unicode-trim', {
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_THREAD_ID: `\u0085 ${ctx.threadId}　\t` } }),
  });
  await probe('codex-thread-id-bom-kept', {
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_THREAD_ID: `﻿${ctx.threadId}` } }),
  });
  // dirs::home_dir(): Known Folder profile on Windows (not %USERPROFILE%).
  await probe('codex-home-userprofile-override', {
    platform: 'win32',
    setup: (ctx) => {
      const fake = join(ctx.base, 'fake-profile');
      sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }], { codexHome: join(fake, '.codex') });
      return { env: { CODEX_THREAD_ID: ctx.threadId, USERPROFILE: fake, HOMEDRIVE: '', HOMEPATH: '' } };
    },
  });
  await probe('codex-home-empty-home-var', {
    platform: 'linux',
    setup: (ctx) => {
      sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }], { codexHome: join(ctx.base, 'unused') });
      return { env: { CODEX_THREAD_ID: ctx.threadId, HOME: '' } };
    },
  });

  // PNG directory choice and the path strings derived from it (image-notify pinned).
  const desktop = (ctx) => sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: '{"payload":{"originator":"Codex Desktop"}}\n' }]);
  const img = (fn) => async (ctx) => {
    const r = (await fn(ctx)) ?? {};
    return { ...r, env: { ...desktop(ctx), ...(r.env ?? {}) }, expectMode: 'image-notify' };
  };
  const blockFile = (p) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'blocker'); };
  await probe('img-env-empty', { setup: img(() => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: '' } })) });
  await probe('img-env-forward-slashes', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, 'fw', 'imgs').replaceAll('\\', '/') } })) });
  await probe('img-env-trailing-sep', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, 'ts') + S } })) });
  await probe('img-env-double-sep', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, 'dd') + S + S + 'x' } })) });
  await probe('img-env-dot-segments', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `${ctx.work}${S}.${S}p${S}..${S}q` } })) });
  await probe('img-env-relative', { setup: img(() => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `rel${S}imgs` } })) });
  await probe('img-env-relative-dot', { setup: img(() => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `.${S}rel2` } })) });
  await probe('img-env-non-ascii', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, '图片 qr') } })) });
  await probe('img-env-outside-cwd', { setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.base, 'elsewhere') } })) });
  await probe('img-env-blocked-home', { setup: img((ctx) => { blockFile(join(ctx.base, 'blk')); return { env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.base, 'blk', 'sub') } }; }) });
  await probe('img-home-under-cwd', { setup: img((ctx) => ({ cwd: ctx.base })) });
  await probe('img-cwd-fallback', { setup: img((ctx) => { blockFile(join(ctx.home, 'tmp')); }) });
  await probe('img-cwd-fallback-trailing-sep-cwd', { setup: img((ctx) => { blockFile(join(ctx.home, 'tmp')); return { cwd: ctx.work + S }; }) });
  await probe('img-cwd-drive-letter-case', {
    platform: 'win32',
    setup: img((ctx) => { blockFile(join(ctx.home, 'tmp')); return { cwd: ctx.work[0].toLowerCase() + ctx.work.slice(1) }; }),
  });
  await probe('img-temp-fallback', {
    setup: img((ctx) => {
      blockFile(join(ctx.home, 'tmp'));
      blockFile(join(ctx.work, '.onchainos'));
      const t = join(ctx.base, 'tmpdir');
      mkdirSync(t, { recursive: true });
      return { env: WIN ? { TMP: t, TEMP: t } : { TMPDIR: t } };
    }),
  });
  await probe('img-temp-fallback-under-cwd', {
    setup: img((ctx) => {
      blockFile(join(ctx.home, 'tmp'));
      blockFile(join(ctx.work, '.onchainos'));
      const t = join(ctx.work, 'tmpdir');
      mkdirSync(t, { recursive: true });
      return { env: WIN ? { TMP: t.replaceAll('\\', '/') + '/', TEMP: '' } : { TMPDIR: t + '/' } };
    }),
  });
  await probe('img-temp-fallback-temp-var', {
    platform: 'win32',
    setup: img((ctx) => {
      blockFile(join(ctx.home, 'tmp'));
      blockFile(join(ctx.work, '.onchainos'));
      const t = join(ctx.base, 'tempvar');
      mkdirSync(t, { recursive: true });
      return { env: { TMP: '', TEMP: t } };
    }),
  });
  await probe('img-verbatim-env', { platform: 'win32', setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `\\\\?\\${join(ctx.work, 'vb')}` } })) });
  await probe('img-verbatim-env-double-sep', { platform: 'win32', setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `\\\\?\\${join(ctx.work, 'vd')}\\\\y` } })) });
  await probe('img-verbatim-env-trailing-sep', { platform: 'win32', setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `\\\\?\\${join(ctx.work, 'vt')}\\` } })) });
  await probe('img-verbatim-env-dot', { platform: 'win32', setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `\\\\?\\${join(ctx.work, 'vdot')}\\.` } })) });
  await probe('img-gt-in-dir', { platform: 'linux', setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, 'a>b') } })) });
  // Win32 normalisation: create_dir_all makes the normalised directory, the PNG write then
  // succeeds (`x.\f` → `x\f`) or fails and falls through (`x \f`, `x...\f` keep the name).
  const winEnvDir = (name, leaf) => probe(name, {
    platform: 'win32',
    setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `${ctx.work}\\${leaf}` } })),
  });
  await winEnvDir('img-win-trailing-dot', 'td.');
  await winEnvDir('img-win-trailing-space', 'tsp ');
  await winEnvDir('img-win-trailing-dots', 'tdd...');
  await winEnvDir('img-win-trailing-dot-space', 'tds .');
  await winEnvDir('img-win-inner-dot', 'id.\\b');
  await winEnvDir('img-win-inner-space', 'is \\b');
  await winEnvDir('img-win-inner-dots', 'idd..\\b');
  await winEnvDir('img-win-long', `${'L'.repeat(120)}\\${'M'.repeat(120)}`);
  await probe('img-win-all-spaces-env', { platform: 'win32', setup: img(() => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: '   ' } })) });
  // create_dir_all side effects when a later name is invalid: NTFS reports "path not found"
  // for a missing directory before it (so the ancestor gets created), "invalid name" otherwise.
  const verbatimDir = (name, tail) => probe(name, {
    platform: 'win32',
    setup: img((ctx) => ({ env: { ONCHAINOS_FUNDING_IMAGE_DIR: `\\\\?\\${ctx.work}\\${tail}` } })),
  });
  await verbatimDir('img-verbatim-missing-dot', 'vmd\\.');
  await verbatimDir('img-verbatim-missing-dotdot', 'vmdd\\..\\z');
  await verbatimDir('img-verbatim-missing-slash', 'vms\\a/b');
  await verbatimDir('img-verbatim-missing-deep-dot', 'vmx\\y\\.\\z');
  await verbatimDir('img-verbatim-empty-name', 'vme\\\\z');
  await winEnvDir('img-win-invalid-char-missing-parent', 'icm\\a<b');
  await winEnvDir('img-win-invalid-char', 'a<b');
  await winEnvDir('img-win-ads-syntax', 'ads:x');
  await probe('img-under-file', {
    setup: img((ctx) => { blockFile(join(ctx.work, 'blkf')); return { env: { ONCHAINOS_FUNDING_IMAGE_DIR: join(ctx.work, 'blkf', 'sub', 'deeper') } }; }),
  });
  const tempProbe = (name, tmp) => probe(name, {
    platform: 'win32',
    setup: img((ctx) => {
      blockFile(join(ctx.home, 'tmp'));
      blockFile(join(ctx.work, '.onchainos'));
      mkdirSync(join(ctx.base, 't2'), { recursive: true });
      return { env: { TMP: tmp(ctx), TEMP: join(ctx.base, 't2') } };
    }),
  });
  await tempProbe('img-temp-relative', () => 'reltmp\\x');
  await tempProbe('img-temp-trailing-dot', (ctx) => `${ctx.base}\\tdot.`);
  await tempProbe('img-temp-dot-segments', (ctx) => `${ctx.base}/a/./b/../c`);
  await tempProbe('img-temp-too-long', (ctx) => `${ctx.base}\\${'x'.repeat(300)}`);
  await tempProbe('img-temp-spaces', () => '   ');
  await tempProbe('img-temp-leading-spaces', (ctx) => `  ${ctx.base}`);
  // Codex roots through Win32 normalisation: `codex.` reaches `codex`, `codex ` does not.
  await probe('codex-home-trailing-dot', {
    platform: 'win32',
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_HOME: `${join(ctx.base, 'codex')}.` } }),
  });
  await probe('codex-home-trailing-space', {
    platform: 'win32',
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_HOME: `${join(ctx.base, 'codex')} ` } }),
  });
  await probe('codex-home-verbatim-dot', {
    platform: 'win32',
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_HOME: `\\\\?\\${join(ctx.base, 'codex')}\\.` } }),
  });
  await probe('codex-home-verbatim-double-sep', {
    platform: 'win32',
    setup: (ctx) => ({ env: { ...sessions(ctx, [{ rel: 'rollout-{id}.jsonl', content: tuiLine() }]), CODEX_HOME: `\\\\?\\${ctx.base}\\\\codex` } }),
  });

  // Encode failure degrades to {requestedFormat, displayMode} in both modes.
  const long = `0x${'a'.repeat(8000)}`;
  await probe('degrade-image', { address: long, setup: img(() => ({})) });
  await probe('degrade-terminal', { address: long, setup: one('{"payload":{"originator":"codex-tui"}}\n') });
  await probe('terminal-non-ascii-address', { address: '钱包地址 0xABC', setup: one('{"payload":{"originator":"codex-tui"}}\n') });
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`); };
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

try {
  let n = 0;
  for (const address of process.env.QR_E2E_PHASE1 === '0' ? [] : ADDRESSES) {
    currentAddress = address;
    for (const scenario of ['terminal', 'image-abs', 'image-cwd', 'image-envdir']) {
      n++;
      const base = join(SANDBOX, `case-${n}`);
      const home = join(base, 'home');
      makeHome(home);
      const threadId = randomUUID();
      const codex = join(base, 'codex');
      codexHome(codex, threadId, scenario === 'terminal' ? 'codex-tui' : 'Codex Desktop');
      const outside = join(SANDBOX, `outside-${n}`);
      mkdirSync(outside, { recursive: true });
      const cwd = scenario === 'image-cwd' ? base : outside;   // image-cwd: PNG lands under cwd → relative markdown
      const envDir = join(base, 'env-images');
      const env = { ONCHAINOS_HOME: home, ONCHAINOS_CREDENTIAL_STORE: 'file', CODEX_THREAD_ID: threadId, CODEX_HOME: codex };
      if (scenario === 'image-envdir') env.ONCHAINOS_FUNDING_IMAGE_DIR = envDir;
      const r = await runUpstream(['wallet', 'receive'], { env, cwd });
      const label = `${scenario} ${address}`;
      let evmQr;
      try { evmQr = JSON.parse(r.stdout).data.payload.evmQr; } catch { check(label, false, `exit ${r.code} stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 300)}`); continue; }

      // Lite's runtime detection with the same Codex environment.
      const liteMode = await withEnv({ CODEX_THREAD_ID: threadId, CODEX_HOME: codex }, () => qr.displayMode());
      check(`${label}: display mode`, evmQr.displayMode === liteMode, `${evmQr.displayMode} vs ${liteMode}`);

      if (scenario === 'terminal') {
        const lite = await withEnv({ CODEX_THREAD_ID: threadId, CODEX_HOME: codex }, () => qr.buildQrOutput(address));
        check(`${label}: evmQr JSON`, JSON.stringify(evmQr) === stringify({ ...lite }), 'terminalQr/fields differ');
        continue;
      }
      const imagePath = evmQr.imagePath;
      const wantDir = scenario === 'image-envdir' ? envDir : qr.rustJoin(home, 'tmp', 'funding-qr');
      check(`${label}: image dir`, dirname(imagePath) === wantDir, `${dirname(imagePath)} vs ${wantDir}`);
      check(`${label}: file name`, new RegExp(`^onchainos-funding-qr-${r.pid}-\\d+\\.png$`).test(basename(imagePath)), basename(imagePath));
      check(`${label}: PNG bytes`, existsSync(imagePath) && readFileSync(imagePath).equals(qr.renderAddressQrPng(address)), 'png differs');
      const expect = qr.qrOutput({
        requestedFormat: 'auto', resolvedFormat: 'png', displayMode: 'image-notify', imagePath, mimeType: 'image/png',
        markdownImage: qr.markdownImageForPathIn(imagePath, cwd), notifyCommandArgs: qr.notifyCommandArgsForPath(imagePath),
      });
      check(`${label}: evmQr JSON`, JSON.stringify(evmQr) === stringify({ ...expect }), `${JSON.stringify(evmQr)} vs ${stringify({ ...expect })}`);
      const relative = evmQr.markdownImage.startsWith('![QR Code](<.');
      check(`${label}: markdown ${scenario === 'image-cwd' ? 'cwd-relative' : 'absolute'}`, relative === (scenario === 'image-cwd'), evmQr.markdownImage);
      if (process.platform !== 'win32') check(`${label}: dir mode 0700`, (statSync(dirname(imagePath)).mode & 0o777) === 0o700);
      // Lite writes the identical file bytes for the same directory choice.
      const litePath = qr.writeQrPng(address, join(base, 'lite-images'));
      check(`${label}: lite PNG == upstream PNG`, readFileSync(litePath).equals(readFileSync(imagePath)));
    }
  }
  if (process.env.QR_E2E_PROBES !== '0') await runProbes();
  const unexpected = seen.filter((s) => !s.includes('/priapi/v5/wallet/agentic/account/'));
  check('stub saw only the two wallet read endpoints', unexpected.length === 0, unexpected.join(', '));
} finally {
  await new Promise((r) => server.close(r));
  releaseLock();
  rmSync(SANDBOX, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
