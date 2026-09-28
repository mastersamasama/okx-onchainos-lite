// PRIVATE — Rust / serde_json / chrono / std semantics the agent-commerce ports depend on
// (JS equivalents differ at the edges). Owned by the agent foundation (A0); candidates for
// promotion into a shared core module:
//   • serde_json::Value accessors (`get`, Index `v["k"]` → Null, `as_i64` / `as_u64` / `as_f64`)
//   • Rust `{:?}` of str / Option, `{:.1}` of f64, ExitStatus / io::Error / spawn error Display
//   • base64 0.22 STANDARD / URL_SAFE_NO_PAD (strict) encode/decode
//   • chrono 0.4.44 formatting: Utc / Local rfc3339 (AutoSi), `%Y-%m-%d %H:%M`, DateTime<Utc>
//     serde (`…Z`), RFC 3339 parsing into nanosecond BigInts.
import { statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { F64, formatF64, displayF64, stringify } from '../core/json.mjs';

// ── serde_json::Value accessors ──────────────────────────────────────
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && !Buffer.isBuffer(v);
export const isNum = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Value::get(k) → value | undefined (None)
export const get = (v, k) => (typeof k === 'number'
  ? (Array.isArray(v) && k >= 0 && k < v.length ? v[k] : undefined)
  : (isObj(v) && hasOwn(v, k) && v[k] !== undefined ? v[k] : undefined));
// Value Index `v[k]` → value | null (Value::Null)
export const at = (v, k) => { const r = get(v, k); return r === undefined ? null : r; };
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined);
export const asArray = (v) => (Array.isArray(v) ? v : undefined);
const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n, U64_MAX = 18446744073709551615n;
const num = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);
// Value::as_i64 → number (BigInt beyond 2^53) | undefined
export function asI64(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? (Object.is(v, -0) ? 0 : v) : undefined;
  if (typeof v === 'bigint') return v >= I64_MIN && v <= I64_MAX ? num(v) : undefined;
  return undefined;
}
// Value::as_u64
export function asU64(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? (Object.is(v, -0) ? 0 : v) : undefined;
  if (typeof v === 'bigint') return v >= 0n && v <= U64_MAX ? num(v) : undefined;
  return undefined;
}
// Value::as_f64 (every number)
export function asF64(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof F64) return v.valueOf();
  return undefined;
}
// i64 in the JS-safe range → number; else BigInt. Comparisons with numbers work either way.
export const i64Eq = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && BigInt(a) === BigInt(b);
// serde_json::Number Display (`n.to_string()`).
export function numText(v) {
  if (v instanceof F64) return formatF64(v.valueOf());
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(Object.is(v, -0) ? 0 : v) : formatF64(v);
  return String(v);
}
// Value Display (`format!("{v}")` / `v.to_string()`): compact JSON, sorted keys.
export const valueText = (v) => stringify(v === undefined ? null : v);
// Deep clone of a parsed JSON value (keeps F64 / BigInt identity).
export function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = cloneValue(v[k]); return o; }
  return v;
}
// `str.parse::<i64>()` (Rust FromStr: optional leading '+' or '-', ASCII digits only).
export function parseI64(s) {
  if (typeof s !== 'string' || !/^[+-]?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v >= I64_MIN && v <= I64_MAX ? num(v) : undefined;
}
export function parseI32(s) {
  const v = parseI64(s);
  return v !== undefined && typeof v === 'number' && v >= -2147483648 && v <= 2147483647 ? v : undefined;
}
export function parseU64(s) {
  if (typeof s !== 'string' || !/^\+?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v <= U64_MAX ? num(v) : undefined;
}
export const i32Of = (n) => (n !== undefined && n !== null && typeof n === 'number' && n >= -2147483648 && n <= 2147483647 ? n : undefined);

// ── std string helpers ───────────────────────────────────────────────
const WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
export const isWs = (c) => WS.has(typeof c === 'number' ? c : c.charCodeAt(0));
export function trimStart(s) { let i = 0; while (i < s.length && WS.has(s.charCodeAt(i))) i++; return s.slice(i); }
export function trimEnd(s) { let j = s.length; while (j > 0 && WS.has(s.charCodeAt(j - 1))) j--; return s.slice(0, j); }
export const trim = (s) => trimEnd(trimStart(String(s)));
export const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const eqIgnoreAsciiCase = (a, b) => a.length === b.length && asciiLower(a) === asciiLower(b);
export const byteLen = (s) => Buffer.byteLength(String(s), 'utf8');
export const charCount = (s) => [...String(s)].length;
// str::split_whitespace
export const splitWhitespace = (s) => { const out = []; let cur = ''; for (const ch of String(s)) { if (isWs(ch)) { if (cur) out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; };
// str::lines (splits on \n, strips a trailing \r of each line; no final empty line)
export function lines(s) {
  const parts = String(s).split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
// char::is_control (Unicode Cc)
export const isControl = (ch) => { const c = ch.codePointAt(0); return c <= 0x1f || (c >= 0x7f && c <= 0x9f); };
// char::is_alphanumeric (Unicode Alphabetic || Numeric)
export const isAlphanumeric = (ch) => /[\p{Alphabetic}\p{N}]/u.test(ch);

// Rust `{:?}` of a str.
export function rustDebugStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0xd800 && c <= 0xdfff)) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}
// Rust `{:?}` of Option<i64> / Option<&str>.
export const debugOptInt = (v) => (v === undefined || v === null ? 'None' : `Some(${v})`);
export const debugOptStr = (v) => (v === undefined || v === null ? 'None' : `Some(${rustDebugStr(v)})`);
// Rust `{:.1}` of a non-negative ratio num/den (exact, round-half-to-even like core::fmt).
export function fixed1Ratio(numerator, denominator) {
  const n = BigInt(numerator) * 10n, d = BigInt(denominator);
  let q = n / d; const r = n % d;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) q += 1n;
  return `${q / 10n}.${q % 10n}`;
}
export { displayF64 };

// ── base64 0.22 (strict, canonical) ─────────────────────────────────
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URLA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const table = (alpha) => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[alpha.charCodeAt(i)] = i; return t; };
const TABLES = { std: table(STD), url: table(URLA) };
const PAD = 0x3d;
// padding: 'canonical' (STANDARD) | 'none' (*_NO_PAD). Throws base64::DecodeError Display text.
export function b64Decode(input, alphabet = 'std', padding = 'canonical') {
  const inp = Buffer.from(String(input), 'utf8');
  const t = TABLES[alphabet];
  const rem = inp.length % 4;
  if (rem === 1) {
    const last = inp[inp.length - 1];
    if (last !== PAD && t[last] < 0) throw new Error(`Invalid symbol ${last}, offset ${inp.length - 1}.`);
  }
  const quads = Math.max(0, inp.length - rem - (rem === 0 ? 4 : 0));
  const out = [];
  for (let i = 0; i < quads; i += 4) {
    let acc = 0;
    for (let j = 0; j < 4; j++) {
      const m = t[inp[i + j]];
      if (m < 0) throw new Error(`Invalid symbol ${inp[i + j]}, offset ${i + j}.`);
      acc = (acc << 6) | m;
    }
    out.push((acc >> 16) & 255, (acc >> 8) & 255, acc & 255);
  }
  let morsels = 0, pads = 0, firstPad = 0, last = 0;
  const ms = [0, 0, 0, 0];
  for (let k = quads; k < inp.length; k++) {
    const b = inp[k], li = k - quads;
    if (b === PAD) {
      if (li < 2) throw new Error(`Invalid symbol ${b}, offset ${k}.`);
      if (pads === 0) firstPad = li;
      pads++;
      continue;
    }
    if (pads > 0) throw new Error(`Invalid symbol ${PAD}, offset ${quads + firstPad}.`);
    last = b;
    const m = t[b];
    if (m < 0) throw new Error(`Invalid symbol ${b}, offset ${k}.`);
    ms[morsels++] = m;
  }
  if (inp.length && morsels < 2) throw new Error(`Invalid input length: ${quads + morsels}`);
  if (padding === 'canonical' && (pads + morsels) % 4 !== 0) throw new Error('Invalid padding');
  if (padding === 'none' && pads > 0) throw new Error('Invalid padding');
  const nbytes = Math.floor((morsels * 6) / 8);
  let n = ((ms[0] << 26) | (ms[1] << 20) | (ms[2] << 14) | (ms[3] << 8)) >>> 0;
  const mask = nbytes === 0 ? 0xffffffff : (0xffffffff >>> (nbytes * 8)) >>> 0;
  if (((n & mask) >>> 0) !== 0) throw new Error(`Invalid last symbol ${last}, offset ${quads + morsels - 1}.`);
  for (let k = 0; k < nbytes; k++) { out.push((n >>> 24) & 255); n = (n << 8) >>> 0; }
  return Buffer.from(out);
}
export const b64StdDecode = (s) => b64Decode(s, 'std', 'canonical');
export const b64UrlNoPadDecode = (s) => b64Decode(s, 'url', 'none');
export const b64StdEncode = (buf) => Buffer.from(buf).toString('base64');
export const b64UrlNoPadEncode = (buf) => Buffer.from(buf).toString('base64url');

