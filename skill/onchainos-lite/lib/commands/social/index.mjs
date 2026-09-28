// social — upstream cli/src/commands/social.rs (fetch helpers shared with MCP + CLI handlers).
// The Social*Params structs are plain objects keyed by their serde (snake_case) field names, null/undefined
// for None — exactly what MCP tool arguments deserialise to; the CLI handlers build them from the options.
import { resolveChain } from '../../core/chains.mjs';
import { cloneClient } from '../../core/http.mjs';
import { autoPaginate, CursorMode, invalidInput, nowMs, pageShape, parseMaxResults, resolveSinceWindow } from '../../core/sink.mjs';
import { isJsonObject, rustParams, some } from '../market/_g03.mjs';

// ── Compliance strip (vibe endpoints only) ───────────────────────────
const TWEET_BODY_FIELDS = ['text', 'content', 'translatedContent'];

// upstream: social.rs::strip_tweet_bodies (private) — recursively drop tweet-body keys, in place.
export function stripTweetBodies(v) {
  if (Array.isArray(v)) {
    for (const item of v) stripTweetBodies(item);
  } else if (isJsonObject(v)) {
    for (const f of TWEET_BODY_FIELDS) delete v[f];
    for (const child of Object.values(v)) stripTweetBodies(child);
  }
}

// upstream: social.rs::push_if_present / push_owned (private) — append only when Some and non-empty.
export function pushIfPresent(query, key, val) {
  if (some(val) && val !== '') query.push([key, val]);
}
export const pushOwned = pushIfPresent;

// serde_json::to_value(struct) → a Value: object keys print sorted (drops struct field order).
const toValue = (s) => ({ ...s });

// upstream: social.rs::finalize_news (private) — shared FR-1 (--since) + FR-3 (--max-results)
// logic of the three news list endpoints. `base` holds every endpoint param except begin/end/limit/cursor.
export async function finalizeNews(client, path, base, since, begin, end, limit, cursor, maxResults) {
  let window;
  if (some(since)) {
    const hasBegin = some(begin) && begin !== '';
    const hasEnd = some(end) && end !== '';
    if (hasBegin || hasEnd) throw invalidInput('since', '--since is mutually exclusive with --begin/--end');
    const now = nowMs();
    try { window = resolveSinceWindow(since, now); } catch (e) { throw invalidInput('since', e.message); }
    base.push(['begin', String(window.begin)]);
    base.push(['end', String(window.end)]);
  } else {
    pushOwned(base, 'begin', begin);
    pushOwned(base, 'end', end);
  }
  const resolved = () => ({ begin: window.begin, end: window.end });

  const max = parseMaxResults(some(maxResults) ? maxResults : null);
  if (max !== null) {
    const shape = pageShape('list', 'cursor', CursorMode.PageLevel);
    const baseClient = cloneClient(client);
    const agg = await autoPaginate(some(cursor) ? cursor : null, max, shape, (cur) => {
      const c = cloneClient(baseClient);   // every page starts from the base client's auth
      const q = [...base];
      if (some(limit) && limit !== '') q.push(['limit', limit]);
      if (cur !== null && cur !== undefined) q.push(['cursor', cur]);
      return c.get(path, q);
    });
    const data = toValue(agg);
    if (data.error) data.error = toValue(data.error);
    if (window) data.resolvedWindow = resolved();
    return data;
  }

  pushOwned(base, 'limit', limit);
  pushOwned(base, 'cursor', cursor);
  const data = await client.get(path, base);
  if (window && isJsonObject(data)) data.resolvedWindow = resolved();
  return data;
}

// upstream: social.rs::fetch_news_latest — p: SocialNewsLatestParams
export function fetchNewsLatest(client, p) {
  const base = [];
  pushOwned(base, 'tokenSymbols', p.token_symbols);
  pushOwned(base, 'importance', p.importance);
  pushOwned(base, 'platform', p.platform);
  pushOwned(base, 'detailLevel', p.detail_level);
  pushOwned(base, 'language', p.language);
  return finalizeNews(client, '/api/v6/dex/market/social/news/latest', base, p.since, p.begin, p.end, p.limit, p.cursor, p.max_results);
}

// upstream: social.rs::fetch_news_by_symbol — p: SocialNewsBySymbolParams
export function fetchNewsBySymbol(client, p) {
  const base = [['tokenSymbols', p.token_symbols]];
  pushOwned(base, 'sortBy', p.sort_by);
  pushOwned(base, 'sentiment', p.sentiment);
  pushOwned(base, 'importance', p.importance);
  pushOwned(base, 'platform', p.platform);
  pushOwned(base, 'detailLevel', p.detail_level);
  pushOwned(base, 'language', p.language);
  return finalizeNews(client, '/api/v6/dex/market/social/news/by-symbol', base, p.since, p.begin, p.end, p.limit, p.cursor, p.max_results);
}

// upstream: social.rs::fetch_news_search — p: SocialNewsSearchParams
export function fetchNewsSearch(client, p) {
  const base = [['keyword', p.keyword]];
  pushOwned(base, 'sortBy', p.sort_by);
  pushOwned(base, 'sentiment', p.sentiment);
  pushOwned(base, 'importance', p.importance);
  pushOwned(base, 'platform', p.platform);
  pushOwned(base, 'tokenSymbols', p.token_symbols);
  pushOwned(base, 'detailLevel', p.detail_level);
  pushOwned(base, 'language', p.language);
  return finalizeNews(client, '/api/v6/dex/market/social/news/search', base, p.since, p.begin, p.end, p.limit, p.cursor, p.max_results);
}

