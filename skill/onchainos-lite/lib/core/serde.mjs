// Typed deserialisation with serde semantics — upstream crates serde_json 1.0.149 (de.rs,
// read.rs, value/de.rs, error.rs; `float_roundtrip` enabled by upstream's dependency graph) and
// serde_derive 1.0.228 (the derive(Deserialize) visitors). Results use core/json.mjs's Value
// model: safe integers → number, other u64/i64 → BigInt, floats → F64, objects → plain objects
// (a "__proto__" key is an own property).
//
//   fromStr(text, t) / fromSlice(bytes, t)   serde_json::from_str / from_slice::<T>. Streaming:
//       errors surface in document order and carry "at line L column C"; struct rules apply
//       while parsing (duplicate fields, seq-form structs, trailing input). A Buffer input is
//       read as a slice: every parsed string must be valid UTF-8.
//   fromValue(value, t)   serde_json::from_value::<T> — errors carry no position; map keys are
//       visited in serde_json::Map (BTreeMap, byte) order.
//   firstValue(text)      Deserializer::from_str(text).into_iter::<Value>().next(), errors → undefined.
//   numberFromStr(text)   <serde_json::Number as FromStr>::from_str — one JSON number, positioned errors.
//
// Types (T): value, ignored (IgnoredAny → true), string, bool, f64, i8…i64, u8…u64, usize,
// option(t), vec(t), map(t) (HashMap/BTreeMap<String, t>), enum(name, variants, aliases) (unit
// variants), struct(name, fields, { denyUnknown, flatten }), with(t, convert) (deserialize_with).
// Struct fields are [jsonName, type, default?, aliases?]: no default = required (an Option field
// is then None when absent); a default is a value or a thunk (#[serde(default)]).
import { F64, formatF64 } from './json.mjs';
import { cmpBytes, strDebug } from './rs/str.mjs';
import { jsonInt } from './rs/num.mjs';
import { isObject } from './rs/value.mjs';

// upstream: serde_json error.rs::Error — Display "<msg>", or "<msg> at line L column C" once
// the deserializer has positioned it (line 0 = no position).
export class SerdeError extends Error {
  constructor(msg, line = 0, column = 0) {
    super(line === 0 ? msg : `${msg} at line ${line} column ${column}`);
    this.msg = msg; this.line = line; this.column = column;
  }
}

// upstream: serde_json error.rs::ErrorCode Display
const E = {
  EofList: 'EOF while parsing a list', EofObject: 'EOF while parsing an object', EofString: 'EOF while parsing a string',
  EofValue: 'EOF while parsing a value', Colon: 'expected `:`', ListCommaOrEnd: 'expected `,` or `]`',
  ObjectCommaOrEnd: 'expected `,` or `}`', Ident: 'expected ident', Value: 'expected value', InvalidEscape: 'invalid escape',
  InvalidNumber: 'invalid number', OutOfRange: 'number out of range', Control: 'control character (\\u0000-\\u001F) found while parsing a string',
  KeyString: 'key must be a string', LoneLeading: 'lone leading surrogate in hex escape', TrailingComma: 'trailing comma',
  Trailing: 'trailing characters', UnexpectedEndHex: 'unexpected end of hex escape', Recursion: 'recursion limit exceeded',
  InvalidUnicode: 'invalid unicode code point',
};

const isInt = (v) => typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// upstream: serde_json error.rs::JsonUnexpected — serde::de::Unexpected of a Value, floats in
// serde_json's own (zmij) format.
export function unexpected(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return `boolean \`${v}\``;
  if (typeof v === 'string') return `string ${strDebug(v)}`;
  if (isInt(v)) return `integer \`${v}\``;
  if (typeof v === 'number' || v instanceof F64) return `floating point \`${formatF64(Number(v))}\``;
  if (Array.isArray(v)) return 'sequence';
  return 'map';
}
const invalidType = (v, exp) => new SerdeError(`invalid type: ${unexpected(v)}, expected ${exp}`);
const invalidValue = (v, exp) => new SerdeError(`invalid value: ${unexpected(v)}, expected ${exp}`);
// serde::de::OneOf
function oneOf(names) {
  if (names.length === 1) return `\`${names[0]}\``;
  if (names.length === 2) return `\`${names[0]}\` or \`${names[1]}\``;
  return `one of ${names.map((n) => `\`${n}\``).join(', ')}`;
}
const unknownField = (f, names) => new SerdeError(names.length ? `unknown field \`${f}\`, expected ${oneOf(names)}` : `unknown field \`${f}\`, there are no fields`);
const unknownVariant = (v, names) => new SerdeError(names.length ? `unknown variant \`${v}\`, expected ${oneOf(names)}` : `unknown variant \`${v}\`, there are no variants`);
const missingField = (f) => new SerdeError(`missing field \`${f}\``);
const duplicateField = (f) => new SerdeError(`duplicate field \`${f}\``);
// serde_derive: `"struct X with N elements"` (singular for one field)
const invalidLength = (len, t) => new SerdeError(`invalid length ${len}, expected struct ${t.name} with ${t.fields.length} element${t.fields.length === 1 ? '' : 's'}`);

