// Unit tests for the F2c wallet-rest unit: lib/wallet/{balance,history,inscription,utxo}/**,
// lib/wallet/{gas-station,receive}.mjs. Oracles are the upstream Rust unit tests
// (balance/mod.rs, history/response.rs, inscription/bitcoin.rs, utxo/*.rs, receive.rs,
// gas_station.rs) plus the behaviour spec (spec/extract/g06-wallet-core.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHash } from 'node:crypto';

// A logged-in state dir (parity home with a never-stale chain cache) and a stub wallet API;
// both must be in place before lib/config.mjs is imported.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-wallet-rest-'));
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'parity', 'homes', 'wallet-chains');
cpSync(TEMPLATE, HOME, { recursive: true });
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.env.ONCHAINOS_CREDENTIAL_STORE = 'file';
const STUB = { log: [], routes: {} };   // routes: path → [envelopes] (shifted per call, last one sticks)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    STUB.log.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    const queue = STUB.routes[req.url.split('?')[0]] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0] ?? { code: '599', msg: 'no stub', data: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof next.raw === 'string' ? next.raw : JSON.stringify(next));   // { raw } = exact body bytes
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.OCL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(HOME, { recursive: true, force: true }); });
const resetHome = () => { rmSync(HOME, { recursive: true, force: true }); cpSync(TEMPLATE, HOME, { recursive: true }); STUB.log = []; STUB.routes = {}; };
const ok = (data) => ({ code: '0', msg: 'success', data });

const L = '../../skill/onchainos-lite/lib/';
const { stringify, parse, F64 } = await import(L + 'core/json.mjs');
const { CodedError } = await import(L + 'core/errors.mjs');
const bal = await import(L + 'wallet/balance/index.mjs');
const hist = await import(L + 'wallet/history/index.mjs');
const insc = await import(L + 'wallet/inscription/bitcoin.mjs');
const brc20 = await import(L + 'wallet/utxo/brc20.mjs');
const query = await import(L + 'wallet/utxo/query.mjs');
const manage = await import(L + 'wallet/utxo/manage.mjs');
const reclaim = await import(L + 'wallet/utxo/reclaim.mjs');
const gs = await import(L + 'wallet/gas-station.mjs');
const recv = await import(L + 'wallet/receive.mjs');
const { BtcOutPoint } = await import(L + 'wallet/shared/adapters/bitcoin/models.mjs');
const { ApiCodeError, WalletApiClient } = await import(L + 'wallet/api.mjs');
const store = await import(L + 'wallet/store.mjs');

const J = (v) => parse(stringify(v));   // round-trip through the serde-compatible serialiser
const H = (c) => c.repeat(64);

// ── balance/mod.rs ───────────────────────────────────────────────────

const group = (tokens) => ({ tokenAssets: tokens.map(([balance, tokenPrice, usd]) => ({ balance, tokenPrice, ...(usd ? { usdValue: usd } : {}) })) });

test('balance: enrich_with_usd_value oracles', () => {
  let d = [group([['2.0', '100.0', '']])]; bal.enrichWithUsdValue(d); assert.equal(d[0].tokenAssets[0].usdValue, '200.000000');
  d = [group([['2.0', '100.0', '999.0']])]; bal.enrichWithUsdValue(d); assert.equal(d[0].tokenAssets[0].usdValue, '999.0');
  d = [group([['5.0', '0', '']])]; bal.enrichWithUsdValue(d); assert.equal(d[0].tokenAssets[0].usdValue, '0.000000');
  d = group([['3.0', '50.0', '']]); bal.enrichWithUsdValue(d); assert.equal(d.tokenAssets[0].usdValue, '150.000000');
  d = [{ tokenAssets: [{ balance: '5.0', tokenPrice: '10.0', usdValue: null }] }]; bal.enrichWithUsdValue(d); assert.equal(d[0].tokenAssets[0].usdValue, '50.000000');
  d = [{ assets: [{ balance: '3.0', tokenPrice: '4.0' }] }]; bal.enrichWithUsdValue(d); assert.equal(d[0].assets[0].usdValue, '12.000000');
  d = [{ tokenAssets: [{ balance: '1.0', tokenPrice: '10.0' }, { balance: '2.0', tokenPrice: '5.0', usdValue: '99.0' }, { balance: '3.0', tokenPrice: '3.0' }] }];
  bal.enrichWithUsdValue(d);
  assert.deepEqual(d[0].tokenAssets.map((t) => t.usdValue), ['10.000000', '99.0', '9.000000']);
  bal.enrichWithUsdValue(d);   // idempotent
  assert.equal(d[0].tokenAssets[0].usdValue, '10.000000');
  // numeric operands, unparseable strings, whitespace (Rust f64 grammar), non-object tokens
  d = [{ tokenAssets: [{ balance: new F64(0.5), tokenPrice: 3 }, { balance: ' 1', tokenPrice: '2' }, 'x', { usdValue: 0 }] }];
  bal.enrichWithUsdValue(d);
  assert.equal(d[0].tokenAssets[0].usdValue, '1.500000');
  assert.equal(d[0].tokenAssets[1].usdValue, '0.000000');
  assert.equal(d[0].tokenAssets[2], 'x');
  assert.equal(d[0].tokenAssets[3].usdValue, 0);
  // Rust `{:.6}` rounds the exact binary value (ties to even), unlike Number#toFixed
  d = [{ tokenAssets: [{ balance: '1', tokenPrice: '0.0000125' }, { balance: '1', tokenPrice: '0.0078125' }] }];
  bal.enrichWithUsdValue(d);
  assert.deepEqual(d[0].tokenAssets.map((t) => t.usdValue), ['0.000013', '0.007812']);
});

test('balance: compute_total_value_usd oracles', () => {
  assert.equal(bal.computeTotalValueUsd([group([['2.0', '100.0', '300.0']])]), '300.00');
  assert.equal(bal.computeTotalValueUsd([group([['2.0', '100.0', '']])]), '200.00');
  assert.equal(bal.computeTotalValueUsd([group([['1.0', '0.0', '100.00'], ['2.0', '0.0', '50.00']])]), '150.00');
  assert.equal(bal.computeTotalValueUsd([{ tokenAssets: [] }]), '0.00');
  assert.equal(bal.computeTotalValueUsd([group([['1.0', '0.0', '100.0']]), group([['1.0', '0.0', '200.0']])]), '300.00');
  assert.equal(bal.computeTotalValueUsd(J([{ tokenAssets: [{ balance: '0', tokenPrice: '0', usdValue: new F64(123.45) }] }])), '123.45');
  assert.equal(bal.computeTotalValueUsd([{ tokenAssets: [{ balance: '0', tokenPrice: '0', usdValue: '100.0' }, { balance: '2.0', tokenPrice: '50.0' }] }]), '200.00');
  assert.equal(bal.computeTotalValueUsd([{ tokenAssets: [{ usdValue: '-0.0' }] }]), '0.00');   // -0 normalised
  assert.equal(bal.computeTotalValueUsd([{ assets: [{ usdValue: '1.005' }] }]), '1.00');       // binary 1.00499…
  assert.equal(bal.computeTotalValueUsd({ tokenAssets: 'x' }), '0.00');
});

test('balance: wallet_accounts_need_refresh and address getters', () => {
  const wallets = (ids, mapIds) => ({
    accounts: ids.map((id) => ({ projectId: 'proj', accountId: id, accountName: `Wallet ${id}`, isDefault: false })),
    accountsMap: Object.fromEntries(mapIds.map((id) => [id, { addressList: [{ accountId: id, address: `0x${id}`, chainIndex: '1' }] }])),
  });
  assert.equal(bal.walletAccountsNeedRefresh(wallets([], [])), true);
  assert.equal(bal.walletAccountsNeedRefresh(wallets(['acc-1', 'acc-2'], ['acc-1'])), true);
  assert.equal(bal.walletAccountsNeedRefresh(wallets(['acc-1', 'acc-2'], ['acc-1', 'acc-2'])), false);
  assert.equal(bal.walletAccountsNeedRefresh(wallets(['acc-1'], ['acc-1'])), false);

  const multi = {
    accounts: [],
    accountsMap: {
      'acc-1': { addressList: [
        { address: '0xEVM', chainIndex: '1' }, { address: 'SolanaAddr', chainIndex: '501' },
        { address: 'BitcoinAddr', chainIndex: '0' }, { address: 'SuiAddr', chainIndex: '784' },
      ] },
      'acc-evm-only': { addressList: [{ address: '0xEVMOnly', chainIndex: '56' }] },
      'acc-btc-first': { addressList: [{ address: 'bc1p', chainIndex: '5' }, { address: '0xE', chainIndex: '1' }] },
    },
  };
  assert.equal(bal.getEvmAddress(multi, 'acc-1'), '0xEVM');
  assert.equal(bal.getSolAddress(multi, 'acc-1'), 'SolanaAddr');
  assert.equal(bal.getBtcAddress(multi, 'acc-1'), 'BitcoinAddr');
  assert.equal(bal.getSuiAddress(multi, 'acc-1'), 'SuiAddr');
  assert.equal(bal.getSolAddress(multi, 'acc-evm-only'), '');
  assert.equal(bal.getEvmAddress(multi, 'unknown'), '');
  // chain_family is "evm" for anything but 501: a BTC address listed first is returned (bug-compatible)
  assert.equal(bal.getEvmAddress(multi, 'acc-btc-first'), 'bc1p');
  assert.equal(bal.getBtcAddress(multi, 'acc-btc-first'), 'bc1p');

  multi.accounts = [{ projectId: 'p', accountId: 'acc-1', accountName: 'Account 1', isDefault: true }];
  assert.deepEqual(bal.loginIdentitySummary(multi, 'acc-1'),
    { accountName: 'Account 1', evmAddress: '0xEVM', solAddress: 'SolanaAddr', btcAddress: 'BitcoinAddr', suiAddress: 'SuiAddr', accountCount: 3 });
  assert.deepEqual(bal.loginIdentitySummary(multi, 'unknown'),
    { accountName: '', evmAddress: '', solAddress: '', btcAddress: '', suiAddress: '', accountCount: 3 });
  assert.equal(stringify(bal.loginIdentitySummary(multi, 'acc-1')),
    '{"accountCount":3,"accountName":"Account 1","btcAddress":"BitcoinAddr","evmAddress":"0xEVM","solAddress":"SolanaAddr","suiAddress":"SuiAddr"}');
});

