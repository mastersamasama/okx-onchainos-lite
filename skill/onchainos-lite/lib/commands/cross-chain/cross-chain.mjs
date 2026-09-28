// cross-chain — upstream cli/src/commands/cross_chain.rs: /api/v6/dex/cross-chain fetch helpers
// (shared with MCP), the no-direct-route transit fallback, the bridges/tokens/quote/approve/
// swap/status handlers and the fund-moving `cross-chain execute` flow
// (balance gate → quote → [revoke] → approve → bridge tx → sign → broadcast).
// Exported fns mirror upstream (camelCase of the Rust fn, same parameter order).
import { resolveChain, ensureSupportedChain, chainFamily, nativeTokenAddress } from '../../core/chains.mjs';
import { resolveAndValidate, validateAddressForChain } from '../../core/token-alias.mjs';
import { validateSlippageZeroToOne, validateNonNegativeInteger } from '../../core/validators.mjs';
import { waitTxOnchain } from '../../core/common.mjs';
import { trim, eqIgnoreAsciiCase, asciiUpper } from '../../core/_rust-str.mjs';
import { WalletApiClient, displayTop } from '../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { loadWallets } from '../../wallet/store.mjs';
import { ERR_NOT_LOGGED_IN } from '../../wallet/common.mjs';
import { executeContractCall } from '../../wallet/transfer/index.mjs';
import { fetchAllBalances } from '../portfolio/portfolio.mjs';
import {
  fetchQuote as fetchSwapQuote, resolveAmountArg, readableViaTokenInfo, isAllowanceInsufficient, unwrapApiArray,
  idx, asStr, isJsonObject, extractTxHash, extractTxHashAndOrderId,
} from '../swap/swap.mjs';
import { clap } from '../swap/_clap.mjs';

const V6_PREFIX = '/api/v6/dex/cross-chain';
const some = (v) => v !== undefined && v !== null;

// upstream: cross_chain.rs::unwrap_data_array (same semantics as swap.rs::unwrap_api_array)
export const unwrapDataArray = unwrapApiArray;

// Comma-separated bridge ids → trimmed, non-empty ids (repeated query params).
const splitIds = (s) => (some(s) ? String(s).split(',').map(trim).filter((x) => x !== '') : []);

// ── HTTP layer ───────────────────────────────────────────────────────

// upstream: cross_chain.rs::fetch_supported_tokens
export function fetchSupportedTokens(client, fromChainIndex, toChainIndex) {
  const q = [];
  if (some(fromChainIndex)) q.push(['fromChainIndex', fromChainIndex]);
  if (some(toChainIndex)) q.push(['toChainIndex', toChainIndex]);
  return client.get(`${V6_PREFIX}/supported/tokens`, q);
}

// upstream: cross_chain.rs::fetch_supported_bridges
export function fetchSupportedBridges(client, fromChainIndex, toChainIndex) {
  const q = [];
  if (some(fromChainIndex)) q.push(['fromChainIndex', fromChainIndex]);
  if (some(toChainIndex)) q.push(['toChainIndex', toChainIndex]);
  return client.get(`${V6_PREFIX}/supported/bridges`, q);
}

// upstream: cross_chain.rs::fetch_quote — GET /api/v6/dex/cross-chain/quote
export function fetchQuote(client, fromChain, toChain, fromToken, toToken, rawAmount, slippage, wallet, checkApprove, bridgeId, sort,
  allowBridges, denyBridges, receiveAddress) {
  const q = [
    ['fromChainIndex', fromChain], ['toChainIndex', toChain], ['fromTokenAddress', fromToken], ['toTokenAddress', toToken],
    ['amount', rawAmount], ['slippage', slippage],
  ];
  if (some(wallet)) q.push(['userWalletAddress', wallet]);
  if (some(receiveAddress)) q.push(['receiveAddress', receiveAddress]);
  if (checkApprove) q.push(['checkApprove', 'true']);
  if (some(bridgeId)) q.push(['bridgeId', bridgeId]);
  if (some(sort)) q.push(['sort', sort]);
  for (const id of splitIds(allowBridges)) q.push(['allowBridge', id]);
  for (const id of splitIds(denyBridges)) q.push(['denyBridge', id]);
  return client.get(`${V6_PREFIX}/quote`, q);
}

