// Buyer refund orchestration (Refund V2) — upstream task/user/refund.rs.
//
// `refund-prepare` is read-only. `refund-execute` accepts only a plan produced by prepare,
// re-reads authoritative state, requires explicit confirmation and maps to an existing
// lifecycle endpoint. Handlers return the decision object (printed as the success envelope).
import { readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify, struct } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { context } from '../../../core/errors.mjs';
import { WalletApiClient, ApiCodeError, displayTop } from '../../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { home as onchainosHome, ensureDir0700 } from '../../../core/home.mjs';
import { fromStr, T } from '../../../core/serde.mjs';
import { get, asStr, asI64, asU64, isObject } from '../../../core/rs/value.mjs';
import { trim, charCount, eqIgnoreAsciiCase } from '../../../core/rs/str.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { ioErrorText } from '../../../core/rs/fs.mjs';
import { nowSecs } from '../../../core/rs/time.mjs';
import { PreFetchedTaskContext, fetchAgentProfile, findService, XLAYER_CHAIN_INDEX } from '../common/index.mjs';
import { Status } from '../common/state-machine.mjs';
import { taskStatusLabel, taskStatusDescription } from '../common/query.mjs';
import { formatLocalTimestampWithOffset, formatUtcTimestamp } from '../common/deadline.mjs';
import { markRetiredAutotradeModeDecisionsHandled } from '../common/okx-a2a.mjs';
import * as signing from '../signing.mjs';
import { SUBSCRIBE_API_PREFIX } from './create-subscribe.mjs';
import { resolveUserAgent, negotiateCleanup } from './flow-lifecycle/_peers.mjs';

const SCHEMA_VERSION = 2;
const JOURNAL_REVISION = 3;
const LEGACY_JOURNAL_REVISION = 2;
const MAX_REASON_CHARS = 2000;

// upstream: refund.rs::RefundOperation (clap ValueEnum, kebab-case) — values are the kebab names.
export const RefundOperation = Object.freeze({
  CloseZero: 'close-zero',
  DirectRefund: 'direct-refund',
  RequestRefund: 'request-refund',
  CancelTrialConversion: 'cancel-trial-conversion',
  CloseCreatedSubscription: 'close-created-subscription',
});

// ── Option<i64> helpers (null = None) ──
const isSome = (v) => v !== null && v !== undefined;
const is = (v, n) => isSome(v) && BigInt(v) === BigInt(n);
const oneOf = (v, ns) => isSome(v) && ns.some((n) => BigInt(v) === BigInt(n));
const gt = (v, n) => isSome(v) && BigInt(v) > BigInt(n);
const nonBlank = (v) => isSome(v) && trim(v) !== '';

// ── scalar readers ──
// upstream: refund.rs::scalar_string
export function scalarString(value) {
  if (value === undefined) return undefined;
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); if (t !== '') return t; }
  const i = asI64(value);
  if (i !== undefined) return String(i);
  const u = asU64(value);
  return u !== undefined ? String(u) : undefined;
}
// upstream: refund.rs::first_string — pairs: [[object, keys]]
export function firstString(pairs) {
  for (const [value, keys] of pairs) for (const key of keys) { const r = scalarString(get(value, key)); if (r !== undefined) return r; }
  return undefined;
}
// upstream: refund.rs::scalar_i64
export function scalarI64(value) {
  if (value === undefined) return undefined;
  const i = asI64(value);
  if (i !== undefined) return i;
  const s = asStr(value);
  return s === undefined ? undefined : parseI64(trim(s));
}
// upstream: refund.rs::first_i64
export function firstI64(pairs) {
  for (const [value, keys] of pairs) for (const key of keys) { const r = scalarI64(get(value, key)); if (r !== undefined) return r; }
  return undefined;
}

