// upstream: cli/src/watch/daemon.rs — the `ws run-daemon` event loop: HMAC login,
// subscribe, heartbeat/idle-timeout task, ping/pong, push → events.<channel>.0.jsonl,
// reconnect loop, status file transitions. Same frames (serde_json key order), same
// timings, same status reasons.
import { createHmac } from 'node:crypto';
import { WS_URL } from '../config.mjs';
import { connect, TIMEOUT } from '../core/ws.mjs';
import { stringify } from '../core/json.mjs';
import { context } from '../core/errors.mjs';
import { sleep } from '../core/proc.mjs';
import { appendEvents, writePid, writeStatus, lastPollTime, nowMs } from './store.mjs';
import { channelPattern, ChannelPattern, WatchEnv, watchConfigFromStr, valueFromStr } from './types.mjs';
import { T, fromStr } from '../core/serde.mjs';
import { trim } from '../core/rs/str.mjs';
import { pathJoin, readToString } from '../core/rs/fs.mjs';

// upstream: daemon.rs HEARTBEAT_SECS / PONG_TIMEOUT_SECS / RECONNECT_DELAY_SECS /
// MAX_RECONNECT_ATTEMPTS, the 10 s login/subscribe ack waits and the 10 s status ticker.
// Mutable only so unit tests can shorten them.
export const TIMING = {
  heartbeatMs: 25_000, pongTimeoutMs: 10_000, reconnectDelayMs: 3_000, maxReconnectAttempts: 20,
  ackTimeoutMs: 10_000, statusTickMs: 10_000,
};

// upstream: daemon.rs::Credentials
export class Credentials {
  constructor(apiKey, secretKey, passphrase) { Object.assign(this, { apiKey, secretKey, passphrase }); }

  // upstream: daemon.rs::Credentials::from_watch_env — first missing var → "<VAR> is not set".
  static fromWatchEnv(env) {
    const prefix = env === WatchEnv.Pre ? 'OKX_PRE' : 'OKX_PROD';
    const read = (name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`${name} is not set`);
      return v;
    };
    const apiKey = read(`${prefix}_API_KEY`);
    const secretKey = read(`${prefix}_SECRET_KEY`);
    const passphrase = read(`${prefix}_PASSPHRASE`);
    return new Credentials(apiKey, secretKey, passphrase);
  }

  // upstream: daemon.rs::Credentials::sign — base64(HMAC-SHA256(secret, ts + "GET/users/self/verify"))
  sign(timestamp) {
    return createHmac('sha256', Buffer.from(this.secretKey, 'utf8')).update(`${timestamp}GET/users/self/verify`).digest('base64');
  }

  // upstream: daemon.rs::Credentials::login_msg — json! → keys sorted.
  loginMsg(unixSecs = Math.floor(Date.now() / 1000)) {
    const ts = String(unixSecs);
    return stringify({ op: 'login', args: [{ apiKey: this.apiKey, passphrase: this.passphrase, timestamp: ts, sign: this.sign(ts) }] });
  }
}

// upstream: daemon.rs::load_daemon_config — a parse failure marks the session config_corrupt.
export function loadDaemonConfig(dir) {
  const path = pathJoin(dir, 'config.json');
  let raw;
  try { raw = readToString(path); } catch (e) { throw context(`failed to read watch config: ${path}`, e); }
  try {
    return watchConfigFromStr(raw);
  } catch (e) {
    try { writeStatus(dir, 'config_corrupt', 'config_corrupt'); } catch {}
    throw new Error(`watch config is corrupt (${path}): ${e.message}`);
  }
}

const log = (line) => process.stderr.write(line + '\n');

