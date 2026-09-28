// Review rejection — upstream task/user/v2/reject.rs. `try_handle_free_review` is reached from
// next-action `reject_review`; `handle` / `validate_rejection_reason` have no reachable caller
// upstream (the CLI `reject` command is disabled) but are ported for completeness.
import { auditLog } from '../../../../core/audit.mjs';
import { get, asStr, asI64, asU64, trim, charCount, parseI64, debugOptInt } from '../../../_rs.mjs';
import * as signing from '../../signing.mjs';
import { shortJobId } from '../../common/util.mjs';
import { isZeroDecimal } from '../refund.mjs';
import { resolveUserAgent } from '../flow-lifecycle/_peers.mjs';

const MAX_REASON_CHARS = 2000;
const JOB_TYPE_SUBSCRIBE = 1;

// upstream: reject.rs::validate_rejection_reason → trimmed reason
export function validateRejectionReason(reason) {
  const r = trim(reason);
  if (r === '') throw new Error('--reason is required for reject');
  if (charCount(r) > MAX_REASON_CHARS) throw new Error(`Reject reason exceeds ${MAX_REASON_CHARS} characters`);
  return r;
}

// upstream: reject.rs::scalar_i64 (no trim)
const scalarI64 = (v) => (v === undefined ? undefined : asI64(v) ?? (asStr(v) === undefined ? undefined : parseI64(asStr(v))));
// upstream: reject.rs::scalar_string (no trim / no empty filter)
function scalarString(v) {
  if (v === undefined) return undefined;
  const s = asStr(v);
  if (s !== undefined) return s;
  const i = asI64(v);
  if (i !== undefined) return String(i);
  const u = asU64(v);
  return u === undefined ? undefined : String(u);
}

// upstream: reject.rs::is_free_one_time
function isFreeOneTime(task) {
  if (scalarI64(get(task, 'jobType')) !== 0) return false;
  const primary = get(task, 'paymentTokenAmount');   // Value::get: a present `null` does not fall back
  const amount = scalarString(primary !== undefined ? primary : get(task, 'tokenAmount'));
  return amount !== undefined && isZeroDecimal(amount);
}

// upstream: reject.rs::free_rejection_submitted_result (json! → sorted)
export const freeRejectionSubmittedResult = (jobId, txHash) => ({
  phase: 'deliverable_review', decision: 'ready', reason: 'free_rejection_submitted', nextAction: [{ id: 'stop' }],
  payload: { jobId, txHash, expectedStatus: 'failed', expectedRawStatus: 9 },
});
// upstream: reject.rs::submitted_result
export const submittedResult = (jobId, txHash) => ({
  phase: 'deliverable_review', decision: 'ready', reason: 'rejection_submitted', nextAction: [{ id: 'stop' }], payload: { jobId, txHash },
});
// upstream: reject.rs::reason_required_result
export const reasonRequiredResult = (jobId, agentId, shortId) => ({
  phase: 'deliverable_review', decision: 'requires_user_input', reason: 'rejection_reason_required',
  nextAction: [{ id: 'request_rejection_reason', recommend: true, params: { jobId, agentId, shortJobId: shortId } }],
  payload: { requiredParams: ['reason'] },
});

async function dualReject(client, jobId, reason) {
  const [accountId, address, agentId] = await signing.resolveWalletAndAgentForTask(client, jobId, null);
  const result = await signing.taskDualSignAndBroadcast(client, jobId, 'pre-reject', 'reject', undefined, accountId, address, agentId, { reason });
  return [agentId, result];
}

// upstream: reject.rs::handle (unreachable upstream)
export async function handle(client, jobId, reasonRaw) {
  const reason = validateRejectionReason(reasonRaw);
  const [localAgentId] = await resolveUserAgent();
  const task = await client.getWithIdentity(client.taskPath(jobId), localAgentId);
  const jobType = scalarI64(get(task, 'jobType')) ?? 0;
  let txHash;
  if (Number(jobType) === JOB_TYPE_SUBSCRIBE) {
    const { handleSubscribeRejectInner } = await import('../subscription-ops.mjs');
    txHash = await handleSubscribeRejectInner(client, jobId, reason, localAgentId);
  } else {
    const [agentId, result] = await dualReject(client, jobId, reason);
    auditLog('cli', 'user/reject_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `reasonLen=${charCount(reason)}`, `txHash=${result.txHash}`]);
    txHash = result.txHash;
  }
  return submittedResult(jobId, txHash);
}

// upstream: reject.rs::try_handle_free_review → result | undefined (None: not a free one-time review)
export async function tryHandleFreeReview(client, jobId, reason) {
  const [localAgentId] = await resolveUserAgent();
  const task = await client.getWithIdentity(client.taskPath(jobId), localAgentId);
  if (!isFreeOneTime(task)) return undefined;
  const status = scalarI64(get(task, 'status'));
  if (status !== 2) throw new Error(`free review rejection requires Submitted(2), current status is ${debugOptInt(status)}`);
  const r = reason === undefined || reason === null ? '' : trim(reason);
  if (r === '') return reasonRequiredResult(jobId, localAgentId, shortJobId(jobId));
  if (charCount(r) > MAX_REASON_CHARS) throw new Error(`Reject reason exceeds ${MAX_REASON_CHARS} characters`);
  const [agentId, result] = await dualReject(client, jobId, r);
  auditLog('cli', 'user/free_reject_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `reasonLen=${charCount(r)}`, `txHash=${result.txHash}`]);
  return freeRejectionSubmittedResult(jobId, result.txHash);
}
