// PRIVATE — Rust std / crate semantics the shared transaction pipeline depends on, with the
// exact error texts of the crates upstream links (base64 0.22 STANDARD, hex 0.4, bs58 0.5,
// serde_jcs 0.1). Node's built-ins are lenient where these crates are strict (e.g.
// Buffer.from(s, 'base64') accepts "not-base64"), which changes upstream's error branches.
// Candidate for promotion into lib/core (requested in the F2b report).
import { createHash } from 'node:crypto';
import { F64 } from '../../core/json.mjs';
import { base58Encode } from '../../crypto/encoding.mjs';

// ── str helpers ─────────────────────────────────────────────────────

// str::trim — char::is_whitespace (Unicode White_Space).
const WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
export function rustTrim(s) {
  s = String(s);
  let i = 0, j = s.length;
  while (i < j && WS.has(s.charCodeAt(i))) i++;
  while (j > i && WS.has(s.charCodeAt(j - 1))) j--;
  return s.slice(i, j);
}
export const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const eqIgnoreAsciiCase = (a, b) => a.length === b.length && asciiLower(a) === asciiLower(b);
export const byteLen = (s) => Buffer.byteLength(String(s), 'utf8');
export const isAllAsciiDigits = (s) => /^[0-9]+$/.test(s);
export const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && !Buffer.isBuffer(v);
// serde_json Value::get(key) — None on a non-object or a missing key.
export const get = (v, k) => (isObject(v) && hasOwn(v, k) ? v[k] : undefined);
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined);

// Value::as_u64 → BigInt | undefined (integers only; F64 never qualifies).
export function asU64(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'bigint' && v >= 0n && v <= 18446744073709551615n) return v;
  return undefined;
}
// <u64 as FromStr> → BigInt | undefined (optional '+', ASCII digits, range-checked).
export function parseU64(s) {
  if (typeof s !== 'string' || !/^\+?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s.startsWith('+') ? s.slice(1) : s);
  return v <= 18446744073709551615n ? v : undefined;
}
// <u32 as FromStr> → number | undefined
export function parseU32(s) {
  const v = parseU64(s);
  return v !== undefined && v <= 4294967295n ? Number(v) : undefined;
}
// A u64 BigInt as the JSON integer the serializer should emit.
export const u64Json = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// <char as Debug> — escape_debug of one char ('x', '\n', '\u{7f}').
export function charDebug(c) {
  const cp = c.codePointAt(0);
  const esc = { 0x00: '\\0', 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r', 0x27: "\\'", 0x5c: '\\\\' }[cp];
  if (esc) return `'${esc}'`;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad) return `'\\u{${cp.toString(16)}}'`;
  return `'${c}'`;
}
// <str as Debug> — "…" with escape_debug (used for `{:?}` of backend strings).
export function strDebug(s) {
  let out = '"';
  for (const c of String(s)) {
    const cp = c.codePointAt(0);
    const esc = { 0x00: '\\0', 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' }[cp];
    if (esc) out += esc;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad) out += `\\u{${cp.toString(16)}}`;
    else out += c;
  }
  return out + '"';
}

// ── base64 0.22 (general_purpose::STANDARD: canonical padding, no trailing bits) ──

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_TABLE = new Int16Array(256).fill(-1);
for (let i = 0; i < B64.length; i++) B64_TABLE[B64.charCodeAt(i)] = i;
const PAD = 0x3d;
const invalidByte = (i, b) => new Error(`Invalid symbol ${b}, offset ${i}.`);

