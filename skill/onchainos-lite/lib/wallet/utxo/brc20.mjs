// Transferable BRC-20 carrier UTXOs: holdings summary, transferable query with exact-amount
// selection plans, and the selection used by `wallet send` — upstream agentic_wallet/utxo/brc20.rs.
import { minimalToReadable, parseMinimal, readableToMinimal, valueAsDecimalString } from '../shared/common/amount.mjs';
import { BtcApi, extractTokenDecimals } from '../shared/adapters/bitcoin/api.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { BtcOutPoint } from '../shared/adapters/bitcoin/models.mjs';
import { normalizeBrc20TokenAddress } from '../shared/adapters/bitcoin/validation.mjs';
import { trim, eqIgnoreAsciiCase, cmpBytes } from '../../core/rs/str.mjs';
import { isObject, get, asU64 } from '../../core/rs/value.mjs';
import { rustPanic } from './_panic.mjs';

// upstream: brc20.rs::MAX_COMBINATION_STATES / MAX_COMBINATION_RESULTS
export const MAX_COMBINATION_STATES = 100000;
export const MAX_COMBINATION_RESULTS = 3;

// serde_json Value::pointer for "/a/b" (object keys only; a present null is Some(Null)).
export function pointer(value, path) {
  let cur = value;
  for (const key of path.split('/').slice(1)) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// ── decimal helpers ─────────────────────────────────────────────────

// upstream: brc20.rs::parse_decimal → [mantissa BigInt, scale]
export function parseDecimal(value, field) {
  const v = trim(value);
  const parts = v.split('.');
  const integer = parts[0];
  const fraction = parts.length > 1 ? parts[1] : undefined;
  const digits = (s) => /^[0-9]+$/.test(s);
  if (parts.length > 2 || integer === '' || !digits(integer) || (fraction !== undefined && (fraction === '' || !digits(fraction)))) {
    throw new Error(`${field} must be a non-negative plain decimal`);
  }
  const frac = fraction ?? '';
  return [BigInt(integer + frac), frac.length];
}

// upstream: brc20.rs::format_decimal
export function formatDecimal(mantissa, scale) {
  let digits = mantissa.toString();
  if (scale === 0) return digits;
  if (digits.length <= scale) digits = '0'.repeat(scale + 1 - digits.length) + digits;
  const split = digits.length - scale;
  const fraction = digits.slice(split).replace(/0+$/, '');
  return fraction === '' ? digits.slice(0, split) : `${digits.slice(0, split)}.${fraction}`;
}

// upstream: brc20.rs::decimal_subtract
export function decimalSubtract(left, right, leftName, rightName) {
  const [lm, ls] = parseDecimal(left, leftName);
  const [rm, rs] = parseDecimal(right, rightName);
  const scale = Math.max(ls, rs);
  const l = lm * 10n ** BigInt(scale - ls);
  const r = rm * 10n ** BigInt(scale - rs);
  if (r > l) throw new Error(`${rightName} cannot exceed ${leftName}`);
  return formatDecimal(l - r, scale);
}

// upstream: brc20.rs::decimal_multiply
export function decimalMultiply(left, right, leftName, rightName) {
  const [lm, ls] = parseDecimal(left, leftName);
  const [rm, rs] = parseDecimal(right, rightName);
  return formatDecimal(lm * rm, ls + rs);
}

// ── transferable UTXOs ──────────────────────────────────────────────

// upstream: brc20.rs::Brc20TransferableUtxo
export class Brc20TransferableUtxo {
  constructor({ outpoint, utxoId, utxoAmountRaw, valueRaw, offset, inscriptionId }) {
    Object.assign(this, { outpoint, utxoId, utxoAmountRaw, valueRaw, offset, inscriptionId });
  }

  // upstream: brc20.rs::Brc20TransferableUtxo::build_tx_param_input
  buildTxParamInput(address) {
    return { txId: this.outpoint.txHash, vout: this.outpoint.voutIndex, amount: this.utxoAmountRaw, address };
  }

  // upstream: brc20.rs::Brc20TransferableUtxo::build_choice
  buildChoice(tokenAddress, decimals) {
    return {
      selection: this.outpoint.canonical(),
      tokenAddress,
      tokenAmount: minimalToReadable(this.valueRaw, decimals),
      tokenAmountRaw: this.valueRaw,
      utxoAmountSats: this.utxoAmountRaw,
      utxoId: this.utxoId,
      offset: this.offset ?? null,
      inscriptionId: this.inscriptionId,
    };
  }
}

// upstream: brc20.rs::read_required_raw_field
function readRequiredRawField(item, field, index) {
  const v = valueAsDecimalString(get(item, field));
  if (v === undefined) throw new Error(`transferable UTXO ${index} is missing ${field}`);
  return v;
}

// upstream: brc20.rs::parse_brc20_transferable_utxos
export function parseBrc20TransferableUtxos(snapshot) {
  let items = pointer(snapshot, '/brc20TransferableUtxoList/utxos');
  if (items === undefined) items = get(snapshot, 'utxos');
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const txHash = get(item, 'txHash');
    if (typeof txHash !== 'string' || txHash === '') throw new Error(`transferable UTXO ${index} is missing txHash`);
    const vout = valueAsDecimalString(get(item, 'voutIndex'));
    if (vout === undefined) throw new Error(`transferable UTXO ${index} is missing voutIndex`);
    const outpoint = BtcOutPoint.parse(`${txHash}:${vout}`);
    const utxoAmountRaw = readRequiredRawField(item, 'utxoAmountRaw', index);
    const valueRaw = readRequiredRawField(item, 'valueRaw', index);
    const utxoId = typeof get(item, 'utxoId') === 'string' ? get(item, 'utxoId') : '';
    const inscriptionId = typeof get(item, 'inscriptionId') === 'string' ? get(item, 'inscriptionId') : '';
    return new Brc20TransferableUtxo({ outpoint, utxoId, utxoAmountRaw, valueRaw, offset: valueAsDecimalString(get(item, 'offset')), inscriptionId });
  });
}

