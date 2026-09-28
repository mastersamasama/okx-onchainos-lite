// Crypto parity: every vector in vectors.json was produced by test/oracle with the
// exact crates upstream onchainos uses (hpke, k256/alloy, ed25519-dalek, scrypt, aes-gcm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256 } from '../../skill/onchainos-lite/lib/crypto/keccak.mjs';
import * as secp from '../../skill/onchainos-lite/lib/crypto/secp256k1.mjs';
import { ed25519, x25519 } from '../../skill/onchainos-lite/lib/crypto/curve25519.mjs';
import { decryptSessionSk, seal, open } from '../../skill/onchainos-lite/lib/crypto/hpke.mjs';
import { signingHash } from '../../skill/onchainos-lite/lib/crypto/eip712.mjs';
import { base58Encode, base58Decode } from '../../skill/onchainos-lite/lib/crypto/encoding.mjs';
import { decryptBlob, encryptBlob } from '../../skill/onchainos-lite/lib/core/keyring.mjs';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const h = (s) => Buffer.from(s, 'hex');

test('keccak256 matches tiny-keccak', () => {
  for (const v of V.keccak256) assert.equal(keccak256(h(v.msg)).toString('hex'), v.hash);
});

test('secp256k1 matches alloy PrivateKeySigner (r||s||v, low-s, RFC6979)', () => {
  for (const v of V.secp256k1) {
    assert.equal(secp.sign(h(v.key), h(v.hash)).toString('hex'), v.sig);
    assert.equal(secp.address(h(v.key)), v.address.toLowerCase());
    assert.equal(secp.recoverAddress(h(v.hash), h(v.sig)), v.address.toLowerCase());
  }
});

test('ed25519 matches ed25519-dalek', () => {
  for (const v of V.ed25519) {
    assert.equal(ed25519.sign(h(v.seed), h(v.msg)).toString('hex'), v.sig);
    assert.equal(ed25519.publicKey(h(v.seed)).toString('hex'), v.pub);
  }
});

test('x25519 public keys match x25519-dalek', () => {
  for (const v of V.x25519) assert.equal(x25519.publicKey(h(v.secret)).toString('hex'), v.pub);
});

test('HPKE open matches hpke 0.12 (X25519/HKDF-SHA256/AES-256-GCM, info okx-tee-sign)', () => {
  for (const v of V.hpke) assert.equal(decryptSessionSk(v.encrypted_b64, v.session_key_b64).toString('hex'), v.seed);
});

test('HPKE seal/open roundtrip', () => {
  const { secret, publicKey } = x25519.generate();
  const pt = Buffer.from('roundtrip');
  const { enc, ciphertext } = seal({ pkR: publicKey, plaintext: pt, info: Buffer.from('x') });
  assert.deepEqual(open({ skR: secret, enc, ciphertext, info: Buffer.from('x') }), pt);
});

test('EIP-3009 typed data signature matches alloy eip712_signing_hash + sign', () => {
  const e = V.eip3009;
  const hash = signingHash({
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    domain: { name: e.name, version: e.version, chainId: e.chainId, verifyingContract: e.verifyingContract },
    message: { from: e.from, to: e.to, value: e.value, validAfter: e.validAfter, validBefore: e.validBefore, nonce: e.nonce },
  });
  assert.equal(hash.toString('hex'), e.hash);
  const sig = secp.sign(h(e.key), hash);
  sig[64] += 27;
  assert.equal(sig.toString('base64'), e.sig_b64);
});

test('base58 matches bs58', () => {
  for (const v of V.base58) {
    assert.equal(base58Encode(h(v.hex)), v.b58);
    assert.equal(base58Decode(v.b58).toString('hex'), v.hex);
  }
});

test('file keyring decrypts a blob written by upstream (scrypt + AES-256-GCM)', () => {
  const k = V.keyring;
  assert.equal(JSON.stringify(decryptBlob(h(k.file), k.identity)), JSON.stringify(JSON.parse(k.plaintext)));
  const again = encryptBlob(JSON.parse(k.plaintext), k.identity);
  assert.deepEqual(decryptBlob(again, k.identity), JSON.parse(k.plaintext));
});
