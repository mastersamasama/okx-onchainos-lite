// Unit tests: core/ws.mjs (RFC 6455 client), lib/watch/* (types, serde-faithful config
// parsing, store, daemon helpers + a scripted daemon session), commands/ws helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, truncateSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-ws-unit-'));
process.env.OCL_HOME = HOME;
process.env.OCL_WS_URL = 'ws://127.0.0.1:9/ws/v6/dex';     // nothing listens: runDaemon's connect fails fast
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const ws = await import('../../skill/onchainos-lite/lib/core/ws.mjs');
const types = await import('../../skill/onchainos-lite/lib/watch/types.mjs');
const store = await import('../../skill/onchainos-lite/lib/watch/store.mjs');
const daemon = await import('../../skill/onchainos-lite/lib/watch/daemon.mjs');
const cmd = await import('../../skill/onchainos-lite/lib/commands/ws/ws.mjs');
const { stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');

// ── core/ws.mjs ─────────────────────────────────────────────────────────────

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshake request has tungstenite header order and Host as written', () => {
  const u = ws.parseWsUrl('ws://user:pw@127.0.0.1:18899/ws/v6/dex?x=1');
  assert.deepEqual([u.scheme, u.host, u.hostname, u.port, u.target], ['ws', '127.0.0.1:18899', '127.0.0.1', 18899, '/ws/v6/dex?x=1']);
  const w = ws.parseWsUrl('wss://wsdex.okx.com/ws/v6/dex');
  assert.deepEqual([w.host, w.port], ['wsdex.okx.com', 443]);
  assert.equal(ws.parseWsUrl('wss://h:443').target, '/');
  assert.equal(ws.handshakeRequest('/ws/v6/dex', 'wsdex.okx.com', 'KEY'),
    'GET /ws/v6/dex HTTP/1.1\r\nHost: wsdex.okx.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: KEY\r\n\r\n');
  assert.throws(() => ws.parseWsUrl('ftp://x/y'), /URL scheme not supported/);
});

test('verifyResponse reproduces tungstenite handshake errors', () => {
  const key = 'abc';
  const ok = { status: 101, headers: { upgrade: 'WebSocket', connection: 'Upgrade', 'sec-websocket-accept': ws.acceptKey(key) } };
  assert.doesNotThrow(() => ws.verifyResponse(ok, key));
  assert.throws(() => ws.verifyResponse({ ...ok, status: 404 }, key), { message: 'HTTP error: 404 Not Found' });
  assert.throws(() => ws.verifyResponse({ ...ok, headers: { ...ok.headers, upgrade: 'h2c' } }, key), { message: 'WebSocket protocol error: No "Upgrade: websocket" header' });
  assert.throws(() => ws.verifyResponse({ ...ok, headers: { ...ok.headers, connection: 'keep-alive, Upgrade' } }, key), { message: 'WebSocket protocol error: No "Connection: upgrade" header' });
  assert.throws(() => ws.verifyResponse({ ...ok, headers: { ...ok.headers, 'sec-websocket-accept': 'x' } }, key), { message: 'WebSocket protocol error: Key mismatch in "Sec-WebSocket-Accept" header' });
  assert.equal(ws.parseResponseHead('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX: 1').headers.upgrade, 'websocket');
});

test('frames round-trip for every length encoding, masked and unmasked', () => {
  for (const len of [0, 1, 125, 126, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(len, 0x61);
    for (const mask of [Buffer.from([1, 2, 3, 4]), null]) {
      const d = new ws.FrameDecoder(mask ? 'server' : 'client');
      const buf = ws.encodeFrame(ws.OP.BINARY, payload, mask);
      d.push(buf.subarray(0, 3));                        // split delivery
      if (buf.length > 3) assert.equal(d.next(), null);
      d.push(buf.subarray(3));
      const f = d.next();
      assert.equal(f.opcode, ws.OP.BINARY);
      assert.ok(f.fin);
      assert.ok(f.payload.equals(payload));
      assert.equal(d.next(), null);
    }
  }
});

// A WebSocket over an in-memory socket fed with raw server bytes.
import { EventEmitter } from 'node:events';
function fakeWs(bytes) {
  const sock = Object.assign(new EventEmitter(), { written: [], destroyed: false, resume() {}, write(b) { this.written.push(b); }, destroy() { this.destroyed = true; } });
  return { sock, w: new ws.WebSocket(sock, Buffer.concat(bytes)) };
}
const srvFrame = (op, data = '', fin = true) => ws.encodeFrame(op, Buffer.from(data), null, fin);

test('consumed frames are checked in tungstenite order with its texts', async () => {
  const E = async (bytes) => { const { w } = fakeWs(bytes); try { const m = await w.next(0); return m === ws.TIMEOUT ? 'TIMEOUT' : JSON.stringify(m); } catch (e) { return e.message; } };
  assert.equal(await E([ws.encodeFrame(ws.OP.TEXT, 'x', Buffer.from([9, 9, 9, 9]))]), 'WebSocket protocol error: Received a masked frame from server');
  assert.equal(await E([Buffer.from([0xc1, 0x00])]), 'WebSocket protocol error: Reserved bits are non-zero');
  assert.equal(await E([srvFrame(ws.OP.PING, '', false)]), 'WebSocket protocol error: Fragmented control frame');
  assert.equal(await E([srvFrame(ws.OP.CONT, 'x')]), 'WebSocket protocol error: Continue frame but nothing to continue');
  assert.equal(await E([srvFrame(ws.OP.TEXT, 'a', false), srvFrame(ws.OP.BINARY, 'b')]), 'WebSocket protocol error: While waiting for more fragments received: BINARY');
  assert.equal(await E([srvFrame(3, 'x')]), 'WebSocket protocol error: Unknown data frame type: 3');
  assert.equal(await E([srvFrame(0xb, 'x')]), 'WebSocket protocol error: Unknown control frame type: 11');
  assert.equal(await E([srvFrame(ws.OP.TEXT, 'a', false), srvFrame(ws.OP.CONT, 'b')]), '{"type":"text","data":"ab"}');
  assert.equal(await E([ws.encodeFrame(ws.OP.TEXT, Buffer.from([0xff]), null)]), 'UTF-8 encoding error');
  assert.equal(await E([srvFrame(ws.OP.CLOSE, ''), srvFrame(ws.OP.TEXT, 'late')]), '{"type":"close","reason":""}');
  const { w } = fakeWs([srvFrame(ws.OP.CLOSE, ''), srvFrame(ws.OP.TEXT, 'late')]);
  await w.next(0);
  await assert.rejects(w.next(0), { message: 'WebSocket protocol error: Remote sent after having closed' });
  assert.equal(await E([]), 'TIMEOUT');
  assert.equal(ws.decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), '﻿a');   // BOM kept
});

