// User-side message templates — upstream task/user/content.rs (single source of truth for the
// user-facing copy rendered by the next-action playbooks). Pure string builders.
import { isCliMode } from '../common/config.mjs';
import { isZeroDecimal } from '../arbitration.mjs';
import { utcParts, trim } from '../../_rs.mjs';

export { isCliMode };

const p2 = (n) => String(n).padStart(2, '0');
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));
const RATE_INVITE = (jobId) => `\n\nTo rate this job, reply "Rate job". Your rating for Job ID \`${jobId}\` replaces the AI-generated rating.`;
const has = (v) => v !== undefined && v !== null;

// upstream: content.rs::scoped_watch_handoff
export function scopedWatchHandoff(jobId) {
  return '[Watch] 🛑 Mandatory continuous monitor. Do NOT end the turn merely because one watch call returned. Do NOT ask the user whether to watch — it is required to receive the next event.\n'
    + '\n'
    + '**Step 1 (MANDATORY GATE) — Enter through `skills/okx-ai/SKILL.md`, then follow its Runtime route to `skills/okx-ai/references/runtime/watch.md`.** If you have NOT read the Runtime Watch reference in this session, you cannot proceed to Step 2 — Step 2\'s invocation, dispatch rules, and re-arm semantics live ONLY in that file. Skipping this step is a protocol violation.\n'
    + '\n'
    + `**Step 2 — Execute the watch per \`skills/okx-ai/references/runtime/watch.md\` §Run watch, scoped to job-id \`${jobId}\`.** Then dispatch every returned item per §Dispatch by \`kind\` and re-enter the same scoped command per §Re-enter after processing. A notification, deliverable, or empty poll does not end this Watch generation. Keep the same \`--job-id\` on every re-entry; stop or pause only when \`runtime/watch.md\`'s literal §Stop condition applies or a \`decision_request\` requires the user's reply. (Do NOT guess the bash invocation — read the v2 Runtime Watch reference first.)\n`
    + '\n'
    + '⏭ Skip `detect_watch_support` — this `[Watch]` block is only emitted on supported platforms.';
}

// upstream: content.rs::job_created_designated_user_notify
export const jobCreatedDesignatedUserNotify = () => '[Connecting ASP]【<title>】(<short_jobId>) — connecting to the designated ASP (<provider_agentId>).';

// upstream: content.rs::designated_asp_abc_prompt (private)
function designatedAspAbcPrompt(shortId, dpId, jobId, reason) {
  return `[Job ${shortId} — you are the User Agent] The designated agent (agentId=${dpId}) for job \`${jobId}\` ${reason}\nPlease choose:\nA. Designate another ASP — provide the agentId\nB. Close the job`;
}

// upstream: content.rs::not_provider_user_prompt
export const notProviderUserPrompt = (jobId, shortId, dpId) => designatedAspAbcPrompt(shortId, dpId, jobId,
  'does not exist or is not registered as an ASP (Agent Service Provider). It cannot fulfil this job.');

// upstream: content.rs::provider_offline_user_prompt
export const providerOfflineUserPrompt = (jobId, shortId, dpId) => designatedAspAbcPrompt(shortId, dpId, jobId,
  'is currently offline. Negotiation requires the ASP to be online.');

// upstream: content.rs::job_accepted_escrow_user_notify
export function jobAcceptedEscrowUserNotify(jobId, _title, amount) {
  const trailing = isCliMode() ? '' : '\n         Waiting for the ASP to execute and submit the deliverable.';
  const amountLine = isZeroDecimal(trim(amount)) ? 'Amount: Free' : 'Amount: <tokenAmount> <tokenSymbol>';
  return `[Job Accepted] Job \`${jobId}\` has been accepted; execution begins.\nTitle: <title>\nDescription: <description>\nASP agentId: <providerAgentId>\nPayment: escrow\n${amountLine}${trailing}`;
}

