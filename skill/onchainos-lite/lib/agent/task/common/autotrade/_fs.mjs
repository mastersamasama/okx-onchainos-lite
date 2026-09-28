// PRIVATE (autotrade): std::fs / std::path semantics the autotrade ports depend on.
//   exists / isFile / isDir (follow symlinks), read_dir order (OS native, like FindNextFileW /
//   getdents), Path::extension / file_stem / with_extension, fs::read_to_string (strict UTF-8),
//   create_new (O_EXCL) writes, io::Error Display, time helpers, sha256 hex.
import { statSync, opendirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ioErrorText } from '../../../_rs.mjs';
import { onchainosHome, writeSecure as writeSecureRaw, ensureDir0700 as ensureDir0700Raw } from '../../../_home.mjs';

export { onchainosHome };

// Path::exists / is_file / is_dir
export const exists = (p) => { try { statSync(p); return true; } catch { return false; } };
export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Rust io::Error → Error(Display text) (anyhow `?` conversion).
export function ioError(e) {
  if (e && e.code && (e.syscall || e.errno !== undefined)) {
    const err = new Error(ioErrorText(e));
    err.io = e;
    return err;
  }
  return e;
}
const io = (fn) => { try { return fn(); } catch (e) { throw ioError(e); } };

// std::fs::read_dir(p) → full child paths in OS order (throws io Display on failure).
// Node's readdirSync goes through uv_fs_scandir, which on Unix strcmp-sorts the names; Rust's
// read_dir yields raw readdir(3)/getdents order (hash order on ext4). The stdout order of
// `autotrade-outcome-flush`, its 32-entry cap and the maintenance scan order depend on it, so
// iterate with opendirSync (uv_fs_readdir: readdir(3) on Unix, FindNextFileW on Windows).
export function readDirPaths(p) {
  let dir;
  try { dir = opendirSync(p); } catch (e) { throw ioError(e); }
  const out = [];
  try {
    for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) out.push(join(p, ent.name));
  } catch (e) { throw ioError(e); } finally { try { dir.closeSync(); } catch {} }
  return out;
}

// std::fs::read → Buffer
export const readBytes = (p) => io(() => readFileSync(p));
// std::fs::read_to_string → string (invalid UTF-8 → io::Error InvalidData)
export function readToString(p) {
  const buf = readBytes(p);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch {
    throw new Error('stream did not contain valid UTF-8');
  }
}
// let _ = std::fs::remove_file(p)
export const removeFileQuiet = (p) => { try { rmSync(p, { force: false }); } catch {} };
export function removeFile(p) { io(() => rmSync(p)); }
export const renameQuiet = (a, b) => { try { renameSync(a, b); return true; } catch { return false; } };
export const createDirAll = (p) => io(() => mkdirSync(p, { recursive: true }));
export const ensureDir0700 = (p) => io(() => ensureDir0700Raw(p));
export const writeSecure = (p, bytes) => io(() => writeSecureRaw(p, bytes));

// OpenOptions::new().write(true).create_new(true)[.mode(0o600)] + write_all + sync_all.
// Returns false when the file already exists; throws io Display on any other failure.
export function createNew(p, bytes, { sync = true } = {}) {
  let fd;
  try { fd = openSync(p, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw ioError(e);
  }
  try {
    writeSync(fd, bytes);
    if (sync) fsyncSync(fd);
  } catch (e) { throw ioError(e); } finally { try { closeSync(fd); } catch {} }
  if (process.platform !== 'win32') { try { chmodSync(p, 0o600); } catch {} }
  return true;
}

// Path::file_name / extension / file_stem / with_extension (Rust rsplit_file_at_dot rules)
function splitAtDot(name) {
  if (name === '..') return [name, undefined];
  const i = name.lastIndexOf('.');
  if (i < 0) return [name, undefined];
  const before = name.slice(0, i), after = name.slice(i + 1);
  if (before === '') return [name, undefined];
  return [before, after];
}
export const fileName = (p) => basename(p);
export const extension = (p) => splitAtDot(basename(p))[1];
export const fileStem = (p) => splitAtDot(basename(p))[0];
export function withExtension(p, ext) {
  const [stem] = splitAtDot(basename(p));
  return join(dirname(p), ext === '' ? stem : `${stem}.${ext}`);
}

// SystemTime::now() as seconds / milliseconds since the epoch
export const nowSecs = () => Math.floor(Date.now() / 1000);
export const nowMs = () => Date.now();
// mtime age in whole seconds (None → undefined)
export function ageSecs(p) {
  try { const m = statSync(p).mtimeMs; const d = Date.now() - m; return d < 0 ? undefined : Math.floor(d / 1000); } catch { return undefined; }
}

// u64 saturating add (numbers stay numbers inside 2^53; otherwise BigInt)
const U64_MAX = 18446744073709551615n;
export function satAdd(a, b) {
  const v = BigInt(a) + BigInt(b);
  const r = v > U64_MAX ? U64_MAX : v;
  return Number.isSafeInteger(Number(r)) ? Number(r) : r;
}
export const u64Le = (a, b) => BigInt(a) <= BigInt(b);
export const u64Gt = (a, b) => BigInt(a) > BigInt(b);

// hex::encode(Sha256::digest(bytes))
export const sha256Hex = (s) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

// autotrade root `<onchainos_home>/autotrade`
export const autotradePath = (...parts) => join(onchainosHome(), 'autotrade', ...parts);
