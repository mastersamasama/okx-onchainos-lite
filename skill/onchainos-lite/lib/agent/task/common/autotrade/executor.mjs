// Durable coordination for model-routed subscription trades — upstream autotrade/executor.rs.
// Admits a delivery exactly once (execution latch), persists its bounded terminal outcome and
// pushes a job-scoped idempotent UI notice. Never executes a trade command itself.
// The retired execution bridge (claim_direct / authorize_direct / authorize / parse_command /
// classify_* / receipt parsing / validate_bound_intent …) has no production caller in 4.6.3 and
// is not ported.
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { Decimal } from './amount.mjs';
import { jobIdIsSafe } from './grants.mjs';
import * as consent from './consent.mjs';
import * as guide from './guide.mjs';
import * as subscription from './subscription.mjs';
import * as subscriptionConfig from './subscription-config.mjs';
import * as deliveryQueue from './delivery-queue.mjs';
import * as notify from './notify.mjs';
import { GUIDE_EXECUTION_UNAVAILABLE_REASON, EXECUTION_POLICY_NOT_CONFIGURED_REASON } from './index.mjs';
import { fromSlice, fromStr, T } from '../../../../core/serde.mjs';
import { home as onchainosHome, writeSecure } from '../../../../core/home.mjs';
import {
  exists, isFile, isDir, readBytes, readToString, readDirPaths, removeFileQuiet, renameQuiet, createDirAll, createNew, extension,
  withExtension, modifiedAgeSecs, io,
} from '../../../../core/rs/fs.mjs';
import { nowSecs } from '../../../../core/rs/time.mjs';
import { u64SaturatingAdd } from '../../../../core/rs/num.mjs';
import { sha256Hex } from '../../../../core/rs/codec.mjs';
import { isObject, get, asStr } from '../../../../core/rs/value.mjs';
import { splitWhitespace, isControl, eqIgnoreAsciiCase, asciiLower } from '../../../../core/rs/str.mjs';
import { ctx, outerMessage } from './_err.mjs';
import { SubscriptionTradePath } from '../config.mjs';
import { resolve as resolveLang, Lang } from '../user-lang.mjs';
import { userNotifyScoped, userNotifyScopedWithTimeout, tradeRecordsInsert } from '../okx-a2a.mjs';
import { findService } from '../index.mjs';
import { TaskApiClient } from '../network/task-api-client.mjs';

const OUTCOME_VERSION = 1;
const ONE_TIME_PERMIT_VERSION = 1;
const ONE_TIME_PERMIT_TTL_SEC = 15 * 60;
const NOTICE_REF_VERSION = 1;
const EXECUTION_LATCH_VERSION = 2;
const TERMINAL_JOURNAL_VERSION = 1;
const INITIAL_NOTIFY_TIMEOUT_MS = 5000;
const FLUSH_NOTIFY_TIMEOUT_MS = 5000;
const MAX_NOTIFICATION_ATTEMPTS = 10;
const STALE_LEASE_SEC = 30;

// upstream: executor.rs::OutcomeStatus (wire strings) + Rust Debug names (idempotency key input)
export const OutcomeStatus = Object.freeze({
  Submitted: 'submitted', FailedBeforeSubmit: 'failed_before_submit', UnknownAfterSubmit: 'unknown_after_submit',
  Skipped: 'skipped', FailedBeforeExecution: 'failed_before_execution',
});
const STATUS_DEBUG = { submitted: 'Submitted', failed_before_submit: 'FailedBeforeSubmit', unknown_after_submit: 'UnknownAfterSubmit', skipped: 'Skipped', failed_before_execution: 'FailedBeforeExecution' };
// upstream: executor.rs::FailureCategory / ExecutionPhase / ExecutionMode / RecoveryState
export const FailureCategory = Object.freeze({ AuthenticationRequired: 'authentication_required' });
const ExecutionPhase = Object.freeze({ Reserved: 'reserved', Prepared: 'prepared', Spawned: 'spawned' });
export const ExecutionMode = Object.freeze({
  Auto: 'auto', Manual: 'manual', OneTime: 'one_time',
  parse(value) { if (value === 'auto' || value === 'manual' || value === 'one_time') return value; throw new Error('execution mode must be auto, manual, or one_time'); },
});
export const RecoveryState = Object.freeze({ NoExecution: 'NoExecution', PreSubmitInterrupted: 'PreSubmitInterrupted', SubmissionUnknown: 'SubmissionUnknown', TerminalOutcome: 'TerminalOutcome' });

const enumT = (name, values) => T.enum(name, values.map((v) => [v, v]));
const STATUS_T = enumT('OutcomeStatus', Object.values(OutcomeStatus));
const MODE_T = enumT('ExecutionMode', ['auto', 'manual', 'one_time']);
const PHASE_T = enumT('ExecutionPhase', ['reserved', 'prepared', 'spawned']);
const CATEGORY_T = enumT('FailureCategory', ['authentication_required']);

