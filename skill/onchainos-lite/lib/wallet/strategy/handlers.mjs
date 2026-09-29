// The 4 limit-order subcommand handlers (create-limit / cancel / list / resume) and their pure
// helpers — upstream commands/agentic_wallet/strategy/handlers.rs. Each handler returns the
// `data` value upstream passes to output::success (the dispatcher prints the envelope).
import { resolveChain } from '../../core/chains.mjs';
import { resolveAndValidate } from '../../core/token-alias.mjs';
import { validateSlippage, validateOrderIdNumeric } from '../../core/validators.mjs';
import { invalidInput } from '../../core/sink.mjs';
import { context } from '../../core/errors.mjs';
import { displayF64, stringify } from '../../core/json.mjs';
import { sleep } from '../../core/proc.mjs';
import { trim, asciiLower } from '../../core/rs/str.mjs';
import { formatFixed } from '../../core/rs/num.mjs';
import { fetchPrice } from '../../commands/market/index.mjs';
import { fetchInfo } from '../../commands/token/token.mjs';
import * as api from './api.mjs';
import * as session from './session.mjs';
import {
  executionEventFor, isOrderAmountTooSmall, isUpgradeRequired, statusLabel, OrderStatus,
  orderStatusIsTerminal, orderStatusTryFrom,
} from './status.mjs';
import { ensureStrategyChain } from './supported-chains.mjs';
import { activate, activateCtx, buildIntent, humanDecimalToRawInteger, signIntent } from './trader-mode.mjs';
import {
  direction, strategyType, cancelReq, createOrderReq, listOrdersReq, reactivateReq, rule as ruleOf,
  verifySignInfo, orderListRespToValue,
} from './types.mjs';
import { asI64, get, isObject } from '../../core/rs/value.mjs';

// upstream: handlers.rs constants
export const DEFAULT_EXPIRES_SECS = 7 * 24 * 60 * 60;               // 7 days
export const DEFAULT_SLIPPAGE_VALUE = '15';                          // percent; BE wire is decimal
const ROUTER_MODE_DEFAULT = 1, ROUTER_MODE_MEV_ON = 2, ROUTER_MODE_MEV_OFF = 3;
const DEFAULT_LIMIT_ORDER_FEE_LEVEL = 2;
export const ACTIVATE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;    // SD-A TTL: 30 days
const SOURCE_TYPE_AGENTIC = 4;
export const MIN_ORDER_USD = 1.0;
export const WAIT_DURATION_SECS = 3;
const WAIT_REQUERY_STRATEGY_MODE = 7;
const ORDER_ID_LABEL = 'order-id';
const ORDER_IDS_LABEL = 'order-ids';

// <f64 as FromStr> → { value } | { err: ParseFloatError Display }
function parseF64(s) {
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(s);
  if (!m) return { err: s === '' ? 'cannot parse float from empty string' : 'invalid float literal' };
  if (m[2]) return { value: m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity) };
  return { value: Number(m[1] + m[3]) };
}
// <u32 as FromStr> → { value } | { err: ParseIntError Display }
function parseU32(s) {
  if (s === '') return { err: 'cannot parse integer from empty string' };
  const digits = s[0] === '+' ? s.slice(1) : s;
  if (digits === '' || !/^[0-9]+$/.test(digits)) return { err: 'invalid digit found in string' };
  const v = BigInt(digits);
  if (v > 4294967295n) return { err: 'number too large to fit in target type' };
  return { value: Number(v) };
}
// <i32 as FromStr> → number | undefined
function parseI32(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  return v >= -2147483648n && v <= 2147483647n ? Number(v) : undefined;
}

// ── create-limit ──

// upstream: handlers.rs::parse_direction_value — clap value parser for --direction
export function parseDirectionValue(raw) {
  const v = asciiLower(raw);
  if (v === 'buy') return direction.BUY;
  if (v === 'sell') return direction.SELL;
  throw new Error(`unknown direction \`${v}\` — expected \`buy\` or \`sell\``);
}

