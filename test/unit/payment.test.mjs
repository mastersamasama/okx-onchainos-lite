// Unit tests for the payment foundation (lib/payment/**). Oracles: the upstream Rust unit tests
// (commands/payment/{dispatcher,payment_flow,addr,decode_receipt,http_carrier,quote,state}.rs,
// payment/permit2/*.rs, payment/subscription/*.rs, mcp_client.rs) and the spec's derived vectors
// (spec/extract/g09a/g09b). A stub wallet API + stub merchant exercise the TEE signing and the
// two-phase replay end to end (fund paths the parity proxy never forwards).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-payment-'));
cpSync(join(HERE, '..', 'parity', 'homes', 'wallet-chains'), HOME, { recursive: true });
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.env.ONCHAINOS_CREDENTIAL_STORE = 'file';
delete process.env.EVM_PRIVATE_KEY;

// Stub OKX API (wallet TEE endpoints) + stub merchant on one server.
const STUB = { log: [], routes: {} };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    STUB.log.push({ method: req.method, url: req.url, path: req.url.split('?')[0], headers: req.headers, body });
    const route = STUB.routes[req.url.split('?')[0]];
    const r = typeof route === 'function' ? route(req, body) : route ?? { status: 599, body: { code: '599', msg: 'no stub', data: [] } };
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.OCL_BASE_URL = BASE;
after(() => server.close());

const ok = (data) => ({ body: { code: '0', msg: '', data } });
const bodies = (path) => STUB.log.filter((x) => x.path === path).map((x) => JSON.parse(x.body));

const rs = await import('../../skill/onchainos-lite/lib/payment/_rs.mjs');
const addr = await import('../../skill/onchainos-lite/lib/payment/addr.mjs');
const disp = await import('../../skill/onchainos-lite/lib/payment/dispatcher.mjs');
const flow = await import('../../skill/onchainos-lite/lib/payment/payment-flow.mjs');
const carrier = await import('../../skill/onchainos-lite/lib/payment/http-carrier.mjs');
const receipt = await import('../../skill/onchainos-lite/lib/payment/decode-receipt.mjs');
const quote = await import('../../skill/onchainos-lite/lib/payment/quote.mjs');
const state = await import('../../skill/onchainos-lite/lib/payment/state.mjs');
const mcp = await import('../../skill/onchainos-lite/lib/payment/_mcp-client.mjs');
const pcache = await import('../../skill/onchainos-lite/lib/payment/_payment-cache.mjs');
const p2e = await import('../../skill/onchainos-lite/lib/payment/permit2/eip712.mjs');
const p2s = await import('../../skill/onchainos-lite/lib/payment/permit2/sign.mjs');
const p2r = await import('../../skill/onchainos-lite/lib/payment/permit2/rpc.mjs');
const p2t = await import('../../skill/onchainos-lite/lib/payment/permit2/types.mjs');
const se = await import('../../skill/onchainos-lite/lib/payment/subscription/eip712.mjs');
const ss = await import('../../skill/onchainos-lite/lib/payment/subscription/sign.mjs');
const sc = await import('../../skill/onchainos-lite/lib/payment/subscription/cache.mjs');
const stypes = await import('../../skill/onchainos-lite/lib/payment/subscription/types.mjs');
const x402 = await import('../../skill/onchainos-lite/lib/payment/x402-header.mjs');
const { signingHash, personalHash } = await import('../../skill/onchainos-lite/lib/crypto/eip712.mjs');
const { recoverAddress } = await import('../../skill/onchainos-lite/lib/crypto/secp256k1.mjs');
const { stringify, parse } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { Confirming } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');
const { EMPTY } = await import('../../skill/onchainos-lite/lib/core/context.mjs');
const { PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY, X402_UPTO_PERMIT2_PROXY } = await import('../../skill/onchainos-lite/lib/core/chains.mjs');

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const errMsg = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const errMsgAsync = async (fn) => { try { await fn(); } catch (e) { return e.message; } return null; };
const PK = Buffer.from('11'.repeat(32), 'hex');
const PK_ADDR = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const ACCOUNT1_EVM = '0xd825f780e3cb88b383907ff427495d1dca352d44';

// ── Permit2 (payment/permit2/eip712.rs golden vectors) ─────────────────────────
const EXACT_IN = {
  token: '0x779ded0c9e1022225f8e0630b35a9b54be713736', amount: '1234000', spender: X402_EXACT_PERMIT2_PROXY, nonce: '1027389',
  deadline: '1714813500', witnessTo: '0x000000000000000000000000000000000000beef', witnessValidAfter: '1714812840', chainId: 196,
};
const UPTO_IN = {
  token: '0x779ded0c9e1022225f8e0630b35a9b54be713736', amount: '5000000', spender: '0x4020e7393B728A3939659E5732F87fdd8e680002', nonce: '1027389',
  deadline: '1714813500', witnessTo: '0x000000000000000000000000000000000000beef', witnessFacilitator: '0x000000000000000000000000000000000000cafe',
  witnessValidAfter: '1714812840', chainId: 196,
};

test('permit2: exact / upto EIP-712 digests match the upstream golden vectors', () => {
  assert.equal(hex(p2e.exactSigningHash(p2e.buildExactPermit2Struct(EXACT_IN), 196)), '0x3ffe06bf5e4edd78f53b87e84d297128e164e5ce5a74aeaa5fd3a82498619155');
  assert.equal(hex(p2e.uptoSigningHash(p2e.buildUptoPermit2Struct(UPTO_IN), 196)), '0x796938f26e4b4fc3292117cd3f61578144a0c794bc03394cd1bb315a365b66c9');
  // The JSON typed data the TEE receives hashes to the same digest (types section == sol! structs).
  assert.equal(hex(signingHash(p2e.buildExactPermit2TypedData(EXACT_IN))), '0x3ffe06bf5e4edd78f53b87e84d297128e164e5ce5a74aeaa5fd3a82498619155');
  assert.equal(hex(signingHash(p2e.buildUptoPermit2TypedData(UPTO_IN))), '0x796938f26e4b4fc3292117cd3f61578144a0c794bc03394cd1bb315a365b66c9');
});

test('permit2: typed data shape (domain without version, sorted wire JSON)', () => {
  const td = p2e.buildExactPermit2TypedData(EXACT_IN);
  assert.equal(stringify(td.domain), `{"chainId":196,"name":"Permit2","verifyingContract":"${PERMIT2_ADDRESS}"}`);
  assert.deepEqual(td.types.EIP712Domain.map((f) => f.name), ['name', 'chainId', 'verifyingContract']);
  assert.equal(td.primaryType, 'PermitWitnessTransferFrom');
  assert.deepEqual(p2e.buildUptoPermit2TypedData(UPTO_IN).types.Witness.map((f) => f.name), ['to', 'facilitator', 'validAfter']);
  assert.equal(errMsg(() => p2e.buildExactPermit2Struct({ ...EXACT_IN, token: '0x12' })), 'invalid token address: invalid string length');
  assert.match(errMsg(() => p2e.buildExactPermit2Struct({ ...EXACT_IN, nonce: 'x' })), /^invalid nonce uint256: /);
});

test('permit2: local signatures recover to the key (legacy v 27/28) + wire shape', () => {
  const p = p2s.signExactPermit2Local(PK, PK_ADDR, EXACT_IN);
  const sig = Buffer.from(p.signature.slice(2), 'hex');
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  assert.equal(recoverAddress(p2e.exactSigningHash(p2e.buildExactPermit2Struct(EXACT_IN), 196), sig), PK_ADDR);
  assert.equal(stringify(p2t.toValue(p.permit2Authorization)),
    `{"deadline":"1714813500","from":"${PK_ADDR}","nonce":"1027389","permitted":{"amount":"1234000","token":"0x779ded0c9e1022225f8e0630b35a9b54be713736"},"spender":"${X402_EXACT_PERMIT2_PROXY}","witness":{"to":"0x000000000000000000000000000000000000beef","validAfter":"1714812840"}}`);
  const u = p2s.signUptoPermit2Local(PK, PK_ADDR, UPTO_IN);
  assert.equal(recoverAddress(p2e.uptoSigningHash(p2e.buildUptoPermit2Struct(UPTO_IN), 196), Buffer.from(u.signature.slice(2), 'hex')), PK_ADDR);
  assert.equal(u.permit2Authorization.witness.facilitator, '0x000000000000000000000000000000000000cafe');
});

test('permit2: struct serialisation keeps declaration order (types.rs oracle)', () => {
  const v = p2t.exactPermit2Payload({ signature: '0xfa42c11c', permit2Authorization: { from: '0xBuyer', permitted: { token: '0xToken', amount: '1234000' }, spender: X402_EXACT_PERMIT2_PROXY, nonce: '1027389', deadline: '1714813500', witness: { to: '0xMerchant', validAfter: '1714812840' } } });
  assert.equal(stringify(v), `{"signature":"0xfa42c11c","permit2Authorization":{"from":"0xBuyer","permitted":{"token":"0xToken","amount":"1234000"},"spender":"${X402_EXACT_PERMIT2_PROXY}","nonce":"1027389","deadline":"1714813500","witness":{"to":"0xMerchant","validAfter":"1714812840"}}}`);
});

test('permit2 rpc: parse_uint256_hex tolerates short hex, rejects junk', () => {
  assert.equal(p2r.parseUint256Hex('0x' + '0'.repeat(64)), 0n);
  assert.equal(p2r.parseUint256Hex('0x' + '0'.repeat(58) + '0f4240'), 1000000n);
  assert.equal(p2r.parseUint256Hex('0x' + 'f'.repeat(64)), (1n << 256n) - 1n);
  assert.equal(p2r.parseUint256Hex('0xf4240'), 1000000n);
  assert.throws(() => p2r.parseUint256Hex('0xZZZZ'));
  assert.equal(errMsg(() => p2r.parseUint256Hex('0x')), 'empty uint256 hex');
  assert.equal(errMsg(() => p2r.parseUint256Hex('0x' + '0'.repeat(65))), 'uint256 hex too long: 65 chars (max 64)');
});

test('permit2 rpc: non-X Layer chains and bad addresses fail before any network', async () => {
  assert.equal(await errMsgAsync(() => p2r.fetchPermit2Allowance('8453', EXACT_IN.token, PK_ADDR)), 'no RPC endpoint configured for chain 8453 — Permit2 allowance pre-check unavailable');
  assert.match(await errMsgAsync(() => p2r.fetchPermit2Allowance('196', '0xnope', PK_ADDR)), /^invalid token address: 0xnope: /);
  assert.match(await errMsgAsync(() => p2r.fetchPermit2Allowance('196', EXACT_IN.token, '0x12')), /^invalid owner address: 0x12: /);
});

// ── Subscription (payment/subscription/eip712.rs; spec g09b §G derived vectors) ─
const SUB = '0x4020000000000000000000000000000000000003';
const TOKEN = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const ZERO32 = '0x' + '0'.repeat(64);
const TERMS = {
  payer: '0x000000000000000000000000000000000000beef', merchant: '0x000000000000000000000000000000000000cafe',
  facilitator: '0x000000000000000000000000000000000000dead', token: TOKEN, amountPerPeriod: '5000000', periodSec: 2592000,
  maxPeriods: 12, startAt: 0, initialChargePeriods: 1, initialChargeAmount: '5000000', termsDeadline: 1750000000,
  permitHash: ZERO32, salt: '0x' + '11'.repeat(32), planTier: 2, changeFromSubId: ZERO32, changeEffectiveAt: 0, periodMode: 1,
  domain: { chainId: 196, verifyingContract: SUB },
};

test('subscription: typestrings are byte-exact', () => {
  assert.equal(se.PERMIT_DETAILS_TYPESTRING, 'PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)');
  assert.equal(se.PERMIT_SINGLE_TYPESTRING, 'PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)');
  assert.equal(se.CANCEL_AUTH_TYPESTRING, 'CancelAuth(uint8 action,bytes32 subId,uint8 initiator,bytes32 nonce,uint64 deadline)');
  assert.equal(se.SUBSCRIPTION_TERMS_TYPESTRING.slice(18, -1).split(',').length, 17);
});

test('subscription: struct hashes / subId match the derived vectors', () => {
  assert.equal(hex(se.permitSingleStructHash(TOKEN, '60000000', 1782000000, 7, SUB, '1750000000')), '0xc29b4bc80555e586b648fc3f872cf472a149120edbbc92e0b4fc581ebebd24cf');
  assert.notEqual(hex(se.permitSingleStructHash(TOKEN, '60000000', 1782000000, 8, SUB, '1750000000')), '0xc29b4bc80555e586b648fc3f872cf472a149120edbbc92e0b4fc581ebebd24cf');
  assert.equal(hex(se.subscriptionTermsStructHash(TERMS)), '0xcde9728252332eb542256082ef4896bf8cae33eb18a8c015246b7be51f2d8e1c');
  assert.equal(hex(se.termsDigest(TERMS)), '0x219121f39e1d0f4051451fd2c55d5a44d7ff03a0b9f73e67e5e18748995d814e');
  assert.notEqual(hex(se.termsDigest({ ...TERMS, salt: '0x' + '22'.repeat(32) })), hex(se.termsDigest(TERMS)));
  // Manual hashing == generic EIP-712 over the typed data the TEE signs.
  assert.equal(hex(signingHash(se.buildSubscriptionTermsTypedData(TERMS))), hex(se.termsDigest(TERMS)));
  const ps = se.buildPermitSingleTypedData(TOKEN, '60000000', 1782000000, 7, SUB, '1750000000', PERMIT2_ADDRESS, 196);
  const all = { ...ps.types };
  assert.equal(hex(signingHash({ ...ps, types: all })).length, 66);
});

