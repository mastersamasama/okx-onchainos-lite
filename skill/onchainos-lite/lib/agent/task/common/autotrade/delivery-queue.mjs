// Durable per-job FIFO of decision-requiring deliveries — upstream autotrade/delivery_queue.rs.
// `<home>/autotrade/delivery-queue/<jobId>.json` (+ `<jobId>.lock`).
import { join } from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { stringify, struct } from '../../../../core/json.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { loadDeliveryContext, loadPendingDeliveryContext } from './consent.mjs';
import { fromSlice, T } from '../../../../core/serde.mjs';
import { home as onchainosHome, writeSecure, ensureDir0700 } from '../../../../core/home.mjs';
import { exists, isDir, readBytes, readDirPaths, removeFileQuiet, io, ioError, extension, fileStem } from '../../../../core/rs/fs.mjs';
import { nowSecs, nowMs } from '../../../../core/rs/time.mjs';
import { u64SaturatingAdd } from '../../../../core/rs/num.mjs';
import { sha256Hex } from '../../../../core/rs/codec.mjs';
import { sessionSendWithTimeout, sessionSendExactWithTimeout } from '../okx-a2a.mjs';

const QUEUE_VERSION = 1;
const RESUME_ENVELOPE_VERSION = 2;
const RETRY_DELAY_SEC = 30;
const RESUME_ACK_TIMEOUT_SEC = 30;
const PROCESSING_WATCHDOG_SEC = 15 * 60;

// upstream: delivery_queue.rs::EntryState (wire strings)
const EntryState = Object.freeze({ Processing: 'processing', AwaitingDecision: 'awaiting_decision', Waiting: 'waiting', ResumePending: 'resume_pending', ResumeSent: 'resume_sent' });
// upstream: delivery_queue.rs::ResumeAck
export const ResumeAck = Object.freeze({ Accepted: 'Accepted', DuplicateOrStale: 'DuplicateOrStale', NotQueueHead: 'NotQueueHead' });

const STATE_T = T.enum('EntryState', Object.values(EntryState).map((v) => [v, v]));
const ENTRY_T = T.struct('QueueEntry', [
  ['deliveryId', T.string], ['state', STATE_T], ['enqueuedAtMs', T.u64], ['nextResumeAttemptAt', T.u64, 0], ['resumeAttempts', T.u32, 0],
  ['resumeSentAt', T.u64, 0], ['processingStartedAt', T.u64, 0], ['processingAttempt', T.u32, 0], ['resumeProtocolVersion', T.u32, 0],
], { denyUnknown: true });
const QUEUE_T = T.struct('QueueFile', [['version', T.u32], ['jobId', T.string], ['entries', T.vec(ENTRY_T)]], { denyUnknown: true });
const entryJson = (e) => struct({
  deliveryId: e.deliveryId, state: e.state, enqueuedAtMs: e.enqueuedAtMs, nextResumeAttemptAt: e.nextResumeAttemptAt, resumeAttempts: e.resumeAttempts,
  resumeSentAt: e.resumeSentAt, processingStartedAt: e.processingStartedAt, processingAttempt: e.processingAttempt, resumeProtocolVersion: e.resumeProtocolVersion,
});
const queueJson = (q) => struct({ version: q.version, jobId: q.jobId, entries: q.entries.map(entryJson) });
const newEntry = (deliveryId, state, enqueuedAtMs, processingStartedAt = 0) => ({
  deliveryId, state, enqueuedAtMs, nextResumeAttemptAt: 0, resumeAttempts: 0, resumeSentAt: 0, processingStartedAt, processingAttempt: 0, resumeProtocolVersion: 0,
});

// upstream: delivery_queue.rs::root / queue_path / lock_path
const root = () => join(onchainosHome(), 'autotrade', 'delivery-queue');
function queuePath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(root(), `${jobId}.json`);
}
const lockPath = (jobId) => join(root(), `${jobId}.lock`);

// upstream: delivery_queue.rs::acquire_lock — creates the (empty, 0600) lock file. Node has no
// flock: exclusion is in-process only (see unit report divergences).
function acquireLock(jobId) {
  const path = lockPath(jobId);
  io(() => ensureDir0700(root()));
  let fd;
  try { fd = openSync(path, 'a', 0o600); } catch (e) { throw ioError(e); }
  try { closeSync(fd); } catch {}
}

