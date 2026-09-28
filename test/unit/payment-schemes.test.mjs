// Unit tests for the payment-schemes unit: lib/payment/{a2a-pay,a2mcp,session,session-state,subscription}.mjs.
// Oracles: upstream Rust unit tests (commands/payment/{a2a_pay,a2mcp,a2mcp_tests,session_state,subscription}.rs)
// and the derived vectors of spec/extract/g09b-payment-schemes.md / g09a-payment-core.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-payment-schemes-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;

const a2a = await import('../../skill/onchainos-lite/lib/payment/a2a-pay.mjs');
const ss = await import('../../skill/onchainos-lite/lib/payment/session-state.mjs');
const session = await import('../../skill/onchainos-lite/lib/payment/session.mjs');
const sub = await import('../../skill/onchainos-lite/lib/payment/subscription.mjs');
const m = await import('../../skill/onchainos-lite/lib/payment/a2mcp.mjs');
const { SubscriptionCache } = await import('../../skill/onchainos-lite/lib/payment/subscription/cache.mjs');
const { keccak256 } = await import('../../skill/onchainos-lite/lib/crypto/keccak.mjs');
const { stringify, F64 } = await import('../../skill/onchainos-lite/lib/core/json.mjs');

const throwsMsg = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });

// ── a2a_pay.rs ────────────────────────────────────────────────────────
test('a2a: terminal status classifier', () => {
  for (const s of ['completed', 'failed', 'expired', 'cancelled']) assert.equal(a2a.isTerminalStatus(s), true, s);
  for (const s of ['pending', 'settling', 'unknown', '']) assert.equal(a2a.isTerminalStatus(s), false, s);
});

test('a2a: validates EVM address (no checksum)', () => {
  assert.ok(a2a.isValidEvmAddress('0x1d4eAbb31AfEd5Aa70E1cCEEf73DEbF4dB164aB7'));
  assert.ok(!a2a.isValidEvmAddress('0x123'));
  assert.ok(!a2a.isValidEvmAddress('1d4eAbb31AfEd5Aa70E1cCEEf73DEbF4dB164aB7'));
  assert.ok(!a2a.isValidEvmAddress('0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'));
  throwsMsg(() => a2a.requireEvmAddress('0x123', 'recipient'), /^--recipient is not a valid EVM address: 0x123$/);
});

test('a2a: validate_positive_decimal_amount', () => {
  for (const ok of ['50', '0.01', '10.5', '.5', '1.']) a2a.validatePositiveDecimalAmount(ok);
  throwsMsg(() => a2a.validatePositiveDecimalAmount(''), /^amount must not be empty$/);
  throwsMsg(() => a2a.validatePositiveDecimalAmount('.'), /^amount must not be empty$/);
  throwsMsg(() => a2a.validatePositiveDecimalAmount('0'), /^amount must be greater than zero$/);
  throwsMsg(() => a2a.validatePositiveDecimalAmount('0.0'), /^amount must be greater than zero$/);
  for (const bad of ['-1', '+1', '1e2', '1.2.3', ' 1', 'abc', '١']) {
    throwsMsg(() => a2a.validatePositiveDecimalAmount(bad), /^amount must be a non-negative decimal number, got: /);
  }
});

test('a2a: parse_bytes32_hex', () => {
  const s = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const b = a2a.parseBytes32Hex(s, 'test');
  assert.equal(b[31], 1);
  assert.deepEqual(a2a.parseBytes32Hex(s.slice(2), 'test'), b);
  throwsMsg(() => a2a.parseBytes32Hex('0x01', 'test'), /^test must be 32 bytes \(64 hex chars\), got 2$/);
  throwsMsg(() => a2a.parseBytes32Hex('zz'.repeat(32), 'salt'), /^salt is not valid hex: Invalid character 'z' at position 0$/);
});

test('a2a: escrow nonce derived vector + field sensitivity', () => {
  const f = {
    from: '0x6666666666666666666666666666666666666666', provider: '0x1111111111111111111111111111111111111111',
    receiver: '0x2222222222222222222222222222222222222222', arbitrator: '0x3333333333333333333333333333333333333333',
    currency: '0x4444444444444444444444444444444444444444', amount: 50000000n, submitWindow: 86400, disputeWindow: 86400,
    arbitrationWindow: 172800, terminationWindow: 86400, hook: '0x5555555555555555555555555555555555555555',
    hookDataHash: keccak256(Buffer.from('deadbeef', 'hex')), salt: a2a.parseBytes32Hex('0x' + '0'.repeat(63) + '7', 'salt'),
    chainId: 196, escrowAddress: '0x7777777777777777777777777777777777777777',
  };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const n1 = hex(a2a.computeEscrowNonce(f));
  assert.equal(n1, '0x399f15b551085a8865b6678094cedac4decad70073a931b153721b25e9f87165');
  assert.equal(hex(a2a.computeEscrowNonce(f)), n1);
  assert.notEqual(hex(a2a.computeEscrowNonce({ ...f, amount: 50000001n })), n1);
  assert.notEqual(hex(a2a.computeEscrowNonce({ ...f, salt: a2a.parseBytes32Hex('0x' + '0'.repeat(63) + '8', 'salt') })), n1);
});

test('a2a: create params + response parsing', () => {
  throwsMsg(() => a2a.chargeParamsTryFrom({ amount: '1', symbol: 'USDT' }), /^--recipient is required for --type charge$/);
  assert.equal(stringify(a2a.parseCreatePaymentResponse({ paymentId: 'p', deliveries: { url: 'u', a: 1 } })), '{"payment_id":"p","deliveries":{"a":1,"url":"u"}}');
  assert.equal(stringify(a2a.parseCreatePaymentResponse({ paymentId: 'p' })), '{"payment_id":"p","deliveries":null}');
  throwsMsg(() => a2a.parseCreatePaymentResponse([]), /^missing 'paymentId' in \/payment\/create response$/);
});