// upstream: cross_chain.rs::fetch_approve_tx — GET /api/v6/dex/cross-chain/approve-tx
export function fetchApproveTx(client, chainIndex, token, wallet, bridgeId, approveAmount, checkAllowance) {
  const q = [['chainIndex', chainIndex], ['tokenContractAddress', token], ['userWalletAddress', wallet], ['bridgeId', bridgeId], ['approveAmount', approveAmount]];
  if (checkAllowance) q.push(['checkAllowance', 'true']);
  return client.get(`${V6_PREFIX}/approve-tx`, q);
}

// upstream: cross_chain.rs::fetch_swap — GET /api/v6/dex/cross-chain/swap
export function fetchSwap(client, fromChain, toChain, fromToken, toToken, rawAmount, slippage, wallet, receiveAddress, bridgeId, sort,
  allowBridges, denyBridges) {
  const q = [
    ['fromChainIndex', fromChain], ['toChainIndex', toChain], ['fromTokenAddress', fromToken], ['toTokenAddress', toToken],
    ['amount', rawAmount], ['slippage', slippage], ['userWalletAddress', wallet],
  ];
  if (some(receiveAddress)) q.push(['receiveAddress', receiveAddress]);
  if (some(bridgeId)) q.push(['bridgeId', bridgeId]);
  if (some(sort)) q.push(['sort', sort]);
  for (const id of splitIds(allowBridges)) q.push(['allowBridge', id]);
  for (const id of splitIds(denyBridges)) q.push(['denyBridge', id]);
  return client.get(`${V6_PREFIX}/swap`, q);
}

// upstream: cross_chain.rs::fetch_status — GET /api/v6/dex/cross-chain/status + mismatch warning
export async function fetchStatus(client, txHash, chainIndex, bridgeId) {
  const q = [['hash', txHash]];
  if (some(chainIndex)) q.push(['chainIndex', chainIndex]);
  if (some(bridgeId)) q.push(['bridgeId', bridgeId]);
  return annotateBridgeIdMismatch(await client.get(`${V6_PREFIX}/status`, q), bridgeId);
}

// serde_json Value::as_i64
const asI64 = (v) => ((typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n) ? v : undefined);

// upstream: cross_chain.rs::annotate_bridge_id_mismatch — `_warning` on rows whose echoed
// bridgeId (string or i64) differs from the requested one.
export function annotateBridgeIdMismatch(resp, requested) {
  if (!some(requested) || !Array.isArray(resp)) return resp;
  for (const item of resp) {
    const b = idx(item, 'bridgeId');
    const echoed = typeof b === 'string' ? b : asI64(b) !== undefined ? String(b) : undefined;
    if (echoed !== undefined && echoed !== requested && isJsonObject(item)) {
      item._warning = `server-side bridgeId mismatch: requested ${requested}, response echoed ${echoed}. Trust the bridgeName from your own quote/execute record.`;
    }
  }
  return resp;
}

// upstream: cross_chain.rs::resolve_order_id_to_tx_hash — wallet /order/detail (login required).
export async function resolveOrderIdToTxHash(orderId, chainIndex) {
  const accessToken = await ensureTokensRefreshed();
  const wallets = loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  if (wallets.selectedAccountId === '') throw new Error(ERR_NOT_LOGGED_IN);
  const data = await new WalletApiClient().getAuthed('/priapi/v5/wallet/agentic/order/detail', accessToken,
    [['accountId', wallets.selectedAccountId], ['chainIndex', chainIndex], ['orderId', orderId]]);
  const txHash = asStr(idx(Array.isArray(data) && data.length ? data[0] : undefined, 'txHash'));
  if (txHash === undefined || txHash === '') throw new Error(`order-id ${orderId} not found on chain ${chainIndex} (no txHash in /order/detail)`);
  return txHash;
}

// ── validation ───────────────────────────────────────────────────────

// upstream: cross_chain.rs::validate_receive_address — address family must match --to-chain.
export function validateReceiveAddress(receiveAddress, toChainIndex) {
  const toFamily = chainFamily(toChainIndex);
  const len = Buffer.byteLength(receiveAddress, 'utf8');
  const looksEvm = receiveAddress.startsWith('0x') && len === 42;
  const looksSolana = !receiveAddress.startsWith('0x') && len >= 32 && len <= 44 && /^[\p{Alphabetic}\p{N}]*$/u.test(receiveAddress);
  if (toFamily === 'solana' && looksEvm) {
    throw new Error('receive-address looks like an EVM address, but destination chain is Solana. Please provide a Solana address.');
  }
  if (toFamily === 'evm' && looksSolana && !looksEvm) {
    throw new Error('receive-address looks like a Solana address, but destination chain is EVM. Please provide an EVM address (0x...).');
  }
}