test('pong / close replies are queued and written by the next read or send (tungstenite additional_send)', async () => {
  const { sock, w } = fakeWs([srvFrame(ws.OP.PING, 'a'), srvFrame(ws.OP.PING, 'b'), srvFrame(ws.OP.CLOSE, '')]);
  const sent = () => sock.written.map((b) => { const d = new ws.FrameDecoder(); d.push(b); const f = d.next(); return `${f.opcode}:${f.payload.toString()}`; });
  assert.deepEqual(await w.next(0), { type: 'ping', data: Buffer.from('a') });
  assert.deepEqual(sent(), []);                                   // not yet flushed
  assert.deepEqual(await w.next(0), { type: 'ping', data: Buffer.from('b') });
  assert.deepEqual(sent(), ['10:a']);
  w.send('hi');                                                   // message first, then the pending pong
  assert.deepEqual(sent(), ['10:a', '1:hi', '10:b']);
  assert.deepEqual(await w.next(0), { type: 'close', code: undefined, reason: '' });
  assert.deepEqual(sent().length, 3);                             // close echo still pending
  w.terminate();                                                  // dropped: echo never sent (as upstream)
  assert.deepEqual(sent().length, 3);
  const b = fakeWs([srvFrame(ws.OP.PING, 'x'), srvFrame(ws.OP.CLOSE, ws.closePayload(4000, 'r'))]);
  await b.w.next(0);
  await b.w.next(0);                                              // flushes pong, then the close replaces nothing
  assert.equal(b.sock.written.length, 1);
  assert.equal(await b.w.next(0), ws.TIMEOUT);                    // flushes the close echo
  const d = new ws.FrameDecoder(); d.push(b.sock.written[1]);
  assert.deepEqual(ws.parseClose(d.next().payload), { code: 4000, reason: 'r' });
});

test('close payloads and allowed close codes', () => {
  assert.deepEqual(ws.parseClose(ws.closePayload(1000, 'bye')), { code: 1000, reason: 'bye' });
  assert.deepEqual(ws.parseClose(Buffer.alloc(0)), { code: undefined, reason: '' });
  assert.throws(() => ws.parseClose(Buffer.from([3])), /Invalid close sequence/);
  for (const c of [1000, 1001, 1003, 1011, 3000, 4999]) assert.ok(ws.closeCodeAllowed(c), String(c));
  for (const c of [999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) assert.ok(!ws.closeCodeAllowed(c), String(c));
});

// A tiny scripted WebSocket server for client/daemon tests.
function wsServer(onConn) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const dec = new ws.FrameDecoder('server');
    const peer = {
      req, socket, frames: [],
      send: (op, data) => socket.write(ws.encodeFrame(op, Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), null)),
      text: (d) => peer.send(ws.OP.TEXT, d),
    };
    socket.on('data', (c) => { dec.push(c); for (let f; (f = dec.next()); ) { peer.frames.push(f); peer.onFrame?.(f); } });
    socket.on('error', () => {});
    onConn(peer);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${server.address().port}/ws/v6/dex`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  })));
}

test('client: text, auto-pong, close echo, clean end, TIMEOUT is non-consuming', async () => {
  let peer;
  const srv = await wsServer((p) => { peer = p; });
  const c = await ws.connect(srv.url);
  assert.equal(peer.req.rawHeaders.filter((_, i) => i % 2 === 0).join(','), 'Host,Connection,Upgrade,Sec-WebSocket-Version,Sec-WebSocket-Key');
  assert.equal(await c.next(30), ws.TIMEOUT);
  c.send('hello');
  await new Promise((r) => { peer.onFrame = r; });
  assert.equal(peer.frames[0].opcode, ws.OP.TEXT);
  assert.equal(peer.frames[0].payload.toString(), 'hello');
  peer.send(ws.OP.PING, 'hb');
  assert.deepEqual(await c.next(1000), { type: 'ping', data: Buffer.from('hb') });
  assert.equal(await c.next(10), ws.TIMEOUT);                    // next read flushes the pong
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peer.frames[1].opcode, ws.OP.PONG);
  assert.equal(peer.frames[1].payload.toString(), 'hb');
  peer.text('{"event":"x"}');
  assert.deepEqual(await c.next(1000), { type: 'text', data: '{"event":"x"}' });
  peer.send(ws.OP.CLOSE, ws.closePayload(1000, 'bye'));
  assert.deepEqual(await c.next(1000), { type: 'close', code: 1000, reason: 'bye' });
  assert.equal(await c.next(10), ws.TIMEOUT);                    // flushes the close echo
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peer.frames[2].opcode, ws.OP.CLOSE);
  assert.deepEqual(ws.parseClose(peer.frames[2].payload), { code: 1000, reason: 'bye' });
  assert.throws(() => c.send('late'), /Sending after closing is not allowed/);
  peer.socket.end();
  assert.equal(await c.next(1000), null);
  assert.equal(await c.next(1000), null);
  c.terminate();
  await srv.close();
});

test('client: TCP end without close handshake is a protocol error', async () => {
  const srv = await wsServer((p) => setTimeout(() => p.socket.end(), 20));
  const c = await ws.connect(srv.url);
  await assert.rejects(c.next(2000), { message: 'WebSocket protocol error: Connection reset without closing handshake' });
  c.terminate();
  await srv.close();
});

test('client: connect errors carry tungstenite "IO error"/"HTTP error" texts', async () => {
  const srv = await wsServer(() => {});
  const port = new URL(srv.url).port;
  await srv.close();
  await assert.rejects(ws.connect(`ws://127.0.0.1:${port}/x`), (e) => e instanceof ws.WsError && /^IO error: /.test(e.message) && /os error/.test(e.message));
  const plain = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  await assert.rejects(ws.connect(`ws://127.0.0.1:${plain.address().port}/x`), { message: 'HTTP error: 404 Not Found' });
  plain.close();
});

// ── watch/types.mjs ─────────────────────────────────────────────────────────

