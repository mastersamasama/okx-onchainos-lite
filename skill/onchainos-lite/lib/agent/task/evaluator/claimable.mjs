// `arbitration-claimable` — upstream task/evaluator/claimable.rs (plain text; agentId used raw).
import { auditLog } from '../../../core/audit.mjs';
import { fetchAndPrintClaimable } from '../common/claim.mjs';

// upstream: claimable.rs::handle_claimable
export async function handleClaimable(client, agentId) {
  const hasNonzero = await fetchAndPrintClaimable(client, agentId);
  auditLog('cli', 'evaluator/arbitration_claimable_checked', true, 0, [`agentId=${agentId}`, `hasClaimable=${hasNonzero}`]);
  process.stdout.write(hasNonzero
    ? "\nnext: rewards available — say 'claim rewards' to withdraw all at once; settles after on-chain confirm.\nhasClaimable: yes\n"
    : '\n(no claimable rewards)\nhasClaimable: no\n');
}
