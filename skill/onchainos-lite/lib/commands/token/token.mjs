// token — upstream commands/token.rs. Handlers for every `onchainos token …` leaf plus the
// pub fetch_* helpers other units reuse (swap, cross-chain, payment, workflows, MCP).
// Every fetch* takes an ApiClient (core/http.mjs) as its first argument, like upstream.
import { resolveChain, resolveChains } from '../../core/chains.mjs';
import { ApiClient, cloneClient } from '../../core/http.mjs';
import { parseMaxResults, autoPaginate, pageShape, CursorMode } from '../../core/sink.mjs';
import { typed } from '../../core/cli.mjs';
import { trim } from '../../core/rs/str.mjs';
import { parseU64 } from '../../core/rs/num.mjs';

const SEARCH_PATH = '/api/v6/dex/market/token/search';
const BASIC_INFO_PATH = '/api/v6/dex/market/token/basic-info';
const HOLDER_PATH = '/api/v6/dex/market/token/holder';
const TOP_LIQUIDITY_PATH = '/api/v6/dex/market/token/top-liquidity';
const PRICE_INFO_PATH = '/api/v6/dex/market/price-info';
const TOKEN_SCAN_PATH = '/api/v6/security/token-scan';
const HOT_TOKEN_PATH = '/api/v6/dex/market/token/hot-token';
const ADVANCED_INFO_PATH = '/api/v6/dex/market/token/advanced-info';
const TOP_TRADER_PATH = '/api/v6/dex/market/token/top-trader';
const TRADES_PATH = '/api/v6/dex/market/trades';
const CLUSTER_SUPPORTED_CHAIN_PATH = '/api/v6/dex/market/token/cluster/supported/chain';
export const CLUSTER_OVERVIEW_PATH = '/api/v6/dex/market/token/cluster/overview';
export const CLUSTER_LIST_PATH = '/api/v6/dex/market/token/cluster/list';
const CLUSTER_TOP_HOLDERS_PATH = '/api/v6/dex/market/token/cluster/top-holders';

// `source` tag sent with every security scan request (token.rs / security.rs literal).
export const SECURITY_SOURCE = 'onchain_os_cli';

// Inline in fetch_search / fetch_holders / fetch_hot_tokens / fetch_top_trader:
// `s.parse::<u64>()` on the raw string (no trim, optional '+'), then the 1..=100 range check.
export function validateLimit(limit) {
  if (limit === undefined || limit === null) return;
  const n = parseU64(String(limit));
  if (n === undefined) throw new Error('--limit must be a number between 1 and 100');
  if (!(n >= 1 && n <= 100)) throw new Error(`--limit must be between 1 and 100, got ${n}`);
}

// serde_json::to_value(Aggregated) — the struct becomes a Value, so its keys print sorted.
const aggregatedValue = (agg) => ({ ...agg, error: agg.error === undefined ? undefined : { ...agg.error } });

// upstream: token.rs::finalize_token_page — single page (cursor only when non-empty) or, with
// --max-results, per-item auto-pagination → {error?,fetchedCount,items,nextCursor,partial?}.
// `base` = ordered query pairs without the cursor.
export async function finalizeTokenPage(client, path, base, cursor, maxResults) {
  const n = parseMaxResults(maxResults);
  if (n !== null) {
    const shape = pageShape('list', 'cursor', CursorMode.PerItem);
    const agg = await autoPaginate(cursor ?? null, n, shape, (cur) =>
      client.get(path, cur === null || cur === undefined ? [...base] : [...base, ['cursor', cur]]));
    return aggregatedValue(agg);
  }
  const q = [...base];
  if (cursor !== undefined && cursor !== null && cursor !== '') q.push(['cursor', cursor]);
  return client.get(path, q);
}

// upstream: token.rs::fetch_search — GET /api/v6/dex/market/token/search
export async function fetchSearch(client, query, chains, limit, cursor, maxResults) {
  const resolvedChains = resolveChains(chains);
  validateLimit(limit);
  const base = [['chains', resolvedChains], ['search', query], ['limit', limit ?? '20']];
  return finalizeTokenPage(client, SEARCH_PATH, base, cursor, maxResults);
}

// upstream: token.rs::fetch_info — POST /api/v6/dex/market/token/basic-info (array body)
export async function fetchInfo(client, address, chainIndex) {
  return client.post(BASIC_INFO_PATH, [{ chainIndex, tokenContractAddress: address }]);
}

