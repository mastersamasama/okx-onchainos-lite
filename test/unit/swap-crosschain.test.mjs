// Unit tests for the swap / cross-chain pure helpers — oracles ported from the upstream
// `#[cfg(test)]` modules of cli/src/commands/swap.rs and cli/src/commands/cross_chain.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowanceInsufficient, classifyApproveAction, extractBatchHashes, historyStatusCmd, nextStepsForSwap, validateSwapMode,
  validateGasLevel, validateTips, validateApproveAmount, swapRoutesMut, classifySwapResponse, attachWalletBalance, quoteFromTokenMeta,
  quoteRequiredFromAmount, swapFundingInput, extractTxHash, extractTxHashAndOrderId, unwrapApiArray, tokenRequiresRevoke,
  ensureDifferentTokens, validateSwapParams, extractApproveCalldata,
} from '../../skill/onchainos-lite/lib/commands/swap/swap.mjs';
import {
  parseApiError, isNoRoute, bridgeableSourceAddresses, buildTransitCandidates, buildTransitOption, rawBalanceFor, bridgeForcesMev,
  classifyDeadEnd, isCanonicalZeroStr, annotateBridgeIdMismatch, validateReceiveAddress, extractBridgeId, unwrapDataArray,
  nextStepsForBridge, buildExecuteData, apiErrorMsg,
} from '../../skill/onchainos-lite/lib/commands/cross-chain/cross-chain.mjs';
import { shortId, flattenReason } from '../../skill/onchainos-lite/lib/agent/task/common/autotrade/notify.mjs';
import { F64, stringify } from '../../skill/onchainos-lite/lib/core/json.mjs';
import { context } from '../../skill/onchainos-lite/lib/core/errors.mjs';

const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48';

// ── swap.rs ──────────────────────────────────────────────────────────

test('is_allowance_insufficient', () => {
  assert.equal(isAllowanceInsufficient('0', '1000000'), true);
  assert.equal(isAllowanceInsufficient('999999', '1000000'), true);
  assert.equal(isAllowanceInsufficient('1000000', '1000000'), false);
  assert.equal(isAllowanceInsufficient('2000000', '1000000'), false);
  assert.equal(isAllowanceInsufficient('abc', '1000000'), true);
  assert.equal(isAllowanceInsufficient('115792089237316195423570985008687907853269984665640564039457584007913129639935', '1000000'), false);
  // unparseable amount → u128::MAX; 38-digit spendable still compared numerically
  assert.equal(isAllowanceInsufficient('1', 'x'), true);
  assert.equal(isAllowanceInsufficient('9'.repeat(38), '1'), false);
  assert.equal(isAllowanceInsufficient('+5', '4'), false);
});

test('classify_approve_action truth table', () => {
  assert.deepEqual(classifyApproveAction('1', USDT_ETH, '1000000', '500000'), [false, false]);
  assert.deepEqual(classifyApproveAction('1', USDT_ETH, '0', '1000000'), [true, false]);
  assert.deepEqual(classifyApproveAction('1', USDT_ETH, '100', '1000000'), [true, true]);
  assert.deepEqual(classifyApproveAction('1', USDC_ETH, '100', '1000000'), [true, false]);
  assert.deepEqual(classifyApproveAction('56', USDT_ETH, '100', '1000000'), [true, false]);
  assert.deepEqual(classifyApproveAction('1', USDT_ETH, '', '1000000'), [true, false]);
  assert.equal(tokenRequiresRevoke('1', USDT_ETH.toUpperCase().replace('0X', '0x')), true);
});

test('extract_batch_hashes', () => {
  assert.deepEqual(extractBatchHashes(['0xmerged'], true, false), [null, '0xmerged']);
  assert.deepEqual(extractBatchHashes(['0xmerged'], true, true), [null, '0xmerged']);
  assert.deepEqual(extractBatchHashes(['0xapprove', '0xswap'], true, false), ['0xapprove', '0xswap']);
  assert.deepEqual(extractBatchHashes(['0xrevoke', '0xapprove', '0xswap'], true, true), ['0xapprove', '0xswap']);
  assert.deepEqual(extractBatchHashes(['0xswap'], false, false), [null, '0xswap']);
});