// ── types ─────────────────────────────────────────────────────────────

const int = (name, lo, hi) => ({ kind: 'int', expecting: name, lo, hi });
// serde_derive FIELDS / VARIANTS: per field (variant) in declaration order, its name and aliases sorted.
const namesOf = (entries) => entries.flatMap(([name, aliases]) => [name, ...aliases].sort(cmpBytes));

export const T = {
  value: { kind: 'value' },
  ignored: { kind: 'ignored' },
  string: { kind: 'string', expecting: 'a string' },
  bool: { kind: 'bool', expecting: 'a boolean' },
  f64: { kind: 'f64', expecting: 'f64' },
  i8: int('i8', -128n, 127n),
  i16: int('i16', -32768n, 32767n),
  i32: int('i32', -2147483648n, 2147483647n),
  i64: int('i64', -9223372036854775808n, 9223372036854775807n),
  u8: int('u8', 0n, 255n),
  u16: int('u16', 0n, 65535n),
  u32: int('u32', 0n, 4294967295n),
  u64: int('u64', 0n, 18446744073709551615n),
  usize: int('usize', 0n, 18446744073709551615n),
  option: (t) => ({ kind: 'option', t }),
  vec: (t) => ({ kind: 'vec', t, expecting: 'a sequence' }),
  map: (t) => ({ kind: 'map', t, expecting: 'a map' }),
  // variants: [[wireName, value], …]; aliases: [[aliasName, value], …] (#[serde(alias)])
  enum(name, variants, aliases = []) {
    const lookup = new Map([...variants, ...aliases]);
    const names = namesOf(variants.map(([w, v]) => [w, aliases.filter(([, av]) => av === v).map(([a]) => a)]));
    return { kind: 'enum', name, lookup, names };
  },
  struct(name, fields, { denyUnknown = false, flatten } = {}) {
    const index = new Map();
    fields.forEach(([key, , , aliases = []], i) => { for (const k of [key, ...aliases]) index.set(k, i); });
    // a #[serde(flatten)] struct has no FIELDS list and no seq form (deserialize_map)
    const names = namesOf(fields.map(([key, , , aliases = []]) => [key, aliases]));
    return { kind: 'struct', name, fields, index, names, denyUnknown, flatten, expecting: `struct ${name}` };
  },
  with: (t, convert) => ({ kind: 'with', t, convert }),
};

// Struct field default: a value or a thunk; an Option field without one is None.
function fieldDefault([, type, def]) {
  if (def !== undefined) return { value: typeof def === 'function' ? def() : def };
  return type.kind === 'option' ? { value: null } : undefined;
}
function finishStruct(t, seen, extra) {
  const out = {};
  t.fields.forEach((f, i) => {
    if (seen.has(i)) { out[f[0]] = seen.get(i); return; }
    const d = fieldDefault(f);
    if (!d) throw missingField(f[0]);
    out[f[0]] = d.value;
  });
  if (t.flatten !== undefined) out[t.flatten] = extra;
  return out;
}

// ── streaming deserializer (serde_json::de::Deserializer over a SliceRead) ─