test('balance: sum_cache_total / retain_requested_accounts / cache_for_accounts', () => {
  const entry = (usd) => ({ updated_at: 0, data: null, total_value_usd: usd });
  assert.equal(bal.sumCacheTotal({ accounts: { 'acc-1': entry('100.50'), 'acc-2': entry('50.25') } }), '150.75');
  assert.equal(bal.sumCacheTotal({ accounts: {} }), '0.00');
  assert.equal(bal.sumCacheTotal({ accounts: { a: entry('75.00'), b: entry('N/A'), c: entry(' 1') } }), '75.00');
  const data = [
    { accountId: 'acc-1', tokenAssets: [{ usdValue: '8.00' }] },
    { accountId: 'acc-2', tokenAssets: [{ usdValue: '100.00' }] },
    { accountId: 3, tokenAssets: [{ usdValue: '36.00' }] },
  ];
  bal.retainRequestedAccounts(data, ['acc-1']);
  assert.equal(data.length, 1);
  assert.equal(bal.computeTotalValueUsd(data), '8.00');
  const notArray = { accountId: 'x' };
  assert.equal(bal.retainRequestedAccounts(notArray, []), notArray);
  const filtered = bal.cacheForAccounts({ batch_updated_at: 7, accounts: { 'acc-1': entry('8.00'), stale: entry('100.00') } }, ['acc-1']);
  assert.deepEqual(Object.keys(filtered.accounts), ['acc-1']);
  assert.equal(filtered.batch_updated_at, 7);
  assert.equal(bal.sumCacheTotal(filtered), '8.00');
});

test('balance: sort_token_assets oracles', () => {
  const tok = (chainIndex, symbol, usdValue) => ({ chainIndex, symbol, usdValue });
  const order = (d) => d[0].tokenAssets.map((t) => [bal.tokenChainIndex(t), t.symbol]);
  let d = [{ tokenAssets: [tok('501', 'SOL', '100.0'), tok('196', 'OKB', '10.0'), tok('1', 'ETH', '50.0')] }];
  bal.sortTokenAssets(d);
  assert.deepEqual(order(d).map((x) => x[0]), ['196', '501', '1']);
  d = [{ tokenAssets: [tok('1', 'ETH', '1000.0'), tok('196', 'OKB', '0')] }];
  bal.sortTokenAssets(d);
  assert.equal(order(d)[0][0], '196');
  d = [{ tokenAssets: [tok('56', 'BNB', '50.0'), tok('1', 'ETH', '200.0'), tok('1', 'USDC', '100.0'), tok('56', 'USDT', '30.0')] }];
  bal.sortTokenAssets(d);
  assert.deepEqual(order(d), [['1', 'ETH'], ['1', 'USDC'], ['56', 'BNB'], ['56', 'USDT']]);
  d = [{ tokenAssets: [tok('501', 'USDC', '10.0'), tok('501', 'SOL', '500.0'), tok('501', 'BONK', '1.0')] }];
  bal.sortTokenAssets(d);
  assert.deepEqual(order(d).map((x) => x[1]), ['SOL', 'USDC', 'BONK']);
  d = [{ tokenAssets: [tok('501', 'SOL', '0.61'), tok('196', 'OKB', '0.40'), tok('1', 'ETH', '0.36'), tok('56', 'BNB', '0.34'),
    tok('8453', 'ETH', '0.23'), tok('501', 'CORGI', '0.11'), tok('501', 'USDC', '0.02')] }];
  bal.sortTokenAssets(d);
  assert.deepEqual(order(d), [['196', 'OKB'], ['501', 'SOL'], ['501', 'CORGI'], ['501', 'USDC'], ['1', 'ETH'], ['56', 'BNB'], ['8453', 'ETH']]);
  d = [{ tokenAssets: [] }]; bal.sortTokenAssets(d); assert.equal(d[0].tokenAssets.length, 0);
  bal.sortTokenAssets({ tokenAssets: [] });
  // numeric chainIndex / usdValue
  d = J([{ tokenAssets: [{ chainIndex: 1, usdValue: new F64(2.5), symbol: 'A' }, { chainIndex: '1', usdValue: 3, symbol: 'B' }] }]);
  bal.sortTokenAssets(d);
  assert.deepEqual(d[0].tokenAssets.map((t) => t.symbol), ['B', 'A']);
  assert.equal(bal.tokenUsd({ usdValue: 'abc' }), 0);
  assert.equal(bal.tokenChainIndex({ chainIndex: true }), '');
});

test('balance: project_token_fields oracles', () => {
  const KEPT = ['balance', 'chainIndex', 'decimal', 'rawBalance', 'symbol', 'tokenAddress', 'tokenName', 'tokenPrice', 'usdValue'];
  const full = () => ({
    symbol: 'ETH', tokenName: 'Ethereum', chainIndex: '1', tokenAddress: '', balance: '1.5', rawBalance: '1500000000000000000',
    decimal: '18', tokenPrice: '3000.0', usdValue: '4500.0', address: '0xWALLET', absSpendingPendingBalance: '0', spendingPendingBalance: '0',
    receivedPendingBalance: '0', activeBuy: true, coinTypeNo: '123', customName: 'My ETH', customSymbol: 'mETH', multiplier: '1',
    tokenType: 'native', imageUrl: 'https://example.com/eth.png', priceChangeRate24H: '0.05',
  });
  const keys = (t) => Object.keys(t).sort();
  let d = [{ tokenAssets: [full()] }];
  bal.projectTokenFields(d);
  assert.deepEqual(keys(d[0].tokenAssets[0]), KEPT);
  d = [{ assets: [full()] }]; bal.projectTokenFields(d); assert.deepEqual(keys(d[0].assets[0]), KEPT);
  d = { tokenAssets: [full()] }; bal.projectTokenFields(d); assert.deepEqual(keys(d.tokenAssets[0]), KEPT);
  d = [{ accountId: 'acc-1', totalValueUsd: '4500.0', tokenAssets: [full()] }];
  bal.projectTokenFields(d);
  assert.equal(d[0].accountId, 'acc-1');
  assert.equal(d[0].totalValueUsd, '4500.0');
  const once = [{ tokenAssets: [full()] }];
  bal.projectTokenFields(once);
  const twice = structuredClone(once);
  bal.projectTokenFields(twice);
  assert.deepEqual(twice, once);
  d = J([{ tokenAssets: [{ symbol: 'ETH', tokenAddress: '', usdValue: new F64(4500.0), balance: '1.5', tokenName: null }] }]);
  bal.projectTokenFields(d);
  assert.equal(stringify(d[0].tokenAssets[0]), '{"balance":"1.5","symbol":"ETH","tokenAddress":"","usdValue":4500.0}');
  d = [{ tokenAssets: ['not-an-object', 42, full()] }];
  bal.projectTokenFields(d);
  assert.equal(d[0].tokenAssets[0], 'not-an-object');
  assert.equal(d[0].tokenAssets[1], 42);
  assert.deepEqual(keys(d[0].tokenAssets[2]), KEPT);
  // only the first array-valued key is touched (tokenAssets wins over assets)
  d = [{ tokenAssets: [], assets: [full()] }];
  bal.projectTokenFields(d);
  assert.equal(Object.keys(d[0].assets[0]).length, 21);
});

