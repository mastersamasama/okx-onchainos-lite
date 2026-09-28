// PRIVATE — Rust / serde / crate semantics the payment ports depend on (JS equivalents differ at
// the edges). Owned by the payment foundation; candidates for promotion into a shared core module:
//   • serde_json::Value accessors (`as_str`, `as_u64`, Index `v["k"]` → Null) and Number Display;
//   • ruint `U256::from_str` / `from_str_radix`, std `u64/u128::from_str` (exact error texts);
//   • hex 0.4 `hex::decode` and const-hex / alloy `Address::from_str` (exact error texts);
//   • base64 0.22 engines (STANDARD / STANDARD_NO_PAD / URL_SAFE / URL_SAFE_NO_PAD, strict);
//   • std::io::Error Display ("<text> (os error N)") and reqwest::Error Display.
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { F64, formatF64 } from '../core/json.mjs';

// ── serde_json::Value accessors ──────────────────────────────────────
export const isNum = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && !Buffer.isBuffer(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Value::get(k) → value | undefined (None)
export const get = (v, k) => (typeof k === 'number'
  ? (Array.isArray(v) && k >= 0 && k < v.length ? v[k] : undefined)
  : (isObj(v) && hasOwn(v, k) && v[k] !== undefined ? v[k] : undefined));
// Value Index `v[k]` → value | null (Value::Null)
export const at = (v, k) => { const r = get(v, k); return r === undefined ? null : r; };
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined);
const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n;
// Value::as_u64 → number (BigInt beyond 2^53) | undefined
export function asU64(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && !Object.is(v, -0) ? v : (Object.is(v, -0) ? 0 : undefined);
  if (typeof v === 'bigint') return v >= 0n && v <= U64_MAX ? (Number.isSafeInteger(Number(v)) ? Number(v) : v) : undefined;
  return undefined;
}
export function asI64(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v === 'bigint') return v >= I64_MIN && v <= I64_MAX ? (Number.isSafeInteger(Number(v)) ? Number(v) : v) : undefined;
  return undefined;
}
// serde_json::Number Display (`n.to_string()`).
export function numText(v) {
  if (v instanceof F64) return formatF64(v.valueOf());
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(Object.is(v, -0) ? 0 : v) : formatF64(v);
  return String(v);
}
// Value Display (`format!("{v}")`) for the few places upstream prints a whole value.
export { stringify as valueText } from '../core/json.mjs';

// Deep clone of a parsed JSON value (keeps F64 / BigInt identity).
export function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = cloneValue(v[k]); return o; }
  return v;
}

// ── integers ─────────────────────────────────────────────────────────
export const U256_MAX = (1n << 256n) - 1n;

