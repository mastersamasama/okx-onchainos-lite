// serde_jcs 0.1 `to_string` of a serde_json::Value (RFC 8785 as that crate implements it):
// compact; serde_json string escaping (JSON.stringify for valid strings); integers printed
// exactly (itoa); floats in ECMAScript form (ryu-js) with ±0 → "0" and NaN / ±inf rejected
// ("oh no"); object members ordered by the bytes of the *serialized* key (`"` + escaped UTF-8 +
// `"`, a BTreeMap<Vec<u8>, _>) — not by UTF-16 code units.
const FLOAT = Symbol.for('ocl.f64');   // core/json.mjs F64 / f64() marker

export function jcs(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v + 0) : float(v);
  if (v[FLOAT] !== undefined) return float(v[FLOAT]);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  const members = Object.keys(v).filter((k) => v[k] !== undefined).map((k) => {
    const key = JSON.stringify(k);
    return { bytes: Buffer.from(key, 'utf8'), text: `${key}:${jcs(v[k])}` };
  });
  members.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  return `{${members.map((m) => m.text).join(',')}}`;
}
function float(x) {
  if (!Number.isFinite(x)) throw new Error('oh no');
  return x === 0 ? '0' : String(x);
}
