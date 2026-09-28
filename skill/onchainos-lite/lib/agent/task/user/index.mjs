// User-side task commands — upstream task/user/mod.rs: shared dispatch helpers, the
// subscription execution preference command, and the wallet-login post-condition hooks
// (new-device subscription routing + active-subscription summary).
import { deviceId as cachedDeviceId } from '../../../core/device.mjs';
import { get, asStr, asI64, asBool, asArray, trim, eqIgnoreAsciiCase } from '../../_rs.mjs';
import { TaskApiClient } from '../common/network/task-api-client.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { findService } from '../common/index.mjs';
import { resolveUserAgent } from './create.mjs';
import * as deviceRouting from './device-routing.mjs';
import { ExecutionMode, saveExecutionMode } from '../common/autotrade/subscription-config.mjs';

export { validateDraftFields } from './create.mjs';

// upstream: mod.rs `pub(crate) use flow_lifecycle::try_recover_from_temp_file` (A4-owned module).
// Loaded lazily: the lifecycle playbooks are heavy and wallet login imports this module.
export async function tryRecoverFromTempFile(...args) {
  const { tryRecoverFromTempFile: f } = await import('./flow-lifecycle/core.mjs');
  return f(...args);
}

// upstream: mod.rs::parse_bool_or_int
export function parseBoolOrInt(s, flag) {
  if (s === '0' || s === 'false') return 0;
  if (s === '1' || s === 'true') return 1;
  throw new Error(`--${flag} must be 0, 1, true, or false; got "${s}"`);
}

// upstream: mod.rs::handle_subscription_execution_config_set → success data (json! → sorted)
export async function handleSubscriptionExecutionConfigSet(serviceId, executionModeRaw, replace) {
  const [resolved] = await resolveUserAgent();
  const agentId = selectSubscriptionAgentId(resolved, '');
  const mode = ExecutionMode.fromStr(executionModeRaw);
  const outcome = saveExecutionMode(agentId, serviceId, mode, replace);
  return { agentId, serviceId, executionMode: mode, outcome, storage: 'local' };
}

// upstream: mod.rs::active_subscription_count (private)
export function activeSubscriptionCount(subscriptions) {
  const list = asArray(get(subscriptions, 'list'));
  if (!list) return 0;
  return list.filter((item) => asI64(get(item, 'status')) === 1 || (() => { const s = asStr(get(item, 'statusName')); return s !== undefined && eqIgnoreAsciiCase(s, 'ACTIVE'); })()).length;
}

// upstream: mod.rs::compose_post_login_subscriptions → {activeSubscriptionCount} | null
export function composePostLoginSubscriptions(subscriptions) {
  const n = activeSubscriptionCount(subscriptions);
  return n === 0 ? null : { activeSubscriptionCount: n };
}

// upstream: mod.rs::resolve_post_login_agentic_id (the wallet login passes a deadline hint; unused)
export async function resolvePostLoginAgenticId() {
  const [agentId] = await resolveUserAgent();
  return agentId;
}

// upstream: mod.rs::device_snapshot_contains (private) → boolean | undefined
export function deviceSnapshotContains(devices, deviceId) {
  const list = asArray(get(devices, 'list'));
  if (!list) return undefined;
  return list.some((row) => asStr(get(row, 'deviceId')) === deviceId);
}

// upstream: mod.rs::device_needs_default_routing (private)
export const deviceNeedsDefaultRouting = (wasRegistered, alreadyPending) => alreadyPending || !wasRegistered;

// upstream: mod.rs::prepare_post_login_subscriptions → PostLoginSubscriptionsPreparation | null (never throws)
export async function preparePostLoginSubscriptions(agenticId) {
  try {
    const agentId = selectSubscriptionAgentId(agenticId, '');
    const client = new TaskApiClient();
    const currentDeviceId = cachedDeviceId();
    if (!currentDeviceId) return null;
    const devices = await deviceRouting.fetchDeviceListSnapshot(client, agentId, 1, 20);
    const wasRegistered = deviceSnapshotContains(devices, currentDeviceId);
    if (wasRegistered === undefined) return null;
    const alreadyPending = deviceRouting.newDeviceRoutingIsPending(client.baseUrl, agentId, currentDeviceId);
    const needs = deviceNeedsDefaultRouting(wasRegistered, alreadyPending);
    if (!wasRegistered && !alreadyPending) deviceRouting.markNewDeviceRoutingPending(client.baseUrl, agentId, currentDeviceId);
    else if (wasRegistered && !alreadyPending) { try { deviceRouting.clearNewDeviceRoutingState(client.baseUrl, agentId, currentDeviceId); } catch {} }
    return {
      agentId, currentDeviceId, routingApiBaseUrl: client.baseUrl, currentDeviceWasRegistered: wasRegistered,
      currentDeviceNeedsDefaultRouting: needs, preRegistrationDevices: devices,
    };
  } catch { return null; }
}

