// memepump — upstream cli/src/commands/memepump.rs (fetch helpers shared with MCP/workflows + CLI handlers).
// MemepumpTokenListParams is a plain object keyed by its serde (snake_case) field names, null/undefined for
// None — what MCP tool arguments deserialise to; the `memepump tokens` handler builds it from its options.
import { resolveChain } from '../../core/chains.mjs';
import { F64 } from '../../core/json.mjs';
import { trim, parseF64, parseUnsigned } from '../../core/_rust-str.mjs';
import { isJsonObject, rustParams, snakeCase } from '../market/_g03.mjs';

// upstream: memepump.rs::NEW_TOKEN_THRESHOLD_MS
export const NEW_TOKEN_THRESHOLD_MS = 2000n;
// upstream: memepump.rs::UNRELIABLE_ZERO_TAGS
export const UNRELIABLE_ZERO_TAGS = ['bundlersPercent', 'devHoldingsPercent', 'freshWalletsPercent', 'insidersPercent', 'snipersPercent', 'suspectedPhishingWalletPercent'];

// upstream: memepump.rs::now_ms (private) — wall-clock Unix ms (0 on clock error).
export const nowMs = () => Date.now();

// upstream: memepump.rs::is_numeric_zero (private) — Rust f64 parse of the trimmed string, or JSON number == 0.
export function isNumericZero(v) {
  if (typeof v === 'string') {
    const n = parseF64(trim(v));
    return n !== undefined && n === 0;
  }
  if (typeof v === 'number') return v === 0;
  if (typeof v === 'bigint') return v === 0n;
  if (v instanceof F64) return Number(v) === 0;
  return false;
}

// serde_json Value::as_u64 for createdTimestamp (strict u64 string parse, else a non-negative integer number).
function createdMs(v) {
  if (typeof v === 'string') {
    const n = parseUnsigned(v, 'u64');
    return n === undefined ? 0n : BigInt(n);
  }
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && !Object.is(v, -0) ? BigInt(v) : 0n;
  if (typeof v === 'bigint') return v >= 0n && v <= 18446744073709551615n ? v : 0n;
  return 0n;
}

// upstream: memepump.rs::nullify_zero_tags_if_new (private) — tokens created < 2 s before
// `receivedAtMs` get their zero-valued unreliable tag fields replaced by null (in place).
export function nullifyZeroTagsIfNew(token, receivedAtMs) {
  const received = BigInt(receivedAtMs);
  if (received === 0n) return;
  if (!isJsonObject(token)) return;
  const created = Object.prototype.hasOwnProperty.call(token, 'createdTimestamp') ? createdMs(token.createdTimestamp) : 0n;
  if (created === 0n || created > received || received - created >= NEW_TOKEN_THRESHOLD_MS) return;
  const tags = token.tags;
  if (!isJsonObject(tags)) return;
  for (const field of UNRELIABLE_ZERO_TAGS) {
    if (Object.prototype.hasOwnProperty.call(tags, field) && isNumericZero(tags[field])) tags[field] = null;
  }
}

// upstream: memepump.rs::apply_nullify_to_response (private) — bare array, wrapper key
// (list/data/items/signals → array or single token), or the bare token object.
export function applyNullifyToResponse(data, receivedAtMs) {
  if (Array.isArray(data)) {
    for (const token of data) nullifyZeroTagsIfNew(token, receivedAtMs);
    return;
  }
  if (isJsonObject(data)) {
    for (const key of ['list', 'data', 'items', 'signals']) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const wrapped = data[key];
      if (Array.isArray(wrapped)) {
        for (const token of wrapped) nullifyZeroTagsIfNew(token, receivedAtMs);
        return;
      }
      if (isJsonObject(wrapped)) {
        nullifyZeroTagsIfNew(wrapped, receivedAtMs);
        return;
      }
    }
    nullifyZeroTagsIfNew(data, receivedAtMs);
  }
}

// upstream: memepump.rs::fetch_chains — GET /api/v6/dex/market/memepump/supported/chainsProtocol
export function fetchChains(client) {
  return client.get('/api/v6/dex/market/memepump/supported/chainsProtocol', []);
}

