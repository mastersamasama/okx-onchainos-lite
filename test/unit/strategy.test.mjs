// Unit tests for lib/wallet/strategy/** (upstream commands/agentic_wallet/strategy/*.rs).
// Oracles are the upstream Rust #[cfg(test)] modules; signatures are cross-checked against the
// upstream binary's recorded createOrder requests when the parity cassettes exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-strategy-'));
cpSync(join(HERE, '..', 'parity', 'homes', 'wallet'), HOME, { recursive: true });
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;

const status = await import('../../skill/onchainos-lite/lib/wallet/strategy/status.mjs');
const chains = await import('../../skill/onchainos-lite/lib/wallet/strategy/supported-chains.mjs');
const tm = await import('../../skill/onchainos-lite/lib/wallet/strategy/trader-mode.mjs');
const types = await import('../../skill/onchainos-lite/lib/wallet/strategy/types.mjs');
const h = await import('../../skill/onchainos-lite/lib/wallet/strategy/handlers.mjs');
const api = await import('../../skill/onchainos-lite/lib/wallet/strategy/api.mjs');
const session = await import('../../skill/onchainos-lite/lib/wallet/strategy/session.mjs');
const { parse, stringify, F64 } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { CodedError } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');
const { ed25519 } = await import('../../skill/onchainos-lite/lib/crypto/curve25519.mjs');
const { keccak256 } = await import('../../skill/onchainos-lite/lib/crypto/keccak.mjs');
const { ed25519SignHex } = await import('../../skill/onchainos-lite/lib/wallet/strategy/_crypto.mjs');

// test/parity/make-home.mjs::SIGNING_SEED (the seed the parity homes' encryptedSessionSk seals)
const SEED = createHash('sha256').update('onchainos-lite parity :: ed25519-signing-seed').digest();
const SEED_B64 = SEED.toString('base64');

// ── status.rs ──
test('status_label / terminal set (status.rs tests)', () => {
  const table = [[-7, 'expired'], [-3, 'cancelling'], [-2, 'cancelled'], [-1, 'failed'], [0, 'processing'], [1, 'completed'], [2, 'creating'], [3, 'active'], [4, 'suspended']];
  for (const [n, s] of table) assert.equal(status.statusLabel(n), s);
  assert.equal(status.statusLabel(999), 'unknown(999)');
  assert.equal(status.statusLabel(-4), 'unknown(-4)');
  assert.throws(() => status.orderStatusTryFrom(-4), /unknown OrderStatus integer: -4/);
  for (const n of [1, -2, -1, -7]) assert.equal(status.orderStatusIsTerminal(n), true);
  for (const n of [0, 2, 3, 4, -3]) assert.equal(status.orderStatusIsTerminal(n), false);
});

test('StrategyError::from_code table', () => {
  const cases = [[100, 'RequestParam'], [10019, 'InsufficientNativeGas'], [10026, 'JwtVerifyFailed'], [10106, 'ChainNotSupported'],
    [60002, 'NoOrderFound'], [60003, 'NoAuthority'], [60006, 'OutOfLimit'], [60009, 'Illiquidity'], [60014, 'ExpiredCannotOperate'],
    [60015, 'PendingCannotOperate'], [60017, 'SuccessCannotOperate'], [60018, 'UpgradeRequired'], [60030, 'QuotaExceeded'],
    [100007, 'TeeSignFailure'], [100010, 'OrderAmountTooSmall'], [100012, 'InsufficientBalance'], [424242, 'Unknown']];
  for (const [c, k] of cases) assert.equal(status.strategyErrorFromCode(c), k);
  assert.equal(status.strategyErrorUserMessage(424242), 'Unknown strategy error.');
});

test('check_response', () => {
  assert.doesNotThrow(() => status.checkResponse({ code: 0, msg: 'ok', data: {} }));
  assert.doesNotThrow(() => status.checkResponse({ code: '60018', msg: 'string code is not read' }));
  assert.doesNotThrow(() => status.checkResponse({ data: 1 }));
  assert.doesNotThrow(() => status.checkResponse([1, 2]));
  assert.doesNotThrow(() => status.checkResponse({ code: 4294967296 }));      // `as i32` truncation → 0
  assert.throws(() => status.checkResponse({ code: 60018, msg: 'upgrade required' }), { message: 'BE strategy error code=60018: upgrade required' });
  assert.throws(() => status.checkResponse({ code: 60002 }), { message: 'BE strategy error code=60002: No matching order was found.' });
  assert.throws(() => status.checkResponse({ code: 60002, msg: '' }), { message: 'BE strategy error code=60002: ' });
  assert.throws(() => status.checkResponse({ code: 50114, msg: 'Invalid Authority' }),
    { message: 'BE strategy error code=50114: Invalid Authority. You are not logged in, run `wallet login` to sign into OKX Agentic Wallet.' });
  let e; try { status.checkResponse({ code: 60018, msg: 'x' }); } catch (x) { e = x; }
  assert.equal(status.isUpgradeRequired(e), true);
  assert.equal(status.isOrderAmountTooSmall(e), false);
  try { status.checkResponse({ code: 100010, msg: 'x' }); } catch (x) { e = x; }
  assert.equal(status.isOrderAmountTooSmall(e), true);
  assert.equal(status.isUpgradeRequired(new Error('API error (code=60018): upgrade required')), false);
});

