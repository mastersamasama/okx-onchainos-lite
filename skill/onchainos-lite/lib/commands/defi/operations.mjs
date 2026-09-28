// High-level DeFi flows (invest / withdraw / collect) — upstream cli/src/commands/defi/operations.rs.
// Each returns the calldata `data` from the backend plus the CLI-side annotations.
import { resolveChain } from '../../core/chains.mjs';
import { normalizeAmount } from '../../core/sink.mjs';
import { displayF64, stringify } from '../../core/json.mjs';
import { eqIgnoreAsciiCase } from '../../core/_rust-str.mjs';
import {
  fetchDetail, fetchPrepare, fetchEnter, fetchExit, fetchClaim, fetchCalculateEntry, fetchPositionDetail,
} from './api.mjs';
import { minimalToDecimalStr, decimalToMinimalStr, extractExpectOutput, precisionOf } from './helpers.mjs';
import {
  get, isObject, asStr, asBool, asI64, asU64, asF64, toU32, parseU64, parseI64, parseU128, parseF64,
  setIndex, outermost, parseJsonArray, formatFixed,
} from './_rs.mjs';

const some = (v) => v !== undefined && v !== null;
const lower = (s) => s.toLowerCase();        // Rust str::to_lowercase (Unicode)

// upstream: operations.rs::TokenInfo
const tokenInfo = ({ address, chainIndex, precision, symbol }) => ({ address, chainIndex, precision, symbol });

// ── Main entry point ──

// upstream: operations.rs::cmd_invest — route to V3 or standard based on detail.investType
export async function cmdInvest(client, investmentId, address, token, amount, token2, amount2, slippage, tokenId, tickLower, tickUpper, range) {
  const detail = await fetchDetail(client, investmentId);
  if (!isInvestable(detail)) throw new Error('This product is not investable (isInvestable=false). Check detail for eligibility.');

  const prepare = await fetchPrepare(client, investmentId);
  const investTokens = get(prepare, 'investWithTokenList');
  if (!Array.isArray(investTokens)) throw new Error('investWithTokenList not found in prepare response');

  const matched1 = findMatchingToken(investTokens, token);
  const primaryToken = extractTokenInfo(matched1, token);
  validateAmount(amount);

  const it = get(detail, 'investType');
  const investType = asU64(it) ?? (typeof it === 'string' ? parseU64(it) : undefined) ?? 0;

  let userInputJson, surplusInfo, resolvedTl = null, resolvedTu = null;
  if (BigInt(investType) === 2n) {
    let secondary = null;
    if (some(token2) && some(amount2)) {
      const matched2 = findMatchingToken(investTokens, token2);
      const secondaryToken = extractTokenInfo(matched2, token2);
      validateAmountV3(amount2);
      secondary = [secondaryToken, amount2];
    } else if (some(amount2)) {
      validateAmountV3(amount2);
      const other = investTokens.find((t) => lower(asStr(get(t, 'tokenAddress')) ?? '') !== lower(primaryToken.address));
      if (other !== undefined) secondary = [extractTokenInfo(other, 'auto-detected'), amount2];
    }
    [userInputJson, surplusInfo, resolvedTl, resolvedTu] = await investV3(
      client, investmentId, address, primaryToken, amount, secondary, prepare, tokenId, tickLower, tickUpper, range,
    );
  } else {
    [userInputJson, surplusInfo] = investStandard(primaryToken, amount);
  }

  // Slippage guard
  const slippageVal = parseF64(slippage) ?? 0.0;
  if (slippageVal > 0.2) {
    throw new Error(`Slippage ${formatFixed(slippageVal * 100.0, 1)}% exceeds maximum allowed 20%. Reduce --slippage and retry.`);
  } else if (slippageVal > 0.1) {
    process.stderr.write(`⚠️  WARNING: Slippage tolerance is ${formatFixed(slippageVal * 100.0, 1)}% (> 10%). High slippage may result in significant value loss.\n`);
  }

  let result = await fetchEnter(client, investmentId, address, userInputJson, slippage, tokenId, resolvedTl, resolvedTu);
  result = appendWarnings(result, detail);
  if (surplusInfo) {
    const [sym, addr, humanAmount] = surplusInfo;
    result = setIndex(result, 'rebalance', {
      surplusToken: sym, surplusTokenAddress: addr, surplusAmount: humanAmount,
      message: `${humanAmount} ${sym} not invested (returned to wallet)`,
    });
  }
  annotateDatalistValueNormalized(result);
  return result;
}

