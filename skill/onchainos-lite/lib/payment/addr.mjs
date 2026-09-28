// Address validation + recipient policy for the payment family — upstream commands/payment/addr.rs.
import { keccak256 } from '../crypto/keccak.mjs';

// upstream: addr.rs::is_valid_evm_address — 0x + 40 hex; mixed-case letters must satisfy EIP-55.
export function isValidEvmAddress(addr) {
  const a = String(addr);
  if (!a.startsWith('0x') || Buffer.byteLength(a) !== 42) return false;
  const hex = a.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return false;
  const lower = /[a-f]/.test(hex), upper = /[A-F]/.test(hex);
  if (!(lower && upper)) return true;
  return eip55ChecksumMatches(hex);
}

// upstream: addr.rs::require_evm_address
export function requireEvmAddress(addr, label) {
  if (!isValidEvmAddress(addr)) throw new Error(`${label} is not a valid EVM address: ${addr}`);
}

// upstream: addr.rs::eip55_checksum_matches (private)
function eip55ChecksumMatches(hex) {
  const hash = keccak256(Buffer.from(hex.toLowerCase(), 'utf8'));
  for (let i = 0; i < hex.length; i++) {
    const ch = hex[i];
    if (!/[a-zA-Z]/.test(ch)) continue;
    const nibble = (hash[i >> 1] >> (4 * (1 - (i % 2)))) & 0x0f;
    if ((nibble >= 8) !== (ch >= 'A' && ch <= 'Z')) return false;
  }
  return true;
}

// upstream: addr.rs::XKO_PREFIX
export const XKO_PREFIX = 'XKO';
const XLAYER_CHAIN_ID = 196;

// upstream: addr.rs::parse_recipient_addr → [canonical0x, display]
export function parseRecipientAddr(input, chainId) {
  const s = String(input);
  if (s.startsWith(XKO_PREFIX)) {
    if (String(chainId) !== String(XLAYER_CHAIN_ID)) {
      throw new Error(`XKO-prefixed addresses are only supported on X Layer (chainId ${XLAYER_CHAIN_ID}), got ${chainId}`);
    }
    const canonical = `0x${s.slice(XKO_PREFIX.length)}`;
    if (!isValidEvmAddress(canonical)) throw new Error(`XKO address body must be 40 hex chars (EIP-55 checksummed if mixed case): ${s}`);
    return [canonical, s];
  }
  if (isValidEvmAddress(s)) return [s, s];
  throw new Error(`not a valid EVM address (expected \`0x...\` or XLayer \`XKO...\`): ${s}`);
}

// upstream: addr.rs::require_recipient_format
export function requireRecipientFormat(input, label) {
  const s = String(input);
  if (s.startsWith(XKO_PREFIX)) {
    if (!isValidEvmAddress(`0x${s.slice(XKO_PREFIX.length)}`)) throw new Error(`${label}: XKO address body must be 40 hex chars (EIP-55 if mixed case): ${s}`);
    return;
  }
  if (isValidEvmAddress(s)) return;
  throw new Error(`${label} is not a valid EVM address (expected \`0x...\` or XLayer \`XKO...\`): ${s}`);
}
