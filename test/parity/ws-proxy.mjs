// WebSocket side of the parity proxy (attached to proxy.mjs's HTTP server 'upgrade' event).
//
//   record + network "real" (no wsFixtures): each upstream connection to
//        ws://127.0.0.1:18899/ws/v6/dex is bridged to the real read-only DEX market stream
//        (WS_URL from lib/config.mjs); frames are relayed both ways and recorded. Any other
//        path (e.g. the agent identity push /ws/v5/private) is never bridged — it needs
//        wsFixtures (safety: only the public market stream is forwarded).
//   record + wsFixtures: a scripted server answers (login/subscribe acks, pushes, close).
//   replay: lite's k-th connection is answered from the k-th recorded session — server
//        frames recorded before the first client frame are sent on connect, and after
//        each client frame lite sends, the server frames that followed the corresponding
//        upstream client frame are sent.
// Every session records the handshake request and every frame ({from:'c'|'s', type, …}),
// so run.mjs can diff lite's client frames against upstream's (compareWs).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect, FrameDecoder, encodeFrame, OP, parseClose, closePayload, TIMEOUT } from '../../skill/onchainos-lite/lib/core/ws.mjs';
import { WS_URL } from '../../skill/onchainos-lite/lib/config.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REAL = { [new URL(WS_URL).pathname]: WS_URL };   // read-only market data only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (buf) => Buffer.from(buf).toString('base64');
function frameToRecord(opcode, payload) {
  switch (opcode) {
    case OP.TEXT: return { type: 'text', data: payload.toString('utf8') };
    case OP.BINARY: return { type: 'binary', b64: b64(payload) };
    case OP.PING: return { type: 'ping', b64: b64(payload) };
    case OP.PONG: return { type: 'pong', b64: b64(payload) };
    case OP.CLOSE: { try { const { code, reason } = parseClose(payload); return { type: 'close', code: code ?? null, reason }; } catch { return { type: 'close', raw: b64(payload) }; } }
    default: return { type: `op${opcode}`, b64: b64(payload) };
  }
}
// A raw server frame from a fixture ({type:'frame', op, b64, fin?, rsv?, mask?}): exercises
// the client's frame checks (reserved bits, masked server frames, fragments, bad UTF-8).
function rawFrame(r) {
  const buf = encodeFrame(r.op, Buffer.from(r.b64 || '', 'base64'), r.mask ? randomBytes(4) : null, r.fin !== false);
  buf[0] |= (r.rsv || 0) << 4;
  return buf;
}
function recordToFrame(r) {
  switch (r.type) {
    case 'text': return [OP.TEXT, Buffer.from(r.data, 'utf8')];
    case 'binary': return [OP.BINARY, Buffer.from(r.b64, 'base64')];
    case 'ping': return [OP.PING, Buffer.from(r.b64 || '', 'base64')];
    case 'pong': return [OP.PONG, Buffer.from(r.b64 || '', 'base64')];
    case 'close': return [OP.CLOSE, r.raw ? Buffer.from(r.raw, 'base64') : closePayload(r.code ?? undefined, r.reason || '')];
    default: return null;
  }
}

