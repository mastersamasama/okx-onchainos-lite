// Terminal states, timeouts, auto-completion, and fallback prompt generators — upstream
// task/user/flow_lifecycle/terminal.rs.
import { get, asStr, asI64, isNum, numText, parseI64, trim } from '../../../_rs.mjs';
import { requestCommandBlock } from '../../common/pending-v2.mjs';
import { verifyFinalRefundEvent, isZeroDecimal, authoritativeRefundSettlementConfirmed } from '../refund.mjs';
import { notifyAndEnd, notifyAndEndTerminal } from '../flow.mjs';
import { content } from './_peers.mjs';

const isSome = (v) => v !== null && v !== undefined;
const is = (v, n) => isSome(v) && Number(v) === n;

// upstream: terminal.rs::display_or_unavailable
const displayOrUnavailable = (v) => v ?? 'unavailable';
// upstream: terminal.rs::authoritative_title
function authoritativeTitle(ctx) {
  const t = ctx.prefetched ? trim(ctx.prefetched.title) : '';
  return t === '' ? 'Task title unavailable' : t;
}
// upstream: terminal.rs::message_text
function messageText(message, key) {
  const v = get(message, key);
  if (typeof v === 'string') return trim(v) !== '' ? trim(v) : undefined;
  return isNum(v) ? numText(v) : undefined;
}
// upstream: terminal.rs::message_i64
function messageI64(message, key) {
  const v = get(message, key);
  if (v === undefined) return undefined;
  return asI64(v) ?? (asStr(v) === undefined ? undefined : parseI64(asStr(v)));
}
// upstream: terminal.rs::service_name
function serviceName(ctx, message) {
  const s = ctx.prefetched?.serviceName;
  if (isSome(s) && trim(s) !== '') return trim(s);
  return messageText(message, 'serviceName') ?? authoritativeTitle(ctx);
}

// upstream: terminal.rs::final_refund_notice → [content, complete]
function finalRefundNotice(ctx, message, automatic, expectedStatus) {
  let verified, error;
  try { verified = verifyFinalRefundEvent(message, ctx.prefetched, expectedStatus, ctx.agentId); } catch (e) { error = e; }
  const p = ctx.prefetched;
  const providerId = p?.providerAgentId ?? null, providerName = p?.providerName ?? null;
  let provider;
  if (isSome(providerName) && isSome(providerId)) provider = `${providerName} (${providerId})`;
  else if (isSome(providerName)) provider = providerName;
  else if (isSome(providerId)) provider = `name unavailable (${providerId})`;
  else provider = 'not provided by the final event';
  let service = p?.serviceName ?? p?.serviceId ?? 'unverified';
  const amount = p && p.tokenAmount !== '' ? p.tokenAmount : undefined;
  const symbol = p && p.tokenSymbol !== '' && p.tokenSymbol !== '?' ? p.tokenSymbol : undefined;
  let amountDisplay;
  if (amount !== undefined && symbol !== undefined) amountDisplay = `${amount} ${symbol}`;
  else if (amount !== undefined) amountDisplay = `${amount} (token symbol unavailable)`;
  else amountDisplay = 'not provided by the final event';
  let txHash = null;
  if (verified) {
    provider = `${verified.providerName} (${verified.providerAgentId})`;
    service = verified.serviceName;
    amountDisplay = `${verified.amount} ${verified.tokenSymbol}`;
    txHash = verified.txHash;
  }
  const complete = verified !== undefined;
  const heading = complete ? (automatic ? '[Auto-Refund Settled]' : '[Refund Settled]') : '[Refund Settlement Detail Incomplete]';
  let status;
  if (complete) status = txHash !== null ? `Refund confirmed by the backend's on-chain lifecycle result and fresh task detail; funds returned to your wallet. The verified Tx Hash is shown above. This job is complete.` : `Refund confirmed by the backend's on-chain lifecycle result and fresh task detail; funds returned to your wallet. The backend did not expose the Tx Hash in the current response. This job is complete.`;
  else { const $0 = error.message; status = `Refund completion cannot be verified: ${$0}. Do not claim completion from this message; refresh Refund status.`; }
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId, $2 = displayOrUnavailable(txHash);
  return [`${heading} ${$0} (\`${$1}\`)\n`
  + `- Refund ASP: ${provider}\n`
  + `- Service: ${service}\n`
  + `- Refund amount: ${amountDisplay}\n`
  + `- Tx Hash: ${$2}\n`
  + `${status}`, complete];
}