// upstream: content.rs::job_rejected_user_notify
export function jobRejectedUserNotify(jobId, title) {
  const lead = isCliMode()
    ? `[Rejection Confirmed] The deliverable for【${title}】(\`${jobId}\`) has been rejected.`
    : `[Rejection Confirmed] The deliverable for【${title}】(\`${jobId}\`) has been rejected; waiting for the ASP to respond.`;
  return `${lead}\nThe ASP will choose: request evaluation or agree to a refund.\nIf the ASP takes no action, funds will be auto-refunded to your wallet.`;
}

// upstream: content.rs::job_completed_escrow_user_notify
export function jobCompletedEscrowUserNotify(jobId, title, tokenAmount, tokenSymbol) {
  return `[Job Completed] ${title} (\`${jobId}\`) — approved by the User Agent; funds released to the ASP.\n- Spent: ${tokenAmount} ${tokenSymbol}\n- Payment: escrow${RATE_INVITE(jobId)}`;
}

// upstream: content.rs::EVALUATION_REASONS_BLOCK
export const EVALUATION_REASONS_BLOCK = '- Evaluation reasons:\n'
  + '    Evaluator 1: <voterReportSummary from message.voteReportSummaries[0]>\n'
  + '    Evaluator 2: <voterReportSummary from message.voteReportSummaries[1]>\n'
  + '    ... (one line per entry; first skip entries whose voterReportSummary is missing / empty / whitespace, then number the kept entries consecutively starting at 1 in array order — do NOT preserve gaps from the original index; omit this whole `- Evaluation reasons:` section if voteReportSummaries is missing, not an array, empty, or every entry would be skipped — do NOT print a header with no body, do NOT fabricate filler text)';

// upstream: content.rs::refund_party (private)
function refundParty(name, id) {
  if (has(name) && has(id)) return `${name} (${id})`;
  if (has(name)) return String(name);
  if (has(id)) return `name unavailable (${id})`;
  return 'not provided by the final event';
}

// upstream: content.rs::amount_and_token (private)
function amountAndToken(amount, symbol) {
  if (has(amount) && has(symbol)) return `${amount} ${symbol}`;
  if (has(amount)) return `${amount} (token symbol unavailable)`;
  return 'not provided by the final event';
}

// upstream: content.rs::dispute_won_user_notify
export function disputeWonUserNotify(jobId, title, providerName, providerId, serviceName, amount, symbol, refundConfirmed, txHash) {
  const settlement = refundConfirmed
    ? `- Refund amount: ${amountAndToken(amount, symbol)}\n- Tx Hash: ${has(txHash) ? txHash : 'unavailable'}\n- Refund status: Settled; funds returned to the User Agent wallet.`
    : `- Refund amount: ${amountAndToken(amount, symbol)} (approved; settlement verification pending)\n- Tx Hash: unavailable\nThe ruling favors the User Agent, but the available lifecycle facts do not yet verify the settlement result. Reconcile through Refund before reporting completion.`;
  return `[Evaluation Result] ${title} (\`${jobId}\`) — evaluation completed; User Agent wins.\n- Refund ASP: ${refundParty(providerName, providerId)}\n- Service: ${has(serviceName) ? serviceName : 'not provided by the final event'}\n${settlement}\n- Evaluation status: Decided\n- Result: User Agent won; the refund completed\n${EVALUATION_REASONS_BLOCK}`;
}

// upstream: content.rs::dispute_lost_user_notify
export function disputeLostUserNotify(jobId, title, providerName, providerId, serviceName, amount, symbol) {
  return `[Evaluation Result] ${title} (\`${jobId}\`) — the refund request was not approved; ASP wins.\n- Refund: Not issued\n- ASP: ${refundParty(providerName, providerId)}\n- Service: ${has(serviceName) ? serviceName : 'not provided by the final event'}\n- Original payment: ${amountAndToken(amount, symbol)} (funds released to the ASP)\n- Evaluation status: Decided\n- Result: ASP won; task funds were released to the ASP\n${EVALUATION_REASONS_BLOCK}\nThis job is complete.`;
}

// upstream: content.rs::rating_submitted_user_notify
export const ratingSubmittedUserNotify = (jobId, title) => `[📝 Rating Submitted] ${title} (\`${jobId}\`) — rated.\nScore: <score> / 5.00\n💬 Comment: <description>`;