test('subscription: access-proof inner hash + EIP-191 digest (derived vectors)', () => {
  const inner = se.accessProofInnerHash('0x' + '11'.repeat(32), '0x000000000000000000000000000000000000beef', 1747200000);
  assert.equal(hex(inner), '0xf94ad6f188467c9ce8b0511dff676ec6cf26a37757b839d4dbddf64b727a8510');
  assert.equal(hex(personalHash(inner)), '0x91c3bf061cbdef1e42a2f6f59573da2a05247f99f94a57862d8565ceef8fd66b');
  assert.match(errMsg(() => se.accessProofInnerHash('not-hex', TERMS.payer, 1)), /^invalid subId bytes32: not-hex: /);
});

test('subscription: typed-data builders (numbers vs strings, planId excluded)', () => {
  const td = se.buildSubscriptionTermsTypedData(TERMS);
  assert.equal(td.types.SubscriptionTerms.length, 17);
  assert.ok(!('planId' in td.message));
  assert.equal(stringify(td.domain), `{"chainId":196,"name":"A2APaySubscription","verifyingContract":"${SUB}","version":"1"}`);
  const ca = se.buildCancelAuthTypedData(0, ZERO32, 0, ZERO32, 5, { chainId: 196, verifyingContract: SUB });
  assert.deepEqual(ca.types.CancelAuth.map((f) => f.name), ['action', 'subId', 'initiator', 'nonce', 'deadline']);
  assert.equal(ca.message.action, 0);
});

const SAMPLE_ACCEPTED = {
  scheme: 'period', network: 'eip155:196', amount: '5000000', asset: TOKEN, payTo: '0x000000000000000000000000000000000000cafe', maxTimeoutSeconds: 600,
  extra: {
    contracts: { subscription: SUB, permit2: PERMIT2_ADDRESS }, facilitator: '0x000000000000000000000000000000000000dead', amountPerPeriod: '5000000',
    periodSec: 2592000, maxPeriods: 12, startAt: 0, initialCharge: { periodCount: 1, totalAmount: '5000000', coversFirstPeriods: true }, plan: { id: 'pro_monthly', tier: 2 },
  },
};

test('subscription sign: extract_terms_params / calendar months / change / u256 / authority', () => {
  const p = ss.extractTermsParams(SAMPLE_ACCEPTED);
  assert.equal(p.merchant, '0x000000000000000000000000000000000000cafe');
  assert.equal(p.planTier, 2); assert.equal(p.planId, 'pro_monthly'); assert.equal(p.timeoutSecs, 600);
  assert.equal(p.initialChargePeriods, 1); assert.equal(p.initialChargeAmount, '5000000');
  const noIc = structuredClone(SAMPLE_ACCEPTED); delete noIc.extra.initialCharge;
  assert.equal(ss.extractTermsParams(noIc).initialChargePeriods, 0);
  assert.equal(ss.addCalendarMonths(1675123200, 1), 1677542400);
  const span = ss.addCalendarMonths(1700000000, 12) - 1700000000;
  assert.ok(span >= 360 * 86400 && span <= 366 * 86400);
  assert.equal(ss.u256(p.initialChargeAmount) + ss.u256(p.amountPerPeriod) * 11n, 60000000n);
  assert.equal(ss.u256('0x10'), 16n);
  assert.throws(() => ss.u256('nope'));
  assert.equal(ss.changeEffectiveAtFrom({ effectiveAt: 'immediate' }), 1);
  assert.equal(ss.changeEffectiveAtFrom({ effectiveAt: 'period_end', direction: 'upgrade' }), 2);
  assert.equal(ss.changeEffectiveAtFrom({ direction: 'downgrade' }), 2);
  assert.equal(errMsg(() => ss.changeEffectiveAtFrom({ direction: 'sideways' })), 'unknown changeFrom.direction: sideways');
  assert.equal(errMsg(() => ss.changeEffectiveAtFrom({})), 'changeFrom missing both effectiveAt and direction');
  assert.equal(errMsg(() => ss.changeEffectiveAtFrom(undefined)), 'change offer missing extra.changeFrom');
  assert.doesNotThrow(() => ss.verifyContractsAgainstAuthority(p, { subscriptionContract: SUB.toUpperCase().replace('0X', '0x'), permit2Contract: PERMIT2_ADDRESS.toLowerCase() }));
  assert.match(errMsg(() => ss.verifyContractsAgainstAuthority(p, { subscriptionContract: '', permit2Contract: PERMIT2_ADDRESS })), /^subscription contract mismatch/);
  assert.match(errMsg(() => ss.verifyContractsAgainstAuthority(p, { subscriptionContract: SUB, permit2Contract: '0x1' })), /^permit2 contract mismatch/);
  const bad = structuredClone(SAMPLE_ACCEPTED); bad.extra.periodMode = 1;
  assert.equal(errMsg(() => ss.extractTermsParams(bad)), 'calendar_month mode (periodMode=1) requires periodSec == 0');
});

test('subscription cache: host_of', () => {
  assert.equal(sc.hostOf('https://api.example.com/v1/data?x=1'), 'api.example.com');
  assert.equal(sc.hostOf('http://user:pass@host.io:8443/x'), 'host.io:8443');
  assert.equal(sc.hostOf('example.com/path'), 'example.com');
  assert.equal(sc.hostOf('HTTPS://API.EXAMPLE.COM'), 'api.example.com');
});

test('subscription types: flex deserializers', () => {
  assert.equal(stypes.flexString(12), '12');
  assert.equal(stypes.flexString(null), '');
  assert.equal(stypes.flexU64(' 42 '), 42);
  assert.equal(stypes.flexU64(''), 0);
  assert.equal(errMsg(() => stypes.flexU64('x')), 'invalid u64 string "x": invalid digit found in string');
  const a = stypes.decodeAllowanceStatus({ approvedAmount: 5, nonce: '7' });
  assert.equal(a.approvedAmount, '5'); assert.equal(a.nonce, 7); assert.equal(a.subscriptionContract, '');
});