test('a2a: funding input shape', () => {
  assert.deepEqual(a2a.a2aFundingInput('0xc', 'USDT', '10', '0.08504764'), { asset: 'USDT', tokenAddress: '0xc', required: '10', balance: '0.08504764', operation: 'a2a_payment' });
  assert.equal(a2a.a2aFundingInput('0xc', 'USDT', '10', null).balance, undefined);
});

// ── session_state.rs ──────────────────────────────────────────────────
test('session-state: sanitize strips path separators', () => {
  assert.equal(ss.sanitize('../../etc/passwd'), 'etcpasswd');
  assert.equal(ss.sanitize('0xDEADbeef_01-ff'), '0xDEADbeef_01-ff');
  assert.equal(ss.sanitize('a.b/c\\dé'), 'abcd');
});

test('session-state: write / read round trip and cleanup', () => {
  new ss.ChannelState({ channel_id: '0xabc123', owner_wallet: 'acc-1', deposit: '100000', cumulative: '40000', created_at: 1000, updated_at: 1000 }).write();
  const body = readFileSync(join(HOME, 'sessions', '0xabc123.json'), 'utf8');
  assert.equal(body, '{\n  "channel_id": "0xabc123",\n  "owner_wallet": "acc-1",\n  "deposit": "100000",\n  "cumulative": "40000",\n  "created_at": 1000,\n  "updated_at": 1000\n}');
  const got = ss.read('0xabc123');
  assert.equal(got.deposit, '100000');
  assert.equal(got.cumulative, '40000');
  ss.cleanup('0xabc123');
  assert.equal(ss.read('0xabc123'), null);
  assert.equal(ss.read('0xdoes-not-exist'), null);
});

test('session-state: strict decode (missing / mistyped fields → None)', () => {
  const good = { channel_id: 'c', owner_wallet: 'o', deposit: '1', cumulative: '0', created_at: 1, updated_at: 2 };
  assert.ok(ss.decodeChannelState(good));
  assert.equal(ss.decodeChannelState({ ...good, created_at: -1 }), null);
  assert.equal(ss.decodeChannelState({ ...good, deposit: 1 }), null);
  const { updated_at: _u, ...missing } = good;
  assert.equal(ss.decodeChannelState(missing), null);
  assert.ok(ss.decodeChannelState(['c', 'o', '1', '0', 1, 2]));
  assert.equal(ss.decodeChannelState(['c', 'o', '1', '0', 1]), null);
  mkdirSync(join(HOME, 'sessions'), { recursive: true });
  writeFileSync(join(HOME, 'sessions', 'corrupt.json'), '{"channel_id":');
  assert.equal(ss.read('corrupt'), null);
});

test('session: voucher reuse (spec oracle, no prior state, no network)', async () => {
  const out = await session.cmdMppSessionVoucher('Payment id="1", realm="r", method="evm", intent="session", request="e30"', '0xabc', '100', null, null, null, '0x' + '1'.repeat(130));
  assert.equal(stringify(out), '{"action":"voucher","authorization_header":"Payment eyJjaGFsbGVuZ2UiOnsiZXhwaXJlcyI6bnVsbCwiaWQiOiIxIiwiaW50ZW50Ijoic2Vzc2lvbiIsIm1ldGhvZCI6ImV2bSIsInJlYWxtIjoiciIsInJlcXVlc3QiOiJlMzAifSwicGF5bG9hZCI6eyJhY3Rpb24iOiJ2b3VjaGVyIiwiY2hhbm5lbElkIjoiMHhhYmMiLCJjdW11bGF0aXZlQW1vdW50IjoiMTAwIiwic2lnbmF0dXJlIjoiMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIn19","channel_id":"0xabc","cumulative_amount":"100","mode":"reuse","needsTopUp":false,"protocol":"mpp","sessionSnapshot":{"channelId":"0xabc","cumulative":"100","deposit":null},"signature":"0x' + '1'.repeat(130) + '","strategy":"reuse"}');
  assert.ok(existsSync(join(HOME, 'sessions')));
});

test('session: voucher reuse advances persisted cumulative only when viable', async () => {
  const ch = '0x' + 'ab'.repeat(32);
  const reuse = '0x' + '2'.repeat(130);
  const challenge = 'Payment id="1", method="evm", intent="session", request="e30"';
  new ss.ChannelState({ channel_id: ch, owner_wallet: 'w', deposit: '1000', cumulative: '100', created_at: 1, updated_at: 1 }).write();
  let out = await session.cmdMppSessionVoucher(challenge, ch, '150', null, null, null, reuse);
  assert.equal(out.strategy, 'reuse');
  assert.equal(out.cumulative_amount, '150');
  assert.equal(ss.read(ch).cumulative, '150');
  out = await session.cmdMppSessionVoucher(challenge, ch, '5000', null, null, null, reuse);   // over deposit: not advanced
  assert.equal(out.strategy, 'topup');
  assert.equal(out.needsTopUp, true);
  assert.equal(out.recovery, 'amount_exceeds_deposit');
  assert.equal(ss.read(ch).cumulative, '150');
  out = await session.cmdMppSessionVoucher(challenge, ch, '150', null, null, null, reuse);    // unit 0
  assert.equal(out.strategy, 'sign');
  assert.equal(out.recovery, 'delta_too_small');
  await assert.rejects(session.cmdMppSessionVoucher(challenge, ch, '1', null, null, null, '0x12'), /--reuse-signature must be a 0x-prefixed 65-byte hex string/);
  await assert.rejects(session.cmdMppSessionVoucher(challenge, ch, '1', null, null, null, null), /^Error: --escrow is required when not using --reuse-signature$/);
  await assert.rejects(session.cmdMppSessionVoucher(challenge, ch, '1', '0xe', null, null, null), /^Error: --chain-id is required when not using --reuse-signature$/);
  ss.cleanup(ch);
});