// upstream: delivery_queue.rs::read_queue
function readQueue(jobId) {
  const path = queuePath(jobId);
  if (!exists(path)) return { version: QUEUE_VERSION, jobId, entries: [] };
  const q = fromSlice(readBytes(path), QUEUE_T);
  if (q.version !== QUEUE_VERSION || q.jobId !== jobId) throw new Error('delivery queue mismatch');
  return q;
}
// upstream: delivery_queue.rs::write_queue
function writeQueue(q) {
  const path = queuePath(q.jobId);
  if (!q.entries.length) { removeFileQuiet(path); return; }
  io(() => writeSecure(path, stringify(queueJson(q), true)));
}

// upstream: delivery_queue.rs::enqueue → { kind: 'Active', context, alreadyPresent } | { kind: 'Queued', activeDeliveryId, position }
export function enqueue(jobId, deliveryId) {
  const context = loadDeliveryContext(jobId, deliveryId);
  acquireLock(jobId);
  const q = readQueue(jobId);
  if (!q.entries.length) {
    const pending = loadPendingDeliveryContext(jobId);
    if (pending && pending.deliveryId !== deliveryId) q.entries.push(newEntry(pending.deliveryId, EntryState.AwaitingDecision, pending.receivedAtMs));
  }
  const index = q.entries.findIndex((e) => e.deliveryId === deliveryId);
  if (index >= 0) {
    if (index === 0) {
      const front = q.entries[0];
      const claimedResume = front.state === EntryState.Processing && front.processingAttempt > 0;
      if (claimedResume) { front.processingAttempt = 0; front.processingStartedAt = nowSecs(); writeQueue(q); }
      return { kind: 'Active', context, alreadyPresent: !claimedResume };
    }
    return { kind: 'Queued', activeDeliveryId: q.entries[0].deliveryId, position: index + 1 };
  }
  const active = q.entries.length === 0;
  q.entries.push(newEntry(deliveryId, active ? EntryState.Processing : EntryState.Waiting, nowMs(), active ? nowSecs() : 0));
  const position = q.entries.length;
  const activeDeliveryId = q.entries[0].deliveryId;
  writeQueue(q);
  return active ? { kind: 'Active', context, alreadyPresent: false } : { kind: 'Queued', activeDeliveryId, position };
}

// upstream: delivery_queue.rs::contains_delivery
export function containsDelivery(jobId, deliveryId) {
  acquireLock(jobId);
  return readQueue(jobId).entries.some((e) => e.deliveryId === deliveryId);
}

// upstream: delivery_queue.rs::mark_awaiting_decision
export function markAwaitingDecision(jobId, deliveryId) {
  acquireLock(jobId);
  const q = readQueue(jobId);
  const front = q.entries[0];
  if (!front) throw new Error('delivery queue is empty');
  if (front.deliveryId !== deliveryId) throw new Error('delivery is not the queue head');
  Object.assign(front, { state: EntryState.AwaitingDecision, nextResumeAttemptAt: 0, resumeSentAt: 0, processingStartedAt: 0, processingAttempt: 0 });
  writeQueue(q);
}

// upstream: delivery_queue.rs::acknowledge_resume (envelopeVersion / attempt: number | null)
export function acknowledgeResume(jobId, deliveryId, envelopeVersion, attempt) {
  acquireLock(jobId);
  const q = readQueue(jobId);
  const front = q.entries[0];
  if (!front || front.deliveryId !== deliveryId) return ResumeAck.NotQueueHead;
  if (front.state !== EntryState.ResumePending && front.state !== EntryState.ResumeSent) return ResumeAck.DuplicateOrStale;
  const none = (v) => v === null || v === undefined;
  let accepted;
  if (envelopeVersion === RESUME_ENVELOPE_VERSION && !none(attempt) && front.resumeProtocolVersion === RESUME_ENVELOPE_VERSION && attempt > 0 && attempt === front.resumeAttempts) accepted = attempt;
  else if (none(envelopeVersion) && !none(attempt) && front.resumeProtocolVersion === 0 && attempt > 0 && attempt === front.resumeAttempts) accepted = attempt;
  else if (none(envelopeVersion) && none(attempt) && front.resumeProtocolVersion === 0) accepted = front.resumeAttempts;
  else return ResumeAck.DuplicateOrStale;
  Object.assign(front, { state: EntryState.Processing, processingStartedAt: nowSecs(), processingAttempt: accepted, resumeSentAt: 0, nextResumeAttemptAt: 0 });
  writeQueue(q);
  return ResumeAck.Accepted;
}