// upstream: cross_chain.rs::is_canonical_zero_str — "0" or "0." followed by ≥1 zeros only.
export const isCanonicalZeroStr = (s) => s === '0' || (s.startsWith('0.') && s.length > 2 && /^0+$/.test(s.slice(2)));

// upstream: cross_chain.rs::resolve_approve_amount — raw --amount ("0" allowed) or
// --readable-amount (canonical zero → "0" without HTTP; else basic-info decimals of `token`).
export async function resolveApproveAmount(client, amount, readableAmount, token, chainIndex) {
  if (some(amount)) {
    const raw = trim(amount);
    validateNonNegativeInteger(raw, 'amount');
    return raw;
  }
  if (some(readableAmount)) {
    const readable = trim(readableAmount);
    if (readable === '') throw new Error('--readable-amount must not be empty');
    if (isCanonicalZeroStr(readable)) return '0';
    return readableViaTokenInfo(client, readable, token, chainIndex);
  }
  throw new Error('either --amount or --readable-amount is required');
}

// ── transit fallback ─────────────────────────────────────────────────

const TRANSIT_PREFERENCE = ['usdc', 'usdt', 'dai'];

// upstream: cross_chain.rs::parse_api_error — `…code=<c>)<: msg>` → [code, msg] | null
export function parseApiError(s) {
  const at = s.indexOf('code=');
  if (at < 0) return null;
  const rest = s.slice(at + 'code='.length);
  const close = rest.indexOf(')');
  if (close < 0) return null;
  return [trim(rest.slice(0, close)), trim(rest.slice(close + 1).replace(/^:+/, ''))];
}

// upstream: cross_chain.rs::api_error_msg — envelope msg, else the error's Display text.
export function apiErrorMsg(e) {
  const s = displayTop(e);
  const p = parseApiError(s);
  return p ? p[1] : s;
}

// upstream: cross_chain.rs::is_no_route — res = { ok: data } | { err: Error }
export function isNoRoute(res) {
  if ('ok' in res) {
    const list = idx(unwrapDataArray(res.ok), 'routerList');
    return Array.isArray(list) ? list.length === 0 : true;
  }
  const p = parseApiError(displayTop(res.err));
  return !!p && (p[0] === '82000' || p[0] === '82104');
}

// upstream: cross_chain.rs::bridgeable_source_addresses — lowercased source-chain addresses.
export function bridgeableSourceAddresses(tokens, fromIdx) {
  const set = new Set();
  if (!Array.isArray(tokens)) return set;
  for (const t of tokens) {
    if (asStr(idx(t, 'chainIndex')) !== fromIdx) continue;
    const a = asStr(idx(t, 'tokenContractAddress'));
    if (a !== undefined) set.add(a.toLowerCase());
  }
  return set;
}

