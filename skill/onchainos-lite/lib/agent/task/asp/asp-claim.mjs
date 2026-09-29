// ASP claims after the submit→complete timeout (claimAutoComplete) — upstream task/asp/asp_claim.rs.
import { auditLog } from '../../../core/audit.mjs';
import { at } from '../../../core/rs/value.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';

// upstream: asp_claim.rs::handle_claim_auto_complete (prints plain text)
export async function handleClaimAutoComplete(client, jobId, agentId) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'claimAutoComplete'), {}, agentId);
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
  auditLog('cli', 'ASP/claim_auto_complete_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write('✓ Timeout claim submitted (claimAutoComplete), waiting for on-chain confirmation (job_completed)\n'
    + `  txHash: ${txHash}\n`
    + '\n'
    + '⚠️  Next steps are driven by system notifications:\n'
    + '    - You will receive a `job_completed` system notification after on-chain confirmation (funds released to you)\n');
}