// upstream: handlers.rs::MevChoice::to_opt_bool — on → true, off → false, default → null
export const mevChoiceToOptBool = (choice) => (choice === 'on' ? true : choice === 'off' ? false : null);

// upstream: handlers.rs::derive_strategy_type — equality folds into the aggressive side.
export function deriveStrategyType(dir, triggerPrice, currentPrice) {
  if (dir === direction.BUY) return triggerPrice < currentPrice ? strategyType.BUY_DIP : strategyType.CHASE_HIGH;
  if (dir === direction.SELL) return triggerPrice > currentPrice ? strategyType.TAKE_PROFIT : strategyType.STOP_LOSS;
  throw new Error(`unsupported direction integer ${dir}; expected BUY (${direction.BUY}) or SELL (${direction.SELL})`);
}

// upstream: handlers.rs::fetch_token_price — market price data[0].price → positive finite f64
export async function fetchTokenPrice(client, address, chainIndex) {
  let resp;
  try { resp = await fetchPrice(client, address, chainIndex); } catch (e) { throw context('market price HTTP call failed', e); }
  const item = Array.isArray(resp) ? resp[0] : undefined;
  if (item === undefined) throw new Error(`market price response empty — got: ${stringify(resp)}`);
  const priceStr = get(item, 'price');
  if (typeof priceStr !== 'string') throw new Error(`market price item missing \`price\` — got: ${stringify(item)}`);
  const p = parseF64(priceStr);
  if (p.err) throw new Error(`market price \`${priceStr}\` is not a number: ${p.err}`);
  if (p.value <= 0 || !Number.isFinite(p.value)) {
    throw new Error(`market price for \`${address}\` on chain \`${chainIndex}\` must be positive finite, got \`${priceStr}\``);
  }
  return p.value;
}

// upstream: handlers.rs::build_below_minimum — json! (sorted keys)
export function buildBelowMinimum(fromTokenPrice, fromSymbol, fromDecimals) {
  return { belowMinimum: true, minFromAmount: formatMinFromAmount(fromTokenPrice, fromDecimals), fromSymbol };
}

// upstream: handlers.rs::format_min_from_amount — ceil(1 / price) at min(decimals, 8) places,
// trailing zeros stripped; "0" for a non-finite / non-positive price.
export function formatMinFromAmount(fromTokenPrice, fromDecimals) {
  if (!Number.isFinite(fromTokenPrice) || fromTokenPrice <= 0) return '0';
  const precision = Math.min(fromDecimals, 8);
  const scale = 10 ** precision;
  const raw = MIN_ORDER_USD / fromTokenPrice;
  const roundedUp = Math.ceil(raw * scale) / scale;
  const s = formatFixed(roundedUp, precision);
  const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.+$/, '') : s;
  return trimmed === '' ? '0' : trimmed;
}

// upstream: handlers.rs::fetch_from_token_info — basic-info data[0] → [decimals(u32), symbol]
export async function fetchFromTokenInfo(client, address, chainIndex) {
  let resp;
  try { resp = await fetchInfo(client, address, chainIndex); } catch (e) { throw context('token info HTTP call failed', e); }
  const item = Array.isArray(resp) ? resp[0] : undefined;
  if (item === undefined) throw new Error(`token info response empty — got: ${stringify(resp)}`);
  const decimalStr = get(item, 'decimal');
  if (typeof decimalStr !== 'string') throw new Error(`token info item missing \`decimal\` — got: ${stringify(item)}`);
  const d = parseU32(decimalStr);
  if (d.err) throw new Error(`token decimal \`${decimalStr}\` is not a u32: ${d.err}`);
  const sym = get(item, 'tokenSymbol');
  return [d.value, typeof sym === 'string' ? sym : ''];
}

// upstream: handlers.rs::percent_to_decimal — "15" / "20%" → "0.15" / "0.2"; bad input unchanged.
export function percentToDecimal(percent) {
  const cleaned = trim(trim(percent).replace(/%+$/, ''));
  const p = parseF64(cleaned);
  return p.err ? percent : displayF64(p.value / 100.0);
}