// ── std::io::Error / process Display ─────────────────────────────────
const WIN = {
  ENOENT_FILE: ['The system cannot find the file specified.', 2], ENOENT_PATH: ['The system cannot find the path specified.', 3],
  EACCES: ['Access is denied.', 5], EPERM: ['Access is denied.', 5], EISDIR: ['Access is denied.', 5],
  EBUSY: ['The process cannot access the file because it is being used by another process.', 32],
  EEXIST: ['Cannot create a file when that file already exists.', 183], ENOTDIR: ['The directory name is invalid.', 267],
  ENOSPC: ['There is not enough space on the disk.', 112], ENOTEMPTY: ['The directory is not empty.', 145],
};
const UNIX = {
  ENOENT: ['No such file or directory', 2], EACCES: ['Permission denied', 13], EPERM: ['Operation not permitted', 1],
  EISDIR: ['Is a directory', 21], EBUSY: ['Device or resource busy', 16], EEXIST: ['File exists', 17],
  ENOTDIR: ['Not a directory', 20], ENOSPC: ['No space left on device', 28], ENOTEMPTY: ['Directory not empty', 39],
};
const isDirSync = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// std::io::Error Display for a Node fs error.
export function ioErrorText(e) {
  const code = e?.code;
  let t;
  if (process.platform === 'win32') {
    if (code === 'ENOENT') t = e.path && !isDirSync(dirname(e.path)) ? WIN.ENOENT_PATH : WIN.ENOENT_FILE;
    else t = WIN[code];
  } else t = UNIX[code];
  if (!t && process.platform === 'darwin' && code === 'ENOTEMPTY') t = ['Directory not empty', 66];
  return t ? `${t[0]} (os error ${t[1]})` : (e?.message ?? String(e));
}
// std::str::from_utf8 of raw bytes: strict (invalid UTF-8 throws the io::Error Display
// "stream did not contain valid UTF-8") and — unlike TextDecoder's default — keeps a leading
// U+FEFF, which Rust never strips (serde_json then rejects it as `expected value`).
export const INVALID_UTF8 = 'stream did not contain valid UTF-8';
export function utf8Strict(buf) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch {
    throw Object.assign(new Error(INVALID_UTF8), { code: 'EINVALIDDATA' });
  }
}
// std::fs::read_to_string(path): fs errors keep their Node shape (render with ioErrorText);
// undecodable content throws INVALID_UTF8.
export const readToString = (path) => utf8Strict(readFileSync(path));
// Error Display of a read_to_string failure.
export const readErrorText = (e) => (e?.code === 'EINVALIDDATA' ? e.message : ioErrorText(e));
// Command::spawn failure Display (program lookup failure).
export function spawnErrorText(e) {
  if (e?.code === 'ENOENT') return process.platform === 'win32' ? 'program not found' : 'No such file or directory (os error 2)';
  if (e?.code === 'EACCES') return process.platform === 'win32' ? 'Access is denied. (os error 5)' : 'Permission denied (os error 13)';
  return ioErrorText(e);
}
// std::process::ExitStatus Display.
export function exitStatusText(code, signal) {
  if (process.platform === 'win32') return `exit code: ${code ?? 1}`;
  if (code === null || code === undefined) {
    const n = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGABRT: 6, SIGSEGV: 11, SIGHUP: 1, SIGPIPE: 13 }[signal];
    return n ? `signal: ${n} (${signal})` : `signal: ${signal}`;
  }
  return `exit status: ${code}`;
}
// ExitStatus::code() Debug (`Some(n)` / `None`).
export const exitCodeDebug = (code) => (code === null || code === undefined ? 'None' : `Some(${code})`);

