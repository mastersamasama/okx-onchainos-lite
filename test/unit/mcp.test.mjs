// `onchainos mcp` — upstream cli/src/mcp/mod.rs (tools, mcp::ok / mcp::err) on top of rmcp 1.3.0
// (stdio framing, message classification, handshake, ServerHandler defaults) and the
// serde_json `Parameters<T>` deserialisation driven by lib/mcp-tools.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-mcp-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const LIB = '../../skill/onchainos-lite/lib/';
const S = await import(LIB + 'mcp/serde.mjs');
const R = await import(LIB + 'mcp/rmcp.mjs');
const M = await import(LIB + 'mcp/index.mjs');
const E = await import(LIB + 'core/errors.mjs');
const { pushEvent, drainEvents } = await import(LIB + 'core/notify.mjs');
const { parse, F64 } = await import(LIB + 'core/json.mjs');
const { readFileSync } = await import('node:fs');
const CATALOGUE = JSON.parse(readFileSync(new URL(LIB + 'mcp-tools.json', import.meta.url), 'utf8'));
const schema = (name) => CATALOGUE.tools.find((t) => t.name === name).inputSchema;
const deErr = (name, args) => { try { S.fromArguments(schema(name), parse(JSON.stringify(args))); } catch (e) { return e.message; } return null; };
const deRaw = (name, json) => { try { return S.fromArguments(schema(name), parse(json)); } catch (e) { return e.message; } };

// ── catalogue ───────────────────────────────────────────────────────
test('every catalogued tool has an implementation and vice versa (88 tools)', () => {
  const names = CATALOGUE.tools.map((t) => t.name);
  assert.equal(names.length, 88);
  assert.deepEqual(Object.keys(M.TOOLS).sort(), [...names].sort());
});

