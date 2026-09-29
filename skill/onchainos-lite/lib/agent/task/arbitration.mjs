// ASP arbitration domain — upstream task/arbitration.rs: rejection decisions (choices,
// deterministic reply resolution, decision results) plus the arbitration list/detail queries.
import { stringify, struct } from '../../core/json.mjs';
import { fromStr, T } from '../../core/serde.mjs';
import { context } from '../../core/errors.mjs';
import { isObject, get, at, asStr, asI64, asU64 } from '../../core/rs/value.mjs';
import { trim, trimStart, asciiLower, isWhitespace } from '../../core/rs/str.mjs';
import { B64 } from '../../core/rs/codec.mjs';
import { nowSecs, nowMs } from '../../core/rs/time.mjs';
import { formatUtcTimestamp, formatLocalTimestampWithOffset } from './common/deadline.mjs';
import { isTestTask } from './common/index.mjs';
import { decodeDisputeStatusResponse } from './evaluator/dispute-status.mjs';
import { validateDecimal, isZeroDecimal } from './user/refund.mjs';

export const JOB_REJECTED = 'job_rejected';
export const SUB_USER_REJECT = 'sub_user_reject';

// ─── RefundDisplayMetadata ───
// upstream: arbitration.rs::RefundDisplayMetadata { serviceName, taskType, amount, tokenSymbol, responseDeadline }
const REFUND_DISPLAY = T.struct('RefundDisplayMetadata', [['serviceName', T.string], ['taskType', T.string],
  ['amount', T.string], ['tokenSymbol', T.string], ['responseDeadline', T.i64]]);
const nonBlank = (v) => { if (v === undefined || v === null) return undefined; const t = trim(v); return t === '' ? undefined : t; };

export class RefundDisplayMetadata {
  constructor({ serviceName, taskType, amount, tokenSymbol, responseDeadline }) {
    Object.assign(this, { serviceName, taskType, amount, tokenSymbol, responseDeadline });
  }
  // upstream: RefundDisplayMetadata::new → metadata | undefined
  static create(sourceEvent, serviceName, amount, tokenSymbol, responseDeadline) {
    const name = nonBlank(serviceName);
    if (name === undefined) return undefined;
    const amt = nonBlank(amount);
    if (amt === undefined || !validateDecimal(amt)) return undefined;
    const sym = nonBlank(tokenSymbol);
    if (sym === undefined) return undefined;
    if (responseDeadline === undefined || responseDeadline === null || !(BigInt(responseDeadline) > 0n)) return undefined;
    if (formatUtcTimestamp(responseDeadline) === undefined) return undefined;
    const taskType = sourceEvent === JOB_REJECTED ? 'One-time' : sourceEvent === SUB_USER_REJECT ? 'Subscription' : undefined;
    if (taskType === undefined) return undefined;
    return new RefundDisplayMetadata({ serviceName: name, taskType, amount: amt, tokenSymbol: sym, responseDeadline });
  }
  // serde struct (field order)
  toStruct() {
    return struct({ serviceName: this.serviceName, taskType: this.taskType, amount: this.amount, tokenSymbol: this.tokenSymbol, responseDeadline: this.responseDeadline });
  }
  // upstream: RefundDisplayMetadata::encode (URL_SAFE_NO_PAD of compact struct JSON)
  encode() { return B64.URL_SAFE_NO_PAD.encode(Buffer.from(stringify(this.toStruct()), 'utf8')); }
  // upstream: RefundDisplayMetadata::decode
  static decode(raw) {
    let bytes;
    try { bytes = B64.URL_SAFE_NO_PAD.decode(raw); } catch (e) { throw context('invalid refund display metadata encoding', e); }
    let m;
    try { m = fromStr(bytes, REFUND_DISPLAY); } catch (e) { throw context('invalid refund display metadata payload', e); }
    if (m.taskType !== 'One-time' && m.taskType !== 'Subscription') throw new Error('invalid refund display task type');
    const r = RefundDisplayMetadata.create(m.taskType === 'Subscription' ? SUB_USER_REJECT : JOB_REJECTED, m.serviceName, m.amount, m.tokenSymbol, m.responseDeadline);
    if (!r) throw new Error('refund display metadata is incomplete');
    return r;
  }
  // upstream: RefundDisplayMetadata::refund_amount_label
  refundAmountLabel() { return isZeroDecimal(this.amount) ? 'No refund required' : `${this.amount} ${this.tokenSymbol}`; }
  // upstream: RefundDisplayMetadata::response_deadline_label
  responseDeadlineLabel() { return formatUtcTimestamp(this.responseDeadline); }
}

