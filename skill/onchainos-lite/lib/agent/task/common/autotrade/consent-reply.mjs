// Foreground auto-trade candidate replies — upstream autotrade/consent_reply.rs.
// Both accepted source events (autotrade_consent / autotrade_config_required) are retired in
// 4.6.3: apply_candidate_json clears any foreground draft and returns FallbackRelay before the
// candidate JSON is parsed, so the draft/persist path after that point is unreachable and not ported.
import { join } from 'node:path';
import { jobIdIsSafe } from './grants.mjs';
import { loadPendingDeliveryContext } from './consent.mjs';
import { isRetiredModeConfigurationDecision } from './index.mjs';
import { CONSENT_SOURCE_EVENT, CONFIG_REQUIRED_SOURCE_EVENT } from './card.mjs';
import { home as onchainosHome } from '../../../../core/home.mjs';
import { removeFileQuiet } from '../../../../core/rs/fs.mjs';

// upstream: consent_reply.rs::is_candidate_source
export const isCandidateSource = (sourceEvent) => sourceEvent === CONSENT_SOURCE_EVENT || sourceEvent === CONFIG_REQUIRED_SOURCE_EVENT;

// upstream: consent_reply.rs::draft_path
function draftPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'pending-config', `${jobId}.json`);
}

// upstream: consent_reply.rs::clear_candidate_draft
export function clearCandidateDraft(jobId) {
  let path;
  try { path = draftPath(jobId); } catch { return; }
  removeFileQuiet(path);
}

// upstream: consent_reply.rs::apply_candidate_json → { kind: 'FallbackRelay' }
export async function applyCandidateJson(jobId, agentId, sourceEvent, candidateJson) {
  loadPendingDeliveryContext(jobId);
  if (!isCandidateSource(sourceEvent)) throw new Error('auto-trade candidate JSON is not valid for this decision type');
  if (isRetiredModeConfigurationDecision(sourceEvent)) {
    clearCandidateDraft(jobId);
    return { kind: 'FallbackRelay' };
  }
  // unreachable in 4.6.3: every candidate source is a retired mode-configuration event
  return { kind: 'FallbackRelay' };
}
