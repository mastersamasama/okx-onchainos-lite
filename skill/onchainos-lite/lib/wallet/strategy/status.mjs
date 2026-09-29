// Order status enum, BE error-code classification, execution-event catalog —
// upstream commands/agentic_wallet/strategy/status.rs.
import { augmentAuthErrorMsg } from '../../core/http.mjs';
import { asI64 } from '../../core/rs/value.mjs';

// upstream: status.rs::OrderStatus (TeeSaOpenOrderStatusEnum, 9 values; -4 SPEEDING_UP removed)
export const OrderStatus = Object.freeze({
  Expired: -7, Cancelling: -3, Cancelled: -2, Failed: -1, Trading: 0,
  Completed: 1, Creating: 2, Active: 3, Suspended: 4,
});

// upstream: status.rs::OrderStatus::as_str (declaration order = enum order)
const STATUS_STR = new Map([
  [-7, 'expired'], [-3, 'cancelling'], [-2, 'cancelled'], [-1, 'failed'], [0, 'processing'],
  [1, 'completed'], [2, 'creating'], [3, 'active'], [4, 'suspended'],
]);
export const orderStatusAsStr = (status) => STATUS_STR.get(status);

// upstream: status.rs::OrderStatus::is_terminal
export const orderStatusIsTerminal = (status) => status === 1 || status === -2 || status === -1 || status === -7;

// upstream: status.rs::OrderStatus::try_from(i32) → status | throws
export function orderStatusTryFrom(value) {
  if (!STATUS_STR.has(value)) throw new Error(`unknown OrderStatus integer: ${value}`);
  return value;
}

// upstream: status.rs::status_label
export const statusLabel = (value) => STATUS_STR.get(value) ?? `unknown(${value})`;

// upstream: status.rs::StrategyError (kind names) — from_code / user_message
const ERRORS = new Map([
  [100, ['RequestParam', 'Request parameters are invalid.']],
  [10019, ['InsufficientNativeGas', "Wallet's native token balance is too low to pay this chain's gas fees. Top up the native gas token (deposit, transfer from another account, or swap a stablecoin into native via `swap execute`) and retry."]],
  [10026, ['JwtVerifyFailed', 'Session expired. Please run `onchainos wallet login` and retry.']],
  [10106, ['ChainNotSupported', 'This chain is not supported for limit orders.']],
  [60002, ['NoOrderFound', 'No matching order was found.']],
  [60003, ['NoAuthority', 'Limit-order permission missing. Trader Mode may not be activated yet.']],
  [60006, ['OutOfLimit', 'Pending order count is at the limit. Cancel some orders before creating new ones.']],
  [60009, ['Illiquidity', 'Insufficient liquidity to place this order.']],
  [60014, ['ExpiredCannotOperate', 'Order has expired and cannot be modified.']],
  [60015, ['PendingCannotOperate', 'Order is pending and cannot be modified.']],
  [60017, ['SuccessCannotOperate', 'Order already completed and cannot be modified.']],
  [60018, ['UpgradeRequired', 'Trader Mode SA needs to be re-activated; CLI will handle this transparently.']],
  [60030, ['QuotaExceeded', 'Quota exceeded for this account.']],
  [100007, ['TeeSignFailure', 'TEE signing failed. Try again shortly.']],
  [100010, ['OrderAmountTooSmall', 'Order value is below the minimum of $1 USD. Increase --amount and retry.']],
  [100012, ['InsufficientBalance', 'Insufficient balance to place this order.']],
]);

// upstream: status.rs::StrategyError::from_code → kind name ("Unknown" for anything else)
export const strategyErrorFromCode = (code) => (ERRORS.get(code) ?? ['Unknown'])[0];
// upstream: status.rs::StrategyError::user_message (by code)
export const strategyErrorUserMessage = (code) => (ERRORS.get(code) ?? [null, 'Unknown strategy error.'])[1];

// upstream: status.rs::StrategyApiError — Display "BE strategy error code=<code>: <msg>"
export class StrategyApiError extends Error {
  constructor(code, msg, kind) {
    super(`BE strategy error code=${code}: ${msg}`);
    this.code = code; this.msg = msg; this.kind = kind;
  }
}

