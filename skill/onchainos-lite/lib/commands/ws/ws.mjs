// ws channels | channel-info | start | poll | stop | list | run-daemon (hidden)
// upstream: cli/src/commands/ws.rs — local watch sessions backed by a detached daemon
// (`ws run-daemon`, lib/watch/daemon.mjs) that streams the DEX WebSocket into
// <home>/watch/<id>/events.<channel>.N.jsonl; poll/stop/list only touch local files.
import { existsSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NO_OUTPUT } from '../../core/context.mjs';
import { typed, spec } from '../../core/cli.mjs';
import { sleep } from '../../core/proc.mjs';
import { spawnSelfDetachedStdio } from '../../watch/_proc.mjs';
import { parseDurationMs } from '../../core/sink.mjs';
import * as store from '../../watch/store.mjs';
import {
  ALL_CHANNELS, DEFAULT_CHANNELS, ChannelPattern, WatchEnv, channelPattern, isTrackerChannel,
  patternName, tokenPair, cmpTokenPair, tradeEventFromValue, watchConfig,
} from '../../watch/types.mjs';
import { Credentials, runDaemon } from '../../watch/daemon.mjs';
import { cmpBytes, sortDedup, trim, parseF64, parseUnsigned, pathJoin, ioError } from '../../watch/_rs.mjs';

// upstream: ws.rs::resolve_trade_type
export function resolveTradeType(s) {
  switch (s.toLowerCase()) {
    case 'all': case '0': return '0';
    case 'buy': case '1': return '1';
    case 'sell': case '2': return '2';
    default: return s;
  }
}

// upstream: ws.rs::parse_duration_ms → sink::parse_duration_ms(s, "idle-timeout", true)
export const parseIdleTimeoutMs = (s) => parseDurationMs(s, 'idle-timeout', true);

// Comma lists from `ws start` (upstream: ws.rs::execute, Start arm).
export const splitList = (s) => (s ?? '').split(',').map((x) => trim(x)).filter((x) => x.length);
export function parseTokenPairs(s) {
  const out = [];
  for (const raw of (s ?? '').split(',')) {
    const t = trim(raw);
    const i = t.indexOf(':');
    if (i < 0) continue;
    const ci = t.slice(0, i), addr = t.slice(i + 1);
    if (!ci || !addr) continue;
    out.push(tokenPair(ci, addr));
  }
  return out;
}

// DaemonState rendered for poll/list: "disconnected:<reason>" or as_str().
export const statusStr = (s) => (s.kind === 'disconnected' ? `disconnected:${s.reason}` : s.asStr());

// upstream: ws.rs::ws_channels
function wsChannels() {
  return ALL_CHANNELS.map((ch) => ({ channel: ch.name, group: ch.group, pattern: patternName(ch.pattern), description: ch.description }));
}

// upstream: ws.rs::ws_channel_info
function wsChannelInfo(name) {
  const ch = ALL_CHANNELS.find((c) => c.name === name || (c.name === 'dex-token-candle{period}' && name.startsWith('dex-token-candle')));
  if (!ch) throw new Error(`unknown channel '${name}'; use 'onchainos ws channels' to list all`);
  return {
    channel: ch.name === 'dex-token-candle{period}' ? name : ch.name,
    group: ch.group, pattern: patternName(ch.pattern), description: ch.description, params: ch.paramsHint, example: ch.example,
  };
}