// upstream: content.rs::job_refunded_user_notify
export const jobRefundedUserNotify = (jobId) => `[Refund Settled] Job \`${jobId}\` — refund confirmed on-chain; funds returned to your wallet. This job is complete.`;

// upstream: content.rs::job_auto_refunded_user_notify
export const jobAutoRefundedUserNotify = (jobId, title) => `[Auto-Refund Settled] ${title} (\`${jobId}\`) — escrowed funds returned to your wallet. This job is complete.`;

// upstream: content.rs::job_expired_user_notify
export const jobExpiredUserNotify = (jobId) => `[Job Expired] Job \`${jobId}\` is in authoritative Expired(8) status after a deadline elapsed. Any applicable automatic refund has reached the buyer, and no buyer-side refund claim or finalization is required.`;

// upstream: content.rs::job_asp_accept_expire_user_notify
export function jobAspAcceptExpireUserNotify(jobId, serviceName, isSubscription, providerName, providerAgentId, amount, tokenSymbol, isPaid, isTrial) {
  return isSubscription
    ? subscriptionJobAspAcceptExpireUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, isTrial)
    : regularJobAspAcceptExpireUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, isPaid);
}

// upstream: content.rs::job_asp_reject_expire_user_notify
export function jobAspRejectExpireUserNotify(jobId, serviceName, amount, tokenSymbol, rejectWindowEndsAt, isSubscription, isPaid) {
  return isSubscription
    ? subscriptionJobAspRejectExpireUserNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt)
    : regularJobAspRejectExpireUserNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt, isPaid);
}

// upstream: content.rs::job_closed_user_notify
export const jobClosedUserNotify = (jobId, title) => `[Job Closed] ${title} (\`${jobId}\`) has been closed; funds have been returned.`;

// upstream: content.rs::payment_mode_escrow_user_notify
export const paymentModeEscrowUserNotify = (jobId, title) => `[Payment Mode Set] ${title} (\`${jobId}\`) — payment mode updated successfully; ASP <providerName> (<providerAgentId>) is accepting...`;

// upstream: content.rs::close_user_notify
export const closeUserNotify = (jobId) => `[Job Closed] Job \`${jobId}\` has been closed.`;

// upstream: content.rs::submit_expired_user_notify
export const submitExpiredUserNotify = (jobId) => `[Submit Deadline Expired] Job \`${jobId}\` — the ASP did not submit the deliverable before the deadline. Authoritative Expired(8) confirms that the backend returned any refundable payment to your wallet. This notification did not send a refund transaction, and no buyer-side claim or finalization is required.`;

// upstream: content.rs::reject_expired_user_notify
export function rejectExpiredUserNotify(jobId) {
  return isCliMode()
    ? `Job \`${jobId}\` — the ASP did not request evaluation in time after you rejected the deliverable. An auto-refund is in progress; funds will return to your wallet and a final refund-settled notice will follow shortly.`
    : `Job \`${jobId}\` — the ASP did not request evaluation in time after you rejected the deliverable. An auto-refund has been requested; funds will return to your wallet.`;
}

// upstream: content.rs::review_deadline_warn_user_prompt
export const reviewDeadlineWarnUserPrompt = (jobId, shortId) => `[Job ${shortId} — you are the User Agent] [⏰ Review Deadline Warning] Job ${jobId} — the review deadline is approaching.\nAfter expiry, the ASP can auto-claim the funds.\nPlease decide soon:\nA. Approve the deliverable\nB. Reject the deliverable`;

// upstream: content.rs::reward_claimed_user_notify
export const rewardClaimedUserNotify = (jobId, title) => `[Reward Claimed] ${title} (\`${jobId}\`) — reward / refund successfully claimed to your wallet.`;

// upstream: content.rs::wakeup_resume_user_notify
export const wakeupResumeUserNotify = (jobId) => `[Resumed] Job \`${jobId}\` is back online. Please continue when ready.`;