// ── chrono 0.4.44 ────────────────────────────────────────────────────
const MIN_YEAR = -262144, MAX_YEAR = 262143;
const p2 = (n) => String(n).padStart(2, '0');
// chrono `%Y`: 4-digit zero pad inside 0..=9999, else explicit sign.
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));
// Civil date from days since 1970-01-01 (proleptic Gregorian; exact for any safe integer).
function civil(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
// UTC broken-down time for unix seconds (number/BigInt) + nanos; undefined when chrono would
// reject the timestamp (outside NaiveDateTime range).
export function utcParts(secs, nanos = 0) {
  const s = BigInt(secs);
  const days = s >= 0n ? s / 86400n : -((-s + 86399n) / 86400n);
  const sod = Number(s - days * 86400n);
  if (days > 200000000n || days < -200000000n) return undefined;
  const { y, m, d } = civil(Number(days));
  if (y < MIN_YEAR || y > MAX_YEAR) return undefined;
  return { y, m, d, hh: Math.floor(sod / 3600), mm: Math.floor((sod % 3600) / 60), ss: sod % 60, nanos };
}
// Local broken-down time (system TZ, as chrono::Local) + offset seconds east of UTC.
export function localParts(secs, nanos = 0) {
  const s = Number(secs);
  if (!Number.isFinite(s) || Math.abs(s) > 8.64e12) {
    const u = utcParts(secs, nanos);
    return u ? { ...u, off: 0 } : undefined;
  }
  const dt = new Date(s * 1000);
  if (Number.isNaN(dt.getTime())) return undefined;
  const off = -dt.getTimezoneOffset() * 60;
  const u = utcParts(BigInt(s) + BigInt(off), nanos);
  return u ? { ...u, off } : undefined;
}
// chrono AutoSi fraction: "", ".mmm", ".uuuuuu" or ".nnnnnnnnn".
function fraction(nanos) {
  if (!nanos) return '';
  if (nanos % 1000000 === 0) return '.' + String(nanos / 1000000).padStart(3, '0');
  if (nanos % 1000 === 0) return '.' + String(nanos / 1000).padStart(6, '0');
  return '.' + String(nanos).padStart(9, '0');
}
function offsetText(off, useZ) {
  if (off === 0 && useZ) return 'Z';
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const base = `${sign}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}`;
  return a % 60 ? `${base}:${p2(a % 60)}` : base;
}
const dateTimeText = (p) => `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)}T${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)}${fraction(p.nanos)}`;
// DateTime::to_rfc3339 of parts (with offset).
export const rfc3339Of = (p, useZ = false) => dateTimeText(p) + offsetText(p.off ?? 0, useZ);
// Utc.timestamp_opt(n, 0).single().map(to_rfc3339) → string | undefined
export function utcRfc3339(secs) { const p = utcParts(secs); return p ? rfc3339Of({ ...p, off: 0 }) : undefined; }

// SystemTime::now() as nanoseconds since the epoch (BigInt; 100 ns resolution on Windows).
export function nowNanos() {
  const ms = performance.timeOrigin + performance.now();
  let nanos = BigInt(Math.floor(ms)) * 1000000n + BigInt(Math.floor((ms % 1) * 1e6));
  if (process.platform === 'win32') nanos -= nanos % 100n;
  return nanos;
}
export const nowSecs = () => Math.floor(Date.now() / 1000);
export const nowMillis = () => Date.now();
const splitNanos = (ns) => { const b = BigInt(ns); const secs = b >= 0n ? b / 1000000000n : -((-b + 999999999n) / 1000000000n); return [secs, Number(b - secs * 1000000000n)]; };
// Utc::now().to_rfc3339() → "…+00:00"
export function utcNowRfc3339() { const [s, n] = splitNanos(nowNanos()); return rfc3339Of({ ...utcParts(s, n), off: 0 }); }
// DateTime<Utc> serde / to_rfc3339 of a nanosecond timestamp.
export function utcNanosSerde(ns) { const [s, n] = splitNanos(ns); return rfc3339Of({ ...utcParts(s, n), off: 0 }, true); }
export function utcNanosRfc3339(ns) { const [s, n] = splitNanos(ns); return rfc3339Of({ ...utcParts(s, n), off: 0 }, false); }
// Local::now().to_rfc3339()
export function localNowRfc3339() { const [s, n] = splitNanos(nowNanos()); const p = localParts(s, n); return rfc3339Of(p); }
// Local::now() broken-down (for `%Y%m%d_%H%M%S` + millis).
export function localNow() { const [s, n] = splitNanos(nowNanos()); return localParts(s, n); }
// `%m-%d %H:%M`, `%Y-%m-%d %H:%M` (local) — undefined when unrepresentable.
export function fmtLocalMdHm(secs) { const p = localParts(secs); return p ? `${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)}` : undefined; }
export function fmtLocalYmdHmOffset(secs) {
  const p = localParts(secs);
  if (!p) return undefined;
  const a = Math.abs(p.off);
  return `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} (UTC${p.off < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))})`;
}
export function fmtUtcYmdHm(secs) { const p = utcParts(secs); return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} (UTC+00:00)` : undefined; }
export function localStamp(p) { return `${yearText(p.y)}${p2(p.m)}${p2(p.d)}_${p2(p.hh)}${p2(p.mm)}${p2(p.ss)}${String(Math.floor(p.nanos / 1000000)).padStart(3, '0')}`; }

// chrono DateTime<FixedOffset>::from_str (relaxed RFC 3339) → UTC nanoseconds BigInt | undefined.
export function parseRfc3339Nanos(s) {
  const m = /^\s*([+-]?\d{4,6})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,}))?\s*(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/.exec(String(s));
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 60) return undefined;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const mdays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > mdays) return undefined;
  const frac = m[7] ? BigInt((m[7] + '000000000').slice(0, 9)) : 0n;
  const off = m[8] ? 0 : (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 3600 + Number(m[11]) * 60);
  const secs = BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + Math.min(se, 59)) - BigInt(off);
  return secs * 1000000000n + frac;
}
// `DateTime::parse_from_rfc3339(v).timestamp()` (strict-ish) → seconds | undefined
export function parseRfc3339Secs(s) {
  const ns = parseRfc3339Nanos(s);
  if (ns === undefined) return undefined;
  const [secs] = splitNanos(ns);
  return num(secs);
}
