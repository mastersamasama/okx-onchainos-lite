// PRIVATE — alloy-primitives semantics the payment signing ports share: FixedBytes / Address / B256
// `FromStr` (const-hex, exact error texts), 32-byte ABI words and PrivateKeySigner addresses.
import * as secp from '../crypto/secp256k1.mjs';
import { charDebug } from '../core/rs/str.mjs';

const hexValue = (b) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1);
// const-hex `decode_to_array::<N>` (FixedBytes::from_str): odd length → strip one lowercase "0x"
// → exact length → first invalid char (index after the prefix).
export function fixedBytesFromStr(s, n) {
  let b = Buffer.from(String(s), 'utf8');
  if (b.length % 2 !== 0) throw new Error('odd number of digits');
  if (b[0] === 0x30 && b[1] === 0x78) b = b.subarray(2);
  if (b.length !== n * 2) throw new Error('invalid string length');
  const out = Buffer.alloc(n);
  for (let i = 0; i < b.length; i++) {
    const v = hexValue(b[i]);
    if (v < 0) throw new Error(`invalid character ${charDebug(String.fromCharCode(b[i]))} at position ${i}`);
    if (i % 2 === 0) out[i >> 1] = v << 4; else out[i >> 1] |= v;
  }
  return out;
}
// Address::from_str / B256::from_str
export const addressFromStr = (s) => fixedBytesFromStr(s, 20);
export const b256FromStr = (s) => fixedBytesFromStr(s, 32);
// `{:#x}` of bytes
export const hex0x = (buf) => '0x' + Buffer.from(buf).toString('hex');
// 32-byte big-endian ABI word of an integer / of a 20-byte address.
export const word = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex');
export const wordAddr = (addr20) => Buffer.concat([Buffer.alloc(12), Buffer.from(addr20)]);

// PrivateKeySigner::from_slice + `format!("{:#x}", signer.address())` (lowercase).
export function privateKeyAddress(pk) {
  const d = BigInt('0x' + Buffer.from(pk).toString('hex'));
  if (d === 0n || d >= secp.N) throw new Error('signature error');
  return secp.address(pk);
}