test('execution event catalog', () => {
  assert.deepEqual([status.executionEventFor(3016).name, status.executionEventFor(3016).message], ['noLiquidty', 'No quote due to low liquidity']);
  assert.equal(status.executionEventFor(0).name, 'tradeSuccessed');
  assert.equal(status.executionEventFor(3023).isTerminal, true);
  assert.equal(status.executionEventFor(9999), undefined);
  for (const c of [3010, 3019, 3020, 3023]) assert.equal(status.isTerminalEvent(c), true);
  for (const c of [3015, 3017, 3018, 0, 9999, -1]) assert.equal(status.isTerminalEvent(c), false);
  assert.equal(status.executionEventFor(2013).message, 'Trade successful');
  assert.equal(status.EXECUTION_EVENT_CATALOG.length, 28);
});

// ── supported_chains.rs ──
test('ensure_strategy_chain', () => {
  for (const c of chains.SUPPORTED_STRATEGY_CHAINS) assert.doesNotThrow(() => chains.ensureStrategyChain(c.chainIndex, c.name));
  assert.throws(() => chains.ensureStrategyChain('137', 'polygon'), {
    message: 'chain "polygon" (resolved to chainIndex 137) is not supported for strategy orders. Phase 1 supports: Ethereum (1), BSC (56), X Layer (196), Solana (501), Base (8453), Arbitrum (42161)',
  });
  assert.throws(() => chains.ensureStrategyChain('10', 'optimism'));
  assert.equal(chains.isSolana('501'), true);
  assert.equal(chains.isSolana(''), false);
});

// ── trader_mode.rs ──
const sampleIntent = {
  chainId: 501, recipient: '5HVKBVReErFGgAUgcHMKc2vCRr8Q2WMZXcvKWJwsLern', fromToken: '11111111111111111111111111111111',
  toToken: '4NBTf8PfLH4oLFnwf3knv46FY9i5oXjDxffCetXRpump', fromAmountRaw: '12000000', createdAt: '2026-05-06T06:41:47.340Z',
  expiredAt: '2026-05-13T06:41:47.340Z', timestampMs: 1778654507340,
};
test('build_intent matches the phase-1 template', () => {
  assert.equal(tm.buildIntent(sampleIntent), 'You will place an order which will be verified and auto-signed by the trusted execution environment.\n'
    + '\nChain Index: 501\nStrategy Type: LimitOrderUbased\nRecipient: 5HVKBVReErFGgAUgcHMKc2vCRr8Q2WMZXcvKWJwsLern\n'
    + 'Created At: 2026-05-06T06:41:47.340Z\nExpired At: 2026-05-13T06:41:47.340Z\nFrom Token: 11111111111111111111111111111111\n'
    + 'To Token: 4NBTf8PfLH4oLFnwf3knv46FY9i5oXjDxffCetXRpump\nFrom Amount(precision adjusted): 12000000\nTimestamp: 1778654507340');
});

test('human_decimal_to_raw_integer', () => {
  const ok = [['0.01', 6, '10000'], ['1', 18, '1000000000000000000'], ['1.5', 18, '1500000000000000000'], ['100', 6, '100000000'],
    ['12', 6, '12000000'], ['0.000001', 6, '1'], ['.5', 6, '500000'], [' 5. ', 2, '500'], ['007', 0, '7']];
  for (const [a, d, want] of ok) assert.equal(tm.humanDecimalToRawInteger(a, d), want);
  assert.throws(() => tm.humanDecimalToRawInteger('0', 6), { message: 'amount must be > 0, got `0`' });
  assert.throws(() => tm.humanDecimalToRawInteger('0.000000', 6), /amount must be > 0/);
  assert.throws(() => tm.humanDecimalToRawInteger('0.0000001', 6), { message: "amount `0.0000001` has 7 fractional digit(s), more than the token's 6 decimals" });
  assert.throws(() => tm.humanDecimalToRawInteger('  ', 6), { message: 'amount is empty' });
  assert.throws(() => tm.humanDecimalToRawInteger('abc', 6), { message: 'amount must be a positive decimal number, got `abc`' });
  assert.throws(() => tm.humanDecimalToRawInteger('1.2.3', 6), { message: 'amount has multiple decimal points, got `1.2.3`' });
  assert.throws(() => tm.humanDecimalToRawInteger('-1', 6), /positive decimal number/);
  assert.throws(() => tm.humanDecimalToRawInteger('1e6', 6), /positive decimal number/);
});

