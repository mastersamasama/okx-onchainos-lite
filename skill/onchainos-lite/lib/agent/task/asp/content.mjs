// ASP-side message templates — upstream task/asp/content.rs (single point of maintenance).
// Every literal below is a byte-exact port of the Rust string literal (line continuations
// `\` strip the newline and the next line's leading whitespace; `\x20` survives).
import { utcParts, nowSecs } from '../../../core/rs/time.mjs';
import { trim } from '../../../core/rs/str.mjs';
import {
  REFUND_SERVICE_NAME_PLACEHOLDER, REFUND_JOB_ID_PLACEHOLDER, REFUND_TASK_TYPE_PLACEHOLDER, REFUND_CURRENT_PERIOD_PLACEHOLDER,
  REFUND_AMOUNT_PLACEHOLDER, REFUND_BUYER_REASON_PLACEHOLDER, REFUND_RESPONSE_DEADLINE_PLACEHOLDER,
} from '../common/template-vars.mjs';
import { deadlineReminderLine, DeadlineKind } from '../common/deadline.mjs';

const I4 = '    ';
const has = (v) => v !== undefined && v !== null;

// upstream: content.rs::job_asp_selected_no_service_notify
export const jobAspSelectedNoServiceNotify = (jobId) => `[Designated Task — Skipped] Job ${jobId} — the User Agent designated you as the ASP without pinning a specific service.\n`
  + '  No action taken; waiting for the User Agent to re-route with a specific service.';

// upstream: content.rs::job_asp_selected_missing_terms_notify
export const jobAspSelectedMissingTermsNotify = (jobId, missingField) => `[Designated Task — Skipped] Job ${jobId} — the User Agent's designation envelope is missing \`${missingField}\`; cannot determine the apply terms.\n`
  + "  No action taken; waiting for the User Agent to re-send the designation with complete terms.";

// upstream: content.rs::job_user_reject_notify
export const jobUserRejectNotify = (jobId) => `[User Agent Declined Payment] Job ${jobId} — the User Agent refused to fund / confirm-accept after your apply.\n`
  + '  This designation is over; no further action is needed on this side.';

// upstream: content.rs::provider_applied_user_notify
export const providerAppliedUserNotify = (jobId, agentId) => `[Apply Submitted] Job ${jobId} — your apply has been recorded on-chain.\n`
  + `  - ASP agentId: ${agentId}\n`
  + "  Awaiting the User Agent's confirm-accept to fund escrow.";

// upstream: content.rs::job_asp_selected_apply_failed_notify
export const jobAspSelectedApplyFailedNotify = (jobId, errorSummary) => `[Designated Task — Apply Failed] Job ${jobId} — the on-chain apply did not go through.\n`
  + `  - Error: ${errorSummary}\n`
  + '  The designated assignment was NOT recorded; please retry or contact the User Agent.';

// upstream: content.rs::job_asp_selected_rejected_notify
export const jobAspSelectedRejectedNotify = (jobId, reason) => `[Designated Task Declined] Job ${jobId} — the designated assignment was declined.\n`
  + `  - Reason: ${reason}\n`
  + '  The User Agent can now re-route to another ASP.';

// upstream: content.rs::L10N_DISPATCH_SHORT
export const L10N_DISPATCH_SHORT = "🌐🛑 **MUST translate** the content below to the user's language before passing to `onchainos agent user-notify` (rule 5: non-English → faithful translation; rule 4: English → verbatim). Sending English content to a Chinese user is a violation.";

// upstream: content.rs::job_accepted_user_notify
export const jobAcceptedUserNotify = (jobId, agentId) => `${I4}[Job Accepted] Job ${jobId} has been accepted.\n`
  + `${I4}- Title: <title>\n`
  + `${I4}- Description: <description>\n`
  + `${I4}- Negotiated price: <tokenAmount> <tokenSymbol>\n`
  + `${I4}- Payment: <escrow>\n`
  + `${I4}- ASP: ${agentId}\n`
  + `${I4}Funds are now escrowed; the ASP has started execution.`;

// upstream: content.rs::job_rejected_user_decision_prompt
export function jobRejectedUserDecisionPrompt(shortId, expireTime) {
  const line = deadlineReminderLine(expireTime, nowSecs(), DeadlineKind.Decision);
  const decisionDeadlineLine = line === undefined ? '' : `\n${I4}${line}`;
  return `${I4}[Job ${shortId}] The buyer rejected the deliverable.\n`
    + `${I4}To refund the buyer, reply 'Approve refund'. To request platform evaluation, reply 'Request evaluation' and include your evaluation reason.${decisionDeadlineLine}`;
}

