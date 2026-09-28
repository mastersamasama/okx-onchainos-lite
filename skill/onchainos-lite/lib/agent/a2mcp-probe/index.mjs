// OKX.AI A2MCP direct invocation with short-lived local prepared state — upstream
// commands/agent_commerce/a2mcp_probe/mod.rs (the six `agent a2mcp-probe …` sub-commands).
import { displayTop } from '../../wallet/api.mjs';
import { ERR_PREPARED_EXPIRED_OR_MISSING, ERR_INVALID_INTENT } from '../../payment/a2mcp.mjs';
import { Action, ProbeDecision } from './_model.mjs';
import { ERR_FREE_RESULT_EXPIRED_OR_MISSING } from './free-result.mjs';
import { runConfirmFree, runFunding, runPreparePayment, runProbe, runRefreshBalance, runResumeAfterFunding } from './flow.mjs';

export {
  PROBE_TIMEOUT_MS, ContractError, Action, ProbeDecision, confirmationPresentation, paidFeeDisplay, defaultStringType, defaultTrue,
} from './_model.mjs';
export { decodeProbeJsonArgs } from './flow.mjs';

// upstream: mod.rs::A2mcpProbeCommand
export const A2mcpProbeCommand = Object.freeze({
  Probe: 'Probe', ConfirmFree: 'ConfirmFree', RefreshBalance: 'RefreshBalance', Funding: 'Funding',
  ResumeAfterFunding: 'ResumeAfterFunding', PreparePayment: 'PreparePayment',
});

// upstream: mod.rs::normalize_invocation_result — recoverable state errors become an
// `invocation_recovery` decision; anything else propagates (exit 1).
export async function normalizeInvocationResult(promise) {
  let error;
  try { return await promise; } catch (e) { error = e; }
  const message = displayTop(error);
  let reason;
  if (message.startsWith(ERR_PREPARED_EXPIRED_OR_MISSING)) reason = 'a2mcp_prepared_expired_or_missing';
  else if (message.startsWith(ERR_FREE_RESULT_EXPIRED_OR_MISSING)) reason = 'a2mcp_free_result_expired_or_missing';
  else if (message.startsWith('a2mcp_invalid_payment_candidate') || (message.startsWith(ERR_INVALID_INTENT) && message.includes('unknown candidate'))) {
    reason = 'a2mcp_candidate_invalid_or_missing';
  } else if (message.startsWith('a2mcp_funding_continuation_required')) reason = 'a2mcp_funding_continuation_required';
  else throw error;
  return new ProbeDecision({
    phase: 'invocation_recovery', decision: 'blocked', reason, nextAction: [Action.new('cancel_a2mcp', true)],
    payload: { schemaVersion: 1, message },
  });
}

// upstream: mod.rs::run(command) — command = {kind: A2mcpProbeCommand, …args}; returns the
// ProbeDecision struct the dispatcher prints as {"ok":true,"data":…}.
export async function run(command) {
  let decision;
  switch (command.kind) {
    case A2mcpProbeCommand.Probe: decision = await runProbe(command); break;
    case A2mcpProbeCommand.ConfirmFree: decision = await normalizeInvocationResult(Promise.resolve().then(() => runConfirmFree(command))); break;
    case A2mcpProbeCommand.RefreshBalance: decision = await normalizeInvocationResult(runRefreshBalance(command)); break;
    case A2mcpProbeCommand.Funding: decision = await normalizeInvocationResult(runFunding(command)); break;
    case A2mcpProbeCommand.ResumeAfterFunding: decision = await normalizeInvocationResult(runResumeAfterFunding(command)); break;
    case A2mcpProbeCommand.PreparePayment: decision = await normalizeInvocationResult(runPreparePayment(command)); break;
    default: throw new Error(`unknown a2mcp-probe command ${command.kind}`);
  }
  return decision.toStruct();
}