// upstream: status.rs::check_response — `code` read with as_i64 (numbers only; missing /
// string-typed → 0 = success) and truncated `as i32`.
export function checkResponse(value) {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? asI64(value.code) : undefined;
  const code = raw === undefined ? 0 : Number(BigInt.asIntN(32, BigInt(raw)));
  if (code === 0) return;
  const kind = strategyErrorFromCode(code);
  const msg = typeof value.msg === 'string' ? value.msg : strategyErrorUserMessage(code);
  throw new StrategyApiError(code, augmentAuthErrorMsg(String(code), msg), kind);
}

// upstream: status.rs::is_upgrade_required — typed StrategyApiError with kind UpgradeRequired
export const isUpgradeRequired = (e) => e instanceof StrategyApiError && e.kind === 'UpgradeRequired';
// upstream: status.rs::is_order_amount_too_small — typed StrategyApiError with kind OrderAmountTooSmall
export const isOrderAmountTooSmall = (e) => e instanceof StrategyApiError && e.kind === 'OrderAmountTooSmall';

// upstream: status.rs::ExecutionEvent { code, name, message, is_terminal }
const ev = (code, name, message, isTerminal) => Object.freeze({ code, name, message, isTerminal });
// upstream: status.rs::EXECUTION_EVENT_CATALOG
export const EXECUTION_EVENT_CATALOG = Object.freeze([
  ev(0, 'tradeSuccessed', 'Trade successful', false),
  ev(3005, 'lessThanMinReceive', 'Quoted price is below the minimum amount to receive', false),
  ev(3006, 'preExecutionFailed', 'Pre-execution error. Try again', false),
  ev(3007, 'signFailed', 'Failed to verify signature', false),
  ev(3008, 'broadcastFailed', 'Broadcast failed', false),
  ev(3010, 'onchainFailed', 'The transaction broadcast was unsuccessful due to an onchain service error', true),
  ev(3013, 'insufficientBalance', 'Insufficient funds in wallet', false),
  ev(3014, 'insufficientLamports', 'Insufficient funds for network fee', false),
  ev(3015, 'exceedSlippage', 'Price exceeded slippage at trade', false),
  ev(3016, 'noLiquidty', 'No quote due to low liquidity', false),
  ev(3017, 'unableQuote', 'Unable to fetch a quote', false),
  ev(3018, 'mevFail', 'Anti-MEV provider error', false),
  ev(3019, 'riskToken', 'Failed to trade due to risky token', true),
  ev(3020, 'blackAddress', 'Failed to trade due to blocklisted address', true),
  ev(3023, 'orderExpired', 'Limit order expired', true),
  ev(2001, 'oldCreated', 'Order created', false),
  ev(2002, 'oldFailedToCreate', 'Failed to create order', false),
  ev(2003, 'oldEdited', 'Order modified', false),
  ev(2004, 'oldFailedToEdit', 'Failed to edit order', false),
  ev(2005, 'oldCanceled', 'Order canceled', false),
  ev(2006, 'oldFailedToCancel', 'Unable to cancel order', false),
  ev(2007, 'oldAutoCanceled', 'Order auto-canceled', false),
  ev(2008, 'oldFailedToAutoCancel', 'Unable to auto-cancel order', false),
  ev(2009, 'oldExpired', 'Order expired', false),
  ev(2010, 'oldExceedsSlippage', 'Price exceeded slippage at trade', false),
  ev(2011, 'oldNoQuoteLowLiquidity', 'No quote due to low liquidity', false),
  ev(2012, 'oldBroadcastFailed', 'Broadcast failed', false),
  ev(2013, 'oldSuccessful', 'Trade successful', false),
]);

// upstream: status.rs::execution_event_for → event | undefined
export const executionEventFor = (code) => EXECUTION_EVENT_CATALOG.find((e) => e.code === code);

// upstream: status.rs::is_terminal_event
export const isTerminalEvent = (code) => executionEventFor(code)?.isTerminal ?? false;
