// market — upstream cli/src/commands/market.rs (the whole file: fetch helpers + CLI handlers).
// The exported fetch* functions are shared with MCP / workflows / strategy (mirror rule:
// camelCase of the Rust fn, same parameter order; `client` is an ApiClient).
import { resolveChain } from '../../core/chains.mjs';
import { ApiClient } from '../../core/http.mjs';
import { invalidInput, nowMs, resolveSinceWindow } from '../../core/sink.mjs';
import { trim } from '../../core/_rust-str.mjs';
import { clapTyped, isJsonObject, some } from './_g03.mjs';

const PRICE_PATH = '/api/v6/dex/market/price';

// upstream: market.rs::fetch_price — POST /api/v6/dex/market/price, body is a JSON array.
export function fetchPrice(client, address, chainIndex) {
  return client.post(PRICE_PATH, [{ chainIndex, tokenContractAddress: address }]);
}

// upstream: market.rs::fetch_prices — batch query from "chain:addr,addr,…".
export function fetchPrices(client, tokens, defaultChainIndex) {
  const items = String(tokens).split(',').map((piece) => {
    const pair = trim(piece);
    const i = pair.indexOf(':');
    if (i >= 0) return { chainIndex: resolveChain(pair.slice(0, i)), tokenContractAddress: pair.slice(i + 1) };
    return { chainIndex: defaultChainIndex, tokenContractAddress: pair };
  });
  return client.post(PRICE_PATH, items);
}

const KLINE_FIELDS = ['ts', 'o', 'h', 'l', 'c', 'vol', 'volUsd', 'confirm'];

// upstream: market.rs::kline_to_named_objects (private) — candle arrays → named objects.
export function klineToNamedObjects(data) {
  if (!Array.isArray(data)) return data;
  return data.map((candle) => {
    if (!Array.isArray(candle)) return candle;
    const map = {};
    candle.forEach((val, i) => { map[KLINE_FIELDS[i] ?? 'unknown'] = val; });
    return map;
  });
}

// upstream: market.rs::fetch_kline — GET /api/v6/dex/market/candles + named-object transform.
export async function fetchKline(client, address, chainIndex, bar, limit) {
  const raw = await client.get('/api/v6/dex/market/candles', [
    ['chainIndex', chainIndex],
    ['tokenContractAddress', address],
    ['bar', bar],
    ['limit', String(limit)],
  ]);
  return klineToNamedObjects(raw);
}

// upstream: market.rs::fetch_index — POST /api/v6/dex/index/current-price.
export function fetchIndex(client, address, chainIndex) {
  return client.post('/api/v6/dex/index/current-price', [{ chainIndex, tokenContractAddress: address }]);
}

// upstream: market.rs::fetch_portfolio_supported_chains
export function fetchPortfolioSupportedChains(client) {
  return client.get('/api/v6/dex/market/portfolio/supported/chain', []);
}

// upstream: market.rs::fetch_portfolio_overview
export function fetchPortfolioOverview(client, chainIndex, address, timeFrame) {
  return client.get('/api/v6/dex/market/portfolio/overview', [
    ['chainIndex', chainIndex],
    ['walletAddress', address],
    ['timeFrame', timeFrame],
  ]);
}

// upstream: market.rs::fetch_portfolio_dex_history — exactly one of `since` XOR (`begin` AND `end`);
// with `since` the resolved window is echoed as data.resolvedWindow (object data only).
export async function fetchPortfolioDexHistory(client, chainIndex, address, begin, end, since, limit, cursor, token, txType) {
  const b = some(begin) && begin !== '' ? begin : undefined;
  const e = some(end) && end !== '' ? end : undefined;
  let window;
  let beginVal, endVal;
  if (some(since) && since !== '') {
    if (b !== undefined || e !== undefined) throw invalidInput('since', '--since is mutually exclusive with --begin/--end');
    const now = nowMs();
    try { window = resolveSinceWindow(since, now); } catch (err) { throw invalidInput('since', err.message); }
    beginVal = String(window.begin);
    endVal = String(window.end);
  } else if (b !== undefined && e !== undefined) {
    beginVal = b;
    endVal = e;
  } else {
    throw invalidInput('since', 'supply --since <dur> OR --begin+--end');
  }
  const query = [['chainIndex', chainIndex], ['walletAddress', address], ['begin', beginVal], ['end', endVal]];
  if (some(limit)) query.push(['limit', limit]);
  if (some(cursor)) query.push(['cursor', cursor]);
  if (some(token)) query.push(['tokenContractAddress', token]);
  if (some(txType)) query.push(['type', txType]);
  const data = await client.get('/api/v6/dex/market/portfolio/dex-history', query);
  if (window && isJsonObject(data)) data.resolvedWindow = { begin: window.begin, end: window.end };
  return data;
}

