// Wallet state files under the state dir — upstream wallet_store.rs.
// Writers: serde_json::to_string_pretty(struct) (2-space, no trailing newline) → "<name>.tmp" → rename.
// Readers: missing → None/default; read error → "failed to read <name>"; parse error →
// "failed to parse <name>: <serde_json::from_str message, with `at line L column C`>" — decoded by
// the streaming serde emulation in core/serde.mjs. In-memory values are plain objects keyed by the
// JSON field names (camelCase for wallets/session/cache, snake_case for the two caches).
import { readFileSync, existsSync } from 'node:fs';
import { save, remove } from '../core/store.mjs';
import { homePath } from '../core/home.mjs';
import { context } from '../core/errors.mjs';
import { struct } from '../core/json.mjs';
import { fromStr, T, SerdeError } from '../core/serde.mjs';

// ── on-disk struct schemas (field order, required vs #[serde(default)]) ──

const ADDRESS_INFO = T.struct('AddressInfo', [['accountId', T.string, ''], ['address', T.string], ['chainIndex', T.string],
  ['chainName', T.string, ''], ['addressType', T.string, ''], ['chainPath', T.string, '']]);
const ACCOUNT_MAP_ENTRY = T.struct('AccountMapEntry', [['addressList', T.vec(ADDRESS_INFO)]]);
const ACCOUNT_INFO = T.struct('AccountInfo', [['projectId', T.string], ['accountId', T.string], ['accountName', T.string], ['isDefault', T.bool, false]]);
const WALLETS_JSON = T.struct('WalletsJson', [['email', T.string, ''], ['isNew', T.bool, false], ['projectId', T.string, ''],
  ['selectedAccountId', T.string, ''], ['accountsMap', T.map(ACCOUNT_MAP_ENTRY), () => ({})], ['accounts', T.vec(ACCOUNT_INFO), () => []],
  ['loginType', T.string, '']]);
const LOGIN_CACHE = T.struct('LoginCache', [['email', T.string], ['flowId', T.string]]);
const CACHE_JSON = T.struct('CacheJson', [['login', T.option(LOGIN_CACHE), null], ['swapTraceId', T.option(T.string), null]]);
const BALANCE_CACHE_ENTRY = T.struct('BalanceCacheEntry', [['updated_at', T.i64], ['data', T.value], ['total_value_usd', T.string]]);
const BALANCE_CACHE_JSON = T.struct('BalanceCacheJson', [['batch_updated_at', T.i64, 0], ['accounts', T.map(BALANCE_CACHE_ENTRY), () => ({})]]);
const CHAIN_CACHE_JSON = T.struct('ChainCacheJson', [['updated_at', T.i64, 0], ['chains', T.vec(T.value), () => []]]);
const SESSION_JSON = T.struct('SessionJson', [['saTeeId', T.string, ''], ['sessionCert', T.string, ''], ['encryptedSessionSk', T.string, ''],
  ['sessionKeyExpireAt', T.string, ''], ['deviceId', T.string, '']]);

// `fs::read_to_string(path).context("failed to read <name>")` + `serde_json::from_str::<T>(&data)
// .context("failed to parse <name>")` → decoded object, or undefined when the file does not exist.
function loadStruct(name, type) {
  const p = homePath(name);
  if (!existsSync(p)) return undefined;
  let bytes;
  try { bytes = readFileSync(p); } catch (e) { throw context(`failed to read ${name}`, e); }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw context(`failed to read ${name}`, new Error('stream did not contain valid UTF-8')); }
  try { return fromStr(bytes, type); } catch (e) {
    if (e instanceof SerdeError) throw context(`failed to parse ${name}`, e);
    throw e;
  }
}

// ── wallets.json ────────────────────────────────────────────────────

// upstream: wallet_store.rs::AddressInfo (struct order)
export const addressInfo = ({ accountId = '', address, chainIndex, chainName = '', addressType = '', chainPath = '' }) =>
  struct({ accountId, address, chainIndex, chainName, addressType, chainPath });
// upstream: wallet_store.rs::AccountInfo
export const accountInfo = ({ projectId, accountId, accountName, isDefault = false }) => struct({ projectId, accountId, accountName, isDefault });
// upstream: wallet_store.rs::AccountMapEntry
export const accountMapEntry = ({ addressList }) => struct({ addressList: addressList.map(addressInfo) });

// upstream: wallet_store.rs::WalletsJson (Default + struct order)
export function walletsJson(w = {}) {
  const accountsMap = {};
  for (const [k, v] of Object.entries(w.accountsMap ?? {})) accountsMap[k] = accountMapEntry(v);
  return struct({
    email: w.email ?? '', isNew: w.isNew ?? false, projectId: w.projectId ?? '', selectedAccountId: w.selectedAccountId ?? '',
    accountsMap, accounts: (w.accounts ?? []).map(accountInfo), loginType: w.loginType ?? '',
  });
}

// upstream: wallet_store.rs::load_wallets → WalletsJson | null
export function loadWallets() {
  const v = loadStruct('wallets.json', WALLETS_JSON);
  return v === undefined ? null : walletsJson(v);
}
// upstream: wallet_store.rs::save_wallets
export const saveWallets = (w) => save('wallets.json', walletsJson(w));
// upstream: wallet_store.rs::delete_wallets
export const deleteWallets = () => remove('wallets.json');

// ── cache.json ──────────────────────────────────────────────────────

// upstream: wallet_store.rs::CacheJson { login?: {email, flowId}, swapTraceId? }
export const cacheJson = (c = {}) => struct({
  login: c.login == null ? undefined : struct({ email: c.login.email, flowId: c.login.flowId }),
  swapTraceId: c.swapTraceId == null ? undefined : c.swapTraceId,
});

