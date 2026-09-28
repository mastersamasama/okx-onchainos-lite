// Bitcoin address / fee-rate / preview validation — upstream
// agentic_wallet/shared/adapters/bitcoin/validation.rs.
import { parse as parseJson } from '../../../../core/json.mjs';
import { minimalToReadable, parseMinimal, valueAsDecimalString } from '../../common/amount.mjs';
import { BtcOutPoint, collectOutpoints } from './models.mjs';
import { parseUnchecked, requireMainnet, addressType, scriptPubkey } from './_address.mjs';
import { rustTrim, asciiLower, get, isObject, asU64, parseU64, isAllAsciiDigits, jcsStringify, sha256Hex } from '../../_rust.mjs';

// upstream: validation.rs::parse_mainnet_address
function parseMainnetAddress(value, field) {
  let unchecked;
  try { unchecked = parseUnchecked(rustTrim(value)); } catch (e) { throw new Error(`invalid ${field} Bitcoin address: ${e.message}`); }
  try { return requireMainnet(unchecked); } catch (e) { throw new Error(`${field} must be a Bitcoin mainnet address: ${e.message}`); }
}

// upstream: validation.rs::validate_wallet_address — mainnet P2TR only.
export function validateWalletAddress(value) {
  const address = parseMainnetAddress(value, 'wallet');
  if (addressType(address) !== 'p2tr') throw new Error('current Agentic Wallet Bitcoin address must be Taproot (P2TR)');
}

// upstream: validation.rs::validate_recipient
export function validateRecipient(value) {
  parseMainnetAddress(value, 'recipient');
}

// upstream: validation.rs::parse_fee_rate → the JSON number (integer / F64) for txParam.feeRate
export function parseFeeRate(value) {
  const v = rustTrim(value);
  const bad = () => new Error('--fee-rate must be a decimal sat/vB value');
  let integer = v, fraction;
  const dot = v.indexOf('.');
  if (dot >= 0) {
    integer = v.slice(0, dot);
    fraction = v.slice(dot + 1);
    if (v.split('.').length - 1 !== 1 || fraction === '') throw bad();
  }
  if (integer === '' || !isAllAsciiDigits(integer) || (fraction !== undefined && !isAllAsciiDigits(fraction)) || (integer.length > 1 && integer.startsWith('0'))) throw bad();
  const scale = fraction === undefined ? 0 : fraction.length;
  const unscaled = BigInt(integer + (fraction ?? ''));
  if (unscaled * 10n < 10n ** BigInt(scale)) throw new Error('--fee-rate must be at least 0.1 sat/vB');
  let parsed;
  try { parsed = parseJson(v); } catch { throw bad(); }
  return parsed;
}

