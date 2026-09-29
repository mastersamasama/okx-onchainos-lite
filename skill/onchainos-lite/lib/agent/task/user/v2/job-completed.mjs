// next-action `job_completed` (user) — upstream task/user/v2/job_completed.rs.
import { join } from 'node:path';
import { get, asStr, asI64 } from '../../../../core/rs/value.mjs';
import { PreFetchedTaskContext, hasSameAgentOwner, TERMINAL_NOTIFICATION_MARKER } from '../../common/index.mjs';
import { TaskApiClient } from '../../common/network/task-api-client.mjs';
import { taskFeedbackExists } from '../../common/onchainos-self.mjs';
import { readManifest, deliverablesDir } from '../../common/deliverables.mjs';
import { content, listAttachmentPaths } from '../flow-lifecycle/_peers.mjs';

// upstream: job_completed.rs::handle → result value
export async function handle(jobId, agentId) {
  const client = new TaskApiClient();
  let response;
  try { response = { ok: await client.getWithIdentity(client.taskPath(jobId), agentId) }; } catch (e) { response = { err: e }; }
  const result = await resultFromTaskDetail(jobId, agentId, response);
  if (get(get(get(result, 'payload'), 'rating'), 'required') === true) {
    let exists;
    try { exists = { ok: await taskFeedbackExists(agentId, jobId) }; } catch (e) { exists = { err: e }; }
    preserveExistingUserRating(result, exists);
  }
  return result;
}

// upstream: job_completed.rs::preserve_existing_user_rating
function preserveExistingUserRating(result, feedbackExists) {
  if (feedbackExists.ok === false) return;
  result.reason = 'notification_required';
  result.payload.rating.required = false;
  delete result.payload.ratingResultNotification;
}

// upstream: job_completed.rs::result_from_task_detail
async function resultFromTaskDetail(jobId, agentId, response) {
  if (response.err) return blockedResult(jobId, 'task_detail_unavailable');
  const r = response.ok;
  if (asStr(get(r, 'jobId')) !== jobId) return blockedResult(jobId, 'task_detail_job_id_mismatch');
  if (asI64(get(r, 'status')) !== 6) return blockedResult(jobId, 'stale_task_status');
  const ratingRequired = !hasSameAgentOwner(r);
  const reason = ratingRequired ? 'notification_and_rating_required' : 'notification_required';
  const task = PreFetchedTaskContext.fromApiResponse(r);
  const provider = task.providerAgentId;
  if (provider === null || provider === undefined || provider === '') return blockedResult(jobId, 'task_detail_unavailable');
  const c = await content();
  return {
    phase: 'task_completion', decision: 'ready', reason,
    nextAction: [{ id: 'finalize_user_task', recommend: true }],
    payload: {
      jobId,
      notification: { content: completionNotification(jobId, task, ratingRequired), localize: true },
      ratingResultNotification: c.ratingSubmittedUserNotify(jobId, title(task)),
      rating: {
        required: ratingRequired, targetAgentId: provider, creatorAgentId: agentId, taskDescription: task.description,
        taskParameters: task.serviceParams !== null && task.serviceParams !== undefined && task.serviceParams !== '' ? task.serviceParams : null,
        deliverables: deliverableFiles(jobId), taskAttachments: await listAttachmentPaths(jobId),
      },
    },
  };
}

// upstream: job_completed.rs::blocked_result
const blockedResult = (jobId, reason) => ({ phase: 'task_completion', decision: 'blocked', reason, nextAction: [{ id: 'stop' }], payload: { jobId } });

const title = (task) => (task.title === '' ? 'Task' : task.title);

// upstream: job_completed.rs::completion_notification
export function completionNotification(jobId, task, includeRatingInvitation) {
  const body = task.paymentMode !== null && task.paymentMode !== undefined && Number(task.paymentMode) === 3
    ? `[x402 Job Completed] ${title(task)} (\`${jobId}\`) — all steps complete.\n- Spent: ${task.tokenAmount} ${task.tokenSymbol}\n- Payment: x402`
    : `[Job Completed] ${title(task)} (\`${jobId}\`) — approved by the User Agent; funds released to the ASP.\n- Spent: ${task.tokenAmount} ${task.tokenSymbol}\n- Payment: escrow`;
  const invitation = includeRatingInvitation
    ? `\n\nTo rate this job, reply "Rate job". Your rating for Job ID \`${jobId}\` replaces the AI-generated rating.`
    : '';
  return `${TERMINAL_NOTIFICATION_MARKER} ${body}${invitation}`;
}

// upstream: job_completed.rs::deliverable_files
function deliverableFiles(jobId) {
  let manifest, dir;
  try { manifest = readManifest('user', jobId); } catch { return []; }
  if (!manifest) return [];
  try { dir = deliverablesDir('user', jobId); } catch { return []; }
  return manifest.entries.map((e) => ({ name: e.originalName, type: e.deliverableType, path: join(dir, e.filename) }));
}
