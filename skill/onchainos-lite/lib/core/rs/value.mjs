// serde_json::Value accessors over lite's lossless JSON representation (core/json.mjs `parse`):
// integers are numbers (BigInt beyond 2^53), decimals / exponents are F64, objects plain.
// Integer accessors return the JSON integer form (see num.mjs).
import { F64, formatF64, stringify } from '../json.mjs';
import { jsonInt } from './num.mjs';

const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n, U64_MAX = 2n ** 64n - 1n;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Value::is_object / is_number / is_i64 / is_u64
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && !Buffer.isBuffer(v);
export const isNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
export const isI64 = (v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'bigint' && v >= I64_MIN && v <= I64_MAX);
export const isU64 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n && v <= U64_MAX);

// Value::get(key | index) → value | undefined (None)
export const get = (v, k) => (typeof k === 'number'
  ? (Array.isArray(v) && k >= 0 && k < v.length ? v[k] : undefined)
  : (isObject(v) && hasOwn(v, k) && v[k] !== undefined ? v[k] : undefined));
// Index `v[k]` → value | null (Value::Null)
export const at = (v, k) => { const r = get(v, k); return r === undefined ? null : r; };
// `value[key] = v` (IndexMut): Null becomes an object, an object gets the key; any other type
// panics upstream (release build aborts) — reported here as an error. Returns the (new) target.
export function setIndex(value, key, v) {
  if (value === null || value === undefined) return { [key]: v };
  if (isObject(value)) {
    Object.defineProperty(value, key, { value: v, enumerable: true, writable: true, configurable: true });
    return value;
  }
  const kind = Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'number';
  throw new Error(`cannot access key ${JSON.stringify(key)} in JSON ${kind}`);
}

// Value::as_str / as_bool / as_array
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined);
export const asArray = (v) => (Array.isArray(v) ? v : undefined);
// Value::as_i64 / as_u64 → JSON integer | undefined (an F64 never qualifies)
export function asI64(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v + 0 : undefined;
  if (typeof v === 'bigint') return v >= I64_MIN && v <= I64_MAX ? jsonInt(v) : undefined;
  return undefined;
}
export function asU64(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v + 0 : undefined;
  if (typeof v === 'bigint') return v >= 0n && v <= U64_MAX ? jsonInt(v) : undefined;
  return undefined;
}
// Value::as_f64 (every number)
export function asF64(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof F64) return v.valueOf();
  return undefined;
}

// serde_json::Number Display (`n.to_string()`)
export function numText(v) {
  if (v instanceof F64) return formatF64(v.valueOf());
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v + 0) : formatF64(v);
  return String(v);
}
// Value Display (`format!("{v}")` / `v.to_string()`): compact JSON, sorted keys.
export const valueText = (v) => stringify(v);
// Value::clone (keeps F64 / BigInt identity)
export function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isObject(v)) { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = cloneValue(v[k]); return o; }
  return v;
}