test('sign_intent: base64, deterministic, Solana raw bytes vs EVM EIP-191', () => {
  const seed = Buffer.alloc(32, 5).toString('base64');
  const intent = tm.buildIntent(sampleIntent);
  const sol = tm.signIntent(intent, '501', seed);
  const evm = tm.signIntent(intent, '1', seed);
  assert.notEqual(sol, evm);
  assert.equal(tm.signIntent(intent, '501', seed), sol);
  const pub = ed25519.publicKey(Buffer.alloc(32, 5));
  assert.equal(ed25519.verify(pub, Buffer.from(intent, 'utf8'), Buffer.from(sol, 'base64')), true);
  const data = Buffer.from(intent, 'utf8');
  const hash = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${data.length}`), data]));
  assert.equal(ed25519.verify(pub, hash, Buffer.from(evm, 'base64')), true);
});

// Ed25519 is deterministic: re-signing the signMsg the upstream binary sent must give its signature.
for (const id of ['strategy-create-ok-buy', 'strategy-create-ok-sell-sol', 'strategy-create-ok-stop-loss', 'strategy-create-60018']) {
  const file = join(HERE, '..', 'parity', 'cassettes', `${id}.json`);
  test(`sign_intent reproduces upstream's recorded signature (${id})`, { skip: !existsSync(file) && 'cassette not recorded' }, () => {
    const cassette = JSON.parse(readFileSync(file, 'utf8'));
    const orders = cassette.exchanges.filter((x) => x.request.path.endsWith('/limitOrder/createOrder'));
    assert.ok(orders.length >= 1);
    for (const x of orders) {
      const body = x.request.body;
      const v = body.verifySignInfo;
      assert.equal(tm.signIntent(v.signMsg, body.chainId, SEED_B64), v.signature);
      // and the intent layout is byte-identical to build_intent's
      const f = Object.fromEntries(v.signMsg.split('\n').slice(2).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
      assert.equal(tm.buildIntent({
        chainId: Number(f['Chain Index']), recipient: f.Recipient, fromToken: f['From Token'], toToken: f['To Token'],
        fromAmountRaw: f['From Amount(precision adjusted)'], createdAt: f['Created At'], expiredAt: f['Expired At'], timestampMs: Number(f.Timestamp),
      }), v.signMsg);
      assert.equal(Number(body.expireTime) - Number(f.Timestamp), h.DEFAULT_EXPIRES_SECS * 1000);
      assert.equal(new Date(Number(f.Timestamp)).toISOString(), f['Created At']);
      assert.equal(new Date(Number(body.expireTime)).toISOString(), f['Expired At']);
    }
  });
}

