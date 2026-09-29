// Display-ready refund lists / detail for buyer and provider — upstream task/refund_list.rs.
// The per-task Refund V2 composition comes from user/refund.rs.
import { get, asStr, asI64 } from '../../core/rs/value.mjs';
import { trim } from '../../core/rs/str.mjs';
import { AGENT_ROLE_USER, AGENT_ROLE_ASP } from './common/index.mjs';
import { resolveAgentIdOrError } from './common/query.mjs';
import { formatLocalTimestampWithOffset } from './common/deadline.mjs';
import { getDisputeStatus } from './evaluator/dispute-status.mjs';
import { fetchRefundListItemForIdentity } from './user/refund.mjs';
import { fetchMySubscriptionsSnapshotForAgentReadOnly } from './user/subscription-ops.mjs';

// upstream: refund_list.rs::RefundListRole / RefundListScope ('buyer'|'provider', 'available'|'requested')
const agentRole = (role) => (role === 'buyer' ? AGENT_ROLE_USER : AGENT_ROLE_ASP);
const subscriptionRole = (role) => (role === 'buyer' ? 'Buyer' : 'Provider');
const oneTimeStatus = (scope) => (scope === 'available' ? 'submitted' : 'rejected');
const subscriptionStatus = (scope) => (scope === 'available' ? 1 : 3);

function integerFromKey(row, key) {
  const v = get(row, key);
  if (v === undefined) return undefined;
  const i = asI64(v);
  if (i !== undefined) return i;
  const s = asStr(v);
  if (s === undefined) return undefined;
  const t = trim(s);
  if (!/^[+-]?[0-9]+$/.test(t)) return undefined;
  const b = BigInt(t);
  return b >= -9223372036854775808n && b <= 9223372036854775807n ? (Number.isSafeInteger(Number(b)) ? Number(b) : b) : undefined;
}

// upstream: refund_list.rs::collect_candidates → [{ jobId, responseDeadline }]
export function collectCandidates(oneTime, subscriptions) {
  const seen = new Set(), out = [];
  const rows = [...(Array.isArray(get(oneTime, 'list')) ? get(oneTime, 'list') : []), ...(Array.isArray(get(subscriptions, 'list')) ? get(subscriptions, 'list') : [])];
  for (const row of rows) {
    const s = asStr(get(row, 'jobId'));
    if (s === undefined) continue;
    const jobId = trim(s);
    if (jobId === '' || seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ jobId, responseDeadline: integerFromKey(row, 'rejectDeadline') });
  }
  return out;
}

// upstream: refund_list.rs::handle_refund_list → success data
export async function handleRefundList(client, role, scope, page, pageSize, agentIdRaw) {
  if (role === 'provider' && scope !== 'requested') throw new Error('provider refund-list supports only --scope requested');
  const agentId = await resolveAgentIdOrError(agentIdRaw, agentRole(role));
  const oneTime = await client.getWithIdentity(`/priapi/v1/aieco/task/my?page=${page}&page_size=${pageSize}&status=${oneTimeStatus(scope)}`, agentId);
  const subscriptions = (await fetchMySubscriptionsSnapshotForAgentReadOnly(client, subscriptionRole(role), subscriptionStatus(scope), agentId)).data;
  const rows = [];
  for (const c of collectCandidates(oneTime, subscriptions)) {
    const item = await fetchRefundListItemForIdentity(client, c.jobId, agentId, role === 'buyer');
    if ((scope === 'available' && !item.refundRequestAvailable) || (scope === 'requested' && Number(item.status) !== 3)) continue;
    const deadline = role === 'provider' && scope === 'requested' ? (c.responseDeadline ?? item.deadline ?? undefined) : (item.deadline ?? undefined);
    const display = item.display;
    if (c.responseDeadline !== undefined) {
      display.responseDeadlineTimestamp = c.responseDeadline;
      display.responseDeadline = formatLocalTimestampWithOffset(c.responseDeadline) ?? null;
    }
    rows.push([display, deadline]);
  }
  if (role === 'provider') {
    const MAX = 9223372036854775807n;
    rows.sort((a, b) => { const x = a[1] === undefined ? MAX : BigInt(a[1]), y = b[1] === undefined ? MAX : BigInt(b[1]); return x < y ? -1 : x > y ? 1 : 0; });
  }
  const items = rows.map(([d]) => d);
  return { role, scope, total: items.length, items };
}

// upstream: refund_list.rs::build_refund_detail_result
export function buildRefundDetailResult(jobId, role, item, terminalEvaluation) {
  const providerDecision = role === 'provider' && Number(item.status) === 3;
  let nextAction = [];
  if (providerDecision) {
    const [refund, evaluation] = Number(item.jobType) === 1 ? ['sub_agree_refund', 'raise_subscription_arbitration'] : ['agree_refund', 'raise_arbitration'];
    nextAction = [{ id: refund, recommend: false, params: { jobId } }, { id: evaluation, recommend: false, params: { jobId } }];
  }
  const display = { ...item.display };
  if (terminalEvaluation) {
    display.evaluationResult = 'asp_won';
    display.evaluationResultLabel = 'ASP won; refund not issued';
    display.evaluationResultDescription = 'The Evaluation concluded in favor of the ASP. The task funds were released to the ASP and no refund was issued.';
    display.evaluationReason = 'The Evaluation service did not return a specific evaluator rationale.';
  }
  return {
    phase: Number(item.status) === 3 ? 'refund_request_detail' : 'refund_status_detail', decision: providerDecision ? 'requires_user_input' : 'ready',
    reason: item.reason, nextAction, payload: { display },
  };
}

// upstream: refund_list.rs::handle_refund_detail → success data
export async function handleRefundDetail(client, jobId, role, agentIdRaw) {
  const agentId = await resolveAgentIdOrError(agentIdRaw, agentRole(role));
  const item = await fetchRefundListItemForIdentity(client, jobId, agentId, role === 'buyer');
  let terminal;
  if (role === 'buyer' && Number(item.status) === 6 && item.refundRequestProvenance) {
    try { const s = await getDisputeStatus(client, jobId, agentId); terminal = Number(s.taskStatus) === 6 ? s : undefined; } catch { terminal = undefined; }
  }
  return buildRefundDetailResult(jobId, role, item, terminal);
}
