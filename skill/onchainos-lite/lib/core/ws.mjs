// RFC 6455 WebSocket client — the part of tokio-tungstenite 0.26 `connect_async(url)` that
// upstream uses (watch daemon, agent identity push): plain client handshake (no extensions,
// no subprotocols), masked client frames, queued pong / close replies, the same limits and
// the same error texts (tungstenite `Error` Display) so daemon status reasons match.
//
// Transport: wss:// → core/transport.mjs connectTls (bundled + system CA store,
// HTTPS_PROXY CONNECT tunnelling — the built-in WebSocket cannot take a custom CA, which
// is what a TLS-inspecting sandbox such as Muse needs); ws:// → plain TCP (local/dev only).
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { connectTls } from './transport.mjs';
import { HTTP_TIMEOUT_MS } from '../config.mjs';
import { socketErrorText, dnsErrorText } from './rs/fs.mjs';

export const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
export const TIMEOUT = Symbol('ws.timeout');                 // next(ms) elapsed without a message
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 << 20;                                  // tungstenite WebSocketConfig defaults
const MAX_MESSAGE = 64 << 20;
const MAX_HEADERS = 124;                                     // handshake/headers.rs
const MAX_HANDSHAKE_BYTES = 65536;                           // handshake/machine.rs AttackCheck

// http 1.4 StatusCode::canonical_reason (differs from node's STATUS_CODES: 203, 418, 509, …).
const REASONS = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created',
  202: 'Accepted', 203: 'Non Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently',
  302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: "I'm a teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency',
  425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected',
  510: 'Not Extended', 511: 'Network Authentication Required',
};
// http::StatusCode Display: "<code> <canonical reason | <unknown status code>>"
export const statusText = (code) => `${code} ${REASONS[code] ?? '<unknown status code>'}`;

// Error whose message is tungstenite's `Error` Display text.
export class WsError extends Error {}
const protocol = (m) => new WsError(`WebSocket protocol error: ${m}`);

export const generateKey = () => randomBytes(16).toString('base64');
export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

// http::Uri pieces tungstenite uses: Host = authority without userinfo (port kept exactly as
// written), request target = path-and-query as written.
export function parseWsUrl(url) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)/.exec(String(url));
  if (!m) throw new WsError('URL error: No host name in the URL');
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (!host) throw new WsError('URL error: URL contains empty host name');
  let target = m[3] || '/';
  if (target.startsWith('?')) target = '/' + target;
  const hm = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(host);
  const hostname = hm ? hm[1].replace(/^\[|\]$/g, '') : host;
  const defPort = scheme === 'wss' ? 443 : scheme === 'ws' ? 80 : undefined;
  const port = hm && hm[2] ? Number(hm[2]) : defPort;
  if (port === undefined) throw new WsError('URL error: URL scheme not supported');
  return { scheme, host, hostname, port, target };
}

