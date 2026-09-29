// swap — upstream cli/src/commands/swap.rs: DEX aggregator fetch helpers (shared with MCP and
// cross-chain), the quote/swap/approve/check-approvals/chains/liquidity handlers and the
// fund-moving `swap execute` orchestration (approve → unsigned tx → sign → broadcast).
// Exported fns mirror upstream (camelCase of the Rust fn, same parameter order; `client` is a
// core/http.mjs ApiClient).
import { resolveChain, ensureSupportedChain, chainFamily, nativeTokenAddress, mergesBatchUnsignedInfo } from '../../core/chains.mjs';
import { resolveTokenAddress, validateAddressForChain } from '../../core/token-alias.mjs';
import { validateAmount, validateSlippage, readableToMinimalStr } from '../../core/validators.mjs';
import { classifySwapRoute } from '../../core/risk-classify.mjs';
import { waitTxOnchain } from '../../core/common.mjs';
import { buildFundingBundle, FUNDING_OPERATION_SWAP } from '../../core/funding.mjs';
import { FundingBlocked } from '../../core/errors.mjs';
import { F64, parse } from '../../core/json.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { success } from '../../core/output.mjs';
import { trim, eqIgnoreAsciiCase } from '../../core/rs/str.mjs';
import { parseF64, parseU32, parseU128 } from '../../core/rs/num.mjs';
import { WalletApiClient, displayTop } from '../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { setSwapTraceId } from '../../wallet/store.mjs';
import { executeContractCall, batchSignAndBroadcast, batchTxParams } from '../../wallet/transfer/index.mjs';
import { minimalToReadable, valueAsDecimalString } from '../../wallet/shared/common/amount.mjs';
import { fetchInfo } from '../token/token.mjs';
import { queryTokenReadableBalance } from '../../wallet/balance/index.mjs';

const QUOTE_PATH = '/api/v6/dex/aggregator/quote';
const SWAP_PATH = '/api/v6/dex/aggregator/swap';
const APPROVE_PATH = '/api/v6/dex/aggregator/approve-transaction';
const CHECK_APPROVALS_PATH = '/api/v6/dex/pre-transaction/check-approvals';
const CHAINS_PATH = '/api/v6/dex/aggregator/supported/chain';
const LIQUIDITY_PATH = '/api/v6/dex/aggregator/get-liquidity';

// ── serde_json::Value access helpers ─────────────────────────────────

const some = (v) => v !== undefined && v !== null;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
// `value[key]` — the field of an object, else Null.
export const idx = (v, k) => (isJsonObject(v) && own(v, k) ? v[k] : null);
// `Value::as_str`
export const asStr = (v) => (typeof v === 'string' ? v : undefined);
// `Value::as_u64` (non-negative integer, never a float)
function asU64(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'bigint' && v >= 0n && v <= 18446744073709551615n) return v;
  return undefined;
}

// upstream: swap.rs::unwrap_api_array (== cross_chain.rs::unwrap_data_array) — first element of
// an array (Null when empty), else the value itself.
export const unwrapApiArray = (data) => (Array.isArray(data) ? (data.length ? data[0] : null) : data === undefined ? null : data);

// ── SW2 per-route classification ─────────────────────────────────────

// upstream: swap.rs::swap_routes_mut — the route objects of a quote (entry itself) or swap
// (entry.routerResult when it is an object) response.
export function swapRoutesMut(value) {
  const routeOf = (entry) => (isJsonObject(idx(entry, 'routerResult')) ? entry.routerResult : entry);
  return Array.isArray(value) ? value.map(routeOf) : [routeOf(value)];
}

// upstream: swap.rs::classify_swap_response — per-route action/reason, in place.
export function classifySwapResponse(value) {
  for (const route of swapRoutesMut(value)) classifySwapRoute(route);
}

// ── amount resolution ────────────────────────────────────────────────

// Token decimals from a basic-info element: string → u32 parse; number → as_u64 as u32.
function tokenDecimal(item, token, chainIndex) {
  void chainIndex;
  const d = idx(item, 'decimal');
  if (typeof d === 'string') {
    const v = parseU32(d);
    if (v === undefined) throw new Error(`Invalid decimal value "${d}" for token ${token}`);
    return Number(v);
  }
  if (typeof d === 'number' || typeof d === 'bigint' || d instanceof F64) {
    const v = asU64(d);
    if (v === undefined) throw new Error(`Invalid decimal value for token ${token}`);
    return Number(v & 0xffffffffn);   // `as u32` truncation
  }
  throw new Error(`Token decimal not found for ${token}. Use --amount with raw units instead.`);
}

