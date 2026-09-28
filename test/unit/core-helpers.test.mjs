// core-helpers: token_alias.rs, validators.rs, commands/sink.rs, commands/common.rs,
// asset_class.rs, funding.rs, commands/risk_classify.rs.
// Every assertion of the upstream #[cfg(test)] modules is ported (the oracle), followed by
// exact-message / edge-case checks taken from the Rust source.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated, empty state dir (chains.mjs reads chain_cache.json from it) — set before any
// module that reads lib/config.mjs is imported, hence the dynamic imports below.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-core-helpers-'));
process.env.OCL_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LIB = '../../skill/onchainos-lite/lib/core/';
const TA = await import(LIB + 'token-alias.mjs');
const V = await import(LIB + 'validators.mjs');
const S = await import(LIB + 'sink.mjs');
const C = await import(LIB + 'common.mjs');
const AC = await import(LIB + 'asset-class.mjs');
const F = await import(LIB + 'funding.mjs');
const R = await import(LIB + 'risk-classify.mjs');
const RS = await import(LIB + '_rust-str.mjs');
const WA = await import('../../skill/onchainos-lite/lib/wallet/account.mjs');
const Q = await import(LIB + 'qr.mjs');
const { stringify, parse, F64 } = await import(LIB + 'json.mjs');
const { CodedError } = await import(LIB + 'errors.mjs');

const ok = (fn) => assert.doesNotThrow(fn);
const err = (fn, msg) => (msg === undefined ? assert.throws(fn) : assert.throws(fn, (e) => { assert.equal(e.message, msg); return true; }));
const errMsg = (fn) => { try { fn(); } catch (e) { return e.message; } return assert.fail('expected an error'); };

// ═════════════════════════════ token_alias.rs ═════════════════════════════