// upstream: ws.rs::ws_start
function wsStart(channelsIn, walletAddressesIn, chainIndexesIn, tokenPairsIn, env, idleTimeoutMs) {
  let watchEnv;
  if (env === 'pre') watchEnv = WatchEnv.Pre;
  else if (env === 'prod') watchEnv = WatchEnv.Prod;
  else throw new Error(`unknown --env '${env}'; use pre or prod`);

  const channels = sortDedup(channelsIn.length ? channelsIn : [...DEFAULT_CHANNELS]);

  for (const ch of channels) {
    switch (channelPattern(ch)) {
      case ChannelPattern.PerWallet:
        if (!walletAddressesIn.length) throw new Error(`--wallet-addresses is required for channel '${ch}'`);
        if (walletAddressesIn.length > 200) throw new Error(`--wallet-addresses exceeds maximum of 200 (got ${walletAddressesIn.length})`);
        break;
      case ChannelPattern.PerToken:
        if (!tokenPairsIn.length) throw new Error(`--token-pair is required for channel '${ch}' (format: chainIndex:tokenAddress)`);
        break;
      case ChannelPattern.PerChain:
        if (!chainIndexesIn.length) throw new Error(`--chain-index is required for channel '${ch}'`);
        break;
      default:
    }
  }

  const walletAddresses = sortDedup(walletAddressesIn);
  const tokenPairs = sortDedup(tokenPairsIn, cmpTokenPair);
  const chainIndexes = sortDedup(chainIndexesIn);

  // Return the existing session if the same config is already running.
  const sameList = (a, b, cmp = cmpBytes) => a.length === b.length && a.every((x, i) => cmp(x, b[i]) === 0);
  for (const w of store.listWatches()) {
    const cfg = w.config;
    if (!cfg) continue;
    if (sameList([...cfg.channels].sort(cmpBytes), channels)
      && sameList([...cfg.wallet_addresses].sort(cmpBytes), walletAddresses)
      && sameList([...cfg.token_pairs].sort(cmpTokenPair), tokenPairs, cmpTokenPair)
      && sameList([...cfg.chain_indexes].sort(cmpBytes), chainIndexes)
      && cfg.env === watchEnv
      && (w.state.kind === 'running' || w.state.kind === 'reconnecting')) {
      return { id: w.id, status: 'already_running', channels, env };
    }
  }

  const id = `ws_${randomUUID().slice(0, 6)}`;
  const config = watchConfig({ channels, walletAddresses, tokenPairs, chainIndexes, env: watchEnv, createdAt: store.nowMs(), idleTimeoutMs });
  // Pre-flight: verify credentials before spawning the daemon.
  Credentials.fromWatchEnv(config.env);

  const dir = store.initWatchDir(id, config);
  const logFd = createDaemonLog(pathJoin(dir, 'daemon.log'));
  let pid;
  try {
    pid = spawnSelfDetachedStdio(['ws', 'run-daemon', '--id', id], { stdout: 'ignore', stderr: logFd });
  } finally {
    closeSync(logFd);
  }
  if (pid === undefined) throw new Error('failed to spawn the watch daemon');
  store.writePid(dir, pid);

  return { id, status: 'starting', pid, channels, env, dir };
}

// upstream: ws.rs::create_daemon_log — append mode, 0600 on unix.
function createDaemonLog(path) {
  try { return openSync(path, 'a', 0o600); } catch (e) { throw ioError(e); }
}

const USIZE_MASK = (1n << 64n) - 1n;