// Shared tail of resolve_amount_arg / cross_chain::resolve_approve_amount: basic-info lookup of
// `token` → decimals → readable_to_minimal_str.
export async function readableViaTokenInfo(client, readable, token, chainIndex) {
  let info;
  try {
    info = await fetchInfo(client, token, chainIndex);
  } catch (e) {
    throw new Error(`Failed to fetch token decimals for ${token}: ${displayTop(e)}. Use --amount with raw units instead.`);
  }
  if (!Array.isArray(info) || !info.length) {
    throw new Error(`Token not found for address ${token} on chain ${chainIndex}. Verify the address is correct. Use --amount with raw units instead.`);
  }
  return readableToMinimalStr(readable, tokenDecimal(info[0], token, chainIndex));
}

// upstream: swap.rs::resolve_amount_arg — raw --amount (validated) or --readable-amount
// converted with the from-token's decimals (POST /api/v6/dex/market/token/basic-info).
export async function resolveAmountArg(client, amount, readableAmount, from, chainIndex) {
  if (some(amount)) {
    const amt = trim(amount);
    validateAmount(amt);
    return amt;
  }
  if (some(readableAmount)) {
    const readable = trim(readableAmount);
    if (readable === '') throw new Error('--readable-amount must not be empty');
    return readableViaTokenInfo(client, readable, resolveTokenAddress(chainIndex, from), chainIndex);
  }
  throw new Error('Either --amount or --readable-amount is required');
}

// ── validators ───────────────────────────────────────────────────────

// upstream: swap.rs::ensure_different_tokens
export function ensureDifferentTokens(from, to) {
  if (eqIgnoreAsciiCase(from, to)) throw new Error(`fromToken and toToken are the same address (${from}). Cannot swap a token to itself.`);
}

// upstream: swap.rs::validate_swap_params — format per chain + different tokens (resolved input).
export function validateSwapParams(chainIndex, from, to) {
  validateAddressForChain(chainIndex, from, 'from');
  validateAddressForChain(chainIndex, to, 'to');
  ensureDifferentTokens(from, to);
}

// upstream: swap.rs::validate_swap_mode
export function validateSwapMode(swapMode) {
  if (swapMode !== 'exactIn' && swapMode !== 'exactOut') throw new Error(`--swap-mode must be "exactIn" or "exactOut", got "${swapMode}"`);
}

// upstream: swap.rs::validate_gas_level
export function validateGasLevel(gasLevel) {
  if (!['slow', 'average', 'fast'].includes(gasLevel)) throw new Error(`--gas-level must be "slow", "average", or "fast", got "${gasLevel}"`);
}

// upstream: swap.rs::validate_tips — SOL amount in [1e-10, 2] (NaN passes, as upstream).
export function validateTips(tips) {
  const t = trim(tips);
  if (t === '') throw new Error('--tips must not be empty');
  const val = parseF64(t);
  if (val === undefined) throw new Error(`--tips must be a number in SOL, got "${t}"`);
  if (val < 1e-10) throw new Error(`--tips must be at least 0.0000000001 SOL, got "${t}"`);
  if (val > 2.0) throw new Error(`--tips must be at most 2 SOL, got "${t}"`);
}

// upstream: swap.rs::validate_approve_amount — whole minimal units, "0" allowed (revoke).
export function validateApproveAmount(amount) {
  const a = trim(amount);
  if (a === '') throw new Error('--amount must not be empty');
  if (a.includes('.')) throw new Error('--amount must be a whole number in minimal units (no decimals)');
  if (!/^[0-9]*$/.test(a)) {
    throw new Error(`--amount must be a whole number in minimal units, got "${a}". Infinity, NaN, negative numbers and non-numeric values are not accepted.`);
  }
  if (a.length > 1 && a.startsWith('0')) throw new Error(`--amount must not have leading zeros, got "${a}"`);
}

// ── aggregator API ───────────────────────────────────────────────────

// Trace id (resolved from-address + epoch ms) and its two headers.
function traceHeaders(from) {
  const timestamp = String(Date.now());
  const tid = `${from}${timestamp}`;
  return { tid, headers: { 'ok-client-tid': tid, 'ok-client-timestamp': timestamp } };
}

