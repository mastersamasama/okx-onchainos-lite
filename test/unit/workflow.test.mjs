// G-workflow: commands/workflows/{mod,token_research,smart_money,new_tokens,wallet_analysis,portfolio}.rs
// and commands/upgrade.rs. Every upstream #[cfg(test)] assertion of those files is ported, plus
// request fan-out checks (paths, params, step ordering) against a mock ApiClient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated empty state dir (resolve_chain reads chain_cache.json) — before importing lib modules.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-workflow-'));
process.env.OCL_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const CMD = '../../skill/onchainos-lite/lib/commands/';
const W = await import(CMD + 'workflow/index.mjs');
const TRS = await import(CMD + 'workflow/token-research.mjs');
const SM = await import(CMD + 'workflow/smart-money.mjs');
const NT = await import(CMD + 'workflow/new-tokens.mjs');
const WA = await import(CMD + 'workflow/wallet-analysis.mjs');
const PF = await import(CMD + 'workflow/portfolio.mjs');
const UP = await import(CMD + 'upgrade/upgrade.mjs');
const { parse, stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { UPSTREAM_VERSION, LITE_VERSION } = await import('../../skill/onchainos-lite/lib/config.mjs');

const someData = () => ({ key: 'value' });
const rejects = async (p, re) => {
  try { await p; } catch (e) { assert.match(e.message, re); return; }
  assert.fail('expected rejection');
};

// Mock ApiClient: records calls in issue order; answers via a function (value or Error).
function mockClient(answer = () => null) {
  const calls = [];
  const next = (method, path, arg) => {
    calls.push({ method, path, arg });
    const a = answer(method, path, arg);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a === undefined ? null : a);
  };
  return { calls, get: (p, q = []) => next('GET', p, q), post: (p, b) => next('POST', p, b) };
}
const q = (pairs) => pairs.filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('&');
const sig = (c) => `${c.method} ${c.path}${c.method === 'GET' ? (q(c.arg) ? '?' + q(c.arg) : '') : ' ' + stringify(c.arg)}`;

// ── mod.rs::ok_or_null ──────────────────────────────────────────────────
test('ok_or_null passes through ok value / null / empty array, converts errors to null', async () => {
  assert.deepEqual(await W.okOrNull(Promise.resolve({ price: '1.23' })), { price: '1.23' });
  assert.equal(await W.okOrNull(Promise.reject(new Error('API timeout'))), null);
  assert.equal(await W.okOrNull(Promise.resolve(null)), null);
  assert.deepEqual(await W.okOrNull(Promise.resolve([])), []);
  // thunk form: a synchronous throw while building the request is an Err too
  assert.equal(await W.okOrNull(() => { throw new Error('boom'); }), null);
  assert.deepEqual(await W.okOrNull(() => Promise.resolve([1])), [1]);
});

// ── token_research.rs ───────────────────────────────────────────────────
const fullAssemble = (info, price, advanced, security, launchpad) =>
  TRS.assemble('0xTOKEN', '501', info, price, advanced, security, someData(), someData(), someData(), someData(), launchpad);

test('token_research::assemble — all Step 1 null → error naming address and chain', () => {
  assert.throws(() => fullAssemble(null, null, null, null, null), (e) =>
    e.message === 'token-research: all Step 1 sub-calls failed for address 0xTOKEN on chain 501');
});

test('token_research::assemble — single Step 1 null keeps the rest', () => {
  assert.doesNotThrow(() => fullAssemble(null, someData(), someData(), someData(), null));
  assert.doesNotThrow(() => fullAssemble(someData(), null, someData(), someData(), null));
  assert.doesNotThrow(() => fullAssemble(someData(), someData(), null, someData(), null));
  assert.doesNotThrow(() => fullAssemble(someData(), someData(), someData(), null, null));
  assert.doesNotThrow(() => fullAssemble(null, null, null, someData(), null)); // security alone suffices
  const out = fullAssemble(null, someData(), someData(), someData(), null);
  assert.equal(out.core.info, null);
  assert.notEqual(out.core.price, null);
});

test('token_research::assemble — launchpad, discriminator, blocks, key order', () => {
  assert.equal(fullAssemble(someData(), someData(), someData(), someData(), null).launchpad, null);
  const lp = { tokenDetails: { bonding: '80%' }, devInfo: { rugCount: 0 }, bundleInfo: { bundleRate: '5%' }, similarTokens: [] };
  assert.equal(fullAssemble(someData(), someData(), someData(), someData(), lp).launchpad.devInfo.rugCount, 0);
  assert.equal(fullAssemble(someData(), someData(), null, someData(), null).launchpad, null);
  const out = fullAssemble(someData(), someData(), someData(), someData(), null);
  assert.equal(out.workflow, 'token-research');
  assert.equal(out.address, '0xTOKEN');
  assert.equal(out.chain, '501');
  for (const k of ['info', 'price', 'contract', 'security']) assert.notEqual(out.core[k], null);
  for (const k of ['holders', 'cluster', 'topTraders', 'signals']) assert.notEqual(out.structure[k], null);
  // json! → BTreeMap: keys print sorted
  assert.equal(stringify(TRS.assemble('a', '1', 1, 2, 3, 4, 5, 6, 7, 8, null)),
    '{"address":"a","chain":"1","core":{"contract":3,"info":1,"price":2,"security":4},"launchpad":null,"structure":{"cluster":6,"holders":5,"signals":8,"topTraders":7},"workflow":"token-research"}');
  const nc = TRS.assemble('0xNEW', '501', someData(), someData(), someData(), someData(), someData(), null, someData(), someData(), null);
  assert.equal(nc.structure.cluster, null);
  assert.notEqual(nc.structure.holders, null);
});