const WS = new Set([0x20, 0x0a, 0x09, 0x0d]);
const isDigit = (b) => b >= 0x30 && b <= 0x39;
const U64_MAX = 18446744073709551615n, I64_MIN_ABS = 9223372036854775808n, I32_MAX = 2147483647;
const ESCAPES = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' };
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Deserializer {
  constructor(input) {
    this.b = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.from(String(input), 'utf8');
    this.i = 0;
    this.depth = 128;
  }
  peek() { return this.i < this.b.length ? this.b[this.i] : null; }
  peekOrNull() { return this.i < this.b.length ? this.b[this.i] : 0; }
  eat() { this.i++; }
  next() { return this.i < this.b.length ? this.b[this.i++] : null; }
  // read.rs position_of_index
  positionOf(i) {
    const start = i === 0 ? 0 : this.b.lastIndexOf(0x0a, i - 1) + 1;
    let line = 1;
    for (let k = 0; k < start; k++) if (this.b[k] === 0x0a) line++;
    return [line, i - start];
  }
  error(msg) { const [l, c] = this.positionOf(this.i); return new SerdeError(msg, l, c); }
  peekError(msg) { const [l, c] = this.positionOf(Math.min(this.b.length, this.i + 1)); return new SerdeError(msg, l, c); }
  // de.rs fix_position: a data error from a visitor gets the current position
  fix(err) { return err instanceof SerdeError && err.line === 0 ? this.error(err.msg) : err; }
  ws() { while (this.i < this.b.length && WS.has(this.b[this.i])) this.i++; return this.peek(); }
  ident(rest) {
    for (const ch of rest) {
      const n = this.next();
      if (n === null) throw this.error(E.EofValue);
      if (n !== ch.charCodeAt(0)) throw this.error(E.Ident);
    }
  }
  end() { if (this.ws() !== null) throw this.peekError(E.Trailing); }
  // check_recursion!
  recurse(fn) {
    this.depth -= 1;
    if (this.depth === 0) throw this.peekError(E.Recursion);
    try { return fn(); } finally { this.depth += 1; }
  }

  // ── strings (read.rs parse_str_bytes with validate = true; as_str checks UTF-8) ──
  parseStr() {
    const parts = [];
    let start = this.i;
    for (;;) {
      while (this.i < this.b.length && this.b[this.i] !== 0x22 && this.b[this.i] !== 0x5c && this.b[this.i] >= 0x20) this.i++;
      if (this.i === this.b.length) throw this.error(E.EofString);
      const c = this.b[this.i];
      if (c === 0x22) {
        parts.push(this.b.subarray(start, this.i));
        this.i++;
        try { return UTF8.decode(Buffer.concat(parts)); } catch { throw this.error(E.InvalidUnicode); }
      }
      if (c === 0x5c) { parts.push(this.b.subarray(start, this.i)); this.i++; parts.push(this.escape()); start = this.i; continue; }
      this.i++;
      throw this.error(E.Control);
    }
  }
  // read.rs decode_hex_escape
  hex4() {
    if (this.b.length - this.i < 4) { this.i = this.b.length; throw this.error(E.EofString); }
    const s = this.b.subarray(this.i, this.i + 4).toString('latin1');
    this.i += 4;
    if (!/^[0-9a-fA-F]{4}$/.test(s)) throw this.error(E.InvalidEscape);
    return parseInt(s, 16);
  }
  // read.rs parse_escape / parse_unicode_escape
  escape() {
    const ch = this.next();
    if (ch === null) throw this.error(E.EofString);
    if (ESCAPES[ch] !== undefined) return Buffer.from(ESCAPES[ch]);
    if (ch !== 0x75) throw this.error(E.InvalidEscape);
    const n = this.hex4();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error(E.LoneLeading);
    if (n < 0xd800 || n > 0xdbff) return Buffer.from(String.fromCharCode(n), 'utf8');
    for (const want of [0x5c, 0x75]) {
      const p = this.peek();
      if (p === null) throw this.error(E.EofString);
      this.i++;
      if (p !== want) throw this.error(E.UnexpectedEndHex);
    }
    const n2 = this.hex4();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error(E.LoneLeading);
    return Buffer.from(String.fromCharCode(n, n2), 'utf8');
  }

  // ── numbers (de.rs parse_integer / parse_number / parse_decimal / parse_exponent / parse_long_*)
  // → { kind: 'u64' | 'i64' | 'f64', v } (BigInt for integers). The sign byte, if any, is consumed.
  parseInteger(positive) {
    const start = positive ? this.i : this.i - 1;
    const first = this.next();
    if (first === null) throw this.error(E.EofValue);
    let sig = 0n;
    if (first === 0x30) {
      if (isDigit(this.peekOrNull())) throw this.peekError(E.InvalidNumber);
    } else if (first >= 0x31 && first <= 0x39) {
      sig = BigInt(first - 0x30);
      while (isDigit(this.peekOrNull())) {
        const next = sig * 10n + BigInt(this.peekOrNull() - 0x30);
        if (next > U64_MAX) return { kind: 'f64', v: this.parseLongInteger(start) };
        this.eat();
        sig = next;
      }
    } else throw this.error(E.InvalidNumber);
    const p = this.peekOrNull();
    if (p === 0x2e) return { kind: 'f64', v: this.parseDecimal(start) };
    if (p === 0x65 || p === 0x45) return { kind: 'f64', v: this.parseExponent(start) };
    if (positive) return { kind: 'u64', v: sig };
    // `-0` and i64 underflow become f64
    if (sig === 0n || sig > I64_MIN_ABS) return { kind: 'f64', v: -Number(sig) };
    return { kind: 'i64', v: -sig };
  }
  // parse_long_integer: the u64 significand overflowed; every further digit stays significant.
  parseLongInteger(start) {
    while (isDigit(this.peekOrNull())) this.eat();
    const p = this.peekOrNull();
    if (p === 0x2e) return this.parseDecimal(start);
    if (p === 0x65 || p === 0x45) return this.parseExponent(start);
    return this.fromParts(start);
  }
  parseDecimal(start) {
    this.eat();
    let digits = 0;
    while (isDigit(this.peekOrNull())) { this.eat(); digits++; }
    if (digits === 0) throw this.peekError(this.peek() === null ? E.EofValue : E.InvalidNumber);
    const p = this.peekOrNull();
    return p === 0x65 || p === 0x45 ? this.parseExponent(start) : this.fromParts(start);
  }
  parseExponent(start) {
    const mantissaEnd = this.i;
    this.eat();
    let positiveExp = true;
    const sign = this.peekOrNull();
    if (sign === 0x2b) this.eat();
    else if (sign === 0x2d) { this.eat(); positiveExp = false; }
    const first = this.next();
    if (first === null) throw this.error(E.EofValue);
    if (!isDigit(first)) throw this.error(E.InvalidNumber);
    let exp = first - 0x30;
    while (isDigit(this.peekOrNull())) {
      const digit = this.b[this.i++] - 0x30;
      if (exp * 10 + digit > I32_MAX) return this.exponentOverflow(start, mantissaEnd, positiveExp);
      exp = exp * 10 + digit;
    }
    return this.fromParts(start);
  }
  // parse_exponent_overflow: an error instead of ±infinity, otherwise ±0.0 (rest of the digits consumed)
  exponentOverflow(start, mantissaEnd, positiveExp) {
    let zeroSignificand = true;
    for (let k = start; k < mantissaEnd; k++) if (this.b[k] >= 0x31 && this.b[k] <= 0x39) zeroSignificand = false;
    if (!zeroSignificand && positiveExp) throw this.error(E.OutOfRange);
    while (isDigit(this.peekOrNull())) this.eat();
    return this.b[start] === 0x2d ? -0 : 0;
  }
  // f64_from_parts / f64_long_from_parts: correctly rounded (float_roundtrip); ±infinity is an error
  fromParts(start) {
    const f = Number(this.b.subarray(start, this.i).toString('latin1'));
    if (!Number.isFinite(f)) throw this.error(E.OutOfRange);
    return f;
  }
  number(p) {
    if (p === 0x2d) { this.eat(); return this.parseInteger(false); }
    return this.parseInteger(true);
  }

  // peek_invalid_type — consumes the offending scalar, then positions the error.
  peekInvalidType(exp) {
    const p = this.peekOrNull();
    let v;
    if (p === 0x6e) { this.eat(); this.ident('ull'); v = null; }
    else if (p === 0x74) { this.eat(); this.ident('rue'); v = true; }
    else if (p === 0x66) { this.eat(); this.ident('alse'); v = false; }
    else if (p === 0x2d || isDigit(p)) v = numberValue(this.number(p));
    else if (p === 0x22) { this.eat(); v = this.parseStr(); }
    else if (p === 0x5b) v = [];
    else if (p === 0x7b) v = {};
    else throw this.peekError(E.Value);
    return this.fix(invalidType(v, exp));
  }

  // ── SeqAccess / MapAccess ──
  nextElement(state) {
    let p = this.ws();
    if (p === 0x5d) return false;
    if (p === 0x2c && !state.first) { this.eat(); p = this.ws(); }
    else if (p !== null) { if (state.first) state.first = false; else throw this.peekError(E.ListCommaOrEnd); }
    else throw this.peekError(E.EofList);
    if (p === 0x5d) throw this.peekError(E.TrailingComma);
    if (p === null) throw this.peekError(E.EofValue);
    return true;
  }
  endSeq() {
    const p = this.ws();
    if (p === 0x5d) { this.eat(); return; }
    if (p === 0x2c) { this.eat(); throw this.peekError(this.ws() === 0x5d ? E.TrailingComma : E.Trailing); }
    if (p !== null) throw this.peekError(E.Trailing);
    throw this.peekError(E.EofList);
  }
  nextKey(state) {
    let p = this.ws();
    if (p === 0x7d) return null;
    if (p === 0x2c && !state.first) { this.eat(); p = this.ws(); }
    else if (p !== null) { if (state.first) state.first = false; else throw this.peekError(E.ObjectCommaOrEnd); }
    else throw this.peekError(E.EofObject);
    if (p === 0x22) { this.eat(); return this.parseStr(); }
    if (p === 0x7d) throw this.peekError(E.TrailingComma);
    if (p !== null) throw this.peekError(E.KeyString);
    throw this.peekError(E.EofValue);
  }
  // parse_object_colon
  colon() {
    const p = this.ws();
    if (p === 0x3a) { this.eat(); return; }
    throw this.peekError(p === null ? E.EofObject : E.Colon);
  }
  endMap() {
    const p = this.ws();
    if (p === 0x7d) { this.eat(); return; }
    if (p === 0x2c) throw this.peekError(E.TrailingComma);
    if (p !== null) throw this.peekError(E.Trailing);
    throw this.peekError(E.EofObject);
  }
  // `match (visitor.visit_x(..), self.end_x())`: the end check runs even after a visitor error,
  // and the visitor error wins.
  container(visit, endFn) {
    return this.recurse(() => {
      this.eat();
      let ret, err;
      try { ret = visit(); } catch (e) { if (!(e instanceof SerdeError)) throw e; err = e; }
      let endErr;
      try { endFn(); } catch (e) { if (!(e instanceof SerdeError)) throw e; endErr = e; }
      if (err) throw err;
      if (endErr) throw endErr;
      return ret;
    });
  }
  seq(item) {
    return this.container(() => { const st = { first: true }, out = []; while (this.nextElement(st)) out.push(item()); return out; }, () => this.endSeq());
  }
  map(item) {
    return this.container(() => {
      const st = { first: true }, out = {};
      for (let k = this.nextKey(st); k !== null; k = this.nextKey(st)) { this.colon(); setOwn(out, k, item()); }
      return out;
    }, () => this.endMap());
  }

  // ── typed deserialisation (Deserialize::deserialize(&mut Deserializer)) ──
  de(t) {
    switch (t.kind) {
      case 'value': return this.deValue();
      case 'ignored': this.ignoreValue(); return true;
      case 'option':
        if (this.ws() === 0x6e) { this.eat(); this.ident('ull'); return null; }
        return this.de(t.t);
      case 'enum': return this.deEnum(t);
      case 'with': return t.convert(this.de(t.t));
      default: break;
    }
    const p = this.ws();
    if (p === null) throw this.peekError(E.EofValue);
    try {
      switch (t.kind) {
        case 'string':
          if (p === 0x22) { this.eat(); return this.parseStr(); }
          throw this.peekInvalidType(t.expecting);
        case 'bool':
          if (p === 0x74) { this.eat(); this.ident('rue'); return true; }
          if (p === 0x66) { this.eat(); this.ident('alse'); return false; }
          throw this.peekInvalidType(t.expecting);
        case 'f64':
          if (p !== 0x2d && !isDigit(p)) throw this.peekInvalidType(t.expecting);
          return Number(this.number(p).v);
        case 'int': {
          if (p !== 0x2d && !isDigit(p)) throw this.peekInvalidType(t.expecting);
          return checkInt(numberValue(this.number(p)), t);
        }
        case 'vec':
          if (p !== 0x5b) throw this.peekInvalidType(t.expecting);
          return this.seq(() => this.de(t.t));
        case 'map':
          if (p !== 0x7b) throw this.peekInvalidType(t.expecting);
          return this.map(() => this.de(t.t));
        case 'struct':
          if (p === 0x7b) return this.container(() => this.structMap(t), () => this.endMap());
          if (p === 0x5b && t.flatten === undefined) return this.container(() => this.structSeq(t), () => this.endSeq());
          throw this.peekInvalidType(t.expecting);
        default: throw new Error(`unknown serde type ${t.kind}`);
      }
    } catch (e) { throw this.fix(e); }
  }

  // deserialize_enum for unit variants: "variant" or {"variant": null}.
  deEnum(t) {
    const p = this.ws();
    if (p === null) throw this.peekError(E.EofValue);
    const variant = () => {
      const q = this.ws();
      if (q === null) throw this.peekError(E.EofValue);
      if (q !== 0x22) throw this.peekInvalidType('variant identifier');
      this.eat();
      const s = this.parseStr();
      if (!t.lookup.has(s)) throw this.fix(unknownVariant(s, t.names));
      return t.lookup.get(s);
    };
    if (p === 0x22) return variant();
    if (p !== 0x7b) throw this.peekError(E.Value);
    const v = this.recurse(() => {
      this.eat();
      const r = variant();
      this.colon();
      // VariantAccess::unit_variant → <()>::deserialize (deserialize_unit)
      const q = this.ws();
      if (q === null) throw this.peekError(E.EofValue);
      if (q !== 0x6e) throw this.peekInvalidType('unit');
      this.eat();
      this.ident('ull');
      return r;
    });
    const q = this.ws();
    if (q === 0x7d) { this.eat(); return v; }
    throw this.error(q === null ? E.EofObject : E.Value);
  }

  // derive visit_map: unknown keys ignored (or collected by #[serde(flatten)], or rejected by
  // #[serde(deny_unknown_fields)]); a key seen twice is a duplicate before its value is read.
  structMap(t) {
    const seen = new Map();
    const extra = t.flatten === undefined ? undefined : {};
    const st = { first: true };
    for (let k = this.nextKey(st); k !== null; k = this.nextKey(st)) {
      const i = t.index.get(k);
      if (i === undefined) {
        if (t.denyUnknown) throw unknownField(k, t.names);
        this.colon();
        if (extra) setOwn(extra, k, this.deValue());
        else this.ignoreValue();
        continue;
      }
      if (seen.has(i)) throw duplicateField(t.fields[i][0]);
      this.colon();
      seen.set(i, this.de(t.fields[i][1]));
    }
    return finishStruct(t, seen, extra);
  }
  // derive visit_seq: fields in declaration order; a missing element takes the field default.
  structSeq(t) {
    const seen = new Map();
    const st = { first: true };
    t.fields.forEach((f, i) => {
      if (this.nextElement(st)) seen.set(i, this.de(f[1]));
      else if (f[2] === undefined) throw invalidLength(i, t);
    });
    return finishStruct(t, seen);
  }

  // serde_json::Value (deserialize_any)
  deValue() {
    const p = this.ws();
    if (p === null) throw this.peekError(E.EofValue);
    try {
      if (p === 0x6e) { this.eat(); this.ident('ull'); return null; }
      if (p === 0x74) { this.eat(); this.ident('rue'); return true; }
      if (p === 0x66) { this.eat(); this.ident('alse'); return false; }
      if (p === 0x2d || isDigit(p)) return numberValue(this.number(p));
      if (p === 0x22) { this.eat(); return this.parseStr(); }
      if (p === 0x5b) return this.seq(() => this.deValue());
      if (p === 0x7b) return this.map(() => this.deValue());
      throw this.peekError(E.Value);
    } catch (e) { throw this.fix(e); }
  }

  // ignore_value (IgnoredAny): iterative, no recursion limit, numbers and strings only scanned.
  ignoreValue() {
    const stack = [];
    let enclosing = null;
    for (;;) {
      const p = this.ws();
      if (p === null) throw this.peekError(E.EofValue);
      let frame = null;
      if (p === 0x6e) { this.eat(); this.ident('ull'); }
      else if (p === 0x74) { this.eat(); this.ident('rue'); }
      else if (p === 0x66) { this.eat(); this.ident('alse'); }
      else if (p === 0x2d) { this.eat(); this.ignoreInteger(); }
      else if (isDigit(p)) this.ignoreInteger();
      else if (p === 0x22) { this.eat(); this.ignoreStr(); }
      else if (p === 0x5b || p === 0x7b) { if (enclosing !== null) stack.push(enclosing); enclosing = null; this.eat(); frame = p; }
      else throw this.peekError(E.Value);
      let acceptComma;
      if (frame !== null) acceptComma = false;
      else if (enclosing !== null) { frame = enclosing; enclosing = null; acceptComma = true; }
      else if (stack.length) { frame = stack.pop(); acceptComma = true; }
      else return;
      for (;;) {
        const q = this.ws();
        if (q === 0x2c && acceptComma) { this.eat(); break; }
        if ((q === 0x5d && frame === 0x5b) || (q === 0x7d && frame === 0x7b)) {
          this.eat();
          if (!stack.length) return;
          frame = stack.pop(); acceptComma = true; continue;
        }
        if (q !== null) {
          if (acceptComma) throw this.peekError(frame === 0x5b ? E.ListCommaOrEnd : E.ObjectCommaOrEnd);
          break;
        }
        throw this.peekError(frame === 0x5b ? E.EofList : E.EofObject);
      }
      if (frame === 0x7b) {
        const k = this.ws();
        if (k === 0x22) this.eat();
        else throw this.peekError(k === null ? E.EofObject : E.KeyString);
        this.ignoreStr();
        const c = this.ws();
        if (c === 0x3a) this.eat();
        else throw this.peekError(c === null ? E.EofObject : E.Colon);
      }
      enclosing = frame;
    }
  }
  // next_char_or_null: EOF reads as NUL without advancing
  nextOrNull() { return this.i < this.b.length ? this.b[this.i++] : 0; }
  ignoreInteger() {
    const n = this.nextOrNull();
    if (n === 0x30) { if (isDigit(this.peekOrNull())) throw this.peekError(E.InvalidNumber); }
    else if (n >= 0x31 && n <= 0x39) { while (isDigit(this.peekOrNull())) this.eat(); }
    else throw this.error(E.InvalidNumber);
    const p = this.peekOrNull();
    if (p === 0x2e) {
      this.eat();
      let any = false;
      while (isDigit(this.peekOrNull())) { this.eat(); any = true; }
      if (!any) throw this.peekError(E.InvalidNumber);
      const q = this.peekOrNull();
      if (q === 0x65 || q === 0x45) this.ignoreExponent();
    } else if (p === 0x65 || p === 0x45) this.ignoreExponent();
  }
  ignoreExponent() {
    this.eat();
    const p = this.peekOrNull();
    if (p === 0x2b || p === 0x2d) this.eat();
    if (!isDigit(this.nextOrNull())) throw this.error(E.InvalidNumber);
    while (isDigit(this.peekOrNull())) this.eat();
  }
  // read.rs ignore_str / ignore_escape: escapes are only scanned (lone surrogates pass), and a
  // control character is reported at its own position.
  ignoreStr() {
    for (;;) {
      while (this.i < this.b.length && this.b[this.i] !== 0x22 && this.b[this.i] !== 0x5c && this.b[this.i] >= 0x20) this.i++;
      if (this.i === this.b.length) throw this.error(E.EofString);
      const c = this.b[this.i];
      if (c === 0x22) { this.i++; return; }
      if (c !== 0x5c) throw this.error(E.Control);
      this.i++;
      const ch = this.next();
      if (ch === null) throw this.error(E.EofString);
      if (ch === 0x75) this.hex4();
      else if (ESCAPES[ch] === undefined) throw this.error(E.InvalidEscape);
    }
  }
}

