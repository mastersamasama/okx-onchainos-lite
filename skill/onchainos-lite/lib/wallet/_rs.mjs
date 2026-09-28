// Private helpers for lib/wallet/*: Rust std semantics that JS built-ins get wrong at the edges.
import { F64 } from '../core/json.mjs';

// str::trim — char::is_whitespace (Unicode White_Space; includes U+0085, excludes U+FEFF).
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

// serde_json Value::as_i64 / as_u64 on a parsed value (number | BigInt | F64).
export const isI64 = (v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n);
export const isU64 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n && v <= 18446744073709551615n);
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
// serde_json Value::get(key) on a non-object → None.
export const getField = (v, k) => (isObject(v) ? v[k] : undefined);

// <i64 as FromStr>::from_str → BigInt | undefined (optional sign, ASCII digits, range-checked).
export function parseI64(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v >= -9223372036854775808n && v <= 9223372036854775807n ? v : undefined;
}
// <u64 as FromStr>::from_str → BigInt | undefined
export function parseU64(s) {
  if (!/^\+?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v <= 18446744073709551615n ? v : undefined;
}

// Rust `format!("{:.N}", f64)`: exact decimal expansion of the binary value, ties to even.
export function formatFixed(x, digits) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(Math.abs(x));
  const bits = buf.readBigUInt64BE();
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  let mant, exp;
  if (expBits === 0) { mant = frac; exp = -1074; } else { mant = frac | (1n << 52n); exp = expBits - 1075; }
  // value = mant * 2^exp ; scaled = value * 10^digits = num / den
  let num = mant * 10n ** BigInt(digits), den = 1n;
  if (exp >= 0) num <<= BigInt(exp); else den <<= BigInt(-exp);
  let q = num / den;
  const r = num % den;
  if (r * 2n > den || (r * 2n === den && (q & 1n) === 1n)) q += 1n;
  let s = q.toString().padStart(digits + 1, '0');
  if (digits > 0) s = s.slice(0, -digits) + '.' + s.slice(-digits);
  return (neg ? '-' : '') + s;
}

// Rust `str::parse::<f64>()` → number | undefined (no surrounding whitespace allowed).
export function parseF64(s) {
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(s);
  if (!m) return undefined;
  if (m[2]) return m[2].toLowerCase() === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity;
  return Number(m[1] + m[3]);
}

// serde_json Value::as_f64 on a parsed value.
export function asF64(v) {
  if (v instanceof F64) return v.valueOf();
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

// Race a promise against an absolute deadline (ms epoch) — tokio::time::timeout_at.
// Resolves to { ok: true, value } or { ok: false } on timeout; never rejects on timeout.
export function timeoutAt(promise, deadlineMs) {
  let timer;
  const delay = Math.max(0, deadlineMs - Date.now());
  const t = new Promise((res) => { timer = setTimeout(() => res({ ok: false }), delay); });
  return Promise.race([promise.then((value) => ({ ok: true, value }), (error) => ({ ok: true, error })), t])
    .finally(() => clearTimeout(timer));
}