// base64::engine::general_purpose::STANDARD.decode → Buffer; throws DecodeError Display text.
export function base64Decode(s) {
  const input = Buffer.from(String(s), 'utf8');
  const len = input.length;
  const rem = len % 4;
  if (rem === 1) {
    const last = input[len - 1];
    if (last !== PAD && B64_TABLE[last] < 0) throw invalidByte(len - 1, last);
  }
  const complete = Math.max(0, Math.max(0, len - rem) - (rem === 0 ? 4 : 0));
  const out = [];
  for (let i = 0; i < complete; i += 4) {
    let acc = 0;
    for (let j = 0; j < 4; j++) {
      const m = B64_TABLE[input[i + j]];
      if (m < 0) throw invalidByte(i + j, input[i + j]);
      acc = (acc << 6) | m;
    }
    out.push((acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff);
  }
  // decode_suffix
  let morsels = 0, pads = 0, firstPad = 0, lastSymbol = 0;
  const m4 = [0, 0, 0, 0];
  for (let k = 0; complete + k < len; k++) {
    const b = input[complete + k];
    if (b === PAD) {
      if (k < 2) throw invalidByte(complete + k, b);
      if (pads === 0) firstPad = k;
      pads++;
      continue;
    }
    if (pads > 0) throw invalidByte(complete + firstPad, PAD);
    lastSymbol = b;
    const m = B64_TABLE[b];
    if (m < 0) throw invalidByte(complete + k, b);
    m4[morsels++] = m;
  }
  if (len > 0 && morsels < 2) throw new Error(`Invalid input length: ${complete + morsels}`);
  if ((pads + morsels) % 4 !== 0) throw new Error('Invalid padding');
  const bytes = Math.floor((morsels * 6) / 8);
  let num = ((m4[0] << 26) | (m4[1] << 20) | (m4[2] << 14) | (m4[3] << 8)) >>> 0;
  const mask = bytes === 0 ? 0xffffffff : (0xffffffff >>> (bytes * 8)) >>> 0;
  if (len > 0 && ((num & mask) >>> 0) !== 0) throw new Error(`Invalid last symbol ${lastSymbol}, offset ${complete + morsels - 1}.`);
  for (let k = 0; k < bytes; k++) { out.push((num >>> 24) & 0xff); num = (num << 8) >>> 0; }
  return Buffer.from(out);
}
export const base64Encode = (b) => Buffer.from(b).toString('base64');

// ── hex 0.4 ─────────────────────────────────────────────────────────

const HEXV = (b) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1);
// hex::decode → Buffer; throws FromHexError Display text.
export function hexDecode(s) {
  const input = Buffer.from(String(s), 'utf8');
  if (input.length % 2) throw new Error('Odd number of digits');
  const out = Buffer.alloc(input.length / 2);
  for (let i = 0; i < input.length; i += 2) {
    const hi = HEXV(input[i]);
    if (hi < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(input[i]))} at position ${i}`);
    const lo = HEXV(input[i + 1]);
    if (lo < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(input[i + 1]))} at position ${i + 1}`);
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}
export const hexEncode = (b) => Buffer.from(b).toString('hex');

// ── bs58 0.5 (Bitcoin alphabet) ─────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < B58.length; i++) B58_TABLE[B58.charCodeAt(i)] = i;
// bs58::decode(s).into_vec() → Buffer; throws bs58::decode::Error Display text.
export function bs58Decode(s) {
  const input = Buffer.from(String(s), 'utf8');
  let n = 0n;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c > 127) throw new Error(`provided string contained non-ascii character starting at byte ${i}`);
    const v = B58_TABLE[c];
    if (v < 0) throw new Error(`provided string contained invalid character ${charDebug(String.fromCharCode(c))} at byte ${i}`);
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0x31) zeros++;
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}
export const bs58Encode = (b) => base58Encode(Buffer.from(b));

// ── serde_jcs 0.1 (RFC 8785) ────────────────────────────────────────

const F64_KEY = Symbol.for('ocl.f64');
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
// serde_jcs::to_string of a serde_json::Value: compact, keys sorted, f64 via ryu-js (ECMAScript
// Number::toString), 0.0 → "0".
export function jcsStringify(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof F64 || (typeof v === 'object' && v[F64_KEY] !== undefined)) {
    const x = Number(v instanceof F64 ? v.valueOf() : v[F64_KEY]);
    if (!Number.isFinite(x)) throw new Error('oh no');
    return x === 0 ? '0' : String(x);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (v === 0 ? '0' : String(v));
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => jcsStringify(x === undefined ? null : x)).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(cmpBytes);
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcsStringify(v[k])).join(',') + '}';
}
export const sha256Hex = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// ── anyhow downcast ─────────────────────────────────────────────────

// anyhow::Error::downcast::<E>() also succeeds through `.context()` layers; lite context()
// errors keep the wrapped error in `.cause`.
export function downcast(e, Type) {
  for (let cur = e, depth = 0; cur && depth < 16; cur = cur.cause, depth++) if (cur instanceof Type) return cur;
  return undefined;
}