// upstream: content.rs::attachment_sent_user_notify
export const attachmentSentUserNotify = () => '[Job <short_jobId>] Attachment sent to the ASP.';

// upstream: content.rs::escalation_protocol_misread_notify
export const escalationProtocolMisreadNotify = (jobId) => `[⚠️ Protocol Misalignment] Job \`${jobId}\` — the remote agent repeatedly sends messages that do not match the current flow. Replies have stopped. Please intervene manually to continue.`;

// upstream: content.rs::create_task_designated_user_notify
export const createTaskDesignatedUserNotify = () => 'Job submitted; jobId: <jobId>; designated provider: <providerName> (agentId: <agentId>); awaiting on-chain confirmation (~seconds). Once confirmed, the system will automatically connect with the designated provider.';

// upstream: content.rs::escalation_cli_failed_notify
export function escalationCliFailedNotify(jobId) {
  return `[⚠️ Operation Failed] Job \`${jobId}\`\n- Action: <e.g. match ASPs / submit review / escrow payment>\n- Error: <one-sentence summary of stderr / error field>\n- Current status: <describe in plain language, e.g. waiting for provider / under review / payment pending>\n\nChoose how to proceed:\nA. Retry → reply 'A' or 'retry'\nB. Don't prompt again (you'll handle manually) → reply 'B' or 'dismiss'\nC. Provide a new instruction → describe what to change (e.g. 'change --token-symbol to USDT and retry')`;
}

// upstream: content.rs::fmt_epoch — seconds (ms tolerated) → "YYYY-MM-DD HH:MM UTC" | undefined
export function fmtEpoch(ts) {
  if (!has(ts)) return undefined;
  let t = BigInt(ts);
  if (t <= 0n) return undefined;
  if (t >= 1000000000000n) t /= 1000n;
  const p = utcParts(t);
  return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} UTC` : undefined;
}

// upstream: content.rs::sub_open_user_notify
export function subOpenUserNotify(jobId, serviceName, tokenAmount, tokenSymbol) {
  let out = `[Subscription Created] Job ${jobId} (subscribing to ${serviceName}) is on-chain and waiting for the ASP to accept.`;
  if (has(tokenAmount) && has(tokenSymbol)) out += ` ${tokenAmount} ${tokenSymbol} has been funded for the subscription.`;
  else if (has(tokenAmount)) out += ` ${tokenAmount} has been funded for the subscription.`;
  return out;
}

// upstream: content.rs::sub_open_trial_user_notify
export function subOpenTrialUserNotify(jobId, serviceName, tokenAmount, tokenSymbol) {
  let out = `[Trial Subscription Created] Job ${jobId} (subscribing to ${serviceName}) is on-chain and waiting for the ASP to accept. The free trial will begin after acceptance.`;
  if (has(tokenAmount)) {
    out += has(tokenSymbol)
      ? ` If accepted, ${tokenAmount} ${tokenSymbol} is the paid-period price after the trial.`
      : ` If accepted, ${tokenAmount} is the paid-period price after the trial.`;
  }
  return out;
}

// upstream: content.rs::sub_created_user_notify
export function subCreatedUserNotify(jobId, serviceName, tokenAmount, tokenSymbol, periodStart, periodEnd, autoRenew) {
  let out = `[Subscribed] Job ${jobId} (subscribing to ${serviceName}) is on-chain`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `, current period ${s}–${e}`;
  out += '.';
  if (has(tokenAmount)) out += has(tokenSymbol) ? ` First charge of ${tokenAmount} ${tokenSymbol} completed.` : ` First charge of ${tokenAmount} completed.`;
  if (autoRenew) {
    out += ' Auto-renew is on';
    if (e !== undefined) out += `; next charge date: ${e}`;
  } else out += ' Auto-renew is off';
  out += '.';
  return out + RATE_INVITE(jobId);
}

// upstream: content.rs::sub_created_trial_user_notify
export function subCreatedTrialUserNotify(jobId, tokenAmount, tokenSymbol, trialStart, trialEnd) {
  let out = '[Trial Started] Your free trial has started';
  const s = fmtEpoch(trialStart), e = fmtEpoch(trialEnd);
  if (s !== undefined && e !== undefined) out += ` (${s}–${e})`;
  out += '.';
  if (has(tokenAmount)) {
    out += has(tokenSymbol) ? ` After it ends, ${tokenAmount} ${tokenSymbol} will be auto-charged` : ` After it ends, ${tokenAmount} will be auto-charged`;
    if (e !== undefined) out += ` on ${e}`;
    out += ' to convert to a paid subscription (attempted once, within the final hour before the trial ends — it will not retry if missed).';
  }
  return out + RATE_INVITE(jobId);
}

// upstream: content.rs::sub_trial_into_active_user_notify
export function subTrialIntoActiveUserNotify(_jobId, serviceName, tokenAmount, tokenSymbol, periodStart, periodEnd) {
  let out = '[Trial Converted] Your free trial has ended;';
  if (has(tokenAmount) && has(tokenSymbol)) out += ` the first charge of ${tokenAmount} ${tokenSymbol} for "${serviceName}" is complete`;
  else if (has(tokenAmount)) out += ` the first charge of ${tokenAmount} for "${serviceName}" is complete`;
  else out += ` the first charge for "${serviceName}" is complete`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `, current period ${s}–${e}`;
  out += '.';
  if (e !== undefined) out += ` Next charge date: ${e}.`;
  return out;
}

// upstream: content.rs::sub_renew_user_notify
export function subRenewUserNotify(renewResult, failReason, serviceName, _jobId, tokenAmount, tokenSymbol, _periodStart, periodEnd, graceEndsAt) {
  if (renewResult === 'fail') {
    let out = `[⚠️ Renewal Failed] "${serviceName}" — this cycle's charge failed`;
    if (has(failReason)) out += `: ${failReason}`;
    out += '. A grace period is in effect';
    const g = fmtEpoch(graceEndsAt);
    if (g !== undefined) out += ` (until ${g})`;
    return out + '; service continues normally and the system will keep retrying. Please add funding / increase allowance as soon as possible.';
  }
  let out = `[Renewed] "${serviceName}" —`;
  if (has(tokenAmount) && has(tokenSymbol)) out += ` this cycle's renewal of ${tokenAmount} ${tokenSymbol} is complete.`;
  else if (has(tokenAmount)) out += ` this cycle's renewal of ${tokenAmount} is complete.`;
  else out += " this cycle's renewal is complete.";
  const nc = fmtEpoch(periodEnd);
  out += nc !== undefined ? `. Next charge date: ${nc}.` : '.';
  return out;
}