// upstream: handlers.rs::build_default_preset — SELL → sellPreset, else buyPreset.
export function buildDefaultPreset(slippagePercent, mevChoice, dir) {
  const routerMode = mevChoice === null || mevChoice === undefined ? ROUTER_MODE_DEFAULT : mevChoice ? ROUTER_MODE_MEV_ON : ROUTER_MODE_MEV_OFF;
  const inner = {
    slippageType: 2, slippageLevel: 4, slippageValue: percentToDecimal(slippagePercent),
    dynamicMaxSlippageValue: null, routerModeType: routerMode, limitOrderFeeLevel: DEFAULT_LIMIT_ORDER_FEE_LEVEL,
  };
  return { presetType: 1, [dir === direction.SELL ? 'sellPreset' : 'buyPreset']: inner };
}

// upstream: handlers.rs::create_limit
export async function createLimit(ctx, args) {
  const client = await ctx.api();
  const s = session.load();
  if (s.saTeeId === '') throw new Error('please re-login with `onchainos wallet login` before placing strategy orders');

  const resolvedChain = resolveChain(args.chainId);
  ensureStrategyChain(resolvedChain, args.chainId);
  const userWalletAddress = s.walletAddressFor(resolvedChain);
  if (userWalletAddress === '') {
    throw new Error(`no wallet address for chain \`${resolvedChain}\` — login with the right chain enabled first`);
  }

  const fromToken = resolveAndValidate(resolvedChain, args.fromToken, 'from-token');
  const toToken = resolveAndValidate(resolvedChain, args.toToken, 'to-token');
  const dir = args.direction;

  const tp = parseF64(args.triggerPrice);
  if (tp.err) throw new Error(`--trigger-price \`${args.triggerPrice}\` is not a number: ${tp.err}`);
  if (tp.value <= 0 || !Number.isFinite(tp.value)) {
    throw new Error(`--trigger-price must be a positive finite number, got \`${args.triggerPrice}\``);
  }
  const triggerPriceNum = tp.value;

  const priceQueryToken = dir === direction.BUY ? toToken : fromToken;
  let currentPriceNum;
  if (args.currentPrice !== undefined && args.currentPrice !== null) {
    const cp = parseF64(args.currentPrice);
    if (cp.err) throw new Error(`--current-price \`${args.currentPrice}\` is not a number: ${cp.err}`);
    if (cp.value <= 0 || !Number.isFinite(cp.value)) {
      throw new Error(`--current-price must be a positive finite number, got \`${args.currentPrice}\``);
    }
    currentPriceNum = cp.value;
  } else {
    try { currentPriceNum = await fetchTokenPrice(client, priceQueryToken, resolvedChain); } catch (e) {
      throw context(`fetch current price for ${priceQueryToken} on chain ${resolvedChain}`, e);
    }
  }
  const strat = deriveStrategyType(dir, triggerPriceNum, currentPriceNum);

  let fromDecimals, fromSymbol;
  try { [fromDecimals, fromSymbol] = await fetchFromTokenInfo(client, fromToken, resolvedChain); } catch (e) {
    throw context(`fetch info for fromToken \`${fromToken}\` on chain \`${resolvedChain}\``, e);
  }
  const fromAmountRaw = humanDecimalToRawInteger(args.amount, fromDecimals);

  let fromTokenPrice;
  if (dir === direction.SELL) fromTokenPrice = currentPriceNum;
  else {
    try { fromTokenPrice = await fetchTokenPrice(client, fromToken, resolvedChain); } catch (e) {
      throw context(`fetch from-token price for ${fromToken} on chain ${resolvedChain}`, e);
    }
  }
  if (Number.isFinite(fromTokenPrice) && fromTokenPrice > 0) {
    const a = parseF64(args.amount);
    const usdValue = (a.err ? NaN : a.value) * fromTokenPrice;
    if (Number.isFinite(usdValue) && usdValue < MIN_ORDER_USD) return buildBelowMinimum(fromTokenPrice, fromSymbol, fromDecimals);
  }

  const rule = ruleOf({ fromTokenAddress: fromToken, toTokenAddress: toToken, fromAmount: args.amount, triggerPrice: args.triggerPrice });
  const slippageRaw = args.slippage ?? DEFAULT_SLIPPAGE_VALUE;
  validateSlippage(slippageRaw);
  const preset = buildDefaultPreset(slippageRaw, mevChoiceToOptBool(args.mevProtection), dir);

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expireTimeMs = nowMs + DEFAULT_EXPIRES_SECS * 1000;
  const expiredAt = new Date(expireTimeMs).toISOString();

  if (!/^[+-]?[0-9]+$/.test(resolvedChain)) {
    throw new Error(`verifySignInfo.chainId requires a numeric chain id, got \`${resolvedChain}\``);
  }
  const chainIdLong = Number(resolvedChain);

  const intentStr = buildIntent({
    chainId: chainIdLong, recipient: userWalletAddress, fromToken, toToken, fromAmountRaw,
    createdAt, expiredAt, timestampMs: nowMs,
  });
  const signature = signIntent(intentStr, resolvedChain, s.seedB64);

  const req = createOrderReq({
    chainId: resolvedChain, userWalletAddress, rule, preset, strategyType: strat, strategyDirection: dir,
    verifySignInfo: verifySignInfo({
      accountId: s.accountId, address: userWalletAddress, chainId: chainIdLong, signMsg: intentStr,
      signature, sessionCert: s.sessionCert, teeId: s.saTeeId,
    }),
    expireTime: String(expireTimeMs), sourceType: SOURCE_TYPE_AGENTIC,
  });
  const actx = activateCtx({ accountId: s.accountId, sessionCert: s.sessionCert, sessionSeedB64: s.seedB64, expireMsFromNow: ACTIVATE_DEFAULT_TTL_MS });

  // 60018 → SD-A (its failure aborts) → retry once; the backend 100010 normalization applies to
  // the first attempt and to the retry alike.
  let created;
  try {
    created = { order: await api.createOrder(client, req) };
  } catch (e) {
    if (isUpgradeRequired(e)) {
      await activate(client, actx);
      try { created = { order: await api.createOrder(client, req) }; } catch (e2) { created = { err: e2 }; }
    } else {
      created = { err: e };
    }
  }
  if (created.err) {
    if (isOrderAmountTooSmall(created.err)) return buildBelowMinimum(fromTokenPrice, fromSymbol, fromDecimals);
    throw created.err;
  }
  const { order } = created;

  const original = {
    orderId: order.orderId, status: order.status, statusLabel: statusLabel(order.status),
    estimatedWaitTime: order.estimatedWaitTime, eventCursor: order.eventCursor,
  };
  if (args.wait) {
    await sleep(WAIT_DURATION_SECS * 1000);
    return waitAndRequery(client, s.accountId, order.orderId, original);
  }
  return original;
}

