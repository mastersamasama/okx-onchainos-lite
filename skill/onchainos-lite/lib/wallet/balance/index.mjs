// Wallet balances, account freshness and the post-funding balance check — upstream
// agentic_wallet/balance/mod.rs.
//
// Entry points that upstream finishes with output::success(..) (cmd_balance, cmd_funding_check)
// return that `data` value; the command handler returns it to main, which prints the envelope.
// Every `json!` object here is a plain object (serialised with sorted keys, as upstream's
// BTreeMap-backed serde_json::Value); backend values pass through untouched.
import { chainDisplayName, chainFamily } from '../../core/chains.mjs';
import { readableShortfall, resolveCurrentFundingBundle } from '../../core/funding.mjs';
import { WalletApiClient, numberText } from '../api.mjs';
import * as store from '../store.mjs';
import { ensureTokensRefreshed, formatApiError } from '../auth.mjs';
import { resolveActiveAccountId } from '../account.mjs';
import { ERR_NOT_LOGGED_IN } from '../common.mjs';
import { ensureChainCacheFresh } from '../chain.mjs';
import { resolve as resolveChainProfile } from '../chain-profile.mjs';
import { cmdBrc20Balance } from '../utxo/brc20.mjs';
import { F64 } from '../../core/json.mjs';
import { rustTrim, asciiLower, eqIgnoreAsciiCase, isObject, getField as get, formatFixed, parseF64, asF64 } from '../_rs.mjs';
import { asU64, parseU32, parseU64, u64Json } from '../shared/_rust.mjs';

// upstream: balance/mod.rs::BATCH_BALANCE_TTL — seconds the all-accounts batch cache stays fresh.
export const BATCH_BALANCE_TTL = 60;
// upstream: balance/mod.rs::XLAYER_CHAIN_INDEX — pinned to the top of the sorted token list.
export const XLAYER_CHAIN_INDEX = '196';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
const nowSecs = () => Math.floor(Date.now() / 1000);

// ── account freshness helpers ─────────────────────────────────────────

// upstream: balance/mod.rs::wallet_accounts_need_refresh
export function walletAccountsNeedRefresh(wallets) {
  return wallets.accounts.length === 0 || wallets.accounts.some((a) => !hasOwn(wallets.accountsMap, a.accountId));
}

const addressOf = (wallets, accountId, pred) =>
  (hasOwn(wallets.accountsMap, accountId) ? wallets.accountsMap[accountId].addressList.find(pred)?.address : undefined) ?? '';

// upstream: balance/mod.rs::get_evm_address — first address whose chain family is "evm"
// (any chainIndex other than "501", bug-compatible).
export const getEvmAddress = (wallets, accountId) => addressOf(wallets, accountId, (a) => chainFamily(a.chainIndex) === 'evm');
// upstream: balance/mod.rs::get_sol_address
export const getSolAddress = (wallets, accountId) => addressOf(wallets, accountId, (a) => a.chainIndex === '501');
// upstream: balance/mod.rs::get_btc_address
export const getBtcAddress = (wallets, accountId) => addressOf(wallets, accountId, (a) => a.chainIndex === '0' || a.chainIndex === '5');
// upstream: balance/mod.rs::get_sui_address
export const getSuiAddress = (wallets, accountId) => addressOf(wallets, accountId, (a) => a.chainIndex === '784');

const accountInfoFrom = (a) => ({ projectId: a.projectId, accountId: a.accountId, accountName: a.accountName, isDefault: a.isDefault });
const mapEntryFrom = (item) => ({
  addressList: item.addresses.map((a) => ({
    accountId: item.accountId, address: a.address, chainIndex: a.chainIndex, chainName: a.chainName, addressType: a.addressType, chainPath: a.chainPath,
  })),
});

