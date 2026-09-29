// HTTP wrappers for the 7 strategy endpoints (5 dex limitOrder + 2 wallet SD-A) —
// upstream commands/agentic_wallet/strategy/api.rs. Uses the raw client variants (full
// {code,msg,data} body, no envelope unwrap, no invalid-token retry) so check_response can read
// the numeric `code` for the 60018 retry path.
import { context } from '../../core/errors.mjs';
import { stringify } from '../../core/json.mjs';
import { checkResponse } from './status.mjs';
import { isObject, asI64 } from '../../core/rs/value.mjs';
import {
  orderListRespFromValue, listOrdersRespFromValue, cancelRespFromValue, reactivateRespFromValue,
  listOrdersRespDefault, cancelRespDefault, reactivateRespDefault,
} from './types.mjs';

const LIMIT_ORDER = '/api/v1/dex/strategy/agentic/limitOrder';
const SD_A = '/priapi/v5/wallet/agentic/strategy';

// upstream: api.rs::STRATEGY_AUTH_HEADERS — BE tells Agentic JWT requests apart via this header.
export const STRATEGY_AUTH_HEADERS = Object.freeze({ 'X-Web3-Auth-Type': '1' });

// upstream: api.rs::data_field — object body → its `data` (missing → null); else an error.
export function dataField(body) {
  if (isObject(body)) return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : null;
  throw new Error(`strategy endpoint returned a non-object body — got: ${stringify(body)}`);
}

// serde_json::from_value(..).context(msg)
function decode(fn, v, msg) {
  try { return fn(v); } catch (e) { throw context(msg, e); }
}

// upstream: api.rs::create_order — POST createOrder → OrderListResp
export async function createOrder(client, req) {
  const resp = await client.postRaw(`${LIMIT_ORDER}/createOrder`, req, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  return decode(orderListRespFromValue, dataField(resp), 'createOrder: data shape did not match OrderListResp');
}

// upstream: api.rs::cancel — POST cancel → CancelResp (data null → default)
export async function cancel(client, req) {
  const resp = await client.postRaw(`${LIMIT_ORDER}/cancel`, req, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  const data = dataField(resp);
  if (data === null) return cancelRespDefault();
  return decode(cancelRespFromValue, data, 'cancel: data shape did not match CancelResp');
}

// upstream: api.rs::get_open_order — POST getOpenOrder → ListOrdersResp (data null → default)
export async function getOpenOrder(client, req) {
  const resp = await client.postRaw(`${LIMIT_ORDER}/getOpenOrder`, req, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  const data = dataField(resp);
  if (data === null) return listOrdersRespDefault();
  return decode(listOrdersRespFromValue, data, 'getOpenOrder: response did not match ListOrdersResp');
}

// upstream: api.rs::open_order_detail — GET openOrderDetail (orderId passed as a string) → OrderListResp
export async function openOrderDetail(client, accountId, orderId, strategyMode) {
  const query = [['accountId', accountId], ['orderId', orderId], ['strategyMode', String(strategyMode)]];
  const resp = await client.getRaw(`${LIMIT_ORDER}/openOrderDetail`, query, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  return decode(orderListRespFromValue, dataField(resp), 'openOrderDetail: data shape did not match OrderListResp');
}

// upstream: api.rs::reactivate — POST reactivate → ReactivateResp ({successIds, failIds}; a
// cancel-style {updateNum} is mapped onto the requested ids; anything else → empty lists).
export async function reactivate(client, req) {
  const resp = await client.postRaw(`${LIMIT_ORDER}/reactivate`, req, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  const data = dataField(resp);
  if (isObject(data)) {
    const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
    if (has('successIds') || has('failIds')) {
      return decode(reactivateRespFromValue, data, 'reactivate: data shape did not match ReactivateResp');
    }
    const n = asI64(data.updateNum);
    if (n !== undefined) {
      return BigInt(n) > 0n
        ? { successIds: [...req.orderIds], failIds: [] }
        : { successIds: [], failIds: [...req.orderIds] };
    }
  }
  return reactivateRespDefault();
}

// upstream: api.rs::request_attest_doc_hex_from_sa — GET getAttestDocHex → first array element
export async function requestAttestDocHexFromSa(client) {
  const resp = await client.getRaw(`${SD_A}/getAttestDocHex`, [], STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
  const data = dataField(resp);
  if (!Array.isArray(data)) throw new Error(`getAttestDocHex: response not an array — got: ${stringify(data)}`);
  if (typeof data[0] !== 'string') throw new Error('getAttestDocHex: array is empty');
  return data[0];
}

// upstream: api.rs::register_tee_info — POST registerTeeInfo (failure aborts; no retry)
export async function registerTeeInfo(client, req) {
  const resp = await client.postRaw(`${SD_A}/registerTeeInfo`, req, STRATEGY_AUTH_HEADERS);
  checkResponse(resp);
}