test('token_research::is_launchpad_token', () => {
  assert.equal(TRS.isLaunchpadToken({ protocolId: '120596' }), true);
  assert.equal(TRS.isLaunchpadToken({ protocolId: '' }), false);
  assert.equal(TRS.isLaunchpadToken({ name: 'BONK' }), false);
  assert.equal(TRS.isLaunchpadToken(null), false);
  assert.equal(TRS.isLaunchpadToken({}), false);
  assert.equal(TRS.isLaunchpadToken({ protocolId: 120596 }), false);
  assert.equal(TRS.isLaunchpadToken([{ protocolId: '1' }]), false);   // array → Index gives Null
  assert.equal(TRS.isLaunchpadToken('protocolId'), false);
  assert.equal(TRS.isLaunchpadToken(parse('{"protocolId":null}')), false);
});

test('token_research::all_null', () => {
  assert.equal(TRS.allNull([null, null, null]), true);
  assert.equal(TRS.allNull([null, someData(), null]), false);
  assert.equal(TRS.allNull([{}]), false);
  assert.equal(TRS.allNull([[]]), false);
});

test('token_research::search_and_select — candidates, fallbacks, message, request', async () => {
  const items = parse(`[
    {"tokenSymbol":"Bonk","tokenName":"Bonk","tokenContractAddress":"A1","chainIndex":"501","price":"1","marketCap":"2","logoUrl":"u","extra":true},
    {"symbol":"S2","name":"N2","address":"A2","chain":"501"},
    {"tokenSymbol":null,"symbol":"IGNORED","price":1.0},
    "not-an-object"
  ]`);
  const c = mockClient(() => items);
  const out = await TRS.searchAndSelect(c, 'bonk', 'solana');
  assert.equal(sig(c.calls[0]), 'GET /api/v6/dex/market/token/search?chains=501&search=bonk&limit=5');
  assert.equal(stringify(out),
    '{"candidates":['
    + '{"address":"A1","chain":"501","index":1,"logoUrl":"u","marketCap":"2","name":"Bonk","price":"1","symbol":"Bonk"},'
    + '{"address":"A2","chain":"501","index":2,"logoUrl":null,"marketCap":null,"name":"N2","price":null,"symbol":"S2"},'
    + '{"address":null,"chain":null,"index":3,"logoUrl":null,"marketCap":null,"name":null,"price":1.0,"symbol":null},'
    + '{"address":null,"chain":null,"index":4,"logoUrl":null,"marketCap":null,"name":null,"price":null,"symbol":null}],'
    + `"message":"${TRS.SELECT_TOKEN_MESSAGE}","query":"bonk","step":"select-token","workflow":"token-research"}`);
  for (const empty of [[], {}, null, { list: [1] }]) {
    await rejects(TRS.searchAndSelect(mockClient(() => empty), "it's", '501'), /^token-research: no tokens found for query 'it's' on chain 501$/);
  }
  await rejects(TRS.searchAndSelect(mockClient(() => new Error('API error (code=1): x')), 'q', '501'), /^API error \(code=1\): x$/);
});

test('token_research::fetch_and_assemble — step fan-out and launchpad gating', async () => {
  const advanced = { protocolId: '120596' };
  const c = mockClient((m, p) => (p.endsWith('/advanced-info') ? advanced : p.endsWith('/holder') ? new Error('500') : { p }));
  const out = await TRS.fetchAndAssemble(c, 'TOK', '501');
  assert.deepEqual(c.calls.map(sig), [
    'POST /api/v6/dex/market/token/basic-info [{"chainIndex":"501","tokenContractAddress":"TOK"}]',
    'POST /api/v6/dex/market/price-info [{"chainIndex":"501","tokenContractAddress":"TOK"}]',
    'GET /api/v6/dex/market/token/advanced-info?chainIndex=501&tokenContractAddress=TOK',
    'POST /api/v6/security/token-scan {"source":"onchain_os_cli","tokenList":[{"chainId":"501","contractAddress":"TOK"}]}',
    'GET /api/v6/dex/market/token/holder?chainIndex=501&tokenContractAddress=TOK&limit=100',
    'GET /api/v6/dex/market/token/cluster/overview?chainIndex=501&tokenContractAddress=TOK',
    'GET /api/v6/dex/market/token/top-trader?chainIndex=501&tokenContractAddress=TOK&limit=20',
    'POST /api/v6/dex/market/signal/list {"chainIndex":"501","limit":"20","tokenAddress":"TOK"}',
    'GET /api/v6/dex/market/memepump/tokenDetails?chainIndex=501&tokenContractAddress=TOK',
    'GET /api/v6/dex/market/memepump/tokenDevInfo?chainIndex=501&tokenContractAddress=TOK',
    'GET /api/v6/dex/market/memepump/tokenBundleInfo?chainIndex=501&tokenContractAddress=TOK',
    'GET /api/v6/dex/market/memepump/similarToken?chainIndex=501&tokenContractAddress=TOK',
  ]);
  assert.equal(out.structure.holders, null);
  assert.deepEqual(Object.keys(out.launchpad).sort(), ['bundleInfo', 'devInfo', 'similarTokens', 'tokenDetails']);
  assert.deepEqual(out.launchpad.similarTokens, { p: '/api/v6/dex/market/memepump/similarToken' });
  assert.equal(out.core.contract, advanced);

  const plain = mockClient((m, p) => (p.endsWith('/advanced-info') ? { protocolId: '' } : {}));
  const o2 = await TRS.fetchAndAssemble(plain, 'TOK', '1');
  assert.equal(plain.calls.length, 8);
  assert.equal(o2.launchpad, null);

  const dead = mockClient(() => new Error('down'));
  await rejects(TRS.fetchAndAssemble(dead, 'TOK', '501'), /^token report: all sub-calls failed for address TOK on chain 501$/);
  assert.equal(dead.calls.length, 4); // Step 2 never runs

  // All four Step 1 calls *succeed* with `data: null`: token::fetch_report does not bail (every
  // sub-result is Ok), so upstream's "unreachable" assemble() check fires — after Step 2 ran.
  const nulls = mockClient((m, p) => (/basic-info|price-info|advanced-info|token-scan/.test(p) ? null : { p }));
  await rejects(TRS.fetchAndAssemble(nulls, 'TOK', '501'), /^token-research: all Step 1 sub-calls failed for address TOK on chain 501$/);
  assert.equal(nulls.calls.length, 8); // Step 1 + Step 2, Step 3 skipped (advanced null)
});

// ── smart_money.rs ──────────────────────────────────────────────────────
test('smart_money::assemble_token_result', () => {
  const r = SM.assembleTokenResult(someData(), someData(), someData(), someData(), null);
  for (const k of ['signal', 'price', 'contract', 'security']) assert.notEqual(r[k], null);
  assert.equal(r.launchpad, null);
  assert.equal(SM.assembleTokenResult(someData(), someData(), someData(), someData(), { devInfo: { rugCount: 2 }, bundleInfo: {} }).launchpad.devInfo.rugCount, 2);
  const np = SM.assembleTokenResult(someData(), null, someData(), someData(), null);
  assert.equal(np.price, null);
  assert.notEqual(np.contract, null);
  assert.equal(SM.assembleTokenResult(someData(), someData(), someData(), null, null).security, null);
  assert.equal(SM.assembleTokenResult(someData(), someData(), { name: 'BONK', protocolId: '' }, someData(), null).launchpad, null);
  assert.equal(stringify(SM.assembleTokenResult(1, 2, 3, 4, null)), '{"contract":3,"launchpad":null,"price":2,"security":4,"signal":1}');
});

test('smart_money::assemble', () => {
  const out = SM.assemble('501', null, []);
  assert.equal(out.workflow, 'smart-money');
  assert.equal(out.chain, '501');
  assert.equal(out.rawSignals, null);
  assert.deepEqual(out.topTokens, []);
  const signals = [{ tokenContractAddress: '0xAAA', walletCount: 3 }];
  assert.deepEqual(SM.assemble('501', signals, []).rawSignals, signals);
  assert.equal(SM.assemble('501', null, [{ address: '0xAAA', data: { price: '1.0' } }, { address: '0xBBB', data: { price: '2.0' } }]).topTokens.length, 2);
  assert.equal(stringify(SM.assemble('501', null, [])), '{"chain":"501","rawSignals":null,"topTokens":[],"workflow":"smart-money"}');
});

const addrs = (r) => r.map(([a]) => a);
test('smart_money::extract_top_tokens — upstream oracle cases', () => {
  assert.deepEqual(SM.extractTopTokens([], 5), []);
  assert.deepEqual(SM.extractTopTokens(null, 5), []);
  assert.deepEqual(SM.extractTopTokens({ foo: 'bar' }, 5), []);
  assert.equal(SM.extractTopTokens([{ tokenContractAddress: '0xAAA', walletCount: 3 }, { tokenContractAddress: '0xBBB', walletCount: 7 }], 5).length, 2);
  assert.deepEqual(addrs(SM.extractTopTokens({ data: [{ tokenContractAddress: '0xAAA', walletCount: 1 }, { tokenContractAddress: '0xBBB', walletCount: 2 }] }, 5)), ['0xBBB', '0xAAA']);
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: '0xLOW', walletCount: 1 }, { tokenContractAddress: '0xHIGH', walletCount: 99 }, { tokenContractAddress: '0xMID', walletCount: 10 }], 5)), ['0xHIGH', '0xMID', '0xLOW']);
  const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => ({ tokenContractAddress: '0x' + x, walletCount: 5 - i }));
  const three = SM.extractTopTokens(six, 3);
  assert.equal(three.length, 3);
  assert.equal(three[0][0], '0xA');
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: '0xDUP', walletCount: 10 }, { tokenContractAddress: '0xDUP', walletCount: 5 }, { tokenContractAddress: '0xUNI', walletCount: 3 }], 5)), ['0xDUP', '0xUNI']);
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: '0xDUP', walletCount: 5 }, { tokenContractAddress: '0xDUP', walletCount: 99 }, { tokenContractAddress: '0xOTH', walletCount: 10 }], 5)), ['0xDUP', '0xOTH']);
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: '0xA', addressCount: 8 }, { tokenContractAddress: '0xB', addressCount: 3 }], 5)), ['0xA', '0xB']);
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: '', walletCount: 99 }, { tokenContractAddress: '0xOK', walletCount: 1 }], 5)), ['0xOK']);
  assert.deepEqual(addrs(SM.extractTopTokens([{ address: '0xALT', walletCount: 4 }], 5)), ['0xALT']);
  assert.deepEqual(addrs(SM.extractTopTokens(['0xCCC', '0xAAA', '0xDDD', '0xBBB'].map((a) => ({ tokenContractAddress: a, walletCount: 10 })), 4)), ['0xAAA', '0xBBB', '0xCCC', '0xDDD']);
});

