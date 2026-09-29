// One-time-task and subscription lifecycle projections with scoped local-history fallback —
// upstream task/common/lifecycle.rs. Fresh task detail stays authoritative; local official
// events (okx-a2a SQLite command store / session history) only fill timestamps and context.
import { existsSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { struct } from '../../../core/json.mjs';
import { fromStr } from '../../../core/serde.mjs';
import { parse as parseJson } from '../../../core/json.mjs';
import { isObject, get, asStr, asI64, asU64, numText, isNumber } from '../../../core/rs/value.mjs';
import { trim, asciiLower, eqIgnoreAsciiCase } from '../../../core/rs/str.mjs';
import { parseI64, parseI32 } from '../../../core/rs/num.mjs';
import { utcNowRfc3339, nowSecs } from '../../../core/rs/time.mjs';
import { Status, SubStatus } from './state-machine.mjs';
import { AGENT_ROLE_USER, PreFetchedTaskContext, fetchMyAgentsByRole } from './index.mjs';
import { firstTimestamp, parseTimestampSeconds, formatLocalTimestampWithOffset, REVIEW_WINDOW_SECONDS } from './deadline.mjs';
import { readManifest, deliverablesDir } from './deliverables.mjs';
import { sessionHistory } from './okx-a2a.mjs';
import { authoritativeRefundSettlementConfirmed, hasCreatedSubscriptionCloseReceipt } from '../user/refund.mjs';
import { fetchSubscribeDetailForAgent } from '../user/subscription-ops.mjs';

const MAX_LOCAL_ROWS = 512;
const MAX_COMMAND_JSON_BYTES = 128 * 1024;

// ─── scalar helpers (lifecycle.rs) ───
// upstream: lifecycle.rs::scalar_string — non-blank string kept verbatim, numbers rendered.
function scalarString(v) {
  if (typeof v === 'string') return trim(v) === '' ? undefined : v;
  return isNumber(v) ? numText(v) : undefined;
}
function scalarI64(v) {
  const i = asI64(v);
  if (i !== undefined) return i;
  const u = asU64(v);
  if (u !== undefined && BigInt(u) <= 9223372036854775807n) return u;
  const s = asStr(v);
  return s === undefined ? undefined : parseI64(trim(s));
}
function scalarI32(v) {
  const i = asI64(v);
  if (i !== undefined) return typeof i === 'number' && i >= -2147483648 && i <= 2147483647 ? i : undefined;
  const s = asStr(v);
  return s === undefined ? undefined : parseI32(trim(s));
}
const detailI64 = (d, keys) => { for (const k of keys) { const v = get(d, k); if (v === undefined) continue; const r = scalarI64(v); if (r !== undefined) return r; } return undefined; };
const detailString = (d, keys) => { for (const k of keys) { const v = get(d, k); if (v === undefined) continue; const r = scalarString(v); if (r !== undefined) return r; } return undefined; };
const nz = (v) => (v === undefined ? null : v);
const numEq = (a, b) => a !== undefined && a !== null && Number(a) === b;

// upstream: lifecycle.rs::parse_job_type
function parseJobType(v) {
  if (typeof v === 'string' && eqIgnoreAsciiCase(v, 'one_time')) return 0;
  if (typeof v === 'string' && eqIgnoreAsciiCase(v, 'subscription')) return 1;
  return scalarI32(v);
}

// ─── struct builders (field order) ───
const node = (marker, key, title, detail) => struct({ marker, key, title, detail: detail ?? undefined });
function pendingNode(key, title) { return node('○', key, title, key === 'completed' ? 'Not completed' : 'Not started'); }
const pendingReviewNode = (avail) => (avail ? node('○', 'user_review', 'Deliverable review', 'Deliverable received; waiting for the task status update') : pendingNode('user_review', 'Deliverable review'));
function display({ templateId, progressStep, progressTotal, deliverableAvailable, reviewReady, timeline, followUp = [], choices = [], currentSummary, handledBy, next, notice }) {
  return struct({ templateId: templateId ?? undefined, progressStep, progressTotal, deliverableAvailable, reviewReady, timeline,
    followUp: followUp.length ? followUp : undefined, choices: choices.length ? choices : undefined, currentSummary, handledBy, next, notice: notice ?? undefined });
}
const MILESTONE_KEYS = ['createdAt', 'acceptedAt', 'submittedAt', 'completedAt', 'rejectedAt', 'disputeRequestedAt', 'disputedAt', 'disputeResolvedAt',
  'reviewExpiredAt', 'rejectExpiredAt', 'closedAt', 'expiredAt', 'refundedAt', 'failedAt'];
const milestonesStruct = (m) => struct(Object.fromEntries(MILESTONE_KEYS.map((k) => [k, nz(m[k])])));
const SUB_MILESTONE_KEYS = ['createdAt', 'acceptDeadlineAt', 'acceptedAt', 'trialStartedAt', 'trialEndsAt', 'trialConvertedAt', 'currentPeriodStartedAt',
  'currentPeriodEndsAt', 'gracePeriodEndsAt', 'nextChargeAt', 'lastRenewedAt', 'renewalWarningAt', 'cancellationRequestedAt', 'rejectedAt', 'disputedAt',
  'completedAt', 'closedAt', 'expiredAt', 'refundedAt'];
const subMilestonesStruct = (m) => struct(Object.fromEntries(SUB_MILESTONE_KEYS.map((k) => [k, nz(m[k])])));
const eventStruct = (e) => struct({ messageId: e.messageId, eventId: nz(e.eventId), name: e.name, kind: e.kind, occurredAt: nz(e.occurredAt),
  deadlineAt: nz(e.deadlineAt), authoritativeStatus: nz(e.authoritativeStatus), jobType: nz(e.jobType), outcome: e.outcome ?? undefined,
  reason: e.reason ?? undefined, senderInboxId: nz(e.senderInboxId) });

// upstream: lifecycle.rs::LifecycleSnapshot (one-time) → struct
function snapshotStruct(s) {
  return struct({ jobId: s.jobId, taskType: s.taskType, phase: s.phase, statusLabel: s.statusLabel, responsibleParty: s.responsibleParty,
    nextAction: s.nextAction, confidence: s.confidence, authoritativeStatus: s.authoritativeStatus, statusSource: s.statusSource,
    historyAvailable: s.historyAvailable, historyReadSucceeded: s.historyReadSucceeded, historyEventCount: s.historyEventCount,
    aspAgentId: nz(s.aspAgentId), reviewDeadlineAt: nz(s.reviewDeadlineAt), milestones: milestonesStruct(s.milestones),
    events: s.events.map(eventStruct), display: s.display, syncedAt: s.syncedAt });
}
// upstream: lifecycle.rs::SubscriptionLifecycleSnapshot → struct
function subSnapshotStruct(s) {
  return struct({ jobId: s.jobId, taskType: s.taskType, phase: s.phase, statusLabel: s.statusLabel, responsibleParty: s.responsibleParty,
    nextAction: s.nextAction, confidence: s.confidence, authoritativeStatus: s.authoritativeStatus, statusSource: s.statusSource,
    historyAvailable: s.historyAvailable, historyReadSucceeded: s.historyReadSucceeded, historyEventCount: s.historyEventCount,
    aspAgentId: nz(s.aspAgentId), reviewDeadlineAt: nz(s.reviewDeadlineAt), trialType: nz(s.trialType), autoRenew: nz(s.autoRenew),
    periodIndex: nz(s.periodIndex), refundAmount: nz(s.refundAmount), refundTokenSymbol: nz(s.refundTokenSymbol), refundTxHash: nz(s.refundTxHash),
    milestones: subMilestonesStruct(s.milestones), events: s.events.map(eventStruct), display: s.display, syncedAt: s.syncedAt });
}

// ─── time formatting ───
function timestampSeconds(value) {
  if (value === undefined || value === null) return undefined;
  const raw = parseI64(value);
  if (raw === undefined) return undefined;
  const b = BigInt(raw);
  const abs = b < 0n ? -b : b;
  return Number(abs > 10000000000n ? b / 1000n : b);
}
const timestampHasPassed = (v) => { const s = timestampSeconds(v); return s !== undefined && nowSecs() >= s; };
const timestampIsFuture = (v) => { const s = timestampSeconds(v); return s !== undefined && nowSecs() < s; };
function formatTimestamp(value) {
  if (value === undefined || value === null) return undefined;
  const s = parseTimestampSeconds(value);
  return s === undefined ? undefined : formatLocalTimestampWithOffset(s);
}
const timeOrUnavailable = (v) => formatTimestamp(v) ?? 'Time unavailable';
function timeRange(start, end) {
  const a = formatTimestamp(start), b = formatTimestamp(end);
  if (a !== undefined && b !== undefined) return `${a} - ${b}`;
  if (a !== undefined) return `${a} started; end time unavailable`;
  if (b !== undefined) return `Completed at ${b}; start time unavailable`;
  return 'Time unavailable';
}
const startedOr = (v, dflt) => { const t = formatTimestamp(v); return t !== undefined ? `${t} started` : dflt; };

// ─── history ───
// upstream: lifecycle.rs::parse_history (throws the serde error on invalid JSON)
export function parseHistory(raw) {
  const value = fromStr(raw);
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const row of value) {
    if (!isObject(row)) continue;
    const idv = get(row, 'id');
    if (idv === undefined) continue;
    const id = scalarString(idv);
    if (id === undefined) continue;
    out.push({ id, senderInboxId: get(row, 'senderInboxId') === undefined ? null : nz(scalarString(get(row, 'senderInboxId'))),
      content: get(row, 'content') ?? null, sentAt: get(row, 'sentAt') === undefined ? null : nz(scalarString(get(row, 'sentAt'))),
      deliveryStatus: get(row, 'deliveryStatus') === undefined ? null : nz(scalarString(get(row, 'deliveryStatus'))) });
  }
  return out;
}