// upstream: token.rs::fetch_holders — GET /api/v6/dex/market/token/holder (tagFilter: u8 | undefined)
export async function fetchHolders(client, address, chainIndex, tagFilter, limit, cursor, maxResults) {
  validateLimit(limit);
  const base = [
    ['chainIndex', chainIndex],
    ['tokenContractAddress', address],
    ['tagFilter', tagFilter === undefined || tagFilter === null ? '' : String(tagFilter)],
    ['limit', limit ?? '20'],
  ];
  return finalizeTokenPage(client, HOLDER_PATH, base, cursor, maxResults);
}

// upstream: token.rs::fetch_liquidity — GET /api/v6/dex/market/token/top-liquidity
export async function fetchLiquidity(client, address, chainIndex) {
  return client.get(TOP_LIQUIDITY_PATH, [['chainIndex', chainIndex], ['tokenContractAddress', address]]);
}

// upstream: token.rs::fetch_price_info — POST /api/v6/dex/market/price-info (array body)
export async function fetchPriceInfo(client, address, chainIndex) {
  return client.post(PRICE_INFO_PATH, [{ chainIndex, tokenContractAddress: address }]);
}

// upstream: token.rs::fetch_security — POST /api/v6/security/token-scan for one token.
export async function fetchSecurity(client, address, chainIndex) {
  return client.post(TOKEN_SCAN_PATH, { source: SECURITY_SOURCE, tokenList: [{ chainId: chainIndex, contractAddress: address }] });
}

// upstream: token.rs::HotTokensParams — field order of the Rust struct. Accepts the camelCase
// names (CLI options) or the Rust snake_case names (MCP deserialises the struct from those).
const HOT_FIELDS = [
  'rankingType', 'chain', 'rankBy', 'timeFrame', 'riskFilter', 'stableTokenFilter', 'projectId',
  'priceChangeMin', 'priceChangeMax', 'volumeMin', 'volumeMax', 'marketCapMin', 'marketCapMax',
  'liquidityMin', 'liquidityMax', 'transactionMin', 'transactionMax', 'txsMin', 'txsMax',
  'uniqueTraderMin', 'uniqueTraderMax', 'holdersMin', 'holdersMax', 'inflowMin', 'inflowMax',
  'fdvMin', 'fdvMax', 'mentionedCountMin', 'mentionedCountMax', 'socialScoreMin', 'socialScoreMax',
  'top10HoldPercentMin', 'top10HoldPercentMax', 'devHoldPercentMin', 'devHoldPercentMax',
  'bundleHoldPercentMin', 'bundleHoldPercentMax', 'suspiciousHoldPercentMin', 'suspiciousHoldPercentMax',
  'isLpBurnt', 'isMint', 'isFreeze', 'limit', 'cursor', 'maxResults',
];
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export function hotTokensParams(p = {}) {
  return Object.fromEntries(HOT_FIELDS.map((k) => [k, p[k] ?? p[snake(k)] ?? undefined]));
}

// upstream: token.rs::fetch_hot_tokens — GET /api/v6/dex/market/token/hot-token.
// Query order follows upstream's req_params (market-cap / liquidity after unique-trader).
export async function fetchHotTokens(client, params) {
  const p = hotTokensParams(params);
  validateLimit(p.limit);
  const s = (v) => v ?? '';
  const chainIndex = p.chain === undefined || p.chain === null ? '' : resolveChain(p.chain);
  const base = [
    ['rankingType', s(p.rankingType)],
    ['chainIndex', chainIndex],
    ['rankBy', s(p.rankBy)],
    ['rankingTimeFrame', s(p.timeFrame)],
    ['riskFilter', s(p.riskFilter)],
    ['stableTokenFilter', s(p.stableTokenFilter)],
    ['protocolId', s(p.projectId)],
    ['priceChangePercentMin', s(p.priceChangeMin)],
    ['priceChangePercentMax', s(p.priceChangeMax)],
    ['volumeMin', s(p.volumeMin)],
    ['volumeMax', s(p.volumeMax)],
    ['tradeAmountMin', s(p.transactionMin)],
    ['tradeAmountMax', s(p.transactionMax)],
    ['txsMin', s(p.txsMin)],
    ['txsMax', s(p.txsMax)],
    ['uniqueTraderMin', s(p.uniqueTraderMin)],
    ['uniqueTraderMax', s(p.uniqueTraderMax)],
    ['marketCapMin', s(p.marketCapMin)],
    ['marketCapMax', s(p.marketCapMax)],
    ['liquidityMin', s(p.liquidityMin)],
    ['liquidityMax', s(p.liquidityMax)],
    ['holdersMin', s(p.holdersMin)],
    ['holdersMax', s(p.holdersMax)],
    ['inflowUsdMin', s(p.inflowMin)],
    ['inflowUsdMax', s(p.inflowMax)],
    ['fdvMin', s(p.fdvMin)],
    ['fdvMax', s(p.fdvMax)],
    ['mentionedCountMin', s(p.mentionedCountMin)],
    ['mentionedCountMax', s(p.mentionedCountMax)],
    ['socialScoreMin', s(p.socialScoreMin)],
    ['socialScoreMax', s(p.socialScoreMax)],
    ['top10HoldPercentMin', s(p.top10HoldPercentMin)],
    ['top10HoldPercentMax', s(p.top10HoldPercentMax)],
    ['devHoldPercentMin', s(p.devHoldPercentMin)],
    ['devHoldPercentMax', s(p.devHoldPercentMax)],
    ['bundleHoldPercentMin', s(p.bundleHoldPercentMin)],
    ['bundleHoldPercentMax', s(p.bundleHoldPercentMax)],
    ['suspiciousHoldPercentMin', s(p.suspiciousHoldPercentMin)],
    ['suspiciousHoldPercentMax', s(p.suspiciousHoldPercentMax)],
    ['isLpBurnt', s(p.isLpBurnt)],
    ['isMint', s(p.isMint)],
    ['isFreeze', s(p.isFreeze)],
    ['limit', p.limit ?? '20'],
  ];
  return finalizeTokenPage(client, HOT_TOKEN_PATH, base, p.cursor ?? undefined, p.maxResults ?? undefined);
}

