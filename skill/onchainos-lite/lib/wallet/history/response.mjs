// Public field selection for order list / detail responses — upstream
// agentic_wallet/history/response.rs. Every output object is a json! Value (sorted keys);
// absent source fields become null (serde_json `value["x"]` indexing).
import { isObject } from '../_rs.mjs';

// serde_json `value["key"]` — Null for a missing key or a non-object.
const at = (v, k) => (isObject(v) && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null);
const nonEmptyStr = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

// upstream: response.rs::map_direction — "1" → IN, "2" → OUT, other strings as-is, non-strings "".
export function mapDirection(raw) {
  const s = typeof raw === 'string' ? raw : '';
  return s === '1' ? 'IN' : s === '2' ? 'OUT' : s;
}

// upstream: response.rs::map_tx_status
export function mapTxStatus(raw) {
  const s = typeof raw === 'string' ? raw : '';
  switch (s) {
    case '1': case '2': return 'PENDING';
    case '3': return 'ERROR';
    case '4': return 'SUCCESS';
    case '6': return 'CANCELLED';
    default: return s;
  }
}

const assetLine = (asset) => ({ name: at(asset, 'name'), amount: at(asset, 'amount'), direction: mapDirection(at(asset, 'direction')) });

// upstream: response.rs::filter_detail_response
export function filterDetailResponse(data) {
  const items = Array.isArray(data) ? data : [data];
  return items.map((item) => {
    const out = {
      txHash: at(item, 'txHash'),
      txTime: at(item, 'txTime'),
      txStatus: mapTxStatus(at(item, 'txStatus')),
      failReason: at(item, 'failReason'),
      direction: mapDirection(at(item, 'txType')),
      repeatTxType: at(item, 'repeatTxType'),
      from: at(item, 'from'),
      to: at(item, 'to'),
      chainSymbol: at(item, 'chainSymbol'),
      chainIndex: at(item, 'chainIndex'),
      coinSymbol: at(item, 'coinSymbol'),
      coinAmount: at(item, 'coinAmount'),
      serviceCharge: at(item, 'serviceCharge'),
      confirmedCount: at(item, 'confirmedCount'),
      explorerUrl: at(item, 'explorerUrl'),
      hideTxType: at(item, 'hideTxType'),
    };
    const copy = (src, dst) => { const v = nonEmptyStr(at(item, src)); if (v !== undefined) out[dst] = v; };
    copy('serviceChargeUsd', 'serviceChargeUsd');
    copy('feeName', 'serviceChargeSymbol');
    copy('feeDecimalNum', 'serviceChargeDecimal');
    copy('feeRebate', 'feeRebate');
    copy('feeRebateUsd', 'feeRebateUsd');
    const fee = at(item, 'feeContainCreateAccount');
    if (typeof fee === 'boolean') out.networkFeeLabel = fee ? 'Network fee and Rent fee' : 'Network fee';
    const contractName = nonEmptyStr(at(at(item, 'contractInfo'), 'name'));
    if (contractName !== undefined) out.contractName = contractName;
    copy('tipsType', 'tipsType');
    const input = at(item, 'input');
    if (Array.isArray(input)) out.input = input.map(assetLine);
    const output = at(item, 'output');
    if (Array.isArray(output)) out.output = output.map(assetLine);
    return out;
  });
}

// upstream: response.rs::filter_list_response
export function filterListResponse(data) {
  const items = Array.isArray(data) ? data : [data];
  return items.map((item) => {
    const cursor = typeof at(item, 'cursor') === 'string' ? at(item, 'cursor') : '';
    const orders = at(item, 'orderList');
    const orderList = Array.isArray(orders) ? orders.map(filterOrder) : [];
    return { cursor, orderList };
  });
}

function filterOrder(order) {
  const out = {
    txHash: at(order, 'txHash'),
    txStatus: mapTxStatus(at(order, 'txStatus')),
    repeatTxType: at(order, 'repeatTxType'),
    txTime: at(order, 'txTime'),
    txCreateTime: at(order, 'txCreateTime'),
    from: at(order, 'from'),
    to: at(order, 'to'),
    direction: mapDirection(at(order, 'direction')),
    chainSymbol: at(order, 'chainSymbol'),
    coinSymbol: at(order, 'coinSymbol'),
    coinAmount: at(order, 'coinAmount'),
    serviceCharge: at(order, 'serviceCharge'),
    confirmedCount: at(order, 'confirmedCount'),
    hideTxType: at(order, 'hideTxType'),
  };
  for (const k of ['failReason', 'contractName', 'nftCollectionName', 'approveSymbol', 'tipsType']) {
    const v = nonEmptyStr(at(order, k));
    if (v !== undefined) out[k] = v;
  }
  const assetChanges = at(order, 'assetChange');
  if (Array.isArray(assetChanges)) {
    const changes = assetChanges.map((asset) => {
      const change = { coinSymbol: at(asset, 'coinSymbol'), coinAmount: at(asset, 'coinAmount'), direction: mapDirection(at(asset, 'direction')) };
      const nftId = nonEmptyStr(at(asset, 'nftId'));
      if (nftId !== undefined) change.nftId = nftId;
      const nftImageUrl = nonEmptyStr(at(asset, 'nftImageUrl'));
      if (nftImageUrl !== undefined) change.nftImageUrl = nftImageUrl;
      return change;
    });
    out.assetChange = changes;
    if (changes.length) {
      out.direction = changes[0].direction;
      out.coinSymbol = changes[0].coinSymbol;
      out.coinAmount = changes[0].coinAmount;
    }
  }
  return out;
}
