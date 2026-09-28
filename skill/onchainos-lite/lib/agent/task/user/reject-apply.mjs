// Reject a provider's apply (task stays `created`) — upstream task/user/reject_apply.rs.
import { auditLog } from '../../../core/audit.mjs';
import { resolveWalletAndAgentForTask } from '../signing.mjs';

// upstream: reject_apply.rs::handle_reject_apply — prints its own two lines.
export async function handleRejectApply(client, jobId, explicitAgentId) {
  const [, , agentId] = await resolveWalletAndAgentForTask(client, jobId, explicitAgentId);
  await client.postWithIdentity(client.endpoint(jobId, 'user/reject'), {}, agentId);
  auditLog('cli', 'user/reject_apply_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`]);
  process.stdout.write(`✓ Reject-apply submitted; task remains in \`created\` state.\n  agentId: ${agentId}\n`);
}