test('history_status_cmd / next_steps_for_swap', () => {
  assert.equal(historyStatusCmd('solana', '0xabc', '999'), 'onchainos wallet history --tx-hash 0xabc --chain solana');
  assert.equal(historyStatusCmd('solana', '', '1659439748798636032'), 'onchainos wallet history --order-id 1659439748798636032 --chain solana');
  assert.equal(historyStatusCmd('solana', '', ''), null);
  assert.deepEqual(nextStepsForSwap('1', '0xswap', '', null, null), { checkSwapStatus: 'onchainos wallet history --tx-hash 0xswap --chain 1' });
  assert.deepEqual(nextStepsForSwap('solana', '', '1659439748798636032', null, null), { checkSwapStatus: 'onchainos wallet history --order-id 1659439748798636032 --chain solana' });
  assert.deepEqual(nextStepsForSwap('1', '0xswap', '', '0xapprove', null), {
    checkSwapStatus: 'onchainos wallet history --tx-hash 0xswap --chain 1',
    checkApproveStatus: 'onchainos wallet history --tx-hash 0xapprove --chain 1',
  });
  assert.deepEqual(nextStepsForSwap('solana', '', 'swap-oid', null, 'approve-oid'), {
    checkSwapStatus: 'onchainos wallet history --order-id swap-oid --chain solana',
    checkApproveStatus: 'onchainos wallet history --order-id approve-oid --chain solana',
  });
  assert.deepEqual(nextStepsForSwap('1', '', '', null, null), {});
});

test('validate_approve_amount', () => {
  for (const ok of ['0', '1', '1000000', ' 5 ']) assert.doesNotThrow(() => validateApproveAmount(ok));
  assert.throws(() => validateApproveAmount('1.5'), { message: '--amount must be a whole number in minimal units (no decimals)' });
  assert.throws(() => validateApproveAmount('0.1'));
  assert.throws(() => validateApproveAmount('007'), { message: '--amount must not have leading zeros, got "007"' });
  assert.throws(() => validateApproveAmount('00'));
  assert.throws(() => validateApproveAmount('-1'), /Infinity, NaN, negative numbers/);
  assert.throws(() => validateApproveAmount('abc'));
  assert.throws(() => validateApproveAmount(''), { message: '--amount must not be empty' });
});

test('validate_swap_mode / validate_gas_level', () => {
  for (const ok of ['exactIn', 'exactOut']) assert.doesNotThrow(() => validateSwapMode(ok));
  for (const bad of ['exactin', 'EXACTIN', 'ExactIn', '', 'foobar', 'exact_in']) assert.throws(() => validateSwapMode(bad));
  assert.throws(() => validateSwapMode('bad'), { message: '--swap-mode must be "exactIn" or "exactOut", got "bad"' });
  for (const ok of ['slow', 'average', 'fast']) assert.doesNotThrow(() => validateGasLevel(ok));
  for (const bad of ['', 'Slow', 'FAST', 'medium', 'turbo', 'instant']) assert.throws(() => validateGasLevel(bad));
  assert.throws(() => validateGasLevel('medium'), { message: '--gas-level must be "slow", "average", or "fast", got "medium"' });
});

test('validate_tips', () => {
  for (const ok of ['0.0000000001', '0.001', '1', '2', '  1  ', 'NaN', '+.5', '1e-3']) assert.doesNotThrow(() => validateTips(ok), ok);
  assert.throws(() => validateTips('0'), { message: '--tips must be at least 0.0000000001 SOL, got "0"' });
  assert.throws(() => validateTips('0.00000000001'));
  assert.throws(() => validateTips('2.0000000001'), { message: '--tips must be at most 2 SOL, got "2.0000000001"' });
  assert.throws(() => validateTips('3'));
  assert.throws(() => validateTips('abc'), { message: '--tips must be a number in SOL, got "abc"' });
  assert.throws(() => validateTips('-1'));
  assert.throws(() => validateTips(''), { message: '--tips must not be empty' });
  assert.throws(() => validateTips('  '), { message: '--tips must not be empty' });
  assert.throws(() => validateTips('inf'), { message: '--tips must be at most 2 SOL, got "inf"' });
});

test('extract_tx_hash(_and_order_id)', () => {
  assert.deepEqual(extractTxHashAndOrderId({ txHash: '0xabc', orderId: 'ord_123' }), ['0xabc', 'ord_123']);
  assert.deepEqual(extractTxHashAndOrderId({ txHash: '0xabc' }), ['0xabc', '']);
  assert.deepEqual(extractTxHashAndOrderId({ txHash: '0xabc', orderId: '' }), ['0xabc', '']);
  assert.deepEqual(extractTxHashAndOrderId({ txHash: '', orderId: 'ord_async' }), ['', 'ord_async']);
  assert.throws(() => extractTxHashAndOrderId({ orderId: 'ord_123' }), { message: 'missing txHash in contract-call output' });
  assert.throws(() => extractTxHash({ txHash: 5 }));
});

