// `onchainos mcp` — upstream cli/src/mcp/mod.rs: an MCP server (rmcp, stdio) exposing the
// read-mostly command surface as 88 tools. Each tool mirrors its upstream #[tool] body: the
// same defaults / pre-processing, then the same shared fetch fn (imported from the command
// module that owns it), then mcp::ok / mcp::err.
//
// Tool catalogue (names, descriptions, inputSchema) is served verbatim from lib/mcp-tools.json
// (captured from the upstream binary by tools/dump-mcp-tools.mjs); the same schemas drive the
// `Parameters<T>` deserialisation (lib/mcp/serde.mjs), so there is one definition per tool.
import { readFileSync } from 'node:fs';
import { stringify, struct, rawJson, toValue } from '../core/json.mjs';
import { drainEvents } from '../core/notify.mjs';
import { ApiClient } from '../core/http.mjs';
import { resolveChain, resolveChains } from '../core/chains.mjs';
import * as E from '../core/errors.mjs';
import { PRETTY, UPSTREAM_VERSION } from '../config.mjs';
import { SerdeError } from '../core/serde.mjs';
import { fromArguments, takesParams } from './serde.mjs';
import * as rmcp from './rmcp.mjs';

// ── catalogue ───────────────────────────────────────────────────────
const CATALOGUE = JSON.parse(readFileSync(new URL('../mcp-tools.json', import.meta.url), 'utf8'));
const TOOL_SCHEMAS = new Map(CATALOGUE.tools.map((t) => [t.name, t.inputSchema]));
// ToolRouter::list_all sorts by name (byte order); the capture already is, keep it explicit.
const LIST_TOOLS_JSON = `{"tools":${JSON.stringify([...CATALOGUE.tools].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))))}}`;

// ── result wrappers ─────────────────────────────────────────────────
const OK = (text) => ({ isError: false, text });
const ERR = (text) => ({ isError: true, text });
const errorText = (e) => (e && e.message !== undefined ? e.message : String(e));

// upstream: mod.rs::ok — bare data, or {"data","notifications"} when payment events are pending.
export function ok(data) {
  const events = drainEvents().map(toValue);
  const value = toValue(data === undefined ? null : data);
  const payload = events.length ? { data: value, notifications: events } : value;
  return OK(stringify(payload, PRETTY));
}

// anyhow `downcast_ref` also sees through `.context()` layers.
function downcast(e, C) {
  for (let x = e, n = 0; x && n < 64; x = x.cause, n++) if (x instanceof C) return x;
  return undefined;
}

// upstream: mod.rs::err — always drains notifications; structured payloads for the special
// error types (json! objects → sorted keys, compact), otherwise the `{e:#}` text.
export function err(e) {
  const events = drainEvents().map(toValue);
  const withEvents = (payload) => { if (events.length) payload.notifications = events; return ERR(stringify(payload)); };
  let c;
  if ((c = downcast(e, E.WalletPreviewConfirming))) {
    const payload = { confirming: true, scene: c.scene ?? '', preview: toValue(c.preview ?? null) };
    if (c.msg) payload.message = c.msg;
    if (c.next) payload.next = c.next;
    return withEvents(payload);
  }
  if ((c = downcast(e, E.Confirming))) {
    const payload = { confirming: true };
    if (c.msg) payload.message = c.msg;
    if (c.scene !== undefined && c.scene !== null) payload.scene = c.scene;
    if (c.next) payload.next = c.next;
    return withEvents(payload);
  }
  if ((c = downcast(e, E.DuplicateSubscription))) {
    return withEvents({ ok: false, data: toValue(c.data ?? null) });
  }
  if ((c = downcast(e, E.CodedError))) {
    const payload = { ok: false, error: c.message, errorCode: c.code };
    if (c.field !== undefined && c.field !== null) payload.errorField = c.field;
    if (c.data !== undefined && c.data !== null) payload.data = toValue(c.data);
    if (c.nextSteps !== undefined && c.nextSteps !== null) payload.nextSteps = toValue(c.nextSteps);
    return withEvents(payload);
  }
  const base = errorText(e);
  return events.length ? ERR(stringify({ error: base, notifications: events })) : ERR(base);
}

