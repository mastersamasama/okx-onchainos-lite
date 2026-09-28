// ASP-side task commands — upstream task/asp/mod.rs: `ProviderCommand` / `DisputeCommand`
// routing plus the inline account-pull arms (`asp-claimable`, `asp-claim-rewards`).
// Commands are plain objects `{ kind, ...fields }` (camelCase of the clap fields).
import { auditLog } from '../../../core/audit.mjs';
import { TaskApiClient } from '../common/network/task-api-client.mjs';
import { fetchAndPrintClaimable, submitClaimAndBroadcast } from '../common/claim.mjs';
import { handleUploadEvidence } from '../common/dispute-upload.mjs';
import { resolveWalletByAgentId } from '../signing.mjs';
import { handleApply } from './apply.mjs';
import { handleDeliver } from './deliver.mjs';
import { handleAgreeRefund } from './agreerefund.mjs';
import { handleAspReject } from './asp-reject.mjs';
import { handleAcceptJob, handleDeclineJob, handleAcceptSubscription, handleDeclineSubscription } from './provider-decision.mjs';
import { handleClaimAutoComplete } from './asp-claim.mjs';
import { handleDetail, handleList } from './task-query.mjs';
import { handleDisputeRaise } from './dispute-raise.mjs';
import { decodeReasonInput, handleDisputeConfirm } from './dispute-confirm.mjs';

export * as flow from './flow.mjs';
export * as subscription from './subscription.mjs';

const AGENT_ID_REQUIRED = "--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)";

// upstream: mod.rs::run_provider ProviderCommand::Claimable arm (prints plain text)
export async function handleClaimable(client, agentId) {
  if (agentId === '') throw new Error(AGENT_ID_REQUIRED);
  const hasNonzero = await fetchAndPrintClaimable(client, agentId);
  auditLog('cli', 'ASP/arbitration_claimable_checked', true, 0, [`agentId=${agentId}`, `hasClaimable=${hasNonzero}`]);
  process.stdout.write(hasNonzero
    ? `\nnext: Claimable rewards available — run \`onchainos agent asp-claim-rewards --agent-id ${agentId}\` to withdraw all at once.\n`
    : '\n(No pending rewards at this time)\n');
}

// upstream: mod.rs::run_provider ProviderCommand::ClaimRewards arm (prints plain text)
export async function handleClaimRewards(client, agentId) {
  if (agentId === '') throw new Error(AGENT_ID_REQUIRED);
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  const txHash = await submitClaimAndBroadcast(client, accountId, address, agentId);
  auditLog('cli', 'ASP/arbitration_claimed', true, 0, [`agentId=${agentId}`, `account=${address}`, `txHash=${txHash}`]);
  process.stdout.write(`✓ reward claim submitted (account=${address})\n`
    + 'note: All settled evaluation rewards are claimed in one go; the credited amount will be notified after on-chain confirmation.\n');
}

// upstream: mod.rs::run_provider → success data (JSON-output commands) | undefined (printed itself)
export async function runProvider(cmd) {
  const client = new TaskApiClient();
  switch (cmd.kind) {
    case 'Apply': return handleApply(client, cmd.jobId, cmd.tokenAmount, cmd.tokenSymbol, cmd.agentId);
    case 'Deliver': return handleDeliver(client, cmd.jobId, cmd.file, cmd.deliverableText, cmd.agentId);
    case 'AgreeRefund': return handleAgreeRefund(client, cmd.jobId, cmd.agentId);
    case 'AspReject': return handleAspReject(client, cmd.jobId, cmd.agentId, cmd.reason);
    case 'AcceptJobByProvider': return handleAcceptJob(client, cmd.jobId, cmd.agentId);
    case 'DeclineJobByProvider': return handleDeclineJob(client, cmd.jobId, cmd.agentId, cmd.reason);
    case 'AcceptSubscription': return handleAcceptSubscription(client, cmd.jobId, cmd.agentId);
    case 'DeclineSubscription': return handleDeclineSubscription(client, cmd.jobId, cmd.agentId, cmd.reason);
    case 'ClaimAutoComplete': return handleClaimAutoComplete(client, cmd.jobId, cmd.agentId);
    case 'Status': return handleDetail(client, cmd.jobId, cmd.agentId ?? '');
    case 'List': return handleList(client, cmd.status, cmd.page, cmd.limit, cmd.agentId ?? '');
    case 'Claimable': return handleClaimable(client, cmd.agentId);
    case 'ClaimRewards': return handleClaimRewards(client, cmd.agentId);
    default: throw new Error(`unknown provider command ${cmd.kind}`);
  }
}

// upstream: mod.rs::run_dispute
export async function runDispute(cmd) {
  const client = new TaskApiClient();
  switch (cmd.kind) {
    case 'Raise': return handleDisputeRaise(client, cmd.jobId, cmd.reason, cmd.agentId);
    case 'Confirm': return handleDisputeConfirm(client, cmd.jobId, decodeReasonInput(cmd.reason, cmd.reasonB64), cmd.agentId);
    case 'Upload': return handleUploadEvidence(client, cmd.jobId, cmd.agentId, cmd.role, cmd.text, cmd.files, cmd.maxFiles);
    default: throw new Error(`unknown dispute command ${cmd.kind}`);
  }
}
