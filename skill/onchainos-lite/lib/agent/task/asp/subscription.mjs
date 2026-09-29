// ASP-side subscription continuous-delivery support — upstream task/asp/subscription.rs:
// the subStatus model + liveness classification used by `deliver`, `subscribe-active`, and the
// two `sub_user_reject` outcomes (`subscribe-agree-refund` / `subscribe-dispute`) plus
// `subscribe-asp-claim`. Handlers print their own output (plain text) or return the success data.
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { struct } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { context } from '../../../core/errors.mjs';
import { get, at, asStr, asI64 } from '../../../core/rs/value.mjs';
import { trim, charCount } from '../../../core/rs/str.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { nowSecs } from '../../../core/rs/time.mjs';
import { home as onchainosHome } from '../../../core/home.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { sessionSend } from '../common/okx-a2a.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';
import { buildSubscriptionReasonHandoff } from './dispute-raise.mjs';

// upstream: subscription.rs::JOB_TYPE_SUBSCRIBE
export const JOB_TYPE_SUBSCRIBE = 1;
// upstream: subscription.rs::BUFFER_WINDOW_SECS
export const BUFFER_WINDOW_SECS = 86400;
// upstream: subscription.rs::SUBSCRIBE_MY_PATH
export const SUBSCRIBE_MY_PATH = '/priapi/v1/aieco/task/subscribe/my';
// upstream: subscription.rs::MAX_DISPUTE_REASON_CHARS
const MAX_DISPUTE_REASON_CHARS = 2000;

// upstream: subscription.rs::SubStatus — represented by its i64 code (Unknown(n) keeps n).
export const SubStatus = Object.freeze({
  Init: -1, Created: 0, Active: 1, Rejected: 3, Disputed: 4, Completed: 6, Closed: 7, Expired: 8, Failed: 9,
  // upstream: SubStatus::from_int
  fromInt: (code) => code,
  // upstream: SubStatus::is_active
  isActive: (s) => s === 1,
  // upstream: SubStatus::code
  code: (s) => s,
});

// upstream: subscription.rs::Routing
export const Routing = Object.freeze({ NotSubscription: 'NotSubscription', Active: 'Active', Ended: 'Ended' });

// upstream: subscription.rs::as_i64 — JSON i64 or trimmed numeric string
export function asI64Field(v, key) {
  const f = get(v, key);
  if (f === undefined) return undefined;
  const i = asI64(f);
  if (i !== undefined) return i;
  const s = asStr(f);
  return s === undefined ? undefined : parseI64(trim(s));
}

// upstream: subscription.rs::as_string — string or i64 rendered
export function asStringField(v, key) {
  const f = get(v, key);
  if (f === undefined) return undefined;
  const s = asStr(f);
  if (s !== undefined) return s;
  const i = asI64(f);
  return i === undefined ? undefined : String(i);
}

const big = (n) => BigInt(n);

// upstream: subscription.rs::SubscriptionDetail
export class SubscriptionDetail {
  constructor({ jobType, status, subEndTime, subBufferEndTime }) {
    this.jobType = jobType;
    this.status = status;
    this.subEndTime = subEndTime;
    this.subBufferEndTime = subBufferEndTime;
  }

  // upstream: SubscriptionDetail::from_json
  static fromJson(v) {
    return new SubscriptionDetail({
      jobType: asI64Field(v, 'jobType') ?? 0,
      status: SubStatus.fromInt(asI64Field(v, 'status') ?? asI64Field(v, 'subStatus') ?? -2),
      subEndTime: asI64Field(v, 'subEndTime'),
      subBufferEndTime: asI64Field(v, 'subBufferEndTime'),
    });
  }

  // upstream: SubscriptionDetail::is_subscription
  isSubscription() { return this.jobType === JOB_TYPE_SUBSCRIBE; }

  // upstream: SubscriptionDetail::effective_buffer_end → BigInt | undefined. `e + BUFFER_WINDOW_SECS`
  // is an i64 add in a release build (overflow-checks off) — it wraps, so a subEndTime within a
  // day of i64::MAX yields a negative buffer end (→ Ended), exactly as upstream.
  effectiveBufferEnd() {
    if (this.subBufferEndTime !== undefined) return big(this.subBufferEndTime);
    if (this.subEndTime !== undefined) return BigInt.asIntN(64, big(this.subEndTime) + big(BUFFER_WINDOW_SECS));
    return undefined;
  }

  // upstream: SubscriptionDetail::past_buffer
  pastBuffer(nowSecsValue) {
    const end = this.effectiveBufferEnd();
    return end === undefined ? false : big(nowSecsValue) >= end;
  }

  // upstream: SubscriptionDetail::liveness
  liveness(nowSecsValue) {
    return SubStatus.isActive(this.status) && !this.pastBuffer(nowSecsValue) ? Routing.Active : Routing.Ended;
  }
}

// ── Outbound sent-marker (dead code in 4.6.3; kept for API completeness) ──

// upstream: subscription.rs::sent_marker_path
export const sentMarkerPath = (jobId, deliveryId) => join(onchainosHome(), 'autotrade', 'sent', jobId, deliveryId);

// upstream: subscription.rs::is_already_sent
export function isAlreadySent(jobId, deliveryId) {
  try { return existsSync(sentMarkerPath(jobId, deliveryId)); } catch { return false; }
}

