// PRIVATE — serde_json 1.0 `from_str::<Value>` for the `wallet sign-message --type eip712`
// `--message` argument: syntax errors (message + line/column exactly as serde_json's SliceRead
// computes them) and the resulting Value. The Value is built here rather than by
// lib/core/json.mjs because it is re-serialised into the request body and must keep serde's
// semantics (verified against the upstream binary):
//   • `-0` is F64(-0.0) → "-0.0"; integers above u64::MAX or below i64::MIN become f64
//     (upstream's serde_json is built with `float_roundtrip`: correctly rounded, the same
//     result as JS Number());
//   • an f64 that rounds to ±infinity is `number out of range` (column after the number); an
//     i32 exponent overflow with a non-zero mantissa and a positive exponent is reported right
//     after the overflowing digit (parse_exponent_overflow), otherwise the value is ±0.0;
//   • numbers of any length (no truncation); `__proto__` is an ordinary key; a repeated key
//     keeps its last value (Map insert); recursion limit 128.
import { F64 } from '../../core/json.mjs';

const MSG = {
  EofWhileParsingList: 'EOF while parsing a list',
  EofWhileParsingObject: 'EOF while parsing an object',
  EofWhileParsingString: 'EOF while parsing a string',
  EofWhileParsingValue: 'EOF while parsing a value',
  ExpectedColon: 'expected `:`',
  ExpectedListCommaOrEnd: 'expected `,` or `]`',
  ExpectedObjectCommaOrEnd: 'expected `,` or `}`',
  ExpectedSomeIdent: 'expected ident',
  ExpectedSomeValue: 'expected value',
  InvalidEscape: 'invalid escape',
  InvalidNumber: 'invalid number',
  NumberOutOfRange: 'number out of range',
  ControlCharacterWhileParsingString: 'control character (\\u0000-\\u001F) found while parsing a string',
  KeyMustBeAString: 'key must be a string',
  LoneLeadingSurrogateInHexEscape: 'lone leading surrogate in hex escape',
  TrailingComma: 'trailing comma',
  TrailingCharacters: 'trailing characters',
  UnexpectedEndOfHexEscape: 'unexpected end of hex escape',
  RecursionLimitExceeded: 'recursion limit exceeded',
};

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
// overflow!(exp * 10 + digit, i32::MAX)
const I32_MAX_DIV10 = 214748364;
const I32_MAX_MOD10 = 7;

class SyntaxErr extends Error {}

