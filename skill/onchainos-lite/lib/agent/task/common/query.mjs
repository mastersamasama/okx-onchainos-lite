// Read-only task queries (status / tasks / active-tasks) — upstream task/common/query.rs.
import { get, at, asStr, asI64, asU64, trim } from '../../_rs.mjs';
import { resolveAgentIdByRole } from '../signing.mjs';
import { fetchMyAgents } from './index.mjs';
import { subscriptionStatusCopy } from './lifecycle.mjs';
import { getDisputeStatus } from '../_dispute-status.mjs';

// upstream: query.rs::resolve_agent_id
export async function resolveAgentId(agentId, role) {
  if (agentId !== '') return agentId;
  return resolveAgentIdByRole(role);
}

const wellFormedAgentId = (a) => { const t = trim(asStr(get(a, 'agentId')) ?? ''); return t === '' ? undefined : t; };
function classifyIdentities(agents) {
  const ids = agents.map(wellFormedAgentId).filter((x) => x !== undefined);
  if (ids.length === 0) return agents.length === 1 ? { kind: 'MalformedSingle' } : { kind: 'None' };
  if (ids.length === 1) return { kind: 'One', id: ids[0] };
  return { kind: 'Many' };
}
// upstream: query.rs::role_name
export const roleName = (code) => ({ 1: 'user', 2: 'asp', 3: 'evaluator' })[Number(code)] ?? 'unknown';
function formatAmbiguousIdentities(agents) {
  const c = agents.map((a) => { const id = wellFormedAgentId(a); return id === undefined ? undefined : `[agentId=${id} role=${roleName(asI64(get(a, 'role')) ?? 0)}]`; }).filter((x) => x !== undefined);
  return `This account has ${c.length} identities: ${c.join(', ')}. Pass --agent-id to choose the identity to query.`;
}

// upstream: query.rs::resolve_agent_id_or_error → non-empty agentId (throws otherwise)
export async function resolveAgentIdOrError(explicitAgentId, role) {
  const explicit = trim(explicitAgentId ?? '');
  if (explicit !== '') return explicit;
  const byRole = await resolveAgentIdByRole(role);
  if (trim(byRole) !== '') return trim(byRole);
  const agents = await fetchMyAgents();
  const c = classifyIdentities(agents);
  if (c.kind === 'One') return c.id;
  if (c.kind === 'Many') throw new Error(formatAmbiguousIdentities(agents));
  throw new Error('no agent identity found on this account. Register an identity (route to okx-ai) or pass --agent-id <id> to choose one.');
}

// upstream: query.rs::fetch_task_detail
export const fetchTaskDetail = (client, jobId, agentId) => client.getWithIdentity(client.taskPath(jobId), agentId);

function integerField(value, key) {
  const f = get(value, key);
  if (f === undefined) return undefined;
  const i = asI64(f);
  if (i !== undefined) return i;
  const s = asStr(f);
  if (s === undefined) return undefined;
  const t = trim(s);
  if (!/^[+-]?[0-9]+$/.test(t)) return undefined;
  const b = BigInt(t);
  return b >= -9223372036854775808n && b <= 9223372036854775807n ? (Number.isSafeInteger(Number(b)) ? Number(b) : b) : undefined;
}
function statusCodeForTaskType(jobType, taskDetail, subDetail) {
  if (jobType === 0) return integerField(taskDetail, 'status');
  if (jobType === 1) return subDetail === undefined ? undefined : (integerField(subDetail, 'subStatus') ?? integerField(subDetail, 'status'));
  return undefined;
}

// upstream: query.rs::status_name
export const statusName = (code) => ({ 0: 'created', 1: 'accepted', 2: 'submitted', 3: 'rejected', 4: 'disputed', 5: 'admin_stopped', 6: 'complete', 7: 'close', 8: 'expired', 9: 'failed' })[Number(code)] ?? 'unknown';
// upstream: query.rs::task_status_label
export const taskStatusLabel = (code) => ({ '-1': 'Initializing', 0: 'Awaiting ASP acceptance', 1: 'In progress', 2: 'Awaiting buyer review', 3: 'Awaiting refund decision',
  4: 'Evaluation in progress', 5: 'Stopped by platform', 6: 'Completed', 7: 'Closed', 8: 'Expired', 9: 'Refund completed' })[String(code)] ?? 'Status unavailable';