test('smart_money::extract_top_tokens — serde edge semantics', () => {
  // the higher-count duplicate replaces the stored item; ties keep the first item
  const r = SM.extractTopTokens([{ tokenContractAddress: 'X', walletCount: 1, n: 1 }, { tokenContractAddress: 'X', walletCount: 2, n: 2 }, { tokenContractAddress: 'X', walletCount: 2, n: 3 }], 5);
  assert.equal(r[0][1].n, 2);
  // an empty-string tokenContractAddress wins over `address` and is then skipped
  assert.deepEqual(SM.extractTopTokens([{ tokenContractAddress: '', address: 'ALT', walletCount: 1 }], 5), []);
  // non-string tokenContractAddress falls through to address
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: 5, address: 'ALT' }], 5)), ['ALT']);
  // as_u64: numeric strings, decimals, negatives and -0 are None → addressCount → 0
  const parsed = parse('[{"tokenContractAddress":"S","walletCount":"12"},{"tokenContractAddress":"F","walletCount":1.0,"addressCount":4},'
    + '{"tokenContractAddress":"N","walletCount":-1,"addressCount":3},{"tokenContractAddress":"Z","walletCount":-0,"addressCount":2},'
    + '{"tokenContractAddress":"B","walletCount":18446744073709551615},{"tokenContractAddress":"C","walletCount":18446744073709551614}]');
  assert.deepEqual(addrs(SM.extractTopTokens(parsed, 10)), ['B', 'C', 'F', 'N', 'Z', 'S']);
  // Rust String ordering is byte order ('Z' < 'b'), not locale order
  assert.deepEqual(addrs(SM.extractTopTokens([{ tokenContractAddress: 'bonk', walletCount: 1 }, { tokenContractAddress: 'Zeta', walletCount: 1 }], 5)), ['Zeta', 'bonk']);
  // `{"data": …}` must be an array; other roots give nothing
  assert.deepEqual(SM.extractTopTokens({ data: { tokenContractAddress: 'X' } }, 5), []);
  assert.deepEqual(SM.extractTopTokens('str', 5), []);
});