function decodeObject(value) {
  if (isObject(value)) return value;
  if (typeof value === 'string') { try { const v = parseJson(value); return isObject(v) ? v : undefined; } catch { return undefined; } }
  return undefined;
}
// upstream: lifecycle.rs::system_event_envelope
function systemEventEnvelope(content) {
  const decoded = decodeObject(content);
  if (!decoded) return undefined;
  const m = get(decoded, 'message');
  const env = isObject(m) ? m : decoded;
  const src = asStr(get(env, 'source'));
  return src !== undefined && eqIgnoreAsciiCase(src, 'system') ? env : undefined;
}

const KIND = new Map([['job_asp_selected', 'asp_selected'], ['job_created', 'created'], ['job_accepted', 'accepted'], ['job_submitted', 'submitted'],
  ['job_completed', 'completed'], ['job_auto_completed', 'completed'], ['job_rejected', 'rejected'], ['dispute_approved', 'dispute_requested'],
  ['job_disputed', 'disputed'], ['dispute_resolved', 'dispute_resolved'], ['review_expired', 'review_expired'], ['reject_expired', 'reject_expired'],
  ['job_provider_reject', 'provider_rejected'], ['job_closed', 'closed'], ['job_asp_reject_closed', 'closed'], ['job_expired', 'expired'],
  ['job_asp_accept_expire', 'expired'], ['submit_expired', 'expired'], ['job_refunded', 'refunded'], ['job_auto_refunded', 'refunded'],
  ['job_asp_reject_expire', 'refunded'], ['job_failed', 'failed'], ['sub_open', 'subscription_opened'], ['sub_created', 'subscription_created'],
  ['sub_asp_selected', 'subscription_asp_selected'], ['sub_cancel', 'subscription_cancelled'], ['sub_user_reject', 'subscription_delivery_rejected'],
  ['sub_asp_agree', 'subscription_refund_approved'], ['sub_asp_dispute', 'subscription_disputed'], ['sub_trial_into_active', 'subscription_trial_converted'],
  ['sub_renew', 'subscription_renewed'], ['sub_expire_warn', 'subscription_expiry_warning'], ['sub_complete_notify', 'subscription_completed'],
  ['sub_close_notify', 'subscription_closed'], ['sub_failed_notify', 'subscription_failed'], ['sub_reject_refund_notify', 'subscription_auto_refunded'],
  ['sub_asp_claim_notify', 'subscription_income_claimed']]);
// upstream: lifecycle.rs::event_kind
export const eventKind = (name) => KIND.get(asciiLower(trim(name)));

const firstScalar = (env, keys) => { for (const k of keys) { const v = get(env, k); if (v === undefined) continue; const s = scalarString(v); if (s !== undefined) return s; } return undefined; };
const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function timestampSortKey(v) {
  const t = v === undefined || v === null ? undefined : parseTimestampSeconds(v);
  return t !== undefined ? [0, BigInt(t), ''] : [1, 9223372036854775807n, v ?? ''];
}

// upstream: lifecycle.rs::events_from_history
export function eventsFromHistory(jobId, messages) {
  const seenMessages = new Set(), seenEvents = new Set(), events = [];
  for (const message of messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    const env = systemEventEnvelope(message.content);
    if (!env) continue;
    if (firstScalar(env, ['jobId']) !== jobId) continue;
    const eventName = asStr(get(env, 'event'));
    if (eventName === undefined) continue;
    const kind = eventKind(eventName);
    if (kind === undefined) continue;
    const occurredAt = firstScalar(env, ['occurredAt', 'eventTime', 'timestamp', 'createdAt']) ?? message.sentAt ?? undefined;
    const deadlineAt = firstScalar(env, ['reviewDeadlineAt', 'reviewWindowEndsAt', 'rejectWindowEndsAt', 'acceptDeadline', 'trialEndTime', 'trailEndTime', 'subBufferEndTime', 'expireTime']);
    const eventId = firstScalar(env, ['eventId']);
    const name = asciiLower(trim(eventName));
    const logicalKey = eventId ?? `${jobId}:${name}:${occurredAt ?? ''}`;
    if (seenEvents.has(logicalKey)) continue;
    seenEvents.add(logicalKey);
    const jt = get(env, 'jobType');
    const jobType = (jt === undefined ? undefined : parseJobType(jt)) ?? (name.startsWith('sub_') ? 1 : undefined);
    events.push({
      messageId: message.id, eventId: nz(eventId), name, kind, occurredAt: nz(occurredAt), deadlineAt: nz(deadlineAt),
      authoritativeStatus: nz(firstScalar(env, ['subStatus', 'jobStatus', 'taskStatus', 'status'])), jobType: nz(jobType),
      outcome: nz(firstScalar(env, ['renewResult', 'cancelResult', 'disputeResult', 'evaluationResult', 'winner', 'verdict', 'result'])),
      reason: nz(firstScalar(env, ['failReason', 'failReasopn', 'aspRejectReason', 'refundReason', 'rejectReason', 'reason'])),
      senderInboxId: nz(message.senderInboxId),
    });
  }
  events.sort((l, r) => {
    const a = timestampSortKey(l.occurredAt), b = timestampSortKey(r.occurredAt);
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    const c = byteCmp(a[2], b[2]);
    return c !== 0 ? c : byteCmp(l.messageId, r.messageId);
  });
  return events;
}

// ─── one-time projection ───
const PHASE = { init: 'initializing', created: 'waiting_for_asp', accepted: 'asp_executing', submitted: 'waiting_for_user_review', rejected: 'rejected',
  disputed: 'disputed', completed: 'completed', close: 'closed', admin_stopped: 'closed', expired: 'expired', failed: 'refunded' };
const phaseFromStatus = (s) => PHASE[s] ?? 'unknown';
const STATUS_LABEL = { init: 'Task initializing', created: 'Waiting for ASP acceptance', accepted: 'ASP executing', submitted: 'Waiting for user review',
  rejected: 'Deliverable rejected', disputed: 'Platform review in progress', admin_stopped: 'Stopped by platform', completed: 'Task completed',
  close: 'Task closed', expired: 'Task expired', failed: 'Refund completed' };
