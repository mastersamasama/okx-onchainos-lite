// serde_json 1.0.149 `from_str::<T>` for typed targets, reproducing its error texts and
// "at line L column C" positions (byte based) — needed where upstream surfaces serde errors
// verbatim (watch config.json: `watch config is corrupt (<path>): <serde err>`, `ws poll`).
// Mirrors serde_json::de::Deserializer (parse_whitespace, peek_invalid_type, deserialize_*,
// SeqAccess/MapAccess, end_seq/end_map, ignore_value) and serde_derive's visitors.
// Private to the watch module; candidate for promotion to core/json.mjs.
import { formatF64, F64 } from '../core/json.mjs';

export class SerdeError extends Error {
  constructor(msg, line = 0, column = 0) {
    super(line ? `${msg} at line ${line} column ${column}` : msg);
    this.msg = msg; this.line = line; this.column = column;
  }
}

const C = {
  EofList: 'EOF while parsing a list', EofObject: 'EOF while parsing an object', EofString: 'EOF while parsing a string',
  EofValue: 'EOF while parsing a value', Colon: 'expected `:`', ListCommaOrEnd: 'expected `,` or `]`',
  ObjectCommaOrEnd: 'expected `,` or `}`', Ident: 'expected ident', Value: 'expected value', Escape: 'invalid escape',
  Number: 'invalid number', Range: 'number out of range', Control: 'control character (\\u0000-\\u001F) found while parsing a string',
  Key: 'key must be a string', LoneSurrogate: 'lone leading surrogate in hex escape', TrailingComma: 'trailing comma',
  Trailing: 'trailing characters', HexEnd: 'unexpected end of hex escape',
};

// Rust `{:?}` for str (used by Unexpected::Str).
export function debugStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0) out += '\\0';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

// serde::de::Unexpected as displayed through serde_json's JsonUnexpected.
const unexpected = {
  bool: (b) => `boolean \`${b}\``, int: (n) => `integer \`${n}\``, float: (f) => `floating point \`${formatF64(f)}\``,
  str: (s) => `string ${debugStr(s)}`, unit: () => 'null', seq: () => 'sequence', map: () => 'map',
};
const invalidType = (unexp, exp) => new SerdeError(`invalid type: ${unexp}, expected ${exp}`);
const invalidValue = (unexp, exp) => new SerdeError(`invalid value: ${unexp}, expected ${exp}`);
export const custom = (msg) => new SerdeError(msg);

const isDigit = (b) => b >= 0x30 && b <= 0x39;
const U64_MAX = 18446744073709551615n;

export class Deserializer {
  constructor(text) { this.b = Buffer.from(String(text), 'utf8'); this.i = 0; this.depth = 128; }
  peek() { return this.i < this.b.length ? this.b[this.i] : undefined; }
  peekOrNull() { return this.peek() ?? 0; }
  eat() { this.i++; }
  next() { return this.i < this.b.length ? this.b[this.i++] : undefined; }
  position(i) {
    const nl = this.b.lastIndexOf(0x0a, i - 1);
    const start = i === 0 || nl < 0 ? 0 : nl + 1;
    let line = 1;
    for (let k = 0; k < start; k++) if (this.b[k] === 0x0a) line++;
    return [line, i - start];
  }
  error(msg) { const [l, c] = this.position(this.i); return new SerdeError(msg, l, c); }
  peekError(msg) { const [l, c] = this.position(Math.min(this.b.length, this.i + 1)); return new SerdeError(msg, l, c); }
  fix(err) {
    if (!(err instanceof SerdeError)) throw err;
    return err.line ? err : this.error(err.msg);
  }
  ws() {
    for (;;) {
      const p = this.peek();
      if (p === 0x20 || p === 0x0a || p === 0x09 || p === 0x0d) this.i++;
      else return p;
    }
  }
  ident(rest) {
    for (const ch of rest) {
      const n = this.next();
      if (n === undefined) throw this.error(C.EofValue);
      if (n !== ch.charCodeAt(0)) throw this.error(C.Ident);
    }
  }

