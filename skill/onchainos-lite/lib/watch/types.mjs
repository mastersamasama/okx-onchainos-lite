// upstream: cli/src/watch/types.rs — channel registry/classification, WatchConfig,
// TokenPair, TradeEvent (filter view), DaemonState.
import { struct, F64 } from '../core/json.mjs';
import { cmpBytes, splitn, trim, parseUnsigned } from './_rs.mjs';
import { fromStr, struct as serdeStruct, vec, string, u64, unitEnum, value } from './_serde.mjs';

// upstream: types.rs::ChannelPattern (Debug names; rendered `format!("{:?}").to_lowercase()`)
export const ChannelPattern = Object.freeze({ Global: 'Global', PerWallet: 'PerWallet', PerToken: 'PerToken', PerChain: 'PerChain' });
export const patternName = (p) => p.toLowerCase();

// upstream: types.rs::channel_pattern
export function channelPattern(ch) {
  if (ch === 'address-tracker-activity') return ChannelPattern.PerWallet;
  if (ch === 'price' || ch === 'price-info' || ch === 'trades' || ch.startsWith('dex-token-candle')) return ChannelPattern.PerToken;
  if (ch === 'dex-market-new-signal-openapi' || ch === 'dex-market-memepump-new-token-openapi' || ch === 'dex-market-memepump-update-metrics-openapi') return ChannelPattern.PerChain;
  return ChannelPattern.Global;
}

// upstream: types.rs::is_tracker_channel
export const isTrackerChannel = (ch) => ch === 'kol_smartmoney-tracker-activity' || ch === 'address-tracker-activity';

const USDT = '1:0xdac17f958d2ee523a2206206994597c13d831ec7';
const info = (name, group, pattern, description, paramsHint, example) => Object.freeze({ name, group, pattern, description, paramsHint, example });
// upstream: types.rs::ALL_CHANNELS (registry order)
export const ALL_CHANNELS = Object.freeze([
  info('kol_smartmoney-tracker-activity', 'signal', ChannelPattern.Global, 'KOL and smart money aggregated trade feed', '(none)',
    'onchainos ws start --channel kol_smartmoney-tracker-activity'),
  info('address-tracker-activity', 'signal', ChannelPattern.PerWallet, 'Trade feed for custom wallet addresses (up to 200)', '--wallet-addresses addr1,addr2,...',
    'onchainos ws start --channel address-tracker-activity --wallet-addresses 0xAAA,0xBBB'),
  info('dex-market-new-signal-openapi', 'signal', ChannelPattern.PerChain, 'Aggregated buy signal alerts from smart money/KOL/whale', '--chain-index 1,501',
    'onchainos ws start --channel dex-market-new-signal-openapi --chain-index 1,501'),
  info('price', 'market', ChannelPattern.PerToken, 'Real-time token price updates', '--token-pair chainIndex:tokenAddress',
    `onchainos ws start --channel price --token-pair ${USDT}`),
  info('dex-token-candle{period}', 'market', ChannelPattern.PerToken, 'Candlestick/K-line data (replace {period} with 1s,1m,5m,15m,1H,4H,1D, etc.)', '--token-pair chainIndex:tokenAddress',
    `onchainos ws start --channel dex-token-candle1m --token-pair ${USDT}`),
  info('price-info', 'token', ChannelPattern.PerToken, 'Detailed price with market cap, volume, liquidity, holders', '--token-pair chainIndex:tokenAddress',
    `onchainos ws start --channel price-info --token-pair ${USDT}`),
  info('trades', 'token', ChannelPattern.PerToken, 'Real-time trade feed for a token (every buy/sell)', '--token-pair chainIndex:tokenAddress',
    `onchainos ws start --channel trades --token-pair ${USDT}`),
  info('dex-market-memepump-new-token-openapi', 'trenches', ChannelPattern.PerChain, 'New meme token launches', '--chain-index 501',
    'onchainos ws start --channel dex-market-memepump-new-token-openapi --chain-index 501'),
  info('dex-market-memepump-update-metrics-openapi', 'trenches', ChannelPattern.PerChain, 'Meme token metric updates (market cap, volume, bonding curve)', '--chain-index 501',
    'onchainos ws start --channel dex-market-memepump-update-metrics-openapi --chain-index 501'),
]);

// upstream: types.rs::DEFAULT_CHANNELS
export const DEFAULT_CHANNELS = Object.freeze(['kol_smartmoney-tracker-activity']);

// upstream: types.rs::TokenPair (struct: chain_index, token_contract_address; derives Ord)
export const tokenPair = (chainIndex, tokenContractAddress) => struct({ chain_index: chainIndex, token_contract_address: tokenContractAddress });
export const cmpTokenPair = (a, b) => cmpBytes(a.chain_index, b.chain_index) || cmpBytes(a.token_contract_address, b.token_contract_address);

// upstream: types.rs::WatchEnv (serde rename_all = "lowercase")
export const WatchEnv = Object.freeze({ Pre: 'pre', Prod: 'prod' });

