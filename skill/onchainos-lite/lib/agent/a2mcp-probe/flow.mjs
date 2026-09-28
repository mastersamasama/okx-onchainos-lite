// A2MCP probe / confirmation / payment-preparation flows — upstream
// commands/agent_commerce/a2mcp_probe/flow.rs. Each run* returns a ProbeDecision (or throws).
import { stringify } from '../../core/json.mjs';
import { displayTop } from '../../wallet/api.mjs';
import { currentOwnerId } from '../../payment/state.mjs';
import { nowUnix } from '../../payment/session-state.mjs';
import { resolveChainAndPayer } from '../../payment/payment-flow.mjs';
import { buildFundingBundleForAddress } from '../../core/funding.mjs';
import {
  A2mcpConfirmationContextV1, A2mcpFrozenRequestV1, ERR_CONFIRMATION_REQUIRED, claimA2mcpPreparedPayment, createA2mcpPaymentIntent,
  loadA2mcpPreparedPayment, prepareA2mcpPaymentFromChallenge, refreshA2mcpPreparedPayment, replaceA2mcpPreparedPayment,
  storeA2mcpPreparedPayment,
} from '../../payment/a2mcp.mjs';
import { value } from '../../watch/_serde.mjs';
import { fromStr } from '../identity/_from-str.mjs';
import { eqIgnoreAsciiCase, isObj, get, trim, b64StdDecode } from '../_rs.mjs';
import {
  Action, ContractError, ProbeDecision, confirmationPresentation, defaultStringType, fieldValue, paidFeeDisplay, requestSpecValue,
} from './_model.mjs';
import { parseFields, parseProbeInput, parseRoutingPayload, toPaymentParamPlan, typedValueMatches, outstandingInput } from './contract.mjs';
import {
  PostVerificationAction, discoverEndpointParamIssues, fallbackMethodFor400, fallbackMethodFor405, methodVerificationBlocked, normalizeA2mcpMethod,
  postVerificationAction, shouldRetryDefaultGetAfterFailure, shouldVerifyDefaultGetChallengeWithPost,
} from './method.mjs';
import { sendProbe } from './probe.mjs';
import { consumeFreeResult, loadFreeResult, storeFreeResult } from './free-result.mjs';

const mget = (m, k) => (isObj(m) && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : undefined);
const blockedWith = (code, message) => ProbeDecision.blocked(code, { schemaVersion: 1, message });
const walletLoginRequired = () => new Error('wallet_login_required: no selected wallet');

// base64 STANDARD (padded, canonical) decode → UTF-8; errors mirror base64 / FromUtf8Error Display.
function decodeB64Utf8(v, label) {
  let bytes;
  try { bytes = b64StdDecode(v); } catch (e) { throw new ContractError(label, `base64 input is invalid: ${e.message}`); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ContractError(label, `base64 input is not UTF-8: ${fromUtf8ErrorText(bytes)}`); }
}
// alloc::string::FromUtf8Error Display: "invalid utf-8 sequence of N bytes from index I" /
// "incomplete utf-8 byte sequence from index I".
export function fromUtf8ErrorText(bytes) {
  const b = Buffer.from(bytes);
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let need, lo = 0x80, hi = 0xbf;
    if (c < 0x80) { i++; continue; }
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) { need = 2; if (c === 0xe0) lo = 0xa0; if (c === 0xed) hi = 0x9f; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; if (c === 0xf0) lo = 0x90; if (c === 0xf4) hi = 0x8f; }
    else return `invalid utf-8 sequence of 1 bytes from index ${i}`;
    for (let k = 1; k <= need; k++) {
      if (i + k >= b.length) return `incomplete utf-8 byte sequence from index ${i}`;
      const x = b[i + k];
      const [l, h] = k === 1 ? [lo, hi] : [0x80, 0xbf];
      if (x < l || x > h) return `invalid utf-8 sequence of ${k} bytes from index ${i}`;
    }
    i += need + 1;
  }
  return 'invalid utf-8';
}