test('channel classification and registry', () => {
  assert.equal(types.channelPattern('address-tracker-activity'), 'PerWallet');
  for (const c of ['price', 'price-info', 'trades', 'dex-token-candle1m', 'dex-token-candle']) assert.equal(types.channelPattern(c), 'PerToken');
  for (const c of ['dex-market-new-signal-openapi', 'dex-market-memepump-new-token-openapi', 'dex-market-memepump-update-metrics-openapi']) assert.equal(types.channelPattern(c), 'PerChain');
  for (const c of ['kol_smartmoney-tracker-activity', 'unknown', '']) assert.equal(types.channelPattern(c), 'Global');
  assert.ok(types.isTrackerChannel('kol_smartmoney-tracker-activity') && types.isTrackerChannel('address-tracker-activity') && !types.isTrackerChannel('price'));
  assert.equal(types.ALL_CHANNELS.length, 9);
  assert.deepEqual(types.DEFAULT_CHANNELS, ['kol_smartmoney-tracker-activity']);
  assert.equal(types.patternName(types.ChannelPattern.PerWallet), 'perwallet');
});

test('DaemonState.fromStatusLine', () => {
  const S = (line, now = 100000) => { const s = types.DaemonState.fromStatusLine(line, now); return s.kind + (s.reason !== undefined ? ':' + s.reason : ''); };
  assert.equal(S('running|90000'), 'running');
  assert.equal(S('running|30000'), 'crashed');                   // > 60 s stale
  assert.equal(S('running|99999999999999'), 'running');           // future → saturating_sub = 0
  assert.equal(S('stopped|0'), 'stopped');                        // terminal, no staleness check
  assert.equal(S('stopped|x|idle_timeout'), 'stopped');
  assert.equal(S('disconnected|95000|error:a|b'), 'disconnected:error:a|b');
  assert.equal(S('disconnected|95000'), 'disconnected:unknown');
  assert.equal(S('reconnecting|95000'), 'reconnecting');
  assert.equal(S('config_corrupt|95000|config_corrupt'), 'crashed');
  assert.equal(S('running'), 'crashed');
  assert.equal(S('running|abc', 50000), 'running');               // ts parse failure → 0
  assert.equal(S('  running|95000\n'), 'running');
});

test('TradeEvent deserialisation (from_value) rules', () => {
  const base = { walletAddress: 'w', quoteTokenSymbol: 'q', quoteTokenAmount: '1', tokenSymbol: 't', tokenContractAddress: 'a', chainIndex: '1', tokenPrice: 'p', marketCap: 'm', realizedPnlUsd: 'r', tradeType: '1', tradeTime: '0' };
  assert.equal(types.tradeEventFromValue(base).trackerType, null);
  assert.deepEqual(types.tradeEventFromValue({ ...base, trackerType: [1, 2] }).trackerType, [1, 2]);
  assert.equal(types.tradeEventFromValue({ ...base, trackerType: [256] }), null);
  assert.equal(types.tradeEventFromValue({ ...base, trackerType: [-1] }), null);
  assert.equal(types.tradeEventFromValue({ ...base, txHash: 5 }), null);
  assert.equal(types.tradeEventFromValue({ ...base, tradeTime: 5 }), null);
  assert.equal(types.tradeEventFromValue({ walletAddress: 'w' }), null);
  assert.equal(types.tradeEventFromValue('str'), null);
  const seq = ['w', 'q', '1', 't', 'a', '1', 'p', 'm', 'r', '1', '0', null, null];
  assert.ok(types.tradeEventFromValue(seq));
  assert.equal(types.tradeEventFromValue(seq.slice(0, 12)), null);
});

test('WatchConfig serialises in struct order and parses back', () => {
  const c = types.watchConfig({ channels: ['price'], tokenPairs: [types.tokenPair('1', '0xa')], env: 'prod', createdAt: 1727500000000, idleTimeoutMs: 0 });
  const text = stringify(c, true);
  assert.equal(text, '{\n  "channels": [\n    "price"\n  ],\n  "wallet_addresses": [],\n  "token_pairs": [\n    {\n      "chain_index": "1",\n      "token_contract_address": "0xa"\n    }\n  ],\n  "chain_indexes": [],\n  "env": "prod",\n  "created_at": 1727500000000,\n  "idle_timeout_ms": 0\n}');
  assert.equal(stringify(types.watchConfigFromStr(text), true), text);
  assert.equal(types.watchConfigFromStr('{"channels":[],"env":"pre","created_at":5}').idle_timeout_ms, 1800000);
});

