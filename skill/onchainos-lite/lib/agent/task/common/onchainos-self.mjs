// Wrappers around this CLI itself — upstream task/common/onchainos_self.rs.
import { parse as parseJson } from '../../../core/json.mjs';
import { selfOutput, utf8Lossy } from '../../_proc.mjs';
import { get, asArray } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { exitStatusText } from '../../../core/rs/process.mjs';

// upstream: onchainos_self.rs::parse_task_feedback_exists
export function parseTaskFeedbackExists(stdout) {
  let parsed;
  try { parsed = parseJson(stdout); } catch (e) { throw new Error(`invalid task-feedback JSON: ${e.message}`); }
  const data = asArray(get(parsed, 'data'));
  if (!data) throw new Error('task-feedback response missing data array');
  return data.length > 0;
}

// upstream: onchainos_self.rs::task_feedback_exists
export async function taskFeedbackExists(agentId, taskId) {
  const o = await selfOutput(['agent', 'task-feedback', '--agent-id', agentId, '--task-id', taskId]);
  if (o.spawnError) throw new Error(`spawn failed: ${o.spawnError.message}`);
  if (o.code !== 0) throw new Error(`onchainos agent task-feedback exit ${exitStatusText(o.code, o.signal)}: ${utf8Lossy(o.stderr)}`);
  return parseTaskFeedbackExists(trim(utf8Lossy(o.stdout)));
}

// upstream: onchainos_self.rs::feedback_submit (state-changing)
export async function feedbackSubmit(providerAgentId, userAgentId, score, jobId, comment) {
  const o = await selfOutput(['agent', 'feedback-submit', '--agent-id', providerAgentId, '--creator-id', userAgentId, '--score', score, '--task-id', jobId, '--description', comment]);
  if (o.spawnError) throw new Error(`spawn failed: ${o.spawnError.message}`);
  if (o.code !== 0) throw new Error(`onchainos agent feedback-submit exit ${exitStatusText(o.code, o.signal)}: ${utf8Lossy(o.stderr)}`);
}
