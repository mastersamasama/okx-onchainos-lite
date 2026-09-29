// `payment decode-receipt` — upstream commands/payment/decode_receipt.rs.
// Decode an x402 PAYMENT-RESPONSE header or a raw charge-receipt JSON into one normalized
// {status, transaction, amount, payer, chainId} shape. Read-only; no auth, no funds.
import { parse } from '../core/json.mjs';
import { trim } from '../core/rs/str.mjs';
import { get, isNumber, numText } from '../core/rs/value.mjs';
import { decodePaymentBlob } from './dispatcher.mjs';

// upstream: decode_receipt.rs::TOKEN_INVALID_INPUT
export const TOKEN_INVALID_INPUT = 'invalid_input';
const invalid = () => new Error(`${TOKEN_INVALID_INPUT}: could not decode receipt`);

// upstream: decode_receipt.rs::decode_receipt → DecodedReceipt {status, transaction, amount, payer, chainId}
export function decodeReceipt(header, receipt) {
  let value;
  const h = header == null ? '' : trim(header);
  const r = receipt == null ? '' : trim(receipt);
  if (h !== '') {
    try { value = decodePaymentBlob(h); } catch { throw invalid(); }
  } else if (r !== '') {
    try { value = parse(r); } catch { throw invalid(); }
  } else throw invalid();
  return normalize(value);
}

// upstream: decode_receipt.rs::fetch_decode_receipt — serde_json::to_value (sorted keys)
export function fetchDecodeReceipt(header, receipt) {
  const d = decodeReceipt(header, receipt);
  return { status: d.status, transaction: d.transaction, amount: d.amount, payer: d.payer, chainId: d.chainId };
}

// upstream: decode_receipt.rs::pick (private)
function pick(v, keys) {
  for (const k of keys) {
    const x = get(v, k);
    if (typeof x === 'string' && x !== '') return x;
    if (isNumber(x)) return numText(x);
  }
  return undefined;
}

// upstream: decode_receipt.rs::normalize (private)
function normalize(v) {
  let status = pick(v, ['status']);
  if (status === undefined) {
    const s = get(v, 'success');
    status = s === true ? 'success' : s === false ? 'failed' : 'unknown';
  }
  return {
    status,
    transaction: pick(v, ['transaction', 'txHash', 'transactionHash']) ?? '',
    amount: pick(v, ['amount', 'value']) ?? '',
    payer: pick(v, ['payer', 'from']) ?? '',
    chainId: pick(v, ['chainId', 'network', 'chain_id']) ?? '',
  };
}
