// Unit tests for the agent identity / chat / a2mcp-probe ports (oracles from the upstream Rust
// tests: identity/tests/*.rs, a2mcp_probe/tests.rs, free_result.rs, chat/mod.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.OCL_HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-agent-identity-'));
const LIB = '../../skill/onchainos-lite/lib';
const { stringify, parse, F64 } = await import(`${LIB}/core/json.mjs`);
const U = await import(`${LIB}/agent/identity/utils.mjs`);
const V = await import(`${LIB}/agent/identity/validate.mjs`);
const SM = await import(`${LIB}/agent/identity/service-match.mjs`);
const M = await import(`${LIB}/agent/identity/mutations.mjs`);
const SIG = await import(`${LIB}/agent/identity/signing.mjs`);
const SOCK = await import(`${LIB}/agent/identity/socket.mjs`);
const MODELS = await import(`${LIB}/agent/identity/models.mjs`);
const Q = await import(`${LIB}/agent/identity/queries.mjs`);
const { fileName } = await import(`${LIB}/core/rs/fs.mjs`);
const CHAT = await import(`${LIB}/agent/chat/index.mjs`);
const METHOD = await import(`${LIB}/agent/a2mcp-probe/method.mjs`);
const CONTRACT = await import(`${LIB}/agent/a2mcp-probe/contract.mjs`);
const FLOW = await import(`${LIB}/agent/a2mcp-probe/flow.mjs`);
const FREE = await import(`${LIB}/agent/a2mcp-probe/free-result.mjs`);
const PROBE = await import(`${LIB}/agent/a2mcp-probe/probe.mjs`);
const A2 = await import(`${LIB}/agent/a2mcp-probe/index.mjs`);
const { ed25519 } = await import(`${LIB}/crypto/curve25519.mjs`);

const j = (v) => stringify(v);
const err = (fn) => { try { fn(); } catch (e) { return e.message; } return undefined; };
const aerr = async (p) => { try { await p; } catch (e) { return e.message; } return undefined; };
const pairs = (cells) => cells.map((c) => [c.label, c.value]);

// ─── rating ───────────────────────────────────────────────────────────────
test('parseStarsArg: integers, decimals, round-half-up, trimming', () => {
  const cases = { 0: 0, 1: 20, 5: 100, '4.5': 90, '5.00': 100, '0.01': 0, '0.03': 1, '3.30': 66, '3.31': 66, '3.32': 66, '3.33': 67, '3.35': 67, '4.97': 99, '4.98': 100, '4.99': 100, '  4.5  ': 90 };
  for (const [k, v] of Object.entries(cases)) assert.equal(U.parseStarsArg(String(k), '--score'), v, k);
});
test('parseStarsArg: rejections with exact texts', () => {
  const generic = 'invalid value for --score: expected 0.00–5.00 (up to 2 decimal places)';
  for (const bad of ['3.333', '0.001', '3.', '-1', '+5', '5e0', 'abc', '3.3.3', '', '   ', '.5', '99999999']) assert.equal(err(() => U.parseStarsArg(bad, '--score')), generic, bad);
  for (const bad of ['6', '5.01', '42949672']) assert.equal(err(() => U.parseStarsArg(bad, '--score')), 'invalid value for --score: must be between 0.00 and 5.00', bad);
  assert.equal(err(() => U.parseStarsArg('99999999999', '--score')), generic);
});
test('scoreToStars / convertFeedbackListScores', () => {
  assert.deepEqual([0, 66, 67, 70, 89, 90, 100, 101].map(U.scoreToStars), [0, 3.3, 3.35, 3.5, 4.45, 4.5, 5, 5]);
  assert.equal(U.scoreToStars(18446744073709551615n), 5);
  const v = parse('{"average":89,"items":[{"score":90},{"score":70},{"score":67}],"list":[{"score":100},{"score":"x"},{"score":1.5}]}');
  U.convertFeedbackListScores(v);
  assert.equal(j(v), '{"average":4.45,"items":[{"score":4.5},{"score":3.5},{"score":3.35}],"list":[{"score":5.0},{"score":"x"},{"score":1.5}]}');
});