// ParserNumber → Value number (F64 for floats)
const numberValue = (n) => (n.kind === 'f64' ? new F64(n.v) : jsonInt(n.v));

// Primitive integer visitor: floats are an invalid type, out-of-range integers an invalid value.
function checkInt(v, t) {
  if (!isInt(v)) throw invalidType(v, t.expecting);
  const b = BigInt(v);
  if (b < t.lo || b > t.hi) throw invalidValue(v, t.expecting);
  return jsonInt(b);
}

const input = (text) => new Deserializer(text);

// upstream: serde_json::from_str / from_slice::<T>(input) → decoded value; throws SerdeError.
export function fromStr(text, t = T.value) {
  const d = input(text);
  const v = d.de(t);
  d.end();
  return v;
}
export const fromSlice = fromStr;

// upstream: serde_json::Deserializer::from_str(text).into_iter::<Value>().next() → the first
// value, or undefined when the input is blank or the value fails to parse.
export function firstValue(text) {
  const d = input(text);
  if (d.ws() === null) return undefined;
  try { return d.deValue(); } catch { return undefined; }
}

// upstream: <serde_json::Number as FromStr>::from_str (de.rs parse_any_signed_number) → the
// number as a Value; throws SerdeError. No whitespace is skipped, and input left after the number
// (even after a parse error) is `invalid number` at that position.
export function numberFromStr(text) {
  const d = input(text);
  const p = d.peek();
  if (p === null) throw d.peekError(E.EofValue);
  let v, err;
  try {
    if (p !== 0x2d && !isDigit(p)) throw d.peekError(E.InvalidNumber);
    v = numberValue(d.number(p));
  } catch (e) { if (!(e instanceof SerdeError)) throw e; err = e; }
  if (d.peek() !== null) throw d.peekError(E.InvalidNumber);
  if (err) throw err;
  return v;
}