// upstream: operations.rs::annotate_datalist_value_normalized — FR-4: each dataList[] object gets
// `valueNormalized` (minimal-unit decimal string from `value`), or valueNormalizeError + "0".
export function annotateDatalistValueNormalized(result) {
  const arr = get(result, 'dataList');
  if (!Array.isArray(arr)) return;
  for (const step of arr) {
    if (!isObject(step)) continue;
    const raw = Object.prototype.hasOwnProperty.call(step, 'value') ? step.value : null;
    const n = normalizeAmount(raw);
    if (n.error === undefined) step.valueNormalized = n.value;
    else { step.valueNormalizeError = n.error; step.valueNormalized = '0'; }
  }
}

// ── Standard (non-V3) invest ──

// upstream: operations.rs::invest_standard → [userInputJson, null]
export function investStandard(primaryToken, amount) {
  const list = [{ tokenAddress: primaryToken.address, chainIndex: primaryToken.chainIndex, coinAmount: amount, tokenPrecision: String(primaryToken.precision) }];
  return [stringify(list), null];
}

// ── V3 Pool invest ──

// upstream: operations.rs::invest_v3 → [userInputJson, surplus, tickLower, tickUpper]
export async function investV3(client, investmentId, address, primaryToken, amount, secondary, prepare, tokenId, tickLower, tickUpper, range) {
  const [tl, tu] = some(tokenId) ? [null, null] : resolveTicks(prepare, tickLower, tickUpper, range);
  let json, change;
  if (secondary) {
    [json, change] = await investV3Dual(client, investmentId, address, primaryToken, amount, secondary[0], secondary[1], tl, tu);
  } else {
    const list = get(prepare, 'investWithTokenList');
    [json, change] = await investV3Single(client, investmentId, address, primaryToken, amount, Array.isArray(list) ? list : [], tl, tu);
  }
  return [json, change, tl, tu];
}

// upstream: operations.rs::invest_v3_single — one token in, the calculator sizes the other.
export async function investV3Single(client, investmentId, address, primaryToken, amount, investTokens, tickLower, tickUpper) {
  const humanAmount = minimalToDecimalStr(amount, primaryToken.precision);
  const calcResult = await fetchCalculateEntry(client, investmentId, address, primaryToken.address, humanAmount, String(primaryToken.precision), tickLower, tickUpper);
  const calcTokens = get(calcResult, 'investWithTokenList');
  if (!Array.isArray(calcTokens)) throw new Error('investWithTokenList not found in calculate-entry response');
  const userInputList = calcTokens.map((ct) => {
    const calcTokenAddress = asStr(get(ct, 'tokenAddress')) ?? '';
    const calcTokenChain = asStr(get(ct, 'chainIndex')) ?? primaryToken.chainIndex;
    const calcTokenAmount = asStr(get(ct, 'coinAmount')) ?? '0';
    const calcTokenPrecision = findTokenPrecision(investTokens, calcTokenAddress);
    return {
      tokenAddress: calcTokenAddress, chainIndex: calcTokenChain,
      coinAmount: decimalToMinimalStr(calcTokenAmount, calcTokenPrecision), tokenPrecision: String(calcTokenPrecision),
    };
  });
  return [stringify(userInputList), null];
}

