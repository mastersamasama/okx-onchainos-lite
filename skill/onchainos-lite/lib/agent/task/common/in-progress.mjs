// Task in-progress query — upstream task/common/in_progress.rs.
const IN_PROGRESS_PATH = '/priapi/v1/aieco/task/inProgress';
const MAX_AGENT_IDS = 20;

// upstream: in_progress.rs::handle_in_progress → success data
export async function handleInProgress(client, agentIds) {
  if (!agentIds.length) throw new Error('at least one --agent-ids value is required');
  if (agentIds.length > MAX_AGENT_IDS) throw new Error(`at most ${MAX_AGENT_IDS} agent IDs allowed per request (got ${agentIds.length})`);
  return client.postWithIdentity(IN_PROGRESS_PATH, { agentIds: [...agentIds] }, agentIds[0]);
}
