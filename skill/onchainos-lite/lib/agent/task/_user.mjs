// PRIVATE bridge to the user partitions (lib/agent/task/user/**, owned by the user units):
// the helpers the foundation needs are loaded lazily from their mirror-rule modules; small
// pure predicates and local-file readers have minimal fallback ports so foundation commands
// keep working when those modules are absent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { onchainosHome, taskStateDir } from '../_home.mjs';
import { parse as parseJson } from '../../core/json.mjs';
import { get, asStr, asI64, trim } from '../_rs.mjs';
import { validateDecimal, isZeroDecimal } from './arbitration.mjs';

async function tryImport(rel) {
  try { return await import(rel); } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; }
}
const missing = (what, mod) => new Error(`${what} is unavailable: ${mod} is not installed in this build`);

export { validateDecimal, isZeroDecimal };

// upstream: user/refund.rs::authoritative_refund_settlement_confirmed (pure)
export function authoritativeRefundSettlementConfirmed(detail, expectedStatus) {
  const st = detail.status === null || detail.status === undefined ? undefined : Number(detail.status);
  if (st !== expectedStatus || ![7, 8, 9].includes(expectedStatus)) return false;
  const amt = trim(detail.tokenAmount ?? '');
  const positive = validateDecimal(amt) && !isZeroDecimal(amt);
  const jt = detail.jobType === null || detail.jobType === undefined ? undefined : Number(detail.jobType);
  const tt = detail.trialType === null || detail.trialType === undefined ? undefined : Number(detail.trialType);
  if (expectedStatus === 8) return positive && (jt === 0 || (jt === 1 && tt === 0));
  if (expectedStatus === 9) return positive && (jt === 0 || (jt === 1 && tt !== 1));
  return jt === 0 && Number(detail.paymentMode) === 1 && detail.paymentMode !== null && positive;
}

// upstream: user/refund.rs::refund_event_settlement_confirmed
export const refundEventSettlementConfirmed = (detail, expectedStatus, _event) => authoritativeRefundSettlementConfirmed(detail, expectedStatus);

// upstream: user/refund.rs::has_created_subscription_close_receipt (local Refund V2 journal)
export async function hasCreatedSubscriptionCloseReceipt(jobId, userAgentId) {
  const m = await tryImport('./user/refund.mjs');
  if (m?.hasCreatedSubscriptionCloseReceipt) return m.hasCreatedSubscriptionCloseReceipt(jobId, userAgentId);
  try {
    const digest = createHash('sha256').update(`${userAgentId}\0${jobId}`).digest('hex');
    const s = parseJson(readFileSync(join(onchainosHome(), 'refund-v2', `${digest}.json`), 'utf8'));
    const rev = asI64(get(s, 'journalRevision')) ?? 2;
    if (asI64(get(s, 'schemaVersion')) !== 2 || (rev !== 2 && rev !== 3) || asStr(get(s, 'jobId')) !== jobId || asStr(get(s, 'userAgentId')) !== userAgentId) return false;
    if (asStr(get(s, 'operation')) !== 'close-created-subscription') return false;
    if (!['broadcast_submitted', 'confirmed', 'confirmed_without_hash', 'closed_without_payment'].includes(asStr(get(s, 'state')))) return false;
    return ['pkgId', 'orderId', 'orderType', 'bizUniqKey'].every((k) => { const v = asStr(get(s, k)); return v !== undefined && trim(v) !== ''; });
  } catch { return false; }
}

// upstream: user/subscription_ops.rs::fetch_subscribe_detail_for_agent
export async function fetchSubscribeDetailForAgent(client, subId, agentId) {
  const m = await tryImport('./user/subscription-ops.mjs');
  if (m?.fetchSubscribeDetailForAgent) return m.fetchSubscribeDetailForAgent(client, subId, agentId);
  const { displayTop } = await import('../../wallet/api.mjs');
  try { return await client.getWithIdentity(`/priapi/v1/aieco/task/subscribe/${subId}`, agentId); } catch (e) { throw new Error(`subscribe-detail failed: ${displayTop(e)}`); }
}