// ── --wait (F4) ──

// upstream: handlers.rs::status_is_settled — terminal OrderStatus (unknown integers → false)
export function statusIsSettled(status) {
  try { return orderStatusIsTerminal(orderStatusTryFrom(status)); } catch { return false; }
}

// upstream: handlers.rs::merge_terminal_fields — pure; overwrites status/statusLabel, sets settled
// and, when settled, copies the heavy terminal fields present in the re-query.
export function mergeTerminalFields(original, requeried) {
  const settled = statusIsSettled(requeried.status);
  if (!isObject(original)) return original;
  const obj = { ...original };
  obj.status = requeried.status;
  obj.statusLabel = statusLabel(requeried.status);
  obj.settled = settled;
  if (settled) {
    for (const k of ['transactionInfo', 'executionHistoryList', 'fromToken', 'toToken', 'orderStatusUpdateTime']) {
      if (requeried[k] !== null && requeried[k] !== undefined) obj[k] = requeried[k];
    }
  }
  return obj;
}

// upstream: handlers.rs::build_wait_payload — top-level settled = AND of every order's settled
export function buildWaitPayload(orders) {
  const allSettled = orders.every((o) => get(o, 'settled') === true);
  return { settled: allSettled, orders };
}

// upstream: handlers.rs::reject_all_with_wait — `cancel --all --wait` is unsupported.
export function rejectAllWithWait(args) {
  if (args.all && args.wait) {
    throw invalidInput('wait', 'cancel --all combined with --wait is not supported; use --order-id or --order-ids with --wait, or omit --wait for bulk cancel');
  }
}