// ── exact decimals ──
const allDigits = (s) => /^[0-9]+$/.test(s);
// upstream: refund.rs::validate_decimal
export function validateDecimal(value) {
  const parts = String(value).split('.');
  if (parts.length > 2) return false;
  const [whole, fraction] = parts;
  return whole !== '' && allDigits(whole) && (fraction === undefined || (fraction !== '' && allDigits(fraction)));
}
// upstream: refund.rs::is_zero_decimal
export const isZeroDecimal = (value) => validateDecimal(value) && /^[0.]*$/.test(String(value));
// upstream: refund.rs::valid_tx_hash
export function validTxHash(value) {
  const t = trim(value);
  return t.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(t.slice(2));
}
// upstream: refund.rs::canonical_decimal
export function canonicalDecimal(value) {
  if (!validateDecimal(value)) return undefined;
  const s = String(value);
  const dot = s.indexOf('.');
  let whole = dot < 0 ? s : s.slice(0, dot);
  let fraction = dot < 0 ? '' : s.slice(dot + 1);
  whole = whole.replace(/^0+/, '') || '0';
  fraction = fraction.replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
// upstream: refund.rs::decimal_equal
export function decimalEqual(left, right) {
  const a = canonicalDecimal(left), b = canonicalDecimal(right);
  return a !== undefined && b !== undefined && a === b;
}

// ── journal ──
// upstream: refund.rs::PendingRefundMutation (serde camelCase; Option fields default null)
const PENDING_FIELDS = ['schemaVersion', 'journalRevision', 'jobId', 'userAgentId', 'snapshotId', 'operation', 'state', 'jobType', 'trialType',
  'periodIndex', 'periodStartTime', 'periodEndTime', 'pkgId', 'orderId', 'orderType', 'bizUniqKey', 'txHash', 'accountId', 'address',
  'chainIndex', 'bizType', 'originalAmount', 'tokenAddress', 'tokenSymbol', 'providerAgentId', 'serviceId', 'serviceName', 'paymentMode', 'updatedAt'];
// Read with serde_json's *streaming* struct deserializer (`from_slice::<PendingRefundMutation>`):
// errors carry `at line L column C`, surface in document order and reject duplicate fields.
const optI = T.option(T.i64), optS = T.option(T.string);
const PENDING = T.struct('PendingRefundMutation', [
  ['schemaVersion', T.i64], ['journalRevision', T.i64, LEGACY_JOURNAL_REVISION], ['jobId', T.string], ['userAgentId', T.string],
  ['snapshotId', T.string], ['operation', T.string], ['state', T.string],
  ['jobType', optI], ['trialType', optI], ['periodIndex', optI], ['periodStartTime', optI], ['periodEndTime', optI], ['pkgId', optS],
  ['orderId', optS], ['orderType', optS], ['bizUniqKey', optS], ['txHash', optS], ['accountId', optS], ['address', optS],
  ['chainIndex', optS], ['bizType', optI], ['originalAmount', optS], ['tokenAddress', optS], ['tokenSymbol', optS], ['providerAgentId', optS],
  ['serviceId', optS], ['serviceName', optS], ['paymentMode', optI],
  ['updatedAt', T.i64],
]);
const pendingStruct = (s) => struct(Object.fromEntries(PENDING_FIELDS.map((k) => [k, s[k] === undefined ? null : s[k]])));

// upstream: refund.rs::pending_state_path
export function pendingStatePath(jobId, userAgentId) {
  const digest = createHash('sha256').update(`${userAgentId}\0${jobId}`, 'utf8').digest('hex');
  return join(onchainosHome(), 'refund-v2', `${digest}.json`);
}

// upstream: refund.rs::read_pending_mutation → state | null
export function readPendingMutation(jobId, userAgentId) {
  const path = pendingStatePath(jobId, userAgentId);
  let bytes;
  try { bytes = readFileSync(path); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw context(`read Refund V2 reconciliation state ${path}`, new Error(ioErrorText(e)));
  }
  let state;
  try { state = fromStr(bytes, PENDING); } catch (e) {
    throw context(`parse Refund V2 reconciliation state ${path}`, e);
  }
  if (!is(state.schemaVersion, SCHEMA_VERSION) || !oneOf(state.journalRevision, [2, JOURNAL_REVISION]) || state.jobId !== jobId || state.userAgentId !== userAgentId) {
    throw new Error('Refund V2 reconciliation state does not match this task and identity');
  }
  return state;
}

// upstream: refund.rs::has_durable_broadcast_receipt
export const hasDurableBroadcastReceipt = (s) => [s.pkgId, s.orderId, s.orderType, s.bizUniqKey].every(nonBlank);

// upstream: refund.rs::has_created_subscription_close_receipt
export function hasCreatedSubscriptionCloseReceipt(jobId, userAgentId) {
  let state;
  try { state = readPendingMutation(jobId, userAgentId); } catch { return false; }
  return !!state && state.operation === RefundOperation.CloseCreatedSubscription
    && ['broadcast_submitted', 'confirmed', 'confirmed_without_hash', 'closed_without_payment'].includes(state.state)
    && hasDurableBroadcastReceipt(state);
}

// home.rs::ensure_dir_0700 error: `.with_context` of the failing step (create / metadata / chmod) over the io error.
const ensureDirError = (e, dir) => context(e?.ensureContext ?? `failed to create directory ${dir}`, new Error(ioErrorText(e)));

// upstream: refund.rs::write_pending_mutation — atomic write (0600) + fsync of file (and dir on unix).
function writePendingMutation(state) {
  const path = pendingStatePath(state.jobId, state.userAgentId);
  const parent = join(path, '..');
  try { ensureDir0700(parent); } catch (e) { throw context(`write Refund V2 reconciliation state ${path}`, ensureDirError(e, parent)); }
  const tmp = `${path}.tmp`;
  try { writeFileSync(tmp, stringify(pendingStruct(state), true), { mode: 0o600 }); } catch (e) {
    throw context(`write Refund V2 reconciliation state ${path}`, context(`failed to write temp file ${tmp}`, new Error(ioErrorText(e))));
  }
  if (process.platform !== 'win32') {
    try { chmodSync(tmp, 0o600); } catch (e) {
      throw context(`write Refund V2 reconciliation state ${path}`, context(`failed to set 600 on ${tmp}`, new Error(ioErrorText(e))));
    }
  }
  try { renameSync(tmp, path); } catch (e) {
    throw context(`write Refund V2 reconciliation state ${path}`, context(`failed to rename ${tmp} to ${path}`, new Error(ioErrorText(e))));
  }
  try { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch (e) {
    throw context(`sync Refund V2 reconciliation state ${path}`, new Error(ioErrorText(e)));
  }
  if (process.platform !== 'win32') {
    try { const fd = openSync(parent, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch (e) {
      throw context(`sync Refund V2 reconciliation directory for ${path}`, new Error(ioErrorText(e)));
    }
  }
}

// upstream: refund.rs::remove_pending_mutation
function removePendingMutation(jobId, userAgentId) {
  const path = pendingStatePath(jobId, userAgentId);
  try { rmSync(path); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw context(`remove Refund V2 reconciliation state ${path}`, new Error(ioErrorText(e)));
  }
}

// fs2 `lock_exclusive` equivalent. Node has no flock, so the exclusive section is an atomic
// `mkdir` of `<hash>.lock.held` recording the owner pid; like a flock it is released when the
// owner exits (a holder whose process is gone is reclaimed) and it blocks until available.
// The directory exists only while held, so the persisted state files match upstream.
const LOCK_POLL_MS = 25;
const LOCK_OWNERLESS_GRACE_MS = 5000;
const lockSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function lockOwnerAlive(pid) {
  if (pid === process.pid) return false;   // never re-entered: a matching pid is a reused, dead owner's
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
async function lockExclusive(lockPath) {
  const held = `${lockPath}.held`;
  const owner = join(held, 'pid');
  for (;;) {
    try { mkdirSync(held); } catch (e) {
      if (e?.code !== 'EEXIST') throw context('lock Refund V2 reconciliation state', new Error(ioErrorText(e)));
      let pid;
      try { pid = Number.parseInt(readFileSync(owner, 'utf8'), 10); } catch { pid = undefined; }
      let stale;
      if (Number.isInteger(pid) && pid > 0) stale = !lockOwnerAlive(pid);
      else { try { stale = Date.now() - statSync(held).mtimeMs > LOCK_OWNERLESS_GRACE_MS; } catch { stale = false; } }
      if (stale) { try { rmSync(held, { recursive: true, force: true }); } catch {} continue; }
      await lockSleep(LOCK_POLL_MS);
      continue;
    }
    try { writeFileSync(owner, String(process.pid)); } catch {}
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { rmSync(held, { recursive: true, force: true }); } catch {}
    };
  }
}

// upstream: refund.rs::acquire_pending_lock → release function (the lock guard's Drop)
async function acquirePendingLock(jobId, userAgentId) {
  const statePath = pendingStatePath(jobId, userAgentId);
  const root = join(statePath, '..');
  try { ensureDir0700(root); } catch (e) { throw ensureDirError(e, root); }
  const lockPath = statePath.replace(/\.json$/, '.lock');
  try { closeSync(openSync(lockPath, existsSync(lockPath) ? 'r+' : 'w+')); } catch (e) {
    throw context(`open Refund V2 reconciliation lock ${lockPath}`, new Error(ioErrorText(e)));
  }
  return lockExclusive(lockPath);
}

// upstream: refund.rs::pending_mutation_resolved
function pendingMutationResolved(state, snapshot) {
  const st = snapshot.status;
  switch (state.operation) {
    case 'direct-refund': return oneOf(st, [1, 2, 3, 4, 6, 8, 9]);
    case 'close-zero': return oneOf(st, [1, 2, 3, 4, 6, 7, 8, 9]);
    case 'request-refund': return oneOf(st, [3, 4, 6, 7, 8, 9]);
    case 'cancel-trial-conversion': return !is(st, 1) || is(snapshot.autoRenew, 0);
    case 'close-created-subscription': return !oneOf(st, [0, 7, 8]) || (oneOf(st, [7, 8]) && isZeroDecimal(snapshot.originalAmount));
    case 'finalize-expired-refund': return true;
    default: return false;
  }
}

// upstream: refund.rs::order_detail_item
function orderDetailItem(data) {
  if (Array.isArray(data)) return data.length === 1 ? data[0] : undefined;
  return isObject(data) ? data : undefined;
}

// upstream: refund.rs::parse_refund_order_status → { kind: 'Pending'|'Succeeded'|'Failed'|'Unknown', txHash? }
export function parseRefundOrderStatus(data, submittedTxHash) {
  const detail = orderDetailItem(data);
  if (detail === undefined) return { kind: 'Unknown' };
  const status = (scalarString(get(detail, 'txStatus')) ?? '').replace(/[a-z]/g, (c) => c.toUpperCase());
  if (['1', '2', 'PENDING'].includes(status)) return { kind: 'Pending' };
  if (['3', '6', 'ERROR', 'FAIL', 'FAILED', 'CANCELLED'].includes(status)) return { kind: 'Failed' };
  if (status === '4' || status === 'SUCCESS') {
    let observed = null;
    const o = scalarString(get(detail, 'txHash'));
    if (o !== undefined) { if (!validTxHash(o)) return { kind: 'Unknown' }; observed = o; }
    let submitted = null;
    const t = submittedTxHash === null || submittedTxHash === undefined ? undefined : trim(submittedTxHash);
    if (t !== undefined && t !== '') { if (!validTxHash(t)) return { kind: 'Unknown' }; submitted = t; }
    if (observed !== null && submitted !== null && !eqIgnoreAsciiCase(observed, submitted)) return { kind: 'Unknown' };
    return { kind: 'Succeeded', txHash: observed };
  }
  return { kind: 'Unknown' };
}

// upstream: refund.rs::validate_refund_order_detail_binding
function validateRefundOrderDetailBinding(detail, state) {
  const item = orderDetailItem(detail);
  if (item === undefined) return;
  const orderId = scalarString(get(item, 'orderId'));
  if (isSome(state.orderId) && orderId !== undefined && state.orderId !== orderId) throw new Error('wallet order detail returned a mismatched orderId');
  const chain = scalarString(get(item, 'chainIndex'));
  if (isSome(state.chainIndex) && chain !== undefined && state.chainIndex !== chain) throw new Error('wallet order detail returned a mismatched chainIndex');
}

// upstream: refund.rs::query_refund_order_status
async function queryRefundOrderStatus(state) {
  let resolved;
  if (!isSome(state.accountId) || !isSome(state.address)) resolved = await signing.resolveWalletByAgentId(state.userAgentId);
  const accountId = state.accountId ?? resolved?.[0];
  if (!isSome(accountId)) throw new Error('Refund V2 journal is missing the broadcast account');
  const address = state.address ?? resolved?.[1];
  if (!isSome(address)) throw new Error('Refund V2 journal is missing the broadcast address');
  const accessToken = await ensureTokensRefreshed();
  const chainIndex = state.chainIndex ?? XLAYER_CHAIN_INDEX;
  const query = [['accountId', accountId], ['chainIndex', chainIndex], ['address', address]];
  if (isSome(state.orderId)) query.push(['orderId', state.orderId]);
  else if (isSome(state.txHash)) query.push(['txHash', state.txHash]);
  else return { kind: 'Unknown' };
  let detail;
  try { detail = await new WalletApiClient().getAuthed('/priapi/v5/wallet/agentic/order/detail', accessToken, query); } catch (e) {
    throw context('query Refund V2 broadcast order status', e);
  }
  validateRefundOrderDetailBinding(detail, state);
  return parseRefundOrderStatus(detail, state.txHash);
}

// ── provenance predicates ──
const ciEq = (a, b) => isSome(a) && isSome(b) && eqIgnoreAsciiCase(a, b);
const optExact = (a, b) => !isSome(a) || !isSome(b) || a === b;
const optAscii = (a, b) => !isSome(a) || !isSome(b) || eqIgnoreAsciiCase(a, b);
const optI64 = (a, b) => !isSome(a) || !isSome(b) || BigInt(a) === BigInt(b);
function serviceMatchesLenient(state, snapshot) {
  if (isSome(state.serviceId) && isSome(snapshot.serviceId)) return state.serviceId === snapshot.serviceId;
  if (isSome(state.serviceName) && isSome(snapshot.serviceName)) return state.serviceName === snapshot.serviceName;
  return true;
}

// upstream: refund.rs::direct_refund_provenance_matches
function directRefundProvenanceMatches(snapshot, state) {
  let serviceMatches;
  if (isSome(state.serviceId) && isSome(snapshot.serviceId)) serviceMatches = state.serviceId === snapshot.serviceId;
  else serviceMatches = isSome(state.serviceName) && isSome(snapshot.serviceName) && state.serviceName === snapshot.serviceName;
  return state.operation === 'direct-refund' && is(snapshot.status, 7) && is(snapshot.jobType, 0) && is(snapshot.paymentMode, 1)
    && !isZeroDecimal(snapshot.originalAmount) && hasDurableBroadcastReceipt(state) && gt(state.bizType, 0)
    && nonBlank(state.accountId) && nonBlank(state.address) && state.chainIndex === XLAYER_CHAIN_INDEX
    && isSome(state.originalAmount) && decimalEqual(state.originalAmount, snapshot.originalAmount)
    && ciEq(state.tokenAddress, snapshot.tokenAddress) && ciEq(state.tokenSymbol, snapshot.tokenSymbol)
    && isSome(state.providerAgentId) && isSome(snapshot.providerAgentId) && state.providerAgentId === snapshot.providerAgentId
    && serviceMatches && is(state.paymentMode, 1);
}

// upstream: refund.rs::created_subscription_close_provenance_matches
function createdSubscriptionCloseProvenanceMatches(snapshot, state) {
  return state.operation === RefundOperation.CloseCreatedSubscription && oneOf(snapshot.status, [7, 8]) && is(snapshot.jobType, 1)
    && state.jobId === snapshot.jobId && !isZeroDecimal(snapshot.originalAmount) && hasDurableBroadcastReceipt(state) && gt(state.bizType, 0)
    && nonBlank(state.accountId) && nonBlank(state.address) && state.chainIndex === XLAYER_CHAIN_INDEX && is(state.jobType, 1)
    && state.userAgentId === snapshot.buyerAgentId && isSome(state.originalAmount) && decimalEqual(state.originalAmount, snapshot.originalAmount)
    && ciEq(state.tokenAddress, snapshot.tokenAddress) && optAscii(state.tokenSymbol, snapshot.tokenSymbol)
    && optExact(state.providerAgentId, snapshot.providerAgentId) && serviceMatchesLenient(state, snapshot);
}

const walletOrderProvenance = (state, snapshot) => ({
  source: 'wallet_order_detail', operation: state.operation, orderId: state.orderId, bizType: state.bizType, chainIndex: state.chainIndex,
  lifecycleStatus: snapshot.status,
});

// upstream: refund.rs::apply_confirmed_created_subscription_close
function applyConfirmedCreatedSubscriptionClose(snapshot, state) {
  if (!['confirmed', 'confirmed_without_hash'].includes(state.state) || !createdSubscriptionCloseProvenanceMatches(snapshot, state)) return false;
  if (!isSome(state.orderId) || !isSome(state.bizType) || !isSome(state.chainIndex)) return false;
  snapshot.settlementConfirmed = true;
  snapshot.settlementTxHash = isSome(state.txHash) && validTxHash(state.txHash) ? state.txHash : null;
  snapshot.settlementProvenance = walletOrderProvenance(state, snapshot);
  return true;
}

// upstream: refund.rs::request_refund_provenance_core_matches
function requestRefundProvenanceCoreMatches(snapshot, state) {
  const submittedState = ['broadcast_submitted', 'refund_request_applied', 'request_provenance_incomplete'].includes(state.state);
  const legacy = is(state.journalRevision, LEGACY_JOURNAL_REVISION);
  const recordedJobTypeMatches = (isSome(state.jobType) && BigInt(state.jobType) === BigInt(snapshot.jobType)) || (legacy && !isSome(state.jobType));
  const recordedProvider = nonBlank(state.providerAgentId);
  const recordedService = nonBlank(state.serviceId ?? state.serviceName);
  const recordedTokenSymbol = nonBlank(state.tokenSymbol);
  let jobTypeMatches;
  if (is(snapshot.jobType, 0)) jobTypeMatches = recordedJobTypeMatches && is(snapshot.paymentMode, 1) && is(state.paymentMode, 1);
  else if (is(snapshot.jobType, 1)) {
    jobTypeMatches = recordedJobTypeMatches && is(snapshot.trialType, 0) && (is(state.trialType, 0) || (legacy && !isSome(state.trialType)))
      && (legacy || (gt(state.periodStartTime, 0) && gt(state.periodEndTime, 0) && BigInt(state.periodStartTime) < BigInt(state.periodEndTime)));
  } else jobTypeMatches = false;
  return oneOf(state.journalRevision, [2, JOURNAL_REVISION]) && state.operation === 'request-refund' && submittedState
    && state.jobId === snapshot.jobId && state.userAgentId === snapshot.buyerAgentId && jobTypeMatches && recordedProvider && recordedService
    && recordedTokenSymbol && oneOf(snapshot.status, [3, 4, 6, 8, 9]) && hasDurableBroadcastReceipt(state) && gt(state.bizType, 0)
    && nonBlank(state.accountId) && nonBlank(state.address) && state.chainIndex === XLAYER_CHAIN_INDEX
    && isSome(state.originalAmount) && decimalEqual(state.originalAmount, snapshot.originalAmount)
    && validateDecimal(snapshot.originalAmount) && !isZeroDecimal(snapshot.originalAmount)
    && ciEq(state.tokenAddress, snapshot.tokenAddress) && optAscii(state.tokenSymbol, snapshot.tokenSymbol)
    && optExact(state.providerAgentId, snapshot.providerAgentId) && serviceMatchesLenient(state, snapshot)
    && optI64(state.periodIndex, snapshot.periodIndex) && optI64(state.periodStartTime, snapshot.periodStartTime)
    && optI64(state.periodEndTime, snapshot.periodEndTime) && optI64(state.paymentMode, snapshot.paymentMode);
}

// upstream: refund.rs::request_refund_provenance_matches
const requestRefundProvenanceMatches = (snapshot, state) => requestRefundProvenanceCoreMatches(snapshot, state)
  && (!is(state.journalRevision, LEGACY_JOURNAL_REVISION) || oneOf(snapshot.status, [3, 4]));

// upstream: refund.rs::can_upgrade_request_refund_journal
function canUpgradeRequestRefundJournal(snapshot) {
  if (is(snapshot.jobType, 0)) return true;
  if (is(snapshot.jobType, 1)) return is(snapshot.trialType, 0) && gt(snapshot.periodStartTime, 0) && gt(snapshot.periodEndTime, 0)
    && BigInt(snapshot.periodStartTime) < BigInt(snapshot.periodEndTime);
  return false;
}

// upstream: refund.rs::upgrade_request_refund_journal
function upgradeRequestRefundJournal(state, snapshot) {
  if (!canUpgradeRequestRefundJournal(snapshot)) return false;
  state.journalRevision = JOURNAL_REVISION;
  state.jobType = snapshot.jobType;
  state.trialType = snapshot.trialType;
  state.periodIndex = snapshot.periodIndex;
  state.periodStartTime = snapshot.periodStartTime;
  state.periodEndTime = snapshot.periodEndTime;
  return true;
}

// upstream: refund.rs::apply_request_refund_provenance
function applyRequestRefundProvenance(snapshot, state) {
  if (!requestRefundProvenanceMatches(snapshot, state)) return false;
  snapshot.refundRequestProvenance = true;
  if (is(snapshot.status, 9)) snapshot.settlementConfirmed = true;
  return true;
}

// upstream: refund.rs::apply_legacy_request_refund_provenance_after_order_success
function applyLegacyRequestRefundProvenanceAfterOrderSuccess(snapshot, state) {
  if (!is(state.journalRevision, LEGACY_JOURNAL_REVISION) || !oneOf(snapshot.status, [6, 8, 9]) || !requestRefundProvenanceCoreMatches(snapshot, state)) return false;
  snapshot.refundRequestProvenance = true;
  if (is(snapshot.status, 9)) snapshot.settlementConfirmed = true;
  return true;
}

// upstream: refund.rs::apply_confirmed_direct_refund
function applyConfirmedDirectRefund(snapshot, state) {
  if (state.state !== 'confirmed' || !directRefundProvenanceMatches(snapshot, state)) return false;
  if (!isSome(state.txHash) || !validTxHash(state.txHash)) return false;
  if (!isSome(state.orderId) || !isSome(state.bizType) || !isSome(state.chainIndex)) return false;
  snapshot.settlementTxHash = state.txHash;
  snapshot.settlementProvenance = walletOrderProvenance(state, snapshot);
  return true;
}

const touch = (state) => { state.updatedAt = nowSecs(); };

// upstream: refund.rs::reconcile_pending_mutation_locked → pending | null
async function reconcilePendingMutationLocked(snapshot) {
  let state;
  try { state = readPendingMutation(snapshot.jobId, snapshot.buyerAgentId); } catch (e) {
    if (is(snapshot.status, 8)) { try { removePendingMutation(snapshot.jobId, snapshot.buyerAgentId); } catch {} return null; }
    throw e;
  }
  if (!state) return null;

  if (state.operation === RefundOperation.CloseCreatedSubscription && oneOf(snapshot.status, [7, 8])) {
    if (isZeroDecimal(snapshot.originalAmount)) {
      if (state.state !== 'closed_without_payment') { state.state = 'closed_without_payment'; touch(state); writePendingMutation(state); }
      return null;
    }
    snapshot.settlementConfirmed = false;
    snapshot.settlementTxHash = null;
    snapshot.settlementProvenance = null;
    if (applyConfirmedCreatedSubscriptionClose(snapshot, state)) return null;
    if (['broadcast_failed', 'lifecycle_advanced_without_receipt', 'provenance_incomplete'].includes(state.state)) return null;
    if (!hasDurableBroadcastReceipt(state)) { state.state = 'lifecycle_advanced_without_receipt'; touch(state); writePendingMutation(state); return null; }
    if (!createdSubscriptionCloseProvenanceMatches(snapshot, state)) { state.state = 'provenance_incomplete'; touch(state); writePendingMutation(state); return null; }
    let order;
    try { order = await queryRefundOrderStatus(state); } catch { return state; }
    if (order.kind === 'Succeeded') {
      state.state = order.txHash !== null ? 'confirmed' : 'confirmed_without_hash';
      state.txHash = order.txHash;
      touch(state);
      writePendingMutation(state);
      if (!applyConfirmedCreatedSubscriptionClose(snapshot, state)) throw new Error('confirmed Refund V2 order no longer matches its Created subscription close provenance');
      return null;
    }
    if (order.kind === 'Failed') { state.state = 'broadcast_failed'; touch(state); writePendingMutation(state); return null; }
    return state;
  }

  if (is(snapshot.status, 8)) { try { removePendingMutation(snapshot.jobId, snapshot.buyerAgentId); } catch {} return null; }

  if (applyConfirmedDirectRefund(snapshot, state)) return null;

  if (state.operation === 'request-refund' && oneOf(snapshot.status, [3, 4, 6, 8, 9])) {
    const legacyTerminal = is(state.journalRevision, LEGACY_JOURNAL_REVISION) && oneOf(snapshot.status, [6, 8, 9]);
    let matched;
    if (legacyTerminal) {
      let order;
      try { order = await queryRefundOrderStatus(state); } catch { order = { kind: 'Error' }; }
      matched = order.kind === 'Succeeded' && applyLegacyRequestRefundProvenanceAfterOrderSuccess(snapshot, state);
    } else matched = applyRequestRefundProvenance(snapshot, state);
    const previousRevision = state.journalRevision;
    if (matched && BigInt(previousRevision) < BigInt(JOURNAL_REVISION)) upgradeRequestRefundJournal(state, snapshot);
    const next = matched ? 'refund_request_applied' : 'request_provenance_incomplete';
    if (state.state !== next || BigInt(state.journalRevision) !== BigInt(previousRevision)) { state.state = next; touch(state); writePendingMutation(state); }
    return null;
  }

  if (state.operation === 'direct-refund' && is(snapshot.status, 7)) {
    if (['broadcast_failed', 'lifecycle_advanced_without_receipt', 'confirmed_without_hash'].includes(state.state)) return null;
    if (!hasDurableBroadcastReceipt(state)) { state.state = 'lifecycle_advanced_without_receipt'; touch(state); writePendingMutation(state); return null; }
    if (!directRefundProvenanceMatches(snapshot, state)) { state.state = 'provenance_incomplete'; touch(state); writePendingMutation(state); return null; }
    let order;
    try { order = await queryRefundOrderStatus(state); } catch { return null; }
    if (order.kind === 'Succeeded') {
      state.state = order.txHash !== null ? 'confirmed' : 'confirmed_without_hash';
      state.txHash = order.txHash;
      touch(state);
      writePendingMutation(state);
      if (state.txHash !== null && !applyConfirmedDirectRefund(snapshot, state)) throw new Error('confirmed Refund V2 order no longer matches its direct-refund provenance');
      return null;
    }
    if (order.kind === 'Failed') { state.state = 'broadcast_failed'; touch(state); writePendingMutation(state); return null; }
    return null;
  }

  if (pendingMutationResolved(state, snapshot)) {
    try { removePendingMutation(snapshot.jobId, snapshot.buyerAgentId); } catch {}
    return null;
  }
  return state;
}

// upstream: refund.rs::reconcile_pending_mutation
async function reconcilePendingMutation(snapshot) {
  const release = await acquirePendingLock(snapshot.jobId, snapshot.buyerAgentId);
  try { return await reconcilePendingMutationLocked(snapshot); } finally { release(); }
}

// upstream: refund.rs::reconcile_without_downgrading_confirmed_settlement
async function reconcileWithoutDowngradingConfirmedSettlement(snapshot) {
  try { return await reconcilePendingMutation(snapshot); } catch (e) {
    if (snapshot.settlementConfirmed) return null;
    throw e;
  }
}

// anyhow error chain as seen by `error.chain()`: [outer, cause, cause.cause, …].
function errorChain(e) {
  const out = [];
  for (let c = e, n = 0; c && n < 32; c = c.cause, n++) out.push(c);
  return out;
}
// upstream: refund.rs::is_definitive_api_rejection
const isDefinitiveApiRejection = (e) => errorChain(e).some((c) => c instanceof ApiCodeError && c.httpStatus >= 200 && c.httpStatus < 300);
// upstream: refund.rs::mutation_outcome_may_be_unknown
const mutationOutcomeMayBeUnknown = (e) => errorChain(e).some((c) => { const m = displayTop(c); return m === 'broadcast failed' || m.endsWith('result is unknown'); });

// ── plan ──
// upstream: refund.rs::Plan
const plan = (phase, decision, reason, operation = null, actionId = null, recommendStop = false) => ({ phase, decision, reason, operation, actionId, recommendStop });
const blocked = (reason) => plan('refund_eligibility', 'blocked', reason);
const executable = (phase, reason, actionId, operation) => plan(phase, 'requires_user_input', reason, operation, actionId, false);

// upstream: refund.rs::status_name
function statusName(jobType, status) {
  if (is(jobType, 1)) {
    return { '-1': 'init', 0: 'created', 1: 'active', 3: 'rejected', 4: 'disputed', 6: 'completed', 7: 'closed', 8: 'expired', 9: 'failed' }[String(status)] ?? `status_${status}`;
  }
  return Status.fromInt(BigInt.asIntN(32, BigInt(status)));
}

const LABEL_OVERRIDE = {
  refund_confirmed: ['Refund completed', 'The refund completed successfully.'],
  provider_response_pending: ['Awaiting ASP decision', "The refund request is waiting for the ASP's decision."],
  arbitration_in_progress: ['Refund under evaluation', 'The refund result will be determined by the Evaluation.'],
  refund_not_approved_or_task_completed: ['Refund not issued', 'The task completed without a refund.'],
  trial_subscription_closed_without_refund: ['Closed without refund', 'The task is closed and no refund was issued.'],
  task_closed_no_new_refund_action: ['Closed without refund', 'The task is closed and no refund was issued.'],
  expired_without_refundable_payment: ['No refund required', 'This task has no refundable payment.'],
  zero_amount_task_closed: ['No refund required', 'This task has no refundable payment.'],
  zero_amount_subscription_closed: ['No refund required', 'This task has no refundable payment.'],
  zero_amount_subscription_not_refundable: ['No refund required', 'This task has no refundable payment.'],
  refund_settlement_details_incomplete: ['Refund result unavailable', 'The current response does not contain a complete refund result.'],
};
// upstream: refund.rs::refund_status_label
export function refundStatusLabel(jobType, status, reason) {
  if (Object.prototype.hasOwnProperty.call(LABEL_OVERRIDE, reason)) return LABEL_OVERRIDE[reason][0];
  if (!is(jobType, 1)) return taskStatusLabel(status);
  return { '-1': 'Initializing', 0: 'Created', 1: 'Active', 3: 'Awaiting refund decision', 4: 'Evaluation in progress', 6: 'Completed',
    7: 'Closed', 8: 'Expired', 9: 'Refund completed' }[String(status)] ?? 'Status unavailable';
}
// upstream: refund.rs::refund_status_description
export function refundStatusDescription(jobType, status, reason) {
  if (Object.prototype.hasOwnProperty.call(LABEL_OVERRIDE, reason)) return LABEL_OVERRIDE[reason][1];
  if (!is(jobType, 1)) return taskStatusDescription(status);
  return { 3: "The refund request is waiting for the ASP's decision.", 4: 'The refund request is in Evaluation.',
    6: 'The subscription completed without a refund.', 7: 'The subscription is closed.', 9: 'The refund completed successfully.' }[String(status)]
    ?? 'The refund status follows the current subscription state.';
}

const nullable = (v) => (v === undefined ? null : v);

// upstream: refund.rs::RefundSnapshot
export class RefundSnapshot {
  // upstream: RefundSnapshot::from_details_with_expected_buyer
  static fromDetails(jobId, task, subscription, expectedUserAgentId) {
    const jobType = scalarI64(get(task, 'jobType'));
    if (jobType === undefined) throw new Error('task detail is missing jobType');
    if (!oneOf(jobType, [0, 1])) throw new Error(`task detail returned unsupported jobType=${jobType}`);
    const sources = (keys) => (subscription !== undefined && subscription !== null ? [[subscription, keys], [task, keys]] : [[task, keys]]);
    const status = firstI64(sources(['subStatus', 'status']));
    if (status === undefined) throw new Error('task detail is missing status');
    const lookup = (keys) => nullable(firstString(sources(keys)));
    const lookupI64 = (keys) => nullable(firstI64(sources(keys)));

    const buyerAgentId = lookup(['buyerAgentId', 'userAgentId']);
    if (buyerAgentId === null) throw new Error('task detail is missing buyerAgentId');
    if (expectedUserAgentId !== undefined && expectedUserAgentId !== null && buyerAgentId !== expectedUserAgentId) {
      throw new Error('the selected task is not owned by the current User Agent');
    }
    const originalAmount = lookup(['paymentTokenAmount', 'tokenAmount']);
    if (originalAmount === null) throw new Error('task detail is missing the original token amount');
    if (!validateDecimal(originalAmount)) throw new Error('task detail returned an invalid original token amount');
    let trialType = null;
    if (is(jobType, 1)) {
      trialType = lookupI64(['trialType']);
      if (trialType === null) throw new Error('subscription detail is missing trialType');
      if (!oneOf(trialType, [0, 1])) throw new Error(`subscription detail returned unsupported trialType=${trialType}`);
    }
    const tokenSymbol = lookup(['tokenSymbol', 'paymentTokenSymbol']);
    const tokenAddress = lookup(['paymentTokenAddress', 'tokenAddress']);
    if (!is(status, 8) && !isZeroDecimal(originalAmount) && tokenAddress === null) throw new Error('task detail is missing the original token address');
    const periodIndex = lookupI64(['periodIndex']);
    const periodStartTime = lookupI64(['subStartTime', 'periodStartTime']);
    const periodEndTime = lookupI64(['subEndTime', 'periodEndTime']);
    const activeFormal = is(jobType, 1) && is(status, 1) && is(trialType, 0);
    if (activeFormal && ((isSome(periodIndex) && BigInt(periodIndex) < 0n) || (isSome(periodStartTime) && BigInt(periodStartTime) <= 0n)
      || (isSome(periodEndTime) && BigInt(periodEndTime) <= 0n)
      || (isSome(periodStartTime) && isSome(periodEndTime) && BigInt(periodStartTime) >= BigInt(periodEndTime)))) {
      throw new Error('subscription detail returned an invalid billing period');
    }
    const s = new RefundSnapshot();
    Object.assign(s, {
      jobId, jobType, status, title: lookup(['title', 'jobTitle']) ?? '', buyerAgentId,
      providerAgentId: lookup(['providerAgentId', 'aspAgentId']),
      providerName: lookup(['providerAgentName', 'aspAgentName', 'providerName']),
      serviceId: lookup(['serviceId']), serviceName: lookup(['serviceName']),
      revision: lookup(['revision', 'updatedAt', 'updateTime']),
      trialType, periodIndex, periodStartTime, periodEndTime, autoRenew: lookupI64(['autoRenew']),
      tokenAddress, tokenSymbol, chainId: lookupI64(['chainId', 'chainIndex']), paymentMode: lookupI64(['paymentMode']), originalAmount,
      responseDeadline: lookupI64(['rejectDeadline', 'rejectWindowEndsAt', 'responseDeadline', 'expireTime']),
      requestedAt: lookupI64(['refundRequestedAt', 'rejectTime']),
      recordedRefundReason: lookup(['refundReason', 'rejectReason', 'userReason']),
      settlementConfirmed: false, settlementTxHash: null, settlementProvenance: null,
      settlementTime: lookupI64(['refundTime', 'settledAt']),
      disputeRound: lookupI64(['currentRound']), disputePhase: lookup(['disputePhase']),
      disputePrepareEndTime: lookupI64(['prepareEndTime']), disputeRoundEndTime: lookupI64(['roundEndTime']),
      refundRequestProvenance: false,
    });
    const nonZero = !isZeroDecimal(s.originalAmount);
    const paidExpired = is(s.status, 8) && nonZero && (is(s.jobType, 0) || (is(s.jobType, 1) && is(s.trialType, 0)));
    const paidOneTimeFinal = is(s.jobType, 0) && nonZero && (is(s.status, 9) || (is(s.status, 7) && is(s.paymentMode, 1)));
    const paidSubscriptionRefundFinal = is(s.jobType, 1) && is(s.trialType, 0) && is(s.status, 9) && nonZero;
    if (paidExpired || paidOneTimeFinal || paidSubscriptionRefundFinal) s.settlementConfirmed = true;
    return s;
  }

  isSubscription() { return is(this.jobType, 1); }
  isTrial() { return is(this.trialType, 1); }

  // upstream: RefundSnapshot::refund_reason
  refundReason(reason) {
    const requestRefundState = (!this.isSubscription() && is(this.status, 2)) || (this.isSubscription() && !this.isTrial() && is(this.status, 1));
    return requestRefundState && reason !== undefined && reason !== null ? reason : null;
  }

  hasRequiredRefundDisplayDetails() { return this.providerAgentId !== null && nonBlank(this.tokenSymbol); }
  hasConfirmedSettlement() { return this.settlementConfirmed; }

  // upstream: RefundSnapshot::settlement_confirmation_source
  settlementConfirmationSource() {
    if (!this.hasConfirmedSettlement()) return null;
    if (this.settlementProvenance && this.settlementProvenance.operation === RefundOperation.CloseCreatedSubscription) return 'wallet_order_detail_with_backend_lifecycle';
    if (!is(this.status, 8) && this.isSubscription() && this.refundRequestProvenance) return 'backend_onchain_lifecycle_with_local_refund_request';
    return 'backend_onchain_lifecycle';
  }

  // upstream: RefundSnapshot::context_id
  contextId(reason) {
    const canonical = {
      jobId: this.jobId, jobType: this.jobType, status: this.status, buyerAgentId: this.buyerAgentId, providerAgentId: this.providerAgentId,
      serviceId: this.serviceId, revision: this.revision, trialType: this.trialType, periodIndex: this.periodIndex,
      periodStartTime: this.periodStartTime, periodEndTime: this.periodEndTime, autoRenew: this.autoRenew, tokenAddress: this.tokenAddress,
      tokenSymbol: this.tokenSymbol, chainId: this.chainId, paymentMode: this.paymentMode, originalAmount: this.originalAmount,
      userReason: this.refundReason(reason),
    };
    return `refundctx_${createHash('sha256').update(stringify(canonical), 'utf8').digest('hex')}`;
  }

  // upstream: RefundSnapshot::plan
  plan(reason) {
    if (this.isSubscription() && is(this.status, 0)) {
      if (!isZeroDecimal(this.originalAmount) && !this.hasRequiredRefundDisplayDetails()) return blocked('refund_task_details_incomplete');
      return executable('refund_confirmation', 'created_subscription_close_confirmation_required', 'close_created_subscription', RefundOperation.CloseCreatedSubscription);
    }
    if (this.isTrial()) {
      if (is(this.status, 1) && is(this.autoRenew, 1)) return executable('refund_eligibility', 'trial_subscription_not_refundable', 'cancel_trial_conversion', RefundOperation.CancelTrialConversion);
      if (is(this.status, 1) && is(this.autoRenew, 0)) return plan('refund_eligibility', 'blocked', 'trial_conversion_already_cancelled');
      if (is(this.status, 1)) return blocked('trial_conversion_state_unknown');
      if (is(this.status, 7)) return plan('refund_resolution', 'ready', 'trial_subscription_closed_without_refund', null, null, true);
      if (is(this.status, 8)) return plan('refund_resolution', 'ready', 'expired_without_refundable_payment', null, null, true);
      return blocked('trial_subscription_not_refundable');
    }
    if (!this.isSubscription() && isZeroDecimal(this.originalAmount)) {
      if (is(this.status, 0)) return executable('refund_confirmation', 'zero_amount_close_confirmation_required', 'close_zero_price', RefundOperation.CloseZero);
      if (is(this.status, 7)) return plan('refund_resolution', 'ready', 'zero_amount_task_closed', null, null, true);
      if (is(this.status, 8)) return plan('refund_resolution', 'ready', 'expired_without_refundable_payment', null, null, true);
      return blocked('zero_amount_close_contract_required');
    }
    if (this.isSubscription() && isZeroDecimal(this.originalAmount)) {
      if (is(this.status, 8)) return plan('refund_resolution', 'ready', 'expired_without_refundable_payment', null, null, true);
      return blocked('zero_amount_subscription_not_refundable');
    }
    const requiresDisplay = (!this.isSubscription() && oneOf(this.status, [0, 2])) || (this.isSubscription() && is(this.status, 1));
    if (requiresDisplay && !this.hasRequiredRefundDisplayDetails()) return blocked('refund_task_details_incomplete');
    const sub = this.isSubscription();
    const st = this.status;
    if (is(st, 0) && !sub && is(this.paymentMode, 1)) return executable('refund_confirmation', 'direct_refund_confirmation_required', 'execute_direct_refund', RefundOperation.DirectRefund);
    if (is(st, 0) && !sub) return blocked('direct_refund_funding_not_verified');
    if (is(st, 0)) return blocked('refund_not_available_for_status');
    if (is(st, 1) && !sub) return blocked('accepted_task_refund_contract_required');
    if (oneOf(st, [1, 2]) && ((sub && is(st, 1)) || (!sub && is(st, 2)))) {
      if (!sub && !is(this.paymentMode, 1)) return blocked('refund_payment_not_verified');
      if (sub && (this.periodStartTime === null || this.periodEndTime === null)) return blocked('subscription_period_contract_required');
      if (reason === undefined || reason === null || trim(reason) === '') return plan('refund_reason_collection', 'requires_user_input', 'refund_reason_required', null, 'provide_refund_reason');
      if (charCount(reason) > MAX_REASON_CHARS) return plan('refund_reason_collection', 'requires_user_input', 'refund_reason_too_long', null, 'provide_refund_reason');
      return executable('refund_confirmation', 'refund_request_confirmation_required', 'submit_refund_request', RefundOperation.RequestRefund);
    }
    if (is(st, 3)) return plan('refund_provider_response', 'blocked', 'provider_response_pending');
    if (is(st, 4)) return plan('refund_arbitration', 'blocked', 'arbitration_in_progress', null, 'view_arbitration');
    if (is(st, 8) && this.hasConfirmedSettlement()) return plan('refund_resolution', 'ready', 'refund_confirmed', null, null, true);
    if (is(st, 8)) return blocked('refund_settlement_details_incomplete');
    if (is(st, 9) && this.hasConfirmedSettlement()) return plan('refund_resolution', 'ready', 'refund_confirmed', null, null, true);
    if (is(st, 9)) return plan('refund_resolution', 'blocked', 'refund_settlement_details_incomplete');
    if (is(st, 6)) return plan('refund_resolution', 'blocked', 'refund_not_approved_or_task_completed', null, null, true);
    if (is(st, 7) && !sub && is(this.paymentMode, 1) && this.hasConfirmedSettlement()) return plan('refund_resolution', 'ready', 'refund_confirmed', null, null, true);
    if (is(st, 7) && sub && this.hasConfirmedSettlement()) return plan('refund_resolution', 'ready', 'refund_confirmed', null, null, true);
    if (is(st, 7) && sub && isZeroDecimal(this.originalAmount)) return plan('refund_resolution', 'ready', 'zero_amount_subscription_closed', null, null, true);
    if (is(st, 7) && !sub) return plan('refund_resolution', 'blocked', 'refund_settlement_details_incomplete');
    if (is(st, 7)) return plan('refund_resolution', 'blocked', 'task_closed_no_new_refund_action');
    return blocked('refund_not_available_for_status');
  }

  // upstream: RefundSnapshot::refund_scope
  refundScope() {
    const createdClose = this.isSubscription() && (is(this.status, 0)
      || (this.settlementProvenance !== null && this.settlementProvenance.operation === RefundOperation.CloseCreatedSubscription));
    if (isZeroDecimal(this.originalAmount)) return 'none';
    if (createdClose) return 'full_subscription_payment';
    if (this.isTrial()) return 'none';
    if (this.isSubscription()) return 'current_subscription_period';
    return 'full_task_payment';
  }

  // upstream: RefundSnapshot::settlement_state
  settlementState() {
    const st = this.status, ok = this.hasConfirmedSettlement();
    if (is(st, 8)) return ok ? 'confirmed' : 'not_required';
    if (is(st, 9)) return ok ? 'confirmed' : 'details_incomplete';
    if (is(st, 7)) return ok ? 'confirmed' : isZeroDecimal(this.originalAmount) ? 'not_required' : 'details_incomplete';
    if (is(st, 6)) return 'not_refunded';
    if (oneOf(st, [3, 4])) return 'pending';
    return 'not_started';
  }

  // upstream: RefundSnapshot::refund_state
  refundState() {
    const st = this.status;
    if (is(st, 0)) return 'created';
    if (oneOf(st, [1, 2])) return 'active';
    if (is(st, 3)) return 'provider_pending';
    if (is(st, 4)) return 'arbitrating';
    if (oneOf(st, [6, 8])) return 'resolved';
    if (is(st, 7) && isZeroDecimal(this.originalAmount)) return 'resolved';
    if (oneOf(st, [7, 9]) && this.hasConfirmedSettlement()) return 'resolved';
    if (oneOf(st, [7, 9])) return 'settlement_unverified';
    return 'unavailable';
  }

  static displayTimestamp(timestamp) {
    if (timestamp === null || timestamp === undefined) return null;
    return formatLocalTimestampWithOffset(timestamp) ?? null;
  }

  displayCurrentPeriod() {
    if (!this.isSubscription() || this.periodStartTime === null || this.periodEndTime === null) return null;
    const a = formatLocalTimestampWithOffset(this.periodStartTime), b = formatLocalTimestampWithOffset(this.periodEndTime);
    return a !== undefined && b !== undefined ? `${a}–${b}` : null;
  }

  displayRefundAmount(refundableAmount) {
    if (isZeroDecimal(refundableAmount)) return 'No refund required';
    const symbol = this.tokenSymbol === null ? '' : trim(this.tokenSymbol);
    return symbol !== '' ? `${refundableAmount} ${symbol}` : null;
  }

  // upstream: RefundSnapshot::display_payload
  displayPayload(reason, refundableAmount) {
    const serviceName = this.serviceName !== null && trim(this.serviceName) !== '' ? this.serviceName : trim(this.title) !== '' ? this.title : null;
    const resultDeadline = this.responseDeadline ?? (this.isSubscription() && is(this.status, 1) ? this.periodEndTime : null);
    return {
      serviceName, jobId: this.jobId, serviceProviderName: this.providerName, agentId: this.providerAgentId,
      taskType: this.isSubscription() ? 'Subscription' : 'One-time', currentPeriod: this.displayCurrentPeriod(),
      refundAmount: this.displayRefundAmount(refundableAmount),
      reasonForRefund: reason !== undefined && reason !== null ? reason : this.recordedRefundReason,
      requestedAt: RefundSnapshot.displayTimestamp(this.requestedAt), resultDeadline: RefundSnapshot.displayTimestamp(resultDeadline),
    };
  }

  // upstream: RefundSnapshot::payload
  payload(reason, p) {
    const verified = ['direct_refund_confirmation_required', 'created_subscription_close_confirmation_required', 'refund_reason_required',
      'refund_reason_too_long', 'refund_request_confirmation_required', 'provider_response_pending', 'arbitration_in_progress',
      'refund_confirmed', 'refund_settlement_details_incomplete'].includes(p.reason);
    const pdf = verified && ((!this.isSubscription() && oneOf(this.status, [2, 3, 4])) || (this.isSubscription() && oneOf(this.status, [1, 3, 4])));
    const refundable = verified ? this.originalAmount : '0';
    const display = this.displayPayload(reason, refundable);
    const statusLabel = refundStatusLabel(this.jobType, this.status, p.reason);
    const statusDescription = refundStatusDescription(this.jobType, this.status, p.reason);
    display.statusLabel = statusLabel;
    display.statusDescription = statusDescription;
    const requiredParams = ['refund_reason_required', 'refund_reason_too_long'].includes(p.reason) ? ['reason'] : [];
    const txHash = ['refund_settlement_details_incomplete', 'task_closed_no_new_refund_action'].includes(p.reason) ? null : this.settlementTxHash;
    const provenance = p.reason === 'refund_confirmed' && this.settlementProvenance ? { ...this.settlementProvenance } : null;
    const subscription = this.isSubscription() ? {
      kind: this.isTrial() ? 'trial' : 'formal', trialType: this.trialType, periodIndex: this.periodIndex,
      periodStartTime: this.periodStartTime, periodEndTime: this.periodEndTime, autoRenew: this.autoRenew,
    } : null;
    let currentPeriodLabel = null;
    if (this.periodStartTime !== null && this.periodEndTime !== null) {
      const a = formatUtcTimestamp(this.periodStartTime), b = formatUtcTimestamp(this.periodEndTime);
      if (a !== undefined && b !== undefined) currentPeriodLabel = `${a}–${b}`;
    }
    let refundAmountLabel = null;
    if (isZeroDecimal(this.originalAmount)) refundAmountLabel = 'No refund required';
    else if (this.tokenSymbol !== null && trim(this.tokenSymbol) !== '') refundAmountLabel = `${this.originalAmount} ${this.tokenSymbol}`;
    display.taskTypeLabel = this.isSubscription() ? 'Subscription' : 'One-time';
    display.serviceProviderLabel = this.providerName !== null && this.providerAgentId !== null ? `${this.providerName} (Agent ID : ${this.providerAgentId})` : null;
    display.currentPeriodLabel = currentPeriodLabel;
    display.refundAmountLabel = refundAmountLabel;
    display.responseDeadlineLabel = this.responseDeadline !== null ? (formatUtcTimestamp(this.responseDeadline) ?? null) : null;
    const pending = is(this.status, 3) ? 'unknown' : 'not_requested';
    return {
      schemaVersion: SCHEMA_VERSION,
      refundContextId: this.contextId(reason),
      display,
      job: {
        jobId: this.jobId, jobName: this.title, jobType: this.isSubscription() ? 'subscription' : 'one_time', rawJobType: this.jobType,
        refundState: this.refundState(), rawStatus: this.status, statusName: statusName(this.jobType, this.status), statusLabel,
        statusDescription, buyerAgentId: this.buyerAgentId, providerAgentId: this.providerAgentId, providerName: this.providerName,
        serviceId: this.serviceId, serviceName: this.serviceName, revision: this.revision,
      },
      subscription,
      payment: {
        tokenAddress: this.tokenAddress, tokenSymbol: this.tokenSymbol, chainId: this.chainId, paymentMode: this.paymentMode,
        originalAmount: this.originalAmount, refundableAmount: refundable, refundScope: this.refundScope(), partialRefundSupported: false,
        prorationSupported: false,
      },
      input: { requiredParams, reasonMaxChars: MAX_REASON_CHARS },
      request: {
        userReason: this.refundReason(reason), requestedAt: this.requestedAt, providerResponseDeadline: this.responseDeadline,
        providerNotification: { system: pending, email: pending },
      },
      rules: {
        applies: verified, providerMayAgreeOrDispute: pdf, providerTimeoutRefundExpected: pdf, refundUsesOriginalToken: verified,
        fullRefundOnly: verified, partialRefundSupported: false, prorationSupported: false, onchainConfirmationRequired: verified,
      },
      settlement: {
        state: this.settlementState(), cause: null, txHash, confirmationSource: this.settlementConfirmationSource(), provenance,
        broadcastReceipt: null, confirmedAt: this.settlementTime, onchainConfirmationRequired: verified,
      },
      arbitration: {
        phase: this.disputePhase, currentRound: this.disputeRound, prepareEndTime: this.disputePrepareEndTime, roundEndTime: this.disputeRoundEndTime,
        outcome: is(this.status, 6) ? 'not_refunded' : null,
      },
      capability: {
        clientOperation: p.operation, usesExistingLifecycleEndpoint: p.operation !== null,
        backendContractRequired: p.reason.endsWith('contract_required') || p.reason.endsWith('contract_ambiguous'),
      },
    };
  }
}

// upstream: refund.rs::pending_reconciliation_payload
function pendingReconciliationPayload(snapshot, reason, p, pending) {
  const payload = snapshot.payload(reason, p);
  payload.capability.clientOperation = null;
  payload.settlement.state = pending.state;
  payload.settlement.txHash = null;
  payload.settlement.broadcastReceipt = {
    pkgId: pending.pkgId, orderId: pending.orderId, orderType: pending.orderType, bizUniqKey: pending.bizUniqKey, bizType: pending.bizType,
    txHash: pending.txHash,
  };
  payload.settlement.retrySafe = false;
  payload.settlement.diagnostic = 'query_authoritative_state_before_retry';
  return payload;
}

// upstream: refund.rs::base_decision
export const baseDecision = (phase, decision, reason, nextAction, payload) => ({ phase, decision, reason, nextAction, payload });

// upstream: refund.rs::action
export function action(id, recommend, params) {
  const v = { id, recommend };
  if (params !== undefined && params !== null) v.params = params;
  return v;
}

// upstream: refund.rs::plan_actions
function planActions(snapshot, p, reason) {
  const actions = [];
  if (p.actionId !== null && p.operation !== null) {
    const params = {
      jobId: snapshot.jobId, refundContextId: snapshot.contextId(reason), operation: p.operation, expectedJobType: snapshot.jobType,
      expectedStatus: snapshot.status, expectedOriginalAmount: snapshot.originalAmount,
    };
    if (p.operation === RefundOperation.RequestRefund) { const r = snapshot.refundReason(reason); if (r !== null) params.reason = r; }
    actions.push(action(p.actionId, true, params), action('stop', false));
  } else if (p.actionId !== null) {
    actions.push(action(p.actionId, true, { jobId: snapshot.jobId }), action('stop', false));
  } else if (p.recommendStop) {
    actions.push(action('stop', true));
  } else {
    actions.push(action(is(snapshot.status, 4) ? 'view_arbitration' : 'view_refund_status', true, { jobId: snapshot.jobId }));
    actions.push(action('watch_task', false, { jobId: snapshot.jobId }));
  }
  return actions;
}

// upstream: refund.rs::reconcile_actions
function reconcileActions(jobId, operation) {
  if (operation === RefundOperation.RequestRefund) return [action('view_refund_status', false, { jobId })];
  return [action('view_refund_status', true, { jobId }), action('watch_task', false, { jobId })];
}

// upstream: refund.rs::login_block / identity_block (emit_decision data)
const loginBlock = (jobId) => baseDecision('login_validation', 'blocked', 'login_required', [action('login', true, { jobId })], { schemaVersion: SCHEMA_VERSION });
const identityBlock = (jobId) => baseDecision('identity_validation', 'blocked', 'user_identity_required', [action('register_user_agent', true, { jobId })], { schemaVersion: SCHEMA_VERSION });

// upstream: refund.rs::current_user_agent_id → { agentId } | { decision } (a block to print)
async function currentUserAgentId(jobId) {
  try { await ensureTokensRefreshed(); } catch { return { decision: loginBlock(jobId) }; }
  try {
    const [agentId] = await resolveUserAgent();
    return { agentId };
  } catch (e) {
    if (displayTop(e).includes('no user identity')) return { decision: identityBlock(jobId) };
    throw context('failed to resolve current User Agent', e);
  }
}

// upstream: refund.rs::fetch_snapshot_for_identity
async function fetchSnapshotForIdentity(client, jobId, callerAgentId, requireBuyerOwnership) {
  let task;
  try { task = await client.getWithIdentity(client.taskPath(jobId), callerAgentId); } catch (e) { throw context('failed to fetch authoritative task detail', e); }
  const jobType = scalarI64(get(task, 'jobType'));
  if (jobType === undefined) throw new Error('task detail is missing jobType');
  let subscription;
  if (is(jobType, 1)) {
    try { subscription = await client.getWithIdentity(client.subscribePath(jobId), callerAgentId); } catch (e) { throw context('failed to fetch authoritative subscription detail', e); }
  }
  return RefundSnapshot.fromDetails(jobId, task, subscription, requireBuyerOwnership ? callerAgentId : null);
}

// upstream: refund.rs::fetch_snapshot
async function fetchSnapshot(client, jobId, userAgentId) {
  const snapshot = await fetchSnapshotForIdentity(client, jobId, userAgentId, true);
  if (snapshot.providerName === null && snapshot.providerAgentId !== null) snapshot.providerName = (await fetchAgentProfile(snapshot.providerAgentId)).name;
  if (snapshot.serviceName === null && snapshot.providerAgentId !== null && snapshot.serviceId !== null) {
    const service = await findService(snapshot.providerAgentId, snapshot.serviceId);
    const name = asStr(get(service, 'serviceName'));
    snapshot.serviceName = name !== undefined && trim(name) !== '' ? trim(name) : null;
  }
  return snapshot;
}

// upstream: refund.rs::refund_list_item → RefundListItem
export function refundListItem(snapshot) {
  const p = snapshot.plan(null);
  const deadline = snapshot.responseDeadline ?? (snapshot.isSubscription() && is(snapshot.status, 1) ? snapshot.periodEndTime : null);
  const display = snapshot.displayPayload(null, snapshot.originalAmount);
  display.statusLabel = refundStatusLabel(snapshot.jobType, snapshot.status, p.reason);
  display.statusDescription = refundStatusDescription(snapshot.jobType, snapshot.status, p.reason);
  display.requestedRefund = display.refundAmount;
  display.buyerReason = display.reasonForRefund;
  display.responseDeadline = display.resultDeadline;
  return {
    display, deadline: deadline ?? undefined, jobType: snapshot.jobType, status: snapshot.status, reason: p.reason,
    refundRequestProvenance: snapshot.refundRequestProvenance, refundRequestAvailable: p.reason === 'refund_reason_required',
  };
}

// upstream: refund.rs::fetch_refund_list_item_for_identity
export async function fetchRefundListItemForIdentity(client, jobId, callerAgentId, requireBuyerOwnership) {
  const snapshot = await fetchSnapshotForIdentity(client, jobId, callerAgentId, requireBuyerOwnership);
  if (snapshot.providerName === null && snapshot.providerAgentId !== null) snapshot.providerName = (await fetchAgentProfile(snapshot.providerAgentId)).name;
  return refundListItem(snapshot);
}

// upstream: refund.rs::From<RefundSnapshot> for PreFetchedTaskContext
export function snapshotIntoContext(s) {
  return new PreFetchedTaskContext({
    title: s.title, description: '', jobType: s.jobType, trialType: s.trialType, tokenSymbol: s.tokenSymbol ?? '?', tokenAmount: s.originalAmount,
    paymentMode: s.paymentMode, maxBudget: null, providerAgentId: s.providerAgentId, providerName: s.providerName, userAgentId: s.buyerAgentId,
    status: s.status, deliverable: null, serviceId: s.serviceId, serviceName: s.serviceName, serviceTokenAddress: null, serviceTokenAmount: null,
    serviceParams: null, refundReason: s.recordedRefundReason, periodStartTime: s.periodStartTime, periodEndTime: s.periodEndTime,
    userAgentAddress: null, tokenAddress: s.tokenAddress, verifiedTransactionHash: s.settlementTxHash, refundRequestProvenance: s.refundRequestProvenance,
    expireTime: s.responseDeadline, reviewExpireTime: null, testFlag: false,
  });
}

// upstream: refund.rs::fetch_authoritative_refund_context
export async function fetchAuthoritativeRefundContext(client, jobId, userAgentId) {
  const snapshot = await fetchSnapshot(client, jobId, userAgentId);
  await reconcileWithoutDowngradingConfirmedSettlement(snapshot);
  return snapshotIntoContext(snapshot);
}

// upstream: refund.rs::fetch_authoritative_refund_context_for_provider
export async function fetchAuthoritativeRefundContextForProvider(client, jobId, providerAgentId) {
  return snapshotIntoContext(await fetchSnapshotForIdentity(client, jobId, providerAgentId, false));
}

// ── settlement helpers used by the lifecycle playbooks and the freshness gate ──
const ctxIs = (v, n) => is(v, n);

// upstream: refund.rs::authoritative_refund_settlement_confirmed
export function authoritativeRefundSettlementConfirmed(detail, expectedStatus) {
  if (!ctxIs(detail.status, expectedStatus) || ![7, 8, 9].includes(Number(expectedStatus))) return false;
  const amt = trim(detail.tokenAmount ?? '');
  const positive = validateDecimal(amt) && !isZeroDecimal(amt);
  if (Number(expectedStatus) === 8) return positive && (ctxIs(detail.jobType, 0) || (ctxIs(detail.jobType, 1) && ctxIs(detail.trialType, 0)));
  if (Number(expectedStatus) === 9) return positive && (ctxIs(detail.jobType, 0) || (ctxIs(detail.jobType, 1) && !ctxIs(detail.trialType, 1)));
  return ctxIs(detail.jobType, 0) && ctxIs(detail.paymentMode, 1) && positive;
}

// upstream: refund.rs::refund_event_settlement_confirmed
export const refundEventSettlementConfirmed = (detail, expectedStatus, _event) => authoritativeRefundSettlementConfirmed(detail, expectedStatus);

// upstream: refund.rs::verify_final_refund_event → RefundSettlementEvidence (throws on failure)
export function verifyFinalRefundEvent(message, prefetched, expectedStatus, expectedBuyerAgentId) {
  const msg = Number(expectedStatus) === 8 || message === undefined ? null : message;
  const detail = prefetched;
  if (detail === undefined || detail === null) throw new Error('fresh authoritative task detail is missing');
  if (![7, 8, 9].includes(Number(expectedStatus)) || !ctxIs(detail.status, expectedStatus)) throw new Error('fresh task status does not match a refund-capable lifecycle state');
  if (Number(expectedStatus) === 7) {
    const jt = detail.jobType;
    if (ctxIs(jt, 0) && !ctxIs(detail.paymentMode, 1)) throw new Error('paid close is not proven to be the escrow direct-refund path');
    if (ctxIs(jt, 1)) throw new Error('subscription Closed(7) lacks an authoritative refund-cause contract');
    if (isSome(jt) && !ctxIs(jt, 0)) throw new Error(`fresh task detail returned unsupported jobType=${jt}`);
    if (!isSome(jt)) throw new Error('fresh task detail is missing jobType');
  }
  if (detail.userAgentId !== expectedBuyerAgentId) throw new Error('fresh task detail is not owned by the current User Agent');
  const event = firstString([[msg, ['event']]]) ?? '';
  if (!refundEventSettlementConfirmed(detail, expectedStatus, event)) throw new Error('fresh task detail does not confirm refund settlement');
  const code = firstString([[msg, ['code', 'txStatus']]]);
  if (code !== undefined && ['failed', 'failure', 'error'].includes(code.replace(/[A-Z]/g, (c) => c.toLowerCase()))) throw new Error('refund transaction-result notification reports failure');
  const txHash = isSome(detail.verifiedTransactionHash) && validTxHash(detail.verifiedTransactionHash) ? detail.verifiedTransactionHash : null;
  const eventProvider = firstString([[msg, ['providerAgentId', 'aspAgentId']]]);
  const providerAgentId = detail.providerAgentId ?? 'unavailable';
  if (eventProvider !== undefined && isSome(detail.providerAgentId) && eventProvider !== detail.providerAgentId) throw new Error('refund event provider does not match fresh task detail');
  const providerName = detail.providerName ?? 'name unavailable';
  const eventService = firstString([[msg, ['serviceId']]]);
  if (eventService !== undefined && isSome(detail.serviceId) && eventService !== detail.serviceId) throw new Error('refund event service does not match fresh task detail');
  const serviceName = detail.serviceName ?? detail.serviceId ?? 'service unavailable';
  const eventServiceName = firstString([[msg, ['serviceName']]]);
  if (eventServiceName !== undefined && isSome(detail.serviceName) && eventServiceName !== detail.serviceName) throw new Error('refund event service name does not match fresh task detail');
  const originalAmount = trim(detail.tokenAmount ?? '');
  if (!validateDecimal(originalAmount) || isZeroDecimal(originalAmount)) throw new Error('fresh task detail is missing a valid paid original amount');
  const eventAmount = firstString([[msg, ['refundAmount', 'paymentTokenAmount', 'tokenAmount']]]);
  if (eventAmount !== undefined && !decimalEqual(eventAmount, originalAmount)) throw new Error('refund event amount is not the full original payment');
  const freshSymbol = trim(detail.tokenSymbol ?? '');
  const hasFreshSymbol = freshSymbol !== '' && freshSymbol !== '?';
  const eventSymbol = firstString([[msg, ['refundTokenSymbol', 'paymentTokenSymbol', 'tokenSymbol']]]);
  if (eventSymbol !== undefined && hasFreshSymbol && !eqIgnoreAsciiCase(eventSymbol, freshSymbol)) throw new Error('refund event token does not match the original payment token');
  const tokenSymbol = hasFreshSymbol ? freshSymbol : 'token symbol unavailable';
  const originalTokenAddress = isSome(detail.tokenAddress) && trim(detail.tokenAddress) !== '' ? trim(detail.tokenAddress) : undefined;
  if (Number(expectedStatus) !== 8 && originalTokenAddress === undefined) throw new Error('fresh task detail is missing the original token address');
  const eventAddress = firstString([[msg, ['refundTokenAddress', 'paymentTokenAddress', 'tokenAddress']]]);
  if (eventAddress !== undefined && originalTokenAddress !== undefined && !eqIgnoreAsciiCase(eventAddress, originalTokenAddress)) {
    throw new Error('refund event token address does not match the original payment token');
  }
  const eventBuyer = firstString([[msg, ['buyerAgentId', 'userAgentId']]]);
  if (eventBuyer !== undefined && isSome(detail.userAgentId) && eventBuyer !== detail.userAgentId) throw new Error('refund event buyer does not match fresh task detail');
  return { providerName, providerAgentId, serviceName, amount: originalAmount, tokenSymbol, txHash };
}

// ── handlers ──
// upstream: refund.rs::handle_prepare → decision data
export async function handlePrepare(client, jobId, reason) {
  if (trim(jobId) === '') {
    return baseDecision('refund_eligibility', 'requires_user_input', 'refund_target_required', [action('resolve_refund_target', true)], { schemaVersion: SCHEMA_VERSION });
  }
  const who = await currentUserAgentId(jobId);
  if (who.decision) return who.decision;
  const snapshot = await fetchSnapshot(client, jobId, who.agentId);
  const pending = await reconcileWithoutDowngradingConfirmedSettlement(snapshot);
  const p = snapshot.plan(reason);
  if (pending) {
    const operation = pending.operation === RefundOperation.RequestRefund ? RefundOperation.RequestRefund : p.operation;
    return baseDecision('refund_reconciliation', 'blocked', 'refund_operation_pending_reconciliation', reconcileActions(jobId, operation),
      pendingReconciliationPayload(snapshot, reason, p, pending));
  }
  return baseDecision(p.phase, p.decision, p.reason, planActions(snapshot, p, reason), snapshot.payload(reason, p));
}

// upstream: refund.rs::strict_broadcast_receipt
function strictBroadcastReceipt(receipt) {
  if (!isObject(receipt)) throw new Error('broadcast response did not contain a receipt object');
  for (const field of ['pkgId', 'orderId', 'orderType', 'bizUniqKey']) {
    if (scalarString(get(receipt, field)) === undefined) throw new Error(`broadcast response is missing ${field}`);
  }
  const raw = get(receipt, 'txHash');
  let txHash;
  if (raw === undefined || raw === null) txHash = null;
  else if (typeof raw === 'string' && trim(raw) === '') txHash = null;
  else if (typeof raw === 'string' && validTxHash(raw)) txHash = trim(raw);
  else if (typeof raw === 'string') throw new Error('broadcast response returned an invalid transaction hash');
  else throw new Error('broadcast response returned a non-string transaction hash');
  return { ...receipt, txHash };
}

// upstream: refund.rs::lifecycle_biz_type
function lifecycleBizType(response, expected) {
  const t = scalarI64(get(response, 'type'));
  if (t === undefined || !(BigInt(t) > 0n)) throw new Error('lifecycle endpoint did not return a valid type');
  if (expected !== undefined && expected !== null && BigInt(t) !== BigInt(expected)) throw new Error(`lifecycle endpoint returned unexpected type=${t}; expected ${expected}`);
  return t;
}

// upstream: refund.rs::validate_lifecycle_preflight
function validateLifecyclePreflight(uopData) {
  if (get(uopData, 'executeResult') === false) {
    throw new Error(`backend transaction preflight failed: ${scalarString(get(uopData, 'executeErrorMsg')) ?? 'no error detail returned'}`);
  }
}

// upstream: refund.rs::sign_response
async function signResponse(client, response, accountId, address, snapshot, reason, expectedBizType) {
  const uop = get(response, 'uopData');
  if (uop === undefined || uop === null) throw new Error('lifecycle endpoint did not return uopData');
  const responseJobId = scalarString(get(response, 'jobId'));
  if (responseJobId === undefined) throw new Error('lifecycle endpoint did not return jobId');
  if (responseJobId !== snapshot.jobId) throw new Error('lifecycle endpoint returned a mismatched jobId');
  validateLifecyclePreflight(uop);
  const bizType = lifecycleBizType(response, expectedBizType);
  const extra = reason !== undefined && reason !== null ? { reason } : undefined;
  let receipt = await signing.signUopAndBroadcastFull(client, uop, accountId, address, snapshot.jobId, bizType, snapshot.buyerAgentId, extra);
  try { receipt = strictBroadcastReceipt(receipt); } catch (e) { throw context('broadcast receipt result is unknown', e); }
  receipt.bizType = bizType;
  return receipt;
}

async function mutation(client, path, body, agentId, ctxMsg) {
  try { return await client.postMutationWithIdentity(path, body, agentId); } catch (e) { throw context(ctxMsg, e); }
}

// upstream: refund.rs::execute_regular_reject
async function executeRegularReject(client, snapshot, reason, accountId, address) {
  const deadline = nowSecs() + 1800;
  const pre = await mutation(client, client.endpoint(snapshot.jobId, 'pre-reject'), { deadline }, snapshot.buyerAgentId, 'pre-reject result is unknown');
  const typedData = get(pre, 'typedData');
  if (typedData === undefined || typedData === null) throw new Error('pre-reject did not return typedData');
  const rawNonce = asStr(get(pre, 'nonce'));
  const nonce = rawNonce === undefined ? '' : trim(rawNonce);
  if (nonce === '') throw new Error('pre-reject did not return nonce');
  const signature = await signing.signTypedData(typedData, address);
  const response = await mutation(client, client.endpoint(snapshot.jobId, 'reject'), { signatureData: { signature, deadline, nonce } }, snapshot.buyerAgentId, 'reject result is unknown');
  return signResponse(client, response, accountId, address, snapshot, reason, null);
}

// upstream: refund.rs::execute_operation
async function executeOperation(client, snapshot, operation, reason, accountId, address) {
  const job = snapshot.jobId, buyer = snapshot.buyerAgentId;
  if (operation === RefundOperation.CloseZero || operation === RefundOperation.DirectRefund) {
    const r = await mutation(client, client.endpoint(job, 'close'), {}, buyer, 'close result is unknown');
    return signResponse(client, r, accountId, address, snapshot, null, null);
  }
  if (operation === RefundOperation.CancelTrialConversion) {
    const r = await mutation(client, `${SUBSCRIBE_API_PREFIX}/${job}/cancel`, {}, buyer, 'trial conversion cancellation result is unknown');
    return signResponse(client, r, accountId, address, snapshot, null, null);
  }
  if (operation === RefundOperation.CloseCreatedSubscription) {
    const r = await mutation(client, `${SUBSCRIBE_API_PREFIX}/${job}/cancel`, {}, buyer, 'Created subscription close result is unknown');
    return signResponse(client, r, accountId, address, snapshot, null, null);
  }
  if (reason === undefined || reason === null) throw new Error('refund reason is required');
  if (snapshot.isSubscription()) {
    const r = await mutation(client, `${SUBSCRIBE_API_PREFIX}/${job}/reject`, {}, buyer, 'subscription refund request result is unknown');
    return signResponse(client, r, accountId, address, snapshot, reason, null);
  }
  return executeRegularReject(client, snapshot, reason, accountId, address);
}

const blockedWithDiagnostic = (snapshot, reason, p, decisionReason, diagnostic, actions) => {
  const payload = snapshot.payload(reason, p);
  payload.capability.clientOperation = null;
  payload.capability.diagnostic = diagnostic;
  return baseDecision('refund_execution', 'blocked', decisionReason, actions, payload);
};
const staleContext = (snapshot, reason, p, jobId) => baseDecision('refund_eligibility', 'blocked', 'refund_context_stale',
  [action('prepare_refund', true, { jobId })], snapshot.payload(reason, p));

// upstream: refund.rs::handle_execute → decision data
export async function handleExecute(client, jobId, operation, refundContextId, reason, confirm) {
  const who = await currentUserAgentId(jobId);
  if (who.decision) return who.decision;
  const userAgentId = who.agentId;
  let snapshot = await fetchSnapshot(client, jobId, userAgentId);
  let pending = await reconcileWithoutDowngradingConfirmedSettlement(snapshot);
  let p = snapshot.plan(reason);
  if (snapshot.contextId(reason) !== refundContextId) return staleContext(snapshot, reason, p, jobId);
  if (p.operation !== operation) {
    return baseDecision('refund_eligibility', 'blocked', 'refund_operation_not_available', planActions(snapshot, p, reason), snapshot.payload(reason, p));
  }
  if (pending) {
    return baseDecision('refund_reconciliation', 'blocked', 'refund_operation_pending_reconciliation', reconcileActions(jobId, operation),
      pendingReconciliationPayload(snapshot, reason, p, pending));
  }
  if (!confirm) {
    return baseDecision('refund_confirmation', 'requires_user_input', 'refund_execution_confirmation_required', planActions(snapshot, p, reason), snapshot.payload(reason, p));
  }
  let accountId, address;
  try { [accountId, address] = await signing.resolveWalletByAgentId(userAgentId); } catch (e) {
    auditLog('cli', 'user/refund_v2_wallet_preflight_failed', false, 0, [`jobId=${jobId}`], 'wallet resolution failed before any refund mutation');
    return blockedWithDiagnostic(snapshot, reason, p, 'refund_wallet_preflight_failed', displayTop(e), [action('stop', true)]);
  }
  let release;
  try { release = await acquirePendingLock(jobId, userAgentId); } catch (e) {
    return blockedWithDiagnostic(snapshot, reason, p, 'refund_reconciliation_guard_unavailable', displayTop(e), [action('stop', true)]);
  }
  // upstream holds `_lock` until handle_execute returns.
  try { return await executeLocked(client, jobId, operation, refundContextId, reason, userAgentId, accountId, address); } finally { release(); }
}

// upstream: refund.rs::handle_execute — the part that runs under the per-task execution lock.
async function executeLocked(client, jobId, operation, refundContextId, reason, userAgentId, accountId, address) {
  let pending, p;
  // A second read under the lock closes the gap between confirmation and mutation.
  const snapshot = await fetchSnapshot(client, jobId, userAgentId);
  try { pending = await reconcilePendingMutationLocked(snapshot); } catch (e) {
    if (!snapshot.settlementConfirmed) throw e;
    pending = null;
  }
  p = snapshot.plan(reason);
  if (snapshot.contextId(reason) !== refundContextId || p.operation !== operation) return staleContext(snapshot, reason, p, jobId);
  if (pending) {
    return baseDecision('refund_reconciliation', 'blocked', 'refund_operation_pending_reconciliation', reconcileActions(jobId, operation),
      pendingReconciliationPayload(snapshot, reason, p, pending));
  }
  const journal = {
    schemaVersion: SCHEMA_VERSION, journalRevision: JOURNAL_REVISION, jobId, userAgentId, snapshotId: snapshot.contextId(null), operation,
    state: 'unknown', jobType: snapshot.jobType, trialType: snapshot.trialType, periodIndex: snapshot.periodIndex,
    periodStartTime: snapshot.periodStartTime, periodEndTime: snapshot.periodEndTime, pkgId: null, orderId: null, orderType: null,
    bizUniqKey: null, txHash: null, accountId, address, chainIndex: XLAYER_CHAIN_INDEX, bizType: null, originalAmount: snapshot.originalAmount,
    tokenAddress: snapshot.tokenAddress, tokenSymbol: snapshot.tokenSymbol, providerAgentId: snapshot.providerAgentId,
    serviceId: snapshot.serviceId, serviceName: snapshot.serviceName, paymentMode: snapshot.paymentMode, updatedAt: nowSecs(),
  };
  try { writePendingMutation(journal); } catch (e) {
    return blockedWithDiagnostic(snapshot, reason, p, 'refund_reconciliation_guard_unavailable', displayTop(e), [action('stop', true)]);
  }
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  let receipt;
  try {
    receipt = await executeOperation(client, snapshot, operation, reason, accountId, address);
  } catch (error) {
    const definitive = isDefinitiveApiRejection(error);
    if (definitive || !mutationOutcomeMayBeUnknown(error)) {
      try { removePendingMutation(jobId, userAgentId); } catch (removeError) {
        journal.state = 'unknown';
        touch(journal);
        try { writePendingMutation(journal); } catch {}
        const payload = pendingReconciliationPayload(snapshot, reason, p, journal);
        payload.capability.diagnostic = `backend rejected the write, but the local reconciliation guard could not be cleared: ${displayTop(removeError)}`;
        return baseDecision('refund_reconciliation', 'blocked', 'refund_operation_pending_reconciliation', reconcileActions(jobId, operation), payload);
      }
      return blockedWithDiagnostic(snapshot, reason, p, definitive ? 'refund_write_rejected' : 'refund_prebroadcast_failed', displayTop(error),
        [action('prepare_refund', true, { jobId })]);
    }
    journal.state = 'unknown';
    touch(journal);
    try { writePendingMutation(journal); } catch {}
    auditLog('cli', 'user/refund_v2_outcome_unknown', false, elapsed(), [`jobId=${jobId}`, `operation=${operation}`], 'mutation or broadcast outcome requires reconciliation');
    const payload = pendingReconciliationPayload(snapshot, reason, p, journal);
    payload.settlement.error = displayTop(error);
    return baseDecision('refund_settlement', 'blocked', 'refund_outcome_unknown', reconcileActions(jobId, operation), payload);
  }

  journal.state = 'broadcast_submitted';
  journal.pkgId = scalarString(get(receipt, 'pkgId')) ?? null;
  journal.orderId = scalarString(get(receipt, 'orderId')) ?? null;
  journal.orderType = scalarString(get(receipt, 'orderType')) ?? null;
  journal.bizUniqKey = scalarString(get(receipt, 'bizUniqKey')) ?? null;
  journal.txHash = scalarString(get(receipt, 'txHash')) ?? null;
  journal.bizType = scalarI64(get(receipt, 'bizType')) ?? null;
  touch(journal);
  try { writePendingMutation(journal); } catch (e) {
    auditLog('cli', 'user/refund_v2_receipt_persist_failed', false, elapsed(), [`jobId=${jobId}`, `agentId=${userAgentId}`, `operation=${operation}`],
      'broadcast accepted but reconciliation receipt was not persisted');
    const payload = pendingReconciliationPayload(snapshot, reason, p, journal);
    payload.settlement.broadcastReceipt = receipt;
    payload.capability.diagnostic = displayTop(e);
    return baseDecision('refund_reconciliation', 'blocked', 'refund_outcome_unknown', reconcileActions(jobId, operation), payload);
  }

  if (operation === RefundOperation.CloseZero || operation === RefundOperation.DirectRefund) {
    try { await negotiateCleanup(jobId); } catch {}
  } else if (operation === RefundOperation.CancelTrialConversion || operation === RefundOperation.CloseCreatedSubscription) {
    try { await markRetiredAutotradeModeDecisionsHandled(jobId); } catch {}
    if (operation === RefundOperation.CloseCreatedSubscription) { try { await negotiateCleanup(jobId); } catch {} }
  }

  auditLog('cli', 'user/refund_v2_broadcast_submitted', true, elapsed(), [`jobId=${jobId}`, `agentId=${userAgentId}`, `operation=${operation}`,
    `reasonLen=${reason === undefined || reason === null ? 0 : Buffer.byteLength(reason, 'utf8')}`, `txHash=${asStr(get(receipt, 'txHash')) ?? ''}`]);

  const resultReason = {
    [RefundOperation.CloseZero]: 'zero_amount_close_broadcast_submitted', [RefundOperation.DirectRefund]: 'refund_broadcast_submitted',
    [RefundOperation.RequestRefund]: 'refund_request_broadcast_submitted', [RefundOperation.CancelTrialConversion]: 'trial_conversion_cancel_broadcast_submitted',
    [RefundOperation.CloseCreatedSubscription]: 'created_subscription_close_broadcast_submitted',
  }[operation];
  const payload = snapshot.payload(reason, p);
  payload.settlement.state = 'broadcast_submitted';
  payload.settlement.txHash = null;
  payload.settlement.broadcastReceipt = receipt;
  if (operation === RefundOperation.RequestRefund) {
    payload.request.providerNotification.system = 'unknown';
    payload.request.providerNotification.email = 'unknown';
  }
  return baseDecision('refund_settlement', 'ready', resultReason, reconcileActions(jobId, operation), payload);
}

// test seam: pure pieces for unit tests
export const _internal = {
  planActions, reconcileActions, strictBroadcastReceipt, lifecycleBizType, validateLifecyclePreflight, pendingMutationResolved,
  directRefundProvenanceMatches, createdSubscriptionCloseProvenanceMatches, requestRefundProvenanceMatches, statusName, pendingStruct,
  isDefinitiveApiRejection, mutationOutcomeMayBeUnknown, loginBlock, identityBlock, pendingReconciliationPayload, PENDING, mkdirSync,
  acquirePendingLock,
};
