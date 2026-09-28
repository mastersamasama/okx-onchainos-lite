// Private helper for lib/wallet/*: serde_json 1.0.x `from_str` / `from_slice` semantics.
//
// Upstream reads its state files with `serde_json::from_str::<Struct>` and wallet API bodies
// with `serde_json::from_str::<Value>`. Both are *streaming* deserializers, so error texts
// carry the byte position (`… at line L column C`), errors surface in document order, and
// struct rules apply while parsing (duplicate fields, `null` vs missing, seq-form structs).
// This module reproduces that behaviour for the shapes lite needs:
//   T.string · T.bool · T.i64 · T.value (serde_json::Value) · T.option(t) · T.vec(t)
//   T.map(t) (HashMap<String, t>) · T.struct(name, [[jsonName, type, default?], …])
// A field without a default is required ("missing field `x`"); `default` may be a value or a
// function returning a fresh one (Rust `#[serde(default)]`).
// Values decode to lite's lossless representation (core/json.mjs parse): safe integers →
// number, larger u64/i64 → BigInt, everything else (decimals, exponents, -0, > u64) → F64.
import { F64, formatF64 } from '../core/json.mjs';

// serde_json::Error — Display "<msg> at line L column C" (line 0 = no position: data error
// not yet positioned by the deserializer).
export class SerdeJsonError extends Error {
  constructor(msg, line = 0, column = 0) {
    super(line === 0 ? msg : `${msg} at line ${line} column ${column}`);
    this.msg = msg; this.line = line; this.column = column;
  }
}

const E = {
  EofList: 'EOF while parsing a list', EofObject: 'EOF while parsing an object', EofString: 'EOF while parsing a string',
  EofValue: 'EOF while parsing a value', Colon: 'expected `:`', ListCommaOrEnd: 'expected `,` or `]`',
  ObjectCommaOrEnd: 'expected `,` or `}`', Ident: 'expected ident', Value: 'expected value', InvalidEscape: 'invalid escape',
  InvalidNumber: 'invalid number', OutOfRange: 'number out of range', Control: 'control character (\\u0000-\\u001F) found while parsing a string',
  KeyString: 'key must be a string', LoneLeading: 'lone leading surrogate in hex escape', TrailingComma: 'trailing comma',
  Trailing: 'trailing characters', UnexpectedEndHex: 'unexpected end of hex escape', Recursion: 'recursion limit exceeded',
};

// Rust `{:?}` of a str (serde Unexpected::Str).
export function rustDebugStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0xd800 && c <= 0xdfff)) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

// serde_json JsonUnexpected Display for a parsed/decoded value.
export function unexpectedText(u) {
  switch (u.kind) {
    case 'unit': return 'null';
    case 'bool': return `boolean \`${u.v}\``;
    case 'unsigned': case 'signed': return `integer \`${u.v}\``;
    case 'float': return `floating point \`${formatF64(u.v)}\``;
    case 'str': return `string ${rustDebugStr(u.v)}`;
    case 'seq': return 'sequence';
    default: return 'map';
  }
}
const invalidType = (u, exp) => new SerdeJsonError(`invalid type: ${unexpectedText(u)}, expected ${exp}`);

export const T = {
  string: { kind: 'string', expecting: 'a string' },
  bool: { kind: 'bool', expecting: 'a boolean' },
  i64: { kind: 'i64', expecting: 'i64' },
  value: { kind: 'value' },
  option: (t) => ({ kind: 'option', t }),
  vec: (t) => ({ kind: 'vec', t, expecting: 'a sequence' }),
  map: (t) => ({ kind: 'map', t, expecting: 'a map' }),
  struct: (name, fields) => ({ kind: 'struct', name, fields, expecting: `struct ${name}` }),
};

const WS = new Set([0x20, 0x0a, 0x09, 0x0d]);
const isDigit = (b) => b >= 0x30 && b <= 0x39;
const U64_MAX = 18446744073709551615n, I64_MAX = 9223372036854775807n;