// ─── choices ───
// upstream: arbitration.rs::DecisionChoice { key, actionId, params (skip when empty) }
export const decisionChoice = (key, actionId, params = {}) => ({ key, actionId, params });
// serde struct JSON of a DecisionChoice (struct order; params sorted Map; omitted when empty).
export function choiceJson(c) {
  const parts = [`"key":${JSON.stringify(c.key)}`, `"actionId":${JSON.stringify(c.actionId)}`];
  if (Object.keys(c.params).length) parts.push(`"params":${stringify(c.params)}`);
  return `{${parts.join(',')}}`;
}
export const choicesJson = (choices) => `[${choices.map(choiceJson).join(',')}]`;

// upstream: arbitration.rs::ChoiceError
export class ChoiceError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
  // upstream: ChoiceError::reason_code
  reasonCode() { return { Ambiguous: 'ambiguous_choice', MissingReason: 'arbitration_reason_required', UnsupportedAction: 'unsupported_action' }[this.kind]; }
}

// upstream: arbitration.rs::is_decision_source
export const isDecisionSource = (e) => e === JOB_REJECTED || e === SUB_USER_REJECT;

// upstream: arbitration.rs::default_choices
export function defaultChoices(sourceEvent, jobId) {
  const ids = sourceEvent === JOB_REJECTED ? ['agree_refund', 'raise_arbitration'] : sourceEvent === SUB_USER_REJECT ? ['sub_agree_refund', 'raise_subscription_arbitration'] : undefined;
  if (!ids) return [];
  return [decisionChoice('A', ids[0], { jobId }), decisionChoice('B', ids[1], { jobId })];
}

// upstream: arbitration.rs::scalar_string
export function scalarString(value) {
  if (value === undefined || value === null) return undefined;
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); return t === '' ? undefined : t; }
  const i = asI64(value);
  if (i !== undefined) return String(i);
  const u = asU64(value);
  return u !== undefined ? String(u) : undefined;
}

// upstream: arbitration.rs::decision_id
export function decisionId(sourceEvent, jobId, message) {
  let instance;
  if (message !== undefined && message !== null) {
    for (const key of ['eventId', 'messageId', 'periodIndex', 'subStartTime']) { instance = scalarString(get(message, key)); if (instance !== undefined) break; }
  }
  return `${jobId}:${sourceEvent}:${instance ?? 'current'}`;
}

// upstream: arbitration.rs::progression (json! → sorted keys)
export const progression = (phase, decision, reason, nextAction, payload) => ({ phase, decision, reason, nextAction, payload });

function integerValue(value) {
  if (value === undefined || value === null) return undefined;
  const i = asI64(value);
  if (i !== undefined) return i;
  const u = asU64(value);
  if (u !== undefined && BigInt(u) <= 9223372036854775807n) return u;
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); if (/^[+-]?[0-9]+$/.test(t)) { const b = BigInt(t); if (b >= -9223372036854775808n && b <= 9223372036854775807n) return Number.isSafeInteger(Number(b)) ? Number(b) : b; } }
  return undefined;
}
// upstream: arbitration.rs::integer_from_keys
export function integerFromKeys(value, keys) {
  for (const key of keys) { const v = integerValue(get(value, key)); if (v !== undefined) return v; }
  return undefined;
}
const formatTimestamp = (t) => (t === undefined || t === null ? undefined : formatLocalTimestampWithOffset(t));
const formatTimestampValue = (t) => formatTimestamp(t) ?? null;
function displayPeriod(start, end) {
  const a = formatTimestamp(start), b = formatTimestamp(end);
  return a !== undefined && b !== undefined ? `${a}–${b}` : null;
}
function isZeroAmount(amount) {
  let v = trim(amount);
  while (v.startsWith('+')) v = v.slice(1);
  return v !== '' && /^[0.]+$/.test(v);
}
// upstream: arbitration.rs::display_amount
export function displayAmount(amount, tokenSymbol) {
  const a = nonBlank(amount);
  if (a === undefined) return null;
  if (isZeroAmount(a)) return 'No refund required';
  const s = nonBlank(tokenSymbol);
  return s === undefined ? null : `${a} ${s}`;
}
// upstream: arbitration.rs::value_from_keys
function valueFromKeys(value, keys) {
  for (const key of keys) { const v = get(value, key); if (v !== undefined && v !== null) return v; }
  return null;
}
function optionalFields(message) {
  const fields = {};
  if (message === undefined || message === null) return fields;
  for (const key of ['periodIndex', 'subStartTime', 'subEndTime', 'rejectWindowEndsAt', 'expireTime']) {
    const v = get(message, key);
    if (v !== undefined && v !== null) fields[key] = v;
  }
  return fields;
}
function subscriptionPeriodBinding(message) {
  if (message === undefined || message === null) return undefined;
  for (const key of ['periodIndex', 'subStartTime', 'subEndTime']) { const v = scalarString(get(message, key)); if (v !== undefined) return [key, v]; }
  return undefined;
}