test('balance: match_readable_token / match_readable_balance oracles', () => {
  const fixture = [{ accountId: 'acc-1', tokenAssets: [
    { symbol: 'OKB', chainIndex: '196', tokenAddress: '', balance: '0.08504764' },
    { symbol: 'USDC', chainIndex: '196', tokenAddress: '0x74b7f16337b8972027f6196a17a631ac6de26d22', balance: '12.5' },
    { symbol: 'USDC', chainIndex: '1', tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', balance: '999.0' },
  ] }];
  assert.equal(bal.matchReadableBalance(fixture, '196', ''), '0.08504764');
  assert.equal(bal.matchReadableBalance(fixture, '196', '0x74b7f16337b8972027f6196a17a631ac6de26d22'), '12.5');
  assert.equal(bal.matchReadableBalance(fixture, '1', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), '999.0');
  assert.equal(bal.matchReadableBalance(fixture, '196', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), null);
  assert.equal(bal.matchReadableBalance(fixture, '1', '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), '999.0');
  assert.equal(bal.matchReadableBalance(fixture, '56', ''), null);
  assert.equal(bal.matchReadableBalance({ assets: [{ symbol: 'ETH', chainIndex: 1, tokenAddress: '', balance: '1.25' }] }, '1', ''), '1.25');
  assert.deepEqual(bal.matchReadableToken(fixture, '196', '0x74b7f16337b8972027f6196a17a631ac6de26d22'), { balance: '12.5', symbol: 'USDC', decimals: undefined });
  const blank = { tokenAssets: [
    { chainIndex: '1', tokenAddress: '', balance: '1.0', decimal: 18 },
    { symbol: '   ', chainIndex: '1', tokenAddress: '0xabc', balance: '2.0', decimal: '6' },
    { symbol: 'X', chainIndex: '1', tokenAddress: '0xbig', balance: J(new F64(1.5)), decimal: 4294967296 },
    { symbol: 'Y', chainIndex: '1', tokenAddress: '0xbad', balance: null },
  ] };
  assert.deepEqual(bal.matchReadableToken(blank, '1', ''), { balance: '1.0', symbol: undefined, decimals: 18 });
  assert.deepEqual(bal.matchReadableToken(blank, '1', '0xabc'), { balance: '2.0', symbol: undefined, decimals: 6 });
  assert.deepEqual(bal.matchReadableToken(blank, '1', '0xbig'), { balance: '1.5', symbol: 'X', decimals: undefined });
  assert.equal(bal.matchReadableToken(blank, '1', '0xbad'), null);   // a non-string/number balance stops the search
  assert.equal(bal.valueAsU32('7'), 7);
  assert.equal(bal.valueAsU32('+7'), 7);
  assert.equal(bal.valueAsU32(4294967295), 4294967295);
  assert.equal(bal.valueAsU32(4294967296), undefined);
  assert.equal(bal.valueAsU32('-1'), undefined);
  assert.equal(bal.valueAsU32(new F64(6)), undefined);
});

test('balance: ensure_wallet_accounts_fresh / refresh_wallet_accounts_strict against a stub API', async () => {
  resetHome();
  const client = new WalletApiClient();
  const wallets = store.loadWallets();
  // complete account data → no request unless forced
  await bal.ensureWalletAccountsFresh(client, 'tok', wallets, false);
  assert.equal(STUB.log.length, 0);
  // forced: account/list failure is swallowed and nothing is written
  STUB.routes['/priapi/v5/wallet/agentic/account/list'] = [{ code: '50001', msg: 'down', data: [] }];
  const before = readFileSync(join(HOME, 'wallets.json'), 'utf8');
  await bal.ensureWalletAccountsFresh(client, 'tok', wallets, true);
  assert.equal(readFileSync(join(HOME, 'wallets.json'), 'utf8'), before);
  // forced: list ok, address list fails → accounts replaced, map kept, file saved
  STUB.routes['/priapi/v5/wallet/agentic/account/list'] = [ok([{ projectId: 'p', accountId: 'new-1', accountName: 'N', isDefault: true }])];
  STUB.routes['/priapi/v5/wallet/agentic/account/address/list'] = [{ code: '1', msg: 'x', data: [] }];
  await bal.ensureWalletAccountsFresh(client, 'tok', wallets, true);
  const saved = JSON.parse(readFileSync(join(HOME, 'wallets.json'), 'utf8'));
  assert.deepEqual(saved.accounts, [{ projectId: 'p', accountId: 'new-1', accountName: 'N', isDefault: true }]);
  assert.equal(Object.keys(saved.accountsMap).length, 3);
  // strict: errors surface as `code=<c> msg=<m>`
  STUB.routes['/priapi/v5/wallet/agentic/account/list'] = [{ code: '50001', msg: 'down', data: [] }];
  await assert.rejects(bal.refreshWalletAccountsStrict(client, 'tok', store.loadWallets()), { message: 'code=50001 msg=down' });
  // strict: wholesale replacement; selection falls back to the default account
  STUB.routes['/priapi/v5/wallet/agentic/account/list'] = [ok([
    { projectId: 'p', accountId: 'a', accountName: 'A', isDefault: false }, { projectId: 'p', accountId: 'b', accountName: 'B', isDefault: true }])];
  STUB.routes['/priapi/v5/wallet/agentic/account/address/list'] = [ok([{ accounts: [{ accountId: 'b', addresses: [{ address: '0xb', chainIndex: 1, chainName: 'eth', addressType: 'eoa', chainPath: null }] }] }])];
  const w = store.loadWallets();
  await bal.refreshWalletAccountsStrict(client, 'tok', w);
  assert.equal(w.selectedAccountId, 'b');
  assert.deepEqual(Object.keys(w.accountsMap), ['b']);
  const file = JSON.parse(readFileSync(join(HOME, 'wallets.json'), 'utf8'));
  assert.deepEqual(file.accountsMap.b.addressList[0], { accountId: 'b', address: '0xb', chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: '' });
  // no default → first account; no accounts → ""
  STUB.routes['/priapi/v5/wallet/agentic/account/list'] = [ok([])];
  STUB.routes['/priapi/v5/wallet/agentic/account/address/list'] = [ok([{ accounts: [] }])];
  const w2 = store.loadWallets();
  await bal.refreshWalletAccountsStrict(client, 'tok', w2);
  assert.equal(w2.selectedAccountId, '');
});

test('balance: cmd_balance --all serves a fresh batch cache without HTTP', async () => {
  resetHome();
  const entry = (usd) => ({ updated_at: 1, data: [{ accountId: 'x', tokenAssets: [] }], total_value_usd: usd });
  writeFileSync(join(HOME, 'balance_cache.json'), JSON.stringify({
    batch_updated_at: 4102444800,
    accounts: { 'parity-account-0002': entry('2.50'), 'parity-account-0001': entry('1.25'), 'stale-identity': entry('100.00') },
  }));
  const out = await bal.cmdBalance(true, undefined, undefined, false);
  assert.equal(STUB.log.length, 0);
  assert.equal(stringify(out), '{"details":{"parity-account-0001":{"data":[{"accountId":"x","tokenAssets":[]}],"total_value_usd":"1.25","updated_at":1},'
    + '"parity-account-0002":{"data":[{"accountId":"x","tokenAssets":[]}],"total_value_usd":"2.50","updated_at":1}},"totalValueUsd":"3.75"}');
  // --force bypasses the cache; the batch response is enriched + projected per account
  STUB.routes['/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch'] = [ok([
    { accountId: 'parity-account-0001', tokenAssets: [{ balance: '2', tokenPrice: '3', imageUrl: 'x' }] },
    { accountId: 'foreign', tokenAssets: [{ usdValue: '9' }] },
  ])];
  const forced = await bal.cmdBalance(true, undefined, undefined, true);
  assert.equal(STUB.log.length, 1);
  assert.match(STUB.log[0].path, /accountIds=parity-account-000[123]%2Cparity-account-000[123]%2Cparity-account-000[123]$/);
  assert.equal(forced.details['parity-account-0001'].total_value_usd, '6.00');
  assert.equal(stringify(forced.details['parity-account-0001'].data), '[{"accountId":"parity-account-0001","tokenAssets":[{"balance":"2","tokenPrice":"3","usdValue":"6.000000"}]}]');
  assert.equal(forced.totalValueUsd, '8.50');   // 6.00 + the cached 2.50 of account 2
  const cache = JSON.parse(readFileSync(join(HOME, 'balance_cache.json'), 'utf8'));
  assert.ok(cache.batch_updated_at > 1700000000 && cache.batch_updated_at < 4102444800);
  assert.ok(!('foreign' in cache.accounts));
});

test('balance: login_account_summary best-effort total', async () => {
  resetHome();
  const client = new WalletApiClient();
  const wallets = store.loadWallets();
  STUB.routes['/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch'] = [{ code: '1', msg: 'x', data: [] }];
  let s = await bal.loginAccountSummary(client, 'tok', wallets, 'parity-account-0001');
  assert.equal(s.totalValueUsd, '');
  assert.equal(s.accountName, 'Account 1');
  STUB.routes['/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch'] = [ok([{ accountId: 'parity-account-0001', tokenAssets: [{ balance: '1', tokenPrice: '2', imageUrl: 'kept' }] }])];
  s = await bal.loginAccountSummary(client, 'tok', wallets, 'parity-account-0001');
  assert.equal(s.totalValueUsd, '2.00');
  const cache = JSON.parse(readFileSync(join(HOME, 'balance_cache.json'), 'utf8'));
  assert.equal(cache.accounts['parity-account-0001'].data[0].tokenAssets[0].imageUrl, 'kept');   // enriched, not projected
});

test('balance: query_token_metadata / query_token_readable', async () => {
  resetHome();
  STUB.routes['/priapi/v5/wallet/agentic/token/get-token-info'] = [ok([{ decimals: null, decimal: '6', tokenSymbol: null, symbol: 'USDC' }])];
  assert.deepEqual(await bal.queryTokenMetadata('1', '0xa'), { symbol: undefined, decimals: 6 });
  assert.deepEqual(STUB.log[0].body, { chainIndex: 1, source: 0, tokenAddress: '0xa' });
  STUB.routes['/priapi/v5/wallet/agentic/token/get-token-info'] = [ok({ decimals: 18, symbol: 'ETH' })];
  assert.deepEqual(await bal.queryTokenMetadata('1', ''), { symbol: 'ETH', decimals: 18 });
  STUB.routes['/priapi/v5/wallet/agentic/token/get-token-info'] = [ok([{ tokenSymbol: 'X' }])];
  await assert.rejects(bal.queryTokenMetadata('1', ''), { message: 'token metadata missing decimals' });
  await assert.rejects(bal.queryTokenMetadata('x1', ''), { message: 'invalid numeric chain index: x1' });
  STUB.routes['/priapi/v5/wallet/agentic/asset/wallet-all-token-balances'] = [ok([{ tokenAssets: [{ chainIndex: '1', tokenAddress: '', balance: '0.5', symbol: 'ETH', imageUrl: 'x' }] }])];
  assert.deepEqual(await bal.queryTokenReadable('1', ''), { balance: '0.5', symbol: 'ETH', decimals: undefined });
  assert.equal(await bal.queryTokenReadableBalance('1', '0xnone'), null);
});

// ── history/response.rs ──────────────────────────────────────────────

test('history: status / direction mapping and response filters', () => {
  assert.equal(hist.mapTxStatus('4'), 'SUCCESS');
  assert.deepEqual(['1', '2', '3', '6', 'X', 4, null].map(hist.mapTxStatus), ['PENDING', 'PENDING', 'ERROR', 'CANCELLED', 'X', '', '']);
  assert.deepEqual(['1', '2', 'SWAP', 1].map(hist.mapDirection), ['IN', 'OUT', 'SWAP', '']);
  const detail = hist.filterDetailResponse([{ chainIndex: '0', txHash: 'btc-hash', txStatus: '4' }, { chainIndex: '784', txHash: 'sui-hash', txStatus: '2' }]);
  assert.equal(detail[0].chainIndex, '0');
  assert.equal(detail[0].txStatus, 'SUCCESS');
  assert.equal(detail[1].chainIndex, '784');
  assert.equal(detail[1].txStatus, 'PENDING');
  assert.equal(detail[0].explorerUrl, null);
  const full = hist.filterDetailResponse({ txType: '2', feeName: 'ETH', feeDecimalNum: '', feeContainCreateAccount: true, contractInfo: { name: 'Pool' }, input: [{ name: 'A', amount: '1', direction: '1' }], output: 'x' });
  assert.equal(full.length, 1);
  assert.equal(full[0].serviceChargeSymbol, 'ETH');
  assert.ok(!('serviceChargeDecimal' in full[0]));
  assert.equal(full[0].networkFeeLabel, 'Network fee and Rent fee');
  assert.equal(full[0].contractName, 'Pool');
  assert.deepEqual(full[0].input, [{ name: 'A', amount: '1', direction: 'IN' }]);
  assert.ok(!('output' in full[0]));
  assert.equal(hist.filterDetailResponse([{ feeContainCreateAccount: false }])[0].networkFeeLabel, 'Network fee');
  assert.deepEqual(hist.filterDetailResponse(null)[0].txStatus, '');

  const list = hist.filterListResponse([{ cursor: 'c1', orderList: [{ txHash: 'h', direction: '2', coinSymbol: 'ETH', coinAmount: '1', nftCollectionName: '',
    assetChange: [{ coinSymbol: 'NFT', coinAmount: '1', direction: '1', nftId: '7', nftImageUrl: '' }] }] }, { cursor: 5 }]);
  assert.equal(list[0].cursor, 'c1');
  const o = list[0].orderList[0];
  assert.equal(o.direction, 'IN');
  assert.equal(o.coinSymbol, 'NFT');
  assert.deepEqual(o.assetChange, [{ coinSymbol: 'NFT', coinAmount: '1', direction: 'IN', nftId: '7' }]);
  assert.ok(!('nftCollectionName' in o));
  assert.deepEqual(list[1], { cursor: '', orderList: [] });
  assert.equal(stringify(hist.filterListResponse({ orderList: [{ assetChange: [] }] })),
    '[{"cursor":"","orderList":[{"assetChange":[],"chainSymbol":null,"coinAmount":null,"coinSymbol":null,"confirmedCount":null,"direction":"","from":null,"hideTxType":null,"repeatTxType":null,"serviceCharge":null,"to":null,"txCreateTime":null,"txHash":null,"txStatus":"","txTime":null}]}]');
});

test('history: cmd_query_history request shapes', async () => {
  resetHome();
  STUB.routes['/priapi/v5/wallet/agentic/order/list'] = [ok([{ cursor: 'n', orderList: [] }])];
  const out = await hist.cmdQueryHistory(undefined, 'eth', undefined, '1', '', 'c', '20', undefined, undefined, undefined);
  assert.deepEqual(out, [{ cursor: 'n', orderList: [] }]);
  assert.equal(STUB.log[0].path, '/priapi/v5/wallet/agentic/order/list?accountId=parity-account-0001&begin=1&cursor=c&limit=20&chainIndex=1');
  await assert.rejects(hist.cmdQueryHistory(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '0x1', undefined),
    { message: '--chain is required for order detail query' });
  await assert.rejects(hist.cmdQueryHistory('', 'nochain'), { message: 'unsupported chain: nochain' });
  STUB.routes['/priapi/v5/wallet/agentic/order/detail'] = [ok({ txStatus: '6' })];
  const d = await hist.cmdQueryHistory('acc-x', '501', 'addr', undefined, undefined, undefined, undefined, '', '0xh', 'u');
  assert.equal(d[0].txStatus, 'CANCELLED');
  assert.equal(STUB.log.at(-1).path, '/priapi/v5/wallet/agentic/order/detail?accountId=acc-x&chainIndex=501&address=addr&txHash=0xh&uopHash=u');
});

// ── inscription/bitcoin.rs ───────────────────────────────────────────

test('inscription: reveal selection, status lifecycle, continuation command', () => {
  const b = (txHash, orderId) => ({ pkgId: '', orderId, orderType: '', txHash });
  assert.deepEqual(insc.selectRevealBroadcast([b('commit-hash', 'commit-order'), b('reveal-hash', 'reveal-order')]), b('reveal-hash', 'reveal-order'));
  assert.equal(insc.selectRevealBroadcast([]), undefined);
  assert.equal(insc.normalizeInscriptionStatus('2'), 'INSCRIBING');
  assert.equal(insc.normalizeInscriptionStatus('4'), 'READY_TO_TRANSFER');
  assert.equal(insc.normalizeInscriptionStatus('6'), 'FAILED');
  assert.equal(insc.normalizeInscriptionStatus('waiting_indexer'), 'WAITING_INDEXER');
  assert.equal(insc.normalizeInscriptionStatus('ünknown'), 'üNKNOWN');   // ASCII-only uppercase
  const cmd = insc.buildInscriptionNextCommand('btc-brc20-pizza', '1', new F64(1.25), 'token');
  assert.ok(cmd.includes('--fee-rate 1.25 --force'));
  assert.ok(!cmd.includes('--preview-version'));
  assert.equal(insc.buildInscriptionNextCommand('btc-brc20-pizza', "1 o'", 8, 'sha256:ab'),
    "onchainos wallet inscription create --chain bitcoin --token-address btc-brc20-pizza --readable-amount '1 o'\"'\"'' --operation-token sha256:ab --fee-rate 8 --force");
  assert.equal(insc.inscriptionStatusMessage('READY_TO_TRANSFER', true), 'The BRC-20 inscription is ready. Refresh the transferable balance before starting a separate transfer.');
  assert.equal(insc.inscriptionStatusMessage('UNKNOWN', true), 'The BRC-20 inscription is not available; review the service detail before deciding whether to create another inscription.');
  assert.equal(insc.inscriptionStatusMessage('INSCRIBING', true), 'The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query again at the service-recommended time.');
  assert.equal(insc.inscriptionStatusMessage('X', false), 'The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query it again later with the returned transaction hash or order ID.');
});

// ── utxo/brc20.rs ────────────────────────────────────────────────────

const transferableSnapshot = () => ({ brc20TransferableUtxoList: { sumValueRaw: '3000000000000000000', count: 2, utxos: [
  { txHash: H('c'), voutIndex: 2, utxoId: 'utxo-1', utxoAmountRaw: '546', valueRaw: '1000000000000000000', offset: '0', inscriptionId: 'inscription-1' },
  { txHash: H('d'), voutIndex: 3, utxoId: 'utxo-2', utxoAmountRaw: '600', valueRaw: '2000000000000000000', offset: '1', inscriptionId: 'inscription-2' },
] } });

test('brc20: transferable choices, selections and asset enrichment', () => {
  const [selected] = brc20.selectBrc20TransferableUtxos(transferableSnapshot(), [`${H('c')}:2`]);
  assert.equal(selected.valueRaw, '1000000000000000000');
  assert.equal(selected.utxoAmountRaw, '546');
  assert.equal(selected.buildTxParamInput('bc1pfrom').amount, '546');
  assert.equal(stringify(selected.buildTxParamInput('bc1pfrom')), `{"address":"bc1pfrom","amount":"546","txId":"${H('c')}","vout":2}`);
  const choice = selected.buildChoice('btc-brc20-pizza', 18);
  assert.equal(choice.tokenAmount, '1');
  assert.equal(choice.utxoAmountSats, '546');
  assert.equal(choice.selection, `${H('c')}:2`);
  assert.equal(stringify(choice), `{"inscriptionId":"inscription-1","offset":"0","selection":"${H('c')}:2","tokenAddress":"btc-brc20-pizza","tokenAmount":"1","tokenAmountRaw":"1000000000000000000","utxoAmountSats":"546","utxoId":"utxo-1"}`);

  const choices = [{ selection: `${H('c')}:2` }, { selection: `${H('d')}:3` }];
  brc20.enrichBrc20ChoiceAssets(choices, [
    { txHash: H('c'), voutIndex: 2, assets: [{ protocol: 'BRC20', symbol: 'pizza', readableAmount: '1' }] },
    { txHash: H('d'), voutIndex: '3', assets: [] },
  ]);
  assert.equal(choices[0].assets[0].symbol, 'pizza');
  assert.ok(!('assets' in choices[1]));

  const two = brc20.selectBrc20TransferableUtxos(transferableSnapshot(), [`${H('d')}:3`, `${H('c').toUpperCase()}:2`]);
  assert.deepEqual(two.map((u) => u.valueRaw), ['2000000000000000000', '1000000000000000000']);
  assert.throws(() => brc20.selectBrc20TransferableUtxos(transferableSnapshot(), [`${H('c')}:2`, `${H('c')}:2`]), /selected more than once/);
  assert.throws(() => brc20.selectBrc20TransferableUtxos(transferableSnapshot(), [`${H('e')}:0`]), { message: `selected BRC-20 UTXO is no longer transferable: ${H('e')}:0` });
  assert.throws(() => brc20.selectBrc20TransferableUtxos(transferableSnapshot(), []),
    { message: 'BRC-20 transfers require at least one --brc20-outpoint selected from wallet utxo brc20-transferable' });

  assert.throws(() => brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: '', voutIndex: 1 }] }), { message: 'transferable UTXO 0 is missing txHash' });
  assert.throws(() => brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: H('a'), voutIndex: -1 }] }), { message: 'transferable UTXO 0 is missing voutIndex' });
  assert.throws(() => brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: H('a'), voutIndex: 1, valueRaw: '1' }] }), { message: 'transferable UTXO 0 is missing utxoAmountRaw' });
  assert.throws(() => brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: H('a'), voutIndex: 1, utxoAmountRaw: 1 }] }), { message: 'transferable UTXO 0 is missing valueRaw' });
  assert.deepEqual(brc20.parseBrc20TransferableUtxos({ brc20TransferableUtxoList: { utxos: null }, utxos: [{}] }), []);   // present null wins
  assert.deepEqual(brc20.parseBrc20TransferableUtxos([1]), []);
  const flat = brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: H('A'), voutIndex: '1', utxoAmountRaw: 546, valueRaw: '5', offset: 3, utxoId: 7 }] });
  assert.equal(flat[0].outpoint.canonical(), `${H('a')}:1`);
  assert.equal(flat[0].offset, '3');
  assert.equal(flat[0].utxoId, '');
  assert.equal(flat[0].inscriptionId, '');
});