test('serde_json error texts for corrupt configs (verified against upstream)', () => {
  const E = (s) => { try { types.watchConfigFromStr(s); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(E('{ this is not valid json ]'), 'key must be a string at line 1 column 3');
  assert.equal(E('not json'), 'expected ident at line 1 column 2');
  assert.equal(E(''), 'EOF while parsing a value at line 1 column 0');
  assert.equal(E('{}'), 'missing field `channels` at line 1 column 2');
  assert.equal(E('123'), 'invalid type: integer `123`, expected struct WatchConfig at line 1 column 3');
  assert.equal(E('{"channels":"x"}'), 'invalid type: string "x", expected a sequence at line 1 column 15');
  assert.equal(E('{"channels":["a"],"env":"staging","created_at":1}'), 'unknown variant `staging`, expected `pre` or `prod` at line 1 column 33');
  assert.equal(E('{"channels":["a"],"env":"prod","created_at":-1}'), 'invalid value: integer `-1`, expected u64 at line 1 column 46');
  assert.equal(E('{"channels":["a"],"env":"prod","created_at":1.5}'), 'invalid type: floating point `1.5`, expected u64 at line 1 column 47');
  assert.equal(E('{"channels":["a"],"env":"prod","created_at":1,"channels":[]}'), 'duplicate field `channels` at line 1 column 56');
  assert.equal(E('{"channels":["a"],"env":"prod","created_at":1} x'), 'trailing characters at line 1 column 48');
  assert.equal(E('{"channels":["a",]}'), 'trailing comma at line 1 column 18');
  assert.equal(E('﻿{}'), 'expected value at line 1 column 1');
  assert.equal(E('{"channels":["a"],"env":{"pre":null},"created_at":1}'), 'ok');
});

test('serde Value parsing rejects what serde_json rejects', () => {
  const V = (s) => { try { return stringify(types.valueFromStr(s)); } catch (e) { return 'ERR ' + e.message; } };
  assert.equal(V('{"b":1.50,"a":[1e3,-0.0,18446744073709551615]}'), '{"a":[1000.0,-0.0,18446744073709551615],"b":1.5}');
  assert.match(V('{"f":"a\tb"}'), /^ERR control character/);
  assert.match(V('"\\ud800"'), /^ERR (lone leading surrogate|unexpected end of hex escape)/);
  assert.match(V('1e400'), /^ERR number out of range/);
  assert.equal(V('['.repeat(127) + ']'.repeat(127)).length, 254);
  assert.match(V('['.repeat(128) + ']'.repeat(128)), /^ERR recursion limit exceeded/);
  assert.equal(V('{"__proto__":{"x":1}}'), '{"__proto__":{"x":1}}');
});

// ── watch/store.mjs ─────────────────────────────────────────────────────────

const freshDir = (id) => { const d = store.watchDir(id); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

test('store paths, pid/status/cursor files', () => {
  assert.equal(store.watchDir('ws_x'), join(HOME, 'watch', 'ws_x'));
  const dir = freshDir('ws_files');
  store.writePid(dir, 1234);
  assert.equal(readFileSync(join(dir, 'pid'), 'utf8'), '1234');
  assert.equal(store.readPid('ws_files'), 1234);
  writeFileSync(join(dir, 'pid'), ' +77\n');
  assert.equal(store.readPid('ws_files'), 77);
  store.writeStatus(dir, 'disconnected', 'error:x');
  assert.match(readFileSync(join(dir, 'status'), 'utf8'), /^disconnected\|\d{13}\|error:x$/);
  assert.equal(store.readDaemonState('ws_files').kind, 'disconnected');
  assert.deepEqual(store.readCursor(dir, 'price'), { fileNo: 0, offset: 0 });
  store.writeCursor(dir, 'price', 0, 42);
  assert.equal(readFileSync(join(dir, 'cursor.price'), 'utf8'), '0|42');
  assert.deepEqual(store.readCursor(dir, 'price'), { fileNo: 0, offset: 42 });
  writeFileSync(join(dir, 'cursor.bad'), 'x|y');
  assert.deepEqual(store.readCursor(dir, 'bad'), { fileNo: 0, offset: 0 });
  assert.equal(existsSync(join(dir, '.status.tmp')) || existsSync(join(dir, '.cursor.price.tmp')), false);
});

test('append + read with per-event cursors, partial lines and rotation tail', () => {
  const dir = freshDir('ws_ev');
  store.appendEvents(dir, 'price', [{ b: 1, a: 2 }, { c: 3 }]);
  writeFileSync(join(dir, 'events.price.0.jsonl'), readFileSync(join(dir, 'events.price.0.jsonl'), 'utf8') + '\nnot json\n{"d":4}\n{"partial":');
  assert.equal(readFileSync(join(dir, 'events.price.0.jsonl'), 'utf8').split('\n')[0], '{"a":2,"b":1}');
  let r = store.readEventsFromCursor(dir, 'price', 2);
  assert.deepEqual(r.events, [{ a: 2, b: 1 }, { c: 3 }]);
  assert.deepEqual(r.perEventCursors, [{ fileNo: 0, offset: 14 }, { fileNo: 0, offset: 22 }]);
  store.writeCursor(dir, 'price', r.newCursor.fileNo, r.newCursor.offset);
  r = store.readEventsFromCursor(dir, 'price', 10);
  assert.deepEqual(r.events, [{ d: 4 }]);                          // blank + invalid consumed, partial left
  assert.equal(r.newCursor.offset, 22 + 1 + 9 + 8);
  // rotation: cursor offset beyond the fresh .0 → drain .1 tail first
  const rot = freshDir('ws_rot');
  writeFileSync(join(rot, 'events.price.1.jsonl'), '{"n":1}\n{"n":2}\n{"n":3}\n');
  writeFileSync(join(rot, 'events.price.0.jsonl'), '{"n":4}\n');
  store.writeCursor(rot, 'price', 0, 8 + 8);
  r = store.readEventsFromCursor(rot, 'price', 10);
  assert.deepEqual(r.events, [{ n: 3 }, { n: 4 }]);
  assert.deepEqual(r.perEventCursors, [{ fileNo: 0, offset: 0 }, { fileNo: 0, offset: 8 }]);
  assert.deepEqual(r.newCursor, { fileNo: 0, offset: 8 });
});

test('appendEvents rotates at 32 MiB, keeping at most 3 files', () => {
  const dir = freshDir('ws_big');
  const cur = join(dir, 'events.t.0.jsonl');
  writeFileSync(join(dir, 'events.t.2.jsonl'), 'oldest\n');
  writeFileSync(join(dir, 'events.t.1.jsonl'), 'older\n');
  writeFileSync(cur, '');
  truncateSync(cur, 32 * 1024 * 1024);
  store.appendEvents(dir, 't', [{ x: 1 }]);
  assert.equal(readFileSync(join(dir, 'events.t.0.jsonl'), 'utf8'), '{"x":1}\n');
  assert.equal(readFileSync(join(dir, 'events.t.2.jsonl'), 'utf8'), 'older\n');
  assert.equal(readFileSync(join(dir, 'events.t.1.jsonl')).length, 32 * 1024 * 1024);
  store.appendEvents(dir, 't', []);                               // no-op
});

test('listWatches filters prefixes and sorts; lastPollTime uses cursor mtimes', () => {
  rmSync(store.watchRoot(), { recursive: true, force: true });
  assert.deepEqual(store.listWatches(), []);
  for (const id of ['ws_b', 'watch_a', 'other', 'ws_a']) freshDir(id);
  writeFileSync(join(store.watchDir('ws_a'), 'config.json'), '{"channels":["price"],"env":"pre","created_at":7}');
  writeFileSync(join(store.watchDir('ws_a'), 'pid'), '99');
  const list = store.listWatches();
  assert.deepEqual(list.map((w) => w.id), ['watch_a', 'ws_a', 'ws_b']);
  assert.equal(list[1].pid, 99);
  assert.equal(list[1].config.env, 'pre');
  assert.equal(list[2].config, null);
  assert.equal(list[2].state.kind, 'crashed');
  const d = store.watchDir('ws_a');
  assert.equal(store.lastPollTime(d), null);
  store.writeCursor(d, 'a', 0, 0);
  store.writeCursor(d, 'b', 0, 0);
  utimesSync(join(d, 'cursor.a'), new Date(1000), new Date(5000));
  utimesSync(join(d, 'cursor.b'), new Date(1000), new Date(3000));
  assert.equal(store.lastPollTime(d), 5000);
  store.removeWatchDir('ws_a');
  assert.ok(!existsSync(d));
  store.removeWatchDir('ws_a');
});

// ── watch/daemon.mjs ────────────────────────────────────────────────────────

test('login frame: HMAC-SHA256 sign test vector and sorted keys', () => {
  const c = new daemon.Credentials('test-key', 'test-secret', 'test-pass');
  assert.equal(c.sign('1700000000'), '0uAi5j594sWw9rkXI4knzlNhWDTrHUJBZExNMGGD2gs=');
  assert.equal(c.loginMsg(1700000000), '{"args":[{"apiKey":"test-key","passphrase":"test-pass","sign":"0uAi5j594sWw9rkXI4knzlNhWDTrHUJBZExNMGGD2gs=","timestamp":"1700000000"}],"op":"login"}');
});

test('Credentials.fromWatchEnv reads the env set in order', () => {
  const keep = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^OKX_(PROD|PRE)_/.test(k)) delete process.env[k];
    assert.throws(() => daemon.Credentials.fromWatchEnv('prod'), { message: 'OKX_PROD_API_KEY is not set' });
    process.env.OKX_PROD_API_KEY = '';
    assert.throws(() => daemon.Credentials.fromWatchEnv('prod'), { message: 'OKX_PROD_SECRET_KEY is not set' });
    process.env.OKX_PRE_API_KEY = 'a'; process.env.OKX_PRE_SECRET_KEY = 'b';
    assert.throws(() => daemon.Credentials.fromWatchEnv('pre'), { message: 'OKX_PRE_PASSPHRASE is not set' });
    process.env.OKX_PRE_PASSPHRASE = 'c';
    assert.equal(daemon.Credentials.fromWatchEnv('pre').passphrase, 'c');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('subscribe args per pattern, notice and push parsing', () => {
  const cfg = types.watchConfig({
    channels: ['address-tracker-activity', 'dex-market-new-signal-openapi', 'kol_smartmoney-tracker-activity', 'price'],
    walletAddresses: ['0x1'], tokenPairs: [types.tokenPair('1', '0xa')], chainIndexes: ['1', '501'], env: 'prod', createdAt: 0,
  });
  assert.equal(stringify({ op: 'subscribe', args: daemon.subscribeArgs(cfg) }),
    '{"args":[{"channel":"address-tracker-activity","walletAddress":"0x1"},{"chainIndex":"1","channel":"dex-market-new-signal-openapi"},{"chainIndex":"501","channel":"dex-market-new-signal-openapi"},{"channel":"kol_smartmoney-tracker-activity"},{"chainIndex":"1","channel":"price","tokenContractAddress":"0xa"}],"op":"subscribe"}');
  assert.equal(daemon.checkNotice('{"event":"notice","msg":"x"}'), 'service_upgrade');
  assert.equal(daemon.checkNotice('{"event":"login"}'), null);
  assert.equal(daemon.checkNotice('[1]'), null);
  assert.deepEqual(daemon.parseWsPush('{"arg":{"channel":"price","x":1},"data":[{"a":1}],"extra":true}'), { channel: 'price', data: [{ a: 1 }] });
  assert.deepEqual(daemon.parseWsPush('[["trades"],[]]'), { channel: 'trades', data: [] });
  assert.equal(daemon.parseWsPush('{"arg":{"channel":"price"},"data":{}}'), null);
  assert.equal(daemon.parseWsPush('{"arg":{},"data":[]}'), null);
  assert.equal(daemon.parseWsPush('{"arg":{"channel":"p"},"data":[],"data":[]}'), null);     // duplicate field
  assert.equal(daemon.parseWsPush('pong'), null);
});

test('loadDaemonConfig: read error context, corrupt config marks status', () => {
  const dir = freshDir('ws_cfg');
  assert.throws(() => daemon.loadDaemonConfig(dir), (e) => e.message.startsWith(`failed to read watch config: ${join(dir, 'config.json')}: `));
  writeFileSync(join(dir, 'config.json'), '{ this is not valid json ]');
  assert.throws(() => daemon.loadDaemonConfig(dir), { message: `watch config is corrupt (${join(dir, 'config.json')}): key must be a string at line 1 column 3` });
  assert.match(readFileSync(join(dir, 'status'), 'utf8'), /^config_corrupt\|\d+\|config_corrupt$/);
  writeFileSync(join(dir, 'config.json'), '{"channels":["kol_smartmoney-tracker-activity"],"env":"prod","created_at":0,"idle_timeout_ms":60000}');
  rmSync(join(dir, 'status'));
  assert.equal(daemon.loadDaemonConfig(dir).idle_timeout_ms, 60000);
  assert.ok(!existsSync(join(dir, 'status')));
});

test('connectAndStream: login, subscribe acks, pushes, ping/pong, idle timeout', async () => {
  const saved = { ...daemon.TIMING };
  Object.assign(daemon.TIMING, { heartbeatMs: 150, pongTimeoutMs: 500, ackTimeoutMs: 1000 });
  const dir = freshDir('ws_stream');
  const seen = [];
  const srv = await wsServer((peer) => {
    peer.onFrame = (f) => {
      const t = f.payload.toString();
      seen.push(t);
      if (t.includes('"op":"login"')) peer.text({ event: 'login', code: '0', msg: '' });
      else if (t.includes('"op":"subscribe"')) {
        const args = JSON.parse(t).args;
        for (const arg of args) peer.text({ event: 'subscribe', arg });
        peer.text({ arg: { channel: 'price' }, data: [{ p: '1', a: 1.5 }] });
      } else if (t === 'ping') {
        peer.text({ arg: { channel: 'price' }, data: [{ p: '2' }] });   // push while waiting for pong
        peer.text('pong');
      }
    };
  });
  const cfg = types.watchConfig({ channels: ['price'], tokenPairs: [types.tokenPair('1', '0xa')], env: 'prod', createdAt: 0 });
  const state = { idleExpired: false };
  setTimeout(() => { state.idleExpired = true; }, 250);
  const reason = await daemon.connectAndStream(dir, srv.url, new daemon.Credentials('k', 's', 'p'), cfg, state);
  assert.equal(reason, 'idle_timeout');
  assert.match(seen[0], /^\{"args":\[\{"apiKey":"k","passphrase":"p","sign":"[^"]+","timestamp":"\d+"\}\],"op":"login"\}$/);
  assert.equal(seen[1], '{"args":[{"chainIndex":"1","channel":"price","tokenContractAddress":"0xa"}],"op":"subscribe"}');
  assert.equal(seen[2], 'ping');
  assert.equal(readFileSync(join(dir, 'events.price.0.jsonl'), 'utf8'), '{"a":1.5,"p":"1"}\n{"p":"2"}\n');
  assert.match(readFileSync(join(dir, 'status'), 'utf8'), /^running\|\d+$/);
  Object.assign(daemon.TIMING, saved);
  await srv.close();
});

test('connectAndStream error paths', async () => {
  const saved = { ...daemon.TIMING };
  Object.assign(daemon.TIMING, { heartbeatMs: 5000, pongTimeoutMs: 200, ackTimeoutMs: 200 });
  const creds = new daemon.Credentials('k', 's', 'p');
  const cfg = types.watchConfig({ channels: ['kol_smartmoney-tracker-activity'], env: 'prod', createdAt: 0 });
  const run = async (script) => {
    const srv = await wsServer((peer) => { peer.onFrame = (f) => (f.opcode === ws.OP.CLOSE ? peer.socket.end() : script(peer, f.payload.toString(), f)); });
    try { return await daemon.connectAndStream(freshDir('ws_err'), srv.url, creds, cfg, { idleExpired: false }); }
    catch (e) { return 'ERR ' + e.message; }
    finally { await srv.close(); }
  };
  const ok = (p) => p.text({ event: 'login', code: '0' });
  assert.equal(await run((p, t) => { if (t.includes('login')) p.text({ event: 'login', code: '60009', msg: 'Login failed.' }); }), 'ERR login error: Login failed.');
  assert.equal(await run((p, t) => { if (t.includes('login')) p.text({ event: 'login', code: 0 }); }), 'ERR login error: unknown');
  assert.equal(await run((p, t) => { if (t.includes('login')) p.text({ event: 'error', msg: 'Invalid apiKey' }); }), 'ERR login ack timeout');
  assert.equal(await run((p, t) => { if (t.includes('login')) p.send(ws.OP.CLOSE, ws.closePayload(1000)); }), 'ERR connection closed during login');
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); else p.text({ event: 'error', msg: 'bad sub' }); }), 'ERR subscribe error: bad sub');
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); }), 'ERR subscribe ack timeout');
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); else { p.text({ event: 'subscribe' }); p.text({ event: 'notice' }); } }), 'service_upgrade');
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); else if (t.includes('subscribe')) { p.text({ event: 'subscribe' }); p.send(ws.OP.CLOSE, ws.closePayload(1001)); } }), 'ERR server_closed');
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); else if (t.includes('subscribe')) { p.text({ event: 'subscribe' }); p.socket.end(); } }), 'ERR WebSocket protocol error: Connection reset without closing handshake');
  Object.assign(daemon.TIMING, { heartbeatMs: 100 });
  assert.equal(await run((p, t) => { if (t.includes('login')) ok(p); else if (t.includes('subscribe')) p.text({ event: 'subscribe' }); }), 'ERR ping_timeout');
  Object.assign(daemon.TIMING, saved);
});

