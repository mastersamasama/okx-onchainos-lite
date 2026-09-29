// Escrow completion (review approval) — upstream task/user/v2/complete.rs. FUNDS: releases escrow.
import { auditLog } from '../../../../core/audit.mjs';
import { get, asI64 } from '../../../../core/rs/value.mjs';
import * as signing from '../../signing.mjs';
import { PaymentMode } from '../../common/payment-mode.mjs';
import { checkAndConsume } from '../../common/review-gate.mjs';

// upstream: complete.rs::submitted_result (json! → sorted)
export const submittedResult = (jobId, txHash) => ({
  phase: 'deliverable_review', decision: 'ready', reason: 'completion_submitted', nextAction: [{ id: 'stop' }], payload: { jobId, txHash },
});

// upstream: complete.rs::legacy_a2mcp_removed_result
export const legacyA2mcpRemovedResult = (jobId) => ({
  phase: 'deliverable_review', decision: 'blocked', reason: 'legacy_a2mcp_flow_removed', nextAction: [{ id: 'stop' }], payload: { jobId },
});

// upstream: complete.rs::handle → result value
export async function handle(client, jobId) {
  const [accountId, address, agentId] = await signing.resolveWalletAndAgentForTask(client, jobId, null);
  const task = await client.getWithIdentity(client.taskPath(jobId), agentId);
  const mode = PaymentMode.fromInt(Number(BigInt.asIntN(32, BigInt(asI64(get(task, 'paymentMode')) ?? 0))));
  if (mode !== PaymentMode.Escrow) return legacyA2mcpRemovedResult(jobId);
  checkAndConsume(jobId);
  const result = await signing.taskDualSignAndBroadcast(client, jobId, 'pre-complete', 'complete', undefined, accountId, address, agentId, undefined);
  const txHash = result.txHash;
  auditLog('cli', 'user/complete_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, 'paymentMode=1', `txHash=${txHash}`]);
  return submittedResult(jobId, txHash);
}