  // read.rs parse_str (after the opening quote), validate = true.
  parseStr() {
    const parts = [];
    let start = this.i;
    for (;;) {
      while (this.i < this.b.length) {
        const c = this.b[this.i];
        if (c === 0x22 || c === 0x5c || c < 0x20) break;
        this.i++;
      }
      if (this.i === this.b.length) throw this.error(C.EofString);
      const c = this.b[this.i];
      if (c === 0x22) {
        parts.push(this.b.subarray(start, this.i));
        this.i++;
        return Buffer.concat(parts).toString('utf8');
      }
      if (c === 0x5c) {
        parts.push(this.b.subarray(start, this.i));
        this.i++;
        parts.push(Buffer.from(this.parseEscape(), 'utf8'));
        start = this.i;
        continue;
      }
      this.i++;
      throw this.error(C.Control);
    }
  }
  parseEscape() {
    const ch = this.next();
    if (ch === undefined) throw this.error(C.EofString);
    const simple = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' }[ch];
    if (simple !== undefined) return simple;
    if (ch !== 0x75) throw this.error(C.Escape);
    let n = this.hex4();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error(C.LoneSurrogate);
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    const peekOrEof = () => { const p = this.peek(); if (p === undefined) throw this.error(C.EofString); return p; };
    if (peekOrEof() !== 0x5c) { this.i++; throw this.error(C.HexEnd); }
    this.i++;
    if (peekOrEof() !== 0x75) { this.i++; throw this.error(C.HexEnd); }
    this.i++;
    const n2 = this.hex4();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error(C.LoneSurrogate);
    return String.fromCharCode(n, n2);
  }
  hex4() {
    if (this.i + 4 > this.b.length) { this.i = this.b.length; throw this.error(C.EofString); }
    const s = this.b.subarray(this.i, this.i + 4).toString('latin1');
    this.i += 4;
    if (!/^[0-9a-fA-F]{4}$/.test(s)) throw this.error(C.Escape);
    return parseInt(s, 16);
  }

  // parse_integer / parse_number (float_roundtrip off): → { kind: 'u64'|'i64'|'f64', v }
  parseInteger(positive) {
    const next = this.next();
    if (next === undefined) throw this.error(C.EofValue);
    let text;
    if (next === 0x30) {
      if (isDigit(this.peekOrNull())) throw this.peekError(C.Number);
      text = '0';
    } else if (next >= 0x31 && next <= 0x39) {
      text = String.fromCharCode(next);
      while (isDigit(this.peekOrNull())) { text += String.fromCharCode(this.b[this.i]); this.i++; }
    } else throw this.error(C.Number);
    let isFloat = BigInt(text) > U64_MAX;
    const p = this.peekOrNull();
    if (p === 0x2e) {
      this.i++;
      let digits = 0;
      text += '.';
      while (isDigit(this.peekOrNull())) { text += String.fromCharCode(this.b[this.i]); this.i++; digits++; }
      if (!digits) throw this.peek() === undefined ? this.peekError(C.EofValue) : this.peekError(C.Number);
      isFloat = true;
    }
    if (this.peekOrNull() === 0x65 || this.peekOrNull() === 0x45) {
      this.i++;
      text += 'e';
      const s = this.peekOrNull();
      if (s === 0x2b || s === 0x2d) { this.i++; text += String.fromCharCode(s); }
      const d = this.next();
      if (d === undefined) throw this.error(C.EofValue);
      if (!isDigit(d)) throw this.error(C.Number);
      text += String.fromCharCode(d);
      while (isDigit(this.peekOrNull())) { text += String.fromCharCode(this.b[this.i]); this.i++; }
      isFloat = true;
    }
    if (isFloat) {
      const f = Number(text);
      if (!Number.isFinite(f)) throw this.error(C.Range);
      return { kind: 'f64', v: positive ? f : -f };
    }
    const n = BigInt(text);
    if (positive) return { kind: 'u64', v: n };
    if (n === 0n || n > 9223372036854775808n) return { kind: 'f64', v: -Number(n) };
    return { kind: 'i64', v: -n };
  }