// Server end of one upgraded connection. Client frames are unmasked, recorded and handed
// to onMessage; send() writes unmasked server frames and records them.
class ServerConn {
  constructor(socket, head, session, onMessage, onEnd) {
    Object.assign(this, { socket, session, onMessage, onEnd, ended: false, decoder: new FrameDecoder('server'), frag: null });
    socket.on('data', (c) => this._data(c));
    socket.on('end', () => this._end('c'));
    socket.on('close', () => this._end('c'));
    socket.on('error', () => this._end('c'));
    if (head && head.length) this._data(head);
  }
  _data(chunk) {
    this.decoder.push(chunk);
    try {
      for (let f; (f = this.decoder.next()); ) {
        if (f.opcode === OP.CONT || (!f.fin && f.opcode < 8)) {       // reassemble fragmented data
          if (!this.frag) this.frag = { opcode: f.opcode, parts: [] };
          this.frag.parts.push(f.payload);
          if (!f.fin) continue;
          f = { opcode: this.frag.opcode, payload: Buffer.concat(this.frag.parts) };
          this.frag = null;
        }
        const rec = { from: 'c', ...frameToRecord(f.opcode, f.payload) };
        this.session.frames.push(rec);
        this.onMessage(rec);
      }
    } catch (e) {
      this.session.frames.push({ from: 'c', type: 'protocol-error', data: e.message });
      this.socket.destroy();
    }
  }
  send(rec) {
    if (this.ended) return;
    if (rec.type === 'end') return this.end();
    if (rec.type === 'reset') return this.reset();
    if (rec.type === 'frame') {
      this.session.frames.push({ from: 's', ...rec });
      this.socket.write(rawFrame(rec));
      return;
    }
    const fr = recordToFrame(rec);
    if (!fr) return;
    this.session.frames.push({ from: 's', ...rec });
    this.socket.write(encodeFrame(fr[0], fr[1], null));
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.session.frames.push({ from: 's', type: 'end' });
    this.socket.destroy();
    this.onEnd?.();
  }
  // Abortive close (TCP RST).
  reset() {
    if (this.ended) return;
    this.ended = true;
    this.session.frames.push({ from: 's', type: 'reset' });
    if (typeof this.socket.resetAndDestroy === 'function') this.socket.resetAndDestroy(); else this.socket.destroy();
    this.onEnd?.();
  }
  _end(from) {
    if (this.ended) return;
    this.ended = true;
    this.session.frames.push({ from, type: 'end' });
    this.onEnd?.();
  }
}

// Scripted server from a fixture: { sessions: [{ onConnect?: [...], rules: [{ on, send, then?, delayMs? }] }] }
//   on   : "login" | "subscribe" | "ping" | "*" | { …subset of the client JSON frame }
//   send : items — object → JSON text, string → text verbatim, "$acks" → one
//          {"event":"subscribe","arg":<arg>,"connId":…} per subscribe arg,
//          {"$close":code,"reason":…}, {"$ping":"text"}, "$end" (FIN), "$reset" (RST),
//          {"$frame":{op, b64?|text?, fin?, rsv?, mask?}} (raw frame)
//   then : "close" (close 1000, end after the client's reply) | "end" (drop TCP)
// A session may instead carry "handshake": "<raw HTTP response>" — written in place of the
// 101 answer (then the connection ends): exercises the client's handshake checks.
function fixtureScript(fixture, index) {
  const sessions = fixture.sessions || [];
  const spec = sessions[Math.min(index, sessions.length - 1)] || { rules: [] };
  const connId = spec.connId || 'a1b2c3d4';
  const expand = (items, clientJson) => (items || []).flatMap((it) => {
    if (it === '$acks') return (clientJson?.args || []).map((arg) => ({ type: 'text', data: JSON.stringify({ event: 'subscribe', arg, connId }) }));
    if (it === '$end') return [{ type: 'end' }];
    if (it === '$reset') return [{ type: 'reset' }];
    if (it && it.$frame) {
      const f = it.$frame;
      return [{ type: 'frame', op: f.op, b64: f.b64 ?? Buffer.from(f.text ?? '', 'utf8').toString('base64'), fin: f.fin !== false, rsv: f.rsv || 0, mask: !!f.mask }];
    }
    if (typeof it === 'string') return [{ type: 'text', data: it }];
    if (it && it.$close !== undefined) return [{ type: 'close', code: it.$close, reason: it.reason || '' }];
    if (it && it.$ping !== undefined) return [{ type: 'ping', b64: b64(Buffer.from(String(it.$ping))) }];
    return [{ type: 'text', data: JSON.stringify(it) }];
  });
  const matches = (on, rec, json) => {
    if (on === '*') return true;
    if (rec.type !== 'text') return false;
    if (on === 'ping') return rec.data.trim() === 'ping';
    if (on === 'login' || on === 'subscribe') return json?.op === on;
    if (on && typeof on === 'object') return json && subset(on, json);
    return false;
  };
  const used = new Set();
  // a Close the server sent itself is not echoed again when the client replies to it
  const sendItem = (conn, r) => { if (r.type === 'close') conn.closing = true; conn.send(r); };
  return {
    handshake: spec.handshake,
    onConnect: (conn) => expand(spec.onConnect).forEach((r) => sendItem(conn, r)),
    async onClient(conn, rec) {
      if (rec.type === 'close') {
        if (!conn.closing) conn.send({ type: 'close', code: rec.code ?? undefined, reason: rec.reason || '' });
        return conn.end();
      }
      if (conn.closing) return;
      let json;
      if (rec.type === 'text') { try { json = JSON.parse(rec.data); } catch {} }
      const idx = (spec.rules || []).findIndex((r, i) => (!r.once || !used.has(i)) && matches(r.on, rec, json));
      if (idx < 0) return;
      used.add(idx);
      const rule = spec.rules[idx];
      if (rule.delayMs) await sleep(rule.delayMs);
      for (const r of expand(rule.send, json)) sendItem(conn, r);
      if (rule.then === 'end') conn.end();
      else if (rule.then === 'close') { conn.closing = true; conn.send({ type: 'close', code: 1000, reason: '' }); setTimeout(() => conn.end(), 2000); }
    },
  };
}
function subset(want, have) {
  if (want && typeof want === 'object') return have && typeof have === 'object' && Object.entries(want).every(([k, v]) => subset(v, have[k]));
  return want === have;
}