// upstream: operations.rs::invest_v3_dual — both tokens in; rebalance to the pool ratio and report
// the surplus of whichever side is not the constraint.
export async function investV3Dual(client, investmentId, address, primaryToken, amount, secondaryToken, secondaryAmount, tickLower, tickUpper) {
  const humanAmount1 = minimalToDecimalStr(amount, primaryToken.precision);
  const calc1 = await fetchCalculateEntry(client, investmentId, address, primaryToken.address, humanAmount1, String(primaryToken.precision), tickLower, tickUpper);
  const neededT2Human = findTokenAmountInCalcResult(calc1, secondaryToken.address);
  const neededT2Minimal = decimalToMinimalStr(neededT2Human, secondaryToken.precision);
  const userT2 = parseU128(secondaryAmount) ?? 0n;
  const neededT2 = parseU128(neededT2Minimal) ?? 0n;

  let finalT1, finalT2, surplusSymbol, surplusAddress, surplusAmount;
  if (neededT2 <= userT2) {
    const change = userT2 - neededT2;
    [finalT1, finalT2] = [amount, neededT2Minimal];
    [surplusSymbol, surplusAddress] = [secondaryToken.symbol, secondaryToken.address];
    surplusAmount = minimalToDecimalStr(change.toString(), secondaryToken.precision);
  } else {
    const humanAmount2 = minimalToDecimalStr(secondaryAmount, secondaryToken.precision);
    const calc2 = await fetchCalculateEntry(client, investmentId, address, secondaryToken.address, humanAmount2, String(secondaryToken.precision), tickLower, tickUpper);
    const neededT1Human = findTokenAmountInCalcResult(calc2, primaryToken.address);
    const neededT1Minimal = decimalToMinimalStr(neededT1Human, primaryToken.precision);
    const userT1 = parseU128(amount) ?? 0n;
    const neededT1 = parseU128(neededT1Minimal) ?? 0n;
    const change = userT1 > neededT1 ? userT1 - neededT1 : 0n;
    [finalT1, finalT2] = [neededT1Minimal, secondaryAmount];
    [surplusSymbol, surplusAddress] = [primaryToken.symbol, primaryToken.address];
    surplusAmount = minimalToDecimalStr(change.toString(), primaryToken.precision);
  }
  const surplusInfo = surplusAmount !== '0' && surplusAmount !== '' ? [surplusSymbol, surplusAddress, surplusAmount] : null;
  const userInputList = [
    { tokenAddress: primaryToken.address, chainIndex: primaryToken.chainIndex, coinAmount: finalT1, tokenPrecision: String(primaryToken.precision) },
    { tokenAddress: secondaryToken.address, chainIndex: secondaryToken.chainIndex, coinAmount: finalT2, tokenPrecision: String(secondaryToken.precision) },
  ];
  return [stringify(userInputList), surplusInfo];
}

// ── Helpers ──

// upstream: operations.rs::is_investable — bool, or "true"/"1"; missing / other → false
export function isInvestable(detail) {
  const v = get(detail, 'isInvestable');
  const b = asBool(v) ?? (typeof v === 'string' ? v === 'true' || v === '1' : undefined);
  return b ?? false;
}

const AMOUNT_DOT = (amount) => `amount must be in minimal units (integer), got "${amount}". Convert: userAmount × 10^tokenPrecision. Example: 0.1 USDC (precision=6) → amount="100000"`;

// upstream: operations.rs::validate_amount
export function validateAmount(amount) {
  if (amount.includes('.')) throw new Error(AMOUNT_DOT(amount));
  if (amount === '' || /^0*$/.test(amount)) throw new Error(`amount cannot be zero or empty. Got "${amount}".`);
}

// upstream: operations.rs::validate_amount_v3 — like validate_amount but "0" is allowed
export function validateAmountV3(amount) {
  if (amount.includes('.')) throw new Error(AMOUNT_DOT(amount));
  if (amount === '') throw new Error('amount cannot be empty.');
}

// upstream: operations.rs::find_matching_token — by symbol or address, case-insensitive
export function findMatchingToken(investTokens, token) {
  const tokenLower = lower(token);
  const hit = investTokens.find((t) => {
    const sym = lower(asStr(get(t, 'tokenSymbol')) ?? '');
    const addr = lower(asStr(get(t, 'tokenAddress')) ?? '');
    return sym === tokenLower || addr === tokenLower;
  });
  if (hit !== undefined) return hit;
  const available = investTokens.map((t) => asStr(get(t, 'tokenSymbol'))).filter((s) => s !== undefined);
  throw new Error(`Token '${token}' not found in investWithTokenList. Available: ${available.join(', ')}`);
}

// upstream: operations.rs::extract_token_info
export function extractTokenInfo(matched, token) {
  const address = asStr(get(matched, 'tokenAddress'));
  if (address === undefined || address === '') throw new Error(`tokenAddress is empty for token '${token}'`);
  const chainIndex = asStr(get(matched, 'chainIndex'));
  if (chainIndex === undefined || chainIndex === '') throw new Error(`chainIndex is empty for token '${token}'`);
  const precision = precisionOf(get(matched, 'tokenPrecision')) ?? 18;
  const symbol = asStr(get(matched, 'tokenSymbol')) ?? 'UNKNOWN';
  return tokenInfo({ address, chainIndex, precision, symbol });
}