// upstream: terminal.rs::notify_refund_result
const notifyRefundResult = (ctx, c, complete) => (complete ? notifyAndEndTerminal(c, ctx.terminalSessionHint) : notifyAndEnd(c));

// upstream: terminal.rs::job_refunded
export function jobRefunded(ctx, message) {
  const [c, complete] = finalRefundNotice(ctx, message, false, 9);
  return notifyRefundResult(ctx, c, complete);
}
// upstream: terminal.rs::job_auto_refunded
export function jobAutoRefunded(ctx, message) {
  const [c, complete] = finalRefundNotice(ctx, message, true, 9);
  return notifyRefundResult(ctx, c, complete);
}

// upstream: terminal.rs::expired_terminal_result
function expiredTerminalResult(ctx, cause) {
  const detail = ctx.prefetched;
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId;
  if (!detail) return notifyAndEnd(`[Expired Task Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative Expired(8) task detail is unavailable. Do not infer refund receipt or clean up from caller-supplied event data.`);
  if (!is(detail.status, 8) || detail.userAgentId !== ctx.agentId) return notifyAndEnd(`[Expired Task Detail Incomplete] ${$0} (\`${$1}\`): fresh task detail does not prove buyer-owned Expired(8). Do not infer refund receipt or clean up from caller-supplied event data.`);
  let trial;
  if (is(detail.jobType, 0)) trial = false;
  else if (is(detail.jobType, 1)) {
    if (is(detail.trialType, 0)) trial = false;
    else if (is(detail.trialType, 1)) trial = true;
    else return notifyAndEnd(`[Expired Task Detail Incomplete] ${$0} (\`${$1}\`): fresh subscription detail is missing a supported trialType. Do not infer that funds moved.`);
  } else return notifyAndEnd(`[Expired Task Detail Incomplete] ${$0} (\`${$1}\`): fresh task detail is missing a supported jobType. Do not infer that funds moved.`);
  const zeroAmount = isZeroDecimal(trim(detail.tokenAmount));
  if (trial || zeroAmount) {
    const noFunds = trial ? `This was a trial subscription, so no refundable escrow payment was collected.` : `The task had a zero payment amount, so no funds needed to be returned.`;
    return notifyAndEndTerminal(`[Job Expired] ${$0} (\`${$1}\`): ${cause}. ${noFunds} The task is complete and no buyer-side refund action is required.`, ctx.terminalSessionHint);
  }
  const [c, complete] = finalRefundNotice(ctx, null, true, 8);
  const contentText = c;
  return notifyRefundResult(ctx, `${contentText}\n- Timeout result: ${cause}`, complete);
}

// upstream: terminal.rs::job_expired
export const jobExpired = (ctx) => expiredTerminalResult(ctx, 'A task deadline elapsed');

