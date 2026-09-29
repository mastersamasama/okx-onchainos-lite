// serde / serde_json pieces the MCP server needs: rmcp's `Parameters<T>` extraction
// (`serde_json::from_value::<T>(Value::Object(arguments))`, decoded by core/serde.mjs) and the
// Rust `{:?}` texts that surface in handshake errors.
//
// The params structs of upstream cli/src/mcp/mod.rs are not re-declared here: their
// shape is read from the captured tools/list catalogue (lib/mcp-tools.json), whose
// schemars inputSchema encodes exactly what serde needs:
//   "string"                      → String                (required unless it has a default)
//   ["string","null"]             → Option<String>
//   ["integer","null"] + format   → Option<u8|u32|u64|usize|i64>
//   ["number","null"]             → Option<f64>
//   "boolean" + default           → #[serde(default)] bool
//   "array" (items string)+default→ #[serde(default)] Vec<String>
// `required` lists the required fields in declaration order, which is the order serde's
// derive reports `missing field` in.
import { F64, formatF64 } from '../core/json.mjs';
import { T, fromValue } from '../core/serde.mjs';
import { strDebug } from '../core/rs/str.mjs';

const isF64 = (v) => v instanceof F64;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !isF64(v);
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const sortedKeys = (o) => Object.keys(o).sort(cmpBytes);

// schemars integer `format` → Rust integer type
const INT = { uint8: T.u8, uint32: T.u32, uint64: T.u64, uint: T.usize, int64: T.i64 };

// One property schema → its deserialisation type.
function fieldType(prop) {
  const types = [].concat(prop.type);
  const base = types.find((t) => t !== 'null');
  let t;
  switch (base) {
    case 'string': t = T.string; break;
    case 'boolean': t = T.bool; break;
    case 'integer': t = INT[prop.format] ?? T.i64; break;
    case 'number': t = T.f64; break;
    case 'array': t = T.vec(fieldType(prop.items ?? {})); break;
    default: t = T.value;
  }
  return types.includes('null') ? T.option(t) : t;
}

// The params struct: required fields first (declaration order), then the Option /
// #[serde(default)] ones.
const COMPILED = new WeakMap();
function paramsType(schema) {
  let t = COMPILED.get(schema);
  if (t) return t;
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const names = [...required, ...Object.keys(props).filter((k) => !required.includes(k))];
  t = T.struct(schema.title, names.map((k) => {
    const p = props[k] ?? {};
    return 'default' in p ? [k, fieldType(p), () => structuredClone(p.default)] : [k, fieldType(p)];
  }));
  COMPILED.set(schema, t);
  return t;
}

// serde_json::from_value::<Params>(Value::Object(args)) for the struct described by `schema`.
// Returns an object keyed by the Rust field names: absent Option fields are null, defaults applied.
export const fromArguments = (schema, args) => fromValue(args, paramsType(schema));

// A tool registered without `Parameters<T>` gets rmcp's empty-object schema (no `title`).
export const takesParams = (schema) => typeof schema?.title === 'string';

// ── Rust `{:?}` of serde_json::Value / Map (used by rmcp's handshake error texts) ──
export function debugValue(v) {
  if (v === null || v === undefined) return 'Null';
  if (typeof v === 'boolean') return `Bool(${v})`;
  if (typeof v === 'number' || typeof v === 'bigint') return `Number(${v})`;
  if (isF64(v)) return `Number(${formatF64(v.valueOf())})`;
  if (typeof v === 'string') return `String(${strDebug(v)})`;
  if (Array.isArray(v)) return `Array [${v.map(debugValue).join(', ')}]`;
  return `Object ${debugMap(v)}`;
}
export const debugMap = (o) => `{${sortedKeys(o).map((k) => `${strDebug(k)}: ${debugValue(o[k])}`).join(', ')}}`;
export const debugOpt = (v, f) => (v === undefined || v === null ? 'None' : `Some(${f(v)})`);

// A JSON number as serde deserializes it into f64 (u64/i64 → `as f64`, floats as parsed).
export const isJsonNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || isF64(v);
export const toF64 = (v) => (typeof v === 'number' ? v : Number(v.valueOf()));

// Rust `{:?}` of an f64 (core::fmt float_to_general_debug): shortest round-trip digits;
// exponential form ("1e16", "1.5e-5") when |x| < 1e-4 or |x| >= 1e16 (x ≠ 0), else decimal with at
// least one fractional digit ("1.0", "0.5").
export function debugF64(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const sign = x < 0 || Object.is(x, -0) ? '-' : '';
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = a.toExponential().split('e');
    return `${sign}${m}e${Number(e)}`;
  }
  const s = String(a);   // never exponential in [1e-4, 1e16)
  return sign + (s.includes('.') ? s : `${s}.0`);
}

export { isObject, isF64 };