test('tools/list is sorted by name (ToolRouter::list_all)', () => {
  const listed = JSON.parse(M.mcpServer().listTools()[Symbol.for('ocl.raw')]).tools.map((t) => t.name);
  const sorted = [...listed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(listed, sorted);
  assert.equal(listed[0], 'cross_chain_bridges');
  assert.equal(listed.at(-1), 'workflow_wallet_analysis');
});

// ── Parameters<T> (serde_json::from_value) ──────────────────────────
test('missing required fields are reported in declaration order', () => {
  assert.equal(deErr('leaderboard_list', {}), 'missing field `chain`');
  assert.equal(deErr('leaderboard_list', { time_frame: '3', sort_by: '1' }), 'missing field `chain`');
  assert.equal(deErr('leaderboard_list', { chain: 'sol', time_frame: '1' }), 'missing field `sort_by`');
  assert.equal(deErr('cross_chain_status', { from_chain: '1' }), 'missing field `bridge_id`');
});

test('type errors win over missing fields; keys are visited in byte order', () => {
  assert.equal(deErr('leaderboard_list', { wallet_type: 7 }), 'invalid type: integer `7`, expected a string');
  assert.equal(deErr('token_info', { chain: 5, address: 6 }), 'invalid type: integer `6`, expected a string');
  assert.equal(deErr('token_info', { address: null }), 'invalid type: null, expected a string');
  assert.equal(deErr('token_info', { address: true }), 'invalid type: boolean `true`, expected a string');
  assert.equal(deErr('token_info', { address: [] }), 'invalid type: sequence, expected a string');
  assert.equal(deErr('token_info', { address: {} }), 'invalid type: map, expected a string');
});

test('integer targets: range, sign and float errors', () => {
  assert.equal(deErr('market_kline', { address: 'a', limit: '5' }), 'invalid type: string "5", expected u32');
  assert.equal(deErr('market_kline', { address: 'a', limit: -1 }), 'invalid value: integer `-1`, expected u32');
  assert.equal(deErr('market_kline', { address: 'a', limit: 4294967296 }), 'invalid value: integer `4294967296`, expected u32');
  assert.equal(deRaw('market_kline', '{"address":"a","limit":1.0}'), 'invalid type: floating point `1.0`, expected u32');
  assert.equal(deRaw('market_kline', '{"address":"a","limit":-0}'), 'invalid type: floating point `-0.0`, expected u32');
  assert.equal(deErr('token_holders', { address: 'a', tag_filter: 256 }), 'invalid value: integer `256`, expected u8');
  assert.equal(deErr('payment_pay', { payment_id: 'p', selected_index: '0' }), 'invalid type: string "0", expected usize');
  assert.equal(deRaw('payment_session', '{"action":"a","chain_id":18446744073709551616}'), 'invalid type: floating point `1.8446744073709552e+19`, expected u64');
  assert.equal(deRaw('defi_invest', '{"investment_id":"1","address":"a","token":"t","amount":"1","tick_upper":9223372036854775808}'),
    'invalid value: integer `9223372036854775808`, expected i64');
});

test('values convert to the JS shapes the fetch fns take', () => {
  const p = deRaw('defi_invest', '{"investment_id":"1","address":"a","token":"t","amount":"1","tick_lower":-9007199254740993,"range":5,"x":{"ignored":true}}');
  assert.equal(p.tick_lower, -9007199254740993n);
  assert.equal(p.range, 5);
  assert.equal(p.tick_upper, null);
  assert.equal(p.slippage, null);
  assert.equal('x' in p, false);
  assert.equal(deRaw('defi_invest', '{"investment_id":"1","address":"a","token":"t","amount":"1","range":2.5}').range, 2.5);
  const q = S.fromArguments(schema('payment_quote'), { url: 'u' });
  assert.deepEqual([q.param, q.method], [[], 'GET']);
  assert.equal(S.fromArguments(schema('gateway_broadcast'), { signed_tx: 's', address: 'a', chain: 'c' }).mev_protection, false);
  assert.equal(deErr('payment_quote', { url: 'u', param: ['a', 1] }), 'invalid type: integer `1`, expected a string');
  assert.equal(deErr('payment_quote', { url: 'u', param: 'a' }), 'invalid type: string "a", expected a sequence');
  assert.equal(deErr('payment_a2a_status', { payment_id: 'p', wait: 1 }), 'invalid type: integer `1`, expected a boolean');
  assert.equal(deErr('defi_invest', { investment_id: '1', address: 'a', token: 't', amount: '1', range: '5' }), 'invalid type: string "5", expected f64');
});

test('tools without Parameters<T> take no arguments', () => {
  assert.equal(S.takesParams(schema('signal_chains')), false);
  assert.equal(S.takesParams(schema('token_info')), true);
});

test('Rust {:?} of strings and serde_json Values', () => {
  assert.equal(S.debugStr('a"b\\c\n\t\r\0'), '"a\\"b\\\\c\\n\\t\\r\\0"');
  assert.equal(S.debugStr('\u0001\u007f ​́é😀 '), '"\\u{1}\\u{7f}\\u{a0}\\u{200b}\\u{301}é😀 "');
  assert.equal(S.debugValue(parse('{"b":[1,-2,1.5,true,null],"a":"x"}')), 'Object {"a": String("x"), "b": Array [Number(1), Number(-2), Number(1.5), Bool(true), Null]}');
});

// ── rmcp message classification ─────────────────────────────────────
const msg = (o) => R.parseMessage(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)));
test('JsonRpcMessage untagged classification', () => {
  assert.equal(msg({ jsonrpc: '2.0', id: 1, method: 'ping', params: 5 }).req.type, 'PingRequest');
  assert.equal(msg({ jsonrpc: '2.0', id: 'x', method: 'tools/list' }).req.type, 'ListToolsRequest');
  const bad = msg({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 5 } });
  assert.deepEqual([bad.req.type, bad.req.paramsSome], ['ListToolsRequest', false]);   // flattened Option → None
  assert.equal(msg({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }).req.type, 'CustomRequest');
  assert.equal(msg({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }), null);
  assert.equal(msg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1', capabilities: {} } }).req.type, 'CustomRequest');
  assert.equal(msg({ jsonrpc: '2.0', id: null, method: 'ping' }).kind, 'notification');
  assert.equal(msg('{"jsonrpc":"2.0","id":9223372036854775808,"method":"ping"}').kind, 'notification');
  assert.equal(msg('{"jsonrpc":"2.0","id":9223372036854775807,"method":"ping"}').id, 9223372036854775807n);
  assert.equal(msg({ jsonrpc: '2.0', id: 3, result: null }).kind, 'response');
  assert.equal(msg({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'm' } }).kind, 'error');
  assert.equal(msg({ jsonrpc: '2.0', id: 3, error: { code: 'x', message: 'm' } }), null);
  assert.equal(msg({ method: 'custom/x' }), 'ignore');                 // non-MCP notification
  assert.equal(msg({ method: 'tools/list' }), null);                   // standard method without jsonrpc
  assert.equal(msg({ id: 1, method: 'notifications/foo' }), 'ignore'); // non-standard notifications/*
  assert.equal(msg(''), null);
  assert.equal(msg('[1]'), null);
});