// upstream: wallet_store.rs::load_cache → CacheJson (default when missing)
export function loadCache() {
  const v = loadStruct('cache.json', CACHE_JSON);
  return v === undefined ? cacheJson() : cacheJson(v);
}
// upstream: wallet_store.rs::save_cache
export const saveCache = (c) => save('cache.json', cacheJson(c));
// upstream: wallet_store.rs::delete_cache
export const deleteCache = () => remove('cache.json');
// upstream: wallet_store.rs::clear_login_cache (creates cache.json when absent)
export function clearLoginCache() { const c = loadCache(); c.login = undefined; saveCache(c); }
// upstream: wallet_store.rs::set_swap_trace_id
export function setSwapTraceId(tid) { const c = loadCache(); c.swapTraceId = String(tid); saveCache(c); }
// upstream: wallet_store.rs::get_swap_trace_id → string | null
export const getSwapTraceId = () => loadCache().swapTraceId ?? null;
// upstream: wallet_store.rs::clear_swap_trace_id
export function clearSwapTraceId() { const c = loadCache(); c.swapTraceId = undefined; saveCache(c); }

// ── balance_cache.json ──────────────────────────────────────────────

const nowSecs = () => Math.floor(Date.now() / 1000);
// upstream: wallet_store.rs::BalanceCacheEntry { updated_at, data, total_value_usd }
export const balanceCacheEntry = ({ updated_at, data, total_value_usd }) => struct({ updated_at, data, total_value_usd });
// upstream: wallet_store.rs::BalanceCacheJson { batch_updated_at, accounts }
export function balanceCacheJson(c = {}) {
  const accounts = {};
  for (const [k, e] of Object.entries(c.accounts ?? {})) accounts[k] = balanceCacheEntry(e);
  return struct({ batch_updated_at: c.batch_updated_at ?? 0, accounts });
}

// upstream: wallet_store.rs::load_balance_cache → default when missing
export function loadBalanceCache() {
  const v = loadStruct('balance_cache.json', BALANCE_CACHE_JSON);
  return v === undefined ? balanceCacheJson() : balanceCacheJson(v);
}
// upstream: wallet_store.rs::save_balance_cache
export const saveBalanceCache = (c) => save('balance_cache.json', balanceCacheJson(c));
// upstream: wallet_store.rs::delete_balance_cache
export const deleteBalanceCache = () => remove('balance_cache.json');

// upstream: wallet_store.rs::get_batch_balance_cache → BalanceCacheJson | null
export function getBatchBalanceCache(ttlSecs) {
  const c = loadBalanceCache();
  if (!Object.keys(c.accounts).length) return null;
  if (nowSecs() - c.batch_updated_at >= ttlSecs) return null;
  return c;
}
// upstream: wallet_store.rs::set_batch_balance_cache — entries: [[accountId, entry], …]
export function setBatchBalanceCache(entries) {
  const now = nowSecs();
  const c = loadBalanceCache();
  c.batch_updated_at = now;
  for (const [id, e] of entries) c.accounts[id] = balanceCacheEntry(e);
  saveBalanceCache(c);
}
// upstream: wallet_store.rs::get_account_balance_cache → entry | null
export function getAccountBalanceCache(accountId, ttlSecs) {
  const accounts = loadBalanceCache().accounts;
  if (!Object.prototype.hasOwnProperty.call(accounts, accountId)) return null;
  const e = accounts[accountId];
  if (nowSecs() - e.updated_at >= ttlSecs) return null;
  return e;
}
// upstream: wallet_store.rs::set_account_balance_cache (does not touch batch_updated_at)
export function setAccountBalanceCache(accountId, entry) {
  const c = loadBalanceCache();
  c.accounts[accountId] = balanceCacheEntry(entry);
  saveBalanceCache(c);
}

// ── chain_cache.json ────────────────────────────────────────────────

// upstream: wallet_store.rs::ChainCacheJson { updated_at, chains }
export const chainCacheJson = (c = {}) => struct({ updated_at: c.updated_at ?? 0, chains: c.chains ?? [] });

// upstream: wallet_store.rs::load_chain_cache → default when missing
export function loadChainCache() {
  const v = loadStruct('chain_cache.json', CHAIN_CACHE_JSON);
  return v === undefined ? chainCacheJson() : chainCacheJson(v);
}
// upstream: wallet_store.rs::save_chain_cache
export const saveChainCache = (c) => save('chain_cache.json', chainCacheJson(c));
// upstream: wallet_store.rs::get_chain_cache → ChainCacheJson | null (fresh and non-empty only)
export function getChainCache(ttlSecs) {
  const c = loadChainCache();
  if (!c.chains.length) return null;
  if (nowSecs() - c.updated_at >= ttlSecs) return null;
  return c;
}
// upstream: wallet_store.rs::set_chain_cache
export const setChainCache = (chains) => saveChainCache({ updated_at: nowSecs(), chains });

// ── session.json ────────────────────────────────────────────────────

// upstream: wallet_store.rs::SessionJson (all fields default "")
export const sessionJson = (s = {}) => struct({
  saTeeId: s.saTeeId ?? '', sessionCert: s.sessionCert ?? '', encryptedSessionSk: s.encryptedSessionSk ?? '',
  sessionKeyExpireAt: s.sessionKeyExpireAt ?? '', deviceId: s.deviceId ?? '',
});

// upstream: wallet_store.rs::load_session → SessionJson | null
export function loadSession() {
  const v = loadStruct('session.json', SESSION_JSON);
  return v === undefined ? null : sessionJson(v);
}
// upstream: wallet_store.rs::save_session
export const saveSession = (s) => save('session.json', sessionJson(s));
// upstream: wallet_store.rs::delete_session
export const deleteSession = () => remove('session.json');