// upstream: subscription_ops.rs::fetch_my_subscriptions_snapshot_for_agent (A4-owned; Buyer role).
async function buyerSnapshot(client, agentId) {
  const { fetchMySubscriptionsSnapshotForAgent } = await import('./subscription-ops.mjs');
  return fetchMySubscriptionsSnapshotForAgent(client, 'buyer', undefined, agentId);
}

// upstream: mod.rs::finalize_post_login_subscriptions → {activeSubscriptionCount} | null (never throws)
export async function finalizePostLoginSubscriptions(prepared, deviceRegistrationSucceeded) {
  if (!prepared) return null;
  const client = new TaskApiClient();
  let snapshot;
  try { snapshot = await buyerSnapshot(client, prepared.agentId); } catch { return null; }
  const { routingApiBaseUrl: base, agentId, currentDeviceId: dev } = prepared;
  if (snapshot.isEmpty) {
    if (prepared.currentDeviceNeedsDefaultRouting && (prepared.currentDeviceWasRegistered || deviceRegistrationSucceeded)) {
      try { deviceRouting.markNewDeviceRoutingCompleted(base, agentId, dev); } catch { return null; }
      try { deviceRouting.clearNewDeviceRoutingState(base, agentId, dev); } catch {}
    }
    return null;
  }
  if (prepared.currentDeviceNeedsDefaultRouting && !prepared.currentDeviceWasRegistered && !deviceRegistrationSucceeded) return null;
  const subscriptions = snapshot.data;
  if (prepared.currentDeviceNeedsDefaultRouting) {
    try { await deviceRouting.addNewDeviceToAllSubscriptions(client, base, agentId, subscriptions, dev); } catch { return null; }
    try { deviceRouting.clearNewDeviceRoutingState(base, agentId, dev); } catch {}
  }
  await addPostLoginAutotradePrechecks(client, subscriptions, agentId);
  return composePostLoginSubscriptions(subscriptions);
}

// upstream: mod.rs::fetch_post_login_subscriptions (no caller in 4.6.3)
export async function fetchPostLoginSubscriptions(agenticId) {
  let agentId;
  try { agentId = selectSubscriptionAgentId(agenticId, ''); } catch { return null; }
  const client = new TaskApiClient();
  let snapshot;
  try { snapshot = await buyerSnapshot(client, agentId); } catch { return null; }
  await addPostLoginAutotradePrechecks(client, snapshot.data, agentId);
  return composePostLoginSubscriptions(snapshot.data);
}

const nonBlank = (v) => { const s = asStr(v); if (s === undefined) return undefined; const t = trim(s); return t === '' ? undefined : t; };

// upstream: mod.rs::resolve_subscription_executable_service (resolve_current_guide = false) →
// description text to classify | undefined. HTTP / child-process lookups follow upstream order.
async function resolveSubscriptionServiceDescription(client, agentId, subscription) {
  const inline = nonBlank(get(subscription, 'serviceDescription'));
  if (inline !== undefined) return inline;
  const jobId = asStr(get(subscription, 'jobId')) ?? '';
  let detail;
  if (jobId !== '') {
    const { fetchSubscribeDetailForAgent } = await import('./subscription-ops.mjs');
    try { detail = await fetchSubscribeDetailForAgent(client, jobId, agentId); } catch {}
  }
  const detailDesc = nonBlank(get(detail, 'serviceDescription'));
  if (detailDesc !== undefined) return detailDesc;
  const provider = asStr(get(subscription, 'providerAgentId')) ?? '';
  const serviceId = asStr(get(subscription, 'serviceId')) ?? '';
  let catalog, catalogError;
  if (provider !== '' && serviceId !== '') { try { catalog = await findService(provider, serviceId); } catch (e) { catalogError = e; } }
  const catalogDesc = nonBlank(get(catalog, 'serviceDescription'));
  if (catalogDesc !== undefined) return catalogDesc;
  if (catalogError) throw catalogError;
  return undefined;
}

// upstream: mod.rs::add_post_login_autotrade_prechecks — bounded execution-profile hints; all
// failures ignored. Classification / profile storage are owned by the autotrade unit.
export async function addPostLoginAutotradePrechecks(client, subscriptions, agentId) {
  const list = asArray(get(subscriptions, 'list'));
  if (!list) return;
  const { classifyDescription: classify } = await import('../common/autotrade/tooling.mjs');
  const { saveFromDescription: save } = await import('../common/autotrade/profile.mjs');
  for (const sub of list) {
    if (asI64(get(sub, 'status')) !== 1 || asBool(get(sub, 'thisDeviceReceives')) !== true) continue;
    const jobId = asStr(get(sub, 'jobId')) ?? '';
    const serviceId = asStr(get(sub, 'serviceId')) ?? '';
    const provider = asStr(get(sub, 'providerAgentId')) ?? '';
    if (jobId === '' || serviceId === '' || provider === '') continue;
    let description;
    try { description = await resolveSubscriptionServiceDescription(client, agentId, sub); } catch { continue; }
    if (description === undefined) continue;
    try {
      const classified = await classify(description);
      if (!classified || !(classified.classes ?? []).length) continue;
      await save(jobId, serviceId, provider, description);
    } catch {}
  }
}