// upstream: arbitration.rs::build_decision_result
export function buildDecisionResult(sourceEvent, jobId, name, amount, tokenSymbol, message) {
  const missing = [['name', name], ['amount', amount], ['tokenSymbol', tokenSymbol]].filter(([, v]) => v === undefined || v === null || trim(v) === '').map(([k]) => k);
  if (missing.length) return progression('arbitration_decision', 'blocked', 'missing_required_facts', [], { jobId, missingFields: missing });
  const choices = defaultChoices(sourceEvent, jobId);
  if (sourceEvent === SUB_USER_REJECT) {
    const b = subscriptionPeriodBinding(message);
    if (b) for (const c of choices) { c.params.decisionBindingKey = b[0]; c.params.decisionBindingValue = b[1]; }
  }
  const nextActions = choices.map((c) => ({ key: c.key, id: c.actionId, recommend: false, params: c.params }));
  const extraFields = optionalFields(message);
  const isSubscription = sourceEvent === SUB_USER_REJECT;
  const m = message ?? undefined;
  const currentPeriod = isSubscription ? displayPeriod(m && integerFromKeys(m, ['subStartTime', 'periodStartTime']), m && integerFromKeys(m, ['subEndTime', 'periodEndTime'])) : null;
  const serviceName = (m && scalarString(get(m, 'serviceName'))) ?? name;
  const buyerReason = m ? valueFromKeys(m, ['refundReason', 'rejectReason', 'userReason', 'reason']) : null;
  const deadlineTs = m ? integerFromKeys(m, ['rejectWindowEndsAt', 'responseDeadline', 'expireTime']) : undefined;
  const responseDeadline = formatTimestampValue(deadlineTs);
  const requestedRefund = displayAmount(amount, tokenSymbol);
  const responseDeadlineLabel = deadlineTs === undefined ? null : (formatUtcTimestamp(deadlineTs) ?? null);
  const meta = RefundDisplayMetadata.create(sourceEvent, serviceName, amount, tokenSymbol, deadlineTs);
  const refundDisplayB64 = meta ? meta.encode() : null;
  const missingDisplay = [];
  if (serviceName === undefined || serviceName === null || serviceName === '') missingDisplay.push('serviceName');
  if (scalarString(buyerReason) === undefined) missingDisplay.push('buyerReason');
  if (deadlineTs === undefined || responseDeadline === null) missingDisplay.push('responseDeadline');
  if (isSubscription && currentPeriod === null) missingDisplay.push('currentPeriod');
  if (refundDisplayB64 === null) missingDisplay.push('refundDisplay');
  if (missingDisplay.length) return progression('arbitration_decision', 'blocked', 'missing_required_facts', [], { jobId, missingFields: missingDisplay });
  return progression('arbitration_decision', 'requires_user_input', 'delivery_rejected', nextActions, {
    jobId, decisionId: decisionId(sourceEvent, jobId, message), taskType: isSubscription ? 'Subscription' : 'One-time', name: name ?? null,
    serviceName: serviceName ?? null, amount: amount ?? null, tokenSymbol: tokenSymbol ?? null, currentPeriod, requestedRefund, buyerReason,
    refundReason: buyerReason, responseDeadline, responseDeadlineTimestamp: deadlineTs ?? null, responseDeadlineLabel,
    statusLabel: 'Awaiting ASP decision', statusDescription: "The refund request is waiting for the ASP's decision.", refundDisplayB64, extraFields,
  });
}

