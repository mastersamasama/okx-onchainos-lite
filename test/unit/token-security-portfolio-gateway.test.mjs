// g04: commands/token.rs, security.rs, portfolio.rs, gateway.rs (+ the private clap pass the
// four handler groups share). Every assertion of the upstream #[cfg(test)] modules is ported
// (token.rs compose_report, security.rs extract_token_pairs / token parsing / classify_tokens),
// followed by request-shape and exact-message checks taken from the Rust source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated, empty state dir (chains.mjs reads chain_cache.json from it) — set before any module
// that reads lib/config.mjs is imported, hence the dynamic imports.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-g04-'));
process.env.OCL_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const CMD = '../../skill/onchainos-lite/lib/commands/';
const T = await import(CMD + 'token/token.mjs');
const S = await import(CMD + 'security/security.mjs');
const P = await import(CMD + 'portfolio/portfolio.mjs');
const G = await import(CMD + 'gateway/gateway.mjs');
const K = await import(CMD + 'token/_clap.mjs');
const { stringify, parse, F64 } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { CodedError, UsageError } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');

// Fake ApiClient recording every call; `reply(method, path, query|body)` supplies the data.
function fakeClient(reply = () => []) {
  const calls = [];
  return {
    calls,
    async get(path, query = []) { calls.push({ m: 'GET', path, query }); return reply('GET', path, query); },
    async post(path, body) { calls.push({ m: 'POST', path, body }); return reply('POST', path, body); },
    async postNoRetry(path, body, headers) { calls.push({ m: 'POST!', path, body, headers }); return reply('POST', path, body); },
  };
}
const qs = (q) => q.filter(([, v]) => v !== '' && v !== undefined && v !== null);

// ── token.rs ─────────────────────────────────────────────────────────

test('token.rs: request_time_passes_through_report_composition', () => {
  const info = { requestTime: 1721000000000, symbol: 'ETH' };
  const price = { requestTime: 1721000000111, price: '1' };
  const report = T.composeReport('0xabc', '1', info, price, null, null);
  assert.equal(report.info.requestTime, 1721000000000);
  assert.equal(report.priceInfo.requestTime, 1721000000111);
  assert.equal(report.advancedInfo, null);
  assert.equal(stringify(report), '{"address":"0xabc","advancedInfo":null,"chain":"1","info":{"requestTime":1721000000000,"symbol":"ETH"},"priceInfo":{"price":"1","requestTime":1721000000111},"security":null}');
});

test('validateLimit: u64 parse of the raw string, then 1..=100', () => {
  assert.doesNotThrow(() => T.validateLimit(undefined));
  assert.doesNotThrow(() => T.validateLimit('1'));
  assert.doesNotThrow(() => T.validateLimit('+100'));
  assert.doesNotThrow(() => T.validateLimit('0005'));
  assert.throws(() => T.validateLimit(' 5'), /^Error: --limit must be a number between 1 and 100$/);
  assert.throws(() => T.validateLimit('-1'), /^Error: --limit must be a number between 1 and 100$/);
  assert.throws(() => T.validateLimit(''), /^Error: --limit must be a number between 1 and 100$/);
  assert.throws(() => T.validateLimit('18446744073709551616'), /must be a number between 1 and 100$/);
  assert.throws(() => T.validateLimit('0'), /^Error: --limit must be between 1 and 100, got 0$/);
  assert.throws(() => T.validateLimit('+101'), /^Error: --limit must be between 1 and 100, got 101$/);
  assert.throws(() => T.validateLimit('18446744073709551615'), /got 18446744073709551615$/);
});

test('fetchSearch: resolved chains, untrimmed query, default limit "20", empty cursor dropped', async () => {
  const c = fakeClient();
  await T.fetchSearch(c, ' dog wif ', ' eth , sol,base', undefined, '', undefined);
  assert.deepEqual(c.calls[0], { m: 'GET', path: '/api/v6/dex/market/token/search', query: [['chains', '1,501,8453'], ['search', ' dog wif '], ['limit', '20']] });
  await T.fetchSearch(c, 'x', '1', '+5', 'abc', undefined);
  assert.deepEqual(c.calls[1].query, [['chains', '1'], ['search', 'x'], ['limit', '+5'], ['cursor', 'abc']]);
  await assert.rejects(T.fetchSearch(c, 'x', '1', '101'), /got 101/);
  await assert.rejects(T.fetchSearch(c, 'x', '1', '5', undefined, '0'), (e) => e instanceof CodedError && e.code === 'invalid_input' && e.field === 'max-results' && e.message === '--max-results must be between 1 and 500, got 0');
  assert.equal(c.calls.length, 2);
});