// ── subscription.rs ───────────────────────────────────────────────────
test('subscription: select_subscription_entry', () => {
  const arr = [{ scheme: 'exact', network: 'eip155:196' }, { scheme: 'period', network: 'eip155:196', asset: '0xtok' }];
  assert.equal(sub.selectSubscriptionEntry(arr).asset, '0xtok');
  assert.equal(sub.selectSubscriptionEntry({ scheme: 'period', asset: '0xtok' }).asset, '0xtok');
  assert.equal(sub.selectSubscriptionEntry({ scheme: 'exact' }).scheme, 'exact');
  throwsMsg(() => sub.selectSubscriptionEntry([{ scheme: 'exact' }]), /^no period entry in accepts\[\]$/);
  throwsMsg(() => sub.selectSubscriptionEntry([{ scheme: 'Period' }]), /^no period entry/);
});

const samplePayload = () => ({
  terms: {
    payer: '0xp', merchant: '0xm', facilitator: '0xf', token: '0xt', amountPerPeriod: '5000000', periodSec: 2592000, maxPeriods: 12, startAt: 0,
    initialChargePeriods: 1, initialChargeAmount: '5000000', termsDeadline: 1750000000, permitHash: '0xph', salt: '0xsalt', planId: 'pro_monthly',
    planTier: 2, changeFromSubId: '0x' + '0'.repeat(64), changeEffectiveAt: 0, periodMode: 0,
  },
  termsSignature: '0xtsig',
  permit: { details: { token: '0xt', amount: '60000000', expiration: 1782000000, nonce: 7 }, spender: '0xsub', sigDeadline: '1750000000' },
  permitSignature: '0xpsig',
});

test('subscription: header uses permitSingle payload keys', () => {
  const [name, value] = sub.buildSubscriptionPaymentHeader({ scheme: 'period' }, 'https://api.x.com/d', samplePayload());
  assert.equal(name, 'PAYMENT-SIGNATURE');
  const text = Buffer.from(value, 'base64').toString('utf8');
  const body = JSON.parse(text);
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.resource, { mimeType: 'application/json', url: 'https://api.x.com/d' });
  assert.equal(body.payload.permitSingleSignature, '0xpsig');
  assert.equal(body.payload.termsSignature, '0xtsig');
  assert.equal(body.payload.permitSingle.details.nonce, 7);
  assert.equal(body.payload.terms.planTier, 2);
  assert.ok(text.startsWith('{"accepted":{"scheme":"period"},"payload":{"permitSingle":{"details":{"amount":"60000000","expiration":1782000000,"nonce":7,"token":"0xt"},"sigDeadline":"1750000000","spender":"0xsub"}'));
  const [, noUrl] = sub.buildSubscriptionPaymentHeader({}, null, samplePayload());
  assert.equal(JSON.parse(Buffer.from(noUrl, 'base64').toString()).resource.url, '');
});

test('subscription: cache_subscription put / upgrade / downgrade', () => {
  const p = samplePayload();
  sub.cacheSubscription('https://API.x.com/d', p, '0xaaa', 'pro');
  let c = SubscriptionCache.load();
  assert.equal(c.resolve('https://api.x.com/other').subId, '0xaaa');
  const up = samplePayload();
  up.terms.changeFromSubId = '0xaaa';
  up.terms.changeEffectiveAt = 1;
  sub.cacheSubscription('https://other.x.com/', up, '0xbbb', 'max');
  c = SubscriptionCache.load();
  assert.equal(c.get('api.x.com').state, 'changed');
  assert.equal(c.get('api.x.com').changedToSubId, '0xbbb');
  assert.equal(c.get('other.x.com').state, 'active');
  const down = samplePayload();
  down.terms.changeFromSubId = '0xbbb';
  down.terms.changeEffectiveAt = 2;
  sub.cacheSubscription('https://third.x.com/', down, '0xccc', 'basic');
  c = SubscriptionCache.load();
  assert.equal(c.get('third.x.com'), null);
  assert.equal(c.get('other.x.com').subId, '0xbbb');
});

// ── a2mcp.rs (+ a2mcp_tests.rs) ───────────────────────────────────────
const RAW = {
  scheme: 'exact', network: 'eip155:196', asset: '0x1111111111111111111111111111111111111111', amount: '1000000',
  payTo: '0x2222222222222222222222222222222222222222', extra: { name: 'USDC', version: '2' },
};
const quoteCandidate = (acceptsIndex, over = {}) => ({
  scheme: 'exact', acceptsIndex, chainId: '196', chainName: 'X Layer', isMainnet: true, tokenSymbol: 'USDC', amount: '1000000',
  amountHuman: '1', decimals: 6, hasBalance: true, balanceStatus: 'sufficient', availableAmount: '2', requiredAmount: '1', shortfall: '0',
  depositAddress: '0x3333333333333333333333333333333333333333', recommended: null, ...over,
});
const testCandidate = (id, raw, symbol, decimals, authorizationType, balanceStatus) => new m.A2mcpPreparedCandidate({
  candidateId: id, rawAccept: raw, symbol, network: raw.network ?? '', chainId: '196', chainName: 'X Layer', isMainnet: true,
  scheme: raw.scheme ?? '', amountAtomic: raw.amount, amountDisplay: raw.amount, decimals, authorizationType, balanceStatus,
  availableAmount: raw.amount, requiredAmount: raw.amount, shortfall: '0', depositAddress: '',
});
const frozen = () => m.A2mcpFrozenRequestV1.new('https://merchant.example/pay', 'POST', { count: 2, enabled: true }, [], { url: 'https://merchant.example/pay' });
const selected = (status = 'sufficient') => m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('candidate_0', structuredClone(RAW), 'USDC', 6, 'eip3009', status));
const createInput = (over = {}) => ({
  probeId: 'probe_1', ownerAccountId: 'account_1', payerAddress: '0x3333333333333333333333333333333333333333', frozenRequest: frozen(),
  selectedAccept: selected(), createdAt: 1000, expiresAt: 1200, userConfirmed: true, ...over,
});

