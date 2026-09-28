// Stub-API unit tests for the payment-schemes unit (a2a-pay create/pay/status polling, sign_escrow,
// subscription allowance-status / cancel). A logged-in parity home + a local stub OKX API: the TEE
// sign-msg / credential endpoints never reach a real server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-payment-schemes-net-'));
cpSync(join(HERE, '..', 'parity', 'homes', 'wallet-chains'), HOME, { recursive: true });
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.env.ONCHAINOS_CREDENTIAL_STORE = 'file';

const STUB = { log: [], routes: {} };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    STUB.log.push({ method: req.method, url: req.url, path, headers: req.headers, body });
    const route = STUB.routes[`${req.method} ${path}`];
    const r = typeof route === 'function' ? route(req, body) : route ?? { status: 599, body: { code: '599', msg: 'no stub', data: [] } };
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.OCL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const a2a = await import('../../skill/onchainos-lite/lib/payment/a2a-pay.mjs');
const sub = await import('../../skill/onchainos-lite/lib/payment/subscription.mjs');
const { stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { keccak256 } = await import('../../skill/onchainos-lite/lib/crypto/keccak.mjs');

const ok = (data) => ({ body: { code: '0', msg: '', data } });
const reset = (routes) => { STUB.log.length = 0; STUB.routes = routes; };
const bodies = (path) => STUB.log.filter((x) => x.path === path).map((x) => JSON.parse(x.body));
const PAYER = '0xd825f780e3cb88b383907ff427495d1dca352d44';
const TOKEN = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const GEN = '/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash';
const SIGN = '/priapi/v5/wallet/agentic/pre-transaction/sign-msg';
const TEE = {
  [`POST ${GEN}`]: ok([{ msgHash: '0x' + 'ab'.repeat(32), domainHash: '0x' + 'cd'.repeat(32) }]),
  [`POST ${SIGN}`]: ok([{ signature: '0x' + 'ee'.repeat(65) }]),
};

test('a2a status: one-shot, polling to terminal, and the ceiling', async () => {
  reset({ 'GET /api/v6/pay/a2a/p/p1/status': ok({ status: 'settling', executed: { blockNumber: 5 } }) });
  assert.deepEqual(await a2a.fetchStatus('p1', false), { status: 'settling', terminal: false, timed_out: false });
  assert.equal(STUB.log.length, 1);
  assert.equal(STUB.log[0].url, '/api/v6/pay/a2a/p/p1/status');
  assert.match(STUB.log[0].headers.authorization, /^Bearer /);
  const st = await a2a.status('p1');
  assert.equal(stringify(st), '{"payment_id":"p1","status":"settling","tx_hash":null,"block_number":5,"block_timestamp":null,"fee_amount":null,"fee_bps":null}');

  let n = 0;
  reset({ 'GET /api/v6/pay/a2a/p/p1/status': () => ok({ status: ++n < 3 ? 'pending' : 'completed' }) });
  assert.deepEqual(await a2a.fetchStatus('p1', true, { intervalMs: 5, ceilingMs: 5000 }), { status: 'completed', terminal: true, timed_out: false });
  assert.equal(n, 3);

  reset({ 'GET /api/v6/pay/a2a/p/p1/status': ok({ status: 'pending' }) });
  assert.deepEqual(await a2a.fetchStatus('p1', true, { intervalMs: 5, ceilingMs: 30 }), { status: 'pending', terminal: false, timed_out: true });
});

test('a2a create: wire body (sorted, optional keys only when given)', async () => {
  reset({ 'POST /api/v6/pay/a2a/payment/create': ok({ paymentId: 'pay_1', deliveries: { url: 'u' } }) });
  const out = await a2a.execute({ kind: 'create', args: { type: 'charge', amount: '0.01', symbol: 'USDT', recipient: PAYER, expiresIn: 600, externalId: 't1', description: null, realm: null } });
  assert.equal(stringify(out), '{"payment_id":"pay_1","deliveries":{"url":"u"}}');
  assert.equal(STUB.log[0].body, `{"amount":"0.01","deliveries":{"includeUrl":true},"expiresIn":600,"externalId":"t1","recipient":"${PAYER}","symbol":"USDT","type":"charge"}`);
  await assert.rejects(a2a.execute({ kind: 'create', args: { type: 'escrow' } }), /^Error: unknown --type 'escrow', expected 'charge'$/);
});

test('a2a pay: challenge guards, TEE bodies and the credential', async () => {
  const challenge = { data: { intent: 'charge', expires: '2099-01-01T00:00:00Z', request: { amount: '10000', currency: TOKEN, recipient: '0x' + '22'.repeat(20), methodDetails: { chainId: 196, authorizationType: 'transferWithAuthorization' } } } };
  reset({
    'GET /api/v6/pay/a2a/p/p1': ok({ challenge }), ...TEE,
    'POST /api/v6/pay/a2a/p/p1/credential': ok({ success: true, status: 'settling', txHash: '0xabc' }),
  });
  const out = await a2a.pay({ paymentId: 'p1', amount: '10000', currency: TOKEN.toUpperCase().replace('0X', '0x'), recipientAddress: '0x' + '22'.repeat(20) });
  assert.deepEqual(Object.keys(out), ['payment_id', 'status', 'tx_hash', 'valid_after', 'valid_before', 'signature']);
  assert.equal(out.status, 'settling');
  assert.equal(out.tx_hash, '0xabc');
  assert.equal(STUB.log[0].headers.authorization, undefined, 'GET /p/{id} is anonymous');
  const [gen] = bodies(GEN);
  assert.equal(gen.msgType, 'eip3009Auth');
  assert.equal(gen.signType, undefined);
  assert.equal(gen.validAfter, '0');
  assert.equal(gen.from, PAYER);
  const [sign] = bodies(SIGN);
  assert.equal(sign.msgType, undefined);
  assert.equal(sign.skipWarning, undefined);
  assert.equal(sign.domainHash, '0x' + 'cd'.repeat(32));
  const [cred] = bodies('/api/v6/pay/a2a/p/p1/credential');
  assert.deepEqual(Object.keys(cred.payload.authorization).sort(), ['from', 'nonce', 'to', 'type', 'validAfter', 'validBefore', 'value']);
  assert.equal(cred.payload.authorization.type, 'transferWithAuthorization');
  await assert.rejects(a2a.pay({ paymentId: 'p1', amount: '1', currency: TOKEN, recipientAddress: '0x' + '22'.repeat(20) }), /amount mismatch: expected 1, challenge has 10000/);
});

test('a2a sign_escrow: validation, escrow nonce and ReceiveWithAuthorization bodies', async () => {
  const p = {
    chainId: 196, provider: '0x' + '11'.repeat(20), receiver: '0x' + '22'.repeat(20), arbitrator: '0x' + '33'.repeat(20), currency: TOKEN,
    escrowContract: '0x' + '77'.repeat(20), amount: '50000000', submitWindow: 86400, disputeWindow: 86400, arbitrationWindow: 172800,
    terminationWindow: 86400, hook: '0x' + '55'.repeat(20), hookData: '0xdeadbeef', salt: '0x' + '0'.repeat(63) + '7', expiredAt: '2030-01-01T00:00:00Z',
  };
  await assert.rejects(a2a.signEscrow({ ...p, hook: '0x1' }), /^Error: --hook is not a valid EVM address: 0x1$/);
  reset({ ...TEE });
  await assert.rejects(a2a.signEscrow({ ...p, expiredAt: 'soon' }), /expired_at 'soon' is not RFC 3339: premature end of input/);
  await assert.rejects(a2a.signEscrow({ ...p, amount: '-1' }), /^Error: amount must be a non-negative integer in minimal units: invalid digit found in string$/);
  const out = await a2a.signEscrow(p);
  const expectedNonce = '0x' + Buffer.from(a2a.computeEscrowNonce({
    from: PAYER, provider: p.provider, receiver: p.receiver, arbitrator: p.arbitrator, currency: TOKEN, amount: 50000000n, submitWindow: 86400,
    disputeWindow: 86400, arbitrationWindow: 172800, terminationWindow: 86400, hook: p.hook, hookDataHash: keccak256(Buffer.from('deadbeef', 'hex')),
    salt: a2a.parseBytes32Hex(p.salt, 'salt'), chainId: 196, escrowAddress: p.escrowContract,
  })).toString('hex');
  assert.equal(stringify(out), `{"type":"transaction","signature":"0x${'ee'.repeat(65)}","authorization":{"type":"ReceiveWithAuthorization","from":"${PAYER}","to":"${p.escrowContract}","value":"50000000","validAfter":"0","validBefore":"1893456000","nonce":"${expectedNonce}"}}`);
  const [gen] = bodies(GEN);
  assert.equal(gen.signType, 'eip3009ReceiveAuth');
  assert.equal(gen.msgType, 'eip3009ReceiveAuth');
  assert.equal(gen.nonce, expectedNonce);
  const [sign] = bodies(SIGN);
  assert.equal(sign.signType, 'eip3009ReceiveAuth');
  assert.equal(sign.msgType, undefined);
});

test('subscription: allowance-status output + cancel via --token lookup', async () => {
  const allowance = {
    approvedAmount: 5, expiration: '1790000000', nonce: 3, reservedAmount: null, reservedExpiration: 0, tokenBalance: '1',
    availableAmount: '1', permit2Allowance: '9', subscriptionContract: '0x4020000000000000000000000000000000000003', permit2Contract: '0xp2',
  };
  reset({ [`GET /api/v6/pay/x402/buyers/${PAYER}/allowance-status`]: ok(allowance), ...TEE });
  const out = await sub.execute({ kind: 'allowance-status', token: TOKEN, chain: 'xlayer' });
  assert.equal(stringify(out), '{"approvedAmount":"5","availableAmount":"1","expiration":1790000000,"nonce":3,"permit2Allowance":"9","permit2Contract":"0xp2","reservedAmount":"","reservedExpiration":0,"subscriptionContract":"0x4020000000000000000000000000000000000003","tokenBalance":"1"}');
  assert.equal(STUB.log[0].url, `/api/v6/pay/x402/buyers/${PAYER}/allowance-status?token=${TOKEN}&chainIndex=196`);
  assert.equal(STUB.log[0].headers['ok-client-version'], undefined, 'buyer-direct reads send no OK headers');
  const c = await sub.execute({ kind: 'cancel', subId: '0x' + '11'.repeat(32), token: TOKEN, chain: '196' });
  assert.deepEqual(Object.keys(JSON.parse(stringify(c))), ['cancelAuth', 'chainIndex']);
  assert.deepEqual(Object.keys(JSON.parse(stringify(c)).cancelAuth), ['action', 'deadline', 'initiator', 'nonce', 'signature', 'subId']);
  const typed = bodies(GEN)[0].payload[0].message;
  assert.equal(typed.primaryType, 'CancelAuth');
  assert.equal(typed.domain.verifyingContract, '0x4020000000000000000000000000000000000003');
});
