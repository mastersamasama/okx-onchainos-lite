// agent_commerce shared helpers — upstream commands/agent_commerce/mod.rs: the pre-dispatch
// maintenance hook, `escape_control_chars_in_strings`, the `--a2a-file` validator/spool, the
// next-action freshness gate (`check_status_freshness` + policy tables) and the `next-action`
// dispatcher itself. Per-role playbooks live in the user / asp / evaluator partitions.
import { lstatSync, realpathSync, readFileSync, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from '../core/json.mjs';
import { auditLog } from '../core/audit.mjs';
import { sleep } from '../core/proc.mjs';
import { fromStr } from '../core/serde.mjs';
import { displayTop } from '../wallet/api.mjs';
import { get, at, asStr, asI64, isObject } from '../core/rs/value.mjs';
import { trim, lines, debugOptInt } from '../core/rs/str.mjs';
import { ioErrorText, decodeUtf8, INVALID_UTF8, readToString } from '../core/rs/fs.mjs';
import { nowNanos } from '../core/rs/time.mjs';
import { Event, Status, parseStatusOrEvent, statusWhenEvent } from './task/common/state-machine.mjs';
import { validateJobId } from './task/common/util.mjs';
import { PreFetchedTaskContext, preFetchedDeliverable, queryAgentByIdDirect } from './task/common/index.mjs';
import { TaskApiClient } from './task/common/network/task-api-client.mjs';
import { markPending, markApproved } from './task/common/review-gate.mjs';
import { readManifest, deliverablesDir } from './task/common/deliverables.mjs';
import * as arbitration from './task/arbitration.mjs';
import * as executor from './task/common/autotrade/executor.mjs';
import * as deliveryQueue from './task/common/autotrade/delivery-queue.mjs';
import {
  isZeroDecimal, refundEventSettlementConfirmed, fetchAuthoritativeRefundContext, fetchAuthoritativeRefundContextForProvider,
} from './task/user/refund.mjs';
import { saveDesignatedProvider, hasDesignatedProvider } from './task/user/negotiate.mjs';
import { tryRecoverFromTempFile } from './task/user/index.mjs';
import { generateNextAction as userNextAction } from './task/user/flow.mjs';
import { generateNextAction as aspNextAction } from './task/asp/flow.mjs';
import { generateNextAction as evaluatorNextAction } from './task/evaluator/flow.mjs';

// upstream: mod.rs::run pre-dispatch maintenance (autotrade executor / delivery queue), run once
// per `agent` invocation by core/main.mjs; every result is ignored and an empty state dir makes
// all four no-ops.
export async function runPreDispatchMaintenance() {
  try { await executor.reconcileTerminalJournals(4, 100); } catch {}
  try { await executor.flushAllDue(1); } catch {}
  try { await executor.cleanupExpiredTickets(8); } catch {}
  try { await deliveryQueue.flushDue(1, 100); } catch {}
}

// upstream: mod.rs::tx_failure_label
export const txFailureLabel = (event) => Event.failureLabel(Event.parse(event));
// upstream: mod.rs::expired_timeout_uses_authoritative_status
export const expiredTimeoutUsesAuthoritativeStatus = (e) => e === 'job_expired' || e === 'submit_expired' || e === 'job_asp_accept_expire';

// upstream: mod.rs::escape_control_chars_in_strings
export function escapeControlCharsInStrings(s) {
  let out = '', inString = false, escaped = false;
  for (const ch of String(s)) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; out += ch; }
    else if (ch === '"') { inString = !inString; out += ch; }
    else if (ch === '\n' && inString) out += '\\n';
    else if (ch === '\r' && inString) out += '\\r';
    else if (ch === '\t' && inString) out += '\\t';
    else out += ch;
  }
  return out;
}