// upstream: mod.rs::decode_probe_json_args(args) → [routing, params]; throws ContractError
export function decodeProbeJsonArgs(args) {
  const routing = args.routingBase64 !== undefined && args.routingBase64 !== null ? decodeB64Utf8(args.routingBase64, 'invalid_a2mcp_routing') : (args.routingJson ?? '');
  const params = args.paramsBase64 !== undefined && args.paramsBase64 !== null ? decodeB64Utf8(args.paramsBase64, 'invalid_a2mcp_params') : (args.paramsJson ?? '{}');
  return [routing, params];
}

// upstream: flow.rs::run_probe(args) → ProbeDecision
export async function runProbe(args) {
  let routingJson, paramsJson;
  try { [routingJson, paramsJson] = decodeProbeJsonArgs(args); } catch (e) {
    if (e instanceof ContractError) return blockedWith(e.code, e.msg);
    throw e;
  }
  let input;
  try { input = parseProbeInput(routingJson, paramsJson); } catch (e) {
    if (!(e instanceof ContractError)) throw e;
    if (e.code === 'invalid_a2mcp_param_value') return invalidParamsDecision(routingJson, paramsJson, e);
    return blockedWith(e.code, e.msg);
  }
  const outstanding = outstandingRequestInput(input);
  if (outstanding) return inputRequiredDecision(input, outstanding);
  let outcome;
  try { outcome = await sendInitialProbe(input); } catch (e) { return probeErrorDecision(e); }
  let fallback;
  if (outcome.kind === 'MethodRequired') fallback = fallbackMethodFor405(input.snapshot.method, outcome.allow);
  else if (outcome.kind === 'Failed') {
    fallback = shouldRetryDefaultGetAfterFailure(input) ? 'POST'
      : fallbackMethodFor400(input.snapshot.method, outcome.status, outcome.body, input.typedParams, input.snapshot.paramPlan);
  }
  if (fallback !== undefined) {
    input.snapshot.method = fallback;
    input.snapshot.methodWasDefaulted = false;
    try { outcome = await sendProbe(input); } catch (e) { return probeErrorDecision(e); }
  }
  if (shouldVerifyDefaultGetChallengeWithPost(input, outcome)) {
    const postInput = cloneInput(input);
    postInput.snapshot.method = 'POST';
    postInput.snapshot.methodWasDefaulted = false;
    let postOutcome;
    try { postOutcome = await sendProbe(postInput); } catch { return methodVerificationBlocked(); }
    const action = postVerificationAction(postInput, postOutcome);
    if (action === PostVerificationAction.AdoptPost) { input = postInput; outcome = postOutcome; }
    else if (action === PostVerificationAction.KeepGet) input.snapshot.methodWasDefaulted = false;
    else return methodVerificationBlocked();
  }
  switch (outcome.kind) {
    case 'InputRequired': {
      const required = outcome.required;
      try { applyInputRequiredMethod(input, required); } catch (e) {
        if (e instanceof ContractError) return blockedWith(e.code, e.msg);
        throw e;
      }
      return inputRequiredDecision(input, required);
    }
    case 'Free': {
      const stored = storeFreeResult({
        serviceId: input.snapshot.serviceId, serviceName: input.snapshot.serviceName, providerAgentId: input.snapshot.providerAgentId,
        endpoint: input.snapshot.endpoint.href, method: input.snapshot.method, typedParams: input.typedParams, statusCode: outcome.status,
        result: outcome.body,
      }, nowUnix());
      return freeConfirmationDecision(input, stored.confirmationId);
    }
    case 'MethodRequired':
      return ProbeDecision.blocked('request_method_required', { schemaVersion: 1, allow: outcome.allow ?? null });
    case 'Failed': {
      if (outcome.status === 400) {
        const required = discoverEndpointParamIssues(outcome.body, input.typedParams, input.snapshot.paramPlan);
        if (required) return inputRequiredDecision(input, required);
      }
      return ProbeDecision.blocked('endpoint_failure', { schemaVersion: 1, statusCode: outcome.status, result: outcome.body });
    }
    default:
      return buildPaymentDecision(input, outcome.challenge, outcome.body);
  }
}

const cloneInput = (input) => ({ snapshot: { ...input.snapshot }, typedParams: input.typedParams });