test('a2mcp: payment id for probe (derived vector) + id validation', () => {
  assert.equal(m.paymentIdForProbe('probe_1', 'account_1'), 'pay_645ff957de035f18b7bb9351');
  m.validatePaymentId('pay_ok-1');
  throwsMsg(() => m.validatePaymentId('bad id!'), /^a2mcp_invalid_payment_intent: invalid payment id$/);
  throwsMsg(() => m.validatePaymentId(''), /invalid payment id/);
  throwsMsg(() => m.validatePaymentId('a'.repeat(129)), /invalid payment id/);
});

test('a2mcp: compute_expires_at', () => {
  assert.equal(m.computeExpiresAt(0, 1000), 1300);
  assert.equal(m.computeExpiresAt(1200, 1000), 1200);
  assert.equal(m.computeExpiresAt(5000, 1000), 1300);
  throwsMsg(() => m.computeExpiresAt(1000, 1000), /^a2mcp_payment_intent_expired: challenge expired$/);
});

test('a2mcp: challenge expiry accepts RFC 3339 and numeric values', () => {
  assert.equal(m.parseChallengeExpiry('1970-01-01T00:20:00Z'), 1200n);
  assert.equal(m.parseChallengeExpiry('1200'), 1200n);
  assert.equal(m.parseChallengeExpiry(1200), 1200n);
  throwsMsg(() => m.parseChallengeExpiry('not-a-time'), /^a2mcp_invalid_payment_intent: invalid challenge expiry$/);
  throwsMsg(() => m.parseChallengeExpiry(true), /invalid challenge expiry/);
  assert.equal(m.parseUnixValue('+7'), 7n);
  assert.equal(m.parseUnixValue('-7'), undefined);
});

test('a2mcp: authorization classifier allows exactly four combinations', () => {
  assert.equal(m.classifyAuthorization({ scheme: 'exact', extra: { assetTransferMethod: 'eip3009' } }), 'eip3009');
  assert.equal(m.classifyAuthorization({ scheme: 'EXACT', extra: { assetTransferMethod: 'EIP-3009' } }), 'eip3009');
  assert.equal(m.classifyAuthorization({ scheme: 'exact', extra: { assetTransferMethod: 'permit2' } }), 'permit2');
  assert.equal(m.classifyAuthorization({ scheme: 'upto', extra: { assetTransferMethod: 'permit2' } }), 'permit2');
  assert.equal(m.classifyAuthorization({ scheme: 'aggr_deferred' }), 'session');
  assert.equal(m.classifyAuthorization({ scheme: 'upto' }), null);
  assert.equal(m.classifyAuthorization({ scheme: 'period' }), null);
  assert.equal(m.classifyAuthorization({}), null);
});

test('a2mcp: scheme priority is case-insensitive and deterministic', () => {
  const ranked = [['AGGR_DEFERRED', 'session'], ['UPTO', 'permit2'], ['EXACT', 'permit2'], ['EXACT', 'eip3009']]
    .map(([scheme, a]) => ({ rawAccept: { scheme }, authorizationType: a }))
    .sort((x, y) => m.schemePriority(x) - m.schemePriority(y));
  assert.deepEqual(ranked.map((c) => c.authorizationType), ['eip3009', 'permit2', 'permit2', 'session']);
});

test('a2mcp: candidate binding uses accepts index after a filtered entry', () => {
  const unsupported = { scheme: 'period', network: 'eip155:1', asset: '0x' + 'a'.repeat(40), amount: '9', payTo: '0x' + 'b'.repeat(40) };
  const supported = { scheme: 'exact', network: 'eip155:196', asset: '0x1111111111111111111111111111111111111111', amount: '1000000', payTo: '0x2222222222222222222222222222222222222222' };
  const bound = m.brandCandidates([quoteCandidate(1)], [unsupported, supported]);
  assert.equal(bound.length, 1);
  assert.deepEqual(bound[0].rawAccept(), supported);
  assert.equal(bound[0].candidateId(), 'candidate_1');
  throwsMsg(() => m.brandCandidates([quoteCandidate(1)], [{}]), /candidate index out of range/);
  // same (network, asset): the better scheme priority wins; unsupported symbols are skipped
  const permit = { ...supported, extra: { assetTransferMethod: 'permit2' } };
  const two = m.brandCandidates([quoteCandidate(0), quoteCandidate(1), quoteCandidate(2, { tokenSymbol: 'DAI' })], [permit, supported, supported]);
  assert.equal(two.length, 1);
  assert.equal(two[0].authorizationType(), 'eip3009');
});

test('a2mcp: selected accept rejects unsupported token / scheme / mislabel', () => {
  throwsMsg(() => m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('c', { ...RAW }, 'DAI', 18, 'eip3009', 'sufficient')), /unsupported payment asset/);
  throwsMsg(() => m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('c', { ...RAW, scheme: 'period' }, 'USDC', 6, 'permit2', 'sufficient')), /unsupported scheme\/authorization/);
  const deferred = { ...RAW, scheme: 'aggr_deferred', extra: undefined };
  assert.equal(m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('c', deferred, 'usdc', 6, 'session', 'sufficient')).scheme(), 'aggr_deferred');
  throwsMsg(() => m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('c', deferred, 'USDC', 6, 'eip3009', 'sufficient')), /authorization disagrees with raw entry/);
  throwsMsg(() => m.A2mcpSelectedAcceptV1.tryFromPreparedCandidate(testCandidate('c', { ...RAW, payTo: '' }, 'USDC', 6, 'eip3009', 'sufficient')), /^a2mcp_invalid_payment_intent: missing payTo$/);
});

