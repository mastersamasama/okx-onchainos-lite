// TEE session material — upstream agentic_wallet/shared/common/session.rs.
import * as keyring from '../../../core/keyring.mjs';
import { context } from '../../../core/errors.mjs';
import { loadSession } from '../../store.mjs';
import { ERR_NOT_LOGGED_IN } from '../../common.mjs';
import { hpkeDecryptSessionSk } from '../_crypto.mjs';
import { hexDecode } from '../_rust.mjs';

// keyring_store::get("session_key").map_err(|_| not logged in) — missing key or unreadable store.
export function sessionKeyOrNotLoggedIn() {
  let v;
  try { v = keyring.get('session_key'); } catch { v = undefined; }
  if (typeof v !== 'string') throw new Error(ERR_NOT_LOGGED_IN);
  return v;
}

// upstream: session.rs::SigningSeed — the decrypted 32-byte Ed25519 seed.
export class SigningSeed {
  constructor(bytes) { this.bytes = Buffer.from(bytes); }

  // upstream: session.rs::SigningSeed::load — session.json + keyring session_key → HPKE open.
  static load() {
    const session = loadSession();
    if (!session) throw new Error(ERR_NOT_LOGGED_IN);
    const sessionKey = sessionKeyOrNotLoggedIn();
    return new SigningSeed(hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey));
  }

  // upstream: session.rs::SigningSeed::from_bytes (test helper)
  static fromBytes(seed) { return new SigningSeed(seed); }

  // upstream: session.rs::SigningSeed::as_bytes
  asBytes() { return this.bytes; }
}

// upstream: session.rs::session_cert
export function sessionCert() {
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  return session.sessionCert;
}

// upstream: session.rs::decode_hex — optional `0x`, `<field> is not valid hex: <hex error>`.
export function decodeHex(value, field) {
  try {
    return hexDecode(value.startsWith('0x') ? value.slice(2) : value);
  } catch (e) {
    throw context(`${field} is not valid hex`, e);
  }
}