// upstream: brc20.rs::select_brc20_transferable_utxos — user selections resolved against the
// latest snapshot, in request order.
export function selectBrc20TransferableUtxos(snapshot, selections) {
  if (!selections.length) throw new Error('BRC-20 transfers require at least one --brc20-outpoint selected from wallet utxo brc20-transferable');
  const available = new Map();
  for (const utxo of parseBrc20TransferableUtxos(snapshot)) available.set(utxo.outpoint.canonical(), utxo);
  const seen = new Set();
  const selected = [];
  for (const selection of selections) {
    const canonical = BtcOutPoint.parse(selection).canonical();
    if (seen.has(canonical)) throw new Error(`BRC-20 UTXO ${canonical} was selected more than once`);
    seen.add(canonical);
    const utxo = available.get(canonical);
    if (!utxo) throw new Error(`selected BRC-20 UTXO is no longer transferable: ${canonical}`);
    available.delete(canonical);
    selected.push(utxo);
  }
  return selected;
}

// ── holdings summary (wallet balance --chain bitcoin --token-address btc-brc20-…) ──

// upstream: brc20.rs::find_token_asset — first matching tokenAssets entry, depth-first
// (object values in sorted-key order).
export function findTokenAsset(value, tokenAddress) {
  const tokens = get(value, 'tokenAssets');
  if (Array.isArray(tokens)) {
    const hit = tokens.find((a) => typeof get(a, 'tokenAddress') === 'string' && eqIgnoreAsciiCase(get(a, 'tokenAddress'), tokenAddress));
    if (hit !== undefined) return hit;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const f = findTokenAsset(item, tokenAddress); if (f !== undefined) return f; }
  } else if (isObject(value)) {
    for (const k of Object.keys(value).sort(cmpBytes)) { const f = findTokenAsset(value[k], tokenAddress); if (f !== undefined) return f; }
  }
  return undefined;
}

// `value_as_decimal_string(v).filter(|v| parse_decimal(v, …).is_ok())`
function plainDecimalOrNull(v) {
  const s = valueAsDecimalString(v);
  if (s === undefined) return null;
  try { parseDecimal(s, 'value'); return s; } catch { return null; }
}