// ruint Uint::from_str_radix (radix ≤ 36): '_' ignored; a letter digit ≥ radix fails at once in
// from_base_be; any other char stops the digit stream and fails after the digits seen so far.
export function u256FromStrRadix(src, radix, max = U256_MAX) {
  let value = 0n, bad;
  const r = BigInt(radix);
  for (const c of String(src)) {
    let d;
    if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
    else if (c >= 'a' && c <= 'z') d = c.charCodeAt(0) - 87;
    else if (c >= 'A' && c <= 'Z') d = c.charCodeAt(0) - 55;
    else if (c === '_') continue;
    else { bad = c; break; }
    if (d >= radix) throw new Error(`digit ${d} is out of range for base ${radix}`);
    value = value * r + BigInt(d);
    if (value > max) throw new Error('the value is too large to fit the target type');
  }
  if (bad !== undefined) throw new Error(`invalid digit: ${bad}`);
  return value;
}
// ruint `impl FromStr for Uint` — 0x / 0o / 0b prefixes select the radix.
export function u256FromStr(src) {
  const s = String(src);
  const p = s.slice(0, 2);
  if (p === '0x' || p === '0X') return u256FromStrRadix(s.slice(2), 16);
  if (p === '0o' || p === '0O') return u256FromStrRadix(s.slice(2), 8);
  if (p === '0b' || p === '0B') return u256FromStrRadix(s.slice(2), 2);
  return u256FromStrRadix(s, 10);
}
// std `<uN as FromStr>` (u64 / u128): optional '+', ASCII digits only.
export function parseUint(src, bits = 64) {
  const s = String(src);
  if (s === '') throw new Error('cannot parse integer from empty string');
  const body = s[0] === '+' ? s.slice(1) : s;
  if (body === '' || !/^[0-9]+$/.test(body)) throw new Error('invalid digit found in string');
  const v = BigInt(body);
  if (v > (1n << BigInt(bits)) - 1n) throw new Error('number too large to fit in target type');
  return v;
}
export const tryUint = (src, bits) => { try { return parseUint(src, bits); } catch { return undefined; } };
// BigInt → number when it is safe (for u64 JSON numbers).
export const toNum = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// ── hex ──────────────────────────────────────────────────────────────
// Rust `char` Debug (used by hex's InvalidHexCharacter Display).
export function charDebug(c) {
  const cp = c.codePointAt(0);
  const esc = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 39: "\\'", 92: '\\\\' }[cp];
  if (esc) return `'${esc}'`;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad) return `'\\u{${cp.toString(16)}}'`;
  return `'${c}'`;
}
const HEXV = (b) => (b >= 48 && b <= 57 ? b - 48 : b >= 97 && b <= 102 ? b - 87 : b >= 65 && b <= 70 ? b - 55 : -1);
// hex 0.4 `hex::decode` → Buffer; errors carry hex's Display text.
export function hexDecode(s) {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length % 2 !== 0) throw new Error('Odd number of digits');
  const out = Buffer.alloc(b.length / 2);
  for (let i = 0; i < b.length; i += 2) {
    const hi = HEXV(b[i]); if (hi < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(b[i]))} at position ${i}`);
    const lo = HEXV(b[i + 1]); if (lo < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(b[i + 1]))} at position ${i + 1}`);
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}
// const-hex `decode_to_array::<N>` (alloy FixedBytes / Address / B256 `from_str`): odd length →
// strip one lowercase "0x" → exact length → first invalid char (index after the prefix).
export function fixedBytesFromStr(s, n) {
  let b = Buffer.from(String(s), 'utf8');
  if (b.length % 2 !== 0) throw new Error('odd number of digits');
  if (b[0] === 0x30 && b[1] === 0x78) b = b.subarray(2);
  if (b.length !== n * 2) throw new Error('invalid string length');
  const out = Buffer.alloc(n);
  for (let i = 0; i < b.length; i++) {
    const v = HEXV(b[i]);
    if (v < 0) throw new Error(`invalid character ${charDebug(String.fromCharCode(b[i]))} at position ${i}`);
    if (i % 2 === 0) out[i >> 1] = v << 4; else out[i >> 1] |= v;
  }
  return out;
}
export const addressFromStr = (s) => fixedBytesFromStr(s, 20);
export const b256FromStr = (s) => fixedBytesFromStr(s, 32);
// str::trim_start_matches("0x") — strips every leading repetition.
export const trimStartMatches0x = (s) => { let t = String(s); while (t.startsWith('0x')) t = t.slice(2); return t; };
export const hex0x = (buf) => '0x' + Buffer.from(buf).toString('hex');
// 32-byte big-endian word.
export const word = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex');
export const wordAddr = (addr20) => Buffer.concat([Buffer.alloc(12), Buffer.from(addr20)]);

// ── base64 0.22 (GeneralPurpose engines, decode_allow_trailing_bits = false) ────────
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const table = (alpha) => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[alpha.charCodeAt(i)] = i; return t; };
const TABLES = { std: table(STD), url: table(URL) };
const PAD = 0x3d;
// padding: 'canonical' (STANDARD / URL_SAFE) | 'none' (*_NO_PAD). Throws DecodeError Display text.
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
  // decode_suffix
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
  let num = ((ms[0] << 26) | (ms[1] << 20) | (ms[2] << 14) | (ms[3] << 8)) >>> 0;
  const mask = nbytes === 0 ? 0xffffffff : (0xffffffff >>> (nbytes * 8)) >>> 0;
  if (((num & mask) >>> 0) !== 0) throw new Error(`Invalid last symbol ${last}, offset ${quads + morsels - 1}.`);
  for (let k = 0; k < nbytes; k++) { out.push((num >>> 24) & 255); num = (num << 8) >>> 0; }
  return Buffer.from(out);
}
export const B64 = {
  STANDARD: (s) => b64Decode(s, 'std', 'canonical'),
  STANDARD_NO_PAD: (s) => b64Decode(s, 'std', 'none'),
  URL_SAFE: (s) => b64Decode(s, 'url', 'canonical'),
  URL_SAFE_NO_PAD: (s) => b64Decode(s, 'url', 'none'),
};
export const b64urlNoPad = (buf) => Buffer.from(buf).toString('base64url');

// ── std::io::Error Display ───────────────────────────────────────────
const WIN = {
  ENOENT_FILE: ['The system cannot find the file specified.', 2], ENOENT_PATH: ['The system cannot find the path specified.', 3],
  EACCES: ['Access is denied.', 5], EPERM: ['Access is denied.', 5], EISDIR: ['Access is denied.', 5],
  EBUSY: ['The process cannot access the file because it is being used by another process.', 32],
  EEXIST: ['Cannot create a file when that file already exists.', 183], ENOTDIR: ['The directory name is invalid.', 267],
  ENOSPC: ['There is not enough space on the disk.', 112],
};
const UNIX = {
  ENOENT: ['No such file or directory', 2], EACCES: ['Permission denied', 13], EPERM: ['Operation not permitted', 1],
  EISDIR: ['Is a directory', 21], EBUSY: ['Device or resource busy', 16], EEXIST: ['File exists', 17],
  ENOTDIR: ['Not a directory', 20], ENOSPC: ['No space left on device', 28],
};
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export function ioErrorText(e) {
  const code = e?.code;
  let t;
  if (process.platform === 'win32') {
    if (code === 'ENOENT') t = e.path && !isDir(dirname(e.path)) ? WIN.ENOENT_PATH : WIN.ENOENT_FILE;
    else t = WIN[code];
  } else t = UNIX[code];
  return t ? `${t[0]} (os error ${t[1]})` : (e?.message ?? String(e));
}