// upstream: terminal.rs::job_asp_accept_expire
export async function jobAspAcceptExpire(ctx, message) {
  const detail = ctx.prefetched;
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId;
  if (!detail) return notifyAndEnd(`[ASP Acceptance Timeout Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative task detail does not prove buyer-owned Expired(8). Do not report refund settlement and do not initiate any buyer-side refund claim or finalization.`);
  if (!is(detail.status, 8) || detail.userAgentId !== ctx.agentId) return notifyAndEnd(`[ASP Acceptance Timeout Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative task detail does not prove buyer-owned Expired(8). Do not report refund settlement and do not initiate any buyer-side refund claim or finalization.`);
  let isSubscription, isTrial;
  if (is(detail.jobType, 0)) [isSubscription, isTrial] = [false, false];
  else if (is(detail.jobType, 1)) {
    if (is(detail.trialType, 0)) [isSubscription, isTrial] = [true, false];
    else if (is(detail.trialType, 1)) [isSubscription, isTrial] = [true, true];
    else return notifyAndEnd(`[ASP Acceptance Timeout Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative subscription detail is missing a supported trialType. Do not claim that refundable escrow was collected or returned.`);
  } else return notifyAndEnd(`[ASP Acceptance Timeout Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative task detail is missing a supported jobType. Do not render caller-provided display fields or report refund settlement.`);
  const svc = serviceName(ctx, message);
  const pn = isSome(detail.providerName) && trim(detail.providerName) !== '' ? trim(detail.providerName) : 'name unavailable';
  const pid = isSome(detail.providerAgentId) && trim(detail.providerAgentId) !== '' ? trim(detail.providerAgentId) : 'unavailable';
  const amount = trim(detail.tokenAmount);
  const tokenSymbol = trim(detail.tokenSymbol);
  const paidRefundConfirmed = authoritativeRefundSettlementConfirmed(detail, 8);
  const zeroAmount = isZeroDecimal(amount);
  if (!isTrial && !zeroAmount && !paidRefundConfirmed) { const $0 = ctx.jobId; return notifyAndEnd(`[ASP Acceptance Timeout Detail Incomplete] Job \`${$0}\` has fresh buyer-owned Expired(8), but its original payment amount is invalid. Do not substitute caller-provided fields or report a refund amount.`); }
  const c = (await content()).jobAspAcceptExpireUserNotify(ctx.jobId, svc, isSubscription, pn, pid, amount === '' ? 'unavailable' : amount,
    tokenSymbol === '' || tokenSymbol === '?' ? 'token symbol unavailable' : tokenSymbol, !zeroAmount, isTrial);
  return notifyAndEndTerminal(c, ctx.terminalSessionHint);
}

// upstream: terminal.rs::job_asp_reject_expire
export async function jobAspRejectExpire(ctx, message) {
  const d = ctx.prefetched;
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId;
  if (d && is(d.status, 9) && d.userAgentId === ctx.agentId && is(d.jobType, 0) && isZeroDecimal(trim(d.tokenAmount))) {
    const rr = isSome(d.refundReason) && trim(d.refundReason) !== '' ? trim(d.refundReason) : undefined;
    const $2 = rr ?? messageText(message, 'rejectReason') ?? messageText(message, 'reason') ?? 'Not provided';
    return notifyAndEndTerminal(`[Task Failed] ${$0} (\`${$1}\`): the rejection is confirmed and this free one-time task has ended.\n`
  + `- Rejection reason: ${$2}\n`
  + `- Refund: Not required (payment amount was 0)\n`
  + `No refund reconciliation or platform evaluation is required.`, ctx.terminalSessionHint);
  }
  const complete = !!d && is(d.status, 9) && d.userAgentId === ctx.agentId && d.refundRequestProvenance;
  if (!complete) { const $2 = ctx.jobId; return notifyAndEnd(`[Automatic Refund Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative detail does not combine buyer-owned Failed(9) with the durable local request-refund provenance for this task. Do not report refund completion or clean up the session. Run \`onchainos agent refund-prepare ${$2}\` to reconcile.`); }
  let isSubscription;
  if (is(d.jobType, 0)) isSubscription = false;
  else if (is(d.jobType, 1)) isSubscription = true;
  else return notifyAndEnd(`[Automatic Refund Detail Incomplete] ${$0} (\`${$1}\`): fresh task detail is missing a supported jobType.`);
  const amount = trim(d.tokenAmount);
  const tokenSymbol = trim(d.tokenSymbol);
  const c = (await content()).jobAspRejectExpireUserNotify(ctx.jobId, serviceName(ctx, message), amount, tokenSymbol, messageI64(message, 'rejectWindowEndsAt'),
    isSubscription, !isZeroDecimal(amount));
  return notifyAndEndTerminal(c, ctx.terminalSessionHint);
}

