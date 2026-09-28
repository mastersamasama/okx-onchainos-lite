// Native SUI / Coin<T> transfers and SUI PTB contract calls — upstream agentic_wallet/transfer/sui.rs.
import { CodedError, context } from '../../core/errors.mjs';
import { parse as parseJson, stringify } from '../../core/json.mjs';
import { validateNonNegativeInteger } from '../../core/validators.mjs';
import { walletPreviewConfirming, handleConfirmingError } from '../common.mjs';
import { displayTop } from '../api.mjs';
import { decimalField, minimalToReadable, readableToMinimal, valueAsDecimalString } from '../shared/common/amount.mjs';
import { shellArg } from '../shared/common/json.mjs';
import { buildDirectExtraData } from '../shared/common/unsigned-hash-list.mjs';
import { SuiApi, mapApiError } from '../shared/adapters/sui/api.mjs';
import { SuiContext } from '../shared/adapters/sui/context.mjs';
import { NATIVE_COIN_TYPE, normalizeAddress, normalizeCoinType } from '../shared/adapters/sui/identifiers.mjs';
import { signUnsignedHashes } from '../shared/adapters/sui/signing.mjs';
import { get, isObject, rustTrim, base64Decode } from '../shared/_rust.mjs';

const some = (v) => v !== undefined && v !== null;
const orNull = (v) => (v === undefined ? null : v);

// upstream: sui.rs::map_local_input_error — `error.to_string()` (outermost message only).
function mapLocalInputError(error) {
  return new CodedError('LOCAL_PRECHECK_FAILED', null, displayTop(error));
}
const localSigningFailed = (e) => new CodedError('LOCAL_SIGNING_FAILED', null, displayTop(e));

// upstream: sui.rs::cmd_send → success data (or WalletPreviewConfirming without --force)
export async function cmdSend(readableAmount, recipient, from, coinType, force) {
  let normalizedRecipient, normalizedCoinType;
  try { normalizedRecipient = normalizeAddress(recipient); } catch (e) { throw mapLocalInputError(e); }
  if (some(coinType)) { try { normalizedCoinType = normalizeCoinType(coinType); } catch (e) { throw mapLocalInputError(e); } }
  const ctx = await SuiContext.load(from);
  const api = new SuiApi();

  let decimals, symbol, effectiveCoinType;
  if (normalizedCoinType !== undefined) {
    const metadata = await api.tokenMetadata(ctx, normalizedCoinType);
    decimals = decimalField(metadata);
    if (decimals === undefined) throw new CodedError('INCOMPLETE_ASSET_METADATA', 'contract-token', 'SUI token metadata is missing decimal');
    const s = get(metadata, 'symbol');
    symbol = typeof s === 'string' && s !== '' ? s : normalizedCoinType;
    effectiveCoinType = normalizedCoinType;
  } else {
    decimals = ctx.profile.nativeDecimals;
    symbol = ctx.profile.nativeSymbol;
    effectiveCoinType = NATIVE_COIN_TYPE;
  }
  let amount;
  try { amount = readableToMinimal(readableAmount, decimals); } catch (e) { throw mapLocalInputError(e); }
  const prepared = await api.prepareTransaction(ctx, normalizedRecipient, amount, normalizedCoinType);
  ensureSimulationSucceeded(prepared);
  let seed, signatures;
  try { seed = ctx.signingSeed(); } catch (e) { throw localSigningFailed(e); }
  try { signatures = signUnsignedHashes(prepared, seed); } catch (e) { throw localSigningFailed(e); }
  if (!force) {
    throw walletPreviewConfirming({
      message: 'The transfer has been signed and is ready to broadcast. Review the transfer and current network fee before confirming.',
      next: buildSendNextCommand(normalizedRecipient, ctx.address.address, normalizedCoinType, readableAmount),
      scene: 'sui_transfer',
      preview: previewFromPrepared(prepared, ctx, normalizedRecipient, effectiveCoinType, symbol, amount, readableAmount),
    });
  }
  let broadcast;
  try {
    broadcast = await broadcastPreparedTransaction(api, ctx, prepared, signatures, force, undefined, undefined);
  } catch (e) {
    throw mapApiError(handleConfirmingError(e, force));
  }
  return {
    message: 'SUI transaction submitted. The final result is pending network confirmation.',
    state: 'PENDING',
    chainIndex: ctx.profile.chainIndex,
    from: ctx.address.address,
    to: normalizedRecipient,
    coinType: effectiveCoinType,
    symbol,
    amount,
    txHash: broadcast.txHash,
    orderId: broadcast.orderId,
  };
}

