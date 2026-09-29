// SUI address and Coin<T> identifier normalisation — upstream
// agentic_wallet/shared/adapters/sui/identifiers.rs.
import { trim, asciiLower } from '../../../../core/rs/str.mjs';

// upstream: identifiers.rs::NATIVE_COIN_TYPE
export const NATIVE_COIN_TYPE = '0x2::sui::SUI';

// upstream: identifiers.rs::normalize_address → `0x` + 64 lower-case hex digits
export function normalizeAddress(value) {
  const v = trim(value);
  const hex = v.startsWith('0x') || v.startsWith('0X') ? v.slice(2) : v;
  if (hex === '' || Buffer.byteLength(hex, 'utf8') > 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('SUI address must contain 1 to 64 hexadecimal characters');
  }
  return `0x${asciiLower(hex).padStart(64, '0')}`;
}

// upstream: identifiers.rs::same_address
export const sameAddress = (left, right) => normalizeAddress(left) === normalizeAddress(right);

const COIN_TYPE_ERR = 'SUI Coin Type must be a complete <package>::<module>::<type> value';

// upstream: identifiers.rs::normalize_coin_type → `0x<compact pkg>::<module>::<type>`
export function normalizeCoinType(value) {
  const v = trim(value);
  if (v === '' || /[ \t\n\x0c\r]/.test(v)) throw new Error(COIN_TYPE_ERR);
  const first = v.indexOf('::');
  const pkg = first < 0 ? v : v.slice(0, first);
  const rest = first < 0 ? undefined : v.slice(first + 2);
  let module = '', typeName = '';
  if (rest !== undefined) {
    const second = rest.indexOf('::');
    module = second < 0 ? rest : rest.slice(0, second);
    typeName = second < 0 ? '' : rest.slice(second + 2);
  }
  if (pkg === '' || !isValidIdentifier(module) || !isValidTypeName(typeName)) throw new Error(COIN_TYPE_ERR);
  const full = normalizeAddress(pkg);
  const compact = full.replace(/^(0x)+/, '').replace(/^0+/, '') || '0';
  return `0x${compact}::${module}::${typeName}`;
}

// upstream: identifiers.rs::same_coin_type
export const sameCoinType = (left, right) => normalizeCoinType(left) === normalizeCoinType(right);

// upstream: identifiers.rs::is_valid_identifier — [A-Za-z_][A-Za-z0-9_]*
const isValidIdentifier = (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);

// upstream: identifiers.rs::is_valid_type_name — [A-Za-z0-9:,_<>] with balanced angle brackets
function isValidTypeName(v) {
  if (v === '') return false;
  let depth = 0;
  for (const c of v) {
    if (c === '<') depth++;
    else if (c === '>') { depth--; if (depth < 0) return false; }
    else if (!/^[A-Za-z0-9:,_]$/.test(c)) return false;
  }
  return depth === 0;
}