test('swap_routes_mut + classify_swap_route', () => {
  const quote = [{ fromToken: { isHoneyPot: false }, toToken: { isHoneyPot: true } }];
  classifySwapResponse(quote);
  assert.equal(quote[0].action, 'block');
  assert.match(quote[0].reason, /to-token is a honeypot/);
  const swap = [{ routerResult: { fromToken: { isHoneyPot: true }, toToken: { isHoneyPot: false } }, tx: { to: '0xrouter' } }];
  classifySwapResponse(swap);
  assert.equal(swap[0].routerResult.action, 'warn');
  assert.match(swap[0].routerResult.reason, /exit allowed/);
  assert.deepEqual(swap[0].tx, { to: '0xrouter' });
  const clean = [{ fromToken: { isHoneyPot: false }, toToken: { isHoneyPot: false } }];
  classifySwapResponse(clean);
  assert.equal(clean[0].action, 'ok');
  assert.equal(clean[0].reason, '');
  const obj = { fromToken: { isHoneyPot: false }, toToken: { isHoneyPot: true } };
  classifySwapResponse(obj);
  assert.equal(obj.action, 'block');
  const many = [{ fromToken: {}, toToken: { isHoneyPot: true } }, { fromToken: {}, toToken: {} }, 'x', null];
  classifySwapResponse(many);
  assert.equal(many[0].action, 'block');
  assert.equal(many[1].action, 'ok');
  assert.equal(swapRoutesMut({ routerResult: [1] }).length, 1);
  assert.equal(swapRoutesMut(null)[0], null);
  // routerResult that is not an object → the entry itself is the route
  const odd = [{ routerResult: 'x', toToken: { isHoneyPot: true } }];
  classifySwapResponse(odd);
  assert.equal(odd[0].action, 'block');
});

test('attach_wallet_balance', () => {
  const o = { fromToken: { tokenSymbol: 'USDT' } };
  attachWalletBalance(o, '500.25');
  assert.equal(o.walletBalance, '500.25');
  const n = { fromToken: {} };
  attachWalletBalance(n, undefined);
  assert.equal(n.walletBalance, null);
  assert.ok(Object.prototype.hasOwnProperty.call(n, 'walletBalance'));
  const arr = [{ fromToken: {} }, { fromToken: {} }, 'skip'];
  attachWalletBalance(arr, '500.25');
  assert.equal(arr[0].walletBalance, '500.25');
  assert.equal(arr[1].walletBalance, '500.25');
  assert.equal(arr[2], 'skip');
  const nul = [{}];
  attachWalletBalance(nul, null);
  assert.equal(stringify(nul), '[{"walletBalance":null}]');
});

test('quote_from_token_meta / quote_required_from_amount', () => {
  assert.deepEqual(quoteFromTokenMeta([{ fromToken: { tokenSymbol: 'USDT', decimal: '6' }, toToken: { tokenSymbol: 'USDC' } }]), ['USDT', 6]);
  assert.deepEqual(quoteFromTokenMeta({ fromToken: { tokenSymbol: 'ETH', decimal: 18 } }), ['ETH', 18]);
  assert.deepEqual(quoteFromTokenMeta([{ toToken: {} }]), [undefined, undefined]);
  assert.deepEqual(quoteFromTokenMeta([{ fromToken: { decimal: new F64('6.0') } }]), [undefined, undefined]);
  assert.deepEqual(quoteFromTokenMeta([{ fromToken: { decimal: 4294967302 } }]), [undefined, 6]);   // `as u32`
  assert.deepEqual(quoteFromTokenMeta([]), [undefined, undefined]);
  assert.equal(quoteRequiredFromAmount([{ fromTokenAmount: '1250000' }], 'exactIn', '1000000'), '1000000');
  assert.equal(quoteRequiredFromAmount([{ fromTokenAmount: '1250000' }], 'exactOut', '1000000'), '1250000');
  assert.equal(quoteRequiredFromAmount([{ fromTokenAmount: 1250000 }], 'exactOut', '1000000'), '1250000');
  assert.equal(quoteRequiredFromAmount([{ toTokenAmount: '1000000' }], 'exactOut', '1000000'), undefined);
  assert.equal(quoteRequiredFromAmount([{ fromTokenAmount: null }], 'exactOut', '1000000'), undefined);
});