// upstream: swap.rs::fetch_quote — GET /api/v6/dex/aggregator/quote (own trace id, not cached).
export async function fetchQuote(client, chainIndex, from, to, amount, swapMode) {
  if (swapMode !== '') validateSwapMode(swapMode);
  const f = resolveTokenAddress(chainIndex, from);
  const t = resolveTokenAddress(chainIndex, to);
  validateSwapParams(chainIndex, f, t);
  const { headers } = traceHeaders(f);
  return client.get(QUOTE_PATH, [
    ['chainIndex', chainIndex], ['fromTokenAddress', f], ['toTokenAddress', t], ['amount', amount], ['swapMode', swapMode],
  ], headers);
}

// upstream: swap.rs::fetch_swap — GET /api/v6/dex/aggregator/swap; caches the trace id in
// cache.json (swapTraceId) for the following contract-call broadcast.
export async function fetchSwap(client, chainIndex, from, to, amount, slippage, wallet, swapMode, gasLevel, tips, maxAutoSlippage) {
  if (swapMode !== '') validateSwapMode(swapMode);
  if (gasLevel !== '') validateGasLevel(gasLevel);
  if (some(slippage)) validateSlippage(slippage);
  if (some(tips)) validateTips(tips);
  if (some(maxAutoSlippage)) validateSlippage(maxAutoSlippage);
  validateAddressForChain(chainIndex, wallet, 'wallet');
  validateAmount(amount);
  const f = resolveTokenAddress(chainIndex, from);
  const t = resolveTokenAddress(chainIndex, to);
  validateSwapParams(chainIndex, f, t);
  const query = [
    ['chainIndex', chainIndex], ['fromTokenAddress', f], ['toTokenAddress', t], ['amount', amount],
    ['userWalletAddress', wallet], ['swapMode', swapMode], ['gasLevel', gasLevel],
  ];
  if (some(slippage)) query.push(['slippagePercent', slippage]);
  else query.push(['autoSlippage', 'true'], ['slippagePercent', '0.5']);
  if (some(tips)) query.push(['tips', tips], ['computeUnitPrice', '0']);
  if (some(maxAutoSlippage)) query.push(['maxAutoSlippagePercent', maxAutoSlippage]);
  const { tid, headers } = traceHeaders(f);
  try { setSwapTraceId(tid); } catch { /* best effort */ }
  return client.get(SWAP_PATH, query, headers);
}

// upstream: swap.rs::fetch_approve — GET /api/v6/dex/aggregator/approve-transaction.
export async function fetchApprove(client, chainIndex, token, amount) {
  validateApproveAmount(amount);
  const t = resolveTokenAddress(chainIndex, token);
  validateAddressForChain(chainIndex, t, 'token');
  return client.get(APPROVE_PATH, [['chainIndex', chainIndex], ['tokenContractAddress', t], ['approveAmount', amount]]);
}

// upstream: swap.rs::fetch_check_approvals — POST /api/v6/dex/pre-transaction/check-approvals.
export async function fetchCheckApprovals(client, chainIndex, address, token, spender) {
  validateAddressForChain(chainIndex, address, 'address');
  const t = resolveTokenAddress(chainIndex, token);
  validateAddressForChain(chainIndex, t, 'token');
  if (some(spender)) validateAddressForChain(chainIndex, spender, 'spender');
  const body = { chainIndex, address, tokens: [{ tokenContractAddress: t }] };
  if (some(spender)) body.spender = spender;
  return client.post(CHECK_APPROVALS_PATH, body);
}

// upstream: swap.rs::fetch_chains — GET /api/v6/dex/aggregator/supported/chain
export const fetchChains = (client) => client.get(CHAINS_PATH, []);

// upstream: swap.rs::fetch_liquidity — GET /api/v6/dex/aggregator/get-liquidity
export const fetchLiquidity = (client, chainIndex) => client.get(LIQUIDITY_PATH, [['chainIndex', chainIndex]]);

// ── approval gating / batch helpers ──────────────────────────────────

// upstream: swap.rs::REVOKE_REQUIRED_TOKENS — USDT-pattern tokens (revoke to 0 before re-approve).
const REVOKE_REQUIRED_TOKENS = {
  1: [
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
    '0x1776e1f26f98b1a5df9cd347953a26dd3cb46671',
    '0xd3e4ba569045546d09cf021ecc5dfe42b1d7f6e4',
  ],
};

// upstream: swap.rs::token_requires_revoke
export function tokenRequiresRevoke(chainIndex, token) {
  const list = own(REVOKE_REQUIRED_TOKENS, chainIndex) ? REVOKE_REQUIRED_TOKENS[chainIndex] : null;
  const lc = String(token).toLowerCase();
  return !!list && list.some((a) => a.toLowerCase() === lc);
}