const statusLabel = (s) => STATUS_LABEL[s] ?? 'Status unavailable';
function responsibleParty(phase) {
  if (['initializing', 'disputed', 'unknown'].includes(phase)) return 'official';
  if (['waiting_for_asp', 'asp_executing', 'free_trial', 'active_subscription', 'awaiting_asp_decision'].includes(phase)) return 'asp';
  if (['renewal_grace_period', 'waiting_for_user_review', 'rejected'].includes(phase)) return 'user';
  return 'none';
}
const NEXT = { initializing: 'Wait for task initialization', waiting_for_asp: 'Wait for the ASP to accept the task', asp_executing: 'Wait for the ASP to submit the deliverable',
  free_trial: 'Use the service or cancel before the trial ends', active_subscription: 'Continue using the subscription service',
  renewal_grace_period: 'Fund the wallet before the grace period ends', awaiting_asp_decision: 'Wait for the ASP refund decision',
  waiting_for_user_review: 'Review the ASP deliverable', rejected: 'Wait for the ASP response or platform review', disputed: 'Wait for the platform review result',
  unknown: 'Try the task query again later' };
const nextAction = (phase) => NEXT[phase] ?? 'No further task action';

// upstream: lifecycle.rs::status_from_event → Status | undefined
function statusFromEvent(event) {
  const raw = event.authoritativeStatus;
  if (raw !== null && raw !== undefined) {
    const code = parseI32(raw);
    if (code !== undefined) return Status.fromInt(code);
    const parsed = Status.parse(asciiLower(trim(raw)));
    if (!Status.isOther(parsed)) return parsed;
  }
  switch (event.kind) {
    case 'asp_selected': case 'created': case 'provider_rejected': return 'created';
    case 'accepted': return 'accepted';
    case 'submitted': case 'review_expired': return 'submitted';
    case 'rejected': case 'dispute_requested': case 'reject_expired': return 'rejected';
    case 'disputed': return 'disputed';
    case 'completed': return 'completed';
    case 'closed': return 'close';
    case 'expired': return 'expired';
    case 'refunded': case 'failed': return 'failed';
    default: return undefined;
  }
}

const FOLD = { created: 'createdAt', accepted: 'acceptedAt', submitted: 'submittedAt', completed: 'completedAt', rejected: 'rejectedAt',
  dispute_requested: 'disputeRequestedAt', disputed: 'disputedAt', dispute_resolved: 'disputeResolvedAt', review_expired: 'reviewExpiredAt',
  reject_expired: 'rejectExpiredAt', closed: 'closedAt', expired: 'expiredAt', refunded: 'refundedAt', failed: 'failedAt' };
function foldMilestones(events) {
  const r = Object.fromEntries(MILESTONE_KEYS.map((k) => [k, null]));
  for (const e of events) { const slot = FOLD[e.kind]; if (slot && r[slot] === null) r[slot] = e.occurredAt; }
  return r;
}
function eventsConflictWithStatus(status, events) {
  let terminal;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = e.kind === 'completed' ? 'completed' : e.kind === 'closed' ? 'close' : e.kind === 'expired' ? 'expired'
      : e.kind === 'refunded' || e.kind === 'failed' ? 'failed' : e.kind === 'dispute_resolved' ? statusFromEvent(e) : undefined;
    if (t !== undefined) { terminal = t; break; }
  }
  if (terminal === undefined) return false;
  if (!Status.isTerminal(status)) return true;
  return terminal !== status && !(status === 'admin_stopped' && terminal === 'close');
}

// upstream: lifecycle.rs::build_display
export function buildDisplay(phase, m, reviewDeadlineAt, tokenAmount, tokenSymbol, events, deliverableAvailable, notice) {
  const created = () => node('✓', 'created', 'Task created', timeOrUnavailable(m.createdAt));
  const accepted = () => node('✓', 'accepted', 'ASP accepted', timeOrUnavailable(m.acceptedAt));
  const executed = () => node('✓', 'asp_execution', 'ASP executed', timeRange(m.acceptedAt, m.submittedAt));
  const hasRejection = m.rejectedAt !== null || events.some((e) => e.kind === 'rejected');
  const evaluationResolved = m.disputeResolvedAt !== null;
  const reviewRange = () => timeRange(m.disputedAt ?? m.disputeRequestedAt, m.disputeResolvedAt);
  let step, timeline, followUp = [], summary, handledBy, next;
  switch (phase) {
    case 'initializing':
      step = 1;
      timeline = [node('▶', 'created', 'Creating task', 'Start time unavailable'), pendingNode('accepted', 'ASP acceptance'), pendingNode('asp_execution', 'ASP execution'),
        pendingReviewNode(deliverableAvailable), pendingNode('completed', 'Task completion')];
      [summary, handledBy, next] = ['Creating task', 'Platform', 'Wait for task creation'];
      break;
    case 'waiting_for_asp':
      step = 2;
      timeline = [created(), node('▶', 'accepted', 'Waiting for ASP acceptance', startedOr(m.createdAt, 'Start time unavailable')),
        pendingNode('asp_execution', 'ASP execution'), pendingReviewNode(deliverableAvailable), pendingNode('completed', 'Task completion')];
      [summary, handledBy, next] = ['Waiting for ASP acceptance', 'ASP', 'Wait for the ASP to accept'];
      break;
    case 'asp_executing':
      step = 3;
      timeline = [created(), accepted(), node('▶', 'asp_execution', 'ASP executing', startedOr(m.acceptedAt, 'Start time unavailable')),
        pendingReviewNode(deliverableAvailable), pendingNode('completed', 'Task completion')];
      [summary, handledBy, next] = ['ASP executing', 'ASP', 'Wait for the ASP to submit'];
      break;
    case 'waiting_for_user_review': {
      const expired = m.reviewExpiredAt !== null;
      const ready = !expired && deliverableAvailable;
      let detail;
      if (expired) detail = timeOrUnavailable(m.reviewExpiredAt);
      else if (!deliverableAvailable) { const t = formatTimestamp(m.submittedAt); detail = t !== undefined ? `${t} started; waiting for the deliverable` : 'Waiting for the deliverable'; }
      else {
        const s = formatTimestamp(m.submittedAt), d = formatTimestamp(reviewDeadlineAt);
        detail = s !== undefined && d !== undefined ? `${s} started; accept or reject by ${d}` : s !== undefined ? `${s} started; accept or reject; deadline unavailable`
          : d !== undefined ? `Accept or reject by ${d}` : 'Accept or reject the deliverable; timing unavailable';
      }
      step = 4;
      timeline = [created(), accepted(), executed(),
        node(expired ? '—' : '▶', 'user_review', expired ? 'Deliverable review period ended' : 'Waiting for you to review the deliverable', detail),
        pendingNode('completed', 'Task completion')];
      summary = expired ? 'Waiting for task completion' : !ready ? 'Waiting for the deliverable' : 'Waiting for you to review the deliverable';
      handledBy = expired || !ready ? 'ASP' : 'You';
      next = expired ? 'Wait for the final result' : !ready ? 'Wait for the deliverable to arrive' : 'Accept or reject the deliverable';
      break;
    }
    case 'rejected': case 'disputed': {
      const rejected = node('✓', 'user_review', 'Deliverable rejected', timeOrUnavailable(m.rejectedAt));
      let follow;
      if (evaluationResolved) follow = node('✓', 'platform_review', 'Platform review completed', reviewRange());
      else if (phase === 'disputed') follow = node('▶', 'platform_review', 'Platform review in progress', startedOr(m.disputedAt, 'Start time unavailable'));
      else if (m.disputeRequestedAt !== null) { const t = formatTimestamp(m.disputeRequestedAt); follow = node('▶', 'platform_review', 'Waiting for platform review', t !== undefined ? `${t} requested` : 'Request time unavailable'); }
      else if (m.rejectExpiredAt !== null) follow = node('▶', 'refund_pending', 'Waiting for refund', timeOrUnavailable(m.rejectExpiredAt));
      else follow = node('▶', 'asp_response', 'Waiting for ASP response', startedOr(m.rejectedAt, 'Start time unavailable'));
      step = 4;
      timeline = [created(), accepted(), executed(), rejected, pendingNode('completed', 'Task completion')];
      followUp = [follow];
      summary = evaluationResolved ? 'Platform review completed' : phase === 'disputed' ? 'Platform review in progress' : 'Waiting for the next response';
      handledBy = evaluationResolved || phase === 'disputed' ? 'Platform' : 'ASP';
      next = evaluationResolved ? 'Wait for the final task result' : 'Wait for the result';
      break;
    }
    case 'completed': {
      const review = hasRejection ? node('✓', 'user_review', 'Deliverable rejected', timeOrUnavailable(m.rejectedAt))
        : node('✓', 'user_review', 'Deliverable confirmed', timeRange(m.submittedAt, m.completedAt));
      step = 5;
      timeline = [created(), accepted(), executed(), review, node('✓', 'completed', 'Task completed', timeOrUnavailable(m.completedAt))];
      if (evaluationResolved) followUp = [node('✓', 'platform_review', 'Platform review completed', `${reviewRange()}; result supports the ASP`)];
      [summary, handledBy, next] = ['Task completed', 'No action needed', 'No further action'];
      break;
    }
    case 'refunded': case 'failed': {
      const review = hasRejection ? node('✓', 'user_review', 'Deliverable rejected', timeOrUnavailable(m.rejectedAt))
        : m.submittedAt !== null ? node('—', 'user_review', 'Deliverable review ended', 'The task ended before deliverable review') : pendingNode('user_review', 'Deliverable review');
      if (evaluationResolved) followUp.push(node('✓', 'platform_review', 'Platform review completed', `${reviewRange()}; result supports you`));
      const refundTime = m.refundedAt ?? m.failedAt;
      let amount;
      if (tokenAmount && tokenSymbol) amount = `${tokenAmount} ${tokenSymbol} returned`;
      else if (tokenAmount) amount = `${tokenAmount} returned`;
      const t = formatTimestamp(refundTime);
      const refundDetail = t !== undefined && amount !== undefined ? `${t}; ${amount}` : t !== undefined ? t : amount;
      followUp.push(node('✓', 'refund', 'Refund completed', refundDetail));
      const acceptedNode = m.acceptedAt !== null ? accepted() : pendingNode('accepted', 'ASP acceptance');
      const execNode = m.submittedAt !== null ? executed() : m.acceptedAt !== null ? node('—', 'asp_execution', 'ASP execution ended', timeRange(m.acceptedAt, refundTime))
        : pendingNode('asp_execution', 'ASP execution');
      step = hasRejection || m.submittedAt !== null ? 4 : m.acceptedAt !== null ? 3 : 2;
      timeline = [created(), acceptedNode, execNode, review, node('—', 'completed', 'Task not completed', 'Ended before normal completion')];
      [summary, handledBy, next] = ['Refund completed', 'No action needed', 'No further action'];
      break;
    }
    case 'expired': case 'closed': {
      const last = events[events.length - 1];
      const hasSubmission = m.submittedAt !== null;
      const started = (last !== undefined && last.name === 'submit_expired') || m.acceptedAt !== null;
      const three = hasSubmission ? executed() : started
        ? node('—', 'asp_execution', phase === 'expired' ? 'ASP submission timed out' : 'ASP execution ended', timeOrUnavailable(m.expiredAt ?? m.closedAt))
        : pendingNode('asp_execution', 'ASP execution');
      const two = m.acceptedAt !== null || started ? accepted()
        : phase === 'expired' ? node('—', 'accepted', 'ASP acceptance timed out', timeOrUnavailable(m.expiredAt)) : pendingNode('accepted', 'ASP acceptance');
      const eventTime = phase === 'expired' ? m.expiredAt : m.closedAt;
      const four = hasSubmission ? node('—', 'user_review', 'Deliverable review period ended', timeOrUnavailable(eventTime)) : pendingNode('user_review', 'Deliverable review');
      followUp = [node('✓', phase === 'expired' ? 'expired' : 'closed', phase === 'expired' ? 'Task expired' : 'Task closed', formatTimestamp(eventTime))];
      step = hasSubmission ? 4 : started ? 3 : 2;
      timeline = [created(), two, three, four, pendingNode('completed', 'Task completion')];
      [summary, handledBy, next] = [phase === 'expired' ? 'Task expired' : 'Task closed', 'No action needed', 'No further action'];
      break;
    }
    default:
      step = 1;
      timeline = [pendingNode('created', 'Task creation'), pendingNode('accepted', 'ASP acceptance'), pendingNode('asp_execution', 'ASP execution'),
        pendingNode('user_review', 'Deliverable review'), pendingNode('completed', 'Task completion')];
      [summary, handledBy, next] = ['Task status unavailable', 'Unknown', 'Try again later'];
  }
  return display({ progressStep: step, progressTotal: 5, deliverableAvailable,
    reviewReady: phase === 'waiting_for_user_review' && deliverableAvailable && m.reviewExpiredAt === null,
    timeline, followUp, currentSummary: summary, handledBy, next, notice });
}

