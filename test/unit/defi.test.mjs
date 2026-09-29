// Unit tests for lib/commands/defi/** (upstream cli/src/commands/defi/{api,helpers,operations}.rs).
// Oracles: the upstream Rust doc examples / #[cfg(test)] cases and the behaviour spec g08.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.OCL_HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-defi-'));
process.env.ONCHAINOS_HOME = process.env.OCL_HOME;

const helpers = await import('../../skill/onchainos-lite/lib/commands/defi/helpers.mjs');
const ops = await import('../../skill/onchainos-lite/lib/commands/defi/operations.mjs');
const api = await import('../../skill/onchainos-lite/lib/commands/defi/api.mjs');
const { parse, stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');

// A client stub recording every call and answering from a per-path queue.
function stubClient(routes = {}) {
  const log = [];
  const answer = (method, path, arg) => {
    log.push({ method, path, arg: JSON.parse(stringify(arg ?? null)) });
    const q = routes[path];
    if (q === undefined) throw new Error(`no stub for ${path}`);
    const v = Array.isArray(q) && q.__queue ? (q.length > 1 ? q.shift() : q[0]) : q;
    if (v instanceof Error) throw v;
    return structuredClone(v);
  };
  return { log, get: async (p, q) => answer('GET', p, q), post: async (p, b) => answer('POST', p, b) };
}
const queue = (...xs) => Object.assign(xs, { __queue: true });

test('minimal_to_decimal_str', () => {
  const cases = [['500000', 6, '0.5'], ['1154528481238320444', 18, '1.154528481238320444'], ['1', 6, '0.000001'], ['1000000', 6, '1'],
    ['00500000', 6, '00.5'], ['abc', 6, '0.000abc'], ['17', 0, '17'], ['0', 6, '0'], ['', 2, '0'], ['120', 1, '12']];
  for (const [a, p, want] of cases) assert.equal(helpers.minimalToDecimalStr(a, p), want, `${a},${p}`);
});

test('decimal_to_minimal_str', () => {
  const cases = [['0.5', 6, '500000'], ['226.483834', 6, '226483834'], ['0.005', 18, '5000000000000000'], ['17.123456789', 6, '17123456'],
    ['0', 6, '0'], ['', 6, '0'], ['1.2.3', 4, '12.30'], ['12.9', 0, '12'], ['.5', 2, '50'], ['000.000', 3, '0']];
  for (const [a, p, want] of cases) assert.equal(helpers.decimalToMinimalStr(a, p), want, `${a},${p}`);
});

test('convert_minimal_to_decimal', () => {
  const items = parse('[{"tokenAddress":"0xa","coinAmount":"500000","tokenPrecision":"6"},{"coinAmount":5,"tokenPrecision":18},{"coinAmount":"42","tokenPrecision":4294967302}]');
  helpers.convertMinimalToDecimal(items);
  assert.equal(stringify(items), '[{"coinAmount":"0.5","tokenAddress":"0xa"},{"coinAmount":5},{"coinAmount":"0.000042"}]');
  const err = (v) => { try { helpers.convertMinimalToDecimal(parse(v)); } catch (e) { return e.message; } return null; };
  assert.equal(err('[{"coinAmount":"500000"}]'), 'tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision');
  assert.equal(err('[{"coinAmount":"1","tokenPrecision":"4294967296"}]'), 'tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision');
  assert.equal(err('[{"coinAmount":"1","tokenPrecision":-1}]'), 'tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision');
  assert.equal(err('[1]'), 'tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision');
  assert.equal(err('[{"coinAmount":"000","tokenPrecision":6}]'), 'coinAmount cannot be zero or empty. Got "000".');
  assert.equal(err('[{"coinAmount":"","tokenPrecision":6}]'), 'coinAmount cannot be zero or empty. Got "".');
  assert.equal(err('[{"coinAmount":"0.5","tokenPrecision":"6"}]'),
    'coinAmount must be an integer (minimal units), got "0.5". Convert: userAmount x 10^tokenPrecision. Example: 0.5 USDC (precision=6) -> coinAmount="500000"');
  assert.equal(err('[{"coinAmount":"1","tokenPrecision":"+6"}]'), null);
});

test('annotate_datalist_value_normalized (operations.rs tests)', () => {
  const result = parse('{"dataList":[{"value":"0x1a","to":"0xabc"},{"value":"0x0"},{"value":"abc"},{"value":"123456"},{"to":"x"},{"value":-1},{"value":1.5},"raw"],"other":"preserved"}');
  ops.annotateDatalistValueNormalized(result);
  const s = result.dataList;
  assert.deepEqual([s[0].valueNormalized, s[0].value, s[0].to], ['26', '0x1a', '0xabc']);
  assert.equal(s[1].valueNormalized, '0');
  assert.deepEqual([s[2].valueNormalized, s[2].valueNormalizeError], ['0', "unparseable value 'abc'"]);
  assert.equal(s[3].valueNormalized, '123456');
  assert.equal(s[4].valueNormalized, '0');
  assert.equal(s[5].valueNormalizeError, "value must be a non-negative integer minimal unit, got '-1'");
  assert.equal(s[6].valueNormalizeError, "value must be a non-negative integer minimal unit, got '1.5'");
  assert.equal(s[7], 'raw');
  assert.equal(result.other, 'preserved');
  const noList = { foo: 1 };
  ops.annotateDatalistValueNormalized(noList);
  assert.deepEqual(noList, { foo: 1 });
  const nonArray = { dataList: 'oops' };
  ops.annotateDatalistValueNormalized(nonArray);
  assert.deepEqual(nonArray, { dataList: 'oops' });
  ops.annotateDatalistValueNormalized(null);
});

test('validate_amount / validate_amount_v3', () => {
  assert.throws(() => ops.validateAmount('0.1'), { message: 'amount must be in minimal units (integer), got "0.1". Convert: userAmount × 10^tokenPrecision. Example: 0.1 USDC (precision=6) → amount="100000"' });
  assert.throws(() => ops.validateAmount('000'), { message: 'amount cannot be zero or empty. Got "000".' });
  assert.throws(() => ops.validateAmount(''), { message: 'amount cannot be zero or empty. Got "".' });
  assert.doesNotThrow(() => ops.validateAmount('100000'));
  assert.doesNotThrow(() => ops.validateAmountV3('0'));
  assert.throws(() => ops.validateAmountV3(''), { message: 'amount cannot be empty.' });
  assert.throws(() => ops.validateAmountV3('1.5'), /minimal units/);
});

test('is_investable / token matching / token info', () => {
  assert.equal(ops.isInvestable({ isInvestable: true }), true);
  assert.equal(ops.isInvestable({ isInvestable: '1' }), true);
  assert.equal(ops.isInvestable({ isInvestable: 'yes' }), false);
  assert.equal(ops.isInvestable({ isInvestable: 1 }), false);
  assert.equal(ops.isInvestable({}), false);
  assert.equal(ops.isInvestable([]), false);
  const list = [{ tokenSymbol: 'USDC', tokenAddress: '0xA0b8', tokenPrecision: '6', chainIndex: '1' }, { tokenSymbol: 'WETH', tokenAddress: '0xc02a', tokenPrecision: 18, chainIndex: '1' }, { tokenAddress: '0xnosym' }];
  assert.equal(ops.findMatchingToken(list, 'usdc'), list[0]);
  assert.equal(ops.findMatchingToken(list, '0XC02A'), list[1]);
  assert.throws(() => ops.findMatchingToken(list, 'DAI'), { message: "Token 'DAI' not found in investWithTokenList. Available: USDC, WETH" });
  assert.deepEqual(ops.extractTokenInfo(list[0], 'x'), { address: '0xA0b8', chainIndex: '1', precision: 6, symbol: 'USDC' });
  assert.deepEqual(ops.extractTokenInfo({ tokenAddress: '0x1', chainIndex: '1', tokenPrecision: 'x' }, 'x'), { address: '0x1', chainIndex: '1', precision: 18, symbol: 'UNKNOWN' });
  assert.throws(() => ops.extractTokenInfo({ tokenAddress: '' }, 'T'), { message: "tokenAddress is empty for token 'T'" });
  assert.throws(() => ops.extractTokenInfo({ tokenAddress: '0x1', chainIndex: 1 }, 'T'), { message: "chainIndex is empty for token 'T'" });
  assert.equal(ops.findTokenPrecision(list, '0XA0B8'), 6);
  assert.equal(ops.findTokenPrecision(list, '0xnone'), 18);
  assert.equal(ops.findTokenAmountInCalcResult({ investWithTokenList: [{ tokenAddress: '0xAB', coinAmount: '1.5' }] }, '0xab'), '1.5');
  assert.equal(ops.findTokenAmountInCalcResult({ investWithTokenList: [{ tokenAddress: '0xAB', coinAmount: 1 }] }, '0xab'), '0');
  assert.throws(() => ops.findTokenAmountInCalcResult({}, '0x'), { message: 'calculate-entry response missing investWithTokenList' });
  assert.deepEqual(ops.investStandard({ address: '0xa', chainIndex: '1', precision: 6, symbol: 'USDC' }, '100'),
    ['[{"chainIndex":"1","coinAmount":"100","tokenAddress":"0xa","tokenPrecision":"6"}]', null]);
});

test('resolve_ticks', () => {
  assert.deepEqual(ops.resolveTicks({}, -5, 7, null), [-5, 7]);
  assert.deepEqual(ops.resolveTicks({ currentTick: '-195123', tickSpacing: '60' }, null, null, 5), [-204840, -185280]);
  assert.deepEqual(ops.resolveTicks({ currentTick: 195120, tickSpacing: 200 }, null, null, 0.001), [194600, 195600]);
  assert.deepEqual(ops.resolveTicks({ currentTick: '0', tickSpacing: '10' }, 5, null, NaN), [-20, 20]);
  assert.throws(() => ops.resolveTicks({}, null, null, 150), { message: '--range must be between 0 and 100 (percent), got 150' });
  assert.throws(() => ops.resolveTicks({}, null, null, -5), { message: '--range must be between 0 and 100 (percent), got -5' });
  assert.throws(() => ops.resolveTicks({}, null, null, 5), { message: 'currentTick not found in prepare response' });
  assert.throws(() => ops.resolveTicks({ currentTick: '1', tickSpacing: 'x' }, null, null, 5), { message: 'tickSpacing not found in prepare response' });
  assert.throws(() => ops.resolveTicks({ currentTick: '-1', tickSpacing: 60 }, -5, null, null),
    { message: 'V3 pool requires --range (e.g. --range 5 for ±5%) or --tick-lower/--tick-upper. Current tick: -1, tick spacing: unknown.' });
});

test('append_warnings', () => {
  assert.deepEqual(ops.appendWarnings({ a: 1 }, { rate: '0.51', healthRate: 1.49 }), { a: 1, highApyWarning: true, liquidationWarning: true });
  assert.deepEqual(ops.appendWarnings({ a: 1 }, { rate: '0.5', healthRate: '1.5' }), { a: 1 });
  assert.deepEqual(ops.appendWarnings(null, { rate: 0.75 }), { highApyWarning: true });
  assert.deepEqual(ops.appendWarnings({}, { rate: 'n/a', healthRate: 'x' }), {});
  assert.throws(() => ops.appendWarnings([1], { rate: '1' }), /cannot access key "highApyWarning" in JSON array/);
});

const PD = parse(JSON.stringify([{ walletIdPlatformDetailList: [{ networkHoldVoList: [{
  investTokenBalanceVoList: [{ investmentId: 9510, assetsTokenList: [] }, { investmentId: 9502, assetsTokenList: [{ tokenSymbol: 'aEthUSDC', tokenAddress: '0xa', tokenPrecision: '6', coinAmount: '100.235', chainIndex: '1' }],
    rewardDefiTokenInfo: [{ rewardType: 'REWARD_INVESTMENT', baseDefiTokenInfos: [{ tokenAddress: '0xaave', coinAmount: '0.0169' }] }] },
  { investmentId: '9511', rewardDefiTokenInfo: [{ rewardType: 'REWARD_INVESTMENT', baseDefiTokenInfos: [{ tokenAddress: '0xskip', coinAmount: '9' }] }] }],
  investMarketTokenBalanceVoList: [{ marketRewards: [{ rewardType: 'REWARD_PLATFORM', baseDefiTokenInfos: [{ tokenAddress: '0xstk', coinAmount: '1.25' }, { tokenAddress: '0xzero' }] }],
    assetMap: { SUPPLY: [{ investmentId: 9506, assetsTokenList: [{ tokenAddress: '0xw', tokenPrecision: 18, coinAmount: '0.5' }], rewardDefiTokenInfo: [{ rewardType: 'REWARD_OKX_BONUS', baseDefiTokenInfos: [{ tokenAddress: '0xusdc', coinAmount: '0.5' }] }] }] } }],
  availableRewards: [{ rewardType: 'REWARD_PLATFORM', baseDefiTokenInfos: [{ tokenAddress: '0xstk', coinAmount: '1.25' }, { tokenAddress: '0xaave', coinAmount: '0.3' }] },
    { rewardType: 'REWARD_OKX_BONUS', baseDefiTokenInfos: [{ tokenAddress: '0xusdc', coinAmount: '0.5' }] }],
}] }] }]));

test('find_position_token', () => {
  assert.deepEqual(ops.findPositionToken(PD, '9502'), { address: '0xa', chainIndex: '1', precision: 6, balance: '100.235', symbol: 'aEthUSDC' });
  assert.deepEqual(ops.findPositionToken(PD, '9506'), { address: '0xw', chainIndex: '', precision: 18, balance: '0.5', symbol: 'UNKNOWN' });
  assert.throws(() => ops.findPositionToken(PD, '9510'), { message: 'No position found for investmentId 9510 in position-detail' });
  assert.throws(() => ops.findPositionToken({}, '1'), { message: 'position-detail response is not an array' });
});

test('extract_expect_output', async () => {
  const path = '/api/v6/defi/user/asset/platform/detail';
  const run = (rt, id) => helpers.extractExpectOutput(stubClient({ [path]: PD }), '0xw', '1', '10', rt, id);
  assert.equal(await run('REWARD_PLATFORM', null), '[{"chainIndex":"1","coinAmount":"1.25","tokenAddress":"0xstk"},{"chainIndex":"1","coinAmount":"0","tokenAddress":"0xzero"},{"chainIndex":"1","coinAmount":"0.3","tokenAddress":"0xaave"}]');
  assert.equal(await run('REWARD_INVESTMENT', '9502'), '[{"chainIndex":"1","coinAmount":"0.0169","tokenAddress":"0xaave"}]');
  assert.equal(await run('REWARD_INVESTMENT', null), '[{"chainIndex":"1","coinAmount":"0.0169","tokenAddress":"0xaave"},{"chainIndex":"1","coinAmount":"9","tokenAddress":"0xskip"}]');
  assert.equal(await run('REWARD_OKX_BONUS', '9506'), '[{"chainIndex":"1","coinAmount":"0.5","tokenAddress":"0xusdc"}]');
  assert.equal(await run('V3_FEE', null), null);
  const c = stubClient({ [path]: { not: 'array' } });
  assert.equal(await helpers.extractExpectOutput(c, '0xw', '56', '10', 'REWARD_PLATFORM', null), null);
  assert.deepEqual(c.log[0].arg, { platformList: [{ analysisPlatformId: '10', chainIndex: '56' }], walletAddressList: [{ chainIndex: '56', walletAddress: '0xw' }] });
});

test('request bodies (api.rs)', async () => {
  const c = stubClient({
    '/api/v6/defi/product/search': {}, '/api/v6/defi/transaction/enter': {}, '/api/v6/defi/transaction/exit': {}, '/api/v6/defi/transaction/claim': {},
    '/api/v6/defi/product/rate/chart': [], '/api/v6/defi/user/asset/platform/list': [],
  });
  await api.fetchSearch(c, 'USDC, ETH,', null, '1', null, 2);
  await api.fetchEnter(c, '9502', '0xw', '[{"coinAmount":"500000","tokenPrecision":"6"}]', '0.01', null, -5, null);
  await api.fetchExit(c, '9502', '56', '0xw', null, '0xt', 'USDT', '1.5', 18, null, '0.01', null);
  await api.fetchClaim(c, '0xw', 'foo', 'X', null, '10', null, null, '[]');
  await api.fetchClaim(c, '0xw', '', 'X', null, null, null, null, null);
  await api.fetchClaim(c, '0xw', '9007199254740993', 'X', null, null, null, null, null);
  await api.fetchRateChart(c, '9502', null);
  await api.fetchPositions(c, '0xw', 'eth, bsc,');
  assert.deepEqual(c.log.map((x) => x.arg), [
    { chainIndex: '1', pageNum: 2, tokenKeywordList: ['USDC', 'ETH', ''] },
    { address: '0xw', investmentId: '9502', slippage: '0.01', tickLower: -5, userInputList: [{ coinAmount: '0.5' }] },
    { address: '0xw', investmentId: '9502', slippage: '0.01', userInputList: [{ chainIndex: '56', coinAmount: '1.5', tokenAddress: '0xt', tokenPrecision: 18, tokenSymbol: 'USDT' }] },
    { address: '0xw', analysisPlatformId: '10', chainIndex: 0, expectOutputList: [], rewardType: 'X' },
    { address: '0xw', rewardType: 'X' },
    { address: '0xw', chainIndex: 9007199254740992, rewardType: 'X' },
    [['investmentId', '9502']],
    { walletAddressList: [{ chainIndex: '1', walletAddress: '0xw' }, { chainIndex: '56', walletAddress: '0xw' }, { chainIndex: '', walletAddress: '0xw' }] },
  ]);
  await assert.rejects(api.fetchEnter(c, '1', '0xw', 'not json', '0.01'), { message: 'failed to parse --user-input as JSON array: expected ident at line 1 column 2' });
  await assert.rejects(api.fetchClaim(c, '0xw', '', 'X', null, null, null, null, '{}'), { message: 'failed to parse --expect-output as JSON array: invalid type: map, expected a sequence at line 1 column 0' });
});

test('invest V3 dual rebalance', async () => {
  const calc = '/api/v6/defi/calculator/enter/info';
  const weth = { address: '0xweth', chainIndex: '1', precision: 18, symbol: 'WETH' };
  const usdc = { address: '0xusdc', chainIndex: '1', precision: 6, symbol: 'USDC' };
  const c1 = stubClient({ [calc]: { investWithTokenList: [{ tokenAddress: '0xWETH', coinAmount: '0.005' }, { tokenAddress: '0xUSDC', coinAmount: '17.123456789' }] } });
  assert.deepEqual(await ops.investV3Dual(c1, '42001', '0xw', weth, '5000000000000000', usdc, '20000000', -1, 1),
    ['[{"chainIndex":"1","coinAmount":"5000000000000000","tokenAddress":"0xweth","tokenPrecision":"18"},{"chainIndex":"1","coinAmount":"17123456","tokenAddress":"0xusdc","tokenPrecision":"6"}]',
      ['USDC', '0xusdc', '2.876544']]);
  const c2 = stubClient({ [calc]: queue({ investWithTokenList: [{ tokenAddress: '0xusdc', coinAmount: '17.123456' }] }, { investWithTokenList: [{ tokenAddress: '0xweth', coinAmount: '0.0031' }] }) });
  const [json2, surplus2] = await ops.investV3Dual(c2, '42001', '0xw', weth, '5000000000000000', usdc, '10000000', null, null);
  assert.equal(json2, '[{"chainIndex":"1","coinAmount":"3100000000000000","tokenAddress":"0xweth","tokenPrecision":"18"},{"chainIndex":"1","coinAmount":"10000000","tokenAddress":"0xusdc","tokenPrecision":"6"}]');
  assert.deepEqual(surplus2, ['WETH', '0xweth', '0.0019']);
  assert.deepEqual(c2.log.map((x) => x.arg.inputAmount), ['0.005', '10']);
});
