// next-action `sub_complete_notify` (user) — upstream task/user/v2/sub_complete_notify.rs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, asStr } from '../../../../core/rs/value.mjs';
import { displayTop } from '../../../../wallet/api.mjs';
import { PreFetchedTaskContext, hasSameAgentOwner } from '../../common/index.mjs';
import { TaskApiClient } from '../../common/network/task-api-client.mjs';
import { taskFeedbackExists } from '../../common/onchainos-self.mjs';
import { readManifest, deliverablesDir } from '../../common/deliverables.mjs';
import { handleSessionCleanup } from '../../common/session-cleanup.mjs';
import { validateJobId } from '../../common/util.mjs';
import { content } from '../flow-lifecycle/_peers.mjs';

const MAX_SAMPLE_DELIVERABLES = 5;
const MAX_TEXT_PREVIEW_CHARS = 500;

// upstream: sub_complete_notify.rs::handle → result value
export async function handle(agentId, message) {
  const jobId = messageJobId(message);
  if (jobId === undefined) return blockedResult('job_id_required', undefined, undefined);
  const invalid = validateJobId(jobId);
  if (invalid !== undefined) return blockedResult('invalid_job_id', jobId, invalid);
  const client = new TaskApiClient();
  let response;
  try { response = await client.getWithIdentity(client.taskPath(jobId), agentId); } catch (e) {
    try { await handleSessionCleanup(jobId, false); } catch {}
    return blockedResult('task_detail_unavailable', jobId, displayTop(e));
  }
  if (asStr(get(response, 'jobId')) !== jobId) {
    try { await handleSessionCleanup(jobId, false); } catch {}
    return blockedResult('task_detail_job_id_mismatch', jobId, 'response jobId does not match message.jobId');
  }
  const task = PreFetchedTaskContext.fromApiResponse(response);
  const ratingAllowed = canRateSubscription(response, task);
  const c = await content();
  const notification = c.subCompleteNotifyUserNotify(taskTitle(task), jobId, undefined, ratingAllowed);
  const rating = ratingAllowed ? await buildRatingPayload(agentId, jobId, task) : { required: false };
  return successResult(jobId, taskTitle(task), notification, rating, c);
}

// upstream: sub_complete_notify.rs::success_result
function successResult(jobId, title, notification, rating, c) {
  const payload = { jobId, notification: { content: notification, localize: true }, rating };
  if (rating.required === true) payload.ratingResultNotification = c.ratingSubmittedUserNotify(jobId, title);
  return {
    phase: 'subscription_completion', decision: 'ready', reason: 'notification_required',
    nextAction: [{ id: 'finalize_user_subscription', recommend: true }], payload,
  };
}

// upstream: sub_complete_notify.rs::message_job_id
function messageJobId(message) {
  const v = asStr(get(message, 'jobId'));
  return v === undefined || v === '' ? undefined : v;
}

// upstream: sub_complete_notify.rs::blocked_result
function blockedResult(reason, jobId, error) {
  const payload = {};
  if (jobId !== undefined) payload.jobId = jobId;
  if (error !== undefined) payload.error = error;
  return { phase: 'subscription_completion', decision: 'blocked', reason, nextAction: [{ id: 'stop' }], payload };
}

const taskTitle = (task) => (task.title === '' ? 'subscription' : task.title);
const canRateSubscription = (response, task) => !hasSameAgentOwner(response) && task.providerAgentId !== null && task.providerAgentId !== undefined && task.providerAgentId !== '';

// upstream: sub_complete_notify.rs::build_rating_payload
async function buildRatingPayload(agentId, jobId, task) {
  const providerId = task.providerAgentId;
  if (providerId === null || providerId === undefined || providerId === '') return { required: false };
  let exists;
  try { exists = await taskFeedbackExists(agentId, jobId); } catch { return { required: false }; }
  if (exists) return { required: false };
  return {
    required: true, providerAgentId: providerId, creatorAgentId: agentId, taskDescription: task.description,
    taskParameters: task.serviceParams !== null && task.serviceParams !== undefined && task.serviceParams !== '' ? task.serviceParams : null,
    deliverables: buildDeliverableSample(jobId),
  };
}

// upstream: sub_complete_notify.rs::build_deliverable_sample
export function buildDeliverableSample(jobId) {
  let manifest;
  try { manifest = readManifest('user', jobId); } catch { manifest = null; }
  if (!manifest || !manifest.entries.length) return 'Deliverables: none found.\n';
  let dir;
  try { dir = deliverablesDir('user', jobId); } catch { return 'Deliverables: directory unavailable.\n'; }
  const indices = pickSampleIndices(manifest.entries.length, MAX_SAMPLE_DELIVERABLES, jobId);
  const samples = indices.map((index, position) => {
    const entry = manifest.entries[index];
    const path = join(dir, entry.filename);
    let sample = `${position + 1}. ${entry.originalName} (type: ${entry.deliverableType}, path: ${path})`;
    if (entry.deliverableType === 'text') {
      let text;
      try { text = readFileSync(path, { encoding: 'utf8' }); } catch { text = undefined; }
      if (text !== undefined && isValidUtf8File(path)) {
        const chars = [...text];
        const preview = chars.slice(0, MAX_TEXT_PREVIEW_CHARS).join('');
        const suffix = chars.length > MAX_TEXT_PREVIEW_CHARS ? '...(truncated)' : '';
        sample += `\n   Preview: ${preview}${suffix}`;
      }
    }
    return sample;
  });
  return `Deliverables (${manifest.entries.length} total, sampled ${samples.length}):\n${samples.join('\n')}\n`;
}

// std::fs::read_to_string fails on invalid UTF-8.
function isValidUtf8File(path) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); return true; } catch { return false; }
}

// upstream: sub_complete_notify.rs::pick_sample_indices (FNV-1a seed + LCG partial Fisher-Yates)
export function pickSampleIndices(total, maxPick, jobId) {
  if (total <= maxPick) return Array.from({ length: total }, (_, i) => i);
  const M = (1n << 64n) - 1n;
  let random = fnv1aSeed(jobId);
  const pool = Array.from({ length: total }, (_, i) => i);
  for (let index = 0; index < maxPick; index++) {
    random = (random * 6364136223846793005n + 1n) & M;
    const selected = index + Number((random >> 33n) % BigInt(total - index));
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
  }
  return pool.slice(0, maxPick).sort((a, b) => a - b);
}

// upstream: sub_complete_notify.rs::fnv1a_seed
export function fnv1aSeed(value) {
  const M = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & M;
  }
  return hash;
}

