// Subscription lifecycle event handlers (user side) — upstream task/user/flow_lifecycle/subscription.rs.
// (The private, caller-less `build_auto_rating_block` / `build_deliverable_sample` helpers are not ported.)
import { displayTop } from '../../../../wallet/api.mjs';
import { get, asStr, asI64, parseI64, trim, debugOptInt } from '../../../_rs.mjs';
import * as okxA2a from '../../common/okx-a2a.mjs';
import { queryXlayerBalance } from '../../common/util.mjs';
import { TaskApiClient } from '../../common/network/task-api-client.mjs';
import { selectSubscriptionAgentId } from '../../common/subscription-identity.mjs';
import { resolveWalletByAgentId } from '../../signing.mjs';
import { verifyFinalRefundEvent } from '../refund.mjs';
import { SUBSCRIBE_API_PREFIX } from '../create-subscribe.mjs';
import { notifyAndEnd, notifyAndEndTerminal, notifyAndEndWithDeposit } from '../flow.mjs';
import { content as loadContent } from './_peers.mjs';
import { uploadAndForwardAllAttachments } from './manage.mjs';

const fmt = (v, spec) => (spec === '?' ? debugOptInt(v) : String(v));
const isSome = (v) => v !== null && v !== undefined;

// upstream: subscription.rs::extract_str
function extractStr(message, key) {
  const s = asStr(get(message, key));
  return s !== undefined && s !== '' ? s : undefined;
}
// upstream: subscription.rs::extract_i64
const extractI64 = (message, key) => asI64(get(message, key) ?? null);

// upstream: subscription.rs::service_name
function serviceName(message, ctx) {
  const p = ctx.prefetched;
  return extractStr(message, 'serviceName') ?? p?.serviceName ?? extractStr(message, 'jobTitle') ?? extractStr(message, 'title')
    ?? (p && p.title !== '' ? p.title : undefined) ?? 'subscription';
}
// upstream: subscription.rs::refund_provider
function refundProvider(ctx) {
  const name = ctx.prefetched?.providerName ?? null, id = ctx.prefetched?.providerAgentId ?? null;
  if (isSome(name) && isSome(id)) return `${name} (${id})`;
  if (isSome(name)) return name;
  if (isSome(id)) return `name unavailable (${id})`;
  return 'not provided by the final event';
}
// upstream: subscription.rs::refund_amount
function refundAmount(ctx) {
  const p = ctx.prefetched;
  const amount = p && p.tokenAmount !== '' ? p.tokenAmount : undefined;
  const symbol = p && p.tokenSymbol !== '' && p.tokenSymbol !== '?' ? p.tokenSymbol : undefined;
  if (amount !== undefined && symbol !== undefined) return `${amount} ${symbol}`;
  if (amount !== undefined) return `${amount} (token symbol unavailable)`;
  return 'not provided by the final event';
}
// upstream: subscription.rs::incomplete_subscription_refund_notice
function incompleteSubscriptionRefundNotice(ctx, _message) {
  const p = ctx.prefetched;
  const t = p ? trim(p.title) : '';
  const $0 = t !== '' ? t : 'Subscription title unavailable';
  const $1 = ctx.jobId, $2 = refundProvider(ctx), $3 = p?.serviceName ?? p?.serviceId ?? 'unverified', $4 = refundAmount(ctx);
  return `[Refund Settlement Detail Incomplete] ${$0} (\`${$1}\`)\n`
  + `- Refund ASP: ${$2}\n`
  + `- Service: ${$3}\n`
  + `- Refund amount: ${$4}\n`
  + `- Tx Hash: unavailable\n`
  + `The subscription lifecycle result or refund cause is incomplete or ambiguous. Do not report the refund as complete; refresh Refund status.`;
}
// upstream: subscription.rs::event_job_type
function eventJobType(message) {
  const v = get(message, 'jobType');
  if (v === undefined) return undefined;
  return asI64(v) ?? (asStr(v) === undefined ? undefined : parseI64(asStr(v)));
}
// upstream: subscription.rs::subscription_terminal_context_block_reason
function subscriptionTerminalContextBlockReason(ctx, message, event) {
  const detail = ctx.prefetched;
  if (!detail) return `[${event}] fresh composed subscription detail is missing; do not notify or clean up from caller-supplied event data.`;
  if (!(isSome(detail.jobType) && Number(detail.jobType) === 1)) { const $0 = detail.jobType; return `[${event}] fresh detail jobType ${fmt($0, "?")} is not subscription(1); do not notify or clean up from a task-type-mismatched event.`; }
  const ejt = eventJobType(message);
  if (ejt !== undefined && Number(ejt) !== 1) return `[${event}] event jobType conflicts with fresh subscription detail; do not notify or clean up.`;
  if (detail.userAgentId !== ctx.agentId) { const $0 = ctx.agentId; return `[${event}] fresh subscription detail is not owned by User Agent ${$0}; do not notify or clean up.`; }
  return undefined;
}

