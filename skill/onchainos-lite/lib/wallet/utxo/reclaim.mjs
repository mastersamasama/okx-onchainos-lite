// Close mempool-removed transactions to release service-side UTXO occupancy —
// upstream agentic_wallet/utxo/reclaim.rs.
import { CodedError } from '../../core/errors.mjs';
import { WalletPreviewConfirming } from '../common.mjs';
import { BtcApi } from '../shared/adapters/bitcoin/api.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { mapApiError } from '../shared/adapters/bitcoin/error.mjs';
import { collectOutpoints } from '../shared/adapters/bitcoin/models.mjs';
import { shellArg } from '../shared/common/json.mjs';
import { trim, asciiLower, cmpBytes } from '../../core/rs/str.mjs';
import { get } from '../../core/rs/value.mjs';
import { pointer } from './brc20.mjs';

// rust-bitcoin 0.32 `Txid::from_str` (hex-conservative array decode) error Display texts.
export function parseTxid(value) {
  if (Buffer.byteLength(value, 'utf8') !== 64) throw new Error('failed to parse hex');
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('failed to parse hex digit');
  return value;
}

// upstream: reclaim.rs::cmd_reclaim → output data (or WalletPreviewConfirming)
export async function cmdReclaim(txHashes, force) {
  if (!txHashes.length) throw new Error('at least one --tx-hash is required');
  const requested = [...new Set(txHashes.map((v) => asciiLower(trim(v))))].sort(cmpBytes);   // BTreeSet
  if (requested.length !== txHashes.length) throw new Error('duplicate --tx-hash values are not allowed');
  for (const txHash of requested) {
    try { parseTxid(txHash); } catch (e) { throw new Error(`invalid --tx-hash '${txHash}': ${e.message}`); }
  }
  const context = await BtcContext.load(null);
  const api = new BtcApi();
  const unavailable = await api.availabilityDetails(context, 'UNAVAILABLE_BREAKDOWN');
  const removed = pointer(unavailable, '/unavailableBreakdown/mempoolRemovedSpending');
  const mempoolRemoved = removed === undefined ? null : removed;
  const outpoints = collectOutpoints(mempoolRemoved);
  if (!outpoints.length) {
    throw new CodedError('NO_RECLAIMABLE_UTXO', null, 'The latest UTXO snapshot has no mempool-removed spending occupancy to reclaim',
      { data: { mempoolRemovedSpending: mempoolRemoved } });
  }
  const transactionDetails = [];
  for (const txHash of requested) transactionDetails.push(await api.orderDetail(context, txHash, null));

  if (!force) {
    const nextHashes = requested.map((h) => ` --tx-hash ${shellArg(h)}`).join('');
    throw new WalletPreviewConfirming({
      message: 'Review the original transaction hashes and the current mempool-removed occupancy snapshot. The service validates their reclaim relationship. Reclaim closes removed transactions; it does not broadcast a transaction or create an unconfirmed change output.',
      next: `onchainos wallet utxo reclaim --chain bitcoin${nextHashes} --force`,
      scene: 'btc_utxo_reclaim',
      preview: {
        operationType: 'RECLAIM_MEMPOOL_REMOVED_UTXOS',
        chainIndex: context.profile.chainIndex,
        network: 'bitcoin',
        from: context.address.address,
        txHashList: requested,
        currentMempoolRemovedInputOutpoints: outpoints.map((p) => p.canonical()),
        transactionDetails,
        mempoolRemovedSpending: mempoolRemoved,
        effect: 'Close the removed original transaction and release service-side spending occupancy for inputs that remain unspent on chain.',
      },
    });
  }

  let result;
  try { result = await api.closeTransactions(context, requested); } catch (e) { throw mapApiError(e); }
  const failed = validateCloseResult(result, requested);
  const latestUnavailable = await api.availabilityDetails(context, 'UNAVAILABLE_BREAKDOWN');
  if (failed.length) {
    throw new CodedError('RECLAIM_NOT_CLOSED', null, 'One or more mempool-removed transactions were not closed',
      { data: { failedTxHashes: failed, result, unavailable: latestUnavailable } });
  }
  return {
    message: 'The close-transaction request finished. Use each returned closed value and the latest unavailable UTXO snapshot as the authoritative result.',
    result,
    unavailable: latestUnavailable,
  };
}

// upstream: reclaim.rs::validate_close_result → failed tx hashes (lower-case)
export function validateCloseResult(result, requested) {
  if (!Array.isArray(result)) throw new Error('close-transaction response data must be an array');
  const wanted = new Set(requested.map(asciiLower));
  const returned = new Set();
  const failed = [];
  for (const item of result) {
    const raw = get(item, 'txHash');
    if (typeof raw !== 'string' || raw === '') throw new Error('close-transaction item is missing txHash');
    const txHash = asciiLower(raw);
    if (!wanted.has(txHash)) throw new Error(`close-transaction returned an unexpected txHash ${txHash}`);
    if (returned.has(txHash)) throw new Error(`close-transaction returned duplicate txHash ${txHash}`);
    returned.add(txHash);
    const closed = get(item, 'closed');
    if (closed === true) continue;
    if (closed === false) { failed.push(txHash); continue; }
    throw new Error('close-transaction item is missing closed');
  }
  if (returned.size !== wanted.size) throw new Error('close-transaction response does not cover every requested txHash');
  return failed;
}