// upstream: daemon.rs::run_daemon — runs until stopped; resolves on a clean exit.
export async function runDaemon(_id, dir) {
  writePid(dir, process.pid);
  writeStatus(dir, 'running');
  const config = loadDaemonConfig(dir);

  // Heartbeat writer (tokio interval, first tick immediate): keeps the status fresh so
  // poll/list can detect crashes, and signals the main loop on idle timeout.
  const state = { heartbeatActive: true, idleExpired: false };
  const idleTimeoutMs = BigInt(config.idle_timeout_ms);
  const createdAt = BigInt(config.created_at);
  let ticker;
  const tick = () => {
    if (state.heartbeatActive) { try { writeStatus(dir, 'running'); } catch {} }
    if (idleTimeoutMs > 0n) {
      const last = BigInt(lastPollTime(dir) ?? createdAt);
      const now = BigInt(nowMs());
      if ((now > last ? now - last : 0n) > idleTimeoutMs) {
        try { writeStatus(dir, 'stopped', 'idle_timeout'); } catch {}
        state.idleExpired = true;
        clearInterval(ticker);
        return true;
      }
    }
    return false;
  };
  if (!tick()) ticker = setInterval(tick, TIMING.statusTickMs);

  try {
    let creds;
    try {
      creds = Credentials.fromWatchEnv(config.env);
    } catch (e) {
      log(`[watch daemon] credentials error: ${e.message}`);
      writeStatus(dir, 'stopped', `credentials:${e.message}`);
      throw e;
    }

    let attempts = 0;
    for (;;) {
      state.heartbeatActive = true;
      let reason, err;
      try { reason = await connectAndStream(dir, WS_URL, creds, config, state); } catch (e) { err = e; }
      state.heartbeatActive = false;
      if (err === undefined) {
        attempts = 0;
        log(`[watch daemon] disconnected: ${reason}`);
        if (reason === 'stopped' || reason === 'idle_timeout') {
          writeStatus(dir, 'stopped', reason);
          return;
        }
        writeStatus(dir, 'disconnected', reason);
      } else {
        log(`[watch daemon] error: ${err.message}`);
        writeStatus(dir, 'disconnected', `error:${err.message}`);
      }

      if (state.idleExpired) {
        log('[watch daemon] idle timeout reached, shutting down');
        return;
      }
      attempts += 1;
      if (attempts >= TIMING.maxReconnectAttempts) {
        writeStatus(dir, 'stopped', 'max_reconnect_reached');
        return;
      }
      writeStatus(dir, 'reconnecting');
      await sleep(TIMING.reconnectDelayMs);
    }
  } finally {
    clearInterval(ticker);
  }
}

// Subscribe args per channel pattern (json! objects → keys sorted when serialised).
export function subscribeArgs(config) {
  return config.channels.flatMap((ch) => {
    switch (channelPattern(ch)) {
      case ChannelPattern.Global: return [{ channel: ch }];
      case ChannelPattern.PerWallet: return config.wallet_addresses.map((addr) => ({ channel: ch, walletAddress: addr }));
      case ChannelPattern.PerToken: return config.token_pairs.map((tp) => ({ channel: ch, chainIndex: tp.chain_index, tokenContractAddress: tp.token_contract_address }));
      default: return config.chain_indexes.map((ci) => ({ channel: ch, chainIndex: ci }));
    }
  });
}

// upstream: daemon.rs::connect_and_stream — Ok(reason) on a clean exit, throws otherwise.
export async function connectAndStream(dir, wsUrl, creds, config, state) {
  const ws = await connect(wsUrl);
  try {
    ws.send(creds.loginMsg());
    await waitForLoginAck(ws);

    const args = subscribeArgs(config);
    ws.send(stringify({ op: 'subscribe', args }));
    await waitForSubscribeAcks(ws, args.length);
    writeStatus(dir, 'running');

    let nextTick = Date.now() + TIMING.heartbeatMs;       // first interval tick consumed
    for (;;) {
      const msg = await ws.next(nextTick - Date.now());
      if (msg === TIMEOUT) {
        nextTick += TIMING.heartbeatMs;
        if (state.idleExpired) return 'idle_timeout';
        ws.send('ping');
        try { await recvPong(ws, dir, Date.now() + TIMING.pongTimeoutMs); } catch { throw new Error('ping_timeout'); }
        continue;
      }
      if (msg === null) throw new Error('connection_closed');
      if (msg.type === 'text') {
        if (trim(msg.data) === 'pong') continue;
        const notice = checkNotice(msg.data);
        if (notice) return notice;
        const push = parseWsPush(msg.data);
        if (push) appendEvents(dir, push.channel, push.data);
      } else if (msg.type === 'close') {
        throw new Error('server_closed');
      }
    }
  } finally {
    ws.terminate();
  }
}