// upstream: operations.rs::find_token_precision — ASCII case-insensitive address match, default 18
export function findTokenPrecision(investTokens, tokenAddress) {
  const t = investTokens.find((x) => eqIgnoreAsciiCase(asStr(get(x, 'tokenAddress')) ?? '', tokenAddress));
  return (t === undefined ? undefined : precisionOf(get(t, 'tokenPrecision'))) ?? 18;
}

// upstream: operations.rs::find_token_amount_in_calc_result — coinAmount of the matching token or "0"
export function findTokenAmountInCalcResult(calcResult, tokenAddress) {
  const tokens = get(calcResult, 'investWithTokenList');
  if (!Array.isArray(tokens)) throw new Error('calculate-entry response missing investWithTokenList');
  const t = tokens.find((x) => eqIgnoreAsciiCase(asStr(get(x, 'tokenAddress')) ?? '', tokenAddress));
  return (t === undefined ? undefined : asStr(get(t, 'coinAmount'))) ?? '0';
}

const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n;
const wrap64 = (b) => BigInt.asIntN(64, b);
const out64 = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);
// `v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64())`
const tickOf = (v) => (typeof v === 'string' ? parseI64(v) : asI64(v));
// Rust f64::max (NaN-ignoring) and `f64 as i64` (saturating, NaN → 0)
const fmax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));
function f64ToI64(x) {
  if (Number.isNaN(x)) return 0n;
  if (x >= 9223372036854775807) return I64_MAX;
  if (x <= -9223372036854775808) return I64_MIN;
  return BigInt(Math.trunc(x));
}
function idiv(a, b) {
  if (b === 0n) throw new Error('attempt to divide by zero');
  return wrap64(a / b);
}

// upstream: operations.rs::resolve_ticks — explicit ticks, or ±range% around currentTick snapped to
// tickSpacing (integer division truncating toward zero).
export function resolveTicks(prepare, tickLower, tickUpper, range) {
  if (some(tickLower) && some(tickUpper)) return [tickLower, tickUpper];
  if (some(range)) {
    if (range <= 0.0 || range > 100.0) throw new Error(`--range must be between 0 and 100 (percent), got ${displayF64(range)}`);
    const ct = tickOf(get(prepare, 'currentTick'));
    if (ct === undefined) throw new Error('currentTick not found in prepare response');
    const sp = tickOf(get(prepare, 'tickSpacing'));
    if (sp === undefined) throw new Error('tickSpacing not found in prepare response');
    const cur = BigInt(ct), spacing = BigInt(sp);
    const abs = wrap64(cur < 0n ? -cur : cur);
    const delta = f64ToI64(fmax((Number(abs) * range) / 100.0, Number(wrap64(spacing * 2n))));
    const lowerTick = wrap64(idiv(wrap64(cur - delta), spacing) * spacing);
    const upperTick = wrap64(idiv(wrap64(cur + delta + spacing - 1n), spacing) * spacing);
    return [out64(lowerTick), out64(upperTick)];
  }
  const cs = asStr(get(prepare, 'currentTick')) ?? 'unknown';
  const ss = asStr(get(prepare, 'tickSpacing')) ?? 'unknown';
  throw new Error(`V3 pool requires --range (e.g. --range 5 for ±5%) or --tick-lower/--tick-upper. Current tick: ${cs}, tick spacing: ${ss}.`);
}

// `v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64())`
const rateOf = (v) => (typeof v === 'string' ? parseF64(v) : asF64(v));

// upstream: operations.rs::append_warnings — highApyWarning (rate > 0.5), liquidationWarning
// (healthRate < 1.5). Returns the (possibly new) result value.
export function appendWarnings(result, detail) {
  const rate = rateOf(get(detail, 'rate'));
  if (rate !== undefined && rate > 0.5) result = setIndex(result, 'highApyWarning', true);
  const health = rateOf(get(detail, 'healthRate'));
  if (health !== undefined && health < 1.5) result = setIndex(result, 'liquidationWarning', true);
  return result;
}

// ── Withdraw / Collect ──

