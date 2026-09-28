// Supported-chain list with a 10-minute on-disk cache — upstream agentic_wallet/chain.rs.
import { WalletApiClient } from './api.mjs';
import * as store from './store.mjs';
import { rustTrim, eqIgnoreAsciiCase, isI64, isU64, getField as get } from './_rs.mjs';

// upstream: chain.rs::CHAIN_CACHE_TTL (seconds)
export const CHAIN_CACHE_TTL = 600;


// upstream: chain.rs::execute(ChainCommand::List) → cmd_list — returns the chain array (printed as data).
export const execute = () => cmdList();
// upstream: chain.rs::cmd_list
export const cmdList = () => getAllChains();

// upstream: chain.rs::get_all_chains — cache-first (TTL 600 s), else fetch + persist.
export async function getAllChains() {
  const cached = store.getChainCache(CHAIN_CACHE_TTL);
  if (cached) return cached.chains;
  const chains = await fetchChainsFromApi();
  store.setChainCache(chains);
  return chains;
}

// upstream: chain.rs::get_chain_by_index
export async function getChainByIndex(chainIndex) {
  const chains = await getAllChains();
  return chains.find((c) => {
    const v = get(c, 'chainIndex');
    const idx = typeof v === 'string' ? v : isI64(v) ? String(v) : undefined;
    return idx !== undefined && idx === chainIndex;
  }) ?? null;
}

// upstream: chain.rs::get_real_chain_index → number | BigInt
export async function getRealChainIndex(chainIndex) {
  const entry = await getChainByIndex(chainIndex);
  if (!entry) throw new Error(`Chain index ${chainIndex} not found in supported chains`);
  const v = get(entry, 'realChainIndex');
  if (typeof v === 'string' && /^\+?\d+$/.test(v) && BigInt(v) <= 18446744073709551615n) {
    const b = BigInt(v);
    return Number.isSafeInteger(Number(b)) ? Number(b) : b;
  }
  if (isU64(v)) return v;
  throw new Error(`Cannot resolve realChainIndex for chain index ${chainIndex}`);
}

// upstream: chain.rs::get_chain_by_name (Unicode to_lowercase equality)
export async function getChainByName(chainName) {
  const chains = await getAllChains();
  const lower = chainName.toLowerCase();
  return chains.find((c) => typeof get(c, 'chainName') === 'string' && get(c, 'chainName').toLowerCase() === lower) ?? null;
}

// upstream: chain.rs::get_chain_by_real_chain_index — chainIndex | realChainIndex | chainName | alias.
export async function getChainByRealChainIndex(input) {
  const needle = rustTrim(input);
  const chains = await getAllChains();
  return chains.find((c) => {
    const fieldMatches = (key) => {
      const v = get(c, key);
      if (typeof v === 'string') return eqIgnoreAsciiCase(v, needle);
      if (isI64(v)) return String(v) === needle;
      return false;
    };
    const aliases = get(c, 'alias');
    return fieldMatches('chainIndex') || fieldMatches('realChainIndex') || fieldMatches('chainName')
      || (Array.isArray(aliases) && aliases.some((a) => typeof a === 'string' && eqIgnoreAsciiCase(a, needle)));
  }) ?? null;
}

// upstream: chain.rs::force_refresh_chain_cache — errors ignored.
export async function forceRefreshChainCache() {
  let chains;
  try { chains = await fetchChainsFromApi(); } catch { return; }
  try { store.setChainCache(chains); } catch {}
}

// upstream: chain.rs::show_name_for_real_id_sync — cache only, any age.
export function showNameForRealIdSync(realChainId) {
  let cached;
  try { cached = store.getChainCache(Number.MAX_SAFE_INTEGER); } catch { return null; }
  if (!cached) return null;
  const target = String(realChainId);
  for (const c of cached.chains) {
    const v = get(c, 'realChainIndex');
    const real = typeof v === 'string' ? v : isI64(v) ? String(v) : undefined;
    if (real === undefined || real !== target) continue;
    // find_map: a matching entry without a string showName yields None → keep searching
    const name = get(c, 'showName');
    if (typeof name === 'string') return name;
  }
  return null;
}

// upstream: chain.rs::fetch_chains_from_api — POST chain/support/list {} (anonymous).
export async function fetchChainsFromApi() {
  const data = await new WalletApiClient().postPublic('/priapi/v5/wallet/agentic/chain/support/list', {});
  if (Array.isArray(data)) return data;
  const list = get(data, 'chainList');
  return Array.isArray(list) ? list : [];
}

// upstream: chain.rs::ensure_chain_cache_fresh — refresh when stale, errors ignored.
export async function ensureChainCacheFresh() {
  let fresh = null;
  try { fresh = store.getChainCache(CHAIN_CACHE_TTL); } catch {}
  if (fresh) return;
  await forceRefreshChainCache();
}

