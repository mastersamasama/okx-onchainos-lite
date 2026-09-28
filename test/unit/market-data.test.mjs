// G-market (g03): market.rs, signal.rs, social.rs, memepump.rs, leaderboard.rs, tracker.rs.
// Every upstream #[cfg(test)] assertion of those files is ported, plus request-shape and
// edge-case checks taken from the Rust source (query order, Option vs "" semantics, errors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated empty state dir (resolve_chain reads chain_cache.json) — before importing lib modules.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-market-data-'));
process.env.OCL_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const CMD = '../../skill/onchainos-lite/lib/commands/';
const M = await import(CMD + 'market/index.mjs');
const SIG = await import(CMD + 'signal/index.mjs');
const SOC = await import(CMD + 'social/index.mjs');
const MP = await import(CMD + 'memepump/index.mjs');
const LB = await import(CMD + 'leaderboard/index.mjs');
const TR = await import(CMD + 'tracker/index.mjs');
const G = await import(CMD + 'market/_g03.mjs');
const { stringify, parse, F64 } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { CodedError } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');

// Mock ApiClient: records calls, answers from a queue (value or Error) or a function.
function mockClient(answers = []) {
  const calls = [];
  const next = (method, path, arg) => {
    calls.push({ method, path, arg });
    const a = typeof answers === 'function' ? answers(method, path, arg, calls.length) : answers.shift();
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a === undefined ? null : a);
  };
  return { calls, get: (p, q) => next('GET', p, q), post: (p, b) => next('POST', p, b) };
}
// Query pairs as the client would send them (core drops "" / undefined / null values).
const sent = (q) => q.filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('&');
const rejects = async (p, check) => {
  try { await p; } catch (e) { check(e); return; }
  assert.fail('expected a rejection');
};

// ═════════════════════════════ market.rs ═════════════════════════════

test('market: request_time_survives_kline_transform (upstream)', () => {
  const v = { requestTime: 1721000000000, candles: [] };
  const out = M.klineToNamedObjects(v);
  assert.deepEqual(out, v);
  assert.equal(out.requestTime, 1721000000000);
});

test('market: kline_transform_names_candle_array_fields (upstream)', () => {
  const out = M.klineToNamedObjects([['1700000000000', '1.0', '2.0', '0.5', '1.5', '10', '15', '1']]);
  assert.equal(out[0].ts, '1700000000000');
  assert.equal(out[0].o, '1.0');
  assert.equal(out[0].confirm, '1');
  assert.equal(stringify(out), '[{"c":"1.5","confirm":"1","h":"2.0","l":"0.5","o":"1.0","ts":"1700000000000","vol":"10","volUsd":"15"}]');
});

test('market: kline transform — extra fields map to "unknown" (last wins), non-arrays untouched', () => {
  const data = parse('[["1","2","3","4","5","6","7","8","x","y"],{"a":1},"s",[],[1.0]]');
  const out = M.klineToNamedObjects(data);
  assert.equal(out[0].unknown, 'y');
  assert.deepEqual(out[1], { a: 1 });
  assert.equal(out[2], 's');
  assert.deepEqual(out[3], {});
  assert.equal(stringify(out[4]), '{"ts":1.0}');
  assert.equal(M.klineToNamedObjects(null), null);
  assert.equal(M.klineToNamedObjects('x'), 'x');
});

test('market: fetch_price / fetch_index bodies', async () => {
  const c = mockClient([[], []]);
  await M.fetchPrice(c, '0xabc', '1');
  await M.fetchIndex(c, '', '501');
  assert.equal(c.calls[0].path, '/api/v6/dex/market/price');
  assert.equal(stringify(c.calls[0].arg), '[{"chainIndex":"1","tokenContractAddress":"0xabc"}]');
  assert.equal(c.calls[1].path, '/api/v6/dex/index/current-price');
  assert.equal(stringify(c.calls[1].arg), '[{"chainIndex":"501","tokenContractAddress":""}]');
});

test('market: fetch_prices splits on "," and the first ":" (chain resolved, pieces trimmed)', async () => {
  const c = mockClient([[]]);
  await M.fetchPrices(c, 'ethereum:0xA0b8, 0xC02a ,501:So1:x,, sol :y', '56');
  assert.deepEqual(c.calls[0].arg, [
    { chainIndex: '1', tokenContractAddress: '0xA0b8' },
    { chainIndex: '56', tokenContractAddress: '0xC02a' },
    { chainIndex: '501', tokenContractAddress: 'So1:x' },
    { chainIndex: '56', tokenContractAddress: '' },
    { chainIndex: 'sol ', tokenContractAddress: 'y' },
  ]);
});

