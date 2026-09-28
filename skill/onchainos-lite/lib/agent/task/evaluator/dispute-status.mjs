// `dispute/status` hard-gate helper — upstream task/evaluator/dispute_status.rs:
// `DisputeStatusResponse`, `get_dispute_status`, and the four-gate `precheck_round_gate`
// that `evidence-info` runs before downloading evidence.
import { context } from '../../../core/errors.mjs';
import { S, fromValue } from '../../_serde.mjs';
import { rustDebugStr } from '../../_rs.mjs';
import { Status, DisputeRoundStatus } from '../common/state-machine.mjs';
import { taskStatusLabel, taskStatusDescription } from '../common/query.mjs';

// upstream: dispute_status.rs::DisputeStatusResponse (fields camelCase; Option → null)
export const DISPUTE_STATUS_RESPONSE = S.struct('DisputeStatusResponse', [
  ['jobId', S.string],
  ['jobType', S.option(S.i32), { default: null }],
  ['currentRound', S.option(S.i64), { default: null }],
  ['selectedVoter', S.option(S.ignored), { default: null }],
  ['taskStatus', S.i32, { default: 0 }],
  ['disputeRoundStatus', S.option(S.i32), { default: null, aliases: ['disputeStatus'] }],
  ['prepareEndTime', S.option(S.i64), { default: null }],
  ['roundEndTime', S.option(S.i64), { default: null }],
  ['tokenAmount', S.option(S.string), { default: null }],
  ['tokenSymbol', S.option(S.string), { default: null }],
]);

// serde_json::from_value::<DisputeStatusResponse>
export const decodeDisputeStatusResponse = (v) => fromValue(DISPUTE_STATUS_RESPONSE, v);

// upstream: dispute_status.rs::evaluator_task_is_terminal
export const evaluatorTaskIsTerminal = (status) => status === Status.Completed || status === Status.Close || status === Status.Expired || status === Status.Failed;

// upstream: dispute_status.rs::get_dispute_status
export async function getDisputeStatus(client, jobId, agentId) {
  const data = await client.getWithIdentity(client.endpoint(jobId, 'dispute/status'), agentId);
  try { return decodeDisputeStatusResponse(data); } catch (e) { throw context('failed to parse dispute/status response', e); }
}

// Rust `str::parse::<i64>()` → { ok } | { err: ParseIntError Display }
function parseI64Result(s) {
  if (s === '') return { err: 'cannot parse integer from empty string' };
  if (!/^[+-]?[0-9]+$/.test(s)) return { err: 'invalid digit found in string' };
  const v = BigInt(s);
  if (v > 9223372036854775807n) return { err: 'number too large to fit in target type' };
  if (v < -9223372036854775808n) return { err: 'number too small to fit in target type' };
  return { ok: v };
}

const fmtOpt = (n) => (n === null || n === undefined ? 'null' : String(n));

// upstream: dispute_status.rs::gate_reason → reason text | undefined (all gates pass)
export function gateReason(s, roundNum) {
  const taskStatus = Status.fromInt(s.taskStatus);
  const drs = s.disputeRoundStatus === null ? null : DisputeRoundStatus.fromInt(s.disputeRoundStatus);
  if (evaluatorTaskIsTerminal(taskStatus)) return `taskStatus=${s.taskStatus} (${Status.asStr(taskStatus)}) is terminal — task finished, evaluation window closed`;
  const req = parseI64Result(roundNum);
  if (req.err !== undefined) return `--round-num cannot be parsed as integer: ${rustDebugStr(roundNum)} (${req.err})`;
  if (s.currentRound === null) return 'currentRound=null — no active evaluation (task is not under evaluation / already ended / backend has not advanced round)';
  if (req.ok !== BigInt(s.currentRound)) return `round mismatch: envelope round_num=${req.ok} != on-chain currentRound=${s.currentRound} (stale envelope)`;
  if (drs === null) return 'disputeStatus=null — evaluation sub-state-machine not started / already settled (commit window guaranteed closed)';
  if (drs !== DisputeRoundStatus.CommitPhase) {
    return `disputeStatus=${fmtOpt(s.disputeRoundStatus)} (${DisputeRoundStatus.asStr(drs)}) is not ${DisputeRoundStatus.asStr(DisputeRoundStatus.CommitPhase)} — commit window not open / already closed`;
  }
  if (s.selectedVoter === null) return 'selectedVoter=null — this account is not the selected juror for the current round';
  return undefined;
}

// upstream: dispute_status.rs::precheck_round_gate → true (selected) | false; prints the status block
export async function precheckRoundGate(client, jobId, agentId, roundNum) {
  const s = await getDisputeStatus(client, jobId, agentId);
  const drs = s.disputeRoundStatus === null ? null : DisputeRoundStatus.fromInt(s.disputeRoundStatus);
  let out = `evaluation status (jobId=${s.jobId})\n`
    + `  currentRound : ${fmtOpt(s.currentRound)}\n`
    + `  Task status: ${taskStatusLabel(s.taskStatus)}\n`
    + `  Status description: ${taskStatusDescription(s.taskStatus)}\n`
    + `  Evaluation round status: ${drs === null ? 'Round status unavailable' : DisputeRoundStatus.displayLabel(drs)}\n`
    + `  Evaluation round description: ${drs === null ? 'The evaluation round status is currently unavailable.' : DisputeRoundStatus.displayDescription(drs)}\n`
    + `  selectedVoter: ${s.selectedVoter !== null ? 'present (this account is selected as juror for current round)' : 'null (not selected for current round / notification expired / no active evaluation)'}\n`;
  const reason = gateReason(s, roundNum);
  out += reason === undefined ? '\nselected: yes\n' : `\nreason: ${reason}\nselected: no\n`;
  process.stdout.write(out);
  return reason === undefined;
}