// ── addr.rs ──────────────────────────────────────────────────────────────────
test('addr: EIP-55 validation and XKO recipients', () => {
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED']) assert.ok(addr.isValidEvmAddress(a), a);
  for (const a of ['0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x123', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x' + 'Z'.repeat(40)]) assert.ok(!addr.isValidEvmAddress(a), a);
  assert.deepEqual(addr.parseRecipientAddr('XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 196), ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed']);
  assert.equal(errMsg(() => addr.parseRecipientAddr('XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 1)), 'XKO-prefixed addresses are only supported on X Layer (chainId 196), got 1');
  assert.match(errMsg(() => addr.parseRecipientAddr('xko5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 196)), /not a valid EVM address/);
  assert.match(errMsg(() => addr.parseRecipientAddr('XKO5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 196)), /EIP-55/);
  assert.match(errMsg(() => addr.requireEvmAddress('0xnope', 'challenge.request.currency')), /challenge.request.currency/);
});

// ── dispatcher.rs ────────────────────────────────────────────────────────────
test('dispatcher: chain_id_to_caip2 / caip2_to_chain_id', () => {
  assert.equal(disp.chainIdToCaip2('196'), 'eip155:196');
  assert.equal(disp.chainIdToCaip2('  8453  '), 'eip155:8453');
  assert.equal(disp.chainIdToCaip2('+196'), 'eip155:196');
  for (const bad of ['xlayer', 'ethereum', 'eip155:196', '', '   ', '-1', '195', '501', '607', '784']) assert.throws(() => disp.chainIdToCaip2(bad), bad);
  assert.equal(errMsg(() => disp.chainIdToCaip2('xlayer')), '--chain must be a numeric chain id (e.g. "1" for Ethereum, "196" for X Layer), got: xlayer: invalid digit found in string');
  assert.equal(errMsg(() => disp.chainIdToCaip2('99999999999999999999')), '--chain must be a numeric chain id (e.g. "1" for Ethereum, "196" for X Layer), got: 99999999999999999999: number too large to fit in target type');
  assert.equal(disp.caip2ToChainId('eip155:196'), '196');
  assert.equal(disp.caip2ToChainId('solana:x'), 'solana:x');
});

test('dispatcher: parse_www_authenticate', () => {
  const p = disp.parseWwwAuthenticate('Payment id="abc123", realm="api.shop.com", method="evm", intent="charge", request="eyJ9"');
  assert.deepEqual([p.id, p.realm, p.method, p.intent], ['abc123', 'api.shop.com', 'evm', 'charge']);
  assert.throws(() => disp.parseWwwAuthenticate('Payment realm="x"'), /missing required fields \(id, method, intent\)/);
  assert.equal(errMsg(() => disp.parseWwwAuthenticate('Payment id="a", method="svm", intent="charge"')), 'unsupported payment challenge method "svm"; this CLI only supports method="evm"');
  assert.equal(disp.parseWwwAuthenticate('Payment id="a", description="a, b", method="evm", intent="charge", request="e30"').description, 'a, b');
  const ws = disp.parseWwwAuthenticate('Payment   id=a,realm=r ,\tmethod=evm,intent=charge');
  assert.deepEqual([ws.id, ws.realm, ws.intent], ['a', 'r', 'charge']);
  assert.equal(disp.parseWwwAuthenticate('Payment id="a", method="evm", intent="c", note="hello \\"world\\""').note, 'hello "world"');
  // quoted bytes are pushed Latin-1 (`byte as char`): UTF-8 "é" → "Ã©"
  assert.equal(disp.parseWwwAuthenticate('Payment id="é", method="evm", intent="c"').id, 'Ã©');
});

test('dispatcher: decode_payment_blob (www-auth, base64 variants, plain JSON)', () => {
  const body = { x402Version: 2, accepts: [{ scheme: 'exact' }] };
  const js = JSON.stringify(body);
  assert.equal(stringify(disp.decodePaymentBlob(Buffer.from(js).toString('base64'))), stringify(body));
  assert.equal(stringify(disp.decodePaymentBlob(Buffer.from(js).toString('base64url'))), stringify(body));
  assert.equal(stringify(disp.decodePaymentBlob(`  ${js}  `)), stringify(body));
  const req = Buffer.from('{"amount":"1"}').toString('base64url');
  const w = disp.decodePaymentBlob(`Payment id="1", realm="r", method="evm", intent="charge", request="${req}"`);
  assert.equal(w.intent, 'charge'); assert.equal(w.request.amount, '1');
  assert.throws(() => disp.decodePaymentBlob('@@@ not base64, not json @@@'), /^Error: could not decode payment blob/);
  // `payment ` detection is case-insensitive but the prefix strip is not → required-fields error
  assert.throws(() => disp.decodePaymentBlob('payment id="1", method="evm", intent="c"'), /missing required fields/);
  assert.match(errMsg(() => disp.decodeChallengeRequest({ request: 'e30!' })), /^invalid base64url in challenge request: /);
  assert.equal(errMsg(() => disp.decodeChallengeRequest({ request: 'eyJ' })), 'invalid base64url in challenge request: Invalid padding');
  assert.equal(errMsg(() => disp.decodeChallengeRequest({ request: 'eyI' })), 'invalid JSON in challenge request: EOF while parsing a string at line 1 column 2');
  assert.equal(errMsg(() => disp.decodeChallengeRequest({})), "missing 'request' in challenge");
});

test('dispatcher: decode_pay_payload / select_accepts_index / emit', () => {
  const payload = { x402Version: 2, resource: { url: 'https://api.example.com/data', mimeType: 'application/json' }, accepts: [{ scheme: 'exact' }, { scheme: 'aggr_deferred', asset: '0xB' }] };
  const [acc, res] = disp.decodePayPayload(Buffer.from(JSON.stringify(payload)).toString('base64'));
  assert.equal(acc.length, 2); assert.equal(res.url, 'https://api.example.com/data');
  assert.equal(disp.decodePayPayload(Buffer.from('{"accepts":[],"resource":null}').toString('base64'))[1], null);
  assert.equal(disp.decodePayPayload(Buffer.from('{"accepts":[]}').toString('base64'))[1], undefined);
  assert.equal(errMsg(() => disp.decodePayPayload('eyJ4NDAyVmVyc2lvbiI6Mn0')), "--payload decoded to JSON without an 'accepts' field");
  assert.deepEqual(disp.selectAcceptsIndex(acc, 1), [{ scheme: 'aggr_deferred', asset: '0xB' }]);
  assert.equal(errMsg(() => disp.selectAcceptsIndex([{ scheme: 'exact' }], 5)), '--selected-index 5 is out of range (accepts has 1 entry)');
  assert.equal(errMsg(() => disp.selectAcceptsIndex([], 0)), '--selected-index 0 is out of range (accepts has 0 entries)');
  assert.equal(errMsg(() => disp.selectAcceptsIndex({ scheme: 'exact' }, 0)), "--selected-index requires the payload's 'accepts' to be an array");
});

test('dispatcher: JCS base64url credential encoding', () => {
  const e1 = disp.base64urlEncodeJson({ b: 1, a: 2, c: { z: 1, y: [2, 'x'] } });
  const e2 = disp.base64urlEncodeJson({ c: { y: [2, 'x'], z: 1 }, a: 2, b: 1 });
  assert.equal(e1, e2);
  assert.ok(!e1.endsWith('='));
  assert.equal(Buffer.from(e1, 'base64url').toString(), '{"a":2,"b":1,"c":{"y":[2,"x"],"z":1}}');
  // spec oracle (session voucher reuse credential)
  const cred = { challenge: disp.buildChallengeEcho(disp.parseWwwAuthenticate('Payment id="1", realm="r", method="evm", intent="session", request="e30"')), payload: { action: 'voucher', channelId: '0xabc', cumulativeAmount: '100', signature: '0x' + '1'.repeat(130) } };
  assert.equal(disp.base64urlEncodeJson(cred), 'eyJjaGFsbGVuZ2UiOnsiZXhwaXJlcyI6bnVsbCwiaWQiOiIxIiwiaW50ZW50Ijoic2Vzc2lvbiIsIm1ldGhvZCI6ImV2bSIsInJlYWxtIjoiciIsInJlcXVlc3QiOiJlMzAifSwicGF5bG9hZCI6eyJhY3Rpb24iOiJ2b3VjaGVyIiwiY2hhbm5lbElkIjoiMHhhYmMiLCJjdW11bGF0aXZlQW1vdW50IjoiMTAwIiwic2lnbmF0dXJlIjoiMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIn19');
});

test('dispatcher: compute_valid_before oracles + expires errors', () => {
  assert.equal(disp.computeValidBefore({}, 1000), '1300');
  assert.equal(disp.computeValidBefore({ expires: '1970-01-01T00:10:00Z' }, 0), '660');
  assert.equal(disp.computeValidBefore({ expires: '1970-01-01T00:01:40Z' }, 0), '300');
  assert.equal(errMsg(() => disp.computeValidBefore({ expires: '1970-01-01T00:01:40Z' }, 1000)), 'challenge.expires is already in the past');
  assert.equal(errMsg(() => disp.computeValidBefore({ expires: 'garbage' }, 0)), 'challenge.expires is not RFC3339: garbage: premature end of input');
  assert.equal(errMsg(() => disp.computeValidBefore({ expires: '1969-12-31T23:59:59Z' }, 0)), 'challenge.expires is before Unix epoch: 1969-12-31T23:59:59Z');
  assert.equal(disp.computeValidBefore({ expires: 5 }, 10), '310');   // non-string → ignored
});

test('dispatcher: chrono RFC3339 parser error texts', () => {
  assert.equal(rs.parseRfc3339('2026-01-01T00:00:00Z'), 1767225600n);
  assert.equal(rs.parseRfc3339('1970-01-01T01:00:00+01:00'), 0n);
  assert.equal(rs.parseRfc3339('2026-01-01t00:00:00.123456789123z'), 1767225600n);
  for (const [s, m] of [['2026-13-01T00:00:00Z', 'input is out of range'], ['2026-02-30T00:00:00Z', 'input is out of range'], ['2026-01-01T00:00:00', 'premature end of input'],
    ['2026-01-01T00:00:00Zx', 'trailing input'], ['2026-01-01T00:00:00+24:00', 'input is out of range'], ['2026/01/01T00:00:00Z', 'input contains invalid characters'],
    ['tomorrow', 'premature end of input'], ['x'.repeat(18), 'premature end of input'], ['x'.repeat(19), 'input contains invalid characters'],
    ['2026-01-01T00:00:00−01:00', 'input contains invalid characters'], ['2021-02-29T00:00:00Z', 'input is out of range']]) {
    assert.equal(errMsg(() => rs.parseRfc3339(s)), m, s);
  }
});

test('dispatcher: compute_primary_split_amounts', () => {
  const r = (a, splits) => ({ amount: a, methodDetails: splits === undefined ? {} : { splits } });
  const R1 = '0x' + '11'.repeat(20), R2 = '0x' + '22'.repeat(20);
  assert.deepEqual(disp.computePrimarySplitAmounts(r('100'), 196), ['100', []]);
  assert.equal(disp.computePrimarySplitAmounts(r('1000000', [{ amount: '50000', recipient: R1 }, { amount: '10000', recipient: R2 }]), 196)[0], '940000');
  assert.equal(disp.computePrimarySplitAmounts(r('100', [{ amount: '30', recipient: R1 }, { amount: '20', recipient: R2 }]), 196)[0], '50');
  const xko = disp.computePrimarySplitAmounts(r('100', [{ amount: '1', recipient: 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }]), 196)[1][0];
  assert.deepEqual([xko.canonical, xko.display], ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed']);
  assert.match(errMsg(() => disp.computePrimarySplitAmounts(r('100', [{ amount: '1', recipient: 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }]), 1)), /^splits\[0\]\.recipient: XKO-prefixed addresses are only supported on X Layer/);
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts(r('100', [{ amount: '100', recipient: R1 }]), 196)), 'splits sum (100) must be strictly less than challenge amount (100) per spec §Constraints');
  assert.throws(() => disp.computePrimarySplitAmounts(r('100', [{ amount: '101', recipient: R1 }]), 196));
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts(r('100', [{ amount: '0', recipient: R1 }]), 196)), 'splits[0].amount must be > 0');
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts(r('100', []), 196)), 'challenge methodDetails.splits is present but empty (spec requires >= 1 entry)');
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts(r('100', Array(11).fill({ amount: '1', recipient: R1 })), 196)), 'challenge splits count 11 exceeds spec max of 10');
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts(r('1.5'), 196)), "challenge amount '1.5' is not a base-10 integer: invalid digit: .");
  assert.equal(errMsg(() => disp.computePrimarySplitAmounts({}, 196)), "missing 'amount' in challenge request");
});

test('dispatcher: channelId / open nonce / topup nonce (ABI encode + keccak)', () => {
  const [a1, a2, a3, a4, a5] = ['11', '22', '33', '44', '55'].map((b) => '0x' + b.repeat(20));
  assert.equal(disp.computeChannelId(a1, a2, a3, '0x' + '44'.repeat(32), a1, a5, 196), '0xa38cd33d0b42b9654d5077dccc63849159206c9da56748d8d225a1c79100e2b2');
  assert.notEqual(disp.computeChannelId(a1, a2, a3, '0x' + '45'.repeat(32), a1, a5, 196), '0xa38cd33d0b42b9654d5077dccc63849159206c9da56748d8d225a1c79100e2b2');
  assert.match(errMsg(() => disp.computeChannelId(a1, a2, a3, '0x1234', a1, a5, 196)), /32 bytes/);
  assert.match(errMsg(() => disp.computeChannelId('0xzz', a2, a3, '0x' + '44'.repeat(32), a1, a5, 196)), /^invalid payer address: /);
  // open nonce: head(5 static + 2 offsets) + two dynamic arrays — cross-check against a hand-built ABI blob
  const { keccak256 } = rs.__keccak ?? {};
  void keccak256;
  const zero = '0x' + '0'.repeat(40);
  const n0 = disp.computeOpenNonce(a1, a2, a3, '0x' + '44'.repeat(32), zero, [], []);
  const n1 = disp.computeOpenNonce(a1, a2, a3, '0x' + '44'.repeat(32), zero, [a4], [250]);
  assert.match(n0, /^0x[0-9a-f]{64}$/); assert.notEqual(n0, n1);
  assert.equal(errMsg(() => disp.computeOpenNonce(a1, a2, a3, 'zz', zero, [], [])), "salt must be hex: Invalid character 'z' at position 0");
  const t = disp.computeTopupNonce(a1, '0x' + 'ab'.repeat(32), '1000', '0x' + 'cd'.repeat(32));
  assert.match(t, /^0x[0-9a-f]{64}$/);
  assert.equal(errMsg(() => disp.computeTopupNonce(a1, '0xabc', '1', '0x' + 'cd'.repeat(32))), 'channelId must be hex: Odd number of digits');
  assert.equal(errMsg(() => disp.computeTopupNonce(a1, '0x' + 'ab'.repeat(31), '1', '0x' + 'cd'.repeat(32))), 'channelId must be 32 bytes (64 hex chars)');
  assert.equal(errMsg(() => disp.computeTopupNonce(a1, '0x' + 'ab'.repeat(32), '1.5', '0x' + 'cd'.repeat(32))), 'additionalDeposit must be decimal uint128: invalid digit found in string');
});

test('dispatcher: open nonce matches a hand-built abi.encode', async () => {
  const { keccak256 } = await import('../../skill/onchainos-lite/lib/crypto/keccak.mjs');
  const w = (h) => h.replace(/^0x/, '').padStart(64, '0');
  const [a1, a2, a3, a4] = ['11', '22', '33', '44'].map((b) => '0x' + b.repeat(20));
  const salt = '44'.repeat(32), zero = '0x' + '0'.repeat(40);
  const enc = [w(a1), w(a2), w(a3), salt, w(zero), w('e0'), w((0xe0 + 32 + 32).toString(16)), w('1'), w(a4), w('1'), w('fa')].join('');
  assert.equal(disp.computeOpenNonce(a1, a2, a3, '0x' + salt, zero, [a4], [250]), hex(keccak256(Buffer.from(enc, 'hex'))));
  const enc2 = [w('ab'.repeat(32)), w('3e8'), w(a1), 'cd'.repeat(32)].join('');
  assert.equal(disp.computeTopupNonce(a1, '0x' + 'ab'.repeat(32), '1000', '0x' + 'cd'.repeat(32)), hex(keccak256(Buffer.from(enc2, 'hex'))));
});

test('dispatcher: session splits / normalize_bytes32 / voucher helpers', () => {
  const R = '0x' + '11'.repeat(20);
  assert.deepEqual(disp.parseSessionSplits({ methodDetails: { splits: [{ recipient: R, bps: 250 }] } }, 196), [[R], [250]]);
  assert.deepEqual(disp.parseSessionSplits({}, 196), [[], []]);
  assert.equal(errMsg(() => disp.parseSessionSplits({ methodDetails: { splits: [{ recipient: R, bps: 0 }] } }, 196)), 'splits[0].bps out of range 1-9999: 0');
  assert.equal(errMsg(() => disp.parseSessionSplits({ methodDetails: { splits: [{ recipient: R, bps: '1' }] } }, 196)), 'splits[0].bps missing or not integer');
  assert.equal(disp.normalizeBytes32Hex('0x' + 'AB'.repeat(32), '--salt'), '0x' + 'ab'.repeat(32));
  assert.equal(errMsg(() => disp.normalizeBytes32Hex('0x12', '--tx-hash')), '--tx-hash must be 32 bytes (0x + 64 hex chars), got 2 chars');
  assert.equal(errMsg(() => disp.normalizeBytes32Hex('0x' + 'zz'.repeat(32), '--salt')), '--salt contains non-hex characters');
  const td = disp.buildVoucherTypedData('0x' + 'ab'.repeat(32), '250000', '0x' + '55'.repeat(20), 196);
  assert.equal(td.domain.name, 'EVM Payment Channel'); assert.equal(td.domain.version, '1'); assert.equal(td.domain.chainId, 196);
  assert.deepEqual(td.types.Voucher, [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }]);
  assert.equal(td.types.EIP712Domain.length, 4); assert.equal(td.primaryType, 'Voucher'); assert.equal(td.message.cumulativeAmount, '250000');
  assert.equal(disp.voucherAdvancesCumulative(50, 150, 200), true);
  assert.equal(disp.voucherAdvancesCumulative(200, 200, 200), true);
  assert.equal(disp.voucherAdvancesCumulative(50, 250, 200), false);
  assert.equal(disp.voucherAdvancesCumulative(50, 250, null), true);
  assert.equal(disp.voucherAdvancesCumulative(0, 100, 200), false);
  assert.deepEqual(disp.sessionOpenParams('0xc', '100', '0'), { action: 'open', channel_id: '0xc', cumulative_amount: '0', unit_amount: '0', deposit: '100' });
});

// ── payment_flow.rs ──────────────────────────────────────────────────────────
test('payment_flow: select_accept_with_preference', () => {
  const acc = [{ scheme: 'aggr_deferred', asset: '0xA', network: 'eip155:1' }, { scheme: 'exact', asset: '0xB', network: 'eip155:196' }, { scheme: 'upto', asset: '0xC', network: 'eip155:196' }];
  assert.deepEqual(flow.selectAcceptWithPreference(acc, null), [acc[1], 'exact']);
  assert.deepEqual(flow.selectAcceptWithPreference([acc[2], acc[0]], null), [acc[0], 'aggr_deferred']);
  assert.deepEqual(flow.selectAcceptWithPreference([acc[2]], null), [acc[2], 'upto']);
  assert.deepEqual(flow.selectAcceptWithPreference(acc, { asset: '0xC', network: 'eip155:196' }), [acc[2], 'upto']);
  assert.deepEqual(flow.selectAcceptWithPreference(acc, { asset: '0xC', network: 'eip155:1' }), [acc[1], 'exact']);
  assert.equal(errMsg(() => flow.selectAcceptWithPreference([], null)), 'accepts array is empty');
});

test('payment_flow: resolve_amount / resolve_entry / tier', () => {
  const e = { network: 'eip155:196', payTo: '0x' + '11'.repeat(20), asset: '0xA', maxAmountRequired: '77' };
  assert.equal(flow.resolveEntry(e, 'exact', null).amount, '77');
  assert.equal(flow.resolveEntry(e, 'exact', null).maxTimeoutSeconds, 300);
  assert.equal(flow.resolveEntry({ ...e, payTo: 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }, null, null).payTo, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.match(errMsg(() => flow.resolveEntry({ ...e, network: 'eip155:1', payTo: 'XKO5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }, null, null)), /^accepts\.payTo: XKO-prefixed/);
  const tiered = { amount: { basic: '100', premium: 500 } };
  assert.equal(flow.resolveAmount(tiered, 'basic'), '100');
  assert.equal(flow.resolveAmount(tiered, 'premium'), '500');
  assert.equal(errMsg(() => flow.resolveAmount(tiered, null)), 'accepts.amount is a tiered object ({basic, premium}) but no tier was specified');
  assert.equal(errMsg(() => flow.resolveAmount({ amount: { basic: '1' } }, 'premium')), "accepts.amount is missing 'premium' key");
  assert.equal(errMsg(() => flow.resolveAmount({ amount: { basic: true } }, 'basic')), 'accepts.amount.basic must be a string or number');
  assert.equal(flow.resolveAmount({ amount: 12 }, 'basic'), '12');
  assert.equal(errMsg(() => flow.resolveAmount({}, null)), "missing 'amount' or 'maxAmountRequired' in accepts entry");
  assert.equal(errMsg(() => flow.resolveEntry({}, null, null)), "missing 'network' in accepts entry");
  assert.equal(errMsg(() => flow.resolveEntry({ network: 'base', amount: '1', payTo: 'x' }, null, null)), "network 'base' is not a CAIP-2 EVM identifier (eip155:<id>)");
  assert.equal(errMsg(() => flow.resolveEntry({ network: 'eip155:x', amount: '1', payTo: 'x' }, null, null)), "network 'eip155:x' has non-numeric chain id: invalid digit found in string");
  const [entry, params] = flow.prepareResolvedEntry([{ scheme: 'exact', network: 'eip155:196', payTo: '0x' + '11'.repeat(20), asset: '0xA', amount: { basic: '5', premium: '9' } }], 'premium', null);
  assert.equal(entry.amount, '9'); assert.equal(params.amount, '9');
  assert.equal(flow.PaymentTier.fromServerStr('BASIC'), 'basic');
  assert.equal(flow.PaymentTier.fromServerStr('gold'), null);
  assert.equal(flow.parseEip155ChainId('eip155:8453'), 8453);
  assert.match(errMsg(() => flow.parseEip155ChainId('eip155:-1')), /invalid chain ID '-1'/);
  assert.match(errMsg(() => flow.parseEip155ChainId('solana:1')), /eip155:/);
});

test('payment_flow: detect_permit2_route / timing+nonce', () => {
  const r = (scheme, atm) => flow.detectPermit2Route({ extra: atm === undefined ? {} : { assetTransferMethod: atm } }, { scheme });
  assert.deepEqual(r('upto'), [true, false]);
  assert.deepEqual(r('EXACT', 'Permit2'), [false, true]);
  assert.deepEqual(r('exact', 'eip3009'), [false, false]);
  assert.deepEqual(r('exact'), [false, false]);
  const now = Math.floor(Date.now() / 1000);
  const [va, dl, n1] = flow.permit2TimingAndNonce(60);
  assert.ok(Math.abs(Number(va) - (now - 600)) <= 2); assert.ok(Math.abs(Number(dl) - (now + 60)) <= 2);
  assert.match(n1, /^\d+$/); assert.notEqual(n1, flow.permit2TimingAndNonce(60)[2]);
});

test('payment_flow: proof JSON / v2 header / pay_with_header_json', () => {
  const auth = { from: '0xPayer', to: '0xTo', value: '1', validAfter: '0', validBefore: '9', nonce: '0x01' };
  const p = flow.PaymentProof.eip3009({ signature: '0xsig', authorization: auth });
  assert.equal(stringify(p.toPayJson()), '{"authorization":{"from":"0xPayer","nonce":"0x01","to":"0xTo","validAfter":"0","validBefore":"9","value":"1"},"signature":"0xsig"}');
  const d = flow.PaymentProof.eip3009({ signature: 'b64', authorization: auth, sessionCert: 'cert' });
  assert.equal(d.toPayJson().sessionCert, 'cert');
  const entry = { scheme: 'aggr_deferred', network: 'eip155:196', extra: { name: 'USDG' } };
  const [name, value] = flow.buildPaymentHeader(d, entry, 'https://web3.okx.com/api/v6/dex/market/price');
  assert.equal(name, 'PAYMENT-SIGNATURE');
  assert.equal(Buffer.from(value, 'base64').toString(), '{"accepted":{"extra":{"name":"USDG","sessionCert":"cert"},"network":"eip155:196","scheme":"aggr_deferred"},"payload":{"authorization":{"from":"0xPayer","nonce":"0x01","to":"0xTo","validAfter":"0","validBefore":"9","value":"1"},"signature":"b64"},"resource":{"mimeType":"application/json","url":"https://web3.okx.com/api/v6/dex/market/price"},"x402Version":2}');
  assert.equal(entry.extra.sessionCert, undefined);   // the caller's entry is not mutated
  const [, noExtra] = flow.assembleV2PaymentHeader(d, { scheme: 'aggr_deferred' }, { url: 'u', description: 'd' });
  assert.equal(JSON.parse(Buffer.from(noExtra, 'base64')).accepted.extra.sessionCert, 'cert');
  const p2 = flow.PaymentProof.permit2({ signature: '0xs', permit2Authorization: { from: '0xP2' } });
  assert.deepEqual(flow.payWithHeaderJson(p2, { scheme: 'exact' }, { url: 'u' }).wallet, '0xP2');
  assert.equal(stringify(Object.keys(flow.payWithHeaderJson(p, {}, null))), '["authorization_header","header_name","scheme","wallet"]');
  assert.equal(flow.payWithHeaderJson(p, {}, null).scheme, '');
  const sub = flow.PaymentProof.subscription({ terms: {}, permitSingle: {}, termsSignature: 'a', permitSingleSignature: 'b' });
  assert.equal(flow.payWithHeaderJson(sub, { scheme: 'period' }, {}).wallet, null);
});

const cand = (scheme, token, amount, mainnet, has) => ({
  scheme, acceptsIndex: 0, chainId: mainnet ? '8453' : '1952', chainName: mainnet ? 'Base' : 'X Layer Testnet', isMainnet: mainnet, tokenSymbol: token,
  amount, amountHuman: amount, decimals: 6, hasBalance: has, balanceStatus: has ? 'sufficient' : 'insufficient', availableAmount: has ? amount : '0',
  requiredAmount: amount, shortfall: has ? '0' : amount, depositAddress: '0xwallet', recommended: null,
});

test('payment_flow: rank_candidates business rules', () => {
  let [c, alt] = flow.rankCandidates([cand('exact', 'USDC', '10000', true, true), cand('aggr_deferred', 'USDC', '5000', true, true)]);
  assert.equal(c.length, 1); assert.equal(c[0].amount, '5000'); assert.equal(c[0].recommended, true); assert.equal(alt[0].recommended, false);
  [c] = flow.rankCandidates([cand('exact', 'DAI', '5000', false, true), cand('aggr_deferred', 'USDC', '5000', true, true)]);
  assert.equal(c[0].tokenSymbol, 'USDC');
  [c] = flow.rankCandidates([cand('exact', 'USDC', '5000', true, true), cand('aggr_deferred', 'DAI', '5000', true, true)]);
  assert.equal(c[0].scheme, 'aggr_deferred');
  [c, alt] = flow.rankCandidates([cand('exact', 'USDC', '5000', true, false), cand('aggr_deferred', 'DAI', '5000', true, false)]);
  assert.equal(c.length, 2); assert.ok(c.every((x) => x.recommended === null)); assert.equal(alt.length, 0);
  [c, alt] = flow.rankCandidates([cand('exact', 'USDC', '5000', true, true)]);
  assert.equal(c[0].recommended, true); assert.equal(alt.length, 0);
  [c] = flow.rankCandidates([cand('exact', 'USDC', '5000', true, false)]);
  assert.equal(c[0].recommended, null);
  const ins = { ...cand('exact', 'USDC', '10000', true, true), balanceStatus: 'insufficient', shortfall: '0.005' };
  [c, alt] = flow.rankCandidates([ins, cand('exact', 'USDC', '5000', true, true)]);
  assert.equal(c[0].balanceStatus, 'sufficient'); assert.equal(alt[0].shortfall, '0.005');
  assert.ok(flow.schemeRank('aggr_deferred') < flow.schemeRank('exact') && flow.schemeRank('exact') < flow.schemeRank('upto') && flow.schemeRank('upto') < flow.schemeRank('charge') && flow.schemeRank('charge') < flow.schemeRank('period'));
});

test('payment_flow: pay_confirming previews the entry the signer signs', () => {
  const winner = { ...cand('aggr_deferred', 'USDC', '5000', true, true), acceptsIndex: 1, amountHuman: '0.005', recommended: true };
  const exact = { ...cand('exact', 'USDC', '10000', true, true), acceptsIndex: 0, amountHuman: '0.01', recommended: false };
  const st = { payment_id: 'pay_x', decoded_challenge: { amountHuman: '0.005', recipient: '0xR' }, candidates: [winner, exact],
    accepts: [{ index: 0, scheme: 'exact', amount: '10000', asset: '0xA' }, { index: 1, scheme: 'aggr_deferred', amount: '5000', asset: '0xA' }, { index: 2, scheme: 'upto', amount: '7', asset: '0xB' }] };
  let c = flow.payConfirming(st, 0);
  assert.ok(c instanceof Confirming);
  assert.equal(c.msg, 'Will pay 0.01 USDC (exact, Base) to 0xR - confirm to proceed');
  assert.equal(c.next, 'onchainos payment pay --payment-id pay_x --selected-index 0 --yes');
  c = flow.payConfirming(st, null);
  assert.equal(c.msg, 'Will pay 0.005 USDC (aggr_deferred, Base) to 0xR - confirm to proceed');
  assert.equal(c.next, 'onchainos payment pay --payment-id pay_x --yes');
  assert.equal(flow.payConfirming(st, 2).msg, 'Will pay up to 7 0xB (upto) to 0xR - confirm to proceed');
  assert.equal(flow.payConfirming({ ...st, candidates: [] }, 9).msg, 'Will pay 0.005 to 0xR - confirm to proceed');
});

test('payment_flow: parse_kv / retry classifier / replay mapping / param overrides', () => {
  assert.deepEqual(flow.parseKv(['a=1', ' b =x=y', 'c=']), [['a', '1'], ['b', 'x=y'], ['c', '']]);
  assert.equal(errMsg(() => flow.parseKv(['novalue'])), "invalid_input: --param must be key=value, got 'novalue'");
  assert.equal(errMsg(() => flow.parseKv([' =1'])), 'invalid_input: --param key must not be empty');
  assert.ok(flow.isRetryableA2mcpSigningAuthorizationError(new Error('payment sign-msg failed: code=1 msg=x')));
  assert.ok(flow.isRetryableA2mcpSigningAuthorizationError(new Error('Missing msgHash in gen-msg-hash response')));
  assert.ok(!flow.isRetryableA2mcpSigningAuthorizationError(new Error('not logged in')));
  const rcpt = Buffer.from('{"success":true,"transaction":"0xabc","network":"eip155:196","payer":"0xp"}').toString('base64');
  assert.deepEqual(flow.mapReplayParts(200, rcpt, { ok: 1 }), ['success', '0xabc', { ok: 1 }, null, { amount: '', chainId: 'eip155:196', payer: '0xp', status: 'success', transaction: '0xabc' }]);
  assert.deepEqual(flow.mapReplayParts(402, null, 'x').slice(0, 4), ['pending', null, 'x', 'facilitator non-terminal: HTTP 402']);
  assert.deepEqual(flow.mapReplayParts(500, 'garbage!!', null), ['failed', null, null, 'merchant returned HTTP 500', null]);
  assert.equal(stringify(flow.applyParamOverrides({ q: 'hello', keep: 'x' }, [['q', 'world'], ['n', '5']], { properties: { n: { type: 'integer' } } })), '{"keep":"x","n":5,"q":"world"}');
});

test('payment_flow: fetch_session decision oracles', async () => {
  let d = await flow.fetchSession({ action: 'close', deposit: '100000', cumulative_amount: '40000', unit_amount: '0' });
  assert.equal(d.refund, '60000'); assert.equal(d.cumulative_amount, '40000');
  d = await flow.fetchSession({ action: 'voucher', cumulative_amount: '100', unit_amount: '50', deposit: '1000', reuse_signature: '0x1' });
  assert.equal(d.strategy, 'reuse'); assert.equal(d.cumulative_amount, '150'); assert.equal(d.needsTopUp, false);
  d = await flow.fetchSession({ action: 'voucher', cumulative_amount: '40', unit_amount: '20', deposit: '50' });
  assert.equal(d.strategy, 'topup'); assert.equal(d.needsTopUp, true); assert.equal(d.recovery, 'amount_exceeds_deposit');
  d = await flow.fetchSession({ action: 'voucher', cumulative_amount: '100', unit_amount: '20', server_cumulative: '130' });
  assert.equal(d.strategy, 'sign'); assert.equal(d.cumulative_amount, '150'); assert.match(d.reason_text, /70015/);
  d = await flow.fetchSession({ action: 'open', channel_id: '0xc', cumulative_amount: '0', unit_amount: '0', deposit: '100' });
  assert.equal(stringify(d), '{"cumulative_amount":"0","needsTopUp":false,"reason_text":"voucher delta is zero — nothing to authorize","recovery":"delta_too_small","sessionSnapshot":{"channelId":"0xc","cumulative":"0","deposit":"100"},"strategy":"sign"}');
  assert.equal(flow.needsTopUp(40n, 20n, 50n), true);
  assert.equal(flow.computeRefund(10n, 20n), 0n);
  assert.equal(flow.classifyRecovery(1n, 0n, 10n), 'delta_too_small');
  assert.equal(flow.classifyRecovery(1n, 1n, 10n), null);
});

test('payment_flow: read_private_key (env, $HOME/.env, errors)', () => {
  process.env.EVM_PRIVATE_KEY = '0xabc';
  assert.equal(flow.readPrivateKey(), '0xabc');
  delete process.env.EVM_PRIVATE_KEY;
  assert.match(errMsg(() => flow.readPrivateKey()), /^Wallet not logged in and no EVM_PRIVATE_KEY configured\. Either run `onchainos wallet login`, or create .*\.env with a line `EVM_PRIVATE_KEY=0x<hex_key>`\.: /);
  writeFileSync(join(HOME, '.env'), 'FOO=1\r\n  EVM_PRIVATE_KEY=\nEVM_PRIVATE_KEY=0x22  \n');
  assert.equal(flow.readPrivateKey(), '0x22');
  writeFileSync(join(HOME, '.env'), 'FOO=1\n');
  assert.match(errMsg(() => flow.readPrivateKey()), /^EVM_PRIVATE_KEY not found in .*\.env$/);
  writeFileSync(join(HOME, '.env'), '');
});

test('payment_flow: local EIP-3009 signing (pay-local) + aggr_deferred filtering + key errors', async () => {
  const entry = { scheme: 'exact', network: 'eip155:196', amount: '1000000', payTo: '0x' + '11'.repeat(20), asset: '0x' + '22'.repeat(20), maxTimeoutSeconds: 300, extra: { name: 'USDG', version: '1' } };
  process.env.EVM_PRIVATE_KEY = '0x' + '11'.repeat(32);
  try {
    const [proof, sel] = await flow.signPaymentLocal([{ ...entry, scheme: 'aggr_deferred' }, entry], null);
    assert.equal(sel.scheme, 'exact');
    const a = proof.authorization;
    assert.equal(a.from, PK_ADDR); assert.equal(a.validAfter, '0'); assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
    const types = { TransferWithAuthorization: [['from', 'address'], ['to', 'address'], ['value', 'uint256'], ['validAfter', 'uint256'], ['validBefore', 'uint256'], ['nonce', 'bytes32']].map(([name, type]) => ({ name, type })) };
    const h = signingHash({ types, primaryType: 'TransferWithAuthorization', domain: { name: 'USDG', version: '1', chainId: 196, verifyingContract: entry.asset }, message: a });
    const sig = Buffer.from(proof.signature.slice(2), 'hex');
    assert.equal(sig.length, 65); assert.ok(sig[64] >= 27);
    assert.equal(recoverAddress(h, sig), PK_ADDR);
    assert.equal(await errMsgAsync(() => flow.signPaymentLocal([{ ...entry, scheme: 'aggr_deferred' }], null)), 'aggr_deferred requires a TEE session key — not supported in local-key mode. Run `onchainos wallet login` to enable TEE signing.');
    assert.equal(await errMsgAsync(() => flow.signPaymentLocal([{ ...entry, extra: {} }], null)), "missing 'extra.name' (EIP-712 domain name) in accepts entry");
    assert.equal(await errMsgAsync(() => flow.signPaymentLocal([{ ...entry, amount: '1.5' }], null)), 'amount not a valid integer: invalid digit: .');
    process.env.EVM_PRIVATE_KEY = '0x1234';
    assert.equal(await errMsgAsync(() => flow.signPaymentLocal([entry], null)), 'EVM_PRIVATE_KEY must be 32 bytes (64 hex chars), got 2');
    process.env.EVM_PRIVATE_KEY = 'zz';
    assert.equal(await errMsgAsync(() => flow.signPaymentLocal([entry], null)), "EVM_PRIVATE_KEY is not valid hex: Invalid character 'z' at position 0");
    process.env.EVM_PRIVATE_KEY = '0x' + '00'.repeat(32);
    assert.match(await errMsgAsync(() => flow.signPaymentLocal([entry], null)), /^invalid secp256k1 private key: /);
  } finally { delete process.env.EVM_PRIVATE_KEY; }
});

// ── decode_receipt.rs / http_carrier.rs ─────────────────────────────────────
test('decode_receipt: normalize + header precedence + invalid input', () => {
  assert.equal(stringify(receipt.fetchDecodeReceipt(null, '{"status":"success","txHash":"0xdef456","amount":"10000","from":"0xfrom","chainId":"196"}')), '{"amount":"10000","chainId":"196","payer":"0xfrom","status":"success","transaction":"0xdef456"}');
  assert.equal(stringify(receipt.fetchDecodeReceipt('eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4YWJjMTIzIiwibmV0d29yayI6Ijg0NTMiLCJwYXllciI6IjB4cGF5ZXIifQ==', null)), '{"amount":"","chainId":"8453","payer":"0xpayer","status":"success","transaction":"0xabc123"}');
  assert.equal(receipt.fetchDecodeReceipt(null, '{"success":false,"transaction":"0x0"}').status, 'failed');
  assert.equal(receipt.fetchDecodeReceipt(null, '{}').status, 'unknown');
  const r = receipt.fetchDecodeReceipt(null, '{"status":"success","transactionHash":"0xaaa","value":"42","from":"0xf","chainId":8453}');
  assert.deepEqual([r.chainId, r.amount, r.transaction], ['8453', '42', '0xaaa']);
  assert.equal(receipt.fetchDecodeReceipt(null, '{"amount":1.5,"status":""}').amount, '1.5');
  assert.equal(receipt.fetchDecodeReceipt('  ', '{"status":"x"}').status, 'x');
  for (const [h, rc] of [[null, '{bad json'], [null, '  '], [null, null], ['@@@', '{"status":"x"}']]) assert.equal(errMsg(() => receipt.fetchDecodeReceipt(h, rc)), 'invalid_input: could not decode receipt');
});

test('http_carrier: carriers, percent-encoding, typed requests', () => {
  assert.ok(carrier.isBodyBearing('put') && carrier.isBodyBearing('Patch') && !carrier.isBodyBearing('HEAD'));
  assert.equal(carrier.carrierFor('orderId', [], false), 'query');
  assert.equal(carrier.carrierFor('orderId', [], true), 'body');
  assert.equal(carrier.carrierFor('orderId', [{ name: 'orderId', carrier: 'header' }], true), 'header');
  assert.equal(carrier.percentEncodeNonAlnum('a b/c?d#e&f'), 'a%20b%2Fc%3Fd%23e%26f');
  assert.equal(carrier.percentEncodeNonAlnum('-._~é'), '%2D%2E%5F%7E%C3%A9');
  let r = carrier.buildRequest('get', 'https://m.example/orders/{id}?x=1', [['id', '4 2'], ['q', 'a b*'], ['h', 'v']], [{ name: 'id', carrier: 'path' }, { name: 'h', carrier: 'header' }]);
  assert.equal(r.method, 'GET'); assert.equal(r.url, 'https://m.example/orders/4%202?x=1&q=a+b*'); assert.deepEqual(r.headers, [['h', 'v']]);
  r = carrier.buildRequest('post', 'https://m.example/x', [['b', '1'], ['a', '2']], []);
  assert.equal(r.body, '{"a":"2","b":"1"}'); assert.deepEqual(r.headers[0], ['content-type', 'application/json']);
  r = carrier.buildRequest('POST', 'https://m.example/x', [], []);
  assert.equal(r.body, undefined);
  r = carrier.buildTypedRequest('POST', 'https://m.example/x', { count: 2, enabled: true, filter: { kind: 'book' } }, []);
  assert.equal(r.body, '{"count":2,"enabled":true,"filter":{"kind":"book"}}');
  assert.equal(carrier.buildTypedRequest('POST', 'https://m.example/x', {}, []).body, '{}');
  r = carrier.buildTypedRequest('GET', 'https://m.example/u/{id}', { id: 7, q: null, tenant: 'alpha' }, [{ name: 'id', carrier: 'path' }, { name: 'tenant', carrier: 'header' }]);
  assert.equal(r.url, 'https://m.example/u/7?q=null'); assert.deepEqual(r.headers, [['tenant', 'alpha']]);
  assert.equal(errMsg(() => carrier.buildTypedRequest('GET', 'https://x/', { b: 1 }, [{ name: 'b', carrier: 'body' }])), "a2mcp_invalid_typed_params: body parameter 'b' is invalid for GET");
  assert.equal(errMsg(() => carrier.buildTypedRequest('GET', 'https://x/', { q: [1] }, [])), "a2mcp_invalid_typed_params: non-body parameter 'q' must be scalar");
  assert.equal(errMsg(() => carrier.buildTypedRequest('GET', 'https://x/', { id: 1 }, [{ name: 'id', carrier: 'path' }])), "a2mcp_invalid_typed_params: path placeholder '{id}' is missing");
  assert.equal(errMsg(() => carrier.buildTypedRequest('G T', 'https://x/', {}, [])), 'a2mcp_invalid_typed_params: invalid HTTP method');
});

// ── quote.rs / mcp_client.rs ─────────────────────────────────────────────────
test('quote: params / probe errors / amounts / balances / plans', () => {
  assert.deepEqual(quote.parseParams(['orderId=42', 'note=hi there']), { orderId: '42', note: 'hi there' });
  assert.equal(errMsg(() => quote.parseParams(['noequals'])), "invalid_input: --param must be key=value, got 'noequals'");
  assert.equal(errMsg(() => quote.parseParams(['=v'])), 'invalid_input: --param key must not be empty');
  assert.deepEqual([401, 403, 500, 503, 404, 418].map(quote.classifyProbeError), ['auth_required', 'auth_required', 'endpoint_server_error', 'endpoint_server_error', 'endpoint_unreachable', 'endpoint_unreachable']);
  assert.deepEqual([['10000', 6], ['1000000', 6], ['1234567', 6], ['500', 0], ['', 6], ['0x1f', 2], ['000', 0]].map(([a, d]) => quote.humanAmount(a, d)), ['0.01', '1', '1.234567', '500', '0', '0.01', '0']);
  assert.equal(quote.humanToAtomic('0.08504764', 8), 8504764n);
  assert.equal(quote.humanToAtomic('1', 6), 1000000n);
  assert.equal(quote.humanToAtomic('.', 2), 0n);
  for (const bad of ['-1', '1e5', '1.1234567', 'abc', '']) assert.equal(quote.humanToAtomic(bad, 6), undefined, bad);
  const bal = [{ tokenAssets: [{ symbol: 'USDT', tokenContractAddress: '0xAbC', balance: '1.5' }, { symbol: 'OKB', tokenContractAddress: '', balance: '2' }] }];
  assert.equal(quote.candidateBalanceAtomic(bal, 'x', '0xabc', 6), 1500000n);
  // ruint parses "" as 0 (verified against the upstream binary) — an empty rawBalance wins over balance
  assert.equal(quote.candidateBalanceAtomic([{ tokenContractAddress: '0xabc', rawBalance: '', balance: '1' }], 'x', '0xabc', 6), 0n);
  assert.equal(quote.candidateBalanceAtomic(bal, 'USDT', '0xdef', 6), 0n);
  assert.equal(quote.candidateBalanceAtomic([{ symbol: 'usdt', balanceRawAmount: '42' }], 'USDT', '0xdef', 6), 42n);
  assert.equal(quote.candidateBalanceAtomic([{ symbol: 'USDT', balance: '-1' }], 'USDT', '', 6), undefined);
  assert.deepEqual(quote.missingParams('{"missingParams":["a","x"],"required":["z"]}', { x: '1' }, [{ name: 'p', required: true }, { name: 'a', required: true }, { name: 'o' }]), ['p', 'a']);
  assert.deepEqual(quote.missingParams('{"required":["z"]}', {}, []), ['z']);
  assert.deepEqual(quote.missingParams('not json', {}, []), []);
  assert.deepEqual(quote.parseParamPlan({ b: { carrier: 'HEADER', required: true, type: 'string' }, a: {} }), [{ name: 'a', carrier: 'query', required: false, type: '' }, { name: 'b', carrier: 'header', required: true, type: 'string' }]);
  assert.deepEqual(quote.parseParamPlan([{ name: 'x', carrier: 'path' }, { nope: 1 }]), [{ name: 'x', carrier: 'path', required: false, type: '' }]);
  assert.deepEqual(quote.findOutputSchema({ outputSchema: null }, '{"outputSchema":{"method":"POST"}}'), { method: 'POST' });
  assert.equal(quote.findOutputSchema({}, 'x'), undefined);
  assert.equal(quote.declaredDecimals({ extra: { decimals: '8' }, decimals: 2 }), 8);
  assert.equal(quote.declaredDecimals({ decimals: 2 }), 2);
  assert.equal(quote.declaredDecimals({ extra: { decimals: 'x' }, decimals: 2 }), undefined);
  assert.equal(quote.buildSummary([{ ...cand('upto', 'USDT', '1', true, true), amountHuman: '0.01', chainName: 'X Layer', recommended: null }], [], {}), 'Will pay up to 0.01 USDT (upto, X Layer)');
  assert.equal(quote.buildSummary([], [], { amountHuman: '3' }), 'Will pay 3');
  assert.match(quote.newPaymentId('https://x', 1), /^pay_[0-9a-f]{24}$/);
  assert.notEqual(quote.newPaymentId('https://x', 1, 5n), quote.newPaymentId('https://x', 1, 6n));
  assert.deepEqual(quote.buildAccepts([{ scheme: 'exact', amount: { basic: '1' }, asset: '0xA' }, 5]), [{ index: 0, scheme: 'exact', amount: '', asset: '0xA', network: '' }, { index: 1, scheme: '', amount: '', asset: '', network: '' }]);
});

test('mcp_client: URL heuristics, probe signal, coercion, streamable bodies', () => {
  for (const u of ['https://api.example.com/mcp', 'https://api.example.com/sse/', 'https://api.example.com/api/sse?token=x', 'HTTPS://API.EXAMPLE.COM/MCP', 'https://api.example.com/mcp#section']) assert.ok(mcp.urlLooksLikeMcp(u), u);
  for (const u of ['https://api.example.com/mcphammer', 'https://api.example.com/pay', 'https://api.example.com/']) assert.ok(!mcp.urlLooksLikeMcp(u), u);
  assert.ok(mcp.probeSignalsMcp('text/event-stream; charset=utf-8', ''));
  assert.ok(mcp.probeSignalsMcp('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}'));
  assert.ok(!mcp.probeSignalsMcp('application/json', '{"ok":1}'));
  assert.equal(stringify(mcp.coerceArguments({ n: '5', f: '1.5', b: 'true', bb: 'yes', o: '{"a":1}', s: '7', bad: 'x' }, { properties: { n: { type: 'integer' }, f: { type: 'number' }, b: { type: 'boolean' }, bb: { type: 'boolean' }, o: { type: 'object' }, bad: { type: 'integer' } } })),
    '{"b":true,"bad":"x","bb":"yes","f":1.5,"n":5,"o":{"a":1},"s":"7"}');
  assert.equal(mcp.parseStreamableBody('event: message\ndata: {"jsonrpc":"2.0","method":"progress"}\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n').result.ok, true);
  assert.equal(errMsg(() => mcp.parseStreamableBody('nothing')), 'endpoint_unreachable: no JSON-RPC result/error in MCP response');
  assert.equal(errMsg(() => mcp.jsonrpcResult({ error: { code: -32601, message: 'nope' } })), 'endpoint_unreachable: JSON-RPC error -32601: nope');
  assert.equal(errMsg(() => mcp.jsonrpcResult({ error: {} })), 'endpoint_unreachable: JSON-RPC error: unknown JSON-RPC error');
  assert.equal(mcp.httpError('initialize', 500, 'x'.repeat(501)).message, `endpoint_unreachable: initialize returned HTTP 500: ${'x'.repeat(500)}…`);
  assert.equal(mcp.httpError('tools/list', 404, '  ').message, 'endpoint_unreachable: tools/list returned HTTP 404');
  assert.deepEqual(mcp.decodeMcpTool({ description: null, extra: 1 }), { name: '', description: undefined, inputSchema: undefined });
  assert.equal(mcp.decodeMcpTool({ name: 5 }), null);
});

// ── state.rs / payment cache ─────────────────────────────────────────────────
test('state: compute_expires_at, write/read round-trip, owner + TTL guards', () => {
  assert.equal(state.computeExpiresAt(0, 1000), 1300);
  assert.equal(state.computeExpiresAt(1100, 1000), 1100);
  assert.equal(state.computeExpiresAt(5000, 1000), 1300);
  const st = {
    payment_id: 'pay_unit0001', owner_wallet: 'acct', created_at: 1, expires_at: 4102444800, accepts: [{ index: 0, scheme: 'exact', amount: '1', asset: '0xA', network: 'eip155:196' }],
    decoded_challenge: { amount: '1', amountHuman: '0.000001', decimals: 6, recipient: '0xR', expires: 0, supported: true, unsupported_reason: null },
    candidates: [cand('exact', 'USDT', '1', true, false)], known_params: { b: '2', a: '1' }, merchant_body: '', endpoint_url: 'https://m/x',
    raw_accepts: [{ scheme: 'exact' }], resource: null, method: 'GET', param_plan: [{ name: 'a', carrier: 'query', required: false, type: '' }],
  };
  state.writeState(st);
  const text = readFileSync(join(HOME, 'payments', 'pay_unit0001.json'), 'utf8');
  assert.ok(text.startsWith('{\n  "payment_id": "pay_unit0001",\n  "owner_wallet": "acct",'));
  assert.ok(text.includes('"resource": null') && !text.includes('mcpTool') && text.includes('"known_params": {\n    "a": "1",\n    "b": "2"\n  }'));
  const back = state.read('pay_unit0001', 'acct', 2);
  assert.equal(back.resource, undefined);   // Option<Value>: null → None
  assert.equal(back.candidates[0].tokenSymbol, 'USDT');
  assert.equal(errMsg(() => state.read('pay_unit0001', 'other', 2)), 'cross_user_payment_id: pay_unit0001');
  assert.equal(errMsg(() => state.read('pay_unit0001', 'acct', 4102444801)), 'quote_expired_or_missing: pay_unit0001');
  assert.ok(!existsSync(join(HOME, 'payments', 'pay_unit0001.json')));
  writeFileSync(join(HOME, 'payments', 'pay_bad.json'), '{"payment_id":1}');
  assert.equal(errMsg(() => state.read('pay_bad', '', 0)), 'quote_expired_or_missing: pay_bad');
});

test('payment cache: strict load, struct-order save, default set/get/unset', () => {
  writeFileSync(join(HOME, 'payment_cache.json'), '{"basic_state":"charging_unconfirmed","premium_state":"charging_unconfirmed","endpoints":{"/p":"basic"}}');
  assert.equal(stringify(disp.cmdDefault({ kind: 'set', asset: ' 0x1234567890123456789012345678901234567890 ', chain: '196', name: ' ', tier: 'Basic' })), '{"asset":"0x1234567890123456789012345678901234567890","chain":"196","name":null}');
  const saved = readFileSync(join(HOME, 'payment_cache.json'), 'utf8');
  assert.equal(saved, '{"endpoints":{"/p":"basic"},"accepts":null,"basic_state":"charging_confirmed","premium_state":"charging_unconfirmed","updated_at":0,"user_type":null,"intro_shown":false,"grace_shown":false,"default_asset":{"asset":"0x1234567890123456789012345678901234567890","network":"eip155:196"},"local_signing_warned":false}');
  assert.equal(stringify(disp.cmdDefault({ kind: 'get' })), '{"asset":"0x1234567890123456789012345678901234567890","chain":"196","name":null}');
  assert.equal(disp.cmdDefault({ kind: 'unset' }), EMPTY);
  assert.equal(disp.cmdDefault({ kind: 'get' }), EMPTY);
  writeFileSync(join(HOME, 'payment_cache.json'), '{"basic_state":"bogus"}');
  assert.equal(pcache.load(), null);
  assert.equal(errMsg(() => disp.cmdDefault({ kind: 'set', asset: '0x1234567890123456789012345678901234567890', chain: '1', tier: 'gold' })), '--tier must be `basic` or `premium`');
  assert.equal(pcache.decodeCache({ updated_at: -1 }), null);
  assert.equal(pcache.decodeCache({ user_type: 'new', default_asset: ['0xA', 'eip155:1'] }).default_asset.network, 'eip155:1');
});

// ── TEE signing end to end against the stub wallet API ───────────────────────
const MSG_HASH = '0x' + 'ab'.repeat(32);
function teeRoutes() {
  STUB.log.length = 0;
  STUB.routes = {
    '/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash': ok([{ msgHash: MSG_HASH, domainHash: '0x' + 'cd'.repeat(32) }]),
    '/priapi/v5/wallet/agentic/pre-transaction/sign-msg': ok([{ signature: '0x' + 'ee'.repeat(65) }]),
  };
}
const X402_ENTRY = { scheme: 'exact', network: 'eip155:196', amount: '1000000', payTo: '0x' + '11'.repeat(20), asset: '0x' + '22'.repeat(20), maxTimeoutSeconds: 300, extra: { name: 'USDG', version: '1' } };

test('TEE: exact EIP-3009 (payment pay --payload) — gen-msg-hash → session sig → sign-msg', async () => {
  teeRoutes();
  const payload = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://api.example.com/data', mimeType: 'application/json' }, accepts: [X402_ENTRY] })).toString('base64');
  const out = await disp.cmdPay(payload, null);
  assert.equal(out.wallet, ACCOUNT1_EVM); assert.equal(out.scheme, 'exact'); assert.equal(out.header_name, 'PAYMENT-SIGNATURE');
  const [gen] = bodies('/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash');
  const [sign] = bodies('/priapi/v5/wallet/agentic/pre-transaction/sign-msg');
  assert.deepEqual(Object.keys(gen), ['chainIndex', 'from', 'nonce', 'to', 'validAfter', 'validBefore', 'value', 'verifyingContract']);
  assert.equal(gen.chainIndex, '196'); assert.equal(gen.from, ACCOUNT1_EVM); assert.equal(gen.validAfter, '0');
  assert.deepEqual(Object.keys(sign), ['chainIndex', 'domainHash', 'from', 'nonce', 'sessionCert', 'sessionSignature', 'to', 'validAfter', 'validBefore', 'value', 'verifyingContract']);
  assert.equal(Buffer.from(sign.sessionSignature, 'base64').length, 64);
  const header = JSON.parse(Buffer.from(out.authorization_header, 'base64'));
  assert.equal(header.payload.signature, '0x' + 'ee'.repeat(65));
  assert.equal(header.payload.authorization.nonce, gen.nonce);
  const auth = STUB.log.find((x) => x.path.endsWith('sign-msg')).headers.authorization;
  assert.match(auth, /^Bearer /);
});

test('TEE: aggr_deferred skips sign-msg and embeds sessionCert; missing msgHash / API error texts', async () => {
  teeRoutes();
  const [proof, entry] = await flow.signPaymentWithPreference([{ ...X402_ENTRY, scheme: 'aggr_deferred' }], null, null, null);
  assert.equal(proof.authorization.validBefore, ((1n << 256n) - 1n).toString());
  assert.ok(proof.sessionCert);
  assert.equal(bodies('/priapi/v5/wallet/agentic/pre-transaction/sign-msg').length, 0);
  assert.equal(JSON.parse(Buffer.from(flow.buildPaymentHeader(proof, entry, 'u')[1], 'base64')).accepted.extra.sessionCert, proof.sessionCert);
  STUB.routes['/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash'] = ok([{ domainHash: '0x1' }]);
  assert.equal(await errMsgAsync(() => flow.signPaymentWithPreference([X402_ENTRY], null, null, null)), 'missing msgHash in gen-msg-hash response');
  STUB.routes['/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash'] = { body: { code: '81001', msg: 'risky', data: [] } };
  assert.equal(await errMsgAsync(() => flow.signPaymentWithPreference([X402_ENTRY], null, null, null)), 'payment gen-msg-hash failed: code=81001 msg=risky');
  teeRoutes();
  STUB.routes['/priapi/v5/wallet/agentic/pre-transaction/sign-msg'] = ok([{}]);
  assert.equal(await errMsgAsync(() => flow.signPaymentWithPreference([X402_ENTRY], null, null, null)), 'missing signature in sign-msg response');
  assert.equal(await errMsgAsync(() => flow.signPaymentWithPreference([{ ...X402_ENTRY, network: 'eip155:999999' }], null, null, null)), 'chain not found for realChainIndex 999999');
});

test('TEE: permit2 exact + upto (typed data to TEE, allowance probe warns and continues)', async () => {
  teeRoutes();
  const [proof] = await flow.signPaymentWithPreference([{ ...X402_ENTRY, network: 'eip155:8453', extra: { assetTransferMethod: 'permit2' } }], null, null, null);
  assert.equal(proof.kind, 'Permit2');
  assert.equal(proof.permit2Authorization.spender, X402_EXACT_PERMIT2_PROXY);
  const [gen] = bodies('/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash');
  assert.equal(gen.chainIndex, '8453'); assert.equal(gen.payload[0].msgType, 'eip712'); assert.equal(gen.payload[0].message.primaryType, 'PermitWitnessTransferFrom');
  const [sign] = bodies('/priapi/v5/wallet/agentic/pre-transaction/sign-msg');
  assert.deepEqual(Object.keys(sign), ['chainIndex', 'from', 'payload', 'sessionCert', 'skipWarning']);
  assert.equal(sign.payload[0].signType, 'eip712');
  teeRoutes();
  assert.equal(await errMsgAsync(() => flow.signPaymentWithPreference([{ ...X402_ENTRY, scheme: 'upto', network: 'eip155:8453' }], null, null, null)), 'upto scheme requires extra.facilitatorAddress in the accepts entry, but it is missing or not a string');
  const [up] = await flow.signPaymentWithPreference([{ ...X402_ENTRY, scheme: 'upto', network: 'eip155:8453', extra: { facilitatorAddress: '0x' + 'fa'.repeat(20) } }], null, null, null);
  assert.equal(up.kind, 'Upto'); assert.equal(up.permit2Authorization.spender, X402_UPTO_PERMIT2_PROXY);
});

test('TEE: MPP charge transaction mode with splits (payment charge)', async () => {
  teeRoutes();
  const req = Buffer.from(JSON.stringify({ amount: '1000', currency: '0x' + '22'.repeat(20), recipient: '0x' + '11'.repeat(20), methodDetails: { chainId: 196, splits: [{ amount: '100', recipient: '0x' + '33'.repeat(20) }] } })).toString('base64url');
  const out = await disp.cmdMppCharge(`Payment id="1", realm="r", method="evm", intent="charge", request="${req}"`, null, null);
  assert.equal(out.mode, 'transaction'); assert.equal(out.wallet, ACCOUNT1_EVM);
  assert.equal(stringify(Object.keys(out)), '["protocol","method","intent","mode","authorization_header","wallet","challenge"]');
  const gens = bodies('/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash');
  assert.deepEqual(gens.map((g) => g.value), ['900', '100']);
  const signs = bodies('/priapi/v5/wallet/agentic/pre-transaction/sign-msg');
  assert.ok(signs.every((s) => s.skipWarning === true && s.signType === undefined));
  const cred = JSON.parse(Buffer.from(out.authorization_header.slice(8), 'base64url'));
  assert.equal(cred.source, `did:pkh:eip155:196:${ACCOUNT1_EVM}`);
  assert.equal(cred.payload.authorization.splits.length, 1);
  assert.equal(cred.payload.authorization.type, 'eip-3009');
  assert.equal(await errMsgAsync(() => disp.cmdMppCharge(`Payment id="1", realm="r", method="evm", intent="charge", request="${req}"`, null, '0x' + '11'.repeat(32))), '--tx-hash is only valid when challenge.methodDetails.feePayer=false');
  STUB.routes['/priapi/v5/wallet/agentic/pre-transaction/sign-msg'] = (() => { let n = 0; return () => (n++ === 0 ? ok([{ signature: '0x1' }]) : { body: { code: '5', msg: 'no', data: [] } }); })();
  assert.equal(await errMsgAsync(() => disp.cmdMppCharge(`Payment id="1", realm="r", method="evm", intent="charge", request="${req}"`, null, null)), 'splits[0] TEE sign failed: eip3009 sign-msg failed: code=5 msg=no');
});

test('TEE: receive-auth + voucher helpers (session building blocks)', async () => {
  teeRoutes();
  await disp.teeSignEip3009(disp.Eip3009AuthType.Receive, '196', ACCOUNT1_EVM, '0x' + '55'.repeat(20), '10', '99', '0x' + '00'.repeat(32), '0x' + '22'.repeat(20));
  assert.equal(bodies('/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash')[0].msgType, 'eip3009ReceiveAuth');
  const s = bodies('/priapi/v5/wallet/agentic/pre-transaction/sign-msg')[0];
  assert.equal(s.signType, 'eip3009ReceiveAuth'); assert.equal(s.msgType, undefined);
  teeRoutes();
  assert.equal(await disp.teeSignVoucher('196', ACCOUNT1_EVM, '0x' + 'ab'.repeat(32), '5', '0x' + '55'.repeat(20), 196), '0x' + 'ee'.repeat(65));
  const g = bodies('/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash')[0];
  assert.equal(stringify(g.payload[0].message.domain), '{"chainId":196,"name":"EVM Payment Channel","verifyingContract":"0x5555555555555555555555555555555555555555","version":"1"}');
  assert.deepEqual(await disp.resolveChainAndPayer(196, null), ['196', ACCOUNT1_EVM]);
  assert.equal(await errMsgAsync(() => disp.resolveChainAndPayer(999999, null)), 'chain not found for chainId 999999');
});

test('x402 auto-pay signer: TEE when logged in; resource = request URL', async () => {
  teeRoutes();
  const [name, value] = await x402.signHeaderFromAccepts({ accepts: [{ ...X402_ENTRY, amount: { basic: '7', premium: '9' } }], tier: 'premium', resource: `${BASE}/api/v6/dex/market/price` });
  const h = JSON.parse(Buffer.from(value, 'base64'));
  assert.equal(name, 'PAYMENT-SIGNATURE');
  assert.equal(h.accepted.amount, '9'); assert.equal(h.payload.authorization.value, '9');
  assert.deepEqual(h.resource, { mimeType: 'application/json', url: `${BASE}/api/v6/dex/market/price` });
});

// ── two-phase pay: confirming gate + signed replay to a stub merchant ─────────
function seedState(id, extra = {}) {
  const wallets = JSON.parse(readFileSync(join(HOME, 'wallets.json'), 'utf8'));
  mkdirSync(join(HOME, 'payments'), { recursive: true });
  state.writeState({
    payment_id: id, owner_wallet: wallets.selectedAccountId, created_at: 1, expires_at: 4102444800,
    accepts: [{ index: 0, scheme: 'exact', amount: '1000000', asset: X402_ENTRY.asset, network: 'eip155:196' }],
    decoded_challenge: { amount: '1000000', amountHuman: '1', decimals: 6, recipient: X402_ENTRY.payTo, expires: 0, supported: true, unsupported_reason: null },
    candidates: [{ ...cand('exact', 'USDG', '1000000', true, true), chainId: '196', chainName: 'X Layer', amountHuman: '1', recommended: true }],
    known_params: { q: 'quoted' }, merchant_body: '', endpoint_url: `${BASE}/merchant/{sku}`, raw_accepts: [X402_ENTRY],
    resource: { url: 'https://api.example.com/data' }, method: 'POST', param_plan: [{ name: 'sku', carrier: 'path', required: true, type: '' }], ...extra,
  });
}

test('two-phase pay: confirming gate, validation, success replay deletes state', async () => {
  seedState('pay_unit_ok');
  const e = await flow.fetchPay('pay_unit_ok', null, [], false).catch((x) => x);
  assert.ok(e instanceof Confirming);
  assert.equal(e.msg, `Will pay 1 USDG (exact, X Layer) to ${X402_ENTRY.payTo} - confirm to proceed`);
  assert.equal(await errMsgAsync(() => flow.fetchPay('pay_unit_ok', 3, [], true)), 'invalid_input: --selected-index 3 is out of range (accepts has 1 entry)');
  assert.equal(await errMsgAsync(() => flow.fetchPay('pay_unit_ok', null, ['novalue'], true)), "invalid_input: --param must be key=value, got 'novalue'");
  assert.equal(await errMsgAsync(() => flow.fetchPay('bad id!', null, [], true)), 'a2mcp_invalid_payment_intent: invalid payment id');
  teeRoutes();
  STUB.routes['/merchant/A 1'] = STUB.routes['/merchant/A%201'] = { status: 200, headers: { 'PAYMENT-RESPONSE': Buffer.from('{"success":true,"transaction":"0xfeed","network":"eip155:196"}').toString('base64') }, body: { data: 'paid' } };
  const out = await flow.fetchPay('pay_unit_ok', 0, ['sku=A 1', 'extra=x'], true);
  assert.equal(stringify(out), '{"decodedReceipt":{"amount":"","chainId":"eip155:196","payer":"","status":"success","transaction":"0xfeed"},"error":null,"ok":true,"paymentId":"pay_unit_ok","result":{"data":"paid"},"scheme":"exact","status":"success","txHash":"0xfeed"}');
  const m = STUB.log.find((x) => x.path.startsWith('/merchant/'));
  assert.equal(m.method, 'POST'); assert.equal(m.url, '/merchant/A%201'); assert.equal(m.body, '{"extra":"x"}');
  assert.ok(m.headers['payment-signature']);
  assert.equal(JSON.parse(Buffer.from(m.headers['payment-signature'], 'base64')).resource.url, 'https://api.example.com/data');
  assert.ok(!existsSync(join(HOME, 'payments', 'pay_unit_ok.json')));
});

test('two-phase pay: 402 → pending (state kept); transport error → failed', async () => {
  seedState('pay_unit_pend', { param_plan: [], endpoint_url: `${BASE}/merchant/pend`, method: 'GET' });
  teeRoutes();
  STUB.routes['/merchant/pend'] = { status: 402, body: 'settling' };
  const out = await flow.fetchPay('pay_unit_pend', null, ['k=v'], true);
  assert.equal(out.status, 'pending'); assert.equal(out.error, 'facilitator non-terminal: HTTP 402'); assert.equal(out.result, 'settling');
  assert.equal(STUB.log.find((x) => x.path === '/merchant/pend').url, '/merchant/pend?k=v');
  assert.ok(existsSync(join(HOME, 'payments', 'pay_unit_pend.json')));
  seedState('pay_unit_fail', { endpoint_url: 'http://127.0.0.1:1/x', param_plan: [] });
  teeRoutes();
  const f = await flow.fetchPay('pay_unit_fail', null, [], true);
  assert.equal(stringify(f), '{"decodedReceipt":null,"error":"error sending request for url (http://127.0.0.1:1/x)","ok":false,"paymentId":"pay_unit_fail","result":null,"scheme":"exact","status":"failed","txHash":null}');
});

test('two-phase pay: MCP replay re-handshakes and replays tools/call with merged args', async () => {
  seedState('pay_unit_mcp', { endpoint_url: `${BASE}/mcp`, mcp_tool: 'weather', known_params: { zip: '01234', n: 1 }, param_plan: [] });
  teeRoutes();
  const calls = [];
  STUB.routes['/mcp'] = (req, body) => {
    const m = JSON.parse(body);
    calls.push({ m, sid: req.headers['mcp-session-id'], sig: req.headers['payment-signature'] });
    if (m.method === 'initialize') return { headers: { 'Mcp-Session-Id': 'sess-1' }, body: { jsonrpc: '2.0', id: 1, result: {} } };
    if (m.method === 'notifications/initialized') return { status: 202, body: '' };
    if (m.method === 'tools/list') return { body: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'weather', inputSchema: { properties: { n: { type: 'integer' } } } }] } } };
    return { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"jsonrpc":"2.0","id":4,"result":{"temp":21}}\n\n' };
  };
  const out = await flow.fetchPay('pay_unit_mcp', null, ['n=7'], true);
  assert.equal(out.status, 'success'); assert.equal(stringify(out.result), '{"temp":21}');
  const call = calls.find((c) => c.m.id === 4);
  assert.equal(stringify(call.m), '{"id":4,"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"n":7,"zip":"01234"},"name":"weather"}}');
  assert.equal(call.sid, 'sess-1'); assert.ok(call.sig);
  assert.equal(stringify(calls[0].m.params), '{"capabilities":{},"clientInfo":{"name":"onchainos","version":"4.6.3"},"protocolVersion":"2025-06-18"}');
});

test('quote: REST 402 challenge → candidates, state file, summary (stub merchant + stub DEX API)', async () => {
  STUB.log.length = 0;
  const accepts = [{ scheme: 'exact', network: 'eip155:196', amount: '10000', asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736', payTo: '0x' + '11'.repeat(20), maxTimeoutSeconds: 300, extra: { name: 'USD₮0', version: '1', decimals: 6 } }];
  STUB.routes = {
    '/paid': { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://m/paid' }, accepts })).toString('base64') }, body: { outputSchema: { input: { city: { required: true } } } } },
    '/api/v6/dex/market/token/basic-info': ok([{ symbol: 'USDT', decimal: '6' }]),
    '/api/v6/dex/balance/all-token-balances-by-address': ok([{ tokenAssets: [{ symbol: 'USDT', tokenContractAddress: '0x779DED0C9E1022225F8E0630B35A9B54BE713736', balance: '0.005' }] }]),
    '/free': { body: { ok: 1 } },
  };
  const q = await quote.fetchQuote(`${BASE}/paid`, ['a=1'], 'GET', null);
  assert.match(q.paymentId, /^pay_[0-9a-f]{24}$/);
  assert.equal(q.summary, 'Will pay 0.01 USDT (exact, X Layer)');
  assert.equal(q.walletError, undefined);
  assert.deepEqual(q.missingParams, ['city']);
  assert.equal(q.candidates[0].balanceStatus, 'insufficient'); assert.equal(q.candidates[0].shortfall, '0.005'); assert.equal(q.candidates[0].recommended, null);
  assert.equal(q.candidates[0].depositAddress, ACCOUNT1_EVM);
  const wireKeys = Object.keys(JSON.parse(stringify(q)));
  assert.deepEqual(wireKeys, wireKeys.slice().sort());
  const probe = STUB.log.find((x) => x.path === '/paid');
  assert.equal(probe.url, '/paid?a=1'); assert.equal(probe.headers['user-agent'], undefined);
  assert.equal(STUB.log.filter((x) => x.path === '/api/v6/dex/market/token/basic-info').length, 1);
  const saved = JSON.parse(readFileSync(join(HOME, 'payments', `${q.paymentId}.json`), 'utf8'));
  assert.equal(saved.method, 'GET'); assert.equal(saved.endpoint_url, `${BASE}/paid`); assert.equal(saved.raw_accepts[0].extra.name, 'USD₮0');
  const free = await quote.fetchQuote(`${BASE}/free`, [], 'GET', null);
  assert.equal(stringify(free), '{"accepts":[],"alternatives":[],"candidates":[],"decodedChallenge":{"amount":"0","amountHuman":"0","decimals":0,"expires":0,"recipient":"","supported":true,"unsupported_reason":null},"knownParams":{},"merchantBody":"{\\"ok\\":1}","missingParams":[],"needsConfirm":false,"nextStep":"","paramPlan":[],"summary":"Endpoint returned 200 — no payment required"}');
  STUB.routes['/nope'] = { status: 405, body: '' };
  assert.equal(await errMsgAsync(() => quote.fetchQuote(`${BASE}/nope`, [], 'GET', null)), 'endpoint_unreachable: endpoint returned HTTP 405 to the GET probe — if this is an A2MCP endpoint, retry with --tool <name> (MCP transport) or --method POST (REST)');
  STUB.routes['/nope'] = { status: 403, body: '' };
  assert.equal(await errMsgAsync(() => quote.fetchQuote(`${BASE}/nope`, [], 'GET', null)), 'auth_required: unexpected HTTP 403 (expected 402 or 200)');
  STUB.routes['/nope'] = { status: 402, body: '{"x402Version":2,"accepts":[{"scheme":"weird"}]}' };
  assert.equal(await errMsgAsync(() => quote.fetchQuote(`${BASE}/nope`, [], 'GET', null)), 'unsupported: no supported payment scheme in accepts[]');
  STUB.routes['/nope'] = { status: 402, headers: { 'WWW-Authenticate': 'Payment id="1", method="evm", intent="charge", request="e30"' }, body: '' };
  assert.equal(await errMsgAsync(() => quote.fetchQuote(`${BASE}/nope`, [], 'GET', null)), 'unsupported: 402 challenge has no accepts[] array');
});

test('quote: MCP discovery / unknown tool / free tool', async () => {
  STUB.routes = {
    '/tools/mcp': (req, body) => {
      const m = JSON.parse(body);
      if (m.method === 'initialize') return { body: { jsonrpc: '2.0', id: 1, result: {} } };
      if (m.method === 'tools/list') return { body: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a', description: 'A' }, { name: 'b', inputSchema: { properties: { n: { type: 'number' } } } }, 7] } } };
      if (m.method === 'tools/call') return { body: { jsonrpc: '2.0', id: 3, result: { args: m.params.arguments } } };
      return { status: 202, body: '' };
    },
  };
  const d = await quote.fetchQuote(`${BASE}/tools/mcp`, ['x=1'], 'GET', null);
  assert.equal(d.summary, 'MCP server exposes 2 tool(s): a, b');
  assert.equal(stringify(d.mcpTools), '[{"description":"A","name":"a"},{"inputSchema":{"properties":{"n":{"type":"number"}}},"name":"b"}]');
  assert.equal(await errMsgAsync(() => quote.fetchQuote(`${BASE}/tools/mcp`, [], 'GET', 'zzz')), "invalid_input: tool 'zzz' not found; available tools: [a, b]");
  const f = await quote.fetchQuote(`${BASE}/tools/mcp`, ['n=2.5'], 'GET', 'b');
  assert.equal(f.summary, "MCP tool 'b' returned a result — no payment required");
  assert.equal(stringify(f.result), '{"args":{"n":2.5}}');
  assert.equal(stringify(f.knownParams), '{"n":"2.5"}');
});

test('x402 auto-pay signer: local EVM_PRIVATE_KEY path honours the saved default + warns once', async () => {
  const { renameSync, writeFileSync: wf } = await import('node:fs');
  renameSync(join(HOME, 'wallets.json'), join(HOME, 'wallets.json.bak'));
  process.env.EVM_PRIVATE_KEY = '0x' + '11'.repeat(32);
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...r) => { writes.push(String(c)); return true; };
  try {
    wf(join(HOME, 'payment_cache.json'), JSON.stringify({ default_asset: { asset: '0x' + '33'.repeat(20), network: 'eip155:196' } }));
    const second = { ...X402_ENTRY, asset: '0x' + '33'.repeat(20), amount: { basic: '5', premium: '6' } };
    const [, v] = await x402.signHeaderFromAccepts({ accepts: [X402_ENTRY, second], tier: 'basic', resource: 'https://x/p' });
    const h = JSON.parse(Buffer.from(v, 'base64'));
    assert.equal(h.accepted.asset, second.asset); assert.equal(h.payload.authorization.value, '5'); assert.equal(h.payload.authorization.from, PK_ADDR);
    await x402.signHeaderFromAccepts({ accepts: [X402_ENTRY], tier: 'basic', resource: 'https://x/p' });
    assert.equal(writes.filter((w) => w.includes('payment signed locally with EVM_PRIVATE_KEY')).length, 1);
    assert.equal(JSON.parse(readFileSync(join(HOME, 'payment_cache.json'), 'utf8')).local_signing_warned, true);
  } finally {
    process.stderr.write = orig;
    delete process.env.EVM_PRIVATE_KEY;
    renameSync(join(HOME, 'wallets.json.bak'), join(HOME, 'wallets.json'));
  }
});

// ── verifier regressions (divergences found by differential runs against the 4.6.3 binary) ──
test('subscription sign: U256 `+`/`*` wrap mod 2^256 and u64 `now + timeout` wraps (release build)', async () => {
  teeRoutes();
  const status = { approvedAmount: '0', expiration: 0, nonce: 3, reservedAmount: '100', reservedExpiration: 4200000000, permit2Allowance: '', subscriptionContract: SUB, permit2Contract: PERMIT2_ADDRESS };
  STUB.routes[`/api/v6/pay/x402/buyers/${ACCOUNT1_EVM}/allowance-status`] = ok([status]);
  const accepted = structuredClone(SAMPLE_ACCEPTED);
  accepted.extra.amountPerPeriod = '0x' + 'f'.repeat(64);   // (2^256-1) * 12 wraps to 2^256-12
  delete accepted.extra.initialCharge;
  accepted.maxTimeoutSeconds = 18446744073709551615n;          // now + (2^64-1) wraps to now - 1
  const before = BigInt(Math.floor(Date.now() / 1000));
  const signed = await ss.signSubscribe('196', 196, ACCOUNT1_EVM, accepted);
  // upstream 4.6.3: reservedAmount 100 + wrapped commit → "88" (verified against the binary)
  assert.equal(signed.payload.permit.details.amount, '88');
  const td = BigInt(signed.payload.terms.termsDeadline);
  assert.ok(td >= before - 1n && td <= before + 5n, `termsDeadline ${td} should wrap to ≈ now - 1`);
  assert.equal(ss.wrap256((1n << 256n) + 5n), 5n);
});

test('subscription types: from_value walks the map in key order (first bad sorted key is reported)', () => {
  // document order puts reservedAmount first; serde_json::from_value visits approvedAmount first
  assert.equal(errMsg(() => stypes.decodeAllowanceStatus(parse('{"reservedAmount":[],"approvedAmount":{}}'))), 'expected string or number, got {}');
  assert.equal(errMsg(() => stypes.decodeAllowanceStatus(parse('{"subscriptionContract":5,"nonce":-1}'))), 'number out of u64 range');
});

test('state: an explicit null in a param_plan spec is a serde type error (default applies only when absent)', () => {
  const base = {
    payment_id: 'pay_unitnull', owner_wallet: 'acct', created_at: 1, expires_at: 4102444800, accepts: [], candidates: [],
    decoded_challenge: { amount: '1', amountHuman: '1', decimals: 0, recipient: '', expires: 0, supported: true, unsupported_reason: null },
    known_params: {}, merchant_body: '', endpoint_url: 'https://m/x',
  };
  for (const spec of [{ name: 'a', carrier: null }, { name: 'a', required: null }, { name: 'a', type: null }]) {
    writeFileSync(join(HOME, 'payments', 'pay_unitnull.json'), JSON.stringify({ ...base, param_plan: [spec] }));
    assert.equal(errMsg(() => state.read('pay_unitnull', 'acct', 2)), 'quote_expired_or_missing: pay_unitnull', JSON.stringify(spec));
  }
  writeFileSync(join(HOME, 'payments', 'pay_unitnull.json'), JSON.stringify({ ...base, param_plan: [{ name: 'a' }] }));
  assert.deepEqual(state.read('pay_unitnull', 'acct', 2).param_plan, [{ name: 'a', carrier: 'query', required: false, type: '' }]);
});

test('http_carrier: typed params iterate in serde Map (byte) order, not insertion order', () => {
  const r = carrier.buildTypedRequest('GET', 'https://m.example/svc', { zeta: 1, b: 'x', q: true, 10: 'n', 2: 'm' }, [{ name: 'b', carrier: 'header' }, { name: 'zeta', carrier: 'header' }]);
  assert.equal(r.url, 'https://m.example/svc?10=n&2=m&q=true');     // upstream: "?10=n&2=m&q=true" (byte order)
  assert.deepEqual(r.headers, [['b', 'x'], ['zeta', '1']]);
});

test('subscription cache: sequence-form structs load like serde (top level and entries)', () => {
  const entry = ['0xaa', 'a.com', '0x1', 'p', 1, 3, 'active'];
  writeFileSync(join(HOME, 'subscriptions.json'), JSON.stringify([{ 'a.com': entry }]));
  assert.equal(sc.SubscriptionCache.load().get('a.com').subId, '0xaa');
  writeFileSync(join(HOME, 'subscriptions.json'), JSON.stringify({ by_host: { 'a.com': [...entry, '0xbb'] } }));
  assert.equal(sc.SubscriptionCache.load().get('a.com').changedToSubId, '0xbb');
  for (const bad of ['[{},{}]', '{"by_host":{"a.com":["0xaa"]}}', '{"by_host":null}']) {
    writeFileSync(join(HOME, 'subscriptions.json'), bad);
    assert.equal(sc.SubscriptionCache.load().byHost.size, 0, bad);
  }
  writeFileSync(join(HOME, 'subscriptions.json'), '[]');
  assert.equal(sc.SubscriptionCache.load().byHost.size, 0);
});