test('fetchHolders / fetchTopTrader: tagFilter (u8) sent as text, 0 kept, absent dropped', async () => {
  const c = fakeClient();
  await T.fetchHolders(c, '0xA', '1', 0, undefined, undefined, undefined);
  assert.deepEqual(c.calls[0], { m: 'GET', path: '/api/v6/dex/market/token/holder', query: [['chainIndex', '1'], ['tokenContractAddress', '0xA'], ['tagFilter', '0'], ['limit', '20']] });
  await T.fetchTopTrader(c, '0xA', '501', undefined, '3', 'c1', undefined);
  assert.deepEqual(c.calls[1], { m: 'GET', path: '/api/v6/dex/market/token/top-trader', query: [['chainIndex', '501'], ['tokenContractAddress', '0xA'], ['tagFilter', ''], ['limit', '3'], ['cursor', 'c1']] });
});

test('finalizeTokenPage: auto-pagination chains per-item cursors and truncates to N', async () => {
  const pages = { '': [{ id: 1, cursor: 'a' }, { id: 2, cursor: 'b' }], b: [{ id: 3, cursor: 'c' }, { id: 4, cursor: 'd' }], d: [{ id: 5, cursor: 'e' }] };
  const c = fakeClient((m, path, q) => pages[(q.find(([k]) => k === 'cursor') || [, ''])[1]]);
  const out = await T.finalizeTokenPage(c, '/p', [['a', '1']], undefined, ' 3 ');
  assert.deepEqual(c.calls.map((x) => x.query), [[['a', '1']], [['a', '1'], ['cursor', 'b']]]);
  assert.equal(stringify(out), '{"fetchedCount":3,"items":[{"cursor":"a","id":1},{"cursor":"b","id":2},{"cursor":"c","id":3}],"nextCursor":"c"}');
});

test('finalizeTokenPage: page failure → partial upstream_error (exit 0 data), keys sorted', async () => {
  let n = 0;
  const c = fakeClient(() => { if (n++) throw new Error('API error (code=50011): Too Many Requests'); return [{ id: 1, cursor: 'x' }]; });
  const out = await T.finalizeTokenPage(c, '/p', [], 'start', '10');
  assert.equal(stringify(out), '{"error":{"code":"upstream_error","message":"page 2 request failed: API error (code=50011): Too Many Requests","nextCursor":"x"},"fetchedCount":1,"items":[{"cursor":"x","id":1}],"nextCursor":"x","partial":true}');
  assert.deepEqual(c.calls[0].query, [['cursor', 'start']]);
});

test('finalizeTokenPage: single page passthrough without --max-results', async () => {
  const c = fakeClient(() => ({ any: 'thing' }));
  assert.deepEqual(await T.finalizeTokenPage(c, '/p', [['k', 'v']], 'cur', undefined), { any: 'thing' });
  assert.deepEqual(c.calls[0].query, [['k', 'v'], ['cursor', 'cur']]);
});

test('hotTokensParams accepts CLI camelCase and Rust snake_case (MCP) names', () => {
  const a = T.hotTokensParams({ rankingType: '4', top10HoldPercentMin: '5', isLpBurnt: 'true' });
  const b = T.hotTokensParams({ ranking_type: '4', top10_hold_percent_min: '5', is_lp_burnt: 'true' });
  assert.deepEqual(a, b);
  assert.equal(a.top10HoldPercentMin, '5');
  assert.equal(a.chain, undefined);
});