test('brc20: template values with exact decimals', () => {
  const balance = [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza', balance: '4.25', tokenPrice: '1.2', usdValue: '5.1' }] }];
  const s = brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, balance, transferableSnapshot());
  assert.equal(s.ticker, 'pizza');
  assert.equal(s.totalAmount, '4.25');
  assert.equal(s.transferableAmount, '3');
  assert.equal(s.remainingInscribableAmount, '1.25');
  assert.equal(s.totalUsd, '5.1');
  assert.equal(s.transferableUsd, '3.6');
  assert.equal(s.remainingInscribableUsd, '1.5');
  assert.equal(s.count, 2);
  assert.deepEqual(s.denominations, ['1', '2']);
  const noPrice = brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza', balance: '3' }] }], transferableSnapshot());
  assert.equal(noPrice.totalUsd, null);
  assert.equal(noPrice.transferableUsd, null);
  assert.equal(noPrice.remainingInscribableUsd, null);
  // nested search in sorted-key order; case-insensitive token match; sum of valueRaw without sumValueRaw
  const nested = { z: { tokenAssets: [{ tokenAddress: 'BTC-BRC20-PIZZA', balance: 5, tokenPrice: '1e2' }] }, a: [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza', balance: '9' }] }] };
  const snap = transferableSnapshot();
  delete snap.brc20TransferableUtxoList.sumValueRaw;
  const n = brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, nested, snap);
  assert.equal(n.totalAmount, '9');
  assert.equal(n.remainingInscribableAmount, '6');
  assert.throws(() => brc20.buildBrc20TemplateValues('btc-brc20-x', 18, balance, transferableSnapshot()), { message: 'BRC-20 balance response did not contain btc-brc20-x' });
  assert.throws(() => brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza' }] }], transferableSnapshot()),
    { message: 'BRC-20 balance response is missing balance' });
  assert.throws(() => brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza', balance: '2' }] }], transferableSnapshot()),
    { message: 'transferable BRC-20 amount cannot exceed BRC-20 total amount' });
  assert.throws(() => brc20.buildBrc20TemplateValues('btc-brc20-pizza', 18, [{ tokenAssets: [{ tokenAddress: 'btc-brc20-pizza', balance: '1e3' }] }], transferableSnapshot()),
    { message: 'BRC-20 total amount must be a non-negative plain decimal' });
});

test('brc20: decimal helpers', () => {
  assert.deepEqual(brc20.parseDecimal(' 1.50 ', 'x'), [150n, 2]);
  for (const bad of ['', '.5', '5.', '1.2.3', '-1', '1e5', '١']) assert.throws(() => brc20.parseDecimal(bad, 'f'), { message: 'f must be a non-negative plain decimal' });
  assert.equal(brc20.formatDecimal(150n, 2), '1.5');
  assert.equal(brc20.formatDecimal(5n, 3), '0.005');
  assert.equal(brc20.formatDecimal(100n, 2), '1');
  assert.equal(brc20.formatDecimal(0n, 0), '0');
  assert.equal(brc20.decimalSubtract('4.25', '3', 'a', 'b'), '1.25');
  assert.equal(brc20.decimalSubtract('3', '3.000', 'a', 'b'), '0');
  assert.throws(() => brc20.decimalSubtract('1', '1.5', 'left', 'right'), { message: 'right cannot exceed left' });
  assert.equal(brc20.decimalMultiply('3', '1.2', 'a', 'b'), '3.6');
  assert.equal(brc20.decimalMultiply('0.5', '0.25', 'a', 'b'), '0.125');
  assert.equal(brc20.pointer({ a: { b: null } }, '/a/b'), null);
  assert.equal(brc20.pointer({ a: [1] }, '/a/0'), undefined);
  assert.equal(brc20.recordOutpointKey({ txHash: 'h', voutIndex: 3 }), 'h:3');
  assert.equal(brc20.recordOutpointKey({ txHash: 'h', voutIndex: '03' }), 'h:03');
  assert.equal(brc20.recordOutpointKey({ txHash: 'h', voutIndex: -1 }), undefined);
});

test('brc20: exact selection plans', () => {
  const snapshot = transferableSnapshot();
  const transferable = brc20.parseBrc20TransferableUtxos(snapshot);
  const choices = transferable.map((u) => u.buildChoice('btc-brc20-pizza', 18));
  let plan = brc20.buildBrc20SelectionPlan(transferable, choices, '3', 18);
  assert.equal(plan.status, 'EXACT_MATCH');
  assert.equal(plan.combinationCount, 1);
  assert.equal(plan.combinations[0].selectedCount, 2);
  assert.equal(plan.combinations[0].selectedOutpoints.length, 2);
  plan = brc20.buildBrc20SelectionPlan(transferable, choices, '4', 18);
  assert.equal(plan.status, 'NO_EXACT_MATCH');
  assert.deepEqual(plan.combinations, []);
  assert.equal(stringify(plan), '{"combinationCount":0,"combinations":[],"maxCombinations":3,"requestedAmount":"4","requestedAmountRaw":"4000000000000000000","searchStateLimit":100000,"status":"NO_EXACT_MATCH"}');

  const utxos = (value) => ['a', 'b', 'c', 'd'].map((digit, index) => new brc20.Brc20TransferableUtxo({
    outpoint: BtcOutPoint.parse(`${digit.repeat(64)}:${index}`), utxoId: `utxo-${index}`, utxoAmountRaw: '546', valueRaw: value, offset: '0', inscriptionId: `inscription-${index}`,
  }));
  let t = utxos('1000000000000000000');
  plan = brc20.buildBrc20SelectionPlan(t, t.map((u) => u.buildChoice('btc-brc20-pizza', 18)), '1', 18);
  assert.equal(plan.status, 'EXACT_MATCH');
  assert.equal(plan.maxCombinations, 3);
  assert.equal(plan.combinationCount, 3);
  assert.ok(plan.combinations.every((c) => c.selectedCount === 1));
  t = utxos('1');
  plan = brc20.buildBrc20SelectionPlan(t, t.map((u) => u.buildChoice('btc-brc20-pizza', 0)), '2', 0);
  assert.equal(plan.combinationCount, 3);
  assert.ok(plan.combinations.every((c) => c.selectedCount === 2));
  assert.deepEqual(plan.combinations.map((c) => c.selectedOutpoints.map((o) => o[0])), [['a', 'b'], ['a', 'c'], ['a', 'd']]);
  // fewest inputs first, then lexicographic index order
  const mix = ['5', '15', '10', '25', '30'].map((v, i) => new brc20.Brc20TransferableUtxo({ outpoint: BtcOutPoint.parse(`${'e'.repeat(64)}:${i}`), utxoId: '', utxoAmountRaw: '1', valueRaw: v, offset: undefined, inscriptionId: '' }));
  const r = brc20.findExactCombination(mix, 45n);
  assert.deepEqual(r, { kind: 'Exact', combinations: [[1, 4], [0, 1, 3], [0, 2, 4]] });
  assert.deepEqual(brc20.findExactCombination(mix, 1000n), { kind: 'NoExactMatch' });
  assert.throws(() => brc20.findExactCombination([new brc20.Brc20TransferableUtxo({ outpoint: mix[0].outpoint, valueRaw: '0' })], 1n),
    { message: 'transferable UTXO 0 valueRaw must be greater than zero' });
  assert.throws(() => brc20.buildBrc20SelectionPlan(t, [], '0', 0), /readable-amount/);
});

// ── utxo/query.rs ────────────────────────────────────────────────────

test('utxo query: modes, section outpoints and asset annotation', () => {
  assert.equal(query.UtxoQueryMode.UserIgnored.queryType, 'USER_IGNORED_LIST');
  assert.equal(query.UtxoQueryMode.UserIgnored.resultKey, 'userIgnored');
  assert.ok(query.UtxoQueryMode.UserIgnored.message.includes('asset occupancy was explicitly removed by the user'));
  assert.equal(query.UtxoQueryMode.Unavailable.queryType, 'UNAVAILABLE_BREAKDOWN');
  assert.equal(query.UtxoQueryMode.Available.queryType, 'AVAILABLE_UTXO_LIST');
  assert.equal(query.UtxoQueryMode.Available.resultKey, 'available');
  const ui = '4d3f6a7a45dbb9d3398a8f83c0219b6bedfdcd77d1de63cc09f9cfe360c553c0';
  const snapshot = {
    userIgnoredList: [{ txHash: ui, voutIndex: 0 }],
    unavailableBreakdown: { assetLocked: [{ txHash: H('a'), voutIndex: 1 }] },
    availableUtxoList: { sumSats: '546', count: 1, utxos: [{ txHash: H('b'), voutIndex: 2, valueRaw: '546' }] },
  };
  assert.deepEqual(query.collectResponseOutpoints(query.UtxoQueryMode.UserIgnored, snapshot).map((p) => p.txHash), [ui]);
  assert.deepEqual(query.collectResponseOutpoints(query.UtxoQueryMode.Unavailable, snapshot).map((p) => p.txHash), [H('a')]);
  assert.deepEqual(query.collectResponseOutpoints(query.UtxoQueryMode.Available, snapshot).map((p) => p.txHash), [H('b')]);
  assert.equal(query.collectResponseOutpoints(query.UtxoQueryMode.Available, { availableUtxoList: null, x: [{ txHash: H('c'), voutIndex: 0 }] }).length, 0);
  assert.equal(query.collectResponseOutpoints(query.UtxoQueryMode.Available, { x: [{ txHash: H('c'), voutIndex: 0 }] }).length, 1);

  const snap = { availableUtxoList: { utxos: [{ txHash: H('a'), voutIndex: '0', valueRaw: '546' }, { txHash: H('b'), voutIndex: 1, valueRaw: '546' }] } };
  query.enrichBrc20Assets(snap, [
    { txHash: H('a'), voutIndex: 0, assets: [{ protocol: 'BRC20', symbol: 'pizza', readableAmount: '1' }] },
    { txHash: H('b'), voutIndex: '1', assets: [] },
  ]);
  assert.equal(snap.availableUtxoList.utxos[0].assets[0].symbol, 'pizza');
  assert.ok(!('assets' in snap.availableUtxoList.utxos[1]));
});

// ── utxo/manage.rs ───────────────────────────────────────────────────

test('utxo manage: continuation validation and confirmation tokens', () => {
  for (const token of ['', 'sha256:not-a-digest']) {
    assert.throws(() => manage.validateManageContinuation(token, true), (e) => e instanceof CodedError && e.code === 'INVALID_PREVIEW_CONTINUATION'
      && e.field === 'operationToken' && !e.message.includes('state changed'));
  }
  manage.validateManageContinuation(`sha256:${H('a')}`, true);
  manage.validateManageContinuation(undefined, false);
  assert.throws(() => manage.validateManageContinuation(undefined, true), { message: 'confirmed UTXO protection changes require the preview continuation' });
  assert.throws(() => manage.validateManageContinuation('x', false), { message: 'preview continuation parameters are only valid with --force' });
  assert.equal(manage.isConfirmationToken(`sha256:${H('A')}`), true);
  assert.equal(manage.isConfirmationToken(`sha256:${H('a')}0`), false);

  const targets = ['4d3f6a7a45dbb9d3398a8f83c0219b6bedfdcd77d1de63cc09f9cfe360c553c0:0'];
  const original = manage.buildManageConfirmationToken('UNLOCK_UTXO_PROTECTION', '0', 'account-a', 'bc1ptest', targets);
  assert.equal(original, manage.buildManageConfirmationToken('UNLOCK_UTXO_PROTECTION', '0', 'account-a', 'bc1ptest', targets));
  assert.notEqual(original, manage.buildManageConfirmationToken('UNLOCK_UTXO_PROTECTION', '0', 'account-a', 'bc1ptest', [`${H('a')}:1`]));
  assert.notEqual(original, manage.buildManageConfirmationToken('LOCK_UTXO_PROTECTION', '0', 'account-a', 'bc1ptest', targets));
  assert.notEqual(original, manage.buildManageConfirmationToken('UNLOCK_UTXO_PROTECTION', '0', 'account-b', 'bc1ptest', targets));
  assert.match(original, /^sha256:[0-9a-f]{64}$/);
  // JCS: sorted keys, compact → a fixed digest for a fixed intent
  const jcs = `{"accountId":"account-a","chainIndex":"0","from":"bc1ptest","network":"bitcoin","operationType":"UNLOCK_UTXO_PROTECTION","targets":["${targets[0]}"]}`;
  assert.equal(original, `sha256:${createHash('sha256').update(jcs).digest('hex')}`);
  assert.equal(manage.resolveManagementReason('ignoreAsset'), 'User confirmed removal of UTXO asset protection');
  assert.equal(manage.resolveManagementOperationType('cancelIgnore'), 'LOCK_UTXO_PROTECTION');
  assert.throws(() => manage.resolveManagementReason('x'), { message: 'unsupported UTXO management action: x' });
});

test('utxo manage: candidates, targets and batch normalisation', () => {
  const locked = '4d3f6a7a45dbb9d3398a8f83c0219b6bedfdcd77d1de63cc09f9cfe360c553c0';
  const snapshot = { unavailableBreakdown: {
    assetLocked: { count: 1, utxos: [{ txHash: locked, voutIndex: 0 }] },
    feeUneconomic: { count: 1, utxos: [{ txHash: H('a'), voutIndex: 1 }] },
    assetUncertain: { count: 0, utxos: [] },
  } };
  const candidates = manage.collectProtectedOutpoints(snapshot, false);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].txHash, locked);
  assert.equal(manage.hasGroupItems(snapshot, '/unavailableBreakdown/assetUncertain'), false);
  assert.equal(manage.hasGroupItems({ g: { count: '2' } }, '/g'), true);
  assert.equal(manage.hasGroupItems({ g: { count: 'x', utxos: [{ txHash: H('b'), voutIndex: 0 }] } }, '/g'), true);
  assert.equal(manage.hasGroupItems({}, '/g'), false);
  const withUncertain = { unavailableBreakdown: { assetLocked: [{ txHash: H('b'), voutIndex: 0 }], assetUncertain: [{ txHash: H('a'), voutIndex: 5 }, { txHash: H('b'), voutIndex: 0 }] } };
  assert.deepEqual(manage.collectProtectedOutpoints(withUncertain, true).map((p) => p.canonical()), [`${H('a')}:5`, `${H('b')}:0`]);

  const avail = [BtcOutPoint.parse(`${H('b')}:10`), BtcOutPoint.parse(`${H('b')}:2`), BtcOutPoint.parse(`${H('a')}:3`)];
  assert.deepEqual(manage.selectTargets(avail, [`${H('B')}:10`, `${H('a')}:3`, `${H('b')}:2`], false).map((p) => p.canonical()),
    [`${H('a')}:3`, `${H('b')}:2`, `${H('b')}:10`]);
  assert.deepEqual(manage.selectTargets(avail, [], true), avail);
  assert.throws(() => manage.selectTargets([], [], true), { message: 'no matching UTXOs were returned by the current service snapshot' });
  assert.throws(() => manage.selectTargets(avail, [], false), { message: 'at least one --outpoint is required' });
  assert.throws(() => manage.selectTargets(avail, [`${H('b')}:2`, `${H('B')}:2`], false), { message: `duplicate --outpoint ${H('b')}:2` });
  assert.throws(() => manage.selectTargets(avail, [`${H('c')}:2`], false), (e) => e instanceof CodedError && e.code === 'STATE_CHANGED' && e.field === 'outpoint'
    && e.message === `The requested outpoint ${H('c')}:2 is not present in the latest UTXO snapshot`);

  const targets = [BtcOutPoint.parse(`${locked}:0`), BtcOutPoint.parse(`${H('a')}:1`)];
  const outcome = manage.normalizeManageBatchResult([{ result: false, resaon: 'already spent' }], 2, targets);
  assert.equal(outcome.batchIndex, 2);
  assert.equal(outcome.outpoints[0], targets[0].canonical());
  assert.equal(outcome.result, false);
  assert.equal(outcome.reason, 'already spent');
  assert.equal(manage.normalizeManageBatchResult([{ result: true, reason: null, resaon: 'x' }], 0, targets).reason, null);
  assert.throws(() => manage.normalizeManageBatchResult({ result: true }, 0, targets), { message: 'UTXO management response data must be an array' });
  assert.throws(() => manage.normalizeManageBatchResult([{ result: true }, { result: true }], 0, targets), { message: 'UTXO management response data must contain exactly one item' });
  assert.throws(() => manage.normalizeManageBatchResult([{ result: 'true' }], 0, targets), { message: 'UTXO management response item is missing boolean result' });

  const ctx = { batchResults: [], unavailable: {}, userIgnored: {} };
  const coded = manage.enrichManageError(new CodedError('82002', null, 'utxo not found', { data: { state: 'UTXO_NOT_FOUND' } }), ctx);
  assert.deepEqual(coded.data, { ...ctx, serviceData: { state: 'UTXO_NOT_FOUND' } });
  const unknown = manage.enrichManageError(new Error('Network result is unknown'), ctx);
  assert.equal(unknown.code, 'UTXO_MANAGE_RESULT_UNKNOWN');
  assert.equal(unknown.message, 'UTXO management result is unknown: Network result is unknown');
  assert.deepEqual(unknown.data, ctx);
});