const tokenAmountOf = (message, ctx) => { const v = extractStr(message, 'tokenAmount') ?? ctx.prefetched?.tokenAmount; return v !== undefined && v !== '' ? v : undefined; };
const tokenSymbolOf = (message, ctx) => { const v = extractStr(message, 'tokenSymbol') ?? ctx.prefetched?.tokenSymbol; return v !== undefined && v !== '' && v !== '?' ? v : undefined; };

// upstream: subscription.rs::sub_open
export async function subOpen(ctx, message) {
  const c = await loadContent();
  const amount = tokenAmountOf(message, ctx), symbol = tokenSymbolOf(message, ctx);
  const text = extractI64(message, 'trialType') === 1
    ? c.subOpenTrialUserNotify(ctx.jobId, serviceName(message, ctx), amount, symbol)
    : c.subOpenUserNotify(ctx.jobId, serviceName(message, ctx), amount, symbol);
  const providerId = extractStr(message, 'providerAgentId') ?? ctx.prefetched?.providerAgentId ?? undefined;
  const sessionBlock = providerId !== undefined && providerId !== null ? await createSubSession(ctx.jobId, ctx.agentId, providerId) : `[sub_open] providerAgentId missing from event and task detail; session was not created.\n`;
  const content = text;
  return `**Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content shown below>"\n`
  + `\`\`\`\n`
  + `Content: ${content}\n`
  + `\n`
  + `${sessionBlock}**End this turn** after the notification is sent.\n`;
}