// Own enumerable property even for keys such as "__proto__" (serde Map insert: last value wins).
function setKey(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// serde_json::from_str::<Value>(text) → value in lib/core/json representation (safe integers →
// number, other u64/i64 → BigInt, floats → F64), or throws an Error whose message is
// serde_json's Display: "<reason> at line <l> column <c>".
export function fromStr(text) {
  const b = Buffer.from(String(text), 'utf8');
  let i = 0;
  let depth = 128;
  const pos = (at) => {
    const start = b.lastIndexOf(0x0a, at - 1) + 1;
    let line = 1;
    for (let k = 0; k < start; k++) if (b[k] === 0x0a) line++;
    return [line, at - start];
  };
  const fail = (code, at) => { const [l, c] = pos(at); return new SyntaxErr(`${MSG[code]} at line ${l} column ${c}`); };
  const error = (code) => fail(code, i);
  const peekError = (code) => fail(code, Math.min(b.length, i + 1));
  const peek = () => (i < b.length ? b[i] : undefined);
  const next = () => (i < b.length ? b[i++] : undefined);
  const isDigit = (c) => c !== undefined && c >= 0x30 && c <= 0x39;
  const ws = () => { while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x09 || b[i] === 0x0d)) i++; return peek(); };
  const textOf = (start) => b.subarray(start, i).toString('latin1');

  const ident = (rest, v) => {
    for (const ch of rest) {
      const c = next();
      if (c === undefined) throw error('EofWhileParsingValue');
      if (c !== ch.charCodeAt(0)) throw error('ExpectedSomeIdent');
    }
    return v;
  };
  // f64_from_parts / f64_long_from_parts: correctly rounded; ±infinity → out of range, reported
  // after the whole number.
  const finishFloat = (start) => {
    const t = textOf(start);
    if (!Number.isFinite(Number(t))) throw error('NumberOutOfRange');
    return new F64(t);
  };
  // Mantissa digits of b[start..end) all '0' (serde: significand == 0 / scratch all zeros).
  const zeroMantissa = (start, end) => {
    for (let k = start; k < end; k++) if (isDigit(b[k]) && b[k] !== 0x30) return false;
    return true;
  };
  // parse_exponent / parse_long_exponent
  const exponent = (start) => {
    const mantissaEnd = i;
    i++;
    let positiveExp = true;
    if (peek() === 0x2b) i++;
    else if (peek() === 0x2d) { positiveExp = false; i++; }
    const c = next();
    if (c === undefined) throw error('EofWhileParsingValue');
    if (!isDigit(c)) throw error('InvalidNumber');
    let exp = c - 0x30;
    while (isDigit(peek())) {
      const d = next() - 0x30;
      if (exp >= I32_MAX_DIV10 && (exp > I32_MAX_DIV10 || d > I32_MAX_MOD10)) {
        // parse_exponent_overflow: error instead of ±infinity, otherwise ±0.0
        if (!zeroMantissa(start, mantissaEnd) && positiveExp) throw error('NumberOutOfRange');
        while (isDigit(peek())) i++;
        return new F64(b[start] === 0x2d ? -0 : 0);
      }
      exp = exp * 10 + d;
    }
    return finishFloat(start);
  };
  // parse_decimal
  const decimal = (start) => {
    i++;
    let digits = 0;
    while (isDigit(peek())) { i++; digits++; }
    if (!digits) throw peek() === undefined ? peekError('EofWhileParsingValue') : peekError('InvalidNumber');
    if (peek() === 0x65 || peek() === 0x45) return exponent(start);
    return finishFloat(start);
  };
  // parse_number (no fraction / exponent): U64, I64, or F64 for -0, i64 underflow, u64 overflow.
  const integerValue = (start) => {
    const t = textOf(start);
    const big = BigInt(t);
    if (big > U64_MAX || big < I64_MIN) return finishFloat(start);
    if (t === '-0') return new F64('-0');
    return Number.isSafeInteger(Number(big)) ? Number(big) : big;
  };
  // parse_integer
  const number = (start) => {
    const c = next();
    if (c === undefined) throw error('EofWhileParsingValue');
    if (c === 0x30) {
      if (isDigit(peek())) throw peekError('InvalidNumber');
    } else if (isDigit(c)) {
      while (isDigit(peek())) i++;
    } else {
      throw error('InvalidNumber');
    }
    if (peek() === 0x2e) return decimal(start);
    if (peek() === 0x65 || peek() === 0x45) return exponent(start);
    return integerValue(start);
  };
  const hex4 = () => {
    if (b.length - i < 4) { i = b.length; throw error('EofWhileParsingString'); }
    const s = b.subarray(i, i + 4).toString('latin1');
    i += 4;
    if (!/^[0-9a-fA-F]{4}$/.test(s)) throw error('InvalidEscape');
    return parseInt(s, 16);
  };
  const SIMPLE = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' };
  const escape = () => {
    const c = next();
    if (c === undefined) throw error('EofWhileParsingString');
    if (SIMPLE[c] !== undefined) return SIMPLE[c];
    if (c !== 0x75) throw error('InvalidEscape');
    const n = hex4();
    if (n >= 0xdc00 && n <= 0xdfff) throw error('LoneLeadingSurrogateInHexEscape');
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    if (peek() === undefined) throw error('EofWhileParsingString');
    if (peek() !== 0x5c) { i++; throw error('UnexpectedEndOfHexEscape'); }
    i++;
    if (peek() === undefined) throw error('EofWhileParsingString');
    if (peek() !== 0x75) { i++; throw error('UnexpectedEndOfHexEscape'); }
    i++;
    const n2 = hex4();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw error('LoneLeadingSurrogateInHexEscape');
    return String.fromCharCode(n, n2);
  };
  const string = () => {
    let out = '';
    let run = i;
    for (;;) {
      if (i === b.length) throw error('EofWhileParsingString');
      const c = b[i];
      if (c === 0x22) { out += b.subarray(run, i).toString('utf8'); i++; return out; }
      if (c === 0x5c) { out += b.subarray(run, i).toString('utf8'); i++; out += escape(); run = i; continue; }
      i++;
      if (c < 0x20) throw error('ControlCharacterWhileParsingString');
    }
  };
  const value = () => {
    const p = ws();
    if (p === undefined) throw peekError('EofWhileParsingValue');
    switch (p) {
      case 0x6e: i++; return ident('ull', null);
      case 0x74: i++; return ident('rue', true);
      case 0x66: i++; return ident('alse', false);
      case 0x2d: { const s = i; i++; return number(s); }
      case 0x22: i++; return string();
      case 0x5b: {
        if (--depth === 0) throw peekError('RecursionLimitExceeded');
        i++;
        const out = [];
        let first = true;
        for (;;) {
          const q = ws();
          if (q === undefined) throw peekError('EofWhileParsingList');
          if (q === 0x5d) break;
          if (first) first = false;
          else if (q === 0x2c) {
            i++;
            const r = ws();
            if (r === 0x5d) throw peekError('TrailingComma');
            if (r === undefined) throw peekError('EofWhileParsingValue');
          } else throw peekError('ExpectedListCommaOrEnd');
          out.push(value());
        }
        depth++;
        i++;   // end_seq consumes `]`
        return out;
      }
      case 0x7b: {
        if (--depth === 0) throw peekError('RecursionLimitExceeded');
        i++;
        const out = {};
        let first = true;
        for (;;) {
          const q = ws();
          if (q === undefined) throw peekError('EofWhileParsingObject');
          if (q === 0x7d) break;
          if (first) {
            first = false;
            if (q !== 0x22) throw peekError('KeyMustBeAString');
          } else if (q === 0x2c) {
            i++;
            const r = ws();
            if (r === 0x7d) throw peekError('TrailingComma');
            if (r === undefined) throw peekError('EofWhileParsingValue');
            if (r !== 0x22) throw peekError('KeyMustBeAString');
          } else throw peekError('ExpectedObjectCommaOrEnd');
          i++;
          const key = string();
          const colon = ws();
          if (colon === undefined) throw peekError('EofWhileParsingObject');
          if (colon !== 0x3a) throw peekError('ExpectedColon');
          i++;
          setKey(out, key, value());
        }
        depth++;
        i++;   // end_map consumes `}`
        return out;
      }
      default:
        if (isDigit(p)) return number(i);
        throw peekError('ExpectedSomeValue');
    }
  };
  const v = value();
  if (ws() !== undefined) throw peekError('TrailingCharacters');
  return v;
}