// upstream: balance/mod.rs::ensure_wallet_accounts_fresh — best effort: account/list +
// account/address/list when forced or when the account data is incomplete. API errors are
// swallowed; a save error propagates. Mutates `wallets` in place.
export async function ensureWalletAccountsFresh(client, accessToken, wallets, force) {
  if (!force && !walletAccountsNeedRefresh(wallets)) return;
  let accountList;
  try { accountList = await client.accountList(accessToken, wallets.projectId); } catch { return; }
  wallets.accounts = accountList.map(accountInfoFrom);
  let addressData;
  try { addressData = await client.accountAddressList(accessToken, accountList.map((a) => a.accountId)); } catch { addressData = null; }
  if (addressData) for (const item of addressData) wallets.accountsMap[item.accountId] = mapEntryFrom(item);
  store.saveWallets(wallets);
}

// upstream: balance/mod.rs::refresh_wallet_accounts_strict — both calls must succeed
// (`code=<c> msg=<m>` otherwise); accounts and accountsMap are replaced wholesale and the
// selection falls back to the default (else first) account when it disappeared.
export async function refreshWalletAccountsStrict(client, accessToken, wallets) {
  let accountList, addressData;
  try { accountList = await client.accountList(accessToken, wallets.projectId); } catch (e) { throw formatApiError(e); }
  const accountIds = accountList.map((a) => a.accountId);
  try { addressData = await client.accountAddressList(accessToken, accountIds); } catch (e) { throw formatApiError(e); }
  const accounts = accountList.map(accountInfoFrom);
  const accountsMap = {};
  for (const item of addressData) accountsMap[item.accountId] = mapEntryFrom(item);
  if (!accountIds.includes(wallets.selectedAccountId)) {
    wallets.selectedAccountId = (accounts.find((a) => a.isDefault) ?? accounts[0])?.accountId ?? '';
  }
  wallets.accounts = accounts;
  wallets.accountsMap = accountsMap;
  store.saveWallets(wallets);
}

// ── token helpers ─────────────────────────────────────────────────────

// `groups = data.as_array() or [data]`
const groupsOf = (data) => (Array.isArray(data) ? data : [data]);
// the first of `tokenAssets` / `assets` that is an array
function tokenArray(group) {
  for (const key of ['tokenAssets', 'assets']) {
    const v = get(group, key);
    if (Array.isArray(v)) return v;
  }
  return null;
}
// `v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64())`
function numeric(v) {
  if (typeof v === 'string') { const n = parseF64(v); if (n !== undefined) return n; }
  return asF64(v);
}

// upstream: balance/mod.rs::token_chain_index — string, number rendered, else "".
export function tokenChainIndex(token) {
  const v = get(token, 'chainIndex');
  if (typeof v === 'string') return v;
  return isNumber(v) ? numberText(v) : '';
}

// upstream: balance/mod.rs::token_usd
export const tokenUsd = (token) => numeric(get(token, 'usdValue')) ?? 0;

// f64::partial_cmp(b, a) as a comparator (NaN → Equal)
const descending = (a, b) => { const d = b - a; return Number.isNaN(d) ? 0 : Math.sign(d); };

// upstream: balance/mod.rs::sort_tokens_vec — X Layer first, then chains by total USD desc,
// then tokens by USD desc (stable).
export function sortTokensVec(tokens) {
  const chainTotals = new Map();
  for (const t of tokens) {
    const ci = tokenChainIndex(t);
    chainTotals.set(ci, (chainTotals.get(ci) ?? 0) + tokenUsd(t));
  }
  tokens.sort((a, b) => {
    const aCi = tokenChainIndex(a), bCi = tokenChainIndex(b);
    const aX = aCi === XLAYER_CHAIN_INDEX, bX = bCi === XLAYER_CHAIN_INDEX;
    if (aX && !bX) return -1;
    if (!aX && bX) return 1;
    if (aCi !== bCi) return descending(chainTotals.get(aCi) ?? 0, chainTotals.get(bCi) ?? 0);
    return descending(tokenUsd(a), tokenUsd(b));
  });
  return tokens;
}

// upstream: balance/mod.rs::sort_token_assets
export function sortTokenAssets(data) {
  for (const group of groupsOf(data)) {
    const tokens = tokenArray(group);
    if (tokens) sortTokensVec(tokens);
  }
  return data;
}