// upstream: handlers.rs::wait_and_requery
export async function waitAndRequery(client, accountId, orderId, original) {
  const requeried = await api.openOrderDetail(client, accountId, orderId, WAIT_REQUERY_STRATEGY_MODE);
  return mergeTerminalFields(original, requeried);
}

// upstream: handlers.rs::wait_over_ids — one fixed 3 s sleep, then sequential re-queries.
export async function waitOverIds(client, accountId, orderIds) {
  await sleep(WAIT_DURATION_SECS * 1000);
  const orders = [];
  for (const id of orderIds) orders.push(await waitAndRequery(client, accountId, id, { orderId: id }));
  return buildWaitPayload(orders);
}

// ── cancel ──

// upstream: handlers.rs::cancel
export async function cancel(ctx, args) {
  rejectAllWithWait(args);
  const client = await ctx.api();
  const s = session.load();
  const req = buildCancelRequest(s.accountId, args);
  const resp = await api.cancel(client, req);
  if (args.wait) return waitOverIds(client, s.accountId, req.orderIds ?? []);
  return { updateNum: resp.updateNum, estimatedWaitTime: resp.estimatedWaitTime };
}

const csvParts = (s) => String(s).split(',').map((x) => trim(x)).filter((x) => x !== '');

// upstream: handlers.rs::build_cancel_request
export function buildCancelRequest(accountId, args) {
  if (args.all) return cancelReq({ accountId, cancelAll: true });
  if (args.orderIds !== undefined && args.orderIds !== null) {
    const parsed = csvParts(args.orderIds);
    if (!parsed.length) throw new Error('--order-ids parsed into an empty list');
    for (const id of parsed) validateOrderIdNumeric(id, ORDER_IDS_LABEL);
    return cancelReq({ accountId, orderIds: parsed, cancelAll: false });
  }
  if (args.orderId !== undefined && args.orderId !== null) {
    validateOrderIdNumeric(args.orderId, ORDER_ID_LABEL);
    return cancelReq({ accountId, orderIds: [args.orderId], cancelAll: false });
  }
  throw new Error('must pass exactly one of --order-id, --order-ids, or --all');
}

// ── list ──

// upstream: handlers.rs::list
export async function list(ctx, args) {
  const client = await ctx.api();
  const s = session.load();

  if (args.orderId !== undefined && args.orderId !== null) {
    const order = await api.openOrderDetail(client, s.accountId, args.orderId, args.strategyMode);
    return printOrders([order], null);
  }

  const rawList = csvToStrings(args.chainId);
  let chainIdList;
  if (rawList.length) {
    chainIdList = [];
    for (const raw of rawList) {
      const idx = resolveChain(raw);
      ensureStrategyChain(idx, raw);
      chainIdList.push(idx);
    }
  }

  let tokenAddress;
  if (args.token !== undefined && args.token !== null) {
    const t = trim(args.token);
    if (t !== '') {
      if (t.includes(',')) throw new Error('--token accepts only a single address; run `list` once per token.');
      tokenAddress = t;
    }
  }

  const req = listOrdersReq({
    accountId: s.accountId, walletAddressList: collectWalletAddresses(s), chainIdList,
    orderStatusList: parseStatusFilter(args.status) ?? defaultNonTerminalStatusList(),
    tokenAddress, limit: args.limit, cursor: args.cursor,
  });
  const resp = await api.getOpenOrder(client, req);
  return printOrders(resp.dataList, resp.cursor);
}

// upstream: handlers.rs::print_orders → the `{list, nextCursor}` payload
export function printOrders(orders, nextCursor) {
  const serialised = orders.map((o) => {
    const v = orderListRespToValue(o);
    const st = asI64(v.status);
    if (st !== undefined) v.statusLabel = statusLabel(Number(BigInt.asIntN(32, BigInt(st))));   // `as i32`
    enrichExecutionHistory(v);
    return v;
  });
  return { list: serialised, nextCursor: nextCursor ?? null };
}