const U128_MAX = (1n << 128n) - 1n;

// upstream: swap.rs::is_allowance_insufficient — minimal-unit decimal strings; spendable longer
// than 38 digits (uint256 max approval) counts as sufficient.
export function isAllowanceInsufficient(spendable, amount) {
  if (Buffer.byteLength(spendable, 'utf8') > 38) return false;
  const s = parseU128(spendable) ?? 0n;
  const a = parseU128(amount) ?? U128_MAX;
  return s < a;
}

// upstream: swap.rs::classify_approve_action → [needsApprove, needsRevoke]
export function classifyApproveAction(chainIndex, token, spendable, amount) {
  const needsApprove = isAllowanceInsufficient(spendable, amount);
  const nonzero = spendable !== '0' && spendable !== '';
  return [needsApprove, needsApprove && nonzero && tokenRequiresRevoke(chainIndex, token)];
}

// upstream: swap.rs::extract_batch_hashes — hashes in [revoke?, approve, swap] order →
// [approveTxHash | null, swapTxHash]; a single hash is an X Layer merge (swap only).
export function extractBatchHashes(hashes, needsApprove, needsRevoke) {
  if (hashes.length === 1) return [null, hashes[0]];
  const swap = hashes[hashes.length - 1];
  const approve = needsApprove ? hashes[needsRevoke ? 1 : 0] : null;
  return [approve, swap];
}

// upstream: swap.rs::extract_approve_calldata
export function extractApproveCalldata(approveData) {
  const d = asStr(idx(unwrapApiArray(approveData), 'data'));
  if (d === undefined) throw new Error("missing 'data' field in approve response");
  return d;
}

// ── next steps ───────────────────────────────────────────────────────

// upstream: swap.rs::history_status_cmd — prefer --tx-hash, else --order-id, else none.
export function historyStatusCmd(chainIndex, txHash, orderId) {
  if (txHash !== '') return `onchainos wallet history --tx-hash ${txHash} --chain ${chainIndex}`;
  if (orderId !== '') return `onchainos wallet history --order-id ${orderId} --chain ${chainIndex}`;
  return null;
}

// upstream: swap.rs::next_steps_for_swap → {checkSwapStatus?, checkApproveStatus?}
export function nextStepsForSwap(chainIndex, swapTxHash, swapOrderId, approveTxHash, approveOrderId) {
  const steps = {};
  const swapCmd = historyStatusCmd(chainIndex, swapTxHash, swapOrderId);
  if (swapCmd !== null) steps.checkSwapStatus = swapCmd;
  const approveCmd = historyStatusCmd(chainIndex, approveTxHash ?? '', approveOrderId ?? '');
  if (approveCmd !== null) steps.checkApproveStatus = approveCmd;
  return steps;
}

// ── balance context (swap quote) ─────────────────────────────────────

// upstream: swap.rs::first_quote_route
const firstQuoteRoute = (quote) => (Array.isArray(quote) ? (quote.length ? quote[0] : undefined) : isJsonObject(quote) ? quote : undefined);

// upstream: swap.rs::quote_from_token_meta → [symbol | undefined, decimals | undefined]
export function quoteFromTokenMeta(quote) {
  const from = idx(firstQuoteRoute(quote), 'fromToken');
  const symbol = asStr(idx(from, 'tokenSymbol'));
  const d = idx(from, 'decimal');
  let decimals;
  if (typeof d === 'string') decimals = parseU32(d);
  else { const v = asU64(d); decimals = v === undefined ? undefined : Number(v & 0xffffffffn); }
  return [symbol, decimals];
}

// upstream: swap.rs::quote_required_from_amount — exactIn: the request amount; exactOut: the
// quote's fromTokenAmount (string or u64).
export function quoteRequiredFromAmount(quote, swapMode, requestAmount) {
  if (swapMode !== 'exactOut') return requestAmount;
  const route = firstQuoteRoute(quote);
  const v = isJsonObject(route) && own(route, 'fromTokenAmount') ? route.fromTokenAmount : undefined;
  return v === undefined ? undefined : valueAsDecimalString(v);
}

// upstream: swap.rs::attach_wallet_balance — walletBalance (string | null) on every object route.
export function attachWalletBalance(quote, walletBalance) {
  const value = some(walletBalance) ? walletBalance : null;
  if (Array.isArray(quote)) { for (const r of quote) if (isJsonObject(r)) r.walletBalance = value; }
  else if (isJsonObject(quote)) quote.walletBalance = value;
}

