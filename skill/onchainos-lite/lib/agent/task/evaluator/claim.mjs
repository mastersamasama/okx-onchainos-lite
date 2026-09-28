// `arbitration-claim` — upstream task/evaluator/claim.rs (account-level reward pull; plain text).
import { auditLog } from '../../../core/audit.mjs';
import { resolveWalletAndAgentForEvaluator } from '../signing.mjs';
import { submitClaimAndBroadcast } from '../common/claim.mjs';

// upstream: claim.rs::handle_claim
export async function handleClaim(client, agentIdRaw) {
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  const txHash = await submitClaimAndBroadcast(client, accountId, address, agentId);
  auditLog('cli', 'evaluator/arbitration_claimed', true, 0, [`agentId=${agentId}`, `account=${address}`, `txHash=${txHash}`]);
  process.stdout.write(`reward claim submitted (account=${address})\n`
    + `  txHash:   ${txHash}\n`
    + 'note: claims all rewards from settled evaluations at once; settled amount will be notified after on-chain confirmation.\n');
}