// upstream: content.rs::asp_refund_decision_source_template
export function aspRefundDecisionSourceTemplate(isSubscription) {
  return '### Buyer Refund Request\n\n'
    + `- Service Name: ${REFUND_SERVICE_NAME_PLACEHOLDER}\n`
    + `- Job ID: ${REFUND_JOB_ID_PLACEHOLDER}\n`
    + `- Task Type: ${REFUND_TASK_TYPE_PLACEHOLDER}\n`
    + (isSubscription ? `- Current Period: ${REFUND_CURRENT_PERIOD_PLACEHOLDER}\n` : '')
    + `- Requested Refund: ${REFUND_AMOUNT_PLACEHOLDER}\n`
    + `- Buyer’s Reason: ${REFUND_BUYER_REASON_PLACEHOLDER}\n`
    + `- Response Deadline: ${REFUND_RESPONSE_DEADLINE_PLACEHOLDER}\n`
    + '- Refund Status: Awaiting ASP decision\n'
    + "- Status Description: The refund request is waiting for the ASP's decision.\n\n"
    + 'Please respond by the deadline. Otherwise, a full refund will be issued automatically.\n\n'
    + 'To refund the buyer, reply “Approve refund”. To request platform evaluation, reply “Request evaluation” and include your evaluation reason.';
}

// upstream: content.rs::sub_user_reject_asp_decision_copy
export function subUserRejectAspDecisionCopy(serviceName, periodStart, periodEnd, rejectWindowEndsAt, amount, tokenSymbol) {
  let out = `[Action Needed: User Rejection] The user has rejected "${serviceName}"'s current period`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += ` (${s}–${e})`;
  out += '.';
  const deadline = fmtEpoch(rejectWindowEndsAt);
  out += deadline !== undefined ? ` Please confirm the refund or request evaluation by ${deadline}` : ' Please confirm the refund or request evaluation within about 1 day';
  out += ' — otherwise a full refund';
  if (has(amount) && has(tokenSymbol)) out += ` of ${amount} ${tokenSymbol}`;
  else if (has(amount)) out += ` of ${amount}`;
  out += ' will be issued to the user automatically.\n';
  out += "  To refund the buyer, reply 'Approve refund'.\n";
  out += "  To request platform evaluation, reply 'Request evaluation' and include your evaluation reason.";
  return out;
}

// upstream: content.rs::job_submitted_user_notify
export const jobSubmittedUserNotify = (jobId) => `[Deliverable Submitted] Job ${jobId} — your deliverable is on-chain (submit tx confirmed).\n`
  + "  Waiting for the User Agent's review (approve or reject).";

// upstream: content.rs::EVALUATION_REASONS_BLOCK
export const EVALUATION_REASONS_BLOCK = '      - Evaluation reasons:\n'
  + '          Evaluator 1: <voterReportSummary from message.voteReportSummaries[0]>\n'
  + '          Evaluator 2: <voterReportSummary from message.voteReportSummaries[1]>\n'
  + '          ... (one line per entry; first skip entries whose voterReportSummary is missing / empty / whitespace, then number the kept entries consecutively starting at 1 in array order — do NOT preserve gaps from the original index; omit this whole `- Evaluation reasons:` section if voteReportSummaries is missing, not an array, empty, or every entry would be skipped — do NOT print a header with no body, do NOT fabricate filler text)';

// upstream: content.rs::dispute_won_with_claim_user_notify
export const disputeWonWithClaimUserNotify = (jobId) => `${I4}[⚖️💰 Evaluation Result] Job ${jobId} (<title>) — evaluation completed; ASP wins.\n`
  + `${I4}  - Evaluation Status: Decided\n`
  + `${I4}  - Result: ASP won; task funds were released to the ASP\n`
  + `${I4}  - Job income: <tokenAmount> <tokenSymbol>\n`
  + `${I4}  - Auto-claimed account reward: <claimed amount> <symbol>\n`
  + `${I4}  - User Agent: <buyerAgentId>\n`
  + `${EVALUATION_REASONS_BLOCK}\n`
  + `${I4}  \n`
  + `${I4}  This job is complete.`;

// upstream: content.rs::dispute_won_no_claim_user_notify
export const disputeWonNoClaimUserNotify = (jobId) => `${I4}[⚖️💰 Evaluation Result] Job ${jobId} (<title>) — evaluation completed; ASP wins.\n`
  + `${I4}  - Evaluation Status: Decided\n`
  + `${I4}  - Result: ASP won; task funds were released to the ASP\n`
  + `${I4}  - Job income: <tokenAmount> <tokenSymbol>\n`
  + `${I4}  - Account-level pending reward: none (checked)\n`
  + `${I4}  - User Agent: <buyerAgentId>\n`
  + `${EVALUATION_REASONS_BLOCK}\n`
  + `${I4}  \n`
  + `${I4}  This job is complete.`;