test('smart_money::fetch_and_assemble — requests and ordering', async () => {
  const list = [
    { tokenContractAddress: 'A', walletCount: 1 },
    { tokenContractAddress: 'B', walletCount: 3 },
    { tokenContractAddress: 'C', walletCount: 2 },
  ];
  const c = mockClient((m, p, a) => {
    if (p.endsWith('/signal/list')) return list;
    if (p.endsWith('/advanced-info')) return { protocolId: a[1][1] === 'C' ? 'p' : '' };
    if (p.endsWith('/price-info') && a[0].tokenContractAddress === 'B') return new Error('x');
    return { ok: p };
  });
  const out = await SM.fetchAndAssemble(c, '501');
  assert.equal(sig(c.calls[0]), 'POST /api/v6/dex/market/signal/list {"chainIndex":"501","limit":"20"}');
  assert.deepEqual(out.topTokens.map((t) => t.address), ['B', 'C', 'A']);
  assert.equal(out.topTokens[0].data.price, null);
  assert.equal(out.topTokens[0].data.signal, list[1]);
  assert.deepEqual(out.topTokens[1].data.launchpad, { devInfo: { ok: '/api/v6/dex/market/memepump/tokenDevInfo' }, bundleInfo: { ok: '/api/v6/dex/market/memepump/tokenBundleInfo' } });
  assert.equal(out.topTokens[2].data.launchpad, null);
  assert.equal(c.calls.length, 1 + 3 * 3 + 2);
  assert.equal(out.rawSignals, list);

  const failing = mockClient(() => new Error('API error (code=50011): Too Many Requests'));
  assert.deepEqual(await SM.fetchAndAssemble(failing, '1'), { workflow: 'smart-money', chain: '1', rawSignals: null, topTokens: [] });
  assert.equal(failing.calls.length, 1);
});

// ── new_tokens.rs ───────────────────────────────────────────────────────
test('new_tokens::assemble_token_result', () => {
  const r = NT.assembleTokenResult(someData(), someData(), someData(), someData(), someData());
  for (const k of ['token', 'security', 'contract', 'devInfo', 'bundleInfo']) assert.notEqual(r[k], null);
  const a = NT.assembleTokenResult(someData(), null, someData(), someData(), someData());
  assert.equal(a.security, null); assert.notEqual(a.contract, null);
  const b = NT.assembleTokenResult(someData(), someData(), someData(), null, someData());
  assert.equal(b.devInfo, null); assert.notEqual(b.bundleInfo, null);
  const d = NT.assembleTokenResult(someData(), someData(), someData(), someData(), null);
  assert.equal(d.bundleInfo, null); assert.notEqual(d.devInfo, null);
  const all = NT.assembleTokenResult(someData(), null, null, null, null);
  assert.notEqual(all.token, null);
  for (const k of ['security', 'contract', 'devInfo', 'bundleInfo']) assert.equal(all[k], null);
  const t = NT.assembleTokenResult({ tokenContractAddress: '0xABC', symbol: 'TKN', marketCap: '500000' }, null, null, null, null);
  assert.equal(t.token.symbol, 'TKN'); assert.equal(t.token.marketCap, '500000');
  assert.equal(stringify(NT.assembleTokenResult(1, 2, 3, 4, 5)), '{"bundleInfo":5,"contract":3,"devInfo":4,"security":2,"token":1}');
});