// upstream: token.rs::fetch_advanced_info — GET /api/v6/dex/market/token/advanced-info
export async function fetchAdvancedInfo(client, address, chainIndex) {
  return client.get(ADVANCED_INFO_PATH, [['chainIndex', chainIndex], ['tokenContractAddress', address]]);
}

// upstream: token.rs::fetch_top_trader — GET /api/v6/dex/market/token/top-trader (tagFilter: u8 | undefined)
export async function fetchTopTrader(client, address, chainIndex, tagFilter, limit, cursor, maxResults) {
  validateLimit(limit);
  const base = [
    ['chainIndex', chainIndex],
    ['tokenContractAddress', address],
    ['tagFilter', tagFilter === undefined || tagFilter === null ? '' : String(tagFilter)],
    ['limit', limit ?? '20'],
  ];
  return finalizeTokenPage(client, TOP_TRADER_PATH, base, cursor, maxResults);
}

// upstream: token.rs::fetch_token_trades — GET /api/v6/dex/market/trades (limit: u32)
export async function fetchTokenTrades(client, address, chainIndex, limit, tagFilter, walletFilter) {
  return client.get(TRADES_PATH, [
    ['chainIndex', chainIndex],
    ['tokenContractAddress', address],
    ['limit', String(limit)],
    ['tagFilter', tagFilter ?? ''],
    ['walletAddressFilter', walletFilter ?? ''],
  ]);
}

// upstream: token.rs::fetch_cluster_supported_chains — GET …/cluster/supported/chain
export async function fetchClusterSupportedChains(client) {
  return client.get(CLUSTER_SUPPORTED_CHAIN_PATH, []);
}

// upstream: token.rs::fetch_cluster_by_address — GET …/cluster/overview or …/cluster/list
export async function fetchClusterByAddress(client, path, address, chainIndex) {
  return client.get(path, [['chainIndex', chainIndex], ['tokenContractAddress', address]]);
}

// upstream: token.rs::fetch_cluster_top_holders — GET …/cluster/top-holders
export async function fetchClusterTopHolders(client, address, chainIndex, rangeFilter) {
  return client.get(CLUSTER_TOP_HOLDERS_PATH, [
    ['chainIndex', chainIndex],
    ['tokenContractAddress', address],
    ['rangeFilter', rangeFilter],
  ]);
}

// upstream: token.rs::fetch_report — info + price-info + advanced-info + security concurrently
// (tokio::join!); a failed sub-call becomes null silently; all four failing is an error.
export async function fetchReport(client, address, chainIndex) {
  const settle = (p) => p.then((v) => ({ ok: true, v }), () => ({ ok: false, v: null }));
  // info runs on `client`, the other three on their own clones (a refresh in a clone stays there)
  const [c1, c2, c3] = [cloneClient(client), cloneClient(client), cloneClient(client)];
  const [info, price, advanced, security] = await Promise.all([
    settle(fetchInfo(client, address, chainIndex)),
    settle(fetchPriceInfo(c1, address, chainIndex)),
    settle(fetchAdvancedInfo(c2, address, chainIndex)),
    settle(fetchSecurity(c3, address, chainIndex)),
  ]);
  if (!info.ok && !price.ok && !advanced.ok && !security.ok) {
    throw new Error(`token report: all sub-calls failed for address ${address} on chain ${chainIndex}`);
  }
  return composeReport(address, chainIndex, info.v, price.v, advanced.v, security.v);
}