test('market: fetch_kline query order and limit rendering', async () => {
  const c = mockClient([null]);
  assert.equal(await M.fetchKline(c, 'So1', '501', '1H', 5), null);
  assert.equal(c.calls[0].path, '/api/v6/dex/market/candles');
  assert.equal(sent(c.calls[0].arg), 'chainIndex=501&tokenContractAddress=So1&bar=1H&limit=5');
});

test('market: portfolio overview / recent-pnl / token-pnl / supported chains queries', async () => {
  const c = mockClient([1, 2, 3, 4, 5]);
  await M.fetchPortfolioSupportedChains(c);
  await M.fetchPortfolioOverview(c, '1', '0xw', '4');
  await M.fetchPortfolioRecentPnl(c, '1', '0xw', undefined, undefined);
  await M.fetchPortfolioRecentPnl(c, '1', '0xw', '5', 'abc');
  await M.fetchPortfolioTokenPnl(c, '1', '0xw', '0xt');
  assert.deepEqual(c.calls.map((x) => x.path), [
    '/api/v6/dex/market/portfolio/supported/chain', '/api/v6/dex/market/portfolio/overview',
    '/api/v6/dex/market/portfolio/recent-pnl', '/api/v6/dex/market/portfolio/recent-pnl', '/api/v6/dex/market/portfolio/token/latest-pnl',
  ]);
  assert.deepEqual(c.calls.map((x) => sent(x.arg)), [
    '', 'chainIndex=1&walletAddress=0xw&timeFrame=4', 'chainIndex=1&walletAddress=0xw',
    'chainIndex=1&walletAddress=0xw&limit=5&cursor=abc', 'chainIndex=1&walletAddress=0xw&tokenContractAddress=0xt',
  ]);
});

test('market: fetch_portfolio_dex_history window validation (CodedError, no request)', async () => {
  const c = mockClient([]);
  const coded = (msg) => (e) => { assert.ok(e instanceof CodedError); assert.equal(e.code, 'invalid_input'); assert.equal(e.field, 'since'); assert.equal(e.message, msg); };
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', '1', undefined, '24h'), coded('--since is mutually exclusive with --begin/--end'));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, '2', 'bogus'), coded('--since is mutually exclusive with --begin/--end'));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', '1', undefined, undefined), coded('supply --since <dur> OR --begin+--end'));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', '', '2', ''), coded('supply --since <dur> OR --begin+--end'));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, undefined, '0'), coded("invalid --since '0'; duration must be positive"));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, undefined, '10'), coded("invalid --since '10'; use e.g. 300s, 30m, 24h, 7d"));
  await rejects(M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, undefined, '18446744073709551615d'), coded("--since '18446744073709551615d' overflows"));
  assert.equal(c.calls.length, 0);
});

test('market: fetch_portfolio_dex_history absolute window + optional params order', async () => {
  const c = mockClient([{ a: 1 }]);
  const out = await M.fetchPortfolioDexHistory(c, '1', '0xw', '100', '200', '', '5', 'c1', '0xt', '1,2');
  assert.equal(sent(c.calls[0].arg), 'chainIndex=1&walletAddress=0xw&begin=100&end=200&limit=5&cursor=c1&tokenContractAddress=0xt&type=1,2');
  assert.deepEqual(out, { a: 1 });   // no resolvedWindow without --since
});

test('market: fetch_portfolio_dex_history --since window + resolvedWindow (objects only)', async () => {
  const before = Date.now();
  const c = mockClient([{ cursor: 'x' }, [], null]);
  const out = await M.fetchPortfolioDexHistory(c, '1', '0xw', '', '', '24h');
  const q = Object.fromEntries(c.calls[0].arg);
  assert.equal(Number(q.end) - Number(q.begin), 86400000);
  assert.ok(Number(q.end) >= before && Number(q.end) <= Date.now());
  assert.deepEqual(out.resolvedWindow, { begin: Number(q.begin), end: Number(q.end) });
  assert.match(stringify(out), /^\{"cursor":"x","resolvedWindow":\{"begin":\d+,"end":\d+\}\}$/);
  assert.deepEqual(await M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, undefined, '1h'), []);
  assert.equal(await M.fetchPortfolioDexHistory(c, '1', '0xw', undefined, undefined, '1s'), null);
});

// ═════════════════════════════ signal.rs ═════════════════════════════

test('signal: fetch_list body (json! → sorted keys, default limit "20", Some("") kept)', async () => {
  const c = mockClient([[], []]);
  await SIG.fetchList(c, '1');
  assert.equal(c.calls[0].path, '/api/v6/dex/market/signal/list');
  assert.equal(stringify(c.calls[0].arg), '{"chainIndex":"1","limit":"20"}');
  await SIG.fetchList(c, '501', '1,2', '0', 'b', 'c', 'd', 'e', 'f', '', 'h', 'i', '3', 'abc');
  assert.equal(stringify(c.calls[1].arg),
    '{"chainIndex":"501","cursor":"abc","limit":"3","maxAddressCount":"d","maxAmountUsd":"b","maxLiquidityUsd":"i","maxMarketCapUsd":"","minAddressCount":"c","minAmountUsd":"0","minLiquidityUsd":"h","minMarketCapUsd":"f","tokenAddress":"e","walletType":"1,2"}');
});