// upstream: ws.rs::ws_poll — `limit` is the clap usize (BigInt here).
function wsPoll(id, channel, limit, f) {
  const dir = store.watchDir(id);
  if (!existsSync(dir)) throw new Error(`session '${id}' not found`);

  const daemonState = store.readDaemonState(id);
  let pollChannel = channel;
  if (pollChannel === undefined) {
    const config = store.readConfig(id);
    if (!config.channels.length) throw new Error('session has no channels configured');
    pollChannel = config.channels[0];
  }

  const isTracker = isTrackerChannel(pollChannel);
  const hasFilters = isTracker && [f.minQuoteAmount, f.minMarketCap, f.minPnl, f.trader, f.tag, f.since, f.tradeType].some((x) => x !== undefined);
  // `limit * 4` is usize arithmetic: it wraps in the release build (no overflow checks).
  const fetchLimit = hasFilters ? (limit * 4n) & USIZE_MASK : limit;
  const result = store.readEventsFromCursor(dir, pollChannel, Number(fetchLimit));
  const take = Number(limit);
  const daemonStatus = statusStr(daemonState);

  if (isTracker && hasFilters) {
    let tagFilter;
    if (f.tag !== undefined) {
      if (f.tag === 'smart_money' || f.tag === 'sm' || f.tag === '1') tagFilter = 1;
      else if (f.tag === 'kol' || f.tag === '2') tagFilter = 2;
      else throw new Error(`unknown --tag value '${f.tag}'; use smart_money or kol`);
    }
    const tradeTypeFilter = f.tradeType === undefined ? undefined : resolveTradeType(f.tradeType);
    const filtered = [];
    for (let i = 0; i < result.events.length && filtered.length < take; i++) {
      if (tradeMatches(result.events[i], f, tagFilter, tradeTypeFilter)) filtered.push([i, result.events[i]]);
    }
    if (filtered.length) {
      const c = result.perEventCursors[filtered.at(-1)[0]] ?? result.newCursor;
      store.writeCursor(dir, pollChannel, c.fileNo, c.offset);
    }
    return { daemon_status: daemonStatus, new_count: filtered.length, trades: filtered.map(([, v]) => v) };
  }

  const events = result.events.slice(0, take);
  store.writeCursor(dir, pollChannel, result.newCursor.fileNo, result.newCursor.offset);
  return { daemon_status: daemonStatus, new_count: events.length, [isTracker ? 'trades' : 'events']: events };
}

// The TradeEvent filter closure of ws_poll (NaN comparisons keep the event, as in Rust).
export function tradeMatches(value, f, tagFilter, tradeTypeFilter) {
  const e = tradeEventFromValue(value);
  if (!e) return false;
  const num = (s, def) => { const v = parseF64(s); return v === undefined ? def : v; };
  if (f.minQuoteAmount !== undefined && num(e.quoteTokenAmount, 0) < f.minQuoteAmount) return false;
  if (f.minMarketCap !== undefined && num(e.marketCap, 0) < f.minMarketCap) return false;
  if (f.minPnl !== undefined && num(e.realizedPnlUsd, -Infinity) < f.minPnl) return false;
  if (f.trader !== undefined && !e.walletAddress.startsWith(f.trader)) return false;
  if (tagFilter !== undefined && !(e.trackerType ?? []).includes(tagFilter)) return false;
  if (f.since !== undefined && BigInt(parseUnsigned(e.tradeTime, 'u64') ?? 0) < BigInt(f.since)) return false;
  if (tradeTypeFilter !== undefined && tradeTypeFilter !== '' && tradeTypeFilter !== '0' && e.tradeType !== tradeTypeFilter) return false;
  return true;
}

// upstream: ws.rs::stop_one
async function stopOne(id, flush) {
  const dir = store.watchDir(id);
  if (!existsSync(dir)) throw new Error(`session '${id}' not found`);
  const flushedEvents = [];
  if (flush) {
    const config = store.readConfig(id);
    for (const ch of config.channels) {
      const result = store.readEventsFromCursor(dir, ch, 1000);
      store.writeCursor(dir, ch, result.newCursor.fileNo, result.newCursor.offset);
      flushedEvents.push(...result.events);
    }
  }
  try { await killDaemon(id); } catch {}
  try { store.writeStatus(dir, 'stopped'); } catch {}
  store.removeWatchDir(id);
  return { flushedEvents };
}

// upstream: ws.rs::ws_stop
async function wsStop(id, flush) {
  const { flushedEvents } = await stopOne(id, flush);
  return { id, status: 'stopped', flushed_count: flushedEvents.length, flushed_events: flushedEvents };
}