// upstream: arbitration.rs::build_selected_result
export const buildSelectedResult = (jobId, resolved) => progression('arbitration_decision', 'ready', 'user_choice_resolved',
  [{ id: resolved.actionId, recommend: true, params: resolved.params }], { jobId });

// upstream: arbitration.rs::blocked_result → compact JSON string (sorted)
export const blockedResult = (reason, jobId, details) => stringify(progression('arbitration_decision', 'blocked', reason, [], { jobId, details }));

// upstream: arbitration.rs::canonical_action_id
export const canonicalActionId = (a) => ({ dispute_raise: 'raise_arbitration', sub_dispute: 'raise_subscription_arbitration', view_dispute: 'view_arbitration' })[a] ?? a;

// `serde_json::from_str::<Vec<DecisionChoice>>` (errors carry the serde position).
const CHOICE_T = () => T.vec(T.struct('DecisionChoice', [['key', T.string], ['actionId', T.string], ['params', T.map(T.value), () => ({})]]));

// upstream: arbitration.rs::parse_choices → choices; throws the String error text
export function parseChoices(raw, sourceEvent, jobId) {
  let choices;
  if (raw !== undefined && raw !== null) {
    let v;
    try { v = fromStr(raw, CHOICE_T()); } catch (e) { throw new Error(`invalid --choices-json: ${e.message}`); }
    choices = v.map((c) => decisionChoice(c.key, c.actionId, { ...c.params }));
  } else choices = defaultChoices(sourceEvent, jobId);
  for (const c of choices) c.actionId = canonicalActionId(c.actionId);
  validateChoices(choices, sourceEvent, jobId);
  return choices;
}

const sameParams = (a, b) => stringify(a) === stringify(b);
function validChoiceParams(choices, jobId) {
  if (choices.length !== 2 || !sameParams(choices[0].params, choices[1].params)) return false;
  const p = choices[0].params;
  if (asStr(get(p, 'jobId')) !== jobId || Object.keys(p).some((k) => !['jobId', 'decisionBindingKey', 'decisionBindingValue'].includes(k))) return false;
  const k = asStr(get(p, 'decisionBindingKey')), v = asStr(get(p, 'decisionBindingValue'));
  if (k === undefined && v === undefined) return true;
  if (k !== undefined && v !== undefined) return ['periodIndex', 'subStartTime', 'subEndTime'].includes(k) && trim(v) !== '';
  return false;
}

// upstream: arbitration.rs::validate_choices (throws the String error text)
export function validateChoices(choices, sourceEvent, jobId) {
  if (!isDecisionSource(sourceEvent)) return;
  const expected = defaultChoices(sourceEvent, jobId);
  if (choices.length !== 2 || choices[0].key !== 'A' || choices[1].key !== 'B' || choices[0].actionId !== expected[0].actionId
    || choices[1].actionId !== expected[1].actionId || !validChoiceParams(choices, jobId)) {
    throw new Error("evaluation choices must map A/B to the source event's allowed actions");
  }
}

const allowedAction = (source, action) => (source === JOB_REJECTED && (action === 'raise_arbitration' || action === 'agree_refund'))
  || (source === SUB_USER_REJECT && (action === 'raise_subscription_arbitration' || action === 'sub_agree_refund'));

// upstream: arbitration.rs::starts_with_choice
function startsWithChoice(value, expected) {
  const chars = [...value];
  if (chars[0] !== expected) return false;
  const next = chars[1];
  return next === undefined || isWhitespace(next) || next === '.' || next === ':' || next === ',';
}
// upstream: arbitration.rs::contains_choice_marker
const containsChoiceMarker = (value, expected) => value.split(/[^0-9A-Za-z]/).some((t) => t.length === 1 && t === expected);

const A_PHRASES = ['agree refund', 'agree to refund', 'accept refund', 'accept full refund', 'approve refund'];
const B_PHRASES = ['file dispute', 'raise dispute', 'file arbitration', 'raise arbitration', 'request evaluation', 'start evaluation', 'file for evaluation'];