// upstream: types.rs::default_idle_timeout_ms
export const defaultIdleTimeoutMs = () => 30 * 60 * 1000;

// upstream: types.rs::WatchConfig — struct field order is the serialised order.
export function watchConfig({ channels, walletAddresses = [], tokenPairs = [], chainIndexes = [], env, createdAt, idleTimeoutMs = defaultIdleTimeoutMs() }) {
  return struct({
    channels,
    wallet_addresses: walletAddresses,
    token_pairs: tokenPairs.map((t) => tokenPair(t.chain_index, t.token_contract_address)),
    chain_indexes: chainIndexes,
    env,
    created_at: createdAt,
    idle_timeout_ms: idleTimeoutMs,
  });
}

const TOKEN_PAIR = serdeStruct('TokenPair', [
  { name: 'chain_index', de: (d) => string(d) },
  { name: 'token_contract_address', de: (d) => string(d) },
]);
const WATCH_CONFIG = serdeStruct('WatchConfig', [
  { name: 'channels', de: vec((d) => string(d)) },
  { name: 'wallet_addresses', de: vec((d) => string(d)), def: () => [] },
  { name: 'token_pairs', de: vec(TOKEN_PAIR), def: () => [] },
  { name: 'chain_indexes', de: vec((d) => string(d)), def: () => [] },
  { name: 'env', de: unitEnum(['pre', 'prod']) },
  { name: 'created_at', de: u64 },
  { name: 'idle_timeout_ms', de: u64, def: defaultIdleTimeoutMs },
]);

// serde_json::from_str::<serde_json::Value>(text) (throws serde's error text).
export const valueFromStr = (text) => fromStr(text, value);

// serde_json::from_str::<WatchConfig>(text) → WatchConfig (throws serde's error text).
export function watchConfigFromStr(text) {
  const c = fromStr(text, WATCH_CONFIG);
  return watchConfig({
    channels: c.channels, walletAddresses: c.wallet_addresses, tokenPairs: c.token_pairs,
    chainIndexes: c.chain_indexes, env: c.env, createdAt: c.created_at, idleTimeoutMs: c.idle_timeout_ms,
  });
}

// upstream: types.rs::TradeEvent — serde_json::from_value::<TradeEvent>(value), used only
// to filter. Returns the typed view or null when deserialisation fails.
const TRADE_FIELDS = ['walletAddress', 'quoteTokenSymbol', 'quoteTokenAmount', 'tokenSymbol', 'tokenContractAddress', 'chainIndex',
  'tokenPrice', 'marketCap', 'realizedPnlUsd', 'tradeType', 'tradeTime'];
const isU8 = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255;
function trackerTypeOf(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!Array.isArray(v) || !v.every(isU8)) return { ok: false };
  return { ok: true, value: v };
}
export function tradeEventFromValue(v) {
  let obj;
  if (Array.isArray(v)) {                  // serde derive also accepts the sequence form
    if (v.length !== 13) return null;
    obj = Object.fromEntries([...TRADE_FIELDS, 'trackerType', 'txHash'].map((k, i) => [k, v[i]]));
  } else if (v && typeof v === 'object' && !(v instanceof F64)) obj = v;
  else return null;
  const e = {};
  for (const k of TRADE_FIELDS) {
    if (typeof obj[k] !== 'string') return null;
    e[k] = obj[k];
  }
  const tt = trackerTypeOf(obj.trackerType);
  if (!tt.ok) return null;
  e.trackerType = tt.value;
  if (obj.txHash !== undefined && obj.txHash !== null && typeof obj.txHash !== 'string') return null;
  e.txHash = obj.txHash ?? null;
  return e;
}

// upstream: types.rs::DaemonState
export class DaemonState {
  constructor(kind, reason) { this.kind = kind; this.reason = reason; }
  static Running = new DaemonState('running');
  static Reconnecting = new DaemonState('reconnecting');
  static Stopped = new DaemonState('stopped');
  static Crashed = new DaemonState('crashed');
  static Disconnected = (reason) => new DaemonState('disconnected', reason);

  // upstream: types.rs::DaemonState::from_status_line
  static fromStatusLine(line, nowMs) {
    const parts = splitn(trim(line), 3, '|');
    if (parts.length < 2) return DaemonState.Crashed;
    if (parts[0] === 'stopped') return DaemonState.Stopped;
    const ts = BigInt(parseUnsigned(parts[1], 'u64') ?? 0);
    const now = BigInt(nowMs);
    if ((now > ts ? now - ts : 0n) > 60000n) return DaemonState.Crashed;
    switch (parts[0]) {
      case 'running': return DaemonState.Running;
      case 'disconnected': return DaemonState.Disconnected(parts[2] ?? 'unknown');
      case 'reconnecting': return DaemonState.Reconnecting;
      default: return DaemonState.Crashed;
    }
  }

  // upstream: types.rs::DaemonState::as_str
  asStr() { return this.kind; }
}
