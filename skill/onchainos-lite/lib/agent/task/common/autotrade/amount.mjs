// Exact decimal arithmetic for auto-trade amounts — upstream autotrade/amount.rs.
// `mantissa * 10^-scale` with an unsigned 128-bit mantissa; no floating point anywhere.

// upstream: amount.rs::AmountError (Display texts)
export const AmountError = Object.freeze({
  Empty: 'empty amount',
  Invalid: 'invalid decimal string',
  Overflow: 'amount arithmetic overflow',
});
export class AmountErr extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 4294967295;
const PCT_ABS_SCALE = 8;

// upstream: amount.rs::pow10 → 10^exp as u128 or Overflow
function pow10(exp) {
  const v = 10n ** BigInt(exp);
  if (v > U128_MAX) throw new AmountErr(AmountError.Overflow);
  return v;
}
const checkedMul = (a, b) => { const v = a * b; if (v > U128_MAX) throw new AmountErr(AmountError.Overflow); return v; };
const checkedAddScale = (a, b) => { const v = a + b; if (v > U32_MAX) throw new AmountErr(AmountError.Overflow); return v; };

// upstream: amount.rs::Decimal
export class Decimal {
  constructor(mantissa, scale) { this.mantissa = BigInt(mantissa); this.scale = scale; }

  // upstream: Decimal::parse
  static parse(s) {
    s = String(s);
    if (s === '') throw new AmountErr(AmountError.Empty);
    let int = '', frac = '', seenDot = false;
    for (const c of s) {
      if (c >= '0' && c <= '9') { if (seenDot) frac += c; else int += c; }
      else if (c === '.' && !seenDot) seenDot = true;
      else throw new AmountErr(AmountError.Invalid);
    }
    if (int === '' && frac === '') throw new AmountErr(AmountError.Invalid);
    const digits = int + frac;
    const mantissa = digits === '' ? 0n : BigInt(digits);
    if (mantissa > U128_MAX) throw new AmountErr(AmountError.Overflow);
    return new Decimal(mantissa, frac.length).normalized();
  }

  // upstream: Decimal::is_zero
  isZero() { return this.mantissa === 0n; }

  // upstream: Decimal::normalized
  normalized() {
    let m = this.mantissa, s = this.scale;
    if (m === 0n) return new Decimal(0n, 0);
    while (s > 0 && m % 10n === 0n) { m /= 10n; s -= 1; }
    return new Decimal(m, s);
  }

  // upstream: Decimal::mantissa_at
  mantissaAt(targetScale) {
    if (targetScale < this.scale) throw new Error('mantissa_at requires target_scale >= self.scale');
    return checkedMul(this.mantissa, pow10(targetScale - this.scale));
  }

  // upstream: Decimal::pct_to_absolute — holding * pct / 100, floored to 8 dp.
  static pctToAbsolute(holding, pct) {
    const m = checkedMul(holding.mantissa, pct.mantissa);
    const s = checkedAddScale(holding.scale, pct.scale);
    return new Decimal(m, checkedAddScale(s, 2)).floorTo(PCT_ABS_SCALE);
  }

  // upstream: Decimal::ratio_to_absolute — holding * ratio, floored to 8 dp.
  static ratioToAbsolute(holding, ratio) {
    const m = checkedMul(holding.mantissa, ratio.mantissa);
    return new Decimal(m, checkedAddScale(holding.scale, ratio.scale)).floorTo(PCT_ABS_SCALE);
  }

  // upstream: Decimal::pct_to_ratio — pct / 100 exact.
  static pctToRatio(pct) { return new Decimal(pct.mantissa, checkedAddScale(pct.scale, 2)).normalized(); }

  // upstream: Decimal::floor_to
  floorTo(maxScale) {
    if (this.scale <= maxScale) return this.normalized();
    const drop = this.scale - maxScale;
    let divisor;
    try { divisor = pow10(drop); } catch { divisor = U128_MAX; }
    return new Decimal(this.mantissa / divisor, maxScale).normalized();
  }

  // upstream: Decimal::le — exact compare; overflow while widening ⇒ false.
  le(cap) {
    const common = Math.max(this.scale, cap.scale);
    try { return this.mantissaAt(common) <= cap.mantissaAt(common); } catch { return false; }
  }

  // derive(PartialEq) on the normalized representation
  eq(other) { return this.mantissa === other.mantissa && this.scale === other.scale; }

  // upstream: Decimal::to_plain_string
  toPlainString() {
    if (this.scale === 0) return this.mantissa.toString();
    const digits = this.mantissa.toString();
    if (digits.length > this.scale) {
      const split = digits.length - this.scale;
      return `${digits.slice(0, split)}.${digits.slice(split)}`;
    }
    return `0.${'0'.repeat(this.scale - digits.length)}${digits}`;
  }
  toString() { return this.toPlainString(); }
}