// upstream: content.rs::reward_claim_failed_user_notify
export const rewardClaimFailedUserNotify = (jobId) => `[Reward Claim Failed] Job ${jobId} — the reward-claim transaction failed. Please review and retry manually; the agent will not auto-retry.`;

// upstream: content.rs::reward_claimed_user_notify
export const rewardClaimedUserNotify = (jobId) => `[Reward Claimed] Job ${jobId} — reward successfully claimed to your wallet.`;

// upstream: content.rs::escalation_protocol_misread_notify
export const escalationProtocolMisreadNotify = (jobId) => `[⚠️ Protocol Misalignment] Job ${jobId} — repeated clarifications on the same flow, and the remote agent still repeats. Replies have stopped. Please intervene or give a new instruction.`;

// upstream: content.rs::escalation_cli_failed_notify
export const escalationCliFailedNotify = (jobId) => `[⚠️ Operation Failed] Job ${jobId}\n`
  + '- Action: <e.g. submit deliverable / accept job / fetch paymentId>\n'
  + '- Error: <one-sentence summary of stderr / error field>\n'
  + '- Current status: <status>\n'
  + '\n'
  + 'Choose how to proceed:\n'
  + "A. Retry → reply 'A' or 'retry'\n"
  + "B. Don't prompt again (you'll handle manually) → reply 'B' or 'dismiss'\n"
  + "C. Provide a new instruction → describe what to change (e.g. 'change --token-symbol to USDT and retry')";

// upstream: content.rs::submit_deadline_warn_user_prompt
export const submitDeadlineWarnUserPrompt = (shortId) => `${I4}[⏰ Deadline Warning — Job ${shortId}, you are the ASP] The submit deadline is approaching.\n`
  + `${I4}If the deliverable is ready, reply 'submit now' and I will run the delivery flow immediately.\n`
  + `${I4}If it is not ready, you may stay silent — after expiry the backend automatically returns any escrowed funds to the User Agent and this job is void. No client-side refund claim is required.`;

// upstream: content.rs::rating_submitted_user_notify
export const ratingSubmittedUserNotify = (jobId) => `${I4}[📝 Rating Submitted] Job <title> (\`${jobId}\`) — rated.\n`
  + `${I4}Score: <score> / 5.00\n`
  + `${I4}💬 Comment: <description>`;

// upstream: content.rs::dispute_lost_user_notify
export const disputeLostUserNotify = (jobId) => `${I4}[⚖️⚠️ Evaluation Result] Job ${jobId} (<title>) — evaluation completed; User Agent wins.\n`
  + `${I4}  - Evaluation Status: Decided\n`
  + `${I4}  - Result: User Agent won; the refund completed\n`
  + `${I4}  - Loss: <tokenAmount> <tokenSymbol> (funds returned to the User Agent)\n`
  + `${I4}  - User Agent: <buyerAgentId>\n`
  + `${EVALUATION_REASONS_BLOCK}\n`
  + `${I4}  \n`
  + `${I4}  This job is complete.`;

// upstream: content.rs::deliver_text_to_user (protocol reference; no production caller)
export const deliverTextToUser = (jobId) => `jobId: ${jobId}\ndeliverableType: text\n- - -\n<paste the deliverable text here>\n- - -\n[intent:deliver]`;

// upstream: content.rs::deliver_file_to_user (protocol reference; no production caller)
export const deliverFileToUser = (jobId) => `jobId: ${jobId}\ndeliverableType: file\n`
  + 'fileKey: <full fileKey string returned from A-Step 1>\ndigest: <digest returned from A-Step 1>\nsalt: <salt returned from A-Step 1>\n'
  + 'nonce: <nonce returned from A-Step 1>\nsecret: <secret returned from A-Step 1>\nfilename: <filename returned from A-Step 1>\n[intent:deliver]';

// upstream: content.rs::build_text_deliver_message
export const buildTextDeliverMessage = (jobId, text) => `jobId: ${jobId}\ndeliverableType: text\n- - -\n${text}\n- - -\n[intent:deliver]`;

// upstream: content.rs::build_file_deliver_message (upload = okx_a2a::FileUploadResult)
export const buildFileDeliverMessage = (jobId, upload) => `jobId: ${jobId}\ndeliverableType: file\nfileKey: ${upload.fileKey}\ndigest: ${upload.digest}\n`
  + `salt: ${upload.salt}\nnonce: ${upload.nonce}\nsecret: ${upload.secret}\nfilename: ${upload.filename}\n[intent:deliver]`;

