// One-time evaluation request (combined approve-and-create) — upstream task/asp/dispute_raise.rs.
// The exact ASP reason is handed to the task session before the combined transaction is
// broadcast; the later `job_disputed` / `sub_asp_dispute` event reuses it for the evidence upload.
import { stringify, displayF64 } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { context, FundingBlocked } from '../../../core/errors.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import { isObject, at, asStr, cloneValue } from '../../../core/rs/value.mjs';
import { trim, charCount } from '../../../core/rs/str.mjs';
import { B64 } from '../../../core/rs/codec.mjs';
import { ensureSufficientBalanceAt } from '../common/util.mjs';
import { enrichBlockingAt, balanceWarningBase, InsufficientBalanceError } from '../common/deposit-qr.mjs';
import { fundingBlockedEnvelope } from '../common/funding-notice.mjs';
import { sessionSend } from '../common/okx-a2a.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';

const MAX_REASON_CHARS = 2000;
// upstream: dispute_raise.rs::ARBITRATION_REASON_CONTEXT
export const ARBITRATION_REASON_CONTEXT = '[ARBITRATION_REASON_CONTEXT]';
const AGENT_ID_REQUIRED = "--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)";

// upstream: dispute_raise.rs::ReasonHandoffFlow
export const ReasonHandoffFlow = Object.freeze({ OneTime: 'OneTime', Subscription: 'Subscription' });

// upstream: dispute_raise.rs::build_reason_handoff_for
export function buildReasonHandoffFor(jobId, providerAgentId, reason, flow) {
  const ctx = { version: 1, intent: 'arbitration_reason_context', jobId, providerAgentId, reason, reasonB64: B64.URL_SAFE_NO_PAD.encode(Buffer.from(reason, 'utf8')) };
  const resumeEvent = flow === ReasonHandoffFlow.OneTime ? 'job_disputed' : 'sub_asp_dispute';
  ctx.taskType = flow === ReasonHandoffFlow.OneTime ? 'one_time' : 'subscription';
  ctx.resumeEvent = resumeEvent;
  const instruction = `Keep this exact reason in the current task conversation and end this turn. When the matching ${resumeEvent} event arrives, include it as the ASP's evaluation reason in the evidence upload.`;
  return `${ARBITRATION_REASON_CONTEXT}\n${stringify(ctx)}\n${instruction}`;
}

// upstream: dispute_raise.rs::build_reason_handoff
export const buildReasonHandoff = (jobId, providerAgentId, reason) => buildReasonHandoffFor(jobId, providerAgentId, reason, ReasonHandoffFlow.OneTime);
// upstream: dispute_raise.rs::build_subscription_reason_handoff
export const buildSubscriptionReasonHandoff = (jobId, providerAgentId, reason) => buildReasonHandoffFor(jobId, providerAgentId, reason, ReasonHandoffFlow.Subscription);

// upstream: dispute_raise.rs::with_sa_batch_tx_flag — clone of uopData with extraData.isSaBatchTx = true
export function withSaBatchTxFlag(uopData) {
  const flagged = cloneValue(uopData);
  const extra = isObject(flagged) ? flagged.extraData : undefined;
  if (!isObject(extra)) throw new Error('approveAndCreateDispute response missing object uopData.extraData');
  extra.isSaBatchTx = true;
  return flagged;
}

// `str.parse::<f64>().unwrap_or(0.0)`
function parseF64Or0(s) {
  try { return parseRustF64(s); } catch { return 0; }
}

// upstream: dispute_raise.rs::handle_dispute_raise (prints plain text)
export async function handleDisputeRaise(client, jobId, reason, agentId) {
  if (agentId === '') throw new Error(AGENT_ID_REQUIRED);
  if (trim(reason) === '') throw new Error('Evaluation reason is required. Pass the provided evaluation reason with --reason.');
  if (charCount(reason) > MAX_REASON_CHARS) throw new Error(`Evaluation reason exceeds ${MAX_REASON_CHARS} characters. Please shorten it and try again.`);
  const [accountId, address] = await resolveWalletByAgentId(agentId);

  let taskResp;
  try { taskResp = await client.getWithIdentity(client.taskPath(jobId), agentId); } catch (e) {
    throw context('dispute raise: failed to fetch task details (deposit precheck)', e);
  }
  const taskAmount = parseF64Or0(asStr(at(taskResp, 'tokenAmount')) ?? '0');
  const tokenSymbol = asStr(at(taskResp, 'tokenSymbol')) ?? '?';
  if (taskAmount > 0) {
    const required = taskAmount * 0.05;
    try { await ensureSufficientBalanceAt(required, tokenSymbol, address); } catch (e) {
      const wrapped = context(`Requesting evaluation requires a deposit >= 5% of the task amount (${displayF64(required)} ${tokenSymbol}; task amount ${displayF64(taskAmount)} ${tokenSymbol})`, e);
      throw printDisputeFundingBlockFromError(enrichBlockingAt(wrapped, address));
    }
  }

  let evaluationResp;
  try { evaluationResp = await client.postWithIdentity(client.endpoint(jobId, 'dispute/approveAndCreateDispute'), {}, agentId); } catch (e) {
    throw context('dispute raise: approveAndCreateDispute API request failed', e);
  }
  const evaluationUopData = withSaBatchTxFlag(at(evaluationResp, 'uopData'));

  const buyer = [asStr(at(taskResp, 'buyerAgentId')) ?? asStr(at(taskResp, 'userAgentId'))].find((v) => v !== undefined && trim(v) !== '');
  if (buyer === undefined) throw new Error('dispute raise: task detail missing buyerAgentId for reason handoff');
  try { await sessionSend(jobId, buyer, buildReasonHandoff(jobId, agentId, reason)); } catch (e) {
    throw context('dispute raise: failed to hand off the evaluation reason to the task session; combined transaction was not broadcast', e);
  }

  let evaluationTx;
  try {
    evaluationTx = await signUopAndBroadcast(client, evaluationUopData, accountId, address, jobId, extractBizType(evaluationResp), agentId, { reason });
  } catch (e) { throw context('dispute raise: approveAndCreateDispute on-chain broadcast failed', e); }

  auditLog('cli', 'ASP/evaluation_requested', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `reasonLen=${charCount(reason)}`, `txHash=${evaluationTx}`]);
  process.stdout.write('✓ Evaluation request submitted\n'
    + '  Progress will update in this task.\n'
    + "  Ask me to view this task's details for the evaluation result.\n");
}

// upstream: dispute_raise.rs::print_dispute_funding_block_from_error → the error to raise
export function printDisputeFundingBlockFromError(err) {
  if (!(err instanceof InsufficientBalanceError)) return err;
  const warning = balanceWarningBase(err);
  if (err.depositAddress !== undefined && err.depositAddress !== null) {
    warning.depositAddress = err.depositAddress;
    warning.depositChain = err.depositChain;
  }
  return new FundingBlocked(fundingBlockedEnvelope(warning, 'dispute-bond', 'Evaluation bond'));
}
