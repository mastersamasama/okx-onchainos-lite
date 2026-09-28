// Exact add / sub / compare over non-negative decimal strings — upstream
// task/evaluator/decimal_str.rs (u128 fixed-point after aligning the fractional precision).
import { trim } from '../../_rs.mjs';

const U128_MAX = (1n << 128n) - 1n;

// upstream: decimal_str.rs::split → [intPart, fracPart]
function split(s) {
  const t = trim(s);
  if (t === '') throw new Error('decimal string is empty');
  const dot = t.indexOf('.');
  let intPart = dot < 0 ? t : t.slice(0, dot);
  const fracPart = dot < 0 ? '' : t.slice(dot + 1);
  if (intPart === '') intPart = '0';
  if (!/^[0-9]*$/.test(intPart)) throw new Error(`invalid decimal (non-digit in integer part): "${t}"`);
  if (!/^[0-9]*$/.test(fracPart)) throw new Error(`invalid decimal (non-digit in fractional part): "${t}"`);
  return [intPart, fracPart];
}

// upstream: decimal_str.rs::align → [a, b, prec] (BigInt fixed-point)
function align(a, b) {
  const [ai, af] = split(a);
  const [bi, bf] = split(b);
  const prec = Math.max(af.length, bf.length);
  const toU128 = (i, f, original) => {
    const stripped = `${i}${f.padEnd(prec, '0')}`.replace(/^0+/, '');
    const v = BigInt(stripped === '' ? '0' : stripped);
    if (v > U128_MAX) throw new Error(`decimal exceeds u128 range: "${original}": number too large to fit in target type`);
    return v;
  };
  return [toU128(ai, af, a), toU128(bi, bf, b), prec];
}

// upstream: decimal_str.rs::format_at
export function formatAt(value, prec) {
  if (prec === 0) return value.toString();
  const scale = 10n ** BigInt(prec);
  const intPart = value / scale, fracPart = value % scale;
  if (fracPart === 0n) return intPart.toString();
  return `${intPart}.${fracPart.toString().padStart(prec, '0').replace(/0+$/, '')}`;
}

// upstream: decimal_str.rs::cmp → -1 (Less) | 0 (Equal) | 1 (Greater)
export function cmp(a, b) {
  const [av, bv] = align(a, b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

// upstream: decimal_str.rs::sub (requires a >= b)
export function sub(a, b) {
  const [av, bv, prec] = align(a, b);
  if (av < bv) throw new Error(`decimal subtraction underflow: "${a}" - "${b}"`);
  return formatAt(av - bv, prec);
}

// upstream: decimal_str.rs::add
export function add(a, b) {
  const [av, bv, prec] = align(a, b);
  const s = av + bv;
  if (s > U128_MAX) throw new Error(`decimal addition overflow: "${a}" + "${b}"`);
  return formatAt(s, prec);
}
