// PRIVATE fallback for the upstream crypto.rs primitives the payment flows sign with (no core
// module mirrors crypto.rs yet — requested for promotion to lib/core/crypto.mjs). Error texts
// follow crypto.rs (`{:#}` chains via context()).
import { open as hpkeOpen } from '../crypto/hpke.mjs';
import { ed25519, x25519 } from '../crypto/curve25519.mjs';
import { keccak256 } from '../crypto/keccak.mjs';
import * as secp from '../crypto/secp256k1.mjs';
import { signingHash } from '../crypto/eip712.mjs';
import { context } from '../core/errors.mjs';
import { B64, hexDecode } from './_rs.mjs';

const HPKE_INFO = Buffer.from('okx-tee-sign');

// upstream: crypto.rs::hpke_decrypt_session_sk → 32-byte Ed25519 seed
export function hpkeDecryptSessionSk(encryptedB64, sessionKeyB64) {
  let encrypted, sk;
  try { encrypted = B64.STANDARD(encryptedB64); } catch (e) { throw context('encrypted_session_sk is not valid base64', e); }
  try { sk = B64.STANDARD(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  if (encrypted.length <= 32) throw new Error(`encrypted_session_sk too short: ${encrypted.length} bytes (need > 32)`);
  const enc = encrypted.subarray(0, 32), ciphertext = encrypted.subarray(32);
  let dh;
  try { dh = x25519.dh(sk, enc); } catch { dh = Buffer.alloc(32); }
  if (dh.every((b) => b === 0)) throw new Error('HPKE decryption failed: Input value is invalid');
  let pt;
  try { pt = hpkeOpen({ skR: sk, enc, ciphertext, info: HPKE_INFO }); } catch { throw new Error('HPKE decryption failed: Failed to open ciphertext'); }
  if (pt.length !== 32) throw new Error(`decrypted signing seed must be 32 bytes, got ${pt.length}`);
  return Buffer.from(pt);
}

// upstream: crypto.rs::ed25519_sign → 64-byte signature
export function ed25519Sign(seed, message) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error(`session key must be 32 bytes, got ${s.length}`);
  return ed25519.sign(s, Buffer.from(message));
}

// upstream: crypto.rs::ed25519_sign_hex — hex (one optional 0x) → base64 signature; "" → "".
export function ed25519SignHex(hexHash, sessionKeyB64) {
  const clean = hexHash.startsWith('0x') ? hexHash.slice(2) : hexHash;
  if (clean === '') return '';
  let bytes, sk;
  try { bytes = hexDecode(clean); } catch (e) { throw context('failed to decode hex message', e); }
  try { sk = B64.STANDARD(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  return ed25519.sign(sk, bytes).toString('base64');
}

// upstream: crypto.rs::ed25519_sign_eip191 — keccak256("\x19Ethereum Signed Message:\n"+len+data)
export function ed25519SignEip191(msg, signingSeed, encoding) {
  if (msg === '') return '';
  let data;
  if (encoding === 'hex') {
    const clean = msg.startsWith('0x') ? msg.slice(2) : msg;
    try { data = hexDecode(clean); } catch (e) { throw context('msg is not valid hex', e); }
  } else if (encoding === 'utf8') data = Buffer.from(msg, 'utf8');
  else throw new Error(`unsupported encoding for eip191: ${encoding}, expected "hex" or "utf8"`);
  const hash = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${data.length}`), data]));
  return ed25519Sign(signingSeed, hash).toString('base64');
}

// upstream: crypto.rs::secp256k1_sign → 65 bytes r||s||v, v ∈ {0,1}
export function secp256k1Sign(seed, message) {
  const s = Buffer.from(seed), m = Buffer.from(message);
  if (s.length !== 32) throw new Error(`private key must be 32 bytes, got ${s.length}`);
  if (m.length !== 32) throw new Error(`message hash must be 32 bytes, got ${m.length}`);
  const d = BigInt('0x' + s.toString('hex'));
  if (d === 0n || d >= secp.N) throw new Error('invalid secp256k1 private key: signature error');
  return secp.sign(s, m);
}

// alloy PrivateKeySigner::from_slice + `format!("{:#x}", signer.address())` (lowercase).
export function privateKeyAddress(pk) {
  const d = BigInt('0x' + Buffer.from(pk).toString('hex'));
  if (d === 0n || d >= secp.N) throw new Error('signature error');
  return secp.address(pk);
}

// crypto.rs `sol! TransferWithAuthorization` EIP-712 types.
export const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
];

// upstream: crypto.rs::eip3009_sign — auth {from,to,value,validAfter,validBefore (BigInt/str), nonce (hex)},
// domain {name, version, chainId, verifyingContract} → base64 65-byte signature with v ∈ {27,28}.
export function eip3009Sign(auth, domain, privateKey) {
  const hash = signingHash({
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: 'TransferWithAuthorization',
    domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    message: auth,
  });
  const sig = secp256k1Sign(privateKey, hash);
  sig[64] += 27;
  return sig.toString('base64');
}
