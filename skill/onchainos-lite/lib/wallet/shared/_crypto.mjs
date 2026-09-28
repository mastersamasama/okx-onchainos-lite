// PRIVATE fallback for upstream crypto.rs signing primitives used by every Agentic Wallet
// signing flow (no lib/core module mirrors crypto.rs yet — requested for promotion to
// lib/core/crypto.mjs). Error texts follow crypto.rs (`{:#}` chains via context()).
import { open as hpkeOpen } from '../../crypto/hpke.mjs';
import { ed25519, x25519 } from '../../crypto/curve25519.mjs';
import { keccak256 } from '../../crypto/keccak.mjs';
import { context } from '../../core/errors.mjs';
import { base64Decode, hexDecode, bs58Decode } from './_rust.mjs';

const HPKE_INFO = Buffer.from('okx-tee-sign');
const ENC_SIZE = 32;

// upstream: crypto.rs::hpke_decrypt_session_sk → 32-byte Ed25519 seed (Buffer)
export function hpkeDecryptSessionSk(encryptedB64, sessionKeyB64) {
  let encrypted, sk;
  try { encrypted = base64Decode(encryptedB64); } catch (e) { throw context('encrypted_session_sk is not valid base64', e); }
  try { sk = base64Decode(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  if (encrypted.length <= ENC_SIZE) throw new Error(`encrypted_session_sk too short: ${encrypted.length} bytes (need > ${ENC_SIZE})`);
  const enc = encrypted.subarray(0, ENC_SIZE), ciphertext = encrypted.subarray(ENC_SIZE);
  // hpke 0.12 decap: a non-contributory (all-zero) X25519 shared secret — a small-order encapped
  // key — is DhError → HpkeError::DecapError ("Decapsulation failed"; confirmed against upstream).
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
      try { bytes = base64Decode(msg); } catch (e) { throw context('failed to decode base64 message', e); }
      break;
    case 'base58':
      if (msg === '') return '';
      try { bytes = bs58Decode(msg); } catch (e) { throw context('failed to decode base58 message', e); }
      break;
    default:
      throw new Error(`unsupported encoding: ${encoding}, expected hex/base64/base58`);
  }
  let sk;
  try { sk = base64Decode(sessionKeyB64); } catch (e) { throw context('session_key is not valid base64', e); }
  if (sk.length !== 32) throw new Error(`session_key must be 32 bytes, got ${sk.length}`);
  return ed25519.sign(sk, bytes).toString('base64');
}

// upstream: crypto.rs::ed25519_sign_hex
export const ed25519SignHex = (hexHash, sessionKeyB64) => ed25519SignEncoded(hexHash, sessionKeyB64, 'hex');

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
  return ed25519Sign(signingSeed, keccak256(ethMsg)).toString('base64');
}
