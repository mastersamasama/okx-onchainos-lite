// Wrappers around the external `okx-a2a` CLI (npm `@okxweb3/a2a-node`) — upstream
// task/common/okx_a2a.rs. `Command::new("okx-a2a")` resolves only a native executable
// (on Windows an npm `.cmd` shim is not found); the npm-shim helpers go through `cmd /C`.
import { existsSync } from 'node:fs';
import { parse as parseJson, stringify } from '../../../core/json.mjs';
import { output, npmOutput, utf8Lossy } from '../../_proc.mjs';
import { spawnErrorText, exitStatusText, isObj, get, asStr, asBool, asArray, trim, valueText } from '../../_rs.mjs';
import { isRetiredDeliveryDecision, isRetiredModeConfigurationDecision } from './_autotrade.mjs';

// upstream: okx_a2a.rs::SKIP_A2A_PREFLIGHT_ENV
export const SKIP_A2A_PREFLIGHT_ENV = 'ONCHAINOS_SKIP_A2A_PREFLIGHT';
const skipPreflight = () => process.env[SKIP_A2A_PREFLIGHT_ENV] === '1';
const OKX_A2A = 'okx-a2a';

const statusText = (o) => exitStatusText(o.code, o.signal);
const success = (o) => !o.spawnError && o.code === 0;
const parseSlice = (buf) => parseJson(utf8Lossy(buf));
const stderrText = (o) => utf8Lossy(o.stderr);

// upstream: okx_a2a.rs::output_with_timeout — spawn failure / timeout errors.
async function outputWithTimeout(program, args, timeoutMs, { npm = false } = {}) {
  const o = npm ? await npmOutput(program, args, { timeoutMs }) : await output(program, args, { timeoutMs });
  if (o.spawnError) throw new Error(spawnErrorText(o.spawnError));
  if (o.timedOut) throw new Error(`okx-a2a command timed out after ${Math.floor(timeoutMs / 1000)}s`);
  return o;
}

// upstream: okx_a2a.rs::version_probe_failure_hint
export function versionProbeFailureHint(details) {
  let hint = 'okx-a2a may not be installed, or the active Node environment may differ from the one used to install it. Switch to the correct Node environment and retry. If it is not installed, run `npm i -g @okxweb3/a2a-node` in a compatible Node environment.';
  const d = details === undefined || details === null ? '' : trim(details);
  if (d !== '') hint += ` Details: ${d}`;
  return hint;
}

// upstream: okx_a2a.rs::build_not_ready_hint
export function buildNotReadyHint(userMessage, report) {
  const lines = [userMessage];
  for (const action of asArray(get(report, 'nextActions')) ?? []) {
    if (asBool(get(action, 'optional')) ?? false) continue;
    const why = asStr(get(action, 'why')) ?? '';
    const command = asStr(get(action, 'command')) ?? '';
    if (why !== '' && command !== '') lines.push(`- ${why} (run: ${command})`);
    else if (why !== '') lines.push(`- ${why}`);
    else if (command !== '') lines.push(`- run: ${command}`);
  }
  lines.push('Run `okx-a2a doctor --fix` to repair the local A2A environment, then retry.');
  return lines.join('\n');
}

// upstream: okx_a2a.rs::probe_communication_readiness → { kind: 'Ready'|'NotReady'|'Unverifiable', text? }
export async function probeCommunicationReadiness() {
  if (skipPreflight()) return { kind: 'Ready' };
  const v = await npmOutput(OKX_A2A, ['--version']);
  if (v.spawnError) return { kind: 'NotReady', text: versionProbeFailureHint(spawnErrorText(v.spawnError)) };
  if (v.code !== 0) {
    const stderr = utf8Lossy(v.stderr), stdout = utf8Lossy(v.stdout);
    return { kind: 'NotReady', text: versionProbeFailureHint(trim(stderr) === '' ? stdout : stderr) };
  }
  process.stderr.write('[onchainos] checking A2A communication readiness (okx-a2a doctor)...\n');
  const d = await npmOutput(OKX_A2A, ['doctor', '--json']);
  let report;
  if (!d.spawnError) { try { report = parseSlice(d.stdout); } catch { report = undefined; } }
  if (report === undefined) {
    return { kind: 'Unverifiable', text: 'A2A readiness could not be verified: okx-a2a doctor produced no usable report (the installed build may be outdated or broken). Continuing without the check — if communication fails, run `okx-a2a doctor --fix` (or reinstall with `npm i -g @okxweb3/a2a-node@latest`).' };
  }
  const verdict = asBool(get(report, 'ready')) ?? asBool(get(report, 'ok'));
  if (verdict === true) {
    process.stderr.write('[onchainos] A2A communication is ready\n');
    return { kind: 'Ready' };
  }
  if (verdict === false) {
    const message = asStr(get(report, 'userMessage')) ?? 'A2A communication is not fully ready';
    process.stderr.write(`[onchainos] A2A communication is NOT ready: ${message}\n`);
    return { kind: 'NotReady', text: buildNotReadyHint(message, report) };
  }
  return { kind: 'Unverifiable', text: 'A2A readiness could not be verified: okx-a2a doctor returned no readiness verdict. Continuing without the check — if communication fails, run `okx-a2a doctor --fix`.' };
}

