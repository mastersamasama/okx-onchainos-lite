// Pending-decisions v2 queue — upstream task/common/pending_v2.rs.
// Files under <home>/task/: pending-decisions-new.json (queue), pending-decisions-new.lock,
// last-display.json (index snapshot). Handlers print plain-text playbooks (or a JSON line).
import { mkdirSync, readFileSync, writeFileSync, writeSync, renameSync, existsSync, openSync, closeSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { stringify, struct } from '../../../core/json.mjs';
import { CodedError } from '../../../core/errors.mjs';
import { fromStr, T } from '../../../wallet/_serde-json.mjs';
import { taskStateRoot } from '../../_home.mjs';
import {
  nowNanos, nowSecs, utcNanosSerde, utcNanosRfc3339, utcNowRfc3339, parseRfc3339Nanos, rustDebugStr, debugOptStr, ioErrorText, isObj, trim, trimStart,
  utf8Strict, readToString, readErrorText,
} from '../../_rs.mjs';
import { sleep } from '../../../core/proc.mjs';
import * as arbitration from '../arbitration.mjs';
import { isCliMode } from './config.mjs';
import { decodeAndValidate, renderAll, TemplateVarError } from './template-vars.mjs';
import { hasReviewCardSentMarker, markReviewCardSent } from './deliverables.mjs';
import { userDecisionRequest, sessionSend, sessionSendExact } from './okx-a2a.mjs';
import { recordFromUserText } from './user-lang.mjs';
import {
  isRetiredModeConfigurationDecision, isCandidateSource, loadPendingDeliveryContext, clearPendingSignal, clearCandidateDraft, applyCandidateJson,
  CONSENT_SOURCE_EVENT,
} from './_autotrade.mjs';

export { isCliMode } from './config.mjs';

const DEFAULT_TTL_DAYS = 7n;
const TTL_ENV_VAR = 'ONCHAINOS_PENDING_DECISIONS_TTL_DAYS';
const LOCK_TIMEOUT_MS = 5000;
const NS = 1000000000n;

// upstream: pending_v2.rs::DEFER_KEYWORDS
export const DEFER_KEYWORDS = Object.freeze(['等会儿', '等等', '等一下', '稍后', '晚点', '先放着', '先不管', '回头再看', 'skip', 'later', 'wait', 'hold on', 'not now', 'defer']);

// upstream: pending_v2.rs::decision_relay_post_action
const decisionRelayPostAction = () => 'Decision relayed. If this card was surfaced by a currently active `okx-a2a user watch`, immediately re-enter that exact originating watch command per `skills/okx-ai/references/runtime/watch.md` (re-enter through `skills/okx-ai/SKILL.md` and preserve global vs sticky `--job-id`). If it was opened independently through a decision list / outdated-list, do not start watch; end the turn normally. Never infer watch origin from the user\'s reply text.\n';

// upstream: pending_v2.rs::arbitration_relay_description
const arbitrationRelayDescription = (mode, agentId) => `User-decision relay envelope (${mode}). Run \`onchainos agent next-action --role auto --agentId ${agentId} --message '<complete current message object as JSON>'\`. Preserve every field from the current \`message\` object, including \`decisionId\`, \`selectedActionId\`, \`params\`, \`data\`, and \`jobId\` when present. Decision resolution is complete in the user session; continue with the returned progression result.`;

// ─── data model ───
// PendingEntry (camelCase in memory; snake_case struct on disk). createdAt/updatedAt: BigInt ns.
const CHOICE_T = T.struct('DecisionChoice', [['key', T.string], ['actionId', T.string], ['params', T.map(T.value), () => ({})]]);
const REFUND_T = T.struct('RefundDisplayMetadata', [['serviceName', T.string], ['taskType', T.string], ['amount', T.string], ['tokenSymbol', T.string], ['responseDeadline', T.i64]]);
const ENTRY_T = T.struct('PendingEntry', [['job_id', T.string], ['role', T.string], ['agent_id', T.string], ['to_agent_id', T.option(T.string), null],
  ['user_content', T.string], ['list_label', T.string], ['llm_content_override', T.option(T.string), null], ['source_event', T.option(T.string), null],
  ['decision_id', T.option(T.string), null], ['choices', T.vec(CHOICE_T), () => []], ['expires_at', T.option(T.i64), null],
  ['refund_display', T.option(REFUND_T), null], ['status', T.string], ['created_at', T.string], ['updated_at', T.string]]);
const QUEUE_T = T.struct('Queue', [['entries', T.vec(ENTRY_T)]]);
const ITEM_T = T.struct('DisplayItem', [['index', T.i64], ['job_id', T.string], ['role', T.string], ['agent_id', T.string], ['to_agent_id', T.option(T.string), null], ['list_label', T.string]]);
const SNAP_T = T.struct('DisplaySnapshot', [['displayed_at', T.option(T.string)], ['items', T.vec(ITEM_T)]]);

function entryFromDisk(e) {
  if (e.status !== 'active' && e.status !== 'queued') throw new Error('bad status');
  const createdAt = parseRfc3339Nanos(e.created_at), updatedAt = parseRfc3339Nanos(e.updated_at);
  if (createdAt === undefined || updatedAt === undefined) throw new Error('bad datetime');
  return {
    jobId: e.job_id, role: e.role, agentId: e.agent_id, toAgentId: e.to_agent_id, userContent: e.user_content, listLabel: e.list_label,
    llmContentOverride: e.llm_content_override, sourceEvent: e.source_event, decisionId: e.decision_id,
    choices: e.choices.map((c) => arbitration.decisionChoice(c.key, c.actionId, c.params)), expiresAt: e.expires_at,
    refundDisplay: e.refund_display ? new arbitration.RefundDisplayMetadata(e.refund_display) : null, status: e.status, createdAt, updatedAt,
  };
}
const choiceStruct = (c) => struct({ key: c.key, actionId: c.actionId, params: Object.keys(c.params).length ? c.params : undefined });
const entryStruct = (e) => struct({
  job_id: e.jobId, role: e.role, agent_id: e.agentId, to_agent_id: e.toAgentId ?? undefined, user_content: e.userContent, list_label: e.listLabel,
  llm_content_override: e.llmContentOverride ?? undefined, source_event: e.sourceEvent ?? undefined, decision_id: e.decisionId ?? undefined,
  choices: e.choices.length ? e.choices.map(choiceStruct) : undefined, expires_at: e.expiresAt ?? undefined,
  refund_display: e.refundDisplay ? e.refundDisplay.toStruct() : undefined, status: e.status, created_at: utcNanosSerde(e.createdAt), updated_at: utcNanosSerde(e.updatedAt),
});

// upstream: pending_v2.rs::decision_metadata
function decisionMetadata(jobId, sourceEvent, decisionId, choicesJson, expiresAt, refundDisplayB64) {
  const src = sourceEvent ?? '';
  const choices = arbitration.parseChoices(choicesJson, src, jobId);
  let did = decisionId ?? null;
  if (arbitration.isDecisionSource(src)) did = did !== null && trim(did) !== '' ? did : `${jobId}:${src}:current`;
  let refundDisplay = null;
  if (refundDisplayB64 !== undefined && refundDisplayB64 !== null) refundDisplay = arbitration.RefundDisplayMetadata.decode(refundDisplayB64);
  if (refundDisplay && !arbitration.isDecisionSource(src)) throw new Error('refund display metadata requires a refund decision source event');
  if (refundDisplay && ((src === arbitration.JOB_REJECTED && refundDisplay.taskType !== 'One-time') || (src === arbitration.SUB_USER_REJECT && refundDisplay.taskType !== 'Subscription'))) {
    throw new Error('refund display task type does not match the source event');
  }
  return { decisionId: did, choices, expiresAt: expiresAt !== undefined && expiresAt !== null && BigInt(expiresAt) > 0n ? expiresAt : null, refundDisplay };
}
const emptyMetadata = () => ({ decisionId: null, choices: [], expiresAt: null, refundDisplay: null });

const entryMatches = (e, jobId, role, agentId, toAgentId) => e.jobId === jobId && e.role === role && e.agentId === agentId && (e.toAgentId ?? null) === (toAgentId ?? null);
const entryMatchesRequest = (e, jobId, role, agentId, toAgentId, decisionId) => entryMatches(e, jobId, role, agentId, toAgentId)
  && (decisionId === undefined || decisionId === null || e.decisionId === decisionId);

// ─── paths / lock / IO ───
function taskDir() { const d = taskStateRoot(); mkdirSync(d, { recursive: true }); return d; }
const queuePath = () => join(taskDir(), 'pending-decisions-new.json');
const lockPath = () => join(taskDir(), 'pending-decisions-new.lock');
const snapshotPath = () => join(taskDir(), 'last-display.json');

function loadGlobalTtlSecs() {
  const v = process.env[TTL_ENV_VAR];
  const days = v !== undefined && /^\+?[0-9]+$/.test(v) && BigInt(v) <= 18446744073709551615n ? BigInt(v) : DEFAULT_TTL_DAYS;
  // Duration::from_secs(days * 24 * 60 * 60): the u64 product wraps in release builds.
  return BigInt.asUintN(64, days * 86400n);
}

// upstream: pending_v2.rs::acquire_lock — the flock file persists; lite serialises writers with an
// exclusive sibling marker (Node has no flock).
async function acquireLock() {
  const p = lockPath();
  try { closeSync(openSync(p, 'a')); } catch (e) { throw new Error(ioErrorText(e)); }
  const marker = `${p}.held`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // An OS flock dies with its process; emulate that by recording the holder pid in the marker
  // and reclaiming it when that process no longer exists (or the marker is > 30 s old).
  const holderGone = () => {
    let pid;
    try { pid = Number(readFileSync(marker, 'utf8')); } catch { return false; }
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); return false; } catch (err) { return err?.code === 'ESRCH'; }
  };
  for (;;) {
    let fd;
    try { fd = openSync(marker, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw new Error(`acquire flock failed: ${ioErrorText(e)}`);
      try { if (holderGone() || Date.now() - statSync(marker).mtimeMs > 30000) { rmSync(marker, { force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('pending-decisions lock timed out after 5s');
      await sleep(10);
      continue;
    }
    try { writeSync(fd, String(process.pid)); } catch {} finally { closeSync(fd); }
    break;
  }
  return { release() { try { rmSync(marker, { force: true }); } catch {} } };
}
async function withLock(fn) {
  const lock = await acquireLock();
  try { return await fn(); } finally { lock.release(); }
}

// upstream: pending_v2.rs::trace_log (best-effort)
function traceLog(line) { try { appendFileSync('/tmp/onchainos-cli-mode.log', `[${utcNowRfc3339()}] ${line}\n`); } catch {} }

// upstream: pending_v2.rs::read_queue — unparsable → empty; retired autotrade sources dropped.
function readQueue() {
  const path = queuePath();
  if (!existsSync(path)) return { entries: [] };
  let raw;
  try { raw = readFileSync(path); } catch (e) { throw new Error(ioErrorText(e)); }
  const text = utf8Strict(raw);   // read_to_string: invalid UTF-8 propagates; a leading U+FEFF is kept
  if (trim(text) === '') return { entries: [] };
  let entries;
  try { entries = fromStr(raw, QUEUE_T).entries.map(entryFromDisk); } catch { entries = []; }
  return { entries: entries.filter((e) => !isRetiredModeConfigurationDecision(e.sourceEvent)) };
}
function writeAtomic(path, text) {
  const tmp = join(taskDir(), `.tmp${randomBytes(6).toString('base64url')}`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
const writeQueueAtomic = (q) => writeAtomic(queuePath(), stringify(struct({ entries: q.entries.map(entryStruct) }), true));
function readSnapshot() {
  let path;
  try { path = snapshotPath(); } catch { return { displayedAt: null, items: [] }; }
  if (!existsSync(path)) return { displayedAt: null, items: [] };
  try {
    const s = fromStr(readFileSync(path), SNAP_T);
    const displayedAt = s.displayed_at === null ? null : parseRfc3339Nanos(s.displayed_at);
    if (displayedAt === undefined) return { displayedAt: null, items: [] };
    return { displayedAt, items: s.items.map((i) => ({ index: i.index, jobId: i.job_id, role: i.role, agentId: i.agent_id, toAgentId: i.to_agent_id, listLabel: i.list_label })) };
  } catch { return { displayedAt: null, items: [] }; }
}
const snapshotStruct = (s) => struct({
  displayed_at: s.displayedAt === null ? null : utcNanosSerde(s.displayedAt),
  items: s.items.map((i) => struct({ index: i.index, job_id: i.jobId, role: i.role, agent_id: i.agentId, to_agent_id: i.toAgentId ?? undefined, list_label: i.listLabel })),
});
const writeSnapshotAtomic = (s) => writeAtomic(snapshotPath(), stringify(snapshotStruct(s), true));

// upstream: pending_v2.rs::ensure_invariant_and_evict → evicted count
function ensureInvariantAndEvict(q) {
  const now = nowNanos();
  const ttl = loadGlobalTtlSecs();
  const pre = q.entries.length;
  const actives = q.entries.map((e, i) => [e, i]).filter(([e]) => e.status === 'active').map(([, i]) => i);
  if (actives.length > 1) {
    const sorted = [...actives].sort((a, b) => (q.entries[a].createdAt < q.entries[b].createdAt ? -1 : q.entries[a].createdAt > q.entries[b].createdAt ? 1 : 0));
    for (const i of sorted.slice(1)) q.entries[i].status = 'queued';
  }
  q.entries = q.entries.filter((e) => {
    let age = (now - e.createdAt) / NS;
    if (age < 0n) age = 0n;
    return age < ttl;
  });
  const evicted = pre - q.entries.length;
  q.entries.sort((a, b) => {
    const aa = a.status === 'active', bb = b.status === 'active';
    if (aa && !bb) return -1;
    if (!aa && bb) return 1;
    return b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0;
  });
  if (evicted > 0 && !q.entries.some((e) => e.status === 'active')) {
    const newest = maxByCreated(q.entries.filter((e) => e.status === 'queued'));
    if (newest) newest.status = 'active';
  }
  return evicted;
}
// Iterator::max_by_key (last maximum wins)
function maxByCreated(list) { let best; for (const e of list) if (best === undefined || e.createdAt >= best.createdAt) best = e; return best; }

// upstream: pending_v2.rs::has_pending_for_job (lock-free)
export function hasPendingForJob(jobId, role) {
  let q;
  try { q = readQueue(); } catch (e) { traceLog(`has_pending_for_job read_queue failed: ${e.message}; returning false`); return false; }
  return q.entries.some((e) => e.jobId === jobId && e.role === role);
}

// upstream: pending_v2.rs::cancel_all_for_job → removed count
export function cancelAllForJob(jobId) {
  return withLock(() => {
    const q = readQueue();
    ensureInvariantAndEvict(q);
    const before = q.entries.length;
    q.entries = q.entries.filter((e) => e.jobId !== jobId);
    const removed = before - q.entries.length;
    if (removed > 0) { writeSnapshotAtomic(buildSnapshot(q)); writeQueueAtomic(q); }
    return removed;
  });
}

// ─── request / request-prompt ───
// upstream: pending_v2.rs::sanitize_to_agent
function sanitizeToAgent(toAgentId, agentId) {
  if (toAgentId !== undefined && toAgentId !== null && toAgentId === agentId) {
    process.stderr.write(`[pending-v2] --to-agent-id ${toAgentId} equals --agent-id (self-addressed) — ignored; routing to the job's backup session instead\n`);
    return null;
  }
  return toAgentId ?? null;
}
async function trustedAutotradeTarget(jobId, agentId, sourceEvent, supplied) {
  const s = sanitizeToAgent(supplied, agentId);
  if (!sourceEvent.startsWith('autotrade_')) return s;
  let ctx;
  try { ctx = await loadPendingDeliveryContext(jobId); } catch { return null; }
  const p = ctx?.providerAgentId;
  return p && p !== agentId ? p : null;
}
async function trustedAutotradeSessionKey(jobId, sourceEvent) {
  if (!sourceEvent.startsWith('autotrade_')) return null;
  try { const k = (await loadPendingDeliveryContext(jobId))?.originSessionKey; return k ? k : null; } catch { return null; }
}
async function trustedAutotradeDeliveryId(jobId, sourceEvent) {
  if (!sourceEvent.startsWith('autotrade_')) return null;
  try { const d = (await loadPendingDeliveryContext(jobId))?.deliveryId; return d ? d : null; } catch { return null; }
}
// upstream: pending_v2.rs::send_decision_relay
async function sendDecisionRelay(jobId, sourceEvent, toAgentId, content) {
  const sessionKey = await trustedAutotradeSessionKey(jobId, sourceEvent);
  if (sessionKey) {
    const messageId = `autotrade-relay:${createHash('sha256').update(`${jobId}\0${sourceEvent}\0${content}`).digest('hex')}`;
    return sessionSendExact(sessionKey, content, messageId);
  }
  return sessionSend(jobId, toAgentId ?? undefined, content);
}
// upstream: pending_v2.rs::resolve_arbitration_choice → choice | null (throws ChoiceError)
function resolveArbitrationChoice(sourceEvent, jobId, choices, userReply) {
  if (!arbitration.isDecisionSource(sourceEvent)) return null;
  const cs = choices.length ? choices : arbitration.defaultChoices(sourceEvent, jobId);
  try { arbitration.validateChoices(cs, sourceEvent, jobId); } catch { throw new arbitration.ChoiceError('UnsupportedAction'); }
  return arbitration.resolveChoice(sourceEvent, cs, userReply);
}
const buyerReviewIdempotencyKey = (jobId, role, sourceEvent) => (role === 'user' && sourceEvent === 'job_submitted' ? `buyer-review:${jobId}:job_submitted` : null);
const out = (s) => process.stdout.write(s);
const printArbitrationBlocked = (reason, jobId, sourceEvent) => out(`${arbitration.blockedResult(reason, jobId, { sourceEvent })}\n`);
function printLocalArbitrationResolution(jobId, decisionId, selection) {
  out(`${stringify({
    phase: 'arbitration_decision', decision: 'ready', reason: 'user_choice_resolved',
    nextAction: [{ id: selection.actionId, recommend: true, params: selection.params }],
    payload: { jobId, decisionId: decisionId ?? null, selectedActionId: selection.actionId, params: selection.params, executionOwner: 'current_conversation' },
  })}\n`);
}

// upstream: pending_v2.rs::request_prompt_inner
async function requestPromptInner(jobId, role, agentId, toAgentIdIn, userContentIn, listLabelIn, llmContent, sourceEvent, metadata, templateVarsB64, printOk) {
  if (isRetiredModeConfigurationDecision(sourceEvent)) { if (printOk) out('OK\n'); return; }
  const toAgentId = sanitizeToAgent(toAgentIdIn, agentId);
  const userContentRaw = userContentIn.split('\\n').join('\n');
  let userContent, listLabel;
  try {
    const vars = templateVarsB64 !== undefined && templateVarsB64 !== null ? decodeAndValidate(templateVarsB64) : new Map();
    [userContent, listLabel] = renderAll([userContentRaw, listLabelIn], vars);
  } catch (e) {
    if (e instanceof TemplateVarError) throw new CodedError(e.code, 'template-vars-b64', e.message);
    throw e;
  }
  const cliMode = isCliMode();
  traceLog(`handle_request_prompt ${cliMode ? 'CLI_MODE' : 'QUEUE_MODE'}: job_id=${jobId} role=${role} agent_id=${agentId} to_agent_id=${debugOptStr(toAgentId)}`);
  const isBuyerReview = role === 'user' && sourceEvent === 'job_submitted';
  if (cliMode) {
    const lock = isBuyerReview ? await acquireLock() : null;
    try {
      if (isBuyerReview && hasReviewCardSentMarker(jobId)) {
        traceLog(`request_prompt CLI_MODE: buyer review already sent for job_id=${jobId}`);
        if (printOk) out('OK\n');
        return;
      }
      const now = nowNanos();
      const entry = { jobId, role, agentId, toAgentId, userContent, listLabel, llmContentOverride: llmContent ?? null, sourceEvent: sourceEvent ?? null,
        decisionId: metadata.decisionId, choices: metadata.choices, expiresAt: metadata.expiresAt, refundDisplay: metadata.refundDisplay, status: 'active', createdAt: now, updatedAt: now };
      const llm = resolveLlmContentCli(entry);
      await userDecisionRequest(entry.userContent, llm, isBuyerReview ? entry.jobId : null, buyerReviewIdempotencyKey(entry.jobId, entry.role, entry.sourceEvent));
      if (isBuyerReview) markReviewCardSent(entry.jobId);
      if (printOk) out('OK\n');
      return;
    } finally { lock?.release(); }
  }
  const now = nowNanos();
  const template = { jobId, role, agentId, toAgentId, userContent, listLabel, llmContentOverride: llmContent ?? null, sourceEvent: sourceEvent ?? null,
    decisionId: metadata.decisionId, choices: metadata.choices, expiresAt: metadata.expiresAt, refundDisplay: metadata.refundDisplay, status: 'queued', createdAt: now, updatedAt: now };
  await withLock(async () => {
    if (isBuyerReview && hasReviewCardSentMarker(jobId)) {
      traceLog(`request_prompt QUEUE_MODE: buyer review already sent for job_id=${jobId}`);
      if (printOk) out('OK\n');
      return;
    }
    const q = readQueue();
    const match = q.entries.find((e) => entryMatchesRequest(e, jobId, role, agentId, toAgentId, metadata.decisionId));
    const originalCreatedAt = match ? match.createdAt : now;
    q.entries = q.entries.filter((e) => !entryMatchesRequest(e, jobId, role, agentId, toAgentId, metadata.decisionId));
    q.entries.push({ ...template, createdAt: originalCreatedAt });
    writeQueueAtomic(q);
    const entry = q.entries[q.entries.length - 1];
    const llm = resolveLlmContentPromptUser(entry);
    await userDecisionRequest(entry.userContent, llm, isBuyerReview ? entry.jobId : null, buyerReviewIdempotencyKey(entry.jobId, entry.role, entry.sourceEvent));
    if (isBuyerReview) markReviewCardSent(entry.jobId);
    if (printOk) out('OK\n');
  });
}

// upstream: pending_v2.rs::push_decision_direct
export function pushDecisionDirect(jobId, role, agentId, toAgentId, userContent, listLabel, sourceEvent) {
  return requestPromptInner(jobId, role, agentId, toAgentId ?? null, userContent, listLabel, null, sourceEvent, emptyMetadata(), null, false);
}

function resolvedContent(o) {
  if (o.userContent !== undefined && o.userContent !== null) return o.userContent;
  if (o.userContentFile !== undefined && o.userContentFile !== null) {
    try { return readToString(o.userContentFile); } catch (e) { throw new Error(`failed to read --user-content-file ${o.userContentFile}: ${readErrorText(e)}`); }
  }
  throw new Error('either --user-content or --user-content-file is required');
}

// upstream: pending_v2.rs::run(Request)
export async function handleRequestCommand(o) {
  const content = resolvedContent(o);
  const metadata = decisionMetadata(o.jobId, o.sourceEvent, o.decisionId, o.choicesJson, o.expiresAt, undefined);
  return requestPromptInner(o.jobId, o.role, o.agentId, o.toAgentId, content, o.listLabel, o.llmContent, o.sourceEvent, metadata, null, true);
}
// upstream: pending_v2.rs::run(RequestPrompt)
export async function handleRequestPromptCommand(o) {
  const content = resolvedContent(o);
  const metadata = decisionMetadata(o.jobId, o.sourceEvent, o.decisionId, o.choicesJson, o.expiresAt, o.refundDisplayB64);
  return requestPromptInner(o.jobId, o.role, o.agentId, o.toAgentId, content, o.listLabel, o.llmContent, o.sourceEvent, metadata, o.templateVarsB64, true);
}

// ─── resolve variants ───
// upstream: pending_v2.rs::prepare_foreground_autotrade → undefined | { awaiting } | { relay }
async function prepareForegroundAutotrade(jobId, agentId, sourceEvent, candidateJson) {
  if (!isCandidateSource(sourceEvent)) {
    if (candidateJson !== undefined && candidateJson !== null) throw new Error('--autotrade-candidate-json is only valid for auto-trade consent decisions');
    return undefined;
  }
  if (candidateJson === undefined || candidateJson === null) return undefined;
  const r = await applyCandidateJson(jobId, agentId, sourceEvent, candidateJson);
  if (r.kind === 'Awaiting') {
    out(`${stringify(r.outcome)}\n`);
    out('The auto-trade draft was processed synchronously. A follow-up decision is already available; end this turn and wait for the user\'s reply.\n');
    return { awaiting: true };
  }
  if (r.kind === 'Relay') return { relay: true, normalizedReply: r.normalizedReply, outcome: r.outcome };
  return undefined;
}
function printForegroundPersistGuidance(outcome) {
  if (isObj(outcome) && outcome.authorizationPersisted === true) out('Authorization was written synchronously before delivery resume. Do not describe it as still processing.\n');
  else out('The skip decision was applied synchronously and no authorization was written. Do not describe it as still processing.\n');
}
function relayEnvelope(agentId, event, data, description, jobId, decisionId, selection, deliveryId, role) {
  return stringify({ agentId, message: { event, data, code: 0, description, source: 'system', jobId, decisionId: decisionId ?? null,
    selectedActionId: selection ? selection.actionId : null, params: selection ? selection.params : null, deliveryId: deliveryId ?? null, role, timestamp: nowSecs() } });
}
const validPrefixedDecisionId = (decisionId, jobId, sourceEvent) => {
  const prefix = `${jobId}:${sourceEvent}:`;
  return decisionId !== undefined && decisionId !== null && decisionId.startsWith(prefix) && Buffer.byteLength(decisionId) > Buffer.byteLength(prefix);
};

async function relayAfterResolve(o, mode, selection, relayDeliveryId, toAgentId) {
  const fg = await prepareForegroundAutotrade(o.jobId, o.agentId, o.sourceEvent, o.autotradeCandidateJson);
  if (fg?.awaiting) return;
  const userReply = fg?.relay ? fg.normalizedReply : o.userReply;
  const outcome = fg?.relay ? fg.outcome : undefined;
  const relaySource = outcome !== undefined ? CONSENT_SOURCE_EVENT : o.sourceEvent;
  const relayEvent = `user_decision_${relaySource}`;
  let description;
  if (arbitration.isDecisionSource(relaySource)) description = arbitrationRelayDescription(mode === 'cli' ? 'CLI mode' : 'queue-backed prompt mode', o.agentId);
  else {
    const dataContract = outcome !== undefined ? '<foreground-validated normalized A/B/C policy>' : '<message.data verbatim>';
    const delivery = relayDeliveryId ? `,"deliveryId":"${relayDeliveryId}"` : '';
    const call = `Call \`onchainos agent next-action --role ${o.role} --agentId ${o.agentId} --message '{"event":"${relayEvent}","jobId":"${o.jobId}","data":"${dataContract}"${delivery}}'\` to fetch the routing playbook; follow it. `;
    description = mode === 'cli'
      ? `User-decision relay envelope (CLI mode). ${call}❌ Do NOT call \`pending-decisions-v2 resolve\` / \`pick\` / \`cancel\` — those are user-session-only; the user-session already issued this relay envelope.`
      : `User-decision relay envelope (queue-backed prompt mode). ${call}❌ Do NOT call \`pending-decisions-v2 resolve\` / \`resolve-with-sessionkey\` / \`resolve-prompt\` / \`pick\` / \`cancel\` — those are user-session-only; the user-session already issued this relay envelope.`;
  }
  const content = relayEnvelope(o.agentId, relayEvent, userReply, description, o.jobId, o.decisionId, selection, relayDeliveryId, o.role);
  await sendDecisionRelay(o.jobId, o.sourceEvent, toAgentId, content);
  if (outcome !== undefined) {
    await clearCandidateDraft(o.jobId);
    await clearPendingSignal(o.jobId);
    const oc = isObj(outcome) ? { ...outcome, deliveryResumeQueued: true } : outcome;
    out(`${stringify(oc)}\n`);
    printForegroundPersistGuidance(oc);
  }
  out(decisionRelayPostAction());
}

// upstream: pending_v2.rs::handle_resolve_with_sessionkey
export async function handleResolveWithSessionkey(o) {
  traceLog(`handle_resolve_with_sessionkey: job_id=${o.jobId} role=${o.role} agent_id=${o.agentId} to_agent_id=${debugOptStr(o.toAgentId)} source_event=${o.sourceEvent} user_reply=${rustDebugStr(o.userReply)}`);
  const toAgentId = await trustedAutotradeTarget(o.jobId, o.agentId, o.sourceEvent, o.toAgentId);
  const relayDeliveryId = await trustedAutotradeDeliveryId(o.jobId, o.sourceEvent);
  recordFromUserText(o.jobId, o.userReply);
  let choices = [];
  if (arbitration.isDecisionSource(o.sourceEvent)) {
    if (!validPrefixedDecisionId(o.decisionId, o.jobId, o.sourceEvent) || o.choicesJson === undefined || o.choicesJson === null) {
      printArbitrationBlocked('decision_metadata_missing', o.jobId, o.sourceEvent); return;
    }
    if (o.expiresAt !== undefined && o.expiresAt !== null && BigInt(o.expiresAt) <= BigInt(nowSecs())) { printArbitrationBlocked('decision_expired', o.jobId, o.sourceEvent); return; }
    try { choices = arbitration.parseChoices(o.choicesJson, o.sourceEvent, o.jobId); } catch { printArbitrationBlocked('decision_metadata_missing', o.jobId, o.sourceEvent); return; }
  }
  let selection;
  try { selection = resolveArbitrationChoice(o.sourceEvent, o.jobId, choices, o.userReply); } catch (e) {
    if (e instanceof arbitration.ChoiceError) { printArbitrationBlocked(e.reasonCode(), o.jobId, o.sourceEvent); return; }
    throw e;
  }
  if (selection) {
    if (o.role !== 'asp') { printArbitrationBlocked('unsupported_action', o.jobId, o.sourceEvent); return; }
    printLocalArbitrationResolution(o.jobId, o.decisionId, selection);
    return;
  }
  await relayAfterResolve(o, 'cli', null, relayDeliveryId, toAgentId);
}

async function loadPromptEntry(jobId, role, agentId, toAgentId, decisionId) {
  let lock;
  try { lock = await acquireLock(); } catch { return undefined; }
  try { return readQueue().entries.find((e) => entryMatchesRequest(e, jobId, role, agentId, toAgentId, decisionId)); } catch { return undefined; } finally { lock.release(); }
}
async function removePromptEntry(jobId, role, agentId, toAgentId, decisionId) {
  let lock;
  try { lock = await acquireLock(); } catch (e) { traceLog(`handle_resolve_prompt: acquire_lock failed: ${e.message}`); return; }
  try {
    let q;
    try { q = readQueue(); } catch (e) { traceLog(`handle_resolve_prompt: read_queue failed: ${e.message}`); return; }
    const before = q.entries.length;
    q.entries = q.entries.filter((e) => !entryMatchesRequest(e, jobId, role, agentId, toAgentId, decisionId));
    if (q.entries.length !== before) { try { writeQueueAtomic(q); } catch (e) { traceLog(`handle_resolve_prompt: write_queue_atomic failed: ${e.message}`); } }
  } finally { lock.release(); }
}

// upstream: pending_v2.rs::handle_resolve_prompt
export async function handleResolvePrompt(o) {
  traceLog(`handle_resolve_prompt: job_id=${o.jobId} role=${o.role} agent_id=${o.agentId} to_agent_id=${debugOptStr(o.toAgentId)} source_event=${o.sourceEvent} user_reply=${rustDebugStr(o.userReply)}`);
  const toAgentId = await trustedAutotradeTarget(o.jobId, o.agentId, o.sourceEvent, o.toAgentId);
  const relayDeliveryId = await trustedAutotradeDeliveryId(o.jobId, o.sourceEvent);
  recordFromUserText(o.jobId, o.userReply);
  const isDecision = arbitration.isDecisionSource(o.sourceEvent);
  if (isDecision && !validPrefixedDecisionId(o.decisionId, o.jobId, o.sourceEvent)) { printArbitrationBlocked('decision_metadata_missing', o.jobId, o.sourceEvent); return; }
  const stored = await loadPromptEntry(o.jobId, o.role, o.agentId, toAgentId, o.decisionId);
  if (isDecision && !stored) { printArbitrationBlocked('decision_metadata_missing', o.jobId, o.sourceEvent); return; }
  if (stored && stored.expiresAt !== null && BigInt(stored.expiresAt) <= BigInt(nowSecs())) {
    await removePromptEntry(o.jobId, o.role, o.agentId, toAgentId, o.decisionId);
    printArbitrationBlocked('decision_expired', o.jobId, o.sourceEvent); return;
  }
  if (isDecision && stored && (stored.decisionId === null || !stored.choices.length)) {
    await removePromptEntry(o.jobId, o.role, o.agentId, toAgentId, o.decisionId);
    printArbitrationBlocked('decision_metadata_missing', o.jobId, o.sourceEvent); return;
  }
  let selection;
  try { selection = resolveArbitrationChoice(o.sourceEvent, o.jobId, stored ? stored.choices : [], o.userReply); } catch (e) {
    if (e instanceof arbitration.ChoiceError) { printArbitrationBlocked(e.reasonCode(), o.jobId, o.sourceEvent); return; }
    throw e;
  }
  await removePromptEntry(o.jobId, o.role, o.agentId, toAgentId, o.decisionId);
  if (selection) {
    if (o.role !== 'asp') { printArbitrationBlocked('unsupported_action', o.jobId, o.sourceEvent); return; }
    printLocalArbitrationResolution(o.jobId, o.decisionId, selection);
    return;
  }
  await relayAfterResolve(o, 'queue', null, relayDeliveryId, toAgentId);
}

// upstream: pending_v2.rs::handle_resolve
export async function handleResolve(userReply) {
  return withLock(async () => {
    const q = readQueue();
    ensureInvariantAndEvict(q);
    const activeIdx = q.entries.findIndex((e) => e.status === 'active');
    if (activeIdx < 0) {
      if (q.entries.some((e) => e.status === 'queued')) {
        const snap = buildSnapshot(q);
        writeSnapshotAtomic(snap);
        out(playbookStaleRelist(snap, 'queue is in selection mode — please pick a number first, then re-send your decision'));
      } else out(playbookErrorNoActive());
      return;
    }
    const active = { ...q.entries[activeIdx] };
    const src = active.sourceEvent ?? '';
    if (arbitration.isDecisionSource(src) && (active.decisionId === null || !active.choices.length)) {
      q.entries.splice(activeIdx, 1);
      ensureInvariantAndEvict(q);
      writeQueueAtomic(q);
      printArbitrationBlocked('decision_metadata_missing', active.jobId, src); return;
    }
    if (active.expiresAt !== null && BigInt(active.expiresAt) <= BigInt(nowSecs())) {
      q.entries.splice(activeIdx, 1);
      ensureInvariantAndEvict(q);
      writeQueueAtomic(q);
      printArbitrationBlocked('decision_expired', active.jobId, src); return;
    }
    let selection;
    try { selection = resolveArbitrationChoice(src, active.jobId, active.choices, userReply); } catch (e) {
      if (e instanceof arbitration.ChoiceError) { writeQueueAtomic(q); printArbitrationBlocked(e.reasonCode(), active.jobId, src); return; }
      throw e;
    }
    q.entries.splice(activeIdx, 1);
    const relayDeliveryId = await trustedAutotradeDeliveryId(active.jobId, src);
    const clearAfter = src.startsWith('autotrade_');
    recordFromUserText(active.jobId, userReply);
    const relayEvent = active.sourceEvent !== null ? `user_decision_${active.sourceEvent}` : 'user_decision';
    let description;
    if (arbitration.isDecisionSource(src)) description = arbitrationRelayDescription('sub session', active.agentId);
    else {
      const delivery = relayDeliveryId ? `,"deliveryId":"${relayDeliveryId}"` : '';
      description = `User-decision relay envelope (sub session). Call \`onchainos agent next-action --role ${active.role} --agentId ${active.agentId} --message '{"event":"${relayEvent}","jobId":"${active.jobId}","data":"<message.data verbatim>"${delivery}}'\` to fetch the routing playbook; follow it. ❌ Do NOT call \`pending-decisions-v2 resolve\` / \`pick\` / \`cancel\` — those are user-session-only; the user-session already called \`resolve\` to produce this envelope. The sub session has no queue file; calling resolve here = wasted turn + flow stall.`;
    }
    const content = relayEnvelope(active.agentId, relayEvent, userReply, description, active.jobId, active.decisionId, selection, relayDeliveryId, active.role);
    const queued = q.entries.filter((e) => e.status === 'queued');
    if (!queued.length) {
      await sendDecisionRelay(active.jobId, src, active.toAgentId, content);
      if (clearAfter) await clearPendingSignal(active.jobId);
      writeQueueAtomic(q);
      out('🛑 User reply relayed and consumed — do NOT reuse it for future cards; wait for a fresh user message, then end the turn.\n');
    } else {
      const promote = queued[0];
      const idx = q.entries.findIndex((e) => entryMatches(e, promote.jobId, promote.role, promote.agentId, promote.toAgentId));
      q.entries[idx].status = 'active';
      ensureInvariantAndEvict(q);
      await sendDecisionRelay(active.jobId, src, active.toAgentId, content);
      if (clearAfter) await clearPendingSignal(active.jobId);
      writeSnapshotAtomic(buildSnapshot(q));
      writeQueueAtomic(q);
      out(playbookAdvanceOnly(q));
    }
  });
}

// ─── pick / cancel / list ───
// upstream: pending_v2.rs::handle_pick
export async function handlePick(index, jobIdRaw) {
  return withLock(async () => {
    const q = readQueue();
    ensureInvariantAndEvict(q);
    const snapshot = readSnapshot();
    let target;
    if (index !== undefined && index !== null) {
      const i = Number(index);
      if (i === 0 || i > snapshot.items.length) {
        const s = buildSnapshot(q); writeSnapshotAtomic(s); out(playbookStaleRelist(s, 'selection index out of range')); return;
      }
      target = snapshot.items[i - 1];
    } else if (jobIdRaw !== undefined && jobIdRaw !== null && trim(jobIdRaw) !== '') {
      const jobId = trim(jobIdRaw);
      const matches = snapshot.items.filter((it) => it.jobId === jobId);
      if (matches.length !== 1) {
        const s = buildSnapshot(q); writeSnapshotAtomic(s);
        out(playbookStaleRelist(s, matches.length === 0 ? 'selection Job ID was not in the displayed list' : 'selection Job ID is ambiguous in the displayed list'));
        return;
      }
      target = matches[0];
    } else throw new Error('either --index or --job-id is required');
    const idx = q.entries.findIndex((e) => entryMatches(e, target.jobId, target.role, target.agentId, target.toAgentId));
    if (idx < 0) {
      const s = buildSnapshot(q); writeSnapshotAtomic(s); out(playbookStaleRelist(s, 'selected entry no longer exists (auto-cleaned or resolved)')); return;
    }
    if (snapshot.displayedAt !== null && q.entries[idx].updatedAt > snapshot.displayedAt) {
      const s = buildSnapshot(q); writeSnapshotAtomic(s); out(playbookStaleRelist(s, "selected entry's content was updated since display")); return;
    }
    out(playbookRender(q.entries[idx]));
  });
}

// upstream: pending_v2.rs::handle_cancel
export async function handleCancel(index) {
  return withLock(async () => {
    const q = readQueue();
    ensureInvariantAndEvict(q);
    const snapshot = readSnapshot();
    const i = Number(index);
    if (i === 0 || i > snapshot.items.length) { const s = buildSnapshot(q); writeSnapshotAtomic(s); out(playbookStaleRelist(s, 'cancel index out of range')); return; }
    const target = snapshot.items[i - 1];
    const idx = q.entries.findIndex((e) => entryMatches(e, target.jobId, target.role, target.agentId, target.toAgentId));
    if (idx < 0) {
      out(playbookError(`no pending decision found for index ${index} (jobId=${target.jobId} role=${target.role} agentId=${target.agentId} toAgentId=${debugOptStr(target.toAgentId)})`));
      return;
    }
    const [removed] = q.entries.splice(idx, 1);
    const wasActive = removed.status === 'active';
    if (wasActive && q.entries.length) {
      const newest = maxByCreated(q.entries.filter((e) => e.status === 'queued'));
      if (newest) {
        const p = q.entries.findIndex((e) => entryMatches(e, newest.jobId, newest.role, newest.agentId, newest.toAgentId));
        if (p >= 0) { q.entries[p].status = 'active'; ensureInvariantAndEvict(q); }
      }
    }
    const snap = buildSnapshot(q);
    writeSnapshotAtomic(snap);
    writeQueueAtomic(q);
    out(playbookCancel(removed, wasActive, q, snap));
  });
}

function refundQueue(q) {
  const now = BigInt(nowSecs());
  let entries = q.entries.filter((e) => e.role === 'asp' && e.sourceEvent !== null && arbitration.isDecisionSource(e.sourceEvent)
    && (e.expiresAt === null || BigInt(e.expiresAt) > now));
  if (entries.some((e) => e.refundDisplay === null)) throw new Error('pending refund decision metadata is incomplete; refresh the affected rejection event');
  entries = entries.filter((e) => BigInt(e.refundDisplay.responseDeadline) > now);
  entries.sort((a, b) => { const x = BigInt(a.refundDisplay.responseDeadline), y = BigInt(b.refundDisplay.responseDeadline); return x < y ? -1 : x > y ? 1 : 0; });
  return { entries };
}
function refundListJson(q) {
  return { pendingCount: q.entries.length, items: q.entries.map((e, i) => (e.refundDisplay ? {
    index: i + 1, serviceName: e.refundDisplay.serviceName, jobId: e.jobId, taskType: e.refundDisplay.taskType, refundAmount: e.refundDisplay.refundAmountLabel(),
    amount: e.refundDisplay.amount, tokenSymbol: e.refundDisplay.tokenSymbol, responseDeadline: e.refundDisplay.responseDeadline,
    responseDeadlineLabel: e.refundDisplay.responseDeadlineLabel() ?? null,
  } : undefined)).filter((x) => x !== undefined) };
}
function renderRefundListMarkdown(q) {
  let s = `You have ${q.entries.length} refund requests awaiting a decision:\n\n| # | Service name | Job ID | Task Type | Refund Amount | Response Deadline |\n|---|---|---|---|---|---|\n`;
  q.entries.forEach((e, i) => {
    const m = e.refundDisplay;
    if (!m) return;
    s += `| ${i + 1} | ${m.serviceName} | ${e.jobId} | ${m.taskType} | ${m.refundAmountLabel()} | ${m.responseDeadlineLabel() ?? '—'} |\n`;
  });
  if (q.entries.length) s += '\nReply with the number or Job ID to view and process a request.\n';
  return s;
}

// upstream: pending_v2.rs::handle_list (format: markdown|json, scope: all|refund)
export async function handleList(format, scope) {
  return withLock(async () => {
    const q = readQueue();
    const evicted = ensureInvariantAndEvict(q);
    const display = scope === 'refund' ? refundQueue(q) : { entries: [...q.entries] };
    writeSnapshotAtomic(buildSnapshot(display));
    writeQueueAtomic(q);
    if (scope === 'refund') {
      if (format === 'json') out(`${stringify(refundListJson(display), true)}\n`);
      else out(renderRefundListMarkdown(display));
      return;
    }
    if (format === 'json') {
      out(`${stringify({ evicted_since_last_call: evicted, entries: display.entries.map((e, i) => ({
        index: i + 1, job_id: e.jobId, role: e.role, agent_id: e.agentId, to_agent_id: e.toAgentId ?? null, list_label: e.listLabel, status: e.status,
        created_at: utcNanosRfc3339(e.createdAt), updated_at: utcNanosRfc3339(e.updatedAt),
      })) }, true)}\n`);
      return;
    }
    if (evicted > 0) out(`ℹ️ Since last check, ${evicted} decision(s) older than ${loadGlobalTtlSecs() / 86400n} days were auto-cleaned.\n\n`);
    if (!display.entries.length) out('(no pending decisions)\n\nRender the line above to the user as your assistant response.\n');
    else out(`3 steps (Steps 1-2 in this turn, Step 3 in the future turn):\n\n**Step 1** — Translate the [Source content] below to the user's language per [Translation rules].\n\n**Step 2** — Render Step 1's output to the user as your assistant response.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n${renderListMarkdown(display)}`);
  });
}

// ─── rendering ───
// upstream: pending_v2.rs::short_job_id (byte-based, "...")
function shortJobId(jobId) {
  const b = Buffer.from(jobId, 'utf8');
  if (b.length <= 12) return jobId;
  return `${b.subarray(0, 6).toString('utf8')}...${b.subarray(b.length - 4).toString('utf8')}`;
}
// upstream: pending_v2.rs::strip_label_prefix
function stripLabelPrefix(label) {
  if (label.startsWith('[')) { const end = label.indexOf(']'); if (end >= 0) return trimStart(label.slice(end + 1)); }   // str::trim_start (no U+FEFF)
  return label;
}
function renderListMarkdown(q) {
  const n = q.entries.length;
  const activeIdx = q.entries.findIndex((e) => e.status === 'active');
  let body = '';
  if (activeIdx >= 0) {
    const a = q.entries[activeIdx];
    body += `🟢 Decision 1 — ${stripLabelPrefix(a.listLabel)} (Job ${shortJobId(a.jobId)})\n\n${a.userContent}\n\n`;
    const remaining = q.entries.filter((_, i) => i !== activeIdx);
    if (remaining.length) {
      body += '─────────────────\n';
      body += `Remaining (${remaining.length}):\n`;
      remaining.forEach((e, j) => { body += `${j + 1}. ${stripLabelPrefix(e.listLabel)} (Job ${shortJobId(e.jobId)})\n`; });
      body += '\nReply per the options shown in the active card to handle this decision; reply "switch N" to jump to remaining item N; reply "later" to defer.\n';
    } else body += 'Reply per the options shown in the active card to handle this decision; reply "later" to defer.\n';
  } else {
    body += 'Please pick one to activate:\n\n';
    q.entries.forEach((e, i) => { body += `${i + 1}. ${stripLabelPrefix(e.listLabel)} (Job ${shortJobId(e.jobId)})\n`; });
    body += `\nReply with a number 1-${n} to activate that decision, or "later" to defer.\n`;
  }
  let s = `[Source content to render to user]:\n\n${body}\n`;
  s += '[Translation rules] — **translate every English word to the user\'s language**, including quoted user-facing keywords. Only these are kept verbatim:\n  - Hex jobIds (`0x...`).\n  - Sub-provided `<title>` fields (already in user\'s language).\n  - Structural delimiters (`🟢`, `─────────────────`, numbered list markers).\nEverything else — `Decision`, the `<type>` token (`acceptance` / `dispute` / `submit` / `ASP-pick` / `ASP-contact` / `next-step` / `price` / `budget` / `error`), `decision`, all surrounding prose, AND quoted user-facing keywords like `"switch N"` / `"later"` — gets translated. Footer: preserve every `;`-separated clause (do NOT drop or merge). No mixed-language content.\n\n';
  s += '[Future-turn user-reply routing] (when the user replies, match semantics — localized equivalents count):\n';
  if (activeIdx >= 0) {
    const m = q.entries.length - 1;
    s += '  - Reply matches the active card\'s option set (`A` / `B` / `A`/`B`/`C` / numeric `1`/`2`/`3` / free-form like `retry` / `dismiss` / `重试` / `同意` / `拒绝` / `通过` / `第一个` / etc.) → `onchainos agent pending-decisions-v2 resolve --user-reply "<user\'s verbatim wording>"`\n    ⚠️ Disambiguation: if the active card uses numeric options (e.g. "1. Alpha / 2. Beta"), a bare `1` / `2` is the active answer → use `resolve`, NOT `pick`. `pick` requires explicit `switch` / `切换` / `跳到` keyword.\n';
    if (m > 0) s += `  - \`switch N\` / \`切换 N\` / \`跳到 N\` / \`go to N\` / \`change to N\` (1 ≤ N ≤ ${m}) → \`onchainos agent pending-decisions-v2 pick --index (N+1)\` (e.g. \`switch 2\` → \`--index 3\`).\n`;
    s += '  - `later` / `稍后` / `defer` → end the turn.\n  - User asks to see the list again → `onchainos agent pending-decisions-v2 list --format markdown`.\n  - Else → ordinary chat; do NOT call `pick` / `resolve` / `cancel`.\n';
  } else {
    s += `  - A number K (1 ≤ K ≤ ${n}) / \`第 K 个\` / \`选 K\` / \`the Kth\` → \`onchainos agent pending-decisions-v2 pick --index K\`.\n  - \`later\` / \`稍后\` / \`defer\` → end the turn.\n  - User asks to see the list again → \`onchainos agent pending-decisions-v2 list --format markdown\`.\n  - Else → ordinary chat. No active entry to resolve.\n`;
  }
  return s;
}
function buildSnapshot(q) {
  return { displayedAt: nowNanos(), items: q.entries.map((e, i) => ({ index: i + 1, jobId: e.jobId, role: e.role, agentId: e.agentId, toAgentId: e.toAgentId, listLabel: e.listLabel })) };
}

// upstream: pending_v2.rs::request_command_block
export function requestCommandBlock(jobId, role, agentId, toAgentId, userContent, listLabelFull, sourceEvent) {
  const escaped = String(userContent).split('\\').join('\\\\').split('"').join('\\"');
  const toFlag = toAgentId !== undefined && toAgentId !== null ? ` --to-agent-id "${toAgentId}"` : '';
  return `**Localize first** — translate the \`--user-content\` and \`--list-label\` values below to the user's language before running. Keep the bash structure / flags / source-event token unchanged.\n\n\`\`\`bash\nonchainos agent pending-decisions-v2 request \\\n  --job-id ${jobId} --role ${role} --agent-id ${agentId}${toFlag} \\\n  --user-content "${escaped}" \\\n  --list-label "${listLabelFull}" \\\n  --source-event ${sourceEvent}\n\`\`\``;
}

// upstream: pending_v2.rs::encode_title_vars
export const encodeTitleVars = (copyTitle, labelTitle) => Buffer.from(stringify({ __OKX_TASK_TITLE__: copyTitle, __OKX_TASK_LABEL_TITLE__: labelTitle }), 'utf8').toString('base64');

// upstream: pending_v2.rs::encode_refund_decision_vars
export function encodeRefundDecisionVars(serviceName, jobId, taskType, currentPeriod, requestedRefund, buyerReason, responseDeadline) {
  const obj = { __OKX_REFUND_SERVICE_NAME__: serviceName, __OKX_REFUND_JOB_ID__: jobId, __OKX_REFUND_TASK_TYPE__: taskType, __OKX_REFUND_AMOUNT__: requestedRefund,
    __OKX_REFUND_BUYER_REASON__: buyerReason, __OKX_REFUND_RESPONSE_DEADLINE__: responseDeadline };
  if (currentPeriod !== undefined && currentPeriod !== null) obj.__OKX_REFUND_CURRENT_PERIOD__ = currentPeriod;
  return Buffer.from(stringify(obj), 'utf8').toString('base64');
}

// upstream: pending_v2.rs::role_short_label
export const roleShortLabel = (role) => ({ user: 'User', asp: 'ASP', evaluator: 'Evaluator' })[role] ?? role;

// candidate guidance / flag are empty in 4.6.3 (candidate sources == retired sources).
const candidateGuidance = (src) => (isRetiredModeConfigurationDecision(src) || !isCandidateSource(src) ? '' : '');
const candidateFlag = (src) => (isRetiredModeConfigurationDecision(src) || !isCandidateSource(src) ? '' : " --autotrade-candidate-json '<strict candidate JSON>'");

function buyerReviewLlmContentCli(e) {
  const src = e.sourceEvent;
  if (src === null || e.role !== 'user' || !(src === 'job_submitted' || src === 'review_deadline_warn')) return undefined;
  const toHeader = e.toAgentId !== null ? `[to: ${e.toAgentId}]` : '[to: backup]';
  const job = e.jobId, role = e.role, agent = e.agentId;
  return `[USER_DECISION_REQUEST][job: ${job}][role: ${role}][agent: ${agent}]${toHeader}\n\n`
    + 'Step 1 — Card was just delivered. **END THE TURN NOW** and wait for the user\'s next message.\n'
    + 'Step 2 — Handle that reply in this current conversation. Enter through `skills/okx-ai/SKILL.md`, then apply `skills/okx-ai/references/runtime/watch.md` §Handling the user reply: cancel the wake when applicable, and for a non-defer reply claim the decision with `okx-a2a user check --todo-ids <todo_id> --json`. Continue on `handled`.\n'
    + 'Step 3 — Interpret the choice and complete the selected review action here:\n'
    + `- A or an unambiguous approval: run \`onchainos agent next-action --role user --agentId ${agent} --message '{"event":"approve_review","jobId":"${job}"}'\`. For \`reason=completion_submitted\`, give one localized friendly confirmation equivalent to: "Deliverable approved. The on-chain completion transaction has been submitted." For any other result, present its returned status and actions.\n`
    + `- B or an unambiguous rejection: preserve any rejection wording from the reply in \`message.data\`, then run \`onchainos agent next-action --role user --agentId ${agent} --message '{"event":"reject_review","jobId":"${job}","data":"<verbatim rejection reason when present>"}'\`. If a submitted zero-price one-time task has no reason, the result is \`request_rejection_reason\`: create the returned durable rejection-reason decision and wait; do not call any reject endpoint yet. After a non-blank reason is supplied, the existing \`/pre-reject\` + \`/reject\` lifecycle runs and the task becomes Failed; for \`reason=free_rejection_submitted\`, confirm that the rejection transaction was submitted. For every other eligible task, follow the returned Refund V2 compatibility guidance: run its read-only \`refund-prepare\` command, render the complete Template 6.1 Confirm Refund Request from \`payload.display\` as a single-record \`- Label: value\` field list, and ask for \`Submit refund request\` plus a reason. For paid tasks, B opens the confirmation only; B never counts as submission intent for a refund and never arms a reason-only continuation.\n`
    + '- After the card, analyze the reply for both the submission intent and a refund reason. If it contains clear `Submit refund request` intent and a non-blank reason, preserve the reason verbatim and continue immediately. If the intent is clear but the reason is missing, ask only for the refund reason and keep the Job ID, latest Refund V2 context, and explicit submission intent active. Only during that explicitly armed follow-up may the next non-blank reply be treated as the verbatim reason. A reason without current submission intent must be previewed by rerunning `refund-prepare` with that reason and re-rendering Template 6.1; it does not authorize a write.\n'
    + `- After both submission intent and the reason are present: run \`onchainos agent refund-prepare ${job} --reason "<verbatim reason>"\`. Continue only when it returns \`payload.schemaVersion=2\`, \`phase=refund_confirmation\`, \`decision=ready\`, \`reason=refund_request_confirmation_required\`, and \`nextAction[id=submit_refund_request]\`; immediately run \`onchainos agent refund-execute <params.jobId> --operation <params.operation> --refund-context-id <params.refundContextId> --reason "<params.reason verbatim>" --confirm\` with every parameter copied from that fresh action. For \`reason=refund_request_broadcast_submitted\`, give one concise localized confirmation that the request was submitted and progress will update in this task. For any other result, present its returned status and actions.\n`
    + '- Ambiguous or unrelated text: show the same A/B choice and wait.\n\n'
    + 'The current conversation owns choice parsing, action execution, and result feedback. For `refund_request_broadcast_submitted`, end the turn after the pending confirmation and friendly later-query guidance without displaying a CLI command; do not resume the originating watch. The User may later ask to view the task details for the refund result. Other decisions resume the exact originating watch only when the watch-core rules require it.';
}

function aspArbitrationLlmContent(e, queueMode) {
  const src = e.sourceEvent;
  if (src === null || e.role !== 'asp' || !arbitration.isDecisionSource(src)) return undefined;
  const decisionFlag = e.decisionId !== null ? ` --decision-id "${e.decisionId}"` : '';
  let resolver;
  if (queueMode) resolver = `onchainos agent pending-decisions-v2 resolve-prompt --user-reply "<user's verbatim wording>" --job-id "${e.jobId}" --role "${e.role}" --agent-id "${e.agentId}" --source-event "${src}"${decisionFlag}`;
  else {
    const choices = arbitration.choicesJson(e.choices);
    const expires = e.expiresAt !== null ? ` --expires-at ${e.expiresAt}` : '';
    resolver = `onchainos agent pending-decisions-v2 resolve-with-sessionkey --user-reply "<user's verbatim wording>" --job-id "${e.jobId}" --role "${e.role}" --agent-id "${e.agentId}" --source-event "${src}"${decisionFlag} --choices-json '${choices.split("'").join('\'"\'"\'')}'${expires}`;
  }
  const agent = e.agentId;
  return `[USER_DECISION_REQUEST][job: ${e.jobId}][role: ${e.role}][agent: ${agent}]\n\n`
    + 'Step 1 — The card was just delivered. End this turn and wait for the user\'s next message.\n'
    + 'Step 2 — Handle the next reply in this current conversation. Enter through `skills/okx-ai/SKILL.md`, then apply `skills/okx-ai/references/runtime/watch.md` §Handling the user reply: cancel the wake when applicable, and claim a non-defer reply with `okx-a2a user check --todo-ids <todo_id> --json`. Continue on `handled`.\n'
    + 'Step 3 — Analyze the reply for both the decision intent and any evaluation reason. Resolve `Approve refund`, or `Request evaluation` with a non-blank reason, by running this pre-filled command once:\n'
    + `\`${resolver}\`\n`
    + 'The resolver preserves the card\'s `decisionId`, choices, deadline, and job binding. When a reply contains the `Request evaluation` intent and a non-blank reason, preserve that reason verbatim and pass the canonical `--user-reply "Request evaluation: <verbatim reason>"`. If the intent is clear but the reason is missing, show the complete Seller Refund Rejection field-list card, then ask for the evaluation reason and keep this card context and explicit evaluation intent active. Only during that explicitly armed follow-up may the next non-blank reply be treated as the reason, preserved verbatim, and resolved once with the same canonical form. A reason without current `Request evaluation` intent does not authorize Evaluation: show the same complete Template 6.4 field-list card and wait. For `ambiguous_choice`, show the same card.\n\n'
    + 'Step 4 — For `phase=arbitration_decision`, `decision=ready`, and `reason=user_choice_resolved`, execute the sole returned action directly in this current conversation.\n'
    + `- \`agree_refund\`: run \`onchainos agent agree-refund <params.jobId> --agent-id ${agent}\` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query.\n`
    + `- \`raise_arbitration\`: run \`onchainos agent dispute raise <params.jobId> --reason "<params.reason verbatim>" --agent-id ${agent}\` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query. The later \`job_disputed\` event starts automatic evidence submission in the task session.\n`
    + `- \`sub_agree_refund\`: run \`onchainos agent subscribe-agree-refund <params.jobId> --agent-id ${agent}\` in this current conversation, then give one concise localized result with the outcome and relevant returned fields.\n`
    + `- \`raise_subscription_arbitration\`: run \`onchainos agent subscribe-dispute <params.jobId> --reason "<params.reason verbatim>" --agent-id ${agent}\` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query.\n\n`
    + 'The current conversation owns choice resolution, freshness validation, returned action execution, concise result feedback, and resuming the exact originating watch when one exists.';
}

// upstream: pending_v2.rs::resolve_llm_content_cli
function resolveLlmContentCli(e) {
  const buyer = buyerReviewLlmContentCli(e);
  if (buyer !== undefined) return buyer;
  const asp = aspArbitrationLlmContent(e, false);
  if (asp !== undefined) return asp;
  if (e.llmContentOverride !== null) return e.llmContentOverride;
  const src = e.sourceEvent ?? '';
  const toFlag = e.toAgentId !== null ? ` --to-agent-id "${e.toAgentId}"` : '';
  const toHeader = e.toAgentId !== null ? `[to: ${e.toAgentId}]` : '[to: backup]';
  const decisionFlag = e.decisionId !== null ? ` --decision-id "${e.decisionId}"` : '';
  const arbFlags = arbitration.isDecisionSource(src)
    ? ` --choices-json '${arbitration.choicesJson(e.choices).split("'").join('\'"\'"\'')}'${e.expiresAt !== null ? ` --expires-at ${e.expiresAt}` : ''}` : '';
  return `[USER_DECISION_REQUEST][job: ${e.jobId}][role: ${e.role}][agent: ${e.agentId}]${toHeader}\n\n`
    + 'Step 1 — Card was just delivered. **END THE TURN NOW** and wait for the user to reply. Do NOT call any tool. Stale user messages in context are NOT replies to this card.\n'
    + `Step 2 — When the user actually replies (next turn):${candidateGuidance(src)}\n`
    + `    - defer keyword (${DEFER_KEYWORDS.join(' / ')}) or any defer value defined in runtime/watch.md → do NOT claim or resolve; if this card came from a currently active watch, re-enter that exact originating watch command, otherwise END TURN\n`
    + `    - else → enter through \`skills/okx-ai/SKILL.md\`, then follow \`skills/okx-ai/references/runtime/watch.md\` §kind == decision_request "Handling the user reply": **first claim the todo** per Runtime Watch step 2: \`okx-a2a user check --todo-ids <todo_id> --json\` (read \`<todo_id>\` from this item's \`id\` field in the original watch / outdated-list JSON output). **Then** on \`handled\` run \`onchainos agent pending-decisions-v2 resolve-with-sessionkey --user-reply "<user's verbatim wording — no interpretation, no translation>" --job-id "${e.jobId}" --role "${e.role}" --agent-id "${e.agentId}"${toFlag} --source-event "${src}"${decisionFlag}${arbFlags}${candidateFlag(src)}\` exactly once, then follow the relay playbook it returns. Only a card surfaced by a currently active watch resumes that exact originating watch; an independently opened card never starts watch. Never infer watch origin from A/B/C, an amount, a cap, or any other reply text. Skipping the \`check\` leaves a ghost todo in the outstanding-decisions queue.`;
}

// upstream: pending_v2.rs::resolve_llm_content_prompt_user
function resolveLlmContentPromptUser(e) {
  const asp = aspArbitrationLlmContent(e, true);
  if (asp !== undefined) return asp;
  if (e.llmContentOverride !== null) return e.llmContentOverride;
  const src = e.sourceEvent ?? '';
  const toFlag = e.toAgentId !== null ? ` --to-agent-id "${e.toAgentId}"` : '';
  const toHeader = e.toAgentId !== null ? `[to: ${e.toAgentId}]` : '[to: backup]';
  const decisionFlag = e.decisionId !== null ? ` --decision-id "${e.decisionId}"` : '';
  return `[USER_DECISION_REQUEST]\n[job: ${e.jobId}][role: ${e.role}][agent: ${e.agentId}]${toHeader}\n(Anything above this marker is stale — NOT a reply to this card.)\n\n`
    + 'Step 1 — Card was already delivered to the user. You MUST NOT re-render it, paraphrase it, summarize it, translate it again, or compose your own "please choose A/B/..." prompt — the user already has the exact text. Stale user messages in context are NOT replies to this card.\n'
    + 'Step 2 — Scan your current context for OTHER [USER_DECISION_REQUEST] blocks. If you find any, render the warning below to the user as your assistant response (in user\'s language), e.g.:\n'
    + '  `⚠️ You have multiple decisions pending — please prefix your reply with the jobId short hash, e.g. \\`0x7091: approve\\`, so it routes correctly.`\n'
    + 'If no other blocks → skip this step.\n\n'
    + 'Step 3 — **END THE TURN NOW with NO assistant text output** (unless Step 2 fired its multi-card warning, which is the ONLY allowed text this turn). No confirmation, no recap, no fabricated option list. Just stop. Wait for the user to reply in a future turn.\n\n'
    + '🛑 **The block below runs ONLY in a future turn**, AFTER the user has actually replied. Do NOT run anything in the current turn.\n'
    + `On the user's next reply, re-scan your context for [USER_DECISION_REQUEST] blocks (the count may have changed since Step 2), then walk this decision tree:${candidateGuidance(src)}\n`
    + `  - defer keyword (${DEFER_KEYWORDS.join(' / ')}) or any defer value defined in runtime/watch.md → do NOT claim or resolve; if this card came from a currently active watch, re-enter that exact originating watch command, otherwise END TURN.\n`
    + '  · Reply starts with `0x...:` prefix → strip the prefix + colon, use the prefix to match each block\'s `[job: 0x...]` header, locate THAT block, then run THAT block\'s command template with `--user-reply` set to the stripped wording (without the prefix).\n'
    + '  · No prefix + only THIS block in context (single) → run THIS block\'s command template with the full reply.\n'
    + '  · 🔁 No prefix + **multiple** [USER_DECISION_REQUEST] blocks in context → user forgot to add the jobId prefix. Ask them which jobId they\'re answering (number the candidates `1. Job 0x...`, `2. Job 0x...`, one per line — short_jobId only), **END THE TURN**, wait for the pick (hex prefix `0x7091` or list number `1`); locate THAT block via `[job: 0x...]` header (or list order), then run THAT block\'s command template. Never guess, never collapse.\n\n'
    + '**Command template** (pre-filled for THIS block; only run AFTER the user has replied):\n'
    + `  \`onchainos agent pending-decisions-v2 resolve-prompt --user-reply "<user wording, without any jobId prefix>" --job-id "${e.jobId}" --role "${e.role}" --agent-id "${e.agentId}"${toFlag} --source-event "${src}"${decisionFlag}${candidateFlag(src)}\`\n\n`
    + 'After running, follow the relay playbook the command returns.';
}

// upstream: pending_v2.rs::playbook_advance_only
function playbookAdvanceOnly(q) {
  return '✓ Previous decision already relayed in-process — the user\'s reply is consumed; do NOT relay it again.\n\n3 steps (Steps 1-2 in this turn, Step 3 in the future turn).\n🛑 **STRICTLY ORDERED — execute Step 1 → 2 sequentially in this turn; do NOT skip any step.**\n\n**Step 1** — Translate the [Source content] below to the user\'s language per [Translation rules]. Prepend a transition line `✓ Previous decision handled. Here\'s the next pending one:` (also translated) to the top of the translated output.\n\n**Step 2** — Render Step 1\'s output to the user as your assistant response. The user\'s reply just relayed is **already consumed** — it is NOT the answer to the next card.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n'
    + renderListMarkdown(q);
}
// upstream: pending_v2.rs::playbook_render
function playbookRender(e) {
  return 'Render the selected decision card to the user as your assistant response (text rendering only — do NOT call any tool). End the turn after rendering.\n\n**User-visible text** (render this verbatim as your assistant response; translate per [Localization] rules if the user\'s language is not English; keep `jobId` / data values intact):\n"""\n'
    + `${e.userContent}"""\n\n**LLM context** (this is for YOUR own routing reasoning — **do NOT show / paraphrase / leak this block to the user**):\n"""\n${resolveLlmContentPromptUser(e)}\n"""\n\nOn the user's next reply, follow the LLM context above (decision tree + pre-filled \`resolve-prompt\` command).\n`;
}
// upstream: pending_v2.rs::playbook_cancel
function playbookCancel(removed, wasActive, qAfter, snapAfter) {
  let s = `Cancelled pending decision: job=${removed.jobId}, role=${removed.role}, agent=${removed.agentId}, to_agent=${debugOptStr(removed.toAgentId)}, status_before=${wasActive ? 'active' : 'queued'}. Sub session is NOT notified (silent cancel); it will TTL-evict eventually or be retriggered by a new system event.\n\n`;
  if (!snapAfter.items.length) return s + 'Queue is now empty. End the turn.\n';
  if (wasActive) {
    s += '3 steps (Steps 1-2 in this turn, Step 3 in the future turn):\n\n**Step 1** — Translate the [Source content] below to the user\'s language per [Translation rules]. Prepend a transition line `✓ Previous decision cancelled. Here\'s the next pending one:` (also translated) to the top of the translated output.\n\n**Step 2** — Render Step 1\'s output to the user as your assistant response.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n';
    return s + renderListMarkdown(qAfter);
  }
  return s + 'Active entry was NOT affected (the cancelled entry was queued, not active). End the turn.\n';
}
// upstream: pending_v2.rs::playbook_error_no_active
const playbookErrorNoActive = () => 'The pending-decisions queue is empty — there is no decision to resolve. The user\'s reply is just a normal chat message; handle it as such.\nDo NOT call any `okx-a2a` user / session command. End the turn now.\n';
// upstream: pending_v2.rs::playbook_error
const playbookError = (msg) => `Cannot proceed: ${msg}\nDo NOT call any \`okx-a2a\` user / session command. End the turn.\n`;
// upstream: pending_v2.rs::playbook_stale_relist
function playbookStaleRelist(snap, reason) {
  let list = '';
  if (!snap.items.length) list = 'Queue is empty, no selection needed.\n';
  else {
    list = `Your previous selection is stale (${reason}). Current list:\n\n`;
    for (const it of snap.items) list += `${it.index}. ${it.listLabel}\n`;
    list += `\nReply with a number 1-${snap.items.length} to re-select.\n`;
  }
  return `The previous selection is stale. **Translate the content below into the user's language**, then render as your assistant response:\n\n"""\n${list}"""\n\nAfter rendering, end the turn. Do NOT call any tool.\n`;
}

export { resolveLlmContentCli, resolveLlmContentPromptUser, renderListMarkdown, ensureInvariantAndEvict, readQueue, entryStruct };