  // peek_invalid_type
  invalidType(exp) {
    const p = this.peekOrNull();
    let err;
    if (p === 0x6e) { this.i++; this.ident('ull'); err = invalidType(unexpected.unit(), exp); }
    else if (p === 0x74) { this.i++; this.ident('rue'); err = invalidType(unexpected.bool(true), exp); }
    else if (p === 0x66) { this.i++; this.ident('alse'); err = invalidType(unexpected.bool(false), exp); }
    else if (p === 0x2d) { this.i++; err = numberInvalidType(this.parseInteger(false), exp); }
    else if (isDigit(p)) err = numberInvalidType(this.parseInteger(true), exp);
    else if (p === 0x22) { this.i++; err = invalidType(unexpected.str(this.parseStr()), exp); }
    else if (p === 0x5b) err = invalidType(unexpected.seq(), exp);
    else if (p === 0x7b) err = invalidType(unexpected.map(), exp);
    else err = this.peekError(C.Value);
    return this.fix(err);
  }

  // ignore_value (IgnoredAny for unknown fields)
  ignoreValue() {
    const stack = [];
    let enclosing;
    for (;;) {
      const p = this.ws();
      if (p === undefined) throw this.peekError(C.EofValue);
      let frame;
      if (p === 0x6e) { this.i++; this.ident('ull'); }
      else if (p === 0x74) { this.i++; this.ident('rue'); }
      else if (p === 0x66) { this.i++; this.ident('alse'); }
      else if (p === 0x2d) { this.i++; this.parseInteger(false); }
      else if (isDigit(p)) this.parseInteger(true);
      else if (p === 0x22) { this.i++; this.parseStr(); }
      else if (p === 0x5b || p === 0x7b) { if (enclosing !== undefined) stack.push(enclosing); enclosing = undefined; this.i++; frame = p; }
      else throw this.peekError(C.Value);
      let acceptComma;
      if (frame !== undefined) acceptComma = false;
      else if (enclosing !== undefined) { frame = enclosing; enclosing = undefined; acceptComma = true; }
      else if (stack.length) { frame = stack.pop(); acceptComma = true; }
      else return;
      for (;;) {
        const q = this.ws();
        if (q === 0x2c && acceptComma) { this.i++; break; }
        if ((q === 0x5d && frame === 0x5b) || (q === 0x7d && frame === 0x7b)) {
          this.i++;
          if (!stack.length) return;
          frame = stack.pop();
          acceptComma = true;
          continue;
        }
        if (q === undefined) throw this.peekError(frame === 0x5b ? C.EofList : C.EofObject);
        if (acceptComma) throw this.peekError(frame === 0x5b ? C.ListCommaOrEnd : C.ObjectCommaOrEnd);
        break;
      }
      if (frame === 0x7b) {
        const q = this.ws();
        if (q === 0x22) this.i++;
        else if (q === undefined) throw this.peekError(C.EofObject);
        else throw this.peekError(C.Key);
        this.parseStr();
        const r = this.ws();
        if (r === 0x3a) this.i++;
        else if (r === undefined) throw this.peekError(C.EofObject);
        else throw this.peekError(C.Colon);
      }
      enclosing = frame;
    }
  }

  endSeq() {
    const p = this.ws();
    if (p === 0x5d) { this.i++; return; }
    if (p === 0x2c) {
      this.i++;
      throw this.ws() === 0x5d ? this.peekError(C.TrailingComma) : this.peekError(C.Trailing);
    }
    if (p === undefined) throw this.peekError(C.EofList);
    throw this.peekError(C.Trailing);
  }
  endMap() {
    const p = this.ws();
    if (p === 0x7d) { this.i++; return; }
    if (p === 0x2c) throw this.peekError(C.TrailingComma);
    if (p === undefined) throw this.peekError(C.EofObject);
    throw this.peekError(C.Trailing);
  }
  colon() {
    const p = this.ws();
    if (p === 0x3a) { this.i++; return; }
    throw this.peekError(p === undefined ? C.EofObject : C.Colon);
  }
  end() { if (this.ws() !== undefined) throw this.peekError(C.Trailing); }
}

function numberInvalidType(n, exp) {
  if (n.kind === 'f64') return invalidType(unexpected.float(n.v), exp);
  return invalidType(unexpected.int(n.v), exp);
}

// Run `visit` between the opening bracket and end_seq/end_map exactly like serde_json:
// the closing check runs even when the visitor failed, and the visitor error wins.
// check_recursion!: serde_json's 128-level nesting limit applies to every seq/map.
function nested(de, visit, end) {
  let ret, err;
  if (--de.depth === 0) throw de.peekError('recursion limit exceeded');
  de.i++;
  try { ret = visit(); } catch (e) { if (!(e instanceof SerdeError)) throw e; err = e; }
  de.depth++;
  let endErr;
  try { end.call(de); } catch (e) { if (!(e instanceof SerdeError)) throw e; endErr = e; }
  if (err) throw err;
  if (endErr) throw endErr;
  return ret;
}