// upstream: token.rs::compose_report — json! object (keys print sorted); sub-results verbatim
// (a nested `requestTime` passes through untouched).
export function composeReport(address, chainIndex, info, price, advanced, security) {
  return {
    address,
    chain: chainIndex,
    info: info ?? null,
    priceInfo: price ?? null,
    advancedInfo: advanced ?? null,
    security: security ?? null,
  };
}

// D.2 — `--chain` (leaf, shares its id with the global) resolved, else config default, else ethereum.
const addressChain = (ctx, o) => (o.chain !== undefined ? resolveChain(o.chain) : ctx.chainIndexOr('ethereum'));

// upstream: token.rs::cluster_by_address / cluster_top_holders / cluster_supported_chains call
// ctx.client_async() a second time (after execute() already built one).
const secondClient = () => ApiClient.create();

export default {
  'token search': {
    uses: ['query', 'chains', 'limit', 'cursor', 'maxResults'],
    async run(ctx, o) {
      const client = await ctx.api();
      if (trim(o.query) === '') throw new Error('Parameter --query cannot be empty');
      const chains = ctx.resolveChainsOr(o.chains, '1,501');
      return fetchSearch(client, o.query, chains, o.limit, o.cursor, o.maxResults);
    },
  },
  'token info': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchInfo(client, o.address, addressChain(ctx, o));
    },
  },
  'token holders': {
    uses: ['address', 'chain', 'tagFilter', 'limit', 'cursor', 'maxResults'],
    async run(ctx, o) {
      const tagFilter = typed(ctx.path, 'tagFilter', o.tagFilter, 'u8');
      const client = await ctx.api();
      return fetchHolders(client, o.address, addressChain(ctx, o), tagFilter, o.limit, o.cursor, o.maxResults);
    },
  },
  'token price-info': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchPriceInfo(client, o.address, addressChain(ctx, o));
    },
  },
  'token liquidity': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchLiquidity(client, o.address, addressChain(ctx, o));
    },
  },
  'token hot-tokens': {
    uses: HOT_FIELDS,
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchHotTokens(client, hotTokensParams(o));
    },
  },
  'token advanced-info': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchAdvancedInfo(client, o.address, addressChain(ctx, o));
    },
  },
  'token top-trader': {
    uses: ['address', 'chain', 'tagFilter', 'limit', 'cursor', 'maxResults'],
    async run(ctx, o) {
      const tagFilter = typed(ctx.path, 'tagFilter', o.tagFilter, 'u8');
      const client = await ctx.api();
      return fetchTopTrader(client, o.address, addressChain(ctx, o), tagFilter, o.limit, o.cursor, o.maxResults);
    },
  },
  'token trades': {
    uses: ['address', 'chain', 'limit', 'tagFilter', 'walletFilter'],
    async run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'u32');
      const client = await ctx.api();
      return fetchTokenTrades(client, o.address, addressChain(ctx, o), limit, o.tagFilter, o.walletFilter);
    },
  },
  // upstream: token.rs::cluster_by_address
  'token cluster-overview': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      await ctx.api();
      const chainIndex = addressChain(ctx, o);
      return fetchClusterByAddress(await secondClient(), CLUSTER_OVERVIEW_PATH, o.address, chainIndex);
    },
  },
  // upstream: token.rs::cluster_top_holders
  'token cluster-top-holders': {
    uses: ['address', 'chain', 'rangeFilter'],
    async run(ctx, o) {
      await ctx.api();
      const chainIndex = addressChain(ctx, o);
      return fetchClusterTopHolders(await secondClient(), o.address, chainIndex, o.rangeFilter);
    },
  },
  'token cluster-list': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      await ctx.api();
      const chainIndex = addressChain(ctx, o);
      return fetchClusterByAddress(await secondClient(), CLUSTER_LIST_PATH, o.address, chainIndex);
    },
  },
  // upstream: token.rs::cluster_supported_chains
  'token cluster-supported-chains': {
    uses: [],
    async run(ctx) {
      await ctx.api();
      return fetchClusterSupportedChains(await secondClient());
    },
  },
  'token report': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchReport(client, o.address, addressChain(ctx, o));
    },
  },
};