// upstream: cross_chain.rs::build_transit_candidates → [{symbol, address, destAddress}]
export function buildTransitCandidates(fromIdx, toIdx, bridgeable) {
  const raw = [];
  for (const sym of TRANSIT_PREFERENCE) {
    let address, destAddress;
    try {
      address = resolveAndValidate(fromIdx, sym, 'transit');
      destAddress = resolveAndValidate(toIdx, sym, 'transit');
    } catch { continue; }
    raw.push({ symbol: asciiUpper(sym), address, destAddress });
  }
  raw.push({ symbol: 'NATIVE', address: nativeTokenAddress(fromIdx), destAddress: nativeTokenAddress(toIdx) });
  const seen = new Set();
  return raw
    .filter((c) => { const k = c.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .filter((c) => bridgeable.size === 0 || bridgeable.has(c.address.toLowerCase()));
}

// upstream: cross_chain.rs::build_transit_option — first route of a transit bridge quote.
export function buildTransitOption(symbol, bridgeQuote) {
  const obj = unwrapDataArray(bridgeQuote);
  const list = idx(obj, 'routerList');
  if (!Array.isArray(list) || !list.length) return null;
  const route = list[0];
  return {
    transitToken: symbol,
    bridgeName: idx(route, 'bridgeName'),
    bridgeId: idx(route, 'bridgeId'),
    toTokenAmount: idx(route, 'toTokenAmount'),
    minimumReceived: idx(route, 'minimumReceived'),
    crossChainFee: idx(route, 'crossChainFee'),
    crossChainFeeTokenAddress: idx(route, 'crossChainFeeTokenAddress'),
    otherNativeFee: idx(route, 'otherNativeFee'),
    estimateTime: idx(route, 'estimateTime'),
    toTokenDecimals: idx(idx(obj, 'toToken'), 'decimals'),
  };
}

// upstream: cross_chain.rs::bridge_forces_mev — relay / mayan / butterswap bundle a swap leg.
export function bridgeForcesMev(bridgeName) {
  const n = bridgeName.toLowerCase();
  return n.includes('relay') || n.includes('mayan') || n.includes('butterswap');
}

// upstream: cross_chain.rs::raw_balance_for — rawBalance of the first asset matching `address`
// (ASCII case-insensitive), "0" when absent or not a string.
export function rawBalanceFor(assets, address) {
  const hit = (Array.isArray(assets) ? assets : []).find((a) => {
    const s = asStr(idx(a, 'tokenContractAddress'));
    return s !== undefined && eqIgnoreAsciiCase(s, address);
  });
  return asStr(idx(hit, 'rawBalance')) ?? '0';
}

// upstream: cross_chain.rs::classify_dead_end → [outcome, message]
export function classifyDeadEnd(errors) {
  const informative = errors.filter((m) => { const t = trim(m); return t !== '' && t !== 'unknown error'; });
  if (!informative.length) {
    return ['env_unavailable', 'Bridge service appears unavailable for this chain pair on this environment — the pair is in the routing config but quote returns no reason across the direct route and every transit token. Typically a server-side / adapter issue, not your token or amount. Retry later or escalate to OKX support.'];
  }
  return ['no_path', informative[0]];
}

class ProbeError extends Error {}

// upstream: cross_chain.rs::probe_transit — leg 1 source→transit swap quote (skipped when the
// source already is the transit), leg 2 transit bridge quote. Throws ProbeError(msg).
async function probeTransit(client, fromIdx, toIdx, fromToken, cand, rawAmount, slippage) {
  let transitAmount;
  if (eqIgnoreAsciiCase(fromToken, cand.address)) transitAmount = rawAmount;
  else {
    let swapQ;
    try { swapQ = await fetchSwapQuote(client, fromIdx, fromToken, cand.address, rawAmount, ''); } catch (e) { throw new ProbeError(apiErrorMsg(e)); }
    transitAmount = asStr(idx(unwrapDataArray(swapQ), 'toTokenAmount'));
    if (transitAmount === undefined) throw new ProbeError('source→transit swap returned no amount');
  }
  let bridgeQ;
  try {
    bridgeQ = await fetchQuote(client, fromIdx, toIdx, cand.address, cand.destAddress, transitAmount, slippage, undefined, false);
  } catch (e) { throw new ProbeError(apiErrorMsg(e)); }
  const opt = buildTransitOption(cand.symbol, bridgeQ);
  if (opt === null) throw new ProbeError('transit bridge quote returned no route');
  return opt;
}

// upstream: cross_chain.rs::discover_transit_fallback — never throws.
export async function discoverTransitFallback(client, fromIdx, toIdx, fromToken, rawAmount, slippage) {
  let bridgeable = new Set();
  try { bridgeable = bridgeableSourceAddresses(await fetchSupportedTokens(client, fromIdx, toIdx), fromIdx); } catch { bridgeable = new Set(); }
  const candidates = buildTransitCandidates(fromIdx, toIdx, bridgeable);
  if (!candidates.length) {
    return { outcome: 'no_path', transitOptions: [], message: 'No common transit token (USDC / USDT / DAI / native) is bridgeable from this source chain.' };
  }
  const options = [];
  const errors = [];
  for (const cand of candidates) {
    try {
      options.push(await probeTransit(client, fromIdx, toIdx, fromToken, cand, rawAmount, slippage));
    } catch (e) {
      if (!(e instanceof ProbeError)) throw e;
      errors.push(e.message);
    }
  }
  if (!options.length) {
    const [outcome, message] = classifyDeadEnd(errors);
    return { outcome, transitOptions: [], message };
  }
  return { outcome: 'transit_available', transitOptions: options };
}

// Rust `Result<Value>` of a quote call → { ok } | { err }
const settle = (p) => p.then((ok) => ({ ok }), (err) => ({ err }));
const unwrapResult = (r) => { if ('err' in r) throw r.err; return r.ok; };

// ── execute ──────────────────────────────────────────────────────────

// upstream: cross_chain.rs::execute_balance_block → [blockCode, message] | null (proceed)
async function executeBalanceBlock(client, fromIdx, wallet, fromToken, nativeAddr, rawAmount, isFromNative) {
  let balances;
  try { balances = await fetchAllBalances(client, wallet, fromIdx, undefined, undefined); } catch { return null; }
  const assets = idx(unwrapDataArray(balances), 'tokenAssets');
  if (!Array.isArray(assets)) return null;
  if (isAllowanceInsufficient(rawBalanceFor(assets, fromToken), rawAmount)) {
    return ['insufficient_balance', 'Source token balance is less than the amount you want to bridge.'];
  }
  if (!isFromNative) {
    let nativeRaw = rawBalanceFor(assets, nativeAddr);
    if (nativeRaw === '0') nativeRaw = rawBalanceFor(assets, '');
    if (nativeRaw === '0' || nativeRaw === '') {
      return ['insufficient_gas', 'Source-chain native (gas) balance is zero — deposit native token for gas before bridging.'];
    }
  }
  return null;
}

// upstream: cross_chain.rs::extract_bridge_id — i64 or string routerList[].bridgeId
export function extractBridgeId(route) {
  const b = idx(route, 'bridgeId');
  if (asI64(b) !== undefined) return String(b);
  if (typeof b === 'string') return b;
  throw new Error('quote.routerList[0].bridgeId missing or wrong type');
}

// upstream: cross_chain.rs::wallet_contract_call — family-aware execute_contract_call as the
// selected account (tx_source "3", agent_biz_type "cross-chain") → {txHash, orderId}.
async function walletContractCall(to, chain, amt, inputData, gasLimit, mevProtection, force) {
  const solana = chainFamily(chain) === 'solana';
  const resp = await executeContractCall(to, chain, solana ? '0' : amt, solana ? undefined : inputData, solana ? inputData : undefined,
    solana ? undefined : gasLimit, undefined, undefined, undefined, mevProtection, undefined, force, '3', undefined, undefined, false,
    'cross-chain', undefined);
  return { txHash: resp.txHash, orderId: resp.orderId };
}

// upstream: cross_chain.rs::next_steps_for_bridge
export function nextStepsForBridge(bridgeId, fromChainIndex, fromTxHash) {
  return { checkBridgeStatus: `onchainos cross-chain status --tx-hash ${fromTxHash} --bridge-id ${bridgeId} --from-chain ${fromChainIndex}` };
}

// upstream: cross_chain.rs::build_execute_data — default-path output (json! → sorted keys).
export function buildExecuteData(route, resolvedBridgeId, fromChainIndex, fromTxHash, swapOrderId, approveTxHash, approveOrderId) {
  const out = {
    action: 'execute',
    fromTxHash,
    bridgeId: resolvedBridgeId,
    bridgeName: idx(route, 'bridgeName'),
    fromChainIndex,
    minimumReceived: idx(route, 'minimumReceived'),
    toTokenAmount: idx(route, 'toTokenAmount'),
    crossChainFee: idx(route, 'crossChainFee'),
    estimateTime: idx(route, 'estimateTime'),
    nextSteps: nextStepsForBridge(resolvedBridgeId, fromChainIndex, fromTxHash),
  };
  if (swapOrderId !== '') out.swapOrderId = swapOrderId;
  if (some(approveTxHash)) out.approveTxHash = approveTxHash;
  if (some(approveOrderId)) out.approveOrderId = approveOrderId;
  return out;
}

// Revoke (approve 0) leg: lenient on the `tx` shape (non-object → skipped). Returns the hash.
async function revokeLeg(client, fromIdx, fromToken, wallet, bridgeId, force) {
  const revokeObj = unwrapDataArray(await fetchApproveTx(client, fromIdx, fromToken, wallet, bridgeId, '0', false));
  const tx = idx(revokeObj, 'tx');
  if (!isJsonObject(tx)) return null;
  const calldata = asStr(idx(tx, 'data'));
  if (calldata === undefined) throw new Error('missing tx.data in revoke approve-tx');
  const result = await walletContractCall(fromToken, fromIdx, '0', calldata, asStr(idx(tx, 'gasLimit')), false, force);
  return extractTxHash(result);
}

// Approve leg: strict `tx` shape → [txHash, orderId].
async function approveLeg(client, fromIdx, fromToken, wallet, bridgeId, rawAmount, force) {
  const approveObj = unwrapDataArray(await fetchApproveTx(client, fromIdx, fromToken, wallet, bridgeId, rawAmount, false));
  const tx = idx(approveObj, 'tx');
  if (!isJsonObject(tx)) throw new Error('/approve-tx returned null tx — sanity check failed');
  const calldata = asStr(idx(tx, 'data'));
  if (calldata === undefined) throw new Error('missing tx.data in approve-tx response');
  const result = await walletContractCall(fromToken, fromIdx, '0', calldata, asStr(idx(tx, 'gasLimit')), false, force);
  return extractTxHashAndOrderId(result);
}

// upstream: cross_chain.rs::cmd_execute → the `data` printed by output::success.
export async function cmdExecute(client, from, to, fromChain, toChain, amount, readableAmount, slippage, wallet, receiveAddress, bridgeId,
  routeIndex, sort, allowBridges, denyBridges, mevProtection, confirmApprove, skipApprove, force) {
  const fromIdx = resolveChain(fromChain);
  const toIdx = resolveChain(toChain);
  ensureSupportedChain(fromIdx, fromChain);
  ensureSupportedChain(toIdx, toChain);
  const fromToken = resolveAndValidate(fromIdx, from, 'from');
  const toToken = resolveAndValidate(toIdx, to, 'to');
  validateAddressForChain(fromIdx, wallet, 'wallet');
  if (some(receiveAddress)) validateReceiveAddress(receiveAddress, toIdx);
  validateSlippageZeroToOne(slippage);
  const rawAmount = await resolveAmountArg(client, amount, readableAmount, from, fromIdx);

  const family = chainFamily(fromIdx);
  const nativeAddr = nativeTokenAddress(fromIdx);
  const isFromNative = eqIgnoreAsciiCase(fromToken, nativeAddr);

  // Step 0 — balance gate
  const block = await executeBalanceBlock(client, fromIdx, wallet, fromToken, nativeAddr, rawAmount, isFromNative);
  if (block) return { action: 'blocked', block: block[0], message: block[1] };

  // Step 1 — quote
  const quoteRes = await settle(fetchQuote(client, fromIdx, toIdx, fromToken, toToken, rawAmount, slippage, wallet, true, bridgeId, sort,
    allowBridges, denyBridges, receiveAddress));
  if (isNoRoute(quoteRes)) {
    const fallback = await discoverTransitFallback(client, fromIdx, toIdx, fromToken, rawAmount, slippage);
    return { action: 'fallback', routerList: [], fallback };
  }
  const quoteObj = unwrapDataArray(unwrapResult(quoteRes));
  const routerList = idx(quoteObj, 'routerList');
  if (!Array.isArray(routerList) || !routerList.length) throw new Error('/quote returned empty routerList — no available route');
  const picked = some(routeIndex) ? routeIndex : 0;
  if (BigInt(picked) >= BigInt(routerList.length)) {
    throw new Error(`--route-index ${picked} out of bounds: routerList has ${routerList.length} entries`);
  }
  const route = routerList[Number(picked)];
  const resolvedBridgeId = extractBridgeId(route);
  const needApprove = idx(route, 'needApprove') === true;
  const needCancelApprove = idx(route, 'needCancelApprove') === true;

  // Step 2 — approve branch
  let approveTxHash = null;
  let approveOrderId = null;
  const approveBranch = family === 'evm' && !isFromNative && needApprove && !skipApprove;

  if (approveBranch && !confirmApprove) {
    if (needCancelApprove) {
      const revokeHash = await revokeLeg(client, fromIdx, fromToken, wallet, resolvedBridgeId, force);
      if (revokeHash !== null) await waitTxOnchain(client, revokeHash, fromIdx);
    }
    const [txHash, orderId] = await approveLeg(client, fromIdx, fromToken, wallet, resolvedBridgeId, rawAmount, force);
    await waitTxOnchain(client, txHash, fromIdx);
    approveTxHash = txHash;
    if (orderId !== '') approveOrderId = orderId;
  }

  if (approveBranch && confirmApprove) {
    if (needCancelApprove) await revokeLeg(client, fromIdx, fromToken, wallet, resolvedBridgeId, force);
    const [txHash, orderId] = await approveLeg(client, fromIdx, fromToken, wallet, resolvedBridgeId, rawAmount, force);
    const out = {
      action: 'approved',
      approveTxHash: txHash,
      tokenAddress: fromToken,
      tokenSymbol: idx(idx(route, 'fromToken'), 'tokenSymbol'),
      approveAmount: rawAmount,
      readableAmount: readableAmount ?? '',
      bridgeId: resolvedBridgeId,
      bridgeName: idx(route, 'bridgeName'),
    };
    if (orderId !== '') out.approveOrderId = orderId;
    return out;
  }

  // Step 3 — bridge tx
  const swapObj = unwrapDataArray(await fetchSwap(client, fromIdx, toIdx, fromToken, toToken, rawAmount, slippage, wallet, receiveAddress,
    resolvedBridgeId, sort, allowBridges, denyBridges));
  const tx = idx(swapObj, 'tx');
  const txTo = asStr(idx(tx, 'to'));
  if (txTo === undefined) throw new Error('missing tx.to in swap response');
  const txData = asStr(idx(tx, 'data'));
  if (txData === undefined) throw new Error('missing tx.data in swap response');
  const txValue = asStr(idx(tx, 'value')) ?? '0';
  const txGasLimit = asStr(idx(tx, 'gasLimit'));
  const mev = mevProtection || bridgeForcesMev(asStr(idx(route, 'bridgeName')) ?? '');
  const [swapTxHash, swapOrderId] = extractTxHashAndOrderId(await walletContractCall(txTo, fromIdx, txValue, txData, txGasLimit, mev, force));

  // Step 4 — output
  if (!skipApprove) return buildExecuteData(route, resolvedBridgeId, fromIdx, swapTxHash, swapOrderId, approveTxHash, approveOrderId);
  const router = idx(swapObj, 'router');
  const out = {
    action: 'execute',
    fromTxHash: swapTxHash,
    approveTxHash,
    selectedRoute: idx(router, 'bridgeName'),
    bridgeId: idx(router, 'bridgeId'),
    fromAmount: idx(swapObj, 'fromTokenAmount'),
    toAmount: idx(swapObj, 'toTokenAmount'),
    minimumReceived: idx(swapObj, 'minimumReceived'),
    estimateTime: idx(router, 'estimateTime'),
    crossChainFee: idx(router, 'crossChainFee'),
  };
  if (approveOrderId !== null) out.approveOrderId = approveOrderId;
  if (swapOrderId !== '') out.swapOrderId = swapOrderId;
  return out;
}

// ── CLI handlers (cross_chain.rs::execute) ───────────────────────────

const AMOUNT_CONFLICT = ['amount', 'readableAmount'];
const optChain = (c) => (some(c) ? resolveChain(c) : undefined);

export default {
  'cross-chain bridges': {
    uses: ['fromChain', 'toChain'],
    async run(ctx, o) {
      clap(ctx, o, {});
      const client = await ctx.api();
      return fetchSupportedBridges(client, optChain(o.fromChain), optChain(o.toChain));
    },
  },
  'cross-chain tokens': {
    uses: ['fromChain', 'toChain'],
    async run(ctx, o) {
      clap(ctx, o, {});
      const client = await ctx.api();
      return fetchSupportedTokens(client, optChain(o.fromChain), optChain(o.toChain));
    },
  },
  'cross-chain quote': {
    uses: ['from', 'to', 'fromChain', 'toChain', 'readableAmount', 'amount', 'slippage', 'wallet', 'checkApprove', 'bridgeId', 'sort',
      'allowBridges', 'denyBridges', 'receiveAddress'],
    async run(ctx, o) {
      clap(ctx, o, { conflicts: [AMOUNT_CONFLICT] });
      const client = await ctx.api();
      const fromIdx = resolveChain(o.fromChain);
      const toIdx = resolveChain(o.toChain);
      ensureSupportedChain(fromIdx, o.fromChain);
      ensureSupportedChain(toIdx, o.toChain);
      if (some(o.receiveAddress)) validateReceiveAddress(o.receiveAddress, toIdx);
      const fromToken = resolveAndValidate(fromIdx, o.from, 'from');
      const toToken = resolveAndValidate(toIdx, o.to, 'to');
      validateSlippageZeroToOne(o.slippage);
      const rawAmount = await resolveAmountArg(client, o.amount, o.readableAmount, o.from, fromIdx);
      const quoteRes = await settle(fetchQuote(client, fromIdx, toIdx, fromToken, toToken, rawAmount, o.slippage, o.wallet, o.checkApprove,
        o.bridgeId, o.sort, o.allowBridges, o.denyBridges, o.receiveAddress));
      if (isNoRoute(quoteRes)) {
        const fallback = await discoverTransitFallback(client, fromIdx, toIdx, fromToken, rawAmount, o.slippage);
        return [{ routerList: [], fallback }];
      }
      return unwrapResult(quoteRes);
    },
  },
  'cross-chain approve': {
    uses: ['chain', 'token', 'wallet', 'bridgeId', 'amount', 'readableAmount', 'checkAllowance'],
    async run(ctx, o) {
      // The leaf declares its own required `--chain`, which shadows the global one: a global
      // `--chain` before the subcommand does not satisfy it (clap: missing required, exit 2).
      clap(ctx, o, { conflicts: [AMOUNT_CONFLICT], leafRequired: ['chain'] });
      const client = await ctx.api();
      const chainIdx = resolveChain(o.chain);
      ensureSupportedChain(chainIdx, o.chain);
      const token = resolveAndValidate(chainIdx, o.token, 'token');
      const rawAmount = await resolveApproveAmount(client, o.amount, o.readableAmount, token, chainIdx);
      return fetchApproveTx(client, chainIdx, token, o.wallet, o.bridgeId, rawAmount, o.checkAllowance);
    },
  },
  'cross-chain swap': {
    uses: ['from', 'to', 'fromChain', 'toChain', 'readableAmount', 'amount', 'slippage', 'wallet', 'receiveAddress', 'bridgeId', 'sort',
      'allowBridges', 'denyBridges'],
    async run(ctx, o) {
      clap(ctx, o, { conflicts: [AMOUNT_CONFLICT] });
      const client = await ctx.api();
      const fromIdx = resolveChain(o.fromChain);
      const toIdx = resolveChain(o.toChain);
      ensureSupportedChain(fromIdx, o.fromChain);
      ensureSupportedChain(toIdx, o.toChain);
      const fromToken = resolveAndValidate(fromIdx, o.from, 'from');
      const toToken = resolveAndValidate(toIdx, o.to, 'to');
      validateAddressForChain(fromIdx, o.wallet, 'wallet');
      if (some(o.receiveAddress)) validateReceiveAddress(o.receiveAddress, toIdx);
      validateSlippageZeroToOne(o.slippage);
      const rawAmount = await resolveAmountArg(client, o.amount, o.readableAmount, o.from, fromIdx);
      return fetchSwap(client, fromIdx, toIdx, fromToken, toToken, rawAmount, o.slippage, o.wallet, o.receiveAddress, o.bridgeId, o.sort,
        o.allowBridges, o.denyBridges);
    },
  },
  'cross-chain execute': {
    uses: ['from', 'to', 'fromChain', 'toChain', 'readableAmount', 'amount', 'slippage', 'wallet', 'receiveAddress', 'bridgeId',
      'routeIndex', 'sort', 'allowBridges', 'denyBridges', 'mevProtection', 'confirmApprove', 'skipApprove', 'force'],
    async run(ctx, o) {
      const { routeIndex } = clap(ctx, o, {
        types: { routeIndex: 'usize' },
        conflicts: [AMOUNT_CONFLICT, ['bridgeId', 'routeIndex'], ['confirmApprove', 'skipApprove']],
      });
      const client = await ctx.api();
      return cmdExecute(client, o.from, o.to, o.fromChain, o.toChain, o.amount, o.readableAmount, o.slippage, o.wallet, o.receiveAddress,
        o.bridgeId, routeIndex, o.sort, o.allowBridges, o.denyBridges, o.mevProtection, o.confirmApprove, o.skipApprove, o.force);
    },
  },
  'cross-chain status': {
    uses: ['txHash', 'orderId', 'bridgeId', 'fromChain'],
    async run(ctx, o) {
      clap(ctx, o, { conflicts: [['txHash', 'orderId']], oneOf: [['txHash', 'orderId']] });
      const client = await ctx.api();
      const chainIdx = resolveChain(o.fromChain);
      const hash = some(o.txHash) ? o.txHash : await resolveOrderIdToTxHash(o.orderId, chainIdx);
      return fetchStatus(client, hash, chainIdx, o.bridgeId);
    },
  },
};