// ── utxo/reclaim.rs ──────────────────────────────────────────────────

test('utxo reclaim: close-result validation and txid parsing', () => {
  assert.deepEqual(reclaim.validateCloseResult([{ txHash: 'aa', closed: true }, { txHash: 'BB', closed: false }], ['aa', 'bb']), ['bb']);
  assert.throws(() => reclaim.validateCloseResult({}, ['aa']), { message: 'close-transaction response data must be an array' });
  assert.throws(() => reclaim.validateCloseResult([{ txHash: '' }], ['aa']), { message: 'close-transaction item is missing txHash' });
  assert.throws(() => reclaim.validateCloseResult([{ txHash: 'cc', closed: true }], ['aa']), { message: 'close-transaction returned an unexpected txHash cc' });
  assert.throws(() => reclaim.validateCloseResult([{ txHash: 'aa', closed: true }, { txHash: 'AA', closed: true }], ['aa']), { message: 'close-transaction returned duplicate txHash aa' });
  assert.throws(() => reclaim.validateCloseResult([{ txHash: 'aa', closed: 1 }], ['aa']), { message: 'close-transaction item is missing closed' });
  assert.throws(() => reclaim.validateCloseResult([{ txHash: 'aa', closed: true }], ['aa', 'bb']), { message: 'close-transaction response does not cover every requested txHash' });
  assert.equal(reclaim.parseTxid(H('a')), H('a'));
});

