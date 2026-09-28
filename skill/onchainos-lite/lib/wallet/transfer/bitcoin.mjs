// Native BTC and BRC-20 transfers — upstream agentic_wallet/transfer/bitcoin.rs.
// Signs before confirmation: without --force the signed transfer is previewed
// (WalletPreviewConfirming, exit 2); with --force it is broadcast.
import { walletPreviewConfirming, handleConfirmingError } from '../common.mjs';
import { parseMinimal, readableToMinimal } from '../shared/common/amount.mjs';
import { shellArg } from '../shared/common/json.mjs';
import { BtcApi, extractTokenDecimals } from '../shared/adapters/bitcoin/api.mjs';
import { submitDirectTransaction } from '../shared/adapters/bitcoin/broadcast.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { mapApiError } from '../shared/adapters/bitcoin/error.mjs';
import { signUnsignedHashes } from '../shared/adapters/bitcoin/signing.mjs';
import { validateRecipient, parseFeeRate, normalizeBrc20TokenAddress, previewFromResponse } from '../shared/adapters/bitcoin/validation.mjs';
import { F64, stringify } from '../../core/json.mjs';
import { selectBrc20TransferableUtxos } from '../utxo/index.mjs';

const some = (v) => v !== undefined && v !== null;

// upstream: bitcoin.rs::cmd_send → success data (or throws WalletPreviewConfirming without --force)
export async function cmdSend(readableAmount, recipient, from, tokenAddress, brc20Outpoints, feeRate, force) {
  validateRecipient(recipient);
  const fee = some(feeRate) ? parseFeeRate(feeRate) : undefined;
  const token = some(tokenAddress) ? normalizeBrc20TokenAddress(tokenAddress) : undefined;
  const ctx = await BtcContext.load(from);
  const api = new BtcApi();

  let amount, symbol, selectedTxParam, selectedOutpoints;
  if (token !== undefined) {
    const snapshot = await api.brc20TransferableUtxos(ctx, token);
    let requested;
    if (some(readableAmount)) {
      const metadata = await api.tokenMetadata(ctx, token);
      requested = readableToMinimal(readableAmount, extractTokenDecimals(metadata));
    }
    [amount, selectedTxParam, selectedOutpoints] = buildBrc20TransferParameters(snapshot, brc20Outpoints, ctx.address.address, requested);
    symbol = token;
  } else {
    if (brc20Outpoints.length) throw new Error('--brc20-outpoint requires a BRC-20 --contract-token');
    if (!some(readableAmount)) throw new Error('--readable-amount is required');
    amount = readableToMinimal(readableAmount, ctx.profile.nativeDecimals);
    symbol = ctx.profile.nativeSymbol;
    selectedOutpoints = [];
  }
  if (selectedTxParam !== undefined && fee !== undefined) selectedTxParam.feeRate = fee;

  let prepared;
  try {
    prepared = token !== undefined && selectedTxParam !== undefined
      ? await api.prepareSelectedBrc20Transfer(ctx, recipient, amount, token, selectedTxParam)
      : await api.prepareTransaction(ctx, recipient, amount, undefined, undefined, fee);
  } catch (e) {
    throw mapApiError(e);
  }

  const seed = ctx.signingSeed();
  const signatures = signUnsignedHashes(prepared, seed);
  if (!force) {
    const operation = token !== undefined ? 'BRC20_TRANSFER' : 'BTC_TRANSFER';
    const readable = some(readableAmount) ? readableAmount : amount;
    const preview = previewFromResponse(prepared, operation, ctx.profile.chainIndex, ctx.address.address, recipient, token, amount, readable, ctx.profile.nativeDecimals);
    throw walletPreviewConfirming({
      message: 'The transfer has been signed and is ready to broadcast. Review the transfer and current network fee before confirming.',
      next: buildSendNextCommand(recipient, ctx.address.address, token, readable, selectedOutpoints, preview.feeRate),
      scene: token !== undefined ? 'brc20_transfer' : 'btc_transfer',
      preview,
    });
  }
  let broadcast;
  try {
    broadcast = await submitDirectTransaction(api, ctx, prepared, signatures, force);
  } catch (e) {
    throw mapApiError(handleConfirmingError(e, force));
  }
  const submitted = { txHash: broadcast.txHash, orderId: broadcast.orderId };
  return {
    message: 'Bitcoin transaction submitted. The final result is pending network confirmation.',
    state: 'PENDING',
    accountId: ctx.accountId,
    chainIndex: ctx.profile.chainIndex,
    from: ctx.address.address,
    to: recipient,
    asset: symbol,
    amount,
    selectedBrc20Outpoints: selectedOutpoints,
    txHash: submitted.txHash,
    orderId: submitted.orderId,
    broadcasts: [submitted],
  };
}

// upstream: bitcoin.rs::build_send_next_command — the exact confirmed command (no signing data).
// `feeRate` is the preview's feeRate Value: a number (its JSON text) or a valid fee-rate string.
export function buildSendNextCommand(recipient, from, tokenAddress, readableAmount, selectedOutpoints, feeRate) {
  let command = `onchainos wallet send --chain bitcoin --recipient ${shellArg(recipient)} --readable-amount ${shellArg(readableAmount)}`;
  command += ` --from ${shellArg(from)}`;
  if (some(tokenAddress)) command += ` --contract-token ${shellArg(tokenAddress)}`;
  for (const o of selectedOutpoints) command += ` --brc20-outpoint ${shellArg(o)}`;
  let fr;
  if (typeof feeRate === 'number' || typeof feeRate === 'bigint' || feeRate instanceof F64) fr = stringify(feeRate);
  else if (typeof feeRate === 'string') { try { parseFeeRate(feeRate); fr = feeRate; } catch { fr = undefined; } }
  if (fr !== undefined) command += ` --fee-rate ${shellArg(fr)}`;
  return command + ' --force';
}

// upstream: bitcoin.rs::build_brc20_transfer_parameters → [amount, txParam, selectedOutpoints]
export function buildBrc20TransferParameters(snapshot, selections, address, requestedAmount) {
  const selected = selectBrc20TransferableUtxos(snapshot, selections);
  let total = 0n;
  selected.forEach((utxo, index) => { total += parseMinimal(utxo.valueRaw, `selected BRC-20 UTXO ${index} valueRaw`, false); });
  const selectedAmount = total.toString();
  if (some(requestedAmount) && requestedAmount !== selectedAmount) throw new Error('--readable-amount does not match the combined BRC-20 UTXO amount');
  const inputs = selected.map((u) => u.buildTxParamInput(address));
  return [selectedAmount, { amount: selectedAmount, inputs }, selected.map((u) => u.outpoint.canonical())];
}