test('swap_funding_input', () => {
  assert.deepEqual(swapFundingInput(USDT_ETH, 'USDT', '100', '20'), { asset: 'USDT', tokenAddress: USDT_ETH, required: '100', balance: '20', operation: 'swap' });
  assert.equal(swapFundingInput(USDT_ETH, '', '100', '20').asset, USDT_ETH);
});

test('validate_swap_params / extract_approve_calldata / unwrap_api_array', () => {
  assert.throws(() => ensureDifferentTokens('0xAbC', '0xabc'), { message: 'fromToken and toToken are the same address (0xAbC). Cannot swap a token to itself.' });
  assert.throws(() => validateSwapParams('1', '0x12', USDT_ETH), /--from is not a valid EVM address/);
  assert.doesNotThrow(() => validateSwapParams('1', USDC_ETH, USDT_ETH));
  assert.equal(extractApproveCalldata([{ data: '0x095e' }]), '0x095e');
  assert.equal(extractApproveCalldata({ data: '0x095e' }), '0x095e');
  assert.throws(() => extractApproveCalldata([]), { message: "missing 'data' field in approve response" });
  assert.deepEqual(unwrapApiArray([{ a: 1 }, { a: 2 }]), { a: 1 });
  assert.deepEqual(unwrapApiArray({ a: 1 }), { a: 1 });
  assert.equal(unwrapApiArray([]), null);
});

// ── cross_chain.rs ───────────────────────────────────────────────────

test('parse_api_error / api_error_msg', () => {
  assert.deepEqual(parseApiError('API error (code=82000): Insufficient liquidity'), ['82000', 'Insufficient liquidity']);
  assert.deepEqual(parseApiError('API error (code=82000): '), ['82000', '']);
  assert.equal(parseApiError('some other error'), null);
  assert.deepEqual(parseApiError('x code= 7 ) ::: y '), ['7', '::: y']);
  assert.deepEqual(parseApiError('code=1):: z'), ['1', 'z']);
  assert.equal(apiErrorMsg(new Error('API error (code=82104): token')), 'token');
  assert.equal(apiErrorMsg(new Error('plain failure')), 'plain failure');
  // anyhow Display prints only the outermost context
  assert.equal(apiErrorMsg(context('Network unavailable — check your connection and try again', new Error('ECONNRESET'))), 'Network unavailable — check your connection and try again');
});

test('is_no_route', () => {
  assert.equal(isNoRoute({ err: new Error('API error (code=82000): no liquidity') }), true);
  assert.equal(isNoRoute({ err: new Error('API error (code=82104): token') }), true);
  assert.equal(isNoRoute({ ok: [{ routerList: [] }] }), true);
  assert.equal(isNoRoute({ ok: [{}] }), true);
  assert.equal(isNoRoute({ ok: [] }), true);
  assert.equal(isNoRoute({ ok: [{ routerList: [{ bridgeId: 1 }] }] }), false);
  assert.equal(isNoRoute({ err: new Error('API error (code=50114): not logged in') }), false);
  assert.equal(isNoRoute({ err: new Error('Server error (HTTP 503)') }), false);
});

test('bridgeable_source_addresses', () => {
  const set = bridgeableSourceAddresses([
    { chainIndex: '1', tokenContractAddress: '0xAAA' },
    { chainIndex: '1', tokenContractAddress: '0xbbb' },
    { chainIndex: '1088', tokenContractAddress: '0xCCC' },
    { chainIndex: 1, tokenContractAddress: '0xDDD' },
  ], '1');
  assert.deepEqual([...set].sort(), ['0xaaa', '0xbbb']);
  assert.equal(bridgeableSourceAddresses({ not: 'array' }, '1').size, 0);
});