// upstream: flow.rs::send_initial_probe(input) — a defaulted GET that fails is retried once as POST.
export async function sendInitialProbe(input) {
  try { return await sendProbe(input); } catch (e) {
    if (!shouldRetryDefaultGetAfterFailure(input)) throw e;
    input.snapshot.method = 'POST';
    input.snapshot.methodWasDefaulted = false;
    return sendProbe(input);
  }
}

// upstream: flow.rs::probe_error_decision (private)
export function probeErrorDecision(error) {
  const message = displayTop(error);
  const reason = message.startsWith('a2mcp_invalid_typed_params') || message.startsWith('invalid_a2mcp_params') ? 'invalid_a2mcp_params' : 'endpoint_failure';
  return ProbeDecision.blocked(reason, { schemaVersion: 1, message });
}

// upstream: flow.rs::free_confirmation_decision
export const freeConfirmationDecision = (input, confirmationId) => buildFreeConfirmationDecision(input.snapshot.serviceId, input.snapshot.serviceName,
  input.snapshot.providerAgentId, input.snapshot.endpoint.href, input.snapshot.method, input.typedParams, confirmationId);

// upstream: flow.rs::free_confirmation_decision_from_state (private)
const freeConfirmationDecisionFromState = (s) => buildFreeConfirmationDecision(s.serviceId, s.serviceName, s.providerAgentId, s.endpoint, s.method,
  s.typedParams, s.confirmationId);

// upstream: flow.rs::build_free_confirmation_decision (private)
function buildFreeConfirmationDecision(serviceId, serviceName, providerAgentId, endpoint, method, typedParams, confirmationId) {
  const presentation = confirmationPresentation(providerAgentId, serviceName, endpoint, 'Free', typedParams);
  return new ProbeDecision({
    phase: 'payment_confirmation', decision: 'requires_user_input', reason: 'free_confirmation_required',
    nextAction: [Action.new('confirm_a2mcp_free', true).withParams({ confirmationId }), Action.new('cancel_a2mcp', false)],
    payload: {
      schemaVersion: 1, serviceId, serviceName: serviceName ?? null, providerAgentId: providerAgentId ?? null, endpoint, method, typedParams,
      amountDisplay: 'Free', confirmationEnabled: true, confirmationId, presentation,
    },
  });
}

// upstream: flow.rs::run_confirm_free(args {confirmationId, yes})
export function runConfirmFree(args) {
  const now = nowUnix();
  if (!args.yes) return freeConfirmationDecisionFromState(loadFreeResult(args.confirmationId, now));
  const s = consumeFreeResult(args.confirmationId, now);
  return new ProbeDecision({
    phase: 'endpoint_result', decision: 'ready', reason: 'free_result', nextAction: [],
    payload: {
      schemaVersion: 1, serviceId: s.serviceId, serviceName: s.serviceName ?? null, providerAgentId: s.providerAgentId ?? null, endpoint: s.endpoint,
      method: s.method, typedParams: s.typedParams, amountDisplay: 'Free', statusCode: s.statusCode, result: s.result,
    },
  });
}

// upstream: flow.rs::apply_input_required_method; throws ContractError
export function applyInputRequiredMethod(input, required) {
  const m = required.method;
  required.method = null;
  if (m !== null && m !== undefined) {
    input.snapshot.method = normalizeA2mcpMethod(m);
    input.snapshot.methodWasDefaulted = false;
  }
}

// upstream: flow.rs::input_required_decision(input, required)
export function inputRequiredDecision(input, required) {
  const responseFields = required.needsDescriptionFallback
    ? required.fields.map((f) => ({ name: f.name, required: f.required }))
    : required.fields.map(fieldValue);
  const requiredFields = [...required.fields];
  for (const name of required.requiredAnyOf) {
    if (!requiredFields.some((f) => f.name === name)) requiredFields.push({ name, type: defaultStringType(), required: false, carrier: null, description: null });
  }
  const requestFields = required.needsDescriptionFallback ? [...input.snapshot.paramPlan] : mergeFieldConstraints(input.snapshot.paramPlan, requiredFields);
  const requestSpec = { method: input.snapshot.methodWasDefaulted ? null : input.snapshot.method, fields: requestFields, requiredAnyOf: [...required.requiredAnyOf] };
  return new ProbeDecision({
    phase: 'parameter_collection', decision: 'requires_user_input', reason: 'input_required',
    nextAction: [Action.new('provide_a2mcp_params', true), Action.new('cancel_a2mcp', false)],
    payload: {
      schemaVersion: 1, serviceId: input.snapshot.serviceId, fields: responseFields, requiredAnyOf: [...required.requiredAnyOf],
      message: required.message ?? null, typedParams: input.typedParams, needsDescriptionFallback: required.needsDescriptionFallback,
      autoProbeOnValid: true,
      nextProbePayload: { schemaVersion: 1, serviceSnapshot: input.snapshot.raw, requestSpec: requestSpecValue(requestSpec) },
    },
  });
}