// upstream: swap.rs::swap_funding_input → funding::FundingBlockedInput
export function swapFundingInput(fromToken, fromSymbol, requestedAmount, walletBalance) {
  return {
    asset: fromSymbol === '' ? fromToken : fromSymbol,
    tokenAddress: fromToken,
    required: requestedAmount,
    balance: walletBalance,
    operation: FUNDING_OPERATION_SWAP,
  };
}

// swap quote balance context + insufficient-balance scene (swap.rs Quote arm).
async function quoteWithBalance(quote, chainIndex, from, swapMode, rawAmount) {
  const resolvedFrom = resolveTokenAddress(chainIndex, from);
  const balanceToken = eqIgnoreAsciiCase(resolvedFrom, nativeTokenAddress(chainIndex)) ? '' : resolvedFrom;
  let walletBalance = null;
  try { walletBalance = (await queryTokenReadableBalance(chainIndex, balanceToken)) ?? null; } catch { walletBalance = null; }
  const required = quoteRequiredFromAmount(quote, swapMode, rawAmount);
  const [symbol, decimals] = quoteFromTokenMeta(quote);
  if (walletBalance !== null && decimals !== undefined && required !== undefined) {
    let insufficient;
    try { insufficient = isAllowanceInsufficient(readableToMinimalStr(walletBalance, decimals), required); } catch { insufficient = false; }
    if (insufficient) {
      let requested;
      try { requested = minimalToReadable(required, decimals); } catch { requested = undefined; }
      if (requested !== undefined) {
        const value = await buildFundingBundle(chainIndex, swapFundingInput(resolvedFrom, symbol ?? '', requested, walletBalance));
        throw new FundingBlocked(value);
      }
    }
  }
  attachWalletBalance(quote, walletBalance);
  return quote;
}

// ── execute orchestration ────────────────────────────────────────────

// upstream: swap.rs::wallet_contract_call — execute_contract_call as the selected account,
// agent_biz_type "dex" → {txHash, orderId}.
async function walletContractCall(to, chain, amt, inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, mevProtection,
  jitoUnsignedTx, gasTokenAddress, relayerId, enableGasStation, force) {
  const resp = await executeContractCall(to, chain, amt, inputData, unsignedTx, gasLimit, undefined, aaDexTokenAddr, aaDexTokenAmount,
    mevProtection, jitoUnsignedTx, force, undefined, gasTokenAddress, relayerId, enableGasStation, 'dex', undefined);
  return { txHash: resp.txHash, orderId: resp.orderId };
}

// upstream: swap.rs::extract_tx_hash / extract_tx_hash_and_order_id
export function extractTxHash(data) {
  const h = asStr(idx(data, 'txHash'));
  if (h === undefined) throw new Error('missing txHash in contract-call output');
  return h;
}
export const extractTxHashAndOrderId = (data) => [extractTxHash(data), asStr(idx(data, 'orderId')) ?? ''];

// Output `data` shared by both execute paths (json! → sorted keys).
function executeOutput(routerResult, approveTxHash, swapTxHash, nextSteps) {
  return {
    approveTxHash: approveTxHash ?? null,
    swapTxHash,
    fromToken: idx(routerResult, 'fromToken'),
    toToken: idx(routerResult, 'toToken'),
    fromAmount: idx(routerResult, 'fromTokenAmount'),
    toAmount: idx(routerResult, 'toTokenAmount'),
    priceImpact: idx(routerResult, 'priceImpactPercent'),
    gasUsed: idx(routerResult, 'estimateGasFee'),
    nextSteps,
  };
}

// Approve lookup shared by both paths: calldata (required), spender (optional), allowance gate.
async function approvalFacts(client, chainIndex, fromToken, amount, walletAddress) {
  const approveObj = unwrapApiArray(await fetchApprove(client, chainIndex, fromToken, amount));
  const approveCalldata = asStr(idx(approveObj, 'data'));
  if (approveCalldata === undefined) throw new Error("missing 'data' field in approve response");
  const dexContractAddress = asStr(idx(approveObj, 'dexContractAddress'));
  const approvals = await fetchCheckApprovals(client, chainIndex, walletAddress, fromToken, dexContractAddress);
  const first = Array.isArray(approvals) && approvals.length ? approvals[0] : undefined;
  const tokens = idx(first, 'tokens');
  const spendable = asStr(idx(Array.isArray(tokens) && tokens.length ? tokens[0] : undefined, 'spendable')) ?? '0';
  const [needsApprove, needsRevoke] = classifyApproveAction(chainIndex, fromToken, spendable, amount);
  return { approveCalldata, needsApprove, needsRevoke };
}