// ── serde_json::from_value (value/de.rs) ──────────────────────────────

// upstream: serde_json::from_value::<T>(value) → decoded value; throws SerdeError.
export function fromValue(v, t) {
  if (v === undefined) v = null;
  switch (t.kind) {
    case 'value': return v;
    case 'ignored': return true;
    case 'option': return v === null ? null : fromValue(v, t.t);
    case 'with': return t.convert(fromValue(v, t.t));
    case 'string':
      if (typeof v !== 'string') throw invalidType(v, t.expecting);
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw invalidType(v, t.expecting);
      return v;
    case 'f64':
      if (typeof v !== 'number' && typeof v !== 'bigint' && !(v instanceof F64)) throw invalidType(v, t.expecting);
      return Number(v);
    case 'int': return checkInt(v, t);
    case 'vec':
      if (!Array.isArray(v)) throw invalidType(v, t.expecting);
      return v.map((x) => fromValue(x, t.t));
    case 'map': {
      if (!isObject(v)) throw invalidType(v, t.expecting);
      const out = {};
      for (const k of entryKeys(v)) setOwn(out, k, fromValue(v[k], t.t));
      return out;
    }
    case 'enum': return enumFromValue(v, t);
    case 'struct': return Array.isArray(v) ? structFromArray(v, t) : structFromObject(v, t);
    default: throw new Error(`unknown serde type ${t.kind}`);
  }
}