// upstream: terminal.rs::job_asp_reject_closed
export async function jobAspRejectClosed(ctx, message) {
  const detail = ctx.prefetched;
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId;
  if (!detail) return notifyAndEnd(`[Job Close Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative detail is unavailable.`);
  if (!is(detail.status, 7) || detail.userAgentId !== ctx.agentId) return notifyAndEnd(`[Job Close Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative detail does not prove Closed(7) ownership by the current User Agent.`);
  const svc = serviceName(ctx, message);
  const amount = trim(detail.tokenAmount);
  const tokenSymbol = trim(detail.tokenSymbol);
  const pn = isSome(detail.providerName) && trim(detail.providerName) !== '' ? trim(detail.providerName) : 'ASP';
  const pid = isSome(detail.providerAgentId) && trim(detail.providerAgentId) !== '' ? trim(detail.providerAgentId) : 'unavailable';
  const reason = messageText(message, 'aspRejectReason') ?? messageText(message, 'reason') ?? 'No reason provided';
  const c = await content();
  let text;
  if (is(detail.jobType, 0)) text = c.regularJobAspRejectClosedUserNotify(svc, ctx.jobId, amount, tokenSymbol, pn, pid, reason, !isZeroDecimal(amount));
  else if (is(detail.jobType, 1)) {
    const trialType = messageI64(message, 'trialType') ?? detail.trialType;
    let isTrial;
    if (is(trialType, 0)) isTrial = false;
    else if (is(trialType, 1)) isTrial = true;
    else return notifyAndEnd(`[Job Close Detail Incomplete] ${$0} (\`${$1}\`): subscription notification is missing a supported trialType.`);
    text = c.subscriptionJobAspRejectClosedUserNotify(svc, ctx.jobId, amount, tokenSymbol, pn, pid, reason, isTrial);
  } else return notifyAndEnd(`[Job Close Detail Incomplete] ${$0} (\`${$1}\`): fresh task detail is missing a supported jobType.`);
  return notifyAndEndTerminal(text, ctx.terminalSessionHint);
}

// upstream: terminal.rs::job_closed / closed_notice
export function jobClosed(ctx, message) {
  const owned = !!ctx.prefetched && is(ctx.prefetched.status, 7) && ctx.prefetched.userAgentId === ctx.agentId;
  const $0 = authoritativeTitle(ctx), $1 = ctx.jobId;
  if (!owned) { const $2 = ctx.jobId; return notifyAndEnd(`[Job Close Detail Incomplete] ${$0} (\`${$1}\`): fresh authoritative detail does not prove Closed(7) ownership by the current User Agent. Do not report closure or refund completion; run \`onchainos agent refund-prepare ${$2}\`.`); }
  const amount = ctx.prefetched.tokenAmount !== '' ? ctx.prefetched.tokenAmount : '';
  const zeroPrice = is(ctx.prefetched.jobType, 0) && isZeroDecimal(amount);
  if (zeroPrice) return notifyAndEndTerminal(`[Job Closed] ${$0} (\`${$1}\`) has been closed. The task price was 0, so no refund was required.`, ctx.terminalSessionHint);
  const [c, complete] = finalRefundNotice(ctx, message, false, 7);
  return notifyRefundResult(ctx, c, complete);
}

// upstream: terminal.rs::submit_expired
export const submitExpired = (ctx) => expiredTerminalResult(ctx, `The ASP did not submit the deliverable before the deadline`);

// upstream: terminal.rs::reject_expired
export async function rejectExpired(ctx) {
  return notifyAndEnd((await content()).rejectExpiredUserNotify(ctx.jobId));
}

// upstream: terminal.rs::review_deadline_warn
export async function reviewDeadlineWarn(ctx) {
  const { jobId, agentId, shortId, titleDisplay } = ctx;
  const prompt = (await content()).reviewDeadlineWarnUserPrompt(jobId, shortId);
  const requestBlock = requestCommandBlock(jobId, 'user', agentId, ctx.prefetched?.providerAgentId ?? null, prompt,
    `[Decision ${shortId}] ${titleDisplay} acceptance decision (deadline soon)`, 'review_deadline_warn');
  return `[System Notification] review_deadline_warn (review deadline approaching)\n`
  + `[Role] User Agent\n`
  + `\n`
  + `**CRITICAL — this event MUST push the review decision to the user via \`pending-decisions-v2 request\` (NOT a plain text reply, NOT just \`onchainos agent user-notify\`).**\n`
  + `Review deadline = user funds safety red line — if the user is not notified, funds auto-release to the ASP on timeout, irreversibly.\n`
  + `Do not substitute a plain text reply for the \`pending-decisions-v2 request\` call.\n`
  + `Do not substitute \`onchainos agent user-notify\` for the \`pending-decisions-v2 request\` (the user must make a review decision; a one-way notify cannot relay).\n`
  + `\n`
  + `**Push the review decision to the user (5-substep protocol; read ALL 5 before running any command)**:\n`
  + `\n`
  + `${requestBlock}`;
}