test('runDaemon: idle-expired session exits after its first connection, status trail', async () => {
  const saved = { ...daemon.TIMING };
  const keep = { ...process.env };
  Object.assign(daemon.TIMING, { reconnectDelayMs: 10 });
  Object.assign(process.env, { OKX_PROD_API_KEY: 'k', OKX_PROD_SECRET_KEY: 's', OKX_PROD_PASSPHRASE: 'p' });
  const dir = freshDir('ws_run');
  writeFileSync(join(dir, 'config.json'), '{"channels":["kol_smartmoney-tracker-activity"],"env":"prod","created_at":0,"idle_timeout_ms":1}');
  // nothing listens at OCL_WS_URL → "IO error: …" → disconnected → idle expired → exit
  await daemon.runDaemon('ws_run', dir);
  assert.match(readFileSync(join(dir, 'status'), 'utf8'), /^disconnected\|\d+\|error:IO error: .*\(os error \d+\)$/);
  assert.equal(readFileSync(join(dir, 'pid'), 'utf8'), String(process.pid));
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
  Object.assign(daemon.TIMING, saved);
});

// ── commands/ws helpers ─────────────────────────────────────────────────────

test('ws helpers: trade type aliases, list parsing, status rendering', () => {
  assert.deepEqual(['all', '0', 'BUY', '1', 'Sell', '2', 'x', 'buy '].map(cmd.resolveTradeType), ['0', '0', '1', '1', '2', '2', 'x', 'buy ']);
  assert.deepEqual(cmd.splitList(' a, ,b ,'), ['a', 'b']);
  assert.deepEqual(cmd.splitList(undefined), []);
  assert.deepEqual(cmd.parseTokenPairs(' 1:0xa ,bad,1:,:0xb,56:x:y').map((t) => [t.chain_index, t.token_contract_address]), [['1', '0xa'], ['56', 'x:y']]);
  assert.equal(cmd.statusStr(types.DaemonState.Disconnected('error:x')), 'disconnected:error:x');
  assert.equal(cmd.statusStr(types.DaemonState.Stopped), 'stopped');
  assert.equal(cmd.parseIdleTimeoutMs('0'), 0);
  assert.equal(cmd.parseIdleTimeoutMs('30m'), 1800000);
  assert.throws(() => cmd.parseIdleTimeoutMs('30x'), { message: "invalid --idle-timeout '30x'; use e.g. 300s, 30m, 24h, 7d" });
});

