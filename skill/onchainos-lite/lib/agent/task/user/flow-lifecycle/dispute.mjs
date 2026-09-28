// Rejection / evaluation prompt generators — upstream task/user/flow_lifecycle/dispute.rs.
import { displayTop } from '../../../../wallet/api.mjs';
import { get, asStr, asI64, parseI64, trim, debugOptInt } from '../../../_rs.mjs';
import { TERMINAL_NOTIFICATION_MARKER } from '../../common/index.mjs';
import * as okxA2a from '../../common/okx-a2a.mjs';
import { verifyFinalRefundEvent } from '../refund.mjs';
import { notifyAndEnd } from '../flow.mjs';
import { content } from './_peers.mjs';

const fmt = (v, spec) => (spec === '?' ? debugOptInt(v) : String(v));
const isSome = (v) => v !== null && v !== undefined;

// upstream: dispute.rs::event_job_type
function eventJobType(message) {
  const v = get(message, 'jobType');
  if (v === undefined) return undefined;
  return asI64(v) ?? (asStr(v) === undefined ? undefined : parseI64(asStr(v)));
}

// upstream: dispute.rs::job_rejected
export async function jobRejected(ctx) {
  return notifyAndEnd((await content()).jobRejectedUserNotify(ctx.jobId, ctx.titleDisplay));
}

// upstream: dispute.rs::job_disputed
export async function jobDisputed(ctx) {
  const { jobId, agentId, titleDisplay, titleQueryHint } = ctx;
  const providerId = ctx.prefetched && ctx.prefetched.providerAgentId ? ctx.prefetched.providerAgentId : undefined;
  if (providerId === undefined) return `[job_disputed] prefetched.provider_agent_id missing for job ${jobId}; cannot fetch chat history for evaluation evidence.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  let chatBlock;
  try {
    const raw = await okxA2a.sessionHistory(jobId, providerId);
    const trimmed = trim(raw);
    chatBlock = trimmed === '' || trimmed === '[]' ? '(no chat history available)' : trimmed;
  } catch (err) {
    const e = displayTop(err);
    return `[job_disputed] \`okx-a2a session history\` failed: ${e}\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  }
  return `[Current Status] job_disputed (evaluation opened; CLI auto-submits evidence on this event)\n`
  + `[Role] User Agent\n`
  + `\n`
  + `**This event triggers an AUTOMATIC evidence upload — no user interaction**.\n`
  + `The agent does NOT ask the user for evidence; it formats the chat history, calls \`dispute upload\`\n`
  + `(which also auto-attaches every saved deliverable from \`~/.onchainos/deliverables/user/${jobId}/\`),\n`
  + `and then notifies the user via \`onchainos agent user-notify\`. **Do NOT** use \`pending-decisions-v2 request\`\n`
  + `for this event. **Do NOT** send any message to the ASP — both sides see the evaluation via on-chain events.\n`
  + `\n`
  + `[Your next actions (strict order)]\n`
  + `\n`
  + `${titleQueryHint}**Step 1 — Chat history (pre-fetched and inlined below; do NOT call \`okx-a2a session history\` again):**\n`
  + `\n`
  + `\`\`\`\n`
  + `==== Negotiation / delivery chat history ====\n`
  + `${chatBlock}\n`
  + `\`\`\`\n`
  + `\n`
  + `**Step 2 — Extract a \`--text\` body from the chat history above** (≤16 KB):\n`
  + `Keep ONLY the key checkpoints — task-detail discussion / deliverable messages + both sides' key evaluation points. Prepend \`(key checkpoints extracted)\` so the evaluator knows it was trimmed. If history is genuinely empty, pass a minimal placeholder like \`(no chat history available)\`.\n`
  + `\n`
  + `**Step 3 — Upload (off-chain multipart):**\n`
  + `\`\`\`bash\n`
  + `onchainos agent dispute upload ${jobId} --role user --agent-id ${agentId} --text "<chat history block from Step 2>"\n`
  + `\`\`\`\n`
  + `The CLI auto-attaches every entry under \`~/.onchainos/deliverables/user/${jobId}/manifest.json\` as multipart \`files[]\` parts — **do NOT pass \`--file\`**; the manifest covers all locally-saved deliverables / attachments. If the upload fails, retry up to 3 times; if it keeps failing, still proceed to Step 4 — the on-chain evaluation will continue with the available evidence.\n`
  + `\n`
  + `**Step 4 — Notify the user via \`onchainos agent user-notify\` (after upload returns):**\n`
  + `**Localize first** — translate the content below into the user's language before sending.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content>"\n`
  + `\`\`\`\n`
  + `Content:\n`
  + `    [Evaluation opened] Evaluation for **${titleDisplay}** (\`${jobId}\`) is on-chain.\n`
  + `    - Evaluation status: Evidence preparation\n`
  + `    - Status description: Evidence was submitted and the evidence stage is in progress.\n`
  + `    Awaiting the evaluator's verdict.\n`
  + `\n`
  + `**Step 5 — End this turn.** Do NOT send any message to the ASP.\n`
  + `\n`;
}