// upstream: delivery_queue.rs::resume_envelope (json! → compact, sorted keys)
export function resumeEnvelope(context, attempt) {
  return stringify({
    agentId: context.agentId,
    message: {
      event: 'autotrade_queued_resume', data: 'resume_queued_delivery', code: 0,
      description: 'A previously queued Active-subscription delivery is now at the head of its FIFO. Call onchainos agent next-action with this envelope and follow the returned playbook. Re-read and re-validate the saved artifact; do not reuse prior dynamic trade fields.',
      source: 'system', jobId: context.jobId, deliveryId: context.deliveryId, resumeEnvelopeVersion: RESUME_ENVELOPE_VERSION,
      resumeAttempt: attempt, role: 'user', timestamp: nowSecs(),
    },
  });
}

// upstream: delivery_queue.rs::send_resume
async function sendResume(context, attempt, timeoutMs) {
  const content = resumeEnvelope(context, attempt);
  const messageId = `autotrade-queue-resume:${sha256Hex(`${context.jobId}\0${context.deliveryId}\0${attempt}`)}`;
  const key = context.originSessionKey;
  if (key !== null && key !== undefined && key !== '') return sessionSendExactWithTimeout(key, content, messageId, timeoutMs);
  return sessionSendWithTimeout(context.jobId, context.providerAgentId, content, timeoutMs);
}

// upstream: delivery_queue.rs::dispatch_front → dispatched?
async function dispatchFront(jobId, timeoutMs) {
  acquireLock(jobId);
  const q = readQueue(jobId);
  const front = q.entries[0];
  if (!front) return false;
  const now = nowSecs();
  const pendingDue = front.state === EntryState.ResumePending && front.nextResumeAttemptAt <= now;
  const ackTimedOut = front.state === EntryState.ResumeSent && (BigInt(front.resumeSentAt) === 0n || u64SaturatingAdd(front.resumeSentAt, RESUME_ACK_TIMEOUT_SEC) <= now);
  if (!pendingDue && !ackTimedOut) return false;
  Object.assign(front, {
    state: EntryState.ResumePending, nextResumeAttemptAt: u64SaturatingAdd(now, RETRY_DELAY_SEC), resumeAttempts: Math.min(front.resumeAttempts + 1, 4294967295),
    resumeProtocolVersion: RESUME_ENVELOPE_VERSION, resumeSentAt: 0, processingStartedAt: 0, processingAttempt: 0,
  });
  const deliveryId = front.deliveryId, attempt = front.resumeAttempts;
  writeQueue(q);
  const context = loadDeliveryContext(jobId, deliveryId);
  await sendResume(context, attempt, timeoutMs);
  acquireLock(jobId);
  const q2 = readQueue(jobId);
  const f2 = q2.entries[0];
  if (f2 && f2.deliveryId === deliveryId && f2.state === EntryState.ResumePending) {
    f2.state = EntryState.ResumeSent;
    f2.resumeSentAt = nowSecs();
    f2.nextResumeAttemptAt = u64SaturatingAdd(f2.resumeSentAt, RESUME_ACK_TIMEOUT_SEC);
    writeQueue(q2);
  }
  return true;
}

// upstream: delivery_queue.rs::schedule_retry
export function scheduleRetry(jobId, deliveryId) {
  acquireLock(jobId);
  const q = readQueue(jobId);
  const front = q.entries[0];
  if (front && front.deliveryId === deliveryId) {
    Object.assign(front, { state: EntryState.ResumePending, nextResumeAttemptAt: u64SaturatingAdd(nowSecs(), RETRY_DELAY_SEC), resumeSentAt: 0, processingStartedAt: 0, processingAttempt: 0 });
    writeQueue(q);
  }
}

// upstream: delivery_queue.rs::remove_terminal_and_promote → shouldDispatch
function removeTerminalAndPromote(jobId, deliveryId) {
  acquireLock(jobId);
  const q = readQueue(jobId);
  const index = q.entries.findIndex((e) => e.deliveryId === deliveryId);
  if (index < 0) return false;
  const wasFront = index === 0;
  q.entries.splice(index, 1);
  if (wasFront && q.entries[0]) Object.assign(q.entries[0], { state: EntryState.ResumePending, nextResumeAttemptAt: 0, resumeSentAt: 0, processingStartedAt: 0, processingAttempt: 0 });
  const shouldDispatch = wasFront && q.entries.length > 0;
  writeQueue(q);
  return shouldDispatch;
}