// upstream: brc20.rs::build_brc20_template_values
export function buildBrc20TemplateValues(tokenAddress, decimals, balance, transferableSnapshot) {
  const asset = findTokenAsset(balance, tokenAddress);
  if (asset === undefined) throw new Error(`BRC-20 balance response did not contain ${tokenAddress}`);
  const totalAmount = valueAsDecimalString(get(asset, 'balance'));
  if (totalAmount === undefined) throw new Error('BRC-20 balance response is missing balance');
  const transferable = parseBrc20TransferableUtxos(transferableSnapshot);
  let transferableRaw = valueAsDecimalString(pointer(transferableSnapshot, '/brc20TransferableUtxoList/sumValueRaw'));
  if (transferableRaw === undefined) {
    let total = 0n;
    for (const utxo of transferable) {
      try { total += parseMinimal(utxo.valueRaw, 'transferable BRC-20 amount', true); } catch (e) {
        rustPanic('commands/agentic_wallet/utxo/brc20.rs', 44, 30, `parsed transferable UTXOs have valid minimal amounts: ${e.message}`);
      }
    }
    transferableRaw = total.toString();
  }
  const transferableAmount = minimalToReadable(transferableRaw, decimals);
  const remainingInscribableAmount = decimalSubtract(totalAmount, transferableAmount, 'BRC-20 total amount', 'transferable BRC-20 amount');
  const tokenPrice = plainDecimalOrNull(get(asset, 'tokenPrice'));
  const totalUsd = plainDecimalOrNull(get(asset, 'usdValue'));
  const transferableUsd = tokenPrice === null ? null : decimalMultiply(transferableAmount, tokenPrice, 'transferable BRC-20 amount', 'tokenPrice');
  const remainingInscribableUsd = tokenPrice === null ? null
    : decimalMultiply(remainingInscribableAmount, tokenPrice, 'remaining inscribable BRC-20 amount', 'tokenPrice');
  return {
    ticker: tokenAddress.startsWith('btc-brc20-') ? tokenAddress.slice('btc-brc20-'.length) : tokenAddress,
    totalAmount,
    transferableAmount,
    remainingInscribableAmount,
    totalUsd,
    transferableUsd,
    remainingInscribableUsd,
    tokenPrice,
    count: transferable.length,
    denominations: transferable.map((utxo) => utxo.buildChoice(tokenAddress, decimals).tokenAmount),
  };
}

// upstream: brc20.rs::cmd_brc20_balance → output data
export async function cmdBrc20Balance(tokenAddress) {
  const token = normalizeBrc20TokenAddress(tokenAddress);
  const context = await BtcContext.load(null);
  const metadata = await new BtcApi().tokenMetadata(context, token);
  const decimals = extractTokenDecimals(metadata);
  // tokio::try_join! — both requests in flight, the first failure wins.
  const [balance, transferableSnapshot] = await Promise.all([
    new BtcApi().brc20Balance(context, token),
    new BtcApi().brc20TransferableUtxos(context, token),
  ]);
  const result = buildBrc20TemplateValues(token, decimals, balance, transferableSnapshot);
  result.tokenAddress = token;
  return result;
}

// ── transferable query + exact selection plan ───────────────────────