test('a2mcp: frozen request validation', () => {
  throwsMsg(() => m.A2mcpFrozenRequestV1.new('https://merchant.example/pay', 'GET', { filter: { nested: true } }, [{ name: 'filter', carrier: 'query', required: true, type: 'object' }]), /^a2mcp_invalid_typed_params: non-body parameter 'filter' must be scalar$/);
  throwsMsg(() => m.A2mcpFrozenRequestV1.new('https://merchant.example/pay', 'POST', { 'PAYMENT-SIGNATURE': 'x' }, [{ name: 'PAYMENT-SIGNATURE', carrier: 'header', required: true, type: 'string' }]), /reserved header parameter 'PAYMENT-SIGNATURE'/);
  throwsMsg(() => m.A2mcpFrozenRequestV1.new('http://merchant.example/pay', 'POST', {}, []), /Endpoint must use HTTPS/);
  throwsMsg(() => m.A2mcpFrozenRequestV1.new(' ', 'POST', {}, []), /endpoint and method are required/);
  throwsMsg(() => m.A2mcpFrozenRequestV1.new('not a url', 'POST', {}, []), /^a2mcp_invalid_typed_params: invalid Endpoint URL: /);
  for (const method of ['GET', 'post', ' Get ']) assert.ok(['GET', 'POST'].includes(m.A2mcpFrozenRequestV1.new('https://merchant.example/pay', method, {}, []).method()));
  for (const method of ['PUT', 'PATCH', 'DELETE']) throwsMsg(() => m.A2mcpFrozenRequestV1.new('https://merchant.example/pay', method, {}, []), /method must be GET or POST/);
});

test('a2mcp: url crate ParseError classification for rejected endpoints', () => {
  // Oracles recorded from the 4.6.3 binary (parity cases payment-schemes-a2mcp-endpoint-url*):
  // special-scheme hosts go through IDNA (IdnaError), the host is checked before the port, and a
  // host that ends in a number must be a valid IPv4 address; only opaque (non-special) hosts
  // report InvalidDomainCharacter.
  const cases = { foo: 'relative URL without a base', 'https://': 'empty host', 'https://host:70000/x': 'invalid port number',
    'https://[::1/': 'invalid IPv6 address', 'https://256.1.1.1/': 'invalid IPv4 address', 'https://exa mple.com': 'invalid international domain name',
    'https://exa mple.com:99999/pay': 'invalid international domain name', 'https://foo.09/pay': 'invalid IPv4 address',
    'https://foo.0x/pay': 'invalid IPv4 address', 'https://1.2.3.4.5/pay': 'invalid IPv4 address', 'https://0x100000000/pay': 'invalid IPv4 address',
    'https://999.1.1.1:99999/pay': 'invalid IPv4 address', 'https://xn--a.com/pay': 'invalid international domain name',
    'https://ex%20ample.com/pay': 'invalid international domain name', 'https://ex%zzample.com/pay': 'invalid international domain name',
    'https://example.com:8a/pay': 'invalid port number', 'https://[::1]x/pay': 'invalid IPv6 address', 'https://user@/pay': 'empty host',
    'https://:443/pay': 'empty host', 'http://exa mple.com/pay': 'invalid international domain name',
    'foo://exa mple/pay': 'invalid domain character', 'foo://[::1/x': 'invalid IPv6 address', 'foo://h:9x/p': 'invalid port number' };
  for (const [u, want] of Object.entries(cases)) {
    assert.equal(m.urlParseError(u), want, u);
    assert.throws(() => m.A2mcpFrozenRequestV1.new(u, 'GET', {}, []), (e) => e.message === `a2mcp_invalid_typed_params: invalid Endpoint URL: ${want}`);
  }
});

test('a2mcp: intent creation, source isolation and the execution state machine', () => {
  throwsMsg(() => m.createA2mcpPaymentIntent(createInput({ userConfirmed: false })), /^a2mcp_payment_confirmation_required/);
  throwsMsg(() => m.createA2mcpPaymentIntent(createInput({ selectedAccept: selected('insufficient') })), /^a2mcp_insufficient_balance/);
  const intent = m.createA2mcpPaymentIntent(createInput());
  assert.equal(intent.paymentId(), 'pay_645ff957de035f18b7bb9351');
  assert.equal(intent.source(), m.A2mcpPaymentSource.OkxAiA2mcp);
  assert.equal(intent.executionState(), 'prepared');
  assert.equal(m.inspectPaymentSource(intent.paymentId()), m.A2mcpPaymentSource.OkxAiA2mcp);
  throwsMsg(() => m.createA2mcpPaymentIntent(createInput()), /^a2mcp_payment_intent_already_created: probe_1$/);
  const file = JSON.parse(readFileSync(join(HOME, 'payments', `${intent.paymentId()}.json`), 'utf8'));
  assert.deepEqual(Object.keys(file), ['version', 'source', 'paymentId', 'probeId', 'ownerAccountId', 'payerAddress', 'frozenRequest', 'selectedAccept', 'execution', 'createdAt', 'expiresAt']);
  assert.deepEqual(file.frozenRequest.typedParams, { count: 2, enabled: true });

  const read = m.readA2mcpPaymentIntent(intent.paymentId(), 'account_1', 1050);
  throwsMsg(() => m.readA2mcpPaymentIntent(intent.paymentId(), 'account_2', 1050), /^cross_user_payment_id: pay_645ff957de035f18b7bb9351$/);
  read.beginSigning(1050);
  read.recordSignatureAttempt();
  read.markProofGenerated();
  read.markReplaying();
  read.markFailedTerminal();
  const after = JSON.parse(readFileSync(join(HOME, 'payments', `${intent.paymentId()}.json`), 'utf8'));
  assert.deepEqual(after.execution, { state: 'failed_terminal', signatureAttempts: 1 });
  for (const k of ['source', 'paymentId', 'probeId', 'ownerAccountId', 'payerAddress', 'frozenRequest', 'selectedAccept', 'createdAt', 'expiresAt']) assert.deepEqual(after[k], file[k], k);
  throwsMsg(() => read.beginSigning(1060), /^a2mcp_payment_already_executed/);

  // missing challenge expiry → bounded local TTL; expiry persists `expired`
  const late = m.createA2mcpPaymentIntent(createInput({ probeId: 'probe_no_expiry', expiresAt: 0 }));
  assert.ok(m.readA2mcpPaymentIntent(late.paymentId(), 'account_1', 1299));
  throwsMsg(() => m.readA2mcpPaymentIntent(late.paymentId(), 'account_1', 1300), /^a2mcp_payment_intent_expired/);
  assert.equal(JSON.parse(readFileSync(join(HOME, 'payments', `${late.paymentId()}.json`), 'utf8')).execution.state, 'expired');

  // generic quote state is not misclassified; unknown source rejected; malformed intent
  writeFileSync(join(HOME, 'payments', 'pay_generic.json'), JSON.stringify({ payment_id: 'pay_generic', owner_wallet: 'account_1' }));
  assert.equal(m.inspectPaymentSource('pay_generic'), m.A2mcpPaymentSource.GenericQuote);
  writeFileSync(join(HOME, 'payments', 'pay_other.json'), JSON.stringify({ source: 'x' }));
  throwsMsg(() => m.inspectPaymentSource('pay_other'), /^a2mcp_invalid_payment_intent: unknown payment source$/);
  writeFileSync(join(HOME, 'payments', 'pay_broken.json'), JSON.stringify({ source: 'okx_ai_a2mcp' }));
  throwsMsg(() => m.readA2mcpPaymentIntent('pay_broken', 'account_1', 1), /^a2mcp_invalid_payment_intent: malformed intent$/);
  throwsMsg(() => m.readA2mcpPaymentIntent('pay_generic', 'account_1', 1), /payment state is not an A2MCP intent/);
  throwsMsg(() => m.inspectPaymentSource('pay_missing'), /^quote_expired_or_missing: pay_missing: /);
});