test('ws poll tracker filter semantics', () => {
  const ev = { walletAddress: '0xab1', quoteTokenSymbol: 'q', quoteTokenAmount: '150', tokenSymbol: 't', tokenContractAddress: 'a', chainIndex: '1', tokenPrice: 'p', marketCap: 'abc', realizedPnlUsd: 'NaN', tradeType: '1', tradeTime: '+1000', trackerType: [2] };
  const m = (f, tag, tt) => cmd.tradeMatches(ev, f, tag, tt);
  assert.ok(m({ minQuoteAmount: 100 }));
  assert.ok(!m({ minQuoteAmount: 151 }));
  assert.ok(!m({ minMarketCap: 1 }));                            // "abc" → 0
  assert.ok(m({ minPnl: 5 }));                                   // NaN comparison keeps
  assert.ok(m({ trader: '0xab' }) && !m({ trader: '0xAB' }));
  assert.ok(m({}, 2) && !m({}, 1));
  assert.ok(m({ since: 1000 }) && !m({ since: 1001n }));
  assert.ok(m({}, undefined, '0') && m({}, undefined, '1') && !m({}, undefined, '2') && !m({}, undefined, 'buy '));
  assert.ok(!cmd.tradeMatches({ walletAddress: 'x' }, {}));
  assert.ok(!m({ minPnl: 0 }) === false);
});

// ── test/parity/ws-proxy.mjs pure helpers ───────────────────────────────────

const wsp = await import('../parity/ws-proxy.mjs');

test('parity: login frames are masked, HMAC validated against the case creds', () => {
  const c = new daemon.Credentials('test-key', 'test-secret', 'test-pass');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(wsp.maskLogin(c.loginMsg(now), ['test-secret']), '{"args":[{"apiKey":"test-key","passphrase":"test-pass","sign":"<valid-hmac>","timestamp":"<unix-secs>"}],"op":"login"}');
  assert.match(wsp.maskLogin(c.loginMsg(now), ['other']), /"sign":"<INVALID-hmac>"/);
  assert.equal(wsp.maskLogin('{"op":"subscribe","args":[]}'), '{"op":"subscribe","args":[]}');
  assert.equal(wsp.maskLogin('ping'), 'ping');
});