class Deserializer {
  constructor(buf) { this.b = buf; this.i = 0; this.depth = 128; }
  peek() { return this.i < this.b.length ? this.b[this.i] : null; }
  peekOrNull() { return this.i < this.b.length ? this.b[this.i] : 0; }
  eat() { this.i++; }
  next() { return this.i < this.b.length ? this.b[this.i++] : null; }
  positionOf(i) {
    let start = 0;
    for (let k = i - 1; k >= 0; k--) if (this.b[k] === 0x0a) { start = k + 1; break; }
    let line = 1;
    for (let k = 0; k < start; k++) if (this.b[k] === 0x0a) line++;
    return [line, i - start];
  }
  error(msg) { const [l, c] = this.positionOf(this.i); return new SerdeJsonError(msg, l, c); }
  peekError(msg) { const [l, c] = this.positionOf(Math.min(this.b.length, this.i + 1)); return new SerdeJsonError(msg, l, c); }
  fix(err) { return err instanceof SerdeJsonError && err.line === 0 ? this.error(err.msg) : err; }
  ws() { while (this.i < this.b.length && WS.has(this.b[this.i])) this.i++; return this.peek(); }
  ident(rest) {
    for (const ch of rest) {
      const n = this.next();
      if (n === null) throw this.error(E.EofValue);
      if (n !== ch.charCodeAt(0)) throw this.error(E.Ident);
    }
  }
  end() { if (this.ws() !== null) throw this.peekError(E.Trailing); }
  recurse(fn) {
    this.depth -= 1;
    if (this.depth === 0) throw this.peekError(E.Recursion);
    try { return fn(); } finally { this.depth += 1; }
  }

  // ── strings ──
  parseStr() {                       // opening quote already consumed
    const parts = [];
    let start = this.i;
    for (;;) {
      while (this.i < this.b.length && this.b[this.i] !== 0x22 && this.b[this.i] !== 0x5c && this.b[this.i] >= 0x20) this.i++;
      if (this.i === this.b.length) throw this.error(E.EofString);
      const c = this.b[this.i];
      if (c === 0x22) { parts.push(this.b.subarray(start, this.i)); this.i++; return Buffer.concat(parts).toString('utf8'); }
      if (c === 0x5c) { parts.push(this.b.subarray(start, this.i)); this.i++; parts.push(this.escape()); start = this.i; continue; }
      this.i++;
      throw this.error(E.Control);
    }
  }
  hex4() {
    if (this.b.length - this.i < 4) { this.i = this.b.length; throw this.error(E.EofString); }
    const s = this.b.subarray(this.i, this.i + 4).toString('latin1');
    this.i += 4;
    if (!/^[0-9a-fA-F]{4}$/.test(s)) throw this.error(E.InvalidEscape);
    return parseInt(s, 16);
  }
  escape() {
    const ch = this.next();
    if (ch === null) throw this.error(E.EofString);
    const simple = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' }[ch];
    if (simple !== undefined) return Buffer.from(simple);
    if (ch !== 0x75) throw this.error(E.InvalidEscape);
    const n = this.hex4();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error(E.LoneLeading);
    if (n < 0xd800 || n > 0xdbff) return Buffer.from(String.fromCharCode(n), 'utf8');
    if (this.peek() === null) throw this.error(E.EofString);
    if (this.peek() !== 0x5c) { this.i++; throw this.error(E.UnexpectedEndHex); }
    this.i++;
    if (this.peek() === null) throw this.error(E.EofString);
    if (this.peek() !== 0x75) { this.i++; throw this.error(E.UnexpectedEndHex); }
    this.i++;
    const n2 = this.hex4();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error(E.LoneLeading);
    return Buffer.from(String.fromCharCode(n, n2), 'utf8');
  }

  // ── numbers (parse_integer / parse_number / parse_decimal / parse_exponent) ──
  // Returns { kind: 'unsigned'|'signed'|'float', v, text } — the sign byte, if any, is consumed.
  parseInteger(positive, startIdx) {
    const first = this.next();
    if (first === null) throw this.error(E.EofValue);
    let overflowed = false;
    if (first === 0x30) {
      if (isDigit(this.peekOrNull())) throw this.peekError(E.InvalidNumber);
    } else if (first >= 0x31 && first <= 0x39) {
      let sig = BigInt(first - 0x30);
      while (isDigit(this.peekOrNull())) {
        const nextSig = sig * 10n + BigInt(this.peekOrNull() - 0x30);
        if (!overflowed && nextSig > U64_MAX) overflowed = true;
        this.eat();
        sig = nextSig;
      }
    } else throw this.error(E.InvalidNumber);
    let isFloat = overflowed;
    const p = this.peekOrNull();
    if (p === 0x2e) { this.decimal(); isFloat = true; }
    else if (p === 0x65 || p === 0x45) { this.exponent(); isFloat = true; }
    const text = this.b.subarray(startIdx, this.i).toString('latin1');
    if (isFloat) {
      const v = Number(text);
      if (!Number.isFinite(v)) throw this.error(E.OutOfRange);
      return { kind: 'float', v, text };
    }
    const big = BigInt(text);
    if (positive) return { kind: 'unsigned', v: big, text };
    if (big === 0n || big < -I64_MAX - 1n) return { kind: 'float', v: Number(text), text };   // -0 / i64 underflow → f64
    return { kind: 'signed', v: big, text };
  }
  decimal() {
    this.eat();
    let digits = 0;
    while (isDigit(this.peekOrNull())) { this.eat(); digits++; }
    if (digits === 0) {
      if (this.peek() !== null) throw this.peekError(E.InvalidNumber);
      throw this.peekError(E.EofValue);
    }
    const p = this.peekOrNull();
    if (p === 0x65 || p === 0x45) this.exponent();
  }
  exponent() {
    this.eat();
    const p = this.peekOrNull();
    if (p === 0x2b || p === 0x2d) this.eat();
    const n = this.next();
    if (n === null) throw this.error(E.EofValue);
    if (!isDigit(n)) throw this.error(E.InvalidNumber);
    while (isDigit(this.peekOrNull())) this.eat();
  }
  number(peek) {
    const start = this.i;
    if (peek === 0x2d) { this.eat(); return this.parseInteger(false, start); }
    return this.parseInteger(true, start);
  }