// `match fetch(..).await { Ok(data) => ok(data), Err(e) => err(e) }`
async function call(fetch) {
  let data;
  try { data = await fetch(); } catch (e) { return err(e); }
  return ok(data);
}

// ── shared client (McpServer.client: Arc<Mutex<ApiClient>>) ─────────
// Tools that lock it run one at a time in arrival order (tokio::sync::Mutex is FIFO); the payment
// and gas-station tools build their own wallet clients and never take the lock.
function sharedClient() {
  const client = ApiClient.sync();   // ApiClient::new(): keyring JWT (no expiry check) or anonymous
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn(client));
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// ── helpers mirroring the inline pre-processing of the tool bodies ──
const some = (v) => v !== undefined && v !== null;
// `p.chain.as_deref().map(resolve_chain).unwrap_or_else(|| resolve_chain(def))`
const chainOr = (chain, def) => resolveChain(some(chain) ? chain : def);
// memepump tools: `.unwrap_or_else(|| "501".to_string())` — the default is not resolved.
const chainOrLiteral = (chain, def) => (some(chain) ? resolveChain(chain) : def);
const optChain = (chain) => (some(chain) ? resolveChain(chain) : undefined);

const lazy = (spec) => { let m; return async () => (m ??= await import(spec)); };
const M = {
  payment: lazy('../payment/index.mjs'),
  a2a: lazy('../payment/a2a-pay.mjs'),
  token: lazy('../commands/token/token.mjs'),
  market: lazy('../commands/market/index.mjs'),
  signal: lazy('../commands/signal/index.mjs'),
  memepump: lazy('../commands/memepump/index.mjs'),
  social: lazy('../commands/social/index.mjs'),
  swap: lazy('../commands/swap/swap.mjs'),
  portfolio: lazy('../commands/portfolio/portfolio.mjs'),
  gateway: lazy('../commands/gateway/gateway.mjs'),
  tracker: lazy('../commands/tracker/index.mjs'),
  leaderboard: lazy('../commands/leaderboard/index.mjs'),
  crossChain: lazy('../commands/cross-chain/cross-chain.mjs'),
  tokenAlias: lazy('../core/token-alias.mjs'),
  defi: lazy('../commands/defi/index.mjs'),
  gasStation: lazy('../wallet/gas-station.mjs'),
  tokenResearch: lazy('../commands/workflow/token-research.mjs'),
  smartMoney: lazy('../commands/workflow/smart-money.mjs'),
  newTokens: lazy('../commands/workflow/new-tokens.mjs'),
  walletAnalysis: lazy('../commands/workflow/wallet-analysis.mjs'),
  wfPortfolio: lazy('../commands/workflow/portfolio.mjs'),
};

const MEMEPUMP_TOKEN_DEV_INFO = '/api/v6/dex/market/memepump/tokenDevInfo';
const MEMEPUMP_SIMILAR_TOKEN = '/api/v6/dex/market/memepump/similarToken';
const MEMEPUMP_TOKEN_BUNDLE_INFO = '/api/v6/dex/market/memepump/tokenBundleInfo';