// upstream: content.rs::sub_user_reject_user_notify
export function subUserRejectUserNotify(serviceName, periodStart, periodEnd, rejectWindowEndsAt, tokenAmount, tokenSymbol) {
  let out = `[Rejection Submitted] Your rejection for "${serviceName}"'s current period`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += ` (${s}–${e})`;
  out += ' has been submitted. The ASP must respond';
  const w = fmtEpoch(rejectWindowEndsAt);
  if (w !== undefined) out += ` by ${w}`;
  out += ', or a full refund';
  if (has(tokenAmount) && has(tokenSymbol)) out += ` of ${tokenAmount} ${tokenSymbol}`;
  else if (has(tokenAmount)) out += ` of ${tokenAmount}`;
  return out + ' will be issued automatically.';
}

// upstream: content.rs::sub_asp_dispute_user_notify
export function subAspDisputeUserNotify(serviceName, jobId, periodStart, periodEnd) {
  let out = `[Evaluation Opened] The ASP requested evaluation of your rejection of "${serviceName}"`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `'s current period (${s}–${e})`;
  return out + `. Evaluation is in progress for Job ${jobId} (protocol status: Disputed).`;
}

// upstream: content.rs::sub_cancel_user_notify
export function subCancelUserNotify(cancelResult, failReason, trialType, serviceName, jobId, subEnd) {
  if (cancelResult === 'fail') {
    let out = '[Subscription Cancellation Failed] Your subscription could not be cancelled.';
    if (has(failReason)) out += `\n         Reason: ${failReason}`;
    return out;
  }
  if (has(trialType) && Number(trialType) === 1) {
    return `[Cancelled] The free trial for "${serviceName}" has been cancelled and access ends immediately. No conversion charge will occur.`;
  }
  let out = `[Auto-Renew Cancelled] Auto-renew for "${serviceName}" has been cancelled. Current service continues`;
  const e = fmtEpoch(subEnd);
  out += e !== undefined ? ` until ${e}` : ' for the remainder of the current period';
  return out + `; job ${jobId} will then move to Completed.`;
}