// ── gas_station.rs ───────────────────────────────────────────────────

test('gas station: recommendation mapping and success message', () => {
  const r = (gasStationStatus, extra = {}) => ({ gasStationStatus, hasPendingTx: false, insufficientAll: false, gasStationUsed: false, ...extra });
  assert.equal(gs.recommendFromProbe(r('READY_TO_USE')), 'READY');
  assert.equal(gs.recommendFromProbe(r('NOT_APPLICABLE')), 'READY');
  assert.equal(gs.recommendFromProbe(r('FIRST_TIME_PROMPT')), 'ENABLE_GAS_STATION');
  assert.equal(gs.recommendFromProbe(r('PENDING_UPGRADE')), 'PENDING_UPGRADE');
  assert.equal(gs.recommendFromProbe(r('REENABLE_ONLY')), 'REENABLE_GAS_STATION');
  assert.equal(gs.recommendFromProbe(r('NOT_SUPPORT_INTENTION')), 'NOT_SUPPORT_INTENTION');
  assert.equal(gs.recommendFromProbe(r('INSUFFICIENT_ALL')), 'INSUFFICIENT_ALL');
  assert.equal(gs.recommendFromProbe(r('HAS_PENDING_TX')), 'HAS_PENDING_TX');
  assert.equal(gs.recommendFromProbe(r('FIRST_TIME_PROMPT', { insufficientAll: true })), 'INSUFFICIENT_ALL');
  assert.equal(gs.recommendFromProbe(r('FIRST_TIME_PROMPT', { hasPendingTx: true, insufficientAll: true })), 'HAS_PENDING_TX');
  assert.equal(gs.recommendFromProbe(r('SOMETHING_NEW', { gasStationUsed: true })), 'ENABLE_GAS_STATION');
  assert.equal(gs.recommendFromProbe(r('SOMETHING_NEW')), 'READY');
  assert.equal(gs.recommendFromProbe(r('ready_to_use')), 'READY');   // case-sensitive: Unknown, not used
  assert.deepEqual(gs.attachSuccessMessage({ a: 1 }, 'm'), { a: 1, message: 'm' });
  assert.deepEqual(gs.attachSuccessMessage([1], 'm'), { message: 'm', data: [1] });
  assert.deepEqual(gs.attachSuccessMessage(null, 'm'), { message: 'm', data: null });
});

