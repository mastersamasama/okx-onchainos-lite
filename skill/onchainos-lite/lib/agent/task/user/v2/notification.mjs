// User-side notification results — upstream task/user/v2/notification.rs. Only
// `sub_asp_claim_notify` is reachable (the job_asp_* builders have no caller upstream; the ASP
// flow uses task/asp/v2/notification.rs) — they are ported for completeness.
import { get, asStr, asI64, isNumber, numText } from '../../../../core/rs/value.mjs';
import { parseI64 } from '../../../../core/rs/num.mjs';
import { trim } from '../../../../core/rs/str.mjs';
import { content } from '../flow-lifecycle/_peers.mjs';

// upstream: notification.rs::display_field
function displayField(message, key) {
  const v = get(message, key);
  if (typeof v === 'string') return v !== '' ? v : undefined;
  return isNumber(v) ? numText(v) : undefined;
}
const jobName = (m) => displayField(m, 'serviceName') ?? displayField(m, 'jobTitle') ?? displayField(m, 'jobName') ?? 'job';
const i64Field = (m, k) => { const v = get(m, k); return v === undefined ? undefined : asI64(v) ?? (asStr(v) === undefined ? undefined : parseI64(asStr(v))); };
const tokenAmount = (m) => displayField(m, 'tokenAmount') ?? '0';
const isSubscription = (m) => displayField(m, 'jobType') === '1';
// upstream: notification.rs::is_paid — `str::parse::<f64>` of the trimmed amount, finite and > 0.
function isPaid(amount) {
  const t = trim(amount);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && !/^[+-]?(inf|infinity|nan)$/i.test(t)) return false;
  const v = Number(t.replace(/^\+/, ''));
  return Number.isFinite(v) && v > 0;
}
const providerName = (m) => displayField(m, 'providerName') ?? 'ASP';
const providerAgentId = (m) => displayField(m, 'providerAgentId') ?? 'unknown';
const reason = (m) => displayField(m, 'aspRejectReason') ?? displayField(m, 'reason') ?? 'No reason provided';

// upstream: notification.rs::notification_result
const notificationResult = (jobId, event, notification) => ({
  phase: 'notification', decision: 'ready', reason: 'notification_required',
  nextAction: [{ id: 'notify_user', recommend: true, params: { jobId, event } }],
  payload: { role: 'user', event, jobId, notification: { content: notification, localize: true }, rating: { required: false } },
});

// upstream: notification.rs::job_asp_accept_expire
export async function jobAspAcceptExpire(jobId, message) {
  const c = await content();
  const amount = tokenAmount(message), symbol = displayField(message, 'tokenSymbol') ?? '';
  const n = isSubscription(message)
    ? c.subscriptionJobAspAcceptExpireUserNotify(jobName(message), jobId, amount, symbol, providerName(message), providerAgentId(message), i64Field(message, 'trialType') === 1)
    : c.regularJobAspAcceptExpireUserNotify(jobName(message), jobId, amount, symbol, providerName(message), providerAgentId(message), isPaid(amount));
  return notificationResult(jobId, 'job_asp_accept_expire', n);
}

// upstream: notification.rs::job_asp_reject_closed
export async function jobAspRejectClosed(jobId, message) {
  const c = await content();
  const amount = tokenAmount(message), symbol = displayField(message, 'tokenSymbol') ?? '';
  const n = isSubscription(message)
    ? c.subscriptionJobAspRejectClosedUserNotify(jobName(message), jobId, amount, symbol, providerName(message), providerAgentId(message), reason(message), i64Field(message, 'trialType') === 1)
    : c.regularJobAspRejectClosedUserNotify(jobName(message), jobId, amount, symbol, providerName(message), providerAgentId(message), reason(message), isPaid(amount));
  return notificationResult(jobId, 'job_asp_reject_closed', n);
}

// upstream: notification.rs::job_asp_reject_expire
export async function jobAspRejectExpire(jobId, message) {
  const c = await content();
  const amount = tokenAmount(message), symbol = displayField(message, 'tokenSymbol') ?? '';
  const n = isSubscription(message)
    ? c.subscriptionJobAspRejectExpireUserNotify(jobName(message), jobId, amount, symbol, i64Field(message, 'rejectWindowEndsAt'))
    : c.regularJobAspRejectExpireUserNotify(jobName(message), jobId, amount, symbol, i64Field(message, 'rejectWindowEndsAt'), isPaid(amount));
  return notificationResult(jobId, 'job_asp_reject_expire', n);
}

// upstream: notification.rs::sub_asp_claim_notify
export const subAspClaimNotify = (jobId) => ({
  phase: 'notification', decision: 'ready', reason: 'notification_not_required', nextAction: [{ id: 'stop' }],
  payload: { role: 'user', event: 'sub_asp_claim_notify', jobId },
});