// upstream: content.rs::user_attachment_received_user_notify
export const userAttachmentReceivedUserNotify = (jobId) => `[Job \`${jobId}\`] The User Agent sent an attachment (reference material for this task). File downloaded and saved locally.`;

// ── Subscription notifications (display-class) ──

const p2 = (n) => String(n).padStart(2, '0');
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));

// upstream: content.rs::fmt_epoch — `%Y-%m-%d %H:%M UTC` of positive contract seconds
// (millisecond-scale values ≥ 1e12 are divided by 1000).
export function fmtEpoch(ts) {
  if (!has(ts)) return undefined;
  let t = BigInt(ts);
  if (t <= 0n) return undefined;
  if (t >= 1000000000000n) t /= 1000n;
  const p = utcParts(t);
  return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} UTC` : undefined;
}

// upstream: content.rs::service_name_clause
export const serviceNameClause = (preposition, serviceName) => (has(serviceName) && serviceName !== '' ? `${preposition} "${serviceName}"` : '');

// upstream: content.rs::sub_asp_selected_asp_notify
export function subAspSelectedAspNotify(serviceName, buyerAgentId, jobId, tokenAmount, tokenSymbol, periodStart, periodEnd) {
  let out = `[New Subscription] You have a new subscriber${serviceNameClause(' for', serviceName)}.`;
  if (has(buyerAgentId)) out += ` Buyer: ${buyerAgentId}.`;
  out += ` Job ${jobId}`;
  const s = fmtEpoch(periodStart), e = fmtEpoch(periodEnd);
  if (s !== undefined && e !== undefined) out += `, current period ${s}–${e}`;
  if (has(tokenAmount) && has(tokenSymbol)) out += `, payment received: ${tokenAmount} ${tokenSymbol}`;
  else if (has(tokenAmount)) out += `, payment received: ${tokenAmount}`;
  out += '.';
  out += ' Please begin delivering the service.';
  return out;
}

// upstream: content.rs::sub_asp_selected_trial_asp_notify
export function subAspSelectedTrialAspNotify(serviceName, buyerAgentId, jobId, tokenAmount, tokenSymbol, trialStart, trialEnd) {
  let out = `[New Trial Subscriber] You have a new subscriber${serviceNameClause(' for', serviceName)} on a free trial`;
  const s = fmtEpoch(trialStart), e = fmtEpoch(trialEnd);
  if (s !== undefined && e !== undefined) out += ` (${s}–${e})`;
  out += '.';
  if (has(buyerAgentId)) out += ` Buyer: ${buyerAgentId}.`;
  out += ` Job ${jobId}. No payment during the trial`;
  if (has(tokenAmount)) {
    out += has(tokenSymbol) ? `; ${tokenAmount} ${tokenSymbol} will be charged on conversion` : `; ${tokenAmount} will be charged on conversion`;
    if (e !== undefined) out += ` at ${e}`;
  }
  out += '.';
  out += ' Please begin delivering the service.';
  return out;
}

// upstream: content.rs::sub_complete_notify_asp_notify
export function subCompleteNotifyAspNotify(serviceName, jobId, periodEnd) {
  let out = `[Subscription Complete] The user's subscription${serviceNameClause(' to', serviceName)} has completed all scheduled renewals. Job ${jobId} status: Completed; service ends normally`;
  const e = fmtEpoch(periodEnd);
  if (e !== undefined) out += ` at ${e}`;
  out += ' — no further delivery is required.';
  return out;
}

// upstream: content.rs::sub_close_notify_asp_notify
export function subCloseNotifyAspNotify(serviceName, jobId, aspRejectReason) {
  const svc = serviceNameClause(' to', serviceName);
  if (has(aspRejectReason) && trim(aspRejectReason) !== '') {
    return `[Assignment Closed] You declined the user's subscription${svc} before activation. Reason: ${aspRejectReason}. Job ${jobId} status: Closed — do not start or continue delivery. This notice does not confirm refund settlement and authorizes no funds action.`;
  }
  return `[Subscription Ended] The user's subscription${svc} has ended because the renewal charge failed during the grace period. Job ${jobId} status: Closed — please stop delivering the service.`;
}