// upstream: arbitration.rs::deterministic_choice_key → 'A' | 'B' | undefined
export function deterministicChoiceKey(reply) {
  const lowered = asciiLower(reply);
  const a = startsWithChoice(lowered, 'a'), b = startsWithChoice(lowered, 'b');
  if ((a && containsChoiceMarker(lowered, 'b')) || (b && containsChoiceMarker(lowered, 'a'))) return undefined;
  if (a || A_PHRASES.some((p) => lowered.startsWith(p))) return 'A';
  if (b || B_PHRASES.some((p) => lowered.startsWith(p))) return 'B';
  return undefined;
}

// Rust str::get(n..) (byte offset; None when not a char boundary).
function byteTail(s, n) {
  const buf = Buffer.from(s, 'utf8');
  if (n > buf.length) return undefined;
  if (n < buf.length && (buf[n] & 0xc0) === 0x80) return undefined;
  return buf.subarray(n).toString('utf8');
}

// upstream: arbitration.rs::arbitration_reason
export function arbitrationReason(reply) {
  const trimmed = trim(reply);
  let after;
  if (startsWithChoice(asciiLower(trimmed), 'b')) after = byteTail(trimmed, 1) ?? '';
  else {
    const lower = asciiLower(trimmed);
    const p = B_PHRASES.find((ph) => lower.startsWith(ph));
    after = p === undefined ? '' : (byteTail(trimmed, p.length) ?? '');
  }
  let reason = after;
  while (reason.length && (isWhitespace(reason[0]) || '.:,'.includes(reason[0]))) reason = reason.slice(1);
  const buf = Buffer.from(reason, 'utf8');
  if (buf.length >= 6 && (buf.length === 6 || (buf[6] & 0xc0) !== 0x80)) {
    const prefix = buf.subarray(0, 6).toString('utf8'), rest = buf.subarray(6).toString('utf8');
    const c = rest[0];
    if (asciiLower(prefix) === 'reason' && (c === undefined || isWhitespace(c) || '.:,'.includes(c))) reason = rest;
  }
  while (reason.length && (isWhitespace(reason[0]) || reason[0] === ':')) reason = reason.slice(1);
  reason = trim(reason);
  return reason === '' ? undefined : reason;
}

// upstream: arbitration.rs::resolve_choice → { actionId, params } (throws ChoiceError)
export function resolveChoice(sourceEvent, choices, userReply) {
  if (!isDecisionSource(sourceEvent)) throw new ChoiceError('UnsupportedAction');
  const normalized = trim(userReply);
  const key = deterministicChoiceKey(normalized);
  if (key === undefined) throw new ChoiceError('Ambiguous');
  const choice = choices.find((c) => c.key.length === key.length && asciiLower(c.key) === asciiLower(key));
  if (!choice) throw new ChoiceError('UnsupportedAction');
  const actionId = canonicalActionId(choice.actionId);
  if (!allowedAction(sourceEvent, actionId)) throw new ChoiceError('UnsupportedAction');
  const params = { ...choice.params };
  if (key === 'B') {
    const reason = arbitrationReason(normalized);
    if (reason === undefined) throw new ChoiceError('MissingReason');
    params.reason = reason;
  }
  return { actionId, params };
}

// upstream: arbitration.rs::resolved_action
export function resolvedAction(sourceEvent, actionIdRaw, jobId, params) {
  const actionId = canonicalActionId(actionIdRaw);
  if (!allowedAction(sourceEvent, actionId)) throw new ChoiceError('UnsupportedAction');
  const resolved = isObject(params) ? { ...params } : {};
  const pj = asStr(get(resolved, 'jobId'));
  if (pj !== undefined && pj !== jobId) throw new ChoiceError('UnsupportedAction');
  resolved.jobId = jobId;
  if ((actionId === 'raise_arbitration' || actionId === 'raise_subscription_arbitration')) {
    const r = asStr(get(resolved, 'reason'));
    if (r === undefined || trim(r) === '') throw new ChoiceError('MissingReason');
  }
  return { actionId, params: resolved };
}

// ─── list / detail ───
const TASK_STATUS_NAME = { 0: 'created', 1: 'accepted', 2: 'submitted', 3: 'rejected', 4: 'disputed', 5: 'admin_stopped', 6: 'complete', 7: 'close', 8: 'expired', 9: 'failed' };
const TASK_STATUS_LABEL = { 0: 'Awaiting ASP acceptance', 1: 'In progress', 2: 'Awaiting buyer review', 3: 'Awaiting refund decision', 4: 'Evaluation in progress',
  5: 'Stopped by platform', 6: 'Completed', 7: 'Closed', 8: 'Expired', 9: 'Refund completed' };