// upstream: balance/mod.rs::enrich_group_usd_value — usdValue = format!("{:.6}", balance*price)
// unless the token already carries a non-null, non-empty usdValue.
export function enrichGroupUsdValue(group) {
  const tokens = tokenArray(group);
  if (!tokens) return;
  for (const asset of tokens) {
    const u = get(asset, 'usdValue');
    if (u !== undefined && u !== null && (typeof u !== 'string' || u !== '')) continue;
    const balance = numeric(get(asset, 'balance')) ?? 0;
    const price = numeric(get(asset, 'tokenPrice')) ?? 0;
    if (isObject(asset)) asset.usdValue = formatFixed(balance * price, 6);
  }
}

// upstream: balance/mod.rs::enrich_with_usd_value
export function enrichWithUsdValue(data) {
  if (Array.isArray(data)) data.forEach(enrichGroupUsdValue);
  else enrichGroupUsdValue(data);
  return data;
}

// upstream: balance/mod.rs::TokenBalanceResponse — the 9-field whitelist (nulls dropped).
export const TOKEN_BALANCE_FIELDS = Object.freeze(['symbol', 'tokenName', 'chainIndex', 'tokenAddress', 'balance', 'rawBalance', 'decimal', 'tokenPrice', 'usdValue']);

// upstream: balance/mod.rs::project_token_fields — trims every object token to the whitelist.
export function projectTokenFields(data) {
  for (const group of groupsOf(data)) {
    const tokens = tokenArray(group);
    if (!tokens) continue;
    tokens.forEach((token, i) => {
      if (!isObject(token)) return;
      const projected = {};
      for (const k of TOKEN_BALANCE_FIELDS) if (hasOwn(token, k) && token[k] !== null && token[k] !== undefined) projected[k] = token[k];
      tokens[i] = projected;
    });
  }
  return data;
}

// Rust `if total.is_sign_negative() && total == 0.0 { 0.0 }` then `{:.2}`
const money = (total) => formatFixed(total === 0 ? 0 : total, 2);

// upstream: balance/mod.rs::compute_total_value_usd → "x.xx"
export function computeTotalValueUsd(data) {
  let total = 0;
  for (const group of groupsOf(data)) {
    const g = isObject(group) ? group : {};
    const assets = Array.isArray(g.tokenAssets) ? g.tokenAssets : Array.isArray(g.assets) ? g.assets : null;
    if (!assets) continue;
    for (const asset of assets) {
      let usd = numeric(get(asset, 'usdValue'));
      if (usd === undefined) usd = (numeric(get(asset, 'balance')) ?? 0) * (numeric(get(asset, 'tokenPrice')) ?? 0);
      total += usd;
    }
  }
  return money(total);
}

// upstream: balance/mod.rs::sum_cache_total — Σ total_value_usd (unparseable → 0) → "x.xx"
export function sumCacheTotal(cache) {
  let total = 0;
  for (const e of Object.values(cache.accounts)) total += parseF64(String(e.total_value_usd)) ?? 0;
  return money(total);
}

// upstream: balance/mod.rs::retain_requested_accounts (in place; non-arrays untouched)
export function retainRequestedAccounts(data, requested) {
  if (!Array.isArray(data)) return data;
  const kept = data.filter((g) => typeof get(g, 'accountId') === 'string' && requested.includes(g.accountId));
  data.splice(0, data.length, ...kept);
  return data;
}

// upstream: balance/mod.rs::cache_for_accounts — copy restricted to `accountIds`.
export function cacheForAccounts(cache, accountIds) {
  const accounts = {};
  for (const [k, v] of Object.entries(cache.accounts)) if (accountIds.includes(k)) accounts[k] = v;
  return { batch_updated_at: cache.batch_updated_at, accounts };
}

// BalanceCacheJson.accounts as the json! Value upstream prints (entries: sorted-key objects).
const cacheAccountsValue = (accounts) =>
  Object.fromEntries(Object.entries(accounts).map(([k, e]) => [k, { updated_at: e.updated_at, data: e.data, total_value_usd: e.total_value_usd }]));

