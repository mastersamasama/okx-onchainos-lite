// Signing & key-exchange primitives shared by the wallet, payment and agent flows — upstream
// crypto.rs. Error texts follow crypto.rs (`{:#}` chains via context()).
import { open as hpkeOpen } from '../crypto/hpke.mjs';
import { ed25519, x25519 } from '../crypto/curve25519.mjs';
import { keccak256 } from '../crypto/keccak.mjs';
import * as secp from '../crypto/secp256k1.mjs';
import { signingHash } from '../crypto/eip712.mjs';
import { context } from './errors.mjs';
import { B64, hexDecode, bs58Decode } from './rs/codec.mjs';

const HPKE_INFO = Buffer.from('okx-tee-sign');
const ENC_SIZE = 32;

// upstream: crypto.rs::hpke_decrypt_session_sk → 32-byte Ed25519 seed (Buffer)
export function hpkeDecryptSessionSk(encryptedB64, sessionKeyB64) {
  let encrypted, sk;
  try { encrypted = B64.STANDARD.decode(encryptedB64); } catch (e) { throw context('encrypted_session_sk is not valid base64', e); }
  try { sk = B64.STANDARD.decode(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  if (encrypted.length <= ENC_SIZE) throw new Error(`encrypted_session_sk too short: ${encrypted.length} bytes (need > ${ENC_SIZE})`);
  const enc = encrypted.subarray(0, ENC_SIZE), ciphertext = encrypted.subarray(ENC_SIZE);
  // hpke 0.12 decap: a non-contributory (all-zero) X25519 shared secret — a small-order encapped
  // key — is DhError → HpkeError::DecapError ("Decapsulation failed").
  let dh;
  try { dh = x25519.dh(sk, enc); } catch { dh = Buffer.alloc(32); }
  if (dh.every((b) => b === 0)) throw new Error('HPKE decryption failed: Decapsulation failed');
  let plaintext;
  try { plaintext = hpkeOpen({ skR: sk, enc, ciphertext, info: HPKE_INFO }); } catch { throw new Error('HPKE decryption failed: Failed to open ciphertext'); }
  if (plaintext.length !== 32) throw new Error(`decrypted signing seed must be 32 bytes, got ${plaintext.length}`);
  return Buffer.from(plaintext);
}

// upstream: crypto.rs::ed25519_sign → 64-byte signature (Buffer)
export function ed25519Sign(seed, message) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error(`session key must be 32 bytes, got ${s.length}`);
  return ed25519.sign(s, Buffer.from(message));
}

// upstream: crypto.rs::ed25519_sign_encoded → base64 signature ("" for an empty message)
export function ed25519SignEncoded(msg, sessionKeyB64, encoding) {
  let bytes;
  switch (encoding) {
    case 'hex': {
      const clean = msg.startsWith('0x') ? msg.slice(2) : msg;
      if (clean === '') return '';
      try { bytes = hexDecode(clean); } catch (e) { throw context('failed to decode hex message', e); }
      break;
    }
    case 'base64':
      if (msg === '') return '';
      try { bytes = B64.STANDARD.decode(msg); } catch (e) { throw context('failed to decode base64 message', e); }
      break;
    case 'base58':
      if (msg === '') return '';
      try { bytes = bs58Decode(msg); } catch (e) { throw context('failed to decode base58 message', e); }
      break;
    default:
      throw new Error(`unsupported encoding: ${encoding}, expected hex/base64/base58`);
  }
  let sk;
  try { sk = B64.STANDARD.decode(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  return B64.STANDARD.encode(ed25519.sign(sk, bytes));
}

// upstream: crypto.rs::ed25519_sign_hex
export const ed25519SignHex = (hexHash, sessionKeyB64) => ed25519SignEncoded(hexHash, sessionKeyB64, 'hex');

// upstream: crypto.rs::secp256k1_sign → 65 bytes r || s || v, v ∈ {0, 1}
export function secp256k1Sign(seed, message) {
  const s = Buffer.from(seed), m = Buffer.from(message);
  if (s.length !== 32) throw new Error(`private key must be 32 bytes, got ${s.length}`);
  if (m.length !== 32) throw new Error(`message hash must be 32 bytes, got ${m.length}`);
  const d = BigInt('0x' + s.toString('hex'));
  if (d === 0n || d >= secp.N) throw new Error('invalid secp256k1 private key: signature error');
  return secp.sign(s, m);
}

// upstream: crypto.rs `sol! TransferWithAuthorization` EIP-712 types
export const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
];

// upstream: crypto.rs::eip3009_sign — auth {from, to, value, validAfter, validBefore (BigInt / str),
// nonce (hex)}, domain {name, version, chainId, verifyingContract} → base64 65-byte signature with
// v ∈ {27, 28}.
export function eip3009Sign(auth, domain, privateKey) {
  const hash = signingHash({
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: 'TransferWithAuthorization',
    domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    message: auth,
  });
  const sig = secp256k1Sign(privateKey, hash);
  sig[64] += 27;
  return B64.STANDARD.encode(sig);
}

// upstream: crypto.rs::ed25519_sign_eip191 — keccak256("\x19Ethereum Signed Message:\n" + len + data)
// signed with Ed25519, base64; "" for an empty message.
export function ed25519SignEip191(msg, signingSeed, encoding) {
  if (msg === '') return '';
  let data;
  switch (encoding) {
    case 'hex': {
      const clean = msg.startsWith('0x') ? msg.slice(2) : msg;
      try { data = hexDecode(clean); } catch (e) { throw context('msg is not valid hex', e); }
      break;
    }
    case 'utf8':
      data = Buffer.from(msg, 'utf8');
      break;
    default:
      throw new Error(`unsupported encoding for eip191: ${encoding}, expected "hex" or "utf8"`);
  }
  const ethMsg = Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${data.length}`, 'utf8'), data]);
  return B64.STANDARD.encode(ed25519Sign(signingSeed, keccak256(ethMsg)));
}