test('new_tokens::assemble', () => {
  const out = NT.assemble('501', 'MIGRATED', null, []);
  assert.equal(out.workflow, 'new-tokens');
  assert.equal(out.chain, '501');
  assert.equal(out.stage, 'MIGRATED');
  assert.equal(out.tokenList, null);
  assert.deepEqual(out.enriched, []);
  assert.equal(NT.assemble('501', 'MIGRATED', someData(), [{ address: '0xA', data: {} }, { address: '0xB', data: {} }]).enriched.length, 2);
  assert.equal(NT.assemble('501', 'MIGRATING', null, []).stage, 'MIGRATING');
  assert.equal(stringify(out), '{"chain":"501","enriched":[],"stage":"MIGRATED","tokenList":null,"workflow":"new-tokens"}');
});

test('new_tokens::extract_top_tokens — upstream oracle cases', () => {
  assert.deepEqual(NT.extractTopTokens(null, 10), []);
  assert.deepEqual(NT.extractTopTokens([], 10), []);
  assert.deepEqual(NT.extractTopTokens({ foo: 'bar' }, 10), []);
  assert.deepEqual(addrs(NT.extractTopTokens([{ tokenContractAddress: '0xAAA' }, { tokenContractAddress: '0xBBB' }], 10)), ['0xAAA', '0xBBB']);
  assert.equal(NT.extractTopTokens({ data: [{ tokenContractAddress: '0xCCC' }, { tokenContractAddress: '0xDDD' }] }, 10).length, 2);
  assert.deepEqual(addrs(NT.extractTopTokens([{ tokenContractAddress: '0xFIRST', marketCap: '100' }, { tokenContractAddress: '0xSECOND', marketCap: '999' }], 10)), ['0xFIRST', '0xSECOND']);
  assert.equal(NT.extractTopTokens(['A', 'B', 'C', 'D'].map((x) => ({ tokenContractAddress: '0x' + x })), 2).length, 2);
  assert.deepEqual(addrs(NT.extractTopTokens([{ tokenContractAddress: '' }, { tokenContractAddress: '0xOK' }], 10)), ['0xOK']);
  assert.equal(NT.extractTopTokens([{ symbol: 'NOADDR' }, { tokenContractAddress: '0xGOOD' }], 10).length, 1);
  assert.deepEqual(addrs(NT.extractTopTokens([{ address: '0xALT' }], 10)), ['0xALT']);
  const full = NT.extractTopTokens([{ tokenContractAddress: '0xFULL', symbol: 'TKN', marketCap: '1000000' }], 10);
  assert.equal(full[0][1].symbol, 'TKN'); assert.equal(full[0][1].marketCap, '1000000');
  const dup = NT.extractTopTokens([{ tokenContractAddress: '0xDUP', symbol: 'FIRST' }, { tokenContractAddress: '0xOTH', symbol: 'OTHER' }, { tokenContractAddress: '0xDUP', symbol: 'SECOND' }], 10);
  assert.deepEqual(addrs(dup), ['0xDUP', '0xOTH']);
  assert.equal(dup[0][1].symbol, 'FIRST');
  // real memepump rows carry `tokenAddress`, which upstream does not read
  assert.deepEqual(NT.extractTopTokens([{ tokenAddress: 'Real1pump' }], 10), []);
});

test('new_tokens::fetch_and_assemble — stage validation and fan-out', async () => {
  const c0 = mockClient();
  await rejects(NT.fetchAndAssemble(c0, '501', 'foo'), /^stage must be one of \["MIGRATED", "MIGRATING"\] \(case-insensitive\), got: foo$/);
  await rejects(NT.fetchAndAssemble(c0, '501', ''), /got: $/);
  // to_ascii_uppercase: 'ı' (dotless i) must not become 'I'
  await rejects(NT.fetchAndAssemble(c0, '501', 'mıgrated'), /got: mıgrated$/);
  assert.equal(c0.calls.length, 0);

  const list = Array.from({ length: 12 }, (_, i) => ({ tokenContractAddress: `T${i}` }));
  const c = mockClient((m, p) => (p.endsWith('/tokenList') ? list : p.endsWith('/tokenDevInfo') ? new Error('x') : { p }));
  const out = await NT.fetchAndAssemble(c, '501', 'migrating');
  assert.equal(sig(c.calls[0]), 'GET /api/v6/dex/market/memepump/tokenList?chainIndex=501&stage=MIGRATING');
  assert.equal(out.stage, 'MIGRATING');
  assert.equal(out.enriched.length, NT.ENRICH_TOP_N);
  assert.deepEqual(out.enriched.map((e) => e.address), list.slice(0, 10).map((t) => t.tokenContractAddress));
  assert.equal(c.calls.length, 1 + 10 * 4);
  assert.deepEqual(c.calls.slice(1, 5).map(sig), [
    'POST /api/v6/security/token-scan {"source":"onchain_os_cli","tokenList":[{"chainId":"501","contractAddress":"T0"}]}',
    'GET /api/v6/dex/market/token/advanced-info?chainIndex=501&tokenContractAddress=T0',
    'GET /api/v6/dex/market/memepump/tokenDevInfo?chainIndex=501&tokenContractAddress=T0',
    'GET /api/v6/dex/market/memepump/tokenBundleInfo?chainIndex=501&tokenContractAddress=T0',
  ]);
  assert.equal(out.enriched[0].data.devInfo, null);
  assert.equal(out.enriched[0].data.token, list[0]);

  const dead = mockClient(() => new Error('down'));
  const o2 = await NT.fetchAndAssemble(dead, '501', 'MIGRATED');
  assert.equal(o2.tokenList, null);
  assert.deepEqual(o2.enriched, []);
});