// upstream: executor.rs::ExecutionLatch (deny_unknown_fields)
const LATCH_T = T.struct('ExecutionLatch', [
  ['version', T.u32], ['jobId', T.string], ['deliveryId', T.string], ['phase', PHASE_T], ['updatedAt', T.u64],
  ['directAmount', T.option(T.string), null], ['directExecutionMode', T.option(MODE_T), null],
], { denyUnknown: true });
const latchJson = (l) => struct({
  version: l.version, jobId: l.jobId, deliveryId: l.deliveryId, phase: l.phase, updatedAt: l.updatedAt,
  directAmount: l.directAmount ?? undefined, directExecutionMode: l.directExecutionMode ?? undefined,
});
// upstream: executor.rs::OneTimePermit (deny_unknown_fields)
const PERMIT_T = T.struct('OneTimePermit', [
  ['version', T.u32], ['jobId', T.string], ['deliveryId', T.string], ['amount', T.string], ['createdAt', T.u64], ['expiresAt', T.u64],
], { denyUnknown: true });
export const oneTimePermitJson = (p) => struct({ version: p.version, jobId: p.jobId, deliveryId: p.deliveryId, amount: p.amount, createdAt: p.createdAt, expiresAt: p.expiresAt });
// upstream: executor.rs::ExecutionOutcome
export const OUTCOME_T = T.struct('ExecutionOutcome', [
  ['version', T.u32], ['jobId', T.string], ['deliveryId', T.string], ['venue', T.string], ['action', T.string], ['amount', T.string],
  ['executionMode', MODE_T, ExecutionMode.Auto], ['status', STATUS_T], ['receipt', T.option(T.value)], ['reason', T.option(T.string)],
  ['failureCategory', T.option(CATEGORY_T), null], ['notificationPending', T.bool], ['notificationAttempts', T.u32, 0],
  ['nextNotificationAttemptAt', T.u64, 0], ['createdAt', T.u64], ['updatedAt', T.u64],
]);
// ExecutionOutcome Serialize (struct order; receipt/reason/failureCategory skipped when None)
export const outcomeJson = (o) => struct({
  version: o.version, jobId: o.jobId, deliveryId: o.deliveryId, venue: o.venue, action: o.action, amount: o.amount,
  executionMode: o.executionMode, status: o.status, receipt: o.receipt ?? undefined, reason: o.reason ?? undefined,
  failureCategory: o.failureCategory ?? undefined, notificationPending: o.notificationPending, notificationAttempts: o.notificationAttempts,
  nextNotificationAttemptAt: o.nextNotificationAttemptAt, createdAt: o.createdAt, updatedAt: o.updatedAt,
});
// upstream: executor.rs::OutcomeNoticeRef / TerminalJournal (deny_unknown_fields)
const NOTICE_REF_T = T.struct('OutcomeNoticeRef', [['version', T.u32], ['jobId', T.string], ['deliveryId', T.string], ['nextAttemptAt', T.u64]], { denyUnknown: true });
const JOURNAL_T = T.struct('TerminalJournal', [['version', T.u32], ['outcome', OUTCOME_T]], { denyUnknown: true });

// upstream: executor.rs::DirectClaimResult / GuidePrepareResult (struct order)
const directClaimResult = (allowed, status, jobId, deliveryId, reason) => struct({ allowed, status, jobId, deliveryId, amount: undefined, reason });
const guidePrepareResult = (jobId, deliveryId, reason) => struct({
  ready: reason === undefined, status: reason === undefined ? 'ready' : 'not_ready', jobId, deliveryId, reason,
});

// upstream: executor.rs::safe_delivery_id — 1..=128 bytes [A-Za-z0-9_:.-]
const safeDeliveryId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_:.-]+$/.test(v);
function idPath(dir, jobId, deliveryId, suffix) {
  if (!jobIdIsSafe(jobId) || !safeDeliveryId(deliveryId)) throw new Error('invalid job or delivery id');
  return join(onchainosHome(), 'autotrade', dir, jobId, `${deliveryId}${suffix}`);
}
// upstream: executor.rs::outcome_path / latch_path / terminal_journal_path / one_time_permit_path
export const outcomePath = (j, d) => idPath('outcomes', j, d, '.json');
const latchPath = (j, d) => idPath('execution-latch', j, d, '');
const terminalJournalPath = (j, d) => idPath('terminal-journal', j, d, '.json');
const oneTimePermitPath = (j, d) => idPath('one-time-permits', j, d, '.json');
// upstream: executor.rs::notice_index_root / notice_ref_path
const noticeIndexRoot = () => join(onchainosHome(), 'autotrade', 'pending-outcome-notifications');
function noticeRefPath(jobId, deliveryId) {
  if (!jobIdIsSafe(jobId) || !safeDeliveryId(deliveryId)) throw new Error('invalid job or delivery id');
  return join(noticeIndexRoot(), `${sha256Hex(`${jobId}\0${deliveryId}`)}.json`);
}

// upstream: executor.rs::sync_notice_ref
function syncNoticeRef(o) {
  const path = noticeRefPath(o.jobId, o.deliveryId);
  if (!o.notificationPending) { removeFileQuiet(path); return; }
  io(() => writeSecure(path, stringify(struct({ version: NOTICE_REF_VERSION, jobId: o.jobId, deliveryId: o.deliveryId, nextAttemptAt: o.nextNotificationAttemptAt }), true)));
}

// latch writers (O_EXCL): upstream reserve_execution / reserve_guide_direct_execution
function reserveLatch(jobId, deliveryId, phase, directExecutionMode) {
  const path = latchPath(jobId, deliveryId);
  createDirAll(join(path, '..'));
  return createNew(path, stringify(latchJson({
    version: EXECUTION_LATCH_VERSION, jobId, deliveryId, phase, updatedAt: nowSecs(), directAmount: null, directExecutionMode,
  }), true));
}
const reserveExecution = (j, d) => reserveLatch(j, d, ExecutionPhase.Reserved, null);
const reserveGuideDirectExecution = (j, d) => reserveLatch(j, d, ExecutionPhase.Spawned, ExecutionMode.Auto);