// ── receive.rs ───────────────────────────────────────────────────────

test('receive: generic view builds only the EVM QR', () => {
  const addr = (chainIndex, address) => ({ accountId: 'account-1', address, chainIndex, chainName: '', addressType: '', chainPath: '' });
  const wallets = (list) => ({ selectedAccountId: 'account-1', accounts: [{ projectId: 'project-1', accountId: 'account-1', accountName: 'Trading', isDefault: true }],
    accountsMap: { 'account-1': { addressList: list } } });
  const v = recv.genericReceiveValue(wallets([addr('196', '0xXLayerDifferent'), addr('1', '0xEvm'), addr('501', 'SolanaAddress'), addr('0', 'BitcoinAddress'), addr('784', 'SuiAddress')]));
  assert.equal(v.reason, 'receive_addresses_ready');
  assert.equal(v.payload.evmAddress, '0xEvm');
  assert.equal(typeof v.payload.evmQr, 'object');
  assert.ok(v.payload.evmQr !== null);
  assert.equal(v.payload.xLayerAddress, '0xXLayerDifferent');
  assert.equal(v.payload.solanaAddress, 'SolanaAddress');
  assert.ok(!('solanaQr' in v.payload) && !('bitcoinQr' in v.payload) && !('suiQr' in v.payload));
  const same = recv.genericReceiveValue(wallets([addr('196', '0xSame'), addr('501', '')]));
  assert.equal(same.payload.evmAddress, '0xSame');
  assert.equal(same.payload.xLayerAddress, null);
  assert.equal(same.payload.solanaAddress, null);
  const none = recv.genericReceiveValue(wallets([addr('5', 'bc1')]));
  assert.equal(none.payload.evmAddress, null);
  assert.equal(none.payload.evmQr, null);
  assert.equal(none.payload.bitcoinAddress, 'bc1');
  assert.throws(() => recv.genericReceiveValue({ selectedAccountId: 'x', accounts: [], accountsMap: {} }), { message: 'account not found' });
  assert.deepEqual(Object.keys(v).sort(), ['decision', 'nextAction', 'payload', 'phase', 'reason']);
  assert.equal(stringify(v.nextAction), '[{"id":"specify_funding_chain","params":{},"recommend":true},{"id":"search_receive_token","params":{},"recommend":false}]');
});

test('receive: token candidates, pagination and chain scope', () => {
  const raw = J([
    { tokenName: 'Tether', tokenSymbol: 'USDT', chainIndex: '1', tokenContractAddress: '0x1234567890abcdef', cursor: '8' },
    { tokenName: 'Tether', tokenSymbol: 'USDT', chainIndex: 196, tokenContractAddress: '', cursor: '9' },
  ]);
  const names = new Map([['1', 'Ethereum'], ['196', 'X Layer']]);
  const candidates = recv.normalizeCandidates(raw, names);
  assert.equal(candidates[0].sequence, 1);
  assert.equal(candidates[0].tokenContractAddress, '0x1234567890abcdef');
  assert.equal(candidates[1].networkName, 'X Layer');
  assert.equal(candidates[1].tokenContractAddress, '');
  const selection = recv.selectionValue('USDT', candidates);
  assert.equal(selection.decision, 'requires_user_input');
  assert.equal(selection.payload.pagination.nextCursor, null);
  assert.equal(selection.nextAction[0].params.chainIndex, '1');

  const full = Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, chainIndex: '1', tokenContractAddress: `0x${i + 1}`, cursor: `cursor-${i + 1}` }));
  const page = recv.selectionValue('USDT', full);
  assert.equal(page.payload.pagination.nextCursor, 'cursor-10');
  const more = page.nextAction.at(-1);
  assert.equal(more.id, 'more_receive_tokens');
  assert.deepEqual(more.params, { query: 'USDT', cursor: 'cursor-10' });
  full[9].cursor = '';
  assert.equal(recv.selectionValue('USDT', full).payload.pagination.nextCursor, null);

  assert.equal(recv.supportedChainIndices([{ chainIndex: '1' }, { chainIndex: 196 }, { chainIndex: '1' }, { chainIndex: '' }, { chainIndex: J(new F64(2)) }]), '1,196');
  const nm = recv.supportedChainNames([{ chainIndex: 1, chainName: 'eth' }, { chainIndex: '1', showName: 'Ethereum' }, { chainIndex: 2, showName: '', chainName: 'x' }, { chainIndex: 3, showName: 5, chainName: 'c' }]);
  assert.deepEqual([...nm], [['1', 'Ethereum'], ['3', 'c']]);
  // skipped raw entries keep their 1-based position; only the first 10 raw items are considered
  const skipped = recv.normalizeCandidates({ items: [{ chainIndex: '' }, { chainIndex: 56, tokenName: null }] }, new Map());
  assert.deepEqual(skipped, [{ sequence: 2, tokenName: null, tokenSymbol: null, chainIndex: '56', networkName: 'BNB Chain', tokenContractAddress: '', cursor: null }]);
  assert.equal(recv.normalizeCandidates({ list: Array.from({ length: 12 }, () => ({ chainIndex: '1' })) }, new Map()).length, 10);
  assert.deepEqual(recv.normalizeCandidates('x', new Map()), []);
  assert.equal(recv.valueAsString(J(-5)), '-5');
  assert.equal(recv.valueAsString(18446744073709551615n), '18446744073709551615');
  assert.equal(recv.valueAsString(true), undefined);

  const ready = recv.receiveAddressValue({ target: { accountName: 'A', chainIndex: '1', chainName: 'Ethereum', receiveAddress: '0x1', gasFree: false, sameNetworkRequired: true },
    qr: { requestedFormat: 'auto', displayMode: 'image-notify' } }, { tokenName: 'T', tokenSymbol: 'S', chainIndex: '1' });
  assert.equal(stringify(ready.payload), '{"accountName":"A","chainIndex":"1","chainName":"Ethereum","gasFree":false,"networkName":null,"qr":{"displayMode":"image-notify","requestedFormat":"auto"},"receiveAddress":"0x1","sameNetworkRequired":true,"tokenContractAddress":null,"tokenName":"T","tokenSymbol":"S"}');
});

