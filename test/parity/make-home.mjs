#!/usr/bin/env node
// Fabricates logged-in state directories ("homes") that BOTH the upstream onchainos binary
// (run with ONCHAINOS_CREDENTIAL_STORE=file, as the parity runner does) and onchainos-lite
// accept as a real login. Everything is deterministic except the keyring.enc salt/nonce.
//
//   node test/parity/make-home.mjs            # (re)generate every home under test/parity/homes/
//   node test/parity/make-home.mjs --print    # print the identities (keys, addresses, tokens)
//
// What a home contains (same files a real `wallet login --phase poll` writes):
//   machine-identity  64 hex chars — the file-keyring password (upstream file_keyring.rs)
//   keyring.enc       salt‖nonce‖AES-256-GCM(scrypt(identity)) of {access_token, refresh_token, session_key}
//   session.json      {saTeeId, sessionCert, encryptedSessionSk, sessionKeyExpireAt, deviceId}
//   wallets.json      {email, isNew, projectId, selectedAccountId, accountsMap, accounts, loginType}
// The session key is a real X25519 secret and encryptedSessionSk is a real HPKE (base mode,
// X25519/HKDF-SHA256/AES-256-GCM, info "okx-tee-sign") seal of a known Ed25519 signing seed to
// it, so every signing flow (unsignedInfo → ed25519 → broadcast) works against fixtures.
// See test/parity/homes/README.md for the catalogue.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptBlob } from '../../skill/onchainos-lite/lib/core/keyring.mjs';
import { seal } from '../../skill/onchainos-lite/lib/crypto/hpke.mjs';
import { x25519, ed25519 } from '../../skill/onchainos-lite/lib/crypto/curve25519.mjs';
import * as secp from '../../skill/onchainos-lite/lib/crypto/secp256k1.mjs';
import { base58Encode } from '../../skill/onchainos-lite/lib/crypto/encoding.mjs';
import { stringify, struct } from '../../skill/onchainos-lite/lib/core/json.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOMES = join(HERE, 'homes');

// ── deterministic material ──────────────────────────────────────────
const det = (label) => createHash('sha256').update(`onchainos-lite parity :: ${label}`).digest();
const FAR_FUTURE = 4102444800;          // 2100-01-01T00:00:00Z
const PAST = 1700000000;                // 2023-11-14 — expired
export const MACHINE_IDENTITY = det('machine-identity').toString('hex');
export const DEVICE_ID = det('device-id').toString('hex');
export const SESSION_KEY = det('x25519-session-key');                 // X25519 secret (raw 32 bytes)
export const SIGNING_SEED = det('ed25519-signing-seed');              // what the TEE would hand out
export const SESSION_CERT = 'parity-session-cert-' + det('session-cert').toString('hex').slice(0, 32);
export const SA_TEE_ID = 'parity-sa-tee-0001';
export const PROJECT_ID = 'parity-project-0001';
export const EMAIL = 'parity@example.com';
// in-progress social login (as left behind by `wallet login --phase init`)
export const PENDING_AUTH_SESSION_ID = '7c1f0e2a-6b1d-4c3e-9a55-0d2f3b4c5d6e';
export const OTHER_PENDING_SESSION_ID = '0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f';

