// PRIVATE — Rust std / serde_json semantics the defi port needs (not a handler file).
// Values use lite's lossless JSON representation (core/json.mjs parse).
import { CliError } from '../../core/errors.mjs';
import { fromStr, T } from '../../wallet/_serde-json.mjs';
import { isObject } from '../../wallet/strategy/_serde.mjs';
export { isObject, get, asI64, asU64, asF64, toU32 } from '../../wallet/strategy/_serde.mjs';
export { formatFixed } from '../../wallet/_rs.mjs';

// serde_json Value::as_str
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
// serde_json Value::as_bool
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined);

const U32_MAX = 4294967295n, U64_MAX = 18446744073709551615n, U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n;
const bigOut = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// `s.parse::<uN>().ok()` — optional '+', ASCII digits, in range → number | BigInt | undefined
function parseUnsigned(s, max) {
  if (typeof s !== 'string' || !/^\+?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s.startsWith('+') ? s.slice(1) : s);
  return v <= max ? v : undefined;
}
export const parseU32 = (s) => { const v = parseUnsigned(s, U32_MAX); return v === undefined ? undefined : Number(v); };
export const parseU64 = (s) => { const v = parseUnsigned(s, U64_MAX); return v === undefined ? undefined : bigOut(v); };
// u128 as BigInt (callers compare / subtract exactly)
export const parseU128 = (s) => parseUnsigned(s, U128_MAX);
// `s.parse::<i64>().ok()` → number | BigInt | undefined
export function parseI64(s) {
  if (typeof s !== 'string' || !/^[+-]?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v >= I64_MIN && v <= I64_MAX ? bigOut(v) : undefined;
}
// `s.parse::<f64>().ok()` (no surrounding whitespace; inf/infinity/nan accepted)
export function parseF64(s) {
  if (typeof s !== 'string') return undefined;
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(s);
  if (!m) return undefined;
  if (m[2]) return m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity);
  return Number(m[1] + m[3]);
}

// `value[key] = v` (serde_json IndexMut): Null becomes an object; an object gets the key; any other
// type panics upstream (release build aborts) — reported here as an error.
export function setIndex(value, key, v) {
  if (value === null || value === undefined) return { [key]: v };
  if (isObject(value)) {
    Object.defineProperty(value, key, { value: v, enumerable: true, writable: true, configurable: true });
    return value;
  }
  const kind = Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'number';
  throw new Error(`cannot access key ${JSON.stringify(key)} in JSON ${kind}`);
}

// `format!("{}", anyhow_error)` — the outermost message only (no `: cause` chain).
export function outermost(e) {
  if (e instanceof CliError && e.cause !== undefined) {
    const inner = `: ${e.cause?.message ?? e.cause}`;
    if (e.message.endsWith(inner)) return e.message.slice(0, -inner.length);
  }
  return e?.message ?? String(e);
}

// `serde_json::from_str::<Vec<Value>>(text)` → array; throws serde_json::Error (Display text).
export const parseJsonArray = (text) => fromStr(String(text), T.vec(T.value));