// Replay script: the k-th recorded session, anchored on client frames.
function replayScript(recorded) {
  const frames = recorded?.frames || [];
  let p = 0;
  const flush = (conn) => {
    while (p < frames.length && frames[p].from === 's') {
      const r = frames[p++];
      if (r.type === 'end') return conn.end();
      conn.send(r);
    }
  };
  return {
    handshake: recorded?.response,
    onConnect: flush,
    onClient(conn, rec) {
      if (rec.type === 'end') return;
      while (p < frames.length && frames[p].from === 'c' && frames[p].type === 'end') p++;
      if (!(p < frames.length && frames[p].from === 'c')) return;   // upstream sent no more frames
      p++;
      flush(conn);
    },
  };
}

// Bridge to the real endpoint (record, network real).
async function bridge(conn, url, session) {
  let up;
  try { up = await connect(url, { timeoutMs: 30000 }); } catch (e) {
    session.upstreamError = e.message;
    return conn.end();
  }
  conn.upstream = up;
  for (const rec of conn.pending || []) relay(up, rec);
  conn.pending = null;
  (async () => {
    for (;;) {
      let m;
      try { m = await up.next(); } catch (e) { session.upstreamError = e.message; break; }
      if (m === null || m === TIMEOUT) break;
      if (m.type === 'text') conn.send({ type: 'text', data: m.data });
      else if (m.type === 'binary') conn.send({ type: 'binary', b64: b64(m.data) });
      else if (m.type === 'ping') conn.send({ type: 'ping', b64: b64(m.data) });
      else if (m.type === 'pong') conn.send({ type: 'pong', b64: b64(m.data) });
      else if (m.type === 'close') conn.send({ type: 'close', code: m.code ?? undefined, reason: m.reason });
    }
    conn.end();
  })();
}
function relay(up, rec) {
  try {
    if (rec.type === 'text') up.send(rec.data);
    else if (rec.type === 'binary') up.sendBinary(Buffer.from(rec.b64, 'base64'));
    else if (rec.type === 'ping') up.ping(Buffer.from(rec.b64, 'base64'));
    else if (rec.type === 'pong') up.pong(Buffer.from(rec.b64, 'base64'));
    else if (rec.type === 'close') up.close(rec.code ?? 1000, rec.reason || '');
    else if (rec.type === 'end') up.terminate();
  } catch {}
}