// End-to-end: replay each recorded upstream create-limit run through lite's real createLimit
// handler with the clock frozen at upstream's `Timestamp`. Parity masks signMsg/signature (they
// carry the clock), so this is what proves lite builds the SAME intent (Recipient, raw From
// Amount, tokens, chain, times) and the same createOrder / registerTeeInfo bodies byte for byte.
const { unwrapEnvelope } = await import('../../skill/onchainos-lite/lib/core/http.mjs');
const { struct } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
function argvToCreateArgs(argv) {
  const a = { mevProtection: 'default', wait: false };
  const names = { '--chain-id': 'chainId', '--from-token': 'fromToken', '--to-token': 'toToken', '--amount': 'amount', '--trigger-price': 'triggerPrice', '--slippage': 'slippage', '--mev-protection': 'mevProtection', '--direction': 'direction', '--current-price': 'currentPrice' };
  for (let i = argv.indexOf('create-limit') + 1; i < argv.length; i++) {
    if (argv[i] === '--wait') { a.wait = true; continue; }
    a[names[argv[i]]] = argv[++i];
  }
  a.direction = h.parseDirectionValue(a.direction);
  return a;
}
function replayClient(exchanges) {
  let next = 0;
  const seen = [];
  const take = (method, path, payload) => {
    const i = exchanges.findIndex((x, k) => k >= next && x.request.method === method && x.request.path === path);
    assert.ok(i >= 0, `unexpected ${method} ${path}`);
    next = i + 1;
    seen.push({ method, path, payload, recorded: exchanges[i].request });
    return parse(exchanges[i].response.body);
  };
  const query = (q) => Object.fromEntries(q.filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
  return {
    seen,
    post: async (path, body) => unwrapEnvelope(take('POST', path, body)),
    postRaw: async (path, body) => take('POST', path, body),
    getRaw: async (path, q) => take('GET', path, query(q)),
    get: async (path, q) => unwrapEnvelope(take('GET', path, query(q))),
  };
}
for (const id of ['strategy-create-ok-buy', 'strategy-create-ok-chase', 'strategy-create-ok-sell-sol', 'strategy-create-ok-stop-loss',
  'strategy-create-60018', 'strategy-create-60018-100010', 'strategy-create-100010', 'strategy-create-wait']) {
  const file = join(HERE, '..', 'parity', 'cassettes', `${id}.json`);
  test(`create_limit replays upstream's recorded run byte for byte (${id})`, { skip: !existsSync(file) && 'cassette not recorded' }, async () => {
    const cassette = JSON.parse(readFileSync(file, 'utf8'));
    const order = cassette.exchanges.find((x) => x.request.path.endsWith('/limitOrder/createOrder')).request.body;
    const ts = Number(/\nTimestamp: (\d+)$/.exec(order.verifySignInfo.signMsg)[1]);
    const client = replayClient(cassette.exchanges);
    const realNow = Date.now, realWrite = process.stdout.write;
    let printed = '';
    Date.now = () => ts;
    process.stdout.write = function (s, ...rest) { if (typeof s !== 'string') return realWrite.call(this, s, ...rest); printed += s; return true; };
    let data;
    try {
      data = await h.createLimit({ api: async () => client }, argvToCreateArgs(cassette.argv));
    } finally {
      Date.now = realNow;
      process.stdout.write = realWrite;
    }
    assert.equal(client.seen.length, cassette.exchanges.length, 'same request sequence');
    for (const s of client.seen) {
      const lite = s.method === 'GET' ? s.payload : parse(stringify(s.payload));
      const up = s.method === 'GET' ? s.recorded.query : parse(JSON.stringify(s.recorded.body));
      if (s.path.endsWith('/registerTeeInfo')) {   // SD-A reads its own clock
        assert.equal(lite.expireTimestamp - lite.timestamp, up.expireTimestamp - up.timestamp);
        for (const o of [lite, up]) { delete o.timestamp; delete o.expireTimestamp; }
      }
      assert.equal(stringify(lite), stringify(up), `${s.method} ${s.path}`);
    }
    const upOut = cassette.result.stdoutText.split('\n').filter(Boolean);
    assert.equal(printed, upOut.slice(0, -1).map((l) => l + '\n').join(''), 'plain-text lines before the envelope');
    assert.equal(stringify(struct({ ok: true, data })), upOut.at(-1));
  });
}

test('SD-A sessionSig matches the upstream recording (ed25519 over the hex-decoded attest doc)', { skip: !existsSync(join(HERE, '..', 'parity', 'cassettes', 'strategy-resume-60018.json')) && 'cassette not recorded' }, () => {
  const cassette = JSON.parse(readFileSync(join(HERE, '..', 'parity', 'cassettes', 'strategy-resume-60018.json'), 'utf8'));
  const reg = cassette.exchanges.find((x) => x.request.path.endsWith('/registerTeeInfo')).request.body;
  assert.equal(ed25519SignHex(reg.attestDocHex, SEED_B64), reg.sessionSig);
  assert.equal(reg.expireTimestamp - reg.timestamp, h.ACTIVATE_DEFAULT_TTL_MS);
});

test('retry_on_upgrade', async () => {
  const upgrade = () => { try { status.checkResponse({ code: 60018, msg: 'u' }); } catch (e) { return e; } };
  const other = () => { try { status.checkResponse({ code: 60002, msg: 'n' }); } catch (e) { return e; } };
  let ops = 0, acts = 0;
  assert.equal(await tm.retryOnUpgrade(async () => { ops++; return 42; }, async () => { acts++; }), 42);
  assert.deepEqual([ops, acts], [1, 0]);
  ops = 0;
  assert.equal(await tm.retryOnUpgrade(async () => { if (ops++ === 0) throw upgrade(); return 99; }, async () => { acts++; }), 99);
  assert.deepEqual([ops, acts], [2, 1]);
  ops = 0; acts = 0;
  await assert.rejects(tm.retryOnUpgrade(async () => { ops++; throw other(); }, async () => { acts++; }), /code=60002/);
  assert.deepEqual([ops, acts], [1, 0]);
  ops = 0;
  await assert.rejects(tm.retryOnUpgrade(async () => { ops++; throw upgrade(); }, async () => { throw new Error('attest server unreachable'); }), /attest server unreachable/);
  assert.equal(ops, 1);
});

// ── handlers.rs ──
test('parse_direction_value / mev / derive_strategy_type', () => {
  assert.equal(h.parseDirectionValue('buy'), 0);
  assert.equal(h.parseDirectionValue('BUY'), 0);
  assert.equal(h.parseDirectionValue('Sell'), 1);
  assert.throws(() => h.parseDirectionValue('HODL'), { message: 'unknown direction `hodl` — expected `buy` or `sell`' });
  assert.throws(() => h.parseDirectionValue('all'));
  assert.throws(() => h.parseDirectionValue(''));
  assert.deepEqual(['on', 'off', 'default'].map(h.mevChoiceToOptBool), [true, false, null]);
  assert.equal(h.deriveStrategyType(0, 0.10, 0.15), 2);
  assert.equal(h.deriveStrategyType(0, 0.20, 0.15), 5);
  assert.equal(h.deriveStrategyType(0, 0.15, 0.15), 5);
  assert.equal(h.deriveStrategyType(1, 0.20, 0.15), 3);
  assert.equal(h.deriveStrategyType(1, 0.10, 0.15), 4);
  assert.equal(h.deriveStrategyType(1, 0.15, 0.15), 4);
  assert.throws(() => h.deriveStrategyType(-1, 0.1, 0.15), /unsupported direction integer -1/);
});

test('build_default_preset / percent_to_decimal', () => {
  assert.equal(stringify(h.buildDefaultPreset('15', null, 0)),
    '{"buyPreset":{"dynamicMaxSlippageValue":null,"limitOrderFeeLevel":2,"routerModeType":1,"slippageLevel":4,"slippageType":2,"slippageValue":"0.15"},"presetType":1}');
  assert.equal(h.buildDefaultPreset('25', null, 0).buyPreset.slippageValue, '0.25');
  assert.equal(h.buildDefaultPreset('15', true, 0).buyPreset.routerModeType, 2);
  assert.equal(h.buildDefaultPreset('15', false, 0).buyPreset.routerModeType, 3);
  const sell = h.buildDefaultPreset('15', null, 1);
  assert.equal(sell.buyPreset, undefined);
  assert.equal(sell.sellPreset.slippageValue, '0.15');
  assert.equal(h.buildDefaultPreset('15', null, -1).buyPreset.slippageValue, '0.15');
  assert.equal(h.percentToDecimal('nope'), 'nope');
  assert.equal(h.percentToDecimal('20%'), '0.2');
  assert.equal(h.percentToDecimal('15%'), '0.15');
  assert.equal(h.percentToDecimal(' 25 % '), '0.25');
  assert.equal(h.percentToDecimal('0.5'), '0.005');
  assert.equal(h.percentToDecimal('0.0001'), '0.000001');
  assert.equal(h.percentToDecimal('100%%'), '1');
});

test('build_below_minimum / format_min_from_amount', () => {
  assert.equal(stringify(h.buildBelowMinimum(0.1, 'USDC', 6)), '{"belowMinimum":true,"fromSymbol":"USDC","minFromAmount":"10"}');
  assert.equal(h.formatMinFromAmount(1.0, 6), '1');
  assert.equal(h.formatMinFromAmount(0.3, 18), '3.33333334');
  assert.equal(h.formatMinFromAmount(60000.0, 8), '0.00001667');
  assert.equal(h.formatMinFromAmount(1e-9, 6), '1000000000');
  assert.equal(h.formatMinFromAmount(0.0, 6), '0');
  assert.equal(h.formatMinFromAmount(NaN, 6), '0');
  assert.equal(h.formatMinFromAmount(3, 0), '1');
  assert.equal(h.formatMinFromAmount(2500.12, 18), '0.00039999');
});

test('cancel request building + --all/--wait guard', () => {
  assert.deepEqual(h.buildCancelRequest('acc-1', { all: true }), { accountId: 'acc-1', orderIds: undefined, cancelAll: true });
  assert.deepEqual(h.buildCancelRequest('acc-1', { orderId: '17296046425729984' }).orderIds, ['17296046425729984']);
  assert.deepEqual(h.buildCancelRequest('acc-1', { orderId: ' 5 ' }).orderIds, [' 5 ']);
  assert.deepEqual(h.buildCancelRequest('acc-1', { orderIds: '17296046425729984, 17296046425729985 ,,17296046425729986 ' }).orderIds,
    ['17296046425729984', '17296046425729985', '17296046425729986']);
  assert.throws(() => h.buildCancelRequest('acc-1', { orderId: 'ord-1' }), { message: '--order-id must be a numeric order id, got `ord-1`' });
  assert.throws(() => h.buildCancelRequest('acc-1', { orderIds: '1,not-a-number' }), { message: '--order-ids must be a numeric order id, got `not-a-number`' });
  assert.throws(() => h.buildCancelRequest('acc-1', {}), { message: 'must pass exactly one of --order-id, --order-ids, or --all' });
  assert.throws(() => h.buildCancelRequest('acc-1', { orderIds: ',, ,' }), { message: '--order-ids parsed into an empty list' });
  let e; try { h.rejectAllWithWait({ all: true, wait: true }); } catch (x) { e = x; }
  assert.ok(e instanceof CodedError);
  assert.deepEqual([e.code, e.field, e.message], ['invalid_input', 'wait', 'cancel --all combined with --wait is not supported; use --order-id or --order-ids with --wait, or omit --wait for bulk cancel']);
  assert.doesNotThrow(() => h.rejectAllWithWait({ all: true, wait: false }));
  assert.doesNotThrow(() => h.rejectAllWithWait({ orderId: '1', wait: true }));
});

test('list helpers', () => {
  assert.deepEqual(h.parseStatusFilter('active, 4, suspended,1'), [3, 4, 4, 1]);
  assert.equal(h.parseStatusFilter(undefined), null);
  assert.equal(h.parseStatusFilter(''), null);
  assert.equal(h.parseStatusFilter(' , ,'), null);
  assert.deepEqual(h.parseStatusFilter('garbage,active'), [3]);
  assert.deepEqual(h.parseStatusFilter('+3,-7,2147483648,trading,PROCESSING'), [3, -7, 0]);
  assert.deepEqual(h.csvToStrings(undefined), []);
  assert.deepEqual(h.csvToStrings(' ,, '), []);
  assert.deepEqual(h.csvToStrings('a, b ,c '), ['a', 'b', 'c']);
  assert.equal(h.stringToStatus('active'), 3);
  assert.equal(h.stringToStatus('ACTIVE'), 3);
  assert.equal(h.stringToStatus('foo'), undefined);
  assert.equal(h.stringToStatus('speeding-up'), undefined);
  assert.deepEqual(h.defaultNonTerminalStatusList(), [-3, 0, 2, 3, 4]);
  assert.deepEqual(h.collectWalletAddresses({ evmAddress: '0xa', solAddress: '' }), ['0xa']);
});

test('enrich_execution_history', () => {
  const order = { executionHistoryList: [{ code: 3016, txHash: null }, { code: 0, txHash: '0xabc' }, { code: 9999, msg: 'raw be string' }, { code: '3015' }, 5] };
  h.enrichExecutionHistory(order);
  const [a, b, c, d] = order.executionHistoryList;
  assert.deepEqual(a, { code: 3016, txHash: null, name: 'noLiquidty', message: 'No quote due to low liquidity', terminal: false });
  assert.equal(b.name, 'tradeSuccessed');
  assert.deepEqual(c, { code: 9999, msg: 'raw be string' });
  assert.deepEqual(d, { code: '3015' });
  const o2 = { executionHistoryList: null };
  h.enrichExecutionHistory(o2);
  assert.equal(o2.executionHistoryList, null);
  const o3 = { executionHistoryList: [{ code: 3019 }, { code: 3023 }, { code: 3015 }] };
  h.enrichExecutionHistory(o3);
  assert.deepEqual(o3.executionHistoryList.map((x) => x.terminal), [true, true, false]);
});

test('--wait merge / payload / settled', () => {
  for (const s of [1, -2, -1, -7]) assert.equal(h.statusIsSettled(s), true);
  for (const s of [0, 3, 2, 4, -3, 999]) assert.equal(h.statusIsSettled(s), false);
  const requeried = types.orderListRespFromValue({
    orderId: '17296046425729984', status: 1, transactionInfo: { txHash: '0xabc' }, executionHistoryList: [{ code: 0 }],
    fromToken: { tokenSymbol: 'USDC' }, toToken: { tokenSymbol: 'PEPE' }, orderStatusUpdateTime: '2026-07-23T00:00:00Z',
  });
  const merged = h.mergeTerminalFields({ orderId: '17296046425729984', status: 2, statusLabel: 'creating', estimatedWaitTime: 12, eventCursor: 'cur-1' }, requeried);
  assert.equal(stringify(merged), '{"estimatedWaitTime":12,"eventCursor":"cur-1","executionHistoryList":[{"code":0}],"fromToken":{"tokenSymbol":"USDC"},"orderId":"17296046425729984","orderStatusUpdateTime":"2026-07-23T00:00:00Z","settled":true,"status":1,"statusLabel":"completed","toToken":{"tokenSymbol":"PEPE"},"transactionInfo":{"txHash":"0xabc"}}');
  const active = types.orderListRespFromValue({ orderId: '123', status: 3, transactionInfo: { txHash: '0xabc' }, fromToken: { tokenSymbol: 'USDC' } });
  assert.equal(stringify(h.mergeTerminalFields({ orderId: '123', status: 2, statusLabel: 'creating' }, active)), '{"orderId":"123","settled":false,"status":3,"statusLabel":"active"}');
  assert.deepEqual(h.buildWaitPayload([{ orderId: '1', settled: true }, { orderId: '2', settled: false }]).settled, false);
  assert.deepEqual(h.buildWaitPayload([{ settled: true }, { settled: true }]).settled, true);
  assert.deepEqual(h.buildWaitPayload([]), { settled: true, orders: [] });
});

// ── types.rs + serde ──
test('OrderListResp / ListOrdersResp / CancelResp decoding', () => {
  const o = types.orderListRespFromValue(parse('{"orderId":"ord-1","status":2,"estimatedWaitTime":12}'));
  assert.deepEqual([o.orderId, o.status, o.estimatedWaitTime, o.transactionInfo], ['ord-1', 2, 12, null]);
  const l = types.listOrdersRespFromValue(parse('{"dataList":[{"orderId":"a","status":3},{"orderId":"b","status":4}],"cursor":"abc","hasNext":true}'));
  assert.equal(l.dataList.length, 2);
  assert.equal(l.cursor, 'abc');
  assert.deepEqual(types.cancelRespFromValue({}), { updateNum: 0, estimatedWaitTime: null });
  assert.deepEqual(types.cancelRespFromValue([3, 7]), { updateNum: 3, estimatedWaitTime: 7 });
  assert.throws(() => types.cancelRespFromValue([1, 2, 3]), { message: 'invalid length 3, expected fewer elements in array' });
  assert.throws(() => types.orderListRespFromValue({ status: 3 }), { message: 'missing field `orderId`' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 'x' }), { message: 'missing field `status`' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 'x', status: '3' }), { message: 'invalid type: string "3", expected i32' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 'x', status: 3000000000 }), { message: 'invalid value: integer `3000000000`, expected i32' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 'x', status: new F64('3') }), { message: 'invalid type: floating point `3.0`, expected i32' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 'x', status: 1, chainId: 1 }), { message: 'invalid type: integer `1`, expected a string' });
  assert.throws(() => types.orderListRespFromValue({ orderId: 1, status: 'x' }), { message: 'invalid type: integer `1`, expected a string' });
  assert.throws(() => types.orderListRespFromValue(null), { message: 'invalid type: null, expected struct OrderListResp' });
  assert.throws(() => types.orderListRespFromValue([]), { message: 'invalid type: sequence, expected struct OrderListResp' });
  assert.throws(() => types.listOrdersRespFromValue({ cursor: 7, dataList: 'x' }), { message: 'invalid type: integer `7`, expected a string' });
  assert.throws(() => types.reactivateRespFromValue({ successIds: [101] }), { message: 'invalid type: integer `101`, expected a string' });
});

