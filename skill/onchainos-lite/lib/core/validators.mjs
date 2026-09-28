// Generic CLI input validators (numeric / id format) — upstream validators.rs.
// Every function throws Error with upstream's exact message (anyhow bail!).
import { trim, allAsciiDigits, parseF64 } from './_rust-str.mjs';

const I64_MAX = 9223372036854775807n;

// upstream: validators.rs::validate_amount — raw positive integer, no leading zeros.
export function validateAmount(amount) {
  const a = trim(amount);
  if (a === '') throw new Error('--amount must not be empty');
  if (a.includes('.')) throw new Error('--amount must be a whole number in minimal units (no decimals)');
  if (!allAsciiDigits(a)) {
    throw new Error(`--amount must be a whole number in minimal units, got "${a}". Infinity, NaN, negative numbers and non-numeric values are not accepted.`);
  }
  if (/^0*$/.test(a)) throw new Error('--amount must be greater than zero');
  if (a.startsWith('0')) throw new Error(`--amount must not have leading zeros, got "${a}"`);
}

// upstream: validators.rs::validate_slippage — percent in (0, 100], trailing '%' accepted.
export function validateSlippage(slippage) {
  const s = trim(trim(slippage).replace(/%+$/, ''));
  const val = parseF64(s);
  if (val === undefined) {
    throw new Error(`--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "${s}"`);
  }
  if (!Number.isFinite(val)) {
    throw new Error(`--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "${s}"`);
  }
  if (val <= 0.0 || val > 100.0) throw new Error(`--slippage must be greater than 0 and at most 100, got "${s}"`);
}

// upstream: validators.rs::validate_slippage_zero_to_one — decimal in (0, 1], '%' rejected.
export function validateSlippageZeroToOne(slippage) {
  const s = trim(slippage);
  if (s.endsWith('%')) {
    throw new Error(`--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got "${s}"`);
  }
  const val = parseF64(s);
  if (val === undefined) {
    throw new Error(`--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got "${s}"`);
  }
  if (!Number.isFinite(val)) {
    throw new Error(`--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got "${s}"`);
  }
  if (val <= 0.0 || val > 1.0) {
    throw new Error(`--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got "${s}"`);
  }
}

// upstream: validators.rs::validate_non_negative_integer — "0" allowed, no leading zeros.
export function validateNonNegativeInteger(value, label) {
  const v = trim(value);
  if (v === '') throw new Error(`--${label} must not be empty`);
  if (!allAsciiDigits(v)) throw new Error(`--${label} must be a non-negative integer, got "${v}"`);
  if (v.length > 1 && v.startsWith('0')) throw new Error(`--${label} must not have leading zeros, got "${v}"`);
}

// upstream: validators.rs::validate_order_id_numeric — digits that fit a Java Long (i64).
export function validateOrderIdNumeric(id, label) {
  const t = trim(id);
  if (t === '') throw new Error(`--${label} must not be empty`);
  if (!allAsciiDigits(t)) throw new Error(`--${label} must be a numeric order id, got \`${t}\``);
  if (BigInt(t) > I64_MAX) throw new Error(`--${label} \`${t}\` does not fit in BE Long range (max ${I64_MAX})`);
}

// upstream: validators.rs::readable_to_minimal_str — human decimal → raw integer string
// (string arithmetic, no floats). `decimal` is the token's u32 decimals.
export function readableToMinimalStr(amount, decimal) {
  const a = trim(amount);
  const dot = a.indexOf('.');
  const [intRaw, frac] = dot >= 0 ? [a.slice(0, dot), a.slice(dot + 1)] : [a, ''];
  const integer = intRaw === '' ? '0' : intRaw;
  if (!allAsciiDigits(integer)) throw new Error(`--readable-amount must be a positive number, got "${a}"`);
  if (!allAsciiDigits(frac)) throw new Error(`--readable-amount must be a positive number, got "${a}"`);
  const precision = Number(decimal);
  let fracPadded;
  if (frac.length >= precision) {
    if (/[^0]/.test(frac.slice(precision))) {
      throw new Error(`--readable-amount "${a}" has more decimal places than this token supports (${decimal} decimals)`);
    }
    fracPadded = frac.slice(0, precision);
  } else {
    fracPadded = frac.padEnd(precision, '0');
  }
  const stripped = (integer + fracPadded).replace(/^0+/, '');
  const result = stripped === '' ? '0' : stripped;
  if (result === '0') {
    throw new Error(`--readable-amount ${a} is too small for this token (${decimal} decimals); results in zero minimal units`);
  }
  return result;
}
