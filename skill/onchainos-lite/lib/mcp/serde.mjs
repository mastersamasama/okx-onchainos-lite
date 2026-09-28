// serde / serde_json semantics the MCP server needs, reproduced for rmcp's
// `Parameters<T>` extraction (`serde_json::from_value::<T>(Value::Object(arguments))`)
// and for the Rust `{:?}` texts that surface in handshake errors.
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
// derive reports `missing field` in. Present keys are visited in serde_json::Map order
// (BTreeMap: sorted by bytes), so the first type error is the one of the smallest key.
import { F64, formatF64 } from '../core/json.mjs';

export class SerdeError extends Error {}

const isF64 = (v) => v instanceof F64;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !isF64(v);
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const sortedKeys = (o) => Object.keys(o).sort(cmpBytes);

// ── Rust `{:?}` of a str (core::fmt Debug: char::escape_debug_ext, grapheme-extended escaped) ──
const NON_PRINTABLE = /^(?:[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}|\p{Grapheme_Extend})$/u;
export function debugStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (NON_PRINTABLE.test(ch)) out += `\\u{${ch.codePointAt(0).toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

// ── serde::de::Unexpected as printed by serde_json's JsonUnexpected ──
export function unexpected(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return `boolean \`${v}\``;
  if (typeof v === 'number' || typeof v === 'bigint') return `integer \`${v}\``;
  if (isF64(v)) return `floating point \`${formatF64(v.valueOf())}\``;
  if (typeof v === 'string') return `string ${debugStr(v)}`;
  if (Array.isArray(v)) return 'sequence';
  return 'map';
}
const invalidType = (v, exp) => new SerdeError(`invalid type: ${unexpected(v)}, expected ${exp}`);
const invalidValue = (v, exp) => new SerdeError(`invalid value: ${unexpected(v)}, expected ${exp}`);

// Integer targets: [expecting, min, max]
const INT = {
  uint8: ['u8', 0n, 255n],
  uint32: ['u32', 0n, 4294967295n],
  uint64: ['u64', 0n, 18446744073709551615n],
  uint: ['usize', 0n, 18446744073709551615n],
  int64: ['i64', -9223372036854775808n, 9223372036854775807n],
};
const outInt = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b);

// One property schema → deserializer (value) → JS value, throws SerdeError.
function fieldType(prop) {
  const types = [].concat(prop.type);
  const base = types.find((t) => t !== 'null');
  const optional = types.includes('null');
  let de;
  switch (base) {
    case 'string':
      de = (v) => { if (typeof v !== 'string') throw invalidType(v, 'a string'); return v; };
      break;
    case 'boolean':
      de = (v) => { if (typeof v !== 'boolean') throw invalidType(v, 'a boolean'); return v; };
      break;
    case 'integer': {
      const [exp, min, max] = INT[prop.format] ?? INT.int64;
      de = (v) => {
        if (typeof v !== 'number' && typeof v !== 'bigint') throw invalidType(v, exp);   // floats included
        const b = BigInt(v);
        if (b < min || b > max) throw invalidValue(v, exp);
        return outInt(b);
      };
      break;
    }
    case 'number':   // f64 accepts every JSON number
      de = (v) => {
        if (typeof v === 'number') return v;
        if (typeof v === 'bigint' || isF64(v)) return Number(v.valueOf());
        throw invalidType(v, 'f64');
      };
      break;
    case 'array': {
      const item = fieldType(prop.items ?? {});
      de = (v) => { if (!Array.isArray(v)) throw invalidType(v, 'a sequence'); return v.map(item); };
      break;
    }
    default:
      de = (v) => v;   // serde_json::Value
  }
  return optional ? (v) => (v === null ? null : de(v)) : de;
}

const COMPILED = new WeakMap();
function compile(schema) {
  let c = COMPILED.get(schema);
  if (c) return c;
  const props = schema.properties ?? {};
  const fields = new Map(Object.entries(props).map(([k, p]) => [k, fieldType(p)]));
  const required = schema.required ?? [];
  const defaults = Object.entries(props).filter(([, p]) => 'default' in p).map(([k, p]) => [k, p.default]);
  c = { fields, required, defaults };
  COMPILED.set(schema, c);
  return c;
}

// serde_json::from_value::<Params>(Value::Object(args)) for the struct described by `schema`.
// Returns an object keyed by the Rust field names: absent Option fields are null, defaults applied.
export function fromArguments(schema, args) {
  const { fields, required, defaults } = compile(schema);
  const out = {};
  for (const k of fields.keys()) out[k] = null;
  for (const [k, d] of defaults) out[k] = structuredClone(d);
  const seen = new Set();
  for (const k of sortedKeys(args)) {
    const de = fields.get(k);
    if (!de) continue;                 // no deny_unknown_fields: IgnoredAny
    out[k] = de(args[k]);
    seen.add(k);
  }
  for (const k of required) if (!seen.has(k)) throw new SerdeError(`missing field \`${k}\``);
  return out;
}

// A tool registered without `Parameters<T>` gets rmcp's empty-object schema (no `title`).
export const takesParams = (schema) => typeof schema?.title === 'string';

// ── Rust `{:?}` of serde_json::Value / Map (used by rmcp's handshake error texts) ──
export function debugValue(v) {
  if (v === null || v === undefined) return 'Null';
  if (typeof v === 'boolean') return `Bool(${v})`;
  if (typeof v === 'number' || typeof v === 'bigint') return `Number(${v})`;
  if (isF64(v)) return `Number(${formatF64(v.valueOf())})`;
  if (typeof v === 'string') return `String(${debugStr(v)})`;
  if (Array.isArray(v)) return `Array [${v.map(debugValue).join(', ')}]`;
  return `Object ${debugMap(v)}`;
}
export const debugMap = (o) => `{${sortedKeys(o).map((k) => `${debugStr(k)}: ${debugValue(o[k])}`).join(', ')}}`;
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