// tungstenite handshake::client::generate_request: fixed header order, CRLF, blank line.
export function handshakeRequest(target, host, key) {
  return `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
}

// Parse the raw response head ("HTTP/1.1 101 …\r\nk: v\r\n…") → { status, headers } the way
// tungstenite does: httparse (HTTP/1.0 or 1.1 only, 3-digit code, token header names,
// ≤ 124 headers) → Response::from_httparse (version ≥ 1.1, StatusCode::from_u16 ≥ 100).
const httparseError = (m) => protocol(`httparse error: ${m}`);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CTL = /[\x00-\x08\x0a-\x1f\x7f]/;
export function parseResponseHead(text) {
  const lines = text.split('\r\n');
  const vm = /^HTTP\/1\.([01])/.exec(lines[0] || '');
  if (!vm) throw httparseError('invalid HTTP version');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!m || CTL.test(m[2] ?? '')) throw httparseError('invalid response status');
  const headers = {};
  let count = 0;
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const i = l.indexOf(':');
    if (i <= 0 || !TOKEN.test(l.slice(0, i))) throw httparseError('invalid header name');
    const v = l.slice(i + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (CTL.test(v)) throw httparseError('invalid header value');
    if (++count > MAX_HEADERS) throw new WsError('Space limit exceeded: Too many headers');
    const k = l.slice(0, i).toLowerCase();
    if (!(k in headers)) headers[k] = v;
  }
  if (vm[1] === '0') throw protocol('HTTP version must be 1.1 or higher');
  const status = Number(m[1]);
  if (status < 100) throw new WsError('HTTP format error: invalid status code');
  return { status, version: `1.${vm[1]}`, headers };
}

// handshake::client::VerifyData::verify_response (RFC 6455 §4.1 client checks).
export function verifyResponse({ status, headers }, key) {
  if (status !== 101) throw new WsError(`HTTP error: ${statusText(status)}`);
  if ((headers.upgrade ?? '').toLowerCase() !== 'websocket') throw protocol('No "Upgrade: websocket" header');
  if ((headers.connection ?? '').toLowerCase() !== 'upgrade') throw protocol('No "Connection: upgrade" header');
  if (headers['sec-websocket-accept'] !== acceptKey(key)) throw protocol('Key mismatch in "Sec-WebSocket-Accept" header');
  if (headers['sec-websocket-protocol'] !== undefined) throw protocol('SubProtocol error: Server sent a subprotocol but none was requested');
}

// One frame. Client frames carry a 4-byte mask key; server frames pass maskKey = null.
export function encodeFrame(opcode, payload = Buffer.alloc(0), maskKey = randomBytes(4), fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (maskKey ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = (maskKey ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!maskKey) return Buffer.concat([head, data]);
  maskKey.copy(head, 2 + ext);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([head, body]);
}

// Close payload: 2-byte code + UTF-8 reason (none → empty payload).
export const closePayload = (code, reason = '') => {
  if (code === undefined || code === null) return Buffer.alloc(0);
  const r = Buffer.from(reason, 'utf8');
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code, 0);
  r.copy(b, 2);
  return b;
};

// tungstenite CloseCode::is_allowed
export const closeCodeAllowed = (c) => !((c >= 0 && c <= 999) || c === 1004 || c === 1005 || c === 1006 || c === 1015 || (c >= 1016 && c <= 2999) || c >= 5000);

// Incremental frame decoder (FrameCodec::read_frame): yields raw frames
// { fin, rsv, opcode, masked, payload }. Only the frame-size limit is enforced here; the
// per-frame protocol checks run when the frame is consumed (WebSocket#_frame).
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }
  next() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80), rsv = b[0] & 0x70, opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) throw new WsError(`Space limit exceeded: Message too long: ${big} > ${MAX_FRAME}`);
      len = Number(big); off = 10;
    }
    if (len > MAX_FRAME) throw new WsError(`Space limit exceeded: Message too long: ${len} > ${MAX_FRAME}`);
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return null;
    const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
    if (masked) { const k = b.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i & 3]; }
    this.buf = b.subarray(need);
    return { fin, rsv, opcode, masked, payload };
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });   // keep a BOM, like Rust
export function decodeText(buf) {
  try { return utf8.decode(buf); } catch { throw new WsError('UTF-8 encoding error'); }
}

// Parse a close payload → { code, reason } (empty payload → code undefined).
export function parseClose(payload) {
  if (payload.length === 0) return { code: undefined, reason: '' };
  if (payload.length === 1) throw protocol('Invalid close sequence');
  return { code: payload.readUInt16BE(0), reason: decodeText(payload.subarray(2)) };
}

// Rust std::io::Error Display for socket errors (what tungstenite wraps as "IO error: …").
export function ioErrorText(e) {
  const t = socketErrorText(e?.code);
  if (t) return t;
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return dnsErrorText(e.code);
  return e?.message ?? String(e);
}

// Map a connect-phase failure to tungstenite's Display text.
function connectError(e) {
  if (e instanceof WsError) return e;
  if (e && typeof e.code === 'string' && /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO)/.test(e.code)) return new WsError(`TLS error: ${e.message}`);
  if (e && /proxy/i.test(e.message || '')) return new WsError(`IO error: ${e.message}`);
  return new WsError(`IO error: ${ioErrorText(e)}`);
}

function tcpConnect(hostname, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: hostname, port });
    const onErr = (e) => { s.destroy(); reject(e); };
    s.once('error', onErr);
    s.setTimeout(timeoutMs, () => s.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })));
    s.once('connect', () => { s.removeListener('error', onErr); resolve(s); });
  });
}

// Read the HTTP response head; returns { head, rest } where rest are bytes after "\r\n\r\n".
function readHead(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err, val) => {
      clearTimeout(timer);
      socket.removeListener('data', onData); socket.removeListener('error', onErr);
      socket.removeListener('end', onEnd); socket.removeListener('close', onEnd);
      if (err) { socket.destroy(); reject(err); } else resolve(val);
    };
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) { socket.pause(); done(null, { head: buf.subarray(0, i).toString('latin1'), rest: buf.subarray(i + 4) }); }
      else if (buf.length > MAX_HANDSHAKE_BYTES) done(new WsError('Attack attempt detected'));
    };
    const onErr = (e) => done(new WsError(`IO error: ${ioErrorText(e)}`));
    const onEnd = () => done(protocol('Handshake not finished'));
    const timer = setTimeout(() => done(new WsError(`IO error: ${ioErrorText({ code: 'ETIMEDOUT' })}`)), timeoutMs);
    socket.on('data', onData); socket.on('error', onErr); socket.on('end', onEnd); socket.on('close', onEnd);
  });
}

// connect_async(url): TCP/TLS connect + client handshake → open WebSocket.
export async function connect(url, { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const u = parseWsUrl(url);
  if (u.scheme !== 'ws' && u.scheme !== 'wss') throw new WsError('URL error: URL scheme not supported');
  let socket;
  try {
    socket = u.scheme === 'wss' ? await connectTls(`wss://${u.host}${u.target}`, { timeoutMs }) : await tcpConnect(u.hostname, u.port, timeoutMs);
  } catch (e) {
    throw connectError(e);
  }
  socket.setTimeout(0);
  const key = generateKey();
  const headP = readHead(socket, timeoutMs);
  socket.write(handshakeRequest(u.target, u.host, key));
  const { head, rest } = await headP;
  try { verifyResponse(parseResponseHead(head), key); } catch (e) { socket.destroy(); throw e; }
  return new WebSocket(socket, rest);
}