// ── reqwest::Error Display (`e.to_string()`, no source chain) ────────
export class ReqwestError extends Error {
  constructor(kind, url, cause) {
    super(kind + (url ? ` for url (${url})` : ''));
    this.kind = kind; this.url = url; this.cause = cause;
  }
}
export const hrefOf = (u) => { try { return new globalThis.URL(u).href; } catch { return u; } };

// ── chrono 0.4 `DateTime::parse_from_rfc3339` ────────────────────────
// Returns Unix seconds (BigInt, may be negative); throws chrono ParseError Display texts.
const CHRONO = {
  OutOfRange: 'input is out of range', Invalid: 'input contains invalid characters',
  TooShort: 'premature end of input', TooLong: 'trailing input',
};
const perr = (k) => new Error(CHRONO[k]);
export function parseRfc3339(input) {
  const b = Buffer.from(String(input), 'utf8');
  if (b.length < 19) throw perr('TooShort');   // "YYYY-MM-DDTHH:MM:SS" minimum, checked up front
  let i = 0;
  // scan::number(s, min, max)
  const number = (min, max) => {
    if (b.length - i < min) throw perr('TooShort');
    let n = 0;
    for (let k = 0; k < max && i + k < b.length; k++) {
      const c = b[i + k];
      if (c < 0x30 || c > 0x39) {
        if (k < min) throw perr('Invalid');
        i += k;
        return n;
      }
      n = n * 10 + (c - 0x30);
    }
    i = Math.min(i + max, b.length);
    return n;
  };
  const char = (c) => {
    if (i >= b.length) throw perr('TooShort');
    if (b[i] !== c) throw perr('Invalid');
    i++;
  };
  const range = (v, lo, hi) => { if (v < lo || v > hi) throw perr('OutOfRange'); return v; };
  const year = number(4, 4); char(0x2d);
  const month = range(number(2, 2), 1, 12); char(0x2d);
  const day = range(number(2, 2), 1, 31);
  if (i >= b.length) throw perr('TooShort');
  if (![0x74, 0x54, 0x20].includes(b[i])) throw perr('Invalid');
  i++;
  const hour = range(number(2, 2), 0, 23); char(0x3a);
  const minute = range(number(2, 2), 0, 59); char(0x3a);
  const second = range(number(2, 2), 0, 60);
  if (b[i] === 0x2e) {
    i++;
    number(1, 9);
    while (i < b.length && b[i] >= 0x30 && b[i] <= 0x39) i++;
  }
  // scan::timezone_offset(s, colon, allow_zulu, !allow_missing_minutes, !allow_tz_minus_sign)
  let offset;
  if (i >= b.length) throw perr('TooShort');
  let neg;
  if (b[i] === 0x2b) { neg = false; i++; }
  else if (b[i] === 0x2d) { neg = true; i++; }
  else if (b[i] === 0x5a || b[i] === 0x7a) { offset = 0; i++; }
  else throw perr('Invalid');
  if (offset === undefined) {
    if (b.length - i < 2) throw perr('TooShort');
    const isD = (c) => c >= 0x30 && c <= 0x39;
    if (!isD(b[i]) || !isD(b[i + 1])) throw perr('Invalid');
    const hh = (b[i] - 0x30) * 10 + (b[i + 1] - 0x30);
    i += 2;
    char(0x3a);
    if (b.length - i < 2) throw perr('TooShort');
    const [m1, m2] = [b[i], b[i + 1]];
    let mm;
    if (m1 >= 0x30 && m1 <= 0x35 && isD(m2)) mm = (m1 - 0x30) * 10 + (m2 - 0x30);
    else if (m1 >= 0x36 && m1 <= 0x39 && isD(m2)) throw perr('OutOfRange');
    else throw perr('Invalid');
    i += 2;
    offset = (hh * 3600 + mm * 60) * (neg ? -1 : 1);
    if (Math.abs(offset) > (23 * 60 + 59) * 60) throw perr('OutOfRange');
  }
  if (i < b.length) throw perr('TooLong');
  const lastDay = new Date(Date.UTC(2000, month, 0)).getUTCDate();   // month length (leap-agnostic)
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const mdays = month === 2 ? (leap ? 29 : 28) : lastDay;
  if (day > mdays) throw perr('OutOfRange');
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, Math.min(second, 59), 0);
  return BigInt(Math.floor(d.getTime() / 1000)) - BigInt(offset);
}

// ── serde_jcs (RFC 8785) ─────────────────────────────────────────────
// Keys sorted by UTF-16 code units, compact, ES6 number / string serialisation.
export function jcs(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof F64) return JSON.stringify(v.valueOf());
  if (typeof v === 'bigint') return JSON.stringify(Number(v));
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => jcs(x === undefined ? null : x)).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
}