// upstream: content.rs::sub_asp_agree_user_notify
export function subAspAgreeUserNotify(serviceName, tokenAmount, tokenSymbol, periodStart, periodEnd) {
  let out = `[Refund Complete] The ASP has acknowledged the issue with "${serviceName}"'s current period`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += ` (${s}–${e})`;
  out += '. A full refund';
  if (has(tokenAmount) && has(tokenSymbol)) out += ` of ${tokenAmount} ${tokenSymbol}`;
  else if (has(tokenAmount)) out += ` of ${tokenAmount}`;
  return out + ' has been sent directly to your wallet, and auto-renew has been turned off.';
}

// upstream: content.rs::sub_complete_notify_user_notify
export function subCompleteNotifyUserNotify(serviceName, jobId, periodEnd, includeRatingInvitation) {
  let out = `[Subscription Complete] "${serviceName}" has completed all scheduled renewals. Job ${jobId} status: Completed; service ends normally`;
  const e = fmtEpoch(periodEnd);
  if (e !== undefined) out += ` at ${e}`;
  out += ' with no further renewal.';
  if (includeRatingInvitation) out += RATE_INVITE(jobId);
  return out;
}

// upstream: content.rs::sub_close_notify_user_notify
export function subCloseNotifyUserNotify(serviceName, jobId, periodStart, periodEnd, aspRejectReason) {
  if (has(aspRejectReason) && trim(aspRejectReason) !== '') {
    return `[Service Closed] The ASP declined "${serviceName}" before activation. Job ${jobId} status: Closed. ASP reason: ${aspRejectReason}. This closure notice does not by itself confirm that a refund settled.`;
  }
  let out = `[Service Closed] "${serviceName}"`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `'s current period (${s}–${e})`;
  return out + ` has ended. Job ${jobId} status: Closed.`;
}

// upstream: content.rs::sub_failed_notify_user_notify
export function subFailedNotifyUserNotify(serviceName, trialType, reason, jobId, graceEndsAt) {
  if (has(trialType) && Number(trialType) === 1) {
    let out = `[Trial Ended] "${serviceName}" — the conversion charge could not be completed before the trial ended`;
    if (has(reason)) out += ` (${reason})`;
    return out + `; conversion failed with no retry. Job ${jobId} status: Closed. Subscribe again to continue.`;
  }
  let out = `[Subscription Ended] "${serviceName}" — the charge still failed after the grace period`;
  const g = fmtEpoch(graceEndsAt);
  if (g !== undefined) out += `; the service ended at ${g}`;
  return out + `. Job ${jobId} status: Closed. Subscribe again to continue.`;
}

// upstream: content.rs::sub_expire_warn_user_notify
export const subExpireWarnUserNotify = (jobId) => `[Renewal Reminder] Job \`${jobId}\` — your subscription's current period is ending soon. It will auto-renew on expiry. Cancel in advance via subscription management if you don't want this.`;

// upstream: content.rs::sub_expire_warn_no_autorenew_notify
export const subExpireWarnNoAutorenewNotify = (jobId, periodStart, periodEnd) => `[Subscription Ending Soon] Subscription job ${jobId} (period ${periodStart}–${periodEnd}) will expire and close on ${periodEnd}. To continue using it, please enable auto-renew in time.`;

