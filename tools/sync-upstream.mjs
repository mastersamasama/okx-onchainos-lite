#!/usr/bin/env node
// Upstream sync: turn a new official onchainos-skills release into a work list for lite.
//
//   node tools/sync-upstream.mjs                    # fetch, diff latest tag vs the lock, write drift report
//   node tools/sync-upstream.mjs --ref v4.7.0       # specific tag / commit / origin/main
//   node tools/sync-upstream.mjs --ref v4.7.0 --apply
//        # also: build the new upstream binaries, adopt the new command surface
//        # (spec/cli-tree.json → lib/spec.json → command docs), bump UPSTREAM_VERSION,
//        # re-record every parity cassette with the new binary and report what fails.
//   --skip-build   reuse binaries already in .cache/bin
//
// Output: spec/drift/<old>..<new>.md (human work list) and .json (machine-readable).
// See docs/SYNC.md for the porting playbook that consumes the report.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UP = join(ROOT, 'upstream');
const LOCK = join(ROOT, 'spec', 'upstream.lock.json');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const flag = (n) => args.includes('--' + n);
const EXE = process.platform === 'win32' ? '.exe' : '';

const git = (...a) => execFileSync('git', ['-C', UP, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const log = (m) => process.stderr.write(m + '\n');

// ── 1. resolve refs ───────────────────────────────────────────────────
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : { commit: git('rev-parse', 'HEAD'), version: '4.6.3' };
log('fetching upstream…');
try { git('fetch', '--tags', 'origin'); } catch (e) { log(`fetch failed (${e.message.split('\n')[0]}); using local refs`); }
const semver = (t) => t.replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
const latestTag = git('tag', '--list', 'v*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }).at(-1);
const ref = opt('ref', latestTag);
const newCommit = git('rev-parse', `${ref}^{commit}`);
const newVersion = JSON.parse(git('show', `${newCommit}:package.json`)).version;
log(`lock: ${lock.version} @ ${lock.commit.slice(0, 8)} → target: ${newVersion} @ ${newCommit.slice(0, 8)} (${ref})`);
if (newCommit === lock.commit && !flag('force')) { log('already in sync.'); process.exit(0); }

// ── 2. changed files → partitions ─────────────────────────────────────
const parts = JSON.parse(readFileSync(join(ROOT, 'spec', 'partitions.json'), 'utf8')).partitions;
const changed = git('diff', '--name-status', lock.commit, newCommit, '--', 'cli/src', 'skills', 'workflows', 'cli/Cargo.toml', 'cli/build.rs')
  .split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { status: st[0], path: p.at(-1), from: p.length > 1 ? p[0] : undefined }; });
const partitionOf = (srcPath) => {
  const rel = srcPath.replace(/^cli\/src\//, '');
  for (const [id, p] of Object.entries(parts)) if (p.src.some((s) => (s.endsWith('/') ? rel.startsWith(s) : rel === s))) return id;
  return 'UNMAPPED';
};
const srcChanges = changed.filter((c) => c.path.startsWith('cli/src/'));
const byPartition = {};
for (const c of srcChanges) (byPartition[partitionOf(c.path)] ||= []).push(c);
const docChanges = changed.filter((c) => c.path.startsWith('skills/') || c.path.startsWith('workflows/'));

// ── 3. API path literals added / removed ─────────────────────────────
const apiPaths = (commit) => {
  const r = spawnSync('git', ['-C', UP, 'grep', '-hoE', '"/(api|priapi)/[A-Za-z0-9_/{}.-]+"', commit, '--', 'cli/src'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return new Set((r.stdout || '').split('\n').filter(Boolean).map((s) => s.replace(/^[^:]*:/, '').replace(/"/g, '')));
};
const oldApi = apiPaths(lock.commit), newApi = apiPaths(newCommit);
const apiAdded = [...newApi].filter((p) => !oldApi.has(p)).sort();
const apiRemoved = [...oldApi].filter((p) => !newApi.has(p)).sort();

// ── 4. build new upstream binaries (prod + parity-proxy origin) ──────
const wt = join(ROOT, '.cache', `upstream-${newVersion}`);
const binProd = join(ROOT, '.cache', 'bin', `onchainos-${newVersion}${EXE}`);
const binProxy = join(ROOT, '.cache', 'bin', `onchainos-${newVersion}-proxy${EXE}`);
if (!flag('skip-build') && !(existsSync(binProd) && existsSync(binProxy))) {
  if (!existsSync(wt)) git('worktree', 'add', '--detach', wt, newCommit);
  const target = join(ROOT, '.cache', 'cargo-target');
  const build = (envText) => {
    const envFile = join(wt, 'cli', '.env');
    if (envText) writeFileSync(envFile, envText); else rmSync(envFile, { force: true });
    log(`cargo build (${envText ? 'proxy' : 'prod'})…`);
    // ONCHAINOS_FORCE_FILE_KEYRING=1 at build time makes the reference binaries unable to read the
    // OS keychain (keyring_store.rs option_env!), so tests can never pick up a real login.
    const r = spawnSync('cargo', ['build', '--release'], { cwd: join(wt, 'cli'), env: { ...process.env, CARGO_TARGET_DIR: target, ONCHAINOS_FORCE_FILE_KEYRING: '1' }, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('cargo build failed');
    return join(target, 'release', `onchainos${EXE}`);
  };
  mkdirSync(join(ROOT, '.cache', 'bin'), { recursive: true });
  copyFileSync(build(null), binProd);
  copyFileSync(build('OKX_BASE_URL=http://127.0.0.1:18899\nOKX_AGENTIC_WS_URL=ws://127.0.0.1:18899/ws/v5/private\nONCHAINOS_WS_URL=ws://127.0.0.1:18899/ws/v6/dex\n'), binProxy);
  rmSync(join(wt, 'cli', '.env'), { force: true });
}

// ── 5. command-surface diff ───────────────────────────────────────────
let surface = null;
if (existsSync(binProd)) {
  log('dumping new command tree…');
  const hidden = existsSync(join(ROOT, 'spec', 'hidden.json')) ? [join(ROOT, 'spec', 'hidden.json')] : [];
  const next = execFileSync(process.execPath, [join(ROOT, 'tools', 'dump-cli-tree.mjs'), binProd, ...hidden], { encoding: 'utf8', maxBuffer: 1 << 28 });
  writeFileSync(join(ROOT, '.cache', `cli-tree-${newVersion}.json`), next);
  const flat = (tree) => { const m = {}; (function w(n) { if (n.path) m[n.path] = n; n.children.forEach(w); })(tree.tree); return m; };
  const A = flat(JSON.parse(readFileSync(join(ROOT, 'spec', 'cli-tree.json'), 'utf8'))), B = flat(JSON.parse(next));
  const optKey = (o) => JSON.stringify({ v: o.value, r: o.required, d: o.default, p: o.possible, m: o.multiple });
  surface = { added: [], removed: [], changed: [] };
  for (const p of Object.keys(B)) if (!A[p]) surface.added.push(p);
  for (const p of Object.keys(A)) if (!B[p]) surface.removed.push(p);
  for (const p of Object.keys(A)) {
    if (!B[p]) continue;
    const ao = new Map(A[p].options.map((o) => [o.long, o])), bo = new Map(B[p].options.map((o) => [o.long, o]));
    const d = { path: p, optionsAdded: [], optionsRemoved: [], optionsChanged: [], helpChanged: A[p].help !== B[p].help };
    for (const [k, o] of bo) if (!ao.has(k)) d.optionsAdded.push(k); else if (optKey(o) !== optKey(ao.get(k))) d.optionsChanged.push(`${k}: ${optKey(ao.get(k))} → ${optKey(o)}`);
    for (const k of ao.keys()) if (!bo.has(k)) d.optionsRemoved.push(k);
    if (d.optionsAdded.length || d.optionsRemoved.length || d.optionsChanged.length || d.helpChanged) surface.changed.push(d);
  }
}

// ── 6. report ────────────────────────────────────────────────────────
const report = { from: { version: lock.version, commit: lock.commit }, to: { version: newVersion, commit: newCommit, ref },
  surface, apiAdded, apiRemoved, partitions: byPartition, docs: docChanges };
mkdirSync(join(ROOT, 'spec', 'drift'), { recursive: true });
const base = join(ROOT, 'spec', 'drift', `${lock.version}..${newVersion}`);
writeFileSync(base + '.json', JSON.stringify(report, null, 2));
const md = [`# Upstream drift ${lock.version} → ${newVersion}`, '', `Commits ${lock.commit.slice(0, 8)}..${newCommit.slice(0, 8)} (${ref}). Work through it with docs/SYNC.md.`, ''];
if (surface) {
  md.push('## Command surface', '', `- added: ${surface.added.length ? surface.added.map((p) => '`' + p + '`').join(', ') : 'none'}`, `- removed: ${surface.removed.length ? surface.removed.map((p) => '`' + p + '`').join(', ') : 'none'}`);
  for (const c of surface.changed) md.push(`- \`${c.path}\`: ${[c.optionsAdded.length && '+' + c.optionsAdded.join(' +'), c.optionsRemoved.length && '-' + c.optionsRemoved.join(' -'), c.optionsChanged.length && c.optionsChanged.join('; '), c.helpChanged && 'help text'].filter(Boolean).join(' · ')}`);
  md.push('');
}
md.push('## API paths', '', `- added: ${apiAdded.map((p) => '`' + p + '`').join(', ') || 'none'}`, `- removed: ${apiRemoved.map((p) => '`' + p + '`').join(', ') || 'none'}`, '');
md.push('## Changed upstream source by partition (re-extract + port these)', '');
for (const [id, list] of Object.entries(byPartition)) {
  md.push(`### ${id}` + (parts[id] ? ` → lite: ${parts[id].lite.join(', ')}` : ' (add it to spec/partitions.json)'));
  for (const c of list) md.push(`- ${c.status} \`${c.path}\``);
  md.push(`- diff: \`git -C upstream diff ${lock.commit.slice(0, 8)} ${newCommit.slice(0, 8)} -- ${list.map((c) => c.path).join(' ')}\``, '');
}
md.push('## Changed upstream skill docs (update references/guides accordingly)', '', ...docChanges.map((c) => `- ${c.status} \`${c.path}\``), '');
writeFileSync(base + '.md', md.join('\n'));
log(`drift report: ${base}.md`);

// ── 7. apply ─────────────────────────────────────────────────────────
if (flag('apply')) {
  if (!existsSync(binProd)) throw new Error('no new binaries; run without --skip-build');
  git('checkout', '--detach', newCommit);
  copyFileSync(join(ROOT, '.cache', `cli-tree-${newVersion}.json`), join(ROOT, 'spec', 'cli-tree.json'));
  const run = (file, ...a) => spawnSync(process.execPath, [join(ROOT, 'tools', file), ...a], { stdio: 'inherit' }).status;
  spawnSync(process.execPath, [join(ROOT, 'tools', 'dump-clap-model.mjs'), '--ref', newCommit], { stdio: 'inherit' });
  run('gen-spec.mjs');
  run('gen-docs.mjs');
  run('gen-endpoints.mjs');
  const cfg = join(ROOT, 'skill', 'onchainos-lite', 'lib', 'config.mjs');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/export const UPSTREAM_VERSION = '[^']+';/, `export const UPSTREAM_VERSION = '${newVersion}';`));
  const hashPart = (id) => createHash('sha256').update(parts[id].src.map((s) => git('ls-tree', '-r', newCommit, '--', 'cli/src/' + s)).join('\n')).digest('hex').slice(0, 16);
  writeFileSync(LOCK, JSON.stringify({ version: newVersion, commit: newCommit, date: new Date().toISOString(),
    partitions: Object.fromEntries(Object.keys(parts).map((id) => [id, hashPart(id)])) }, null, 2) + '\n');
  log('re-recording parity cassettes with the new upstream binary…');
  spawnSync(process.execPath, [join(ROOT, 'test', 'parity', 'run.mjs'), '--mode', 'both'], { stdio: 'inherit', env: { ...process.env, PARITY_UPSTREAM_BIN: binProxy } });
  run('check.mjs');
  log('applied. Remaining failures above are the porting work list (docs/SYNC.md).');
}