const TASK_STATUS_DESC = { 0: 'The task is waiting for an ASP to accept it.', 1: 'The ASP accepted the task and is working on it.',
  2: 'The ASP submitted the deliverable and is waiting for buyer review.', 3: "The buyer rejected the deliverable and is waiting for the ASP's refund decision.",
  4: 'The refund request is in Evaluation.', 5: 'The platform stopped the task.', 6: 'The ASP won the Evaluation and the task funds were released to the ASP.',
  7: 'The task is closed.', 8: 'The task expired.', 9: 'The buyer won the Evaluation and the refund completed.' };
const backendTaskStatusName = (c) => TASK_STATUS_NAME[c] ?? 'unknown';
const backendTaskStatusLabel = (c) => TASK_STATUS_LABEL[c] ?? 'Status unavailable';
const backendTaskStatusDescription = (c) => TASK_STATUS_DESC[c] ?? 'The task status is currently unavailable.';
const evaluationStatusDescription = (s) => ({ 'Evidence preparation': 'Evidence is collected automatically. Please wait.', Evaluating: 'Evaluators are reviewing the submitted evidence.',
  Decided: 'The Evaluation has concluded.' })[s] ?? 'The Evaluation status is currently unavailable.';
const evaluationStatusKey = (s) => ({ 'Evidence preparation': 'evidence_preparation', Evaluating: 'evaluating', Decided: 'decided' })[s] ?? 'unknown';
const arbitrationPhaseLabel = (p) => ({ evidence_preparation: 'Evidence preparation', in_progress: 'Evaluating', resolved: 'Decided' })[p] ?? 'Status unavailable';
const arbitrationPhaseDescription = (p) => ({ evidence_preparation: 'Evidence is collected automatically. Please wait.',
  in_progress: 'Evaluation is in progress; evaluators are reviewing the evidence.', resolved: 'The Evaluation has concluded with a decision.' })[p]
  ?? 'The Evaluation stage is currently unavailable.';
const verdictDescription = (v) => (typeof v !== 'string' ? 'No decision has been produced yet.' : v === 'asp_won' ? 'The ASP won; task funds were released to the ASP.'
  : v === 'asp_lost_auto_refund' ? 'The buyer won; the refund completed.' : 'A decision was returned by the Evaluation service.');
const verdictLabel = (v) => (typeof v !== 'string' ? 'Not decided' : v === 'asp_won' ? 'ASP won' : v === 'asp_lost_auto_refund' ? 'Buyer won; refund completed' : 'Decision returned');

const n = (v) => (v === undefined || v === null ? undefined : Number(v));
// upstream: arbitration.rs::evaluation_status_at
export function evaluationStatusAt(taskStatus, prepareEndTime, nowSeconds, nowMs) {
  const s = n(taskStatus);
  if (s === 6 || s === 9) return 'Decided';
  if (s === 4) {
    if (prepareEndTime === undefined || prepareEndTime === null) return 'Status unavailable';
    const d = BigInt(prepareEndTime);
    const abs = d < 0n ? -d : d;
    const now = BigInt(abs >= 100000000000n ? nowMs : nowSeconds);
    return now <= d ? 'Evidence preparation' : 'Evaluating';
  }
  return 'Status unavailable';
}
// upstream: arbitration.rs::arbitration_phase_at
export function arbitrationPhaseAt(taskStatus, prepareEndTime, nowSeconds, nowMs) {
  const s = n(taskStatus);
  if (s === 6 || s === 9) return 'resolved';
  if (s === 4) {
    if (prepareEndTime === undefined || prepareEndTime === null) return 'unknown';
    const d = BigInt(prepareEndTime);
    const now = BigInt(d >= 100000000000n ? nowMs : nowSeconds);
    return now <= d ? 'evidence_preparation' : 'in_progress';
  }
  return 'unknown';
}
const evaluationStatus = (t, p) => evaluationStatusAt(t, p, nowSecs(), nowMs());
const arbitrationPhase = (t, p) => arbitrationPhaseAt(t, p, nowSecs(), nowMs());
const arbitrationVerdict = (t) => (n(t) === 6 ? 'asp_won' : n(t) === 9 ? 'asp_lost_auto_refund' : null);
const mapOpt = (v, f) => (v === undefined || v === null ? null : f(n(v)));