test('fetchHotTokens: upstream req_params order, empty values dropped, chain resolved', async () => {
  const c = fakeClient();
  const all = Object.fromEntries(['rankBy', 'timeFrame', 'riskFilter', 'stableTokenFilter', 'projectId', 'priceChangeMin', 'priceChangeMax',
    'volumeMin', 'volumeMax', 'marketCapMin', 'marketCapMax', 'liquidityMin', 'liquidityMax', 'transactionMin', 'transactionMax', 'txsMin', 'txsMax',
    'uniqueTraderMin', 'uniqueTraderMax', 'holdersMin', 'holdersMax', 'inflowMin', 'inflowMax', 'fdvMin', 'fdvMax', 'mentionedCountMin', 'mentionedCountMax',
    'socialScoreMin', 'socialScoreMax', 'top10HoldPercentMin', 'top10HoldPercentMax', 'devHoldPercentMin', 'devHoldPercentMax', 'bundleHoldPercentMin',
    'bundleHoldPercentMax', 'suspiciousHoldPercentMin', 'suspiciousHoldPercentMax', 'isLpBurnt', 'isMint', 'isFreeze'].map((k) => [k, k]));
  await T.fetchHotTokens(c, { rankingType: '5', chain: 'sol', ...all, limit: '7' });
  assert.deepEqual(qs(c.calls[0].query).map(([k]) => k), ['rankingType', 'chainIndex', 'rankBy', 'rankingTimeFrame', 'riskFilter', 'stableTokenFilter', 'protocolId',
    'priceChangePercentMin', 'priceChangePercentMax', 'volumeMin', 'volumeMax', 'tradeAmountMin', 'tradeAmountMax', 'txsMin', 'txsMax', 'uniqueTraderMin',
    'uniqueTraderMax', 'marketCapMin', 'marketCapMax', 'liquidityMin', 'liquidityMax', 'holdersMin', 'holdersMax', 'inflowUsdMin', 'inflowUsdMax', 'fdvMin',
    'fdvMax', 'mentionedCountMin', 'mentionedCountMax', 'socialScoreMin', 'socialScoreMax', 'top10HoldPercentMin', 'top10HoldPercentMax', 'devHoldPercentMin',
    'devHoldPercentMax', 'bundleHoldPercentMin', 'bundleHoldPercentMax', 'suspiciousHoldPercentMin', 'suspiciousHoldPercentMax', 'isLpBurnt', 'isMint', 'isFreeze', 'limit']);
  assert.equal(c.calls[0].query[1][1], '501');
  await T.fetchHotTokens(c, { rankingType: '4' });
  assert.deepEqual(qs(c.calls[1].query), [['rankingType', '4'], ['limit', '20']]);
  await assert.rejects(T.fetchHotTokens(c, { rankingType: '4', limit: 'x' }), /must be a number between 1 and 100/);
});

test('fetchInfo / fetchPriceInfo / fetchSecurity / fetchTokenTrades request shapes', async () => {
  const c = fakeClient();
  await T.fetchInfo(c, '0xA', '1');
  await T.fetchPriceInfo(c, '0xA', '1');
  await T.fetchSecurity(c, '0xA', '1');
  await T.fetchTokenTrades(c, '0xA', '1', 100, undefined, 'w1,w2');
  assert.equal(stringify(c.calls[0].body), '[{"chainIndex":"1","tokenContractAddress":"0xA"}]');
  assert.equal(c.calls[1].path, '/api/v6/dex/market/price-info');
  assert.equal(stringify(c.calls[2].body), '{"source":"onchain_os_cli","tokenList":[{"chainId":"1","contractAddress":"0xA"}]}');
  assert.deepEqual(c.calls[3].query, [['chainIndex', '1'], ['tokenContractAddress', '0xA'], ['limit', '100'], ['tagFilter', ''], ['walletAddressFilter', 'w1,w2']]);
});

test('fetchReport: failed sub-calls become null; all failing is an error', async () => {
  const c = fakeClient((m, path) => { if (path.includes('price-info') || path.includes('token-scan')) throw new Error('boom'); return path.includes('advanced') ? null : [{ s: 1 }]; });
  const r = await T.fetchReport(c, '0xA', '8453');
  assert.equal(stringify(r), '{"address":"0xA","advancedInfo":null,"chain":"8453","info":[{"s":1}],"priceInfo":null,"security":null}');
  const bad = fakeClient(() => { throw new Error('down'); });
  await assert.rejects(T.fetchReport(bad, '0xA', '1'), /^Error: token report: all sub-calls failed for address 0xA on chain 1$/);
  assert.equal(bad.calls.length, 4);
});

// ── security.rs ──────────────────────────────────────────────────────