// ── typed deserializers: (de) => value ─────────────────────────────────────

// String / &str (deserialize_str)
export function string(de, exp = 'a string') {
  const p = de.ws();
  if (p === undefined) throw de.peekError(C.EofValue);
  if (p === 0x22) { de.i++; return de.parseStr(); }
  throw de.invalidType(exp);
}

// u64 (deserialize_number with the u64 primitive visitor) → number, BigInt beyond 2^53
export function u64(de) {
  const p = de.ws();
  if (p === undefined) throw de.peekError(C.EofValue);
  let n;
  if (p === 0x2d) { de.i++; n = de.parseInteger(false); }
  else if (isDigit(p)) n = de.parseInteger(true);
  else throw de.invalidType('u64');
  if (n.kind === 'u64') return Number.isSafeInteger(Number(n.v)) ? Number(n.v) : n.v;
  if (n.kind === 'i64') throw de.fix(invalidValue(unexpected.int(n.v), 'u64'));
  throw de.fix(invalidType(unexpected.float(n.v), 'u64'));
}

// Vec<T> (deserialize_seq + VecVisitor)
export const vec = (elem) => (de) => {
  const p = de.ws();
  if (p === undefined) throw de.peekError(C.EofValue);
  if (p !== 0x5b) throw de.invalidType('a sequence');
  try {
    return nested(de, () => {
      const out = [];
      let first = true;
      for (;;) {
        const q = de.ws();
        if (q === undefined) throw de.peekError(C.EofList);
        if (q === 0x5d) return out;
        if (first) first = false;
        else if (q === 0x2c) {
          de.i++;
          const r = de.ws();
          if (r === 0x5d) throw de.peekError(C.TrailingComma);
          if (r === undefined) throw de.peekError(C.EofValue);
        } else throw de.peekError(C.ListCommaOrEnd);
        out.push(elem(de));
      }
    }, de.endSeq);
  } catch (e) { throw de.fix(e); }
};

// Unit-variant enum (deserialize_enum) with the given variant names.
export const unitEnum = (variants) => (de) => {
  const oneOf = variants.length === 1 ? `\`${variants[0]}\`` : variants.length === 2 ? `\`${variants[0]}\` or \`${variants[1]}\`` : `one of ${variants.map((v) => `\`${v}\``).join(', ')}`;
  const variant = () => {
    const v = string(de, 'variant identifier');
    if (!variants.includes(v)) throw de.fix(custom(`unknown variant \`${v}\`, expected ${oneOf}`));
    return v;
  };
  const p = de.ws();
  if (p === 0x7b) {
    de.i++;
    const v = variant();
    de.colon();
    const q = de.ws();
    if (q === undefined) throw de.peekError(C.EofValue);
    if (q === 0x6e) { de.i++; de.ident('ull'); } else throw de.invalidType('unit');
    const r = de.ws();
    if (r === 0x7d) { de.i++; return v; }
    throw de.error(r === undefined ? C.EofObject : C.Value);
  }
  if (p === 0x22) return variant();
  throw p === undefined ? de.peekError(C.EofValue) : de.peekError(C.Value);
};