// mode: 'record' | 'replay'; cassette: { ws?: [...] }; network: 'real' | 'fixture';
// fixture: parsed ws fixture ({ sessions }) or null.
export function attachWs(server, { mode, cassette, network = 'real', fixture = null } = {}) {
  const sessions = [];
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const u = new URL(req.url, 'http://x');
    const session = { path: u.pathname, request: { method: req.method, url: req.url, rawHeaders: pairs(req.rawHeaders) }, frames: [] };
    const index = sessions.push(session) - 1;
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      session.rejected = true;
      return;
    }
    let script = null;
    if (mode === 'replay') script = replayScript(cassette?.ws?.[index]);
    else if (fixture || network === 'fixture') script = fixtureScript(fixture || { sessions: [] }, index);
    if (script?.handshake !== undefined) {           // scripted (non-101 / malformed) handshake answer
      session.response = script.handshake;
      socket.end(script.handshake);
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const conn = new ServerConn(socket, null, session, (rec) => {
      if (script) Promise.resolve(script.onClient(conn, rec)).catch(() => {});
      else if (conn.upstream) relay(conn.upstream, rec);
      else (conn.pending ||= []).push(rec);
    }, () => { if (conn.upstream) conn.upstream.terminate(); });
    if (script) script.onConnect(conn);
    else {
      const real = REAL[u.pathname];
      if (!real) { session.upstreamError = `no real endpoint for ${u.pathname}`; conn.end(); }
      else bridge(conn, real + u.search, session);
    }
    if (head && head.length) conn._data(head);
  });
  return {
    sessions,
    clientFrames: () => sessions.reduce((n, s) => n + s.frames.filter((f) => f.from === 'c' && f.type !== 'end').length, 0),
    closeAll() { for (const s of sockets) s.destroy(); },
  };
}
const pairs = (raw) => { const out = []; for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]); return out; };

export function loadWsFixture(dir, names = []) {
  const list = [].concat(names || []);
  if (!list.length) return null;
  const merged = { sessions: [] };
  for (const n of list) {
    const f = JSON.parse(readFileSync(join(dir, n.endsWith('.json') ? n : n + '.json'), 'utf8'));
    merged.sessions.push(...(f.sessions || []));
  }
  return merged;
}

// ── comparison ──────────────────────────────────────────────────────────────

// Client-side view of a session: handshake header lines (Host / key masked) and the
// frames the client sent (login sign/timestamp masked; sign checked against case creds).
export function clientTranscript(session, env = {}) {
  const secrets = ['OKX_PROD_SECRET_KEY', 'OKX_PRE_SECRET_KEY'].map((k) => env[k]).filter((v) => v !== undefined);
  const handshake = [`${session.request?.method} ${session.request?.url}`,
    ...(session.request?.rawHeaders || []).map(([k, v]) => `${k}: ${/^(host|sec-websocket-key)$/i.test(k) ? '<masked>' : v}`)];
  const frames = session.frames.filter((f) => f.from === 'c' && f.type !== 'end').map((f) => {
    if (f.type !== 'text') return f;
    return { type: 'text', data: maskLogin(f.data, secrets) };
  });
  return { path: session.path, handshake, frames };
}
export function maskLogin(text, secrets = []) {
  let v;
  try { v = JSON.parse(text); } catch { return text; }
  if (!v || v.op !== 'login' || !Array.isArray(v.args)) return text;
  return text.replace(/"sign":"([^"]*)"/g, (m, sign) => {
    const a = v.args.find((x) => x && x.sign === sign);
    const ok = a && secrets.some((s) => createHmac('sha256', s).update(`${a.timestamp}GET/users/self/verify`).digest('base64') === sign);
    return `"sign":"${ok ? '<valid-hmac>' : '<INVALID-hmac>'}"`;
  }).replace(/"timestamp":"(\d+)"/g, (m, ts) => `"timestamp":"${Math.abs(Number(ts) - Date.now() / 1000) < 7 * 86400 ? '<unix-secs>' : ts}"`);
}
export function compareWs(c, upstreamSessions = [], liteSessions = []) {
  const up = upstreamSessions.map((s) => clientTranscript(s, c.env));
  const li = liteSessions.map((s) => clientTranscript(s, c.env));
  if (JSON.stringify(up) === JSON.stringify(li)) return null;
  return { kind: 'ws', upstream: up, lite: li };
}

// ── daemons and state-dir normalisation ─────────────────────────────────────

function imageOf(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = /^"([^"]+)","(\d+)"/m.exec(out);
      return m && Number(m[2]) === pid ? m[1] : null;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Kill daemons that this case's run spawned: pid files under <home>/watch/*/pid that the