// upstream: okx_a2a.rs::ensure_communication_ready_preflight
export async function ensureCommunicationReadyPreflight() {
  const r = await probeCommunicationReadiness();
  if (r.kind === 'NotReady') throw new Error(`A2A communication is not ready, so this operation was not executed. ${r.text}`);
  if (r.kind === 'Unverifiable') process.stderr.write(`[onchainos] ${r.text}\n`);
}

// upstream: okx_a2a.rs::communication_gate_json (json! → sorted keys)
export async function communicationGateJson() {
  const r = await probeCommunicationReadiness();
  if (r.kind === 'Ready') return { ok: true };
  if (r.kind === 'NotReady') return { ok: false, hint: r.text };
  return { ok: true, note: r.text };
}

// upstream: okx_a2a.rs::refresh_agent_identities_silently
export async function refreshAgentIdentitiesSilently() {
  if (skipPreflight()) return;
  process.stderr.write('[onchainos] refreshing A2A agent identities (okx-a2a agent refresh)...\n');
  const o = await npmOutput(OKX_A2A, ['agent', 'refresh', '--json']);
  if (success(o)) process.stderr.write('[onchainos] A2A agent identities refreshed\n');
  else process.stderr.write('[onchainos] A2A agent refresh did not complete (non-fatal); the daemon syncs periodically, or run `okx-a2a agent refresh` manually\n');
}

// upstream: okx_a2a.rs::DEFAULT_OFFLINE_REPLAY_FIX_COMMAND
export const DEFAULT_OFFLINE_REPLAY_FIX_COMMAND = 'npm install -g @okxweb3/a2a-node@latest';

// upstream: okx_a2a.rs::OfflineReplayCapability::fix_commands_or_default
export const fixCommandsOrDefault = (cap) => (cap.fixCommands.length ? [...cap.fixCommands] : [DEFAULT_OFFLINE_REPLAY_FIX_COMMAND]);

// upstream: okx_a2a.rs::interpret_capabilities_output (stdout: Buffer | undefined)
export function interpretCapabilitiesOutput(stdout) {
  const unsupported = { supported: false, fixCommands: [] };
  if (stdout === undefined || stdout === null) return unsupported;
  let report;
  try { report = parseSlice(stdout); } catch { return unsupported; }
  const elig = get(report, 'messageEligibleOfflineReplay');
  if (!isObj(elig)) return unsupported;
  return {
    supported: asBool(get(elig, 'ok')) === true,
    fixCommands: (asArray(get(elig, 'fixCommands')) ?? []).filter((v) => typeof v === 'string'),
  };
}

// upstream: okx_a2a.rs::probe_offline_replay_capability → { supported, fixCommands }
export async function probeOfflineReplayCapability() {
  if (skipPreflight()) return { supported: true, fixCommands: [] };
  const o = await npmOutput(OKX_A2A, ['capabilities', '--json']);
  return interpretCapabilitiesOutput(o.spawnError ? undefined : o.stdout);
}