// upstream: delivery_queue.rs::reconcile_terminal
export const reconcileTerminal = (jobId, deliveryId) => removeTerminalAndPromote(jobId, deliveryId);
// upstream: delivery_queue.rs::complete_and_advance
export async function completeAndAdvance(jobId, deliveryId) {
  return removeTerminalAndPromote(jobId, deliveryId) ? dispatchFront(jobId, 1000) : false;
}
// upstream: delivery_queue.rs::release_unpresented
export const releaseUnpresented = completeAndAdvance;

// upstream: delivery_queue.rs::reconcile_terminal_head
export async function reconcileTerminalHead(jobId) {
  const executor = await import('./executor.mjs');
  acquireLock(jobId);
  const front = readQueue(jobId).entries[0];
  if (!front) return false;
  const deliveryId = front.deliveryId;
  if (executor.recoveryState(jobId, deliveryId) !== executor.RecoveryState.TerminalOutcome) return false;
  return executor.recoverIncomplete(jobId, deliveryId);
}

// upstream: delivery_queue.rs::migrate_legacy_processing
async function migrateLegacyProcessing(jobId) {
  const executor = await import('./executor.mjs');
  acquireLock(jobId);
  const front = readQueue(jobId).entries[0];
  if (!front || front.state !== EntryState.Processing || BigInt(front.processingStartedAt) !== 0n) return false;
  const deliveryId = front.deliveryId;
  if (executor.recoveryState(jobId, deliveryId) !== executor.RecoveryState.NoExecution) return executor.recoverIncomplete(jobId, deliveryId);
  const pending = loadPendingDeliveryContext(jobId);
  const stillLegacy = (f) => f && f.deliveryId === deliveryId && f.state === EntryState.Processing && BigInt(f.processingStartedAt) === 0n;
  acquireLock(jobId);
  const q = readQueue(jobId);
  const f = q.entries[0];
  if (pending && pending.deliveryId === deliveryId) {
    if (stillLegacy(f)) { f.state = EntryState.AwaitingDecision; f.processingAttempt = 0; writeQueue(q); return true; }
    return false;
  }
  if (stillLegacy(f)) {
    Object.assign(f, { state: EntryState.ResumePending, nextResumeAttemptAt: 0, resumeSentAt: 0, processingAttempt: 0, resumeProtocolVersion: 0 });
    writeQueue(q);
    return true;
  }
  return false;
}

// upstream: delivery_queue.rs::recover_stalled_processing
async function recoverStalledProcessing(jobId) {
  const executor = await import('./executor.mjs');
  acquireLock(jobId);
  const front = readQueue(jobId).entries[0];
  if (!front || front.state !== EntryState.Processing || BigInt(front.processingStartedAt) === 0n
    || BigInt(u64SaturatingAdd(front.processingStartedAt, PROCESSING_WATCHDOG_SEC)) > BigInt(nowSecs())) return false;
  const deliveryId = front.deliveryId;
  const state = executor.recoveryState(jobId, deliveryId);
  if (state === executor.RecoveryState.NoExecution) {
    acquireLock(jobId);
    const q = readQueue(jobId);
    const f = q.entries[0];
    if (f && f.deliveryId === deliveryId && f.state === EntryState.Processing) {
      Object.assign(f, { state: EntryState.ResumePending, nextResumeAttemptAt: 0, processingStartedAt: 0, processingAttempt: 0 });
      writeQueue(q);
      return true;
    }
    return false;
  }
  return executor.recoverIncomplete(jobId, deliveryId);
}

// upstream: delivery_queue.rs::flush_due(limit, budget) → dispatched count
export async function flushDue(limit, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const r = root();
  if (!isDir(r)) return 0;
  let dispatched = 0;
  for (const path of readDirPaths(r)) {
    if (dispatched >= limit || Date.now() >= deadline) break;
    if (extension(path) !== 'json') continue;
    const jobId = fileStem(path);
    try { await reconcileTerminalHead(jobId); } catch {}
    try { await migrateLegacyProcessing(jobId); } catch {}
    try { await recoverStalledProcessing(jobId); } catch {}
    const remaining = deadline - Date.now();
    if (remaining < 25) break;
    let d = false;
    try { d = await dispatchFront(jobId, remaining); } catch { d = false; }
    dispatched += d ? 1 : 0;
  }
  return dispatched;
}
