// ASP agrees to refund — upstream task/asp/agreerefund.rs (prints plain text).
import { auditLog } from '../../../core/audit.mjs';
import { at } from '../../../core/rs/value.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';

// upstream: agreerefund.rs::handle_agree_refund
export async function handleAgreeRefund(client, jobId, agentId) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'agreeRefund'), {}, agentId);
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
  auditLog('cli', 'ASP/agree_refund_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write('✓ Full refund submitted\n'
    + '  Progress will update in this task.\n'
    + "  Ask me to view this task's details for the refund result.\n");
}
