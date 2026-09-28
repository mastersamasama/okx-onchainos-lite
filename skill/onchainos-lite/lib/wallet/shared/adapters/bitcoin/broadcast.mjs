// Bitcoin direct-transfer and inscription broadcasts — upstream
// agentic_wallet/shared/adapters/bitcoin/broadcast.rs.
import { parse as parseJson, stringify, F64 } from '../../../../core/json.mjs';
import { context } from '../../../../core/errors.mjs';
import { numberText } from '../../../api.mjs';
import { requiredString } from '../../common/json.mjs';
import { buildDirectExtraData } from '../../common/unsigned-hash-list.mjs';
import { get, isObject } from '../../_rust.mjs';

// upstream: broadcast.rs::submit_direct_transaction → BroadcastResponse
export async function submitDirectTransaction(api, ctx, prepared, signedHashes, force) {
  const extraData = buildDirectExtraData(prepared, signedHashes, ctx.sessionCert(), force, 'Bitcoin');
  return api.broadcastTransaction(ctx, extraData);
}

// upstream: broadcast.rs::submit_inscription_transactions — sign-tx then ordered batch broadcast.
export async function submitInscriptionTransactions(api, ctx, prepared, signedHashes, tokenAddress, amount, force) {
  const signed = await api.signTransaction(ctx, prepared, signedHashes);
  const body = buildInscriptionBatchBody(ctx, prepared, signed, tokenAddress, amount, force);
  return api.batchBroadcastTransactions(ctx, body);
}

// upstream: broadcast.rs::build_inscription_batch_body → [{accountId,address,chainIndex,extraData,signedTx}]
export function buildInscriptionBatchBody(ctx, prepared, signed, tokenAddress, amount, force) {
  const list = get(signed, 'signedTxList');
  const signedItems = Array.isArray(list) && list.length ? list : [signed];
  const signType = requiredString(prepared, 'signType', 'unsignedInfo response');
  const encoding = requiredString(prepared, 'encoding', 'unsignedInfo response');
  const txParam = extractTxParamObject(prepared);
  const commitHashRaw = get(signedItems[0], 'txHash');
  const commitHash = typeof commitHashRaw === 'string' ? commitHashRaw : '';
  const commitRaw = get(txParam, 'commitAddress');
  const commitAddress = typeof commitRaw === 'string' && commitRaw !== '' ? commitRaw : undefined;

  return signedItems.map((item, index) => {
    const signedTx = requiredString(item, 'signedTx', 'sign-tx response item');
    const th = get(item, 'txHash');
    const base = get(prepared, 'extraData');
    const extraData = isObject(base) ? { ...base } : {};
    extraData.txHash = typeof th === 'string' ? th : '';
    extraData.tokenAddress = tokenAddress;
    extraData.txType = 51;
    extraData.coinAmount = amount;
    extraData.toAdr = ctx.address.address;
    extraData.checkBalance = true;
    extraData.encoding = encoding;
    extraData.signType = signType;
    const charge = extractInscriptionServiceCharge(txParam, index);
    if (charge !== undefined) extraData.serviceCharge = charge;
    if (index > 0 && commitHash !== '') extraData.dependTx = [commitHash];
    const extJson = parseJsonObject(get(extraData, 'extJson')) ?? {};
    extJson.batchBroadcastType = 0;
    extraData.extJson = extJson;
    if (force) extraData.skipWarning = true;
    const address = index === 0 ? ctx.address.address : commitAddress ?? ctx.address.address;
    let serialized;
    try { serialized = stringify(extraData); } catch (e) { throw context('failed to serialize BRC-20 inscription batch extraData', e); }
    return { accountId: ctx.accountId, address, chainIndex: ctx.profile.chainIndex, signedTx, extraData: serialized };
  });
}

// upstream: broadcast.rs::extract_tx_param_object — object, JSON-string object, else {}.
function extractTxParamObject(prepared) {
  const v = get(prepared, 'txParam');
  if (isObject(v)) return v;
  if (typeof v === 'string') { try { return parseJson(v); } catch { return {}; } }
  return {};
}

// upstream: broadcast.rs::parse_json_object
function parseJsonObject(value) {
  if (isObject(value)) return { ...value };
  if (typeof value === 'string') {
    try { const v = parseJson(value); return isObject(v) ? v : undefined; } catch { return undefined; }
  }
  return undefined;
}

// upstream: broadcast.rs::extract_inscription_service_charge
function extractInscriptionServiceCharge(txParam, index) {
  let value;
  if (index === 0) value = get(txParam, 'commitFee');
  else {
    const fees = get(txParam, 'revealFees');
    value = Array.isArray(fees) && index - 1 < fees.length ? fees[index - 1] : get(txParam, 'revealFee');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || value instanceof F64) return numberText(value);
  return undefined;
}