// #[derive(Deserialize)] struct: fields = [{ name, de, def? }] in declaration order;
// `def` supplies the value for #[serde(default…)] fields.
export const struct = (name, fields) => (de) => {
  const p = de.ws();
  if (p === undefined) throw de.peekError(C.EofValue);
  const exp = `struct ${name}`;
  try {
    if (p === 0x5b) {
      return nested(de, () => {
        const out = {};
        let first = true;
        fields.forEach((f, idx) => {
          const q = de.ws();
          let has;
          if (q === undefined) throw de.peekError(C.EofList);
          if (q === 0x5d) has = false;
          else if (first) { first = false; has = true; }
          else if (q === 0x2c) {
            de.i++;
            const r = de.ws();
            if (r === 0x5d) throw de.peekError(C.TrailingComma);
            if (r === undefined) throw de.peekError(C.EofValue);
            has = true;
          } else throw de.peekError(C.ListCommaOrEnd);
          if (has) out[f.name] = f.de(de);
          else if (f.def) out[f.name] = f.def();
          else throw custom(`invalid length ${idx}, expected ${exp} with ${fields.length} elements`);
        });
        return out;
      }, de.endSeq);
    }
    if (p === 0x7b) {
      return nested(de, () => {
        const out = {};
        let first = true;
        for (;;) {
          const q = de.ws();
          if (q === undefined) throw de.peekError(C.EofObject);
          if (q === 0x7d) break;
          if (first) {
            first = false;
            if (q !== 0x22) throw de.peekError(C.Key);
          } else if (q === 0x2c) {
            de.i++;
            const r = de.ws();
            if (r === 0x7d) throw de.peekError(C.TrailingComma);
            if (r === undefined) throw de.peekError(C.EofValue);
            if (r !== 0x22) throw de.peekError(C.Key);
          } else throw de.peekError(C.ObjectCommaOrEnd);
          de.i++;
          const key = de.parseStr();
          const f = fields.find((x) => x.name === key);
          if (f && Object.prototype.hasOwnProperty.call(out, key)) throw custom(`duplicate field \`${key}\``);
          de.colon();
          if (f) out[key] = f.de(de);
          else de.ignoreValue();
        }
        for (const f of fields) {
          if (Object.prototype.hasOwnProperty.call(out, f.name)) continue;
          if (f.def) out[f.name] = f.def();
          else throw custom(`missing field \`${f.name}\``);
        }
        return out;
      }, de.endMap);
    }
    throw de.invalidType(exp);
  } catch (e) { throw de.fix(e); }
};

// serde_json::Value (deserialize_any): the same JS representation as core/json.mjs parse —
// integers as numbers (BigInt beyond 2^53), floats as F64, objects as plain objects —
// but with serde's acceptance rules (control characters, lone surrogates, out-of-range
// numbers and nesting deeper than the 128 recursion limit are errors).
export function value(de) {
  const p = de.ws();
  if (p === undefined) throw de.peekError(C.EofValue);
  const num = (n) => (n.kind === 'f64' ? new F64(n.v) : Number.isSafeInteger(Number(n.v)) ? Number(n.v) : n.v);
  try {
    switch (p) {
      case 0x6e: de.i++; de.ident('ull'); return null;
      case 0x74: de.i++; de.ident('rue'); return true;
      case 0x66: de.i++; de.ident('alse'); return false;
      case 0x2d: de.i++; return num(de.parseInteger(false));
      case 0x22: de.i++; return de.parseStr();
      case 0x5b: case 0x7b: {
        const isSeq = p === 0x5b;
        const out = nested(de, () => {
          const acc = isSeq ? [] : {};
          let first = true;
          for (;;) {
            const q = de.ws();
            if (q === undefined) throw de.peekError(isSeq ? C.EofList : C.EofObject);
            if (q === (isSeq ? 0x5d : 0x7d)) return acc;
            if (first) {
              first = false;
              if (!isSeq && q !== 0x22) throw de.peekError(C.Key);
            } else if (q === 0x2c) {
              de.i++;
              const r = de.ws();
              if (r === (isSeq ? 0x5d : 0x7d)) throw de.peekError(C.TrailingComma);
              if (r === undefined) throw de.peekError(C.EofValue);
              if (!isSeq && r !== 0x22) throw de.peekError(C.Key);
            } else throw de.peekError(isSeq ? C.ListCommaOrEnd : C.ObjectCommaOrEnd);
            if (isSeq) { acc.push(value(de)); continue; }
            de.i++;
            const key = de.parseStr();
            de.colon();
            Object.defineProperty(acc, key, { value: value(de), enumerable: true, writable: true, configurable: true });
          }
        }, isSeq ? de.endSeq : de.endMap);
        return out;
      }
      default:
        if (isDigit(p)) return num(de.parseInteger(true));
        throw de.peekError(C.Value);
    }
  } catch (e) { throw de.fix(e); }
}

// serde_json::from_str::<T>(text)
export function fromStr(text, target) {
  const de = new Deserializer(text);
  const v = target(de);
  de.end();
  return v;
}