// upstream: okx_a2a.rs::compose_user_notify_content
export function composeUserNotifyContent(content, imagePath) {
  const c = String(content).split('\\n').join('\n');
  if (c.includes('file://') || (c.includes('![') && c.includes(']('))) {
    throw new Error('local image links in --content are not supported; use --image-path <file>');
  }
  if (imagePath === undefined || imagePath === null) return c;
  const p = String(imagePath);
  if (trim(p) === '' || p.includes('\n') || p.includes('\r')) throw new Error('--image-path must be a non-empty single-line path');
  return `${c}\n\nMEDIA:${p}`;
}

// upstream: okx_a2a.rs::user_notify
export async function userNotify(content, imagePath, printOutput) {
  if (imagePath !== undefined && imagePath !== null && !existsSync(imagePath)) {
    throw new Error(`--image-path file not found: ${imagePath}`);
  }
  const c = composeUserNotifyContent(content, imagePath);
  const o = await output(OKX_A2A, ['user', 'notify', '--content', c, '--json']);
  if (o.spawnError) throw new Error(`spawn failed: ${spawnErrorText(o.spawnError)}`);
  if (o.code !== 0) throw new Error(`okx-a2a user notify exit ${statusText(o)}: ${stderrText(o)}`);
  if (printOutput) process.stdout.write('OK\n');
}

// upstream: okx_a2a.rs::user_notify_scoped (5 s)
export const userNotifyScoped = (content, jobId, idempotencyKey) => userNotifyScopedWithTimeout(content, jobId, idempotencyKey, 5000);

// upstream: okx_a2a.rs::user_notify_scoped_with_timeout
export async function userNotifyScopedWithTimeout(content, jobId, idempotencyKey, timeoutMs) {
  const c = composeUserNotifyContent(content, undefined);
  let o;
  try { o = await outputWithTimeout(OKX_A2A, ['user', 'notify', '--content', c, '--job-id', jobId, '--idempotency-key', idempotencyKey, '--json'], timeoutMs); } catch (e) { throw new Error(`scoped user notify failed: ${e.message}`); }
  if (o.code !== 0) throw new Error(`okx-a2a scoped user notify exit ${statusText(o)}: ${stderrText(o)}`);
}

// upstream: okx_a2a.rs::user_decision_request_command → argv
export function userDecisionRequestArgs(userContent, llmContent, jobId, idempotencyKey) {
  const args = ['user', 'decision-request', '--user-content', userContent, '--llm-content', llmContent];
  if (jobId !== undefined && jobId !== null && trim(jobId) !== '') args.push('--job-id', jobId);
  if (idempotencyKey !== undefined && idempotencyKey !== null && trim(idempotencyKey) !== '') args.push('--idempotency-key', idempotencyKey);
  args.push('--json');
  return args;
}

// upstream: okx_a2a.rs::user_decision_request
export async function userDecisionRequest(userContent, llmContent, jobId, idempotencyKey) {
  const o = await output(OKX_A2A, userDecisionRequestArgs(userContent, llmContent, jobId, idempotencyKey));
  if (o.spawnError) throw new Error(`spawn failed: ${spawnErrorText(o.spawnError)}`);
  if (o.code !== 0) throw new Error(`okx-a2a user decision-request exit ${statusText(o)}: ${stderrText(o)}`);
}

