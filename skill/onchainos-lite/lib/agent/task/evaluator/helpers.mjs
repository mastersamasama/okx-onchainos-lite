// Evaluator helpers — upstream task/evaluator/helpers.rs.
import { home as onchainosHome } from '../../../core/home.mjs';
import { pathJoin } from '../../../core/rs/fs.mjs';

// upstream: helpers.rs::evidence_dir — `task_state_dir(job_id).join("dispute").join(agent_id)`,
// i.e. `<home>/task/<jobId>/dispute/<agentId>` (no validation). PathBuf::join does not
// normalise, which the `localPath` that `evidence-info` prints shows (e.g. ONCHAINOS_HOME=C:/h).
export const evidenceDir = (jobId, agentId) => ['task', jobId, 'dispute', agentId].reduce(pathJoin, onchainosHome());