test('a2mcp: proof assembly failure can be recorded terminal before replay', () => {
  const intent = m.createA2mcpPaymentIntent(createInput({ probeId: 'probe_proof_failure' }));
  intent.beginSigning(1050);
  intent.recordSignatureAttempt();
  intent.markProofGenerated();
  intent.markFailedTerminal();
  assert.equal(intent.executionState(), 'failed_terminal');
  throwsMsg(() => intent.beginSigning(1060), /already_executed/);
  throwsMsg(() => intent.markSuccess(), /terminal transition from invalid state/);
});

const preparedPayment = () => new m.A2mcpPreparedPayment({
  version: 1, source: 'okx_ai_a2mcp',
  frozenRequest: m.A2mcpFrozenRequestV1.new('https://example.com/pay', 'POST', { count: 2 }, [], { url: 'https://example.com/pay' }),
  confirmationContext: m.A2mcpConfirmationContextV1.new('service-1', 'Yield report', '8136', '1.25', 'USDT'),
  candidates: m.brandCandidates([quoteCandidate(0)], [{ scheme: 'exact', network: 'eip155:196', asset: '0x1111111111111111111111111111111111111111', amount: '1000000', payTo: '0x2222222222222222222222222222222222222222' }]),
  challengeExpiresAt: 1200, walletError: undefined, fundingCandidateId: undefined,
});

test('a2mcp: prepared state uses a short id and is consumed once', () => {
  const id = m.storeA2mcpPreparedPayment(preparedPayment(), 'account_1', 1000);
  assert.match(id, /^a2prep_[0-9a-f]{32}$/);
  const loaded = m.loadA2mcpPreparedPayment(id, 'account_1', 1100);
  assert.equal(loaded.select('candidate_0').symbol(), 'USDC');
  assert.equal(loaded.confirmationContext().serviceName(), 'Yield report');
  assert.equal(loaded.confirmationContext().providerAgentId(), '8136');
  assert.equal(loaded.confirmationContext().aspAmount(), '1.25');
  const consumed = m.consumeA2mcpPreparedPayment(id, 'account_1', 1100);
  assert.equal(consumed.frozenRequest().typedParams().count, 2);
  throwsMsg(() => m.consumeA2mcpPreparedPayment(id, 'account_1', 1100), /^a2mcp_prepared_expired_or_missing/);
  assert.ok(!existsSync(join(HOME, 'payments', `${id}.json`)));
  throwsMsg(() => m.storeA2mcpPreparedPayment(preparedPayment(), '', 1000), /^wallet_login_required: no selected wallet$/);
  throwsMsg(() => m.loadA2mcpPreparedPayment('a2prep_xyz', 'account_1', 1), /^a2mcp_prepared_expired_or_missing: a2prep_xyz$/);
});

test('a2mcp: prepared owner / expiry guards and replacement', () => {
  const id = m.storeA2mcpPreparedPayment(preparedPayment(), 'account_1', 1000);
  throwsMsg(() => m.loadA2mcpPreparedPayment(id, 'account_2', 1100), /^cross_user_payment_id/);
  const replacement = m.replaceA2mcpPreparedPayment(id, preparedPayment(), 'account_1', 1100);
  assert.notEqual(replacement, id);
  assert.throws(() => m.loadA2mcpPreparedPayment(id, 'account_1', 1100));
  assert.ok(m.loadA2mcpPreparedPayment(replacement, 'account_1', 1199));
  throwsMsg(() => m.loadA2mcpPreparedPayment(replacement, 'account_1', 1200), /^a2mcp_prepared_expired_or_missing/);
  assert.ok(!existsSync(join(HOME, 'payments', `${replacement}.json`)));
});

