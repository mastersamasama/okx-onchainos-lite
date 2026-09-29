// Shared subscription identity selector — upstream task/common/subscription_identity.rs.
import { trim } from '../../../core/rs/str.mjs';

// upstream: subscription_identity.rs::select_subscription_agent_id
export function selectSubscriptionAgentId(userAgentId, aspAgentId) {
  for (const id of [userAgentId, aspAgentId]) {
    const t = trim(id ?? '');
    if (t !== '') return t;
  }
  throw new Error('agenticId is required for subscription requests');
}
