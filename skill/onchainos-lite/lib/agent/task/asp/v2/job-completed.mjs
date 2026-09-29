// ASP task-completion playbook — upstream task/asp/v2/job_completed.rs.
// Reads the authoritative task detail (identity GET /task/{jobId}) and, when a rating is
// required, asks `agent task-feedback` whether this ASP already rated the job.
import { stringify } from '../../../../core/json.mjs';
import { get, asStr, asI64 } from '../../../../core/rs/value.mjs';
import { TaskApiClient } from '../../common/network/task-api-client.mjs';
import { hasSameAgentOwner, PreFetchedTaskContext, TERMINAL_NOTIFICATION_MARKER } from '../../common/index.mjs';
import { taskFeedbackExists } from '../../common/onchainos-self.mjs';
import { ratingSubmittedUserNotify } from '../content.mjs';

// upstream: job_completed.rs::handle → compact JSON string
export async function handle(jobId, agentId) {
  const client = new TaskApiClient();
  let response;
  try { response = { ok: await client.getWithIdentity(client.taskPath(jobId), agentId) }; } catch (e) { response = { err: e }; }
  const result = resultFromTaskDetail(jobId, agentId, response);
  if (result.payload?.rating?.required === true) {
    let feedbackExists;
    try { feedbackExists = { ok: await taskFeedbackExists(agentId, jobId) }; } catch (e) { feedbackExists = { err: e }; }
    preserveExistingProviderRating(result, feedbackExists);
  }
  return stringify(result);
}

// upstream: job_completed.rs::preserve_existing_provider_rating (mutates result)
export function preserveExistingProviderRating(result, feedbackExists) {
  if (feedbackExists.err === undefined && feedbackExists.ok === false) return;
  result.reason = 'notification_required';
  result.payload.rating.required = false;
  delete result.payload.ratingResultNotification;
}

// upstream: job_completed.rs::result_from_task_detail → result Value (object)
export function resultFromTaskDetail(jobId, agentId, response) {
  if (response.err !== undefined) return blockedResult(jobId, 'task_detail_unavailable');
  const detail = response.ok;
  if (asStr(get(detail, 'jobId')) !== jobId) return blockedResult(jobId, 'task_detail_job_id_mismatch');
  const status = asI64(get(detail, 'status'));
  if (status === undefined || Number(status) !== 6) return blockedResult(jobId, 'stale_task_status');
  const ratingRequired = !hasSameAgentOwner(detail);
  const task = PreFetchedTaskContext.fromApiResponse(detail);
  const userAgentId = task.userAgentId;
  if (userAgentId === null || userAgentId === undefined || userAgentId === '') return blockedResult(jobId, 'task_detail_unavailable');
  return {
    phase: 'task_completion', decision: 'ready', reason: ratingRequired ? 'notification_and_rating_required' : 'notification_required',
    nextAction: [{ id: 'finalize_asp_task', recommend: true }],
    payload: {
      jobId,
      notification: { content: completionNotification(jobId, task, ratingRequired), localize: true },
      ratingResultNotification: ratingNotification(jobId, task),
      rating: {
        required: ratingRequired, targetAgentId: userAgentId, creatorAgentId: agentId, taskDescription: task.description,
        taskParameters: task.serviceParams !== null && task.serviceParams !== undefined && task.serviceParams !== '' ? task.serviceParams : null,
      },
    },
  };
}

// upstream: job_completed.rs::blocked_result
const blockedResult = (jobId, reason) => ({ phase: 'task_completion', decision: 'blocked', reason, nextAction: [{ id: 'stop' }], payload: { jobId } });

const title = (task) => (task.title === '' ? 'Task' : task.title);

// upstream: job_completed.rs::completion_notification
function completionNotification(jobId, task, includeRatingInvitation) {
  const content = `${TERMINAL_NOTIFICATION_MARKER} [💰 Job Completed] Job ${jobId} (${title(task)}) — approved by the User Agent; funds received.\n`
    + `      - Income: ${task.tokenAmount} ${task.tokenSymbol}\n      - User Agent: ${task.userAgentId ?? ''}\n    \n    This job is complete.`;
  if (!includeRatingInvitation) return content;
  return `${content}\n\n    To rate the User Agent, reply "Rate User Agent". Your rating for Job ID \`${jobId}\` replaces the AI-generated rating.`;
}

// upstream: job_completed.rs::rating_notification
const ratingNotification = (jobId, task) => ratingSubmittedUserNotify(jobId).split('<title>').join(title(task));