// upstream: sui.rs::preview_from_prepared — non-sensitive confirmation preview (sorted keys)
export function previewFromPrepared(prepared, ctx, recipient, coinType, symbol, amount, readableAmount) {
  const list = get(prepared, 'unsignedHashList');
  if (!Array.isArray(list) || !list.length) throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: unsignedHashList is empty');
  const signType = get(prepared, 'signType');
  if (typeof signType !== 'string' || signType === '') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing signType');
  const encoding = get(prepared, 'encoding');
  if (typeof encoding !== 'string' || encoding === '') throw new Error('INCOMPLETE_TRANSACTION_PREVIEW: missing encoding');
  const tp = get(prepared, 'txParam');
  const transaction = isObject(tp) ? tp : {};
  const firstNonNull = (obj) => {
    for (const k of ['fee', 'gasFee']) { const v = get(obj, k); if (v !== undefined && v !== null) return v; }
    return undefined;
  };
  let fee = firstNonNull(transaction);
  if (fee === undefined) fee = firstNonNull(prepared);
  fee = orNull(fee);
  const feeText = valueAsDecimalString(fee);
  const feeReadable = feeText === undefined ? null : minimalToReadable(feeText, ctx.profile.nativeDecimals);
  const gasPrice = get(transaction, 'gasPrice') !== undefined ? get(transaction, 'gasPrice') : get(prepared, 'gasPrice');
  return {
    operationType: 'SUI_TRANSFER',
    chainIndex: ctx.profile.chainIndex,
    network: 'sui',
    from: ctx.address.address,
    to: recipient,
    asset: { coinType, symbol, amount, readableAmount },
    feeRate: orNull(gasPrice),
    fee,
    feeReadable,
    feeSymbol: ctx.profile.nativeSymbol,
    preExecution: { executeResult: orNull(get(prepared, 'executeResult')), executeErrorMsg: orNull(get(prepared, 'executeErrorMsg')) },
    signing: { signType, encoding, unsignedItemCount: list.length },
    warnings: get(prepared, 'warnings') !== undefined ? get(prepared, 'warnings') : [],
  };
}

// upstream: sui.rs::build_send_next_command
export function buildSendNextCommand(recipient, from, coinType, readableAmount) {
  let command = `onchainos wallet send --chain sui --recipient ${shellArg(recipient)} --readable-amount ${shellArg(readableAmount)}`;
  command += ` --from ${shellArg(from)}`;
  if (some(coinType)) command += ` --contract-token ${shellArg(coinType)}`;
  return command + ' --force';
}

// upstream: sui.rs::cmd_contract_call — DApp-built TransactionData / PTB (no preview) → data
export async function cmdContractCall(txBytes, to, amount, from, force, agentBizType, agentSkillName) {
  try { validateTxBytes(txBytes); } catch (e) { throw mapLocalInputError(e); }
  try { validateNonNegativeInteger(amount, 'amt'); } catch (e) { throw mapLocalInputError(e); }
  let normalizedTo;
  if (some(to)) { try { normalizedTo = normalizeAddress(to); } catch (e) { throw mapLocalInputError(e); } }
  const ctx = await SuiContext.load(from);
  const api = new SuiApi();
  const prepared = await api.prepareContractCall(ctx, normalizedTo, amount, rustTrim(txBytes));
  ensureSimulationSucceeded(prepared);
  let seed, signatures;
  try { seed = ctx.signingSeed(); } catch (e) { throw localSigningFailed(e); }
  try { signatures = signUnsignedHashes(prepared, seed); } catch (e) { throw localSigningFailed(e); }
  let broadcast;
  try {
    broadcast = await broadcastPreparedTransaction(api, ctx, prepared, signatures, force, agentBizType, agentSkillName);
  } catch (e) {
    throw mapApiError(handleConfirmingError(e, force));
  }
  return {
    message: 'SUI contract transaction submitted. The final result is pending network confirmation.',
    state: 'PENDING',
    chainIndex: ctx.profile.chainIndex,
    txHash: broadcast.txHash,
    orderId: broadcast.orderId,
  };
}

// upstream: sui.rs::validate_tx_bytes — transport encoding only (standard padded base64).
export function validateTxBytes(txBytes) {
  const t = rustTrim(txBytes);
  if (t === '') throw new Error('--sui-tx-bytes must not be empty');
  let decoded;
  try { decoded = base64Decode(t); } catch (e) { throw context('--sui-tx-bytes must be valid base64', e); }
  if (!decoded.length) throw new Error('--sui-tx-bytes must decode to non-empty TransactionData');
}

// upstream: sui.rs::ensure_simulation_succeeded
export function ensureSimulationSucceeded(prepared) {
  if (get(prepared, 'executeResult') === false) {
    const m = get(prepared, 'executeErrorMsg');
    throw new Error(`transaction simulation failed: ${typeof m === 'string' && m !== '' ? m : 'transaction simulation failed'}`);
  }
}

// upstream: sui.rs::broadcast_prepared_transaction → BroadcastResponse
async function broadcastPreparedTransaction(api, ctx, prepared, signedHashes, force, agentBizType, agentSkillName) {
  const encoded = buildDirectExtraData(prepared, signedHashes, ctx.sessionCert(), force, 'SUI');
  let extraData;
  try { extraData = parseJson(encoded); } catch (e) { throw context('failed to parse serialized SUI extraData', e); }
  if (some(agentBizType)) extraData.agentBizType = agentBizType;
  if (some(agentSkillName)) extraData.agentSkillName = agentSkillName;
  let serialized;
  try { serialized = stringify(extraData); } catch (e) { throw context('failed to serialize SUI extraData', e); }
  return api.broadcastTransaction(ctx, serialized);
}
