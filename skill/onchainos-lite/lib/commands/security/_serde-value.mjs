// PRIVATE — `serde_json::from_str::<serde_json::Value>(text)` acceptance rules and value model,
// used by `security sig-scan --message` (requested for promotion into core/json.mjs parse()).
// core/json.mjs parse() is more lenient than serde_json, which changes what sig-scan sends:
//   - `\u` escapes: exactly 4 hex digits; a leading surrogate must be followed by `\u` + a trailing
//     surrogate; a lone trailing surrogate is an error (serde validates UTF-8 for `String`).
//   - recursion limit: the 128th nested `[`/`{` is an error (remaining_depth starts at 128).
//   - `-0` (integer syntax) is F64(-0.0); integers beyond u64 / below i64::MIN become f64;
//     a non-finite f64 is an error ("number out of range"); number literals have no length cap.
//   - a `__proto__` key is an ordinary map key.
// Returns lite's lossless value model (numbers / BigInt / F64, plain arrays and objects);
// throws SyntaxError when serde_json would return Err.
import { F64 } from '../../core/json.mjs';

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
const RECURSION_LIMIT = 128;
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';

export function fromStrValue(text) {
  const s = String(text);
  let i = 0;
  let remainingDepth = RECURSION_LIMIT;
  const fail = (msg) => { throw new SyntaxError(`${msg} at byte ${i}`); };
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\t' || s[i] === '\r')) i++; };

  function hex4() {
    const h = s.slice(i, i + 4);
    if (h.length < 4) fail('EOF while parsing a string');
    if (!/^[0-9A-Fa-f]{4}$/.test(h)) fail('invalid escape');
    i += 4;
    return parseInt(h, 16);
  }
  function unicodeEscape() {
    const n = hex4();
    if (n >= 0xdc00 && n <= 0xdfff) fail('lone leading surrogate in hex escape');
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    if (s[i] !== '\\') fail('unexpected end of hex escape');
    i++;
    if (s[i] !== 'u') fail('unexpected end of hex escape');
    i++;
    const n2 = hex4();
    if (n2 < 0xdc00 || n2 > 0xdfff) fail('lone leading surrogate in hex escape');
    return String.fromCharCode(n, n2);
  }
  function string() {
    i++;   // opening quote
    let out = '';
    for (;;) {
      if (i >= s.length) fail('EOF while parsing a string');
      const c = s.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail('control character (\\u0000-\\u001F) found while parsing a string');
      if (c !== 0x5c) { out += s[i++]; continue; }
      i++;
      if (i >= s.length) fail('EOF while parsing a string');
      const e = s[i++];
      if (e === 'u') out += unicodeEscape();
      else if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) out += ESCAPES[e];
      else fail('invalid escape');
    }
  }
  function number() {
    const start = i;
    const negative = s[i] === '-';
    if (negative) i++;
    if (s[i] === '0') {
      i++;
      if (isDigit(s[i])) fail('invalid number');
    } else if (isDigit(s[i])) {
      while (isDigit(s[i])) i++;
    } else fail('invalid number');
    let float = false;
    if (s[i] === '.') {
      i++;
      if (!isDigit(s[i])) fail('invalid number');
      while (isDigit(s[i])) i++;
      float = true;
    }
    if (s[i] === 'e' || s[i] === 'E') {
      i++;
      if (s[i] === '+' || s[i] === '-') i++;
      if (!isDigit(s[i])) fail('invalid number');
      while (isDigit(s[i])) i++;
      float = true;
    }
    const literal = s.slice(start, i);
    if (!float && i - start - (negative ? 1 : 0) <= 20) {   // longer literals exceed u64 / i64 anyway
      const b = BigInt(literal);
      if (negative && b === 0n) return new F64(-0);   // serde: `-0` → F64(-0.0)
      if (negative ? b >= I64_MIN : b <= U64_MAX) return Number.isSafeInteger(Number(b)) ? Number(b) : b;
    }
    const f = Number(literal);
    if (!Number.isFinite(f)) fail('number out of range');
    return new F64(f);
  }
  function literal(word, v) {
    if (s.startsWith(word, i)) { i += word.length; return v; }
    fail('expected ident');
  }
  function enter() { if (--remainingDepth === 0) fail('recursion limit exceeded'); i++; }
  function value() {
    ws();
    if (i >= s.length) fail('EOF while parsing a value');
    const c = s[i];
    if (c === 'n') return literal('null', null);
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === '"') return string();
    if (c === '-' || isDigit(c)) return number();
    if (c === '[') {
      enter();
      const a = [];
      ws();
      if (s[i] === ']') { i++; remainingDepth++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === ']') fail('trailing comma'); continue; }
        if (s[i] === ']') { i++; remainingDepth++; return a; }
        fail(i >= s.length ? 'EOF while parsing a list' : 'expected `,` or `]`');
      }
    }
    if (c === '{') {
      enter();
      const o = {};
      ws();
      if (s[i] === '}') { i++; remainingDepth++; return o; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail(i >= s.length ? 'EOF while parsing an object' : 'key must be a string');
        const k = string();
        ws();
        if (s[i] !== ':') fail('expected `:`');
        i++;
        const v = value();
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === '}') fail('trailing comma'); continue; }
        if (s[i] === '}') { i++; remainingDepth++; return o; }
        fail(i >= s.length ? 'EOF while parsing an object' : 'expected `,` or `}`');
      }
    }
    fail('expected value');
  }

  const v = value();
  ws();
  if (i < s.length) fail('trailing characters');
  return v;
}
