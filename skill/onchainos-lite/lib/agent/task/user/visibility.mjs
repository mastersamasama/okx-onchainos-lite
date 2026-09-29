// Change a marketplace task's visibility — upstream task/user/visibility.rs.
// The update endpoint's wire values are public=1 / private=0 (the inverse of create-task).
import { stringify } from '../../../core/json.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { resolveUserAgent } from './create.mjs';

const SET_VISIBILITY_ACTION = 'setVisibility';

// upstream: visibility.rs::TaskVisibility ('public' | 'private') → update API value
export const TaskVisibility = Object.freeze({ Public: 'public', Private: 'private', updateApiValue: (v) => (v === 'public' ? 1 : 0) });

// upstream: visibility.rs::is_success (private)
export const isSuccess = (data) => data === null || data === undefined || data === true;

// upstream: visibility.rs::handle_task_visibility_update → success data
export async function handleTaskVisibilityUpdate(client, jobId, visibility) {
  if (trim(jobId) === '') throw new Error('--job-id must not be empty');
  const [userAgentId] = await resolveUserAgent();
  let response;
  try {
    response = await client.postMutationWithIdentity(client.endpoint(jobId, SET_VISIBILITY_ACTION), { visibility: TaskVisibility.updateApiValue(visibility) }, userAgentId);
  } catch (e) { throw new Error(`task-visibility-update failed: ${displayTop(e)}`); }
  if (!isSuccess(response)) throw new Error(`task-visibility-update failed: backend did not confirm the update: ${stringify(response)}`);
  return { updated: true, payload: { jobId, targetVisibility: visibility, targetVisibilityValue: TaskVisibility.updateApiValue(visibility) } };
}
