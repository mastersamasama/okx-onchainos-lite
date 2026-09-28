// `subscribe-offline-update` — upstream task/user/offline_receive.rs.
import { stringify } from '../../../core/json.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { probeOfflineReplayCapability, fixCommandsOrDefault } from '../common/okx-a2a.mjs';
import { resolveUserAgent } from './create.mjs';
import { SUBSCRIBE_API_PREFIX } from './create-subscribe.mjs';

// upstream: offline_receive.rs::parse_offline_flag (private)
export function parseOfflineFlag(raw) {
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  throw new Error(`--flag must be 0 (keep offline backlog) or 1 (discard offline backlog); got "${raw}"`);
}

// upstream: offline_receive.rs::build_offline_body (private)
export const buildOfflineBody = (flag) => ({ offlineReceiveFlag: flag });
// upstream: offline_receive.rs::offline_receive_path (private)
export const offlineReceivePath = (subId) => `${SUBSCRIBE_API_PREFIX}/${subId}/setOfflineReceiveFlag`;
// upstream: offline_receive.rs::is_offline_update_success (private) — null or true
export const isOfflineUpdateSuccess = (data) => data === null || data === undefined || data === true;

// upstream: offline_receive.rs::build_offline_success (json! → sorted)
export function buildOfflineSuccess(jobId, flag, offlineReplay) {
  const out = { jobId, offlineReceiveFlag: flag, offlineReplaySupported: offlineReplay.supported };
  if (!offlineReplay.supported) out.offlineReplayFixCommands = fixCommandsOrDefault(offlineReplay);
  return out;
}

// upstream: offline_receive.rs::handle_subscribe_offline_update → success data
export async function handleSubscribeOfflineUpdate(client, jobId, flagRaw) {
  const flag = parseOfflineFlag(flagRaw);
  if (jobId === '') throw new Error('--job-id must not be empty');
  try { await ensureTokensRefreshed(); } catch (e) { throw new Error(`session has expired; run \`onchainos wallet login\` first: ${displayTop(e)}`); }
  const [resolved] = await resolveUserAgent();
  const userAgentId = selectSubscriptionAgentId(resolved, '');
  let resp;
  try { resp = await client.postWithIdentity(offlineReceivePath(jobId), buildOfflineBody(flag), userAgentId); } catch (e) {
    throw new Error(`subscribe-offline-update failed: ${displayTop(e)}`);
  }
  if (!isOfflineUpdateSuccess(resp)) throw new Error(`subscribe-offline-update failed: backend did not confirm the update: ${stringify(resp)}`);
  return buildOfflineSuccess(jobId, flag, await probeOfflineReplayCapability());
}