// upstream: lifecycle.rs::build_snapshot_with_history_state (plain snapshot object; see snapshotStruct)
export function buildSnapshotWithHistoryState(jobId, status, messages, historyReadSucceeded) {
  const events = eventsFromHistory(jobId, messages);
  const milestones = foldMilestones(events);
  const phase = phaseFromStatus(status);
  const historyAvailable = events.length > 0;
  const confidence = Status.isOther(status) ? 'unknown' : eventsConflictWithStatus(status, events) ? 'conflict' : !historyAvailable ? 'partial' : 'confirmed';
  const disp = buildDisplay(phase, milestones, undefined, undefined, undefined, events, false,
    historyAvailable ? undefined : 'Some historical times are unavailable; the current stage comes from the latest task details.');
  return { jobId, taskType: 'one_time', phase, statusLabel: statusLabel(status), responsibleParty: responsibleParty(phase), nextAction: nextAction(phase),
    confidence, authoritativeStatus: status, statusSource: 'task_api', historyAvailable, historyReadSucceeded, historyEventCount: events.length,
    aspAgentId: null, reviewDeadlineAt: null, milestones, events, display: disp, syncedAt: utcNowRfc3339() };
}
// upstream: lifecycle.rs::build_snapshot
export const buildSnapshot = (jobId, status, messages) => buildSnapshotWithHistoryState(jobId, status, messages, true);

function withNotice(d, notice) { return display({ ...d, followUp: d.followUp ?? [], choices: d.choices ?? [], notice }); }

// upstream: lifecycle.rs::unavailable_snapshot
function unavailableSnapshot(jobId, notice) {
  const s = buildSnapshotWithHistoryState(jobId, 'unavailable', [], false);
  s.taskType = 'unknown';
  s.statusSource = 'unavailable';
  s.display = withNotice(s.display, notice);
  return s;
}

// upstream: lifecycle.rs::review_deadline
function reviewDeadline(detail, events, milestones) {
  const exact = firstTimestamp(detail, ['reviewDeadlineAt', 'reviewWindowEndsAt', 'expireTime']);
  if (exact !== undefined) return exact;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== 'submitted') continue;
    const d = events[i].deadlineAt;
    const t = d === null ? undefined : parseTimestampSeconds(d);
    if (t !== undefined) return t;
    break;
  }
  const sub = milestones.submittedAt === null ? undefined : parseTimestampSeconds(milestones.submittedAt);
  if (sub === undefined) return undefined;
  const sum = BigInt(sub) + BigInt(REVIEW_WINDOW_SECONDS);
  return sum > 9223372036854775807n ? undefined : sum;
}

function snapshotFromLocalFallback(jobId, local) {
  const events = eventsFromHistory(jobId, local.messages);
  let taskType, status;
  for (let i = events.length - 1; i >= 0; i--) if (taskType === undefined && events[i].jobType !== null) taskType = events[i].jobType;
  for (let i = events.length - 1; i >= 0; i--) { const s = statusFromEvent(events[i]); if (s !== undefined) { status = s; break; } }
  if (taskType !== 0 || status === undefined) {
    const s = unavailableSnapshot(jobId, 'Verified local task history is incomplete.');
    s.taskType = taskType === 1 ? 'subscription' : taskType !== undefined ? 'unsupported' : 'unknown';
    s.historyReadSucceeded = local.readSucceeded;
    s.historyAvailable = events.length > 0;
    s.historyEventCount = events.length;
    s.events = events;
    return s;
  }
  const s = buildSnapshotWithHistoryState(jobId, status, local.messages, local.readSucceeded);
  s.statusSource = 'local_official_event';
  s.confidence = 'partial';
  const rd = reviewDeadline(null, s.events, s.milestones);
  s.reviewDeadlineAt = rd === undefined ? null : String(rd);
  s.display = buildDisplay(s.phase, s.milestones, s.reviewDeadlineAt, undefined, undefined, s.events, localUserDeliverableExists(jobId),
    'Latest task details are unavailable; showing the latest verified local task record.');
  return s;
}