test('token_alias: resolve_known_alias_returns_canonical_ca', () => {
  assert.equal(TA.resolveTokenAddress('501', 'usdc'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(TA.resolveTokenAddress('1', 'USDT'), '0xdac17f958d2ee523a2206206994597c13d831ec7');
  assert.equal(TA.resolveTokenAddress('501', 'native'), '11111111111111111111111111111111');
});

test('token_alias: resolve_unknown_token_returns_input_unchanged', () => {
  assert.equal(TA.resolveTokenAddress('501', 'aaa'), 'aaa');
  assert.equal(TA.resolveTokenAddress('1', '0xdac17f958d2ee523a2206206994597c13d831ec7'), '0xdac17f958d2ee523a2206206994597c13d831ec7');
});

test('token_alias: resolve_is_case_insensitive', () => {
  assert.equal(TA.resolveTokenAddress('501', 'USDC'), TA.resolveTokenAddress('501', 'usdc'));
  assert.equal(TA.resolveTokenAddress('1', 'Usdt'), TA.resolveTokenAddress('1', 'usdt'));
});

test('token_alias: validate_evm_valid', () => {
  ok(() => TA.validateAddressForChain('1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'from'));
  ok(() => TA.validateAddressForChain('1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'wallet'));
  ok(() => TA.validateAddressForChain('56', '0x55d398326f99059ff775485246999027b3197955', 'token'));
});

test('token_alias: validate_evm_rejects_solana_address', () => {
  const sol = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  err(() => TA.validateAddressForChain('1', sol, 'from'));
  err(() => TA.validateAddressForChain('56', sol, 'token'));
  err(() => TA.validateAddressForChain('8453', sol, 'wallet'));
});

test('token_alias: validate_evm_rejects_short_address', () => {
  err(() => TA.validateAddressForChain('1', '0xabc123', 'from'));
  err(() => TA.validateAddressForChain('56', '0x1234', 'token'));
});

test('token_alias: validate_evm_rejects_long_address', () => {
  err(() => TA.validateAddressForChain('1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48a', 'from'));
});

test('token_alias: validate_evm_rejects_ticker_and_garbage', () => {
  err(() => TA.validateAddressForChain('196', 'WIF', 'to'));
  err(() => TA.validateAddressForChain('1', 'USDC', 'from'));
  err(() => TA.validateAddressForChain('56', 'BNB', 'to'));
  err(() => TA.validateAddressForChain('1', 'hello', 'from'));
  err(() => TA.validateAddressForChain('1', 'native', 'to'));
  err(() => TA.validateAddressForChain('196', '', 'from'));
  err(() => TA.validateAddressForChain('1', '12345', 'to'));
});

test('token_alias: validate_evm_rejects_non_hex_42_chars', () => {
  err(() => TA.validateAddressForChain('1', '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', 'from'));
});

test('token_alias: validate_solana_valid', () => {
  ok(() => TA.validateAddressForChain('501', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'from'));
  ok(() => TA.validateAddressForChain('501', '11111111111111111111111111111111', 'wallet'));
});

test('token_alias: validate_solana_rejects_evm_address', () => {
  err(() => TA.validateAddressForChain('501', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'from'));
  err(() => TA.validateAddressForChain('501', '0x1234567890abcdef1234567890abcdef12345678', 'wallet'));
});

test('token_alias: validate_solana_length_boundary', () => {
  ok(() => TA.validateAddressForChain('501', '1'.repeat(32), 'from'));
  ok(() => TA.validateAddressForChain('501', 'A'.repeat(44), 'from'));
  err(() => TA.validateAddressForChain('501', '1'.repeat(31), 'from'));
  err(() => TA.validateAddressForChain('501', 'A'.repeat(45), 'from'));
});

test('token_alias: validate_solana_rejects_non_base58_chars', () => {
  err(() => TA.validateAddressForChain('501', `${'A'.repeat(31)}0`, 'from'));
  err(() => TA.validateAddressForChain('501', `${'A'.repeat(31)}O`, 'from'));
  err(() => TA.validateAddressForChain('501', `${'A'.repeat(31)}I`, 'from'));
  err(() => TA.validateAddressForChain('501', `${'A'.repeat(31)}l`, 'from'));
});

test('token_alias: validate_tron_skips / validate_sui_skips', () => {
  ok(() => TA.validateAddressForChain('195', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'from'));
  ok(() => TA.validateAddressForChain('195', '0xabc123', 'wallet'));
  ok(() => TA.validateAddressForChain('784', '0x2::sui::SUI', 'from'));
  ok(() => TA.validateAddressForChain('607', 'anything at all', 'from'));
});

test('token_alias: validate_error_includes_label', () => {
  assert.ok(errMsg(() => TA.validateAddressForChain('1', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'wallet')).includes('--wallet'));
});

test('token_alias: resolve_and_validate (alias / CA / garbage / typo)', () => {
  assert.equal(TA.resolveAndValidate('501', 'usdc', 'to-token'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(TA.resolveAndValidate('1', '0xdac17f958d2ee523a2206206994597c13d831ec7', 'from-token'), '0xdac17f958d2ee523a2206206994597c13d831ec7');
  const m = errMsg(() => TA.resolveAndValidate('501', 'aaa', 'to-token'));
  assert.ok(m.includes('to-token'));
  assert.ok(m.includes('not a valid Solana address'));
  assert.ok(errMsg(() => TA.resolveAndValidate('1', 'usdcc', 'from-token')).includes('from-token'));
});

test('token_alias: arc (5042) explicit stablecoin mapping', () => {
  assert.equal(TA.resolveTokenAddress('5042', 'usdc'), '0x3600000000000000000000000000000000000000');
  assert.equal(TA.resolveTokenAddress('5042', 'native'), '0x3600000000000000000000000000000000000000');
  assert.notEqual(TA.resolveTokenAddress('5042', 'native'), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(TA.resolveAndValidate('5042', 'usdc', 'from-token'), '0x3600000000000000000000000000000000000000');
});

test('token_alias: exact error texts, byte lengths, has_alias', () => {
  err(() => TA.validateAddressForChain('501', '0Xabc', 'from'),
    '--from looks like an EVM address (0x…) but chain is Solana. Solana uses base58 addresses (e.g. EPjFWdd5...wyTDt1v). Did you mean to use a different chain?');
  err(() => TA.validateAddressForChain('501', 'aaa', 'to-token'),
    '--to-token is not a valid Solana address: expected 32-44 base58 characters, got 3 characters ("aaa")');
  err(() => TA.validateAddressForChain('501', `${'A'.repeat(31)}l`, 'x'),
    `--x is not a valid Solana address: contains characters outside base58 alphabet ("${'A'.repeat(31)}l")`);
  err(() => TA.validateAddressForChain('8453', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'from'),
    '--from looks like a Solana/base58 address but chain is EVM (chainIndex=8453). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?');
  err(() => TA.validateAddressForChain('1', 'usdcc', 'from-token'),
    '--from-token is not a valid EVM address: expected 0x + 40 hex digits, got "usdcc"');
  // str::len is the UTF-8 byte length: 22 × "é" = 44 bytes (in range), 23 × "é" = 46 bytes
  err(() => TA.validateAddressForChain('501', 'é'.repeat(22), 'a'),
    `--a is not a valid Solana address: contains characters outside base58 alphabet ("${'é'.repeat(22)}")`);
  err(() => TA.validateAddressForChain('501', 'é'.repeat(23), 'a'),
    `--a is not a valid Solana address: expected 32-44 base58 characters, got 46 characters ("${'é'.repeat(23)}")`);
  // an all-lowercase alphanumeric string is not flagged as base58 on EVM chains
  err(() => TA.validateAddressForChain('1', 'a'.repeat(40), 'to'), `--to is not a valid EVM address: expected 0x + 40 hex digits, got "${'a'.repeat(40)}"`);
  ok(() => TA.validateAddressForChain('1', '0X' + 'A'.repeat(40), 'to'));
  ok(() => TA.validateAddressForChain('999999', '0x' + 'a'.repeat(40), 'to'));   // unknown chains validate as EVM
  assert.equal(TA.hasAlias('8453', 'USDC'), true);
  assert.equal(TA.hasAlias('8453', 'usdt'), false);
  assert.equal(TA.hasAlias('137', 'usdt'), false);
  assert.equal(TA.hasAlias('999', 'usdc'), false);
  assert.equal(TA.hasAlias('1', 'constructor'), false);
  assert.equal(TA.resolveTokenAddress('1', 'constructor'), 'constructor');
  assert.equal(TA.resolveTokenAddress('501', 'So11111111111111111111111111111111111111112'), '11111111111111111111111111111111');
  assert.equal(TA.resolveTokenAddress('43114', 'WETH.E'), '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab');
});

test('token_alias: TOKEN_MAP equals the upstream Rust table (parsed from token_alias.rs)', (t) => {
  const src = join(ROOT, 'upstream', 'cli', 'src', 'token_alias.rs');
  if (!existsSync(src)) return t.skip('upstream source not present');
  const rust = readFileSync(src, 'utf8');
  const body = rust.slice(rust.indexOf('static TOKEN_MAP'), rust.indexOf('pub fn has_alias'));
  const want = {};
  for (const [, ci, inner] of body.matchAll(/\("(\d+)", HashMap::from\(\[([\s\S]*?)\]\)\)/g)) {
    want[ci] = Object.fromEntries([...inner.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(([, k, v]) => [k, v]));
  }
  assert.equal(Object.keys(want).length, 17);
  assert.deepEqual(JSON.parse(JSON.stringify(TA.TOKEN_MAP)), want);
});

// ═════════════════════════════ validators.rs ═════════════════════════════

test('validators: test_readable_to_minimal_str', () => {
  assert.equal(V.readableToMinimalStr('0.1', 6), '100000');
  assert.equal(V.readableToMinimalStr('1.5', 6), '1500000');
  assert.equal(V.readableToMinimalStr('100', 6), '100000000');
  assert.equal(V.readableToMinimalStr('1', 6), '1000000');
  assert.equal(V.readableToMinimalStr('0.000001', 6), '1');
  assert.equal(V.readableToMinimalStr('0.1', 18), '100000000000000000');
  assert.equal(V.readableToMinimalStr('1', 18), '1000000000000000000');
  assert.equal(V.readableToMinimalStr('1', 9), '1000000000');
  err(() => V.readableToMinimalStr('0.1234567', 6));
  err(() => V.readableToMinimalStr('1.00000002', 2));
  assert.equal(V.readableToMinimalStr('1.000', 2), '100');
  assert.equal(V.readableToMinimalStr('0.1230000', 6), '123000');
  assert.equal(V.readableToMinimalStr('1.5', 18), '1500000000000000000');   // spec oracle
});

test('validators: test_readable_to_minimal_str_too_small_rejects', () => {
  err(() => V.readableToMinimalStr('0.0000001', 6));
  err(() => V.readableToMinimalStr('0.0', 18));
  err(() => V.readableToMinimalStr('0', 6));
});

test('validators: test_readable_to_minimal_str_accepts_leading_dot_and_whitespace', () => {
  assert.equal(V.readableToMinimalStr('.5', 6), '500000');
  assert.equal(V.readableToMinimalStr('  1.5  ', 6), '1500000');
  assert.equal(V.readableToMinimalStr(' .000001 ', 6), '1');
});

test('validators: readable_to_minimal_str exact messages and edges', () => {
  err(() => V.readableToMinimalStr(' -1 ', 6), '--readable-amount must be a positive number, got "-1"');
  err(() => V.readableToMinimalStr('1.2.3', 6), '--readable-amount must be a positive number, got "1.2.3"');
  err(() => V.readableToMinimalStr('1e5', 6), '--readable-amount must be a positive number, got "1e5"');
  err(() => V.readableToMinimalStr('0.1234567', 6), '--readable-amount "0.1234567" has more decimal places than this token supports (6 decimals)');
  err(() => V.readableToMinimalStr('0.0000001', 6), '--readable-amount "0.0000001" has more decimal places than this token supports (6 decimals)');
  err(() => V.readableToMinimalStr(' 0.000000 ', 6), '--readable-amount 0.000000 is too small for this token (6 decimals); results in zero minimal units');
  err(() => V.readableToMinimalStr('', 6), '--readable-amount  is too small for this token (6 decimals); results in zero minimal units');
  assert.equal(V.readableToMinimalStr('5.', 2), '500');
  assert.equal(V.readableToMinimalStr('007', 0), '7');
  assert.equal(V.readableToMinimalStr('\u00851.5\u0085', 6), '1500000');   // Rust trim includes U+0085
  err(() => V.readableToMinimalStr('﻿1', 6), '--readable-amount must be a positive number, got "﻿1"');   // …but not U+FEFF
  assert.equal(V.readableToMinimalStr('12345678901234567890.5', 18), '12345678901234567890500000000000000000');
});

test('validators: test_validate_slippage_valid / percent / boundary / range / non_numeric', () => {
  for (const s of ['0.5', '1', '50', '99.9', '100', '100.0', '0.001', '0.01', '  1  ']) ok(() => V.validateSlippage(s));
  for (const s of ['20%', '0.5%', ' 100% ']) ok(() => V.validateSlippage(s));
  err(() => V.validateSlippage('0%'));
  err(() => V.validateSlippage('101%'));
  for (const s of ['0', '0.0', '100.1']) err(() => V.validateSlippage(s));
  for (const s of ['-1', '-0.5', '100.1', '200']) err(() => V.validateSlippage(s));
  for (const s of ['abc', '', '   ', 'NaN', 'inf', 'infinity', '-inf']) err(() => V.validateSlippage(s));
});

test('validators: slippage exact messages and Rust f64 grammar', () => {
  err(() => V.validateSlippage(' abc% '), '--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "abc"');
  err(() => V.validateSlippage('NaN'), '--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "NaN"');
  err(() => V.validateSlippage('-Infinity'), '--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "-Infinity"');
  err(() => V.validateSlippage('1e400'), '--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "1e400"');
  err(() => V.validateSlippage('200'), '--slippage must be greater than 0 and at most 100, got "200"');
  err(() => V.validateSlippage('0x10'), '--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "0x10"');
  err(() => V.validateSlippage('1_0'), '--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "1_0"');
  ok(() => V.validateSlippage('5 %%'));   // trim → strip every trailing % → trim
  ok(() => V.validateSlippage('1e1'));
  ok(() => V.validateSlippage('+.5'));
  ok(() => V.validateSlippage('5.'));
  err(() => V.validateSlippage('.'), '--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "."');
});

test('validators: test_validate_slippage_zero_to_one_*', () => {
  for (const s of ['0.01', '0.5', '1', '1.0', '0.002', '0.5', '  0.05  ']) ok(() => V.validateSlippageZeroToOne(s));
  for (const s of ['0', '0.0', '-0.01', '1.01', '50', '100']) err(() => V.validateSlippageZeroToOne(s));
  for (const s of ['abc', '', 'NaN', 'inf']) err(() => V.validateSlippageZeroToOne(s));
  const msg = errMsg(() => V.validateSlippageZeroToOne('0.5%'));
  assert.ok(msg.includes('decimal here'), msg);
  assert.ok(msg.includes('divide by 100'), msg);
  err(() => V.validateSlippageZeroToOne('50%'));
  err(() => V.validateSlippageZeroToOne('0.01%'));
});

test('validators: slippage_zero_to_one exact messages', () => {
  err(() => V.validateSlippageZeroToOne(' 0.5% '), '--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the \'%\' suffix only applies to swap/strategy (percent mode). Drop the \'%\' and divide by 100, got "0.5%"');
  err(() => V.validateSlippageZeroToOne('abc'), '--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got "abc"');
  err(() => V.validateSlippageZeroToOne('inf'), '--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got "inf"');
  err(() => V.validateSlippageZeroToOne('1.01'), '--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got "1.01"');
});

test('validators: test_validate_amount_*', () => {
  for (const s of ['1', '1000000', '999999999999999999']) ok(() => V.validateAmount(s));
  for (const s of ['1.5', '0.1', '100.0']) err(() => V.validateAmount(s));
  for (const s of ['0', '000']) err(() => V.validateAmount(s));
  for (const s of ['-1', '-100', 'abc', '12abc', '', '  ']) err(() => V.validateAmount(s));
  for (const s of ['007', '01']) err(() => V.validateAmount(s));
});

test('validators: validate_amount exact messages', () => {
  err(() => V.validateAmount('  '), '--amount must not be empty');
  err(() => V.validateAmount('1.5'), '--amount must be a whole number in minimal units (no decimals)');
  err(() => V.validateAmount(' -1 '), '--amount must be a whole number in minimal units, got "-1". Infinity, NaN, negative numbers and non-numeric values are not accepted.');
  err(() => V.validateAmount('000'), '--amount must be greater than zero');
  err(() => V.validateAmount('007'), '--amount must not have leading zeros, got "007"');
  err(() => V.validateAmount('１'), '--amount must be a whole number in minimal units, got "１". Infinity, NaN, negative numbers and non-numeric values are not accepted.');
  ok(() => V.validateAmount(' 42 '));
});

test('validators: test_validate_non_negative_integer_*', () => {
  for (const [v, l] of [['0', 'gas-limit'], ['1', 'gas-limit'], ['21000', 'gas-limit'], ['999999999', 'aa-dex-token-amount']]) ok(() => V.validateNonNegativeInteger(v, l));
  for (const v of ['abc', '-1', '1.5', '', '  ']) err(() => V.validateNonNegativeInteger(v, 'gas-limit'));
  err(() => V.validateNonNegativeInteger('007', 'gas-limit'));
  err(() => V.validateNonNegativeInteger('00', 'gas-limit'));
  err(() => V.validateNonNegativeInteger('01', 'aa-dex-token-amount'));
  ok(() => V.validateNonNegativeInteger('0', 'gas-limit'));
  assert.ok(errMsg(() => V.validateNonNegativeInteger('abc', 'gas-limit')).includes('--gas-limit'));
  assert.ok(errMsg(() => V.validateNonNegativeInteger('-1', 'aa-dex-token-amount')).includes('--aa-dex-token-amount'));
  err(() => V.validateNonNegativeInteger(' ', 'amt'), '--amt must not be empty');
  err(() => V.validateNonNegativeInteger(' 1.5', 'amt'), '--amt must be a non-negative integer, got "1.5"');
  err(() => V.validateNonNegativeInteger('00', 'amt'), '--amt must not have leading zeros, got "00"');
});

test('validators: test_validate_order_id_numeric_*', () => {
  ok(() => V.validateOrderIdNumeric('17296046425729984', 'order-id'));
  ok(() => V.validateOrderIdNumeric('1', 'order-id'));
  for (const v of ['abc-123', '', '  ', '12a']) err(() => V.validateOrderIdNumeric(v, 'order-id'));
  ok(() => V.validateOrderIdNumeric('9223372036854775807', 'order-id'));
  err(() => V.validateOrderIdNumeric('9223372036854775808', 'order-id'));
  err(() => V.validateOrderIdNumeric('1'.repeat(20), 'order-id'));
  assert.ok(errMsg(() => V.validateOrderIdNumeric('abc', 'order-ids')).includes('--order-ids'));
  err(() => V.validateOrderIdNumeric(' ', 'order-id'), '--order-id must not be empty');
  err(() => V.validateOrderIdNumeric(' 12a ', 'order-id'), '--order-id must be a numeric order id, got `12a`');
  err(() => V.validateOrderIdNumeric('9223372036854775808', 'order-id'), '--order-id `9223372036854775808` does not fit in BE Long range (max 9223372036854775807)');
  ok(() => V.validateOrderIdNumeric('0009223372036854775807', 'order-id'));   // i64 parse accepts leading zeros
});

// ═════════════════════════════ commands/sink.rs ═════════════════════════════

test('sink: parse_duration_known_units', () => {
  assert.equal(S.parseDurationMs('300s', 'since', false), 300000);
  assert.equal(S.parseDurationMs('30m', 'since', false), 1800000);
  assert.equal(S.parseDurationMs('24h', 'since', false), 86400000);
  assert.equal(S.parseDurationMs('7d', 'since', false), 604800000);
});

test('sink: parse_duration_rejects_bad_input / overflow_guard', () => {
  for (const s of ['-5m', '10', '10x', '']) err(() => S.parseDurationMs(s, 'since', false));
  err(() => S.parseDurationMs('100000000000000000d', 'since', false));
});

test('sink: parse_duration_zero_disabled_for_since / allowed_for_idle_timeout', () => {
  for (const s of ['0', '0s', '0m', '0h', '0d']) err(() => S.parseDurationMs(s, 'since', false));
  for (const s of ['0', '0s', '0m', '0h', '0d']) assert.equal(S.parseDurationMs(s, 'idle-timeout', true), 0);
  assert.equal(S.parseDurationMs('30m', 'idle-timeout', true), 1800000);
});

test('sink: parse_duration exact messages and u64 grammar', () => {
  err(() => S.parseDurationMs(' 0 ', 'since', false), "invalid --since ' 0 '; duration must be positive");
  err(() => S.parseDurationMs('00m', 'since', false), "invalid --since '00m'; duration must be positive");
  err(() => S.parseDurationMs('10x', 'since', false), "invalid --since '10x'; use e.g. 300s, 30m, 24h, 7d");
  err(() => S.parseDurationMs('-5m', 'idle-timeout', true), "invalid --idle-timeout '-5m'; use e.g. 300s, 30m, 24h, 7d");
  err(() => S.parseDurationMs('1.5h', 'since', false), "invalid --since '1.5h'; use e.g. 300s, 30m, 24h, 7d");
  err(() => S.parseDurationMs('100000000000000000d', 'since', false), "--since '100000000000000000d' overflows");
  err(() => S.parseDurationMs('18446744073709551616s', 'since', false), "invalid --since '18446744073709551616s'; use e.g. 300s, 30m, 24h, 7d");
  assert.equal(S.parseDurationMs(' +5m ', 'since', false), 300000);   // u64::from_str accepts '+'
  assert.equal(S.parseDurationMs('18446744073709551s', 'x', false), 18446744073709551000n);   // > 2^53 → BigInt
  err(() => S.parseDurationMs('5 m', 'since', false));
});

test('sink: resolve_since_window_rejects_zero / invariants / saturates', () => {
  err(() => S.resolveSinceWindow('0', 1000));
  err(() => S.resolveSinceWindow('0m', 1000));
  const now = 1721086400000;
  const w = S.resolveSinceWindow('24h', now);
  assert.equal(w.end, now);
  assert.equal(w.end - w.begin, 86400000);
  const w2 = S.resolveSinceWindow('7d', 1000);
  assert.equal(w2.end, 1000);
  assert.equal(w2.begin, 0);
  assert.equal(stringify(w), '{"begin":1721000000000,"end":1721086400000}');
  assert.equal(stringify(S.resolveSinceWindow('18446744073709551s', 5)), '{"begin":0,"end":5}');
});

test('sink: parse_max_results_range / error_is_coded', () => {
  assert.equal(S.parseMaxResults(undefined), null);
  assert.equal(S.parseMaxResults('50'), 50);
  assert.equal(S.parseMaxResults('1'), 1);
  assert.equal(S.parseMaxResults('500'), 500);
  for (const s of ['0', '999', 'abc']) err(() => S.parseMaxResults(s));
  const e = (() => { try { S.parseMaxResults('999'); } catch (x) { return x; } })();
  assert.ok(e instanceof CodedError);
  assert.equal(e.code, 'invalid_input');
  assert.equal(e.field, 'max-results');
  assert.equal(e.message, '--max-results must be between 1 and 500, got 999');
  err(() => S.parseMaxResults(' 1.5 '), "--max-results must be an integer between 1 and 500, got '1.5'");
  err(() => S.parseMaxResults('4294967296'), "--max-results must be an integer between 1 and 500, got '4294967296'");
  err(() => S.parseMaxResults('-1'), "--max-results must be an integer between 1 and 500, got '-1'");
  assert.equal(S.parseMaxResults(' +7 '), 7);
  assert.equal(S.parseMaxResults(null), null);
});

const item = (c) => ({ id: c, cursor: c });
const perItem = S.pageShape('list', 'cursor', S.CursorMode.PerItem);
const pageLevel = S.pageShape('list', 'cursor', S.CursorMode.PageLevel);

test('sink: auto_paginate_per_item_exact_truncation', async () => {
  const agg = await S.autoPaginate(null, 5, perItem, async (cur) => (
    cur === null ? { list: [item('a'), item('b'), item('c')] }
      : cur === 'c' ? { list: [item('d'), item('e'), item('f')] } : { list: [] }));
  assert.equal(agg.fetchedCount, 5);
  assert.equal(agg.items.length, 5);
  assert.equal(agg.nextCursor, 'e');
  assert.ok(!agg.partial);
});

test('sink: auto_paginate_page_level_keeps_whole_page', async () => {
  const agg = await S.autoPaginate(null, 4, pageLevel, async (cur) => (
    cur === null ? { list: [item('a'), item('b'), item('c')], cursor: 'p2' }
      : cur === 'p2' ? { list: [item('d'), item('e'), item('f')], cursor: 'p3' } : { list: [], cursor: null }));
  assert.equal(agg.fetchedCount, 6);
  assert.equal(agg.nextCursor, 'p3');
  assert.ok(!agg.partial);
});

test('sink: auto_paginate_stops_on_empty_cursor', async () => {
  const agg = await S.autoPaginate(null, 100, pageLevel, async (cur) => (cur === null ? { list: [item('a')], cursor: '' } : { list: [] }));
  assert.equal(agg.fetchedCount, 1);
  assert.equal(agg.nextCursor, null);
});

test('sink: auto_paginate_ten_page_cap', async () => {
  let n = 0;
  const agg = await S.autoPaginate(null, 1000, perItem, async () => { n += 1; return { list: [item(`c${n}`)] }; });
  assert.equal(agg.fetchedCount, S.MAX_PAGES);
  assert.equal(agg.nextCursor, 'c10');
  assert.ok(!agg.partial);
});

test('sink: auto_paginate_stops_when_cursor_not_advancing', async () => {
  const agg = await S.autoPaginate(null, 1000, perItem, async () => ({ list: [item('x')] }));
  assert.ok(agg.partial);
  assert.equal(agg.fetchedCount, 2);
  assert.equal(agg.nextCursor, 'x');
  assert.equal(agg.error.code, 'cursor_not_advancing');
  assert.equal(agg.error.nextCursor, 'x');
  assert.equal(stringify(agg),
    '{"items":[{"cursor":"x","id":"x"},{"cursor":"x","id":"x"}],"nextCursor":"x","fetchedCount":2,"partial":true,'
    + '"error":{"code":"cursor_not_advancing","message":"upstream returned the same cursor \'x\' it was queried with; stopping to avoid re-fetching the same page","nextCursor":"x"}}');
});

test('sink: auto_paginate_stops_on_empty_page_with_cursor', async () => {
  const agg = await S.autoPaginate(null, 100, pageLevel, async (cur) => (cur === null ? { list: [item('a'), item('b')], cursor: 'p2' } : { list: [], cursor: 'p3' }));
  assert.ok(!agg.partial);
  assert.equal(agg.fetchedCount, 2);
  assert.equal(agg.nextCursor, 'p2');
});

test('sink: auto_paginate_mid_page_error_is_partial', async () => {
  const agg = await S.autoPaginate(null, 100, perItem, async (cur) => {
    if (cur === null) return { list: [item('a'), item('b')] };
    throw new Error('boom');
  });
  assert.ok(agg.partial);
  assert.equal(agg.fetchedCount, 2);
  assert.equal(agg.nextCursor, 'b');
  assert.equal(agg.error.code, 'upstream_error');
  assert.equal(agg.error.nextCursor, 'b');
  assert.equal(agg.error.message, 'page 2 request failed: boom');
});

test('sink: auto_paginate tolerant item extraction, numeric cursors, serialisation', async () => {
  // page itself is an array; the first array field in BTreeMap (sorted-key) order otherwise
  // (page 2 is empty with no cursor → last continuation becomes None, as upstream)
  let agg = await S.autoPaginate(null, 10, perItem, async (cur) => (cur === null ? [{ cursor: 7 }] : []));
  assert.equal(agg.nextCursor, null);
  assert.equal(stringify(agg), '{"items":[{"cursor":7}],"nextCursor":null,"fetchedCount":1}');
  agg = await S.autoPaginate(null, 1, perItem, async () => [{ cursor: 7 }, { cursor: 8 }]);
  assert.equal(stringify(agg), '{"items":[{"cursor":7}],"nextCursor":"7","fetchedCount":1}');
  agg = await S.autoPaginate('start', 10, pageLevel, async () => parse('{"zeta":[1],"alpha":[2,3],"cursor":1.5}'));
  assert.deepEqual(agg.items, [2, 3, 2, 3]);
  // the continuation "1.5" differs from the attempted "start", so page 2 is fetched with "1.5"; same
  // response again → attempted "1.5" == continuation → cursor_not_advancing partial
  assert.equal(agg.partial, true);
  assert.equal(agg.nextCursor, '1.5');
  assert.equal(agg.fetchedCount, 4);
  // first-page failure: nextCursor = the attempted start cursor
  agg = await S.autoPaginate('c0', 10, perItem, async () => { throw new Error('x: y'); });
  assert.equal(stringify(agg), '{"items":[],"nextCursor":"c0","fetchedCount":0,"partial":true,"error":{"code":"upstream_error","message":"page 1 request failed: x: y","nextCursor":"c0"}}');
  agg = await S.autoPaginate(null, 10, perItem, async () => { throw new Error('boom'); });
  assert.equal(stringify(agg), '{"items":[],"nextCursor":null,"fetchedCount":0,"partial":true,"error":{"code":"upstream_error","message":"page 1 request failed: boom"}}');
  // non-object page → no items
  agg = await S.autoPaginate(null, 10, perItem, async () => 'nope');
  assert.equal(stringify(agg), '{"items":[],"nextCursor":null,"fetchedCount":0}');
});

test('sink: normalize_amount_zero_forms / hex_and_decimal / strips_leading_zeros', () => {
  assert.deepEqual(S.normalizeAmount(null), { value: '0' });
  assert.deepEqual(S.normalizeAmount(''), { value: '0' });
  assert.deepEqual(S.normalizeAmount('0'), { value: '0' });
  assert.deepEqual(S.normalizeAmount('0x0'), { value: '0' });
  assert.deepEqual(S.normalizeAmount('0x1a'), { value: '26' });
  assert.deepEqual(S.normalizeAmount('123456'), { value: '123456' });
  assert.ok('error' in S.normalizeAmount('abc'));
  assert.deepEqual(S.normalizeAmount('007'), { value: '7' });
  assert.deepEqual(S.normalizeAmount('00123'), { value: '123' });
  assert.deepEqual(S.normalizeAmount('00'), { value: '0' });
  assert.deepEqual(S.normalizeAmount('000'), { value: '0' });
});

test('sink: normalize_amount_rejects_non_integer_numbers', () => {
  assert.ok('error' in S.normalizeAmount(parse('1.5')));
  assert.ok('error' in S.normalizeAmount(parse('-5')));
  assert.ok('error' in S.normalizeAmount(parse('-1.0')));
  assert.deepEqual(S.normalizeAmount(parse('42')), { value: '42' });
  assert.deepEqual(S.normalizeAmount(parse('0')), { value: '0' });
});

test('sink: normalize_amount_exceeds_u128', () => {
  const hex = `0x${'f'.repeat(33)}`;
  const expected = S.hexToDecimalString(hex);
  assert.deepEqual(S.normalizeAmount(hex), { value: expected });
  assert.ok(expected.length > 39);
});

test('sink: normalize_amount exact messages', () => {
  assert.deepEqual(S.normalizeAmount(parse('1.5')), { error: "value must be a non-negative integer minimal unit, got '1.5'" });
  assert.deepEqual(S.normalizeAmount(parse('-1.0')), { error: "value must be a non-negative integer minimal unit, got '-1.0'" });
  assert.deepEqual(S.normalizeAmount(parse('-5')), { error: "value must be a non-negative integer minimal unit, got '-5'" });
  assert.deepEqual(S.normalizeAmount(parse('1e3')), { error: "value must be a non-negative integer minimal unit, got '1000.0'" });
  assert.deepEqual(S.normalizeAmount(parse('18446744073709551615')), { value: '18446744073709551615' });
  assert.deepEqual(S.normalizeAmount(' 12a '), { error: "unparseable value '12a'" });
  assert.deepEqual(S.normalizeAmount(' 0xZZ'), { error: "invalid hex digit 'Z' in '0xZZ'" });
  assert.deepEqual(S.normalizeAmount(' 0X0 '), { value: '0' });
  assert.deepEqual(S.normalizeAmount('0x'), { value: '0' });
  assert.deepEqual(S.normalizeAmount(true), { error: 'unparseable value (unexpected JSON type)' });
  assert.deepEqual(S.normalizeAmount([1]), { error: 'unparseable value (unexpected JSON type)' });
  assert.deepEqual(S.normalizeAmount({}), { error: 'unparseable value (unexpected JSON type)' });
  assert.deepEqual(S.normalizeAmount(undefined), { value: '0' });
});

test('sink: hex_to_decimal_boundaries', () => {
  assert.equal(S.hexToDecimalString('0x0'), '0');
  assert.equal(S.hexToDecimalString('0xff'), '255');
  assert.equal(S.hexToDecimalString('0x10'), '16');
  assert.equal(S.hexToDecimalString('0x100000000000000000000000000000000'), '340282366920938463463374607431768211456');
  err(() => S.hexToDecimalString('0xZZ'));
  err(() => S.hexToDecimalString(' 0x0x1'), "invalid hex digit 'x' in ' 0x0x1'");
  assert.equal(S.hexToDecimalString('FF'), '255');
  assert.equal(S.hexToDecimalString('  '), '0');
  assert.equal(S.hexToDecimalString('0X000a'), '10');
});

test('sink: add_decimal_strings_integer_and_fractional', () => {
  assert.equal(S.addDecimalStrings('40000', '0'), '40000');
  assert.equal(S.addDecimalStrings('40000', '200'), '40200');
  assert.equal(S.addDecimalStrings('1.5', '2.75'), '4.25');
  assert.equal(S.addDecimalStrings('0.1', '0.2'), '0.3');
  assert.equal(S.addDecimalStrings('340282366920938463463374607431768211456', '1'), '340282366920938463463374607431768211457');
  err(() => S.addDecimalStrings('1.2.3', '1'));
  err(() => S.addDecimalStrings('1.2.3', '1'), "unparseable decimal '1.2.3'");
  err(() => S.addDecimalStrings('1', ' '), "empty decimal string ' '");
  err(() => S.addDecimalStrings('-1', '1'), "unparseable decimal '-1'");
  err(() => S.addDecimalStrings('.5', '1'), "unparseable decimal '.5'");
  assert.equal(S.addDecimalStrings('1.', '1'), '2');
  assert.equal(S.addDecimalStrings('0.5', '0.5'), '1');
  assert.equal(S.addDecimalStrings('007', '0.010'), '7.01');
});

test('sink: format_thousands_groups', () => {
  assert.equal(S.formatThousands('40000'), '40,000');
  assert.equal(S.formatThousands('999'), '999');
  assert.equal(S.formatThousands('1234567'), '1,234,567');
  assert.equal(S.formatThousands('40000.5'), '40,000.5');
  assert.equal(S.formatThousands(''), '');
  assert.equal(S.formatThousands('1234.5678.9'), '1,234.5678.9');
});

test('sink: sum_prize_pool_same_unit / multi_unit_join / empty / bad_entry', () => {
  let tp = S.sumPrizePool([{ totalReward: '10000', rewardUnit: 'USDC' }, { totalReward: '30000', rewardUnit: 'USDC' }]);
  assert.equal(tp.amountByUnit.length, 1);
  assert.equal(tp.amountByUnit[0].amount, '40000');
  assert.equal(tp.display, '40,000 USDC');
  assert.ok(!tp.partial);
  tp = S.sumPrizePool([{ totalReward: '40000', rewardUnit: 'USDC' }, { totalReward: '200', rewardUnit: 'DJT' }]);
  assert.equal(tp.display, '40,000 USDC + 200 DJT');
  assert.equal(S.sumPrizePool([]), null);
  tp = S.sumPrizePool([{ totalReward: '40000', rewardUnit: 'USDC' }, { totalReward: 'not-a-number', rewardUnit: 'USDC' }]);
  assert.equal(tp.amountByUnit[0].amount, '40000');
  assert.ok(tp.partial);
});

test('sink: sum_prize_pool serialisation, numbers, missing units', () => {
  const tp = S.sumPrizePool(parse('[{"totalReward":" 1.5 ","rewardUnit":"USDC"},{"totalReward":2,"rewardUnit":"USDC"},{"totalReward":1000.25},{"rewardUnit":"X"},null,{"totalReward":1e21,"rewardUnit":"Y"}]'));
  assert.equal(stringify(tp), '{"amountByUnit":[{"amount":"3.5","rewardUnit":"USDC"},{"amount":"1000.25","rewardUnit":""}],"display":"3.5 USDC + 1,000.25","partial":true}');
  assert.equal(stringify(S.sumPrizePool([{ totalReward: '1', rewardUnit: 'A' }])), '{"amountByUnit":[{"amount":"1","rewardUnit":"A"}],"display":"1 A"}');
});

// ═════════════════════════════ commands/common.rs ═════════════════════════════

test('common: tx_confirmation_timeout eth / linea / fallback', () => {
  assert.equal(C.txConfirmationTimeout('1'), 20000);
  assert.equal(C.txConfirmationTimeout('59144'), 20000);
  assert.equal(C.txConfirmationTimeout('8453'), 10000);
});

test('common: wait_tx_onchain success / fail / pending / request errors / timeout', async () => {
  const calls = [];
  const client = (responses) => ({
    async get(path, query) {
      calls.push([path, query]);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  });
  await C.waitTxOnchain(client([[{ txStatus: 'SUCCESS' }]]), '0xabc', '1');
  assert.deepEqual(calls[0], ['/api/v6/dex/post-transaction/transaction-detail-by-txhash', [['chainIndex', '1'], ['txHash', '0xabc']]]);
  await assert.rejects(C.waitTxOnchain(client([{ txStatus: 'Fail' }]), '0xdef', '8453'), { message: 'tx 0xdef failed on-chain (chain=8453)' });
  // pending → request error → success (two 1 s sleeps)
  const t0 = Date.now();
  await C.waitTxOnchain(client([[{ txStatus: 'pending' }], new Error('net'), { txStatus: 'success' }]), '0x1', '196');
  assert.ok(Date.now() - t0 >= 1900);
  // timeout: advance the monotonic clock past the deadline inside the request
  const realNow = performance.now.bind(performance);
  let skew = 0;
  performance.now = () => realNow() + skew;
  try {
    const slow = { async get() { skew += 21000; return []; } };
    await assert.rejects(C.waitTxOnchain(slow, '0x2', '59144'), { message: 'tx 0x2 not confirmed on-chain within 20s (chain=59144)' });
    const slow10 = { async get() { skew += 11000; throw new Error('down'); } };
    await assert.rejects(C.waitTxOnchain(slow10, '0x3', '56'), { message: 'tx 0x3 not confirmed on-chain within 10s (chain=56)' });
  } finally {
    performance.now = realNow;
  }
});

// ═════════════════════════════ asset_class.rs ═════════════════════════════

test('asset_class: as_str_maps_every_variant', () => {
  assert.equal(AC.assetClassAsStr(AC.AssetClass.Spot), 'spot');
  assert.equal(AC.assetClassAsStr(AC.AssetClass.Perp), 'perp');
  assert.equal(AC.assetClassAsStr(AC.AssetClass.Prediction), 'prediction');
  assert.equal(AC.assetClassAsStr(AC.AssetClass.Option), 'option');
  assert.equal(AC.assetClassAsStr(AC.AssetClass.Defi), 'defi');
});

test('asset_class: order_covers_all_five_variants_in_declaration_order', () => {
  assert.deepEqual(AC.ASSET_CLASS_ORDER, [AC.AssetClass.Spot, AC.AssetClass.Perp, AC.AssetClass.Prediction, AC.AssetClass.Option, AC.AssetClass.Defi]);
  assert.deepEqual(AC.ASSET_CLASS_ORDER.map(AC.assetClassAsStr), ['spot', 'perp', 'prediction', 'option', 'defi']);
});

test('asset_class: serde_round_trips_to_lowercase_token', () => {
  for (const [variant, token] of [[AC.AssetClass.Spot, '"spot"'], [AC.AssetClass.Perp, '"perp"'], [AC.AssetClass.Prediction, '"prediction"'], [AC.AssetClass.Option, '"option"'], [AC.AssetClass.Defi, '"defi"']]) {
    assert.equal(stringify(variant), token);
    assert.equal(parse(token), variant);
  }
});

test('asset_class: parses_cli_tokens_and_aliases', () => {
  assert.equal(AC.assetClassFromStr('spot'), AC.AssetClass.Spot);
  assert.equal(AC.assetClassFromStr('FUTURES'), AC.AssetClass.Perp);
  assert.equal(AC.assetClassFromStr('options'), AC.AssetClass.Option);
  err(() => AC.assetClassFromStr('unknown'), 'asset class must be spot, perp, prediction, option, or defi');
  err(() => AC.assetClassFromStr(' spot'));       // no trimming upstream
  assert.equal(AC.assetClassFromStr('DeFi'), AC.AssetClass.Defi);
  err(() => AC.assetClassFromStr('constructor'));
});

// ═════════════════════════════ funding.rs ═════════════════════════════

const addr = (chainIndex, address) => ({ accountId: 'account-1', address, chainIndex, chainName: '', addressType: '', chainPath: '' });
const walletsFixture = (addressList) => ({
  email: '', isNew: false, projectId: '', selectedAccountId: 'account-1',
  accountsMap: { 'account-1': { addressList } },
  accounts: [{ projectId: 'project-1', accountId: 'account-1', accountName: 'Trading', isDefault: true }],
  loginType: '',
});

test('funding: resolve_funding_target_x_layer_is_canonical_and_gas_free', () => {
  const t = F.resolveFundingTarget(walletsFixture([addr('1', '0xEvmShared'), addr('501', 'SoLaNaAddr')]), '196');
  assert.equal(t.chainName, 'X Layer');
  assert.equal(t.gasFree, true);
  assert.equal(t.chainIndex, '196');
  assert.equal(t.receiveAddress, '0xEvmShared');
  assert.equal(t.accountName, 'Trading');
  assert.equal(t.sameNetworkRequired, true);
});

test('funding: resolve_funding_target_ethereum_is_canonical_and_not_gas_free', () => {
  const t = F.resolveFundingTarget(walletsFixture([addr('1', '0xEvmShared'), addr('501', 'SoLaNaAddr')]), '1');
  assert.equal(t.chainName, 'Ethereum');
  assert.equal(t.gasFree, false);
  assert.equal(t.receiveAddress, '0xEvmShared');
});

test('funding: funding_target_serializes_chain_name_as_chain_name_camel_case', () => {
  const json = JSON.parse(stringify(F.resolveFundingTarget(walletsFixture([addr('196', '0xXLayerAddr')]), '196')));
  assert.equal(json.chainName, 'X Layer');
  assert.equal(json.chainIndex, '196');
  assert.equal(json.receiveAddress, '0xXLayerAddr');
  assert.equal(json.gasFree, true);
  assert.equal(json.chain_name, undefined);
  // serde_json::to_value(&target) → sorted keys
  assert.equal(stringify(F.resolveFundingTarget(walletsFixture([addr('196', '0xX')]), '196')),
    '{"accountName":"Trading","chainIndex":"196","chainName":"X Layer","gasFree":true,"receiveAddress":"0xX","sameNetworkRequired":true}');
});

test('funding: build_funding_bundle_composes_target_and_populated_qr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-funding-qr-'));
  try {
    const bundle = F.buildFundingBundleFromWallets(walletsFixture([addr('1', '0xEvmShared')]), '1', dir);
    assert.equal(bundle.target.chainName, 'Ethereum');
    assert.equal(bundle.target.receiveAddress, '0xEvmShared');
    assert.equal(bundle.qr.requestedFormat, 'auto');
    assert.ok(bundle.qr.terminalQr !== undefined || bundle.qr.imagePath !== undefined, 'QrOutput must carry a QR payload');
    if (bundle.qr.imagePath !== undefined) {
      assert.ok(resolve(bundle.qr.imagePath).startsWith(resolve(dir)));
      rmSync(bundle.qr.imagePath, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('funding: readable_shortfall_uses_exact_decimal_arithmetic', () => {
  assert.equal(F.readableShortfall('10', '0.08504764'), '9.91495236');
  assert.equal(F.readableShortfall('1.20', '0.2'), '1');
  assert.equal(F.readableShortfall('1', '2'), '0');
  assert.equal(F.readableShortfall('1e3', '1'), null);
});

test('funding: readable_shortfall edges', () => {
  assert.equal(F.readableShortfall(' 10 ', '9.999'), '0.001');
  assert.equal(F.readableShortfall('.5', '0'), '0.5');
  assert.equal(F.readableShortfall('5.', '0'), '5');
  assert.equal(F.readableShortfall('0.30', '0.1'), '0.2');
  assert.equal(F.readableShortfall('100', '1'), '99');
  assert.equal(F.readableShortfall('1', '0.001'), '0.999');
  assert.equal(F.readableShortfall('.', '0'), null);
  assert.equal(F.readableShortfall('1.2.3', '0'), null);
  assert.equal(F.readableShortfall('-1', '0'), null);
  assert.equal(F.readableShortfall('1', '+1'), null);
  assert.equal(F.readableShortfall('', '0'), null);
  assert.equal(F.readableShortfall('123456789012345678901234567890.1', '0.1'), '123456789012345678901234567890');
});

test('funding: blocked_result_builds_the_common_funding_contract', () => {
  const bundle = F.buildFundingBundleFromWallets(walletsFixture([addr('196', '0xReceive')]), '196');
  const value = F.buildFundingBlockedResult(bundle, {
    asset: 'USDC', tokenAddress: '0xToken', required: '10', balance: '1',
    operation: 'example_operation', errorCode: 'E_BALANCE', errorMessage: 'Insufficient funds',
  });
  assert.equal(value.phase, F.FUNDING_REQUIRED_PHASE);
  assert.equal(value.reason, 'insufficient_balance');
  assert.deepEqual(value.nextAction, []);
  assert.equal(value.payload.operation, 'example_operation');
  assert.equal(value.payload.error.code, 'E_BALANCE');
  assert.equal(value.payload.error.message, 'Insufficient funds');
  assert.equal(value.payload.fundingNeed.shortfall, '9');
  assert.equal(value.payload.fundingTarget.receiveAddress, '0xReceive');
  assert.ok(value.payload.qr !== null && typeof value.payload.qr === 'object');
});

test('funding: resolved_address_bundle_uses_the_same_target_and_qr_rules', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const value = F.buildFundingBundleForAddress('Agent', '196', address, { asset: 'USDT', tokenAddress: '0xToken', required: '10', balance: '1' });
  assert.equal(value.payload.fundingTarget.accountName, 'Agent');
  assert.equal(value.payload.fundingTarget.chainName, 'X Layer');
  assert.equal(value.payload.fundingTarget.gasFree, true);
  assert.equal(value.payload.fundingTarget.receiveAddress, address);
  assert.equal(value.payload.qr.requestedFormat, 'auto');
  assert.equal(value.payload.operation, undefined);
  assert.equal(value.payload.error, undefined);
});

test('funding: missing_address_for_chain_errors_with_no_partial_bundle', () => {
  const w = walletsFixture([addr('1', '0xEvmShared')]);
  err(() => F.resolveFundingTarget(w, '0'), 'no address for chain "0" on the selected account');
  err(() => F.buildFundingBundleFromWallets(w, '0'));
});

test('funding: blocked result serialises with sorted keys; qr struct order dropped', () => {
  const bundle = {
    target: F.resolveFundingTarget(walletsFixture([addr('1', '0xE')]), '8453'),
    qr: Object.defineProperty({ requestedFormat: 'auto', resolvedFormat: undefined, displayMode: 'image-notify' }, Symbol.for('ocl.ordered'), { value: true }),
  };
  const v = F.buildFundingBlockedResult(bundle, { asset: 'USDC', tokenAddress: '0xT', required: '10', balance: null, operation: F.FUNDING_OPERATION_SWAP, errorCode: '  ', errorMessage: 'm' });
  assert.equal(stringify(v),
    '{"decision":"blocked","nextAction":[],"payload":{"error":{"message":"m"},'
    + '"fundingNeed":{"asset":"USDC","balance":null,"required":"10","tokenAddress":"0xT"},'
    + '"fundingTarget":{"accountName":"Trading","chainIndex":"8453","chainName":"Base","gasFree":false,"receiveAddress":"0xE","sameNetworkRequired":true},'
    + '"operation":"swap","qr":{"displayMode":"image-notify","requestedFormat":"auto"}},'
    + '"phase":"funding_required","reason":"insufficient_balance"}');
  // unparseable balance → no shortfall key (validation is the caller's job here)
  const v2 = F.buildFundingBlockedResult(bundle, { asset: 'A', tokenAddress: '', required: '10', balance: 'n/a' });
  assert.equal(v2.payload.fundingNeed.shortfall, undefined);
  assert.equal(v2.payload.fundingNeed.balance, 'n/a');
});

test('funding: validate_funding_blocked_input exact messages (build_funding_bundle_for_address)', () => {
  const base = { asset: 'USDT', tokenAddress: '0xT', required: '10', balance: '1' };
  const run = (over, ci = '196', address = '0xA') => () => F.buildFundingBundleForAddress('n', ci, address, { ...base, ...over });
  err(run({ asset: ' ' }), 'funding asset must not be blank');
  err(run({ operation: '\t' }), 'funding operation must not be blank when provided');
  err(run({ required: '1e3' }), 'funding required amount must be a plain non-negative decimal');
  err(run({ required: '0.00' }), 'funding required amount must be greater than zero');
  err(run({ balance: '-1' }), 'funding balance must be a plain non-negative decimal');
  err(run({ balance: '10.0' }), 'funding bundle requires an actual balance shortfall');
  err(run({}, ' '), 'funding chain index must not be blank');
  err(run({}, '196', ''), 'funding receive address must not be blank');
  ok(run({ balance: undefined }));
  const v = run({ balance: undefined })();
  assert.equal(v.payload.fundingNeed.balance, null);
  assert.equal(v.payload.fundingNeed.shortfall, undefined);
  assert.equal(v.payload.fundingTarget.accountName, 'n');
  assert.equal(v.payload.fundingTarget.chainName, 'X Layer');
  assert.equal(F.buildFundingBundleForAddress('n', '999', '0xA', base).payload.fundingTarget.chainName, '999');
});

test('funding: build_funding_bundle validates before touching wallet state', async () => {
  await assert.rejects(F.buildFundingBundle('196', { asset: '', tokenAddress: '', required: '1' }), { message: 'funding asset must not be blank' });
});

test('funding: account name / active account fallbacks (selected → default → first key)', () => {
  const w = walletsFixture([addr('501', 'SoL')]);
  w.selectedAccountId = '';
  assert.equal(F.resolveFundingTarget(w, '501').accountName, 'Trading');
  w.accounts[0].isDefault = false;
  assert.equal(F.resolveFundingTarget(w, '501').accountName, 'Trading');   // first accounts_map key
  w.accounts = [];
  assert.equal(F.resolveFundingTarget(w, '501').accountName, '');
  err(() => F.resolveFundingTarget({ ...w, accountsMap: {} }, '501'), 'no wallet accounts found');
  err(() => F.resolveFundingTarget({ ...w, selectedAccountId: 'ghost' }, '501'), 'account not found');
  // exact match wins over the shared EVM address; empty addresses are skipped
  const w2 = walletsFixture([addr('1', ''), addr('8453', '0xBase'), addr('196', '0xXL')]);
  assert.equal(F.resolveFundingTarget(w2, '196').receiveAddress, '0xXL');
  assert.equal(F.resolveFundingTarget(w2, '1').receiveAddress, '0xBase');
  err(() => F.resolveFundingTarget(w2, '195'), 'no address for chain "195" on the selected account');
  // funding delegates to agentic_wallet::account (lib/wallet/account.mjs)
  assert.equal(WA.resolveAccountAddressForChain(w2, '1'), F.resolveFundingTarget(w2, '1').receiveAddress);
});

test('funding: chain_cache.json isEvmChain override feeds the EVM fallback', () => {
  const cache = join(HOME, 'chain_cache.json');
  writeFileSync(cache, JSON.stringify({ updated_at: 0, chains: [{ chainIndex: '4217', chainName: 'Tempo', isEvmChain: true }] }));
  try {
    assert.equal(F.resolveFundingTarget(walletsFixture([addr('1', '0xE')]), '4217').receiveAddress, '0xE');
  } finally {
    rmSync(cache, { force: true });
  }
  err(() => F.resolveFundingTarget(walletsFixture([addr('1', '0xE')]), '4217'));
});

// ═════════════════════════════ commands/risk_classify.rs ═════════════════════════════

const tok = (risk, a, dir) => R.TokenResult.classify({ riskLevel: risk, tokenContractAddress: a }, dir);

test('risk_classify: parse_trade_direction_value', () => {
  assert.equal(R.parseTradeDirectionValue('buy'), R.TradeDirection.Buy);
  assert.equal(R.parseTradeDirectionValue('BUY'), R.TradeDirection.Buy);
  assert.equal(R.parseTradeDirectionValue('sell'), R.TradeDirection.Sell);
  assert.equal(R.parseTradeDirectionValue('Sell'), R.TradeDirection.Sell);
  err(() => R.parseTradeDirectionValue('hold'));
  err(() => R.parseTradeDirectionValue(''));
  err(() => R.parseTradeDirectionValue(' SideWays '), "invalid trade direction 'sideways'; expected 'buy' or 'sell'");
  assert.equal(R.parseTradeDirectionValue(' Buy\n'), 'buy');
});

test('risk_classify: normalize_risk_level', () => {
  assert.equal(R.normalizeRiskLevel('CRITICAL'), R.RiskLevel.Critical);
  assert.equal(R.normalizeRiskLevel('high'), R.RiskLevel.High);
  assert.equal(R.normalizeRiskLevel('MEDIUM'), R.RiskLevel.Medium);
  assert.equal(R.normalizeRiskLevel('low'), R.RiskLevel.Low);
  assert.equal(R.normalizeRiskLevel(undefined), R.RiskLevel.High);
  assert.equal(R.normalizeRiskLevel('weird'), R.RiskLevel.High);
  assert.equal(R.normalizeRiskLevel('lOw'), R.RiskLevel.Low);
  assert.equal(R.normalizeRiskLevel(' LOW'), R.RiskLevel.High);   // no trimming upstream
});

test('risk_classify: resolve_action_full_matrix', () => {
  const { Critical, High, Medium, Low } = R.RiskLevel;
  const { Buy, Sell } = R.TradeDirection;
  assert.equal(R.resolveAction(Critical, Buy), R.Action.Block);
  assert.equal(R.resolveAction(Critical, Sell), R.Action.Warn);
  assert.equal(R.resolveAction(High, Buy), R.Action.Pause);
  assert.equal(R.resolveAction(High, Sell), R.Action.Warn);
  assert.equal(R.resolveAction(Medium, Buy), R.Action.Warn);
  assert.equal(R.resolveAction(Medium, Sell), R.Action.Warn);
  assert.equal(R.resolveAction(Low, Buy), R.Action.Safe);
  assert.equal(R.resolveAction(Low, Sell), R.Action.Safe);
});

test('risk_classify: combined_action', () => {
  const { Buy } = R.TradeDirection;
  assert.equal(R.combinedAction([tok('HIGH', '0xaaa', Buy), tok('CRITICAL', '0xbbb', Buy), tok('CRITICAL', '', Buy)]), R.Action.Block);
  assert.equal(R.combinedAction([]), R.Action.Safe);
  const nativeBlock = tok('CRITICAL', '', Buy);
  assert.ok(nativeBlock.isNative());
  assert.equal(nativeBlock.action(), R.Action.Block);
  assert.equal(R.combinedAction([nativeBlock]), R.Action.Safe);
  const t = R.TokenResult.classify({ riskLevel: 'LOW', contractAddress: '0xccc' }, Buy);
  assert.ok(!t.isNative());
  assert.equal(R.combinedAction([t]), R.Action.Safe);
  // whitespace-only / non-string addresses count as native; missing riskLevel → HIGH → pause
  const t2 = R.TokenResult.classify({ tokenContractAddress: '  ', contractAddress: 5 }, Buy);
  assert.ok(t2.isNative());
  assert.equal(t2.normalizedRiskLevel(), R.RiskLevel.High);
  assert.equal(t2.action(), R.Action.Pause);
  assert.equal(R.combinedAction([tok('MEDIUM', '0x1', Buy), tok('HIGH', '0x2', Buy), tok('LOW', '0x3', Buy)]), R.Action.Pause);
  assert.equal(R.TokenResult.classify(null, R.TradeDirection.Sell).action(), R.Action.Warn);
});

test('risk_classify: classify_swap_route (honeypot matrix, idempotent)', () => {
  let route = { toToken: { isHoneyPot: true }, fromToken: { isHoneyPot: false } };
  R.classifySwapRoute(route);
  assert.equal(route.action, 'block');
  assert.ok(route.reason.includes('to-token is a honeypot'));

  route = { toToken: { isHoneyPot: false }, fromToken: { isHoneyPot: true } };
  R.classifySwapRoute(route);
  assert.equal(route.action, 'warn');
  assert.ok(route.reason.includes('exit allowed'));

  route = { toToken: { isHoneyPot: true }, fromToken: { isHoneyPot: true } };
  R.classifySwapRoute(route);
  assert.equal(route.action, 'block');
  assert.ok(route.reason.includes('to-token is a honeypot'));
  assert.ok(route.reason.includes('from-token is a honeypot; exit allowed'));
  assert.ok(route.reason.includes(';'));

  route = { toToken: { isHoneyPot: false }, fromToken: { isHoneyPot: false } };
  R.classifySwapRoute(route);
  assert.equal(route.action, 'ok');
  assert.equal(route.reason, '');

  route = {};
  R.classifySwapRoute(route);
  assert.equal(route.action, 'ok');
  assert.equal(route.reason, '');

  route = { toToken: { isHoneyPot: true }, fromToken: { isHoneyPot: false } };
  R.classifySwapRoute(route);
  const first = route.reason;
  R.classifySwapRoute(route);
  assert.equal(route.reason, first);
  assert.equal(route.action, 'block');
});

test('risk_classify: classify_swap_route edges (tax disabled, non-bool honeypot, non-object, bytes)', () => {
  const route = parse('{"toToken":{"isHoneyPot":"true","taxRate":99.5},"fromToken":{"taxRate":50},"z":1}');
  R.classifySwapRoute(route);
  assert.equal(stringify(route), '{"action":"ok","fromToken":{"taxRate":50},"reason":"","toToken":{"isHoneyPot":"true","taxRate":99.5},"z":1}');
  const arr = [];
  R.classifySwapRoute(arr);
  assert.deepEqual(arr, []);
  R.classifySwapRoute(null);
  const r2 = { toToken: null, fromToken: { isHoneyPot: true } };
  R.classifySwapRoute(r2);
  assert.equal(r2.reason, 'from-token is a honeypot; exit allowed');
  assert.ok(Number.isNaN(R.normalizeTaxRate(12)));
});

test('risk_classify: join_dedup + enum wire forms / severities', () => {
  assert.equal(R.joinDedup(['a', 'b', 'a']), 'a;b');
  assert.equal(R.joinDedup([]), '');
  assert.equal(R.Action.Block, 'block');
  assert.equal(R.Action.Pause, 'pause');
  assert.equal(R.Action.Warn, 'warn');
  assert.equal(R.Action.Safe, 'safe');
  assert.ok(R.actionSeverity(R.Action.Block) > R.actionSeverity(R.Action.Pause));
  assert.ok(R.actionSeverity(R.Action.Pause) > R.actionSeverity(R.Action.Warn));
  assert.ok(R.actionSeverity(R.Action.Warn) > R.actionSeverity(R.Action.Safe));
  assert.equal(R.SwapAction.Block, 'block');
  assert.equal(R.SwapAction.Warn, 'warn');
  assert.equal(R.SwapAction.Ok, 'ok');
  assert.ok(R.swapActionSeverity(R.SwapAction.Block) > R.swapActionSeverity(R.SwapAction.Warn));
  assert.ok(R.swapActionSeverity(R.SwapAction.Warn) > R.swapActionSeverity(R.SwapAction.Ok));
  assert.equal(R.RiskLevel.Critical, 'CRITICAL');
  assert.equal(R.RiskLevel.High, 'HIGH');
  assert.equal(R.RiskLevel.Medium, 'MEDIUM');
  assert.equal(R.RiskLevel.Low, 'LOW');
  assert.equal(R.TradeDirection.Buy, 'buy');
  assert.equal(R.TradeDirection.Sell, 'sell');
});

// ═════════════════════════════ private Rust-semantics helpers ═════════════════════════════

test('_rust-str: trim / f64 / unsigned grammars', () => {
  assert.equal(RS.trim('\u0085 x 　'), 'x');
  assert.equal(RS.trim('﻿x'), '﻿x');
  assert.equal(RS.asciiLower('ÀBC'), 'Àbc');
  assert.equal(RS.asciiUpper('ıab'), 'ıAB');
  for (const [s, v] of [['1', 1], ['+1.5', 1.5], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['1E-2', 0.01], ['-0', -0]]) assert.equal(RS.parseF64(s), v);
  for (const s of ['inf', 'INFINITY', '+Inf']) assert.equal(RS.parseF64(s), Infinity);
  assert.equal(RS.parseF64('-inf'), -Infinity);
  assert.ok(Number.isNaN(RS.parseF64('NaN')));
  for (const s of ['', '.', 'e5', '1e', ' 1', '0x1', '1_0', 'infinit', '--1', 'Infinityy']) assert.equal(RS.parseF64(s), undefined, s);
  assert.equal(RS.parseUnsigned('+42'), 42);
  assert.equal(RS.parseUnsigned('4294967295', 'u32'), 4294967295);
  assert.equal(RS.parseUnsigned('4294967296', 'u32'), undefined);
  assert.equal(RS.parseUnsigned('18446744073709551615'), 18446744073709551615n);
  assert.equal(RS.parseUnsigned('18446744073709551616'), undefined);
  for (const s of ['', '+', '-1', '1 ', '١']) assert.equal(RS.parseUnsigned(s), undefined, s);
  assert.ok(F64);
});

// ═════════════════════ funding: no late binding of collaborators ═════════════════════

test('funding: a sync call right after module load renders the full Common QR', () => {
  // Regression: qr.mjs used to be late-bound, so a call issued before its dynamic import settled
  // emitted a degraded qr ({requestedFormat, displayMode} only). Upstream always renders the QR.
  const dir = mkdtempSync(join(tmpdir(), 'ocl-funding-sync-'));
  try {
    const script = `const F = await import(${JSON.stringify(new URL(LIB + 'funding.mjs', import.meta.url).href)});
const v = F.buildFundingBundleForAddress('Agent', '196', '0x1234567890abcdef1234567890abcdef12345678',
  { asset: 'USDT', tokenAddress: '0xT', required: '10', balance: '1' });
process.stdout.write(JSON.stringify(Object.keys(v.payload.qr).sort()));`;
    const env = { ...process.env, OCL_HOME: dir, ONCHAINOS_FUNDING_IMAGE_DIR: dir };
    delete env.CODEX_THREAD_ID;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // piped stdio ⇒ image-notify: the PNG-backed QrOutput, not the address-only degrade.
    assert.deepEqual(JSON.parse(r.stdout), ['displayMode', 'imagePath', 'markdownImage', 'mimeType', 'notifyCommandArgs', 'requestedFormat', 'resolvedFormat']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ═════════════════════ upstream differential vectors ═════════════════════
// [fn, args, expected], produced by compiling the upstream 4.6.3 sources verbatim (token_alias.rs,
// validators.rs, commands/sink.rs, asset_class.rs, commands/risk_classify.rs, plus the funding.rs
// / qr.rs struct and fn ranges) into a harness driven by a seeded fuzzer (~120k calls, 0 diffs),
// keeping one or two inputs per distinct outcome class. Value-typed args are JSON text (both sides
// parse with serde_json number semantics); struct outputs are serde_json::to_string text.
// expected: {ok} | {err: message} | {coded: {code, field, message}}.
const ORACLE_VECTORS = [
  ["addDecimalStrings",["\u0085","\u200b007"],{"err":"empty decimal string '\u0085'"}],
  ["addDecimalStrings",["","\u0085INF%"],{"err":"empty decimal string ''"}],
  ["addDecimalStrings",["\u00a0m","."],{"err":"unparseable decimal '\u00a0m'"}],
  ["addDecimalStrings",["8","\u2028d"],{"err":"unparseable decimal '\u2028d'"}],
  ["addDecimalStrings",["\t99.9999999999999999"," 5."],{"ok":"104.9999999999999999"}],
  ["addDecimalStrings",["99.9999999999999999\u00a0","\u202899.9999999999999999"],{"ok":"199.9999999999999998"}],
  ["assetClassFromStr",[""],{"err":"asset class must be spot, perp, prediction, option, or defi"}],
  ["assetClassFromStr",[""],{"err":"asset class must be spot, perp, prediction, option, or defi"}],
  ["assetClassFromStr",["defi"],{"ok":"defi"}],
  ["assetClassFromStr",["option"],{"ok":"option"}],
  ["assetClassFromStr",["perp"],{"ok":"perp"}],
  ["assetClassFromStr",["prediction"],{"ok":"prediction"}],
  ["assetClassFromStr",["spot"],{"ok":"spot"}],
  ["autoPaginate",["p0",10,"items","cursor","PageLevel",[{"page":"{\"list\":[{\"id\":0,\"cursor\":0},{\"id\":1,\"cursor\":1},{\"id\":2}],\"cursor\":\"p1\"}"},{"page":"{\"list\":[{\"id\":10,\"cursor\":10},{\"id\":11,\"cursor\":\"c1\"},{\"id\":12,\"cursor\":1.5},{\"id\":13,\"cursor\":\"c1\"}],\"cursor\":\"p1\"}"},{"page":"{\"list\":[{\"id\":20,\"cursor\":\"c20\"},{\"id\":21}],\"cursor\":\"c21\"}"}]],{"ok":{"json":"{\"items\":[{\"cursor\":0,\"id\":0},{\"cursor\":1,\"id\":1},{\"id\":2},{\"cursor\":10,\"id\":10},{\"cursor\":\"c1\",\"id\":11},{\"cursor\":1.5,\"id\":12},{\"cursor\":\"c1\",\"id\":13}],\"nextCursor\":\"p1\",\"fetchedCount\":7,\"partial\":true,\"error\":{\"code\":\"cursor_not_advancing\",\"message\":\"upstream returned the same cursor 'p1' it was queried with; stopping to avoid re-fetching the same page\",\"nextCursor\":\"p1\"}}","requested":["p0","p1"]}}],
  ["autoPaginate",["p0",7,"items","cursor","PageLevel",[{"page":"{\"list\":[{\"id\":0},{\"id\":1,\"cursor\":1.5}],\"cursor\":\"p0\"}"},{"page":"{\"zzz\":[],\"aaa\":\"x\",\"cursor\":\"p2\",\"bbb\":[{\"id\":-1}]}"}]],{"ok":{"json":"{\"items\":[{\"id\":0},{\"cursor\":1.5,\"id\":1}],\"nextCursor\":\"p0\",\"fetchedCount\":2,\"partial\":true,\"error\":{\"code\":\"cursor_not_advancing\",\"message\":\"upstream returned the same cursor 'p0' it was queried with; stopping to avoid re-fetching the same page\",\"nextCursor\":\"p0\"}}","requested":["p0"]}}],
  ["autoPaginate",["c0",7,"items","cursor","PageLevel",[{"page":"{\"list\":[{\"id\":0}],\"cursor\":\"p0\"}"},{"page":"{\"list\":[],\"cursor\":1.0}"}]],{"ok":{"json":"{\"items\":[{\"id\":0}],\"nextCursor\":\"p0\",\"fetchedCount\":1}","requested":["c0","p0"]}}],
  ["autoPaginate",[null,3,"list","cursor","PageLevel",[{"page":"{\"list\":[{\"id\":0,\"cursor\":\"c0\"},{\"id\":1,\"cursor\":1.5},{\"id\":2,\"cursor\":\"\"}],\"cursor\":1}"}]],{"ok":{"json":"{\"items\":[{\"cursor\":\"c0\",\"id\":0},{\"cursor\":1.5,\"id\":1},{\"cursor\":\"\",\"id\":2}],\"nextCursor\":\"1\",\"fetchedCount\":3}","requested":[null]}}],
  ["autoPaginate",["c0",10,"list","cursor","PageLevel",[{"page":"{\"zzz\":[],\"aaa\":\"x\",\"cursor\":1.0,\"bbb\":[{\"id\":-1}]}"},{"page":"[{\"id\":10}]"}]],{"ok":{"json":"{\"items\":[{\"id\":-1},{\"id\":10}],\"nextCursor\":null,\"fetchedCount\":2}","requested":["c0","1.0"]}}],
  ["autoPaginate",[null,3,"list","cursor","PageLevel",[{"page":"5"}]],{"ok":{"json":"{\"items\":[],\"nextCursor\":null,\"fetchedCount\":0}","requested":[null]}}],
  ["buildFundingBlockedResult",[{"asset":"\u0085","tokenAddress":"","required":"x","balance":"","operation":null,"errorCode":null,"errorMessage":null},{"accountName":"","chainIndex":"196","chainName":"Ethereum","receiveAddress":"0xabc","gasFree":true,"sameNetworkRequired":true},{"requestedFormat":"auto","resolvedFormat":"png","displayMode":"image-notify","terminalQr":null,"imagePath":"C:\\t\\q.png","mimeType":"image/png","markdownImage":"![q](q.png)","notifyCommandArgs":["agent","user-notify","--x"]}],{"ok":"{\"decision\":\"blocked\",\"nextAction\":[],\"payload\":{\"fundingNeed\":{\"asset\":\"\u0085\",\"balance\":\"\",\"required\":\"x\",\"tokenAddress\":\"\"},\"fundingTarget\":{\"accountName\":\"\",\"chainIndex\":\"196\",\"chainName\":\"Ethereum\",\"gasFree\":true,\"receiveAddress\":\"0xabc\",\"sameNetworkRequired\":true},\"qr\":{\"displayMode\":\"image-notify\",\"imagePath\":\"C:\\\\t\\\\q.png\",\"markdownImage\":\"![q](q.png)\",\"mimeType\":\"image/png\",\"notifyCommandArgs\":[\"agent\",\"user-notify\",\"--x\"],\"requestedFormat\":\"auto\",\"resolvedFormat\":\"png\"}},\"phase\":\"funding_required\",\"reason\":\"insufficient_balance\"}"}],
  ["buildFundingBlockedResult",[{"asset":"","tokenAddress":"","required":"x","balance":"0","operation":null,"errorCode":null,"errorMessage":null},{"accountName":"","chainIndex":"1","chainName":"X Layer","receiveAddress":"0xabc","gasFree":true,"sameNetworkRequired":true},{"requestedFormat":"auto","resolvedFormat":"unicode","displayMode":"terminal-unicode","terminalQr":"\u2588\u2580\n","imagePath":null,"mimeType":null,"markdownImage":null,"notifyCommandArgs":null}],{"ok":"{\"decision\":\"blocked\",\"nextAction\":[],\"payload\":{\"fundingNeed\":{\"asset\":\"\",\"balance\":\"0\",\"required\":\"x\",\"tokenAddress\":\"\"},\"fundingTarget\":{\"accountName\":\"\",\"chainIndex\":\"1\",\"chainName\":\"X Layer\",\"gasFree\":true,\"receiveAddress\":\"0xabc\",\"sameNetworkRequired\":true},\"qr\":{\"displayMode\":\"terminal-unicode\",\"requestedFormat\":\"auto\",\"resolvedFormat\":\"unicode\",\"terminalQr\":\"\u2588\u2580\\n\"}},\"phase\":\"funding_required\",\"reason\":\"insufficient_balance\"}"}],
  ["buildFundingBlockedResult",[{"asset":"","tokenAddress":"","required":"10.00","balance":".","operation":null,"errorCode":"E1","errorMessage":"boom"},{"accountName":"Trading","chainIndex":"1","chainName":"X Layer","receiveAddress":"0xabc","gasFree":false,"sameNetworkRequired":true},{"requestedFormat":"auto","resolvedFormat":"png","displayMode":"image-notify","terminalQr":null,"imagePath":"C:\\t\\q.png","mimeType":"image/png","markdownImage":"![q](q.png)","notifyCommandArgs":["agent","user-notify","--x"]}],{"ok":"{\"decision\":\"blocked\",\"nextAction\":[],\"payload\":{\"error\":{\"code\":\"E1\",\"message\":\"boom\"},\"fundingNeed\":{\"asset\":\"\",\"balance\":\".\",\"required\":\"10.00\",\"tokenAddress\":\"\"},\"fundingTarget\":{\"accountName\":\"Trading\",\"chainIndex\":\"1\",\"chainName\":\"X Layer\",\"gasFree\":false,\"receiveAddress\":\"0xabc\",\"sameNetworkRequired\":true},\"qr\":{\"displayMode\":\"image-notify\",\"imagePath\":\"C:\\\\t\\\\q.png\",\"markdownImage\":\"![q](q.png)\",\"mimeType\":\"image/png\",\"notifyCommandArgs\":[\"agent\",\"user-notify\",\"--x\"],\"requestedFormat\":\"auto\",\"resolvedFormat\":\"png\"}},\"phase\":\"funding_required\",\"reason\":\"insufficient_balance\"}"}],
  ["buildFundingBlockedResult",[{"asset":"USDC","tokenAddress":"","required":"1e3","balance":"","operation":null,"errorCode":"\ufeff","errorMessage":"boom"},{"accountName":"","chainIndex":"1","chainName":"Ethereum","receiveAddress":"0xabc","gasFree":true,"sameNetworkRequired":true},{"requestedFormat":"auto","resolvedFormat":"unicode","displayMode":"terminal-unicode","terminalQr":"\u2588\u2580\n","imagePath":null,"mimeType":null,"markdownImage":null,"notifyCommandArgs":null}],{"ok":"{\"decision\":\"blocked\",\"nextAction\":[],\"payload\":{\"error\":{\"code\":\"\ufeff\",\"message\":\"boom\"},\"fundingNeed\":{\"asset\":\"USDC\",\"balance\":\"\",\"required\":\"1e3\",\"tokenAddress\":\"\"},\"fundingTarget\":{\"accountName\":\"\",\"chainIndex\":\"1\",\"chainName\":\"Ethereum\",\"gasFree\":true,\"receiveAddress\":\"0xabc\",\"sameNetworkRequired\":true},\"qr\":{\"displayMode\":\"terminal-unicode\",\"requestedFormat\":\"auto\",\"resolvedFormat\":\"unicode\",\"terminalQr\":\"\u2588\u2580\\n\"}},\"phase\":\"funding_required\",\"reason\":\"insufficient_balance\"}"}],
  ["classifySwapRoute",["{\"toToken\":{\"isHoneyPot\":true}}"],{"ok":"{\"action\":\"block\",\"reason\":\"to-token is a honeypot\",\"toToken\":{\"isHoneyPot\":true}}"}],
  ["classifySwapRoute",["{\"toToken\":{\"riskLevel\":\"LOW \",\"isHoneyPot\":true},\"fromToken\":{\"isHoneyPot\":true,\"taxRate\":\"50\"}}"],{"ok":"{\"action\":\"block\",\"fromToken\":{\"isHoneyPot\":true,\"taxRate\":\"50\"},\"reason\":\"to-token is a honeypot;from-token is a honeypot; exit allowed\",\"toToken\":{\"isHoneyPot\":true,\"riskLevel\":\"LOW \"}}"}],
  ["classifySwapRoute",["0"],{"ok":"0"}],
  ["classifySwapRoute",["{}"],{"ok":"{\"action\":\"ok\",\"reason\":\"\"}"}],
  ["classifySwapRoute",["{\"fromToken\":{\"riskLevel\":\"x\",\"isHoneyPot\":true,\"taxRate\":50}}"],{"ok":"{\"action\":\"warn\",\"fromToken\":{\"isHoneyPot\":true,\"riskLevel\":\"x\",\"taxRate\":50},\"reason\":\"from-token is a honeypot; exit allowed\"}"}],
  ["classify",["{\"contractAddress\":\"0xabc\"}","sell"],{"ok":["HIGH",false,"warn"]}],
  ["classify",["{}","buy"],{"ok":["HIGH",true,"pause"]}],
  ["combinedAction",["[{\"riskLevel\":\"CRITICAL\",\"contractAddress\":\"0xabc\"}]","buy"],{"ok":"block"}],
  ["combinedAction",["[{\"tokenContractAddress\":\"0xabc\"}]","buy"],{"ok":"pause"}],
  ["combinedAction",["[]","buy"],{"ok":"safe"}],
  ["combinedAction",["[{\"riskLevel\":1e3,\"tokenContractAddress\":\"\ufeff\",\"isHoneyPot\":1}]","sell"],{"ok":"warn"}],
  ["formatThousands",[""],{"ok":""}],
  ["formatThousands",["."],{"ok":"."}],
  ["formatThousands",["\ufeff."],{"ok":"\u00ef\u00bb\u00bf."}],
  ["formatThousands",["\u00a0"],{"ok":"\u00c2\u00a0"}],
  ["formatThousands",["1234"],{"ok":"1,234"}],
  ["formatThousands",["\u00a0CRITICAL92233720368547758081E3"],{"ok":"\u00c2\u00a0,CRI,TIC,AL9,223,372,036,854,775,808,1E3"}],
  ["formatThousands",["\u180ePERP92233720368547758080xABCDEF"],{"ok":"\u00e1,\u00a0\u008eP,ERP,922,337,203,685,477,580,80x,ABC,DEF"}],
  ["formatThousands",["eefXe2db08Fbeaeaf7e 1DdDfacdBaX8e4%bCA"],{"ok":"ee,fXe,2db,08F,bea,eaf,7e ,1Dd,Dfa,cdB,aX8,e4%,bCA"}],
  ["formatThousands",["FEFF11111111111111111111111111111111\u2028"],{"ok":"FEF,F11,111,111,111,111,111,111,111,111,111,111,\u00e2\u0080\u00a8"}],
  ["formatThousands",["\u200bT9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb\u200b"],{"ok":"\u00e2,\u0080\u008bT,9yD,14N,j9j,7xA,B4d,bGe,iX9,h8u,nkK,Hxu,Wwb,\u00e2\u0080\u008b"}],
  ["hasAlias",["1","Usdc"],{"ok":true}],
  ["hasAlias",["195","TRX"],{"ok":true}],
  ["hasAlias",["196","XLAYER_USDT"],{"ok":true}],
  ["hasAlias",["43114","WETH.E"],{"ok":true}],
  ["hasAlias",["501","SOL"],{"ok":true}],
  ["hasAlias",["5042","USDC"],{"ok":true}],
  ["hasAlias",["784","SUI"],{"ok":true}],
  ["hasAlias",["","\u0130"],{"ok":false}],
  ["hexToDecimalString",["\u00df"],{"err":"invalid hex digit '\u00df' in '\u00df'"}],
  ["hexToDecimalString",["\ufeffd"],{"err":"invalid hex digit '\ufeff' in '\ufeffd'"}],
  ["hexToDecimalString",[""],{"ok":"0"}],
  ["hexToDecimalString",["\u00a01"],{"ok":"1"}],
  ["hexToDecimalString",["0fffffffffffffffffffffffffffffffffffffffffffffffff"],{"ok":"100433627766186892221372630771322662657637687111424552206335"}],
  ["hexToDecimalString",["0ffffffffff"],{"ok":"1099511627775"}],
  ["hexToDecimalString",[" 0xABCDEF"],{"ok":"11259375"}],
  ["hexToDecimalString",["C"],{"ok":"12"}],
  ["hexToDecimalString",["\u00a01e400"],{"ok":"123904"}],
  ["hexToDecimalString",["\t7d"],{"ok":"125"}],
  ["normalizeAmount",["\"0xG\""],{"ok":{"error":"invalid hex digit 'G' in '0xG'"}}],
  ["normalizeAmount",["[]"],{"ok":{"error":"unparseable value (unexpected JSON type)"}}],
  ["normalizeAmount",["\"\u200b\""],{"ok":{"error":"unparseable value '\u200b'"}}],
  ["normalizeAmount",["-1"],{"ok":{"error":"value must be a non-negative integer minimal unit, got '-1'"}}],
  ["normalizeAmount",["0"],{"ok":{"value":"0"}}],
  ["normalizeAmount",["\"0x0123456789abcdef01234\""],{"ok":{"value":"85968058283706962416180"}}],
  ["normalizeAmount",["1"],{"ok":{"value":"1"}}],
  ["normalizeRiskLevel",["CRITICAL"],{"ok":"CRITICAL"}],
  ["normalizeRiskLevel",[""],{"ok":"HIGH"}],
  ["normalizeRiskLevel",["low"],{"ok":"LOW"}],
  ["normalizeRiskLevel",["medium"],{"ok":"MEDIUM"}],
  ["parseDurationMs",["0085213503982334602d","idle-timeout",false],{"err":"--idle-timeout '0085213503982334602d' overflows"}],
  ["parseDurationMs",["\n18446744073709551615s","idle-timeout",true],{"err":"--idle-timeout '\n18446744073709551615s' overflows"}],
  ["parseDurationMs",["\t18446744073709551615s","since",false],{"err":"--since '\t18446744073709551615s' overflows"}],
  ["parseDurationMs",[" 0m","idle-timeout",false],{"err":"invalid --idle-timeout ' 0m'; duration must be positive"}],
  ["parseDurationMs",[" 0h","idle-timeout",false],{"err":"invalid --idle-timeout ' 0h'; duration must be positive"}],
  ["parseDurationMs",["","idle-timeout",true],{"err":"invalid --idle-timeout ''; use e.g. 300s, 30m, 24h, 7d"}],
  ["parseDurationMs",["C","idle-timeout",true],{"err":"invalid --idle-timeout 'C'; use e.g. 300s, 30m, 24h, 7d"}],
  ["parseDurationMs",["","since",true],{"err":"invalid --since ''; use e.g. 300s, 30m, 24h, 7d"}],
  ["parseDurationMs",["E","since",true],{"err":"invalid --since 'E'; use e.g. 300s, 30m, 24h, 7d"}],
  ["parseDurationMs",["\u00a00d","since",true],{"ok":"0"}],
  ["parseMaxResults",[""],{"coded":{"code":"invalid_input","field":"max-results","message":"--max-results must be an integer between 1 and 500, got ''"}}],
  ["parseMaxResults",["\u202800"],{"coded":{"code":"invalid_input","field":"max-results","message":"--max-results must be between 1 and 500, got 0"}}],
  ["parseMaxResults",["1"],{"ok":1}],
  ["parseMaxResults",["10"],{"ok":10}],
  ["parseMaxResults",["\n100\u00a0"],{"ok":100}],
  ["parseMaxResults",["20"],{"ok":20}],
  ["parseMaxResults",["\u00a0007"],{"ok":7}],
  ["parseMaxResults",["0085"],{"ok":85}],
  ["parseMaxResults",[null],{"ok":null}],
  ["parseTradeDirectionValue",[""],{"err":"invalid trade direction ''; expected 'buy' or 'sell'"}],
  ["parseTradeDirectionValue",[""],{"err":"invalid trade direction ''; expected 'buy' or 'sell'"}],
  ["parseTradeDirectionValue",["buy"],{"ok":"buy"}],
  ["parseTradeDirectionValue",["sell"],{"ok":"sell"}],
  ["readableShortfall",[" 1\u2028","\n1.00000000000000001"],{"ok":"0"}],
  ["readableShortfall",["\t100.0","0.00000"],{"ok":"100"}],
  ["readableShortfall",["4294967296","\n007\u0085"],{"ok":"4294967289"}],
  ["readableShortfall",[" 10","\u00a01.5\n"],{"ok":"8.5"}],
  ["readableShortfall",[" 00000000000000000000009223372036854775807","\u0085100.0000000000001"],{"ok":"9223372036854775706.9999999999999"}],
  ["readableShortfall",["\u20289223372036854775807","\u3000007"],{"ok":"9223372036854775800"}],
  ["readableShortfall",["","\u2028-"],{"ok":null}],
  ["readableToMinimalStr",["\n",0],{"err":"--readable-amount  is too small for this token (0 decimals); results in zero minimal units"}],
  ["readableToMinimalStr",[".",6],{"err":"--readable-amount . is too small for this token (6 decimals); results in zero minimal units"}],
  ["readableToMinimalStr",[" 0.5",0],{"err":"--readable-amount \"0.5\" has more decimal places than this token supports (0 decimals)"}],
  ["readableToMinimalStr",["\u300099.9999999999999999",8],{"err":"--readable-amount \"99.9999999999999999\" has more decimal places than this token supports (8 decimals)"}],
  ["readableToMinimalStr",["\u008500",8],{"err":"--readable-amount 00 is too small for this token (8 decimals); results in zero minimal units"}],
  ["readableToMinimalStr",["\u30000.0",6],{"err":"--readable-amount 0.0 is too small for this token (6 decimals); results in zero minimal units"}],
  ["readableToMinimalStr",["0.00000",2],{"err":"--readable-amount 0.00000 is too small for this token (2 decimals); results in zero minimal units"}],
  ["readableToMinimalStr",["+",0],{"err":"--readable-amount must be a positive number, got \"+\""}],
  ["readableToMinimalStr",["+",9],{"err":"--readable-amount must be a positive number, got \"+\""}],
  ["readableToMinimalStr",["0.1",2],{"ok":"10"}],
  ["resolveAndValidate",[""," d1","from"],{"err":"--from is not a valid EVM address: expected 0x + 40 hex digits, got \" d1\""}],
  ["resolveAndValidate",["","\ufeff0s","from"],{"err":"--from is not a valid EVM address: expected 0x + 40 hex digits, got \"\ufeff0s\""}],
  ["resolveAndValidate",["501","","from"],{"err":"--from is not a valid Solana address: expected 32-44 base58 characters, got 0 characters (\"\")"}],
  ["resolveAndValidate",["501"," 0m","from"],{"err":"--from is not a valid Solana address: expected 32-44 base58 characters, got 3 characters (\" 0m\")"}],
  ["resolveAndValidate",["","%","to-token"],{"err":"--to-token is not a valid EVM address: expected 0x + 40 hex digits, got \"%\""}],
  ["resolveAndValidate",["0","\u0085s","to-token"],{"err":"--to-token is not a valid EVM address: expected 0x + 40 hex digits, got \"\u0085s\""}],
  ["resolveAndValidate",["501","\u00a01","to-token"],{"err":"--to-token is not a valid Solana address: expected 32-44 base58 characters, got 3 characters (\"\u00a01\")"}],
  ["resolveAndValidate",["501","\u3000in","to-token"],{"err":"--to-token is not a valid Solana address: expected 32-44 base58 characters, got 5 characters (\"\u3000in\")"}],
  ["resolveAndValidate",["1","","wallet"],{"err":"--wallet is not a valid EVM address: expected 0x + 40 hex digits, got \"\""}],
  ["resolveAndValidate",[""," h","wallet"],{"err":"--wallet is not a valid EVM address: expected 0x + 40 hex digits, got \" h\""}],
  ["resolveSinceWindow",["008518446744073709552s","1000"],{"err":"--since '008518446744073709552s' overflows"}],
  ["resolveSinceWindow",[" 18446744073709552s","86399999"],{"err":"--since ' 18446744073709552s' overflows"}],
  ["resolveSinceWindow",["\t0\n","0"],{"err":"invalid --since '\t0\n'; duration must be positive"}],
  ["resolveSinceWindow",["\n0s","1000"],{"err":"invalid --since '\n0s'; duration must be positive"}],
  ["resolveSinceWindow",["+","0"],{"err":"invalid --since '+'; use e.g. 300s, 30m, 24h, 7d"}],
  ["resolveSinceWindow",[" ","0"],{"err":"invalid --since ' '; use e.g. 300s, 30m, 24h, 7d"}],
  ["resolveSinceWindow",["\u300030m","0"],{"ok":"{\"begin\":0,\"end\":0}"}],
  ["resolveSinceWindow",["0085m","1000"],{"ok":"{\"begin\":0,\"end\":1000}"}],
  ["resolveSinceWindow",["7d","1700000000000"],{"ok":"{\"begin\":1699395200000,\"end\":1700000000000}"}],
  ["resolveSinceWindow",["\n+5s","1700000000000"],{"ok":"{\"begin\":1699999995000,\"end\":1700000000000}"}],
  ["resolveTokenAddress",["1","USDC"],{"ok":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}],
  ["resolveTokenAddress",["195","TRX"],{"ok":"T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"}],
  ["resolveTokenAddress",["196","XLAYER_USDT"],{"ok":"0x1e4a5963abfd975d8c9021ce480b42188849d41d"}],
  ["resolveTokenAddress",["43114","WETH.E"],{"ok":"0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab"}],
  ["resolveTokenAddress",["501","SOL"],{"ok":"11111111111111111111111111111111"}],
  ["resolveTokenAddress",["5042","USDC"],{"ok":"0x3600000000000000000000000000000000000000"}],
  ["resolveTokenAddress",["784","SUI"],{"ok":"0x2::sui::SUI"}],
  ["resolveTokenAddress",["","d"],{"ok":"d"}],
  ["sumPrizePool",["[]"],{"ok":"null"}],
  ["sumPrizePool",["[0]"],{"ok":"{\"amountByUnit\":[],\"display\":\"\",\"partial\":true}"}],
  ["sumPrizePool",["[{\"totalReward\":0}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"0\",\"rewardUnit\":\"\"}],\"display\":\"0\"}"}],
  ["sumPrizePool",["[{\"totalReward\":\"0.2\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"0.2\",\"rewardUnit\":\"\"}],\"display\":\"0.2\"}"}],
  ["sumPrizePool",["[{\"totalReward\":\"1000000\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"1000000\",\"rewardUnit\":\"\"}],\"display\":\"1,000,000\"}"}],
  ["sumPrizePool",["[{\"totalReward\":\"12345678901234567890.123456789\",\"rewardUnit\":\"OKB\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"12345678901234567890.123456789\",\"rewardUnit\":\"OKB\"}],\"display\":\"12,345,678,901,234,567,890.123456789 OKB\"}"}],
  ["sumPrizePool",["[{\"totalReward\":\"0\"},{\"rewardUnit\":\"\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"0\",\"rewardUnit\":\"\"}],\"display\":\"0\",\"partial\":true}"}],
  ["sumPrizePool",["[\"\u200b0x00\",{\"totalReward\":\"0.1\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"0.1\",\"rewardUnit\":\"\"}],\"display\":\"0.1\",\"partial\":true}"}],
  ["sumPrizePool",["[{\"totalReward\":123456789012345678},\"\u30000.5\"]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"123456789012345678\",\"rewardUnit\":\"\"}],\"display\":\"123,456,789,012,345,678\",\"partial\":true}"}],
  ["sumPrizePool",["[{},{},{\"totalReward\":12345.678,\"rewardUnit\":\"\"}]"],{"ok":"{\"amountByUnit\":[{\"amount\":\"12345.678\",\"rewardUnit\":\"\"}],\"display\":\"12,345.678\",\"partial\":true}"}],
  ["validateAddressForChain",[""," ","from"],{"err":"--from is not a valid EVM address: expected 0x + 40 hex digits, got \" \""}],
  ["validateAddressForChain",["","\u00a000","from"],{"err":"--from is not a valid EVM address: expected 0x + 40 hex digits, got \"\u00a000\""}],
  ["validateAddressForChain",["501","\u3000T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb","from"],{"err":"--from is not a valid Solana address: contains characters outside base58 alphabet (\"\u3000T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb\")"}],
  ["validateAddressForChain",["501","\u0085in","from"],{"err":"--from is not a valid Solana address: expected 32-44 base58 characters, got 4 characters (\"\u0085in\")"}],
  ["validateAddressForChain",["501","\u3000USDC","from"],{"err":"--from is not a valid Solana address: expected 32-44 base58 characters, got 7 characters (\"\u3000USDC\")"}],
  ["validateAddressForChain",["0","","to-token"],{"err":"--to-token is not a valid EVM address: expected 0x + 40 hex digits, got \"\""}],
  ["validateAddressForChain",["","\ufeff0m","to-token"],{"err":"--to-token is not a valid EVM address: expected 0x + 40 hex digits, got \"\ufeff0m\""}],
  ["validateAddressForChain",["501","6 +ADAfDaD%D-eC234eC6Ea2BfB3e+8b75c","to-token"],{"err":"--to-token is not a valid Solana address: contains characters outside base58 alphabet (\"6 +ADAfDaD%D-eC234eC6Ea2BfB3e+8b75c\")"}],
  ["validateAddressForChain",["501","cxx17FdECD-xecX6aC--e829+%C-c7ebcaa6Ca2eb1","to-token"],{"err":"--to-token is not a valid Solana address: contains characters outside base58 alphabet (\"cxx17FdECD-xecX6aC--e829+%C-c7ebcaa6Ca2eb1\")"}],
  ["validateAddressForChain",["501","SELL","to-token"],{"err":"--to-token is not a valid Solana address: expected 32-44 base58 characters, got 4 characters (\"SELL\")"}],
  ["validateAmount",[" ."],{"err":"--amount must be a whole number in minimal units (no decimals)"}],
  ["validateAmount",["\u00a0."],{"err":"--amount must be a whole number in minimal units (no decimals)"}],
  ["validateAmount",["\u00e9"],{"err":"--amount must be a whole number in minimal units, got \"\u00e9\". Infinity, NaN, negative numbers and non-numeric values are not accepted."}],
  ["validateAmount",["h"],{"err":"--amount must be a whole number in minimal units, got \"h\". Infinity, NaN, negative numbers and non-numeric values are not accepted."}],
  ["validateAmount",["\u00a000"],{"err":"--amount must be greater than zero"}],
  ["validateAmount",["\u300000"],{"err":"--amount must be greater than zero"}],
  ["validateAmount",[""],{"err":"--amount must not be empty"}],
  ["validateAmount",[""],{"err":"--amount must not be empty"}],
  ["validateAmount",["\u2028007"],{"err":"--amount must not have leading zeros, got \"007\""}],
  ["validateAmount",["\u0085007"],{"err":"--amount must not have leading zeros, got \"007\""}],
  ["validateFundingBlockedInput",[{"asset":"","tokenAddress":"","required":".5","balance":null,"operation":"","errorCode":"","errorMessage":""}],{"err":"funding asset must not be blank"}],
  ["validateFundingBlockedInput",[{"asset":"","tokenAddress":"","required":"x","balance":"1","operation":" ","errorCode":"\ufeff","errorMessage":"\u3000"}],{"err":"funding asset must not be blank"}],
  ["validateFundingBlockedInput",[{"asset":"USDC","tokenAddress":"","required":"5.","balance":"","operation":null,"errorCode":"","errorMessage":null}],{"err":"funding balance must be a plain non-negative decimal"}],
  ["validateFundingBlockedInput",[{"asset":"OKB","tokenAddress":"","required":"10","balance":".","operation":null,"errorCode":"","errorMessage":"boom"}],{"err":"funding balance must be a plain non-negative decimal"}],
  ["validateFundingBlockedInput",[{"asset":"OKB","tokenAddress":"","required":"5.","balance":"11","operation":null,"errorCode":"\ufeff","errorMessage":null}],{"err":"funding bundle requires an actual balance shortfall"}],
  ["validateFundingBlockedInput",[{"asset":"OKB","tokenAddress":"","required":"5.","balance":"11","operation":null,"errorCode":"\ufeff","errorMessage":null}],{"err":"funding bundle requires an actual balance shortfall"}],
  ["validateNonNegativeInteger",["-","from"],{"err":"--from must be a non-negative integer, got \"-\""}],
  ["validateNonNegativeInteger",["\uff11","from"],{"err":"--from must be a non-negative integer, got \"\uff11\""}],
  ["validateNonNegativeInteger",["\t","from"],{"err":"--from must not be empty"}],
  ["validateNonNegativeInteger",[" 00\t","from"],{"err":"--from must not have leading zeros, got \"00\""}],
  ["validateNonNegativeInteger",["008518446744073709551616","from"],{"err":"--from must not have leading zeros, got \"008518446744073709551616\""}],
  ["validateNonNegativeInteger",["\u3000h","to-token"],{"err":"--to-token must be a non-negative integer, got \"h\""}],
  ["validateNonNegativeInteger",["\u00a0s","to-token"],{"err":"--to-token must be a non-negative integer, got \"s\""}],
  ["validateNonNegativeInteger",["-","wallet"],{"err":"--wallet must be a non-negative integer, got \"-\""}],
  ["validateNonNegativeInteger",["+1","wallet"],{"err":"--wallet must be a non-negative integer, got \"+1\""}],
  ["validateNonNegativeInteger",["0085501","wallet"],{"err":"--wallet must not have leading zeros, got \"0085501\""}],
  ["validateOrderIdNumeric",["\u300018446744073709551616","from"],{"err":"--from `18446744073709551616` does not fit in BE Long range (max 9223372036854775807)"}],
  ["validateOrderIdNumeric",[".","from"],{"err":"--from must be a numeric order id, got `.`"}],
  ["validateOrderIdNumeric",["s","from"],{"err":"--from must be a numeric order id, got `s`"}],
  ["validateOrderIdNumeric",["\u2028","from"],{"err":"--from must not be empty"}],
  ["validateOrderIdNumeric",["\u00859223372036854775808","to-token"],{"err":"--to-token `9223372036854775808` does not fit in BE Long range (max 9223372036854775807)"}],
  ["validateOrderIdNumeric",["\u20289223372036854775808","to-token"],{"err":"--to-token `9223372036854775808` does not fit in BE Long range (max 9223372036854775807)"}],
  ["validateOrderIdNumeric",["-","to-token"],{"err":"--to-token must be a numeric order id, got `-`"}],
  ["validateOrderIdNumeric",["\u200b\u0131","to-token"],{"err":"--to-token must be a numeric order id, got `\u200b\u0131`"}],
  ["validateOrderIdNumeric",["","to-token"],{"err":"--to-token must not be empty"}],
  ["validateOrderIdNumeric",["\u0085","to-token"],{"err":"--to-token must not be empty"}],
  ["validateSlippageZeroToOne",[" %"],{"err":"--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got \"%\""}],
  ["validateSlippageZeroToOne",[" %"],{"err":"--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got \"%\""}],
  ["validateSlippageZeroToOne",[""],{"err":"--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got \"\""}],
  ["validateSlippageZeroToOne",["\uff11"],{"err":"--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got \"\uff11\""}],
  ["validateSlippageZeroToOne",["NaN"],{"err":"--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got \"NaN\""}],
  ["validateSlippageZeroToOne",["\u3000-nan"],{"err":"--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got \"-nan\""}],
  ["validateSlippageZeroToOne",["5"],{"err":"--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got \"5\""}],
  ["validateSlippageZeroToOne",["5."],{"err":"--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got \"5.\""}],
  ["validateSlippageZeroToOne",["0.5"],{"ok":null}],
  ["validateSlippage",[" INF"],{"err":"--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got \"INF\""}],
  ["validateSlippage",["\u0085NaN"],{"err":"--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got \"NaN\""}],
  ["validateSlippage",[""],{"err":"--slippage must be a number between 0 (exclusive) and 100 (inclusive), got \"\""}],
  ["validateSlippage",[""],{"err":"--slippage must be a number between 0 (exclusive) and 100 (inclusive), got \"\""}],
  ["validateSlippage",["\u30000"],{"err":"--slippage must be greater than 0 and at most 100, got \"0\""}],
  ["validateSlippage",["\u300000"],{"err":"--slippage must be greater than 0 and at most 100, got \"00\""}],
  ["validateSlippage",["58"],{"ok":null}],
  // Unicode case-folding traps: Rust folds ASCII only (Kelvin sign, dotless i, long s).
  ["resolveTokenAddress",["196","o\u212ab"],{"ok":"o\u212ab"}],
  ["hasAlias",["196","WO\u212aB"],{"ok":false}],
  ["resolveAndValidate",["196","o\u212ab","from-token"],{"err":"--from-token is not a valid EVM address: expected 0x + 40 hex digits, got \"o\u212ab\""}],
  ["normalizeRiskLevel",["cr\u0131t\u0131cal"],{"ok":"HIGH"}],
  ["normalizeRiskLevel",["h\u0131gh"],{"ok":"HIGH"}],
  ["classify",["{\"riskLevel\":\"cr\u0131t\u0131cal\",\"tokenContractAddress\":\"0xa\"}","buy"],{"ok":["HIGH",false,"pause"]}],
  ["assetClassFromStr",["\u017fpot"],{"err":"asset class must be spot, perp, prediction, option, or defi"}],
  ["parseTradeDirectionValue",["\u017fell"],{"err":"invalid trade direction '\u017fell'; expected 'buy' or 'sell'"}],
  ["normalizeAmount",["\"0X0\""],{"ok":{"value":"0"}}],
  ["normalizeAmount",["\"0\u212a\""],{"ok":{"error":"unparseable value '0\u212a'"}}],
];

const u64Arg = (s) => { const b = BigInt(s); return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b; };
const noNull = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ?? undefined]));
const outcome = (fn) => {
  try { return { ok: fn() }; } catch (e) {
    if (e instanceof CodedError) return { coded: { code: e.code, field: e.field ?? null, message: e.message } };
    return { err: e.message };
  }
};

async function oracleCall(f, a) {
  switch (f) {
    case 'resolveTokenAddress': return outcome(() => TA.resolveTokenAddress(a[0], a[1]));
    case 'hasAlias': return outcome(() => TA.hasAlias(a[0], a[1]));
    case 'validateAddressForChain': return outcome(() => (TA.validateAddressForChain(a[0], a[1], a[2]), null));
    case 'resolveAndValidate': return outcome(() => TA.resolveAndValidate(a[0], a[1], a[2]));
    case 'validateAmount': return outcome(() => (V.validateAmount(a[0]), null));
    case 'validateSlippage': return outcome(() => (V.validateSlippage(a[0]), null));
    case 'validateSlippageZeroToOne': return outcome(() => (V.validateSlippageZeroToOne(a[0]), null));
    case 'validateNonNegativeInteger': return outcome(() => (V.validateNonNegativeInteger(a[0], a[1]), null));
    case 'validateOrderIdNumeric': return outcome(() => (V.validateOrderIdNumeric(a[0], a[1]), null));
    case 'readableToMinimalStr': return outcome(() => V.readableToMinimalStr(a[0], a[1]));
    case 'parseDurationMs': return outcome(() => String(S.parseDurationMs(a[0], a[1], a[2])));
    case 'resolveSinceWindow': return outcome(() => stringify(S.resolveSinceWindow(a[0], u64Arg(a[1]))));
    case 'parseMaxResults': return outcome(() => S.parseMaxResults(a[0] ?? undefined));
    case 'normalizeAmount': return outcome(() => S.normalizeAmount(parse(a[0])));
    case 'hexToDecimalString': return outcome(() => S.hexToDecimalString(a[0]));
    case 'sumPrizePool': return outcome(() => stringify(S.sumPrizePool(parse(a[0]))));
    case 'addDecimalStrings': return outcome(() => S.addDecimalStrings(a[0], a[1]));
    case 'formatThousands': return outcome(() => S.formatThousands(a[0]));
    case 'autoPaginate': {
      const requested = [];
      let i = 0;
      const shape = S.pageShape(a[2], a[3], a[4] === 'PerItem' ? S.CursorMode.PerItem : S.CursorMode.PageLevel);
      const agg = await S.autoPaginate(a[0], a[1], shape, async (cursor) => {
        requested.push(cursor);
        const p = a[5][i++];
        if (p === undefined) throw new Error('script exhausted');
        if (p.err !== undefined) throw new Error(p.err);
        return parse(p.page);
      });
      return { ok: { json: stringify(agg), requested } };
    }
    case 'assetClassFromStr': return outcome(() => AC.assetClassAsStr(AC.assetClassFromStr(a[0])));
    case 'parseTradeDirectionValue': return outcome(() => R.parseTradeDirectionValue(a[0]));
    case 'normalizeRiskLevel': return outcome(() => R.normalizeRiskLevel(a[0] ?? undefined));
    case 'classify': return outcome(() => {
      const t = R.TokenResult.classify(parse(a[0]), R.parseTradeDirectionValue(a[1]));
      return [t.normalizedRiskLevel(), t.isNative(), t.action()];
    });
    case 'combinedAction': return outcome(() => R.combinedAction(parse(a[0]).map((t) => R.TokenResult.classify(t, R.parseTradeDirectionValue(a[1])))));
    case 'classifySwapRoute': return outcome(() => { const v = parse(a[0]); R.classifySwapRoute(v); return stringify(v); });
    case 'readableShortfall': return outcome(() => F.readableShortfall(a[0], a[1]));
    case 'validateFundingBlockedInput': return outcome(() => (F.validateFundingBlockedInput(a[0]), null));
    case 'buildFundingBlockedResult': return outcome(() => stringify(F.buildFundingBlockedResult({ target: a[1], qr: Q.qrOutput(noNull(a[2])) }, a[0])));
    default: throw new Error(`no dispatcher for ${f}`);
  }
}

test('oracle: every helper reproduces the upstream Rust result byte-for-byte', async () => {
  const failures = [];
  for (const [f, a, want] of ORACLE_VECTORS) {
    const got = await oracleCall(f, a);
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push({ f, a, want, got });
  }
  assert.deepEqual(failures, []);
  assert.equal(new Set(ORACLE_VECTORS.map(([f]) => f)).size, 28);
});