test('a2mcp: replacement preserves the original TTL; uncommitted claim restores', () => {
  const p = preparedPayment();
  p.d.challengeExpiresAt = 0;
  const id = m.storeA2mcpPreparedPayment(p, 'account_1', 1000);
  const replacement = m.replaceA2mcpPreparedPayment(id, p, 'account_1', 1100);
  assert.ok(m.loadA2mcpPreparedPayment(replacement, 'account_1', 1299));
  assert.throws(() => m.loadA2mcpPreparedPayment(replacement, 'account_1', 1300));
  const id2 = m.storeA2mcpPreparedPayment(preparedPayment(), 'account_1', 1000);
  const claim = m.claimA2mcpPreparedPayment(id2, 'account_1', 1100);
  assert.equal(claim.prepared().candidates().length, 1);
  assert.ok(readdirSync(join(HOME, 'payments')).some((f) => f.startsWith(`.${id2}.claim-`)));
  claim.drop();
  assert.ok(m.loadA2mcpPreparedPayment(id2, 'account_1', 1100));
});

test('a2mcp: funding continuation is explicit and survives replacement', () => {
  const p = preparedPayment();
  Object.assign(p.d.candidates[0].d, { balanceStatus: 'insufficient', availableAmount: '0', shortfall: '1' });
  p.markFundingContinuation('candidate_0');
  throwsMsg(() => preparedPayment().markFundingContinuation('candidate_0'), /^a2mcp_funding_not_required/);
  throwsMsg(() => p.markFundingContinuation('candidate_9'), /unknown candidate/);
  const original = m.storeA2mcpPreparedPayment(p, 'account_1', 1000);
  const replacement = m.replaceA2mcpPreparedPayment(original, p, 'account_1', 1100);
  assert.equal(m.loadA2mcpPreparedPayment(replacement, 'account_1', 1100).fundingCandidateId(), 'candidate_0');
  assert.throws(() => m.loadA2mcpPreparedPayment(original, 'account_1', 1100));
});

test('a2mcp: prepared state without confirmationContext remains readable', () => {
  const id = m.storeA2mcpPreparedPayment(preparedPayment(), 'account_1', 1000);
  const path = join(HOME, 'payments', `${id}.json`);
  const v = JSON.parse(readFileSync(path, 'utf8'));
  delete v.prepared.confirmationContext;
  writeFileSync(path, JSON.stringify(v));
  const p = m.loadA2mcpPreparedPayment(id, 'account_1', 1100);
  assert.equal(p.confirmationContext().serviceId(), '');
  assert.equal(p.confirmationContext().serviceName(), null);
});

test('a2mcp: balance refresh preserves frozen candidate metadata', () => {
  const candidates = m.brandCandidates([quoteCandidate(0)], [{ scheme: 'exact', network: 'eip155:196', asset: '0x1111111111111111111111111111111111111111', amount: '1000000', payTo: '0x2222222222222222222222222222222222222222' }]);
  const frozenMeta = ['symbol', 'decimals', 'scheme', 'amountAtomic', 'amountDisplay'].map((k) => candidates[0].d[k]);
  m.applyBalanceRefresh(candidates, [quoteCandidate(0, { balanceStatus: 'insufficient', availableAmount: '0.25', requiredAmount: '1', shortfall: '0.75', depositAddress: '0x' + '4'.repeat(40) })]);
  assert.deepEqual(['symbol', 'decimals', 'scheme', 'amountAtomic', 'amountDisplay'].map((k) => candidates[0].d[k]), frozenMeta);
  assert.equal(candidates[0].balanceStatus(), 'insufficient');
  assert.equal(candidates[0].shortfall(), '0.75');
  throwsMsg(() => m.applyBalanceRefresh(candidates, []), /candidate set changed during balance refresh/);
});

test('a2mcp: serde Value equality distinguishes floats from integers', () => {
  assert.ok(m.valueEq({ a: [1, 'x', null] }, { a: [1n, 'x', null] }));
  assert.ok(!m.valueEq(1, new F64('1.0')));
  assert.ok(m.valueEq(new F64('1.5'), new F64('1.50')));
  assert.ok(!m.valueEq({ a: 1 }, { a: 1, b: 2 }));
});

// ── verifier additions: divergences found against the 4.6.3 binary ─────
const chrono = await import('../../skill/onchainos-lite/lib/payment/_chrono.mjs');

test('chrono 0.4.44 parse_from_rfc3339: error kinds in upstream check order (parity a2a-pay-rfc3339-*)', () => {
  const errs = {
    '2026-13-01T00:00:0xZ': 'input is out of range',            // calendar date checked before the time digits
    '2026-02-30X00:00:00Z': 'input is out of range',            // … and before the 'T' separator
    '2099-01-01T24:00:00.Zz': 'input contains invalid characters', // fraction scanned before hour range
    '2099-01-01T00:00:00+24:00x': 'trailing input',             // trailing input before offset range
    '2099-01-01t00:00:00 z': 'input contains invalid characters',
    '2099-01-01 00:00:00-00:60': 'input is out of range',
    '2099-01-01T00:00:00+0:00': 'input contains invalid characters',
    '2099-01-01T00:00:00+24:00': 'input is out of range',
    '2099-01-01T00:00:00.': 'premature end of input',
    '2099-01-01T00:00:00': 'premature end of input',
    '2099-01-01T00:00:61Z': 'input is out of range',
    tomorrow: 'premature end of input',
  };
  for (const [s, want] of Object.entries(errs)) assert.throws(() => chrono.parseFromRfc3339(s), (e) => e.message === want, s);
  assert.deepEqual(chrono.parseFromRfc3339('2099-01-01T00:00:00−01:00'), { secs: 4070912400n, nanos: 0 });   // U+2212 minus
  assert.deepEqual(chrono.parseFromRfc3339('1970-01-01T00:20:00Z'), { secs: 1200n, nanos: 0 });
  assert.deepEqual(chrono.parseFromRfc3339('0000-01-01T00:00:00.123456789123z'), { secs: -62167219200n, nanos: 123456789 });
  assert.deepEqual(chrono.parseFromRfc3339('2099-12-31T23:59:60.5+23:59'), { secs: 4102358459n, nanos: 1500000000 });
  assert.deepEqual(chrono.parseFromRfc3339('2024-02-29 12:00:00.1-05:30'), { secs: 1709227800n, nanos: 100000000 });
  // `expires_at <= Utc::now()` compares (secs, nanos): sub-second expiries and leap seconds
  const t = chrono.parseFromRfc3339('2030-01-01T00:00:00.500Z');
  const ms = Number(t.secs) * 1000;
  assert.equal(chrono.isAtOrBeforeNow(t, ms + 499), false);
  assert.equal(chrono.isAtOrBeforeNow(t, ms + 500), true);
  const leap = chrono.parseFromRfc3339('2030-01-01T00:00:60Z');
  assert.equal(chrono.isAtOrBeforeNow(leap, (Number(leap.secs) * 1000) + 999), false);
  assert.equal(chrono.isAtOrBeforeNow(leap, (Number(leap.secs) + 1) * 1000), true);
});

