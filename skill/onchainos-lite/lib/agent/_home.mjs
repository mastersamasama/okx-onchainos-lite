// PRIVATE fallback for upstream home.rs helpers not (yet) exported by lib/core/home.mjs:
// task_state_root / task_state_dir / ensure_task_state_writable / write_secure.
// Requested for promotion to lib/core/home.mjs.
import { mkdirSync, writeFileSync, renameSync, rmSync, openSync, writeSync, closeSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { home } from '../core/home.mjs';
import { context } from '../core/errors.mjs';
import { ioErrorText, nowNanos } from './_rs.mjs';

// upstream: home.rs::onchainos_home
export const onchainosHome = () => home();
// upstream: home.rs::task_state_root
export const taskStateRoot = () => join(home(), 'task');
// Rust `PathBuf::join(seg)` (= clone + push): an absolute segment replaces the base; on Windows a
// rooted segment without a prefix (`\x`) keeps only the base's prefix and a prefixed one (`C:x`,
// `\\server\share`) replaces it. Plain Node `path.join` would instead nest such a segment under
// the base (and fail on a drive colon), so a `--job-id` that is an absolute path wrote elsewhere.
export function rustJoin(base, seg) {
  const s = String(seg);
  if (process.platform === 'win32') {
    const prefixed = /^[A-Za-z]:/.test(s) || /^[\\/]{2}/.test(s);
    if (prefixed) return s;
    if (/^[\\/]/.test(s)) {
      const m = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.exec(String(base));
      return (m ? m[0] : '') + s;
    }
    return join(base, s);
  }
  return s.startsWith('/') ? s : join(base, s);
}
// upstream: home.rs::task_state_dir (`task_state_root()?.join(job_id)`)
export const taskStateDir = (jobId) => rustJoin(taskStateRoot(), jobId);

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
