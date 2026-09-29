// RFC 9180 HPKE, base mode, DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-GCM.
// Upstream uses AES-256-GCM with info "okx-tee-sign" (crypto.rs::hpke_decrypt_session_sk).
import { createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { x25519 } from './curve25519.mjs';

const i2osp = (n, len) => { const b = Buffer.alloc(len); b.writeUIntBE(n, 0, len); return b; };
const V1 = Buffer.from('HPKE-v1');
const KEM_ID = 0x0020, KDF_ID = 0x0001;
const AEAD = { 'aes-128-gcm': { id: 0x0001, nk: 16 }, 'aes-256-gcm': { id: 0x0002, nk: 32 } };

const extract = (salt, ikm) => createHmac('sha256', salt).update(ikm).digest();
function expand(prk, info, len) {
  const out = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < len; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, Buffer.concat([V1, suite, Buffer.from(label), ikm]));
const labeledExpand = (suite, prk, label, info, len) =>
  expand(prk, Buffer.concat([i2osp(len, 2), V1, suite, Buffer.from(label), info]), len);

const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)]);
function extractAndExpand(dh, kemContext) {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32);
}

function keySchedule(aeadName, sharedSecret, info) {
  const { id, nk } = AEAD[aeadName];
  const suite = Buffer.concat([Buffer.from('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(id, 2)]);
  const empty = Buffer.alloc(0);
  const ctx = Buffer.concat([Buffer.from([0]), labeledExtract(suite, empty, 'psk_id_hash', empty), labeledExtract(suite, empty, 'info_hash', Buffer.from(info))]);
  const secret = labeledExtract(suite, sharedSecret, 'secret', empty);
  return { key: labeledExpand(suite, secret, 'key', ctx, nk), nonce: labeledExpand(suite, secret, 'base_nonce', ctx, 12) };
}

// Single-shot open: payload = enc(32) || ciphertext||tag(16)
export function open({ skR, enc, ciphertext, info, aad = Buffer.alloc(0), aead = 'aes-256-gcm' }) {
  const pkR = x25519.publicKey(skR);
  const shared = extractAndExpand(x25519.dh(skR, enc), Buffer.concat([Buffer.from(enc), pkR]));
  const { key, nonce } = keySchedule(aead, shared, info);
  const d = createDecipheriv(aead, key, nonce);
  d.setAAD(aad);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
}

// Single-shot seal (used by tests and by flows that encrypt to a server key).
export function seal({ pkR, plaintext, info, aad = Buffer.alloc(0), aead = 'aes-256-gcm', ephemeral }) {
  const eph = ephemeral ?? x25519.generate().secret;
  const enc = x25519.publicKey(eph);
  const shared = extractAndExpand(x25519.dh(eph, pkR), Buffer.concat([enc, Buffer.from(pkR)]));
  const { key, nonce } = keySchedule(aead, shared, info);
  const c = createCipheriv(aead, key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { enc, ciphertext: ct };
}