// upstream: terminal.rs::close_task (unreachable upstream: raw `close` parses to job_closed)
export function closeTask(ctx) {
  const jobId = ctx.jobId;
  return notifyAndEnd(`[Close Requires V2 Confirmation] Job \`${jobId}\` was not changed. A local \`close\` event is not authoritative permission for an irreversible lifecycle/funds write. Run \`onchainos agent refund-prepare ${jobId}\` and execute only the action returned from fresh state after explicit confirmation.`);
}

// upstream: terminal.rs::reward_claimed
export async function rewardClaimed(ctx) {
  return notifyAndEnd((await content()).rewardClaimedUserNotify(ctx.jobId, ctx.titleDisplay));
}

// upstream: terminal.rs::wakeup_notify
export async function wakeupNotify(ctx) {
  const { jobId, agentId } = ctx;
  const wakeupResume = (await content()).wakeupResumeUserNotify(jobId);
  return `[System Notification] wakeup_notify (task wake-up after network / machine restart)\n`
  + `[Role] User Agent\n`
  + `\n`
  + `This is a wake-up heartbeat event, **not** a business-driven event. The real business status lives in envelope.message.jobStatus.\n`
  + `You should not run a playbook with \`wakeup_notify\` as --event -- this playbook is only a guide.\n`
  + `\n`
  + `[Your next actions (strict order)]\n`
  + `\n`
  + `**Step 1 — Read the real status from the envelope**:\n`
  + `From the wakeup_notify envelope that triggered this turn, read \`message.jobStatus\` (e.g. \`accepted\` / \`submitted\` / \`rejected\` / \`disputed\` / \`completed\` / \`failed\` and other real status strings).\n`
  + `\n`
  + `**Step 2 — Re-call next-action with the real status to fetch the current playbook**:\n`
  + `\`\`\`bash\n`
  + `onchainos agent next-action --role user --agentId ${agentId} --message '{"event":"<value of message.jobStatus>","jobId":"${jobId}"}'\n`
  + `\`\`\`\n`
  + `Follow the returned playbook for what to do at the current status.\n`
  + `\n`
  + `**Step 3 — Idempotency self-check (avoid re-prompting the user)**:\n`
  + `If the playbook from Step 2 would push a decision to the user — i.e. it contains \`onchainos agent pending-decisions-v2 request\` — **first** call:\n`
  + `\`\`\`bash\n`
  + `onchainos agent pending-decisions-v2 list --format json\n`
  + `\`\`\`\n`
  + `- The returned \`entries\` already contains an entry with \`job_id=${jobId}\` for this role (the prompt was queued before disconnection) → **skip the script's push step**; instead translate the resume notification below into the user's language and send via \`onchainos agent user-notify --content "<localized content>"\`, then end the turn. Resume notification: ${wakeupResume}\n`
  + `- No matching entry → run the Step 2 playbook normally; the \`pending-decisions-v2 request\` call handles the prompt.\n`
  + `\n`
  + `**Do not** send the ASP "I'm back online" or similar small talk — they do not care about your connection state.\n`
  + `If the Step 2 playbook is passive (e.g. status=accepted waiting for ASP delivery), just emit a "task resumed" notification and end the turn; do not proactively run business actions.\n`;
}

// upstream: terminal.rs::staked_and_unknown
export function stakedAndUnknown(eventStr, jobId) {
  return `[Unknown Status] ${eventStr}\n`
  + `[Advice]\n`
  + `1. Call \`onchainos agent common context ${jobId} --role user\` to view full context\n`
  + `2. If this status is not part of the expected flow, wait for user instructions\n`
  + `3. Do not predict / assume other notifications\n`;
}
