// BRC-20 transfer-inscription creation (preview → `--operation-token … --force`) and status —
// upstream agentic_wallet/inscription/bitcoin.rs.
import { stringify } from '../../core/json.mjs';
import { WalletPreviewConfirming } from '../common.mjs';
import { readableToMinimal } from '../shared/common/amount.mjs';
import { findString, shellArg } from '../shared/common/json.mjs';
import { BtcApi, extractTokenDecimals } from '../shared/adapters/bitcoin/api.mjs';
import { submitInscriptionTransactions } from '../shared/adapters/bitcoin/broadcast.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { mapApiError } from '../shared/adapters/bitcoin/error.mjs';
import { nextSteps, ReadOnlyNextStep } from '../shared/adapters/bitcoin/models.mjs';
import { signUnsignedHashes } from '../shared/adapters/bitcoin/signing.mjs';
import {
  normalizeBrc20TokenAddress, parseFeeRate, isLocalContinuation, previewFromResponse, validatePreviewIntent,
  bindUtxoAvailability, localTransactionToken,
} from '../shared/adapters/bitcoin/validation.mjs';
import { asciiUpper } from '../../core/_rust-str.mjs';

const some = (v) => v !== undefined && v !== null;

// upstream: bitcoin.rs::cmd_create → output data (or WalletPreviewConfirming)
export async function cmdCreate(tokenAddress, readableAmount, from, operationToken, feeRate, force) {
  const token = normalizeBrc20TokenAddress(tokenAddress);
  const rate = some(feeRate) ? parseFeeRate(feeRate) : undefined;
  if (force && !some(operationToken)) throw new Error('confirmed inscription requires --operation-token');
  if (!force && some(operationToken)) throw new Error('--operation-token is only valid with --force');
  if (some(operationToken) && !isLocalContinuation(operationToken)) throw new Error('invalid Bitcoin preview continuation');

  const context = await BtcContext.load(some(from) ? from : null);
  const api = new BtcApi();
  const metadata = await api.tokenMetadata(context, token);
  const decimals = extractTokenDecimals(metadata);
  const amount = readableToMinimal(readableAmount, decimals);
  const unavailable = await api.availabilityDetails(context, 'UNAVAILABLE_BREAKDOWN');
  const own = context.address.address;
  let prepared;
  try { prepared = await api.prepareTransaction(context, own, amount, token, 'brc20Inscribe', rate); } catch (e) { throw mapApiError(e); }

  const chainIndex = context.profile.chainIndex;
  const preview = previewFromResponse(prepared, 'BRC20_INSCRIBE', chainIndex, own, own, token, amount, readableAmount, context.profile.nativeDecimals);
  validatePreviewIntent(preview, 'BRC20_INSCRIBE', chainIndex, own, own, amount);
  bindUtxoAvailability(preview, unavailable);
  const localToken = localTransactionToken(prepared, preview);
  const next = buildInscriptionNextCommand(token, readableAmount, rate, localToken);

  if (force && operationToken !== localToken) {
    throw new WalletPreviewConfirming({
      message: 'The BRC-20 inscription changed after the previous preview. Review the refreshed funding inputs and fees before confirming again.',
      next, scene: 'btc_inscription', preview,
    });
  }

  if (force) {
    const seed = context.signingSeed();
    const signatures = signUnsignedHashes(prepared, seed);
    let broadcasts;
    try { broadcasts = await submitInscriptionTransactions(api, context, prepared, signatures, token, amount, force); } catch (e) { throw mapApiError(e); }
    const reveal = selectRevealBroadcast(broadcasts);
    const revealTxHash = reveal ? reveal.txHash : '';
    const revealOrderId = reveal ? reveal.orderId : '';
    let statusNextSteps;
    if (revealOrderId !== '') statusNextSteps = nextSteps([ReadOnlyNextStep.checkInscriptionStatus({ txHash: null, orderId: revealOrderId })]);
    else if (revealTxHash !== '') statusNextSteps = nextSteps([ReadOnlyNextStep.checkInscriptionStatus({ txHash: revealTxHash, orderId: null })]);
    return {
      message: 'BRC-20 inscription submitted. Inscription is asynchronous; query it later with the returned Reveal order ID.',
      state: 'INSCRIBING',
      accountId: context.accountId,
      chainIndex,
      from: own,
      tokenAddress: token,
      amount,
      txHash: revealTxHash,
      orderId: revealOrderId,
      broadcasts: broadcasts.map((b) => ({ txHash: b.txHash, orderId: b.orderId })),
      nextSteps: statusNextSteps,
    };
  }

  throw new WalletPreviewConfirming({
    message: `Review BRC-20 inscription. From: ${own}. Ticker/token: ${token}. Amount: ${readableAmount}. This submits an asynchronous inscription only; review every funding input, output, fee, and warning before confirming.`,
    next, scene: 'btc_inscription', preview,
  });
}

