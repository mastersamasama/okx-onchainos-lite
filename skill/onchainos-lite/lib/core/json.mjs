// JSON serialisation with serde_json semantics.
// - serde_json::Value objects are BTreeMaps → keys print sorted (byte order).
// - Rust structs print in field declaration order → wrap with struct(obj).
// - Rust f64 prints like ryu ("1.0", "1e21", "1.5e-7") → wrap with f64(x).
// - undefined properties are omitted (serde skip_serializing_if = None/empty).
const ORDERED = Symbol.for('ocl.ordered');
const FLOAT = Symbol.for('ocl.f64');
const RAW = Symbol.for('ocl.raw');

export function struct(obj) {
  Object.defineProperty(obj, ORDERED, { value: true, enumerable: false });
  return obj;
}
export const f64 = (x) => ({ [FLOAT]: Number(x) });
// Pre-serialised JSON text inserted verbatim (e.g. arbitrary-precision numbers from upstream).
export const rawJson = (text) => ({ [RAW]: String(text) });

// serde_json (zmij) f64 formatting: fixed with ≥1 fractional digit when
// 1e-5 ≤ |x| < 1e16, else shortest mantissa + "e" + signed exponent ("1e+16", "1e-6").
export function formatF64(x) {
  if (!Number.isFinite(x)) return 'null';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const ax = Math.abs(x);
  if (ax >= 1e-5 && ax < 1e16) {
    const s = String(x);
    return s.includes('.') ? s : s + '.0';
  }
  return x.toExponential();
}

// Rust `format!("{}", f64)` (Display): shortest digits, never an exponent, no ".0".
export function displayF64(x) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const m = x.toExponential().match(/^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/);
  const [, sign, d, frac = '', e] = m;
  const digits = d + frac, exp = Number(e);
  if (exp >= 0) {
    const int = digits.length > exp + 1 ? digits.slice(0, exp + 1) : digits.padEnd(exp + 1, '0');
    const rest = digits.slice(exp + 1);
    return sign + int + (rest ? '.' + rest : '');
  }
  return sign + '0.' + '0'.repeat(-exp - 1) + digits;
}

// Number with Rust f64 identity (parsed from "1.0", "2.5e3", …). Arithmetic and
// comparisons work through valueOf(); it re-serialises exactly as serde_json would.
export class F64 {
  constructor(v) { this[FLOAT] = Number(v); }
  valueOf() { return this[FLOAT]; }
  toString() { return formatF64(this[FLOAT]); }
  toJSON() { return this[FLOAT]; }
}

// JSON.parse replacement with serde_json::Value number semantics:
// integers stay integers (BigInt beyond 2^53), decimals/exponents become F64.
// Acceptance rules follow serde_json 1.0 (what upstream uses for every response):
// recursion limit 128 (127 nested levels), no raw control characters in strings, no lone surrogates,
// numbers out of f64 range rejected, "-0" is the float -0.0, "__proto__" is a plain key.
export function parse(text) {
  let i = 0, depth = 0;
  const s = String(text);
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const fail = (msg) => { throw new SyntaxError(`${msg} at line ${s.slice(0, i).split('\n').length} column ${i - s.lastIndexOf('\n', i - 1)}`); };
  const setKey = (o, k, v) => {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  };
  // check_recursion!: remaining_depth starts at 128 and errors when it reaches 0 → 127 levels
  const enter = () => { if (++depth >= 128) fail('recursion limit exceeded'); };
  function value() {
    ws();
    const c = s[i];
    if (c === '{') {
      enter(); i++; const o = {}; ws();
      if (s[i] === '}') { i++; depth--; return o; }
      for (;;) {
        ws(); if (s[i] !== '"') fail(i >= s.length ? 'EOF while parsing an object' : 'key must be a string');
        const k = str(); ws(); if (s[i++] !== ':') fail('expected `:`');
        setKey(o, k, value()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; depth--; return o; }
        fail(i >= s.length ? 'EOF while parsing an object' : 'expected `,` or `}`');
      }
    }
    if (c === '[') {
      enter(); i++; const a = []; ws();
      if (s[i] === ']') { i++; depth--; return a; }
      for (;;) {
        a.push(value()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; depth--; return a; }
        fail(i >= s.length ? 'EOF while parsing a list' : 'expected `,` or `]`');
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) fail(i >= s.length ? 'EOF while parsing a value' : 'expected value');
    i += m[0].length;
    if (m[1] || m[2] || m[0] === '-0') {
      const f = Number(m[0]);
      if (!Number.isFinite(f)) fail('number out of range');
      return new F64(m[0]);
    }
    const n = Number(m[0]);
    if (Number.isSafeInteger(n)) return n;
    const b = BigInt(m[0]);
    return b <= 18446744073709551615n && b >= -9223372036854775808n ? b : new F64(m[0]);
  }
  function hex4() {
    const h = s.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail(h.length < 4 ? 'EOF while parsing a string' : 'invalid escape');
    i += 4;
    return parseInt(h, 16);
  }
  function str() {
    let out = '';
    i++;
    for (;;) {
      if (i >= s.length) fail('EOF while parsing a string');
      const ch = s.charCodeAt(i);
      if (ch === 0x22) { i++; return out; }
      if (ch < 0x20) fail('control character (\\u0000-\\u001F) found while parsing a string');
      if (ch !== 0x5c) {
        if (ch >= 0xd800 && ch <= 0xdfff) {   // raw surrogate pair from a UTF-8 decoded body stays as is
          out += s[i++];
          continue;
        }
        out += s[i++];
        continue;
      }
      const e = s[i + 1];
      i += 2;
      if (e === 'u') {
        const u = hex4();
        if (u >= 0xdc00 && u <= 0xdfff) fail('lone leading surrogate in hex escape');
        if (u >= 0xd800 && u <= 0xdbff) {
          if (s[i] !== '\\' || s[i + 1] !== 'u') fail('unexpected end of hex escape');
          i += 2;
          const lo = hex4();
          if (lo < 0xdc00 || lo > 0xdfff) fail('lone leading surrogate in hex escape');
          out += String.fromCharCode(u, lo);
        } else out += String.fromCharCode(u);
      } else {
        const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (m === undefined) fail('invalid escape');
        out += m;
      }
    }
  }
  const v = value();
  ws();
  if (i < s.length) fail('trailing characters');
  return v;
}

// serde_json::to_value(struct): deep copy that drops struct() field order, so the result
// prints with sorted keys (upstream embeds structs into json! objects this way).
export function toValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v[FLOAT] !== undefined || v[RAW] !== undefined) return v;
  if (Array.isArray(v)) return v.map(toValue);
  const out = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = toValue(v[k]);
  return out;
}

const cmp = (a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)));

export function stringify(value, pretty = false, indent = '') {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && value[FLOAT] !== undefined) return formatF64(value[FLOAT]);
  if (typeof value === 'object' && value[RAW] !== undefined) return value[RAW];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const nl = pretty ? '\n' : '', ind = pretty ? indent + '  ' : '', sep = pretty ? ': ' : ':';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[' + nl + value.map((v) => ind + stringify(v === undefined ? null : v, pretty, ind)).join(',' + nl) + nl + indent + ']';
  }
  let keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!value[ORDERED]) keys = keys.sort(cmp);
  if (!keys.length) return '{}';
  return '{' + nl + keys.map((k) => ind + JSON.stringify(k) + sep + stringify(value[k], pretty, ind)).join(',' + nl) + nl + indent + '}';
}