// ─── bcp47 / roles ────────────────────────────────────────────────────────
test('normalizeBcp47', () => {
  const t = { 'zh-CN': 'zh-CN', zh_CN: 'zh-CN', 'ZH-cn': 'zh-CN', en_us: 'en-US', 'zh-hant-tw': 'zh-Hant-TW', '  en-US  ': 'en-US', zh: 'zh-CN', ZH: 'zh-CN', en: 'en-US', ja: 'ja-JP', fr: 'fr', 'zh-TW': 'zh-TW', 'zh-Hant': 'zh-Hant', 'en-GB': 'en-GB', 'es-419': 'es-419', 'de--x-Phonebk': 'de-x-phonebk' };
  for (const [k, v] of Object.entries(t)) assert.equal(U.normalizeBcp47(k), v, k);
  for (const bad of [undefined, '', '   ', '1-CN', 'z', 'abcdefghi', '__']) assert.equal(U.normalizeBcp47(bad), null, String(bad));
});
test('roles: strict input, backend codes, wire strings', () => {
  assert.equal(U.normalizeRole(' ASP '), 'asp');
  assert.equal(err(() => U.normalizeRole(' Buyer ')), 'invalid value for --role: buyer (expected: user, asp, or evaluator)');
  assert.equal(err(() => U.normalizeRole('2')), 'invalid value for --role: 2 (expected: user, asp, or evaluator)');
  assert.deepEqual(['user', 'asp', 'evaluator'].map(U.normalizeRoleCode), ['1', '2', '3']);
  assert.deepEqual(['user', 'asp', 'evaluator', 'x'].map(U.roleToWire), ['requester', 'provider', 'evaluator', 'evaluator']);
  assert.deepEqual([1, 2, 3, 4, '1', new F64(1), -1, null].map(U.roleTokenFromValue), ['user', 'asp', 'evaluator', undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(['user', 'asp', 'evaluator', ' asp ', 'requester', 'provider', 'buyer', '', 'constructor'].map(U.roleLabel),
    ['User', 'ASP', 'Evaluator', 'ASP', undefined, undefined, undefined, undefined, undefined]);
});

// ─── labels / stars / cards ───────────────────────────────────────────────
test('status / approval labels and rating stars', () => {
  assert.deepEqual([1, 'active', 2, '2', 3, 4, 5, ' 1 ', 99, null, new F64(1), -1].map(U.statusLabel),
    ['active', 'active', 'not listed', 'not listed', 'unavailable', 'unavailable', 'unavailable', 'active', undefined, undefined, undefined, undefined]);
  assert.equal(U.approvalLabel(4), 'Listed — eligible for task recommendations');
  assert.equal(U.approvalLabel(3), undefined);
  assert.deepEqual([92, 89, 100, 0, 90, 85, 70, 66, 101].map(U.formatRatingStars), ['4.6', '4.45', '5', '0', '4.5', '4.25', '3.5', '3.3', '5']);
  assert.equal(U.ratingStars({ score: 0, count: 0 }), undefined);
  assert.equal(U.ratingStars({ count: 3 }), undefined);
  assert.equal(U.ratingStars({ score: 92 }), '4.6');
  assert.equal(U.ratingStars({ score: '92', count: 1 }), undefined);
});
test('enrichAgentRow adds labels + card; raw fields untouched', () => {
  const row = parse('{"agentId":"4242","name":" Price Oracle ","role":2,"status":1,"approvalDisplayStatus":4,"reputation":{"score":92,"count":18},"agentWalletAddress":"0x30C1aBcDeF0123456789abcdef012345678959d7","profileDescription":"On-chain data analysis.","profilePicture":"https://cdn.example.com/x.png","services":[{"serviceName":"TVL Query","serviceType":"A2MCP","fee":"10","endpoint":"https://api.example.com/mcp"},{"serviceName":"Loop Helper","serviceType":"A2A","fee":"","subscription":[{"interval":"month","fee":"10"}],"freeTrial":"72"},{"serviceName":"Yield Check","serviceType":"A2A"},{"serviceName":"TVL Query","serviceType":"A2MCP","endpoint":"https://api.example.com/mcp"},{"x":1}]}');
  U.enrichAgentRow(row);
  assert.equal(row.roleLabel, 'ASP');
  assert.equal(row.statusLabel, 'active');
  assert.equal(row.ratingStars, '4.6');
  assert.deepEqual(pairs(row.card), [
    ['Agent ID', '#4242'], ['Name', 'Price Oracle'], ['Role', 'ASP'], ['Status', 'active'], ['Approval status', 'Listed — eligible for task recommendations'],
    ['Address', '0x30C1…59d7'], ['Description', 'On-chain data analysis.'], ['Profile photo', 'https://cdn.example.com/x.png'],
    ['Service 1', 'TVL Query — API service, 10 USDT, https://api.example.com/mcp'], ['Service 2', 'Loop Helper — agent-to-agent, 10 USDT / month, 3 days free trial'],
    ['Service 3', 'Yield Check — agent-to-agent, free'], ['Service 4', 'TVL Query — API service, —, https://api.example.com/mcp'], ['Rating', '★ 4.6 (18 reviews)'],
  ]);
  const user = parse('{"agentId":1001,"role":1,"description":"","profileDescription":"hidden","approvalDisplayStatus":5,"approvalRemark":" nope ","txHash":" 0xabc ","services":[{"serviceName":"x"}]}');
  U.enrichAgentRow(user);
  assert.deepEqual(pairs(user.card), [['Agent ID', '#1001'], ['Role', 'User'], ['Approval status', 'Listing rejected (reason: nope)'],
    ['Description', '(not set)'], ['Profile photo', 'default'], ['txHash', '0xabc']]);
  U.enrichAgentRow('junk');
});
test('agent list cells + hasMore', () => {
  const env = parse('{"list":[{"agentList":[{"agentId":"88","name":"Rejected ASP","role":2,"status":3,"approvalDisplayStatus":5,"approvalRemark":" ","reputation":{"score":89,"count":3}},{"agentId":"1","name":"abcdefghijklmnopqrstuvwxyz","role":1,"status":1}]},{"agentId":7,"role":2,"approvalDisplayStatus":5,"approvalRemark":"blurry"}],"page":"2","pageSize":5,"total":11}');
  U.addAgentListCells(env);
  assert.equal(env.hasMore, true);
  assert.deepEqual(pairs(env.list[0].agentList[0].cells), [['Agent ID', '#88'], ['Name', 'Rejected ASP'], ['Role', 'ASP'], ['Status', 'unavailable'], ['Approval status', 'Review failed'], ['Rating', '★ 4.45 (3)']]);
  assert.deepEqual(pairs(env.list[0].agentList[1].cells), [['Agent ID', '#1'], ['Name', 'abcdefghijklmnopqrst…'], ['Role', 'User'], ['Status', '—'], ['Approval status', '—'], ['Rating', 'No rating yet']]);
  assert.deepEqual(pairs(env.list[1].cells).slice(3, 5), [['Status', '—'], ['Approval status', 'Review failed (reason: blurry)']]);
  for (const [p, s, t, want] of [[1, 5, 5, false], [1, 5, 6, true], ['x', 5, 6, undefined]]) {
    const e = { page: p, pageSize: s, total: t, hasMore: 'backend' };
    U.addAgentListCells(e);
    assert.equal(e.hasMore, want === undefined ? 'backend' : want);
  }
  assert.equal(U.truncateName('short', 20), 'short');
  assert.equal(U.truncateName('😀'.repeat(21), 20), `${'😀'.repeat(20)}…`);
});

// ─── search / service-list / feedback cells ───────────────────────────────
test('search table: rates (ties to even), prices, top service', () => {
  const t = U.buildSearchTable(parse('{"list":[{"agentId":"1128","name":"DeFi Analyzer","serviceMinPrice":10.0,"feedbackRate":95,"soldCount":10,"services":[{"serviceName":"TVL Query","serviceType":"A2MCP","feeAmount":10.0}]},{"feedbackRate":92.5},{"feedbackRate":0,"services":[]},{"feedbackRate":null,"soldCount":null},"junk",{"feedbackRate":100,"services":[{"serviceName":"Sub","serviceType":"a2a","subscription":[{"fee":5},{"fee":"50","Interval":"Year"}]}]}],"total":1,"page":2}'));
  assert.equal(j(t.table.rows[0]), '{"agentId":"#1128","minPrice":"10.0","name":"DeFi Analyzer","rating":"★ 4.75","recommendService":"TVL Query (API service, 10.0)","soldCount":10}');
  assert.equal(t.table.rows[1].rating, '★ 4.62');
  assert.equal(t.table.rows[2].rating, 'No rating yet');
  assert.equal(j(t.table.rows[3]), '{"agentId":"—","minPrice":"—","name":"—","rating":"—","recommendService":"—","soldCount":"—"}');
  assert.equal(t.table.rows[4].recommendService, 'Sub (agent-to-agent, 5 USDT / month, 50 …');
  assert.equal(t.table.rows.length, 5);
  assert.equal(j([t.total, t.page, t.pageSize]), '[1,2,null]');
  assert.deepEqual([4.6, 5, 0, 4.45, 4.625, 0.125, 0.375, 2.675, NaN].map(U.formatSearchRate), ['4.6', '5', '0', '4.45', '4.62', '0.12', '0.38', '2.67', 'NaN']);
});
test('service cells + guide hash + indexing', () => {
  const data = parse('[{"list":[{"ServiceName":"TVL Query","ServiceType":"A2MCP","Fee":"10","Endpoint":"https://api.example.com/mcp","serviceGuide":"step 1; step 2"},{"x":1},{"serviceName":"Loop","serviceType":"A2A","subscription":[{"interval":"month","fee":"10"}],"freeTrial":72},{"serviceName":"Orphan","serviceType":"A2A","fee":"5","freeTrial":"72"},{"serviceName":"No fee","serviceType":"a2mcp"},{"serviceName":"x","serviceDescription":"' + 'd'.repeat(81) + '"}],"page":1,"pageSize":3,"total":3},7]');
  U.addServiceListCells(data);
  const [a, b, c, d, e, f] = data[0].list;
  assert.equal(data[0].hasMore, false);
  assert.equal(a.serviceGuideHash, 'sha256:2e095d2047b122f09ea7bbda25e3b7f8d717ef3c6bd3216b2dc88d5d73d7dd2e');
  assert.deepEqual(pairs(a.cells), [['#', '1'], ['Name', 'TVL Query'], ['Type', 'A2MCP'], ['Fee', '10 USDT'], ['Subscription', '—'], ['Free trial', '—'], ['Endpoint', 'https://api.example.com/mcp'], ['Description', '—']]);
  assert.equal(b.cells, undefined);
  assert.deepEqual(pairs(c.cells).slice(0, 7), [['#', '2'], ['Name', 'Loop'], ['Type', 'A2A'], ['Fee', '—'], ['Subscription', '10 USDT / month'], ['Free trial', '3 days'], ['Endpoint', '—']]);
  assert.deepEqual(pairs(d.cells).slice(3, 6), [['Fee', '5 USDT'], ['Subscription', '—'], ['Free trial', '—']]);
  assert.equal(pairs(e.cells)[3][1], '—');
  assert.equal(pairs(f.cells)[7][1], `${'d'.repeat(80)}…`);
  const ft = (v) => U.formatFreeTrial({ subscription: [{ fee: '1' }], freeTrial: v });
  assert.deepEqual(['72', '24', '5', '1', '0', '', '24.5', 48].map(ft), ['3 days', '1 day', '5 hours', '1 hour', undefined, undefined, undefined, '2 days']);
  assert.equal(U.formatFreeTrial({ freeTrial: '72' }), undefined);
});
test('feedback cells', () => {
  const v = parse('{"list":[{"score":4.5,"valueString":"95/100","agentName":" Buyer ","createdAt":"2024-01-01","content":"Great"},{"score":4.45,"creatorId":12,"description":"  "},{"value":"70","creatorId":" 9 ","time":"x","createdAt":1700000000},{"value":70},{"score":"x"}],"page":1,"pageSize":2,"total":5}');
  U.addFeedbackListCells(v);
  assert.equal(v.hasMore, true);
  assert.deepEqual(pairs(v.list[0].cells), [['Score', '4.75'], ['Reviewer', 'Buyer'], ['Date', '2024-01-01'], ['Comment', 'Great']]);
  assert.deepEqual(pairs(v.list[1].cells), [['Score', '4.45'], ['Reviewer', '#12'], ['Date', '—'], ['Comment', '(no comment)']]);
  assert.deepEqual(pairs(v.list[2].cells).slice(0, 3), [['Score', '3.5'], ['Reviewer', '#9'], ['Date', '1700000000']]);
  assert.equal(pairs(v.list[3].cells)[0][1], '3.5');
  assert.equal(pairs(v.list[4].cells)[0][1], '—');
  const d = new Date(1700000000000);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(U.localDateFromMillis(1700000000000), local);
});

// ─── services parsing / normalisation ─────────────────────────────────────
test('parseServices: serde error texts with positions', () => {
  const p = (raw) => err(() => U.parseServices(raw));
  assert.equal(p(''), 'failed to parse --service as JSON array: EOF while parsing a value at line 1 column 0');
  assert.equal(p('{"a":1}'), 'failed to parse --service as JSON array: invalid type: map, expected a sequence at line 1 column 0');
  assert.equal(p('[{"serviceName":"Quote","serviceType":"A2A"}]'), 'failed to parse --service as JSON array: missing field `serviceDescription` at line 1 column 44');
  assert.equal(p('[{"serviceName":"Q","serviceDescription":"d","serviceType":"A2A","fee":10}]'), 'failed to parse --service as JSON array: invalid type: integer `10`, expected a string at line 1 column 73');
  assert.equal(p('[{"operation":"upsert"}]'), 'failed to parse --service as JSON array: unknown variant `upsert`, expected one of `create`, `update`, `delete` at line 1 column 22');
  assert.deepEqual(U.parseServices(undefined), []);
});
test('normalizeService: order of checks and messages', () => {
  const n = (o) => err(() => U.normalizeService({ id: null, serviceGuide: '', fee: '', subscription: [], freeTrial: null, operation: null, endpoint: null, ...o }));
  const base = { serviceName: 'Q', serviceDescription: 'd' };
  assert.equal(n({ ...base, serviceName: ' ', serviceType: 'A2A' }), 'missing required field in --service: serviceName');
  assert.equal(n({ ...base, serviceType: 'A2A', serviceGuide: '指'.repeat(5001) }), 'The service guide for [Q] exceeds the length limit. Shorten it to no more than 5,000 full-width Chinese/Japanese characters or 10,000 Latin characters, then resubmit.');
  assert.equal(n({ ...base, serviceType: 'A2A', serviceGuide: 'x'.repeat(10001), operation: 'delete' }), 'invalid --service for A2A: provide a single-purchase fee or a subscription (exactly one)');
  assert.equal(n({ ...base, serviceType: ' ' }), 'invalid serviceType in --service:  (expected: A2A or A2MCP)');
  assert.equal(n({ ...base, serviceType: 'a2a', subscription: [{ interval: 'Month', fee: '0.00' }] }), 'The subscription price for "Q" must be greater than 0. Please update the price and try again.');
  assert.equal(n({ ...base, serviceType: 'A2MCP', fee: '1', endpoint: 'https://x', operation: 'update' }), "invalid --service: operation 'update' requires an id");
  const ok = U.normalizeService({ id: ' 7 ', serviceName: ' Q ', serviceDescription: ' d ', serviceGuide: ' g ', fee: '', serviceType: ' a2a ', subscription: [{ interval: ' MONTH ', fee: ' 9.9 ' }, { interval: '', fee: '' }], freeTrial: ' 72 ', operation: 'update', endpoint: 'https://drop' });
  assert.equal(j(MODELS.agentServiceStruct(ok)), '{"id":"7","serviceName":"Q","serviceDescription":"d","serviceGuide":"g","fee":"","serviceType":"A2A","subscription":[{"interval":"month","fee":"9.9"}],"freeTrial":"72","operation":"update"}');
  assert.equal(j(MODELS.agentServiceValue(ok)), '{"fee":"","freeTrial":"72","id":"7","operation":"update","serviceDescription":"d","serviceGuide":"g","serviceName":"Q","serviceType":"A2A","subscription":[{"fee":"9.9","interval":"month"}]}');
});
test('parseServiceDeltas (update)', () => {
  const out = U.parseServiceDeltas('[{"operation":"create","serviceName":"Market Signals","serviceDescription":"d","serviceType":"A2A","fee":"10"},{"operation":"delete","id":" 9 ","serviceName":"x"},{"operation":"delete","id":12345678901234567890}]');
  assert.equal(j(out), '[{"fee":"10","operation":"create","serviceDescription":"d","serviceName":"Market Signals","serviceType":"A2A","subscription":[]},{"id":"9","operation":"delete"},{"id":12345678901234567890,"operation":"delete"}]');
  assert.equal(err(() => U.parseServiceDeltas('[{"operation":"delete"}]')), "invalid --service: operation 'delete' requires an id");
  assert.equal(err(() => U.parseServiceDeltas('[{"serviceDescription":"d"}]')), 'failed to parse --service entry: missing field `serviceName`');
  assert.equal(err(() => U.parseServiceDeltas('["x"]')), 'failed to parse --service entry: invalid type: string "x", expected struct AgentService');
  assert.equal(err(() => U.parseServiceDeltas('[{"serviceName":"a","serviceDescription":"b","serviceType":"A2A","operation":1}]')), 'failed to parse --service entry: invalid type: integer `1`, expected string or map');
  assert.equal(err(() => U.parseServiceDeltas('[{"operation":"delete","id":1.5}]')), 'invalid --service: id must be a string or integer');
  assert.deepEqual(U.parseServiceDeltas(undefined), []);
});
test('plain-number predicates, display width, image kinds, u32 args', () => {
  assert.deepEqual(['10', '00', '007.5', '0.25', '.5', '5.', '1e2', '+1', '1,000', '1.234', ''].map((s) => U.isPlainNumber(s, 2)),
    [true, true, true, true, false, false, false, false, false, false, false]);
  assert.equal(U.isPlainNumber('0.000001', 6), true);
  assert.deepEqual(['0', '0.00', '00', '0.01', ''].map(U.isZeroValue), [true, true, true, false, false]);
  assert.deepEqual(['72', '0', '00', '007', '', '1.0'].map(U.isPositiveInteger), [true, false, false, true, false, false]);
  assert.equal(U.displayWidth('ab价格😀𠀀'), 2 + 4 + 1 + 2);
  assert.deepEqual(U.detectImageKind(Buffer.from('89504e470d0a1a0a00', 'hex')), ['PNG', 'image/png']);
  assert.deepEqual(U.detectImageKind(Buffer.from('ffd8ffe0', 'hex')), ['JPEG', 'image/jpeg']);
  assert.deepEqual(U.detectImageKind(Buffer.from('RIFF\0\0\0\0WEBP')), ['WebP', 'image/webp']);
  assert.equal(U.detectImageKind(Buffer.from('%PDF-1.7')), null);
  assert.equal(err(() => U.validateAvatarImage(Buffer.from('GIF89a'))), 'unsupported image type — only PNG, JPEG, and WebP are accepted; please convert the file to one of those and retry');
  assert.equal(U.parseU32Arg(undefined, '--page', 5, 1, null, false), 5);
  assert.equal(U.parseU32Arg(' +7 ', '--page', 1, 1, null, false), 7);
  assert.equal(U.parseU32Arg('500', '--page-size', 5, 1, 100, true), 100);
  assert.equal(err(() => U.parseU32Arg('0', '--page', 1, 1, null, false)), 'invalid value for --page: must be >= 1');
  assert.equal(err(() => U.parseU32Arg('51', '--page-size', 1, 1, 50, false)), 'invalid value for --page-size: must be <= 50');
  for (const bad of ['-1', '1.5', 'abc', '4294967296', '']) assert.equal(err(() => U.parseU32Arg(bad, '--page', 1, 1, null, false)), 'invalid value for --page: expected integer');
  assert.equal(err(() => U.requireNonEmpty(' ', '--agent-id')), 'missing required parameter: --agent-id');
  assert.equal(U.requireNonEmpty(' 42 ', '--agent-id'), '42');
});
test('query builders', () => {
  assert.deepEqual(Q.buildGetMyAgentsQuery({}), [['chainIndex', '196'], ['pageSize', '10']]);
  assert.deepEqual(Q.buildGetMyAgentsQuery({ role: 'user', agentIds: '13373,9967', pageSize: '5' }), [['chainIndex', '196'], ['role', '1'], ['agentIdList', '13373,9967'], ['pageSize', '5']]);
  assert.deepEqual(Q.buildServiceListQuery('1921', undefined, undefined, undefined), [['agentId', '1921'], ['page', '1'], ['pageSize', '3']]);
  assert.deepEqual(Q.buildServiceListQuery('1921', ' s ', '3', '20'), [['agentId', '1921'], ['page', '3'], ['pageSize', '20'], ['serviceId', 's']]);
  assert.equal(err(() => Q.buildServiceListQuery('1921', '  ', undefined, undefined)), 'invalid parameter: --service-id must not be blank');
  assert.deepEqual(Q.buildFeedbackListQuery('42', undefined, '51'), [['agentId', '42'], ['pageNo', '1'], ['pageSize', '50']]);
});
test('precheck verdict', () => {
  const list = parse('{"list":[{"ownerAddress":"0xABC","agentList":[{"agentId":"11","role":2,"name":" ASP One "},{"agentId":12,"role":1},{"agentId":" ","role":1}]},{"ownerAddress":"0xother","agentList":[{"agentId":"99","role":1}]},{"agentId":5,"role":3,"name":"flat"},{"agentId":6,"role":3,"ownerAddress":"0xnope"}]}');
  assert.deepEqual(U.collectOwnedAgents(list, ' 0xabc '), [['11', 'asp', 'ASP One'], ['12', 'user', ''], ['5', 'evaluator', 'flat']]);
  assert.equal(j(U.buildPrecheck(list, '0xabc', 'user')), '{"aspCount":1,"canCreate":false,"existingSameRole":[{"agentId":"12","name":"","roleLabel":"User"}],"ownerAddress":"0xabc","reason":"A User is already registered under this wallet; each address can register only one User.","role":"user","roleLabel":"User","uniqueness":"single"}');
  assert.equal(U.buildPrecheck(list, '0xabc', 'asp').canCreate, true);
  assert.equal(U.buildPrecheck({}, '0xabc', 'evaluator').uniqueness, 'single');
});

// ─── validate-listing ─────────────────────────────────────────────────────
const codes = (r) => r.findings.map((f) => `${f.field}:${f.code}`);
test('validate-listing: names', () => {
  assert.deepEqual(codes(V.runValidation('asp', 'Bot#3', undefined, undefined)), ['name:N2', 'name:N3', 'name:N8']);
  assert.deepEqual(codes(V.runValidation('asp', 'Casino7', undefined, undefined)), ['name:N3']);
  assert.deepEqual(codes(V.runValidation('asp', 'Helper (2)', undefined, undefined)), ['name:N3']);
  assert.deepEqual(codes(V.runValidation('asp', 'Bot 3', undefined, undefined)), ['name:N2']);
  assert.deepEqual(codes(V.runValidation('asp', 'My Agent (test)', undefined, undefined)), ['name:U1']);
  assert.deepEqual(codes(V.runValidation('asp', 'Predict Pro', undefined, undefined)), []);
  assert.deepEqual(codes(V.runValidation('asp', '价格Price', undefined, undefined)), ['name:N6']);
  assert.deepEqual(codes(V.runValidation('asp', '价格 · Price', undefined, undefined)), []);
  assert.deepEqual(codes(V.runValidation('asp', '价', undefined, undefined)), ['name:N1']);
  assert.deepEqual(codes(V.runValidation('asp', '- Alpha', undefined, undefined)), ['name:N8']);
  assert.deepEqual(codes(V.runValidation('asp', 'Alpha-Omega', undefined, undefined)), []);
  assert.deepEqual(codes(V.runValidation('asp', 'Alpha-Beta', undefined, undefined)), ['name:U1']);
  const r = V.runValidation('asp', '', ' ', undefined);
  assert.equal(stringify(r, true), '{\n  "pass": true,\n  "findings": []\n}');
});
test('validate-listing: services', () => {
  const s = (arr) => JSON.stringify(arr);
  const r = V.runValidation('asp', 'Agent Name', 'x https://a (test)', s([
    { serviceName: 'Agent Name', serviceDescription: 'an A2MCP thing', serviceType: 'A2A', fee: '5 USDT', endpoint: 'https://x', freeTrial: '72' },
    { serviceName: 'Free lookup', serviceDescription: '', serviceType: 'A2MCP', fee: '', endpoint: 'https://10.0.0.1/x', subscription: [{ interval: 'week', fee: '' }], freeTrial: '1' },
    { serviceName: 'Sub Only', serviceDescription: 'visit github.com (test)', serviceType: 'A2A', fee: '', subscription: [{ interval: '', fee: '' }, { interval: 'month', fee: '1.234' }, { interval: 'Month', fee: '0' }], freeTrial: 'x' },
    { serviceName: 'sub only', serviceDescription: 'd', serviceType: 'weird', fee: 'abc' },
  ]));
  assert.deepEqual(codes(r), [
    'description:U1', 'description:D6',
    'service[0].endpoint:T3', 'service[0].servicedescription:U5', 'service[0].name:S3', 'service[0].fee:P1', 'service[0].freeTrial:P7',
    'service[1].endpoint:T4', 'service[1].name:S4', 'service[1].subscription:P3', 'service[1].freeTrial:P7', 'service[1].fee:U4', 'service[1].fee:P1',
    'service[2].subscription:P4', 'service[2].subscription:PRICE_EMPTY', 'service[2].subscription:P5', 'service[2].subscription:SUBSCRIPTION_PRICE_ZERO',
    'service[2].freeTrial:P8', 'service[2].servicedescription:D6', 'service[2].servicedescription:U1',
    'service[3].servicetype:T1', 'service[3].fee:P1', 'service[3].name:S2',
  ]);
  assert.equal(r.pass, false);
  const msg = r.findings.find((f) => f.field === 'service[2].servicedescription').message;
  assert.equal(msg, 'The service description needs a change: remove the link and the test marker. Then resubmit.');
  assert.equal(V.fe.fe22(false, true), 'The service description needs a change: remove the test marker. Then resubmit.');
  const ep = V.runValidation('asp', 'X Agent', undefined, s([
    { serviceName: 'One', serviceDescription: 'd', serviceType: 'A2MCP', fee: '1', endpoint: 'https://e/a', id: 'x' },
    { serviceName: 'Two', serviceDescription: 'd', serviceType: 'A2MCP', fee: '1', endpoint: 'HTTPS://E/a', id: 'x' },
    { serviceName: 'Three', serviceDescription: 'd', serviceType: 'A2MCP', fee: '1', endpoint: 'https://e/a' },
  ]));
  const ep1 = ep.findings.filter((f) => f.code === 'EP1');
  assert.equal(ep1.length, 1);
  assert.equal(ep1[0].field, 'service[2].endpoint');
  assert.match(ep1[0].message, /^The Endpoint for "Three" is already used by "One"\./);
  const d2 = V.runValidation('asp', 'X Agent', undefined, s([{ serviceName: 'Doc Summarizer', serviceDescription: 'x'.repeat(2001), serviceType: 'A2A', fee: '5' }]));
  assert.equal(d2.pass, true);
  assert.deepEqual(d2.findings.map((f) => [f.code, f.severity]), [['D2', 'suggest']]);
  assert.deepEqual(codes(V.runValidation('asp', 'X Agent', undefined, '[{"serviceName":1}]')), ['service:PARSE']);
  assert.deepEqual(codes(V.runValidation('user', 'X Agent', 'https://x', 'not json')), []);
  assert.equal(V.validateListing({ role: 'nope', service: '[1]' }).findings[0].code, 'PARSE');
});
test('validate-listing predicates', () => {
  assert.equal(V.hasTestMarker('svc_predict'), false);
  assert.equal(V.hasTestMarker('svc_pre'), true);
  assert.equal(V.hasTestMarker('svc.test-x'), true);
  assert.equal(V.hasTestMarker('Service Beta'), true);
  assert.equal(V.containsPriceInfo('Only 5 usdt'), true);
  assert.equal(V.containsPriceInfo('usdt pairs'), false);
  assert.equal(V.containsPriceInfo('免费试用'), true);
  assert.equal(V.containsPriceInfo('freedom'), false);
  assert.equal(V.contradictingTypeToken('uses a2a-bridge', 'A2MCP'), 'A2A');
  assert.equal(V.contradictingTypeToken('a2mcpx', 'A2A'), undefined);
});

// ─── service-match ────────────────────────────────────────────────────────
test('service-match request body + number parsing', () => {
  const b = SM.buildRequest({ keywords: ['smart contract', ' ', 'audit'], serviceId: ' svc-001 ', minPaymentTokenAmount: '5.25', maxPaymentTokenAmount: '10.50', limit: 3 });
  assert.equal(j(b), '{"keywords":["smart contract","audit"],"limit":3,"maxPaymentTokenAmount":10.5,"minPaymentTokenAmount":5.25,"sid":"svc-001"}');
  assert.equal(j(SM.buildRequest({ keywords: [], limit: 3 })), '{"limit":3}');
  assert.equal(j(SM.buildRequest({ keywords: [], searchAfter: ' c ', limit: 3 })), '{"limit":3,"searchAfter":"c"}');
  assert.equal(j(SM.buildRequest({ minPaymentTokenAmount: '1e2', maxPaymentTokenAmount: '100', limit: 1 })), '{"limit":1,"maxPaymentTokenAmount":100,"minPaymentTokenAmount":100.0}');
  assert.equal(err(() => SM.buildRequest({ keywords: Array(11).fill('k'), limit: 3 })), 'service search accepts at most 10 keywords');
  assert.equal(err(() => SM.buildRequest({ minPaymentTokenAmount: '6', maxPaymentTokenAmount: '5', limit: 3 })), 'minPaymentTokenAmount must be less than or equal to maxPaymentTokenAmount');
  assert.equal(err(() => SM.buildRequest({ searchAfter: 'x', aspName: 'n', limit: 3 })), '--search-after cannot be combined with initial search conditions');
  const e = (v) => err(() => SM.parseNonNegativeDecimal(v, '--x'));
  assert.equal(e('abc'), '--x must be a valid decimal: invalid number at line 1 column 1');
  assert.equal(e('05'), '--x must be a valid decimal: invalid number at line 1 column 2');
  assert.equal(e('5.'), '--x must be a valid decimal: EOF while parsing a value at line 1 column 2');
  assert.equal(e('1e400'), '--x must be a valid decimal: number out of range at line 1 column 5');
  assert.equal(e('-1'), '--x must be greater than or equal to 0');
  assert.equal(stringify(SM.parseNonNegativeDecimal('-0', '--x')), '-0.0');
});
test('service-match flow metadata + ratings', () => {
  const d = parse('{"services":[{"asp":{"securityRate":4.625,"onlineStatus":1}},{"asp":{"securityRate":0}},{"asp":{"securityRate":"4"}},{"asp":null}],"hasMore":true,"action":"x","phase":"p","payload":1}');
  SM.normalizeSecurityRatings(d);
  SM.addFlowMetadata(d, {});
  assert.deepEqual(d.services.map((s) => s.asp?.rating), ['★ 4.62', 'No rating yet', '—', undefined]);
  assert.equal(d.tip, 'Tell me which service you want to use, or ask for more.');
  assert.equal('action' in d || 'phase' in d || 'payload' in d, false);
  const dup = parse('{"services":[{"asp":{"onlineStatus":1},"subscribedInfo":{"isActive":true,"jobId":" 0xj ","title":"T","status":2}}],"tip":"t"}');
  SM.addFlowMetadata(dup, { serviceId: 'svc' });
  assert.equal(j(dup), '{"decision":"blocked","nextAction":[{"id":"restore_subscription","recommend":true}],"payload":{"active":true,"jobId":"0xj","status":2,"title":"T"},"phase":"subscription_validation","reason":"duplicate_subscription","services":[{"asp":{"onlineStatus":1},"subscribedInfo":{"isActive":true,"jobId":" 0xj ","status":2,"title":"T"}}]}');
  const off = parse('{"services":[{"asp":{"onlineStatus":1.0}}]}');
  SM.addFlowMetadata(off, { aspAgentId: '1' });
  assert.equal(off.tip, 'This Agent is offline and cannot provide the service right now. Search for another service.');
  const none = {};
  SM.addFlowMetadata(none, {});
  assert.equal(none.tip, 'No matching services were found on OKX.AI. Try another keyword and search again.');
  assert.equal(SM.extractUserAgentId(parse('{"list":[{"agentList":[{"agentId":" "},{"agentId":9001}]}]}')), '9001');
  assert.equal(SM.extractUserAgentId(parse('[{"agentId":" x "}]')), 'x');
  assert.equal(SM.extractUserAgentId({}), undefined);
});

// ─── mutations / signing / socket helpers ─────────────────────────────────
test('identity envelope + push parsing', () => {
  assert.equal(j(M.assembleIdentityEnvelope('0xabc', null, null)), '{"newAgentId":null,"txHash":"0xabc"}');
  assert.equal(j(M.assembleIdentityEnvelope('0xabc', { agentId: 7 }, '7')), '{"agent":{"agentId":7},"newAgentId":"7","txHash":"0xabc"}');
  assert.deepEqual([{ agentId: ' 5 ' }, { agentId: 5 }, { agentId: ' ' }, { agentId: true }, null].map(M.extractAgentIdFromPush), ['5', '5', null, null, null]);
  assert.deepEqual(SOCK.extractPayload('{"arg":{},"data":{"txHash":"0x1"}}'), { txHash: '0x1' });
  assert.deepEqual(SOCK.extractPayload('{"data":[{"txHash":"0x2"},{}]}'), { txHash: '0x2' });
  assert.equal(SOCK.extractPayload('{"event":"subscribe","data":{}}'), undefined);
  assert.deepEqual(SOCK.extractPayload('{"txHash":"a","agentId":1}'), { txHash: 'a', agentId: 1 });
  assert.equal(SOCK.extractPayload('{"txHash":"a"}'), undefined);
  assert.equal(SOCK.extractPayload('nope'), undefined);
  assert.equal(SOCK.normalizeHash(' 0XABcd '), 'abcd');
});
test('keyUuid signature is Ed25519 over the raw UTF-8 bytes', () => {
  const seed = Buffer.alloc(32, 7);
  const sig = SIG.signKeyUuid('0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f', seed);
  assert.equal(Buffer.from(sig, 'base64').length, 64);
  assert.equal(ed25519.verify(ed25519.publicKey(seed), Buffer.from('0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f'), Buffer.from(sig, 'base64')), true);
  assert.equal(SIG.signKeyUuid('x', seed), SIG.signKeyUuid('x', seed));
  assert.equal(j(SIG.buildErc8004Overlay([['a', ''], ['role', 'provider'], ['keyUuid', 'k']])), '{"erc8004Msg":{"keyUuid":"k","role":"provider"}}');
  assert.equal(SIG.buildErc8004Overlay([['a', '']]), null);
});
test('agent card JSON is struct-ordered', () => {
  const card = { role: 'provider', name: 'N', profilePicture: '', profileDescription: '', communicationAddress: null, services: [] };
  assert.equal(j(MODELS.agentCardStruct(card)), '{"role":"provider","name":"N","image":"","profileDescription":"","services":[]}');
});
test('path file names', () => {
  assert.equal(fileName('a/b/c.png'), 'c.png');
  assert.equal(fileName('c.png'), 'c.png');
  assert.equal(fileName('a/..'), undefined);
  assert.equal(fileName('a/b/.'), 'b');
  assert.equal(fileName(''), undefined);
});

// ─── chat helpers ─────────────────────────────────────────────────────────
test('chat helpers', () => {
  assert.deepEqual([true, false, undefined].map(CHAT.offlineReplayQueryValue), ['true', 'false', undefined]);
  assert.equal(CHAT.isBusinessRejection({ httpStatus: 200, code: '51001' }), true);
  assert.equal(CHAT.isBusinessRejection({ httpStatus: 200, code: '50114' }), false);
  assert.equal(CHAT.isBusinessRejection({ httpStatus: 403, code: '403' }), false);
});
test('chat: heartbeat / wakeup request shapes', async () => {
  const calls = [];
  const client = {
    postAuthed: async (p, t, b) => { calls.push([p, t, j(b)]); return true; },
    postAuthedWithHeaders: async (p, t, b, h) => { calls.push([p, t, j(b), h]); return []; },
    postAuthedMultipartWithHeaders: async (p, t, form, h) => { calls.push([p, form.map((x) => [x.name, x.filename, x.contentType, String(x.value ?? x.data)]), h]); return {}; },
  };
  await CHAT.fetchHeartbeat(client, 'tok', 196);
  await CHAT.fetchWakeupNotify(client, 'tok', ['1', '2']);
  await CHAT.fetchUpload(client, 'tok', 'f.bin', Buffer.from('abc'), '1001', '0xjob');
  assert.deepEqual(calls, [
    ['/priapi/v5/wallet/agentic/agent-heartbeat', 'tok', '{"chainIndex":196}'],
    ['/priapi/v1/aieco/task/wakeupNotify', 'tok', '{"agentIds":["1","2"]}', [['agenticId', '1']]],
    ['/priapi/v1/aieco/im/attachments/xmtp/encrypted/upload', [['file', 'f.bin', 'application/octet-stream', 'abc'], ['jobId', undefined, undefined, '0xjob']], [['agenticId', '1001']]],
  ]);
  assert.equal(await aerr(Promise.resolve().then(() => CHAT.fetchWakeupNotify(client, 't', []))), 'agent_ids must contain at least one agent ID');
});

// ─── a2mcp-probe ──────────────────────────────────────────────────────────
const EP = new URL('https://signals.example.com/v1/signal');
test('a2mcp: method resolution (upstream oracles)', () => {
  const r = (d, f) => METHOD.resolveRequestMethod(d, EP, f);
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return undefined; };
  assert.equal(METHOD.normalizeA2mcpMethod(' get '), 'GET');
  for (const m of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(code(() => METHOD.normalizeA2mcpMethod(m)), 'invalid_a2mcp_routing');
  assert.equal(r('1. [Service Description] Returns a signal.\n3. [Request Method] GET\n4. [Request Example] curl -X POST \'https://signals.example.com/v1/signal\' -d \'{"pair":"BTC-USDT"}\'', 'GET'), 'POST');
  assert.equal(r('3. [Request Method] POST /v1/signal', 'GET'), 'POST');
  assert.equal(r('3. [Request Method] 一般使用 POST，也支持 GET'), 'POST');
  assert.equal(r('4. [Request Example] curl \'https://signals.example.com/v1/signal\' --data \'{"pair":"BTC-USDT"}\''), 'POST');
  assert.equal(r('4. [Request Example] curl \'https://signals.example.com/v1/signal?pair=BTC-USDT\''), 'GET');
  for (const ex of ['4. [Request Example] curl https://signals.example.com/v1/signal -d\'{"pair":"BTC-USDT"}\'', '4. [Request Example] curl https://signals.example.com/v1/signal -Fpair=BTC-USDT',
    '4. [Request Example] curl \\\n          https://signals.example.com/v1/signal \\\n          --data \'{"pair":"BTC-USDT"}\'']) assert.equal(r(ex), 'POST', ex);
  assert.equal(r('1. [Service Description] Generate curl commands for developers.\n3. [Request Method] POST'), 'POST');
  for (const ex of ['4. [Request Example] curl -I https://signals.example.com/v1/signal', '4. [Request Example] curl -T payload.json https://signals.example.com/v1/signal']) {
    assert.equal(code(() => r(ex)), 'invalid_a2mcp_routing');
  }
  assert.equal(r(undefined, 'POST'), 'POST');
  assert.equal(code(() => r(undefined, 'generally POST')), 'invalid_a2mcp_routing');
  assert.equal(code(() => r('3. [Request Method] POST /v1/other')), 'invalid_a2mcp_routing');
  assert.equal(r('Returns a signal.'), 'GET');
  assert.equal(METHOD.requestMethodIsDefaulted('Returns a signal.', undefined), true);
  assert.equal(METHOD.requestMethodIsDefaulted('x', 'GET'), false);
  assert.equal(METHOD.extractCurlExample('[Request Example] curl https://a \\'), undefined);
});
test('a2mcp: 405 / 400 fallbacks and endpoint issues', () => {
  assert.equal(METHOD.fallbackMethodFor405('GET', null), 'POST');
  assert.equal(METHOD.fallbackMethodFor405('POST', null), undefined);
  assert.equal(METHOD.fallbackMethodFor405('GET', 'POST, OPTIONS'), 'POST');
  assert.equal(METHOD.fallbackMethodFor405('GET', 'GET'), undefined);
  assert.equal(METHOD.fallbackMethodFor405('POST', 'GET, OPTIONS'), 'GET');
  assert.equal(METHOD.fallbackMethodFor405('POST', 'POST'), undefined);
  const params = { a: 1, b: 'x' };
  const body = parse('{"issues":[{"path":["a"],"message":"Required","received":"undefined"},{"path":["b"],"message":"required","received":null}]}');
  assert.equal(METHOD.fallbackMethodFor400('GET', 400, body, params, []), 'POST');
  assert.equal(METHOD.fallbackMethodFor400('GET', 400, body, params, [{ name: 'a', carrier: 'query' }]), undefined);
  assert.equal(METHOD.fallbackMethodFor400('POST', 400, body, params, []), undefined);
  assert.equal(METHOD.fallbackMethodFor400('GET', 400, { code: 'body_required' }, params, []), 'POST');
  assert.equal(METHOD.fallbackMethodFor400('GET', 400, {}, {}, []), undefined);
  const issues = parse('{"issues":[{"path":["decision"],"expected":"string","code":"invalid_type"},{"path":["includeHashtag"],"code":"invalid_type","expected":"boolean"},{"path":["n"],"code":"too_small","minimum":1.5},{"path":["unknown"]},{"path":["decision"]}]}');
  const req = METHOD.discoverEndpointParamIssues(issues, { decision: 1, includeHashtag: 'no', n: 0 }, []);
  assert.equal(j(req.fields.map((f) => [f.name, f.type, f.description])), '[["decision","string","The endpoint expects a string value."],["includeHashtag","boolean","The endpoint expects a boolean value."],["n","integer","The endpoint requires a value of at least 1.5."]]');
  assert.equal(req.message, 'decision: The endpoint expects a string value.; includeHashtag: The endpoint expects a boolean value.; n: The endpoint requires a value of at least 1.5.');
  const byMsg = METHOD.discoverEndpointParamIssues({ message: 'tokenAddress must be a checksum address' }, { tokenAddress: '0x', chain: 'x' }, []);
  assert.equal(byMsg.fields[0].name, 'tokenAddress');
  assert.equal(METHOD.discoverEndpointParamIssues({ message: 'tokenAddresses must be set' }, { tokenAddress: '0x' }, []), null);
  assert.equal(METHOD.containsIdentifier('bad a_b value', 'a'), false);
  assert.equal(METHOD.containsAsciiToken('use post, or get', 'POST'), true);
  assert.equal(METHOD.containsAsciiToken('POSTED', 'POST'), false);
  assert.deepEqual(METHOD.shellLikeTokens(`curl -H 'a b' "x\\"y" z\\ w 'q\\'`), ['curl', '-H', 'a b', 'x"y', 'z w', 'q\\']);
});
test('a2mcp: contract parsing errors', () => {
  const p = (r, q = '{}') => { try { CONTRACT.parseProbeInput(r, q); } catch (e) { return `${e.code}|${e.msg}`; } return 'ok'; };
  assert.equal(p('{"schemaVersion":1,'), 'invalid_a2mcp_routing|routing JSON is invalid: EOF while parsing a value at line 1 column 19');
  assert.equal(p('{"schemaVersion":1}'), 'invalid_a2mcp_routing|routing JSON is invalid: missing field `serviceSnapshot` at line 1 column 19');
  assert.equal(p('{"schemaVersion":2,"serviceSnapshot":{}}'), 'invalid_a2mcp_routing|schemaVersion must be the integer 1');
  const snap = (o) => JSON.stringify({ schemaVersion: 1, serviceSnapshot: { serviceType: 'A2MCP', serviceId: 's', endpoint: 'https://a.example/x', ...o } });
  assert.equal(p(snap({ endpoint: 'not a url' })), 'invalid_a2mcp_routing|serviceSnapshot.endpoint is invalid: relative URL without a base');
  assert.equal(p(snap({ endpoint: 'https://a:99999/' })), 'invalid_a2mcp_routing|serviceSnapshot.endpoint is invalid: invalid port number');
  assert.equal(p(snap({ endpoint: 'ftp://a/' })), 'invalid_a2mcp_routing|serviceSnapshot.endpoint must use HTTPS');
  assert.equal(p(snap({}), '[1]'), 'invalid_a2mcp_params|params JSON must be an object');
  assert.equal(p(snap({}), '{'), 'invalid_a2mcp_params|params JSON is invalid: EOF while parsing an object at line 1 column 1');
  assert.equal(p(snap({ serviceId: null })), 'invalid_a2mcp_routing|serviceSnapshot.serviceId is required');
  const ok = CONTRACT.parseProbeInput(snap({ serviceId: 9, feeAmount: 0.05, feeTokenSymbol: 'usdt', asp: { aspAgentId: 5421 }, outputSchema: { input: { b: {}, a: { required: false, carrier: 'query' } }, requiredAnyOf: ['a', 1] } }), '{"count":2}');
  assert.equal(j([ok.snapshot.serviceId, ok.snapshot.providerAgentId, ok.snapshot.aspAmount, ok.snapshot.aspSymbol, ok.snapshot.method, ok.snapshot.methodWasDefaulted]), '["9","5421","0.05","USDT","GET",true]');
  assert.deepEqual(ok.snapshot.paramPlan.map((f) => f.name), ['a', 'b']);
  assert.deepEqual(ok.snapshot.requiredAnyOf, ['a']);
});
test('a2mcp: input discovery + outstanding + decisions', () => {
  const out = CONTRACT.outstandingInput({ fields: [{ name: 'a', required: true }, { name: 'count', required: true }, { name: 'o', required: false }], requiredAnyOf: ['id', 'slug'], message: null, method: null, needsDescriptionFallback: false }, { a: 1, slug: 'x' });
  assert.deepEqual(out.fields.map((f) => f.name), ['count']);
  assert.deepEqual(out.requiredAnyOf, []);
  assert.equal(CONTRACT.discoverInputRequired(parse('{"input_required":{"fields":["brand"],"method":"POST"}}')).method, 'POST');
  assert.equal(CONTRACT.discoverInputRequired(parse('{"status":"input_required","requiredArgs":[{"name":"x"}]}')).fields[0].name, 'x');
  assert.equal(CONTRACT.discoverInputRequired(parse('{"missingParams":[],"required":["y"],"message":"m"}')).needsDescriptionFallback, true);
  assert.equal(CONTRACT.discoverInputRequired(parse('{"description":"needs brand"}')), null);
  assert.equal(CONTRACT.discoverInputFallbackHint(parse('{"error":"Missing required parameter: brand."}')).message, 'Missing required parameter: brand.');
  assert.equal(CONTRACT.discoverInputFallbackHint(parse('{"message":"brand is required!"}')).needsDescriptionFallback, true);
  assert.equal(CONTRACT.discoverInputFallbackHint(parse('{"message":"Payment required: missing required input"}')), null);
  const input = { snapshot: { serviceId: 's', raw: { a: 1 }, method: 'GET', methodWasDefaulted: true, paramPlan: [{ name: 'q', type: 'string', required: true, carrier: 'body', description: null }], requiredAnyOf: [] }, typedParams: {} };
  const d = FLOW.inputRequiredDecision(input, { fields: [{ name: 'q', type: 'string', required: true, carrier: null, description: 'd' }], requiredAnyOf: ['alt'], message: 'm', method: null, needsDescriptionFallback: false });
  assert.equal(j(d.toStruct()), '{"phase":"parameter_collection","decision":"requires_user_input","reason":"input_required","nextAction":[{"id":"provide_a2mcp_params","actionLabel":"Provide service parameters","recommend":true},{"id":"cancel_a2mcp","actionLabel":"Cancel","recommend":false}],"payload":{"autoProbeOnValid":true,"fields":[{"description":"d","name":"q","required":true,"type":"string"}],"message":"m","needsDescriptionFallback":false,"nextProbePayload":{"requestSpec":{"fields":[{"description":"d","name":"q","required":true,"type":"string"},{"name":"alt","required":false,"type":"string"}],"requiredAnyOf":["alt"]},"schemaVersion":1,"serviceSnapshot":{"a":1}},"requiredAnyOf":["alt"],"schemaVersion":1,"serviceId":"s","typedParams":{}}}');
  assert.deepEqual(FLOW.mergeFieldConstraints([{ name: 'a', carrier: 'body' }, { name: 'b' }], [{ name: 'b', carrier: 'query' }, { name: 'c' }]).map((f) => [f.name, f.carrier]), [['a', 'body'], ['b', 'query'], ['c', undefined]]);
  assert.deepEqual([['1.50', '1.5'], ['001', '1'], ['0.0', '0'], ['.5', '0.5'], ['-1', '-1'], ['1.2.3', '1.2.3'], ['1e2', '100']].map(([a, b]) => FLOW.decimalStringsEqual(a, b)), [true, true, true, false, false, false, false]);
  assert.deepEqual(['upto', 'UpTo', 'exact', ''].map(FLOW.amountSemantics), ['maximum', 'maximum', 'exact', 'exact']);
  assert.equal(FLOW.fromUtf8ErrorText(Buffer.from([0xff])), 'invalid utf-8 sequence of 1 bytes from index 0');
  assert.equal(FLOW.fromUtf8ErrorText(Buffer.from([0x61, 0xe2, 0x82])), 'incomplete utf-8 byte sequence from index 1');
  assert.equal(FLOW.fromUtf8ErrorText(Buffer.from([0xe2, 0x28, 0xa1])), 'invalid utf-8 sequence of 1 bytes from index 0');
  const e = (a) => { try { FLOW.decodeProbeJsonArgs(a); } catch (x) { return `${x.code}|${x.msg}`; } return 'ok'; };
  assert.equal(e({ routingBase64: '!!!' }), 'invalid_a2mcp_routing|base64 input is invalid: Invalid symbol 33, offset 0.');
  assert.equal(e({ routingJson: '{}', paramsBase64: 'e30' }), 'invalid_a2mcp_params|base64 input is invalid: Invalid padding');
  assert.deepEqual(FLOW.decodeProbeJsonArgs({ routingJson: 'r' }), ['r', '{}']);
});
test('a2mcp: response classification', () => {
  const input = { snapshot: { paramPlan: [], method: 'GET' }, typedParams: { a: 1 } };
  const resp = (status, body, headers = {}) => ({ status, headers, body: Buffer.from(body) });
  assert.deepEqual(PROBE.classifyResponse(input, resp(405, '', { allow: 'POST' })), { kind: 'MethodRequired', allow: 'POST' });
  assert.equal(PROBE.classifyResponse(input, resp(200, '{"ok":1}')).kind, 'Free');
  assert.equal(PROBE.classifyResponse(input, resp(200, '{"error":"missing required argument"}')).kind, 'InputRequired');
  assert.equal(PROBE.classifyResponse(input, resp(500, 'boom')).body, 'boom');
  const ch = PROBE.classifyResponse(input, resp(402, '{"x402Version":1,"accepts":[{"scheme":"exact"}]}'));
  assert.equal(ch.kind, 'Challenge');
  assert.equal(PROBE.classifyResponse(input, resp(402, '{"accepts":[],"outputSchema":{"input":{"b":{}}}}')).kind, 'InputRequired');
  assert.equal(PROBE.classifyResponse(input, resp(402, 'not a challenge')).challenge, 'not a challenge');
  assert.throws(() => PROBE.classifyResponse(input, resp(402, '{}', { 'www-authenticate': 'garbage!!' })), /^Error: unsupported_payment_scheme: malformed 402 challenge/);
});
test('a2mcp: free result state lifecycle', async () => {
  const input = { serviceId: 'service-1', serviceName: 'Free service', providerAgentId: '8136', endpoint: 'https://example.com/free', method: 'POST', typedParams: { query: 'BTC' }, statusCode: 200, result: { answer: 42 } };
  const stored = FREE.storeFreeResult(input, 1000);
  assert.match(stored.confirmationId, /^a2free_[0-9a-f]{32}$/);
  assert.equal(j(FREE.loadFreeResult(stored.confirmationId, 1299).result), '{"answer":42}');
  assert.equal(FREE.consumeFreeResult(stored.confirmationId, 1299).statusCode, 200);
  assert.throws(() => FREE.consumeFreeResult(stored.confirmationId, 1299), /a2mcp_free_result_expired_or_missing/);
  const s2 = FREE.storeFreeResult(input, 1000);
  assert.throws(() => FREE.loadFreeResult(s2.confirmationId, 1300), /a2mcp_free_result_expired_or_missing/);
  assert.equal(existsSync(join(process.env.OCL_HOME, 'a2mcp', `${s2.confirmationId}.json`)), false);
  const now = Math.floor(Date.now() / 1000);
  const s3 = FREE.storeFreeResult(input, now);
  const pending = FLOW.runConfirmFree({ confirmationId: s3.confirmationId, yes: false });
  assert.equal(pending.reason, 'free_confirmation_required');
  assert.equal(pending.payload.providerAgentId, '8136');
  assert.equal(pending.payload.result, undefined);
  const ready = FLOW.runConfirmFree({ confirmationId: s3.confirmationId, yes: true });
  assert.equal(j(ready.toStruct()), `{"phase":"endpoint_result","decision":"ready","reason":"free_result","nextAction":[],"payload":{"amountDisplay":"Free","endpoint":"https://example.com/free","method":"POST","providerAgentId":"8136","result":{"answer":42},"schemaVersion":1,"serviceId":"service-1","serviceName":"Free service","statusCode":200,"typedParams":{"query":"BTC"}}}`);
  const rec = await A2.normalizeInvocationResult(Promise.resolve().then(() => FLOW.runConfirmFree({ confirmationId: s3.confirmationId, yes: true })));
  assert.equal(rec.reason, 'a2mcp_free_result_expired_or_missing');
  assert.deepEqual(readdirSync(join(process.env.OCL_HOME, 'a2mcp')), []);
  assert.equal(await aerr(A2.normalizeInvocationResult(Promise.reject(new Error('cross_user_payment_id: x')))), 'cross_user_payment_id: x');
  const cand = await A2.normalizeInvocationResult(Promise.reject(new Error('a2mcp_invalid_payment_intent: unknown candidate')));
  assert.equal(cand.reason, 'a2mcp_candidate_invalid_or_missing');
});
test('a2mcp: payment confirmation actions', () => {
  const { ProbeDecision } = A2;
  const on = ProbeDecision.paymentConfirmation('a2prep_1', 'candidate_0', true, true).toStruct();
  assert.equal(j(on.nextAction), '[{"id":"confirm_a2mcp_payment","actionLabel":"Confirm payment","recommend":true,"params":{"candidateId":"candidate_0","preparedId":"a2prep_1"}},{"id":"cancel_a2mcp","actionLabel":"Cancel","recommend":false}]');
  const off = ProbeDecision.paymentConfirmation('p', 'c', false, true).toStruct();
  assert.deepEqual(off.nextAction.map((a) => a.id), ['fund_a2mcp_token', 'select_a2mcp_token', 'cancel_a2mcp']);
  assert.equal(off.reason, 'insufficient_balance');
  assert.equal(j(A2.confirmationPresentation(null, null, 'https://e', 'Up to 1 USDT', { b: 1, a: 2 }).rows.map((r) => r.value)), '["—","—","https://e","Up to 1 USDT","{\\"a\\":2,\\"b\\":1}"]');
  assert.equal(A2.paidFeeDisplay('1.5', 'USDC', 'maximum'), 'Up to 1.5 USDC');
  assert.equal(j(FLOW.paymentReadyDecision('pay_1').toStruct()), '{"phase":"payment_ready","decision":"ready","reason":"payment_ready","nextAction":[{"id":"execute_a2mcp_payment","actionLabel":"Execute payment","recommend":true,"params":{"paymentId":"pay_1"}}],"payload":{"paymentId":"pay_1","schemaVersion":1}}');
});
test('chat: file-upload local checks run before auth', async () => {
  const missing = await aerr(CHAT.cmdUpload('does-not-exist.bin', '1', '0xj'));
  assert.match(missing, /^file not found: does-not-exist\.bin: .+ \(os error 2\)$/);
  assert.equal(await aerr(CHAT.cmdUpload('test', '1', '0xj')), 'not a file: test');
  assert.equal(await aerr(CHAT.cmdUpload('test/unit/agent-identity.test.mjs', '1', '0xj')), 'session expired, please login again: onchainos wallet login');
});