// upstream: social.rs::fetch_news_detail — p: SocialNewsDetailParams (full `content` kept)
export function fetchNewsDetail(client, p) {
  const q = [['articleId', p.article_id]];
  pushIfPresent(q, 'language', p.language);
  return client.get('/api/v6/dex/market/social/news/detail', q);
}

// upstream: social.rs::fetch_news_platforms
export function fetchNewsPlatforms(client) {
  return client.get('/api/v6/dex/market/social/news/platforms', []);
}

// upstream: social.rs::fetch_sentiment_ranking — p: SocialSentimentRankingParams
export function fetchSentimentRanking(client, p) {
  const q = [];
  pushIfPresent(q, 'timeFrame', p.time_frame);
  pushIfPresent(q, 'sortBy', p.sort_by);
  pushIfPresent(q, 'limit', p.limit);
  return client.get('/api/v6/dex/market/social/sentiment/ranking', q);
}

// upstream: social.rs::fetch_sentiment_symbol — p: SocialSentimentSymbolParams
export function fetchSentimentSymbol(client, p) {
  const q = [['tokenSymbols', p.token_symbols]];
  pushIfPresent(q, 'timeFrame', p.time_frame);
  pushIfPresent(q, 'trendPoints', p.trend_points);
  return client.get('/api/v6/dex/market/social/sentiment/symbol', q);
}

// upstream: social.rs::fetch_vibe_timeline — tweet bodies stripped (compliance).
export async function fetchVibeTimeline(client, chainIndex, tokenAddress, timeFrame) {
  const q = [['chainIndex', chainIndex], ['tokenAddress', tokenAddress]];
  pushIfPresent(q, 'timeFrame', timeFrame);
  const data = await client.get('/api/v6/dex/market/social/vibe/timeline', q);
  stripTweetBodies(data);
  return data;
}

// upstream: social.rs::fetch_vibe_top_kols — tweet bodies stripped (compliance).
export async function fetchVibeTopKols(client, chainIndex, tokenAddress, sortBy, timeFrame, limit) {
  const q = [['chainIndex', chainIndex], ['tokenAddress', tokenAddress]];
  pushIfPresent(q, 'sortBy', sortBy);
  pushIfPresent(q, 'timeFrame', timeFrame);
  pushIfPresent(q, 'limit', limit);
  const data = await client.get('/api/v6/dex/market/social/vibe/top-kols', q);
  stripTweetBodies(data);
  return data;
}

// upstream: social.rs::execute — each arm moves the clap fields into the *Params struct.
const NEWS_LATEST = ['tokenSymbols', 'begin', 'end', 'importance', 'platform', 'limit', 'cursor', 'detailLevel', 'language', 'since', 'maxResults'];
const NEWS_BY_SYMBOL = ['tokenSymbols', 'sortBy', 'sentiment', 'importance', 'platform', 'limit', 'cursor', 'detailLevel', 'begin', 'end', 'language', 'since', 'maxResults'];
const NEWS_SEARCH = ['keyword', 'sortBy', 'sentiment', 'importance', 'platform', 'tokenSymbols', 'begin', 'end', 'detailLevel', 'limit', 'cursor', 'language', 'since', 'maxResults'];
const NEWS_DETAIL = ['articleId', 'language'];
const SENTIMENT_RANKING = ['timeFrame', 'sortBy', 'limit'];
const SENTIMENT_SYMBOL = ['tokenSymbols', 'timeFrame', 'trendPoints'];

export default {
  'social news-latest': {
    uses: NEWS_LATEST,
    async run(ctx, o) {
      const p = rustParams(o, NEWS_LATEST);
      return fetchNewsLatest(await ctx.api(), p);
    },
  },
  'social news-by-symbol': {
    uses: NEWS_BY_SYMBOL,
    async run(ctx, o) {
      const p = rustParams(o, NEWS_BY_SYMBOL);
      return fetchNewsBySymbol(await ctx.api(), p);
    },
  },
  'social news-search': {
    uses: NEWS_SEARCH,
    async run(ctx, o) {
      const p = rustParams(o, NEWS_SEARCH);
      return fetchNewsSearch(await ctx.api(), p);
    },
  },
  'social news-detail': {
    uses: NEWS_DETAIL,
    async run(ctx, o) {
      const p = rustParams(o, NEWS_DETAIL);
      return fetchNewsDetail(await ctx.api(), p);
    },
  },
  'social news-platforms': {
    uses: [],
    async run(ctx) {
      return fetchNewsPlatforms(await ctx.api());
    },
  },
  'social sentiment-ranking': {
    uses: SENTIMENT_RANKING,
    async run(ctx, o) {
      const p = rustParams(o, SENTIMENT_RANKING);
      return fetchSentimentRanking(await ctx.api(), p);
    },
  },
  'social sentiment-symbol': {
    uses: SENTIMENT_SYMBOL,
    async run(ctx, o) {
      const p = rustParams(o, SENTIMENT_SYMBOL);
      return fetchSentimentSymbol(await ctx.api(), p);
    },
  },
  'social vibe-timeline': {
    uses: ['chain', 'tokenAddress', 'timeFrame'],
    async run(ctx, o) {
      const ci = resolveChain(o.chain);
      const api = await ctx.api();
      return fetchVibeTimeline(api, ci, o.tokenAddress, o.timeFrame);
    },
  },
  'social vibe-top-kols': {
    uses: ['chain', 'tokenAddress', 'sortBy', 'timeFrame', 'limit'],
    async run(ctx, o) {
      const ci = resolveChain(o.chain);
      const api = await ctx.api();
      return fetchVibeTopKols(api, ci, o.tokenAddress, o.sortBy, o.timeFrame, o.limit);
    },
  },
};
