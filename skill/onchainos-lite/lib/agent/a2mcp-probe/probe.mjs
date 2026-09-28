// The unsigned merchant probe — upstream commands/agent_commerce/a2mcp_probe/probe.rs.
// A fresh reqwest-like client (payment/_http.mjs: no OKX headers, no user-agent, 10 s timeout).
import { buildTypedRequest } from '../../payment/http-carrier.mjs';
import { decodePaymentBlob } from '../../payment/dispatcher.mjs';
import { send, headerStr, text as respText } from '../../payment/_http.mjs';
import { context } from '../../core/errors.mjs';
import { stringify } from '../../core/json.mjs';
import { value } from '../../watch/_serde.mjs';
import { fromStr } from '../identity/_from-str.mjs';
import { PROBE_TIMEOUT_MS } from './_model.mjs';
import { discoverInputFallbackHint, discoverInputRequired, outstandingInput, toPaymentParamPlan } from './contract.mjs';

// serde_json::from_str::<Value>(text).unwrap_or(Value::String(text))
export function bodyValue(text) {
  try { return fromStr(text, value); } catch { return text; }
}

// upstream: probe.rs::send_probe(input) → HttpOutcome {kind: Free|InputRequired|Challenge|MethodRequired|Failed, …}
export async function sendProbe(input) {
  const plan = toPaymentParamPlan(input.snapshot.paramPlan, input.snapshot.method);
  const req = buildTypedRequest(input.snapshot.method, input.snapshot.endpoint.href, input.typedParams, plan);
  let response;
  try { response = await send({ ...req, timeoutMs: PROBE_TIMEOUT_MS }); } catch (e) { throw context('endpoint_failure: endpoint request failed', e); }
  return classifyResponse(input, response);
}

// The classification half of send_probe (status / headers / body → HttpOutcome).
export function classifyResponse(input, response) {
  const status = response.status;
  const allow = headerStr(response, 'allow') ?? null;
  const challengeHeader = response.headers['payment-required'] !== undefined ? headerStr(response, 'payment-required') : headerStr(response, 'www-authenticate');
  const body = bodyValue(respText(response));
  if (status === 405) return { kind: 'MethodRequired', allow };
  const direct = discoverInputRequired(body);
  const required = direct ? outstandingInput(direct, input.typedParams) : null;
  if (required) return { kind: 'InputRequired', required };
  if (status === 402) {
    const raw = challengeHeader ?? stringify(body);
    let challenge;
    try { challenge = decodePaymentBlob(raw); } catch (e) { throw context('unsupported_payment_scheme: malformed 402 challenge', e); }
    const inChallenge = discoverInputRequired(challenge);
    const outstanding = inChallenge ? outstandingInput(inChallenge, input.typedParams) : null;
    if (outstanding) return { kind: 'InputRequired', required: outstanding };
    return { kind: 'Challenge', challenge, body };
  }
  const hint = discoverInputFallbackHint(body);
  if (hint) return { kind: 'InputRequired', required: hint };
  if (status >= 200 && status <= 299) return { kind: 'Free', status, body };
  return { kind: 'Failed', status, body };
}