// upstream: flow.rs::invalid_params_decision(routing_json, params_json, error)
export function invalidParamsDecision(routingJson, paramsJson, error) {
  let routing = null;
  try { routing = parseRoutingPayload(routingJson); } catch {}
  let nextProbePayload = null;
  try { nextProbePayload = fromStr(routingJson, value); } catch {}
  let typedParams = {};
  try { const p = fromStr(paramsJson, value); if (isObj(p)) typedParams = p; } catch {}
  let plan = [];
  if (routing) {
    if (routing.requestSpec) plan = routing.requestSpec.fields;
    else {
      const input = mget(mget(routing.serviceSnapshot, 'outputSchema'), 'input');
      plan = input === undefined ? [] : parseFields(input);
    }
  }
  const fields = plan.filter((f) => Object.prototype.hasOwnProperty.call(typedParams, f.name) && !typedValueMatches(typedParams[f.name], f.type)).map(fieldValue);
  return new ProbeDecision({
    phase: 'parameter_collection', decision: 'requires_user_input', reason: 'invalid_a2mcp_params',
    nextAction: [Action.new('provide_a2mcp_params', true), Action.new('cancel_a2mcp', false)],
    payload: { schemaVersion: 1, fields, message: error.msg, typedParams, autoProbeOnValid: true, nextProbePayload },
  });
}

// upstream: flow.rs::outstanding_request_input(input) → InputRequired | null
export function outstandingRequestInput(input) {
  return outstandingInput({
    fields: [...input.snapshot.paramPlan], requiredAnyOf: [...input.snapshot.requiredAnyOf], message: null, method: input.snapshot.method,
    needsDescriptionFallback: false,
  }, input.typedParams);
}

// Candidate view (json! → sorted keys) shared by the payment decisions.
function candidateView(candidate, aspAmount, withEnabled) {
  const mismatch = aspAmount !== null && aspAmount !== undefined && !decimalStringsEqual(aspAmount, candidate.amountDisplay());
  const v = {
    candidateId: candidate.candidateId(), tokenSymbol: candidate.symbol(), network: candidate.network(), chainName: candidate.chainName(),
    amountAtomic: candidate.amountAtomic(), amountDisplay: candidate.amountDisplay(), amountSemantics: amountSemantics(candidate.scheme()),
    requiredDisplay: candidate.requiredAmount(), balanceStatus: candidate.balanceStatus(), availableDisplay: candidate.availableAmount(),
    shortfallDisplay: candidate.shortfall(), depositAddress: candidate.depositAddress(), amountMismatch: mismatch,
  };
  if (withEnabled) v.confirmationEnabled = candidate.balanceStatus() === 'sufficient';
  return v;
}

// Single-candidate / token-selection reason + actions.
function selectionOutcome(preparedId, single) {
  if (single) {
    const c = ProbeDecision.paymentConfirmation(preparedId, single.candidateId(), single.balanceStatus() === 'sufficient', false);
    return [c.reason, c.nextAction];
  }
  return ['token_selection_required', [Action.new('select_a2mcp_token', true).withParams({ preparedId }), Action.new('cancel_a2mcp', false)]];
}