// upstream: balance/mod.rs::login_identity_summary (json! → sorted keys)
export function loginIdentitySummary(wallets, accountId) {
  const acct = wallets.accounts.find((a) => a.accountId === accountId);
  return {
    accountName: acct ? acct.accountName : '',
    evmAddress: getEvmAddress(wallets, accountId),
    solAddress: getSolAddress(wallets, accountId),
    btcAddress: getBtcAddress(wallets, accountId),
    suiAddress: getSuiAddress(wallets, accountId),
    accountCount: Math.max(wallets.accounts.length, Object.keys(wallets.accountsMap).length),
  };
}

// Per-account batch cache entries for the groups of a batch response.
function batchEntries(data, prepare) {
  const now = nowSecs();
  const entries = [];
  if (!Array.isArray(data)) return entries;
  for (const group of data) {
    const aid = get(group, 'accountId');
    if (typeof aid !== 'string') continue;
    const accountData = [structuredCloneValue(group)];
    prepare(accountData);
    entries.push([aid, { updated_at: now, data: accountData, total_value_usd: computeTotalValueUsd(accountData) }]);
  }
  return entries;
}

// serde_json::Value::clone — deep copy keeping F64 / BigInt leaves.
function structuredCloneValue(v) {
  if (Array.isArray(v)) return v.map(structuredCloneValue);
  if (isObject(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = structuredCloneValue(x); return o; }
  return v;
}

// upstream: balance/mod.rs::login_account_summary — identity + totalValueUsd from one live
// batch call (also refreshes the batch cache); "" when the call fails.
export async function loginAccountSummary(client, accessToken, wallets, accountId) {
  const summary = loginIdentitySummary(wallets, accountId);
  const accountIds = Object.keys(wallets.accountsMap);
  let totalValueUsd = '';
  if (accountIds.length) {
    let data;
    try { data = await client.balanceBatch(accessToken, accountIds.join(',')); } catch { data = undefined; }
    if (data !== undefined) {
      enrichWithUsdValue(data);
      retainRequestedAccounts(data, accountIds);
      if (Array.isArray(data)) {
        try { store.setBatchBalanceCache(batchEntries(data, () => {})); } catch { /* ignored */ }
      }
      totalValueUsd = computeTotalValueUsd(data);
    }
  }
  summary.totalValueUsd = totalValueUsd;
  return summary;
}

// ── cmd_balance ───────────────────────────────────────────────────────

// upstream: balance/mod.rs::cmd_balance — `wallet balance [--all] [--chain] [--token-address] [--force]`
// (token already normalised by the dispatcher) → output data.
export async function cmdBalance(all, chain, tokenAddress, force) {
  await ensureChainCacheFresh();
  const accessToken = await ensureTokensRefreshed();
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const client = new WalletApiClient();

  // Scenario 1: every account (--all)
  if (all) {
    const accountIds = Object.keys(wallets.accountsMap);
    if (!accountIds.length) throw new Error('no wallet accounts found');
    if (!force) {
      const hit = store.getBatchBalanceCache(BATCH_BALANCE_TTL);
      if (hit) {
        const cached = cacheForAccounts(hit, accountIds);
        return { totalValueUsd: sumCacheTotal(cached), details: cacheAccountsValue(cached.accounts) };
      }
    }
    let data;
    try { data = await client.balanceBatch(accessToken, accountIds.join(',')); } catch (e) { throw formatApiError(e); }
    retainRequestedAccounts(data, accountIds);
    store.setBatchBalanceCache(batchEntries(data, (accountData) => { enrichWithUsdValue(accountData); projectTokenFields(accountData); }));
    const cached = cacheForAccounts(store.loadBalanceCache(), accountIds);
    return { totalValueUsd: sumCacheTotal(cached), details: cacheAccountsValue(cached.accounts) };
  }

  const accountId = resolveActiveAccountId(wallets);

  // Scenario 4: one token (--token-address)
  if (tokenAddress !== undefined && tokenAddress !== null) {
    if (chain === undefined || chain === null) throw new Error('--chain is required when using --token-address');
    const profile = await resolveChainProfile(chain);
    const chainIndex = profile.chainIndex;
    if (profile.isBitcoin() && asciiLower(rustTrim(tokenAddress)).startsWith('btc-brc20-')) return cmdBrc20Balance(tokenAddress);
    const query = [['accountId', accountId], ['chains', chainIndex], ['tokenAddresses[0].chainIndex', chainIndex], ['tokenAddresses[0].tokenAddress', rustTrim(tokenAddress)]];
    let data;
    try { data = await client.balanceSingle(accessToken, query); } catch (e) { throw formatApiError(e); }
    enrichWithUsdValue(data);
    projectTokenFields(data);
    return { details: data };
  }

  // Scenario 3: one chain (--chain)
  if (chain !== undefined && chain !== null) {
    const profile = await resolveChainProfile(chain);
    let data;
    try { data = await client.balanceSingle(accessToken, [['accountId', accountId], ['chains', profile.chainIndex]]); } catch (e) { throw formatApiError(e); }
    enrichWithUsdValue(data);
    projectTokenFields(data);
    return { totalValueUsd: computeTotalValueUsd(data), details: data };
  }

  // Scenario 2: the current account (no flags)
  await ensureWalletAccountsFresh(client, accessToken, wallets, force);
  let data;
  try { data = await client.balanceSingle(accessToken, [['accountId', accountId]]); } catch (e) { throw formatApiError(e); }
  enrichWithUsdValue(data);
  projectTokenFields(data);
  sortTokenAssets(data);
  const acct = wallets.accounts.find((a) => a.accountId === accountId);
  return {
    totalValueUsd: computeTotalValueUsd(data),
    accountId,
    accountName: acct ? acct.accountName : '',
    evmAddress: getEvmAddress(wallets, accountId),
    solAddress: getSolAddress(wallets, accountId),
    btcAddress: getBtcAddress(wallets, accountId),
    suiAddress: getSuiAddress(wallets, accountId),
    accountCount: Math.max(wallets.accounts.length, Object.keys(wallets.accountsMap).length),
    details: data,
  };
}

// ── cmd_funding_check ─────────────────────────────────────────────────

// upstream: balance/mod.rs::cmd_funding_check — fresh post-funding verification → output data.
export async function cmdFundingCheck(chain, tokenAddress, required, asset) {
  const assetSymbol = rustTrim(asset);
  if (assetSymbol === '') throw new Error('--asset must not be blank');
  if (readableShortfall(required, '0') === null) throw new Error('--required must be a non-negative plain decimal');

  const profile = await resolveChainProfile(chain);
  const chainIndex = profile.chainIndex;
  const chainName = chainDisplayName(chainIndex);
  let matched;
  try {
    matched = await queryTokenReadable(chainIndex, tokenAddress);
  } catch {
    return {
      phase: 'funding_verification', decision: 'blocked', reason: 'balance_unavailable', nextAction: [],
      payload: {
        chainIndex, chainName, asset: { symbol: assetSymbol, tokenAddress },
        currentBalance: null, required, shortfall: null, sufficient: null,
      },
    };
  }
  const currentBalance = matched ? matched.balance : '0';
  const symbol = matched && matched.symbol !== undefined ? matched.symbol : assetSymbol;
  const shortfall = readableShortfall(required, currentBalance);
  if (shortfall === null) throw new Error('wallet returned a non-decimal balance');
  const sufficient = shortfall === '0';
  const payload = { chainIndex, chainName, asset: { symbol, tokenAddress }, currentBalance, required, shortfall, sufficient };

  if (!sufficient) {
    let bundle;
    try { bundle = await resolveCurrentFundingBundle(chainIndex, undefined); } catch { bundle = null; }
    if (!bundle) return { phase: 'funding_verification', decision: 'blocked', reason: 'funding_target_unavailable', nextAction: [], payload };
    payload.fundingTarget = { ...bundle.target };
    payload.qr = { ...bundle.qr };
  }
  return {
    phase: 'funding_verification',
    decision: sufficient ? 'ready' : 'blocked',
    reason: sufficient ? 'funding_sufficient' : 'insufficient_balance',
    nextAction: [],
    payload,
  };
}

// ── readable balance / metadata queries ─────────────────────────────

// upstream: balance/mod.rs::value_as_u32 — u64 fitting u32, or a u32 decimal string.
export function valueAsU32(value) {
  const n = asU64(value);
  if (n !== undefined) return n <= 4294967295n ? Number(n) : undefined;
  return typeof value === 'string' ? parseU32(value) : undefined;
}

// upstream: balance/mod.rs::match_readable_token → MatchedToken { balance, symbol?, decimals? } | null
// (matched on exact chainIndex + ASCII-case-insensitive tokenAddress; "" = native).
export function matchReadableToken(data, chainIndex, tokenAddress) {
  for (const group of groupsOf(data)) {
    const g = isObject(group) ? group : {};
    const tokens = Array.isArray(g.tokenAssets) ? g.tokenAssets : Array.isArray(g.assets) ? g.assets : null;
    if (!tokens) continue;
    for (const token of tokens) {
      const ta = typeof get(token, 'tokenAddress') === 'string' ? get(token, 'tokenAddress') : '';
      if (tokenChainIndex(token) !== chainIndex || !eqIgnoreAsciiCase(ta, tokenAddress)) continue;
      const b = get(token, 'balance');
      let balance;
      if (typeof b === 'string') balance = b;
      else if (isNumber(b)) balance = numberText(b);
      else return null;
      const sym = get(token, 'symbol');
      const trimmed = typeof sym === 'string' ? rustTrim(sym) : '';
      const d = get(token, 'decimal');
      const du = asU64(d);
      const decimals = du !== undefined ? (du <= 4294967295n ? Number(du) : undefined) : typeof d === 'string' ? parseU32(d) : undefined;
      return { balance, symbol: trimmed === '' ? undefined : trimmed, decimals };
    }
  }
  return null;
}

// upstream: balance/mod.rs::match_readable_balance
export function matchReadableBalance(data, chainIndex, tokenAddress) {
  const m = matchReadableToken(data, chainIndex, tokenAddress);
  return m ? m.balance : null;
}

// upstream: balance/mod.rs::query_token_metadata → TokenMetadata { symbol?, decimals }
export async function queryTokenMetadata(chainIndex, tokenAddress) {
  const accessToken = await ensureTokensRefreshed();
  const n = parseU64(chainIndex);
  if (n === undefined) throw new Error(`invalid numeric chain index: ${chainIndex}`);
  const client = new WalletApiClient();
  let info;
  try { info = await client.getTokenInfo(accessToken, u64Json(n), tokenAddress); } catch (e) { throw formatApiError(e); }
  const item = Array.isArray(info) && info.length ? info[0] : info;
  const dec = (k) => (isObject(item) && hasOwn(item, k) ? valueAsU32(item[k]) : undefined);
  const decimals = dec('decimals') ?? dec('decimal');
  if (decimals === undefined) throw new Error('token metadata missing decimals');
  const raw = isObject(item) && hasOwn(item, 'tokenSymbol') ? item.tokenSymbol : get(item, 'symbol');
  return { symbol: typeof raw === 'string' && raw !== '' ? raw : undefined, decimals };
}

// upstream: balance/mod.rs::query_token_readable → MatchedToken | null (null = zero holding)
export async function queryTokenReadable(chainIndex, tokenAddress) {
  const accessToken = await ensureTokensRefreshed();
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const client = new WalletApiClient();
  await ensureWalletAccountsFresh(client, accessToken, wallets, false);
  const accountId = resolveActiveAccountId(wallets);
  let data;
  try { data = await client.balanceSingle(accessToken, [['accountId', accountId], ['chains', chainIndex]]); } catch (e) { throw formatApiError(e); }
  projectTokenFields(data);
  return matchReadableToken(data, chainIndex, tokenAddress);
}

// upstream: balance/mod.rs::query_token_readable_balance → balance string | null
export async function queryTokenReadableBalance(chainIndex, tokenAddress) {
  const m = await queryTokenReadable(chainIndex, tokenAddress);
  return m ? m.balance : null;
}