// ── retired autotrade decision cleanup ──
function pendingUserAttentionItems(value) {
  return asArray(get(value, 'items')) ?? asArray(get(value, 'data')) ?? asArray(get(get(value, 'data'), 'items'));
}
// upstream: okx_a2a.rs::decision_source_event
export function decisionSourceEvent(llmContent) {
  const i = llmContent.indexOf('--source-event "');
  if (i < 0) return undefined;
  const rest = llmContent.slice(i + '--source-event "'.length);
  const j = rest.indexOf('"');
  return j < 0 ? undefined : rest.slice(0, j);
}
function todoIds(value, jobId, predicate) {
  return (pendingUserAttentionItems(value) ?? [])
    .filter((item) => asStr(get(item, 'jobId')) === jobId && asStr(get(item, 'kind')) === 'decision_request' && asStr(get(item, 'status')) === 'pending')
    .filter((item) => { const llm = asStr(get(item, 'llmContent')); return predicate(llm === undefined ? undefined : decisionSourceEvent(llm)); })
    .map((item) => asStr(get(item, 'id')))
    .filter((id) => id !== undefined);
}
async function markTodoIdsHandled(ids) {
  if (!ids.length) return 0;
  const o = await npmOutput(OKX_A2A, ['user', 'check', '--todo-ids', ids.join(','), '--json']);
  if (o.spawnError) throw new Error(`spawn failed: ${spawnErrorText(o.spawnError)}`);
  if (o.code !== 0) throw new Error(`okx-a2a user check exit ${statusText(o)}: ${stderrText(o)}`);
  return ids.length;
}
async function outdatedList(jobId) {
  if (trim(jobId) === '') throw new Error('job id is required');
  const o = await npmOutput(OKX_A2A, ['user', 'outdated-list']);
  if (o.spawnError) throw new Error(`spawn failed: ${spawnErrorText(o.spawnError)}`);
  if (o.code !== 0) throw new Error(`okx-a2a user outdated-list exit ${statusText(o)}: ${stderrText(o)}`);
  try { return parseSlice(o.stdout); } catch (e) { throw new Error(`user outdated-list stdout not valid JSON: ${e.message}`); }
}
// upstream: okx_a2a.rs::mark_retired_autotrade_mode_decisions_handled
export async function markRetiredAutotradeModeDecisionsHandled(jobId) {
  const json = await outdatedList(jobId);
  return markTodoIdsHandled(todoIds(json, jobId, (e) => e !== undefined && isRetiredModeConfigurationDecision(e)));
}
// upstream: okx_a2a.rs::mark_retired_autotrade_decisions_handled
export async function markRetiredAutotradeDecisionsHandled(jobId) {
  const json = await outdatedList(jobId);
  return markTodoIdsHandled(todoIds(json, jobId, (e) => isRetiredDeliveryDecision(e)));
}

// ── sessions ──
async function direct(args, label, { timeoutMs = 0, timeoutLabel } = {}) {
  let o;
  if (timeoutMs > 0) {
    try { o = await outputWithTimeout(OKX_A2A, args, timeoutMs); } catch (e) { throw new Error(`${timeoutLabel}: ${e.message}`); }
  } else {
    o = await output(OKX_A2A, args);
    if (o.spawnError) throw new Error(`spawn failed: ${spawnErrorText(o.spawnError)}`);
  }
  if (o.code !== 0) throw new Error(`okx-a2a ${label} exit ${statusText(o)}: ${stderrText(o)}`);
  return o;
}

// upstream: okx_a2a.rs::session_query_exists
export async function sessionQueryExists(jobId, myAgentId, toAgentId) {
  const o = await direct(['session', 'query', '--job-id', jobId, '--my-agent-id', myAgentId, '--to-agent-id', toAgentId, '--json'], 'session query');
  let json;
  try { json = parseSlice(o.stdout); } catch (e) { throw new Error(`session query stdout not valid JSON: ${e.message}`); }
  const s = asArray(get(json, 'sessions'));
  return s ? s.length > 0 : false;
}

// upstream: okx_a2a.rs::session_create → sessionKey
export async function sessionCreate(jobId, myAgentId, toAgentId) {
  const o = await direct(['session', 'create', '--job-id', jobId, '--my-agent-id', myAgentId, '--to-agent-id', toAgentId, '--json'], 'session create');
  let json;
  try { json = parseSlice(o.stdout); } catch (e) { throw new Error(`session create stdout not valid JSON: ${e.message}`); }
  const key = asStr(get(get(json, 'session'), 'sessionKey')) ?? asStr(get(json, 'sessionKey'));
  if (key === undefined) throw new Error('session create response missing sessionKey (checked session.sessionKey and top-level)');
  return key;
}

// upstream: okx_a2a.rs::session_send (5 s)
export const sessionSend = (jobId, toAgentId, content) => sessionSendWithTimeout(jobId, toAgentId, content, 5000);
// upstream: okx_a2a.rs::session_send_with_timeout
export async function sessionSendWithTimeout(jobId, toAgentId, content, timeoutMs) {
  const args = ['session', 'send', '--job-id', jobId, '--content', content, '--json'];
  if (toAgentId !== undefined && toAgentId !== null) args.push('--to-agent-id', toAgentId);
  await direct(args, 'session send', { timeoutMs, timeoutLabel: 'session send failed' });
}

