// Designated-provider routing playbooks (CLI mode) — upstream task/user/flow_negotiate/designated.rs.
import { sessionQueryExists, sessionCreate, sessionSend } from '../../common/okx-a2a.mjs';
import { requestCommandBlock } from '../../common/pending-v2.mjs';
import { notProviderUserPrompt, providerOfflineUserPrompt } from '../content.mjs';

const SKILL_PREFETCH = '[SKILL_PREFETCH] Read the okx-ai skill through skills/okx-ai/SKILL.md. Pre-load A2A context. This prefetch message itself requires no action — but when the NEXT inbound message arrives (same turn or later turn), you MUST re-enter through that SKILL.md and follow its Top-level routing for the exact envelope shape. Do NOT carry over "no action" to business messages.';

// upstream: designated.rs::branch_a2a_cli → playbook text | undefined (session created + prefetch sent)
export async function branchA2aCli(jobId, agentId, dpId) {
  let exists;
  try { exists = await sessionQueryExists(jobId, agentId, dpId); } catch (e) { return `[branch_a2a_cli] ERROR: okx-a2a session query failed: ${e.message}\n`; }
  if (exists) {
    return `[Designated ASP route: A2A] ASP ${dpId}\n\n🛑 Sub session already exists for this job; the first inquiry has already been sent in a prior turn. End this turn immediately — do not create a group, do not send any message, do not run \`okx-a2a session status\` / \`okx-a2a session create\` / \`okx-a2a session send\`.\n`;
  }
  try { await sessionCreate(jobId, agentId, dpId); } catch (e) { return `[branch_a2a_cli] ERROR: okx-a2a session create failed: ${e.message}\n`; }
  try { await sessionSend(jobId, dpId, SKILL_PREFETCH); } catch (e) { return `[branch_a2a_cli] ERROR: okx-a2a session send (SKILL_PREFETCH) failed: ${e.message}\n`; }
  // B-Step 1.6 — upload + forward pending attachments (best effort; owned by flow_lifecycle).
  const { uploadAndForwardAllAttachments } = await import('../flow-lifecycle/manage.mjs');
  try { await uploadAndForwardAllAttachments(jobId, agentId, dpId); } catch {}
  return undefined;
}

// upstream: designated.rs::branch_error
export function branchError(jobId, agentId, shortId, dpId) {
  const notProvider = notProviderUserPrompt(jobId, shortId, dpId);
  const providerOffline = providerOfflineUserPrompt(jobId, shortId, dpId);
  const serviceNotFound = `[Job ${shortId} — you are the User Agent] The previously selected registered service of ASP (agentId=${dpId}) is no longer usable. Choose next step:\nA. Specify another ASP — provide the agentId\nB. Make the job public — let more ASPs discover it\nC. Close the job`;
  const blockService = requestCommandBlock(jobId, 'user', agentId, dpId, serviceNotFound, `[Service gone ${shortId}] next-step decision`, 'service_not_found');
  const blockNotProvider = requestCommandBlock(jobId, 'user', agentId, dpId, notProvider, `[Not ASP ${shortId}] next-step decision`, 'not_provider');
  const blockOffline = requestCommandBlock(jobId, 'user', agentId, dpId, providerOffline, `[Offline ${shortId}] next-step decision`, 'provider_offline');
  const endTurn = "  -> **end this turn** and wait for the user's reply.\n\n";
  return `[Designated ASP route: error] ASP ${dpId} encountered a routing error.\n[Role] User (User)\n\n`
    + '**Branch by `errorType` from the `designated-route` response above (earlier in this turn):**\n\n'
    + '- **`errorType == "service_not_found"`** -> the selected registered service is no longer available.\n'
    + `  ${blockService}\n${endTurn}`
    + '- **`errorType == "not_provider"`** -> the designated agent does not exist or is not registered as an ASP.\n'
    + `  ${blockNotProvider}\n${endTurn}`
    + '- **`errorType == "offline"`** -> the ASP is offline and cannot negotiate.\n'
    + `  ${blockOffline}\n${endTurn}`;
}