// serde_json::Map iteration order (BTreeMap: keys by bytes)
const entryKeys = (o) => Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpBytes);

// Value::deserialize_enum: "variant" or {"variant": ()} (a map with a single key).
function enumFromValue(v, t) {
  let variant, payload = null;
  if (typeof v === 'string') variant = v;
  else if (isObject(v)) {
    const keys = entryKeys(v);
    if (keys.length !== 1) throw new SerdeError('invalid value: map, expected map with a single key');
    [variant] = keys;
    payload = v[variant];
  } else throw invalidType(v, 'string or map');
  if (!t.lookup.has(variant)) throw unknownVariant(variant, t.names);
  if (payload !== null) throw invalidType(payload, 'unit');
  return t.lookup.get(variant);
}

// visit_array: derive visit_seq, then leftover elements are an error.
function structFromArray(v, t) {
  if (t.flatten !== undefined) throw invalidType(v, t.expecting);
  const seen = new Map();
  t.fields.forEach((f, i) => {
    if (i < v.length) seen.set(i, fromValue(v[i], f[1]));
    else if (f[2] === undefined) throw invalidLength(i, t);
  });
  if (v.length > t.fields.length) throw new SerdeError(`invalid length ${v.length}, expected fewer elements in array`);
  return finishStruct(t, seen);
}

// visit_object: derive visit_map over the entries in key order.
function structFromObject(v, t) {
  if (!isObject(v)) throw invalidType(v, t.expecting);
  const seen = new Map();
  const extra = t.flatten === undefined ? undefined : {};
  for (const k of entryKeys(v)) {
    const i = t.index.get(k);
    if (i === undefined) {
      if (t.denyUnknown) throw unknownField(k, t.names);
      if (extra) setOwn(extra, k, v[k]);
      continue;
    }
    if (seen.has(i)) throw duplicateField(t.fields[i][0]);
    seen.set(i, fromValue(v[k], t.fields[i][1]));
  }
  return finishStruct(t, seen, extra);
}