// upstream: market.rs::fetch_portfolio_recent_pnl
export function fetchPortfolioRecentPnl(client, chainIndex, address, limit, cursor) {
  const query = [['chainIndex', chainIndex], ['walletAddress', address]];
  if (some(limit)) query.push(['limit', limit]);
  if (some(cursor)) query.push(['cursor', cursor]);
  return client.get('/api/v6/dex/market/portfolio/recent-pnl', query);
}

// upstream: market.rs::fetch_portfolio_token_pnl
export function fetchPortfolioTokenPnl(client, chainIndex, address, token) {
  return client.get('/api/v6/dex/market/portfolio/token/latest-pnl', [
    ['chainIndex', chainIndex],
    ['walletAddress', address],
    ['tokenContractAddress', token],
  ]);
}

// ── CLI handlers (market.rs::execute) ────────────────────────────────
// execute() builds a client (ctx.client_async) before matching any subcommand; the
// portfolio_* wrappers then build a second one (ApiClient::new_async) — kept 1:1 so an
// expired-JWT refresh (and its stderr warning) happens exactly as often as upstream.

const chainOr = (ctx, chain, def) => (chain !== undefined ? resolveChain(chain) : ctx.chainIndexOr(def));

export default {
  'market price': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const api = await ctx.api();
      const address = trim(o.address);
      if (!address) throw new Error('Parameter --address cannot be empty');
      const ci = chainOr(ctx, o.chain, 'ethereum');
      const result = await fetchPrice(api, address, ci);
      if (Array.isArray(result) && result.length === 0) {
        throw new Error(`No price data found for address ${address} on chain ${ci}. Verify the token address is valid on this chain.`);
      }
      return result;
    },
  },
  'market prices': {
    uses: ['tokens', 'chain'],
    async run(ctx, o) {
      const api = await ctx.api();
      return fetchPrices(api, o.tokens, chainOr(ctx, o.chain, 'ethereum'));
    },
  },
  'market kline': {
    uses: ['address', 'bar', 'limit', 'chain'],
    async run(ctx, o) {
      const limit = clapTyped(ctx, 'limit', o.limit, 'u32');   // clap u32 value parser
      const api = await ctx.api();
      return fetchKline(api, o.address, chainOr(ctx, o.chain, 'ethereum'), o.bar, limit);
    },
  },
  'market index': {
    uses: ['address', 'chain'],
    async run(ctx, o) {
      const api = await ctx.api();
      return fetchIndex(api, o.address, chainOr(ctx, o.chain, 'ethereum'));
    },
  },
  'market portfolio-supported-chains': {
    uses: [],
    async run(ctx) {
      await ctx.api();
      return fetchPortfolioSupportedChains(await ApiClient.create());
    },
  },
  'market portfolio-overview': {
    uses: ['address', 'chain', 'timeFrame'],
    async run(ctx, o) {
      await ctx.api();
      const ci = resolveChain(o.chain);
      return fetchPortfolioOverview(await ApiClient.create(), ci, o.address, o.timeFrame);
    },
  },
  'market portfolio-dex-history': {
    uses: ['address', 'chain', 'begin', 'end', 'since', 'limit', 'cursor', 'token', 'txType'],
    async run(ctx, o) {
      await ctx.api();
      const ci = resolveChain(o.chain);
      return fetchPortfolioDexHistory(await ApiClient.create(), ci, o.address, o.begin, o.end, o.since, o.limit, o.cursor, o.token, o.txType);
    },
  },
  'market portfolio-recent-pnl': {
    uses: ['address', 'chain', 'limit', 'cursor'],
    async run(ctx, o) {
      await ctx.api();
      const ci = resolveChain(o.chain);
      return fetchPortfolioRecentPnl(await ApiClient.create(), ci, o.address, o.limit, o.cursor);
    },
  },
  'market portfolio-token-pnl': {
    uses: ['address', 'chain', 'token'],
    async run(ctx, o) {
      await ctx.api();
      const ci = resolveChain(o.chain);
      return fetchPortfolioTokenPnl(await ApiClient.create(), ci, o.address, o.token);
    },
  },
};