// upstream: content.rs::sub_failed_notify_asp_notify (no production caller in 4.6.3)
export function subFailedNotifyAspNotify(serviceName, jobId, reason) {
  const reasonClause = has(reason) && reason !== '' ? ` (reason: ${reason})` : '';
  return `[Trial Not Converted] The user's free trial${serviceNameClause(' for', serviceName)} failed to convert to a paid subscription${reasonClause}. Job ${jobId} status: Closed — no further delivery is required.`;
}

// ── Job notification events ──

// upstream: content.rs::subscription_job_asp_accept_expire_asp_notify
export function subscriptionJobAspAcceptExpireAspNotify(serviceName, jobId, amount, tokenSymbol, isTrial, isPaid) {
  const head = `[Job Expired] You did not process ${serviceName} within 3 hours, so the job expired.\n\nJob ID: ${jobId}\nJob status: Expired\n\n`;
  if (isTrial) return `${head}Neither the subscription nor the free trial began. No further action is required.`;
  const payment = isPaid ? ` The escrowed amount of ${amount} ${tokenSymbol} will be returned to the User Agent’s wallet.` : '';
  return `${head}The subscription did not begin.${payment} No further action is required.`;
}

// upstream: content.rs::regular_job_asp_accept_expire_asp_notify
export const regularJobAspAcceptExpireAspNotify = (serviceName, jobId) => `[Job Expired] You did not process ${serviceName} within 3 hours, so the job expired.\n\nJob ID: ${jobId}\nJob status: Expired`;

// upstream: content.rs::job_delivery_expire_asp_notify
export function jobDeliveryExpireAspNotify(jobName, jobId, taskType, amount, tokenSymbol, isTrial, isPaid) {
  const payment = isTrial ? 'No refundable funds were collected during the trial, so no refund action is required.'
    : isPaid ? `Escrowed amount: ${amount} ${tokenSymbol}\nAuthoritative Expired(8) confirms that the backend completed the full refund and the funds have reached the Buyer.`
      : 'No refundable funds were collected, so no refund action is required.';
  return `[Delivery Expired] The deliverable for ${jobName} was not submitted before the deadline.\nJob ID: ${jobId}\nTask type: ${taskType}\nJob status: Expired (8)\n${payment}\n`
    + 'No further delivery, refund claim, or finalization action is required.';
}

// upstream: content.rs::subscription_job_asp_reject_closed_asp_notify
export const subscriptionJobAspRejectClosedAspNotify = (serviceName, jobId, reason) => `[Task Declined] You have declined ${serviceName}.\nJob ID: ${jobId}\nReason: ${reason}`;

// upstream: content.rs::regular_job_asp_reject_closed_asp_notify
export const regularJobAspRejectClosedAspNotify = (serviceName, jobId, reason) => `[Job Declined] You have declined ${serviceName}.\n\nJob ID: ${jobId}\nReason: ${reason}\nJob status: Closed`;

// upstream: content.rs::subscription_job_asp_reject_expire_asp_notify
export function subscriptionJobAspRejectExpireAspNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt) {
  const deadline = fmtEpoch(rejectWindowEndsAt) ?? 'Unavailable';
  return `[Automatic Refund Processing] You did not respond to the refund request for ${serviceName} by the deadline. ${amount} ${tokenSymbol} will be returned to the User Agent’s wallet.\n\n`
    + `Job ID: ${jobId}\nResponse deadline: ${deadline}\nJob status: Failed\nNo further service delivery is required.`;
}

// upstream: content.rs::regular_job_asp_reject_expire_asp_notify
export function regularJobAspRejectExpireAspNotify(serviceName, jobId, amount, tokenSymbol, rejectWindowEndsAt, isPaid) {
  const deadline = fmtEpoch(rejectWindowEndsAt) ?? 'Unavailable';
  if (isPaid) {
    return `[Automatic Refund Processing] You did not respond to the refund request for ${serviceName} by the deadline. ${amount} ${tokenSymbol} will be returned to the User Agent’s wallet.\n\n`
      + `Job ID: ${jobId}\nResponse deadline: ${deadline}\nJob status: Failed`;
  }
  return `[Refund Response Timed Out] You did not respond to the refund request for ${serviceName} by the deadline. No charges were incurred, so no refund is required.\n\n`
    + `Job ID: ${jobId}\nResponse deadline: ${deadline}\nJob status: Failed`;
}

// upstream: content.rs::sub_asp_claim_notify_asp_notify
export const subAspClaimNotifyAspNotify = (jobName, jobId, amount, tokenSymbol, txHash) => `[Income Collected] The system has automatically collected subscription income of ${amount} ${tokenSymbol} for ${jobName}. Please monitor your wallet balance.\n`
  + `\nJob ID: ${jobId}\nTransaction: ${txHash}`;