// upstream: arbitration.rs::build_list_result (items: [[item, dispute | null]])
export function buildListResult(page, total, items, includeTestFlag) {
  const rows = [];
  for (const [item, arb] of items) {
    const js = asStr(at(item, 'jobId'));
    if (js === undefined) continue;
    const jobId = trim(js);
    if (jobId === '') continue;
    const taskStatus = arb ? arb.taskStatus : (asI64(at(item, 'status')) ?? null);
    const prepareEndTime = arb ? arb.prepareEndTime : null;
    const status = evaluationStatus(taskStatus, prepareEndTime);
    const phase = arbitrationPhase(taskStatus, prepareEndTime);
    const verdict = arbitrationVerdict(taskStatus);
    const keyTime = status === 'Evidence preparation' ? formatTimestampValue(prepareEndTime)
      : status === 'Evaluating' ? formatTimestampValue(arb ? arb.roundEndTime : null)
        : status === 'Decided' ? formatTimestampValue(integerFromKeys(item, ['resolvedAt', 'decisionTime', 'updatedAt', 'updateTime'])) : null;
    const row = {
      jobId, serviceName: valueFromKeys(item, ['serviceName', 'title', 'jobTitle']), status, evaluationStatus: evaluationStatusKey(status),
      statusLabel: status, statusDescription: evaluationStatusDescription(status),
      evaluationStarted: formatTimestampValue(integerFromKeys(item, ['disputeTime', 'evaluationStartedAt', 'createdAt', 'createTime'])),
      keyTime, description: valueFromKeys(item, ['title']), occurredAt: valueFromKeys(item, ['createTime']),
      taskStatus: mapOpt(taskStatus, backendTaskStatusName), taskStatusLabel: mapOpt(taskStatus, backendTaskStatusLabel),
      taskStatusDescription: mapOpt(taskStatus, backendTaskStatusDescription), taskStatusCode: taskStatus ?? null,
      arbitrationPhase: phase, arbitrationPhaseLabel: arbitrationPhaseLabel(phase), arbitrationPhaseDescription: arbitrationPhaseDescription(phase),
      verdict, verdictLabel: verdictLabel(verdict), verdictDescription: verdictDescription(verdict),
    };
    if (includeTestFlag) row.testFlag = isTestTask(item);
    rows.push(row);
  }
  const allowed = rows.map((r) => r.jobId);
  return progression('arbitration_list', 'ready', rows.length ? 'arbitrations_found' : 'no_arbitrations',
    allowed.length ? [{ id: 'view_arbitration', recommend: false, params: { allowedJobIds: allowed, confirmationRequired: false } }] : [],
    { total, page, items: rows });
}

// upstream: arbitration.rs::build_detail_result
export function buildDetailResult(jobId, supplement, arbitration, statusPayload, evidence) {
  const taskStatus = arbitration ? arbitration.taskStatus : (asI64(at(supplement, 'status')) ?? null);
  const prepareEndTime = arbitration ? arbitration.prepareEndTime : null;
  const phase = arbitrationPhase(taskStatus, prepareEndTime);
  const status = evaluationStatus(taskStatus, prepareEndTime);
  const statusVerdict = arbitrationVerdict(taskStatus);
  const verdict = statusVerdict === null ? valueFromKeys(supplement, ['verdict', 'disputeResult']) : statusVerdict;
  const amount = (arbitration ? arbitration.tokenAmount : null) ?? scalarString(valueFromKeys(supplement, ['tokenAmount', 'serviceTokenAmount'])) ?? null;
  const tokenSymbol = (arbitration ? arbitration.tokenSymbol : null) ?? scalarString(valueFromKeys(supplement, ['tokenSymbol', 'paymentTokenSymbol'])) ?? null;
  const buyerReason = evidence !== undefined && evidence !== null ? valueFromKeys(at(evidence, 'client'), ['reason']) : null;
  const evaluationStarted = (statusPayload !== undefined && statusPayload !== null ? integerFromKeys(statusPayload, ['disputeTime', 'createdAt', 'createTime']) : undefined)
    ?? integerFromKeys(supplement, ['disputeTime']);
  const roundEnd = arbitration ? arbitration.roundEndTime : null;
  return progression('arbitration_detail', 'ready', 'arbitration_found', [], {
    jobId, serviceName: valueFromKeys(supplement, ['serviceName', 'title', 'jobTitle']), requestedRefund: displayAmount(amount, tokenSymbol), buyerReason,
    status, evaluationStatus: evaluationStatusKey(status), statusLabel: status, statusDescription: evaluationStatusDescription(status),
    evaluationStarted: formatTimestampValue(evaluationStarted), description: valueFromKeys(supplement, ['title', 'serviceName']),
    occurredAt: valueFromKeys(supplement, ['disputeTime', 'updatedAt', 'updateTime', 'createdAt', 'createTime']), jobType: arbitration ? arbitration.jobType : null,
    amount, tokenSymbol, taskStatus: mapOpt(taskStatus, backendTaskStatusName), taskStatusLabel: mapOpt(taskStatus, backendTaskStatusLabel),
    taskStatusDescription: mapOpt(taskStatus, backendTaskStatusDescription), taskStatusCode: taskStatus ?? null,
    arbitrationPhase: phase, arbitrationPhaseLabel: arbitrationPhaseLabel(phase), arbitrationPhaseDescription: arbitrationPhaseDescription(phase),
    currentRound: arbitration ? arbitration.currentRound : null, disputeRoundStatus: arbitration ? arbitration.disputeRoundStatus : null,
    prepareEndTime, roundEndTime: roundEnd,
    deadline: phase === 'evidence_preparation' ? prepareEndTime : phase === 'in_progress' ? roundEnd : null,
    verdict, verdictLabel: verdictLabel(verdict), verdictDescription: verdictDescription(verdict),
    fundDestination: valueFromKeys(supplement, ['fundDestination', 'fundsTo']), refundAmount: valueFromKeys(supplement, ['refundAmount']),
  });
}

