// Private serde_json::Value accessors used by the workflow merge logic, so JS reads parsed
// API data exactly the way upstream's `value["k"]`, `.get("k")`, `.as_str()`, `.as_u64()` do.
// Values come from core/json.mjs `parse` (integers: number | BigInt, decimals: F64).
const FLOAT = Symbol.for('ocl.f64');
const RAW = Symbol.for('ocl.raw');
const U64_MAX = 18446744073709551615n;

// Value::Object
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(FLOAT in v) && !(RAW in v);

// Value::get(key) — Some(field) of an object (the field may be JSON null), else None (undefined).
export const get = (v, key) => (isObject(v) && Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined);

// `value[key]` (Index<&str>) — the field of an object, else Value::Null.
export const index = (v, key) => { const x = get(v, key); return x === undefined ? null : x; };

// Value::as_str / as_array
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
export const asArray = (v) => (Array.isArray(v) ? v : undefined);

// Value::as_u64 — only non-negative JSON integers (serde parses "-0" and decimals as f64 → None).
// Returned as BigInt so counts beyond 2^53 compare exactly.
export function asU64(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && !Object.is(v, -0) ? BigInt(v) : undefined;
  if (typeof v === 'bigint') return v >= 0n && v <= U64_MAX ? v : undefined;
  return undefined;
}

// Rust `String` ordering (UTF-8 byte order).
export const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// str::to_ascii_uppercase — only a-z change (JS toUpperCase would also map 'ı' → 'I', 'ſ' → 'S').
export const toAsciiUppercase = (s) => String(s).replace(/[a-z]+/g, (m) => m.toUpperCase());

// `{:?}` of a `&[&str]` of plain ASCII literals: ["A", "B"].
export const debugStrList = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