  // peek_invalid_type — consumes the offending scalar, then positions the error.
  peekInvalidType(exp) {
    const p = this.peekOrNull();
    let u;
    if (p === 0x6e) { this.eat(); this.ident('ull'); u = { kind: 'unit' }; }
    else if (p === 0x74) { this.eat(); this.ident('rue'); u = { kind: 'bool', v: true }; }
    else if (p === 0x66) { this.eat(); this.ident('alse'); u = { kind: 'bool', v: false }; }
    else if (p === 0x2d || isDigit(p)) u = this.number(p);
    else if (p === 0x22) { this.eat(); u = { kind: 'str', v: this.parseStr() }; }
    else if (p === 0x5b) u = { kind: 'seq' };
    else if (p === 0x7b) u = { kind: 'map' };
    else throw this.peekError(E.Value);
    return this.fix(invalidType(u, exp));
  }

  // ── seq / map access ──
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
  colon() {
    const p = this.ws();
    if (p === 0x3a) { this.eat(); return; }
    if (p !== null) throw this.peekError(E.Colon);
    throw this.peekError(E.EofObject);
  }
  endMap() {
    const p = this.ws();
    if (p === 0x7d) { this.eat(); return; }
    if (p === 0x2c) throw this.peekError(E.TrailingComma);
    if (p !== null) throw this.peekError(E.Trailing);
    throw this.peekError(E.EofObject);
  }
  // `match (visitor.visit_x(..), self.end_x())` — end runs even after a visitor error; the
  // visitor error wins, then deserialize_x positions it.
  container(open, visit, endFn) {
    return this.recurse(() => {
      this.eat();
      let ret, err;
      try { ret = visit(); } catch (e) { if (!(e instanceof SerdeJsonError)) throw e; err = e; }
      let endErr;
      try { endFn(); } catch (e) { if (!(e instanceof SerdeJsonError)) throw e; endErr = e; }
      if (err) throw err;
      if (endErr) throw endErr;
      return ret;
    });
  }

