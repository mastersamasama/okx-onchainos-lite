// PRIVATE FALLBACK — login-success summary helpers owned by the wallet-balance unit
// (lib/wallet/balance/index.mjs, upstream agentic_wallet/balance/mod.rs). auth.mjs uses the
// owner's loginAccountSummary whenever that module exports it.
import { chainFamily } from '../core/chains.mjs';
import * as store from './store.mjs';
import { formatFixed, parseF64, asF64, isObject } from './_rs.mjs';

const entryOf = (w, id) => (Object.prototype.hasOwnProperty.call(w.accountsMap, id) ? w.accountsMap[id] : null);
const findAddr = (w, id, pred) => entryOf(w, id)?.addressList.find(pred)?.address ?? '';

// upstream: balance/mod.rs::get_evm_address — any chainIndex whose chain_family is "evm" (≠ 501).
export const getEvmAddress = (w, id) => findAddr(w, id, (a) => chainFamily(a.chainIndex) === 'evm');
// upstream: balance/mod.rs::get_sol_address
export const getSolAddress = (w, id) => findAddr(w, id, (a) => a.chainIndex === '501');
// upstream: balance/mod.rs::get_btc_address
export const getBtcAddress = (w, id) => findAddr(w, id, (a) => a.chainIndex === '0' || a.chainIndex === '5');
// upstream: balance/mod.rs::get_sui_address
export const getSuiAddress = (w, id) => findAddr(w, id, (a) => a.chainIndex === '784');

// `v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64())`
function num(v) {
  if (typeof v === 'string') { const n = parseF64(v); if (n !== undefined) return n; return undefined; }
  return asF64(v);
}

// upstream: balance/mod.rs::enrich_group_usd_value
function enrichGroupUsdValue(group) {
  for (const key of ['tokenAssets', 'assets']) {
    const arr = isObject(group) ? group[key] : undefined;
    if (!Array.isArray(arr)) continue;
    for (const asset of arr) {
      const u = isObject(asset) ? asset.usdValue : undefined;
      if (u !== undefined && u !== null && (typeof u !== 'string' || u !== '')) continue;
      const balance = num(isObject(asset) ? asset.balance : undefined) ?? 0;
      const price = num(isObject(asset) ? asset.tokenPrice : undefined) ?? 0;
      if (isObject(asset)) asset.usdValue = formatFixed(balance * price, 6);
    }
    break;
  }
}
// upstream: balance/mod.rs::enrich_with_usd_value
export function enrichWithUsdValue(data) {
  if (Array.isArray(data)) data.forEach(enrichGroupUsdValue);
  else enrichGroupUsdValue(data);
}

// upstream: balance/mod.rs::compute_total_value_usd → "x.xx"
export function computeTotalValueUsd(data) {
  let total = 0;
  for (const group of Array.isArray(data) ? data : [data]) {
    const g = isObject(group) ? group : {};
    const assets = Array.isArray(g.tokenAssets) ? g.tokenAssets : Array.isArray(g.assets) ? g.assets : null;
    if (!assets) continue;
    for (const asset of assets) {
      const a = isObject(asset) ? asset : {};
      let usd = typeof a.usdValue === 'string' ? parseF64(a.usdValue) : undefined;
      if (usd === undefined) usd = asF64(a.usdValue);
      if (usd === undefined) usd = (num(a.balance) ?? 0) * (num(a.tokenPrice) ?? 0);
      total += usd;
    }
  }
  if (total === 0) total = 0;           // -0 → 0
  return formatFixed(total, 2);
}

// upstream: balance/mod.rs::retain_requested_accounts
export function retainRequestedAccounts(data, requested) {
  if (!Array.isArray(data)) return data;
  const kept = data.filter((g) => isObject(g) && typeof g.accountId === 'string' && requested.includes(g.accountId));
  data.splice(0, data.length, ...kept);
  return data;
}

// upstream: balance/mod.rs::login_identity_summary (json! → sorted keys)
export function loginIdentitySummary(w, id) {
  const acct = w.accounts.find((a) => a.accountId === id);
  return {
    accountName: acct ? acct.accountName : '', evmAddress: getEvmAddress(w, id), solAddress: getSolAddress(w, id),
    btcAddress: getBtcAddress(w, id), suiAddress: getSuiAddress(w, id),
    accountCount: Math.max(w.accounts.length, Object.keys(w.accountsMap).length),
  };
}

// upstream: balance/mod.rs::login_account_summary — identity + totalValueUsd from one live
// wallet-all-token-balances-batch call (also refreshes balance_cache.json); "" on failure.
export async function loginAccountSummary(client, accessToken, wallets, accountId) {
  const summary = loginIdentitySummary(wallets, accountId);
  const ids = Object.keys(wallets.accountsMap);
  let totalValueUsd = '';
  if (ids.length) {
    try {
      const data = await client.balanceBatch(accessToken, ids.join(','));
      enrichWithUsdValue(data);
      retainRequestedAccounts(data, ids);
      if (Array.isArray(data)) {
        const now = Math.floor(Date.now() / 1000);
        const entries = [];
        for (const group of data) {
          if (!isObject(group) || typeof group.accountId !== 'string') continue;
          const accountData = [group];
          entries.push([group.accountId, { updated_at: now, data: accountData, total_value_usd: computeTotalValueUsd(accountData) }]);
        }
        try { store.setBatchBalanceCache(entries); } catch {}
      }
      totalValueUsd = computeTotalValueUsd(data);
    } catch {
      totalValueUsd = '';
    }
  }
  summary.totalValueUsd = totalValueUsd;
  return summary;
}