// An open client connection with tokio-tungstenite Stream/Sink semantics.
//   next(timeoutMs?) → { type:'text', data } | { type:'binary', data } | { type:'ping'|'pong', data }
//     | { type:'close', code, reason } | null (stream ended); rejects with WsError; resolves
//     TIMEOUT when timeoutMs elapses first without consuming anything (tokio `timeout(…, next())`).
// Frames are processed when consumed, as in tungstenite's read(): a received Ping queues a
// Pong and a received Close queues its echo in one "additional" slot that the next
// next()/send() writes — so a caller that stops reading right after a Close (the watch
// daemon does) never sends the reply, exactly like upstream.
export class WebSocket {
  constructor(socket, rest = Buffer.alloc(0)) {
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.state = 'active';            // active | closedByUs | closedByPeer | closeAcknowledged | terminated
    this.additional = null;           // pending pong / close reply: [opcode, payload]
    this.incomplete = null;           // fragmented message being assembled
    this.eof = false;
    this.ioError = null;
    this.ended = false;               // the stream yielded None or an error
    this.wake = null;
    socket.on('data', (c) => { this.decoder.push(c); this._wake(); });
    socket.on('end', () => { this.eof = true; this._wake(); });
    socket.on('close', () => { this.eof = true; this._wake(); });
    socket.on('error', (e) => { this.ioError ??= e; this._wake(); });
    if (rest.length) this.decoder.push(rest);
    socket.resume();
  }
  _wake() { const w = this.wake; this.wake = null; if (w) w(); }

  // set_additional: replace only an empty slot or a pending Pong.
  _setAdditional(opcode, payload) {
    if (!this.additional || this.additional[0] === OP.PONG) this.additional = [opcode, payload];
  }
  _flushAdditional() {
    if (!this.additional) return;
    const [op, payload] = this.additional;
    this.additional = null;
    this._raw(op, payload);
  }
  // Write one frame. A peer that only sent FIN (half-close) still accepts writes at the OS
  // level, but node auto-ends our side on 'end' — such a write is dropped silently instead
  // of failing (tungstenite's write succeeds and the next read sees the EOF).
  _raw(opcode, payload) {
    const s = this.socket;
    if (s.destroyed || s.writableEnded) {
      if (this.ioError) throw new WsError(`IO error: ${ioErrorText(this.ioError)}`);
      if (this.eof) return;
      throw new WsError(`IO error: ${ioErrorText({ code: 'EPIPE' })}`);
    }
    s.write(encodeFrame(opcode, payload));
  }

