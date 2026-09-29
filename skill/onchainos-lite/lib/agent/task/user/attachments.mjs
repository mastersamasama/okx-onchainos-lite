// Local attachment management for user tasks — upstream task/user/attachments.rs.
// Storage: `<ONCHAINOS_HOME>/task/<jobId>/attachments/`.
import { statSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { home as onchainosHome } from '../../../core/home.mjs';
import { rustJoin as join } from '../../../core/qr.mjs';
import { validateJobIdPathComponent } from '../common/util.mjs';
import { resolveAgentId, statusName } from '../common/query.mjs';
import { AGENT_ROLE_USER } from '../common/index.mjs';
import { stringify } from '../../../core/json.mjs';
import { asI64, at } from '../../../core/rs/value.mjs';
import { io, ioErrorText } from '../../../core/rs/fs.mjs';
import { fixed1Ratio } from '../../../core/rs/num.mjs';
import { localNow } from '../../../core/rs/time.mjs';

// upstream: attachments.rs::MAX_FILE_SIZE
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

const SEPS = process.platform === 'win32' ? /[\\/]/ : /\//;

// std::path::Path::file_name — last Normal component; None for `..`, a root or an empty path.
export function pathFileName(p) {
  let s = String(p);
  if (process.platform === 'win32') s = s.replace(/^(\\\\[?.]\\)?([A-Za-z]:)?/, '');
  const parts = s.split(SEPS).filter((c) => c !== '' && c !== '.');
  if (!parts.length) return undefined;
  const last = parts[parts.length - 1];
  return last === '..' ? undefined : last;
}

// std rsplit_file_at_dot → [before, after]
function rsplitFileAtDot(file) {
  if (file === '..') return [file, undefined];
  const i = file.lastIndexOf('.');
  if (i < 0) return [undefined, file];
  const before = file.slice(0, i), after = file.slice(i + 1);
  return before === '' ? [file, undefined] : [before, after];
}
// Path::file_stem / Path::extension of a bare file name.
export function fileStem(name) { const [b, a] = rsplitFileAtDot(name); return b ?? a; }
export function fileExtension(name) { const [b, a] = rsplitFileAtDot(name); return b !== undefined ? a : undefined; }

const p2 = (n) => String(n).padStart(2, '0');

// upstream: attachments.rs::validate_attachment_sources
export function validateAttachmentSources(sources) {
  for (const src of sources ?? []) {
    let st;
    try { st = statSync(src); } catch (e) { throw new Error(`attachment file is not readable: ${src}: ${ioErrorText(e)}`); }
    if (!st.isFile()) throw new Error(`attachment path is not a regular file: ${src}`);
    if (st.size > MAX_FILE_SIZE) {
      throw new Error(`attachment file too large: ${src} (${fixed1Ratio(st.size, 1024 * 1024)} MB, max 100 MB). Please compress or resize the file.`);
    }
    if (pathFileName(src) === undefined) throw new Error(`invalid attachment file path: ${src}`);
  }
}

// upstream: attachments.rs::attachments_dir
export function attachmentsDir(jobId) {
  validateJobIdPathComponent(jobId);
  return join(onchainosHome(), 'task', jobId, 'attachments');   // PathBuf::join (Display parity)
}

// upstream: attachments.rs::dedup_dest
export function dedupDest(dir, fileName) {
  const candidate = join(dir, fileName);
  if (!existsSync(candidate)) return candidate;
  const stem = fileStem(fileName) ?? 'file';
  const e = fileExtension(fileName);
  const ext = e === undefined ? '' : `.${e}`;
  for (let i = 2; i <= 999; i++) {
    const renamed = join(dir, `${stem}_${i}${ext}`);
    if (!existsSync(renamed)) return renamed;
  }
  const n = localNow();
  const ts = `${String(n.y).padStart(4, '0')}${p2(n.m)}${p2(n.d)}${p2(n.hh)}${p2(n.mm)}${p2(n.ss)}`;
  return join(dir, `${stem}_${ts}${ext}`);
}

// upstream: attachments.rs::handle_task_attach — prints the saved-attachment block itself.
export async function handleTaskAttach(client, jobId, filePath) {
  const agentId = await resolveAgentId('', AGENT_ROLE_USER);
  const resp = await client.getWithAgentId(client.taskPath(jobId), agentId);
  const status = asI64(at(resp, 'status')) ?? -1;
  if (status >= 2) {
    throw new Error(`task status is "${statusName(status)}" (status=${status}); attachments can only be added when the task is in created or accepted state`);
  }
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const fileSize = io(() => statSync(filePath)).size;
  if (fileSize > MAX_FILE_SIZE) {
    throw new Error(`file too large: ${fixed1Ratio(fileSize, 1024 * 1024)} MB (max 100 MB). Please compress or resize the file before adding it as an attachment.`);
  }
  const fileName = pathFileName(filePath);
  if (fileName === undefined) throw new Error(`invalid file path: ${filePath}`);
  const dir = attachmentsDir(jobId);
  io(() => mkdirSync(dir, { recursive: true }));
  const dest = dedupDest(dir, fileName);
  io(() => copyFileSync(filePath, dest));
  process.stdout.write('✓ Attachment saved\n'
    + `  jobId: ${jobId}\n`
    + `  file:  ${dest}\n`
    + '\n'
    + '🛑 NEXT STEP (MUST NOT SKIP): the file is saved LOCALLY only — it has NOT been sent to the provider yet.\n'
    + '   If a sub session exists for this job (task already has a matched provider),\n'
    + '   you MUST run `okx-a2a session send` to notify the sub session:\n'
    + '\n'
    + `   okx-a2a session send --job-id ${jobId} --to-agent-id <peer agentId from sub session> --content "[ATTACHMENT_ADDED] ${dest}" --json  ← exact prefix, do NOT change\n`
    + '\n'
    + '   If NO sub session exists yet (task not matched with a provider), skip the dispatch —\n'
    + '   the sub session will pick up the file automatically via list-attachments when it starts.\n');
}

// upstream: attachments.rs::list_attachment_paths — sorted (byte order) regular files.
export function listAttachmentPaths(jobId) {
  let dir;
  try { dir = attachmentsDir(jobId); } catch { return []; }
  if (!existsSync(dir)) return [];
  const files = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile()) files.push(join(dir, e.name));
  } catch {}
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// upstream: attachments.rs::handle_task_attachments — raw pretty JSON array, no envelope.
export function handleTaskAttachments(jobId) {
  process.stdout.write(stringify(listAttachmentPaths(jobId), true) + '\n');
}

// upstream: attachments.rs::copy_attachments_to_job
export function copyAttachmentsToJob(jobId, sources) { copyAttachmentsToJobWithManifest(jobId, sources); }

// upstream: attachments.rs::copy_attachments_to_job_with_manifest → [{fileName,size,sourcePath,storedPath}]
export function copyAttachmentsToJobWithManifest(jobId, sources) {
  const list = sources ?? [];
  validateAttachmentSources(list);
  if (!list.length) return [];
  const dir = attachmentsDir(jobId);
  io(() => mkdirSync(dir, { recursive: true }));
  const manifest = [];
  for (const src of list) {
    const size = io(() => statSync(src)).size;
    const fileName = pathFileName(src);
    if (fileName === undefined) throw new Error(`invalid file path: ${src}`);
    const dest = dedupDest(dir, fileName);
    io(() => copyFileSync(src, dest));
    manifest.push({ sourcePath: src, storedPath: dest, fileName, size });
  }
  return manifest;
}

