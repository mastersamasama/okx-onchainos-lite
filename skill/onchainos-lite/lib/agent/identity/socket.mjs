// `wallet-agentic-identity` WebSocket subscription helper — upstream
// commands/agent_commerce/identity/socket.rs. After `create` / `update` broadcast, the caller
// waits up to 30 s for a push whose `txHash` matches the broadcast hash. Every failure here is
// soft: the caller logs nothing and falls through without the `agent` field.
//
// Transport: core/ws.mjs (tokio-tungstenite `connect_async` semantics over the system CA store
// and HTTPS_PROXY, so the push also works inside TLS-inspecting sandboxes such as Muse).
import { connect, TIMEOUT } from '../../core/ws.mjs';
import { parse, stringify } from '../../core/json.mjs';
import { context } from '../../core/errors.mjs';
import { trim, asciiLower } from '../../core/rs/str.mjs';
import { isObject, asI64 } from '../../core/rs/value.mjs';

// upstream: socket.rs constants
export const SUBSCRIBE_CHANNEL = 'wallet-agentic-identity';
export const OPEN_TIMEOUT_MS = 10000;

const tryParse = (text) => { try { return { v: parse(text) }; } catch { return null; } };
const mget = (m, k) => (isObject(m) && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : undefined);

// Drop the connection after a best-effort flush of anything already queued.
async function dropSocket(ws) {
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      try { ws.socket.end(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
    });
  } catch {}
  try { ws.terminate(); } catch {}
}

// upstream: socket.rs::IdentitySubscription
export class IdentitySubscription {
  constructor(ws) { this.ws = ws; }

  // Dropping the Rust WebSocketStream without a close handshake (early-error paths).
  drop() { try { this.ws.terminate(); } catch {} }

  // upstream: IdentitySubscription::wait_for_match(tx_hash, wait) → push object | null (timeout);
  // throws on read error / close / stream end.
  async waitForMatch(txHash, waitMs) {
    const target = normalizeHash(txHash);
    const deadline = Date.now() + waitMs;
    let outcome;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { outcome = { timeout: true }; break; }
        let msg;
        try { msg = await this.ws.next(remaining); } catch (e) { outcome = { error: new Error(`ws read error: ${e.message}`) }; break; }
        if (msg === TIMEOUT) { outcome = { timeout: true }; break; }
        if (msg === null) { outcome = { error: new Error('ws closed before match') }; break; }
        let text;
        if (msg.type === 'text') text = msg.data;
        else if (msg.type === 'binary') {
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(msg.data); } catch { continue; }
        } else if (msg.type === 'close') { outcome = { error: new Error('ws closed by server') }; break; }
        else continue;
        const payload = extractPayload(text);
        if (payload === undefined) continue;
        const h = mget(payload, 'txHash');
        const pushHash = typeof h === 'string' ? normalizeHash(h) : '';
        if (pushHash !== '' && pushHash === target) { outcome = { payload }; break; }
      }
    } finally {
      // Best-effort close (SinkExt::close → Close frame without a payload), then drop.
      try { this.ws.close(null); } catch {}
      await dropSocket(this.ws);
    }
    if (outcome.error) throw outcome.error;
    return outcome.timeout ? null : outcome.payload;
  }
}

// upstream: socket.rs::open_identity_subscription(wallet_address, ws_url) — connect → login
// (wallet address as "token") → subscribe, all within OPEN_TIMEOUT.
export async function openIdentitySubscription(walletAddress, wsUrl) {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  const timedOut = () => new Error(`ws subscription open timed out after ${OPEN_TIMEOUT_MS / 1000}s (url=${wsUrl})`);
  let ws;
  const connectP = connect(wsUrl, { timeoutMs: OPEN_TIMEOUT_MS }).catch((e) => { throw context(`failed to connect to ${wsUrl}`, e); });
  let timer;
  try {
    ws = await Promise.race([connectP, new Promise((_, rej) => { timer = setTimeout(() => rej(timedOut()), OPEN_TIMEOUT_MS); })]);
  } catch (e) {
    connectP.then((late) => late.terminate(), () => {});
    throw e;
  } finally { clearTimeout(timer); }
  try {
    try { ws.send(stringify({ op: 'login', args: [{ token: walletAddress }] })); } catch (e) { throw context('ws login send failed', e); }
    await waitForEvent(ws, 'login', deadline, timedOut);
    try { ws.send(stringify({ op: 'subscribe', args: [{ channel: SUBSCRIBE_CHANNEL }] })); } catch (e) { throw context('ws subscribe send failed', e); }
    await waitForEvent(ws, 'subscribe', deadline, timedOut);
  } catch (e) {
    await dropSocket(ws);
    throw e;
  }
  return new IdentitySubscription(ws);
}

// upstream: socket.rs::extract_payload (private) → push object | undefined
export function extractPayload(text) {
  const r = tryParse(text);
  if (!r) return undefined;
  const v = r.v;
  if (mget(v, 'event') !== undefined) return undefined;
  const data = mget(v, 'data');
  if (data !== undefined) {
    if (Array.isArray(data)) return data.length ? data[0] : undefined;
    if (isObject(data)) return data;
  }
  if (mget(v, 'txHash') !== undefined && mget(v, 'agentId') !== undefined) return v;
  return undefined;
}

// upstream: socket.rs::wait_for_event (private) — drain frames until the expected ACK.
async function waitForEvent(ws, expected, deadline, timedOut) {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    let msg;
    try { msg = await ws.next(remaining); } catch (e) { throw new Error(`ws ack read error: ${e.message}`); }
    if (msg === TIMEOUT) throw timedOut();
    if (msg === null) throw new Error(`ws closed during ${expected} ack`);
    if (msg.type !== 'text') continue;
    const r = tryParse(msg.data);
    if (!r) continue;
    const v = r.v;
    const event = mget(v, 'event');
    if (event === expected) {
      const code = mget(v, 'code');
      let ok;
      if (code === undefined || code === null) ok = true;
      else if (typeof code === 'string') ok = code === '0';
      else if (typeof code === 'number' || typeof code === 'bigint') ok = asI64(code) === 0;
      else ok = false;
      if (!ok) {
        const m = mget(v, 'msg');
        throw new Error(`ws ${expected} rejected: code=${code === undefined ? '<missing>' : stringify(code)} msg=${typeof m === 'string' ? m : ''} raw=${msg.data}`);
      }
      return msg.data;
    }
    if (event === 'error') {
      const m = mget(v, 'msg');
      throw new Error(`ws error during ${expected}: ${typeof m === 'string' ? m : 'unknown'} raw=${msg.data}`);
    }
  }
}

// upstream: socket.rs::normalize_hash (private) — trim, strip 0x/0X, ASCII-lowercase.
export function normalizeHash(s) {
  const t = trim(s);
  const noPrefix = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t;
  return asciiLower(noPrefix);
}