// ── wallet_analysis.rs ──────────────────────────────────────────────────
const waFull = (a, b, c, d, e) => WA.assemble('0xWALLET', '501', a, b, c, d, e);
test('wallet_analysis::assemble', () => {
  const nul = waFull(null, null, null, null, null);
  assert.equal(nul.workflow, 'wallet-analysis');
  assert.equal(nul.address, '0xWALLET');
  assert.equal(nul.chain, '501');
  assert.equal(nul.performance['7d'], null);
  assert.equal(nul.balances, null);
  assert.equal(nul.activities, null);
  const perf = waFull({ pnl: '100' }, { pnl: '100' }, null, null, null);
  assert.notEqual(perf.performance['7d'], null); assert.notEqual(perf.performance['30d'], null);
  const rest = waFull(null, null, { pnl: '100' }, { pnl: '100' }, { pnl: '100' });
  for (const k of ['balances', 'recentPnl', 'activities']) assert.notEqual(rest[k], null);
  assert.equal(waFull(null, 1, 1, 1, 1).performance['7d'], null);
  assert.equal(waFull(1, null, 1, 1, 1).performance['30d'], null);
  const nb = waFull(1, 1, null, 1, 1); assert.equal(nb.balances, null); assert.notEqual(nb.recentPnl, null);
  assert.equal(waFull(1, 1, 1, null, 1).recentPnl, null);
  assert.equal(waFull(1, 1, 1, 1, null).activities, null);
  assert.equal(waFull({ winRate: '75%', pnl: '1200' }, null, null, null, null).performance['7d'].winRate, '75%');
  assert.equal(waFull(null, null, null, null, [{ action: 'buy', token: 'BONK', amount: '500' }]).activities[0].action, 'buy');
  assert.equal(stringify(WA.assemble('w', '1', 1, 2, 3, 4, 5)), '{"activities":5,"address":"w","balances":3,"chain":"1","performance":{"30d":2,"7d":1},"recentPnl":4,"workflow":"wallet-analysis"}');
});

test('wallet_analysis::fetch_and_assemble — steps and params', async () => {
  const c = mockClient((m, p, a) => (p.endsWith('/recent-pnl') ? new Error('x') : { p, tf: a?.find?.(([k]) => k === 'timeFrame')?.[1] }));
  const out = await WA.fetchAndAssemble(c, '0xW', '1');
  assert.deepEqual(c.calls.map(sig), [
    'GET /api/v6/dex/market/portfolio/overview?chainIndex=1&walletAddress=0xW&timeFrame=3',
    'GET /api/v6/dex/market/portfolio/overview?chainIndex=1&walletAddress=0xW&timeFrame=4',
    'GET /api/v6/dex/balance/all-token-balances-by-address?address=0xW&chains=1',
    'GET /api/v6/dex/market/portfolio/recent-pnl?chainIndex=1&walletAddress=0xW',
    'GET /api/v6/dex/market/address-tracker/trades?trackerType=3&walletAddress=0xW&chainIndex=1',
  ]);
  assert.equal(out.performance['7d'].tf, '3');
  assert.equal(out.performance['30d'].tf, '4');
  assert.equal(out.recentPnl, null);
  const dead = await WA.fetchAndAssemble(mockClient(() => new Error('x')), '0xW', '501');
  assert.equal(stringify(dead), '{"activities":null,"address":"0xW","balances":null,"chain":"501","performance":{"30d":null,"7d":null},"recentPnl":null,"workflow":"wallet-analysis"}');
});

// ── portfolio.rs (workflows) ────────────────────────────────────────────
const pfFull = (b, t, o) => PF.assemble('0xWALLET', '1,501', b, t, o);
test('portfolio::assemble', () => {
  const nul = pfFull(null, null, null);
  assert.equal(nul.workflow, 'portfolio');
  assert.equal(nul.address, '0xWALLET');
  assert.equal(nul.chains, '1,501');
  assert.equal(nul.balances, null); assert.equal(nul.totalValue, null); assert.equal(nul.overview, null);
  const all = pfFull({ value: '9999' }, { value: '9999' }, { value: '9999' });
  for (const k of ['balances', 'totalValue', 'overview']) assert.notEqual(all[k], null);
  assert.equal(pfFull(null, 1, 1).balances, null);
  assert.equal(pfFull(1, null, 1).totalValue, null);
  assert.equal(pfFull(1, 1, null).overview, null);
  assert.equal(pfFull([{ symbol: 'SOL', balance: '10.5' }], null, null).balances[0].symbol, 'SOL');
  assert.equal(pfFull(null, { totalValue: '15234.50', currency: 'USD' }, null).totalValue.currency, 'USD');
  assert.equal(PF.assemble('0xW', '1,501,56', null, null, null).chains, '1,501,56');
  assert.equal(stringify(PF.assemble('w', 'c', 1, 2, 3)), '{"address":"w","balances":1,"chains":"c","overview":3,"totalValue":2,"workflow":"portfolio"}');
});