// upstream: ws.rs::ws_stop_all
async function wsStopAll(flush) {
  const watches = store.listWatches();
  if (!watches.length) return { stopped: [], message: 'no active sessions' };
  const stopped = [];
  for (const w of watches) {
    try {
      await stopOne(w.id, flush);
      stopped.push(w.id);
    } catch (e) {
      process.stderr.write(`[warn] failed to stop ${w.id}: ${e.message}\n`);
    }
  }
  return { stopped };
}

// upstream: ws.rs::kill_daemon — unix: SIGTERM, wait ≤3 s, SIGKILL; windows: taskkill /F.
async function killDaemon(id) {
  const pid = store.readPid(id);
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'pipe', windowsHide: true }); } catch {}
    return;
  }
  if (typeof pid !== 'number' || pid <= 0 || pid > 2147483647) throw new Error(`invalid PID ${pid} — refusing to send signal`);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!alive()) return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

// upstream: ws.rs::ws_list
function wsList() {
  return store.listWatches().map((w) => ({
    id: w.id,
    status: statusStr(w.state),
    pid: w.pid,
    channels: w.config ? w.config.channels : [],
    env: w.config ? w.config.env : '',
    created_at: w.config ? String(w.config.created_at) : '',
  }));
}

// upstream: ws.rs::run_daemon_entry
async function runDaemonEntry(id) {
  const dir = store.watchDir(id);
  if (!existsSync(dir)) throw new Error(`session dir for '${id}' does not exist`);
  await runDaemon(id, dir);
}

const f64Opt = (ctx, name, raw) => (raw === undefined ? undefined : (typed(ctx.path, name, raw, 'f64'), parseF64(raw)));

const handlers = {
  'ws channels': {
    uses: [],
    run: () => wsChannels(),
  },
  'ws channel-info': {
    uses: ['channel'],
    run: (ctx, o) => wsChannelInfo(o.channel),
  },
  'ws start': {
    uses: ['channel', 'walletAddresses', 'chainIndex', 'tokenPair', 'env', 'idleTimeout'],
    async run(ctx, o) {
      const channels = [].concat(o.channel ?? []);
      const addrs = splitList(o.walletAddresses);
      const chainIndexes = splitList(o.chainIndex);
      const tokenPairs = parseTokenPairs(o.tokenPair);
      const idleTimeoutMs = parseIdleTimeoutMs(o.idleTimeout);
      return wsStart(channels, addrs, chainIndexes, tokenPairs, o.env, idleTimeoutMs);
    },
  },
  'ws poll': {
    uses: ['id', 'channel', 'limit', 'minQuoteAmount', 'minMarketCap', 'minPnl', 'trader', 'tag', 'since', 'tradeType'],
    async run(ctx, o) {
      const limit = BigInt(typed(ctx.path, 'limit', o.limit, 'usize'));
      const f = {
        minQuoteAmount: f64Opt(ctx, 'minQuoteAmount', o.minQuoteAmount),
        minMarketCap: f64Opt(ctx, 'minMarketCap', o.minMarketCap),
        minPnl: f64Opt(ctx, 'minPnl', o.minPnl),
        trader: o.trader,
        tag: o.tag,
        since: typed(ctx.path, 'since', o.since, 'u64'),
        tradeType: o.tradeType,
      };
      return wsPoll(o.id, o.channel, limit, f);
    },
  },
  'ws stop': {
    uses: ['id', 'flush'],
    run: (ctx, o) => (o.id !== undefined ? wsStop(o.id, !!o.flush) : wsStopAll(!!o.flush)),
  },
  'ws list': {
    uses: [],
    run: () => wsList(),
  },
};

// Hidden upstream subcommand (#[command(hide = true)]): registered when lib/spec.json carries
// it (spec/hidden.json → dump-cli-tree), which `ws start` needs to spawn its daemon.
if (spec().nodes['ws run-daemon']) {
  handlers['ws run-daemon'] = {
    uses: ['id'],
    async run(ctx, o) {
      await runDaemonEntry(o.id);
      return NO_OUTPUT;
    },
  };
}

export default handlers;