// ─── --a2a-file ───
function isPathUnderCanonicalDir(path, dir) {
  let p, d;
  try { p = realpathSync.native(path); d = realpathSync.native(dir); } catch { return false; }
  if (p === d) return true;
  const prefix = d.endsWith(sep) ? d : d + sep;
  return process.platform === 'win32' ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
}
function isSafeA2aFilePath(path) {
  if (path === '') return false;
  if (isPathUnderCanonicalDir(path, tmpdir())) return true;
  if (process.platform !== 'win32' && isPathUnderCanonicalDir(path, '/tmp')) return true;
  return false;
}
let SPOOL_SEQ = 0n;
function writeSecureTempFile(path, contents) {
  const parent = join(path, '..');
  mkdirSync(parent, { recursive: true });
  const fname = path.slice(parent.length + 1) || 'a2a';
  const ts = nowNanos();
  for (let n = 0; n < 20; n++) {
    const tmp = join(parent, `.${fname}.${process.pid}.${ts}.${n}.tmp`);
    let fd;
    try { fd = openSync(tmp, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { writeSync(fd, contents); fsyncSync(fd); } catch (e) { try { closeSync(fd); } catch {} try { rmSync(tmp, { force: true }); } catch {} throw e; }
    closeSync(fd);
    try { renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
    return;
  }
  throw Object.assign(new Error('could not allocate a unique temp file'), { code: 'EEXIST_CUSTOM' });
}
function persistValidatedA2aSpool(jobId, canonical) {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('--a2a-file: invalid jobId for the spool filename');
  const dir = tmpdir();
  mkdirSync(dir, { recursive: true });
  const ts = nowNanos();
  const seq = SPOOL_SEQ++;
  for (let n = 0; n < 20; n++) {
    const name = n === 0 ? `a2a_deliver_${jobId}_${ts}_${process.pid}_${seq}.json` : `a2a_deliver_${jobId}_${ts}_${process.pid}_${seq}_${n}.json`;
    const path = join(dir, name);
    if (existsSync(path)) continue;
    try { writeSecureTempFile(path, Buffer.from(canonical, 'utf8')); } catch (e) {
      throw new Error(`--a2a-file secure spool write failed: ${e.code === 'EEXIST_CUSTOM' ? e.message : ioErrorText(e)}`);
    }
    return path;
  }
  throw new Error('--a2a-file: could not allocate a unique spool filename');
}

// upstream: mod.rs::validate_a2a_file_arg → spool path
export function validateA2aFileArg(path, messageJobId, agentId) {
  if (!isSafeA2aFilePath(path)) throw new Error('--a2a-file must point to a file under the OS temp directory');
  let meta;
  try { meta = lstatSync(path); } catch (e) { throw new Error(`--a2a-file metadata read failed: ${ioErrorText(e)}`); }
  if (!meta.isFile()) throw new Error('--a2a-file must be a regular file, not a symlink or directory');
  if (process.platform !== 'win32' && (meta.mode & 0o777) !== 0o600) throw new Error('--a2a-file must have mode 0600; run chmod 600');
  let raw;
  try { raw = readFileSync(path); } catch (e) { throw new Error(`--a2a-file read failed: ${ioErrorText(e)}`); }
  let text;
  // read_to_string keeps a leading U+FEFF (serde_json then rejects it).
  try { text = decodeUtf8(raw); } catch { throw new Error(`--a2a-file read failed: ${INVALID_UTF8}`); }
  text = trim(text);
  if (text === '') throw new Error('--a2a-file payload is empty');
  let payload;
  try { payload = fromStr(text); } catch (e) { throw new Error(`--a2a-file payload is not valid JSON: ${e.message}`); }
  const msgType = asStr(get(payload, 'msgType'));
  if (msgType === undefined) throw new Error('--a2a-file payload.msgType is required');
  if (msgType !== 'a2a-agent-chat') throw new Error('--a2a-file payload.msgType must be a2a-agent-chat');
  const pj = asStr(get(payload, 'jobId'));
  if (pj === undefined) throw new Error('--a2a-file payload.jobId is required');
  if (pj !== messageJobId) throw new Error(`--a2a-file payload jobId ${pj} does not match --message jobId ${messageJobId}`);
  const receiver = asStr(get(payload, 'receiverAgentId'));
  if (receiver === undefined) throw new Error('--a2a-file payload.receiverAgentId is required');
  if (receiver !== agentId) throw new Error(`--a2a-file receiverAgentId ${receiver} does not match --agentId ${agentId}`);
  const content = asStr(get(payload, 'content'));
  if (content === undefined) throw new Error('--a2a-file payload.content is required');
  const ls = lines(content);
  let lastNonBlank;
  for (let i = ls.length - 1; i >= 0; i--) if (trim(ls[i]) !== '') { lastNonBlank = trim(ls[i]); break; }
  if (lastNonBlank !== '[intent:deliver]') throw new Error('--a2a-file content must end with [intent:deliver]');
  let embedded;
  for (const l of ls) { const t = trim(l); if (t.startsWith('jobId:')) { embedded = trim(t.slice('jobId:'.length)); break; } }
  if (embedded === undefined) throw new Error('--a2a-file content.jobId is required');
  if (embedded !== pj) throw new Error(`--a2a-file content jobId ${embedded} does not match payload jobId ${pj}`);
  return persistValidatedA2aSpool(pj, stringify(payload));
}

// ─── freshness policy tables ───
// upstream: mod.rs::handler_fetches_own_task_detail
export const handlerFetchesOwnTaskDetail = (role, event) => ((role === 'user' || role === 'asp') && event === 'job_completed') || (role === 'user' && event === 'sub_complete_notify');
// upstream: mod.rs::should_block_legacy_a2mcp_flow
export const shouldBlockLegacyA2mcpFlow = (paymentMode, event) => paymentMode !== null && paymentMode !== undefined && Number(paymentMode) === 3 && event !== 'sub_complete_notify' && event !== 'job_completed';
const detailPathForEvent = (c, jobId, event) => (event.startsWith('sub_') || event === 'user_decision_sub_user_reject' ? c.subscribePath(jobId) : c.taskPath(jobId));
function i64OrStr(v) {
  const i = asI64(v);
  if (i !== undefined) return i;
  const s = asStr(v);
  if (s === undefined || !/^[+-]?[0-9]+$/.test(s)) return undefined;
  const b = BigInt(s);
  return b >= -9223372036854775808n && b <= 9223372036854775807n ? (Number.isSafeInteger(Number(b)) ? Number(b) : b) : undefined;
}
// upstream: mod.rs::subscription_acceptance_status
export const subscriptionAcceptanceStatus = (d) => i64OrStr(at(d, 'subStatus')) ?? i64OrStr(at(d, 'status'));
function subscriptionEventBlockReason(detail, event, expected, name) {
  const status = subscriptionAcceptanceStatus(detail);
  if (status === undefined) return `[next-action blocked] Latest subscription detail has no valid subStatus/status. Do not execute the ${event} flow.`;
  if (Number(status) === expected) return undefined;
  return `[next-action blocked] Latest subscription status is ${status}, not ${name}(${expected}). Do not execute the ${event} flow.`;
}
// upstream: mod.rs::refund_event_status_policy → [status, requiresFinal] | undefined
export function refundEventStatusPolicy(event) {
  if (event === 'job_closed' || event === 'job_asp_reject_closed') return [7, true];
  if (['job_refunded', 'job_auto_refunded', 'sub_asp_agree', 'sub_reject_refund_notify'].includes(event)) return [9, true];
  if (['job_expired', 'submit_expired', 'job_asp_accept_expire'].includes(event)) return [8, false];
  if (event === 'job_asp_reject_expire') return [9, true];
  return undefined;
}
// upstream: mod.rs::buyer_refund_event_status_policy
export const buyerRefundEventStatusPolicy = (role, event) => (role === 'user' ? refundEventStatusPolicy(event) : undefined);
const st = (ctx) => (ctx.status === null || ctx.status === undefined ? undefined : Number(ctx.status));
// upstream: mod.rs::asp_refund_context_block_reason
export function aspRefundContextBlockReason(ctx, event, expectedAsp) {
  const p = refundEventStatusPolicy(event);
  if (!p) return undefined;
  if (ctx.providerAgentId !== expectedAsp) return `[next-action blocked] Fresh task detail does not bind ${event} to ASP ${expectedAsp}. Do not notify or clean up a provider session from caller-supplied event data.`;
  if (st(ctx) !== p[0]) return `[next-action blocked] Fresh task detail status ${debugOptInt(ctx.status)} does not match ${event} expected status ${p[0]}. Do not notify or clean up a provider session from stale event data.`;
  return undefined;
}
// upstream: mod.rs::subscription_side_effect_event_status_policy
export const subscriptionSideEffectEventStatusPolicy = (e) => ({ sub_user_reject: 3, sub_asp_dispute: 4, sub_complete_notify: 6, sub_close_notify: 7, sub_failed_notify: 9 })[e];
// upstream: mod.rs::subscription_side_effect_context_block_reason
export function subscriptionSideEffectContextBlockReason(ctx, event, role, expected) {
  const s = subscriptionSideEffectEventStatusPolicy(event);
  if (s === undefined) return undefined;
  let owner;
  if (role === 'user') owner = ctx.userAgentId;
  else if (role === 'asp') owner = ctx.providerAgentId;
  else return `[next-action blocked] Role ${role} cannot process subscription lifecycle event ${event}.`;
  if (owner !== expected) return `[next-action blocked] Fresh subscription detail does not bind ${event} to ${role} Agent ${expected}. Do not run notification, evidence-upload, decision, or cleanup side effects from caller-supplied event data.`;
  if (st(ctx) !== s) return `[next-action blocked] Fresh subscription status ${debugOptInt(ctx.status)} does not match ${event} expected status ${s}. Do not run lifecycle side effects from stale event data.`;
  return undefined;
}
// upstream: mod.rs::refund_final_context_ready
export function refundFinalContextReady(ctx, event, expectedUser) {
  const expected = refundEventStatusPolicy(event)?.[0] ?? 9;
  if (st(ctx) !== expected || ctx.userAgentId !== expectedUser) return false;
  const jt = ctx.jobType === null || ctx.jobType === undefined ? undefined : Number(ctx.jobType);
  if (expected === 7 && jt === 0 && isZeroDecimal(trim(ctx.tokenAmount))) return true;
  if (event === 'job_asp_reject_expire' && jt === 0 && isZeroDecimal(trim(ctx.tokenAmount))) return true;
  return refundEventSettlementConfirmed(ctx, expected, event);
}
// upstream: mod.rs::buyer_refund_freshness_ready
export function buyerRefundFreshnessReady(ctx, event, expectedUser, expectedStatus, requiresConfirmed) {
  if (st(ctx) !== expectedStatus || ctx.userAgentId !== expectedUser) return false;
  if (!requiresConfirmed || (event === 'job_asp_reject_closed' && Number(ctx.jobType) === 1 && ctx.jobType !== null)) return true;
  return refundFinalContextReady(ctx, event, expectedUser);
}
// upstream: mod.rs::dispute_result_context_block_reason
export function disputeResultContextBlockReason(ctx, expectedUser) {
  const jt = ctx.jobType === null || ctx.jobType === undefined ? undefined : Number(ctx.jobType);
  if (jt !== 0 && jt !== 1) return '[next-action blocked] Fresh evaluation detail is missing a supported jobType. Do not announce a verdict, rate, notify, or clean up from caller-supplied event data.';
  if (ctx.userAgentId !== expectedUser) return `[next-action blocked] Fresh evaluation detail does not bind dispute_resolved to User Agent ${expectedUser}. Do not announce a verdict, rate, notify, or clean up from caller-supplied event data.`;
  if (!ctx.refundRequestProvenance) return '[next-action blocked] Fresh terminal status has no durable local refund-request provenance. Do not treat an ordinary completion/failure as an evaluation verdict or run rating/cleanup side effects.';
  const s = st(ctx);
  if (s === 6) return undefined;
  if (s === 9 && refundEventSettlementConfirmed(ctx, 9, 'dispute_resolved')) return undefined;
  if (s === 9) return '[next-action blocked] Fresh subscription Failed(9) is ambiguous and has no durable local refund-request provenance. Do not announce an evaluation refund or clean up; reconcile with refund-prepare.';
  return `[next-action blocked] Fresh evaluation status ${debugOptInt(ctx.status)} is not Completed(6) or a confirmed user-refund Failed(9). Do not announce a verdict, rate, notify, or clean up.`;
}
// upstream: mod.rs::subscription_failed_context_block_reason
export function subscriptionFailedContextBlockReason(ctx, expectedUser) {
  if (Number(ctx.jobType) !== 1 || ctx.jobType === null) return '[next-action blocked] Fresh detail does not identify a subscription for sub_failed_notify. Do not notify or clean up from a task-type-mismatched event.';
  if (ctx.userAgentId !== expectedUser) return `[next-action blocked] Fresh subscription detail does not bind sub_failed_notify to User Agent ${expectedUser}. Do not notify or clean up from caller-supplied event data.`;
  if (st(ctx) !== 9) return `[next-action blocked] Fresh subscription status ${debugOptInt(ctx.status)} is not Failed(9). Do not notify or clean up from a stale sub_failed_notify event.`;
  return undefined;
}
// upstream: mod.rs::arbitration_decision_source
export function arbitrationDecisionSource(e) {
  if (e === 'job_rejected' || e === 'user_decision_job_rejected') return arbitration.JOB_REJECTED;
  if (e === 'sub_user_reject' || e === 'user_decision_sub_user_reject') return arbitration.SUB_USER_REJECT;
  return undefined;
}
// upstream: mod.rs::arbitration_decision_is_stale
export function arbitrationDecisionIsStale(source, message, detail) {
  const sc = (v) => arbitration.scalarString(v);
  if (source === arbitration.JOB_REJECTED) return sc(get(detail, 'status')) !== '3';
  if (source === arbitration.SUB_USER_REJECT) {
    const status = sc(get(detail, 'subStatus')) ?? sc(get(detail, 'status'));
    const params = message === undefined || message === null ? undefined : get(message, 'params');
    const k = asStr(get(params, 'decisionBindingKey')), v = asStr(get(params, 'decisionBindingValue'));
    let periodMatches;
    if (k !== undefined && v !== undefined) periodMatches = sc(get(detail, k)) === v;
    else periodMatches = ['periodIndex', 'subStartTime', 'subEndTime'].every((key) => {
      const expected = sc(message === undefined || message === null ? undefined : get(message, key));
      return expected === undefined ? true : sc(get(detail, key)) === expected;
    });
    return status !== '3' || !periodMatches;
  }
  return true;
}
// upstream: mod.rs::arbitration_context_is_stale
export function arbitrationContextIsStale(role, event, source, expectedAgent, message, ctx, detail) {
  const freeTerminal = role === 'asp' && event === 'job_rejected' && source === arbitration.JOB_REJECTED && ctx.providerAgentId === expectedAgent
    && Number(ctx.jobType) === 0 && ctx.jobType !== null && st(ctx) === 9 && isZeroDecimal(trim(ctx.tokenAmount));
  return !freeTerminal && arbitrationDecisionIsStale(source, message, detail);
}

const PREFETCH_ONLY_EVENTS = ['deliverable_received', 'job_provider_reject', 'attachment_added', 'provider_conversation', 'sub_open', 'sub_created',
  'sub_cancel', 'sub_user_reject', 'sub_asp_agree', 'sub_asp_dispute', 'sub_trial_into_active', 'sub_renew', 'sub_expire_warn', 'sub_complete_notify',
  'sub_close_notify', 'sub_failed_notify', 'sub_reject_refund_notify', 'sub_asp_selected'];
const SKIP_ALL_EVENTS = ['create_task', 'approve_review', 'reject_review', 'user_attachment_received', 'job_user_reject', 'raise_arbitration', 'dispute_raise',
  'agree_refund', 'raise_subscription_arbitration', 'sub_dispute', 'sub_agree_refund', 'staked', 'unstake_requested', 'unstake_claimed', 'unstake_cancelled',
  'stake_stopped', 'evaluator_selected', 'vote_committed', 'reveal_started', 'vote_revealed', 'vote_commit_deadline_warn', 'vote_reveal_deadline_warn',
  'cooldown_entered', 'round_failed', 'reward_claimed', 'wakeup_notify', 'sub_asp_claim_notify'];
const REFUND_RETRY_DELAYS_MS = [250, 750, 1500];

async function retryContext(fetch, ready) {
  let latestContext, latestError;
  for (let attempt = 0; attempt <= REFUND_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const context = await fetch();
      latestContext = context; latestError = undefined;
      if (ready(context)) break;
    } catch (e) { latestError = e; }
    if (attempt < REFUND_RETRY_DELAYS_MS.length) await sleep(REFUND_RETRY_DELAYS_MS[attempt]);
  }
  return [latestContext, latestError];
}

// upstream: mod.rs::check_status_freshness → [warning | undefined, prefetched | undefined]
export async function checkStatusFreshness(jobId, event, agentId, role, message) {
  const source = arbitrationDecisionSource(event);
  const isRelay = event.startsWith('user_decision_') && source !== undefined;
  const isPrefetchOnly = PREFETCH_ONLY_EVENTS.includes(event);
  const refundPolicy = buyerRefundEventStatusPolicy(role, event);
  if (SKIP_ALL_EVENTS.includes(event)) return [undefined, undefined];
  const evt = parseStatusOrEvent(event);
  const expected = statusWhenEvent(evt);
  const isSubscriptionEvent = expected === 'subscription';
  if (!isPrefetchOnly && !isRelay && expected === 'unknown') return [undefined, undefined];
  const c = new TaskApiClient();
  if (role === 'user' && event === 'dispute_resolved') {
    const [ctx, err] = await retryContext(() => fetchAuthoritativeRefundContext(c, jobId, agentId), (x) => disputeResultContextBlockReason(x, agentId) === undefined);
    if (!ctx) return [`[next-action blocked] Cannot fetch composed buyer-owned evaluation detail for dispute_resolved: ${err ? err.message : 'authoritative evaluation detail unavailable'}. Do not announce a verdict, rate, notify, or clean up.`, undefined];
    const r = disputeResultContextBlockReason(ctx, agentId);
    return [r, ctx];
  }
  if (role === 'user' && event === 'sub_failed_notify') {
    const [ctx, err] = await retryContext(() => fetchAuthoritativeRefundContext(c, jobId, agentId), (x) => subscriptionFailedContextBlockReason(x, agentId) === undefined);
    if (!ctx) return [`[next-action blocked] Cannot fetch composed buyer-owned subscription detail for sub_failed_notify: ${err ? err.message : 'authoritative subscription detail unavailable'}. Do not notify or clean up.`, undefined];
    return [subscriptionFailedContextBlockReason(ctx, agentId), ctx];
  }
  if (refundPolicy) {
    const [expectedStatus, requires] = refundPolicy;
    const [ctx, err] = await retryContext(() => fetchAuthoritativeRefundContext(c, jobId, agentId), (x) => buyerRefundFreshnessReady(x, event, agentId, expectedStatus, requires));
    if (!ctx) return [`[next-action blocked] Cannot fetch the Refund authoritative detail for ${event}: ${err ? err.message : 'authoritative refund detail unavailable'}. Run \`onchainos agent refund-prepare ${jobId}\` before processing this refund lifecycle notice.`, undefined];
    if (st(ctx) !== expectedStatus || ctx.userAgentId !== agentId) {
      return [`[next-action blocked] The ${event} event does not match fresh buyer-owned Refund status ${debugOptInt(ctx.status)}; expected ${expectedStatus}. Run \`onchainos agent refund-prepare ${jobId}\` to reconcile and do not report completion.`, ctx];
    }
    return [undefined, ctx];
  }
  if (role === 'asp') {
    const p = refundEventStatusPolicy(event);
    if (p) {
      const [ctx, err] = await retryContext(() => fetchAuthoritativeRefundContextForProvider(c, jobId, agentId), (x) => st(x) === p[0] && x.providerAgentId === agentId);
      if (!ctx) return [`[next-action blocked] Cannot fetch composed task/subscription detail for ${event}: ${err ? err.message : 'authoritative provider detail unavailable'}. Do not notify or clean up an ASP session from caller-supplied event data.`, undefined];
      return [aspRefundContextBlockReason(ctx, event, agentId), ctx];
    }
  }
  let resp;
  try { resp = await c.getWithIdentity(detailPathForEvent(c, jobId, event), agentId); } catch (error) {
    if (source !== undefined) return [arbitration.blockedResult('status_unavailable', jobId, { sourceEvent: event, error: displayTop(error) }), undefined];
    if (['job_accepted', 'sub_open', 'sub_created', 'sub_asp_selected'].includes(event) || (role === 'asp' && refundEventStatusPolicy(event))
      || ((role === 'user' || role === 'asp') && subscriptionSideEffectEventStatusPolicy(event) !== undefined)) {
      return [`[next-action blocked] Cannot fetch latest task detail for ${event}: ${error.message}. Do not process this lifecycle notice from stale or incomplete event data.`, undefined];
    }
    return [undefined, undefined];
  }
  const subExp = event === 'sub_open' ? [0, 'CREATED'] : event === 'sub_created' || event === 'sub_asp_selected' ? [1, 'ACTIVE'] : undefined;
  if (subExp) { const r = subscriptionEventBlockReason(resp, event, subExp[0], subExp[1]); if (r !== undefined) return [r, undefined]; }
  const ctx = PreFetchedTaskContext.fromApiResponse(resp);
  const se = subscriptionSideEffectContextBlockReason(ctx, event, role, agentId);
  if (se !== undefined) return [se, ctx];
  if (role === 'asp') { const r = aspRefundContextBlockReason(ctx, event, agentId); if (r !== undefined) return [r, ctx]; }
  if (source !== undefined) {
    if (arbitrationContextIsStale(role, event, source, agentId, message, ctx, resp)) return [arbitration.blockedResult('stale_event', jobId, { sourceEvent: event }), ctx];
    return [undefined, ctx];
  }
  if (event === 'job_submitted') {
    const shortFallback = Buffer.from(jobId, 'utf8').subarray(0, Math.min(Buffer.byteLength(jobId), 10)).toString('utf8');
    const recovered = await tryRecoverFromTempFile(jobId, agentId, shortFallback, ctx.title, ctx.tokenSymbol, ctx.tokenAmount, ctx.providerAgentId);
    if (recovered) {
      ctx.deliverable = preFetchedDeliverable({ path: recovered.savedPath, deliverableType: recovered.deliverableType, originalName: '', textContent: recovered.textContent ?? null });
    } else {
      let manifest;
      try { manifest = readManifest('user', jobId); } catch { manifest = null; }
      const entry = manifest ? manifest.entries[manifest.entries.length - 1] : undefined;
      if (entry) {
        let dir = '';
        try { dir = join(deliverablesDir('user', jobId), entry.filename); } catch { dir = ''; }
        let text = null;
        if (entry.deliverableType === 'text') { try { text = readToString(dir); } catch { text = null; } }
        ctx.deliverable = preFetchedDeliverable({ path: dir, deliverableType: entry.deliverableType, originalName: entry.originalName, textContent: text });
      }
    }
  }
  if (isPrefetchOnly || isSubscriptionEvent) return [undefined, ctx];
  const sv = get(resp, 'status');
  let n = sv === undefined ? undefined : (asI64(sv) ?? (() => { const s = asStr(sv); return s !== undefined && /^[+-]?[0-9]+$/.test(s) ? BigInt(s) : undefined; })());
  if (n === undefined || BigInt(n) < -2147483648n || BigInt(n) > 2147483647n) return [undefined, ctx];
  const actual = Status.fromInt(Number(n));
  const disputeOk = evt === 'dispute_resolved' && (actual === 'completed' || actual === 'failed');
  if (actual === expected || disputeOk) return [undefined, ctx];
  return [`🛑 **Stale state — playbook blocked** (next-action's event arg is inconsistent with the task's real status; not emitting steps to prevent on-chain action on a stale event).\n\n`
    + `- You passed event = \`${event}\` (expected task status = \`${expected}\`)\n`
    + `- But task ${jobId} real statusStr = \`${actual}\`\n\n`
    + '**MUST do** (pick one):\n'
    + '1. If the current inbound is a **P2P message** (a2a-agent-chat) → you likely picked the wrong event. Re-match the pseudo-event from the message content (e.g. `[intent:deliver]` → `deliverable_received`; a natural-language quote → `negotiate_reply`). Pseudo-events are not freshness-gated.\n'
    + `2. If the current inbound is a **system event** → re-run next-action with the \`event\` field in the \`--message\` JSON changed to \`${actual}\` (fetch the playbook matching the real status), or just ignore this stale notification and end the turn waiting for the next real chain event.\n\n`
    + '**MUST NOT**: do NOT guess the next step; do NOT call any task CLI before getting a fresh playbook; do NOT push this warning to the user via `onchainos agent user-notify`.\n', ctx];
}

// upstream: mod.rs::run (AgentCommand::NextAction) → prompt text (printed with println!)
export async function runNextAction({ agentId, role, message, a2aFile }) {
  let parsed;
  try { parsed = fromStr(message); } catch (strictErr) {
    const repaired = escapeControlCharsInStrings(message);
    try {
      parsed = fromStr(repaired);
      process.stderr.write(`[next-action] --message had raw control chars inside string values; auto-repaired and parsed. Strict parse error was: ${strictErr.message}\n`);
    } catch { throw new Error(`--message must be a valid JSON object: ${strictErr.message}`); }
  }
  if (a2aFile !== undefined && a2aFile !== null) {
    const mj = asStr(get(parsed, 'jobId')) ?? '';
    const validated = validateA2aFileArg(a2aFile, mj, agentId);
    if (isObject(parsed)) parsed.a2aFile = validated;
    else throw new Error('--message must be a valid JSON object: cannot index into a non-object value');
  }
  const str = (k) => asStr(get(parsed, k));
  const event = str('event');
  if (event === undefined) throw new Error('--message.event is required');
  let jobId = str('jobId');
  if (jobId === undefined) {
    if (event === 'reward_claimed' || event === 'create_task') jobId = '';
    else throw new Error('--message.jobId is required');
  }
  const ci = asI64(get(parsed, 'code'));
  const code = ci !== undefined && typeof ci === 'number' && ci >= -2147483648 && ci <= 2147483647 ? ci : 0;
  const jobTitle = str('jobTitle'), provider = str('provider'), data = str('data');
  if (jobId !== '') { const m = validateJobId(jobId); if (m !== undefined) throw new Error(m); }
  if (provider !== undefined) { try { saveDesignatedProvider(jobId, provider); } catch {} }
  if (code !== 0 && !expiredTimeoutUsesAuthoritativeStatus(event)) {
    const label = txFailureLabel(event);
    const titlePart = jobTitle !== undefined ? ` **${jobTitle}**` : ' ';
    return `【交易失败】${label}（code=${code}）\n\n运行 \`onchainos agent user-notify\` 通知用户：\n\`\`\`bash\nonchainos agent user-notify --content '[${label}]${titlePart}（${jobId}）交易执行失败（code=${code}）。'\n\`\`\`\n→ 结束 turn。`;
  }
  let resolvedRole;
  if (role === 'auto') {
    let agent;
    try { agent = await queryAgentByIdDirect(agentId); } catch (e) { throw new Error(`could not resolve role for agentId=${agentId}: ${e.message}; pass --role explicitly`); }
    const r = asI64(at(agent, 'role'));
    resolvedRole = { 1: 'user', 2: 'asp', 3: 'evaluator' }[r];
    if (resolvedRole === undefined) throw new Error(`agentId=${agentId} has unsupported role=${debugOptInt(r)}; pass --role explicitly`);
  } else resolvedRole = role;
  if (provider === undefined && resolvedRole === 'user' && event === 'job_created' && !hasDesignatedProvider(jobId)) {
    const fb = new TaskApiClient();
    try {
      const resp = await fb.getWithIdentity(fb.taskPath(jobId), agentId);
      const pid = asStr(at(resp, 'providerAgentId'));
      if (pid !== undefined && pid !== '') { try { saveDesignatedProvider(jobId, pid); } catch {} }
    } catch {}
  }
  if (resolvedRole === 'user') {
    if (event === 'job_submitted') { try { markPending(jobId); } catch {} }
    else if (event === 'approve_review') { try { markApproved(jobId); } catch {} }
  }
  const [warning, prefetched] = handlerFetchesOwnTaskDetail(resolvedRole, event) ? [undefined, undefined]
    : await checkStatusFreshness(jobId, event, agentId, resolvedRole, parsed);
  if (warning !== undefined) return warning;
  const paymentMode = prefetched ? prefetched.paymentMode : null;
  const pre = prefetched ?? null;
  if (resolvedRole === 'asp') {
    auditLog('cli', 'provider/next_action_received', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `event=${event}`, `code=${code}`, `paymentMode=${debugOptInt(paymentMode)}`]);
    if (shouldBlockLegacyA2mcpFlow(paymentMode, event)) return `legacy_a2mcp_flow_removed: task-based A2MCP processing is disabled for job ${jobId}. Stop; do not deliver, complete, sign, or pay.`;
    return aspNextAction(jobId, event, agentId, jobTitle ?? null, data ?? null, pre, parsed);
  }
  if (resolvedRole === 'user') {
    auditLog('cli', 'user/next_action_received', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `event=${event}`, `code=${code}`]);
    return userNextAction(jobId, event, agentId, jobTitle ?? null, data ?? null, paymentMode, pre, parsed);
  }
  if (resolvedRole === 'evaluator') {
    auditLog('cli', 'evaluator/next_action_received', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `event=${event}`, `code=${code}`]);
    return evaluatorNextAction(jobId, event, agentId, parsed);
  }
  throw new Error(`--role 必须是 asp/user/evaluator，当前: ${resolvedRole}`);
}