// ── the tools (mod.rs #[tool_router] impl, registration order) ──────
// Each entry: async (p, locked) → {isError, text}; `p` holds the deserialised params struct
// (Rust field names, None → null), `locked(fn)` runs fn(client) holding the shared client.
export const TOOLS = {
  // Payment: two-phase quote/pay — own WalletApiClient, no shared-client lock.
  async payment_quote(p) {
    const { fetchQuote } = await M.payment();
    return call(() => fetchQuote(p.url, p.param, p.method, null));
  },
  async payment_pay(p) {
    const { fetchPay } = await M.payment();
    return call(() => fetchPay(p.payment_id, p.selected_index, p.param, p.yes));
  },
  async payment_decode_receipt(p) {
    const { fetchDecodeReceipt } = await M.payment();
    return call(() => fetchDecodeReceipt(p.header, p.receipt));
  },
  async payment_session(p) {
    const { fetchSession } = await M.payment();
    return call(() => fetchSession(p));
  },
  async payment_a2a_status(p) {
    const { fetchStatus } = await M.a2a();
    return call(() => fetchStatus(p.payment_id, p.wait));
  },

  async token_search(p, locked) {
    const { fetchSearch } = await M.token();
    const chains = some(p.chains) ? p.chains : '1,501';
    return locked((c) => call(() => fetchSearch(c, p.query, chains, p.limit, p.cursor, p.max_results)));
  },
  async token_info(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchInfo } = await M.token();
    return locked((c) => call(() => fetchInfo(c, p.address, ci)));
  },
  async token_holders(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchHolders } = await M.token();
    return locked((c) => call(() => fetchHolders(c, p.address, ci, p.tag_filter, p.limit, p.cursor, p.max_results)));
  },
  async token_price_info(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchPriceInfo } = await M.token();
    return locked((c) => call(() => fetchPriceInfo(c, p.address, ci)));
  },
  async market_price(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchPrice } = await M.market();
    return locked((c) => call(() => fetchPrice(c, p.address, ci)));
  },
  async market_prices(p, locked) {
    const defaultChain = chainOr(p.chain, 'ethereum');
    const { fetchPrices } = await M.market();
    return locked((c) => call(() => fetchPrices(c, p.tokens, defaultChain)));
  },
  async market_kline(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const bar = some(p.bar) ? p.bar : '1H';
    const limit = some(p.limit) ? p.limit : 100;
    const { fetchKline } = await M.market();
    return locked((c) => call(() => fetchKline(c, p.address, ci, bar, limit)));
  },
  async token_trades(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const limit = some(p.limit) ? p.limit : 100;
    const { fetchTokenTrades } = await M.token();
    return locked((c) => call(() => fetchTokenTrades(c, p.address, ci, limit, p.tag_filter, p.wallet_filter)));
  },
  async market_index(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchIndex } = await M.market();
    return locked((c) => call(() => fetchIndex(c, p.address, ci)));
  },
  async signal_chains(p, locked) {
    const { fetchChains } = await M.signal();
    return locked((c) => call(() => fetchChains(c)));
  },
  async signal_list(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchList } = await M.signal();
    return locked((c) => call(() => fetchList(c, ci, p.wallet_type, p.min_amount_usd, p.max_amount_usd, p.min_address_count,
      p.max_address_count, p.token_address, p.min_market_cap_usd, p.max_market_cap_usd, p.min_liquidity_usd,
      p.max_liquidity_usd, p.limit, p.cursor)));
  },
  async memepump_chains(p, locked) {
    const { fetchChains } = await M.memepump();
    return locked((c) => call(() => fetchChains(c)));
  },
  async memepump_tokens(p, locked) {
    const { fetchTokenList } = await M.memepump();
    return locked((c) => call(() => fetchTokenList(c, p)));
  },
  async memepump_token_details(p, locked) {
    const ci = chainOrLiteral(p.chain, '501');
    const { fetchTokenDetails } = await M.memepump();
    return locked((c) => call(() => fetchTokenDetails(c, p.address, ci, some(p.wallet_address) ? p.wallet_address : '')));
  },
  async memepump_token_dev_info(p, locked) {
    const ci = chainOrLiteral(p.chain, '501');
    const { fetchByAddress } = await M.memepump();
    return locked((c) => call(() => fetchByAddress(c, MEMEPUMP_TOKEN_DEV_INFO, p.address, ci)));
  },
  async memepump_similar_tokens(p, locked) {
    const ci = chainOrLiteral(p.chain, '501');
    const { fetchByAddress } = await M.memepump();
    return locked((c) => call(() => fetchByAddress(c, MEMEPUMP_SIMILAR_TOKEN, p.address, ci)));
  },
  async memepump_token_bundle_info(p, locked) {
    const ci = chainOrLiteral(p.chain, '501');
    const { fetchByAddress } = await M.memepump();
    return locked((c) => call(() => fetchByAddress(c, MEMEPUMP_TOKEN_BUNDLE_INFO, p.address, ci)));
  },
  async memepump_aped_wallet(p, locked) {
    const ci = chainOrLiteral(p.chain, '501');
    const { fetchApedWallet } = await M.memepump();
    return locked((c) => call(() => fetchApedWallet(c, p.address, ci, some(p.wallet_address) ? p.wallet_address : '')));
  },

  // Social: news / sentiment / vibe — the params structs pass through as-is.
  async social_news_latest(p, locked) {
    const { fetchNewsLatest } = await M.social();
    return locked((c) => call(() => fetchNewsLatest(c, p)));
  },
  async social_news_by_symbol(p, locked) {
    const { fetchNewsBySymbol } = await M.social();
    return locked((c) => call(() => fetchNewsBySymbol(c, p)));
  },
  async social_news_search(p, locked) {
    const { fetchNewsSearch } = await M.social();
    return locked((c) => call(() => fetchNewsSearch(c, p)));
  },
  async social_news_detail(p, locked) {
    const { fetchNewsDetail } = await M.social();
    return locked((c) => call(() => fetchNewsDetail(c, p)));
  },
  async social_news_platforms(p, locked) {
    const { fetchNewsPlatforms } = await M.social();
    return locked((c) => call(() => fetchNewsPlatforms(c)));
  },
  async social_sentiment_ranking(p, locked) {
    const { fetchSentimentRanking } = await M.social();
    return locked((c) => call(() => fetchSentimentRanking(c, p)));
  },
  async social_sentiment_symbol(p, locked) {
    const { fetchSentimentSymbol } = await M.social();
    return locked((c) => call(() => fetchSentimentSymbol(c, p)));
  },
  async social_vibe_timeline(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchVibeTimeline } = await M.social();
    return locked((c) => call(() => fetchVibeTimeline(c, ci, p.token_address, p.time_frame)));
  },
  async social_vibe_top_kols(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchVibeTopKols } = await M.social();
    return locked((c) => call(() => fetchVibeTopKols(c, ci, p.token_address, p.sort_by, p.time_frame, p.limit)));
  },

  async swap_chains(p, locked) {
    const { fetchChains } = await M.swap();
    return locked((c) => call(() => fetchChains(c)));
  },
  async swap_quote(p, locked) {
    const ci = resolveChain(p.chain);
    const swapMode = some(p.swap_mode) ? p.swap_mode : 'exactIn';
    const { fetchQuote, classifySwapResponse } = await M.swap();
    return locked((c) => call(async () => {
      const data = await fetchQuote(c, ci, p.from, p.to, p.amount, swapMode);
      classifySwapResponse(data);   // SW2: per-route action/reason, as on the CLI path
      return data;
    }));
  },
  async swap_swap(p, locked) {
    const ci = resolveChain(p.chain);
    const swapMode = some(p.swap_mode) ? p.swap_mode : 'exactIn';
    const gasLevel = some(p.gas_level) ? p.gas_level : 'average';
    const { fetchSwap, classifySwapResponse } = await M.swap();
    return locked((c) => call(async () => {
      const data = await fetchSwap(c, ci, p.from, p.to, p.amount, p.slippage, p.wallet, swapMode, gasLevel, p.tips, p.max_auto_slippage);
      classifySwapResponse(data);
      return data;
    }));
  },
  async swap_approve(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchApprove } = await M.swap();
    return locked((c) => call(() => fetchApprove(c, ci, p.token, p.amount)));
  },
  async swap_liquidity(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchLiquidity } = await M.swap();
    return locked((c) => call(() => fetchLiquidity(c, ci)));
  },

  async portfolio_chains(p, locked) {
    const { fetchChains } = await M.portfolio();
    return locked((c) => call(() => fetchChains(c)));
  },
  async portfolio_total_value(p, locked) {
    const { fetchTotalValue } = await M.portfolio();
    return locked((c) => call(() => fetchTotalValue(c, p.address, p.chains, p.asset_type, p.exclude_risk)));
  },
  async portfolio_all_balances(p, locked) {
    const { fetchAllBalances } = await M.portfolio();
    return locked((c) => call(() => fetchAllBalances(c, p.address, p.chains, p.exclude_risk, p.filter)));
  },
  async portfolio_token_balances(p, locked) {
    const { fetchTokenBalances } = await M.portfolio();
    return locked((c) => call(() => fetchTokenBalances(c, p.address, p.tokens, p.exclude_risk)));
  },

  async gateway_chains(p, locked) {
    const { fetchChains } = await M.gateway();
    return locked((c) => call(() => fetchChains(c)));
  },
  async gateway_gas(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchGas } = await M.gateway();
    return locked((c) => call(() => fetchGas(c, ci)));
  },
  async gateway_gas_limit(p, locked) {
    const ci = resolveChain(p.chain);
    const amount = some(p.amount) ? p.amount : '0';
    const { fetchGasLimit } = await M.gateway();
    return locked((c) => call(() => fetchGasLimit(c, ci, p.from, p.to, amount, p.data)));
  },
  async gateway_simulate(p, locked) {
    const ci = resolveChain(p.chain);
    const amount = some(p.amount) ? p.amount : '0';
    const { fetchSimulate } = await M.gateway();
    return locked((c) => call(() => fetchSimulate(c, ci, p.from, p.to, amount, p.data)));
  },
  async gateway_broadcast(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchBroadcast } = await M.gateway();
    return locked((c) => call(() => fetchBroadcast(c, ci, p.signed_tx, p.address, p.mev_protection)));
  },
  async gateway_orders(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchOrders } = await M.gateway();
    return locked((c) => call(() => fetchOrders(c, ci, p.address, p.order_id)));
  },

  // Token: liquidity / hot tokens / advanced info / top traders
  async token_liquidity(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchLiquidity } = await M.token();
    return locked((c) => call(() => fetchLiquidity(c, p.address, ci)));
  },
  async token_hot_tokens(p, locked) {
    const { fetchHotTokens } = await M.token();
    return locked((c) => call(() => fetchHotTokens(c, p)));
  },
  async token_advanced_info(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchAdvancedInfo } = await M.token();
    return locked((c) => call(() => fetchAdvancedInfo(c, p.address, ci)));
  },
  async token_top_trader(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchTopTrader } = await M.token();
    return locked((c) => call(() => fetchTopTrader(c, p.address, ci, p.tag_filter, p.limit, p.cursor, p.max_results)));
  },

  // Portfolio PnL
  async market_portfolio_supported_chains(p, locked) {
    const { fetchPortfolioSupportedChains } = await M.market();
    return locked((c) => call(() => fetchPortfolioSupportedChains(c)));
  },
  async market_portfolio_overview(p, locked) {
    const ci = resolveChain(p.chain);
    const timeFrame = some(p.time_frame) ? p.time_frame : '4';
    const { fetchPortfolioOverview } = await M.market();
    return locked((c) => call(() => fetchPortfolioOverview(c, ci, p.address, timeFrame)));
  },
  async market_portfolio_dex_history(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchPortfolioDexHistory } = await M.market();
    return locked((c) => call(() => fetchPortfolioDexHistory(c, ci, p.address, p.begin, p.end, p.since, p.limit, p.cursor, p.token, p.tx_type)));
  },
  async market_portfolio_recent_pnl(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchPortfolioRecentPnl } = await M.market();
    return locked((c) => call(() => fetchPortfolioRecentPnl(c, ci, p.address, p.limit, p.cursor)));
  },
  async market_portfolio_token_pnl(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchPortfolioTokenPnl } = await M.market();
    return locked((c) => call(() => fetchPortfolioTokenPnl(c, ci, p.address, p.token)));
  },

  async tracker_activities(p, locked) {
    const { resolveTrackerType, fetchActivities } = await M.tracker();
    const resolved = resolveTrackerType(p.tracker_type);
    if ((resolved === '3' || p.tracker_type === 'multi_address') && !some(p.wallet_address)) {
      return ERR('wallet_address is required when tracker_type is multi_address');
    }
    const ci = optChain(p.chain);
    return locked((c) => call(() => fetchActivities(c, p.tracker_type, p.wallet_address, p.trade_type, ci, p.min_volume,
      p.max_volume, p.min_holders, p.min_market_cap, p.max_market_cap, p.min_liquidity, p.max_liquidity)));
  },

  async leaderboard_chains(p, locked) {
    const { fetchChains } = await M.leaderboard();
    return locked((c) => call(() => fetchChains(c)));
  },
  async leaderboard_list(p, locked) {
    const ci = resolveChain(p.chain);
    const { resolveLeaderboardWalletType, fetchList } = await M.leaderboard();
    const walletType = some(p.wallet_type) ? resolveLeaderboardWalletType(p.wallet_type) : undefined;
    return locked((c) => call(() => fetchList(c, ci, p.time_frame, p.sort_by, walletType, p.min_realized_pnl_usd,
      p.max_realized_pnl_usd, p.min_win_rate_percent, p.max_win_rate_percent, p.min_txs, p.max_txs, p.min_tx_volume, p.max_tx_volume)));
  },

  // Token cluster
  async token_cluster_supported_chains(p, locked) {
    const { fetchClusterSupportedChains } = await M.token();
    return locked((c) => call(() => fetchClusterSupportedChains(c)));
  },
  async token_cluster_overview(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchClusterByAddress, CLUSTER_OVERVIEW_PATH } = await M.token();
    return locked((c) => call(() => fetchClusterByAddress(c, CLUSTER_OVERVIEW_PATH, p.address, ci)));
  },
  async token_cluster_top_holders(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchClusterTopHolders } = await M.token();
    return locked((c) => call(() => fetchClusterTopHolders(c, p.address, ci, p.range_filter)));
  },
  async token_cluster_list(p, locked) {
    const ci = chainOr(p.chain, 'ethereum');
    const { fetchClusterByAddress, CLUSTER_LIST_PATH } = await M.token();
    return locked((c) => call(() => fetchClusterByAddress(c, CLUSTER_LIST_PATH, p.address, ci)));
  },

  // Cross-chain
  async cross_chain_tokens(p, locked) {
    const from = optChain(p.from_chain), to = optChain(p.to_chain);
    const { fetchSupportedTokens } = await M.crossChain();
    return locked((c) => call(() => fetchSupportedTokens(c, from, to)));
  },
  async cross_chain_bridges(p, locked) {
    const from = optChain(p.from_chain), to = optChain(p.to_chain);
    const { fetchSupportedBridges } = await M.crossChain();
    return locked((c) => call(() => fetchSupportedBridges(c, from, to)));
  },
  async cross_chain_quote(p, locked) {
    const fromChainIndex = resolveChain(p.from_chain);
    const toChainIndex = resolveChain(p.to_chain);
    const { validateReceiveAddress, fetchQuote } = await M.crossChain();
    const { resolveAndValidate } = await M.tokenAlias();
    const { resolveAmountArg } = await M.swap();
    let fromToken, toToken;
    try {
      if (some(p.receive_address)) validateReceiveAddress(p.receive_address, toChainIndex);
      fromToken = resolveAndValidate(fromChainIndex, p.from, 'from');
      toToken = resolveAndValidate(toChainIndex, p.to, 'to');
    } catch (e) {
      return err(e);
    }
    // one guard across resolve_amount_arg + fetch_quote
    return locked(async (c) => {
      let rawAmount;
      try { rawAmount = await resolveAmountArg(c, null, p.readable_amount, fromToken, fromChainIndex); } catch (e) { return err(e); }
      return call(() => fetchQuote(c, fromChainIndex, toChainIndex, fromToken, toToken, rawAmount, '0.01', null, false, null,
        p.sort, null, null, p.receive_address));
    });
  },
  async cross_chain_status(p, locked) {
    const chainIdx = resolveChain(p.from_chain);
    const { resolveOrderIdToTxHash, fetchStatus } = await M.crossChain();
    let txHash;
    if (some(p.tx_hash) && !some(p.order_id)) txHash = p.tx_hash;
    else if (!some(p.tx_hash) && some(p.order_id)) {
      try { txHash = await resolveOrderIdToTxHash(p.order_id, chainIdx); } catch (e) { return err(e); }
    } else if (some(p.tx_hash)) return ERR('provide tx_hash OR order_id, not both');
    else return ERR('one of tx_hash or order_id is required');
    return locked((c) => call(() => fetchStatus(c, txHash, chainIdx, p.bridge_id)));
  },

  // DeFi
  async defi_support_chains(p, locked) {
    const { fetchChains } = await M.defi();
    return locked((c) => call(() => fetchChains(c)));
  },
  async defi_support_platforms(p, locked) {
    const { fetchProtocols } = await M.defi();
    return locked((c) => call(() => fetchProtocols(c)));
  },
  async defi_list(p, locked) {
    const { fetchSearch } = await M.defi();
    return locked((c) => call(() => fetchSearch(c, null, null, null, null, p.page_num)));
  },
  async defi_search(p, locked) {
    const ci = optChain(p.chain);
    const { fetchSearch } = await M.defi();
    return locked((c) => call(() => fetchSearch(c, p.token, p.platform, ci, p.product_group, p.page_num)));
  },
  async defi_detail(p, locked) {
    const { fetchDetail } = await M.defi();
    return locked((c) => call(() => fetchDetail(c, p.investment_id)));
  },
  async defi_rate_chart(p, locked) {
    const { fetchRateChart } = await M.defi();
    return locked((c) => call(() => fetchRateChart(c, p.investment_id, p.time_range)));
  },
  async defi_tvl_chart(p, locked) {
    const { fetchTvlChart } = await M.defi();
    return locked((c) => call(() => fetchTvlChart(c, p.investment_id, p.time_range)));
  },
  async defi_depth_price_chart(p, locked) {
    const { fetchDepthPriceChart } = await M.defi();
    return locked((c) => call(() => fetchDepthPriceChart(c, p.investment_id, p.chart_type, p.time_range)));
  },
  async defi_positions(p, locked) {
    const { fetchPositions } = await M.defi();
    return locked((c) => call(() => fetchPositions(c, p.address, p.chains)));
  },
  async defi_position_detail(p, locked) {
    const ci = resolveChain(p.chain);
    const { fetchPositionDetail } = await M.defi();
    return locked((c) => call(() => fetchPositionDetail(c, p.address, ci, p.platform_id)));
  },
  // One-step tools; `chain` of defi_invest is accepted but unused upstream.
  async defi_invest(p, locked) {
    const { cmdInvest } = await M.defi();
    return locked((c) => call(() => cmdInvest(c, p.investment_id, p.address, p.token, p.amount, p.token2, p.amount2,
      some(p.slippage) ? p.slippage : '0.01', p.token_id, p.tick_lower, p.tick_upper, p.range)));
  },
  async defi_withdraw(p, locked) {
    const { cmdWithdraw } = await M.defi();
    return locked((c) => call(() => cmdWithdraw(c, p.investment_id, p.address, p.chain, p.ratio, p.token_id,
      some(p.slippage) ? p.slippage : '0.01', p.amount, p.platform_id)));
  },
  async defi_collect(p, locked) {
    const { cmdCollect } = await M.defi();
    return locked((c) => call(() => cmdCollect(c, p.address, p.chain, p.reward_type, p.investment_id, p.platform_id,
      p.token_id, p.principal_index)));
  },

  // Gas Station — own WalletApiClient.
  async gas_station_update_default_token(p) {
    const { fetchUpdateDefaultToken } = await M.gasStation();
    return call(() => fetchUpdateDefaultToken(p.chain, p.gas_token_address));
  },
  async gas_station_enable(p) {
    const { fetchUpdate } = await M.gasStation();
    return call(() => fetchUpdate(p.chain, true));
  },
  async gas_station_disable(p) {
    const { fetchUpdate } = await M.gasStation();
    return call(() => fetchUpdate(p.chain, false));
  },

  // Workflows — chain defaults to solana (config default_chain is not consulted).
  async workflow_token_research(p, locked) {
    const ci = chainOr(p.chain, 'solana');
    const { searchAndSelect, fetchAndAssemble } = await M.tokenResearch();
    if (!some(p.address)) {
      if (!some(p.query)) return ERR("Either 'address' or 'query' is required");
      return locked((c) => call(() => searchAndSelect(c, p.query, ci)));
    }
    return locked((c) => call(() => fetchAndAssemble(c, p.address, ci)));
  },
  async workflow_smart_money(p, locked) {
    const ci = chainOr(p.chain, 'solana');
    const { fetchAndAssemble } = await M.smartMoney();
    return locked((c) => call(() => fetchAndAssemble(c, ci)));
  },
  async workflow_new_tokens(p, locked) {
    const ci = chainOr(p.chain, 'solana');
    const stage = some(p.stage) ? p.stage : 'MIGRATED';
    const { fetchAndAssemble } = await M.newTokens();
    return locked((c) => call(() => fetchAndAssemble(c, ci, stage)));
  },
  async workflow_wallet_analysis(p, locked) {
    const ci = chainOr(p.chain, 'solana');
    const { fetchAndAssemble } = await M.walletAnalysis();
    return locked((c) => call(() => fetchAndAssemble(c, p.address, ci)));
  },
  async workflow_portfolio(p, locked) {
    // chains resolved up-front so the output's `chains` is always the indexed form ("1,501")
    const chainsStr = resolveChains(some(p.chains) ? p.chains : '1,501');
    const { fetchAndAssemble } = await M.wfPortfolio();
    return locked((c) => call(() => fetchAndAssemble(c, p.address, chainsStr)));
  },
};

