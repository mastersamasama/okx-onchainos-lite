// Ed25519 / X25519 from raw 32-byte keys using node:crypto (DER wrapping only).
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, diffieHellman, randomBytes } from 'node:crypto';

const PKCS8 = { ed25519: '302e020100300506032b657004220420', x25519: '302e020100300506032b656e04220420' };
const SPKI = { ed25519: '302a300506032b6570032100', x25519: '302a300506032b656e032100' };

const priv = (kind, raw) => {
  const b = Buffer.from(raw);
  if (b.length !== 32) throw new Error(`session key must be 32 bytes, got ${b.length}`);
  return createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8[kind], 'hex'), b]), format: 'der', type: 'pkcs8' });
};
const pub = (kind, raw) => createPublicKey({ key: Buffer.concat([Buffer.from(SPKI[kind], 'hex'), Buffer.from(raw)]), format: 'der', type: 'spki' });
const rawPub = (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);

export const ed25519 = {
  sign: (seed, msg) => nodeSign(null, Buffer.from(msg), priv('ed25519', seed)),
  verify: (pubRaw, msg, sig) => nodeVerify(null, Buffer.from(msg), pub('ed25519', pubRaw), Buffer.from(sig)),
  publicKey: (seed) => rawPub(priv('ed25519', seed)),
};

export const x25519 = {
  publicKey: (secret) => rawPub(priv('x25519', secret)),
  dh: (secret, peerPub) => diffieHellman({ privateKey: priv('x25519', secret), publicKey: pub('x25519', peerPub) }),
  // Upstream generate_x25519_session_keypair(): (session_private_key_b64, temp_pub_key_b64)
  generate() {
    const secret = randomBytes(32);
    return { secret, publicKey: x25519.publicKey(secret) };
  },
};
