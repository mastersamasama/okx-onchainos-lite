// Structured ASP job-notification playbooks — upstream task/asp/v2/notification.rs.
// Every builder returns a compact JSON string (serde_json `json!` → sorted keys).
import { stringify } from '../../../../core/json.mjs';
import { get, asStr, asI64, isNum, numText, trim, parseI64 } from '../../../_rs.mjs';
import { TERMINAL_NOTIFICATION_MARKER } from '../../common/index.mjs';
import * as content from '../content.mjs';

const has = (v) => v !== undefined && v !== null;
const is = (v, n) => has(v) && Number(v) === n;

// upstream: notification.rs::display_field — non-empty string or number text
export function displayField(message, key) {
  const v = has(message) ? get(message, key) : undefined;
  if (typeof v === 'string') return v !== '' ? v : undefined;
  if (isNum(v)) return numText(v);
  return undefined;
}

// upstream: notification.rs::display_i64 — i64 or `str.parse::<i64>()`
export function displayI64(message, key) {
  const v = has(message) ? get(message, key) : undefined;
  if (v === undefined) return undefined;
  const i = asI64(v);
  if (i !== undefined) return i;
  const s = asStr(v);
  return s === undefined ? undefined : parseI64(s);
}

const jobName = (message) => displayField(message, 'jobTitle') ?? displayField(message, 'jobName') ?? 'job';
const tokenAmount = (message) => displayField(message, 'tokenAmount') ?? '0';
const tokenSymbol = (message) => displayField(message, 'tokenSymbol') ?? '';

// upstream: notification.rs::payment_is_paid → true | false | undefined (malformed amount)
export function paymentIsPaid(amount) {
  const a = trim(amount);
  const parts = a.split('.');
  const whole = parts[0];
  const valid = parts.length <= 2 && whole !== '' && /^[0-9]+$/.test(whole) && (parts.length === 1 || (parts[1] !== '' && /^[0-9]+$/.test(parts[1])));
  return valid ? /[^0.]/.test(a) : undefined;
}

// upstream: notification.rs::authoritative_field — trimmed, non-empty and not "?"
export function authoritativeField(value) {
  if (!has(value)) return undefined;
  const v = trim(value);
  return v !== '' && v !== '?' ? v : undefined;
}

// upstream: notification.rs::authoritative_task_kind — false one-time, true subscription
function authoritativeTaskKind(task) {
  if (is(task.jobType, 0)) return false;
  if (is(task.jobType, 1)) return true;
  return undefined;
}

// upstream: notification.rs::service_name
function serviceName(task, message) {
  return authoritativeField(task.serviceName) ?? displayField(message, 'serviceName') ?? authoritativeField(task.title) ?? 'Service unavailable';
}

// upstream: notification.rs::notification_result
export function notificationResult(jobId, event, notification) {
  return stringify({
    phase: 'notification', decision: 'ready', reason: 'notification_required',
    nextAction: [{ id: 'notify_user', recommend: true, params: { jobId, event } }],
    payload: { role: 'asp', event, jobId, notification: { content: notification, localize: true }, rating: { required: false } },
  });
}

function terminalNotificationValue(jobId, event, notification) {
  return {
    phase: 'notification', decision: 'ready', reason: 'notification_required',
    nextAction: [{ id: 'notify_and_cleanup_subscription', recommend: true, params: { jobId } }],
    payload: { role: 'asp', event, jobId, notification: { content: notification, localize: true }, rating: { required: false }, cleanup: { jobId } },
  };
}

// upstream: notification.rs::terminal_notification_result
export const terminalNotificationResult = (jobId, event, notification) => stringify(terminalNotificationValue(jobId, event, notification));

// upstream: notification.rs::free_job_rejected_failed
export function freeJobRejectedFailed(jobId, task, message) {
  const name = serviceName(task, message);
  const rejectionReason = authoritativeField(task.refundReason) ?? displayField(message, 'reason') ?? displayField(message, 'rejectReason')
    ?? displayField(message, 'refundReason') ?? 'Not provided';
  const notification = `${TERMINAL_NOTIFICATION_MARKER} [Job Failed] Job ${jobId} (${name}) — the buyer rejected the deliverable.\n`
    + `- Status: Failed\n- Rejection reason: ${rejectionReason}\n\n`
    + 'This free one-time task has ended. No refund or platform evaluation is required.';
  const result = terminalNotificationValue(jobId, 'job_rejected', notification);
  result.payload.statusLabel = 'Failed';
  result.payload.statusDescription = 'The buyer rejected the free task deliverable; the task is terminal.';
  return stringify(result);
}

// upstream: notification.rs::authoritative_context_required
export function authoritativeContextRequired(jobId, event, missingFields) {
  return stringify({
    phase: 'notification', decision: 'blocked', reason: 'authoritative_task_context_required', nextAction: [],
    payload: { role: 'asp', event, jobId, error: { code: 'authoritative_task_context_required', missingFields: [...missingFields] }, rating: { required: false } },
  });
}