// upstream: swap.rs::is_chain_batch_supported — any failure → false (single-tx fallback).
async function isChainBatchSupported(chainIndex) {
  let accessToken;
  try { accessToken = await ensureTokensRefreshed(); } catch { return false; }
  try {
    const list = await new WalletApiClient().batchSupportChainIndexList(accessToken);
    return list.some((c) => c === chainIndex);
  } catch {
    return false;
  }
}

// upstream: swap.rs::cmd_execute — single-tx path (and routing to the batch path). Prints the
// result itself (output::success) and returns it.
export async function cmdExecute(client, fromToken, toToken, amount, chain, walletAddress, slippage, gasLevel, swapMode, tips,
  maxAutoSlippage, mevProtection, gasTokenAddress, relayerId, enableGasStation, force) {
  const chainIndex = resolveChain(chain);
  const family = chainFamily(chainIndex);
  const nativeAddr = nativeTokenAddress(chainIndex);
  const from = resolveTokenAddress(chainIndex, fromToken);
  const to = resolveTokenAddress(chainIndex, toToken);
  validateSwapParams(chainIndex, from, to);
  const isFromNative = eqIgnoreAsciiCase(from, nativeAddr);

  const batchSupported = !isFromNative && !enableGasStation && !some(gasTokenAddress) && !some(relayerId) && await isChainBatchSupported(chainIndex);
  if (batchSupported) {
    return cmdExecuteBatch(client, from, to, amount, chainIndex, walletAddress, slippage, gasLevel, swapMode, tips, maxAutoSlippage, mevProtection, force);
  }

  // enableGasStation only on the first gas-consuming tx of the flow.
  let gsEnableRemaining = enableGasStation;
  const takeGsEnable = () => { const v = gsEnableRemaining; gsEnableRemaining = false; return v; };

  let approveTxHash = null;
  let approveOrderId = null;
  if (family === 'evm' && !isFromNative) {
    const { approveCalldata, needsApprove, needsRevoke } = await approvalFacts(client, chainIndex, from, amount, walletAddress);
    if (needsApprove) {
      if (needsRevoke) {
        const revokeCalldata = extractApproveCalldata(await fetchApprove(client, chainIndex, from, '0'));
        const result = await walletContractCall(from, chainIndex, '0', revokeCalldata, undefined, undefined, undefined, undefined, false,
          undefined, gasTokenAddress, relayerId, takeGsEnable(), force);
        await waitTxOnchain(client, extractTxHash(result), chainIndex);
      }
      const result = await walletContractCall(from, chainIndex, '0', approveCalldata, undefined, undefined, undefined, undefined, false,
        undefined, gasTokenAddress, relayerId, takeGsEnable(), force);
      const [txHash, orderId] = extractTxHashAndOrderId(result);
      await waitTxOnchain(client, txHash, chainIndex);
      approveTxHash = txHash;
      if (orderId !== '') approveOrderId = orderId;
    }
  }

  const swapData = await fetchSwap(client, chainIndex, from, to, amount, slippage, walletAddress, swapMode, gasLevel, tips, maxAutoSlippage);
  const swapResult = unwrapApiArray(swapData);
  if (swapResult === null) throw new Error('swap API returned empty result');
  const tx = idx(swapResult, 'tx');

  let swapTxHash, swapOrderId;
  if (family === 'solana') {
    const unsignedTx = asStr(idx(tx, 'data'));
    if (unsignedTx === undefined) throw new Error('missing tx.data (unsigned tx) in swap response');
    const toAddr = asStr(idx(tx, 'to')) ?? '';
    const jitoTx = jitoCalldata(tx);
    const effectiveMev = jitoTx !== undefined || mevProtection;
    const result = await walletContractCall(toAddr, chainIndex, '0', undefined, unsignedTx, undefined, undefined, undefined, effectiveMev,
      jitoTx, gasTokenAddress, relayerId, takeGsEnable(), force);
    [swapTxHash, swapOrderId] = extractTxHashAndOrderId(result);
  } else {
    const toAddr = asStr(idx(tx, 'to'));
    if (toAddr === undefined) throw new Error('missing tx.to in swap response');
    const inputData = asStr(idx(tx, 'data'));
    if (inputData === undefined) throw new Error('missing tx.data in swap response');
    const txValueWei = asStr(idx(tx, 'value')) ?? '0';
    const gasLimit = asStr(idx(tx, 'gas'));
    let aaAddr, aaAmount;
    if (chainIndex === '196' || chainIndex === '1952') {
      aaAddr = from;
      aaAmount = asStr(idx(idx(swapResult, 'routerResult'), 'fromTokenAmount')) ?? amount;
    }
    const result = await walletContractCall(toAddr, chainIndex, txValueWei, inputData, undefined, gasLimit, aaAddr, aaAmount, mevProtection,
      undefined, gasTokenAddress, relayerId, takeGsEnable(), force);
    [swapTxHash, swapOrderId] = extractTxHashAndOrderId(result);
  }

  const nextSteps = nextStepsForSwap(chainIndex, swapTxHash, swapOrderId, approveTxHash, approveOrderId);
  const out = executeOutput(idx(swapResult, 'routerResult'), approveTxHash, swapTxHash, nextSteps);
  if (approveOrderId !== null) out.approveOrderId = approveOrderId;
  if (swapOrderId !== '') out.swapOrderId = swapOrderId;
  success(out);
  return out;
}

