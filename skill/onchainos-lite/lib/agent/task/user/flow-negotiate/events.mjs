// Payment-mode / negotiation / provider-reject playbooks — upstream task/user/flow_negotiate/events.rs.
import { displayTop } from '../../../../wallet/api.mjs';
import { TaskApiClient } from '../../common/network/task-api-client.mjs';
import { requestCommandBlock } from '../../common/pending-v2.mjs';
import { paymentModeEscrowUserNotify } from '../content.mjs';

const CLI_FAILED_HINT = 'Push a `cli_failed` decision to the user via `pending-decisions-v2 request` (enter through `skills/okx-ai/SKILL.md`, then see `skills/okx-ai/references/runtime/recovery.md` §2). Do NOT retry blindly.\n';

// upstream: events.rs::job_payment_mode_changed
export function jobPaymentModeChanged(ctx) {
  if (ctx.paymentMode !== undefined && ctx.paymentMode !== null && Number(ctx.paymentMode) === 3) {
    return '[Legacy A2MCP Task payment] This path was removed. Do not sign, replay, or continue this Task flow; restart from an upstream invoke_a2mcp event.\n';
  }
  return '[Current state] job_payment_mode_changed (A2A escrow is on-chain)\n[Role] User Agent\n\n'
    + 'Notify the user via `onchainos agent user-notify`, using this localized template:\n'
    + `${paymentModeEscrowUserNotify(ctx.jobId, ctx.titleDisplay)}\n\n`
    + 'End this turn and wait for provider_applied.\n';
}

// upstream: events.rs::negotiate_reply
export async function negotiateReply(ctx) {
  const { jobId, agentId } = ctx;
  const p = ctx.prefetched;
  if (!p) return `[negotiate_reply] ❌ no prefetched task context for job ${jobId}; cannot resolve providerAgentId.\n\n${CLI_FAILED_HINT}`;
  const provider = p.providerAgentId;
  if (provider === undefined || provider === null || provider === '') {
    return `[negotiate_reply] ❌ prefetched task context has no providerAgentId for job ${jobId}; cannot send a reply.\n\n${CLI_FAILED_HINT}`;
  }
  const desc = p.description === '' ? '(missing)' : p.description;
  const priceRule = '🛑 **Price is locked**: do NOT discuss tokenAmount / tokenSymbol / paymentMode / budget with the ASP. Price was determined by the service listing at creation time and is locked at accept.\n\n';
  const taskBlock = `**Task fields (already fetched — do NOT call \`common context\`):**\n  • Title: ${p.title}\n  • Description: ${desc}\n${priceRule}`;
  const cmdNoAsp = `onchainos agent pending-decisions-v2 request --job-id ${jobId} --role user --agent-id ${agentId} --user-content "<compose from template below>" --list-label "[No ASP] negotiate timeout — next-step decision" --source-event no_asp_found`;
  const overLimit = '━━━━━━━━━ [Over-limit] 2-round limit exceeded or timeout ━━━━━━━━━\n\n'
    + '**Step 1** — mark this ASP as failed:\n'
    + `\`\`\`bash\nonchainos agent mark-failed ${jobId} --provider ${provider}\n\`\`\`\n\n`
    + '**Step 2** — push a decision card to the user:\n'
    + "**Localize first** — translate the `--user-content` and `--list-label` values below into the user's language before running.\n"
    + `\`\`\`bash\n${cmdNoAsp}\n\`\`\`\n`
    + '`--user-content` template:\n'
    + `Negotiation with ASP ${provider} did not reach agreement within 2 rounds.\n\n`
    + 'What would you like to do next?\nA. Browse the ASP list\nB. Designate a specific ASP by agentId\nC. Close the task\n\n'
    + '→ **End this turn.**\n';
  return `${taskBlock}[Negotiation] negotiate_reply (ASP sent a natural-language message)\n[Role] User (User)\n\n`
    + "**2-round limit**: count how many user replies (your `okx-a2a session send` calls) have already been sent in this sub session's conversation history.\n"
    + '- Rounds sent < 2 → reply normally (see below).\n'
    + '- Rounds sent ≥ 2 → negotiation exceeded the 2-round limit. **Do NOT reply.** Jump to **[Over-limit]** below.\n\n'
    + '**Reply about**: scope, requirements, deliverable format, timeline, clarifying questions.\n\n'
    + '🚫 **Forbidden in this event:**\n'
    + "  ❌ `onchainos agent user-notify` / `pending-decisions-v2 request` to ask the user about the ASP's message — negotiation is autonomous in this sub session.\n"
    + '  ❌ `set-payment-mode` / `confirm-accept` / `reject-apply` / `apply` — no on-chain action belongs in this event.\n\n'
    + '[Normal reply — single CLI call, then end the turn]\n\n'
    + `\`\`\`bash\nokx-a2a session send \\\n  --job-id ${jobId} \\\n  --to-agent-id ${provider} \\\n  --content '<natural-language reply, task details only — no price talk>' \\\n  --json\n\`\`\`\n\n`
    + '⏱ 5-minute timeout: if the ASP does not reply within 5 minutes, treat as over-limit (see below).\n\n'
    + overLimit;
}

// upstream: events.rs::provider_reject — STATE-CHANGING: POST /priapi/v1/aieco/task/{jobId}/reset/asp.
export async function providerReject(ctx) {
  const { jobId, agentId, shortId } = ctx;
  const client = new TaskApiClient();
  try { await client.postWithIdentity(client.endpoint(jobId, 'reset/asp'), {}, agentId); } catch (e) {
    return `[job_provider_reject] ❌ POST reset/asp failed: ${displayTop(e)}\n\n`
      + 'Enter through `skills/okx-ai/SKILL.md`, then see `skills/okx-ai/references/runtime/recovery.md` §2 — push `cli_failed` decision.\n';
  }
  const userContent = `[Job ${shortId} — you are the User Agent] ASP declined to take this task. What would you like to do next?\n\nA. Browse the ASP list\nB. Designate a specific ASP by agentId\nC. Close the task`;
  const block = requestCommandBlock(jobId, 'user', agentId, undefined, userContent, `[Reject ${shortId}] next-step decision`, 'job_provider_reject');
  return '[job_provider_reject] ✅ ASP binding reset (reset/asp) completed in-process.\n\n'
    + `**Localize first** — translate the \`--user-content\` value below into the user's language before executing. Keep \`[Job ${shortId}]\` prefix and \`A.\` / \`B.\` / \`C.\` option letters unchanged.\n\n`
    + '🛑 Push the next-step decision card via `pending-decisions-v2 request`, then end turn.\n\n'
    + `${block}\n`;
}