test('security.rs: extract_token_pairs (upstream tests)', () => {
  assert.deepEqual(S.extractTokenPairs(null), []);
  assert.deepEqual(S.extractTokenPairs([]), []);
  assert.deepEqual(S.extractTokenPairs([{ chainIndex: '1', tokenContractAddress: '0xabc' }, { chainIndex: '56', tokenContractAddress: '0xdef' }]), [['1', '0xabc'], ['56', '0xdef']]);
  const wrapped = S.extractTokenPairs({ tokenAssets: [{ chainIndex: '501', tokenContractAddress: 'So111' }, { chainIndex: '1', tokenContractAddress: '0xusdc' }] });
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped[0][0], '501');
  assert.equal(wrapped[1][1], '0xusdc');
  assert.deepEqual(S.extractTokenPairs([{ chainIndex: '1', tokenContractAddress: '' }, { chainIndex: '1', tokenContractAddress: '0xabc' }, { chainIndex: '501', tokenContractAddress: '' }]), [['1', '0xabc']]);
  assert.deepEqual(S.extractTokenPairs([{ chainIndex: '1' }, { tokenContractAddress: '0xabc' }, { chainIndex: '56', tokenContractAddress: '0xdef' }]), [['56', '0xdef']]);
  assert.throws(() => S.extractTokenPairs({ foo: 'bar' }), /Unexpected portfolio response format/);
  let msg;
  try { S.extractTokenPairs({ unexpected: 'x'.repeat(500) }); } catch (e) { msg = e.message; }
  assert.ok(msg.length < 400);
});

test('extract_token_pairs: exact error text, 200-char preview + ellipsis, top-level items only', () => {
  assert.throws(() => S.extractTokenPairs({ b: 1, a: 'x' }), { message: 'Unexpected portfolio response format — expected array or {tokenAssets:[...]} but got: {"a":"x","b":1}' });
  assert.throws(() => S.extractTokenPairs('str'), { message: 'Unexpected portfolio response format — expected array or {tokenAssets:[...]} but got: "str"' });
  const long = { k: 'y'.repeat(300) };
  assert.throws(() => S.extractTokenPairs(long), { message: `Unexpected portfolio response format — expected array or {tokenAssets:[...]} but got: ${stringify(long).slice(0, 200)}…` });
  // the balance APIs answer [{tokenAssets:[…]}]: upstream reads top-level items only → no pairs
  assert.deepEqual(S.extractTokenPairs([{ tokenAssets: [{ chainIndex: '1', tokenContractAddress: '0xabc' }] }]), []);
  // non-string chainIndex skipped
  assert.deepEqual(S.extractTokenPairs([{ chainIndex: 1, tokenContractAddress: '0xabc' }]), []);
});

