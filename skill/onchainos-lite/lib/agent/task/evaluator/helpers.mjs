// Evaluator helpers — upstream task/evaluator/helpers.rs.
import { onchainosHome } from '../../_home.mjs';

const WIN = process.platform === 'win32';
const isSep = (c) => c === '/' || (WIN && c === '\\');

// `PathBuf::push` (std, no normalisation): an absolute / prefixed part replaces the base (a
// Windows root-only part keeps the base's prefix); otherwise one separator is inserted unless the
// base is empty or already ends with one. Node's path.join would normalise `/`, `.` and `..`,
// which changes the `localPath` that `evidence-info` prints (e.g. ONCHAINOS_HOME=C:/h).
export function pathBufPush(base, part) {
  if (WIN) {
    if (/^[A-Za-z]:/.test(part) || /^[\\/]{2}/.test(part)) return part;
    if (isSep(part.charAt(0))) {
      const prefix = /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.exec(base);
      return (prefix ? prefix[0] : '') + part;
    }
  } else if (part.startsWith('/')) return part;
  if (base === '' || (WIN && /^[A-Za-z]:$/.test(base))) return base + part;   // `C:` + x = `C:x`
  return isSep(base.charAt(base.length - 1)) ? base + part : base + (WIN ? '\\' : '/') + part;
}

// upstream: helpers.rs::evidence_dir — `task_state_dir(job_id).join("dispute").join(agent_id)`,
// i.e. `<home>/task/<jobId>/dispute/<agentId>` (no validation)
export const evidenceDir = (jobId, agentId) => ['task', jobId, 'dispute', agentId].reduce(pathBufPush, onchainosHome());
