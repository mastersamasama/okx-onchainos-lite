// PRIVATE fallback — serde_json 1.0.149 `from_str` for the identity / a2mcp ports, built on the
// watch module's Deserializer (lib/watch/_serde.mjs) with one correction: number parsing follows
// de.rs parse_integer / parse_number / parse_decimal / parse_exponent / parse_long_* exactly,
// so an i32 exponent overflow (`1e99999999999999`) stops at the overflowing digit —
// NumberOutOfRange there for a non-zero significand with a positive exponent, otherwise ±0.0
// with the remaining digits consumed — instead of failing after the last digit. Values are
// correctly rounded (upstream enables serde_json's `float_roundtrip`). Requested for promotion
// into lib/watch/_serde.mjs; the typed combinators (string / vec / struct / value …) are reused
// unchanged because they call `de.parseInteger` polymorphically.
import { Deserializer, SerdeError } from '../../watch/_serde.mjs';

const U64_MAX = 18446744073709551615n;
const I32_MAX = 2147483647;
const EOF_VALUE = 'EOF while parsing a value';
const INVALID_NUMBER = 'invalid number';
const OUT_OF_RANGE = 'number out of range';
const isDigit = (c) => c !== undefined && c >= 0x30 && c <= 0x39;

class NumberDeserializer extends Deserializer {
  // parse_integer(positive) → { kind: 'u64' | 'i64' | 'f64', v } (the '-' is already consumed).
  parseInteger(positive) {
    const start = this.i;
    const peekOrNull = () => this.peekOrNull();
    const isExp = (c) => c === 0x65 || c === 0x45;
    // f64_from_parts / f64_long_from_parts (float_roundtrip): correctly rounded, ±inf → error.
    const fromParts = () => {
      const f = Number(this.b.subarray(start, this.i).toString('latin1'));
      if (!Number.isFinite(f)) throw this.error(OUT_OF_RANGE);
      return positive ? f : -f;
    };
    const exponentOverflow = (zeroSignificand, positiveExp) => {
      if (!zeroSignificand && positiveExp) throw this.error(OUT_OF_RANGE);
      while (isDigit(peekOrNull())) this.i++;
      return positive ? 0 : -0;
    };
    const exponent = (zeroSignificand) => {
      this.i++;
      let positiveExp = true;
      const sign = peekOrNull();
      if (sign === 0x2b) this.i++;
      else if (sign === 0x2d) { this.i++; positiveExp = false; }
      const next = this.next();
      if (next === undefined) throw this.error(EOF_VALUE);
      if (!isDigit(next)) throw this.error(INVALID_NUMBER);
      let exp = next - 0x30;
      while (isDigit(peekOrNull())) {
        const digit = this.b[this.i++] - 0x30;
        if (exp * 10 + digit > I32_MAX) return exponentOverflow(zeroSignificand, positiveExp);
        exp = exp * 10 + digit;
      }
      return fromParts();
    };
    const decimal = (significand) => {
      this.i++;
      let digits = 0;
      let overflowed = false;
      while (isDigit(peekOrNull())) {
        if (!overflowed && significand * 10n + BigInt(this.b[this.i] - 0x30) > U64_MAX) overflowed = true;
        if (!overflowed) significand = significand * 10n + BigInt(this.b[this.i] - 0x30);
        this.i++;
        digits++;
      }
      if (!digits) throw this.peek() === undefined ? this.peekError(EOF_VALUE) : this.peekError(INVALID_NUMBER);
      return isExp(peekOrNull()) ? exponent(significand === 0n) : fromParts();
    };
    const number = (significand) => {
      const c = peekOrNull();
      if (c === 0x2e) return { kind: 'f64', v: decimal(significand) };
      if (isExp(c)) return { kind: 'f64', v: exponent(significand === 0n) };
      if (positive) return { kind: 'u64', v: significand };
      // (significand as i64).wrapping_neg() >= 0 (`-0` or below i64::MIN) → f64
      if (significand === 0n || significand > 9223372036854775808n) return { kind: 'f64', v: -Number(significand) };
      return { kind: 'i64', v: -significand };
    };
    // parse_long_integer: the u64 significand overflowed; every digit stays significant.
    const longInteger = () => {
      for (;;) {
        const c = peekOrNull();
        if (isDigit(c)) this.i++;
        else if (c === 0x2e) return decimal(1n);
        else if (isExp(c)) return exponent(false);
        else return fromParts();
      }
    };

    const next = this.next();
    if (next === undefined) throw this.error(EOF_VALUE);
    if (next === 0x30) {
      if (isDigit(peekOrNull())) throw this.peekError(INVALID_NUMBER);
      return number(0n);
    }
    if (next >= 0x31 && next <= 0x39) {
      let significand = BigInt(next - 0x30);
      for (;;) {
        const c = peekOrNull();
        if (!isDigit(c)) return number(significand);
        const digit = BigInt(c - 0x30);
        if (significand * 10n + digit > U64_MAX) return { kind: 'f64', v: longInteger() };
        this.i++;
        significand = significand * 10n + digit;
      }
    }
    throw this.error(INVALID_NUMBER);
  }
}

// serde_json::from_str::<T>(text)
export function fromStr(text, target) {
  const de = new NumberDeserializer(text);
  const v = target(de);
  de.end();
  return v;
}

export { SerdeError };