test('parity: watch snapshot normalisation', () => {
  const out = wsp.normalizeWatchSnapshot({
    'audit.jsonl': '<present>',
    'watch/ws_a1b2c3/config.json': { channels: ['price'], created_at: 1790000000000 },
    'watch/ws_a1b2c3/status': 'running|1790000000123',
    'watch/ws_a1b2c3/pid': 1234,
    'watch/ws_a1b2c3/daemon.log': 'x',
    'watch/ws_a1b2c3/.status.tmp': '<present>',
    'watch/ws_fixture/status': 'disconnected|1790000000123|error:a|b',
    'watch/ws_fixture/config.json': { created_at: 0 },
  });
  assert.deepEqual(out, {
    'audit.jsonl': '<present>',
    'watch/ws_<random>/config.json': { channels: ['price'], created_at: '<ms>' },
    'watch/ws_<random>/status': 'running|<ms>',
    'watch/ws_<random>/pid': '<pid>',
    'watch/ws_<random>/daemon.log': '<log>',
    'watch/ws_fixture/status': 'disconnected|<ms>|error:a|b',
    'watch/ws_fixture/config.json': { created_at: 0 },
  });
});

test('parity: stdout normalisation (<HOME>, localized OS error text → code)', () => {
  const home = join('C:', 'tmp', 'ocl-parity-up-1');
  const line = JSON.stringify({ ok: false, error: `failed to read watch config: ${join(home, 'watch', 'x', 'config.json')}: 系統找不到指定的檔案。 (os error 2)` });
  assert.equal(wsp.maskHomePath(line, home, { osErrorText: 'code' }), JSON.stringify({ ok: false, error: `failed to read watch config: ${join('<HOME>', 'watch', 'x', 'config.json')}: <os error 2>` }));
  assert.equal(wsp.maskHomePath('{"error":"x (os error 2)"}', home), '{"error":"x (os error 2)"}');
});

test('parity: client transcripts compare handshake + client frames only', () => {
  const s = (frames, host) => ({ path: '/ws/v6/dex', request: { method: 'GET', url: '/ws/v6/dex', rawHeaders: [['Host', host], ['Connection', 'Upgrade'], ['Sec-WebSocket-Key', 'k' + host]] }, frames });
  const up = [s([{ from: 'c', type: 'text', data: 'ping' }, { from: 's', type: 'text', data: 'pong' }, { from: 'c', type: 'end' }], '127.0.0.1:18899')];
  const li = [s([{ from: 'c', type: 'text', data: 'ping' }, { from: 's', type: 'text', data: 'other' }], '127.0.0.1:30000')];
  assert.equal(wsp.compareWs({}, up, li), null);
  li[0].frames.push({ from: 'c', type: 'close', code: 1000, reason: '' });
  assert.equal(wsp.compareWs({}, up, li).kind, 'ws');
  assert.equal(wsp.compareWs({}, undefined, []), null);
});

// ── verifier additions: divergences found against the upstream binary ──────

