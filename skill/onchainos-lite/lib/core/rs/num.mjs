// Rust number semantics: integer / float `FromStr`, ruint `U256` parsing, `as` casts, saturating
// u64 arithmetic and `format!("{:.N}", f64)`.
// Integers up to 64 bits use lite's JSON integer form (what core/json.mjs `parse` yields): a
// number inside ±(2^53 − 1), a BigInt beyond — relational operators compare both exactly.
// u128 / U256 values are always BigInt.

const RANGE = {
  i32: [-(2n ** 31n), 2n ** 31n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  u32: [0n, 2n ** 32n - 1n],
  u64: [0n, 2n ** 64n - 1n],
  u128: [0n, 2n ** 128n - 1n],
};
export const U64_MAX = RANGE.u64[1];

// Exact integer → JSON integer form.
export const jsonInt = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : BigInt(b));

// `<T as FromStr>::from_str` for integer T ('i32' | 'i64' | 'u32' | 'u64' | 'u128') → BigInt;
// throws the ParseIntError Display text. Optional '+' (or '-' for signed T), ASCII digits only.
export function intFromStr(src, type) {
  const s = String(src);
  const [min, max] = RANGE[type];
  if (s === '') throw new Error('cannot parse integer from empty string');
  const signed = s[0] === '+' || (s[0] === '-' && min < 0n);
  const digits = signed ? s.slice(1) : s;
  if (digits === '' || !/^[0-9]+$/.test(digits)) throw new Error('invalid digit found in string');
  const v = s[0] === '-' ? -BigInt(digits) : BigInt(digits);
  if (v > max) throw new Error('number too large to fit in target type');
  if (v < min) throw new Error('number too small to fit in target type');
  return v;
}
// `s.parse::<T>().ok()` → BigInt | undefined
export function intFromStrOk(src, type) {
  try { return intFromStr(src, type); } catch { return undefined; }
}
// `s.parse::<i32 | i64 | u32 | u64>().ok()` of a &str → JSON integer | undefined (a non-string is
// not a &str → undefined)
const jsonOk = (s, type) => { const v = typeof s === 'string' ? intFromStrOk(s, type) : undefined; return v === undefined ? undefined : jsonInt(v); };
export const parseI32 = (s) => jsonOk(s, 'i32');
export const parseI64 = (s) => jsonOk(s, 'i64');
export const parseU32 = (s) => jsonOk(s, 'u32');
export const parseU64 = (s) => jsonOk(s, 'u64');
// `s.parse::<u128>().ok()` of a &str → BigInt | undefined
export const parseU128 = (s) => (typeof s === 'string' ? intFromStrOk(s, 'u128') : undefined);

// `x as u32` — wrapping truncation of an integer.
export const toU32 = (v) => Number(BigInt.asUintN(32, BigInt(v)));
// u64::saturating_add → JSON integer
export function u64SaturatingAdd(a, b) {
  const v = BigInt(a) + BigInt(b);
  return jsonInt(v > U64_MAX ? U64_MAX : v);
}

// ── ruint 1.x Uint<256> ─────────────────────────────────────────────
export const U256_MAX = (1n << 256n) - 1n;

// Uint::from_str_radix (radix ≤ 36): '_' ignored; a letter digit ≥ radix fails at once in
// from_base_be; any other char stops the digit stream and fails after the digits seen so far.
export function u256FromStrRadix(src, radix, max = U256_MAX) {
  let value = 0n, bad;
  const r = BigInt(radix);
  for (const c of String(src)) {
    let d;
    if (c >= '0' && c <= '9') d = c.charCodeAt(0) - 48;
    else if (c >= 'a' && c <= 'z') d = c.charCodeAt(0) - 87;
    else if (c >= 'A' && c <= 'Z') d = c.charCodeAt(0) - 55;
    else if (c === '_') continue;
    else { bad = c; break; }
    if (d >= radix) throw new Error(`digit ${d} is out of range for base ${radix}`);
    value = value * r + BigInt(d);
    if (value > max) throw new Error('the value is too large to fit the target type');
  }
  if (bad !== undefined) throw new Error(`invalid digit: ${bad}`);
  return value;
}
// `impl FromStr for Uint` — 0x / 0o / 0b prefixes select the radix.
export function u256FromStr(src) {
  const s = String(src);
  const p = s.slice(0, 2);
  if (p === '0x' || p === '0X') return u256FromStrRadix(s.slice(2), 16);
  if (p === '0o' || p === '0O') return u256FromStrRadix(s.slice(2), 8);
  if (p === '0b' || p === '0B') return u256FromStrRadix(s.slice(2), 2);
  return u256FromStrRadix(s, 10);
}

// ── f64 ─────────────────────────────────────────────────────────────

// `<f64 as FromStr>::from_str` → number | undefined. No surrounding whitespace;
// [+-]? (inf | infinity | nan | (digits[.digits?] | .digits)([eE][+-]?digits)?), words ASCII-case-insensitive.
export function parseF64(s) {
  if (typeof s !== 'string') return undefined;
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(s);
  if (!m) return undefined;
  if (m[2]) return m[2].toLowerCase() === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity;
  return Number(m[1] + m[3]);
}

// `format!("{:.N}", x)` for an f64: core::fmt renders the exact binary value and rounds ties to
// even, so `format!("{:.2}", 0.125)` is "0.12" where `(0.125).toFixed(2)` gives "0.13".
export function formatFixed(x, digits) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  // value = mant · 2^exp; scaled = value · 10^digits = num / den
  const mant = expBits === 0 ? frac : frac | (1n << 52n);
  const exp = expBits === 0 ? -1074 : expBits - 1075;
  let num = mant * 10n ** BigInt(digits), den = 1n;
  if (exp >= 0) num <<= BigInt(exp); else den <<= BigInt(-exp);
  let q = num / den;
  const r = num % den;
  if (r * 2n > den || (r * 2n === den && (q & 1n) === 1n)) q += 1n;
  let s = q.toString().padStart(digits + 1, '0');
  if (digits > 0) s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  return (neg ? '-' : '') + s;
}
// `{:.1}` of a non-negative ratio numerator / denominator (exact; ties to even like core::fmt).
export function fixed1Ratio(numerator, denominator) {
  const n = BigInt(numerator) * 10n, d = BigInt(denominator);
  let q = n / d;
  const r = n % d;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) q += 1n;
  return `${q / 10n}.${q % 10n}`;
}
