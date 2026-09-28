// PRIVATE bridge to the autotrade partition (lib/agent/task/common/autotrade/**, owned by the
// autotrade unit). The retired-event predicates are needed synchronously by pending-v2 /
// okx-a2a, so they are mirrored here (upstream autotrade/mod.rs constants); the stateful helpers
// are loaded lazily from the owning module and fall back to minimal ports of the upstream code.
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { onchainosHome } from '../../_home.mjs';
import { parse as parseJson } from '../../../core/json.mjs';
import { get, asStr, asU64 } from '../../_rs.mjs';

// upstream: autotrade/mod.rs::RETIRED_MODE_CONFIGURATION_EVENTS
const RETIRED_MODE_CONFIGURATION_EVENTS = ['autotrade_consent', 'autotrade_config_required'];
// upstream: autotrade/mod.rs::RETIRED_DELIVERY_DECISION_EVENTS
const RETIRED_DELIVERY_DECISION_EVENTS = ['autotrade_consent', 'autotrade_consent_pre_delivery', 'autotrade_config_required',
  'autotrade_manual_signal', 'autotrade_over_cap', 'autotrade_cap_adjust', 'autotrade_tool_select', 'autotrade_plugin_install'];
// upstream: autotrade/card.rs::CONSENT_SOURCE_EVENT / CONFIG_REQUIRED_SOURCE_EVENT
export const CONSENT_SOURCE_EVENT = 'autotrade_consent';
export const CONFIG_REQUIRED_SOURCE_EVENT = 'autotrade_config_required';

// upstream: autotrade/mod.rs::is_retired_mode_configuration_decision (Option<&str>)
export const isRetiredModeConfigurationDecision = (e) => e !== undefined && e !== null && RETIRED_MODE_CONFIGURATION_EVENTS.includes(e);
// upstream: autotrade/mod.rs::is_retired_delivery_decision
export const isRetiredDeliveryDecision = (e) => e !== undefined && e !== null && RETIRED_DELIVERY_DECISION_EVENTS.includes(e);
// upstream: autotrade/consent_reply.rs::is_candidate_source
export const isCandidateSource = (e) => e === CONSENT_SOURCE_EVENT || e === CONFIG_REQUIRED_SOURCE_EVENT;
// upstream: autotrade/grants.rs::job_id_is_safe
export const jobIdIsSafe = (j) => typeof j === 'string' && /^[A-Za-z0-9_-]+$/.test(j);

async function tryImport(rel) {
  try { return await import(rel); } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; }
}

// upstream: autotrade/consent.rs::load_pending_delivery_context → context | null (throws on mismatch)
export async function loadPendingDeliveryContext(jobId) {
  const m = await tryImport('./autotrade/consent.mjs');
  if (m?.loadPendingDeliveryContext) return m.loadPendingDeliveryContext(jobId);
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  const path = join(onchainosHome(), 'autotrade', 'pending', `${jobId}.json`);
  if (!existsSync(path)) return null;
  const ctx = parseJson(readFileSync(path, 'utf8'));
  const version = asU64(get(ctx, 'version'));
  if (!(version >= 1 && version <= 2) || asStr(get(ctx, 'jobId')) !== jobId) throw new Error('pending delivery context mismatch');
  return {
    jobId, agentId: asStr(get(ctx, 'agentId')) ?? '', providerAgentId: asStr(get(ctx, 'providerAgentId')) ?? '',
    originSessionKey: asStr(get(ctx, 'originSessionKey')) ?? null, deliveryId: asStr(get(ctx, 'deliveryId')) ?? '',
  };
}

// upstream: autotrade/consent.rs::clear_pending_signal
export async function clearPendingSignal(jobId) {
  const m = await tryImport('./autotrade/consent.mjs');
  if (m?.clearPendingSignal) return m.clearPendingSignal(jobId);
  if (!jobIdIsSafe(jobId)) return;
  try { rmSync(join(onchainosHome(), 'autotrade', 'pending', `${jobId}.json`), { force: true }); } catch {}
}

// upstream: autotrade/consent_reply.rs::clear_candidate_draft
export async function clearCandidateDraft(jobId) {
  const m = await tryImport('./autotrade/consent-reply.mjs');
  if (m?.clearCandidateDraft) return m.clearCandidateDraft(jobId);
  if (!jobIdIsSafe(jobId)) return;
  try { rmSync(join(onchainosHome(), 'autotrade', 'pending-config', `${jobId}.json`), { force: true }); } catch {}
}

// upstream: autotrade/consent_reply.rs::apply_candidate_json — both candidate sources are retired in
// 4.6.3, so the upstream function clears the draft and returns FallbackRelay for them.
export async function applyCandidateJson(jobId, agentId, sourceEvent, candidateJson) {
  const m = await tryImport('./autotrade/consent-reply.mjs');
  if (m?.applyCandidateJson) return m.applyCandidateJson(jobId, agentId, sourceEvent, candidateJson);
  if (!isCandidateSource(sourceEvent)) throw new Error('auto-trade candidate JSON is not valid for this decision type');
  await clearCandidateDraft(jobId);
  return { kind: 'FallbackRelay' };
}