  // ── typed deserialization ──
  de(t) {
    switch (t.kind) {
      case 'value': return this.deValue();
      case 'option': {
        if (this.ws() === 0x6e) { this.eat(); this.ident('ull'); return null; }
        return this.de(t.t);
      }
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
        case 'i64': {
          if (p !== 0x2d && !isDigit(p)) throw this.peekInvalidType(t.expecting);
          const n = this.number(p);
          if (n.kind === 'float') throw invalidType(n, 'i64');
          if (n.kind === 'unsigned' && n.v > I64_MAX) throw new SerdeJsonError(`invalid value: integer \`${n.v}\`, expected i64`);
          return Number.isSafeInteger(Number(n.v)) ? Number(n.v) : n.v;
        }
        case 'vec':
          if (p !== 0x5b) throw this.peekInvalidType(t.expecting);
          return this.container(0x5b, () => { const st = { first: true }, out = []; while (this.nextElement(st)) out.push(this.de(t.t)); return out; }, () => this.endSeq());
        case 'map':
          if (p !== 0x7b) throw this.peekInvalidType(t.expecting);
          return this.container(0x7b, () => {
            const st = { first: true }, out = {};
            for (let k = this.nextKey(st); k !== null; k = this.nextKey(st)) { this.colon(); setOwn(out, k, this.de(t.t)); }
            return out;
          }, () => this.endMap());
        case 'struct':
          if (p === 0x7b) return this.container(0x7b, () => this.structMap(t), () => this.endMap());
          if (p === 0x5b) return this.container(0x5b, () => this.structSeq(t), () => this.endSeq());
          throw this.peekInvalidType(t.expecting);
        default: throw new Error(`unknown serde type ${t.kind}`);
      }
    } catch (e) { throw this.fix(e); }
  }
  structMap(t) {
    const byName = new Map(t.fields.map((f) => [f[0], f]));
    const seen = {};
    const st = { first: true };
    for (let k = this.nextKey(st); k !== null; k = this.nextKey(st)) {
      const f = byName.get(k);
      if (!f) { this.colon(); this.ignoreValue(); continue; }
      if (Object.prototype.hasOwnProperty.call(seen, k)) throw new SerdeJsonError(`duplicate field \`${k}\``);
      this.colon();
      seen[k] = this.de(f[1]);
    }
    return this.finishStruct(t, seen, (name) => { throw new SerdeJsonError(`missing field \`${name}\``); });
  }
  structSeq(t) {
    const seen = {};
    const st = { first: true };
    const n = t.fields.length;
    for (let idx = 0; idx < n; idx++) {
      const f = t.fields[idx];
      if (!this.nextElement(st)) {
        if (f.length < 3) throw new SerdeJsonError(`invalid length ${idx}, expected struct ${t.name} with ${n} element${n === 1 ? '' : 's'}`);
        continue;
      }
      seen[f[0]] = this.de(f[1]);
    }
    return this.finishStruct(t, seen);
  }
  finishStruct(t, seen, onMissing) {
    const out = {};
    for (const [name, type, def] of t.fields) {
      if (Object.prototype.hasOwnProperty.call(seen, name)) out[name] = seen[name];
      else if (def !== undefined) out[name] = typeof def === 'function' ? def() : def;
      else if (type.kind === 'option') out[name] = null;
      else onMissing(name);
    }
    return out;
  }

  deValue() {
    const p = this.ws();
    if (p === null) throw this.peekError(E.EofValue);
    try {
      if (p === 0x6e) { this.eat(); this.ident('ull'); return null; }
      if (p === 0x74) { this.eat(); this.ident('rue'); return true; }
      if (p === 0x66) { this.eat(); this.ident('alse'); return false; }
      if (p === 0x2d || isDigit(p)) return numberValue(this.number(p));
      if (p === 0x22) { this.eat(); return this.parseStr(); }
      if (p === 0x5b) return this.container(0x5b, () => { const st = { first: true }, out = []; while (this.nextElement(st)) out.push(this.deValue()); return out; }, () => this.endSeq());
      if (p === 0x7b) {
        return this.container(0x7b, () => {
          const st = { first: true }, out = {};
          for (let k = this.nextKey(st); k !== null; k = this.nextKey(st)) { this.colon(); setOwn(out, k, this.deValue()); }
          return out;
        }, () => this.endMap());
      }
      throw this.peekError(E.Value);
    } catch (e) { throw this.fix(e); }
  }

  // ignore_value (IgnoredAny for unknown struct fields): iterative, no recursion limit.
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
        else if (k !== null) throw this.peekError(E.KeyString);
        else throw this.peekError(E.EofObject);
        this.ignoreStr();
        const c = this.ws();
        if (c === 0x3a) this.eat();
        else if (c !== null) throw this.peekError(E.Colon);
        else throw this.peekError(E.EofObject);
      }
      enclosing = frame;
    }
  }
  ignoreInteger() {
    const n = this.i < this.b.length ? this.b[this.i++] : 0;
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
    const n = this.i < this.b.length ? this.b[this.i++] : 0;
    if (!isDigit(n)) throw this.error(E.InvalidNumber);
    while (isDigit(this.peekOrNull())) this.eat();
  }
  ignoreStr() {
    for (;;) {
      while (this.i < this.b.length && this.b[this.i] !== 0x22 && this.b[this.i] !== 0x5c && this.b[this.i] >= 0x20) this.i++;
      if (this.i === this.b.length) throw this.error(E.EofString);
      const c = this.b[this.i];
      if (c === 0x22) { this.i++; return; }
      if (c === 0x5c) {
        this.i++;
        const ch = this.next();
        if (ch === null) throw this.error(E.EofString);
        if (ch === 0x75) this.hex4();
        else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(ch)) throw this.error(E.InvalidEscape);
        continue;
      }
      this.i++;
      throw this.error(E.Control);
    }
  }
}

// Own enumerable property even for keys such as "__proto__".
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// ParserNumber → lite value representation.
function numberValue(n) {
  if (n.kind === 'float') return new F64(n.text);
  const v = n.v;
  return Number.isSafeInteger(Number(v)) ? Number(v) : v;
}

// serde_json::from_str / from_slice::<t>(input) → decoded value; throws SerdeJsonError.
export function fromStr(input, t = T.value) {
  const d = new Deserializer(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'));
  const v = d.de(t);
  d.end();
  return v;
}