test('security.rs: token format parsing (upstream tests) + exact error text', () => {
  assert.deepEqual(S.parseExplicitTokens('1:0xdAC17F'), [{ chainId: '1', contractAddress: '0xdAC17F' }]);
  assert.deepEqual(S.parseExplicitTokens('ethereum:0xabc'), [{ chainId: '1', contractAddress: '0xabc' }]);
  assert.deepEqual(S.parseExplicitTokens('501:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), [{ chainId: '501', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }]);
  assert.equal(S.parseExplicitTokens('solana:So111')[0].chainId, '501');
  assert.equal(S.parseExplicitTokens('1:0xabc:extra')[0].contractAddress, '0xabc:extra');
  assert.throws(() => S.parseExplicitTokens('1_0xabc'), { message: "Invalid token format '1_0xabc'. Expected chainId:contractAddress (e.g. 1:0xdAC1...)" });
  assert.throws(() => S.parseExplicitTokens(''), { message: "Invalid token format ''. Expected chainId:contractAddress (e.g. 1:0xdAC1...)" });
  assert.deepEqual(S.parseExplicitTokens('  56 : 0xdef  '), [{ chainId: '56', contractAddress: '0xdef' }]);
  assert.throws(() => S.parseExplicitTokens('1:a, bad ,2:b'), { message: "Invalid token format 'bad'. Expected chainId:contractAddress (e.g. 1:0xdAC1...)" });
  assert.throws(() => S.parseExplicitTokens('1:a,'), /Invalid token format ''/);
  assert.deepEqual(S.parseExplicitTokens('1:'), [{ chainId: '1', contractAddress: '' }]);
  assert.equal(S.BATCH_SIZE, 50);
});

test('security.rs: classify_tokens (upstream tests)', () => {
  let out = S.classifyTokens([{ tokenContractAddress: '0xbad', riskLevel: 'CRITICAL', symbol: 'SCAM' }], 'buy');
  assert.equal(out.tradeDirection, 'buy');
  assert.equal(out.combinedAction, 'block');
  assert.equal(out.tokens[0].normalizedRiskLevel, 'CRITICAL');
  assert.equal(out.tokens[0].action, 'block');
  assert.equal(out.tokens[0].isNative, false);
  assert.equal(out.tokens[0].symbol, 'SCAM');
  assert.equal(out.tokens[0].riskLevel, 'CRITICAL');
  out = S.classifyTokens([{ tokenContractAddress: '0xbad', riskLevel: 'CRITICAL' }], 'sell');
  assert.equal(out.tokens[0].action, 'warn');
  assert.equal(out.combinedAction, 'warn');
  assert.equal(out.tradeDirection, 'sell');
  out = S.classifyTokens([{ tokenContractAddress: '0xok', riskLevel: 'LOW' }], 'sell');
  assert.equal(out.tokens[0].action, 'safe');
  assert.equal(out.combinedAction, 'safe');
  out = S.classifyTokens([{ riskLevel: 'CRITICAL' }, { tokenContractAddress: '0xok', riskLevel: 'LOW' }], 'buy');
  assert.equal(out.tokens[0].isNative, true);
  assert.equal(out.tokens[1].isNative, false);
  assert.equal(out.combinedAction, 'safe');
  out = S.classifyTokens([{ tokenContractAddress: '0xa' }, { tokenContractAddress: '0xb', riskLevel: null }, { tokenContractAddress: '0xc', riskLevel: '???' }], 'buy');
  for (const t of out.tokens) { assert.equal(t.normalizedRiskLevel, 'HIGH'); assert.equal(t.action, 'pause'); }
  assert.equal(out.combinedAction, 'pause');
  out = S.classifyTokens([], 'buy');
  assert.deepEqual(out.tokens, []);
  assert.equal(out.combinedAction, 'safe');
  assert.equal(out.tradeDirection, 'buy');
});

test('classify_tokens: key-sorted output, overwrites same-named keys, non-objects untouched', () => {
  const out = S.classifyTokens([{ contractAddress: '0x1', riskLevel: 'medium', action: 'x', isNative: 'y' }, 7, null], 'buy');
  assert.equal(stringify(out), '{"combinedAction":"warn","tokens":[{"action":"warn","contractAddress":"0x1","isNative":false,"normalizedRiskLevel":"MEDIUM","riskLevel":"medium"},7,null],"tradeDirection":"buy"}');
  assert.deepEqual(S.emitTokenScan([1, 2], undefined), [1, 2]);
});

test('tx_scan value conversion: decimal → 0x hex (u128), 0x/0X and non-u128 unchanged', () => {
  assert.equal(S.txScanHexValue('1000'), '0x3e8');
  assert.equal(S.txScanHexValue('0'), '0x0');
  assert.equal(S.txScanHexValue('+255'), '0xff');
  assert.equal(S.txScanHexValue('0XABC'), '0XABC');
  assert.equal(S.txScanHexValue('0x1'), '0x1');
  assert.equal(S.txScanHexValue('-1'), '-1');
  assert.equal(S.txScanHexValue(''), '');
  assert.equal(S.txScanHexValue('1.5'), '1.5');
  assert.equal(S.txScanHexValue('340282366920938463463374607431768211455'), '0xffffffffffffffffffffffffffffffff');
  assert.equal(S.txScanHexValue('340282366920938463463374607431768211456'), '340282366920938463463374607431768211456');
});

test('approvals: chainIndex as i64 (JSON int or parsable string), --chain list trimmed', async () => {
  assert.equal(S.chainIndexI64({ chainIndex: 1 }), 1);
  assert.equal(S.chainIndexI64({ chainIndex: '+56' }), 56);
  assert.equal(S.chainIndexI64({ chainIndex: '-3' }), -3);
  assert.equal(S.chainIndexI64({ chainIndex: 'x1' }), undefined);
  assert.equal(S.chainIndexI64({ chainIndex: new F64(1) }), undefined);
  assert.equal(S.chainIndexI64({ chainIndex: 18446744073709551615n }), undefined);
  assert.equal(S.chainIndexI64({}), undefined);
  assert.equal(stringify(await S.approvalAddressList('0xA', ' ethereum, ,base,')), '[{"address":"0xA","chainIndex":"1"},{"address":"0xA","chainIndex":"8453"}]');
  assert.deepEqual(await S.approvalAddressList('0xA', ','), []);
});

test('sig-scan message: any serde_json value, else the raw string', () => {
  assert.equal(S.parseSigMessage('123'), 123);
  assert.equal(S.parseSigMessage(' true '), true);
  assert.equal(S.parseSigMessage('"q"'), 'q');
  assert.equal(S.parseSigMessage('hello'), 'hello');
  assert.equal(S.parseSigMessage('{"a":1'), '{"a":1');
  assert.equal(S.parseSigMessage('"a\tb"'), '"a\tb"');
  assert.equal(S.parseSigMessage('1e400'), '1e400');
  assert.equal(S.parseSigMessage('01'), '01');
  assert.equal(stringify(S.parseSigMessage('{"z":1,"a":{"y":2,"b":[1.5]}}')), '{"a":{"b":[1.5],"y":2},"z":1}');
  assert.deepEqual(S.VALID_SIG_METHODS, ['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4']);
});

// Each expectation below was checked against the upstream 4.6.3 binary (request body bytes of
// POST /api/v6/security/sign-message-check): serde_json::from_str::<Value> accepts / rejects.
test('sig-scan message: serde_json escape, surrogate, depth, -0, number and __proto__ rules', () => {
  const B = '\\';
  const raw = (m) => assert.equal(S.parseSigMessage(m), m, `expected raw string for ${m.slice(0, 40)}`);
  const json = (m, out) => assert.equal(stringify(S.parseSigMessage(m)), out, `for ${m.slice(0, 40)}`);
  // \u escapes: 4 hex digits; paired surrogates only (serde validates UTF-8 for String)
  raw(`"${B}ud800"`);
  raw(`"${B}udc00"`);
  raw(`"${B}ud800${B}u0041"`);
  raw(`"${B}ud800${B}n"`);
  raw(`"${B}ud800${B}ud800${B}udc00"`);
  raw(`"${B}u12G4"`);
  raw(`"${B}u12"`);
  raw(`"${B}U00e9"`);
  raw(`"${B}x"`);
  json(`"${B}ud83d${B}ude00${B}u00E9${B}/"`, '"😀é/"');
  json(`"${B}uDBFF${B}uDFFF"`, JSON.stringify('\u{10FFFF}'));
  // recursion limit: 127 nested containers parse, the 128th is an error
  json('['.repeat(127) + ']'.repeat(127), '['.repeat(127) + ']'.repeat(127));
  raw('['.repeat(128) + ']'.repeat(128));
  raw('{"a":'.repeat(128) + '1' + '}'.repeat(128));
  raw('[{"a":'.repeat(64) + '1' + '}]'.repeat(64));
  // numbers: -0 is F64(-0.0); > u64 / < i64::MIN become f64; non-finite is an error; no length cap
  json('[-0, -0.0, 0, -0e5]', '[-0.0,-0.0,0,-0.0]');
  json('[18446744073709551615, 18446744073709551616, -9223372036854775808, -9223372036854775809]',
    '[18446744073709551615,1.8446744073709552e+19,-9223372036854775808,-9.223372036854776e+18]');
  json('0.' + '0'.repeat(440) + '1', '0.0');
  json('1' + '0'.repeat(305), '1e+305');
  raw('1' + '0'.repeat(420));
  raw('[1E400, 2]');
  raw('-'); raw('-01'); raw('1.'); raw('.5'); raw('+1'); raw('1e+'); raw('0x10'); raw('NaN');
  // grammar: trailing commas, literals, trailing characters, only ' \n\t\r' whitespace
  raw('[1,]'); raw('{"a":1,}'); raw('nul'); raw('[1]]'); raw('false x'); raw(' 1'); raw('﻿1'); raw('');
  json(' \n\t{"b":1,"a":[true,false,null]}\r\n', '{"a":[true,false,null],"b":1}');
  // `__proto__` is an ordinary key; duplicate keys keep the last value
  json('{"__proto__":{"x":1},"b":2}', '{"__proto__":{"x":1},"b":2}');
  json('{"a":1,"a":2}', '{"a":2}');
});

// ── portfolio.rs ─────────────────────────────────────────────────────

test('portfolio: token list split on "," and first ":" without trimming', () => {
  assert.equal(stringify(P.parseTokenBalanceList('1:0xa,1:,ethereum,sol:x:y, 1 :z,')),
    '[{"chainIndex":"1","tokenContractAddress":"0xa"},{"chainIndex":"1","tokenContractAddress":""},{"chainIndex":"1","tokenContractAddress":""},{"chainIndex":"501","tokenContractAddress":"x:y"},{"chainIndex":" 1 ","tokenContractAddress":"z"},{"chainIndex":"","tokenContractAddress":""}]');
});

test('portfolio fetch* request shapes', async () => {
  const c = fakeClient();
  await P.fetchChains(c);
  await P.fetchTotalValue(c, '0xA', 'ethereum, base', '1', 'false');
  await P.fetchAllBalances(c, '0xA', 'eth', undefined, '1');
  await P.fetchTokenBalances(c, '0xA', '1:,56:0xb', '0');
  await P.fetchTokenBalances(c, '0xA', '1:', undefined);
  assert.deepEqual(c.calls[0], { m: 'GET', path: '/api/v6/dex/balance/supported/chain', query: [] });
  assert.deepEqual(c.calls[1].query, [['address', '0xA'], ['chains', '1,8453'], ['assetType', '1'], ['excludeRiskToken', 'false']]);
  assert.deepEqual(c.calls[2].query, [['address', '0xA'], ['chains', '1'], ['filter', '1']]);
  assert.equal(stringify(c.calls[3].body), '{"address":"0xA","excludeRiskToken":"0","tokenContractAddresses":[{"chainIndex":"1","tokenContractAddress":""},{"chainIndex":"56","tokenContractAddress":"0xb"}]}');
  assert.equal(stringify(c.calls[4].body), '{"address":"0xA","tokenContractAddresses":[{"chainIndex":"1","tokenContractAddress":""}]}');
});

// ── gateway.rs ───────────────────────────────────────────────────────

test('gateway fetch* request shapes', async () => {
  const c = fakeClient();
  await G.fetchGas(c, '1');
  await G.fetchGasLimit(c, '1', '0xF', '0xT', '0', undefined);
  await G.fetchGasLimit(c, '1', '0xF', '0xT', '5', '0x');
  await G.fetchSimulate(c, '8453', '0xF', '0xT', '0', '0xab');
  await G.fetchOrders(c, '1', '0xA', undefined);
  await G.fetchOrders(c, '1', '0xA', 'o-1');
  await G.fetchChains(c);
  assert.deepEqual(c.calls[0].query, [['chainIndex', '1']]);
  assert.equal(stringify(c.calls[1].body), '{"chainIndex":"1","fromAddress":"0xF","toAddress":"0xT","txAmount":"0"}');
  assert.equal(stringify(c.calls[2].body), '{"chainIndex":"1","extJson":{"inputData":"0x"},"fromAddress":"0xF","toAddress":"0xT","txAmount":"5"}');
  assert.equal(stringify(c.calls[3].body), '{"chainIndex":"8453","extJson":{"inputData":"0xab"},"fromAddress":"0xF","toAddress":"0xT","txAmount":"0"}');
  assert.deepEqual(c.calls[4].query, [['address', '0xA'], ['chainIndex', '1']]);
  assert.deepEqual(c.calls[5].query, [['address', '0xA'], ['chainIndex', '1'], ['orderId', 'o-1']]);
  assert.equal(c.calls[6].path, '/api/v6/dex/pre-transaction/supported/chain');
});

test('gateway broadcast: extraData is a JSON-encoded string; single no-retry POST; no trace id → no headers', async () => {
  assert.equal(stringify(G.broadcastBody('1', '0xdead', '0xA', false)), '{"address":"0xA","chainIndex":"1","signedTx":"0xdead"}');
  assert.equal(stringify(G.broadcastBody('8453', '0xdead', '0xA', true)), '{"address":"0xA","chainIndex":"8453","extraData":"{\\"enableMevProtection\\":true}","signedTx":"0xdead"}');
  const c = fakeClient(() => [{ orderId: 'o' }]);
  assert.deepEqual(await G.fetchBroadcast(c, '1', '0xdead', '0xA', false), [{ orderId: 'o' }]);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].m, 'POST!');
  assert.equal(c.calls[0].path, '/api/v6/dex/pre-transaction/broadcast-transaction');
  assert.equal(c.calls[0].headers, undefined);
});