function mergeDetailMilestones(m, detail) {
  const fill = (slot, keys) => { if (m[slot] === null) m[slot] = nz(detailString(detail, keys)); };
  fill('createdAt', ['createdAt', 'createTime']); fill('acceptedAt', ['acceptedAt', 'acceptTime']); fill('submittedAt', ['submittedAt', 'submitTime']);
  fill('completedAt', ['completedAt', 'completeTime']); fill('rejectedAt', ['rejectedAt', 'rejectTime']); fill('disputedAt', ['disputedAt', 'disputeTime']);
  fill('disputeResolvedAt', ['disputeResolvedAt', 'arbitrationCompletedAt']); fill('closedAt', ['closedAt', 'closeTime']); fill('expiredAt', ['expiredAt']);
  fill('refundedAt', ['refundedAt', 'refundTime']); fill('failedAt', ['failedAt', 'failureTime']);
}

const safeLookupKey = (v) => typeof v === 'string' && v !== '' && Buffer.byteLength(v) <= 256 && /^[A-Za-z0-9_:-]+$/.test(v);

function localUserDeliverableExists(jobId) {
  if (!safeLookupKey(jobId)) return false;
  let manifest;
  try { manifest = readManifest('user', jobId); } catch { return false; }
  if (!manifest || manifest.jobId !== jobId || manifest.role !== 'user') return false;
  const entry = manifest.entries[manifest.entries.length - 1];
  if (!entry) return false;
  const f = entry.filename;
  if (f === '' || f === '.' || f === '..' || f.includes('/') || (process.platform === 'win32' && (f.includes('\\') || /^[A-Za-z]:/.test(f)))) return false;
  let dir;
  try { dir = deliverablesDir('user', jobId); } catch { return false; }
  try { return lstatSync(join(dir, f)).isFile(); } catch { return false; }
}

// upstream: lifecycle.rs::initial_creation_display
export function initialCreationDisplay() {
  const m = Object.fromEntries(MILESTONE_KEYS.map((k) => [k, null]));
  const d = buildDisplay('initializing', m, undefined, undefined, undefined, [], false, undefined);
  d.timeline[0] = node(d.timeline[0].marker, d.timeline[0].key, d.timeline[0].title, 'Creation submitted; waiting for task confirmation');
  return d;
}

// ─── subscription projection ───
function subscriptionPhase(status, trialType, inGrace, refundProven) {
  const s = status === undefined ? undefined : Number(status);
  if (s === -1) return 'initializing';
  if (s === 0) return 'waiting_for_asp';
  if (s === 1 && inGrace) return 'renewal_grace_period';
  if (s === 1 && numEq(trialType, 1)) return 'free_trial';
  if (s === 1) return 'active_subscription';
  if (s === 3) return 'awaiting_asp_decision';
  if (s === 4) return 'disputed';
  if (s === 6) return 'completed';
  if (s === 7) return 'closed';
  if (s === 8) return 'expired';
  if (s === 9) return refundProven ? 'refunded' : 'failed';
  return 'unknown';
}
function subscriptionTemplateNumber(status, trialType, autoRenew, inGrace, refundProven, m, events, userClose) {
  const has = (k) => events.some((e) => e.kind === k);
  const accepted = m.acceptedAt !== null || m.trialStartedAt !== null || m.currentPeriodStartedAt !== null || has('subscription_created');
  const cancelled = userClose || has('subscription_cancelled');
  const disputed = has('subscription_disputed') || has('dispute_resolved');
  const graceEnded = timestampHasPassed(m.gracePeriodEndsAt);
  const s = status === undefined ? undefined : Number(status);
  if (s === -1) return 1;
  if (s === 0) return 2;
  if (s === 1 && numEq(trialType, 1)) return 3;
  if (s === 1 && inGrace) return 11;
  if (s === 1 && numEq(autoRenew, 0)) return 5;
  if (s === 1) return 4;
  if (s === 3) return 14;
  if (s === 4) return 16;
  if (s === 6) return disputed ? 18 : 13;
  if (s === 8) return cancelled ? 8 : 7;
  if (s === 7 && !accepted && cancelled) return 8;
  if (s === 7 && !accepted) return 6;
  if (s === 7 && numEq(trialType, 1) && accepted) return 10;
  if (s === 7 && graceEnded) return 12;
  if (s === 7) return 13;
  if (s === 9 && refundProven && disputed) return 17;
  if (s === 9 && refundProven) return 15;
  if (s === 9 && numEq(trialType, 1)) return 9;
  if (s === 9 && graceEnded) return 12;
  return undefined;
}
const SUB_LABELS = { 1: 'Creating subscription task', 2: 'Task created; waiting for ASP acceptance', 3: 'Free trial active', 4: 'Subscription active; auto-renewal enabled',
  5: 'Subscription active; auto-renewal disabled', 6: 'ASP declined the task; task closed', 7: 'ASP acceptance deadline passed; task closed automatically',
  8: 'User closed the task', 9: 'Paid subscription did not start; task closed', 10: 'Free trial ended; task closed',
  11: 'Renewal payment failed; subscription is in the grace period', 12: 'Payment was not completed during the grace period; subscription ended',
  13: 'All current service periods ended; subscription completed', 14: 'Subscription ended; refund request pending', 15: 'Refund completed; task closed',
  16: 'Evaluation in progress; waiting for evaluator votes', 17: 'Evaluation completed; user won; task closed', 18: 'Evaluation completed; ASP won; task closed' };