// upstream: content.rs::sub_reject_refund_notify_user
export function subRejectRefundNotifyUser(serviceName, periodStart, periodEnd, rejectWindowEndsAt, amount, tokenSymbol) {
  let out = `[Auto-Refund] Your rejection request for "${serviceName}"`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `'s period (${s}–${e})`;
  out += " went unanswered past the ASP's response deadline";
  const d = fmtEpoch(rejectWindowEndsAt);
  if (d !== undefined) out += ` (${d})`;
  out += '.';
  if (has(amount) && has(tokenSymbol)) out += ` The system has automatically issued a full refund of ${amount} ${tokenSymbol} to your wallet.`;
  else if (has(amount)) out += ` The system has automatically issued a full refund of ${amount} to your wallet.`;
  else out += ' The system has automatically issued a full refund to your wallet.';
  return out;
}

// upstream: content.rs::subscription_job_asp_accept_expire_user_notify
export function subscriptionJobAspAcceptExpireUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, isTrial) {
  if (isTrial) {
    return `[Job Expired] The ASP did not accept ${serviceName} within 3 hours, so the job expired. Neither the subscription nor the free trial began.\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nJob status: Expired\n\nYour free-trial eligibility remains unaffected.`;
  }
  return `[Job Expired] The ASP did not accept ${serviceName} within 3 hours, so the job expired. The subscription did not begin. The escrowed amount of ${amount} ${tokenSymbol} will be returned to your wallet.\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nJob status: Expired`;
}

// upstream: content.rs::regular_job_asp_accept_expire_user_notify
export function regularJobAspAcceptExpireUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, isPaid) {
  const payment = isPaid ? ` The escrowed amount of ${amount} ${tokenSymbol} will be returned to your wallet.` : '';
  return `[Job Expired] The ASP did not accept ${serviceName} within 3 hours, so the job expired.${payment}\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nJob status: Expired`;
}

// upstream: content.rs::subscription_job_asp_reject_closed_user_notify
export function subscriptionJobAspRejectClosedUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, reason, isTrial) {
  if (isTrial) {
    return `[ASP Declined] The ASP declined ${serviceName}.\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nReason: ${reason}\n\nThe job is closed. Neither the subscription nor the free trial began, and your free-trial eligibility remains unaffected.`;
  }
  return `[ASP Declined] The ASP declined ${serviceName}. The escrowed amount of ${amount} ${tokenSymbol} will be returned automatically to your wallet address. Please monitor your wallet balance.\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nReason: ${reason}\n\nThe job is closed, and the subscription did not begin.`;
}

// upstream: content.rs::regular_job_asp_reject_closed_user_notify
export function regularJobAspRejectClosedUserNotify(serviceName, jobId, amount, tokenSymbol, providerName, providerAgentId, reason, isPaid) {
  const payment = isPaid ? ` The escrowed amount of ${amount} ${tokenSymbol} will be returned automatically to your wallet address. Please monitor your wallet balance.` : '';
  return `[ASP Declined] The ASP declined ${serviceName}.${payment}\n\nJob ID: ${jobId}\nASP: ${providerName} (Agent ID: ${providerAgentId})\nReason: ${reason}\nJob status: Closed`;
}

// upstream: content.rs::subscription_job_asp_reject_expire_user_notify
export function subscriptionJobAspRejectExpireUserNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt) {
  const deadline = fmtEpoch(rejectWindowEndsAt) ?? 'Unavailable';
  return `[Automatic Refund Processing] The ASP did not respond to the refund request for ${serviceName} by the deadline. ${amount} ${tokenSymbol} will be returned to your wallet, subject to on-chain confirmation.\n\nJob ID: ${jobId}\nResponse deadline: ${deadline}\nJob status: Failed`;
}

// upstream: content.rs::regular_job_asp_reject_expire_user_notify
export function regularJobAspRejectExpireUserNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt, isPaid) {
  const deadline = fmtEpoch(rejectWindowEndsAt) ?? 'Unavailable';
  if (isPaid) return subscriptionJobAspRejectExpireUserNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt);
  return `[Refund Request Processed] The ASP did not respond to the refund request for ${serviceName} by the deadline. No charges were incurred, so no refund is required.\n\nJob ID: ${jobId}\nASP response deadline: ${deadline}\nJob status: Failed`;
}
