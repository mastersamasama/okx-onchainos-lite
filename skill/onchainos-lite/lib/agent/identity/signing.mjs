// Signing helpers for identity mutations and the thin broadcast wrapper — upstream
// commands/agent_commerce/identity/signing.rs. Every material comes from the Agentic Wallet
// login state (wallets.json, session.json, keyring `session_key`) written by `wallet login`.
import * as keyring from '../../core/keyring.mjs';
import { loadWallets, loadSession } from '../../wallet/store.mjs';
import { broadcastUnsigned } from '../../wallet/broadcast.mjs';
import { hpkeDecryptSessionSk, ed25519Sign } from '../../wallet/shared/_crypto.mjs';
import { trim, eqIgnoreAsciiCase } from '../_rs.mjs';
import { XLAYER_CHAIN_INDEX, XLAYER_CHAIN_NAME } from './models.mjs';

const NO_XLAYER = 'no XLayer address found in current account';
const SESSION_EXPIRED = 'session expired, please login again: onchainos wallet login';

// upstream: signing.rs::is_xlayer_address (private)
const isXlayerAddress = (a) => a.chainIndex === XLAYER_CHAIN_INDEX || eqIgnoreAsciiCase(a.chainName, XLAYER_CHAIN_NAME);

// upstream: signing.rs::resolve_xlayer_signing_account(address) → [accountId, AddressInfo]
export function resolveXlayerSigningAccount(address) {
  const wallets = loadWallets();
  if (!wallets) throw new Error(NO_XLAYER);
  if (address !== undefined && address !== null && trim(address) !== '') {
    for (const [accountId, entry] of Object.entries(wallets.accountsMap)) {
      for (const a of entry.addressList) {
        if (isXlayerAddress(a) && eqIgnoreAsciiCase(a.address, trim(address))) return [accountId, a];
      }
    }
    throw new Error(NO_XLAYER);
  }
  return resolveCurrentXlayerAddress(wallets);
}

// upstream: signing.rs::resolve_current_xlayer_address (private)
function resolveCurrentXlayerAddress(wallets) {
  const accountId = trim(wallets.selectedAccountId);
  if (accountId === '') throw new Error(NO_XLAYER);
  const entry = Object.prototype.hasOwnProperty.call(wallets.accountsMap, accountId) ? wallets.accountsMap[accountId] : undefined;
  if (!entry) throw new Error(NO_XLAYER);
  const addr = entry.addressList.find(isXlayerAddress);
  if (!addr) throw new Error(NO_XLAYER);
  return [accountId, addr];
}

// keyring_store::get("session_key").map_err(|_| session expired)
function sessionKey() {
  let v;
  try { v = keyring.get('session_key'); } catch { v = undefined; }
  if (typeof v !== 'string') throw new Error(SESSION_EXPIRED);
  return v;
}

// upstream: signing.rs::load_signing_seed → 32-byte Buffer
export function loadSigningSeed() {
  const session = loadSession();
  if (!session) throw new Error(SESSION_EXPIRED);
  return hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey());
}

// upstream: signing.rs::load_session_cert
export function loadSessionCert() {
  const session = loadSession();
  if (!session) throw new Error(SESSION_EXPIRED);
  return session.sessionCert;
}

// upstream: signing.rs::load_agent_signing_session(address) →
//   { accountId, addrInfo, sessionCert, signingSeed } (AgentSigningSession; never serialised)
export function loadAgentSigningSession(address) {
  const [accountId, addrInfo] = resolveXlayerSigningAccount(address);
  const session = loadSession();
  if (!session) throw new Error(SESSION_EXPIRED);
  const signingSeed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey());
  return { accountId, addrInfo, sessionCert: session.sessionCert, signingSeed };
}

// upstream: signing.rs::sign_key_uuid — base64(Ed25519(seed, raw UTF-8 keyUuid))
export function signKeyUuid(keyUuid, signingSeed) {
  return ed25519Sign(signingSeed, Buffer.from(String(keyUuid), 'utf8')).toString('base64');
}

// upstream: signing.rs::build_erc8004_overlay(fields [[k, v]]) → {erc8004Msg: {…}} | null
export function buildErc8004Overlay(fields) {
  const inner = {};
  for (const [k, v] of fields) if (v !== '') inner[k] = v;
  if (!Object.keys(inner).length) return null;
  return { erc8004Msg: inner };
}

// upstream: signing.rs::sign_and_broadcast_agent_transaction → txHash
export function signAndBroadcastAgentTransaction(accessToken, unsigned, extraDataOverlay, session) {
  return broadcastUnsigned({
    accessToken, accountId: session.accountId, addrInfo: session.addrInfo, sessionCert: session.sessionCert,
    signingSeed: session.signingSeed, unsigned, isContractCall: true, mevProtection: false, force: false,
    extraDataOverlay, traceHeaders: null,
  });
}