test('build_transit_candidates', () => {
  const all = buildTransitCandidates('1', '42161', new Set());
  assert.ok(all.length > 0);
  const only = all[0].address.toLowerCase();
  const filtered = buildTransitCandidates('1', '42161', new Set([only]));
  assert.ok(filtered.every((c) => c.address.toLowerCase() === only));
  const usdc = all.find((c) => c.symbol === 'USDC');
  assert.equal(usdc.address, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(usdc.destAddress, '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  assert.ok(all.every((c) => c.symbol !== 'DAI'));
  assert.ok(all.some((c) => c.symbol === 'NATIVE'));
  const usdt = all.find((c) => c.symbol === 'USDT');
  assert.equal(usdt.address, USDT_ETH);
  assert.equal(usdt.destAddress, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9');
  const sol = buildTransitCandidates('501', '1', new Set());
  const su = sol.find((c) => c.symbol === 'USDC');
  assert.equal(su.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(su.destAddress, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  const native = sol.find((c) => c.symbol === 'NATIVE');
  assert.equal(native.address, '11111111111111111111111111111111');
  assert.equal(native.destAddress, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const destOnly = buildTransitCandidates('1', '42161', new Set(['0xaf88d065e77c8cc2239327c5edb3a432268e5831']));
  assert.ok(destOnly.every((c) => c.symbol !== 'USDC'));
});

test('build_transit_option', () => {
  const opt = buildTransitOption('USDC', [{ toToken: { decimals: 6 }, routerList: [{ bridgeName: 'ACROSS V3', bridgeId: 636, toTokenAmount: '999533', minimumReceived: '999533', crossChainFee: '466', crossChainFeeTokenAddress: '0xaf88', otherNativeFee: '0', estimateTime: '43' }] }]);
  assert.equal(opt.transitToken, 'USDC');
  assert.equal(opt.bridgeName, 'ACROSS V3');
  assert.equal(opt.toTokenAmount, '999533');
  assert.equal(opt.toTokenDecimals, 6);
  assert.equal(buildTransitOption('USDC', [{ routerList: [] }]), null);
  assert.equal(buildTransitOption('USDC', [{ routerList: [{}] }]).bridgeId, null);
});

test('raw_balance_for / bridge_forces_mev / classify_dead_end', () => {
  const assets = [{ tokenContractAddress: '0xAaA', rawBalance: '100' }, { tokenContractAddress: '0xbbb', rawBalance: '200' }, { tokenContractAddress: '0xccc', rawBalance: 5 }];
  assert.equal(rawBalanceFor(assets, '0xaaa'), '100');
  assert.equal(rawBalanceFor(assets, '0xBBB'), '200');
  assert.equal(rawBalanceFor(assets, '0xddd'), '0');
  assert.equal(rawBalanceFor(assets, '0xccc'), '0');
  assert.equal(bridgeForcesMev('RELAY'), true);
  assert.equal(bridgeForcesMev('Mayan Swift'), true);
  assert.equal(bridgeForcesMev('butterswap'), true);
  assert.equal(bridgeForcesMev('ACROSS V3'), false);
  assert.equal(bridgeForcesMev('STARGATE V2 TAXI MODE'), false);
  assert.deepEqual(classifyDeadEnd(['Insufficient liquidity']), ['no_path', 'Insufficient liquidity']);
  assert.equal(classifyDeadEnd(['', 'unknown error', '  ']).at(0), 'env_unavailable');
  assert.equal(classifyDeadEnd([]).at(0), 'env_unavailable');
});

test('is_canonical_zero_str', () => {
  for (const z of ['0', '0.0', '0.00', '0.000000']) assert.equal(isCanonicalZeroStr(z), true, z);
  for (const nz of ['-0', '+0', '-0.0', '00', '001', '00.0', '', '0.', '.0', '0e10', '0.0.0', '0.0a', '1', '0.1']) assert.equal(isCanonicalZeroStr(nz), false, nz);
});

test('annotate_bridge_id_mismatch', () => {
  const out = annotateBridgeIdMismatch([{ bridgeId: 52, status: 'PENDING', txHash: '0xabc' }], '636');
  assert.match(out[0]._warning, /requested 636/);
  assert.match(out[0]._warning, /echoed 52/);
  assert.equal(annotateBridgeIdMismatch([{ bridgeId: 636 }], '636')[0]._warning, undefined);
  assert.equal(annotateBridgeIdMismatch([{ bridgeId: '636' }], '636')[0]._warning, undefined);
  assert.deepEqual(annotateBridgeIdMismatch([{ bridgeId: 52 }], undefined), [{ bridgeId: 52 }]);
  assert.deepEqual(annotateBridgeIdMismatch([{ status: 'NOT_FOUND' }], '636'), [{ status: 'NOT_FOUND' }]);
  assert.equal(annotateBridgeIdMismatch([{ bridgeId: new F64('52.0') }], '636')[0]._warning, undefined);
  assert.equal(stringify(annotateBridgeIdMismatch([{ bridgeId: 52 }], '636')).startsWith('[{"_warning"'), true);
});

test('validate_receive_address', () => {
  assert.throws(() => validateReceiveAddress('0x896f4edd6601eda7d12f077a35e1cdf2898282ce', '501'), /destination chain is Solana/);
  assert.throws(() => validateReceiveAddress('5EDUCQDeVmaGohSAJYQ8mwe4hZMXgDzS4X2Si3Zh3cL5', '8453'), /destination chain is EVM/);
  assert.doesNotThrow(() => validateReceiveAddress('5EDUCQDeVmaGohSAJYQ8mwe4hZMXgDzS4X2Si3Zh3cL5', '501'));
  assert.doesNotThrow(() => validateReceiveAddress('0x896f4edd6601eda7d12f077a35e1cdf2898282ce', '1'));
  assert.throws(() => validateReceiveAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '195'), /destination chain is EVM/);   // quirk 8
  assert.doesNotThrow(() => validateReceiveAddress('bad', '1'));
});

test('extract_bridge_id / unwrap_data_array / next_steps_for_bridge', () => {
  assert.equal(extractBridgeId({ bridgeId: 636 }), '636');
  assert.equal(extractBridgeId({ bridgeId: '636' }), '636');
  assert.throws(() => extractBridgeId({}), { message: 'quote.routerList[0].bridgeId missing or wrong type' });
  assert.throws(() => extractBridgeId({ bridgeId: new F64('1.5') }));
  assert.deepEqual(unwrapDataArray([{ a: 1 }, { a: 2 }]), { a: 1 });
  assert.deepEqual(unwrapDataArray({ a: 1 }), { a: 1 });
  assert.equal(unwrapDataArray([]), null);
  assert.deepEqual(nextStepsForBridge('199', '1', '0xabc'), { checkBridgeStatus: 'onchainos cross-chain status --tx-hash 0xabc --bridge-id 199 --from-chain 1' });
});

test('build_execute_data', () => {
  const route = { bridgeId: 199, bridgeName: 'Across', needApprove: true, needCancelApprove: false, estimateTime: '30', minimumReceived: '0.99', toTokenAmount: '1.00', crossChainFee: '0.01', fromToken: { tokenSymbol: 'USDC' } };
  const out = buildExecuteData(route, '199', '1', '0xfromhash', 'swap-oid-42', null, null);
  assert.equal(out.action, 'execute');
  assert.equal(out.fromTxHash, '0xfromhash');
  assert.equal(out.fromChainIndex, '1');
  assert.equal(out.bridgeId, '199');
  assert.equal(out.bridgeName, 'Across');
  assert.equal(out.swapOrderId, 'swap-oid-42');
  assert.equal(out.nextSteps.checkBridgeStatus, 'onchainos cross-chain status --tx-hash 0xfromhash --bridge-id 199 --from-chain 1');
  assert.ok(!('approveTxHash' in out) && !('approveOrderId' in out));
  const approved = buildExecuteData(route, '199', '1', '0xfromhash', 'swap-oid', '0xapprovehash', 'approve-oid-7');
  assert.equal(approved.approveTxHash, '0xapprovehash');
  assert.equal(approved.approveOrderId, 'approve-oid-7');
  assert.ok(!('swapOrderId' in buildExecuteData(route, '199', '1', '0xfromhash', '', null, null)));
  assert.equal(buildExecuteData({}, '1', '1', '0x', '', null, null).minimumReceived, null);
});

// ── private helpers ──────────────────────────────────────────────────

test('notify short_id / flatten_reason', () => {
  assert.equal(shortId('usdc'), 'usdc');
  assert.equal(shortId('0xb5b8b2b800000000000000000000000000000000000000000000000000009b35'), '0xb5b8…9b35');
  assert.equal(flattenReason('line one\n  line two'), 'line one line two');
  const cut = flattenReason('x'.repeat(400));
  assert.equal([...cut].length, 301);
  assert.ok(cut.endsWith('…'));
});

// str::split_whitespace splits on Unicode White_Space: U+0085 (NEL) is a separator, U+FEFF (BOM)
// is not -- the opposite of the JS regex class for whitespace.
const ch = (cp) => String.fromCodePoint(cp);
test('notify flatten_reason uses Rust whitespace', () => {
  assert.equal(flattenReason('a' + ch(0x85) + 'b'), 'a b');
  assert.equal(flattenReason('a' + ch(0xfeff) + 'b'), 'a' + ch(0xfeff) + 'b');
  assert.equal(flattenReason(ch(0x3000) + 'a' + ch(0x2028) + ch(0x2029) + 'b' + ch(0xa0)), 'a b');
});
