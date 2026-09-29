// V2 designated-provider accept/decline mutations for tasks and subscriptions —
// upstream task/asp/provider_decision.rs. Handlers return the success data (printed as
// `{"ok":true,"data":…}` by the command layer).
import { auditLog } from '../../../core/audit.mjs';
import { context } from '../../../core/errors.mjs';
import { loadSession } from '../../../wallet/store.mjs';
import { get, at, asStr, asI64 } from '../../../core/rs/value.mjs';
import { trim, charCount } from '../../../core/rs/str.mjs';
import { resolveWalletByAgentId, signUopAndBroadcastFull, extractBizType } from '../signing.mjs';

const MAX_DECLINE_REASON_CHARS = 512;

// upstream: provider_decision.rs::DecisionKind
export const DecisionKind = Object.freeze({
  AcceptJob: { action: 'acceptJobByProvider', bizType: 203, subscription: false, decline: false },
  DeclineJob: { action: 'declineJobByProvider', bizType: 202, subscription: false, decline: true },
  AcceptSubscription: { action: 'acceptSubscription', bizType: 205, subscription: true, decline: false },
  DeclineSubscription: { action: 'declineSubscription', bizType: 206, subscription: true, decline: true },
});

// upstream: DecisionKind::path
export const decisionPath = (kind, client, jobId) => (kind.subscription ? `${client.subscribePath(jobId)}/${kind.action}` : client.endpoint(jobId, kind.action));

// upstream: provider_decision.rs::validate_inputs
export function validateInputs(jobId, agentId, kind, reason) {
  if (trim(jobId) === '') throw new Error('jobId is required');
  if (trim(agentId) === '') throw new Error('--agent-id is required');
  if (kind.decline) {
    const r = reason === undefined || reason === null ? '' : trim(reason);
    if (r === '') throw new Error('--reason is required for provider decline');
    if (charCount(r) > MAX_DECLINE_REASON_CHARS) throw new Error(`--reason exceeds ${MAX_DECLINE_REASON_CHARS} Unicode characters`);
  }
}

// upstream: provider_decision.rs::validate_response
export function validateResponse(jobId, kind, value) {
  const raw = asStr(at(value, 'jobId'));
  const returned = raw === undefined ? '' : trim(raw);
  if (returned === '') throw new Error(`${kind.action} response missing jobId`);
  if (returned !== jobId) throw new Error(`${kind.action} returned jobId ${returned}, expected ${jobId}`);
  if (get(value, 'uopData') === undefined || at(value, 'uopData') === null) throw new Error(`${kind.action} response missing uopData`);
  const bizType = extractBizType(value);
  if (Number(bizType) !== kind.bizType) throw new Error(`${kind.action} returned bizType ${bizType}, expected ${kind.bizType}`);
}

// upstream: provider_decision.rs::detail_status
export function detailStatus(kind, detail) {
  if (kind.subscription) return asI64(at(detail, 'subStatus')) ?? asI64(at(detail, 'status'));
  return asI64(at(detail, 'status'));
}

// upstream: provider_decision.rs::already_accepted_result (json! → sorted)
export const alreadyAcceptedResult = (jobId, kind) => ({
  phase: 'provider_decision', decision: 'ready', reason: 'already_accepted', nextAction: [],
  payload: { jobId, taskType: kind.subscription ? 'subscription' : 'single', providerDecision: 'already_accepted', status: 1, broadcast: null },
});

// upstream: provider_decision.rs::broadcast_submitted_result (json! → sorted)
export const broadcastSubmittedResult = (jobId, kind, broadcast) => ({
  phase: 'provider_decision', decision: 'ready', reason: 'broadcast_submitted', nextAction: [],
  payload: {
    jobId, taskType: kind.subscription ? 'subscription' : 'single', providerDecision: kind.decline ? 'decline' : 'accept',
    type: kind.bizType, bizType: kind.bizType, status: 'broadcast_submitted', broadcast,
  },
});

// upstream: provider_decision.rs::execute → success data
async function execute(client, jobId, agentId, kind, reason) {
  validateInputs(jobId, agentId, kind, reason);
  const session = loadSession();
  if (!session || trim(session.sessionCert) === '') throw new Error('current login has no sessionCert; run `onchainos wallet login` again');
  const detailPath = kind.subscription ? client.subscribePath(jobId) : client.taskPath(jobId);
  let detail;
  try { detail = await client.getWithIdentity(detailPath, agentId); } catch (e) {
    throw context(`cannot fetch latest detail before ${kind.action}; no mutation was attempted`, e);
  }
  const status = detailStatus(kind, detail);
  if (status === undefined) throw new Error('latest detail has no status; no mutation was attempted');
  if (status === 1) return alreadyAcceptedResult(jobId, kind);
  if (status !== 0) throw new Error(`latest status is ${status}, not CREATED(0); no mutation was attempted`);
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  let response;
  try { response = await client.postMutationWithIdentity(decisionPath(kind, client, jobId), {}, agentId); } catch (e) {
    throw context(`${kind.action} failed or returned an unknown network result`, e);
  }
  validateResponse(jobId, kind, response);
  const extra = reason === undefined || reason === null ? undefined : { reason: trim(reason) };
  let broadcast;
  try {
    broadcast = await signUopAndBroadcastFull(client, at(response, 'uopData'), accountId, address, jobId, kind.bizType, agentId, extra);
  } catch (e) { throw context(`${kind.action} broadcast failed or returned an unknown result`, e); }
  if (broadcast === null || broadcast === undefined) throw new Error(`${kind.action} broadcast returned no receipt`);
  auditLog('cli', `ASP/${kind.action}_submitted`, true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `bizType=${kind.bizType}`]);
  return broadcastSubmittedResult(jobId, kind, broadcast);
}

// upstream: provider_decision.rs::handle_accept_job
export const handleAcceptJob = (client, jobId, agentId) => execute(client, jobId, agentId, DecisionKind.AcceptJob, undefined);
// upstream: provider_decision.rs::handle_decline_job
export const handleDeclineJob = (client, jobId, agentId, reason) => execute(client, jobId, agentId, DecisionKind.DeclineJob, reason);
// upstream: provider_decision.rs::handle_accept_subscription
export const handleAcceptSubscription = (client, jobId, agentId) => execute(client, jobId, agentId, DecisionKind.AcceptSubscription, undefined);
// upstream: provider_decision.rs::handle_decline_subscription
export const handleDeclineSubscription = (client, jobId, agentId, reason) => execute(client, jobId, agentId, DecisionKind.DeclineSubscription, reason);
