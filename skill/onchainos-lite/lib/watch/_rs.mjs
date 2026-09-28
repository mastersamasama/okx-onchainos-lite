// Rust std semantics the watch module needs (str::trim, f64/u64 FromStr, byte-order
// string sort, PathBuf::join display, std::io::Error Display for fs errors).
// String/number grammars come from core/_rust-str.mjs (core-helpers); re-exported here
// so the watch module has a single import point until that file is promoted.
import { statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
export { trim, parseF64, parseUnsigned } from '../core/_rust-str.mjs';

// Ord for String / &str: UTF-8 byte order.
export const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// Vec::sort + Vec::dedup (consecutive duplicates) with a comparator.
export function sortDedup(list, cmp = cmpBytes) {
  const s = [...list].sort(cmp);
  return s.filter((x, i) => i === 0 || cmp(s[i - 1], x) !== 0);
}

// str::splitn(n, sep)
export function splitn(s, n, sep) {
  const out = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// PathBuf::join as displayed by `Path::display` / `to_string_lossy` (no normalisation):
// an absolute component replaces the base; otherwise one separator is inserted.
const SEP = process.platform === 'win32' ? '\\' : '/';
export function pathJoin(base, part) {
  if (isAbsolute(part)) {
    if (process.platform === 'win32' && /^[\\/](?![\\/])/.test(part)) {
      const prefix = /^([a-zA-Z]:)/.exec(base);
      return (prefix ? prefix[1] : '') + part;
    }
    return part;
  }
  if (!base) return part;
  const endsWithSep = process.platform === 'win32' ? /[\\/]$/.test(base) : base.endsWith('/');
  return endsWithSep ? base + part : base + SEP + part;
}

// std::io::Error Display for the fs errors the watch store can surface.
const WIN = {
  ENOENT_FILE: ['The system cannot find the file specified.', 2], ENOENT_PATH: ['The system cannot find the path specified.', 3],
  EACCES: ['Access is denied.', 5], EPERM: ['Access is denied.', 5], EISDIR: ['Access is denied.', 5],
  EBUSY: ['The process cannot access the file because it is being used by another process.', 32],
  EEXIST: ['Cannot create a file when that file already exists.', 183], ENOTEMPTY: ['The directory is not empty.', 145],
  ENOTDIR: ['The directory name is invalid.', 267], ENOSPC: ['There is not enough space on the disk.', 112],
};
const UNIX = {
  ENOENT: ['No such file or directory', 2], EACCES: ['Permission denied', 13], EPERM: ['Operation not permitted', 1],
  EISDIR: ['Is a directory', 21], EBUSY: ['Device or resource busy', 16], EEXIST: ['File exists', 17],
  ENOTEMPTY: ['Directory not empty', process.platform === 'darwin' ? 66 : 39], ENOTDIR: ['Not a directory', 20], ENOSPC: ['No space left on device', 28],
};
// Windows reports ERROR_FILE_NOT_FOUND (2) only when the parent directory exists; a missing
// parent — or a parent that is a file (watch/<file>/config.json) — is ERROR_PATH_NOT_FOUND (3).
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export function ioErrorText(e) {
  if (e && e.rustText) return e.rustText;
  const code = e?.code;
  let t;
  if (process.platform === 'win32') {
    if (code === 'ENOENT') t = e.path && !isDir(dirname(e.path)) ? WIN.ENOENT_PATH : WIN.ENOENT_FILE;
    else t = WIN[code];
  } else t = UNIX[code];
  return t ? `${t[0]} (os error ${t[1]})` : (e?.message ?? String(e));
}
// Wrap an fs call so a thrown Node error carries Rust's io::Error text as its message.
export function io(fn) {
  try { return fn(); } catch (e) { throw ioError(e); }
}
export const ioError = (e) => Object.assign(new Error(ioErrorText(e)), { code: e?.code, cause: e });

// fs::read_to_string: io errors, then "stream did not contain valid UTF-8".
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });   // keep a BOM, like Rust
export function decodeUtf8(buf) {
  try { return UTF8.decode(buf); } catch { throw new Error('stream did not contain valid UTF-8'); }
}