// upstream: validation.rs::normalize_brc20_token_address → `btc-brc20-<ticker lower-cased>`
export function normalizeBrc20TokenAddress(value) {
  const PREFIX = 'btc-brc20-';
  const v = rustTrim(value);
  const bytes = Buffer.from(v, 'utf8');
  const head = bytes.subarray(0, PREFIX.length);
  const prefixOk = head.length === PREFIX.length && head.every((b) => b < 0x80) && asciiLower(head.toString('latin1')) === PREFIX;
  if (bytes.length <= PREFIX.length || !prefixOk || bytes.length > PREFIX.length + 64) throw new Error('BRC-20 token address must use btc-brc20-<ticker>');
  const ticker = v.slice(PREFIX.length);
  if (Buffer.from(ticker, 'utf8').some((b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b < 0x20 || b === 0x7f || b === 0x2f)) {
    throw new Error('BRC-20 ticker contains unsupported characters');
  }
  return `${PREFIX}${asciiLower(ticker)}`;
}

// upstream: validation.rs::same_address — scriptPubKey equality (left parsed as `from`, right as `wallet`).
export function sameAddress(left, right) {
  const l = scriptPubkey(parseMainnetAddress(left, 'from'));
  const r = scriptPubkey(parseMainnetAddress(right, 'wallet'));
  return l.equals(r);
}

const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
const orNull = (v) => (v === undefined ? null : v);

// upstream: validation.rs::preview_from_response → preview Value (sorted keys)
export function previewFromResponse(response, operation, chainIndex, from, to, tokenAddress, amount, readableAmount, nativeDecimals) {
  const executeResult = get(response, 'executeResult');
  if (typeof executeResult !== 'boolean') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing executeResult');
  if (!executeResult) {
    const m = get(response, 'executeErrorMsg');
    throw new Error(`PRE_EXECUTION_FAILED: ${typeof m === 'string' && m !== '' ? m : 'Bitcoin transaction pre-execution failed'}`);
  }
  const transaction = get(response, 'txParam');
  if (!isObject(transaction)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: response is missing txParam');
  const inputs = get(transaction, 'inputs');
  if (!nonEmptyArray(inputs)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: txParam.inputs is empty');
  const outputs = get(transaction, 'outputs') === undefined ? [] : get(transaction, 'outputs');
  if (operation !== 'BRC20_INSCRIBE' && !nonEmptyArray(outputs)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: txParam.outputs is empty');
  const list = get(response, 'unsignedHashList');
  if (!nonEmptyArray(list)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: unsignedHashList is empty');
  const signType = get(response, 'signType');
  if (typeof signType !== 'string' || signType === '') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing signType');
  const expected = operation === 'BRC20_INSCRIBE' ? 'brc20Inscribe' : 'transfer';
  if (signType !== expected) throw new Error(`PREVIEW_INTENT_MISMATCH: expected signType ${expected}, got ${signType}`);
  const encoding = get(response, 'encoding');
  if (typeof encoding !== 'string' || encoding === '') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing encoding');

  const fee = orNull(get(transaction, 'fee'));
  const feeText = valueAsDecimalString(fee);
  const feeReadable = feeText === undefined ? null : minimalToReadable(feeText, nativeDecimals);
  const symbol = tokenAddress !== undefined && tokenAddress !== null && tokenAddress.startsWith('btc-brc20-') ? tokenAddress.slice('btc-brc20-'.length) : 'BTC';
  return {
    operationType: operation,
    chainIndex,
    network: 'bitcoin',
    from,
    to,
    asset: { tokenAddress: tokenAddress ?? null, symbol, amount, readableAmount },
    feeRate: orNull(get(transaction, 'feeRate')),
    fee,
    feeReadable,
    feeSymbol: 'BTC',
    inputs,
    outputs,
    changeAddress: orNull(get(transaction, 'changeAddress')),
    transaction,
    preExecution: { executeResult: true, executeErrorMsg: orNull(get(response, 'executeErrorMsg')) },
    signing: { signType, encoding, unsignedItemCount: list.length },
    warnings: get(response, 'warnings') === undefined ? [] : get(response, 'warnings'),
  };
}

const countLike = (v) => asU64(v) ?? (typeof v === 'string' ? parseU64(v) : undefined);

// upstream: validation.rs::bind_utxo_availability — mutates `preview`.
export function bindUtxoAvailability(preview, snapshot) {
  const inputs = get(preview, 'inputs');
  if (inputs === undefined) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing inputs');
  const selected = collectOutpoints(inputs);
  const unavailable = collectOutpoints(snapshot);
  const reported = countLike(get(get(snapshot, 'unavailableBreakdown'), 'totalUnavailableCount'));
  if (reported !== undefined && reported > BigInt(unavailable.length)) {
    throw new Error('INCOMPLETE_UTXO_SNAPSHOT: unavailable UTXO count exceeds the returned outpoint set');
  }
  const unavailableSet = new Set(unavailable.map((p) => p.canonical()));
  const selectedOutpoints = selected.map((p) => p.canonical());
  const rejected = selectedOutpoints.filter((o) => unavailableSet.has(o));
  if (rejected.length) throw new Error(`PREVIEW_UTXO_UNAVAILABLE: selected inputs are unavailable: ${rejected.join(', ')}`);
  preview.utxoAvailability = { queryType: 'UNAVAILABLE_BREAKDOWN', selectedAvailableInputs: selectedOutpoints, unavailable: snapshot };
}

// upstream: validation.rs::validate_preview_intent
export function validatePreviewIntent(preview, operation, chainIndex, from, to, amount) {
  compareIfPresent(preview, ['operationType', 'operation'], operation, 'operation');
  compareIfPresent(preview, ['chainIndex'], chainIndex, 'chainIndex');
  compareIfPresent(preview, ['from', 'fromAddr'], from, 'from');
  if (to !== undefined && to !== null) compareIfPresent(preview, ['to', 'toAddr'], to, 'to');
  if (amount !== undefined && amount !== null) compareIfPresent(get(preview, 'asset') ?? null, ['amount'], amount, 'amount');
  validateTransactionShape(preview, operation, from, to, amount);
}

// Option::or_else over two keys, then a conversion: the first *present* key wins.
const firstPresent = (v, a, b) => (get(v, a) !== undefined ? get(v, a) : get(v, b));

// upstream: validation.rs::validate_transaction_shape
function validateTransactionShape(preview, operation, from, to, amount) {
  const inputs = get(preview, 'inputs');
  if (!Array.isArray(inputs)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing inputs');
  const outpoints = new Set();
  for (const input of inputs) {
    const txId = firstPresent(input, 'txId', 'txHash');
    if (typeof txId !== 'string') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: input txId missing');
    const vout = countLike(firstPresent(input, 'vout', 'voutIndex'));
    if (vout === undefined) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: input vout missing');
    const outpoint = BtcOutPoint.parse(`${txId}:${vout}`);
    if (outpoints.has(outpoint.canonical())) throw new Error(`INCOMPLETE_TRANSACTION_PREVIEW: duplicate input ${outpoint.canonical()}`);
    outpoints.add(outpoint.canonical());
    const inputAmount = valueAsDecimalString(get(input, 'amount'));
    if (inputAmount === undefined) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: input amount missing');
    parseMinimal(inputAmount, 'input amount', false);
    const address = get(input, 'address');
    if (typeof address === 'string' && !sameAddress(address, from)) throw new Error('PREVIEW_INTENT_MISMATCH: input address is not the current account');
  }
  const change = get(preview, 'changeAddress');
  if (typeof change === 'string' && change !== '' && !sameAddress(change, from)) throw new Error('PREVIEW_INTENT_MISMATCH: change address is not the current account');

  const outputs = get(preview, 'outputs');
  if (!Array.isArray(outputs)) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing outputs');
  for (const output of outputs) {
    const outputAmount = valueAsDecimalString(get(output, 'amount'));
    if (outputAmount === undefined) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: output amount missing');
    parseMinimal(outputAmount, 'output amount', true);
    const address = get(output, 'address');
    if (typeof address !== 'string') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: output address missing');
    validateRecipient(address);
  }
  if (operation !== 'BRC20_INSCRIBE') {
    if (to === undefined || to === null) throw new Error('preview recipient is required');
    const recipientOutput = outputs.find((o) => {
      const a = get(o, 'address');
      if (typeof a !== 'string') return false;
      try { return sameAddress(a, to); } catch { return false; }
    });
    if (!recipientOutput) throw new Error('PREVIEW_INTENT_MISMATCH: recipient output is missing');
    if (operation === 'BTC_TRANSFER') {
      if (amount === undefined || amount === null) throw new Error('preview amount is required');
      compareIfPresent(recipientOutput, ['amount'], amount, 'recipient amount');
    }
  }
}

// upstream: validation.rs::local_transaction_token — "sha256:" + hex(SHA-256(JCS(binding)))
export function localTransactionToken(response, preview) {
  const binding = {
    preview,
    unsignedHashList: orNull(get(response, 'unsignedHashList')),
    signType: orNull(get(response, 'signType')),
    encoding: orNull(get(response, 'encoding')),
    extraData: orNull(get(response, 'extraData')),
  };
  return `sha256:${sha256Hex(jcsStringify(binding))}`;
}

// upstream: validation.rs::is_local_continuation
export function isLocalContinuation(token) {
  return typeof token === 'string' && token.startsWith('sha256:') && /^[0-9a-fA-F]{64}$/.test(token.slice(7));
}

// upstream: validation.rs::compare_if_present
function compareIfPresent(preview, keys, expected, field) {
  const key = keys.find((k) => get(preview, k) !== undefined);
  if (key === undefined) return;
  const raw = get(preview, key);
  const u = asU64(raw);
  const actual = typeof raw === 'string' ? raw : u !== undefined ? u.toString() : '';
  if (actual !== expected) throw new Error(`PREVIEW_INTENT_MISMATCH: ${field} changed from '${expected}' to '${actual}'`);
}