// ── McpServer: ServerHandler impl (get_info + #[tool_handler]) ──────
export function mcpServer() {
  const locked = sharedClient();
  return {
    // ServerInfo::new(caps.enable_tools()).with_server_info(Implementation::new("onchainos", CARGO_PKG_VERSION))
    getInfo(protocolVersion) {
      return struct({
        protocolVersion,
        capabilities: struct({ tools: struct({}) }),
        serverInfo: struct({ name: 'onchainos', version: UPSTREAM_VERSION }),
      });
    },
    listTools: () => rawJson(LIST_TOOLS_JSON),
    // handler/server.rs CallToolRequest branch + ToolRouter::call + Parameters<T> extraction.
    async callTool({ name, arguments: args, task }) {
      const schema = TOOL_SCHEMAS.get(name);
      const isTask = task !== null && task !== undefined;
      if (schema && isTask) throw new rmcp.RpcError(rmcp.INVALID_PARAMS, 'Tool does not support task-based invocation');
      if (isTask) throw new rmcp.RpcError(rmcp.INTERNAL_ERROR, 'Task processing not implemented');
      const tool = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : undefined;
      if (!schema || !tool) throw new rmcp.RpcError(rmcp.INVALID_PARAMS, 'tool not found');
      let p = null;
      if (takesParams(schema)) {
        try {
          p = fromArguments(schema, args ?? {});
        } catch (e) {
          if (e instanceof SerdeError) throw new rmcp.RpcError(rmcp.INVALID_PARAMS, `failed to deserialize parameters: ${e.message}`);
          throw e;
        }
      }
      let r;
      try { r = await tool(p, locked); } catch (e) { r = err(e); }
      return rmcp.callToolResult(r.text, r.isError);
    },
  };
}

// upstream: mod.rs::serve — McpServer::new()? then serve(stdio()) until the client disconnects.
export async function serve(io) {
  const server = mcpServer();
  try {
    await rmcp.serve(server, io);
  } catch (e) {
    if (e instanceof rmcp.InitializeError) throw new Error(e.message);
    throw e;
  }
}
