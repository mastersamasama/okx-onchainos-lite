// Minimal-unit / readable amount conversion — upstream agentic_wallet/shared/common/amount.rs.
import { readableToMinimalStr } from '../../../core/validators.mjs';
import { trim, allAsciiDigits } from '../../../core/rs/str.mjs';
import { get, isObject, asU64 } from '../../../core/rs/value.mjs';
import { parseU32 } from '../../../core/rs/num.mjs';

// upstream: amount.rs::parse_minimal → BigInt
export function parseMinimal(value, field, allowZero) {
  const v = trim(value);
  if (v === '' || !allAsciiDigits(v)) throw new Error(`${field} must be a non-negative integer in minimal units`);
  if (v.length > 1 && v.startsWith('0')) throw new Error(`${field} must not contain leading zeros`);
  const parsed = BigInt(v);
  if (!allowZero && parsed === 0n) throw new Error(`${field} must be greater than zero`);
  return parsed;
}

// upstream: amount.rs::validate_decimals
function validateDecimals(decimals) {
  if (decimals > 255) throw new Error('asset decimal exceeds the supported limit');
}

// upstream: amount.rs::readable_to_minimal → minimal-unit decimal string
export function readableToMinimal(value, decimals) {
  validateDecimals(decimals);
  const minimal = readableToMinimalStr(value, decimals);
  parseMinimal(minimal, 'readable-amount', false);
  return minimal;
}

// upstream: amount.rs::minimal_to_readable — trailing zeros (and a bare point) trimmed.
export function minimalToReadable(value, decimals) {
  validateDecimals(decimals);
  parseMinimal(value, 'amount', true);
  if (decimals === 0) return value;
  const padded = value.length <= decimals ? '0'.repeat(decimals + 1 - value.length) + value : value;
  const split = padded.length - decimals;
  const integer = padded.slice(0, split);
  const fraction = padded.slice(split).replace(/0+$/, '');
  return fraction === '' ? integer : `${integer}.${fraction}`;
}

// upstream: amount.rs::value_as_decimal_string — JSON string as-is, or a u64 as text.
export function valueAsDecimalString(value) {
  if (typeof value === 'string') return value;
  const n = asU64(value);
  return n === undefined ? undefined : n.toString();
}

// upstream: amount.rs::decimal_field — first *present* key of `decimal`, `decimals` → u32.
export function decimalField(value) {
  if (!isObject(value)) return undefined;
  const key = ['decimal', 'decimals'].find((k) => get(value, k) !== undefined);
  if (key === undefined) return undefined;
  const text = valueAsDecimalString(get(value, key));
  return text === undefined ? undefined : parseU32(text);
}