test('OrderListResp re-serialisation keeps all 21 modelled keys plus extras', () => {
  const o = types.orderListRespFromValue(parse('{"orderId":"a","status":3,"canResume":null,"slippage":"0.15","priceImpact":0.0012}'));
  const v = types.orderListRespToValue(o);
  assert.equal(Object.keys(v).length, 23);
  assert.equal(stringify(v), '{"canResume":null,"chainId":null,"chainName":null,"createTime":null,"estimatedWaitTime":null,"eventCursor":null,"exchangeDirection":null,"executionHistoryList":null,"expireTime":null,"fromToken":null,"orderId":"a","orderStatusUpdateTime":null,"orderType":null,"priceImpact":0.0012,"slippage":"0.15","status":3,"strategyId":null,"strategyMode":null,"strategyType":null,"toToken":null,"transactionInfo":null,"triggerInfo":null,"userWalletAddress":null}');
  const printed = h.printOrders([o], 'c');
  assert.equal(printed.list[0].statusLabel, 'active');
  assert.equal(printed.nextCursor, 'c');
  assert.equal(h.printOrders([], null).nextCursor, null);
});

test('create_order request serialises like types.rs', () => {
  const req = types.createOrderReq({
    chainId: '1', userWalletAddress: '0x', rule: types.rule({ fromTokenAddress: '0xA', toTokenAddress: '0xB', fromAmount: '1' }), preset: {},
    strategyType: 2, strategyDirection: 0,
    verifySignInfo: types.verifySignInfo({ accountId: 'acc-1', address: '0x', chainId: 1, signMsg: '{"x":1}', signature: 'sig', sessionCert: 'cert', teeId: 'tee-1' }),
  });
  assert.equal(stringify(req), '{"chainId":"1","preset":{},"rule":{"fromAmount":"1","fromTokenAddress":"0xA","toTokenAddress":"0xB"},"strategyDirection":0,"strategyType":2,"userWalletAddress":"0x","verifySignInfo":{"accountId":"acc-1","address":"0x","chainId":1,"sessionCert":"cert","signMsg":"{\\"x\\":1}","signature":"sig","teeId":"tee-1"}}');
  assert.equal(stringify(types.cancelReq({ accountId: 'a', orderIds: ['1'], cancelAll: false })), '{"accountId":"a","cancelAll":false,"orderIds":["1"]}');
  assert.equal(stringify(types.listOrdersReq({ accountId: 'a', walletAddressList: [], orderStatusList: [4], limit: 100 })), '{"accountId":"a","limit":100,"orderStatusList":[4],"walletAddressList":[]}');
});