test('handshake error texts use the Rust Debug of the message', () => {
  assert.equal(R.debugMessage(msg({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    'Notification(JsonRpcNotification { jsonrpc: JsonRpcVersion2_0, notification: InitializedNotification(NotificationNoParam { method: InitializedNotificationMethod, extensions: Extensions }) })');
  assert.equal(R.debugMessage(msg({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'c' } })),
    'Request(JsonRpcRequest { jsonrpc: JsonRpcVersion2_0, id: Number(1), request: ListToolsRequest(RequestOptionalParam { method: ListToolsRequestMethod, params: Some(PaginatedRequestParams { meta: None, cursor: Some("c") }), extensions: Extensions }) })');
  assert.equal(R.debugMessage(msg({ jsonrpc: '2.0', id: 'i', method: 'x/y' })),
    'Request(JsonRpcRequest { jsonrpc: JsonRpcVersion2_0, id: String("i"), request: CustomRequest(CustomRequest { method: "x/y", params: None, extensions: Extensions }) })');
});

test('typed ClientRequest / ClientNotification / ClientResult variants in handshake texts', () => {
  const req = (method, params) => R.debugMessage(msg({ jsonrpc: '2.0', id: 1, method, params })).replace(/^Request\(JsonRpcRequest \{ jsonrpc: JsonRpcVersion2_0, id: Number\(1\), request: (.*) \}\)$/, '$1');
  assert.equal(req('prompts/get', { name: 'p', arguments: { a: 'b' } }),
    'GetPromptRequest(Request { method: GetPromptRequestMethod, params: GetPromptRequestParams { meta: None, name: "p", arguments: Some({"a": String("b")}) }, extensions: Extensions })');
  assert.match(req('prompts/get', { arguments: {} }), /^CustomRequest\(/);
  assert.equal(req('resources/read', { uri: 'u' }),
    'ReadResourceRequest(Request { method: ReadResourceRequestMethod, params: ReadResourceRequestParams { meta: None, uri: "u" }, extensions: Extensions })');
  assert.equal(req('tasks/cancel', { taskId: 't' }),
    'CancelTaskRequest(Request { method: CancelTaskMethod, params: CancelTaskParams { meta: None, task_id: "t" }, extensions: Extensions })');
  assert.equal(req('completion/complete', { ref: { type: 'ref/resource', uri: 'r' }, argument: { name: 'a', value: 'b' }, context: { arguments: { k: 'v' } } }),
    'CompleteRequest(Request { method: CompleteRequestMethod, params: CompleteRequestParams { meta: None, ref: Resource(ResourceReference { uri: "r" }), '
    + 'argument: ArgumentInfo { name: "a", value: "b" }, context: Some(CompletionContext { arguments: Some({"k": "v"}) }) }, extensions: Extensions })');
  assert.equal(R.debugMessage(msg({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 7, progress: 1e16, total: 0.00001 } })),
    'Notification(JsonRpcNotification { jsonrpc: JsonRpcVersion2_0, notification: ProgressNotification(Notification { method: ProgressNotificationMethod, '
    + 'params: ProgressNotificationParam { progress_token: ProgressToken(Number(7)), progress: 1e16, total: Some(1e-5), message: None }, extensions: Extensions }) })');
  assert.match(R.debugMessage(msg('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1.5,"progress":3}}')), /CustomNotification\(/);
  const init = (capabilities, clientInfo) => req('initialize', { protocolVersion: 'v', capabilities, clientInfo });
  assert.equal(init({ roots: { listChanged: true }, sampling: {}, experimental: { x: { a: 1 } } }, { name: 'c', version: '1', icons: [{ src: 's', theme: 'dark' }] }),
    'InitializeRequest(Request { method: InitializeResultMethod, params: InitializeRequestParams { meta: None, protocol_version: ProtocolVersion("v"), '
    + 'capabilities: ClientCapabilities { experimental: Some({"x": {"a": Number(1)}}), extensions: None, roots: Some(RootsCapabilities { list_changed: Some(true) }), '
    + 'sampling: Some(SamplingCapability { tools: None, context: None }), elicitation: None, tasks: None }, '
    + 'client_info: Implementation { name: "c", title: None, version: "1", description: None, icons: Some([Icon { src: "s", mime_type: None, sizes: None, theme: Some(Dark) }]), website_url: None } }, extensions: Extensions })');
  assert.match(init({ roots: { listChanged: 'yes' } }, { name: 'c', version: '1' }), /^CustomRequest\(/);   // typed params fail → CustomRequest
  assert.match(init({}, { name: 'c', version: '1', icons: [{}] }), /^CustomRequest\(/);
  const res = (result) => R.debugMessage(msg({ jsonrpc: '2.0', id: 5, result })).replace(/^Response\(JsonRpcResponse \{ jsonrpc: JsonRpcVersion2_0, id: Number\(5\), result: (.*) \}\)$/, '$1');
  assert.equal(res({}), 'EmptyResult(EmptyObject)');
  assert.equal(res({ a: 1 }), 'CustomResult(CustomResult(Object {"a": Number(1)}))');
  assert.equal(res({ roots: [{ uri: 'u', name: 'n' }] }), 'ListRootsResult(ListRootsResult { roots: [Root { uri: "u", name: Some("n") }] })');
  assert.equal(res({ action: 'decline' }), 'CreateElicitationResult(CreateElicitationResult { action: Decline, content: None })');
});

test('Rust {:?} of f64', () => {
  const cases = [[1, '1.0'], [0.5, '0.5'], [-0, '-0.0'], [1e16, '1e16'], [1e15, '1000000000000000.0'], [1.5e-5, '1.5e-5'], [0.0001, '0.0001'], [123.456, '123.456'], [-2.5e300, '-2.5e300']];
  for (const [x, want] of cases) assert.equal(S.debugF64(x), want, String(x));
});

// ── rmcp serve over in-memory stdio ─────────────────────────────────
const J = (o) => JSON.stringify(o);
const INIT = (v, id = 1) => J({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const INITED = J({ jsonrpc: '2.0', method: 'notifications/initialized' });
const fakeHandler = {
  getInfo: (v) => ({ protocolVersion: v }),
  listTools: () => ({ tools: [] }),
  async callTool(req) {
    if (req.name === 'slow') await new Promise((r) => setTimeout(r, 50));
    if (req.name === 'missing') throw new R.RpcError(R.INVALID_PARAMS, 'tool not found');
    return R.callToolResult(`ran ${req.name}`, false);
  },
};
async function session(lines, handler = fakeHandler) {
  const input = new PassThrough(), output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = R.serve(handler, { input, output }).then(() => null, (e) => e);
  input.end(lines.join('\n') + (lines.length ? '\n' : ''));
  const error = await done;
  return { error, out: Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean) };
}

test('protocol version negotiation (lexicographic, server 2025-06-18)', async () => {
  for (const [client, want] of [['2024-11-05', '2024-11-05'], ['2025-06-18', '2025-06-18'], ['2099-01-01', '2025-06-18'], ['1.0', '1.0']]) {
    const { out, error } = await session([INIT(client), INITED]);
    assert.equal(error, null);
    assert.equal(out[0], `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"${want}"}}`);
  }
});

test('pings before initialize and setLevel/ping before initialized are answered', async () => {
  const { out } = await session([J({ jsonrpc: '2.0', id: 'a', method: 'ping' }), INIT('2025-06-18', 2),
    J({ jsonrpc: '2.0', id: 3, method: 'logging/setLevel', params: { level: 'info' } }), INITED,
    J({ jsonrpc: '2.0', id: 4, method: 'logging/setLevel', params: { level: 'info' } })]);
  assert.deepEqual(out, [
    '{"jsonrpc":"2.0","id":"a","result":{}}',
    '{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2025-06-18"}}',
    '{"jsonrpc":"2.0","id":3,"result":{}}',
    '{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"logging/setLevel"}}',
  ]);
});

test('handshake failures', async () => {
  assert.equal((await session([])).error.message, 'connection closed: initialize request');
  assert.equal((await session(['garbage'])).error.message, 'connection closed: initialize request');
  const r = await session([INIT('2025-06-18')]);
  assert.equal(r.out.length, 1);
  assert.equal(r.error.message, 'connection closed: initialize notification');
  assert.match((await session([INITED])).error.message, /^expect initialized request, but received: Some\(Notification\(/);
  assert.match((await session([INIT('2025-06-18'), J({ jsonrpc: '2.0', id: 2, method: 'tools/list' })])).error.message,
    /^expect initialized notification, but received: Some\(Request\(JsonRpcRequest \{ jsonrpc: JsonRpcVersion2_0, id: Number\(2\), request: ListToolsRequest/);
});

test('ServerHandler defaults after the handshake', async () => {
  const cases = [
    [{ method: 'prompts/list' }, '{"jsonrpc":"2.0","id":9,"result":{"prompts":[]}}'],
    [{ method: 'resources/list' }, '{"jsonrpc":"2.0","id":9,"result":{"resources":[]}}'],
    [{ method: 'resources/templates/list' }, '{"jsonrpc":"2.0","id":9,"result":{"resourceTemplates":[]}}'],
    [{ method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: 'b' } } }, '{"jsonrpc":"2.0","id":9,"result":{"completion":{"values":[]}}}'],
    [{ method: 'prompts/get', params: { name: 'x' } }, '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"prompts/get"}}'],
    [{ method: 'foo' }, '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"foo"}}'],
    [{ method: 'tools/call', params: { arguments: {} } }, '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"tools/call"}}'],
    [{ method: 'tools/call', params: { name: 'missing' } }, '{"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"tool not found"}}'],
    [{ method: 'tools/call', params: { name: 'x' } }, '{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"ran x"}],"isError":false}}'],
  ];
  for (const [m, want] of cases) {
    const { out } = await session([INIT('2025-06-18'), INITED, J({ jsonrpc: '2.0', id: 9, ...m })]);
    assert.equal(out[1], want, m.method);
  }
});

test('a codec error ends the session; ignored lines do not', async () => {
  let r = await session([INIT('2025-06-18'), INITED, '', J({ jsonrpc: '2.0', id: 3, method: 'ping' })]);
  assert.equal(r.out.length, 1);
  r = await session([INIT('2025-06-18'), INITED, J({ method: 'x' }), J({ jsonrpc: '2.0', id: null, method: 'ping' }), J({ jsonrpc: '2.0', id: 3, method: 'ping' })]);
  assert.deepEqual(r.out.slice(1), ['{"jsonrpc":"2.0","id":3,"result":{}}']);
});

test('ignored lines follow FramedRead + decode_eof: after EOF the rest of the buffer is one frame', async () => {
  const ping = (id) => J({ jsonrpc: '2.0', id, method: 'ping' });
  const pong = (id) => `{"jsonrpc":"2.0","id":${id},"result":{}}`;
  // 1st ignored line → read → EOF; later lines decode normally until the next ignored line,
  // whose remainder ("ping4\nping5\n") is parsed as a single frame → codec error → session ends.
  // (ignored = fails to parse and carries a non-standard notification method; a jsonrpc 2.0
  // notification with an unknown method parses as CustomNotification and is not "ignored")
  let r = await session([INIT('2025-06-18'), INITED, J({ method: 'x/a' }), ping(3), J({ method: 'notifications/b' }), ping(4), ping(5)]);
  assert.deepEqual(r.out.slice(1), [pong(3)]);
  r = await session([INIT('2025-06-18'), INITED, J({ jsonrpc: '2.0', method: 'x/a' }), ping(3), J({ jsonrpc: '2.0', method: 'x/b' }), ping(4), ping(5)]);
  assert.deepEqual(r.out.slice(1), [pong(3), pong(4), pong(5)]);
  // a single remaining line parses (its "\n" is JSON whitespace)
  r = await session([INIT('2025-06-18'), INITED, J({ method: 'x/a' }), ping(3), J({ method: 'x/b' }), ping(4)]);
  assert.deepEqual(r.out.slice(1), [pong(3), pong(4)]);
  // before EOF an ignored line waits for more input; buffered lines resume once it arrives
  const input = new PassThrough(), output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  const done = R.serve(fakeHandler, { input, output });
  input.write([INIT('2025-06-18'), INITED, J({ method: 'x/a' }), ping(3)].join('\n') + '\n');
  await new Promise((res) => setTimeout(res, 50));
  const lines = () => Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
  assert.equal(lines().length, 1);
  input.end(ping(4) + '\n');
  await done;
  assert.deepEqual(lines().slice(1), [pong(3), pong(4)]);
});

test('stdin EOF drains in-flight responses', async () => {
  const { out } = await session([INIT('2025-06-18'), INITED, J({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slow' } })]);
  assert.equal(out[1], '{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"ran slow"}],"isError":false}}');
});

// ── mcp::ok / mcp::err ──────────────────────────────────────────────
test('mcp::ok — bare data, or {data, notifications} when events are pending', () => {
  drainEvents();
  assert.deepEqual(M.ok({ b: 1, a: new F64('2.0') }), { isError: false, text: '{"a":2.0,"b":1}' });
  pushEvent({ code: 'X', data: { z: 1, y: 2 } });
  assert.equal(M.ok([1]).text, '{"data":[1],"notifications":[{"code":"X","data":{"y":2,"z":1}}]}');
  assert.equal(drainEvents().length, 0);
});

test('mcp::err — special error shapes (sorted json!, compact) and plain text', () => {
  drainEvents();
  assert.deepEqual(M.err(new Error('boom')), { isError: true, text: 'boom' });
  pushEvent({ code: 'N' });
  assert.equal(M.err(new Error('boom')).text, '{"error":"boom","notifications":[{"code":"N"}]}');
  assert.equal(M.err(new E.Confirming({ message: 'review', next: 'rerun --force', scene: 'x402' })).text,
    '{"confirming":true,"message":"review","next":"rerun --force","scene":"x402"}');
  assert.equal(M.err(new E.Confirming({ message: '', next: '' })).text, '{"confirming":true}');
  assert.equal(M.err(new E.Confirming({ scene: '' })).text, '{"confirming":true,"scene":""}');
  assert.equal(M.err(new E.WalletPreviewConfirming({ message: 'review', next: '', scene: 'btc_inscription', preview: { inputs: ['a:0'] } })).text,
    '{"confirming":true,"message":"review","preview":{"inputs":["a:0"]},"scene":"btc_inscription"}');
  assert.equal(M.err(new E.DuplicateSubscription({ id: 's1' })).text, '{"data":{"id":"s1"},"ok":false}');
  assert.equal(M.err(new E.CodedError('INSUFFICIENT_AVAILABLE', null, 'insufficient', { data: { availableBalance: '1' }, nextSteps: { q: 'onchainos wallet utxo unavailable --chain bitcoin' } })).text,
    '{"data":{"availableBalance":"1"},"error":"insufficient","errorCode":"INSUFFICIENT_AVAILABLE","nextSteps":{"q":"onchainos wallet utxo unavailable --chain bitcoin"},"ok":false}');
  pushEvent({ code: 'N' });
  assert.equal(M.err(new E.CodedError('invalid_input', 'since', 'bad')).text,
    '{"error":"bad","errorCode":"invalid_input","errorField":"since","notifications":[{"code":"N"}],"ok":false}');
  // anyhow downcast_ref sees through .context() layers
  assert.equal(M.err(E.context('outer', new E.Confirming({ message: 'm' }))).text, '{"confirming":true,"message":"m"}');
  assert.equal(M.err(new E.FundingBlocked({ a: 1 })).text, 'insufficient balance');
});

// ── tool bodies that fail before any request ────────────────────────
test('tool pre-checks and local tools', async () => {
  const server = M.mcpServer();
  const callText = async (name, args) => (await server.callTool({ name, arguments: args, task: null })).content[0].text;
  assert.equal(await callText('tracker_activities', { tracker_type: 'multi_address' }), 'wallet_address is required when tracker_type is multi_address');
  assert.equal(await callText('tracker_activities', { tracker_type: '3' }), 'wallet_address is required when tracker_type is multi_address');
  assert.equal(await callText('cross_chain_status', { bridge_id: '1', from_chain: '1' }), 'one of tx_hash or order_id is required');
  assert.equal(await callText('cross_chain_status', { bridge_id: '1', from_chain: '1', tx_hash: 'h', order_id: 'o' }), 'provide tx_hash OR order_id, not both');
  assert.equal(await callText('workflow_token_research', { chain: 'solana' }), "Either 'address' or 'query' is required");
  assert.equal(await callText('payment_decode_receipt', {}), 'invalid_input: could not decode receipt');
  const session = await server.callTool({ name: 'payment_session', arguments: { action: 'close', unit_amount: '10', cumulative_amount: '40', deposit: '100' }, task: null });
  assert.equal(session.isError, false);
  assert.equal(JSON.parse(session.content[0].text).refund, '50');
  await assert.rejects(server.callTool({ name: 'nope', arguments: {}, task: null }), { code: -32602, message: 'tool not found' });
  await assert.rejects(server.callTool({ name: 'token_info', arguments: {}, task: {} }), { code: -32602, message: 'Tool does not support task-based invocation' });
  await assert.rejects(server.callTool({ name: 'nope', arguments: {}, task: {} }), { code: -32603, message: 'Task processing not implemented' });
  await assert.rejects(server.callTool({ name: 'token_info', arguments: null, task: null }), { code: -32602, message: 'failed to deserialize parameters: missing field `address`' });
});

test('initialize result is the rmcp struct (field order)', () => {
  const info = M.mcpServer().getInfo('2024-11-05');
  assert.equal(JSON.stringify(info), '{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"onchainos","version":"4.6.3"}}');
});