// upstream: query.rs::task_status_description
export const taskStatusDescription = (code) => ({ '-1': 'The task is being initialized.', 0: 'The task is waiting for an ASP to accept it.',
  1: 'The ASP accepted the task and is working on it.', 2: 'The ASP submitted the deliverable and is waiting for buyer review.',
  3: 'The buyer rejected the deliverable and the refund request awaits an ASP decision.', 4: 'The refund request is in Evaluation.',
  5: 'The platform stopped the task.', 6: 'The task completed and funds were released to the ASP.', 7: 'The task is closed.', 8: 'The task expired.',
  9: 'The refund completed and the task is closed.' })[String(code)] ?? 'The task status is currently unavailable.';
const taskTypeName = (jt) => (jt === 0 ? 'one_time' : jt === 1 ? 'subscription' : 'unknown');
const subscriptionStatusName = (code) => ({ '-1': 'init', 0: 'created', 1: 'active', 3: 'rejected', 4: 'disputed', 6: 'completed', 7: 'closed', 8: 'expired', 9: 'failed' })[String(code)] ?? 'unknown';
const subscriptionStatusLabel = (code) => ({ '-1': 'Initializing', 0: 'Awaiting ASP acceptance', 1: 'Active', 3: 'Awaiting ASP decision', 4: 'Evaluation in progress',
  6: 'Completed', 7: 'Closed', 8: 'Expired', 9: 'Subscription result needs reconciliation' })[String(code)] ?? 'Status unavailable';
const subscriptionStatusDescription = (code) => ({ '-1': 'The subscription is being initialized.', 0: 'The subscription is waiting for an ASP to accept it.',
  1: 'The subscription is active.', 3: "The buyer rejected the current delivery and is waiting for the ASP's decision.",
  4: 'The subscription refund request is in Evaluation.', 6: 'The subscription completed without a refund.', 7: 'The subscription is closed.',
  8: 'The subscription expired.', 9: 'The subscription result requires settlement reconciliation.' })[String(code)] ?? 'The subscription status is currently unavailable.';

// upstream: query.rs::status_copy_for_task_type → [label, description]
export function statusCopyForTaskType(jobType, code, detail, userCloseSubmitted) {
  if (jobType === 0) return [taskStatusLabel(code), taskStatusDescription(code)];
  if (jobType === 1 && (Number(code) === 8 || Number(code) === 9)) return subscriptionStatusCopy(detail, userCloseSubmitted);
  if (jobType === 1) return [subscriptionStatusLabel(code), subscriptionStatusDescription(code)];
  return ['Status unavailable', 'The task type is unknown, so its status cannot be interpreted safely.'];
}

const jt = (v) => (v === undefined ? undefined : Number(v));