// upstream: subscription.rs::sub_created
export async function subCreated(ctx, message) {
  const c = await loadContent();
  const amount = tokenAmountOf(message, ctx), symbol = tokenSymbolOf(message, ctx);
  let text;
  if (extractI64(message, 'trialType') === 1) {
    text = c.subCreatedTrialUserNotify(ctx.jobId, amount, symbol, extractI64(message, 'trialStartTime') ?? extractI64(message, 'trailStartTime'),
      extractI64(message, 'trialEndTime') ?? extractI64(message, 'trailEndTime'));
  } else {
    const autoRenew = (asI64(get(message, 'autoRenew') ?? null) ?? 0) === 1;
    text = c.subCreatedUserNotify(ctx.jobId, serviceName(message, ctx), amount, symbol, extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'), autoRenew);
  }
  const content = text;
  return `**Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content shown below>"\n`
  + `\`\`\`\n`
  + `Content: ${content}\n`
  + `\n` + `**End this turn** after the notification is sent.\n`;
}

// upstream: subscription.rs::sub_asp_selected
export const subAspSelected = (_ctx, _message) => `[Subscription event] sub_asp_selected is ASP-side only; ignore it on the Buyer side.\n`;

// upstream: subscription.rs::create_sub_session → '' on success, error line otherwise
async function createSubSession(jobId, agentId, providerId) {
  let exists;
  try { exists = await okxA2a.sessionQueryExists(jobId, agentId, providerId); } catch (err) { const e = displayTop(err); return `[sub_open] session query failed: ${e}\n`; }
  if (exists) { await uploadAndForwardAllAttachments(jobId, agentId, providerId); return ''; }
  try { await okxA2a.sessionCreate(jobId, agentId, providerId); } catch (err) { const e = displayTop(err); return `[sub_open] session create failed: ${e}\n`; }
  const prefetch = `[SKILL_PREFETCH] Read the okx-ai skill through skills/okx-ai/SKILL.md. Pre-load user role context. This prefetch message itself requires no action — but when the NEXT inbound message arrives (same turn or later turn), you MUST re-enter through that SKILL.md and follow its Top-level routing for the exact envelope shape. Do NOT carry over "no action" to business messages.`;
  try { await okxA2a.sessionSend(jobId, providerId, prefetch); } catch (err) { const e = displayTop(err); return `[sub_open] session send (SKILL_PREFETCH) failed: ${e}\n`; }
  await uploadAndForwardAllAttachments(jobId, agentId, providerId);
  return '';
}

// upstream: subscription.rs::sub_cancel
export async function subCancel(ctx, message) {
  const cancelResult = extractStr(message, 'cancelResult');
  const failReason = extractStr(message, 'failReason') ?? extractStr(message, 'failReasopn');
  const trialType = extractI64(message, 'trialType');
  const text = (await loadContent()).subCancelUserNotify(cancelResult, failReason, trialType, serviceName(message, ctx), ctx.jobId, extractI64(message, 'subEndTime'));
  if (cancelResult !== 'fail' && trialType === 1) return notifyAndEndTerminal(text, ctx.terminalSessionHint);
  return notifyAndEnd(text);
}

// upstream: subscription.rs::sub_user_reject
export async function subUserReject(ctx, message) {
  const text = (await loadContent()).subUserRejectUserNotify(serviceName(message, ctx), extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'),
    extractI64(message, 'rejectWindowEndsAt'), extractStr(message, 'tokenAmount'), extractStr(message, 'tokenSymbol'));
  return notifyAndEnd(text);
}

function settledAppendix(evidence) {
  const $0 = evidence.providerName, $1 = evidence.providerAgentId, $2 = evidence.serviceName, $3 = evidence.txHash ?? 'unavailable';
  return `\n`
  + `- Refund ASP: ${$0} (${$1})\n`
  + `- Service: ${$2}\n`
  + `- Tx Hash: ${$3}`;
}

// upstream: subscription.rs::sub_asp_agree
export async function subAspAgree(ctx, message) {
  const reason = subscriptionTerminalContextBlockReason(ctx, message, 'sub_asp_agree');
  if (reason !== undefined) return reason;
  let evidence;
  try { evidence = verifyFinalRefundEvent(message, ctx.prefetched, 9, ctx.agentId); } catch { return notifyAndEnd(incompleteSubscriptionRefundNotice(ctx, message)); }
  const $0 = (await loadContent()).subAspAgreeUserNotify(evidence.serviceName, evidence.amount, evidence.tokenSymbol, extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'));
  const text = `[Refund Settled] ${$0}` + settledAppendix(evidence);
  return notifyAndEndTerminal(text, ctx.terminalSessionHint);
}

// upstream: subscription.rs::sub_asp_dispute
export async function subAspDispute(ctx, message) {
  const { jobId, agentId, titleQueryHint } = ctx;
  const svc = serviceName(message, ctx);
  const providerId = ctx.prefetched?.providerAgentId;
  if (providerId === undefined || providerId === null || providerId === '') return `[sub_asp_dispute] prefetched.provider_agent_id missing for job ${jobId}; cannot fetch chat history for evaluation evidence.\n`
  + `\n`
  + `Enter through \`skills/okx-ai/SKILL.md\`, then see \`skills/okx-ai/references/runtime/recovery.md\` §2 — push \`cli_failed\` decision.\n`;
  let chatBlock;
  try {
    const raw = await okxA2a.sessionHistory(jobId, providerId);
    const t = trim(raw);
    chatBlock = t === '' || t === '[]' ? '(no chat history available)' : t;
  } catch (err) { const e = displayTop(err); return `[sub_asp_dispute] \`okx-a2a session history\` failed: ${e}\n`
  + `\n`
  + `Enter through \`skills/okx-ai/SKILL.md\`, then see \`skills/okx-ai/references/runtime/recovery.md\` §2 — push \`cli_failed\` decision.\n`; }
  const notifyContent = (await loadContent()).subAspDisputeUserNotify(svc, jobId, extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'));
  return `[Current Status] sub_asp_dispute (subscription evaluation opened; CLI auto-submits evidence on this event)\n`
  + `[Role] User Agent\n`
  + `\n`
  + `**This event triggers an AUTOMATIC evidence upload — no user interaction**.\n`
  + `The agent does NOT ask the user for evidence; it formats the chat history, calls \`dispute upload\`\n`
  + `(which also auto-attaches the most recent 20 saved deliverables from \`~/.onchainos/deliverables/user/${jobId}/\`),\n`
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
  + `Keep ONLY the key checkpoints — subscription scope discussion / deliverable messages + both sides' key evaluation points. Prepend \`(key checkpoints extracted)\` so the evaluator knows it was trimmed. If history is genuinely empty, pass a minimal placeholder like \`(no chat history available)\`.\n`
  + `\n`
  + `**Step 3 — Upload (off-chain multipart):**\n`
  + `\`\`\`bash\n`
  + `onchainos agent dispute upload ${jobId} --role user --agent-id ${agentId} --max-files 20 --text "<chat history block from Step 2>"\n`
  + `\`\`\`\n`
  + `The CLI auto-attaches the most recent 20 entries under \`~/.onchainos/deliverables/user/${jobId}/manifest.json\` as multipart \`files[]\` parts — **do NOT pass \`--file\`**; the manifest covers all locally-saved deliverables. If the upload fails, retry up to 3 times; if it keeps failing, still proceed to Step 4 — the on-chain evaluation will continue with the available evidence.\n`
  + `\n`
  + `**Step 4 — Notify the user via \`onchainos agent user-notify\` (after upload returns):**\n`
  + `**Localize first** — translate the content below into the user's language before sending.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content>"\n`
  + `\`\`\`\n`
  + `Content:\n`
  + `    ${notifyContent}\n`
  + `\n`
  + `**Step 5 — End this turn.** Do NOT send any message to the ASP.\n`
  + `\n`;
}

// upstream: subscription.rs::sub_trial_into_active
export async function subTrialIntoActive(ctx, message) {
  const text = (await loadContent()).subTrialIntoActiveUserNotify(ctx.jobId, serviceName(message, ctx), extractStr(message, 'tokenAmount'), extractStr(message, 'tokenSymbol'),
    extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'));
  return notifyAndEnd(text);
}

// Rust `str::parse::<f64>()` (no trimming): accepts digits, '.', exponent, sign, inf/infinity/nan.
function parseRustF64Opt(s) {
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined;
  return Number(s);
}

// upstream: subscription.rs::sub_renew
export async function subRenew(ctx, message) {
  const renewResult = extractStr(message, 'renewResult');
  const failReason = extractStr(message, 'failReason') ?? extractStr(message, 'failReasopn');
  const text = (await loadContent()).subRenewUserNotify(renewResult, failReason, serviceName(message, ctx), ctx.jobId, extractStr(message, 'tokenAmount'),
    extractStr(message, 'tokenSymbol'), extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'), extractI64(message, 'subBufferEndTime'));
  if (renewResult === 'fail') {
    const symbol = extractStr(message, 'tokenSymbol'), amountStr = extractStr(message, 'tokenAmount');
    if (symbol !== undefined && amountStr !== undefined) {
      const required = parseRustF64Opt(amountStr);
      if (required !== undefined && required > 0) {
        let wallet;
        try { wallet = await resolveWalletByAgentId(ctx.agentId); } catch { wallet = undefined; }
        if (wallet && wallet[1] !== '') {
          let low;
          try { low = (await queryXlayerBalance(wallet[1], symbol)) < required; } catch { low = true; }
          if (low) return notifyAndEndWithDeposit(text, wallet[1]);
        }
      }
    }
  }
  return notifyAndEnd(text);
}

// upstream: subscription.rs::select_sub_expire_warn_content
export async function selectSubExpireWarnContent(autoRenew, jobId, periodStart, periodEnd) {
  const c = await loadContent();
  return autoRenew !== undefined && autoRenew !== null && Number(autoRenew) === 0
    ? c.subExpireWarnNoAutorenewNotify(jobId, periodStart, periodEnd) : c.subExpireWarnUserNotify(jobId);
}
// upstream: subscription.rs::sub_expire_warn_renewal_hint
export function subExpireWarnRenewalHint(autoRenew, jobId) {
  return autoRenew !== undefined && autoRenew !== null && Number(autoRenew) === 0 ? `Auto-renewal is **off**. To enable it before expiry:\n`
  + `\`\`\`bash\n`
  + `onchainos agent start-autorenew ${jobId}\n`
  + `\`\`\`` : `No action needed unless you want to cancel.`;
}
// upstream: subscription.rs::as_epoch_secs
function asEpochSecs(v, key) {
  const x = get(v, key);
  if (x === undefined) return undefined;
  return asI64(x) ?? (asStr(x) === undefined ? undefined : parseI64(asStr(x)));
}

// upstream: subscription.rs::sub_expire_warn
export async function subExpireWarn(ctx) {
  const { jobId, agentId } = ctx;
  let detail;
  try {
    const agent = selectSubscriptionAgentId(agentId, '');
    const client = new TaskApiClient();
    detail = { ok: await client.getWithIdentity(`${SUBSCRIBE_API_PREFIX}/${jobId}`, agent) };
  } catch (e) { detail = { err: e }; }
  const autoRenew = detail.ok !== undefined ? asI64(get(detail.ok, 'autoRenew') ?? null) : undefined;
  const periodStart = detail.ok !== undefined ? asEpochSecs(detail.ok, 'subStartTime') : undefined;
  const periodEnd = detail.ok !== undefined ? asEpochSecs(detail.ok, 'subEndTime') : undefined;
  const c = await loadContent();
  const content = await selectSubExpireWarnContent(autoRenew, jobId, c.fmtEpoch(periodStart) ?? '', c.fmtEpoch(periodEnd) ?? '');
  const renewalHint = subExpireWarnRenewalHint(autoRenew, jobId);
  return `**Localize first** — rewrite the content below in the user's language before sending.\n`
  + `\`\`\`bash\n`
  + `onchainos agent user-notify --content "<localized content shown below>"\n`
  + `\`\`\`\n`
  + `Content: ${content}\n`
  + `\n`
  + `${renewalHint}\n`
  + `\n`
  + `End turn after notification.\n`;
}

// upstream: subscription.rs::sub_close_notify
export async function subCloseNotify(ctx, message) {
  const aspRejectReason = extractStr(message, 'aspRejectReason');
  let text = (await loadContent()).subCloseNotifyUserNotify(serviceName(message, ctx), ctx.jobId, extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'), aspRejectReason);
  if (aspRejectReason === undefined) text += `\n`
  + `\n`
  + `The subscription is authoritatively Closed, but the current backend contract does not expose an authoritative refund cause for this close. No refund completion is claimed.`;
  const $0 = ctx.jobId;
  text += `\n`
  + `\n`
  + `Reconcile through \`onchainos agent refund-prepare ${$0}\` and follow only its returned actions.`;
  return notifyAndEnd(text);
}

// upstream: subscription.rs::sub_reject_refund_notify
export async function subRejectRefundNotify(ctx, message) {
  const reason = subscriptionTerminalContextBlockReason(ctx, message, 'sub_reject_refund_notify');
  if (reason !== undefined) return reason;
  let evidence;
  try { evidence = verifyFinalRefundEvent(message, ctx.prefetched, 9, ctx.agentId); } catch { return notifyAndEnd(incompleteSubscriptionRefundNotice(ctx, message)); }
  const $0 = (await loadContent()).subRejectRefundNotifyUser(evidence.serviceName, extractI64(message, 'subStartTime'), extractI64(message, 'subEndTime'),
    extractI64(message, 'rejectWindowEndsAt'), evidence.amount, evidence.tokenSymbol);
  const text = `[Auto-Refund Settled] ${$0}` + settledAppendix(evidence);
  return notifyAndEndTerminal(text, ctx.terminalSessionHint);
}

// upstream: subscription.rs::sub_failed_notify
export async function subFailedNotify(ctx, message) {
  const reason = subscriptionTerminalContextBlockReason(ctx, message, 'sub_failed_notify');
  if (reason !== undefined) return reason;
  const detail = ctx.prefetched;
  if (!(isSome(detail.status) && Number(detail.status) === 9)) { const $0 = detail.status; return `[sub_failed_notify] fresh subscription status ${fmt($0, "?")} is not Failed(9); do not notify or clean up from a stale event.`; }
  if (detail.refundRequestProvenance) {
    const $0 = incompleteSubscriptionRefundNotice(ctx, message), $1 = ctx.jobId;
    return notifyAndEnd(`${$0}\n`
  + `\n`
  + `[Refund reconciliation pending] This device has a durable Refund request receipt for the subscription, so \`sub_failed_notify\` cannot be treated as a generic charge failure. Do not report either refund completion or charge failure from this event. Run \`onchainos agent refund-prepare ${$1}\` and follow its returned status/watch action.`);
  }
  const t = trim(detail.title);
  const $0 = t === '' ? 'Subscription title unavailable' : t, $1 = ctx.jobId, $2 = ctx.jobId;
  return notifyAndEnd(`[Subscription Result Needs Reconciliation] ${$0} (\`${$1}\`) is in fresh Failed(9) status, but the authoritative backend detail does not expose whether this was a refund or a charge/conversion failure. The caller-provided \`sub_failed_notify\` label and its reason fields are not trusted settlement evidence. Do not report either outcome and do not close the Buyer session. Run \`onchainos agent refund-prepare ${$2}\` and follow only its read/status/watch action.`);
}