test('portfolio::fetch_and_assemble — primary chain rule and params', async () => {
  const run = async (chains) => { const c = mockClient(() => ({})); const out = await PF.fetchAndAssemble(c, '0xW', chains); return { calls: c.calls.map(sig), out }; };
  const a = await run('1,501');
  assert.deepEqual(a.calls, [
    'GET /api/v6/dex/balance/all-token-balances-by-address?address=0xW&chains=1,501',
    'GET /api/v6/dex/balance/total-value-by-address?address=0xW&chains=1,501',
    'GET /api/v6/dex/market/portfolio/overview?chainIndex=1&walletAddress=0xW&timeFrame=4',
  ]);
  assert.equal(a.out.chains, '1,501');
  const b = await run('ethereum,solana');
  assert.equal(b.calls[0], 'GET /api/v6/dex/balance/all-token-balances-by-address?address=0xW&chains=1,501');
  assert.equal(b.calls[2], 'GET /api/v6/dex/market/portfolio/overview?chainIndex=1&walletAddress=0xW&timeFrame=4');
  assert.equal(b.out.chains, 'ethereum,solana');
  // first segment is resolved untrimmed; an empty first segment falls back to 501
  assert.equal((await run(' eth ,sol')).calls[2], 'GET /api/v6/dex/market/portfolio/overview?chainIndex= eth &walletAddress=0xW&timeFrame=4');
  assert.equal((await run('')).calls[2], 'GET /api/v6/dex/market/portfolio/overview?chainIndex=501&walletAddress=0xW&timeFrame=4');
  assert.equal((await run('')).calls[0], 'GET /api/v6/dex/balance/all-token-balances-by-address?address=0xW');
  assert.equal((await run(',56')).calls[2], 'GET /api/v6/dex/market/portfolio/overview?chainIndex=501&walletAddress=0xW&timeFrame=4');
});

// ── ApiClient::clone semantics (private fallback) ───────────────────────
const { cloneClient } = await import(new URL('../../skill/onchainos-lite/lib/core/http.mjs', import.meta.url));
const { ApiClient } = await import('../../skill/onchainos-lite/lib/core/http.mjs');

test('cloneClient: JWT copied per clone, payment state shared (Arc), prototype kept', () => {
  const c = new ApiClient({ token: 'jwt-A' });
  const k = cloneClient(c);
  assert.ok(k instanceof ApiClient);
  k.token = 'jwt-B';
  assert.equal(c.token, 'jwt-A');
  assert.equal(k.pay, c.pay);
  assert.equal(cloneClient({ clone: () => 'native' }), 'native');
});

// A client whose force-refresh (simulated) swaps only its own token, like upstream's AuthMode.
function tokenClient(refreshOn) {
  const calls = [];
  const client = { token: 'A' };
  client.get = function get(path, query) {
    const tf = query.find(([k]) => k === 'timeFrame')?.[1];
    const tag = path.split('/').pop() + (tf ? tf : '');
    if (tag === refreshOn) this.token = 'B';
    calls.push(`${tag}:${this.token}`);
    return Promise.resolve({});
  };
  return { client, calls };
}
test('wallet-analysis: a refresh on a Step 1 clone does not leak into Steps 2-3; one on `client` does', async () => {
  const onClone = tokenClient('overview4');
  await WA.fetchAndAssemble(onClone.client, '0xW', '1');
  assert.deepEqual(onClone.calls, ['overview3:A', 'overview4:B', 'all-token-balances-by-address:A', 'recent-pnl:A', 'trades:A']);
  const onParent = tokenClient('overview3');
  await WA.fetchAndAssemble(onParent.client, '0xW', '1');
  assert.deepEqual(onParent.calls, ['overview3:B', 'overview4:A', 'all-token-balances-by-address:A', 'recent-pnl:B', 'trades:B']);
});
test('token-research: Step 3 clones are taken after Step 2 (inherit a refresh made on `client`)', async () => {
  const calls = [];
  const client = { token: 'A' };
  client.get = function get(path) {
    if (path.endsWith('/holder')) this.token = 'B';
    calls.push(`${path.split('/').pop()}:${this.token}`);
    return Promise.resolve(path.endsWith('/advanced-info') ? { protocolId: 'p' } : {});
  };
  client.post = function post(path) { calls.push(`${path.split('/').pop()}:${this.token}`); return Promise.resolve({}); };
  await TRS.fetchAndAssemble(client, 'T', '501');
  assert.deepEqual(calls.slice(-8), ['holder:B', 'overview:A', 'top-trader:A', 'list:A', 'tokenDetails:B', 'tokenDevInfo:B', 'tokenBundleInfo:B', 'similarToken:B']);
});
// token.rs::fetch_report runs basic-info on `client` and price/advanced/security on clones c1-c3,
// so a force-refresh inside price-info must NOT reach `client` (and hence Steps 2-3). Realistic
// trigger: the JWT expires between Step 1 requests — upstream then refreshes again in Step 2.
// Lite's commands/token/token.mjs fetchReport shares one client for all four (request filed).
test('token-research: a Step 1 refresh on a fetch_report clone does not leak into Step 2', async () => {
  const calls = [];
  const make = (token) => {
    const c = { token };
    c.clone = () => make(c.token);
    c.get = function get(path) { calls.push(`${path.split('/').pop()}:${this.token}`); return Promise.resolve({}); };
    c.post = function post(path) {
      if (path.endsWith('/price-info')) this.token = 'B';
      calls.push(`${path.split('/').pop()}:${this.token}`);
      return Promise.resolve({});
    };
    return c;
  };
  await TRS.fetchAndAssemble(make('A'), 'T', '501');
  assert.deepEqual(calls, ['basic-info:A', 'price-info:B', 'advanced-info:A', 'token-scan:A', 'holder:A', 'overview:A', 'top-trader:A', 'list:A']);
});

