// Unit tests for lib/wallet/{api,store,auth,account,common,chain,chain-profile} pure helpers.
// Oracles are the upstream Rust unit tests (wallet_api.rs, auth/mod.rs, account.rs, common.rs,
// chain_profile.rs, balance/mod.rs) plus Rust `format!` behaviour captured with rustc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The state dir is fixed at config load: point it at a scratch dir before importing lib code.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-wallet-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;

const L = '../../skill/onchainos-lite/lib/';
const api = await import(L + 'wallet/api.mjs');
const store = await import(L + 'wallet/store.mjs');
const auth = await import(L + 'wallet/auth.mjs');
const account = await import(L + 'wallet/account.mjs');
const common = await import(L + 'wallet/common.mjs');
const profile = await import(L + 'wallet/chain-profile.mjs');
const { formatFixed } = await import(L + 'core/rs/num.mjs');
const summary = await import(L + 'wallet/balance/index.mjs');
const { parse, stringify } = await import(L + 'core/json.mjs');
const { Confirming } = await import(L + 'core/errors.mjs');
const { hpkeDecryptSessionSk } = await import(L + 'core/crypto.mjs');
const { ed25519 } = await import(L + 'crypto/curve25519.mjs');
const H = await import('../parity/make-home.mjs');

const J = (text) => parse(text);
// Run fn with process.stderr captured; returns the captured text.
function quiet(fn) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return err;
}
const jwt = (exp) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(`{"exp":${exp}}`).toString('base64url')}.${Buffer.from('fake_sig').toString('base64url')}`;

// ── wallet_api.rs ───────────────────────────────────────────────────

test('is_invalid_token_error matches both client formats (wallet_api.rs oracle)', () => {
  const t = (m) => api.isInvalidTokenError(new Error(m));
  assert.ok(t('API error (code=10008): Invalid access token'));
  assert.ok(t('Wallet API error (code=10008): token revoked'));
  assert.ok(t('Wallet API error (code=130100031): access token invalid'));
  assert.ok(t('Wallet API error (code=10001): authentication failed'));
  assert.ok(t('Wallet API error (code=53017): authentication failed'));
  assert.ok(t('auth failed: Invalid access token'));
  assert.ok(t('auth failed: access token invalid'));
  assert.ok(!t('API error (code=51000): insufficient balance'));
  assert.ok(!t('API error (code=100010): order amount too small'));
  assert.ok(!t('Network unavailable — check your connection and try again'));
  assert.ok(api.isInvalidTokenError(new api.ApiCodeError('10008', 'x', 200)));
  assert.ok(!api.isInvalidTokenError(new api.ApiCodeError('100010', 'x', 200)));
});

test('unwrap_wallet_envelope preserves backend code and msg', () => {
  assert.deepEqual(api.unwrapWalletEnvelope(200, J('{"code":"0","data":[1]}')), [1]);
  assert.deepEqual(api.unwrapWalletEnvelope(200, J('{"code":0,"msg":"","data":[{"executeResult":false}]}')), [{ executeResult: false }]);
  assert.equal(api.unwrapWalletEnvelope(200, J('{"code":0}')), null);
  const e = assert.throws(() => api.unwrapWalletEnvelope(200, J('{"code":"10004","msg":"insufficient balance","data":[]}')), api.ApiCodeError);
  assert.throws(() => api.unwrapWalletEnvelope(200, J('{"code":"10004","msg":"insufficient balance","data":[]}')), (err) =>
    err.code === '10004' && err.msg === 'insufficient balance' && err.httpStatus === 200 && err.message === 'Wallet API error (code=10004): insufficient balance');
  void e;
  // msg fallbacks and numeric codes
  assert.throws(() => api.unwrapWalletEnvelope(400, J('{"code":51000,"errorMessage":"bad"}')), { message: 'Wallet API error (code=51000): bad' });
  assert.throws(() => api.unwrapWalletEnvelope(200, J('{"code":"1","msg":5,"detailMsg":"detail"}')), { message: 'Wallet API error (code=1): detail' });
  assert.throws(() => api.unwrapWalletEnvelope(200, J('{"code":"50114","msg":"Unauthorized"}')),
    { message: 'Wallet API error (code=50114): Unauthorized. You are not logged in, run `wallet login` to sign into OKX Agentic Wallet.' });
  quiet(() => assert.throws(() => api.unwrapWalletEnvelope(200, J('[1,2]')), { message: 'Wallet API error (code=null): [1,2]' }));
  quiet(() => assert.throws(() => api.unwrapWalletEnvelope(200, J('{"code":0.0}')), { message: 'Wallet API error (code=0.0): {"code":0.0}' }));
});

test('unwrap_wallet_envelope truncates a msg-less body to 200 bytes + …', () => {
  const body = J(`{"code":"9","pad":"${'x'.repeat(300)}"}`);
  const err = quiet(() => assert.throws(() => api.unwrapWalletEnvelope(502, body), (e) => e.msg === stringify(body).slice(0, 200) + '…'));
  assert.match(err, /^\[WalletAPI\] no msg field in error response \(HTTP 502\), raw body: \{"code":"9"/);
});

test('handle_response: 5xx, non-JSON and empty bodies', () => {
  const c = new api.WalletApiClient('http://x');
  const r = (status, body) => ({ status, headers: {}, body: Buffer.from(body) });
  assert.throws(() => c.handleResponse(r(502, 'bad gateway')), { message: 'Wallet API server error (HTTP 502): bad gateway' });
  assert.throws(() => c.handleResponse(r(404, '<html>')), { message: 'failed to parse wallet API response as JSON (HTTP 404): <html>: expected value at line 1 column 1' });
  assert.throws(() => c.handleResponse(r(200, '')), { message: 'failed to parse wallet API response as JSON (HTTP 200): : EOF while parsing a value at line 1 column 0' });
  assert.deepEqual(c.handleResponse(r(404, '{"code":"0","data":{"a":1}}')), { a: 1 });   // 4xx + JSON = envelope decides
});

test('build_query_string drops empty values, keeps keys raw, form-encodes values', () => {
  assert.equal(api.buildQueryString([]), '');
  assert.equal(api.buildQueryString([['a', ''], ['b', '']]), '');
  assert.equal(api.buildQueryString([['accountIds', 'a,b'], ['x', ''], ['tokenAddresses[0].chainIndex', '1'], ['q', 'a b~*-._:']]),
    '?accountIds=a%2Cb&tokenAddresses[0].chainIndex=1&q=a+b%7E*-._%3A');
});

test('batch helpers (validate_batch_size, bodies, supportChainIndexList)', () => {
  assert.throws(() => api.validateBatchSize('batch unsignedInfo', 0), { message: 'batch unsignedInfo: empty request array' });
  api.validateBatchSize('batch unsignedInfo', 1);
  api.validateBatchSize('batch unsignedInfo', 5);
  assert.throws(() => api.validateBatchSize('batch broadcast', 6), { message: 'batch broadcast: backend allows up to 5 elements, got 6' });
  const base = { chainPath: 'm/44/60', chainIndex: 10, fromAddr: '0xfrom', toAddr: '0xto', amount: '0', sessionCert: 'cert' };
  assert.equal(stringify(api.buildBatchUnsignedinfoBody([base])), '[{"amount":"0","chainIndex":10,"chainPath":"m/44/60","fromAddr":"0xfrom","sessionCert":"cert","toAddr":"0xto"}]');
  const full = api.buildBatchUnsignedinfoBody([{ ...base, contractAddr: '0xca', inputData: '0xdata', gasLimit: '300000', aaDexTokenAddr: '0xaa', aaDexTokenAmount: '1000', transactionType: 'dex' }])[0];
  assert.deepEqual(Object.keys(full).sort(), ['aaDexTokenAddr', 'aaDexTokenAmount', 'amount', 'chainIndex', 'chainPath', 'contractAddr', 'fromAddr', 'gasLimit', 'inputData', 'sessionCert', 'toAddr', 'transactionType']);
  assert.equal(stringify(api.buildBatchBroadcastBody([{ accountId: 'acc-1', address: '0xabc', chainIndex: '10', extraData: '{"k":"v"}' }])),
    '[{"accountId":"acc-1","address":"0xabc","chainIndex":"10","extraData":"{\\"k\\":\\"v\\"}"}]');
  assert.deepEqual(api.parseSupportedChainList(['196', '1']), ['196', '1']);
  assert.deepEqual(api.parseSupportedChainList([196, 1, 137, 8453]), ['196', '1', '137', '8453']);
  assert.throws(() => api.parseSupportedChainList({ chains: ['1'] }), { message: 'batch supportChainIndexList: expected data to be an array' });
  assert.throws(() => api.parseSupportedChainList([{ chainIndex: '1' }]), { message: 'batch supportChainIndexList: unexpected element Object {"chainIndex": String("1")}' });
});

test('response decoders follow serde rules (VerifyResponse, RefreshResponse, lists)', () => {
  const v = api.decodeVerifyResponse(J(`{"refreshToken":"rt","accessToken":"at","teeId":"tee1","saTeeId":"sa-tee1","sessionCert":"cert","encryptedSessionSk":"esk",
    "sessionKeyExpireAt":"2025-12-31","projectId":"proj","accountId":"acc","accountName":"My Wallet","isNew":true,
    "addressList":[{"chainIndex":"1","address":"0xabc","chainName":"ETH","addressType":"eoa","chainPath":"m/44/60"},{"chainIndex":"501","address":"SoLaddr","chainName":"SOL","addressType":"eoa","chainPath":"m/44/501"}]}`));
  assert.equal(v.saTeeId, 'sa-tee1');
  assert.equal(v.isNew, true);
  assert.equal(v.addressList[0].accountId, '');
  assert.equal(v.addressList[1].address, 'SoLaddr');
  assert.deepEqual(v.loginInfo, { email: '', nickname: '', username: '', loginType: '' });
  const n = api.decodeVerifyResponse(J('{"refreshToken":"rt","accessToken":"at","sessionCert":"c","encryptedSessionSk":"e","sessionKeyExpireAt":1781959290,"projectId":"p","accountId":"a","accountName":"W","isNew":1,"addressList":[]}'));
  assert.equal(n.sessionKeyExpireAt, '1781959290');
  assert.equal(n.isNew, true);
  assert.equal(n.saTeeId, '');
  assert.equal(api.decodeVerifyResponse(J('{"refreshToken":"rt","accessToken":"at","sessionCert":"c","encryptedSessionSk":"e","sessionKeyExpireAt":null,"projectId":"p","accountId":"a","accountName":"W","isNew":1.5}')).isNew, false);
  assert.throws(() => api.decodeVerifyResponse(J('{"accessToken":"x"}')), { message: 'missing field `refreshToken`' });
  assert.throws(() => api.decodeVerifyResponse(J('{"refreshToken":"rt","accessToken":null}')), { message: 'invalid type: null, expected a string' });
  assert.throws(() => api.decodeVerifyResponse(J('{"refreshToken":"rt","accessToken":"a","sessionCert":"c","encryptedSessionSk":"e","sessionKeyExpireAt":[],"projectId":"p","accountId":"a","accountName":"W","isNew":1}')),
    { message: 'expected string or number, got []' });
  const info = api.decodeVerifyAddressInfo(J('{"address":"0xabc","chainIndex":196,"chainName":"okb","addressType":"aa","chainPath":null}'));
  assert.deepEqual(info, { accountId: '', address: '0xabc', chainIndex: '196', chainName: 'okb', addressType: 'aa', chainPath: '' });
  const r = api.decodeRefreshResponse(J('{"refreshToken":"new_rt","accessToken":"new_at"}'));
  assert.equal(r.chainUpdated, false);
  assert.deepEqual(r.allAccountAddressList, []);
  const r2 = api.decodeRefreshResponse(J('{"refreshToken":"rt2","accessToken":"at2","chainUpdated":true,"allAccountAddressList":[{"accountId":"acc-1","accountName":"Wallet 1","isDefault":true,"addresses":[{"chainIndex":4217,"address":"0xabc","chainName":"tempo","addressType":"eoa","chainPath":"m/44/60/0/0"}]},{"accountId":"acc-2","accountName":"Wallet 2","isDefault":false,"addresses":[]}]}'));
  assert.equal(r2.allAccountAddressList[0].addresses[0].chainIndex, '4217');
  assert.equal(r2.allAccountAddressList[1].isDefault, false);
  const items = J('[{"projectId":"p1","accountId":"a1","accountName":"Default","isDefault":true},{"projectId":"p1","accountId":"a2","accountName":"Second"}]').map(api.decodeAccountListItem);
  assert.equal(items[1].isDefault, false);
  const gs = api.decodeGasStationToken(J('{"feeCoinId":7,"symbol":null,"sufficient":null}'));
  assert.deepEqual(gs, { feeCoinId: 7, symbol: '', feeTokenAddress: '', serviceCharge: '', balance: '', sufficient: false, relayerId: '', context: '' });
  assert.throws(() => api.decodeGasStationToken(J('{"feeCoinId":-1}')), { message: 'invalid value: integer `-1`, expected u64' });
  assert.throws(() => api.decodeCreateAccountResponse(J('{"projectId":"p","accountId":"a"}')), { message: 'missing field `accountName`' });
});

test('UnsignedInfoResponse gas-station helpers', () => {
  const u = (json) => api.decodeUnsignedInfoResponse(J(json));
  assert.equal(api.gsStatus(u('{"gasStationStatus":"READY_TO_USE"}')), 'READY_TO_USE');
  assert.equal(api.gsStatus(u('{}')), '');
  assert.equal(api.gasStationStatusParse('not_applicable'), '');
  assert.equal(api.gasStationStatusParse('NOT_SUPPORT_INTENTION'), 'NOT_SUPPORT_INTENTION');
  assert.ok(!api.hasSignMaterial(u('{}')));
  assert.ok(api.hasSignMaterial(u('{"hash":"0xabc"}')));
  assert.ok(api.hasSignMaterial(u('{"gasStationStatus":"NOT_SUPPORT_INTENTION","unsignedTx":"AQAB"}')));
  assert.ok(api.freeGas(u('{"extraData":{"freeGas":true}}')));
  assert.ok(!api.freeGas(u('{"extraData":{"freeGas":"yes"}}')));
  assert.ok(!api.freeGas(u('{"extraData":{}}')));
  const tok = (symbol, feeTokenAddress, sufficient) => ({ symbol, feeTokenAddress, sufficient });
  const mk = (def, list) => ({ defaultGasTokenAddress: def, gasStationTokenList: list });
  assert.equal(api.matchDefaultSufficientToken(mk('', [tok('USDT', '0xaaa', true)])), null);
  assert.equal(api.matchDefaultSufficientToken(mk('0xAAA', [tok('USDT', '0xaaa', true)])).symbol, 'USDT');
  assert.equal(api.matchDefaultSufficientToken(mk('0xaaa', [tok('USDT', '0xaaa', false), tok('USDC', '0xbbb', true)])), null);
  assert.equal(api.onlySufficientToken(mk('', [tok('USDT', '0xaaa', false), tok('USDC', '0xbbb', true), tok('USDG', '0xccc', false)])).symbol, 'USDC');
  assert.equal(api.onlySufficientToken(mk('', [tok('USDT', '0xaaa', true), tok('USDC', '0xbbb', true)])), null);
  assert.equal(api.autoPickGasToken(mk('0xaaa', [tok('USDT', '0xaaa', true), tok('USDC', '0xbbb', true)])).symbol, 'USDT');
  assert.equal(api.autoPickGasToken(mk('', [tok('USDT', '0xaaa', false), tok('USDC', '0xbbb', true)])).symbol, 'USDC');
  assert.equal(api.autoPickGasToken(mk('0xaaa', [tok('USDT', '0xaaa', false), tok('USDC', '0xbbb', true)])), null);
  assert.equal(api.autoPickGasToken(mk('0xdeadbeef', [tok('USDC', '0xbbb', true)])), null);
});

// ── auth/mod.rs ─────────────────────────────────────────────────────

test('token_exp_timestamp / expiry boundaries (auth/mod.rs oracle)', () => {
  assert.equal(auth.tokenExpTimestamp(jwt(1700000000)), 1700000000n);
  assert.equal(auth.tokenExpTimestamp('not.a.jwt'), null);
  assert.equal(auth.tokenExpTimestamp(''), null);
  assert.equal(auth.tokenExpTimestamp('onlyone'), null);
  const padded = jwt(1700000000).split('.');
  assert.equal(auth.tokenExpTimestamp(`${padded[0]}.${padded[1]}=.${padded[2]}`), null);   // strict no-pad
  assert.equal(auth.tokenExpTimestamp(`a.${Buffer.from('{"exp":1.5}').toString('base64url')}.c`), null);
  assert.equal(auth.tokenExpTimestamp(`a.${Buffer.from('{"exp":"1"}').toString('base64url')}.c`), null);
  const now = 1_700_000_000;
  assert.ok(auth.isTokenExpiredAt(jwt(now), now));
  assert.ok(!auth.isTokenExpiredAt(jwt(now + 1), now));
  assert.ok(!auth.isTokenExpiredAt(jwt(now + 60), now));
  assert.ok(auth.isTokenExpiredAt('garbage', now));
  assert.ok(auth.isTokenExpiringAt(jwt(now + 59), now));
  assert.ok(auth.isTokenExpiringAt(jwt(now + 60), now));
  assert.ok(!auth.isTokenExpiringAt(jwt(now + 61), now));
  const far = jwt(now + 3600), soon = jwt(now + 60);
  assert.ok(auth.shouldRefreshTokensAt(soon, far, now));
  assert.ok(auth.shouldRefreshTokensAt(far, soon, now));
  assert.ok(!auth.shouldRefreshTokensAt(far, far, now));
  assert.ok(auth.isTokenExpired(jwt(Math.floor(Date.now() / 1000) - 3600)));
  assert.ok(!auth.isTokenExpired(jwt(Math.floor(Date.now() / 1000) + 3600)));
  assert.ok(auth.isExpiringTimestamp(9223372036854775807n, 9223372036854775807n));   // saturating add
});

test('is_session_key_expired / format_api_error', () => {
  assert.ok(auth.isSessionKeyExpired(''));
  assert.ok(auth.isSessionKeyExpired('2025-12-31'));
  assert.ok(auth.isSessionKeyExpired(' 4102444800'));
  assert.ok(auth.isSessionKeyExpired('1700000000'));
  assert.ok(!auth.isSessionKeyExpired('4102444800'));
  assert.ok(!auth.isSessionKeyExpired('+4102444800'));
  assert.equal(auth.formatApiError(new api.ApiCodeError('-1', 'failed', 200)).message, 'code=-1 msg=failed');
  const plain = new Error('x');
  assert.equal(auth.formatApiError(plain), plain);
});

test('social login URL, poll classification, timeout resolution, next steps', () => {
  const url = auth.buildLoginUrl('https://web3pre.okex.org', 'sess-123', 'AB+/=cd');
  assert.equal(url, 'https://web3pre.okex.org/account/sociallogin?authSessionId=sess-123&tempPubKey=AB%2B%2F%3Dcd&clientType=agent-cli');
  assert.ok(auth.buildLoginUrl('https://x.com/', 's', 'k').startsWith('https://x.com/account/sociallogin?'));
  assert.ok(auth.isBrowsableUrl('https://web3pre.okex.org/account/sociallogin?x=1'));
  assert.ok(auth.isBrowsableUrl('http://localhost:8080/login'));
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com', 'not a url', '']) assert.ok(!auth.isBrowsableUrl(bad), bad);
  assert.equal(auth.classifyPoll({ value: { accessToken: 'tok' } }), 'Ready');
  assert.equal(auth.classifyPoll({ value: { foo: 1 } }), 'Pending');
  assert.equal(auth.classifyPoll({ value: { accessToken: '' } }), 'Pending');
  assert.equal(auth.classifyPoll({ error: new api.ApiCodeError('10018', 'not ready', 200) }), 'Pending');
  assert.equal(auth.classifyPoll({ error: new Error('connection refused') }), 'Transient');
  assert.equal(auth.classifyPoll({ error: new api.ApiCodeError('-1', 'failed', 200) }), 'Terminal');
  for (const [raw, want] of [[undefined, 300], ['', 300], ['abc', 300], ['-5', 300], ['10', 10], ['60', 60], ['9', 300], ['0', 300], ['+20', 20], [' 20', 300]]) {
    assert.equal(auth.resolveSocialLoginTimeoutSecs(raw), want, String(raw));
  }
  assert.equal(auth.SOCIAL_LOGIN_POLL_INTERVAL_SECS, 2);
  assert.deepEqual(auth.nextStepsForLogin('test-session-abc-123', true, 'https://login.example/x'), {
    displayLoginUrl: 'https://login.example/x', completeLogin: 'onchainos wallet login --phase poll --session-id test-session-abc-123', requiredOrder: ['displayLoginUrl', 'completeLogin'],
  });
  assert.equal(auth.nextStepsForLogin('s', false, 'https://login.example/x').openLoginUrl, 'https://login.example/x');
  assert.equal(auth.pendingSessionKeyName('abc'), 'pending_session_key:abc');
  const s = { accountName: 'Wallet 1' };
  auth.attachPostLoginSubscriptions(s, null);
  assert.deepEqual(s, { accountName: 'Wallet 1' });
  auth.attachPostLoginSubscriptions(s, { activeSubscriptionCount: 2 });
  assert.deepEqual(s.postLoginSubscriptions, { activeSubscriptionCount: 2 });
  assert.equal(auth.validatedPostLoginAgenticId(null), null);
  assert.equal(auth.validatedPostLoginAgenticId('   '), null);
  assert.equal(auth.validatedPostLoginAgenticId('  5254  '), '5254');
  const [id, sk, loginUrl] = auth.newLoginSession();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Buffer.from(sk, 'base64').length, 32);
  assert.ok(loginUrl.includes(`authSessionId=${id}&tempPubKey=`) && loginUrl.endsWith('&clientType=agent-cli'));
});

test('apply_all_account_address_list overwrites accounts and accountsMap, keeps identity', () => {
  store.saveWallets({
    email: 'user@test.com', projectId: 'proj-1', selectedAccountId: 'acc-old',
    accounts: [{ projectId: 'proj-1', accountId: 'acc-old', accountName: 'Old Wallet', isDefault: true }],
    accountsMap: { 'acc-old': { addressList: [{ accountId: 'acc-old', address: '0xold', chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: 'm/44/60' }] } },
  });
  auth.applyAllAccountAddressList([{ accountId: 'acc-1', accountName: 'Wallet 1', isDefault: true, addresses: [
    { accountId: 'acc-1', address: '0xabc', chainIndex: '4217', chainName: 'tempo', addressType: 'eoa', chainPath: 'm/44/60/0/0' },
    { accountId: 'acc-1', address: '0xdef', chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: 'm/44/60/0/0' },
  ] }]);
  const w = store.loadWallets();
  assert.equal(w.email, 'user@test.com');
  assert.equal(w.projectId, 'proj-1');
  assert.equal(w.selectedAccountId, 'acc-old');
  assert.deepEqual(w.accounts, [{ projectId: 'proj-1', accountId: 'acc-1', accountName: 'Wallet 1', isDefault: true }]);
  assert.deepEqual(Object.keys(w.accountsMap), ['acc-1']);
  assert.deepEqual(w.accountsMap['acc-1'].addressList.map((a) => a.chainIndex), ['4217', '1']);
  store.deleteWallets();
});

// ── wallet_store.rs ─────────────────────────────────────────────────

test('wallet_store: exact on-disk formats and cache semantics', () => {
  store.saveWallets({ email: 'e', projectId: 'p', accountsMap: { b: { addressList: [{ address: '0x1', chainIndex: '1' }] } }, accounts: [{ projectId: 'p', accountId: 'b', accountName: 'B' }] });
  assert.equal(readFileSync(join(HOME, 'wallets.json'), 'utf8'), [
    '{', '  "email": "e",', '  "isNew": false,', '  "projectId": "p",', '  "selectedAccountId": "",', '  "accountsMap": {', '    "b": {', '      "addressList": [', '        {',
    '          "accountId": "",', '          "address": "0x1",', '          "chainIndex": "1",', '          "chainName": "",', '          "addressType": "",', '          "chainPath": ""',
    '        }', '      ]', '    }', '  },', '  "accounts": [', '    {', '      "projectId": "p",', '      "accountId": "b",', '      "accountName": "B",', '      "isDefault": false', '    }', '  ],', '  "loginType": ""', '}',
  ].join('\n'));
  assert.equal(existsSync(join(HOME, 'wallets.json.tmp')), false);
  // serde_json::from_str: streaming errors with byte positions (verified against the 4.6.3 binary)
  writeFileSync(join(HOME, 'wallets.json'), '{"accounts":[{"projectId":"p"}]}');
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: missing field `accountId` at line 1 column 30' });
  writeFileSync(join(HOME, 'wallets.json'), '{"email":null}');
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: invalid type: null, expected a string at line 1 column 13' });
  writeFileSync(join(HOME, 'wallets.json'), 'null');                   // JSON null is not a missing file
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: invalid type: null, expected struct WalletsJson at line 1 column 4' });
  writeFileSync(join(HOME, 'wallets.json'), '{"email":"a","email":"b"}');
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: duplicate field `email` at line 1 column 20' });
  writeFileSync(join(HOME, 'wallets.json'), '{"loginType": 1, "email": 2}');   // document order, not field order
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: invalid type: integer `1`, expected a string at line 1 column 15' });
  writeFileSync(join(HOME, 'wallets.json'), '[]');                     // seq-form struct, all fields default
  assert.equal(store.loadWallets().email, '');
  writeFileSync(join(HOME, 'wallets.json'), '{"accounts":[["p","a"]]}');
  assert.throws(() => store.loadWallets(), { message: 'failed to parse wallets.json: invalid length 2, expected struct AccountInfo with 4 elements at line 1 column 22' });
  writeFileSync(join(HOME, 'wallets.json'), Buffer.from([0x7b, 0x22, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  assert.throws(() => store.loadWallets(), { message: 'failed to read wallets.json: stream did not contain valid UTF-8' });
  store.deleteWallets();
  assert.equal(store.loadWallets(), null);

  store.deleteCache();
  store.clearLoginCache();
  assert.equal(readFileSync(join(HOME, 'cache.json'), 'utf8'), '{}');
  store.setSwapTraceId('tid');
  assert.equal(store.getSwapTraceId(), 'tid');
  assert.equal(readFileSync(join(HOME, 'cache.json'), 'utf8'), '{\n  "swapTraceId": "tid"\n}');
  store.clearSwapTraceId();
  assert.equal(store.getSwapTraceId(), null);

  store.deleteBalanceCache();
  assert.equal(store.getBatchBalanceCache(60), null);
  store.setBatchBalanceCache([['a1', { updated_at: Math.floor(Date.now() / 1000), data: [{ z: 1, a: 2 }], total_value_usd: '1.00' }]]);
  assert.ok(store.getBatchBalanceCache(60));
  assert.equal(store.getBatchBalanceCache(0), null);
  assert.ok(store.getAccountBalanceCache('a1', 60));
  assert.equal(store.getAccountBalanceCache('zz', 60), null);
  assert.match(readFileSync(join(HOME, 'balance_cache.json'), 'utf8'), /^\{\n {2}"batch_updated_at": \d+,\n {2}"accounts": \{\n {4}"a1": \{\n {6}"updated_at": \d+,\n {6}"data": \[\n {8}\{\n {10}"a": 2,\n {10}"z": 1/);

  assert.equal(store.getChainCache(600), null);
  store.setChainCache([]);
  assert.equal(store.getChainCache(600), null);                        // empty list is never fresh
  store.setChainCache([{ chainIndex: 1 }]);
  assert.deepEqual(store.getChainCache(600).chains, [{ chainIndex: 1 }]);
  store.saveChainCache({ updated_at: 1, chains: [{ chainIndex: 1 }] });
  assert.equal(store.getChainCache(600), null);

  store.saveSession({ sessionCert: 'c', deviceId: 'd' });
  assert.equal(readFileSync(join(HOME, 'session.json'), 'utf8'), '{\n  "saTeeId": "",\n  "sessionCert": "c",\n  "encryptedSessionSk": "",\n  "sessionKeyExpireAt": "",\n  "deviceId": "d"\n}');
  assert.equal(store.loadSession().deviceId, 'd');
  store.deleteSession();
  assert.equal(store.loadSession(), null);
});

// ── account.rs ──────────────────────────────────────────────────────

const addr = (chainIndex, address) => ({ accountId: 'account-1', address, chainIndex, chainName: '', addressType: '', chainPath: '' });
const walletsWith = (list) => store.walletsJson({ selectedAccountId: 'account-1', accountsMap: { 'account-1': { addressList: list } } });

test('resolve_account_address_for_chain (account.rs oracle)', () => {
  const w = walletsWith([addr('1', '0xEvmShared'), addr('501', 'SoLaNaAddr')]);
  assert.equal(account.resolveAccountAddressForChain(w, '1'), '0xEvmShared');
  assert.equal(account.resolveAccountAddressForChain(w, '42161'), '0xEvmShared');
  assert.equal(account.resolveAccountAddressForChain(w, '501'), 'SoLaNaAddr');
  const evmOnly = walletsWith([addr('1', '0xEvmShared')]);
  for (const ci of ['0', '195', '607', '999999']) {
    assert.throws(() => account.resolveAccountAddressForChain(evmOnly, ci), { message: `no address for chain "${ci}" on the selected account` });
  }
  const two = walletsWith([addr('1', '0xSelected')]);
  two.accountsMap['account-2'] = { addressList: [addr('1', '0xOther')] };
  assert.equal(account.resolveAccountAddressForChain(two, '1'), '0xSelected');
});

test('resolve_active_account_id and status summary', () => {
  assert.equal(account.resolveActiveAccountId(store.walletsJson({ selectedAccountId: 's' })), 's');
  assert.equal(account.resolveActiveAccountId(store.walletsJson({ accounts: [{ projectId: 'p', accountId: 'a', accountName: 'A' }, { projectId: 'p', accountId: 'b', accountName: 'B', isDefault: true }] })), 'b');
  assert.equal(account.resolveActiveAccountId(store.walletsJson({ accountsMap: { k: { addressList: [] } } })), 'k');
  assert.throws(() => account.resolveActiveAccountId(store.walletsJson()), { message: 'no wallet accounts found' });
  const w = store.walletsJson({ email: 'buyer@example.com', loginType: 'email', selectedAccountId: 'account-1', accounts: [{ projectId: 'project-1', accountId: 'account-1', accountName: 'Trading', isDefault: true }] });
  const s = account.buildWalletStatusSummary(w, true, 'Trading', { enabled: true });
  assert.equal(stringify(s), '{"accountCount":1,"currentAccountId":"account-1","currentAccountName":"Trading","email":"buyer@example.com","loggedIn":true,"loginType":"email","policy":{"enabled":true}}');
  assert.equal(account.buildWalletStatusSummary(w, false, '', null).loginType, null);
});

// ── common.rs ───────────────────────────────────────────────────────

test('mask_email / is_hex_string / handle_confirming_error (common.rs oracle)', () => {
  assert.equal(common.maskEmail('user@example.com'), 'u***r@example.com');
  assert.equal(common.maskEmail('ab@example.com'), 'a***@example.com');
  assert.equal(common.maskEmail('a@example.com'), 'a***@example.com');
  assert.equal(common.maskEmail('@example.com'), '***@example.com');
  assert.equal(common.maskEmail('noatsign'), '***');
  assert.ok(!common.maskEmail('alicebob@example.com').includes('alicebob'));
  assert.equal(common.maskEmail('ünïcødé@x.io'), 'ü***é@x.io');
  assert.ok(common.isHexString('0xabcdef1234567890'));
  assert.ok(common.isHexString('0xABCDEF1234567890'));
  assert.ok(common.isHexString('0x'));
  assert.ok(!common.isHexString('abcdef'));
  assert.ok(!common.isHexString('0xGHIJKL'));
  assert.ok(!common.isHexString(''));
  assert.ok(common.isHexString('0xabcdef', 3));
  assert.ok(!common.isHexString('0xabcd', 3));
  assert.ok(common.isHexString('0x' + 'a'.repeat(64), 32));
  assert.ok(common.isHexString('0xab', 0));
  const c = common.handleConfirmingError(new api.ApiCodeError('81362', 'Risky tx, confirm?', 200), false);
  assert.ok(c instanceof Confirming);
  assert.equal(c.msg, 'Risky tx, confirm?');
  assert.equal(c.next, 'If the user confirms, re-run the same command with --force flag appended to proceed.');
  assert.equal(c.scene, undefined);
  const forced = common.handleConfirmingError(new api.ApiCodeError('81362', 'm', 200), true);
  assert.equal(forced.message, 'Wallet API error (code=81362): m');
  const other = new Error('x');
  assert.equal(common.handleConfirmingError(other, false), other);
  const p = common.walletPreviewConfirming({ message: 'review', next: 'onchainos wallet utxo lock --force', scene: 'btc_utxo_manage', preview: { outpoints: ['tx:0'] } });
  assert.equal(p.scene, 'btc_utxo_manage');
  assert.equal(p.preview.outpoints[0], 'tx:0');
  assert.equal(p.message, 'confirming: review');
});

// ── chain_profile.rs ────────────────────────────────────────────────

test('chain profile from_entry / entry_matches_name_or_alias (chain_profile.rs oracle)', () => {
  const btc = profile.fromEntry({ chainIndex: '0', realChainIndex: '5', chainName: 'Bitcoin' });
  assert.equal(btc.capabilities.transfer, 'Bitcoin');
  assert.equal(btc.chainIndex, '0');
  assert.equal(btc.nativeDecimals, 8);
  assert.equal(btc.nativeSymbol, 'BTC');
  assert.ok(btc.isBitcoin());
  const pre = { chainIndex: 0, realChainIndex: 0, chainName: 'btc', isEvmChain: false, alias: [] };
  assert.equal(profile.fromEntry(pre).realChainIndex, '0');
  assert.ok(profile.entryMatchesNameOrAlias(pre, 'bitcoin'));
  assert.ok(profile.entryMatchesNameOrAlias(pre, '0'));
  const sui = profile.fromEntry({ chainIndex: 784, realChainIndex: 784, chainName: 'sui', isEvmChain: false, alias: [] });
  assert.equal(sui.capabilities.transfer, 'Sui');
  assert.equal(sui.capabilities.messageSign, 'Unsupported');
  assert.equal(sui.capabilities.contractCall, true);
  const future = profile.fromEntry({ chainIndex: '999999', realChainIndex: '999999', chainName: 'Future Chain' });
  assert.equal(future.capabilities.transfer, 'Unsupported');
  assert.equal(future.capabilities.contractCall, false);
  assert.equal(profile.fromEntry({ chainIndex: '4217', realChainIndex: '4217', chainName: 'Tempo', isEvmChain: true }).capabilities.transfer, 'LegacyAccount');
  const sol = profile.fromEntry({ chainIndex: 501, realChainIndex: 501, chainName: 'sol', isEvmChain: false, nativeSymbol: '', chainSymbol: 'SOL' });
  assert.equal(sol.nativeDecimals, 18);
  assert.equal(sol.nativeSymbol, '');           // first string symbol field wins, then empty → default
  const entry = { chainName: 'btc', alias: ['bitcoin', '比特币'] };
  assert.ok(profile.entryMatchesNameOrAlias(entry, 'Bitcoin'));
  assert.ok(!profile.entryMatchesNameOrAlias(entry, 'ethereum'));
  assert.throws(() => profile.fromEntry({ realChainIndex: '1', chainName: 'x' }), { message: 'chain profile: chain entry missing chainIndex' });
  assert.throws(() => profile.fromEntry({ chainIndex: ' ', realChainIndex: '1', chainName: 'x' }), { message: 'chain profile: chain identifiers must not be empty' });
});

// ── balance/mod.rs + Rust formatting ────────────────────────────────

test('format! {:.N} ties-to-even (rustc 1.95 oracle) and balance totals', () => {
  const cases = [[121.125, '121.12', '121.125000', '121'], [0.125, '0.12', '0.125000', '0'], [0.375, '0.38', '0.375000', '0'], [2.5, '2.50', '2.500000', '2'],
    [1.005, '1.00', '1.005000', '1'], [-0, '-0.00', '-0.000000', '-0'], [1e21, '1000000000000000000000.00', '1000000000000000000000.000000', '1000000000000000000000'],
    [123.456789, '123.46', '123.456789', '123'], [5e-324, '0.00', '0.000000', '0'], [72.18 + 37.6 + 12.345, '122.12', '122.125000', '122']];
  for (const [x, a, b, c] of cases) assert.deepEqual([formatFixed(x, 2), formatFixed(x, 6), formatFixed(x, 0)], [a, b, c], String(x));
  assert.equal(summary.computeTotalValueUsd(J('[{"tokenAssets":[{"usdValue":"300.0"}]}]')), '300.00');
  assert.equal(summary.computeTotalValueUsd(J('{"assets":[{"usdValue":123.45}]}')), '123.45');
  assert.equal(summary.computeTotalValueUsd(J('[]')), '0.00');
  assert.equal(summary.computeTotalValueUsd(J('[{"tokenAssets":[{"usdValue":"-0.0"}]}]')), '0.00');
  const d = J('[{"tokenAssets":[{"balance":"2.0","tokenPrice":"100.0"},{"usdValue":"999.0","balance":"1","tokenPrice":"1"},{"usdValue":null,"balance":2,"tokenPrice":"3"}]}]');
  summary.enrichWithUsdValue(d);
  assert.deepEqual(d[0].tokenAssets.map((t) => t.usdValue), ['200.000000', '999.0', '6.000000']);
  const g = J('[{"accountId":"a"},{"accountId":"b"},{"accountId":1}]');
  summary.retainRequestedAccounts(g, ['b']);
  assert.deepEqual(g, [{ accountId: 'b' }]);
});

test('login identity summary picks addresses the upstream way', () => {
  const w = store.walletsJson({ accounts: [{ projectId: 'p', accountId: 'a', accountName: 'A' }], accountsMap: {
    a: { addressList: [addr('0', 'bc1p'), addr('501', 'Sol'), addr('784', '0xsui'), addr('1', '0xevm')] }, b: { addressList: [] } } });
  // get_evm_address treats every chainIndex ≠ 501 as EVM (bug-compatible): the BTC entry wins.
  assert.equal(stringify(summary.loginIdentitySummary(w, 'a')), '{"accountCount":2,"accountName":"A","btcAddress":"bc1p","evmAddress":"bc1p","solAddress":"Sol","suiAddress":"0xsui"}');
});

// ── fabricated parity homes (test/parity/make-home.mjs) ─────────────

test('parity home session material is a real, decryptable login', () => {
  const seed = hpkeDecryptSessionSk(H.encryptedSessionSk(), H.SESSION_KEY.toString('base64'));
  assert.equal(seed.toString('hex'), H.SIGNING_SEED.toString('hex'));
  const sig = ed25519.sign(seed, Buffer.from('abcd', 'hex'));
  assert.ok(ed25519.verify(ed25519.publicKey(H.SIGNING_SEED), Buffer.from('abcd', 'hex'), sig));
  assert.equal(auth.tokenExpTimestamp(H.TOKENS.access), 4102444800n);
  assert.ok(auth.isTokenExpired(H.TOKENS.accessExpired));
  const home = JSON.parse(readFileSync(new URL('../parity/homes/wallet/wallets.json', import.meta.url), 'utf8'));
  assert.equal(home.selectedAccountId, H.ACCOUNTS[0].accountId);
  assert.ok(home.accountsMap[H.ACCOUNTS[0].accountId].addressList.some((a) => a.chainIndex === '0' && a.address.startsWith('bc1p')));
});

// ── verifier additions: serde_json -0 codes, reqwest error chains, find_map ──
// (serde_json streaming semantics are covered by serde.test.mjs)

const chain = await import(L + 'wallet/chain.mjs');

test('wallet envelope treats -0 as a float code, like serde_json (not ok)', () => {
  const err = quiet(() => assert.throws(() => new api.WalletApiClient('http://x').handleResponse({ status: 200, headers: {}, body: Buffer.from('{"code":-0,"data":[]}') }),
    { message: 'Wallet API error (code=-0.0): {"code":-0.0,"data":[]}' }));
  assert.match(err, /raw body: \{"code":-0\.0,"data":\[\]\}/);
});

test('reqwest error chain and phase for transport failures (oracle: onchainos 4.6.3 binary)', () => {
  const url = 'http://127.0.0.1:18899/priapi/v5/wallet/agentic/geoblock/check';
  const req = `error sending request for url (${url})`;
  const f = (e) => api.reqwestFailure(url, e);
  assert.deepEqual(f(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), { phase: 'timeout', text: `${req}: operation timed out` });
  assert.equal(f(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' })).phase, 'connect');
  assert.match(f(Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: 'connect' })).text, /: client error \(Connect\): tcp connect error: .+ \(os error \d+\)$/);
  assert.match(f(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' })).text, /: client error \(Connect\): dns error: /);
  assert.deepEqual(f(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), { phase: 'send', text: `${req}: client error (SendRequest): connection closed before message completed` });
  assert.equal(f(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })).phase, 'send');
  assert.deepEqual(f(Object.assign(new Error('Parse Error: Expected HTTP/'), { code: 'HPE_INVALID_CONSTANT' })), { phase: 'send', text: `${req}: client error (SendRequest): invalid HTTP version parsed` });
  assert.deepEqual(f(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })),
    { phase: 'body', text: 'error decoding response body: request or response body error: error reading a body from connection: end of file before message length reached' });
  assert.equal(f(Object.assign(new Error('curl failed (28): Operation timed out'), { code: 'ECURL' })).phase, 'timeout');
});

test('show_name_for_real_id_sync is find_map: a match without showName keeps searching', () => {
  store.saveChainCache({ updated_at: 1, chains: [{ realChainIndex: '8453' }, { realChainIndex: 8453, showName: 'Base' }, { realChainIndex: '1', showName: 'Ethereum' }] });
  assert.equal(chain.showNameForRealIdSync(8453), 'Base');
  assert.equal(chain.showNameForRealIdSync(10), null);
  store.saveChainCache({ updated_at: 1, chains: [] });
  assert.equal(chain.showNameForRealIdSync(1), null);
});
