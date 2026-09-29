// `vote-reveal` — upstream task/evaluator/reveal.rs (prints plain text).
import { auditLog } from '../../../core/audit.mjs';
import { at, asBool, valueText } from '../../../core/rs/value.mjs';
import { resolveWalletAndAgentForEvaluator, signUopAndBroadcast, extractBizType } from '../signing.mjs';

// upstream: reveal.rs::handle_reveal
export async function handleReveal(client, jobId, agentIdRaw) {
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  const canResp = await client.getWithIdentity(client.endpoint(jobId, 'vote/canReveal'), agentId);
  const can = asBool(at(canResp, 'canReveal'));
  if (can === false) {
    auditLog('cli', 'evaluator/vote_reveal_skipped', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`]);
    throw new Error(`backend canReveal=false (jobId=${jobId}): reveal window not yet open / current round already settled / no commit submitted.`);
  }
  if (can === undefined) throw new Error(`canReveal response missing boolean field, backend may have returned malformed data: ${valueText(canResp)}`);
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'vote/reveal'), {}, agentId);
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
  auditLog('cli', 'evaluator/vote_revealed', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write(`vote revealed (jobId=${jobId})\n  txHash:       ${txHash}\n`);
}
