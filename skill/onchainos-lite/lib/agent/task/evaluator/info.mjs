// `evidence-info` — upstream task/evaluator/info.rs: round-gate precheck, evidence fetch, and
// download of every evidence file into `<home>/task/<jobId>/dispute/<agentId>/` (no extension).
import { mkdirSync, writeFileSync } from 'node:fs';
import { stringify } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { isObject } from '../../../core/rs/value.mjs';
import { ioError, pathJoin } from '../../../core/rs/fs.mjs';
import { precheckRoundGate } from './dispute-status.mjs';
import { evidenceDir } from './helpers.mjs';
import { evaluatorSelectedPostEvidenceSteps } from './flow.mjs';

// upstream: info.rs::EVIDENCE_SIDES
const EVIDENCE_SIDES = ['provider', 'client'];

// upstream: info.rs::handle_info (prints plain text)
export async function handleInfo(client, jobId, agentId, roundNum) {
  if (!(await precheckRoundGate(client, jobId, agentId, roundNum))) return;
  const data = await client.getWithIdentity(client.endpoint(jobId, 'evidence'), agentId);
  const tmpDir = evidenceDir(jobId, agentId);
  try { mkdirSync(tmpDir, { recursive: true }); } catch (e) { throw ioError(e); }
  for (const side of EVIDENCE_SIDES) {
    const bucket = isObject(data) ? data[side] : undefined;
    if (!isObject(bucket)) continue;
    const files = bucket.files;
    if (!Array.isArray(files)) continue;
    for (let i = 0; i < files.length; i++) {
      const fileKey = files[i];
      if (typeof fileKey !== 'string') continue;
      const merged = { fileKey };
      try {
        merged.localPath = await downloadFile(client, jobId, fileKey, tmpDir, agentId);
      } catch (e) {
        const errMsg = displayTop(e);
        auditLog('cli', 'evaluator/evidence_download_failed', false, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `side=${side}`, `fileKey=${fileKey}`], errMsg);
        merged.downloadError = errMsg;
      }
      files[i] = merged;
    }
  }
  process.stdout.write(`${stringify(data, true)}\n\n---\n\n${evaluatorSelectedPostEvidenceSteps(jobId, agentId)}`);
}

// upstream: info.rs::fetch_evidence_bytes
export const fetchEvidenceBytes = (client, jobId, fileKey, agentId) => client.getBytesWithIdentity(`${client.taskPath(jobId)}/evidence/download`, [['fileKey', fileKey]], agentId);

// upstream: info.rs::download_file → local path
async function downloadFile(client, jobId, fileKey, tmpDir, agentId) {
  const bytes = await fetchEvidenceBytes(client, jobId, fileKey, agentId);
  const slash = fileKey.indexOf('/');
  const filename = slash < 0 ? fileKey : fileKey.slice(slash + 1).split('/').join('_');
  const path = pathJoin(tmpDir, filename);
  try { writeFileSync(path, bytes); } catch (e) { throw ioError(e); }
  return path;
}
