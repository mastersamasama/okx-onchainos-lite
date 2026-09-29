// State directory helpers. Layout and permissions follow upstream home.rs / file_keyring.rs.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, rmSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { HOME_DIR } from '../config.mjs';
import { context } from './errors.mjs';
import { ioErrorText, pathJoin } from './rs/fs.mjs';
import { nowNanos } from './rs/time.mjs';

// upstream: home.rs::onchainos_home
export const home = () => HOME_DIR;
export const homePath = (...parts) => join(HOME_DIR, ...parts);

export function ensureDir(dir = HOME_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') try { chmodSync(dir, 0o700); } catch {}
  return dir;
}

// Atomic write (tmp + rename) with 0600, as upstream does for secrets and state.
export function writeAtomic(path, data, { mode = 0o600, tmpExt = '.tmp' } = {}) {
  ensureDir(dirname(path));
  const tmp = path + tmpExt;
  writeFileSync(tmp, data, { mode });
  if (process.platform !== 'win32') try { chmodSync(tmp, mode); } catch {}
  renameSync(tmp, path);
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export const writeJson = (path, value, opts) => writeAtomic(path, JSON.stringify(value, null, 2), opts);
export const exists = (path) => existsSync(path);
export const remove = (path) => rmSync(path, { force: true, recursive: true });

// ── task state (home.rs) ────────────────────────────────────────────

// upstream: home.rs::task_state_root
export const taskStateRoot = () => homePath('task');
// upstream: home.rs::task_state_dir — PathBuf::join, so an absolute or prefixed job id replaces
// the root instead of nesting under it.
export const taskStateDir = (jobId) => pathJoin(taskStateRoot(), jobId);

// upstream: home.rs::ensure_dir_0700 — create when missing, then (Unix) force mode 0700.
// Throws the raw Node fs error (callers render it with ioErrorText); `e.ensureContext` carries
// upstream's `.with_context` text for the failing step.
export function ensureDir0700(path) {
  const step = (fn, ctx) => { try { return fn(); } catch (e) { if (e && typeof e === 'object') e.ensureContext = ctx; throw e; } };
  if (!existsSync(path)) step(() => mkdirSync(path, { recursive: true }), `failed to create directory ${path}`);   // create_dir_all (default mode)
  if (process.platform !== 'win32') {
    const mode = step(() => statSync(path).mode & 0o777, `failed to read metadata for ${path}`);
    if (mode !== 0o700) step(() => chmodSync(path, 0o700), `failed to set 0700 on ${path}`);
  }
}

// upstream: home.rs::ensure_task_state_writable → task root path
export function ensureTaskStateWritable() {
  const dir = taskStateRoot();
  try { ensureDir0700(dir); } catch (e) {
    const cause = new Error(ioErrorText(e));
    throw context('failed to prepare task state directory', e?.ensureContext ? context(e.ensureContext, cause) : cause);
  }
  const probe = join(dir, `.write-probe-${process.pid}-${nowNanos()}`);
  const notWritable = (e) => context(`task state directory is not writable: ${dir}`, new Error(ioErrorText(e)));
  try {
    let fd;
    try { fd = openSync(probe, 'wx', 0o600); } catch (e) { throw notWritable(e); }
    try { writeSync(fd, 'ok'); } catch (e) { throw notWritable(e); } finally { closeSync(fd); }
    try { rmSync(probe); } catch (e) { throw context(`failed to remove task state write probe ${probe}`, new Error(ioErrorText(e))); }
  } catch (e) {
    try { rmSync(probe, { force: true }); } catch {}
    throw e;
  }
  return dir;
}

// upstream: home.rs::write_secure — create parent, write ".<name>.<pid>.tmp" (0600), rename.
export function writeSecure(path, contents) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  if (process.platform !== 'win32') { try { chmodSync(parent, 0o700); } catch {} }
  const tmp = join(parent, `.${basename(path) || 'f'}.${process.pid}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  try { renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}