test('receive: cmd_receive refuses a blank token before any request', async () => {
  resetHome();
  await assert.rejects(recv.cmdReceive(undefined, '  　', undefined), { message: 'Parameter --token cannot be empty' });
  assert.equal(STUB.log.length, 0);
  assert.ok(existsSync(join(HOME, 'wallets.json')));
});

test('api error types used by the BTC adapters surface unchanged', () => {
  const e = new ApiCodeError('1', 'x');
  assert.equal(e.message, 'Wallet API error (code=1): x');
});

// ── clap relations (lib/wallet/utxo/_clap.mjs) ───────────────────────
// Oracles: stderr of the upstream 4.6.3 binary for the same argv (clap 4.6 Validator order:
// conflicts in ArgMatcher order, then the required graph + required_unless; smart usage).

const { clapValidate } = await import(L + 'wallet/utxo/_clap.mjs');
const RECEIVE = { conflicts: [['chain', 'token'], ['chain', 'cursor']], requires: [['cursor', 'token']] };
const MANAGE = { conflicts: [['outpoint', 'all']], requiredUnless: [['outpoint', ['all']]] };
const STATUS = { conflicts: [['txHash', 'orderId']], requiredUnless: [['txHash', ['orderId']], ['orderId', ['txHash']]] };
const clapErr = (path, argv, rules) => {
  try { clapValidate({ path, argv }, rules); return null; } catch (e) { return e.message; }
};
const usage = (msg, use) => `error: ${msg}\n\nUsage: onchainos ${use}\n\nFor more information, try '--help'.\n`;

test('clap: conflicts in matcher order, "with:" lists, and the requires-aware usage line', () => {
  assert.equal(clapErr('wallet receive', ['wallet', 'receive', '--cursor', 'x', '--chain', 'y'], RECEIVE),
    usage("the argument '--cursor <CURSOR>' cannot be used with '--chain <CHAIN>'", 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(clapErr('wallet receive', ['wallet', 'receive', '--token', 'x', '--cursor', 'y', '--chain', 'z'], RECEIVE),
    usage("the argument '--token <TOKEN>' cannot be used with '--chain <CHAIN>'", 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(clapErr('wallet receive', ['wallet', 'receive', '--chain', '1', '--cursor', '9', '--token', 'x'], RECEIVE),
    usage("the argument '--chain <CHAIN>' cannot be used with:\n  --cursor <CURSOR>\n  --token <TOKEN>", 'wallet receive --chain <CHAIN>'));
  assert.equal(clapErr('wallet utxo unlock', ['wallet', 'utxo', 'unlock', '--all', '--force', '--outpoint', 'a', '--chain', 'bitcoin'], MANAGE),
    usage("the argument '--all' cannot be used with '--outpoint <OUTPOINT>'", 'wallet utxo unlock --chain <CHAIN> --all --force'));
  assert.equal(clapErr('wallet inscription status', ['wallet', 'inscription', 'status', '--chain', 'b', '--order-id', 'a', '--tx-hash', 'b'], STATUS),
    usage("the argument '--order-id <ORDER_ID>' cannot be used with '--tx-hash <TX_HASH>'", 'wallet inscription status --chain <CHAIN> --order-id <ORDER_ID>'));
  // the global --chain before the subcommand is not a leaf arg: no conflict (upstream then panics in cmd_receive)
  assert.equal(clapErr('wallet receive', ['--chain', 'eth', 'wallet', 'receive', '--token', 'USDT'], RECEIVE), null);
});

test('clap: required graph, required_unless and requires; the global --chain does not satisfy a leaf --chain', () => {
  const missing = (list) => `the following required arguments were not provided:\n${list.map((a) => `  ${a}`).join('\n')}`;
  assert.equal(clapErr('wallet receive', ['wallet', 'receive', '--cursor', 'x'], RECEIVE),
    usage(missing(['--token <TOKEN>']), 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(clapErr('wallet utxo unlock', ['wallet', 'utxo', 'unlock', '--force', '--chain', 'bitcoin', '--operation-token', 'x'], MANAGE),
    usage(missing(['--outpoint <OUTPOINT>']), 'wallet utxo unlock --chain <CHAIN> --force --operation-token <OPERATION_TOKEN> --outpoint <OUTPOINT>'));
  assert.equal(clapErr('wallet utxo lock', ['wallet', 'utxo', 'lock'], MANAGE),
    usage(missing(['--chain <CHAIN>', '--outpoint <OUTPOINT>']), 'wallet utxo lock --chain <CHAIN> --outpoint <OUTPOINT>'));
  assert.equal(clapErr('wallet utxo unlock', ['--chain', 'bitcoin', 'wallet', 'utxo', 'unlock', '--all'], MANAGE),
    usage(missing(['--chain <CHAIN>']), 'wallet utxo unlock --chain <CHAIN> --all'));
  assert.equal(clapErr('wallet inscription status', ['wallet', 'inscription', 'status'], STATUS),
    usage(missing(['--chain <CHAIN>', '--tx-hash <TX_HASH>', '--order-id <ORDER_ID>']), 'wallet inscription status --chain <CHAIN> --tx-hash <TX_HASH> --order-id <ORDER_ID>'));
  assert.equal(clapErr('wallet inscription status', ['wallet', 'inscription', 'status', '--tx-hash', 'a'], STATUS),
    usage(missing(['--chain <CHAIN>']), 'wallet inscription status --chain <CHAIN> --tx-hash <TX_HASH>'));
  assert.equal(clapErr('wallet gas-station setup', ['wallet', 'gas-station', 'setup', '--from', 'x', '--relayer-id', 'y'], {}),
    usage(missing(['--chain <CHAIN>', '--gas-token-address <GAS_TOKEN_ADDRESS>']),
      'wallet gas-station setup --chain <CHAIN> --gas-token-address <GAS_TOKEN_ADDRESS> --relayer-id <RELAYER_ID> --from <FROM>'));
  assert.equal(clapErr('wallet utxo reclaim', ['wallet', 'utxo', 'reclaim', '--force'], {}),
    usage(missing(['--chain <CHAIN>', '--tx-hash <TX_HASH>']), 'wallet utxo reclaim --chain <CHAIN> --tx-hash <TX_HASH> --force'));
  assert.equal(clapErr('wallet utxo unlock', ['wallet', 'utxo', 'unlock', '--chain', 'bitcoin', '--outpoint', 'a', '--outpoint', 'b'], MANAGE), null);
});

test('balance: --all batch cache keeps server number forms and rounds {:.2} half-to-even', async () => {
  resetHome();
  STUB.routes['/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch'] = [{ raw: '{"code":"0","msg":"success","data":['
    + '{"accountId":"parity-account-0002","tokenAssets":['
    + '{"chainIndex":"1","symbol":"ETH","balance":"0.25","tokenPrice":"3000.5","usdValue":750.125,"isRiskToken":false},'
    + '{"chainIndex":196,"symbol":"USDT","balance":"10","decimal":6,"tokenPrice":1.0,"usdValue":null},'
    + '{"chainIndex":"501","symbol":"SOL","balance":2,"tokenPrice":"150","usdValue":""}]},'
    + '{"accountId":12345,"tokenAssets":[]}]}' }];
  const out = await bal.cmdBalance(true, undefined, undefined, true);
  const entry = out.details['parity-account-0002'];
  assert.equal(stringify(entry.data), '[{"accountId":"parity-account-0002","tokenAssets":['
    + '{"balance":"0.25","chainIndex":"1","symbol":"ETH","tokenPrice":"3000.5","usdValue":750.125},'
    + '{"balance":"10","chainIndex":196,"decimal":6,"symbol":"USDT","tokenPrice":1.0,"usdValue":"10.000000"},'
    + '{"balance":2,"chainIndex":"501","symbol":"SOL","tokenPrice":"150","usdValue":"300.000000"}]}]');
  assert.equal(entry.total_value_usd, '1060.12');   // 1060.125 is exact in binary → ties to even
  assert.equal(out.totalValueUsd, '1060.12');
  assert.match(readFileSync(join(HOME, 'balance_cache.json'), 'utf8'), /"tokenPrice": 1\.0,/);
  assert.deepEqual(Object.keys(out.details), ['parity-account-0002']);
});