test('signal: fetch_list --limit validation (Rust u64 parse, 1..=100)', () => {
  const c = mockClient([]);
  const lim = (l) => { try { SIG.fetchList(c, '1', ...Array(10).fill(undefined), l, undefined); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(lim('0'), '--limit must be between 1 and 100, got 0');
  assert.equal(lim('101'), '--limit must be between 1 and 100, got 101');
  assert.equal(lim('18446744073709551615'), '--limit must be between 1 and 100, got 18446744073709551615');
  for (const bad of ['x', '', ' 5', '5 ', '-1', '1.0', '18446744073709551616']) assert.equal(lim(bad), '--limit must be a number between 1 and 100', bad);
  assert.equal(lim('+007'), 'ok');
  assert.equal(lim('100'), 'ok');
  assert.equal(c.calls.at(-1).arg.limit, '100');
  lim('+007');
  assert.equal(c.calls.at(-1).arg.limit, '+007');
});

test('signal: fetch_chains', async () => {
  const c = mockClient([[]]);
  await SIG.fetchChains(c);
  assert.equal(c.calls[0].path, '/api/v6/dex/market/signal/supported/chain');
});

// ═════════════════════════════ leaderboard.rs / tracker.rs ═════════════════════════════

test('leaderboard: resolve_leaderboard_wallet_type is exact and case-sensitive', () => {
  const m = { smartMoney: '1', influencer: '2', sniper: '3', dev: '4', fresh: '5', pump: '6', SmartMoney: 'SmartMoney', '1': '1', '': '', toString: 'toString', constructor: 'constructor' };
  for (const [k, v] of Object.entries(m)) assert.equal(LB.resolveLeaderboardWalletType(k), v);
});

test('leaderboard: fetch_list query order; Some("") pushed (then dropped by the client)', async () => {
  const c = mockClient([[], []]);
  await LB.fetchList(c, '1', '3', '1');
  assert.equal(sent(c.calls[0].arg), 'chainIndex=1&timeFrame=3&sortBy=1');
  await LB.fetchList(c, '56', '5', '5', '6', 'a', 'b', 'c', '', 'e', 'f', 'g', 'h');
  assert.equal(sent(c.calls[1].arg), 'chainIndex=56&timeFrame=5&sortBy=5&walletType=6&minRealizedPnlUsd=a&maxRealizedPnlUsd=b&minWinRatePercent=c&minTxs=e&maxTxs=f&minTxVolume=g&maxTxVolume=h');
  assert.equal(c.calls[1].arg.length, 12);
  assert.equal(c.calls[1].path, '/api/v6/dex/market/leaderboard/list');
});

test('tracker: resolve_tracker_type is exact', () => {
  const m = { smart_money: '1', kol: '2', multi_address: '3', Smart_Money: 'Smart_Money', '3': '3', hasOwnProperty: 'hasOwnProperty' };
  for (const [k, v] of Object.entries(m)) assert.equal(TR.resolveTrackerType(k), v);
});

test('tracker: fetch_activities resolves the type and keeps upstream query order', async () => {
  const c = mockClient([[]]);
  await TR.fetchActivities(c, 'kol', 'w1,w2', '1', '501', 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  assert.equal(c.calls[0].path, '/api/v6/dex/market/address-tracker/trades');
  assert.equal(sent(c.calls[0].arg), 'trackerType=2&walletAddress=w1,w2&tradeType=1&chainIndex=501&minVolume=a&maxVolume=b&minHolders=c&minMarketCap=d&maxMarketCap=e&minLiquidity=f&maxLiquidity=g');
});

// ═════════════════════════════ social.rs ═════════════════════════════

test('social: strip_removes_forbidden_fields_recursively (upstream)', () => {
  const v = { summary: { score: '78', text: 'leak' }, kols: [{ handle: 'a', content: 'leak', tweetUrl: 'https://x.com/a/1' }, { handle: 'b', translatedContent: 'leak' }], ts: 1 };
  SOC.stripTweetBodies(v);
  assert.equal(v.summary.text, undefined);
  assert.equal(v.summary.score, '78');
  assert.equal(v.kols[0].content, undefined);
  assert.equal(v.kols[0].tweetUrl, 'https://x.com/a/1');
  assert.equal(v.kols[1].translatedContent, undefined);
  assert.equal(v.ts, 1);
});

test('social: strip_is_noop_on_clean_response (upstream)', () => {
  const v = { summary: { score: '50' }, timeline: [{ ts: 1, score: '40', kols: [{ handle: 'x' }] }] };
  const snapshot = structuredClone(v);
  SOC.stripTweetBodies(v);
  assert.deepEqual(v, snapshot);
});

test('social: request_time_survives_strip_tweet_bodies (upstream) + nested arrays / scalars', () => {
  const v = parse('{"requestTime":1721000000000,"ts":1721000000000,"list":[{"content":"leak","handle":"a"}],"deep":[[{"text":"t","n":1.0}]],"text":"top"}');
  SOC.stripTweetBodies(v);
  assert.equal(stringify(v), '{"deep":[[{"n":1.0}]],"list":[{"handle":"a"}],"requestTime":1721000000000,"ts":1721000000000}');
  for (const s of [null, 'text', 1, new F64('1.5')]) assert.doesNotThrow(() => SOC.stripTweetBodies(s));
});

test('social: push_if_present only appends Some non-empty values', () => {
  const q = [];
  SOC.pushIfPresent(q, 'a', undefined);
  SOC.pushIfPresent(q, 'b', null);
  SOC.pushIfPresent(q, 'c', '');
  SOC.pushIfPresent(q, 'd', 'x');
  SOC.pushOwned(q, 'e', '0');
  assert.deepEqual(q, [['d', 'x'], ['e', '0']]);
});

test('social: news param order (latest / by-symbol / search) — single page', async () => {
  const c = mockClient([{}, {}, {}]);
  await SOC.fetchNewsLatest(c, { token_symbols: 'BTC', begin: '1', end: '2', importance: '1', platform: 'p', limit: '5', cursor: 'c', detail_level: '2', language: 'zh' });
  await SOC.fetchNewsBySymbol(c, { token_symbols: '', sort_by: '2', sentiment: '1', importance: '3', platform: 'p', limit: '5', cursor: 'c', detail_level: '1', begin: '1', end: '2', language: 'l' });
  await SOC.fetchNewsSearch(c, { keyword: 'k w', sort_by: '1', sentiment: '3', importance: '2', platform: 'p', token_symbols: 'S', begin: '1', end: '2', detail_level: '2', limit: '9', cursor: 'c', language: 'l' });
  assert.deepEqual(c.calls.map((x) => x.path), ['/api/v6/dex/market/social/news/latest', '/api/v6/dex/market/social/news/by-symbol', '/api/v6/dex/market/social/news/search']);
  assert.equal(sent(c.calls[0].arg), 'tokenSymbols=BTC&importance=1&platform=p&detailLevel=2&language=zh&begin=1&end=2&limit=5&cursor=c');
  assert.equal(sent(c.calls[1].arg), 'sortBy=2&sentiment=1&importance=3&platform=p&detailLevel=1&language=l&begin=1&end=2&limit=5&cursor=c');
  assert.equal(sent(c.calls[2].arg), 'keyword=k w&sortBy=1&sentiment=3&importance=2&platform=p&tokenSymbols=S&detailLevel=2&language=l&begin=1&end=2&limit=9&cursor=c');
});

test('social: finalize_news --since validation (any Some, incl. "") and --max-results ordering', async () => {
  const c = mockClient([]);
  const coded = (field, msg) => (e) => { assert.ok(e instanceof CodedError); assert.equal(e.field, field); assert.equal(e.message, msg); };
  await rejects(SOC.fetchNewsLatest(c, { since: '0' }), coded('since', "invalid --since '0'; duration must be positive"));
  await rejects(SOC.fetchNewsLatest(c, { since: '' }), coded('since', "invalid --since ''; use e.g. 300s, 30m, 24h, 7d"));
  await rejects(SOC.fetchNewsLatest(c, { since: '24h', begin: '1000' }), coded('since', '--since is mutually exclusive with --begin/--end'));
  await rejects(SOC.fetchNewsLatest(c, { since: 'x', max_results: '0' }), coded('since', "invalid --since 'x'; use e.g. 300s, 30m, 24h, 7d"));
  await rejects(SOC.fetchNewsLatest(c, { max_results: '999' }), coded('max-results', '--max-results must be between 1 and 500, got 999'));
  await rejects(SOC.fetchNewsLatest(c, { max_results: ' abc ' }), coded('max-results', "--max-results must be an integer between 1 and 500, got 'abc'"));
  assert.equal(c.calls.length, 0);
});

test('social: finalize_news --since single page adds resolvedWindow to object data only', async () => {
  const c = mockClient([{ cursor: 'n', articles: [] }, []]);
  const out = await SOC.fetchNewsLatest(c, { since: '30m', begin: '', end: '', limit: '3' });
  const q = Object.fromEntries(c.calls[0].arg);
  assert.equal(Number(q.end) - Number(q.begin), 1800000);
  assert.deepEqual(c.calls[0].arg.map(([k]) => k), ['begin', 'end', 'limit']);
  assert.deepEqual(out.resolvedWindow, { begin: Number(q.begin), end: Number(q.end) });
  assert.deepEqual(await SOC.fetchNewsLatest(c, { since: '1s' }), []);
});

test('social: --max-results aggregates pages (spec example) with sorted keys', async () => {
  const c = mockClient([{ articles: [{ id: 'a' }, { id: 'b' }], cursor: 'p2' }, { articles: [{ id: 'c' }], cursor: '' }]);
  const out = await SOC.fetchNewsLatest(c, { max_results: '50', limit: '2' });
  assert.equal(c.calls.length, 2);
  assert.equal(sent(c.calls[0].arg), 'limit=2');
  assert.equal(sent(c.calls[1].arg), 'limit=2&cursor=p2');
  assert.equal(stringify(out), '{"fetchedCount":3,"items":[{"id":"a"},{"id":"b"},{"id":"c"}],"nextCursor":null}');
});

test('social: --max-results partial results (page error / stuck cursor) and resolvedWindow', async () => {
  const c = mockClient([{ articles: [{ id: 'a' }], cursor: 'p2' }, new Error('API error (code=50011): Too Many Requests')]);
  const out = await SOC.fetchNewsSearch(c, { keyword: 'k', max_results: '30', limit: '' });
  assert.equal(sent(c.calls[0].arg), 'keyword=k');
  assert.equal(stringify(out), '{"error":{"code":"upstream_error","message":"page 2 request failed: API error (code=50011): Too Many Requests","nextCursor":"p2"},"fetchedCount":1,"items":[{"id":"a"}],"nextCursor":"p2","partial":true}');

  const s = mockClient([{ articles: [{ id: 'b1' }], cursor: 'p2' }]);
  const stuck = await SOC.fetchNewsBySymbol(s, { token_symbols: 'BTC', max_results: '20', cursor: 'p2' });
  assert.equal(sent(s.calls[0].arg), 'tokenSymbols=BTC&cursor=p2');
  assert.equal(stringify(stuck), `{"error":{"code":"cursor_not_advancing","message":"upstream returned the same cursor 'p2' it was queried with; stopping to avoid re-fetching the same page","nextCursor":"p2"},"fetchedCount":1,"items":[{"id":"b1"}],"nextCursor":"p2","partial":true}`);

  const w = mockClient([{ articles: [{ id: 'x' }], cursor: 'z' }]);
  const win = await SOC.fetchNewsLatest(w, { max_results: '1', since: '1d' });
  const q = Object.fromEntries(w.calls[0].arg);
  assert.equal(Number(q.end) - Number(q.begin), 86400000);
  assert.equal(stringify(win), `{"fetchedCount":1,"items":[{"id":"x"}],"nextCursor":"z","resolvedWindow":{"begin":${q.begin},"end":${q.end}}}`);
});

test('social: --max-results pages use ApiClient::clone (token copied per page, payment state shared)', async () => {
  class FakeClient {
    constructor() { this.token = 'A'; this.pay = { requests: 0 }; this.seen = []; }
    async get(path, q) {
      this.seen.push(this.token);        // shared array reference survives the shallow clone
      this.token = 'refreshed';          // a refresh-and-retry inside one page only updates that clone
      this.pay.requests += 1;
      const cur = Object.fromEntries(q).cursor;
      return cur ? { articles: [{ id: 'b' }], cursor: '' } : { articles: [{ id: 'a' }], cursor: 'p2' };
    }
  }
  const client = new FakeClient();
  const out = await SOC.fetchNewsLatest(client, { max_results: '10' });
  assert.equal(stringify(out), '{"fetchedCount":2,"items":[{"id":"a"},{"id":"b"}],"nextCursor":null}');
  assert.deepEqual(client.seen, ['A', 'A']);
  assert.equal(client.token, 'A');
  assert.equal(client.pay.requests, 2);
});

test('social: detail / platforms / sentiment / vibe requests', async () => {
  const c = mockClient([{}, {}, {}, {}, { summary: { text: 'x', s: 1 } }, [{ content: 'y', k: 2 }]]);
  await SOC.fetchNewsDetail(c, { article_id: '123', language: '' });
  await SOC.fetchNewsPlatforms(c);
  await SOC.fetchSentimentRanking(c, { time_frame: '2', limit: '5' });
  await SOC.fetchSentimentSymbol(c, { token_symbols: 'BTC,ETH', trend_points: '8' });
  const t = await SOC.fetchVibeTimeline(c, '501', 'So1', '1');
  const k = await SOC.fetchVibeTopKols(c, '1', '0xT', '2', undefined, '5');
  assert.deepEqual(c.calls.map((x) => `${x.path}?${sent(x.arg)}`), [
    '/api/v6/dex/market/social/news/detail?articleId=123',
    '/api/v6/dex/market/social/news/platforms?',
    '/api/v6/dex/market/social/sentiment/ranking?timeFrame=2&limit=5',
    '/api/v6/dex/market/social/sentiment/symbol?tokenSymbols=BTC,ETH&trendPoints=8',
    '/api/v6/dex/market/social/vibe/timeline?chainIndex=501&tokenAddress=So1&timeFrame=1',
    '/api/v6/dex/market/social/vibe/top-kols?chainIndex=1&tokenAddress=0xT&sortBy=2&limit=5',
  ]);
  assert.deepEqual(t, { summary: { s: 1 } });
  assert.deepEqual(k, [{ k: 2 }]);
});

// ═════════════════════════════ memepump.rs ═════════════════════════════

const newToken = (createdMs) => ({
  createdTimestamp: String(createdMs), symbol: 'TEST',
  tags: { bundlersPercent: '0', devHoldingsPercent: '0', freshWalletsPercent: '0', insidersPercent: '0', snipersPercent: '0', suspectedPhishingWalletPercent: '0', top10HoldingsPercent: '12.5', totalHolders: '4' },
});

test('memepump: zero_tags_nullified_within_threshold (upstream)', () => {
  const receivedAt = MP.nowMs();
  const created = receivedAt - 1000;
  const token = newToken(created);
  MP.nullifyZeroTagsIfNew(token, receivedAt);
  for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(token.tags[f], null, f);
  assert.equal(token.tags.top10HoldingsPercent, '12.5');
  assert.equal(token.tags.totalHolders, '4');
  assert.equal(token.createdTimestamp, String(created));
});

test('memepump: zero tags untouched outside threshold / unknown / future timestamps (upstream)', () => {
  const receivedAt = MP.nowMs();
  for (const created of [receivedAt - 5000, 0, receivedAt + 10000, receivedAt - 2000]) {
    const token = newToken(created);
    MP.nullifyZeroTagsIfNew(token, receivedAt);
    for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(token.tags[f], '0', `${f} @ ${created}`);
  }
  const edge = newToken(receivedAt - 1999);
  MP.nullifyZeroTagsIfNew(edge, receivedAt);
  assert.equal(edge.tags.snipersPercent, null);
});

test('memepump: non_zero_tags_not_nullified_within_threshold + decimal zero strings (upstream)', () => {
  const receivedAt = MP.nowMs();
  const t = { createdTimestamp: String(receivedAt - 500), symbol: 'TEST', tags: { bundlersPercent: '5.5', devHoldingsPercent: '10.0', freshWalletsPercent: '0', insidersPercent: '0', snipersPercent: '0', suspectedPhishingWalletPercent: '0', totalHolders: '8' } };
  MP.nullifyZeroTagsIfNew(t, receivedAt);
  assert.equal(t.tags.bundlersPercent, '5.5');
  assert.equal(t.tags.devHoldingsPercent, '10.0');
  assert.equal(t.tags.freshWalletsPercent, null);
  const d = { createdTimestamp: String(receivedAt - 500), tags: { bundlersPercent: '0.0', devHoldingsPercent: '0.00', freshWalletsPercent: '0', insidersPercent: '0', snipersPercent: '0', suspectedPhishingWalletPercent: '0' } };
  MP.nullifyZeroTagsIfNew(d, receivedAt);
  for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(d.tags[f], null, f);
});

test('memepump: is_numeric_zero_handles_common_string_shapes (upstream) + Rust f64 grammar', () => {
  for (const v of ['0', '0.0', '0.00', ' 0 ', 0, new F64('0.0'), '-0', '+0', '0e0', '.0', '0.', '\u00850\u0085', -0]) assert.equal(MP.isNumericZero(v), true, String(v));
  for (const v of ['1', '0.01', '', 'null', new F64('1.5'), null, 'nan', '0x0', '﻿0', '0 0', true, [], {}, 12345678901234567890n]) assert.equal(MP.isNumericZero(v), false, String(v));
});

test('memepump: createdTimestamp parsing (string u64 strict, number as_u64)', () => {
  const now = 1_800_000_000_000;
  const run = (createdTimestamp) => { const t = { createdTimestamp, tags: { snipersPercent: '0' } }; MP.nullifyZeroTagsIfNew(t, now); return t.tags.snipersPercent; };
  assert.equal(run(String(now - 10)), null);
  assert.equal(run(`+${now - 10}`), null);        // u64::from_str accepts a leading '+'
  assert.equal(run(` ${now - 10}`), '0');          // no trim
  assert.equal(run(now - 10), null);               // JSON integer
  assert.equal(run(new F64(now - 10)), '0');       // JSON float → as_u64 None
  assert.equal(run(-5), '0');
  assert.equal(run(null), '0');
  assert.equal(run(undefined), '0');
  const noTags = { createdTimestamp: String(now - 10), tags: ['0'] };
  MP.nullifyZeroTagsIfNew(noTags, now);
  assert.deepEqual(noTags.tags, ['0']);
  const t = newToken(now - 10);
  MP.nullifyZeroTagsIfNew(t, 0);                   // clock error → skip
  assert.equal(t.tags.snipersPercent, '0');
  assert.doesNotThrow(() => MP.nullifyZeroTagsIfNew('str', now));
});

test('memepump: apply_nullify_to_response walks list / bare array / data object / items / signals (upstream)', () => {
  const receivedAt = MP.nowMs();
  const created = receivedAt - 500;
  for (const key of ['list', 'items', 'signals']) {
    const data = { [key]: [newToken(created)], total: 1 };
    MP.applyNullifyToResponse(data, receivedAt);
    for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(data[key][0].tags[f], null, `${key}.${f}`);
  }
  const arr = [newToken(created)];
  MP.applyNullifyToResponse(arr, receivedAt);
  for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(arr[0].tags[f], null);
  const wrapped = { data: newToken(created) };
  MP.applyNullifyToResponse(wrapped, receivedAt);
  for (const f of MP.UNRELIABLE_ZERO_TAGS) assert.equal(wrapped.data.tags[f], null);
});

test('memepump: apply_nullify_to_response key precedence and fallbacks', () => {
  const receivedAt = MP.nowMs();
  const created = receivedAt - 500;
  // `list` (non-container) is skipped, `data` array wins; `items` is never reached.
  const a = { list: 'x', data: [newToken(created)], items: [newToken(created)] };
  MP.applyNullifyToResponse(a, receivedAt);
  assert.equal(a.data[0].tags.snipersPercent, null);
  assert.equal(a.items[0].tags.snipersPercent, '0');
  // No wrapper key → the object itself is the token.
  const b = newToken(created);
  MP.applyNullifyToResponse(b, receivedAt);
  assert.equal(b.tags.snipersPercent, null);
  // A wrapper key holding null is skipped; the object itself is then treated as the token.
  const c = { ...newToken(created), list: null };
  MP.applyNullifyToResponse(c, receivedAt);
  assert.equal(c.tags.snipersPercent, null);
  for (const s of [null, 'x', 5, new F64('0.0')]) assert.doesNotThrow(() => MP.applyNullifyToResponse(s, receivedAt));
});

test('memepump: fetch_token_list query order, renamed keys, NEW default, "" dropped', async () => {
  const c = mockClient([[], []]);
  await MP.fetchTokenList(c, { chain: 'solana' });
  assert.equal(c.calls[0].path, '/api/v6/dex/market/memepump/tokenList');
  assert.equal(sent(c.calls[0].arg), 'chainIndex=501&stage=NEW');
  const all = Object.fromEntries(MP.TOKEN_LIST_FIELDS.map((f, i) => [G.snakeCase(f), `v${i}`]));
  all.chain = 'bsc';
  await MP.fetchTokenList(c, all);
  const keys = c.calls[1].arg.map(([k]) => k);
  assert.equal(keys.length, 56);
  assert.deepEqual(keys.slice(0, 5), ['chainIndex', 'stage', 'walletAddress', 'protocolIdList', 'quoteTokenAddressList']);
  assert.deepEqual(keys.slice(23, 27), ['minMarketCapUsd', 'maxMarketCapUsd', 'minVolumeUsd', 'maxVolumeUsd']);
  assert.deepEqual(keys.slice(-2), ['keywordsInclude', 'keywordsExclude']);
  assert.equal(c.calls[1].arg[0][1], '56');
  assert.equal(Object.fromEntries(c.calls[1].arg).minMarketCapUsd, all.min_market_cap);
  assert.equal(MP.TOKEN_LIST_FIELDS.length, 56);
});

test('memepump: token details / aped wallet / by-address / chains requests', async () => {
  const c = mockClient([{ createdTimestamp: '1', tags: { snipersPercent: '0' } }, [], [], []]);
  const d = await MP.fetchTokenDetails(c, 'T', '501', '');
  assert.deepEqual(d.tags, { snipersPercent: '0' });
  await MP.fetchApedWallet(c, 'T', '56', 'W');
  await MP.fetchByAddress(c, '/api/v6/dex/market/memepump/similarToken', 'T', '501');
  await MP.fetchChains(c);
  assert.deepEqual(c.calls.map((x) => `${x.path}?${sent(x.arg)}`), [
    '/api/v6/dex/market/memepump/tokenDetails?chainIndex=501&tokenContractAddress=T',
    '/api/v6/dex/market/memepump/apedWallet?chainIndex=56&tokenContractAddress=T&walletAddress=W',
    '/api/v6/dex/market/memepump/similarToken?chainIndex=501&tokenContractAddress=T',
    '/api/v6/dex/market/memepump/supported/chainsProtocol?',
  ]);
});

// ═════════════════════════════ private shared helpers ═════════════════════════════

test('_g03: rustParams builds the serde-named *Params struct from CLI options (None → null)', () => {
  assert.equal(G.snakeCase('minTop10HoldingsPercent'), 'min_top10_holdings_percent');
  assert.equal(G.snakeCase('hasX'), 'has_x');
  assert.deepEqual(G.rustParams({ tokenSymbols: 'BTC', maxResults: undefined, limit: '' }, ['tokenSymbols', 'maxResults', 'limit', 'cursor']),
    { token_symbols: 'BTC', max_results: null, limit: '', cursor: null });
});

test('shared fetchers read ONLY serde (snake_case) fields — camelCase keys are unknown fields, ignored like serde', async () => {
  const c = mockClient([{}, {}, [], []]);
  await SOC.fetchNewsLatest(c, { token_symbols: 'BTC', detail_level: '2', limit: '5', since: null, max_results: null });
  await SOC.fetchNewsLatest(c, { tokenSymbols: 'ETH', detailLevel: '1', token_symbols: 'BTC', detail_level: '2', limit: '5' });
  assert.equal(sent(c.calls[0].arg), 'tokenSymbols=BTC&detailLevel=2&limit=5');
  assert.equal(sent(c.calls[1].arg), sent(c.calls[0].arg));
  await MP.fetchTokenList(c, { chain: 'solana', stage: null, min_market_cap: '1000', has_x: 'true' });
  await MP.fetchTokenList(c, { chain: 'solana', minMarketCap: '5', hasX: 'false' });
  assert.equal(sent(c.calls[2].arg), 'chainIndex=501&stage=NEW&minMarketCapUsd=1000&hasX=true');
  assert.equal(sent(c.calls[3].arg), 'chainIndex=501&stage=NEW');
});

test('_g03: clapInt reproduces clap RangedI64ValueParser<u32> (i64 FromStr wording, then bounds)', () => {
  const msg = (raw) => G.clapInt('market kline', 'limit', raw, 'u32').message;
  const err = (raw, why) => assert.equal(msg(raw), `error: invalid value '${raw}' for '--limit <LIMIT>': ${why}

For more information, try '--help'.
`);
  err('abc', 'invalid digit found in string');
  err('', 'cannot parse integer from empty string');
  err('+', 'invalid digit found in string');
  err('-', 'invalid digit found in string');
  err(' 5', 'invalid digit found in string');
  err('1_0', 'invalid digit found in string');
  err('٣', 'invalid digit found in string');
  err('-1', '-1 is not in 0..=4294967295');
  err('+4294967296', '4294967296 is not in 0..=4294967295');
  err('0004294967296', '4294967296 is not in 0..=4294967295');
  err('99999999999999999999', 'number too large to fit in target type');
  err('99999999999999999999x', 'number too large to fit in target type');   // overflow is hit before the bad digit
  err('-99999999999999999999', 'number too small to fit in target type');
  assert.equal(G.clapInt('market kline', 'limit', '-0', 'u32').value, 0);
  assert.equal(G.clapInt('market kline', 'limit', '+007', 'u32').value, 7);
  assert.equal(G.clapInt('market kline', 'limit', '4294967295', 'u32').value, 4294967295);
  assert.deepEqual(G.parseI64('-9223372036854775808'), { value: -9223372036854775808n });
  assert.equal(G.parseI64('9223372036854775808').why, 'number too large to fit in target type');
});

test('memepump: is_numeric_zero uses Rust str::trim + f64 grammar (U+0085/U+00A0 trimmed, U+FEFF not)', () => {
  for (const v of ['0.', '.0', '-0', '+0', '0e0', '0 ', '　 0 ', 0, -0, new F64('-0.0'), new F64('0.0')]) assert.equal(MP.isNumericZero(v), true, String(v));
  for (const v of ['﻿0', '0x0', 'nan', 'inf', '', '.', '0.0.0', false, null, 1e-300, new F64('1e-300')]) assert.equal(MP.isNumericZero(v), false, String(v));
});

test('_g03: some / isJsonObject', () => {
  assert.equal(G.some(undefined), false);
  assert.equal(G.some(null), false);
  assert.equal(G.some(''), true);
  assert.equal(G.isJsonObject({}), true);
  for (const v of [[], null, 'x', 1, 1n, new F64('1.0')]) assert.equal(G.isJsonObject(v), false);
});

// ═════════════════════════════ handler surface ═════════════════════════════

test('handlers: every g03 command is registered once', () => {
  const all = { ...M.default, ...SIG.default, ...SOC.default, ...MP.default, ...LB.default, ...TR.default };
  assert.equal(Object.keys(all).length, 30);
  for (const [path, h] of Object.entries(all)) {
    assert.equal(typeof h.run, 'function', path);
    assert.ok(Array.isArray(h.uses), path);
  }
});