// Vec<usize> ordering by (len, lexicographic).
function cmpCombination(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// upstream: brc20.rs::find_exact_combination →
//   { kind: 'Exact', combinations } | { kind: 'NoExactMatch' } | { kind: 'SearchLimitExceeded' }
// Up to three exact subsets (fewest inputs first) via a subset-sum map ordered by sum.
export function findExactCombination(transferable, target) {
  const amounts = transferable.map((utxo, index) => parseMinimal(utxo.valueRaw, `transferable UTXO ${index} valueRaw`, false));
  const singles = [];
  amounts.forEach((amount, index) => { if (amount === target && singles.length < MAX_COMBINATION_RESULTS) singles.push([index]); });
  if (singles.length) return { kind: 'Exact', combinations: singles };

  const states = new Map([[0n, [[]]]]);     // BTreeMap<sum, Vec<combination>>
  const atTarget = (fallback) => (states.has(target) ? { kind: 'Exact', combinations: states.get(target) } : { kind: fallback });
  for (let index = 0; index < amounts.length; index++) {
    const amount = amounts[index];
    if (amount > target) continue;
    const sums = [...states.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const additions = [];
    for (const sum of sums) {
      const next = sum + amount;
      if (next <= target) additions.push([next, states.get(sum).map((c) => [...c, index])]);
    }
    for (const [sum, candidates] of additions) {
      const existing = states.get(sum);
      if (existing) {
        existing.push(...candidates);
        existing.sort(cmpCombination);
        const deduped = existing.filter((c, i) => i === 0 || cmpCombination(c, existing[i - 1]) !== 0);
        states.set(sum, deduped.slice(0, MAX_COMBINATION_RESULTS));
      } else {
        if (states.size >= MAX_COMBINATION_STATES) return atTarget('SearchLimitExceeded');
        states.set(sum, candidates);
      }
    }
  }
  return atTarget('NoExactMatch');
}

// upstream: brc20.rs::build_brc20_selection_plan
export function buildBrc20SelectionPlan(transferable, choices, readableAmount, decimals) {
  const requestedAmountRaw = readableToMinimal(readableAmount, decimals);
  const target = parseMinimal(requestedAmountRaw, 'requested BRC-20 amount', false);
  const search = findExactCombination(transferable, target);
  let status = 'NO_EXACT_MATCH', combinations = [];
  if (search.kind === 'Exact') {
    status = 'EXACT_MATCH';
    combinations = search.combinations.map((indexes) => ({
      selectedCount: indexes.length,
      selectedOutpoints: indexes.map((i) => transferable[i].outpoint.canonical()),
      selectedChoices: indexes.map((i) => choices[i]),
    }));
  } else if (search.kind === 'SearchLimitExceeded') {
    status = 'SEARCH_LIMIT_EXCEEDED';
  }
  return {
    status,
    requestedAmount: readableAmount,
    requestedAmountRaw,
    maxCombinations: MAX_COMBINATION_RESULTS,
    searchStateLimit: MAX_COMBINATION_STATES,
    combinationCount: combinations.length,
    combinations,
  };
}

// `txHash:voutIndex` key of an asset record (voutIndex u64 or string).
export function recordOutpointKey(record) {
  const txHash = get(record, 'txHash');
  if (typeof txHash !== 'string') return undefined;
  const v = get(record, 'voutIndex');
  const u = asU64(v);
  const vout = u !== undefined ? u.toString() : typeof v === 'string' ? v : undefined;
  return vout === undefined ? undefined : `${txHash}:${vout}`;
}

// upstream: brc20.rs::enrich_brc20_choice_assets — non-empty asset lists onto matching choices.
export function enrichBrc20ChoiceAssets(choices, assetRecords) {
  const byOutpoint = new Map();
  for (const record of assetRecords) {
    const assets = get(record, 'assets');
    if (!Array.isArray(assets) || !assets.length) continue;
    const key = recordOutpointKey(record);
    if (key !== undefined) byOutpoint.set(key, assets);
  }
  for (const choice of choices) {
    const selection = get(choice, 'selection');
    if (typeof selection !== 'string' || !byOutpoint.has(selection)) continue;
    if (isObject(choice)) choice.assets = byOutpoint.get(selection);
  }
  return choices;
}

// upstream: brc20.rs::cmd_brc20_transferable → output data
export async function cmdBrc20Transferable(tokenAddress, readableAmount) {
  const token = normalizeBrc20TokenAddress(tokenAddress);
  const context = await BtcContext.load(null);
  const api = new BtcApi();
  const metadata = await api.tokenMetadata(context, token);
  const decimals = extractTokenDecimals(metadata);
  const snapshot = await api.brc20TransferableUtxos(context, token);
  const transferable = parseBrc20TransferableUtxos(snapshot);
  const choices = transferable.map((utxo) => utxo.buildChoice(token, decimals));
  const assetRecords = await api.brc20UtxoAssetInfo(context, transferable.map((utxo) => utxo.outpoint));
  enrichBrc20ChoiceAssets(choices, assetRecords);
  const selectionPlan = readableAmount === undefined || readableAmount === null ? null
    : buildBrc20SelectionPlan(transferable, choices, readableAmount, decimals);
  const sumValueRaw = valueAsDecimalString(pointer(snapshot, '/brc20TransferableUtxoList/sumValueRaw')) ?? null;
  const sumValue = sumValueRaw === null ? null : minimalToReadable(sumValueRaw, decimals);
  return {
    message: 'Queried transferable BRC-20 inscription UTXOs. A transfer may use one or more returned selections whose token amounts exactly match the requested amount.',
    queryType: 'BRC20_TRANSFERABLE_UTXO_LIST',
    accountId: context.accountId,
    address: context.address.address,
    tokenAddress: token,
    count: choices.length,
    sumValue,
    sumValueRaw,
    choices,
    selectionPlan,
    brc20Transferable: snapshot,
  };
}
