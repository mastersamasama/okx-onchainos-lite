// PRIVATE — serde_json::Value accessors and a small `serde_json::from_value::<T>` emulation for the
// strategy DTOs (types.rs). Values use lite's lossless representation (core/json.mjs parse):
// safe integers → number, larger u64/i64 → BigInt, decimals/exponents → F64.
// Error texts are serde's (no position — from_value errors carry none):
//   invalid type: <unexpected>, expected <what> · invalid value: integer `N`, expected i32
//   missing field `x` · invalid length N, expected fewer elements in array
import { F64, displayF64 } from '../../core/json.mjs';
import { rustDebugStr } from '../_serde-json.mjs';

const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n, U64_MAX = 18446744073709551615n;
const I32_MIN = -2147483648n, I32_MAX = 2147483647n;

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const isInt = (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';
const isNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
const big = (v) => BigInt(v);

// serde_json Value::as_i64 → BigInt-safe number | undefined
export function asI64(v) {
  if (!isInt(v)) return undefined;
  const b = big(v);
  return b >= I64_MIN && b <= I64_MAX ? (typeof v === 'number' ? v : b) : undefined;
}
// serde_json Value::as_u64
export function asU64(v) {
  if (!isInt(v)) return undefined;
  const b = big(v);
  return b >= 0n && b <= U64_MAX ? (typeof v === 'number' ? v : b) : undefined;
}
// serde_json Value::as_f64
export const asF64 = (v) => (isNumber(v) ? Number(v) : undefined);
// Rust `x as i32` (wrapping truncation of an i64)
export const toI32 = (v) => Number(BigInt.asIntN(32, big(v)));
// Rust `x as u32` (wrapping truncation of a u64)
export const toU32 = (v) => Number(BigInt.asUintN(32, big(v)));
// serde_json Value::get(key) on an object (None otherwise / when absent)
export const get = (v, k) => (isObject(v) && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);

// serde::de::Unexpected Display for a serde_json::Value
export function unexpected(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return `boolean \`${v}\``;
  if (typeof v === 'string') return `string ${rustDebugStr(v)}`;
  if (Array.isArray(v)) return 'sequence';
  if (v instanceof F64) {
    const x = v.valueOf();
    const s = displayF64(x);
    return `floating point \`${Number.isFinite(x) && !s.includes('.') ? s + '.0' : s}\``;
  }
  if (isInt(v)) return `integer \`${big(v)}\``;
  return 'map';
}

export class SerdeError extends Error {}
// Key under which a flatten struct keeps its unmodelled entries (a symbol: never collides with BE keys).
export const EXTRA = Symbol('serde.flatten.extra');
const invalidType = (v, exp) => new SerdeError(`invalid type: ${unexpected(v)}, expected ${exp}`);

// Type descriptors. struct fields: [jsonName, type, hasDefault]
export const D = {
  string: { kind: 'string' },
  bool: { kind: 'bool' },
  i32: { kind: 'int', name: 'i32', lo: I32_MIN, hi: I32_MAX },
  i64: { kind: 'int', name: 'i64', lo: I64_MIN, hi: I64_MAX },
  value: { kind: 'value' },
  option: (t) => ({ kind: 'option', t }),
  vec: (t) => ({ kind: 'vec', t }),
  struct: (name, fields, { flatten = false } = {}) => ({ kind: 'struct', name, fields, flatten }),
};

// serde_json::from_value::<t>(v) → decoded JS value (struct → plain object keyed by JSON name,
// absent Option → null, flatten extras under [EXTRA]); throws SerdeError.
export function fromValue(v, t) {
  switch (t.kind) {
    case 'value': return v;
    case 'option': return v === null || v === undefined ? null : fromValue(v, t.t);
    case 'string':
      if (typeof v !== 'string') throw invalidType(v, 'a string');
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw invalidType(v, 'a boolean');
      return v;
    case 'int': {
      if (!isInt(v)) throw invalidType(v, t.name);
      const b = big(v);
      if (b < t.lo || b > t.hi) throw new SerdeError(`invalid value: integer \`${b}\`, expected ${t.name}`);
      return typeof v === 'number' ? v : (Number.isSafeInteger(Number(b)) ? Number(b) : b);
    }
    case 'vec':
      if (!Array.isArray(v)) throw invalidType(v, 'a sequence');
      return v.map((x) => fromValue(x, t.t));
    case 'struct': return structFromValue(v, t);
    default: throw new Error(`unknown descriptor ${t.kind}`);
  }
}

function structFromValue(v, t) {
  const exp = `struct ${t.name}`;
  const out = {};
  if (Array.isArray(v)) {
    // deserialize_struct → visit_seq (a flatten struct uses deserialize_map: no seq form)
    if (t.flatten) throw invalidType(v, exp);
    t.fields.forEach(([name, ft, hasDefault], i) => {
      if (i < v.length) out[name] = fromValue(v[i], ft);
      else if (hasDefault || ft.kind === 'option') out[name] = defaultOf(ft);
      else throw new SerdeError(`invalid length ${i}, expected ${exp} with ${t.fields.length} elements`);
    });
    if (v.length > t.fields.length) throw new SerdeError(`invalid length ${v.length}, expected fewer elements in array`);
    return out;
  }
  if (!isObject(v)) throw invalidType(v, exp);
  const known = new Map(t.fields.map((f) => [f[0], f]));
  const extra = {};
  // serde_json Map is a BTreeMap → entries visited in sorted key order
  for (const k of Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const f = known.get(k);
    if (f) out[k] = fromValue(v[k], f[1]);
    else if (t.flatten) extra[k] = v[k];
  }
  for (const [name, ft, hasDefault] of t.fields) {
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (hasDefault || ft.kind === 'option') out[name] = defaultOf(ft);
    else throw new SerdeError(`missing field \`${name}\``);
  }
  if (t.flatten) out[EXTRA] = extra;
  return out;
}

function defaultOf(t) {
  switch (t.kind) {
    case 'option': return null;
    case 'vec': return [];
    case 'int': return 0;
    case 'string': return '';
    case 'bool': return false;
    default: return null;
  }
}