test('api data_field', () => {
  assert.deepEqual(api.dataField({ code: 0, data: { a: 1 } }), { a: 1 });
  assert.equal(api.dataField({ code: 0 }), null);
  assert.throws(() => api.dataField([1, { b: 2, a: 1 }]), { message: 'strategy endpoint returned a non-object body — got: [1,{"a":1,"b":2}]' });
});

test('session::load reads the parity wallet home', () => {
  const s = session.load();
  assert.equal(s.accountId, 'parity-account-0001');
  assert.equal(s.saTeeId, 'parity-sa-tee-0001');
  assert.equal(s.seedB64, SEED_B64);
  assert.equal(s.evmAddress, '0xd825f780e3cb88b383907ff427495d1dca352d44');
  assert.equal(s.solAddress, 'GU61DfyoDNiH45fNSwGbQgPYU4iiiBcUyycV7us9hH4R');
  assert.equal(s.walletAddressFor('501'), s.solAddress);
  assert.equal(s.walletAddressFor('solana'), s.solAddress);
  assert.equal(s.walletAddressFor('8453'), s.evmAddress);
});

// create_limit guards that fire before any HTTP (verified against the upstream binary with a
// pre-upgrade session.json and a wallet without a Solana address).
async function withHomeEdit(file, edit, fn) {
  const path = join(HOME, file);
  const orig = readFileSync(path, 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, JSON.stringify(edit(JSON.parse(orig)), null, 2));
  try { return await fn(); } finally { writeFileSync(path, orig); }
}
const noHttp = { post: () => assert.fail('no HTTP expected'), postRaw: () => assert.fail('no HTTP expected'), getRaw: () => assert.fail('no HTTP expected') };
const createArgs = (chainId, fromToken, toToken, dir) => ({ chainId, fromToken, toToken, amount: '1', triggerPrice: '1', direction: h.parseDirectionValue(dir), mevProtection: 'default', wait: false });