// upstream: okx_a2a.rs::trade_records_insert
export async function tradeRecordsInsert(input) {
  if (!Array.isArray(input)) throw new Error('trade-records insert input must be a JSON array');
  const o = await outputWithTimeout(OKX_A2A, ['trade-records', 'insert', '--input-json', stringify(input), '--json'], 5000, { npm: true });
  if (o.code !== 0) throw new Error(`okx-a2a trade-records insert exited with ${statusText(o)}`);
}

// upstream: okx_a2a.rs::xmtp_send_args
export const xmtpSendArgs = (jobId, toAgentId, message) => ['xmtp-send', '--job-id', jobId, '--to-agent-id', toAgentId, '--message', message, '--json'];
// upstream: okx_a2a.rs::xmtp_send
export async function xmtpSend(jobId, toAgentId, message) {
  const o = await direct(xmtpSendArgs(jobId, toAgentId, message), 'xmtp-send');
  let response;
  try { response = parseSlice(o.stdout); } catch (e) { throw new Error(`okx-a2a xmtp-send stdout not valid JSON: ${e.message}`); }
  if (asBool(get(response, 'ok')) !== true) throw new Error(`okx-a2a xmtp-send returned an unsuccessful response: ${valueText(response)}`);
}

// upstream: okx_a2a.rs::session_send_exact (5 s)
export const sessionSendExact = (sessionKey, content, messageId) => sessionSendExactWithTimeout(sessionKey, content, messageId, 5000);
// upstream: okx_a2a.rs::session_send_exact_with_timeout
export async function sessionSendExactWithTimeout(sessionKey, content, messageId, timeoutMs) {
  await direct(['session', 'send', '--session-key', sessionKey, '--content', content, '--message-id', messageId, '--json'], 'exact session send', { timeoutMs, timeoutLabel: 'exact session send failed' });
}

// upstream: okx_a2a.rs::session_delete
export async function sessionDelete(jobId, toAgentId) {
  const args = ['session', 'delete', '--job-id', jobId, '--json'];
  if (toAgentId !== undefined && toAgentId !== null) args.push('--to-agent-id', toAgentId);
  await direct(args, 'session delete');
}

// upstream: okx_a2a.rs::session_history → raw stdout (lossy UTF-8)
export async function sessionHistory(jobId, toAgentId) {
  const o = await direct(['session', 'history', '--job-id', jobId, '--to-agent-id', toAgentId, '--json'], 'session history');
  return utf8Lossy(o.stdout);
}

// upstream: okx_a2a.rs::task_reject_by_job
export async function taskRejectByJob(jobId, content) {
  const args = ['task', 'reject', '--job-id', jobId];
  if (content !== undefined && content !== null) args.push('--content', content);
  args.push('--json');
  await direct(args, 'task reject --job-id');
}

// upstream: okx_a2a.rs::file_upload → { fileKey, digest, salt, nonce, secret, filename }
export async function fileUpload(filePath, agentId, jobId, filename, mimeType) {
  const args = ['file', 'upload', '--file-path', filePath, '--agent-id', agentId, '--job-id', jobId];
  if (filename !== undefined && filename !== null) args.push('--filename', filename);
  if (mimeType !== undefined && mimeType !== null) args.push('--mime-type', mimeType);
  const o = await direct(args, 'file upload');
  let json;
  try { json = parseSlice(o.stdout); } catch (e) { throw new Error(`file upload stdout not valid JSON: ${e.message}`); }
  const take = (k) => { const v = asStr(get(json, k)); if (v === undefined) throw new Error(`file upload response missing field: ${k}`); return v; };
  return { fileKey: take('fileKey'), digest: take('digest'), salt: take('salt'), nonce: take('nonce'), secret: take('secret'), filename: take('filename') };
}

// upstream: okx_a2a.rs::file_download → local path
export async function fileDownload(fileKey, agentId, digest, salt, nonce, secret, filename) {
  const args = ['file', 'download', '--file-key', fileKey, '--agent-id', agentId, '--digest', digest, '--salt', salt, '--nonce', nonce, '--secret', secret];
  if (filename !== undefined && filename !== null) args.push('--filename', filename);
  const o = await direct(args, 'file download');
  const trimmed = trim(utf8Lossy(o.stdout));
  let json;
  try { json = parseJson(trimmed); } catch { return trimmed; }
  const p = asStr(get(json, 'path'));
  return p !== undefined ? p : valueText(json);
}