// upstream: notification.rs::job_asp_accept_expire
export function jobAspAcceptExpire(jobId, task, message) {
  const ev = 'job_asp_accept_expire';
  if (!is(task.status, 8)) return authoritativeContextRequired(jobId, ev, ['status']);
  const name = serviceName(task, message);
  const isSubscription = authoritativeTaskKind(task);
  if (isSubscription === undefined) return authoritativeContextRequired(jobId, ev, ['jobType']);
  let isTrial = false;
  if (isSubscription) {
    if (is(task.trialType, 0)) isTrial = false;
    else if (is(task.trialType, 1)) isTrial = true;
    else return authoritativeContextRequired(jobId, ev, ['trialType']);
  }
  const amount = authoritativeField(task.tokenAmount) ?? '';
  let paid = false;
  if (!isTrial) {
    const p = paymentIsPaid(amount);
    if (p === undefined) return authoritativeContextRequired(jobId, ev, ['tokenAmount']);
    paid = p;
  }
  const symbol = authoritativeField(task.tokenSymbol) ?? 'payment token';
  const notification = isSubscription
    ? content.subscriptionJobAspAcceptExpireAspNotify(name, jobId, amount, symbol, isTrial, paid)
    : content.regularJobAspAcceptExpireAspNotify(name, jobId);
  return terminalNotificationResult(jobId, ev, notification);
}

// upstream: notification.rs::job_delivery_expired
export function jobDeliveryExpired(jobId, task, event) {
  if (!is(task.status, 8)) return authoritativeContextRequired(jobId, event, ['status']);
  const name = authoritativeField(task.title) ?? 'Task title unavailable';
  const isSubscription = authoritativeTaskKind(task);
  if (isSubscription === undefined) return authoritativeContextRequired(jobId, event, ['jobType']);
  let taskType = 'One-time task (0)', isTrial = false;
  if (isSubscription) {
    taskType = 'Subscription (1)';
    if (is(task.trialType, 0)) isTrial = false;
    else if (is(task.trialType, 1)) isTrial = true;
    else return authoritativeContextRequired(jobId, event, ['trialType']);
  }
  const amount = authoritativeField(task.tokenAmount) ?? '';
  let paid = false;
  if (!isTrial) {
    const p = paymentIsPaid(amount);
    if (p === undefined) return authoritativeContextRequired(jobId, event, ['tokenAmount']);
    paid = p;
  }
  const symbol = authoritativeField(task.tokenSymbol) ?? 'payment token';
  return terminalNotificationResult(jobId, event, content.jobDeliveryExpireAspNotify(name, jobId, taskType, amount, symbol, isTrial, paid));
}

// upstream: notification.rs::job_asp_reject_closed
export function jobAspRejectClosed(jobId, task, message) {
  const ev = 'job_asp_reject_closed';
  const name = serviceName(task, message);
  const isSubscription = authoritativeTaskKind(task);
  if (isSubscription === undefined) return authoritativeContextRequired(jobId, ev, ['jobType']);
  const reason = displayField(message, 'aspRejectReason') ?? displayField(message, 'reason') ?? 'No reason provided';
  const notification = isSubscription
    ? content.subscriptionJobAspRejectClosedAspNotify(name, jobId, reason)
    : content.regularJobAspRejectClosedAspNotify(name, jobId, reason);
  return notificationResult(jobId, ev, notification);
}

// upstream: notification.rs::job_asp_reject_expire
export function jobAspRejectExpire(jobId, task, message) {
  const ev = 'job_asp_reject_expire';
  if (!is(task.status, 9)) return authoritativeContextRequired(jobId, ev, ['status']);
  const name = serviceName(task, message);
  const isSubscription = authoritativeTaskKind(task);
  if (isSubscription === undefined) return authoritativeContextRequired(jobId, ev, ['jobType']);
  const amount = authoritativeField(task.tokenAmount);
  if (amount === undefined) return authoritativeContextRequired(jobId, ev, ['tokenAmount']);
  const paid = paymentIsPaid(amount) ?? false;
  const symbol = authoritativeField(task.tokenSymbol) ?? '';
  if ((isSubscription || paid) && symbol === '') return authoritativeContextRequired(jobId, ev, ['tokenSymbol']);
  const deadline = displayI64(message, 'rejectWindowEndsAt');
  const notification = isSubscription
    ? content.subscriptionJobAspRejectExpireAspNotify(name, jobId, amount, symbol, deadline)
    : content.regularJobAspRejectExpireAspNotify(name, jobId, amount, symbol, deadline, paid);
  return notificationResult(jobId, ev, notification);
}

// upstream: notification.rs::sub_asp_claim_notify
export function subAspClaimNotify(jobId, message) {
  const txHash = displayField(message, 'txHash') ?? 'Not provided';
  const notification = content.subAspClaimNotifyAspNotify(jobName(message), jobId, tokenAmount(message), tokenSymbol(message), txHash);
  return notificationResult(jobId, 'sub_asp_claim_notify', notification);
}