// upstream: query.rs::handle_status → { json } (arbitration detail data) | { text } (plain text)
export async function handleStatus(client, jobId, agentId, role) {
  const { buildDetailResult } = await import('../arbitration.mjs');
  const { hasCreatedSubscriptionCloseReceipt } = await import('../_user.mjs');
  const agent = await resolveAgentIdOrError(agentId, role);
  let resp;
  try { resp = await fetchTaskDetail(client, jobId, agent); } catch (taskError) {
    let dispute;
    try { dispute = await getDisputeStatus(client, jobId, agent); } catch { throw taskError; }
    let supplement = {};
    if (dispute.jobType !== null && Number(dispute.jobType) === 1) { try { supplement = await client.fetchSubscription(jobId, agent); } catch { supplement = {}; } }
    return { json: buildDetailResult(jobId, supplement, dispute, undefined, undefined) };
  }
  const jobType = jt(integerField(resp, 'jobType'));
  let sub;
  if (jobType === 1) { try { sub = await client.fetchSubscription(jobId, agent); } catch { sub = undefined; } }
  const code = statusCodeForTaskType(jobType, resp, sub);
  const statusDetail = sub ?? resp;
  let dispute;
  if (code !== undefined && Number(code) === 4) dispute = await getDisputeStatus(client, jobId, agent);
  else if (code !== undefined && (Number(code) === 6 || Number(code) === 9)) { try { dispute = await getDisputeStatus(client, jobId, agent); } catch { dispute = undefined; } }
  if (dispute) return { json: buildDetailResult(jobId, statusDetail, dispute, undefined, undefined) };
  const t = resp;
  const tokenSym = asStr(at(t, 'tokenSymbol')) ?? '?';
  let out = `Task type: ${taskTypeName(jobType)}\n`;
  const userClose = jobType === 1 && await hasCreatedSubscriptionCloseReceipt(jobId, agent);
  const [label, desc] = code !== undefined ? statusCopyForTaskType(jobType, code, statusDetail, userClose) : ['Status unavailable', 'The task status is currently unavailable.'];
  out += `Task status: ${label}\n`;
  out += `Status detail: ${desc}\n`;
  out += `  jobId:    ${jobId}\n`;
  out += `  title:    ${asStr(at(t, 'title')) ?? '?'}\n`;
  out += `  description: ${asStr(at(t, 'description')) ?? '?'}\n`;
  out += `  budget:   ${asStr(at(t, 'tokenAmount')) ?? '?'} ${tokenSym}\n`;
  out += `  user:    ${asStr(at(t, 'buyerAgentId')) ?? '?'}\n`;
  const pid = asStr(at(t, 'providerAgentId'));
  if (pid !== undefined) out += `  asp: ${pid}\n`;
  return { text: out };
}

// upstream: query.rs::handle_list → { json } (arbitration list for --status disputed) | { text }
export async function handleList(client, status, page, limit, agentId, role) {
  const agent = await resolveAgentIdOrError(agentId, role);
  if (status === 'disputed') {
    const { handleArbitrationList } = await import('../arbitration.mjs');
    return { json: await handleArbitrationList(client, agent, page, limit) };
  }
  let path = `/priapi/v1/aieco/task/my?page=${page}&page_size=${limit}`;
  if (status !== undefined && status !== null) path += `&status=${status}`;
  const resp = await client.getWithIdentity(path, agent);
  const tasks = Array.isArray(at(resp, 'list')) ? at(resp, 'list') : [];
  const total = asU64(at(resp, 'total')) ?? 0;
  let out = `Task list (${total} total, page ${page}):\n`;
  for (const t of tasks) {
    const sym = asStr(at(t, 'tokenSymbol')) ?? '?';
    const sc = asI64(at(t, 'status'));
    out += `  [${sc === undefined ? 'Status unavailable' : taskStatusLabel(sc)}] ${asStr(at(t, 'jobId')) ?? '?'} — ${asStr(at(t, 'tokenAmount')) ?? '?'} ${sym}\n`;
    out += `       ${asStr(at(t, 'title')) ?? '?'}\n`;
  }
  return { text: out };
}

const isNonTerminal = (kind, code) => { const c = Number(code); return kind === 'OneTime' ? c >= 0 && c <= 4 : [-1, 0, 1, 3, 4].includes(c); };
// upstream: query.rs::short_job_id (byte-based; <12 bytes as-is)
function shortJobIdBytes(jid) {
  const b = Buffer.from(jid, 'utf8');
  if (b.length < 12) return jid;
  return `${b.subarray(0, 6).toString('utf8')}…${b.subarray(b.length - 4).toString('utf8')}`;
}
const parseRoleArg = (raw) => ({ user: 1, asp: 2, evaluator: 3 })[trim(raw).toLowerCase()];
function ordinaryTaskKind(task) {
  const j = integerField(task, 'jobType');
  if (j === undefined || Number(j) === 0) return 'OneTime';
  return undefined;
}
const stringFieldFromKeys = (v, keys) => { for (const k of keys) { const s = asStr(get(v, k)); if (s !== undefined) return s; } return ''; };
const listItems = (v) => (Array.isArray(get(v, 'list')) ? get(v, 'list') : Array.isArray(v) ? v : []);