// upstream: flow.rs::run_refresh_balance(args {preparedId})
export async function runRefreshBalance(args) {
  const owner = currentOwnerId();
  if (owner === null) throw walletLoginRequired();
  const prepared = await refreshA2mcpPreparedPayment(loadA2mcpPreparedPayment(args.preparedId, owner, nowUnix()));
  const ctx = prepared.confirmationContext();
  const replacementId = replaceA2mcpPreparedPayment(args.preparedId, prepared.clone(), owner, nowUnix());
  const cands = prepared.candidates();
  const candidates = cands.map((c) => candidateView(c, ctx.aspAmount(), true));
  const single = cands.length === 1 ? cands[0] : null;
  const feeDisplay = single ? paidFeeDisplay(single.amountDisplay(), single.symbol(), amountSemantics(single.scheme())) : 'Select a payment option';
  const presentation = confirmationPresentation(ctx.providerAgentId(), ctx.serviceName(), prepared.frozenRequest().endpoint(), feeDisplay, prepared.frozenRequest().typedParams());
  const [reason, nextAction] = selectionOutcome(replacementId, single);
  return new ProbeDecision({
    phase: 'payment_confirmation', decision: 'requires_user_input', reason, nextAction,
    payload: {
      schemaVersion: 1, serviceId: ctx.serviceId(), serviceName: ctx.serviceName(), providerAgentId: ctx.providerAgentId(),
      endpoint: prepared.frozenRequest().endpoint(), method: prepared.frozenRequest().method(), typedParams: prepared.frozenRequest().typedParams(),
      aspPrice: { amount: ctx.aspAmount(), symbol: ctx.aspSymbol() },
      amountMismatch: single ? ctx.aspAmount() !== null && !decimalStringsEqual(ctx.aspAmount(), single.amountDisplay()) : null,
      selectedCandidateId: single ? single.candidateId() : null, confirmationEnabled: single ? single.balanceStatus() === 'sufficient' : false,
      walletError: prepared.walletError(), candidates, preparedId: replacementId, presentation,
    },
  });
}

// upstream: flow.rs::run_resume_after_funding(args {preparedId, candidateId, yes})
export async function runResumeAfterFunding(args) {
  if (!args.yes) throw new Error(`${ERR_CONFIRMATION_REQUIRED}: funding completion must be explicit`);
  const owner = currentOwnerId();
  if (owner === null) throw walletLoginRequired();
  const claim = claimA2mcpPreparedPayment(args.preparedId, owner, nowUnix());
  try {
    if (claim.prepared().fundingCandidateId() !== args.candidateId) throw new Error('a2mcp_funding_continuation_required: enter Funding before resuming');
    const refreshed = await refreshA2mcpPreparedPayment(claim.prepared().clone());
    const candidate = refreshed.candidates().find((c) => c.candidateId() === args.candidateId);
    if (!candidate) throw new Error('a2mcp_invalid_payment_candidate: unknown candidate');
    if (candidate.balanceStatus() === 'sufficient') {
      const selected = refreshed.select(args.candidateId);
      const [, , payerAddress] = await resolveChainAndPayer(selected.raw(), null);
      const intent = createA2mcpPaymentIntent({
        probeId: args.preparedId, ownerAccountId: owner, payerAddress, frozenRequest: refreshed.frozenRequest().clone(), selectedAccept: selected,
        createdAt: nowUnix(), expiresAt: refreshed.challengeExpiresAt(), userConfirmed: true,
      });
      claim.commit();
      return paymentReadyDecision(intent.paymentId());
    }
    refreshed.clearFundingContinuation();
    const replacementId = claim.replace(refreshed);
    return runPreparePayment({ preparedId: replacementId, candidateId: args.candidateId, yes: false });
  } finally { claim.drop(); }
}

// upstream: flow.rs::run_funding(args {preparedId, candidateId})
export async function runFunding(args) {
  const owner = currentOwnerId();
  if (owner === null) throw walletLoginRequired();
  const loadedAt = nowUnix();
  const prepared = loadA2mcpPreparedPayment(args.preparedId, owner, loadedAt);
  const candidate = prepared.candidates().find((c) => c.candidateId() === args.candidateId);
  if (!candidate) throw new Error('a2mcp_invalid_payment_candidate: unknown candidate');
  if (candidate.balanceStatus() === 'sufficient') throw new Error('a2mcp_funding_not_required: selected candidate is sufficient');
  const asset = get(candidate.rawAccept(), 'asset');
  const funding = buildFundingBundleForAddress('', candidate.chainId(), candidate.depositAddress(), {
    asset: candidate.symbol(), tokenAddress: typeof asset === 'string' ? asset : '', required: candidate.requiredAmount(),
    balance: candidate.availableAmount(), operation: 'a2mcp', errorCode: null, errorMessage: null,
  });
  prepared.markFundingContinuation(args.candidateId);
  const continuationId = replaceA2mcpPreparedPayment(args.preparedId, prepared, owner, loadedAt);
  return new ProbeDecision({
    phase: 'funding_required', decision: 'blocked', reason: 'insufficient_balance',
    nextAction: [Action.new('resume_a2mcp_after_funding', true).withParams({ preparedId: continuationId, candidateId: args.candidateId })],
    payload: funding.payload === undefined ? null : funding.payload,
  });
}