// Jito MEV: tx.signatureData[0] is a JSON string carrying `jitoCalldata`.
function jitoCalldata(tx) {
  const sd = idx(tx, 'signatureData');
  const s = Array.isArray(sd) && sd.length ? asStr(sd[0]) : undefined;
  if (s === undefined) return undefined;
  let v;
  try { v = parse(s); } catch { return undefined; }
  return asStr(idx(v, 'jitoCalldata'));
}

// upstream: swap.rs::cmd_execute_batch — [revoke?, approve, swap] through one batch unsignedInfo
// + batch broadcast (or a plain contract call when no approval is needed).
async function cmdExecuteBatch(client, fromToken, toToken, amount, chainIndex, walletAddress, slippage, gasLevel, swapMode, tips,
  maxAutoSlippage, mevProtection, force) {
  const { approveCalldata, needsApprove, needsRevoke } = await approvalFacts(client, chainIndex, fromToken, amount, walletAddress);

  const swapData = await fetchSwap(client, chainIndex, fromToken, toToken, amount, slippage, walletAddress, swapMode, gasLevel, tips, maxAutoSlippage);
  const swapResult = unwrapApiArray(swapData);
  if (swapResult === null) throw new Error('swap API returned empty result');
  const swapTx = idx(swapResult, 'tx');
  const swapTo = asStr(idx(swapTx, 'to'));
  if (swapTo === undefined) throw new Error('missing tx.to in swap response');
  const swapInputData = asStr(idx(swapTx, 'data'));
  if (swapInputData === undefined) throw new Error('missing tx.data in swap response');
  const swapValueWei = asStr(idx(swapTx, 'value')) ?? '0';
  const swapGasLimit = asStr(idx(swapTx, 'gas'));
  const routerResult = idx(swapResult, 'routerResult');

  let aaAddr, aaAmount;
  if (chainIndex === '196') {
    aaAddr = fromToken;
    aaAmount = asStr(idx(routerResult, 'fromTokenAmount')) ?? amount;
  }

  if (!needsApprove && !needsRevoke) {
    const result = await walletContractCall(swapTo, chainIndex, swapValueWei, swapInputData, undefined, swapGasLimit, aaAddr, aaAmount,
      mevProtection, undefined, undefined, undefined, false, force);
    const swapTxHash = extractTxHash(result);
    const out = executeOutput(routerResult, null, swapTxHash, nextStepsForSwap(chainIndex, swapTxHash, '', null, null));
    success(out);
    return out;
  }

  const txs = [];
  if (needsRevoke) {
    const revokeCalldata = extractApproveCalldata(await fetchApprove(client, chainIndex, fromToken, '0'));
    txs.push(batchTxParams({ toAddr: fromToken, value: '0', contractAddr: fromToken, inputData: revokeCalldata }));
  }
  txs.push(batchTxParams({ toAddr: fromToken, value: '0', contractAddr: fromToken, inputData: approveCalldata }));
  txs.push(batchTxParams({ toAddr: swapTo, value: swapValueWei, contractAddr: swapTo, inputData: swapInputData, gasLimit: swapGasLimit, aaDexTokenAddr: aaAddr, aaDexTokenAmount: aaAmount }));

  const responses = await batchSignAndBroadcast(chainIndex, walletAddress, txs, true, mevProtection, force, undefined, 'dex', 'okx-dex-swap-batch');
  const merging = mergesBatchUnsignedInfo(chainIndex);
  const lengthOk = merging ? responses.length === 1 || responses.length === txs.length : responses.length === txs.length;
  if (!lengthOk) {
    throw new Error(`batch broadcast on chain ${chainIndex}: response length ${responses.length} not in expected set (request length ${txs.length}, merging chain=${merging})`);
  }
  const [approveTxHash, swapTxHash] = extractBatchHashes(responses.map((r) => r.txHash), needsApprove, needsRevoke);
  const out = executeOutput(routerResult, approveTxHash, swapTxHash, nextStepsForSwap(chainIndex, swapTxHash, '', approveTxHash, null));
  success(out);
  return out;
}