// template home did not already contain, and only when the pid is an onchainos/node process.
export async function killSpawnedDaemons(home, template) {
  const root = join(home, 'watch');
  if (!existsSync(root)) return [];
  const killed = [];
  for (const id of readdirSync(root)) {
    const pidFile = join(root, id, 'pid');
    if (!existsSync(pidFile)) continue;
    const text = readFileSync(pidFile, 'utf8').trim();
    const tpl = template && join(template, 'watch', id, 'pid');
    if (tpl && existsSync(tpl) && readFileSync(tpl, 'utf8').trim() === text) continue;
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const image = imageOf(pid);
    if (!image || !/onchainos|node/i.test(image)) continue;
    try { process.kill(pid); } catch {}
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    killed.push(pid);
  }
  return killed;
}

// After a case: wait for the expected WebSocket traffic (daemons spawned by `ws start`),
// let it settle, then stop the daemon the case spawned so the state dir can be compared
// and removed. Case options: ws: { daemon: true, waitFrames, waitMs, settleMs }.
export async function wsSettle(c, proxy, home, template) {
  const o = c.ws || {};
  if (o.waitFrames) {
    const until = Date.now() + (o.waitMs ?? 20000);
    while (proxy.ws.clientFrames() < o.waitFrames && Date.now() < until) await sleep(100);
  }
  if (o.settleMs) await sleep(o.settleMs);
  return o.daemon ? killSpawnedDaemons(home, template) : [];
}

// State-dir snapshot normalisation for watch sessions: random ws_<6 hex> ids, pids,
// status timestamps, created_at of new sessions and daemon.log text are volatile.
// c.osErrorText === "code": localized OS messages inside status reasons compare by code only.
export function normalizeWatchSnapshot(snap, c = {}) {
  const out = {};
  for (const [rel, v] of Object.entries(snap)) {
    const m = /^watch\/([^/]+)\/(.+)$/.exec(rel);
    if (!m) { out[rel] = v; continue; }
    const random = /^ws_[0-9a-f]{6}$/.test(m[1]);
    const id = random ? 'ws_<random>' : m[1];
    const file = m[2];
    // upstream races its heartbeat task's first status write against the main task's on
    // the same ".status.tmp" (e.g. the credentials-error path) and can leave the tmp behind
    if (file === '.status.tmp') continue;
    // watch/ files are snapshotted as raw text (run.mjs) so number formatting, key order and
    // pretty-printing are compared byte for byte.
    let val = v;
    if (file === 'pid') val = '<pid>';
    else if (file === 'daemon.log') val = random ? '<log>' : v;
    else if (file === 'status' && typeof v !== 'object') {
      val = String(v).replace(/^([^|]*)\|\d+/, '$1|<ms>');
      if (c.osErrorText === 'code') val = val.replace(/: [^:|]*? \(os error (\d+)\)$/, ': <os error $1>');
    }
    else if (file === 'config.json' && random && typeof v === 'string') val = v.replace(/("created_at": )\d+/, '$1<ms>');
    else if (file === 'config.json' && random && v && typeof v === 'object') val = { ...v, created_at: '<ms>' };
    out[`watch/${id}/${file}`] = val;
  }
  return out;
}


// stdout normalisation before comparison:
//  - the per-run state dir differs between the two CLIs → "<HOME>" (raw and JSON-escaped
//    forms), e.g. `ws start` "dir", "watch config is corrupt (<path>)";
//  - case option "osErrorText": "code" → "<os message> (os error N)" becomes "<os error N>":
//    Rust renders Windows OS errors with FormatMessageW in the user's locale (e.g. zh-TW
//    "系統找不到指定的檔案。"), which Node cannot reproduce; the error code is still compared.
export function maskHomePath(text, home, c = {}) {
  let out = text;
  if (home) {
    const escaped = JSON.stringify(home).slice(1, -1);
    out = out.split(escaped).join('<HOME>').split(home).join('<HOME>');
  }
  if (c.osErrorText === 'code') out = out.replace(/(?<=: |")[^":]*? \(os error (\d+)\)/g, '<os error $1>');
  // `ws start` cases: the random session id (ws_<6 hex>) also appears inside "dir".
  if (c.ws?.daemon) out = out.replace(/\bws_[0-9a-f]{6}\b/g, 'ws_<random>');
  return out;
}