// upstream: handlers.rs::enrich_execution_history — inject name/message/terminal for known codes.
export function enrichExecutionHistory(order) {
  const history = get(order, 'executionHistoryList');
  if (!Array.isArray(history)) return;
  for (const entry of history) {
    const code = asI64(get(entry, 'code'));
    if (code === undefined) continue;
    const meta = executionEventFor(Number(BigInt.asIntN(32, BigInt(code))));   // `as i32`
    if (!meta || !isObject(entry)) continue;
    entry.name = meta.name;
    entry.message = meta.message;
    entry.terminal = meta.isTerminal;
  }
}

// upstream: handlers.rs::collect_wallet_addresses — [evm?, sol?]
export function collectWalletAddresses(s) {
  const v = [];
  if (s.evmAddress !== '') v.push(s.evmAddress);
  if (s.solAddress !== '') v.push(s.solAddress);
  return v;
}

// upstream: handlers.rs::csv_to_strings — trimmed non-empty parts ([] for None)
export const csvToStrings = (s) => (s === undefined || s === null ? [] : csvParts(s));

// upstream: handlers.rs::default_non_terminal_status_list
export const defaultNonTerminalStatusList = () => [
  OrderStatus.Cancelling, OrderStatus.Trading, OrderStatus.Creating, OrderStatus.Active, OrderStatus.Suspended,
];

// upstream: handlers.rs::parse_status_filter — ints first, then labels; unknowns dropped; [] → null
export function parseStatusFilter(s) {
  const parts = csvToStrings(s);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const n = parseI32(p);
    if (n !== undefined) { out.push(n); continue; }
    const st = stringToStatus(p);
    if (st !== undefined) out.push(st);
  }
  return out.length ? out : null;
}

const STATUS_BY_LABEL = [
  ['expired', -7], ['cancelling', -3], ['cancelled', -2], ['failed', -1], ['processing', 0],
  ['completed', 1], ['creating', 2], ['active', 3], ['suspended', 4],
];
// upstream: handlers.rs::string_to_status — ASCII-lowercased, '-' → '_'
export function stringToStatus(label) {
  const normalized = asciiLower(label).replaceAll('-', '_');
  return STATUS_BY_LABEL.find(([l]) => l === normalized)?.[1];
}

// ── resume ──

// upstream: handlers.rs::resume
export async function resume(ctx, args) {
  const client = await ctx.api();
  const s = session.load();

  let orderIds;
  if (args.orderIds !== undefined && args.orderIds !== null) {
    orderIds = csvParts(args.orderIds);
    for (const id of orderIds) validateOrderIdNumeric(id, ORDER_IDS_LABEL);
  } else {
    orderIds = await discoverResumable(client, s);
  }

  if (!orderIds.length) return { successIds: [], failIds: [], note: 'no resumable orders found' };

  const actx = activateCtx({ accountId: s.accountId, sessionCert: s.sessionCert, sessionSeedB64: s.seedB64, expireMsFromNow: ACTIVATE_DEFAULT_TTL_MS });
  const req = reactivateReq({ accountId: s.accountId, orderIds: [...orderIds] });
  let resp;
  try {
    resp = await api.reactivate(client, req);
  } catch (e) {
    if (!isUpgradeRequired(e)) throw e;
    await activate(client, actx);
    resp = await api.reactivate(client, req);
  }

  if (args.wait) return waitOverIds(client, s.accountId, orderIds);
  return { successIds: resp.successIds, failIds: resp.failIds };
}

// upstream: handlers.rs::discover_resumable — SUSPENDED orders with canResume == true
export async function discoverResumable(client, s) {
  const wallets = collectWalletAddresses(s);
  if (!wallets.length) throw new Error('active account has no addresses to query');
  const req = listOrdersReq({ accountId: s.accountId, walletAddressList: wallets, orderStatusList: [OrderStatus.Suspended], limit: 100 });
  const resp = await api.getOpenOrder(client, req);
  return resp.dataList.filter((o) => o.canResume === true).map((o) => o.orderId);
}