// serde_json::from_str::<Value>(text).ok() then Value::get (objects only; own keys only, so a
// frame carrying e.g. a "constructor" key is still an object).
const jsonObject = (text) => {
  try {
    const v = valueFromStr(text);
    return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype ? v : null;
  } catch { return null; }
};
const get = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const str = (v) => (typeof v === 'string' ? v : undefined);

// upstream: daemon.rs::wait_for_login_ack
export async function waitForLoginAck(ws) {
  const deadline = Date.now() + TIMING.ackTimeoutMs;
  for (;;) {
    const msg = await ws.next(deadline - Date.now());
    if (msg === TIMEOUT) throw new Error('login ack timeout');
    if (msg === null) throw new Error('connection closed during login');
    if (msg.type !== 'text') continue;
    const v = jsonObject(msg.data);
    if (v && str(get(v, 'event')) === 'login') {
      if ((str(get(v, 'code')) ?? '-1') === '0') return;
      throw new Error(`login error: ${str(get(v, 'msg')) ?? 'unknown'}`);
    }
  }
}

// upstream: daemon.rs::wait_for_subscribe_acks — one ack per subscription arg.
export async function waitForSubscribeAcks(ws, count) {
  if (count === 0) return;
  const deadline = Date.now() + TIMING.ackTimeoutMs;
  let acked = 0;
  for (;;) {
    const msg = await ws.next(deadline - Date.now());
    if (msg === TIMEOUT) throw new Error('subscribe ack timeout');
    if (msg === null) throw new Error('connection closed during subscribe');
    if (msg.type !== 'text') continue;
    const v = jsonObject(msg.data);
    const ev = v ? str(get(v, 'event')) : undefined;
    if (ev === 'subscribe') {
      acked += 1;
      if (acked >= count) return;
    } else if (ev === 'error') {
      throw new Error(`subscribe error: ${str(get(v, 'msg')) ?? 'unknown'}`);
    }
  }
}

// upstream: daemon.rs::recv_pong — pushes that arrive meanwhile are stored, not lost.
export async function recvPong(ws, dir, deadline) {
  for (;;) {
    const msg = await ws.next(deadline - Date.now());
    if (msg === TIMEOUT) throw new Error('ping_timeout');
    if (msg === null) throw new Error('connection closed');
    if (msg.type !== 'text') continue;
    if (trim(msg.data) === 'pong') return;
    const push = parseWsPush(msg.data);
    if (push) appendEvents(dir, push.channel, push.data);
  }
}

// upstream: daemon.rs::check_notice
export function checkNotice(text) {
  const v = jsonObject(text);
  return v && str(get(v, 'event')) === 'notice' ? 'service_upgrade' : null;
}

// upstream: daemon.rs::WsPush { arg: WsPushArg { channel }, data: Vec<Value> } — parsed
// with serde_json::from_str (map or sequence form; unknown fields ignored).
const WS_PUSH = T.struct('WsPush', [['arg', T.struct('WsPushArg', [['channel', T.string]])], ['data', T.vec(T.value)]]);
export function parseWsPush(text) {
  try {
    const p = fromStr(text, WS_PUSH);
    return { channel: p.arg.channel, data: p.data };
  } catch { return null; }
}
