// PRIVATE fallback for the parts of upstream commands/payment/a2mcp.rs that `payment pay
// --payment-id` needs before dispatching (the A2MCP intent state machine itself is owned by
// the session/A2MCP unit in lib/payment/a2mcp.mjs; payment-flow.mjs prefers that module).
import { readFileSync } from 'node:fs';
import { context } from '../core/errors.mjs';
import { fromStr as serdeFromStr } from '../wallet/_serde-json.mjs';
import { statePath, TOKEN_QUOTE_EXPIRED_OR_MISSING } from './state.mjs';
import { get, ioErrorText } from './_rs.mjs';

// upstream: a2mcp.rs constants
export const A2MCP_INTENT_VERSION = 1;
export const A2MCP_SOURCE = 'okx_ai_a2mcp';
export const ERR_CONFIRMATION_REQUIRED = 'a2mcp_payment_confirmation_required';
export const ERR_INSUFFICIENT_BALANCE = 'a2mcp_insufficient_balance';
export const ERR_ALREADY_CREATED = 'a2mcp_payment_intent_already_created';
export const ERR_ALREADY_EXECUTED = 'a2mcp_payment_already_executed';
export const ERR_EXPIRED = 'a2mcp_payment_intent_expired';
export const ERR_INVALID_INTENT = 'a2mcp_invalid_payment_intent';
export const ERR_INVALID_PARAMS = 'a2mcp_invalid_typed_params';
export const ERR_OVERRIDES_FORBIDDEN = 'a2mcp_payment_overrides_forbidden';
export const ERR_PREPARED_EXPIRED_OR_MISSING = 'a2mcp_prepared_expired_or_missing';

// upstream: a2mcp.rs::A2mcpPaymentSource
export const A2mcpPaymentSource = Object.freeze({ GenericQuote: 'GenericQuote', OkxAiA2mcp: 'OkxAiA2mcp' });

// upstream: a2mcp.rs::validate_payment_id (private)
export function validatePaymentId(paymentId) {
  const id = String(paymentId);
  if (id === '' || Buffer.byteLength(id) > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${ERR_INVALID_INTENT}: invalid payment id`);
}

// upstream: a2mcp.rs::inspect_payment_source
export function inspectPaymentSource(paymentId) {
  validatePaymentId(paymentId);
  const path = statePath(paymentId);
  let bytes;
  try { bytes = readFileSync(path); } catch (e) { throw context(`${TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${paymentId}`, new Error(ioErrorText(e))); }
  let value;
  try { value = serdeFromStr(bytes); } catch (e) { throw context(`${TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${paymentId}`, e); }
  const source = get(value, 'source');
  if (typeof source !== 'string') return A2mcpPaymentSource.GenericQuote;
  if (source === A2MCP_SOURCE) return A2mcpPaymentSource.OkxAiA2mcp;
  throw new Error(`${ERR_INVALID_INTENT}: unknown payment source`);
}

// upstream: a2mcp.rs::read_a2mcp_payment_intent — the intent state machine lives in a2mcp.mjs.
export function readA2mcpPaymentIntent() {
  throw new Error(`${ERR_INVALID_INTENT}: A2MCP payment intents are not supported by this build`);
}