// upstream: operations.rs::cmd_withdraw — resolve the position, build exit calldata
export async function cmdWithdraw(client, investmentId, address, chain, ratio, tokenId, slippage, amount, platformId) {
  const chainIndex = resolveChain(chain);
  const slippageVal = parseF64(slippage) ?? 0.0;
  if (slippageVal > 0.1) {
    process.stderr.write(`⚠️  WARNING: Slippage tolerance is ${formatFixed(slippageVal * 100.0, 1)}% (> 10%). High slippage may result in significant value loss.\n`);
  }

  const detail = await fetchDetail(client, investmentId);
  const sr = get(detail, 'isSupportRedeem');
  const isSupportRedeem = asBool(sr) ?? (typeof sr === 'string' ? sr === 'true' || sr === '1' : undefined) ?? true;
  if (!isSupportRedeem) throw new Error('This product does not support redemption (isSupportRedeem=false).');

  if (some(tokenId)) {
    if (!some(ratio)) throw new Error('V3 Pool withdrawal requires --ratio (e.g. --ratio 1 for full exit).');
    const result = await fetchExit(client, investmentId, chainIndex, address, ratio, null, null, null, null, tokenId, slippage, null);
    annotateDatalistValueNormalized(result);
    return result;
  }

  if (!some(ratio) && !some(amount)) throw new Error('Must provide --ratio (e.g. --ratio 1 for full exit) or --amount for partial exit, or both.');
  if (some(amount) && !some(platformId)) throw new Error('--amount requires --platform-id to resolve token info from position-detail.');
  if (some(amount)) validateAmount(amount);

  let userInput = null;
  if (some(platformId)) {
    const posDetail = await fetchPositionDetail(client, address, chainIndex, platformId);
    const info = findPositionToken(posDetail, investmentId);
    const balanceMinimal = decimalToMinimalStr(info.balance, info.precision);
    let coinAmount;
    if (some(amount)) {
      const userAmount = parseU128(amount) ?? 0n;
      const balance = parseU128(balanceMinimal) ?? 0n;
      if (userAmount > balance) {
        throw new Error(`Requested amount ${minimalToDecimalStr(amount, info.precision)} exceeds current balance ${info.balance} ${info.symbol}. Reduce amount or use --ratio 1 for full exit.`);
      }
      coinAmount = amount;
    } else {
      coinAmount = balanceMinimal;
    }
    userInput = stringify([{ tokenAddress: info.address, chainIndex: info.chainIndex, coinAmount, tokenPrecision: String(info.precision) }]);
  }

  const result = await fetchExit(client, investmentId, chainIndex, address, ratio, null, null, null, null, null, slippage, userInput);
  annotateDatalistValueNormalized(result);
  return result;
}

// investmentId (JSON integer or string) as upstream compares it; missing / other → ""
function investmentIdOf(item) {
  const v = get(item, 'investmentId');
  const n = asI64(v);
  if (n !== undefined) return String(n);
  return asStr(v) ?? '';
}

// upstream: operations.rs::extract_position_token → PositionTokenInfo
function extractPositionToken(token) {
  const p = get(token, 'tokenPrecision');
  const u = asU64(p);
  const precision = (u !== undefined ? toU32(u) : (typeof p === 'string' ? precisionOf(p) : undefined)) ?? 18;
  return {
    address: asStr(get(token, 'tokenAddress')) ?? '',
    chainIndex: asStr(get(token, 'chainIndex')) ?? '',
    precision,
    balance: asStr(get(token, 'coinAmount')) ?? '0',
    symbol: asStr(get(token, 'tokenSymbol')) ?? 'UNKNOWN',
  };
}

function firstAsset(item) {
  const assets = get(item, 'assetsTokenList');
  return Array.isArray(assets) && assets.length ? extractPositionToken(assets[0]) : undefined;
}

// upstream: operations.rs::find_token_in_invest_list
function findTokenInInvestList(invests, investmentId) {
  for (const invest of invests) {
    if (investmentIdOf(invest) !== investmentId) continue;
    const t = firstAsset(invest);
    if (t) return t;
  }
  return undefined;
}

// upstream: operations.rs::find_token_in_market_list
function findTokenInMarketList(markets, investmentId) {
  for (const market of markets) {
    const assetMap = get(market, 'assetMap');
    if (assetMap === undefined) continue;
    for (const side of ['SUPPLY', 'BORROW']) {
      const items = get(assetMap, side);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (investmentIdOf(item) !== investmentId) continue;
        const t = firstAsset(item);
        if (t) return t;
      }
    }
  }
  return undefined;
}