// [query key, CLI option (camelCase of the MemepumpTokenListParams field)] in upstream request order
// (after chainIndex, stage).
const TOKEN_LIST_PARAMS = [
  ['walletAddress', 'walletAddress'], ['protocolIdList', 'protocolIdList'], ['quoteTokenAddressList', 'quoteTokenAddressList'],
  ['minTop10HoldingsPercent', 'minTop10HoldingsPercent'], ['maxTop10HoldingsPercent', 'maxTop10HoldingsPercent'],
  ['minDevHoldingsPercent', 'minDevHoldingsPercent'], ['maxDevHoldingsPercent', 'maxDevHoldingsPercent'],
  ['minInsidersPercent', 'minInsidersPercent'], ['maxInsidersPercent', 'maxInsidersPercent'],
  ['minBundlersPercent', 'minBundlersPercent'], ['maxBundlersPercent', 'maxBundlersPercent'],
  ['minSnipersPercent', 'minSnipersPercent'], ['maxSnipersPercent', 'maxSnipersPercent'],
  ['minFreshWalletsPercent', 'minFreshWalletsPercent'], ['maxFreshWalletsPercent', 'maxFreshWalletsPercent'],
  ['minSuspectedPhishingWalletPercent', 'minSuspectedPhishingWalletPercent'], ['maxSuspectedPhishingWalletPercent', 'maxSuspectedPhishingWalletPercent'],
  ['minBotTraders', 'minBotTraders'], ['maxBotTraders', 'maxBotTraders'],
  ['minDevMigrated', 'minDevMigrated'], ['maxDevMigrated', 'maxDevMigrated'],
  ['minMarketCapUsd', 'minMarketCap'], ['maxMarketCapUsd', 'maxMarketCap'],
  ['minVolumeUsd', 'minVolume'], ['maxVolumeUsd', 'maxVolume'],
  ['minTxCount', 'minTxCount'], ['maxTxCount', 'maxTxCount'],
  ['minBondingPercent', 'minBondingPercent'], ['maxBondingPercent', 'maxBondingPercent'],
  ['minHolders', 'minHolders'], ['maxHolders', 'maxHolders'],
  ['minTokenAge', 'minTokenAge'], ['maxTokenAge', 'maxTokenAge'],
  ['minBuyTxCount', 'minBuyTxCount'], ['maxBuyTxCount', 'maxBuyTxCount'],
  ['minSellTxCount', 'minSellTxCount'], ['maxSellTxCount', 'maxSellTxCount'],
  ['minTokenSymbolLength', 'minTokenSymbolLength'], ['maxTokenSymbolLength', 'maxTokenSymbolLength'],
  ['hasAtLeastOneSocialLink', 'hasAtLeastOneSocialLink'], ['hasX', 'hasX'], ['hasTelegram', 'hasTelegram'],
  ['hasWebsite', 'hasWebsite'], ['websiteTypeList', 'websiteTypeList'], ['dexScreenerPaid', 'dexScreenerPaid'],
  ['liveOnPumpFun', 'liveOnPumpFun'], ['devSellAll', 'devSellAll'], ['devStillHolding', 'devStillHolding'],
  ['communityTakeover', 'communityTakeover'], ['bagsFeeClaimed', 'bagsFeeClaimed'],
  ['minFeesNative', 'minFeesNative'], ['maxFeesNative', 'maxFeesNative'],
  ['keywordsInclude', 'keywordsInclude'], ['keywordsExclude', 'keywordsExclude'],
];
// `memepump tokens` CLI options (camelCase of the MemepumpTokenListParams fields): chain, stage + the filters above.
export const TOKEN_LIST_FIELDS = ['chain', 'stage', ...TOKEN_LIST_PARAMS.map(([, f]) => f)];

// upstream: memepump.rs::fetch_token_list — p: MemepumpTokenListParams (serde field names); absent
// filters are sent as "" (unwrap_or_default, dropped by the client), then new-token tags are nullified.
export async function fetchTokenList(client, p) {
  const chainIndex = resolveChain(p.chain);
  const stage = p.stage ?? 'NEW';
  const query = [['chainIndex', chainIndex], ['stage', stage], ...TOKEN_LIST_PARAMS.map(([k, f]) => [k, p[snakeCase(f)] ?? ''])];
  const data = await client.get('/api/v6/dex/market/memepump/tokenList', query);
  applyNullifyToResponse(data, nowMs());
  return data;
}

// upstream: memepump.rs::fetch_token_details
export async function fetchTokenDetails(client, address, chainIndex, walletAddress) {
  const data = await client.get('/api/v6/dex/market/memepump/tokenDetails', [
    ['chainIndex', chainIndex], ['tokenContractAddress', address], ['walletAddress', walletAddress],
  ]);
  applyNullifyToResponse(data, nowMs());
  return data;
}

// upstream: memepump.rs::fetch_aped_wallet
export function fetchApedWallet(client, address, chainIndex, walletAddress) {
  return client.get('/api/v6/dex/market/memepump/apedWallet', [
    ['chainIndex', chainIndex], ['tokenContractAddress', address], ['walletAddress', walletAddress],
  ]);
}

// upstream: memepump.rs::fetch_by_address — shared (chainIndex, tokenContractAddress) GET.
export function fetchByAddress(client, path, address, chainIndex) {
  return client.get(path, [['chainIndex', chainIndex], ['tokenContractAddress', address]]);
}

// ── CLI handlers (memepump.rs::execute) ──────────────────────────────
const chainOrSolana = (ctx, chain) => (chain !== undefined ? resolveChain(chain) : ctx.chainIndexOr('solana'));

// upstream: memepump.rs::memepump_by_address (private CLI wrapper)
const byAddress = (path) => ({
  uses: ['address', 'chain'],
  async run(ctx, o) {
    const ci = chainOrSolana(ctx, o.chain);
    const api = await ctx.api();
    return fetchByAddress(api, path, o.address, ci);
  },
});

export default {
  'memepump chains': {
    uses: [],
    async run(ctx) {
      return fetchChains(await ctx.api());
    },
  },
  'memepump tokens': {
    uses: TOKEN_LIST_FIELDS,
    async run(ctx, o) {
      const api = await ctx.api();
      return fetchTokenList(api, rustParams(o, TOKEN_LIST_FIELDS));   // stage: Some(stage) (clap default "NEW")
    },
  },
  'memepump token-details': {
    uses: ['address', 'chain', 'wallet'],
    async run(ctx, o) {
      const ci = chainOrSolana(ctx, o.chain);
      const wallet = o.wallet ?? '';
      const api = await ctx.api();
      return fetchTokenDetails(api, o.address, ci, wallet);
    },
  },
  'memepump token-dev-info': byAddress('/api/v6/dex/market/memepump/tokenDevInfo'),
  'memepump similar-tokens': byAddress('/api/v6/dex/market/memepump/similarToken'),
  'memepump token-bundle-info': byAddress('/api/v6/dex/market/memepump/tokenBundleInfo'),
  'memepump aped-wallet': {
    uses: ['address', 'chain', 'wallet'],
    async run(ctx, o) {
      const ci = chainOrSolana(ctx, o.chain);
      const wallet = o.wallet ?? '';
      const api = await ctx.api();
      return fetchApedWallet(api, o.address, ci, wallet);
    },
  },
};