// upstream: flow.rs::run_prepare_payment(args {preparedId, candidateId, yes})
export async function runPreparePayment(args) {
  const owner = currentOwnerId();
  if (owner === null) throw walletLoginRequired();
  const prepared = loadA2mcpPreparedPayment(args.preparedId, owner, nowUnix());
  const candidate = prepared.candidates().find((c) => c.candidateId() === args.candidateId);
  if (!candidate) throw new Error('a2mcp_invalid_payment_intent: unknown candidate');
  if (!args.yes) {
    const enabled = candidate.balanceStatus() === 'sufficient';
    const ctx = prepared.confirmationContext();
    const mismatch = ctx.aspAmount() !== null && !decimalStringsEqual(ctx.aspAmount(), candidate.amountDisplay());
    const feeDisplay = paidFeeDisplay(candidate.amountDisplay(), candidate.symbol(), amountSemantics(candidate.scheme()));
    const presentation = confirmationPresentation(ctx.providerAgentId(), ctx.serviceName(), prepared.frozenRequest().endpoint(), feeDisplay, prepared.frozenRequest().typedParams());
    const decision = ProbeDecision.paymentConfirmation(args.preparedId, candidate.candidateId(), enabled, prepared.candidates().length > 1);
    decision.payload = {
      schemaVersion: 1, serviceId: ctx.serviceId(), serviceName: ctx.serviceName(), providerAgentId: ctx.providerAgentId(),
      endpoint: prepared.frozenRequest().endpoint(), method: prepared.frozenRequest().method(), typedParams: prepared.frozenRequest().typedParams(),
      aspPrice: { amount: ctx.aspAmount(), symbol: ctx.aspSymbol() }, amountMismatch: mismatch, selectedCandidateId: candidate.candidateId(),
      confirmationEnabled: enabled, candidate: candidateView(candidate, ctx.aspAmount(), false), walletError: prepared.walletError(),
      preparedId: args.preparedId, presentation,
    };
    return decision;
  }
  const selected0 = prepared.select(args.candidateId);
  const [, , payerAddress] = await resolveChainAndPayer(selected0.raw(), null);
  const createdAt = nowUnix();
  const claim = claimA2mcpPreparedPayment(args.preparedId, owner, createdAt);
  try {
    const selected = claim.prepared().select(args.candidateId);
    const intent = createA2mcpPaymentIntent({
      probeId: args.preparedId, ownerAccountId: owner, payerAddress, frozenRequest: claim.prepared().frozenRequest().clone(), selectedAccept: selected,
      createdAt, expiresAt: claim.prepared().challengeExpiresAt(), userConfirmed: args.yes,
    });
    claim.commit();
    return paymentReadyDecision(intent.paymentId());
  } finally { claim.drop(); }
}

// upstream: flow.rs::payment_ready_decision
export const paymentReadyDecision = (paymentId) => new ProbeDecision({
  phase: 'payment_ready', decision: 'ready', reason: 'payment_ready',
  nextAction: [Action.new('execute_a2mcp_payment', true).withParams({ paymentId })], payload: { schemaVersion: 1, paymentId },
});