// upstream: operations.rs::find_position_token — the position matching investmentId in position-detail
export function findPositionToken(posDetail, investmentId) {
  if (!Array.isArray(posDetail)) throw new Error('position-detail response is not an array');
  for (const platform of posDetail) {
    const wallets = get(platform, 'walletIdPlatformDetailList');
    if (!Array.isArray(wallets)) continue;
    for (const w of wallets) {
      const networks = get(w, 'networkHoldVoList');
      if (!Array.isArray(networks)) continue;
      for (const net of networks) {
        const invests = get(net, 'investTokenBalanceVoList');
        if (Array.isArray(invests)) {
          const info = findTokenInInvestList(invests, investmentId);
          if (info) return info;
        }
        const markets = get(net, 'investMarketTokenBalanceVoList');
        if (Array.isArray(markets)) {
          const info = findTokenInMarketList(markets, investmentId);
          if (info) return info;
        }
      }
    }
  }
  throw new Error(`No position found for investmentId ${investmentId} in position-detail`);
}

const MARKET_REWARD_TYPES = ['REWARD_INVESTMENT', 'REWARD_OKX_BONUS', 'REWARD_MERKLE_BONUS'];

// upstream: operations.rs::cmd_collect — validate reward type, auto-build expectOutputList, claim
export async function cmdCollect(client, address, chain, rewardType, investmentId, platformId, tokenId, principalIndex) {
  const chainIndex = resolveChain(chain);

  if (rewardType === 'REWARD_PLATFORM') {
    if (!some(platformId)) throw new Error('REWARD_PLATFORM requires --platform-id (analysisPlatformId from positions).');
  } else if (MARKET_REWARD_TYPES.includes(rewardType)) {
    if (!some(investmentId) || !some(platformId)) throw new Error(`${rewardType} requires both --investment-id and --platform-id.`);
  } else if (rewardType === 'V3_FEE') {
    if (!some(investmentId) || !some(tokenId)) throw new Error('V3_FEE requires both --investment-id and --token-id (NFT tokenId).');
  } else if (rewardType === 'UNLOCKED_PRINCIPAL') {
    if (!some(investmentId) || !some(principalIndex)) throw new Error('UNLOCKED_PRINCIPAL requires both --investment-id and --principal-index.');
  } else {
    throw new Error(`Unknown reward_type '${rewardType}'. Must be one of: REWARD_PLATFORM, REWARD_INVESTMENT, V3_FEE, REWARD_OKX_BONUS, REWARD_MERKLE_BONUS, UNLOCKED_PRINCIPAL.`);
  }

  let expectOutput = null;
  if (rewardType === 'V3_FEE' || rewardType === 'UNLOCKED_PRINCIPAL') {
    expectOutput = null;
  } else if (some(platformId)) {
    let auto;
    try {
      auto = await extractExpectOutput(client, address, chainIndex, platformId, rewardType, investmentId);
    } catch (e) {
      throw new Error(`Failed to fetch reward info from position-detail: ${outermost(e)}`);
    }
    if (auto === null) {
      throw new Error(`No reward tokens found for ${rewardType} in position-detail. Verify investment-id and platform-id.`);
    }
    let tokens;
    try { tokens = parseJsonArray(auto); } catch { tokens = []; }
    if (!tokens.length) throw new Error(`No rewards found for ${rewardType} in position-detail.`);
    const allZero = tokens.every((t) => {
      const a = asStr(get(t, 'coinAmount')) ?? '0';
      return a === '0' || a === '' || /^[0.]*$/.test(a);
    });
    if (allZero) throw new Error(`No rewards available. All reward amounts are zero for ${rewardType}.`);
    expectOutput = auto;
  } else {
    throw new Error(`--platform-id is required for ${rewardType} to auto-build expectOutputList.`);
  }

  // investmentId and analysisPlatformId cannot both be sent.
  const effectivePlatformId = some(investmentId) ? null : platformId;
  const result = await fetchClaim(client, address, chainIndex, rewardType, investmentId, effectivePlatformId, tokenId, principalIndex, expectOutput);
  annotateDatalistValueNormalized(result);
  return result;
}