  // read_message_frame for one decoded frame → message, or undefined when nothing is yielded.
  _frame(f) {
    if (!(this.state === 'active' || this.state === 'closedByUs')) throw protocol('Remote sent after having closed');
    if (f.rsv) throw protocol('Reserved bits are non-zero');
    if (f.masked) throw protocol('Received a masked frame from server');
    if (f.opcode >= 8) {
      if (!f.fin) throw protocol('Fragmented control frame');
      if (f.payload.length > 125) throw protocol('Control frame too big (payload must be 125 bytes or less)');
      if (f.opcode === OP.CLOSE) {
        const { code, reason } = parseClose(f.payload);
        if (this.state === 'active') {                         // do_close
          this.state = 'closedByPeer';
          const reply = code === undefined || closeCodeAllowed(code) ? { code, reason } : { code: 1002, reason: 'Protocol violation' };
          this._setAdditional(OP.CLOSE, closePayload(reply.code, reply.reason));
          return { type: 'close', code: reply.code, reason: reply.reason };
        }
        this.state = 'closeAcknowledged';                      // reply to our own close
        return { type: 'close', code, reason };
      }
      if (f.opcode === OP.PING) {
        if (this.state === 'active') this._setAdditional(OP.PONG, f.payload);
        return { type: 'ping', data: f.payload };
      }
      if (f.opcode === OP.PONG) return { type: 'pong', data: f.payload };
      throw protocol(`Unknown control frame type: ${f.opcode}`);
    }
    const name = (op) => (op === OP.TEXT ? 'TEXT' : op === OP.BINARY ? 'BINARY' : `RESERVED_DATA_${op}`);
    if (f.opcode === OP.CONT) {
      if (!this.incomplete) throw protocol('Continue frame but nothing to continue');
      this.incomplete.parts.push(f.payload);
      this.incomplete.size += f.payload.length;
      if (this.incomplete.size > MAX_MESSAGE) throw new WsError(`Space limit exceeded: Message too long: ${this.incomplete.size} > ${MAX_MESSAGE}`);
      if (!f.fin) return undefined;
      const { op, parts } = this.incomplete;
      this.incomplete = null;
      return this._message(op, Buffer.concat(parts));
    }
    if (this.incomplete) throw protocol(`While waiting for more fragments received: ${name(f.opcode)}`);
    if (f.opcode !== OP.TEXT && f.opcode !== OP.BINARY) throw protocol(`Unknown data frame type: ${f.opcode}`);
    if (!f.fin) { this.incomplete = { op: f.opcode, parts: [f.payload], size: f.payload.length }; return undefined; }
    return this._message(f.opcode, f.payload);
  }
  _message(op, data) {
    return op === OP.TEXT ? { type: 'text', data: decodeText(data) } : { type: 'binary', data };
  }

  async next(timeoutMs) {
    if (this.ended || this.state === 'terminated') return null;
    const deadline = timeoutMs === undefined || timeoutMs === null ? Infinity : Date.now() + Math.max(0, timeoutMs);
    try {
      this._flushAdditional();
      for (;;) {
        const f = this.decoder.next();
        if (f) { const m = this._frame(f); if (m) return m; continue; }
        if (this.ioError) {
          // check_connection_reset: a reset once the peer's Close was seen ends the stream.
          if (this.ioError.code === 'ECONNRESET' && !(this.state === 'active' || this.state === 'closedByUs')) {
            this.state = 'terminated';
            this.ended = true;
            return null;
          }
          throw new WsError(`IO error: ${ioErrorText(this.ioError)}`);
        }
        if (this.eof) {
          const clean = this.state === 'closedByPeer' || this.state === 'closeAcknowledged';
          this.state = 'terminated';
          this.ended = true;
          if (clean) return null;
          throw protocol('Connection reset without closing handshake');
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return TIMEOUT;
        await new Promise((resolve) => {
          let timer = null;
          const done = () => { if (timer) clearTimeout(timer); if (this.wake === done) this.wake = null; resolve(); };
          if (remaining !== Infinity) timer = setTimeout(done, remaining);
          this.wake = done;
        });
      }
    } catch (e) {
      this.ended = true;
      throw e instanceof WsError ? e : new WsError(String(e?.message ?? e));
    }
  }

  // Sink::send — the message frame first, then any pending pong/close reply.
  _checkSend() {
    if (this.state === 'terminated') throw new WsError('Trying to work with closed connection');
    if (this.state !== 'active') throw protocol('Sending after closing is not allowed');
  }
  _send(opcode, payload) { this._checkSend(); this._raw(opcode, payload); this._flushAdditional(); }
  send(text) { this._send(OP.TEXT, Buffer.from(String(text), 'utf8')); }
  sendBinary(buf) { this._send(OP.BINARY, buf); }
  ping(data = Buffer.alloc(0)) { this._send(OP.PING, data); }
  pong(data = Buffer.alloc(0)) { this._checkSend(); this._setAdditional(OP.PONG, data); this._flushAdditional(); }
  // Close initiated by us (tungstenite close): our Close frame, then flush.
  close(code = 1000, reason = '') {
    if (this.state === 'terminated') throw new WsError('Trying to work with closed connection');
    if (this.state === 'active') {
      this.state = 'closedByUs';
      this._raw(OP.CLOSE, closePayload(code, reason));
    }
    this._flushAdditional();
  }

  // Drop the connection (what dropping a WebSocketStream does): no close handshake.
  terminate() {
    this.state = 'terminated';
    this.ended = true;
    this._wake();
    this.socket.destroy();
  }
}