// upstream: flow.rs::build_payment_decision(input, challenge, merchant_body)
export async function buildPaymentDecision(input, challenge, merchantBody) {
  const bodyInput = mget(mget(merchantBody, 'outputSchema'), 'input');
  const challengeInput = mget(mget(challenge, 'outputSchema'), 'input');
  const bodyPlan = bodyInput === undefined ? [] : parseFields(bodyInput);
  const challengePlan = challengeInput === undefined ? [] : parseFields(challengeInput);
  const responsePlan = mergeFieldConstraints(mergeFieldConstraints(input.snapshot.paramPlan, bodyPlan), challengePlan);
  const paidMethod = input.snapshot.method;
  const paramPlan = toPaymentParamPlan(responsePlan, paidMethod);
  const frozenRequest = A2mcpFrozenRequestV1.new(input.snapshot.endpoint.href, paidMethod, input.typedParams, paramPlan, mget(challenge, 'resource'));
  let prepared;
  try {
    prepared = await prepareA2mcpPaymentFromChallenge({
      challenge: stringify(challenge), frozenRequest,
      confirmationContext: A2mcpConfirmationContextV1.new(input.snapshot.serviceId, input.snapshot.serviceName, input.snapshot.providerAgentId,
        input.snapshot.aspAmount, input.snapshot.aspSymbol),
    });
  } catch (e) {
    if (displayTop(e).includes('unsupported_payment_asset')) return ProbeDecision.blocked('unsupported_payment_asset', { schemaVersion: 1, serviceId: input.snapshot.serviceId });
    throw e;
  }
  const cands = prepared.candidates();
  const candidateViews = cands.map((c) => candidateView(c, input.snapshot.aspAmount, true));
  const selectedMismatch = candidateViews.length === 1 ? candidateViews[0].amountMismatch : null;
  const owner = currentOwnerId();
  if (owner === null) throw walletLoginRequired();
  const preparedId = storeA2mcpPreparedPayment(prepared.clone(), owner, nowUnix());
  const single = cands.length === 1 ? cands[0] : null;
  const feeDisplay = single ? paidFeeDisplay(single.amountDisplay(), single.symbol(), amountSemantics(single.scheme())) : 'Select a payment option';
  const presentation = confirmationPresentation(input.snapshot.providerAgentId, input.snapshot.serviceName, input.snapshot.endpoint.href, feeDisplay, input.typedParams);
  const [reason, nextAction] = selectionOutcome(preparedId, single);
  return new ProbeDecision({
    phase: 'payment_confirmation', decision: 'requires_user_input', reason, nextAction,
    payload: {
      schemaVersion: 1, serviceId: input.snapshot.serviceId, serviceName: input.snapshot.serviceName, providerAgentId: input.snapshot.providerAgentId,
      endpoint: input.snapshot.endpoint.href, method: paidMethod, typedParams: input.typedParams,
      aspPrice: { amount: input.snapshot.aspAmount, symbol: input.snapshot.aspSymbol }, selectedCandidateId: single ? single.candidateId() : null,
      confirmationEnabled: single ? single.balanceStatus() === 'sufficient' : false, amountMismatch: selectedMismatch,
      walletError: prepared.walletError(), candidates: candidateViews, preparedId, presentation,
    },
  });
}

// upstream: flow.rs::merge_field_constraints(base, updates)
export function mergeFieldConstraints(base, updates) {
  const merged = base.map((f) => ({ ...f }));
  for (const field of updates) {
    const i = merged.findIndex((e) => e.name === field.name);
    if (i >= 0) merged[i] = { ...field };
    else merged.push({ ...field });
  }
  return merged;
}

// upstream: flow.rs::decimal_strings_equal(left, right)
export function decimalStringsEqual(left, right) {
  const normalize = (value) => {
    const v = trim(value);
    if (v === '' || v.startsWith('-') || v.startsWith('+')) return null;
    const parts = v.split('.');
    if (parts.length > 2) return null;
    const [whole, fractional = ''] = parts;
    if (whole === '' || !/^[0-9]*$/.test(whole) || !/^[0-9]*$/.test(fractional)) return null;
    const w = whole.replace(/^0+/, '');
    return [w === '' ? '0' : w, fractional.replace(/0+$/, '')];
  };
  const l = normalize(left), r = normalize(right);
  return l !== null && r !== null && l[0] === r[0] && l[1] === r[1];
}

// upstream: flow.rs::amount_semantics(scheme)
export const amountSemantics = (scheme) => (eqIgnoreAsciiCase(scheme, 'upto') ? 'maximum' : 'exact');