test('create_limit: pre-upgrade session.json without saTeeId → re-login error', async () => {
  await withHomeEdit('session.json', (s) => { delete s.saTeeId; return s; }, async () => {
    await assert.rejects(h.createLimit({ api: async () => noHttp }, createArgs('1', 'usdc', 'eth', 'buy')),
      { message: 'please re-login with `onchainos wallet login` before placing strategy orders' });
  });
});

test('create_limit: no address for the resolved chain', async () => {
  await withHomeEdit('wallets.json', (w) => {
    for (const a of Object.values(w.accountsMap)) a.addressList = a.addressList.filter((x) => x.chainIndex !== '501');
    return w;
  }, async () => {
    await assert.rejects(h.createLimit({ api: async () => noHttp }, createArgs('solana', 'sol', 'usdc', 'sell')),
      { message: 'no wallet address for chain `501` — login with the right chain enabled first' });
  });
});

// commands/strategy/_clap.mjs — clap validator.rs conflict rendering (every partner listed).
test('cancel conflicts_with_all: clap lists every conflicting partner', async () => {
  const { validateConflicts } = await import('../../skill/onchainos-lite/lib/commands/strategy/_clap.mjs');
  const W = { orderId: ['orderIds', 'all'], orderIds: ['orderId', 'all'], all: ['orderId', 'orderIds'] };
  const err = (argv) => { try { validateConflicts({ path: 'strategy cancel', argv }, W); return null; } catch (e) { return e.message; } };
  const tail = "\n\nFor more information, try '--help'.\n";
  assert.equal(err(['strategy', 'cancel', '--wait', '--order-ids', '1', '--all', '--order-id', '2']),
    "error: the argument '--order-ids <ORDER_IDS>' cannot be used with:\n  --all\n  --order-id <ORDER_ID>\n\nUsage: onchainos strategy cancel --wait --order-ids <ORDER_IDS>" + tail);
  assert.equal(err(['strategy', 'cancel', '--all', '--chain', 'eth', '--order-id', '1', '--order-ids', '2']),
    "error: the argument '--all' cannot be used with:\n  --order-id <ORDER_ID>\n  --order-ids <ORDER_IDS>\n\nUsage: onchainos strategy cancel --all --chain <CHAIN>" + tail);
  assert.equal(err(['strategy', 'cancel', '--order-ids', '1', '--order-id', '2']),
    "error: the argument '--order-ids <ORDER_IDS>' cannot be used with '--order-id <ORDER_ID>'\n\nUsage: onchainos strategy cancel --order-ids <ORDER_IDS>" + tail);
  assert.equal(err(['strategy', 'cancel', '--order-id', '1', '--wait']), null);
});
