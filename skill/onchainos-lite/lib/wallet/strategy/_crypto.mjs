// PRIVATE shim — the upstream crypto.rs primitives strategy needs. Their mirror location
// (lib/core/crypto.mjs) does not exist yet; the wallet foundation's faithful port is
// re-exported from this single place so a promotion only touches this file.
export { hpkeDecryptSessionSk, ed25519SignHex, ed25519SignEip191 } from '../shared/_crypto.mjs';