// ── private clap pass ────────────────────────────────────────────────

test('parseClapInt: RangedI64 (u8/u32) and RangedU64 (u64) messages', () => {
  const err = (raw, t) => { try { K.parseClapInt(raw, t); } catch (e) { return e.message; } return 'ok'; };
  assert.equal(K.parseClapInt('255', 'u8'), 255);
  assert.equal(K.parseClapInt('+7', 'u32'), 7);
  assert.equal(err('300', 'u8'), '300 is not in 0..=255');
  assert.equal(err('-1', 'u8'), '-1 is not in 0..=255');
  assert.equal(err('+300', 'u8'), '300 is not in 0..=255');
  assert.equal(err('99999999999', 'u32'), '99999999999 is not in 0..=4294967295');
  assert.equal(err('99999999999999999999', 'u32'), 'number too large to fit in target type');
  assert.equal(err('-99999999999999999999', 'u32'), 'number too small to fit in target type');
  assert.equal(err('', 'u32'), 'cannot parse integer from empty string');
  assert.equal(err(' 5', 'u8'), 'invalid digit found in string');
  assert.equal(err('+', 'u8'), 'invalid digit found in string');
  assert.equal(K.parseClapInt('18446744073709551615', 'u64'), 18446744073709551615n);
  assert.equal(err('18446744073709551616', 'u64'), 'number too large to fit in target type');
  assert.equal(err('-1', 'u64'), 'invalid digit found in string');
  assert.equal(err('', 'u64'), 'cannot parse integer from empty string');
});