// upstream: subscription.rs::record_sent
export function recordSent(jobId, deliveryId) {
  const p = sentMarkerPath(jobId, deliveryId);
  mkdirSync(dirname(p), { recursive: true });
  try { closeSync(openSync(p, 'wx')); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

const subscribeAgreeRefundPath = (client, subId) => `${client.subscribePath(subId)}/agreeRefund`;
const subscribeAspClaimPath = (client, subId) => `${client.subscribePath(subId)}/aspClaim`;

// upstream: subscription.rs::fetch_detail → SubscriptionDetail | undefined (lookup errors → undefined)
export async function fetchDetail(client, jobId, agentId) {
  try { return SubscriptionDetail.fromJson(await client.fetchSubscription(jobId, agentId)); } catch { return undefined; }
}

// upstream: subscription.rs::ActiveSubscription (struct order; optional fields skipped)
export const activeSubscription = ({ jobId, subEndTime, subBufferEndTime, status }) => struct({ jobId, subEndTime, subBufferEndTime, status });

// upstream: subscription.rs::handle_active → success data (array of ActiveSubscription)
export async function handleActive(client, agentIdRaw) {
  const agentId = selectSubscriptionAgentId('', agentIdRaw);
  const now = nowSecs();
  const data = await client.getWithIdentity(SUBSCRIBE_MY_PATH, agentId);
  const list = at(data, 'list');
  const items = Array.isArray(list) ? list : (Array.isArray(data) ? data : []);
  const active = [];
  for (const item of items) {
    const pid = asStringField(item, 'providerAgentId');
    if (pid !== undefined && pid !== agentId) continue;
    const detail = SubscriptionDetail.fromJson(item);
    if (detail.liveness(now) !== Routing.Active) continue;
    const jobId = asStringField(item, 'jobId');
    if (jobId === undefined) continue;
    active.push(activeSubscription({ jobId, subEndTime: detail.subEndTime, subBufferEndTime: detail.subBufferEndTime, status: SubStatus.code(detail.status) }));
  }
  return active;
}

// Shared "POST → sign → broadcast" for the two subscription mutations.
async function subscribeMutation(client, jobIdValue, agentIdRaw, pathOf, auditEvent) {
  const agentId = selectSubscriptionAgentId('', agentIdRaw);
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  const resp = await client.postWithIdentity(pathOf(client, jobIdValue), {}, agentId);
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobIdValue, extractBizType(resp), agentId, undefined);
  auditLog('cli', auditEvent, true, 0, [`jobId=${jobIdValue}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  return txHash;
}

// upstream: subscription.rs::handle_agree_refund (prints plain text)
export async function handleAgreeRefund(client, jobId, agentId) {
  await subscribeMutation(client, jobId, agentId, subscribeAgreeRefundPath, 'ASP/subscribe_agree_refund_submitted');
  process.stdout.write('✓ Full refund for this subscription period submitted\n'
    + '  Progress will update in this task.\n'
    + "  Ask me to view this task's details for the refund result.\n");
}

// upstream: subscription.rs::handle_asp_claim (prints plain text)
export async function handleAspClaim(client, jobId, agentId) {
  const txHash = await subscribeMutation(client, jobId, agentId, subscribeAspClaimPath, 'ASP/subscribe_asp_claim_submitted');
  process.stdout.write('✓ Claim submitted for accrued subscription income, waiting for on-chain confirmation\n'
    + `  txHash: ${txHash}\n`
    + '\n'
    + '⚠️  This claims your own funds only — no buyer action is involved; do not message the buyer.\n');
}

// upstream: subscription.rs::handle_dispute (prints plain text)
export async function handleDispute(client, jobId, reason, agentIdRaw) {
  const agentId = selectSubscriptionAgentId('', agentIdRaw);
  if (trim(reason) === '') throw new Error('Evaluation reason is required. Pass the provided evaluation reason with --reason.');
  if (charCount(reason) > MAX_DISPUTE_REASON_CHARS) throw new Error(`Evaluation reason exceeds ${MAX_DISPUTE_REASON_CHARS} characters. Please shorten it and try again.`);
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  let detail;
  try { detail = await client.fetchSubscription(jobId, agentId); } catch (e) { throw context('subscribe-dispute: failed to fetch subscription detail for reason handoff', e); }
  const buyer = [asStr(at(detail, 'buyerAgentId')) ?? asStr(at(detail, 'userAgentId'))].find((v) => v !== undefined && trim(v) !== '');
  if (buyer === undefined) throw new Error('subscribe-dispute: subscription detail missing buyerAgentId for reason handoff');
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'dispute/approveAndCreateDispute'), {}, agentId);
  const handoff = buildSubscriptionReasonHandoff(jobId, agentId, reason);
  try { await sessionSend(jobId, buyer, handoff); } catch (e) {
    throw context('subscribe-dispute: failed to hand off the evaluation reason to the task session; combined dispute transaction was not broadcast', e);
  }
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, { reason });
  auditLog('cli', 'ASP/subscribe_dispute_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write('✓ Evaluation request submitted\n'
    + '  Progress will update in this task.\n'
    + "  Ask me to view this task's details for the evaluation result.\n");
}