// upstream: dispute.rs::dispute_resolved
export async function disputeResolved(ctx, message) {
  const { jobId, agentId, terminalSessionHint } = ctx;
  const p = ctx.prefetched;
  if (!p) return `[dispute_resolved] no prefetched task context for job ${jobId}; cannot decide winner.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  if (!(isSome(p.jobType) && [0, 1].includes(Number(p.jobType)))) { const $0 = p.jobType; return `[dispute_resolved] fresh detail has unsupported or missing jobType ${fmt($0, "?")} for job ${jobId}; do not announce a verdict, rate, notify, or clean up.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`; }
  const ejt = eventJobType(message);
  if (ejt !== undefined && !(isSome(p.jobType) && BigInt(ejt) === BigInt(p.jobType))) return `[dispute_resolved] event jobType conflicts with fresh composed detail for job ${jobId}; do not announce a verdict, rate, notify, or clean up.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  if (p.userAgentId !== agentId) return `[dispute_resolved] fresh detail does not bind job ${jobId} to User Agent ${agentId}; do not announce a verdict, rate, notify, or clean up.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  let userWon;
  if (isSome(p.status) && Number(p.status) === 9) userWon = true;
  else if (isSome(p.status) && Number(p.status) === 6) userWon = false;
  else if (isSome(p.status)) { const other = p.status; return `[dispute_resolved] unexpected prefetched status ${other} for job ${jobId}; expected 6 (completed/ASP wins) or 9 (failed/user wins).\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`; }
  else return `[dispute_resolved] prefetched.status missing for job ${jobId}; cannot decide winner.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  if (!p.refundRequestProvenance) return `[dispute_resolved] fresh terminal status has no durable local refund-request provenance for job ${jobId}; do not treat an ordinary completion/failure as an evaluation verdict, rate, notify, or clean up. Run \`onchainos agent refund-prepare ${jobId}\` to reconcile.\n`;
  let refundEvidence;
  if (userWon) { try { refundEvidence = verifyFinalRefundEvent(message, p, 9, agentId); } catch { refundEvidence = undefined; } }
  if (userWon && refundEvidence === undefined) return `[dispute_resolved] fresh Failed(9) detail does not prove a buyer-owned refund outcome for job ${jobId}; do not announce a verdict, rate, notify, or clean up. Run \`onchainos agent refund-prepare ${jobId}\` to reconcile.\n`;
  const refundSettled = refundEvidence !== undefined;
  const providerId = p.providerAgentId !== null && p.providerAgentId !== undefined && p.providerAgentId !== '' ? p.providerAgentId : undefined;
  if (providerId === undefined) return `[dispute_resolved] prefetched.provider_agent_id missing for job ${jobId}; auto-rate cannot run.\n`
  + `\n`
  + `Enter through skills/okx-ai/SKILL.md, then see skills/okx-ai/references/runtime/recovery.md §2 — push \`cli_failed\` decision.\n`;
  const titleDisplay = trim(p.title) === '' ? 'Task title unavailable' : trim(p.title);
  const c = await content();
  const ratingNotify = c.ratingSubmittedUserNotify(jobId, titleDisplay);
  const providerName = p.providerName ?? null;
  const serviceName = p.serviceName ?? p.serviceId ?? 'service unavailable';
  const amount = p.tokenAmount !== '' ? p.tokenAmount : null;
  const symbol = p.tokenSymbol !== '' && p.tokenSymbol !== '?' ? p.tokenSymbol : null;
  const disputeWon = c.disputeWonUserNotify(jobId, titleDisplay, providerName, providerId, serviceName, amount, symbol, refundSettled, refundEvidence?.txHash ?? null);
  const disputeLost = c.disputeLostUserNotify(jobId, titleDisplay, providerName, providerId, serviceName, amount, symbol);
  const winnerLine = userWon ? `**Evaluation outcome: user WINS** (chain status = 9/failed).\n`
  + `\n` : `**Evaluation outcome: user LOSES** (chain status = 6/completed; ASP wins).\n`
  + `\n`;
  let dispatchContent;
  if (userWon && refundSettled) dispatchContent = `${TERMINAL_NOTIFICATION_MARKER} ${disputeWon}`;
  else if (userWon) dispatchContent = disputeWon;
  else dispatchContent = `${TERMINAL_NOTIFICATION_MARKER} ${disputeLost}`;
  const scoreGuide = userWon ? `provider at fault → 0.00–2.00` : `provider delivered adequately → 3.00–5.00`;
  const wrapUp = userWon && !refundSettled ? `Do not run terminal cleanup yet. Run \`onchainos agent refund-prepare ${jobId}\` to follow refund settlement, and follow only its returned actions.` : `${terminalSessionHint}\n`
  + `Evaluation flow fully complete.`;
  const title = p.title, amt = p.tokenAmount, sym = p.tokenSymbol;
  return `[Current Status] dispute_resolved (evaluation ruling issued)\n`
  + `[Role] User Agent\n`
  + `\n`
  + `**You MUST notify the user of the evaluation result + auto-rating in ONE consolidated message** — auto-rate FIRST, then send a single \`onchainos agent user-notify\` combining both pieces.\n`
  + `\n`
  + `${winnerLine}**Step 1 — Task fields (pre-fetched; do NOT call \`common context\`):**\n`
  + `  - title: ${title}\n`
  + `  - tokenAmount: ${amt} | tokenSymbol: ${sym}\n`
  + `  - providerAgentId: ${providerId}\n`
  + `\n`
  + `**Step 2 — Auto-rate the ASP FIRST (MANDATORY; must complete before Step 3):**\n`
  + `Based on the deliverable vs the task description, quality standards, and the evaluation outcome, generate:\n`
  + `  - Score: 0.00–5.00 (two decimal places). Guide: ${scoreGuide}. Adjust within the range based on specific circumstances.\n`
  + `  - Comment: one sentence, ≤100 characters, evaluating how well the deliverable matches the description.\n`
  + `Then execute:\n`
  + `\`\`\`bash\n`
  + `onchainos agent feedback-submit --agent-id ${providerId} --creator-id ${agentId} --score <X.XX> --task-id ${jobId} --description "<comment, ≤100 chars>"\n`
  + `\`\`\`\n`
  + `Record whether feedback-submit succeeded (output contains \`txHash\`) or failed; the result decides whether the rating half is included in Step 3.\n`
  + `\n`
  + `**Step 3 — Notify the user with a SINGLE consolidated message:**\n`
  + `**Localize first** — translate the human-readable content into the user's language. Preserve any exact ${TERMINAL_NOTIFICATION_MARKER} prefix.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content>"\n`
  + `\`\`\`\n`
  + `Compose by merging the two halves below (concatenate with two blank lines between them):\n`
  + `\n`
  + `▸ Evaluation outcome (always included):\n`
  + `  ${dispatchContent}\n`
  + `\n`
  + `▸ Rating info (include ONLY if Step 2's feedback-submit succeeded; if it failed, omit this entire half):\n`
  + `  ${ratingNotify}\n`
  + `  (fill \`<score>\` with the X.XX value used in Step 2, \`<description>\` with the comment from Step 2, \`<title>\` with the task title above)\n`
  + `\n`
  + `**Step 4 — Settlement-aware wrap-up:**\n`
  + `${wrapUp}\n`;
}