const ctxFor = (argv) => {
  const { parse: cliParse } = globalThis.__cli;
  const p = cliParse(argv);
  return { ctx: { path: p.path, argv }, o: p.opts };
};
globalThis.__cli = await import('../../skill/onchainos-lite/lib/core/cli.mjs');
const usageMsg = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof UsageError); return e.message; } return 'no error'; };

// These clap behaviours are enforced by the core parser (clap model merged into lib/spec.json);
// the expected texts were captured from the upstream 4.6.3 binary.
test('clap parse: hyphen values, typed values in argv order, defaults typed', () => {
  let { ctx, o } = ctxFor(['token', 'hot-tokens', '--price-change-min', '-5', '--limit', '3']);
  assert.deepEqual(K.clapPass(ctx, o, { hyphen: ['priceChangeMin', 'priceChangeMax'] }), {});
  assert.equal(usageMsg(() => ctxFor(['token', 'hot-tokens', '--volume-min', '-1.5'])), "error: unexpected argument '-1' found\n\nUsage: onchainos token hot-tokens [OPTIONS]\n\nFor more information, try '--help'.\n");
  ({ ctx, o } = ctxFor(['token', 'hot-tokens', '--volume-min=-5']));
  assert.doesNotThrow(() => K.clapPass(ctx, o));
  assert.equal(usageMsg(() => ctxFor(['security', 'tx-scan', '--from', 'a', '--chain', '1', '--gas-price', 'x', '--gas', 'y'])), "error: invalid value 'x' for '--gas-price <GAS_PRICE>': invalid digit found in string\n\nFor more information, try '--help'.\n");
  ({ ctx, o } = ctxFor(['token', 'trades', '--address', 'x']));
  assert.deepEqual(K.clapPass(ctx, o, { types: { limit: 'u32' } }), { limit: 100 });
});

