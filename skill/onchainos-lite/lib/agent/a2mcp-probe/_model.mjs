// PRIVATE — the data types of upstream commands/agent_commerce/a2mcp_probe/mod.rs, kept apart
// from ./index.mjs so the submodules can import them without an ES-module cycle (index.mjs
// re-exports everything here under the upstream module path).
import { struct, stringify } from '../../core/json.mjs';

// upstream: mod.rs::PROBE_TIMEOUT
export const PROBE_TIMEOUT_MS = 10000;

// upstream: mod.rs::default_string_type / default_true
export const defaultStringType = () => 'string';
export const defaultTrue = () => true;

// upstream: mod.rs::ContractError — Display "<code>: <message>".
export class ContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.msg = message;
  }
}

// FieldConstraint {name, type, required, carrier?, description?} → serde_json::to_value (sorted keys).
export function fieldValue(f) {
  const o = { name: f.name, type: f.type, required: f.required };
  if (f.carrier !== null && f.carrier !== undefined) o.carrier = f.carrier;
  if (f.description !== null && f.description !== undefined) o.description = f.description;
  return o;
}

// RequestSpec {method?, fields (skip empty), requiredAnyOf (skip empty)} → to_value (sorted keys).
export function requestSpecValue(spec) {
  const o = {};
  if (spec.method !== null && spec.method !== undefined) o.method = spec.method;
  if (spec.fields.length) o.fields = spec.fields.map(fieldValue);
  if (spec.requiredAnyOf.length) o.requiredAnyOf = [...spec.requiredAnyOf];
  return o;
}

const ACTION_LABELS = new Map([
  ['provide_a2mcp_params', 'Provide service parameters'], ['select_a2mcp_token', 'Select payment option'],
  ['fund_a2mcp_token', 'Fund this payment option'], ['resume_a2mcp_after_funding', 'Continue after funding'],
  ['confirm_a2mcp_free', 'Confirm service invocation'], ['confirm_a2mcp_payment', 'Confirm payment'],
  ['execute_a2mcp_payment', 'Execute payment'], ['cancel_a2mcp', 'Cancel'],
]);

// upstream: mod.rs::Action (struct order id, actionLabel, recommend, params?)
export class Action {
  constructor(id, recommend) {
    this.id = id;
    this.actionLabel = ACTION_LABELS.get(id) ?? 'Continue';
    this.recommend = recommend;
    this.params = null;
  }
  // upstream: Action::new
  static new(id, recommend) { return new Action(id, recommend); }
  // upstream: Action::with_params
  withParams(params) { this.params = params; return this; }
  toStruct() { return struct({ id: this.id, actionLabel: this.actionLabel, recommend: this.recommend, params: this.params ?? undefined }); }
}

// upstream: mod.rs::ProbeDecision (struct order phase, decision, reason, nextAction, payload)
export class ProbeDecision {
  constructor({ phase, decision, reason, nextAction, payload }) { Object.assign(this, { phase, decision, reason, nextAction, payload }); }

  // upstream: ProbeDecision::payment_confirmation
  static paymentConfirmation(preparedId, candidateId, enabled, canSelectOther) {
    const bound = () => ({ preparedId, candidateId });
    let nextAction;
    if (enabled) nextAction = [Action.new('confirm_a2mcp_payment', true).withParams(bound()), Action.new('cancel_a2mcp', false)];
    else {
      nextAction = [Action.new('fund_a2mcp_token', true).withParams(bound())];
      if (canSelectOther) nextAction.push(Action.new('select_a2mcp_token', false).withParams({ preparedId }));
      nextAction.push(Action.new('cancel_a2mcp', false));
    }
    return new ProbeDecision({
      phase: 'payment_confirmation', decision: 'requires_user_input', reason: enabled ? 'payment_confirmation_required' : 'insufficient_balance',
      nextAction, payload: { selectedCandidateId: candidateId },
    });
  }

  // upstream: ProbeDecision::blocked
  static blocked(reason, payload) {
    return new ProbeDecision({ phase: 'endpoint_probe', decision: 'blocked', reason, nextAction: [Action.new('cancel_a2mcp', true)], payload });
  }

  toStruct() {
    return struct({ phase: this.phase, decision: this.decision, reason: this.reason, nextAction: this.nextAction.map((a) => a.toStruct()), payload: this.payload });
  }
}

// upstream: mod.rs::confirmation_presentation (json! → sorted keys)
export function confirmationPresentation(providerAgentId, serviceName, endpoint, feeDisplay, typedParams) {
  const provider = providerAgentId !== null && providerAgentId !== undefined ? `Agent ID ${providerAgentId}` : '—';
  return {
    type: 'a2mcp_confirmation',
    columns: [{ key: 'field', label: 'Field' }, { key: 'value', label: 'Value' }],
    rows: [
      { key: 'serviceProvider', label: 'Service Provider', value: provider },
      { key: 'serviceName', label: 'Service Name', value: serviceName ?? '—' },
      { key: 'endpoint', label: 'Endpoint', value: endpoint },
      { key: 'fee', label: 'Fee', value: feeDisplay },
      { key: 'serviceParameters', label: 'Service Parameters', value: stringify(typedParams) },
    ],
  };
}

// upstream: mod.rs::paid_fee_display
export const paidFeeDisplay = (amount, symbol, semantics) => `${semantics === 'maximum' ? 'Up to ' : ''}${amount} ${symbol}`;