// upstream: bitcoin.rs::select_reveal_broadcast — the final batch item (the Reveal transaction).
export const selectRevealBroadcast = (broadcasts) => (broadcasts.length ? broadcasts[broadcasts.length - 1] : undefined);

// upstream: bitcoin.rs::build_inscription_next_command — `feeRate` is the parsed JSON number.
export function buildInscriptionNextCommand(tokenAddress, readableAmount, feeRate, operationToken) {
  let command = `onchainos wallet inscription create --chain bitcoin --token-address ${shellArg(tokenAddress)} --readable-amount ${shellArg(readableAmount)} --operation-token ${shellArg(operationToken)}`;
  if (some(feeRate)) command += ` --fee-rate ${stringify(feeRate)}`;
  return `${command} --force`;
}

// upstream: bitcoin.rs::cmd_query_status → output data
export async function cmdQueryStatus(txHash, orderId) {
  if (!some(txHash) && !some(orderId)) throw new Error('either --tx-hash or --order-id is required');
  const context = await BtcContext.load(null);
  const detail = await new BtcApi().orderDetail(context, some(txHash) ? txHash : null, some(orderId) ? orderId : null);
  const status = normalizeInscriptionStatus(findString(detail, ['status', 'txStatus']) ?? 'UNKNOWN');
  const pending = ['INSCRIBING', 'WAITING_CONFIRMATION', 'WAITING_INDEXER'].includes(status);
  const hasPollSchedule = findString(detail, ['nextQueryAt', 'pollAfterSeconds']) !== undefined;
  const result = {
    message: inscriptionStatusMessage(status, hasPollSchedule),
    status,
    txHash: some(txHash) ? txHash : null,
    orderId: some(orderId) ? orderId : null,
    detail,
  };
  if (pending && hasPollSchedule) {
    result.nextSteps = nextSteps([ReadOnlyNextStep.checkInscriptionStatus({ txHash: some(txHash) ? txHash : null, orderId: some(orderId) ? orderId : null })]);
  } else if (status === 'READY_TO_TRANSFER') {
    const token = findString(result.detail, ['tokenAddress', 'contractAddr']);
    if (token !== undefined) result.nextSteps = nextSteps([ReadOnlyNextStep.queryBrc20TransferableUtxos(token)]);
  }
  return result;
}

// upstream: bitcoin.rs::normalize_inscription_status
export function normalizeInscriptionStatus(raw) {
  const upper = asciiUpper(raw);
  switch (upper) {
    case '1': case '2': return 'INSCRIBING';
    case '3': case '6': return 'FAILED';
    case '4': return 'READY_TO_TRANSFER';
    default: return upper;
  }
}

// upstream: bitcoin.rs::inscription_status_message
export function inscriptionStatusMessage(status, hasPollSchedule) {
  if (status === 'READY_TO_TRANSFER') return 'The BRC-20 inscription is ready. Refresh the transferable balance before starting a separate transfer.';
  if (status === 'FAILED' || status === 'UNKNOWN') return 'The BRC-20 inscription is not available; review the service detail before deciding whether to create another inscription.';
  if (hasPollSchedule) return 'The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query again at the service-recommended time.';
  return 'The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query it again later with the returned transaction hash or order ID.';
}