// ── CLI handlers (swap.rs::execute) ──────────────────────────────────

export default {
  'swap quote': {
    uses: ['from', 'to', 'amount', 'readableAmount', 'chain', 'swapMode'],
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = resolveChain(o.chain);
      ensureSupportedChain(chainIndex, o.chain);
      const rawAmount = await resolveAmountArg(client, o.amount, o.readableAmount, o.from, chainIndex);
      const quote = await fetchQuote(client, chainIndex, o.from, o.to, rawAmount, o.swapMode);
      classifySwapResponse(quote);
      return quoteWithBalance(quote, chainIndex, o.from, o.swapMode, rawAmount);
    },
  },
  'swap swap': {
    uses: ['from', 'to', 'amount', 'readableAmount', 'chain', 'slippage', 'wallet', 'gasLevel', 'swapMode', 'tips', 'maxAutoSlippage'],
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = resolveChain(o.chain);
      ensureSupportedChain(chainIndex, o.chain);
      const rawAmount = await resolveAmountArg(client, o.amount, o.readableAmount, o.from, chainIndex);
      const swap = await fetchSwap(client, chainIndex, o.from, o.to, rawAmount, o.slippage, o.wallet, o.swapMode, o.gasLevel, o.tips, o.maxAutoSlippage);
      classifySwapResponse(swap);
      return swap;
    },
  },
  'swap approve': {
    uses: ['token', 'amount', 'chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = resolveChain(o.chain);
      ensureSupportedChain(chainIndex, o.chain);
      return fetchApprove(client, chainIndex, o.token, o.amount);
    },
  },
  'swap check-approvals': {
    uses: ['chain', 'address', 'token', 'spender'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchCheckApprovals(client, resolveChain(o.chain), o.address, o.token, o.spender);
    },
  },
  'swap chains': {
    uses: [],
    async run(ctx) {
      return fetchChains(await ctx.api());
    },
  },
  'swap liquidity': {
    uses: ['chain'],
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = resolveChain(o.chain);
      ensureSupportedChain(chainIndex, o.chain);
      return fetchLiquidity(client, chainIndex);
    },
  },
  'swap execute': {
    uses: ['from', 'to', 'amount', 'readableAmount', 'chain', 'wallet', 'slippage', 'gasLevel', 'swapMode', 'tips', 'maxAutoSlippage',
      'mevProtection', 'gasTokenAddress', 'relayerId', 'enableGasStation', 'force', 'notifyJobId'],
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = resolveChain(o.chain);
      const run = async () => {
        ensureSupportedChain(chainIndex, o.chain);
        const rawAmount = await resolveAmountArg(client, o.amount, o.readableAmount, o.from, chainIndex);
        return cmdExecute(client, o.from, o.to, rawAmount, o.chain, o.wallet, o.slippage, o.gasLevel, o.swapMode, o.tips, o.maxAutoSlippage,
          o.mevProtection, o.gasTokenAddress, o.relayerId, o.enableGasStation, o.force);
      };
      if (!some(o.notifyJobId)) {
        await run();
        return NO_OUTPUT;
      }
      const displayAmount = o.readableAmount ?? o.amount ?? '?';
      // autotrade::notify::notify_swap_outcome — imported on first use (agent autotrade graph)
      const { notifySwapOutcome } = await import('../../agent/task/common/autotrade/notify.mjs');
      let out;
      try {
        out = await run();
      } catch (e) {
        await notifySwapOutcome(o.notifyJobId, o.chain, displayAmount, o.from, o.to, { err: e });
        throw e;
      }
      await notifySwapOutcome(o.notifyJobId, o.chain, displayAmount, o.from, o.to, { ok: out });
      return NO_OUTPUT;
    },
  },
};
