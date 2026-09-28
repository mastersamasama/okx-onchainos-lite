// PRIVATE port of upstream task/evaluator/dispute_status.rs::{DisputeStatusResponse,
// get_dispute_status} (owned by the evaluator unit) — needed by arbitration / status /
// refund-detail. Fields are the camelCase Rust field names (Option → null).
import { S, fromValue } from '../_serde.mjs';
import { context } from '../../core/errors.mjs';

// upstream: dispute_status.rs::DisputeStatusResponse
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

// serde_json::from_value::<DisputeStatusResponse>(v)
export const decodeDisputeStatus = (v) => fromValue(DISPUTE_STATUS_RESPONSE, v);

// upstream: dispute_status.rs::get_dispute_status
export async function getDisputeStatus(client, jobId, agentId) {
  const data = await client.getWithIdentity(client.endpoint(jobId, 'dispute/status'), agentId);
  try { return decodeDisputeStatus(data); } catch (e) { throw context('failed to parse dispute/status response', e); }
}