test('clap(): once clap accepts argv, Context::new loads AppConfig eagerly (legacy cwd migration)', () => {
  const { ctx, o } = ctxFor(['gateway', 'gas', '--chain', 'base']);
  let loads = 0;
  Object.defineProperty(ctx, 'config', { get() { loads++; return { default_chain: '' }; } });
  assert.deepEqual(K.clap(ctx, o, { leafRequired: ['chain'] }), {});
  assert.equal(loads, 1);
});

test('clap parse: conflicts_with and required leaf --chain shadowed by the global', () => {
  assert.equal(usageMsg(() => ctxFor(['security', 'token-scan', '--address', 'b', '--chain', '1', '--tokens', 'a'])), "error: the argument '--address <ADDRESS>' cannot be used with '--tokens <TOKENS>'\n\nUsage: onchainos security token-scan --address <ADDRESS> --chain <CHAIN>\n\nFor more information, try '--help'.\n");
  assert.match(usageMsg(() => ctxFor(['--chain', 'eth', 'security', 'token-scan', '--tokens', 'a', '--address', 'b'])), /Usage: onchainos security token-scan --tokens <TOKENS>\n/);
  assert.equal(usageMsg(() => ctxFor(['--chain', 'ethereum', 'gateway', 'orders', '--order-id', '5', '--address', '0x1'])), "error: the following required arguments were not provided:\n  --chain <CHAIN>\n\nUsage: onchainos gateway orders --address <ADDRESS> --chain <CHAIN> --order-id <ORDER_ID>\n\nFor more information, try '--help'.\n");
  const { ctx, o } = ctxFor(['gateway', 'gas', '--chain', 'base']);
  assert.deepEqual(K.clapPass(ctx, o, { leafRequired: ['chain'] }), {});
});