test('handshake head: httparse / from_httparse / http 1.4 reason texts', () => {
  const head = (l, extra = '') => `${l}\r\nUpgrade: websocket\r\nConnection: Upgrade${extra}`;
  const err = (t) => { try { ws.parseResponseHead(t); return null; } catch (e) { return e.message; } };
  assert.equal(err(head('HTTP/1.0 101 Switching Protocols')), 'WebSocket protocol error: HTTP version must be 1.1 or higher');
  assert.equal(err(head('HTTP/2 101 Switching Protocols')), 'WebSocket protocol error: httparse error: invalid HTTP version');
  assert.equal(err(head('HTTP/1.1 10 X')), 'WebSocket protocol error: httparse error: invalid response status');
  assert.equal(err(head('HTTP/1.1  101 X')), 'WebSocket protocol error: httparse error: invalid response status');
  assert.equal(err(head('HTTP/1.1 099 X')), 'HTTP format error: invalid status code');
  assert.equal(err(head('HTTP/1.1 101 X', '\r\nBad Name: x')), 'WebSocket protocol error: httparse error: invalid header name');
  assert.equal(err(head('HTTP/1.1 101 X', '\r\nX-A: 1'.repeat(123))), 'Space limit exceeded: Too many headers');
  assert.equal(err(head('HTTP/1.1 101', '\r\nX-A: 1'.repeat(122))), null);
  assert.equal(ws.parseResponseHead('HTTP/1.1 101 \r\nUpgrade:  websocket \t').headers.upgrade, 'websocket');
  const ok = { headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-accept': ws.acceptKey('k') } };
  const status = (s) => { try { ws.verifyResponse({ ...ok, status: s }, 'k'); } catch (e) { return e.message; } };
  assert.equal(status(418), "HTTP error: 418 I'm a teapot");                          // node: "I'm a Teapot"
  assert.equal(status(203), 'HTTP error: 203 Non Authoritative Information');         // node: "Non-Authoritative …"
  assert.equal(status(509), 'HTTP error: 509 <unknown status code>');                 // node: "Bandwidth Limit Exceeded"
  assert.equal(status(503), 'HTTP error: 503 Service Unavailable');
});

test('client: after the peer Close, FIN or RST ends the stream cleanly (no EPIPE / IO error)', async () => {
  for (const how of ['fin', 'reset']) {
    let peer;
    const srv = await wsServer((p) => { peer = p; });
    const c = await ws.connect(srv.url);
    await new Promise((r) => setTimeout(r, 20));
    peer.send(ws.OP.CLOSE, ws.closePayload(1000, 'bye'));
    if (how === 'fin') peer.socket.end();
    await new Promise((r) => setTimeout(r, 80));                  // node has auto-ended our side by now
    assert.deepEqual(await c.next(1000), { type: 'close', code: 1000, reason: 'bye' });
    if (how === 'reset') setTimeout(() => peer.socket.resetAndDestroy(), 50);
    assert.equal(await c.next(2000), null, how);                  // the queued close reply is not an error
    assert.equal(await c.next(10), null);
    c.terminate();
    await srv.close();
  }
});

test('client: a send after the peer only sent FIN succeeds; the next read reports the reset', async () => {
  const srv = await wsServer((p) => setTimeout(() => p.socket.end(), 10));
  const c = await ws.connect(srv.url);
  await new Promise((r) => setTimeout(r, 80));
  assert.doesNotThrow(() => c.send('{"op":"login"}'));        // tungstenite: the write succeeds
  await assert.rejects(c.next(1000), { message: 'WebSocket protocol error: Connection reset without closing handshake' });
  assert.equal(await c.next(10), null);
  c.terminate();
  await srv.close();
});

test('store: incomplete last line is still UTF-8 validated (read_line), unless the limit stops first', () => {
  const dir = freshDir('ws_utf8');
  writeFileSync(join(dir, 'events.price.0.jsonl'), Buffer.concat([Buffer.from('{"a":1}\n{"b":"caf'), Buffer.from([0xc3])]));
  assert.throws(() => store.readEventsFromCursor(dir, 'price', 20), { message: 'stream did not contain valid UTF-8' });
  assert.equal(store.readEventsFromCursor(dir, 'price', 1).events.length, 1);
  writeFileSync(join(dir, 'events.price.0.jsonl'), '{"a":1}\n{"b":"café');   // valid partial line: left unread
  assert.deepEqual(store.readEventsFromCursor(dir, 'price', 20).newCursor, { fileNo: 0, offset: 8 });
});

test('store: cursor file_no + 1 wraps at u32::MAX (release build)', () => {
  const dir = freshDir('ws_wrap');
  writeFileSync(join(dir, 'events.price.0.jsonl'), '{"a":1}\n{"b":2}\n');
  writeFileSync(join(dir, 'cursor.price'), '4294967295|8');
  const r = store.readEventsFromCursor(dir, 'price', 20);
  assert.equal(stringify(r.events), '[{"b":2}]');
  assert.deepEqual(r.newCursor, { fileNo: 4294967295, offset: 0 });
});

test('store: remove_dir_all refuses a non-directory; ENOENT under a file is "path not found"', () => {
  mkdirSync(store.watchRoot(), { recursive: true });
  const file = join(store.watchRoot(), 'ws_plainfile');
  writeFileSync(file, 'x');
  const text = process.platform === 'win32' ? 'The directory name is invalid. (os error 267)' : 'Not a directory (os error 20)';
  assert.throws(() => store.removeWatchDir('ws_plainfile'), { message: text });
  assert.ok(existsSync(file));
  if (process.platform === 'win32') {
    assert.throws(() => store.readConfig('ws_plainfile'), { message: 'The system cannot find the path specified. (os error 3)' });
    assert.throws(() => store.readConfig('ws_absent_dir'), { message: 'The system cannot find the path specified. (os error 3)' });
    freshDir('ws_noconf');
    assert.throws(() => store.readConfig('ws_noconf'), { message: 'The system cannot find the file specified. (os error 2)' });
  }
  rmSync(file);
});

test('ws poll: usize limit arithmetic wraps like the release build (limit*4 with filters)', async () => {
  const dir = freshDir('ws_many');
  const T = 'kol_smartmoney-tracker-activity';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ channels: [T], env: 'prod', created_at: 0 }));
  const trade = (i) => JSON.stringify({ walletAddress: 'w', quoteTokenSymbol: 'U', quoteTokenAmount: '1', tokenSymbol: 'P', tokenContractAddress: 'c', chainIndex: '1', tokenPrice: '1', marketCap: '1', realizedPnlUsd: '1', tradeType: '1', tradeTime: String(i), trackerType: [2] });
  writeFileSync(join(dir, `events.${T}.0.jsonl`), Array.from({ length: 8 }, (_, i) => trade(i)).join('\n') + '\n');
  const poll = cmd.default['ws poll'];
  const r = await poll.run({ path: 'ws poll' }, { id: 'ws_many', limit: '4611686018427387905', tag: 'kol' });
  assert.equal(r.new_count, 4);                                  // 4611686018427387905 * 4 mod 2^64 = 4
  rmSync(join(dir, `cursor.${T}`));
  const r2 = await poll.run({ path: 'ws poll' }, { id: 'ws_many', limit: '4611686018427387905' });
  assert.equal(r2.new_count, 8);                                 // no filter: fetch_limit = limit
});

test('daemon: frames with a "constructor" key are still JSON objects', async () => {
  const fake = (frames) => ({ next: async () => frames.shift() ?? null });
  await daemon.waitForLoginAck(fake([{ type: 'text', data: '{"constructor":"x","event":"login","code":"0"}' }]));
  await assert.rejects(daemon.waitForLoginAck(fake([{ type: 'text', data: '{"toString":1,"event":"login","code":"1","msg":"m"}' }])), { message: 'login error: m' });
  await daemon.waitForSubscribeAcks(fake([{ type: 'text', data: '{"constructor":{},"event":"subscribe"}' }]), 1);
  assert.equal(daemon.checkNotice('{"constructor":1,"event":"notice"}'), 'service_upgrade');
  assert.equal(daemon.checkNotice('[{"event":"notice"}]'), null);
});

test('runDaemon: consecutive failures stop at MAX_RECONNECT_ATTEMPTS with max_reconnect_reached', async () => {
  const saved = { ...daemon.TIMING };
  const keep = { ...process.env };
  Object.assign(daemon.TIMING, { reconnectDelayMs: 5, maxReconnectAttempts: 3 });
  Object.assign(process.env, { OKX_PROD_API_KEY: 'k', OKX_PROD_SECRET_KEY: 's', OKX_PROD_PASSPHRASE: 'p' });
  const dir = freshDir('ws_retry');
  writeFileSync(join(dir, 'config.json'), '{"channels":["kol_smartmoney-tracker-activity"],"env":"prod","created_at":0,"idle_timeout_ms":0}');
  await daemon.runDaemon('ws_retry', dir);                      // nothing listens → 3 failed attempts
  assert.match(readFileSync(join(dir, 'status'), 'utf8'), /^stopped\|\d+\|max_reconnect_reached$/);
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
  Object.assign(daemon.TIMING, saved);
});

test('parity: raw-text watch snapshot normalisation masks created_at of new sessions only', () => {
  const out = wsp.normalizeWatchSnapshot({
    'watch/ws_a1b2c3/config.json': '{\n  "channels": [],\n  "created_at": 1790000000000,\n  "idle_timeout_ms": 1\n}',
    'watch/ws_fixture/config.json': '{\n  "created_at": 5\n}',
    'watch/ws_fixture/daemon.log': '[watch daemon] error: x\n',
  });
  assert.deepEqual(out, {
    'watch/ws_<random>/config.json': '{\n  "channels": [],\n  "created_at": <ms>,\n  "idle_timeout_ms": 1\n}',
    'watch/ws_fixture/config.json': '{\n  "created_at": 5\n}',
    'watch/ws_fixture/daemon.log': '[watch daemon] error: x\n',
  });
});