// upstream: executor.rs::read_execution_latch → latch | null
function readExecutionLatch(jobId, deliveryId) {
  const path = latchPath(jobId, deliveryId);
  if (!exists(path)) return null;
  const latch = fromSlice(readBytes(path), LATCH_T);
  if (!(latch.version >= 1 && latch.version <= EXECUTION_LATCH_VERSION) || latch.jobId !== jobId || latch.deliveryId !== deliveryId) {
    throw new Error('execution latch mismatch');
  }
  return latch;
}

// upstream: executor.rs::recovery_state
export function recoveryState(jobId, deliveryId) {
  if (readOutcome(outcomePath(jobId, deliveryId))) return RecoveryState.TerminalOutcome;
  if (!exists(latchPath(jobId, deliveryId))) return RecoveryState.NoExecution;
  let latch;
  try { latch = readExecutionLatch(jobId, deliveryId); } catch { return RecoveryState.SubmissionUnknown; }
  if (!latch) return RecoveryState.NoExecution;
  return latch.phase === ExecutionPhase.Spawned ? RecoveryState.SubmissionUnknown : RecoveryState.PreSubmitInterrupted;
}

// upstream: executor.rs::read_outcome → outcome | null
function readOutcome(path) {
  if (!exists(path)) return null;
  const o = fromSlice(readBytes(path), OUTCOME_T);
  if (o.version !== OUTCOME_VERSION) throw new Error('unsupported automatic execution outcome version');
  return o;
}

// upstream: executor.rs::write_outcome
function writeOutcome(path, o) {
  io(() => writeSecure(path, stringify(outcomeJson(o), true)));
  try { syncNoticeRef(o); } catch (e) { process.stderr.write(`[autotrade] pending-notification index update failed: ${e.message}\n`); }
}

// upstream: executor.rs::write_terminal_journal / read_terminal_journal
function writeTerminalJournal(o) {
  const path = terminalJournalPath(o.jobId, o.deliveryId);
  io(() => writeSecure(path, stringify(struct({ version: TERMINAL_JOURNAL_VERSION, outcome: outcomeJson(o) }), true)));
  return path;
}
function readTerminalJournal(path) {
  const j = fromSlice(readBytes(path), JOURNAL_T);
  if (j.version !== TERMINAL_JOURNAL_VERSION) throw new Error('unsupported terminal journal version');
  return j;
}

// upstream: executor.rs::terminal_reconciliation_complete
async function terminalReconciliationComplete(o) {
  try { syncNoticeRef(o); } catch { return false; }
  let present;
  try { present = deliveryQueue.containsDelivery(o.jobId, o.deliveryId); } catch { return false; }
  if (present) return false;
  try { await syncA2aTradeRecord(o); return true; } catch { return false; }
}

// upstream: executor.rs::sync_a2a_trade_record
async function syncA2aTradeRecord(o) {
  let context;
  try { context = consent.loadDeliveryContext(o.jobId, o.deliveryId); } catch (e) { throw ctx('trusted delivery context is unavailable for trade record', e); }
  return recordSignalStatus(o.jobId, o.deliveryId, o.status, o.reason ?? '', context.savedPath);
}

// upstream: executor.rs::record_signal_status
export async function recordSignalStatus(jobId, deliveryId, status, reason, savedPath) {
  let raw;
  try { raw = readToString(savedPath); } catch (e) { throw ctx('saved subscription Signal is unavailable for trade record', e); }
  let extra;
  try { extra = fromStr(raw, T.value); } catch { extra = { content: raw }; }
  return tradeRecordsInsert([{ jobId, deliveryId, status, reason, extra }]);
}

// upstream: executor.rs::read_one_time_permit
function readOneTimePermit(path) {
  if (!exists(path)) return null;
  const p = fromSlice(readBytes(path), PERMIT_T);
  if (p.version !== ONE_TIME_PERMIT_VERSION) throw new Error('unsupported one-time execution permit version');
  return p;
}