async function activeTaskRow(task, kind, agentId, role, includeTerminal) {
  const statusCode = kind === 'OneTime' ? integerField(task, 'status') : (integerField(task, 'subStatus') ?? integerField(task, 'status'));
  if (statusCode === undefined) return undefined;
  if (!includeTerminal && !isNonTerminal(kind, statusCode)) return undefined;
  const jobId = stringFieldFromKeys(task, ['jobId', 'subId']);
  if (jobId === '') return undefined;
  const userId = stringFieldFromKeys(task, ['buyerAgentId', 'userAgentId']);
  const providerId = stringFieldFromKeys(task, ['providerAgentId', 'aspAgentId']);
  const r = Number(role);
  const [cpId, cpRole] = r === 1 ? [providerId, 'asp'] : r === 2 ? [userId, 'user'] : ['', ''];
  let taskType, status, label, desc;
  if (kind === 'OneTime') [taskType, status, label, desc] = ['one_time', statusName(statusCode), taskStatusLabel(statusCode), taskStatusDescription(statusCode)];
  else {
    const { hasCreatedSubscriptionCloseReceipt } = await import('../_user.mjs');
    const userClose = await hasCreatedSubscriptionCloseReceipt(jobId, agentId);
    [label, desc] = statusCopyForTaskType(1, statusCode, task, userClose);
    [taskType, status] = ['subscription', subscriptionStatusName(statusCode)];
  }
  return {
    jobId, shortJobId: shortJobIdBytes(jobId), taskType, status, statusLabel: label, statusDescription: desc, statusCode,
    title: stringFieldFromKeys(task, ['title', 'jobName', 'serviceName']),
    tokenAmount: stringFieldFromKeys(task, ['serviceTokenAmount', 'paymentTokenAmount', 'tokenAmount']),
    tokenSymbol: stringFieldFromKeys(task, ['serviceTokenSymbol', 'paymentTokenSymbol', 'tokenSymbol']),
    myAgentId: agentId, myRole: roleName(role), counterpartyAgentId: cpId === '' ? null : cpId, counterpartyRole: cpRole === '' ? null : cpRole,
  };
}

// upstream: query.rs::handle_active_tasks → success data
export async function handleActiveTasks(client, roleFilter, includeTerminal) {
  let agents = await fetchMyAgents();
  if (roleFilter !== undefined && roleFilter !== null) {
    const want = parseRoleArg(roleFilter);
    if (want === undefined) {
      const { rustDebugStr } = await import('../../_rs.mjs');
      throw new Error(`unrecognized --role value: ${rustDebugStr(roleFilter)} (expected user / asp / evaluator)`);
    }
    agents = agents.filter((a) => asI64(get(a, 'role')) === want);
  }
  const all = [], seen = new Set();
  const push = (row) => { const key = `${row.myAgentId}\0${row.jobId}`; if (!seen.has(key)) { seen.add(key); all.push(row); } };
  for (const agent of agents) {
    const agentId = asStr(get(agent, 'agentId')) ?? '';
    const role = asI64(get(agent, 'role')) ?? 0;
    if (agentId === '') continue;
    if (role === 1 || role === 2) {
      for (const statusType of includeTerminal ? [1, 2] : [1]) {
        let response;
        try { response = await client.getWithIdentity(`/priapi/v1/aieco/task/subscribe/my?page=1&pageSize=100&statusType=${statusType}`, agentId); } catch { continue; }
        for (const task of listItems(response)) { const row = await activeTaskRow(task, 'Subscription', agentId, role, includeTerminal); if (row) push(row); }
      }
    }
    let response;
    try { response = await client.getWithIdentity('/priapi/v1/aieco/task/my?page=1&page_size=100', agentId); } catch { continue; }
    for (const task of listItems(response)) {
      const kind = ordinaryTaskKind(task);
      if (!kind) continue;
      const row = await activeTaskRow(task, kind, agentId, role, includeTerminal);
      if (row) push(row);
    }
  }
  return { totalAgents: agents.length, totalTasks: all.length, tasks: all };
}