// ── serde_json::Value accessors as the merge logic reads parsed API data ────
test('smart-money counts are Value::as_u64: floats, -0 and strings count 0; exact beyond 2^53', () => {
  const rows = parse(`[{"tokenContractAddress":"A","walletCount":2.0,"addressCount":1},{"tokenContractAddress":"B","walletCount":-0},
    {"tokenContractAddress":"C","walletCount":"7"},{"tokenContractAddress":"D","walletCount":18446744073709551615},
    {"tokenContractAddress":"E","walletCount":9007199254740993}]`);
  assert.deepEqual(addrs(SM.extractTopTokens(rows, 5)), ['D', 'E', 'A', 'B', 'C']);
});

// ── handlers (option contract) ──────────────────────────────────────────
test('workflow handlers: token-research requires --address or --query before any client', async () => {
  let made = false;
  const ctx = { api: async () => { made = true; return mockClient(); }, chainIndexOr: () => '501' };
  await rejects(TRS.default['workflow token-research'].run(ctx, {}), /^token-research requires --address or --query$/);
  assert.equal(made, false);
});

test('workflow handlers: chain resolution, defaults and stage default', async () => {
  const seen = [];
  const client = mockClient((m, p, a) => { seen.push(sig({ method: m, path: p, arg: a })); return []; });
  const ctx = (over) => ({ api: async () => client, chainIndexOr: (d) => over ?? (d === 'solana' ? '501' : d), resolveChainsOr: (e, d) => e ?? over ?? d });
  assert.equal((await SM.default['workflow smart-money'].run(ctx(), {})).chain, '501');
  assert.equal((await SM.default['workflow smart-money'].run(ctx(), { chain: 'Base' })).chain, '8453');
  const nt = await NT.default['workflow new-tokens'].run(ctx('56'), {});
  assert.equal(nt.chain, '56');
  assert.equal(nt.stage, NT.DEFAULT_STAGE);
  assert.equal((await WA.default['workflow wallet-analysis'].run(ctx(), { address: 'w', chain: 'eth' })).chain, '1');
  assert.equal((await PF.default['workflow portfolio'].run(ctx(), { address: 'w' })).chains, PF.DEFAULT_CHAINS);
  assert.equal((await PF.default['workflow portfolio'].run(ctx('8453'), { address: 'w', chains: 'eth' })).chains, 'eth');
  const s = await TRS.default['workflow token-research'].run({ ...ctx(), api: async () => mockClient(() => [{ tokenSymbol: 'X' }]) }, { query: 'x' });
  assert.equal(s.step, 'select-token');
});

// ── upgrade.rs ──────────────────────────────────────────────────────────
test('upgrade: lite never runs npx; fails with the upstream error envelope message', async () => {
  const h = UP.default.upgrade;
  assert.deepEqual(h.uses, []);
  await rejects(h.run({}, {}), /^`onchainos upgrade` is not available in onchainos-lite/);
  const msg = UP.liteUpgradeMessage();
  assert.ok(msg.includes(UP.INSTALLER_COMMAND));
  assert.ok(msg.includes(UPSTREAM_VERSION) && msg.includes(LITE_VERSION));
  assert.ok(msg.includes('replacing the skill folder'));
  assert.ok(msg.includes('docs/SYNC.md'));
  assert.equal(UP.INSTALLER_COMMAND, 'npx -y @okxweb3/onchainos-installer install');
});

test('upgrade::discover_skill_paths_in / is_skill_installed_in', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocl-upgrade-home-'));
  try {
    assert.deepEqual(UP.discoverSkillPathsIn(home), []);
    assert.equal(UP.isSkillInstalledIn(home, 'onchainos-skills'), false);
    const mk = (rel, skillMd = true) => { mkdirSync(join(home, rel), { recursive: true }); if (skillMd) writeFileSync(join(home, rel, 'SKILL.md'), '# x'); };
    mk('.claude/onchainos-skills');
    mk('.codex/onchainos-skills', false);
    mk('.agents/skills/okx-trade');
    mk('.cursor/skills/no-md', false);
    writeFileSync(join(home, '.agents/skills/not-a-dir'), '');
    mkdirSync(join(home, '.claude/skills/okx-dex/SKILL.md'), { recursive: true }); // SKILL.md as a directory
    const found = UP.discoverSkillPathsIn(home).map((p) => p.slice(home.length + 1).replaceAll('\\', '/'));
    assert.deepEqual(found, ['.codex/onchainos-skills', '.claude/onchainos-skills', '.agents/skills/okx-trade', '.claude/skills/okx-dex', '.cursor/skills/no-md']);
    assert.equal(UP.isSkillInstalledIn(home, 'onchainos-skills'), true);   // .claude copy has SKILL.md
    assert.equal(UP.isSkillInstalledIn(home, 'okx-trade'), true);
    assert.equal(UP.isSkillInstalledIn(home, 'okx-dex'), false);           // SKILL.md is not a regular file
    assert.equal(UP.isSkillInstalledIn(home, 'no-md'), false);
    assert.equal(UP.isSkillInstalledIn(home, 'skills'), false);
    assert.equal(UP.isSkillInstalledIn(home, 'not-a-dir'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