function subscriptionStatusLabel(t, phase, autoRenew) {
  if (t !== undefined) return SUB_LABELS[t];
  return {
    initializing: 'Subscription initializing', waiting_for_asp: 'Waiting for ASP acceptance', free_trial: 'Free trial active',
    active_subscription: numEq(autoRenew, 0) ? 'Active until the current period ends' : 'Subscription active', renewal_grace_period: 'Renewal payment in grace period',
    awaiting_asp_decision: 'Waiting for ASP refund decision', disputed: 'Evaluation in progress', completed: 'Subscription completed', closed: 'Subscription closed',
    expired: 'Subscription expired', refunded: 'Refund completed', failed: 'Subscription result needs reconciliation', rejected: 'Waiting for ASP refund decision',
    asp_executing: 'Subscription active', waiting_for_user_review: 'Waiting for user review', unknown: 'Status unavailable',
  }[phase];
}
function subscriptionResponsibleParty(t, phase) {
  if (t === 1) return 'platform';
  if ([2, 3, 4, 5, 14].includes(t)) return 'asp';
  if (t === 11) return 'user';
  if (t === 16) return 'evaluator';
  if ([6, 7, 8, 9, 10, 12, 13, 15, 17, 18].includes(t)) return 'none';
  if (['initializing', 'disputed', 'unknown'].includes(phase)) return 'official';
  if (['waiting_for_asp', 'free_trial', 'active_subscription', 'awaiting_asp_decision', 'rejected', 'asp_executing'].includes(phase)) return 'asp';
  if (['renewal_grace_period', 'waiting_for_user_review'].includes(phase)) return 'user';
  return 'none';
}
function subscriptionNextAction(t, phase, autoRenew, detail, m, events) {
  const time = (v) => formatTimestamp(v) ?? 'an unavailable time';
  const amount = detailString(detail, ['serviceTokenAmount', 'tokenAmount', 'paymentTokenAmount', 'refundAmount']) ?? 'an unavailable amount';
  const token = detailString(detail, ['serviceTokenSymbol', 'tokenSymbol', 'paymentTokenSymbol', 'refundTokenSymbol']) ?? 'an unavailable token';
  let reason = detailString(detail, ['failReason', 'failReasopn', 'aspRejectReason', 'refundReason', 'reason']);
  if (reason === undefined) { for (let i = events.length - 1; i >= 0; i--) if (events[i].reason !== null) { reason = events[i].reason; break; } }
  reason = reason ?? 'unavailable';
  const next = detailString(detail, ['nextAction', 'recommendedAction']) ?? 'fund the wallet and refresh any required allowance';
  switch (t) {
    case 1: return 'Wait for subscription task creation to complete.';
    case 2: return `Wait for the ASP to accept before ${time(m.acceptDeadlineAt)}. If the ASP does not respond before the deadline, the task will close automatically and any paid service fee will be returned to the wallet.`;
    case 3: {
      const trialEnd = time(m.trialEndsAt);
      const firstCharge = time(detailString(detail, ['firstChargeAt', 'nextChargeAt', 'nextChargeTime']) ?? m.trialEndsAt);
      const lastCancel = time(detailString(detail, ['lastCancelAt', 'cancelDeadline']) ?? m.trialEndsAt);
      return `The free trial ends at ${trialEnd}. The system will charge ${amount} ${token} at ${firstCharge} and convert it to a paid subscription. Cancel before ${lastCancel} if you do not want to continue.`;
    }
    case 4: return `The system will automatically charge ${amount} ${token} at ${time(m.nextChargeAt ?? m.currentPeriodEndsAt)}. Keep enough wallet balance and allowance available.`;
    case 5: return `The current service remains available until ${time(m.currentPeriodEndsAt)} and will then end automatically. Enable auto-renewal before expiry to continue.`;
    case 6: case 7: case 8: return 'No action is required. A supported free-trial entitlement is unaffected; any paid service fee will be returned automatically when applicable.';
    case 9: return `Charge failure reason: ${reason}. The system will not retry automatically. To continue, ${next}, then subscribe again.`;
    case 10: return 'No action is required. The paid subscription did not begin, so no subscription fee will be charged.';
    case 11: return `The grace period ends at ${time(m.gracePeriodEndsAt)}. Before then, ${next}. Service remains active during the grace period and the system will keep retrying; if payment is still incomplete at expiry, the subscription will end automatically. Charge failure reason: ${reason}.`;
    case 12: return 'No action is required. Subscribe again if you want to continue using the service.';
    case 13: return 'No action is required. Subscribe again to continue using the service.';
    case 14: return `The ASP must approve the refund or request an evaluation before ${time(detailString(detail, ['rejectWindowEndsAt', 'responseDeadline', 'reviewDeadlineAt']))}. If no action is taken by the deadline, the system will approve the refund automatically.`;
    case 15: return `No action is required. The current-period fee of ${amount} ${token} will be returned automatically to the wallet.`;
    case 16: return `Evaluators must finish voting before ${time(detailString(detail, ['votingDeadline', 'voteCommitDeadline', 'reviewDeadlineAt']))}. The platform will handle the current-period fee according to the result.`;
    case 17: return `The current-period fee of ${amount} ${token} will be returned automatically to the wallet.`;
    case 18: return 'The current-period fee will not be refunded; the system will settle it to the ASP automatically.';
    default:
      return {
        initializing: 'Wait for on-chain confirmation', waiting_for_asp: 'Wait for the ASP to accept the subscription',
        free_trial: 'Use the service or cancel before the trial ends if you do not want the first charge',
        active_subscription: numEq(autoRenew, 0) ? 'Enable auto-renewal before the current period ends to continue the service' : 'Continue using the service and keep enough balance for the next renewal',
        asp_executing: 'Continue using the service and keep enough balance for the next renewal',
        renewal_grace_period: 'Fund the wallet before the grace period ends so renewal can complete',
        awaiting_asp_decision: 'Wait for the ASP to approve the refund or request an evaluation', rejected: 'Wait for the ASP to approve the refund or request an evaluation',
        disputed: 'Wait for the evaluation result', waiting_for_user_review: 'Review the current delivery', failed: 'Reconcile the final payment or refund result',
        completed: 'No further subscription action', closed: 'No further subscription action', expired: 'No further subscription action', refunded: 'No further subscription action',
        unknown: 'Try the subscription query again later',
      }[phase];
  }
}
const subEventTime = (events, kinds) => { const e = events.find((x) => kinds.includes(x.kind)); return e ? e.occurredAt : null; };
const subLastEventTime = (events, kinds) => { for (let i = events.length - 1; i >= 0; i--) if (kinds.includes(events[i].kind)) return events[i].occurredAt; return null; };
function subscriptionMilestones(detail, events) {
  const d = (keys) => nz(detailString(detail, keys));
  return {
    createdAt: d(['createdAt', 'createTime']) ?? subEventTime(events, ['subscription_opened', 'subscription_created']),
    acceptDeadlineAt: d(['acceptDeadline', 'acceptExpireTime', 'expireTime']),
    acceptedAt: d(['acceptedAt', 'acceptTime']) ?? subEventTime(events, ['subscription_created', 'subscription_asp_selected']),
    trialStartedAt: d(['trialStartTime', 'trailStartTime']), trialEndsAt: d(['trialEndTime', 'trailEndTime']),
    trialConvertedAt: subEventTime(events, ['subscription_trial_converted']),
    currentPeriodStartedAt: d(['subStartTime', 'periodStart']), currentPeriodEndsAt: d(['subEndTime', 'periodEnd']),
    gracePeriodEndsAt: d(['subBufferEndTime', 'graceEndsAt']), nextChargeAt: d(['nextChargeAt', 'nextChargeTime']),
    lastRenewedAt: subLastEventTime(events, ['subscription_renewed']), renewalWarningAt: subLastEventTime(events, ['subscription_expiry_warning']),
    cancellationRequestedAt: subLastEventTime(events, ['subscription_cancelled']),
    rejectedAt: d(['rejectedAt', 'rejectTime']) ?? subEventTime(events, ['subscription_delivery_rejected']),
    disputedAt: d(['disputedAt', 'disputeTime']) ?? subEventTime(events, ['subscription_disputed']),
    completedAt: d(['completedAt', 'completeTime']) ?? subEventTime(events, ['subscription_completed']),
    closedAt: d(['closedAt', 'closeTime']) ?? subEventTime(events, ['subscription_closed']),
    expiredAt: d(['expiredAt']), refundedAt: d(['refundedAt', 'refundTime']),
  };
}
function buildSubscriptionDisplay(phase, t, summary, handledBy, next) {
  const standard = (mk) => [
    node(mk[0], 'created', mk[0] === '▶' ? 'Task creation in progress' : 'Task creation'),
    node(mk[1], 'accepted', mk[1] === '▶' ? 'ASP acceptance decision pending' : mk[1] === '✓' ? 'ASP accepted' : 'ASP acceptance'),
    node(mk[2], 'service', mk[2] === '▶' ? 'ASP providing service' : mk[2] === '✓' ? 'ASP provided service' : 'ASP service'),
    node(mk[3], 'ended', 'Subscription end'),
  ];
  const closedBefore = (middle) => [node('✓', 'created', 'Task creation'), node('✓', 'pre_service_result', middle), node('✓', 'closed', 'Task closed')];
  const active = t === 14 || t === 16;
  const refund = (fourth) => [node('✓', 'created', 'Task creation'), node('✓', 'accepted', 'ASP acceptance'), node('✓', 'service', 'ASP service provided'),
    node(active ? '▶' : '✓', 'refund_or_evaluation', fourth), node(active ? '○' : '✓', 'closed', 'Task closed')];
  let step, total, timeline;
  if (t === 1) [step, total, timeline] = [1, 4, standard(['▶', '○', '○', '○'])];
  else if (t === 2) [step, total, timeline] = [2, 4, standard(['✓', '▶', '○', '○'])];
  else if ([3, 4, 5, 11].includes(t)) [step, total, timeline] = [3, 4, standard(['✓', '✓', '▶', '○'])];
  else if (t === 6) [step, total, timeline] = [3, 3, closedBefore('ASP declined')];
  else if (t === 7) [step, total, timeline] = [3, 3, closedBefore('ASP acceptance timed out')];
  else if (t === 8) [step, total, timeline] = [3, 3, closedBefore('User closed task')];
  else if ([9, 10, 12, 13].includes(t)) [step, total, timeline] = [4, 4, standard(['✓', '✓', '✓', '✓'])];
  else if (t === 14) [step, total, timeline] = [4, 5, refund('Refund request processing')];
  else if (t === 15) [step, total, timeline] = [5, 5, refund('Refund request completed')];
  else if (t === 16) [step, total, timeline] = [4, 5, refund('Refund request under evaluation')];
  else if (t === 17) [step, total, timeline] = [5, 5, refund('Refund request completed (user won)')];
  else if (t === 18) [step, total, timeline] = [5, 5, refund('Refund request completed (ASP won)')];
  else if (phase === 'failed') [step, total, timeline] = [4, 4, standard(['✓', '✓', '✓', '✓'])];
  else [step, total, timeline] = [1, 4, standard([phase === 'initializing' ? '▶' : '○', '○', '○', '○'])];
  return {
    templateId: t === undefined ? undefined : `Sub-Status-${t}`, progressStep: step, progressTotal: total, deliverableAvailable: false, reviewReady: false, timeline,
    followUp: [], choices: t === 2 ? ['Continue waiting for ASP acceptance', 'Close task'] : [], currentSummary: summary, handledBy, next,
    notice: [3, 4, 5, 13, 17, 18].includes(t) ? 'To rate this task, reply "Rate job".' : undefined,
  };
}
function subscriptionAuthoritativeStatus(status) {
  const s = Number(status);
  return [-1, 0, 1, 3, 4, 6, 7, 8, 9].includes(s) ? SubStatus.asStr(SubStatus.fromCode(s)) : `unknown_${status}`;
}

