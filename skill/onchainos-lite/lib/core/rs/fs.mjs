// std::fs / std::path / std::io::Error semantics: Rust's io::Error Display ("<OS text> (os error N)"
// on each platform), strict UTF-8 reads that keep a BOM, read_dir in OS order, create_new, and
// Path component rules (file_name / extension / file_stem / set_extension / PathBuf::push).
import { statSync, opendirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const WIN = process.platform === 'win32';

// ── std::io::Error ──────────────────────────────────────────────────

// errno name → [FormatMessageW / strerror text, raw OS error code]
const WIN_TEXT = {
  ENOENT_FILE: ['The system cannot find the file specified.', 2], ENOENT_PATH: ['The system cannot find the path specified.', 3],
  EACCES: ['Access is denied.', 5], EPERM: ['Access is denied.', 5], EISDIR: ['Access is denied.', 5],
  EBUSY: ['The process cannot access the file because it is being used by another process.', 32],
  EEXIST: ['Cannot create a file when that file already exists.', 183], ENOTDIR: ['The directory name is invalid.', 267],
  ENOSPC: ['There is not enough space on the disk.', 112], ENOTEMPTY: ['The directory is not empty.', 145],
};
const UNIX_TEXT = {
  ENOENT: ['No such file or directory', 2], EACCES: ['Permission denied', 13], EPERM: ['Operation not permitted', 1],
  EISDIR: ['Is a directory', 21], EBUSY: ['Device or resource busy', 16], EEXIST: ['File exists', 17],
  ENOTDIR: ['Not a directory', 20], ENOSPC: ['No space left on device', 28],
  ENOTEMPTY: ['Directory not empty', process.platform === 'darwin' ? 66 : 39],
};

// Socket errnos (reqwest / tungstenite wrap the io::Error): Windows FormatMessageW (English) or strerror.
const SOCKET_TEXT = {
  win32: {
    ECONNREFUSED: ['No connection could be made because the target machine actively refused it.', 10061],
    ECONNRESET: ['An existing connection was forcibly closed by the remote host.', 10054],
    ECONNABORTED: ['An established connection was aborted by the software in your host machine.', 10053],
    ETIMEDOUT: ['A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.', 10060],
    ENETUNREACH: ['A socket operation was attempted to an unreachable network.', 10051],
    EHOSTUNREACH: ['A socket operation was attempted to an unreachable host.', 10065],
    EADDRNOTAVAIL: ['The requested address is not valid in its context.', 10049],
    EPIPE: ['The pipe is being closed.', 232],
  },
  linux: {
    ECONNREFUSED: ['Connection refused', 111], ECONNRESET: ['Connection reset by peer', 104], ECONNABORTED: ['Software caused connection abort', 103],
    ETIMEDOUT: ['Connection timed out', 110], ENETUNREACH: ['Network is unreachable', 101], EHOSTUNREACH: ['No route to host', 113],
    EADDRNOTAVAIL: ['Cannot assign requested address', 99], EPIPE: ['Broken pipe', 32],
  },
  darwin: {
    ECONNREFUSED: ['Connection refused', 61], ECONNRESET: ['Connection reset by peer', 54], ECONNABORTED: ['Software caused connection abort', 53],
    ETIMEDOUT: ['Operation timed out', 60], ENETUNREACH: ['Network is unreachable', 51], EHOSTUNREACH: ['No route to host', 65],
    EADDRNOTAVAIL: ["Can't assign requested address", 49], EPIPE: ['Broken pipe', 32],
  },
};
// io::Error Display of a socket errno, or undefined when the code has no entry.
export function socketErrorText(code) {
  const t = (SOCKET_TEXT[process.platform] ?? SOCKET_TEXT.linux)[code];
  return t ? `${t[0]} (os error ${t[1]})` : undefined;
}

// Resolver failure (Node ENOTFOUND / EAI_AGAIN) as Rust prints it: Windows WSA error text, else
// std's "failed to lookup address information: <gai_strerror>".
export function dnsErrorText(code) {
  if (process.platform === 'win32') return code === 'EAI_AGAIN'
    ? 'This is usually a temporary error during hostname resolution and means that the local server did not receive a response from an authoritative server. (os error 11002)'
    : 'No such host is known. (os error 11001)';
  const detail = process.platform === 'darwin' ? 'nodename nor servname provided, or not known'
    : code === 'EAI_AGAIN' ? 'Temporary failure in name resolution' : 'Name or service not known';
  return `failed to lookup address information: ${detail}`;
}

// std::io::Error whose message is Rust's Display text; `code` keeps the Node errno name.
export class IoError extends Error {
  constructor(text, code, cause) {
    super(text);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const isDirSync = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// io::Error Display of a Node fs error. Windows reports ERROR_FILE_NOT_FOUND (2) only when the
// parent directory exists; a missing parent (or one that is a file) is ERROR_PATH_NOT_FOUND (3).
export function ioErrorText(e) {
  if (e instanceof IoError) return e.message;
  const code = e?.code;
  let t;
  if (WIN) t = code === 'ENOENT' ? (e.path && !isDirSync(dirname(e.path)) ? WIN_TEXT.ENOENT_PATH : WIN_TEXT.ENOENT_FILE) : WIN_TEXT[code];
  else t = UNIX_TEXT[code];
  return t ? `${t[0]} (os error ${t[1]})` : (e?.message ?? String(e));
}
// A Node system error (errno-named `code`) → IoError; any other error passes through unchanged
// (anyhow `?` on an io::Result).
export function ioError(e) {
  if (e instanceof IoError || typeof e?.code !== 'string' || !/^E[A-Z0-9]+$/.test(e.code)) return e;
  return new IoError(ioErrorText(e), e.code, e);
}
// Run an fs call, surfacing its failure as an IoError.
export function io(fn) {
  try { return fn(); } catch (e) { throw ioError(e); }
}

// ── std::fs ─────────────────────────────────────────────────────────

// io::ErrorKind::InvalidData Display of read_to_string / read_line.
export const INVALID_UTF8 = 'stream did not contain valid UTF-8';
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });   // keeps a BOM, like Rust
// Strict UTF-8 decode as std::io reads do it; invalid data → IoError(INVALID_UTF8).
export function decodeUtf8(bytes) {
  try { return UTF8.decode(bytes); } catch { throw new IoError(INVALID_UTF8, 'EINVALIDDATA'); }
}
// std::fs::read / std::fs::read_to_string
export const readBytes = (path) => io(() => readFileSync(path));
export const readToString = (path) => decodeUtf8(readBytes(path));
// std::fs::create_dir_all
export const createDirAll = (path) => io(() => mkdirSync(path, { recursive: true }));
// `let _ = std::fs::remove_file(p)` / `std::fs::rename(a, b).is_ok()`
export const removeFileQuiet = (path) => { try { rmSync(path); } catch {} };
export const renameQuiet = (from, to) => { try { renameSync(from, to); return true; } catch { return false; } };

// Path::exists / is_file / is_dir (follow symlinks)
export const exists = (p) => { try { statSync(p); return true; } catch { return false; } };
export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = isDirSync;
// `SystemTime::now().duration_since(metadata(p)?.modified()?)` in whole seconds; undefined when
// the metadata is unavailable or the mtime lies in the future.
export function modifiedAgeSecs(p) {
  let mtime;
  try { mtime = statSync(p).mtimeMs; } catch { return undefined; }
  const d = Date.now() - mtime;
  return d < 0 ? undefined : Math.floor(d / 1000);
}

// std::fs::read_dir(p) → child paths in OS order. Node's readdirSync strcmp-sorts on Unix
// (uv_fs_scandir) while Rust yields raw readdir(3) / FindNextFileW order, so iterate with
// opendirSync (uv_fs_readdir).
export function readDirPaths(p) {
  let dir;
  try { dir = opendirSync(p); } catch (e) { throw ioError(e); }
  const out = [];
  try {
    for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) out.push(join(p, ent.name));
  } catch (e) { throw ioError(e); } finally { try { dir.closeSync(); } catch {} }
  return out;
}