// upstream: arbitration.rs::handle_arbitration_list → success data
export const handleArbitrationList = (client, agentId, page, pageSize) => handleArbitrationListInner(client, agentId, page, pageSize, false);
// upstream: arbitration.rs::handle_provider_arbitration_list
export const handleProviderArbitrationList = (client, agentId, page, pageSize) => handleArbitrationListInner(client, agentId, page, pageSize, true);

async function handleArbitrationListInner(client, agentIdRaw, page, pageSize, includeTestFlag) {
  const agentId = trim(agentIdRaw);
  if (agentId === '') throw new Error('--agent-id must not be empty');
  if (Number(page) === 0) throw new Error('--page must be greater than 0');
  if (Number(pageSize) === 0) throw new Error('--page-size must be greater than 0');
  const response = await client.getWithAgentId(client.disputeListPath(page, pageSize), agentId);
  const items = Array.isArray(at(response, 'list')) ? at(response, 'list') : [];
  const total = asU64(at(response, 'total')) ?? 0;
  const enriched = [];
  for (const item of items) {
    const js = asStr(at(item, 'jobId'));
    const jobId = js === undefined ? undefined : trim(js);
    let status = null;
    if (jobId) {
      try { status = decodeDisputeStatusResponse(await client.getWithAgentId(client.endpoint(jobId, 'dispute/status'), agentId)); } catch { status = null; }
    }
    enriched.push([item, status]);
  }
  return buildListResult(page, total, enriched, includeTestFlag);
}

// upstream: arbitration.rs::handle_arbitration_detail → success data
export async function handleArbitrationDetail(client, jobIdRaw, agentIdRaw) {
  const jobId = trim(jobIdRaw), agentId = trim(agentIdRaw);
  if (jobId === '') throw new Error('jobId must not be empty');
  if (agentId === '') throw new Error('--agent-id must not be empty');
  const backend = await client.getWithAgentId(client.endpoint(jobId, 'dispute/status'), agentId);
  let arbitration;
  try { arbitration = decodeDisputeStatusResponse(backend); } catch (e) { throw context('failed to parse evaluation detail response', e); }
  let supplement;
  try {
    supplement = Number(arbitration.jobType) === 1 && arbitration.jobType !== null
      ? await client.fetchSubscription(jobId, agentId)
      : await client.getWithIdentity(client.taskPath(jobId), agentId);
  } catch { supplement = {}; }
  let evidence;
  try { evidence = await client.getWithAgentId(client.endpoint(jobId, 'evidence'), agentId); } catch { evidence = undefined; }
  return buildDetailResult(jobId, supplement, arbitration, backend, evidence);
}

export { trimStart as _trimStart };