// upstream: lifecycle.rs::build_subscription_snapshot_with_user_close (plain object; see subSnapshotStruct)
export function buildSubscriptionSnapshotWithUserClose(jobId, detail, events, historyReadSucceeded, userCloseSubmitted) {
  const status = detailI64(detail, ['status', 'subStatus']);
  const trialType = detailI64(detail, ['trialType']);
  const autoRenew = detailI64(detail, ['autoRenew']);
  const periodIndex = detailI64(detail, ['periodIndex']);
  const m = subscriptionMilestones(detail, events);
  const ctx = PreFetchedTaskContext.fromApiResponse(detail);
  ctx.jobType = 1; ctx.status = nz(status); ctx.trialType = nz(trialType);
  const refundProven = !numEq(trialType, 1) && (authoritativeRefundSettlementConfirmed(ctx, 9)
    || (m.refundedAt !== null && detailString(detail, ['refundTxHash', 'refundTransactionHash']) !== undefined));
  const inGrace = numEq(status, 1) && numEq(autoRenew, 1) && timestampHasPassed(m.currentPeriodEndsAt) && timestampIsFuture(m.gracePeriodEndsAt);
  const phase = subscriptionPhase(status, trialType, inGrace, refundProven);
  const t = subscriptionTemplateNumber(status, trialType, autoRenew, inGrace, refundProven, m, events, userCloseSubmitted);
  if (m.acceptedAt === null && ['free_trial', 'active_subscription', 'renewal_grace_period', 'awaiting_asp_decision', 'disputed', 'completed', 'closed', 'refunded', 'failed'].includes(phase)) {
    m.acceptedAt = subEventTime(events, ['subscription_created', 'subscription_asp_selected']);
  }
  const closePending = numEq(status, 0) && userCloseSubmitted;
  const [label, party, next] = closePending
    ? ['Subscription closure submitted', 'platform', 'Wait for the subscription lifecycle and wallet order to confirm the closure.']
    : [subscriptionStatusLabel(t, phase, autoRenew), subscriptionResponsibleParty(t, phase), subscriptionNextAction(t, phase, autoRenew, detail, m, events)];
  const historyAvailable = events.length > 0;
  const d = buildSubscriptionDisplay(phase, t, label, party, next);
  if (closePending) { d.choices = []; d.notice = 'The close request is already submitted. Do not submit another close request while reconciliation is pending.'; }
  const jid = detailString(detail, ['jobId']);
  return {
    jobId: jid !== undefined && jid === jobId ? jid : jobId, taskType: 'subscription', phase, statusLabel: label, responsibleParty: party, nextAction: next,
    confidence: status === undefined ? 'unknown' : historyAvailable ? 'confirmed' : 'partial',
    authoritativeStatus: status === undefined ? 'unavailable' : subscriptionAuthoritativeStatus(status), statusSource: 'subscription_detail',
    historyAvailable, historyReadSucceeded, historyEventCount: events.length, aspAgentId: nz(detailString(detail, ['providerAgentId', 'aspAgentId'])),
    reviewDeadlineAt: nz(detailString(detail, ['rejectWindowEndsAt', 'responseDeadline', 'reviewDeadlineAt'])), trialType: nz(trialType), autoRenew: nz(autoRenew),
    periodIndex: nz(periodIndex), refundAmount: nz(detailString(detail, ['refundAmount', 'paymentTokenAmount'])),
    refundTokenSymbol: nz(detailString(detail, ['refundTokenSymbol', 'paymentTokenSymbol', 'tokenSymbol'])),
    refundTxHash: nz(detailString(detail, ['refundTxHash', 'refundTransactionHash'])), milestones: m, events, display: display(d), syncedAt: utcNowRfc3339(),
  };
}

// upstream: lifecycle.rs::subscription_status_copy → [statusLabel, currentSummary]
export function subscriptionStatusCopy(detail, userCloseSubmitted) {
  const jobId = detailString(detail, ['jobId', 'subId']) ?? '';
  const s = buildSubscriptionSnapshotWithUserClose(jobId, detail, [], true, userCloseSubmitted);
  return [s.statusLabel, s.display.currentSummary];
}

const subscriptionDetailMatchesJob = (detail, jobId) => detailString(detail, ['jobId']) === jobId;

// ─── local SQLite history (read-only) ───
function fixedCommandStorePath() {
  let home;
  try { home = homedir(); } catch { return undefined; }
  if (!home) return undefined;
  const root = join(home, '.okx-agent-task');
  return [root, join(root, 'sqlite', 'command-store.sqlite')];
}
function validatedDatabasePath(root, database) {
  for (const p of [root, join(root, 'sqlite'), database]) {
    try { if (lstatSync(p).isSymbolicLink()) return undefined; } catch { return undefined; }
  }
  try { if (!statSync(database).isFile()) return undefined; } catch { return undefined; }
  let cr, cd;
  try { cr = realpathSync.native(root); cd = realpathSync.native(database); } catch { return undefined; }
  const prefix = cr.endsWith(sep) ? cr : cr + sep;
  return cd === cr || cd.startsWith(prefix) ? cd : undefined;
}
async function openSqlite(path) {
  const origEmit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path, { readOnly: true, timeout: 100 });
  } finally { process.emitWarning = origEmit; }
}
function localRowBelongsToUser(command, content, expected) {
  const clientId = scalarString(get(command, 'clientAgentId') ?? null) ?? (content ? scalarString(get(content, 'clientAgentId') ?? null) : undefined);
  if (clientId !== undefined) return clientId === expected;
  const agentId = scalarString(get(command, 'agentId') ?? null) ?? (content ? scalarString(get(content, 'agentId') ?? null) : undefined);
  return agentId === expected;
}
// upstream: lifecycle.rs::read_scoped_local_history → { messages, readSucceeded }
export async function readScopedLocalHistory(jobId, userAgentId) {
  const none = { messages: [], readSucceeded: false };
  if (!safeLookupKey(jobId) || !safeLookupKey(userAgentId)) return none;
  const paths = fixedCommandStorePath();
  if (!paths) return none;
  const db = validatedDatabasePath(paths[0], paths[1]);
  if (!db) return none;
  let conn, rows;
  try {
    conn = await openSqlite(db);
    const stmt = conn.prepare("SELECT id, command_json, created_at_ms FROM command_queue WHERE type = 'ai-dispatch' AND length(command_json) <= ?3 AND instr(command_json, ?1) > 0 ORDER BY created_at_ms ASC LIMIT ?2");
    rows = stmt.all(jobId, MAX_LOCAL_ROWS, MAX_COMMAND_JSON_BYTES);
  } catch { try { conn?.close(); } catch {} return none; }
  try { conn.close(); } catch {}
  const messages = [];
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.command_json !== 'string') continue;
    let command;
    try { command = parseJson(row.command_json); } catch { continue; }
    const content = get(command, 'content') ?? null;
    const decoded = decodeObject(content);
    if (!localRowBelongsToUser(command, decoded, userAgentId)) continue;
    const env = (decoded ? systemEventEnvelope(decoded) : undefined) ?? systemEventEnvelope(content);
    if (!env) continue;
    if (firstScalar(env, ['jobId']) !== jobId) continue;
    const id = scalarString(get(command, 'messageId') ?? null) ?? row.id;
    const createdMs = row.created_at_ms === null || row.created_at_ms === undefined ? undefined : String(row.created_at_ms);
    messages.push({ id, senderInboxId: null, content, sentAt: nz(scalarString(get(command, 'createdAt') ?? null) ?? createdMs), deliveryStatus: 'local' });
  }
  return { messages, readSucceeded: true };
}

