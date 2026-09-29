// DTOs for the limit-order endpoints — upstream commands/agentic_wallet/strategy/types.rs.
// Requests are sent as `serde_json::to_value(req)` (a Value → keys sorted), so builders return
// plain objects; `undefined` = skip_serializing_if None. Responses are decoded with serde
// `from_value` semantics (core/serde.mjs).
import { T, fromValue } from '../../core/serde.mjs';

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
export const ORDER_LIST_RESP = T.struct('OrderListResp', [
  ['orderId', T.string],
  ['strategyId', T.option(T.string), null],
  ['userWalletAddress', T.option(T.string), null],
  ['status', T.i32],
  ['strategyMode', T.option(T.i32), null],
  ['orderType', T.option(T.i32), null],
  ['strategyType', T.option(T.i32), null],
  ['exchangeDirection', T.option(T.i32), null],
  ['chainId', T.option(T.string), null],
  ['chainName', T.option(T.string), null],
  ['canResume', T.option(T.bool), null],
  ['fromToken', T.option(T.value), null],
  ['toToken', T.option(T.value), null],
  ['triggerInfo', T.option(T.value), null],
  ['createTime', T.option(T.string), null],
  ['expireTime', T.option(T.string), null],
  ['transactionInfo', T.option(T.value), null],
  ['executionHistoryList', T.option(T.value), null],
  ['orderStatusUpdateTime', T.option(T.string), null],
  ['estimatedWaitTime', T.option(T.i64), null],
  ['eventCursor', T.option(T.string), null],
], { flatten: 'extra' });

// upstream: types.rs::ListOrdersResp — BE `dataList` / `cursor` (hasNext ignored)
export const LIST_ORDERS_RESP = T.struct('ListOrdersResp', [
  ['dataList', T.vec(ORDER_LIST_RESP), () => []],
  ['cursor', T.option(T.string), null],
]);

// upstream: types.rs::CancelResp
export const CANCEL_RESP = T.struct('CancelResp', [
  ['updateNum', T.i64, 0],
  ['estimatedWaitTime', T.option(T.i64), null],
]);

// upstream: types.rs::ReactivateResp
export const REACTIVATE_RESP = T.struct('ReactivateResp', [
  ['successIds', T.vec(T.string), () => []],
  ['failIds', T.vec(T.string), () => []],
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
  for (const [k, x] of Object.entries(o.extra ?? {})) {
    Object.defineProperty(v, k, { value: x, enumerable: true, writable: true, configurable: true });
  }
  return v;
}