// upstream: user/subscription_ops.rs::fetch_my_subscriptions_snapshot_for_agent_read_only → snapshot { data, … }
export async function fetchMySubscriptionsSnapshotForAgentReadOnly(client, role, status, headerAgent) {
  const m = await tryImport('./user/subscription-ops.mjs');
  if (!m?.fetchMySubscriptionsSnapshotForAgentReadOnly) throw missing('subscription snapshot', 'lib/agent/task/user/subscription-ops.mjs');
  return m.fetchMySubscriptionsSnapshotForAgentReadOnly(client, role, status, headerAgent);
}

// upstream: user/refund.rs::fetch_refund_list_item_for_identity → RefundListItem
export async function fetchRefundListItemForIdentity(client, jobId, agentId, buyer) {
  const m = await tryImport('./user/refund.mjs');
  if (!m?.fetchRefundListItemForIdentity) throw missing('refund list item', 'lib/agent/task/user/refund.mjs');
  return m.fetchRefundListItemForIdentity(client, jobId, agentId, buyer);
}

// upstream: user/refund.rs::fetch_authoritative_refund_context → PreFetchedTaskContext
export async function fetchAuthoritativeRefundContext(client, jobId, agentId) {
  const m = await tryImport('./user/refund.mjs');
  if (!m?.fetchAuthoritativeRefundContext) throw missing('authoritative refund context', 'lib/agent/task/user/refund.mjs');
  return m.fetchAuthoritativeRefundContext(client, jobId, agentId);
}

// upstream: user/refund.rs::fetch_authoritative_refund_context_for_provider
export async function fetchAuthoritativeRefundContextForProvider(client, jobId, agentId) {
  const m = await tryImport('./user/refund.mjs');
  if (!m?.fetchAuthoritativeRefundContextForProvider) throw missing('authoritative provider refund context', 'lib/agent/task/user/refund.mjs');
  return m.fetchAuthoritativeRefundContextForProvider(client, jobId, agentId);
}

// upstream: user/negotiate.rs::save_designated_provider
export async function saveDesignatedProvider(jobId, providerAgentId) {
  const m = await tryImport('./user/negotiate.mjs');
  if (m?.saveDesignatedProvider) return m.saveDesignatedProvider(jobId, providerAgentId);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { stringify } = await import('../../core/json.mjs');
  const dir = taskStateDir(jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'designated-provider.json'), stringify({ agentId: providerAgentId }, true));
}

// upstream: user/negotiate.rs::has_designated_provider
export async function hasDesignatedProvider(jobId) {
  const m = await tryImport('./user/negotiate.mjs');
  if (m?.hasDesignatedProvider) return m.hasDesignatedProvider(jobId);
  const { existsSync } = await import('node:fs');
  try { return existsSync(join(taskStateDir(jobId), 'designated-provider.json')); } catch { return false; }
}

// upstream: user/flow_lifecycle/core.rs::try_recover_from_temp_file → recovered | undefined
export async function tryRecoverFromTempFile(...args) {
  const m = await tryImport('./user/flow-lifecycle/core.mjs') ?? await tryImport('./user/index.mjs');
  if (!m?.tryRecoverFromTempFile) return undefined;
  return m.tryRecoverFromTempFile(...args);
}

// upstream: task::{user,asp,evaluator}::flow::generate_next_action
export async function loadFlowGenerator(role) {
  const rel = { user: './user/flow.mjs', asp: './asp/flow.mjs', evaluator: './evaluator/flow.mjs' }[role];
  const m = await tryImport(rel);
  if (!m?.generateNextAction) throw missing(`the ${role} next-action playbook`, `lib/agent/task/${rel.slice(2)}`);
  return m.generateNextAction;
}