// ─── CLI ───
function selectCurrentWalletUserAgent(agents, requestedRaw) {
  const requested = trim(requestedRaw ?? '');
  const has = (list, expected) => list.some((a) => {
    const idv = get(a, 'agentId');
    const idOk = idv !== undefined && scalarString(idv) === expected;
    const role = get(a, 'role');
    const roleOk = role !== undefined && ((scalarI64(role) !== undefined && Number(scalarI64(role)) === AGENT_ROLE_USER) || (typeof role === 'string' && eqIgnoreAsciiCase(role, 'user')));
    return idOk && roleOk;
  });
  if (requested !== '') return has(agents, requested) ? requested : undefined;
  for (const a of agents) {
    const idv = get(a, 'agentId');
    const id = idv === undefined ? undefined : scalarString(idv);
    if (id !== undefined && has([a], id)) return id;
  }
  return undefined;
}

// upstream: lifecycle.rs::handle_lifecycle → snapshot struct (success data)
export async function handleLifecycle(client, jobId, agentId) {
  const { fetchTaskDetail } = await import('./query.mjs');
  const walletAgents = await fetchMyAgentsByRole('user');
  const resolved = selectCurrentWalletUserAgent(walletAgents, agentId);
  if (resolved === undefined) return snapshotStruct(unavailableSnapshot(jobId, 'Current wallet identity could not be confirmed, so local task history was not read.'));
  let detail;
  try { detail = await fetchTaskDetail(client, jobId, resolved); } catch {
    const local = await readScopedLocalHistory(jobId, resolved);
    const events = eventsFromHistory(jobId, local.messages);
    let sub;
    try { sub = await fetchSubscribeDetailForAgent(client, jobId, resolved); } catch { sub = undefined; }
    if (sub !== undefined && subscriptionDetailMatchesJob(sub, jobId)) {
      return subSnapshotStruct(buildSubscriptionSnapshotWithUserClose(jobId, sub, events, local.readSucceeded, hasCreatedSubscriptionCloseReceipt(jobId, resolved)));
    }
    const s = snapshotFromLocalFallback(jobId, local);
    s.display = withNotice(s.display, s.historyAvailable ? 'Latest task details are unavailable; showing the latest verified local task record.'
      : 'Task details and verified local history are unavailable. Try again later.');
    return snapshotStruct(s);
  }
  const projected = {
    jobType: get(detail, 'jobType') === undefined ? undefined : parseJobType(get(detail, 'jobType')),
    status: (() => { const v = get(detail, 'status'); const n = v === undefined ? undefined : scalarI32(v); return n === undefined ? undefined : Status.fromInt(n); })(),
    providerAgentId: detailString(detail, ['providerAgentId']) ?? detailString(detail, ['aspAgentId']),
    tokenAmount: detailString(detail, ['refundAmount', 'paymentTokenAmount', 'tokenAmount']),
    tokenSymbol: detailString(detail, ['refundTokenSymbol', 'paymentTokenSymbol', 'tokenSymbol']),
  };
  const local = await readScopedLocalHistory(jobId, resolved);
  const messages = [...local.messages];
  let historyReadSucceeded = local.readSucceeded;
  if (projected.providerAgentId !== undefined) {
    try {
      const raw = await sessionHistory(jobId, projected.providerAgentId);
      try { messages.push(...parseHistory(raw)); historyReadSucceeded = true; } catch {}
    } catch {}
  }
  const events = eventsFromHistory(jobId, messages);
  if (projected.jobType === 1) {
    let sub;
    try { sub = await fetchSubscribeDetailForAgent(client, jobId, resolved); } catch { sub = undefined; }
    if (sub === undefined || !subscriptionDetailMatchesJob(sub, jobId)) {
      const s = unavailableSnapshot(jobId, 'The subscription type was confirmed, but its latest subscription detail is unavailable. Try again later.');
      s.taskType = 'subscription';
      s.aspAgentId = nz(projected.providerAgentId);
      return snapshotStruct(s);
    }
    return subSnapshotStruct(buildSubscriptionSnapshotWithUserClose(jobId, sub, events, historyReadSucceeded, hasCreatedSubscriptionCloseReceipt(jobId, resolved)));
  }
  let localJobType, localStatus;
  for (let i = events.length - 1; i >= 0; i--) if (localJobType === undefined && events[i].jobType !== null) localJobType = events[i].jobType;
  for (let i = events.length - 1; i >= 0; i--) { const s = statusFromEvent(events[i]); if (s !== undefined) { localStatus = s; break; } }
  const reconciled = { jobType: projected.jobType ?? localJobType, status: projected.status ?? localStatus, statusFromLocal: projected.status === undefined && localStatus !== undefined };
  if (reconciled.jobType === undefined || reconciled.jobType === 1) {
    let sub;
    try { sub = await fetchSubscribeDetailForAgent(client, jobId, resolved); } catch { sub = undefined; }
    if (sub !== undefined && subscriptionDetailMatchesJob(sub, jobId)) {
      return subSnapshotStruct(buildSubscriptionSnapshotWithUserClose(jobId, sub, events, historyReadSucceeded, hasCreatedSubscriptionCloseReceipt(jobId, resolved)));
    }
  }
  if (reconciled.jobType !== 0) {
    const s = unavailableSnapshot(jobId, 'The task type could not be confirmed as a one-time task.');
    s.taskType = reconciled.jobType === 1 ? 'subscription' : reconciled.jobType !== undefined ? 'unsupported' : 'unknown';
    s.aspAgentId = nz(projected.providerAgentId);
    return snapshotStruct(s);
  }
  if (reconciled.status === undefined) {
    const s = unavailableSnapshot(jobId, 'The latest task details do not include a usable current status.');
    s.taskType = 'one_time';
    s.aspAgentId = nz(projected.providerAgentId);
    return snapshotStruct(s);
  }
  const s = buildSnapshotWithHistoryState(jobId, reconciled.status, messages, historyReadSucceeded);
  if (reconciled.statusFromLocal) { s.statusSource = 'local_official_event'; s.confidence = 'partial'; }
  s.aspAgentId = nz(projected.providerAgentId);
  mergeDetailMilestones(s.milestones, detail);
  const rd = reviewDeadline(detail, s.events, s.milestones);
  s.reviewDeadlineAt = rd === undefined ? null : String(rd);
  s.display = buildDisplay(s.phase, s.milestones, s.reviewDeadlineAt, projected.tokenAmount, projected.tokenSymbol, s.events, localUserDeliverableExists(jobId),
    s.historyAvailable ? undefined : 'Some historical times are unavailable; the current stage comes from the latest task details.');
  return snapshotStruct(s);
}

export { snapshotStruct, subSnapshotStruct, existsSync as _existsSync };