// OpenOptions::new().write(true).create_new(true).mode(0o600) + write_all [+ sync_all].
// false when the file already exists; any other failure throws an IoError.
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
  if (!WIN) { try { chmodSync(p, 0o600); } catch {} }
  return true;
}

// ── std::path ───────────────────────────────────────────────────────

// std::sys::path::windows::parse_prefix → [prefixLength, verbatim] (length 0 = no prefix).
// Verbatim `\\?\x`, VerbatimUNC `\\?\UNC\srv\share`, VerbatimDisk `\\?\C:`, DeviceNS `\\.\x`,
// UNC `\\srv\share` (either separator) and Disk `C:`.
function windowsPrefix(s) {
  // PrefixParser normalises '/' to '\' in the first 8 bytes before matching.
  const head = s.slice(0, 8).replace(/\//g, '\\');
  const nextComponent = (i, verbatim) => {
    let j = i;
    while (j < s.length && !(s[j] === '\\' || (!verbatim && s[j] === '/'))) j++;
    return j;
  };
  if (head.startsWith('\\\\')) {
    if (head.startsWith('\\\\?\\') && !s.slice(0, 4).includes('/')) {
      if (head.startsWith('\\\\?\\UNC\\')) {
        const serverEnd = nextComponent(8, true);
        if (serverEnd >= s.length) return [serverEnd, true];
        const shareEnd = nextComponent(serverEnd + 1, true);
        return [shareEnd > serverEnd + 1 ? shareEnd : serverEnd, true];
      }
      // parse_drive_exact: `X:` followed by a verbatim separator or the end.
      if (/^[A-Za-z]:/.test(s.slice(4, 6)) && (s.length === 6 || s[6] === '\\')) return [6, true];
      return [nextComponent(4, true), true];
    }
    if (head.startsWith('\\\\.\\')) return [nextComponent(4, false), false];
    const serverEnd = nextComponent(2, false);
    if (serverEnd > 2 && serverEnd < s.length) {
      const shareEnd = nextComponent(serverEnd + 1, false);
      if (shareEnd > serverEnd + 1) return [shareEnd, false];
    }
    return [0, false];
  }
  return /^[A-Za-z]:/.test(s) ? [2, false] : [0, false];
}
const parsePrefix = (s) => (WIN ? windowsPrefix(s) : [0, false]);
// Windows separates on both `\` and `/` (verbatim `\\?\` paths on `\` only), Unix on `/`.
const isSep = (c, verbatim) => c === '/' ? !verbatim : WIN && c === '\\';

// The last Normal component → { name, end } (end = its end index in `s`), or undefined when the
// path is empty, only a root / prefix, or ends in `..`. `.` components are skipped (they are
// CurDir in verbatim paths, which also yields no file name).
function lastNormal(s) {
  const [start, verbatim] = parsePrefix(s);
  let end = s.length;
  for (;;) {
    while (end > start && isSep(s[end - 1], verbatim)) end--;
    let b = end;
    while (b > start && !isSep(s[b - 1], verbatim)) b--;
    const name = s.slice(b, end);
    if (name === '.' && !verbatim && b > start) { end = b; continue; }
    return name === '' || name === '.' || name === '..' ? undefined : { name, end };
  }
}
// rsplit_file_at_dot → [stem, extension | undefined]
function splitAtDot(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, undefined] : [name.slice(0, i), name.slice(i + 1)];
}
// Path::file_name / extension / file_stem
export const fileName = (p) => lastNormal(String(p))?.name;
export const extension = (p) => { const n = fileName(p); return n === undefined ? undefined : splitAtDot(n)[1]; };
export const fileStem = (p) => { const n = fileName(p); return n === undefined ? undefined : splitAtDot(n)[0]; };
// Path::with_extension (set_extension: truncate right after the file stem, then `.ext` unless empty)
export function withExtension(p, ext) {
  const s = String(p);
  const last = lastNormal(s);
  if (last === undefined) return s;
  const stemEnd = last.end - last.name.length + splitAtDot(last.name)[0].length;
  return s.slice(0, stemEnd) + (ext === '' ? '' : `.${ext}`);
}
// PathBuf::join / push as displayed (no normalisation): a prefixed part (`C:x`, `\\srv\share`)
// or a Unix-absolute part replaces the base; a rooted part without prefix (`\x`, Windows) keeps
// only the base's prefix; otherwise one separator is inserted unless the base is empty, ends
// with a separator or is a bare drive (`C:`).
export function pathJoin(base, part) {
  const b = String(base), p = String(part);
  if (!WIN) return p.startsWith('/') || b === '' ? p : (b.endsWith('/') ? b + p : `${b}/${p}`);
  if (windowsPrefix(p)[0] > 0) return p;
  const [baseEnd] = windowsPrefix(b);
  if (isSep(p[0], false)) return b.slice(0, baseEnd) + p;
  const needSep = b !== '' && !isSep(b[b.length - 1], false) && !(baseEnd === b.length && baseEnd === 2);
  return needSep ? `${b}\\${p}` : b + p;
}