// upstream: executor.rs::authorize_one_time → OneTimePermit
export function authorizeOneTime(jobId, deliveryId, amount) {
  let context;
  try { context = consent.loadDeliveryContext(jobId, deliveryId); } catch (e) { throw ctx('trusted delivery context is unavailable', e); }
  const pending = consent.loadPendingDeliveryContext(jobId);
  if (!pending) throw new Error('no delivery is awaiting a one-time execution decision');
  if (!consent.deliveryContextEq(context, pending) || context.deliveryId !== deliveryId) throw new Error('one-time authorization does not match the pending delivery');
  if (exists(latchPath(jobId, deliveryId))) throw new Error('delivery already has a terminal execution outcome');
  let normalized;
  try { normalized = Decimal.parse(amount).toPlainString(); } catch (e) { throw ctx('invalid one-time execution amount', e); }
  if (normalized === '0') throw new Error('one-time execution amount must be positive');
  let policy;
  try { policy = consent.loadConsent(jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  if (!policy) throw new Error('auto-trade consent is missing or expired');
  if (policy.mode !== consent.ConsentMode.Auto) throw new Error('one-time over-cap authorization requires an active auto policy');
  if (policy.capU === null || policy.capU === undefined) throw new Error('auto-trade cap is missing');
  const cap = Decimal.parse(policy.capU);
  const requested = Decimal.parse(normalized);
  if (requested.le(cap)) throw new Error('one-time authorization is only valid for an amount above the current cap');
  const path = oneTimePermitPath(jobId, deliveryId);
  const existing = readOneTimePermit(path);
  if (existing) {
    if (existing.jobId === jobId && existing.deliveryId === deliveryId && existing.amount === normalized && existing.expiresAt > nowSecs()) return oneTimePermitJson(existing);
    if (existing.expiresAt > nowSecs()) throw new Error('a different live one-time permit already exists for this delivery');
    removeFileQuiet(path);
  }
  createDirAll(join(path, '..'));
  const createdAt = nowSecs();
  const permit = { version: ONE_TIME_PERMIT_VERSION, jobId, deliveryId, amount: normalized, createdAt, expiresAt: u64SaturatingAdd(createdAt, ONE_TIME_PERMIT_TTL_SEC) };
  let created;
  try { created = createNew(path, stringify(oneTimePermitJson(permit), true)); } catch (e) { throw ctx('one-time permit was concurrently replaced', e); }
  // OpenOptions::create_new on an existing path: Windows CreateFileW(CREATE_NEW) fails with
  // ERROR_FILE_EXISTS (80, "The file exists."); Unix open(O_EXCL) with EEXIST (17).
  if (!created) throw ctx('one-time permit was concurrently replaced', new Error(process.platform === 'win32'
    ? 'The file exists. (os error 80)' : 'File exists (os error 17)'));
  return oneTimePermitJson(permit);
}

// ── text safety helpers ───────────────────────────────────────────────
// upstream: executor.rs::sensitive_label
function sensitiveLabel(value) {
  const n = [...value].filter((c) => /^[0-9A-Za-z]$/.test(c)).join('').toLowerCase();
  return ['apikey', 'secret', 'secretkey', 'passphrase', 'password', 'authorization', 'accesstoken', 'refreshtoken', 'token', 'cookie',
    'signature', 'privatekey', 'mnemonic', 'seed'].some((name) => n === name || n.endsWith(name));
}
// upstream: executor.rs::looks_like_jwt
function looksLikeJwt(value) {
  const t = value.replace(/^["',;()[\]]+|["',;()[\]]+$/g, '');
  return Buffer.byteLength(t) >= 40 && (t.match(/\./g) || []).length === 2 && /^[A-Za-z0-9._-]*$/.test(t);
}
// upstream: executor.rs::safe_child_text
export function safeChildText(value) {
  const printable = [...String(value)].map((c) => (isControl(c) ? ' ' : c)).join('');
  const out = [];
  let redactNext = 0;
  for (const token of splitWhitespace(printable)) {
    if (redactNext > 0) { out.push('[REDACTED]'); redactNext -= 1; continue; }
    if (eqIgnoreAsciiCase(token, 'bearer')) { out.push('Bearer'); redactNext = 1; continue; }
    if (looksLikeJwt(token)) { out.push('[REDACTED]'); continue; }
    let assignment;
    for (let i = 0; i < token.length; i++) {
      const c = token[i];
      if ((c === '=' || c === ':') && sensitiveLabel(token.slice(0, i))) { assignment = [token.slice(0, i), token.slice(i + 1), c]; break; }
    }
    if (assignment) {
      const [label, assigned, sep] = assignment;
      out.push(`${label}${sep}[REDACTED]`);
      if (assigned === '') redactNext = eqIgnoreAsciiCase(label, 'authorization') ? 2 : 1;
      continue;
    }
    if (sensitiveLabel(token)) { out.push(token); redactNext = 1; continue; }
    out.push(token);
  }
  return safeText(out.join(' '));
}
// upstream: executor.rs::trade_kit_authentication_error
export function tradeKitAuthenticationError(message) {
  const m = asciiLower(message);
  return ['failed to spawn okx-auth', 'no credentials found', 'not logged in', 'not authenticated', 'requires_auth', 'session expired',
    '401 unauthorized', 'http 401', 'token refresh failed', 'token expired', 'token not found', 'storagenotfounderror', 'no config found',
    'run `okx auth login`', 'run okx auth login', 'run `okx config init`', 'run okx config init', 're-run: okx config init',
    "api key doesn't exist", 'api key does not exist', 'invalid api-key', 'invalid api key', 'invalid ok-access-key', 'invalid sign',
    'passphrase is incorrect', '50100', '50110', '50111', '50112', '50113'].some((k) => m.includes(k));
}
// upstream: executor.rs::failure_category_for
export function failureCategoryFor(venue, status, reason) {
  return venue === 'trade_kit' && status === OutcomeStatus.FailedBeforeSubmit && reason !== null && reason !== undefined && tradeKitAuthenticationError(reason)
    ? FailureCategory.AuthenticationRequired : null;
}
// upstream: executor.rs::safe_text
export function safeText(value) {
  let r = splitWhitespace(value).join(' ');
  if (r === '') r = 'unspecified terminal reason';
  const c = [...r];
  if (c.length > 240) r = c.slice(0, 240).join('') + '…';
  return r;
}
// upstream: executor.rs::safe_metadata_token
export const safeMetadataToken = (value, maxChars) => value !== '' && [...value].length <= maxChars && /^[A-Za-z0-9._:/-]+$/.test(value);

// ── Guide-direct flow ─────────────────────────────────────────────────
// upstream: executor.rs::restore_subscription_local_contract → execution mode | null
export async function restoreSubscriptionLocalContract(jobId, agentId, providerAgentId, serviceId, serviceHint) {
  if (!isFile(guide.guidePath(jobId))) {
    let service = serviceHint;
    if (service === undefined || service === null) {
      service = await findService(providerAgentId, serviceId);
      if (service === undefined || service === null) throw new Error('service is not available to restore its Guide');
    }
    const source = asStr(get(service, 'serviceGuide'));
    if (source === undefined) throw new Error('service has no Guide to restore');
    const sourceHash = asStr(get(service, 'serviceGuideHash'));
    const draft = guide.parseDraft(source, sourceHash);
    if (!draft) throw new Error('service has no Guide to restore');
    guide.writeGuide(guide.draftIntoFile(draft, jobId, serviceId, providerAgentId), draft.source);
  }
  guide.migrateLegacyJsonConsentIfNeeded(jobId, agentId, serviceId);
  return subscriptionConfig.executionMode(agentId, serviceId);
}

// upstream: executor.rs::hydrate_subscription_contract
async function hydrateSubscriptionContract(jobId, context) {
  const client = new TaskApiClient();
  let active;
  try { active = await subscription.determineActiveDelivery(client, jobId, context.agentId); } catch { throw new Error('subscription is no longer Active'); }
  if (active.providerAgentId !== context.providerAgentId) throw new Error('Active subscription no longer matches this delivery');
  await restoreSubscriptionLocalContract(jobId, context.agentId, context.providerAgentId, active.serviceId, null);
  return active;
}
// upstream: executor.rs::require_guide_direct_subscription
async function requireGuideDirectSubscription(jobId, context) {
  const active = await hydrateSubscriptionContract(jobId, context);
  if (subscriptionConfig.executionMode(context.agentId, active.serviceId) !== subscriptionConfig.ExecutionMode.GuideDirect) {
    throw new Error('automatic copy-trading is not enabled for this subscription');
  }
}

function loadTrustedAgentDirect(jobId, deliveryId) {
  let context;
  try { context = consent.loadDeliveryContext(jobId, deliveryId); } catch (e) { throw ctx('trusted delivery context is unavailable', e); }
  if (context.executionPath !== SubscriptionTradePath.AgentDirect) throw new Error('delivery is pinned to the legacy execution wrapper');
  return context;
}

// upstream: executor.rs::prepare_guide_direct → GuidePrepareResult
export async function prepareGuideDirect(jobId, deliveryId) {
  const context = loadTrustedAgentDirect(jobId, deliveryId);
  if (!isFile(context.savedPath)) throw new Error('saved subscription Signal is not available');
  let reason;
  try {
    await requireGuideDirectSubscription(jobId, context);
    reason = guide.hasActiveExecutionContract(jobId) ? undefined : 'active local Service Guide and Guide Consent are required';
  } catch (e) { reason = outerMessage(e); }
  return guidePrepareResult(jobId, deliveryId, reason);
}

// upstream: executor.rs::claim_guide_direct → DirectClaimResult
export async function claimGuideDirect(jobId, deliveryId) {
  const context = loadTrustedAgentDirect(jobId, deliveryId);
  if (!isFile(context.savedPath)) throw new Error('saved subscription Signal is not available');
  await requireGuideDirectSubscription(jobId, context);
  if (!guide.hasActiveExecutionContract(jobId)) throw new Error('active local Service Guide and Guide Consent are required');
  const path = outcomePath(jobId, deliveryId);
  if (readOutcome(path)) return directClaimResult(false, 'terminal', jobId, deliveryId, 'delivery already has a terminal outcome');
  if (!reserveGuideDirectExecution(jobId, deliveryId)) {
    return directClaimResult(false, 'already_claimed', jobId, deliveryId, 'an earlier Guide-driven execution may have started; do not retry');
  }
  try { await recordSignalStatus(jobId, deliveryId, 'claimed', '', context.savedPath); } catch {}
  return directClaimResult(true, 'claimed', jobId, deliveryId, undefined);
}

// upstream: executor.rs::finalize_direct → ExecutionOutcome (serialised)
export async function finalizeDirect(jobId, deliveryId, status, toolId, receiptId, reason) {
  loadTrustedAgentDirect(jobId, deliveryId);
  if (!safeMetadataToken(toolId, 128)) throw new Error('direct execution tool id is invalid');
  const path = outcomePath(jobId, deliveryId);
  const existing = readOutcome(path);
  if (existing) {
    if (existing.notificationPending) await notifyAndPersist(path, existing, false, INITIAL_NOTIFY_TIMEOUT_MS);
    return outcomeJson(existing);
  }
  const latch = readExecutionLatch(jobId, deliveryId);
  if (!latch) throw new Error('direct execution was not claimed');
  const amount = latch.directAmount ?? '';
  const executionMode = latch.directExecutionMode;
  if (executionMode === null || executionMode === undefined) throw new Error('direct execution claim mode is unavailable');
  let st, receipt = null, why = null;
  if (status === 'submitted') {
    if (receiptId === undefined || receiptId === null) throw new Error('submitted direct execution requires a receipt id');
    if (!safeMetadataToken(receiptId, 256)) throw new Error('direct execution receipt id is invalid');
    st = OutcomeStatus.Submitted;
    receipt = { receiptId };
  } else if (status === 'failed_before_submit') {
    st = OutcomeStatus.FailedBeforeSubmit;
    why = safeChildText(reason ?? 'selected tool rejected the trade before submission');
  } else if (status === 'unknown_after_submit') {
    st = OutcomeStatus.UnknownAfterSubmit;
    why = safeChildText(reason ?? 'selected tool returned an unknown submission state');
  } else throw new Error('direct execution status must be submitted, failed_before_submit, or unknown_after_submit');
  const failureCategory = toolId === 'trade_kit' ? failureCategoryFor('trade_kit', st, why) : null;
  const now = nowSecs();
  return outcomeJson(await persistAndNotify(path, {
    version: OUTCOME_VERSION, jobId, deliveryId, venue: `agent_direct/${toolId}`, action: 'execute', amount, executionMode, status: st,
    receipt, reason: why, failureCategory, notificationPending: true, notificationAttempts: 0, nextNotificationAttemptAt: 0, createdAt: now, updatedAt: now,
  }));
}

// upstream: executor.rs::persist_and_notify → outcome (possibly notification-mutated)
async function persistAndNotify(path, o) {
  let journalPath = null;
  try { journalPath = writeTerminalJournal(o); } catch (e) { process.stderr.write(`[autotrade] terminal journal write failed: ${e.message}\n`); }
  writeOutcome(path, o);
  if (o.executionMode === ExecutionMode.OneTime) { try { removeFileQuiet(oneTimePermitPath(o.jobId, o.deliveryId)); } catch {} }
  consent.clearPendingDelivery(o.jobId, o.deliveryId);
  await notifyAndPersist(path, o, false, INITIAL_NOTIFY_TIMEOUT_MS);
  try { await deliveryQueue.completeAndAdvance(o.jobId, o.deliveryId); } catch (e) {
    process.stderr.write(`[autotrade] queued-delivery resume failed (persisted for retry): ${e.message}\n`);
  }
  if (await terminalReconciliationComplete(o)) { if (journalPath) removeFileQuiet(journalPath); }
  return o;
}

// upstream: executor.rs::notification — user-visible text
function notification(o) {
  let receipt;
  if (isObject(o.receipt)) {
    for (const k of Object.keys(o.receipt).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (typeof o.receipt[k] === 'string') { receipt = `${k}: ${o.receipt[k]}`; break; }
    }
  }
  const auto = o.executionMode === ExecutionMode.Auto;
  const zhLabel = auto ? '[自动跟单]' : '[手动跟单]';
  const enLabel = auto ? '[Auto Copy-Trade]' : '[Manual Copy-Trade]';
  const authRequired = o.failureCategory === FailureCategory.AuthenticationRequired;
  const zhAuth = authRequired ? ' 请回复“连接 Trade Kit”以启动授权；授权完成后，本次交易不会自动重试。' : '';
  const enAuth = authRequired ? ' Reply “Connect Trade Kit” to start authorization. This trade will not be retried automatically after authorization.' : '';
  const zh = resolveLang(o.jobId) === Lang.Zh;
  const reason = o.reason ?? undefined;
  switch (o.status) {
    case OutcomeStatus.Submitted:
      return zh ? `${zhLabel} 交易已提交。类型: ${o.venue},方向: ${o.action},金额: ${o.amount}。${receipt ?? '可在对应交易记录中查看详情'}`
        : `${enLabel} Trade submitted. Venue: ${o.venue}, action: ${o.action}, amount: ${o.amount}. ${receipt ?? 'Check the venue history for details'}`;
    case OutcomeStatus.FailedBeforeSubmit:
      return zh ? `${zhLabel} 交易执行失败，未确认提交。类型: ${o.venue},方向: ${o.action},金额: ${o.amount}。原因: ${reason ?? '执行命令失败'}。系统不会自动重试。${zhAuth}`
        : `${enLabel} Trade execution failed; submission was not confirmed. Venue: ${o.venue}, action: ${o.action}, amount: ${o.amount}. Reason: ${reason ?? 'execution command failed'}. No automatic retry will occur.${enAuth}`;
    case OutcomeStatus.UnknownAfterSubmit:
      return zh ? `${zhLabel} 交易提交状态未知。类型: ${o.venue},方向: ${o.action},金额: ${o.amount}。原因: ${reason ?? '未获得可验证的交易回执'}。请先查询订单/交易记录，系统不会自动重试。`
        : `${enLabel} Trade submission status is unknown. Venue: ${o.venue}, action: ${o.action}, amount: ${o.amount}. Reason: ${reason ?? 'no verifiable transaction receipt was returned'}. Check order/transaction history first; no automatic retry will occur.`;
    case OutcomeStatus.Skipped:
      if (reason === GUIDE_EXECUTION_UNAVAILABLE_REASON) {
        return zh ? `${zhLabel} 本次 Signal 已保存，仅接收和展示：该订阅没有有效的本地 Service Guide 与 Guide Consent 执行合约。不会提交订单，旧 execution Consent 不会生效。`
          : `${enLabel} The Signal was saved for receiving/display only: this subscription has no valid local Service Guide + active Guide Consent execution contract. No order was submitted and legacy execution Consent does not apply.`;
      }
      if (reason === EXECUTION_POLICY_NOT_CONFIGURED_REASON) {
        return zh ? `${zhLabel} 本次交付物已保存并跳过：固定字段的旧执行策略已退役，不会创建或恢复执行配置。`
          : `${enLabel} The deliverable was saved and skipped: the fixed-field legacy execution policy is retired and cannot create or restore execution configuration.`;
      }
      return zh ? `${zhLabel} 本次交付物未执行交易。原因: ${reason ?? '信号不满足执行条件'}。`
        : `${enLabel} No trade was executed for this delivery. Reason: ${reason ?? 'the signal was not eligible for execution'}.`;
    default:
      return zh ? `${zhLabel} 交付物处理失败，未启动交易。原因: ${(reason ?? '无法完成交易前处理').replace(/。+$/, '')}。系统不会自动下单重试。`
        : `${enLabel} Delivery processing failed before a trade was started. Reason: ${reason ?? 'pre-trade processing could not be completed'}. No automatic order retry will occur.`;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// upstream: executor.rs::notify_and_persist (mutates o)
async function notifyAndPersist(path, o, force, timeoutMs) {
  if (!o.notificationPending || (!force && o.nextNotificationAttemptAt > nowSecs())) return;
  const key = `autotrade-outcome:${sha256Hex(`${o.jobId}\0${o.deliveryId}\0${STATUS_DEBUG[o.status]}`)}`;
  const content = notification(o);
  const maxAttempts = force ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let delivered = true;
    try {
      if (timeoutMs !== undefined) await userNotifyScopedWithTimeout(content, o.jobId, key, timeoutMs);
      else await userNotifyScoped(content, o.jobId, key);
    } catch { delivered = false; }
    if (delivered) {
      o.notificationPending = false;
      o.nextNotificationAttemptAt = 0;
      o.updatedAt = nowSecs();
      try { writeOutcome(path, o); } catch {}
      return;
    }
    if (attempt + 1 < maxAttempts) await sleepMs(50 * (attempt + 1));
  }
  o.notificationAttempts = Math.min(o.notificationAttempts + maxAttempts, 4294967295);
  o.updatedAt = nowSecs();
  if (o.notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS) {
    o.notificationPending = false;
    o.nextNotificationAttemptAt = 0;
    try { writeOutcome(path, o); } catch {}
    return;
  }
  o.nextNotificationAttemptAt = u64SaturatingAdd(o.updatedAt, Math.min(30 * 2 ** Math.min(o.notificationAttempts, 5), 15 * 60));
  try { writeOutcome(path, o); } catch {}
}

// upstream: executor.rs::is_retired_execution_consent_reason
function isRetiredExecutionConsentReason(reason) {
  const n = asciiLower(reason);
  return n.includes('active execution consent') || n.includes('automatic execution consent') || n.includes('copy-trade consent') || n.includes('auto-trade consent');
}

// upstream: executor.rs::report_delivery → ExecutionOutcome (serialised)
export async function reportDelivery(jobId, deliveryId, status, reason) {
  let context;
  try { context = consent.loadDeliveryContext(jobId, deliveryId); } catch (e) { throw ctx('trusted delivery context is unavailable', e); }
  if (context.jobId !== jobId || context.deliveryId !== deliveryId) throw new Error('trusted delivery context mismatch');
  let st;
  if (status === 'skipped') st = OutcomeStatus.Skipped;
  else if (status === 'failed_before_execution') st = OutcomeStatus.FailedBeforeExecution;
  else throw new Error('delivery report status must be skipped or failed_before_execution');
  const contractUnavailable = context.executionPath === SubscriptionTradePath.AgentDirect && !guide.hasActiveExecutionContract(jobId);
  let why;
  if (contractUnavailable || isRetiredExecutionConsentReason(reason)) { st = OutcomeStatus.Skipped; why = GUIDE_EXECUTION_UNAVAILABLE_REASON; }
  else why = safeText(reason);
  const path = outcomePath(jobId, deliveryId);
  if (!reserveExecution(jobId, deliveryId)) {
    const existing = readOutcome(path);
    if (existing) {
      const normalize = isRetiredExecutionConsentReason(existing.reason ?? '') || (contractUnavailable && existing.status === OutcomeStatus.FailedBeforeExecution);
      if (normalize) {
        Object.assign(existing, { status: OutcomeStatus.Skipped, reason: GUIDE_EXECUTION_UNAVAILABLE_REASON, notificationPending: true, notificationAttempts: 0, nextNotificationAttemptAt: 0, updatedAt: nowSecs() });
        writeOutcome(path, existing);
      }
      if (existing.notificationPending) await notifyAndPersist(path, existing, false, INITIAL_NOTIFY_TIMEOUT_MS);
      return outcomeJson(existing);
    }
    throw new Error('delivery already reserved without a terminal outcome');
  }
  const now = nowSecs();
  return outcomeJson(await persistAndNotify(path, {
    version: OUTCOME_VERSION, jobId, deliveryId, venue: '', action: '', amount: '', executionMode: ExecutionMode.Auto, status: st,
    receipt: null, reason: why, failureCategory: null, notificationPending: true, notificationAttempts: 0, nextNotificationAttemptAt: 0, createdAt: now, updatedAt: now,
  }));
}

// upstream: executor.rs::recover_incomplete → handled?
export async function recoverIncomplete(jobId, deliveryId) {
  const state = recoveryState(jobId, deliveryId);
  if (state === RecoveryState.NoExecution) return false;
  if (state === RecoveryState.TerminalOutcome) {
    const path = outcomePath(jobId, deliveryId);
    const o = readOutcome(path);
    if (o) {
      writeOutcome(path, o);
      consent.clearPendingDelivery(jobId, deliveryId);
      try { deliveryQueue.reconcileTerminal(jobId, deliveryId); } catch {}
    }
    return true;
  }
  const [status, reason] = state === RecoveryState.PreSubmitInterrupted
    ? [OutcomeStatus.FailedBeforeSubmit, 'execution was interrupted before the transaction command started; no order was submitted and no automatic retry will occur']
    : [OutcomeStatus.UnknownAfterSubmit, 'execution was interrupted after the transaction command may have started; submission state is unknown and no automatic retry will occur'];
  const now = nowSecs();
  await persistAndNotify(outcomePath(jobId, deliveryId), {
    version: OUTCOME_VERSION, jobId, deliveryId, venue: '', action: '', amount: '', executionMode: ExecutionMode.Auto, status,
    receipt: null, reason, failureCategory: null, notificationPending: true, notificationAttempts: 0, nextNotificationAttemptAt: 0, createdAt: now, updatedAt: now,
  });
  return true;
}

// upstream: executor.rs::reconcile_terminal_journals(max, budget) → repaired count
export async function reconcileTerminalJournals(maxRecords, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const root = join(onchainosHome(), 'autotrade', 'terminal-journal');
  if (!isDir(root)) return 0;
  let repaired = 0;
  for (const dir of readDirPaths(root)) {
    if (!isDir(dir)) continue;
    for (const path of readDirPaths(dir)) {
      if (repaired >= maxRecords || Date.now() >= deadline) return repaired;
      if (extension(path) !== 'json') continue;
      let journal;
      try { journal = readTerminalJournal(path); } catch (e) {
        process.stderr.write(`[autotrade] unreadable terminal journal ${JSON.stringify(path)}: ${e.message}\n`);
        continue;
      }
      const opath = outcomePath(journal.outcome.jobId, journal.outcome.deliveryId);
      const o = readOutcome(opath) ?? journal.outcome;
      writeOutcome(opath, o);
      if (o.executionMode === ExecutionMode.OneTime) { try { removeFileQuiet(oneTimePermitPath(o.jobId, o.deliveryId)); } catch {} }
      consent.clearPendingDelivery(o.jobId, o.deliveryId);
      try { deliveryQueue.reconcileTerminal(o.jobId, o.deliveryId); } catch {}
      if (await terminalReconciliationComplete(o)) removeFileQuiet(path);
      repaired += 1;
    }
  }
  return repaired;
}

// upstream: executor.rs::flush_with_policy → outcomes (serialised)
async function flushWithPolicy(jobId, force, maxRecords) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  const directory = join(onchainosHome(), 'autotrade', 'outcomes', jobId);
  if (!exists(directory)) return [];
  const outcomes = [];
  for (const path of readDirPaths(directory).slice(0, Math.max(maxRecords, 1))) {
    if (extension(path) !== 'json') continue;
    const o = readOutcome(path);
    if (!o) continue;
    if (o.notificationPending) await notifyAndPersist(path, o, force, undefined);
    outcomes.push(outcomeJson(o));
  }
  try { await notify.flushPending(jobId, force); } catch {}
  return outcomes;
}
// upstream: executor.rs::flush
export const flush = (jobId) => flushWithPolicy(jobId, true, 32);
// upstream: executor.rs::flush_due
export async function flushDue(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  await flushAllDue(4);
  return [];
}

// upstream: executor.rs::cleanup_expired_tickets(limit) → removed count
export async function cleanupExpiredTickets(limit) {
  const root = join(onchainosHome(), 'autotrade', 'one-time-permits');
  if (!isDir(root)) return 0;
  let inspected = 0, removed = 0;
  for (const dir of readDirPaths(root)) {
    if (inspected >= limit) break;
    if (!isDir(dir)) continue;
    for (const path of readDirPaths(dir)) {
      if (inspected >= limit) break;
      if (extension(path) !== 'json') continue;
      inspected += 1;
      let expired = false;
      try { const p = fromSlice(readBytes(path), PERMIT_T); expired = p.version === ONE_TIME_PERMIT_VERSION && p.expiresAt <= nowSecs(); } catch { expired = false; }
      if (expired) { try { removeFileQuiet(path); if (!exists(path)) removed += 1; } catch {} }
    }
  }
  return removed;
}

// upstream: executor.rs::flush_all_due(max) → degrade notices delivered
export async function flushAllDue(maxRecords) {
  const root = noticeIndexRoot();
  const pending = [];
  if (isDir(root)) {
    for (const path of readDirPaths(root)) {
      const ext = extension(path);
      if (ext !== undefined && ext.startsWith('lease-')) {
        const age = modifiedAgeSecs(path);
        if (age !== undefined && age >= STALE_LEASE_SEC) {
          const original = withExtension(path, 'json');
          if (exists(original)) removeFileQuiet(path); else renameQuiet(path, original);
        }
        continue;
      }
      if (ext !== 'json') continue;
      let ref;
      try { ref = fromSlice(readBytes(path), NOTICE_REF_T); } catch { ref = undefined; }
      if (ref && ref.version === NOTICE_REF_VERSION) pending.push([path, ref]);
    }
    pending.sort((a, b) => { const x = BigInt(a[1].nextAttemptAt), y = BigInt(b[1].nextAttemptAt); return x < y ? -1 : x > y ? 1 : 0; });
    for (const [indexPath, ref] of pending.slice(0, Math.max(maxRecords, 1))) {
      if (ref.nextAttemptAt > nowSecs()) break;
      const lease = withExtension(indexPath, `lease-${process.pid}`);
      if (!renameQuiet(indexPath, lease)) continue;
      let path;
      try { path = outcomePath(ref.jobId, ref.deliveryId); } catch { removeFileQuiet(lease); continue; }
      let o;
      try { o = readOutcome(path); } catch { o = null; }
      if (o && o.notificationPending) await notifyAndPersist(path, o, false, FLUSH_NOTIFY_TIMEOUT_MS);
      else removeFileQuiet(indexPath);
      removeFileQuiet(lease);
    }
  }
  let delivered = 0;
  try { delivered = await notify.flushAllPendingBounded(maxRecords, FLUSH_NOTIFY_TIMEOUT_MS); } catch { delivered = 0; }
  return delivered;
}