test('session-state: serde_json::from_str rules — BOM, duplicate field, seq form (parity session-state-*)', () => {
  const W = { channel_id: 'c', owner_wallet: 'o', deposit: '1000', cumulative: '100', created_at: 1, updated_at: 2 };
  const text = JSON.stringify(W);
  assert.equal(ss.channelStateFromStr(text).deposit, '1000');
  assert.equal(ss.channelStateFromStr('﻿' + text), null);
  assert.equal(ss.channelStateFromStr(text.replace('"deposit":"1000"', '"deposit":"1000","deposit":"5000"')), null);
  assert.equal(ss.channelStateFromStr('["c","o","1000","100",1,2]').cumulative, '100');
  assert.equal(ss.channelStateFromStr('["c","o","1000","100",1]'), null);
  assert.equal(ss.channelStateFromStr('["c","o","1000","100",1,2,3]'), null);
  assert.equal(ss.channelStateFromStr(text.replace('"created_at":1', '"created_at":1.0')), null);
  assert.equal(ss.channelStateFromStr(text.replace('}', ',"extra":{"x":[1]}}')).deposit, '1000');
  mkdirSync(join(HOME, 'sessions'), { recursive: true });
  writeFileSync(join(HOME, 'sessions', '0xb0.json'), '﻿' + text);
  assert.equal(ss.read('0xb0'), null);
  writeFileSync(join(HOME, 'sessions', '0xb1.json'), Buffer.concat([Buffer.from(text.slice(0, -1) + ',"x":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.equal(ss.read('0xb1'), null);                                         // read_to_string: invalid UTF-8
});

test('a2mcp: persisted intent decode follows serde derive rules (parity a2mcp-dup-field / seq-* / enum-map-form)', () => {
  const intent = m.createA2mcpPaymentIntent(createInput({ probeId: 'probe_serde_rules' }));
  const path = join(HOME, 'payments', `${intent.paymentId()}.json`);
  const good = readFileSync(path, 'utf8');
  const v = JSON.parse(good);
  const put = (text) => writeFileSync(path, text);
  const read = () => m.readA2mcpPaymentIntent(intent.paymentId(), 'account_1', 1050);
  put(good.replace('"version": 1,', '"version": 1,\n  "version": 1,'));
  throwsMsg(read, /^a2mcp_invalid_payment_intent: malformed intent$/);          // duplicate field
  const fr = v.frozenRequest;
  put(JSON.stringify({ ...v, frozenRequest: [fr.endpoint, fr.method, fr.typedParams, fr.paramPlan] }));
  throwsMsg(read, /^a2mcp_invalid_payment_intent: malformed intent$/);          // seq form: Option w/o default still required
  put(JSON.stringify({ ...v, frozenRequest: [fr.endpoint, fr.method, fr.typedParams, fr.paramPlan, null] }));
  assert.equal(read().frozenRequest().resource(), undefined);
  put(JSON.stringify({ ...v, execution: { state: { prepared: null }, signatureAttempts: 0 } }));
  assert.equal(read().executionState(), 'prepared');                            // unit variant, map form
  put(JSON.stringify({ ...v, execution: { state: { prepared: 1 }, signatureAttempts: 0 } }));
  throwsMsg(read, /malformed intent/);
  put(JSON.stringify({ ...v, execution: { state: 'prepared', signatureAttempts: 256 } }));
  throwsMsg(read, /malformed intent/);
  put(good);
  assert.equal(read().executionState(), 'prepared');
});

test('a2mcp: intent write failure carries home::atomic_write context (parity a2mcp-intent-write-fails)', () => {
  const intent = m.createA2mcpPaymentIntent(createInput({ probeId: 'probe_tmp_dir' }));
  const tmp = join(HOME, 'payments', `${intent.paymentId()}.json.tmp`);
  mkdirSync(tmp, { recursive: true });
  assert.throws(() => intent.beginSigning(1050), (e) => e.message.startsWith(`write A2MCP payment intent: failed to write temp file ${tmp}: `));
});

test('a2mcp: prepared state seq-form confirmationContext honours #[serde(default)] Options', () => {
  const id = m.storeA2mcpPreparedPayment(preparedPayment(), 'account_1', 1000);
  const path = join(HOME, 'payments', `${id}.json`);
  const v = JSON.parse(readFileSync(path, 'utf8'));
  v.prepared.confirmationContext = ['service-seq'];
  writeFileSync(path, JSON.stringify(v));
  const p = m.loadA2mcpPreparedPayment(id, 'account_1', 1100);
  assert.equal(p.confirmationContext().serviceId(), 'service-seq');
  assert.equal(p.confirmationContext().serviceName(), null);
  v.prepared.confirmationContext = { serviceId: 'a', serviceId2: 1 };
  v.prepared.walletError = undefined;
  const text = JSON.stringify(v).replace('"serviceId":"a"', '"serviceId":"a","serviceId":"b"');
  writeFileSync(path, text);
  throwsMsg(() => m.loadA2mcpPreparedPayment(id, 'account_1', 1100), /^a2mcp_prepared_expired_or_missing/);   // duplicate field
});