const b64url = (b) => Buffer.from(b).toString('base64url');
export function jwt(exp, sub = 'parity-user') {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub, iss: 'onchainos-lite-parity', exp }))}.${b64url(det(`jwt-sig-${sub}-${exp}`))}`;
}
export const TOKENS = {
  access: jwt(FAR_FUTURE, 'parity-access'),
  refresh: jwt(FAR_FUTURE, 'parity-refresh'),
  accessExpired: jwt(PAST, 'parity-access'),
  refreshExpired: jwt(PAST, 'parity-refresh'),
  // what fixtures/wallet-common.json auth/refresh hands back
  accessRotated: jwt(FAR_FUTURE, 'parity-access-rotated'),
  refreshRotated: jwt(FAR_FUTURE, 'parity-refresh-rotated'),
};

// HPKE seal with a deterministic ephemeral key → reproducible encryptedSessionSk.
export function encryptedSessionSk() {
  const { enc, ciphertext } = seal({ pkR: x25519.publicKey(SESSION_KEY), plaintext: SIGNING_SEED, info: Buffer.from('okx-tee-sign'), ephemeral: det('hpke-ephemeral') });
  return Buffer.concat([enc, ciphertext]).toString('base64');
}

// ── addresses ───────────────────────────────────────────────────────
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function convertBits(data, from, to) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & ((1 << to) - 1)); }
  }
  if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
// BIP-350 bech32m segwit v1 (taproot) address from a 32-byte x-only key.
function taprootAddress(xonly, hrp = 'bc') {
  const data = [1, ...convertBits(xonly, 8, 5)];
  const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = bech32Polymod([...hrpExp, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => BECH32[d]).join('');
}

export function accountAddresses(n) {
  const evmKey = det(`account-${n}-evm-key`);
  const evm = secp.address(evmKey);                                       // lowercase 0x…
  const sol = base58Encode(ed25519.publicKey(det(`account-${n}-sol-seed`)));
  const btc = taprootAddress(secp.publicKey(det(`account-${n}-btc-key`), true).subarray(1));
  const sui = '0x' + det(`account-${n}-sui`).toString('hex');
  return { evm, sol, btc, sui };
}

export const ACCOUNTS = [
  { accountId: 'parity-account-0001', accountName: 'Account 1', isDefault: true, n: 1, chains: 'full' },
  { accountId: 'parity-account-0002', accountName: 'Account 2', isDefault: false, n: 2, chains: 'full' },
  { accountId: 'parity-account-0003', accountName: 'Account 3', isDefault: false, n: 3, chains: 'evm-sol' },
];

// Mirrors the shape the backend returns from account/address/list (chainName = backend short
// name from chain/support/list, EVM chains share one address, BTC is taproot).
export function addressList(acct) {
  const a = accountAddresses(acct.n);
  const evm = (chainIndex, chainName) => ({ address: a.evm, chainIndex, chainName, addressType: 'eoa', chainPath: "m/44'/60'/0'/0/0" });
  const list = [
    evm('1', 'eth'), evm('56', 'bnb'), evm('196', 'okb'), evm('8453', 'base_eth'), evm('42161', 'arb_eth'),
    { address: a.sol, chainIndex: '501', chainName: 'sol', addressType: 'eoa', chainPath: "m/44'/501'/0'/0'" },
  ];
  if (acct.chains === 'full') {
    list.push({ address: a.btc, chainIndex: '0', chainName: 'btc', addressType: 'taproot', chainPath: "m/86'/0'/0'/0/0" });
    list.push({ address: a.sui, chainIndex: '784', chainName: 'sui', addressType: 'eoa', chainPath: "m/44'/784'/0'/0'/0'" });
  }
  return list;
}

// chain/support/list data served by fixtures/wallet-common.json (single source for both).
export function commonChainList() {
  const entries = JSON.parse(readFileSync(join(HERE, 'fixtures', 'wallet-common.json'), 'utf8'));
  return entries.find((e) => e.path === '/priapi/v5/wallet/agentic/chain/support/list').response.body.data;
}

// ── file builders (upstream struct field order) ─────────────────────
const addressInfo = (accountId, x) => struct({ accountId, address: x.address, chainIndex: x.chainIndex, chainName: x.chainName, addressType: x.addressType, chainPath: x.chainPath });
function walletsJson({ selected = ACCOUNTS[0].accountId, accounts = ACCOUNTS, loginType = 'google', email = EMAIL } = {}) {
  const accountsMap = {};
  for (const acct of accounts) accountsMap[acct.accountId] = struct({ addressList: addressList(acct).map((x) => addressInfo(acct.accountId, x)) });
  return struct({
    email, isNew: false, projectId: PROJECT_ID, selectedAccountId: selected, accountsMap,
    accounts: accounts.map((a) => struct({ projectId: PROJECT_ID, accountId: a.accountId, accountName: a.accountName, isDefault: a.isDefault })),
    loginType,
  });
}
const sessionJson = ({ expireAt = FAR_FUTURE } = {}) => struct({
  saTeeId: SA_TEE_ID, sessionCert: SESSION_CERT, encryptedSessionSk: encryptedSessionSk(), sessionKeyExpireAt: String(expireAt), deviceId: DEVICE_ID,
});

export const HOME_VARIANTS = {
  // logged in, tokens valid until 2100, 3 accounts (1+2 full EVM/SOL/BTC/SUI, 3 EVM+SOL), Account 1 selected
  wallet: { access: TOKENS.access, refresh: TOKENS.refresh },
  // access token expired, refresh token valid → first authed command POSTs auth/refresh
  'wallet-expired': { access: TOKENS.accessExpired, refresh: TOKENS.refresh },
  // refresh token expired → "Session expired…" on stderr + "session expired, please login again…"
  'wallet-refresh-expired': { access: TOKENS.accessExpired, refresh: TOKENS.refreshExpired },
  // session key expired (sessionKeyExpireAt in the past) → "session expired, please login again…"
  'wallet-session-expired': { access: TOKENS.access, refresh: TOKENS.refresh, session: { expireAt: PAST } },
  // wallets.json/session.json present but the keyring is empty (e.g. credentials wiped)
  'wallet-no-keyring': { access: null, refresh: null },
  // logged in, Account 2 selected
  'wallet-account2': { access: TOKENS.access, refresh: TOKENS.refresh, wallets: { selected: ACCOUNTS[1].accountId } },
  // logged in plus every cache file logout touches (cache, balance, payment, subscriptions) and
  // the ones it keeps (chain_cache.json, config.json)
  'wallet-with-caches': { access: TOKENS.access, refresh: TOKENS.refresh, files: {
    'cache.json': struct({ swapTraceId: 'parity-swap-trace-0001' }),
    'balance_cache.json': struct({ batch_updated_at: PAST, accounts: { [ACCOUNTS[0].accountId]: struct({ updated_at: PAST, data: [], total_value_usd: '0.00' }) } }),
    'payment_cache.json': { endpoints: {}, updated_at: PAST },
    'subscriptions.json': { by_host: {} },
    'chain_cache.json': struct({ updated_at: PAST, chains: [] }),
    'config.json': { default_chain: '' },
  } },
  // logged in with a chain_cache.json that never goes stale (updated_at in 2100) holding the
  // chain/support/list data from fixtures/wallet-common.json → chain resolution needs no HTTP
  'wallet-chains': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'chain_cache.json': () => struct({ updated_at: FAR_FUTURE, chains: commonChainList() }) } },
  // fresh state dir after `wallet login --phase init` (pending session id + X25519 key in the keyring)
  'wallet-pending-login': { pendingOnly: true },
  // logged in as another user, with a pending login in progress (re-login / account switch)
  'wallet-login-pending': { access: TOKENS.access, refresh: TOKENS.refresh, pending: true, wallets: { email: 'previous.user@example.com' } },
  // pending login plus a second, older pending session key (poll --session-id <other> keeps the newest pointer)
  'wallet-pending-two': { pendingOnly: true, extraKeyring: { ['pending_session_key:' + OTHER_PENDING_SESSION_ID]: SESSION_KEY.toString('base64') } },
  // hand-edited / corrupted state files: serde_json::from_str errors carry byte positions and follow
  // document order; raw strings are written verbatim
  'wallet-bad-wallets-type': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'wallets.json': '{\n  "selectedAccountId": "parity-account-0001",\n  "isNew": "yes",\n  "email": 5\n}' } },
  'wallet-bad-wallets-null': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'wallets.json': 'null' } },
  'wallet-bad-wallets-dup': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'wallets.json': '{"email":"a","email":"b"}' } },
  'wallet-bad-wallets-missing': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'wallets.json': '{"selectedAccountId":"a","accountsMap":{"a":{"addressList":[{"chainIndex":"1"}]}}}' } },
  'wallet-seq-wallets': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'wallets.json': '[]' } },
  'wallet-bad-session': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'session.json': '{"sessionKeyExpireAt":' } },
  'wallet-bad-chain-cache': { access: TOKENS.access, refresh: TOKENS.refresh, files: { 'chain_cache.json': '{"updated_at": "1", "chains": []}' } },
};

function writeHome(name, v) {
  const dir = join(HOMES, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'machine-identity'), MACHINE_IDENTITY);
  const map = {};
  if (v.access) map.access_token = v.access;
  if (v.refresh) map.refresh_token = v.refresh;
  if (v.access || v.refresh) map.session_key = SESSION_KEY.toString('base64');
  if (v.pending || v.pendingOnly) {
    map.pending_auth_session_id = PENDING_AUTH_SESSION_ID;
    map['pending_session_key:' + PENDING_AUTH_SESSION_ID] = SESSION_KEY.toString('base64');
  }
  Object.assign(map, v.extraKeyring || {});
  if (Object.keys(map).length) writeFileSync(join(dir, 'keyring.enc'), encryptBlob(map, MACHINE_IDENTITY));
  if (v.pendingOnly) return dir;
  writeFileSync(join(dir, 'session.json'), stringify(sessionJson(v.session), true));
  writeFileSync(join(dir, 'wallets.json'), stringify(walletsJson(v.wallets), true));
  for (const [name, value] of Object.entries(v.files || {})) writeFileSync(join(dir, name), typeof value === 'string' ? value : stringify(typeof value === 'function' ? value() : value, true));
  return dir;
}

function main() {
  if (process.argv.includes('--print')) {
    const info = {
      machineIdentity: MACHINE_IDENTITY, deviceId: DEVICE_ID,
      sessionKeyB64: SESSION_KEY.toString('base64'), sessionPubB64: x25519.publicKey(SESSION_KEY).toString('base64'),
      signingSeedHex: SIGNING_SEED.toString('hex'), signingPubHex: ed25519.publicKey(SIGNING_SEED).toString('hex'),
      encryptedSessionSk: encryptedSessionSk(), sessionCert: SESSION_CERT, tokens: TOKENS,
      accounts: ACCOUNTS.map((a) => ({ ...a, addresses: accountAddresses(a.n) })),
    };
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  // --only a,b regenerates just those homes (others keep their keyring.enc bytes)
  const i = process.argv.indexOf('--only');
  const only = i > 0 ? new Set(process.argv[i + 1].split(',')) : null;
  for (const [name, v] of Object.entries(HOME_VARIANTS)) if (!only || only.has(name)) console.log('wrote', writeHome(name, v));
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
