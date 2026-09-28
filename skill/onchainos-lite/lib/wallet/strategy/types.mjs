// DTOs for the limit-order endpoints — upstream commands/agentic_wallet/strategy/types.rs.
// Requests are sent as `serde_json::to_value(req)` (a Value → keys sorted), so builders return
// plain objects; `undefined` = skip_serializing_if None. Responses are decoded with serde
// `from_value` semantics (lib/wallet/strategy/_serde.mjs).
import { D, EXTRA, fromValue } from './_serde.mjs';

// upstream: types.rs::strategy_type
export const strategyType = Object.freeze({ BUY_DIP: 2, TAKE_PROFIT: 3, STOP_LOSS: 4, CHASE_HIGH: 5 });
// upstream: types.rs::direction
export const direction = Object.freeze({ ALL: -1, BUY: 0, SELL: 1 });

// ── Request bodies ──

// upstream: types.rs::Rule
export const rule = ({ fromTokenAddress, toTokenAddress, fromAmount, triggerPrice }) =>
  ({ fromTokenAddress, toTokenAddress, fromAmount, triggerPrice: triggerPrice ?? undefined });

// upstream: types.rs::VerifySignInfo (chainId is a Long number; top-level chainId is a String)
export const verifySignInfo = ({ accountId, address, chainId, signMsg, signature, sessionCert, teeId }) =>
  ({ accountId, address, chainId, signMsg, signature, sessionCert, teeId });

// upstream: types.rs::CreateOrderReq
export const createOrderReq = (r) => ({
  chainId: r.chainId, userWalletAddress: r.userWalletAddress, rule: r.rule, preset: r.preset,
  strategyType: r.strategyType, strategyDirection: r.strategyDirection, verifySignInfo: r.verifySignInfo,
  expireTime: r.expireTime ?? undefined, serviceFeeInfo: r.serviceFeeInfo ?? undefined, sourceType: r.sourceType ?? undefined,
  estimateGasFee: r.estimateGasFee ?? undefined, referrerAddress: r.referrerAddress ?? undefined,
});

// upstream: types.rs::CancelReq
export const cancelReq = ({ accountId, orderIds, cancelAll }) =>
  ({ accountId, orderIds: orderIds ?? undefined, cancelAll: cancelAll ?? undefined });

// upstream: types.rs::ListOrdersReq
export const listOrdersReq = (r) => ({
  accountId: r.accountId, walletAddressList: r.walletAddressList, chainIdList: r.chainIdList ?? undefined,
  orderStatusList: r.orderStatusList ?? undefined, orderTypeList: r.orderTypeList ?? undefined, idList: r.idList ?? undefined,
  tokenAddress: r.tokenAddress ?? undefined, limit: r.limit ?? undefined, cursor: r.cursor ?? undefined,
});

// upstream: types.rs::ReactivateReq
export const reactivateReq = ({ accountId, orderIds }) => ({ accountId, orderIds });

// upstream: types.rs::RegisterTeeInfoReq (timestamps in ms, JSON integers)
export const registerTeeInfoReq = ({ accountId, timestamp, expireTimestamp, attestDocHex, sessionCert, sessionSig }) =>
  ({ accountId, timestamp, expireTimestamp, attestDocHex, sessionCert, sessionSig });

// ── Response bodies ──

// upstream: types.rs::OrderListResp (field declaration order; unmodelled keys kept via flatten)
export const ORDER_LIST_RESP = D.struct('OrderListResp', [
  ['orderId', D.string, false],
  ['strategyId', D.option(D.string), true],
  ['userWalletAddress', D.option(D.string), true],
  ['status', D.i32, false],
  ['strategyMode', D.option(D.i32), true],
  ['orderType', D.option(D.i32), true],
  ['strategyType', D.option(D.i32), true],
  ['exchangeDirection', D.option(D.i32), true],
  ['chainId', D.option(D.string), true],
  ['chainName', D.option(D.string), true],
  ['canResume', D.option(D.bool), true],
  ['fromToken', D.option(D.value), true],
  ['toToken', D.option(D.value), true],
  ['triggerInfo', D.option(D.value), true],
  ['createTime', D.option(D.string), true],
  ['expireTime', D.option(D.string), true],
  ['transactionInfo', D.option(D.value), true],
  ['executionHistoryList', D.option(D.value), true],
  ['orderStatusUpdateTime', D.option(D.string), true],
  ['estimatedWaitTime', D.option(D.i64), true],
  ['eventCursor', D.option(D.string), true],
], { flatten: true });

// upstream: types.rs::ListOrdersResp — BE `dataList` / `cursor` (hasNext ignored)
export const LIST_ORDERS_RESP = D.struct('ListOrdersResp', [
  ['dataList', D.vec(ORDER_LIST_RESP), true],
  ['cursor', D.option(D.string), true],
]);

// upstream: types.rs::CancelResp
export const CANCEL_RESP = D.struct('CancelResp', [
  ['updateNum', D.i64, true],
  ['estimatedWaitTime', D.option(D.i64), true],
]);

// upstream: types.rs::ReactivateResp
export const REACTIVATE_RESP = D.struct('ReactivateResp', [
  ['successIds', D.vec(D.string), true],
  ['failIds', D.vec(D.string), true],
]);

// serde_json::from_value::<OrderListResp> etc.
export const orderListRespFromValue = (v) => fromValue(v, ORDER_LIST_RESP);
export const listOrdersRespFromValue = (v) => fromValue(v, LIST_ORDERS_RESP);
export const cancelRespFromValue = (v) => fromValue(v, CANCEL_RESP);
export const reactivateRespFromValue = (v) => fromValue(v, REACTIVATE_RESP);

// Defaults (`#[derive(Default)]`)
export const listOrdersRespDefault = () => ({ dataList: [], cursor: null });
export const cancelRespDefault = () => ({ updateNum: 0, estimatedWaitTime: null });
export const reactivateRespDefault = () => ({ successIds: [], failIds: [] });

// serde_json::to_value(&OrderListResp) → every modelled key (None → null) plus the flattened
// extras; a Value, so the printer sorts the keys.
export function orderListRespToValue(o) {
  const v = {};
  for (const [name] of ORDER_LIST_RESP.fields) v[name] = o[name] ?? null;
  for (const [k, x] of Object.entries(o[EXTRA] ?? {})) {
    Object.defineProperty(v, k, { value: x, enumerable: true, writable: true, configurable: true });
  }
  return v;
}
