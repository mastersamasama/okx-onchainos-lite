// Persistent deliverable storage — upstream task/common/deliverables.rs.
// Layout: <home>/deliverables/<role>/<jobId>[_<title>]/{manifest.json, files…}
import { existsSync, opendirSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { onchainosHome } from '../../_home.mjs';
import { stringify, struct } from '../../../core/json.mjs';
import { fromStr, T } from '../../../wallet/_serde-json.mjs';
import { trim, isAlphanumeric, fixed1Ratio, localNow, localStamp, rfc3339Of, ioErrorText } from '../../_rs.mjs';
import { validateJobIdPathComponent } from './util.mjs';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const deliverablesRoot = () => join(onchainosHome(), 'deliverables');

// upstream: deliverables.rs::sanitize_title
export function sanitizeTitle(title, jobId) {
  const result = [...trim(title)].filter(isAlphanumeric).slice(0, 20).join('');
  if (result !== '') return result;
  const bytes = Buffer.from(jobId, 'utf8');
  return `job_${bytes.subarray(0, Math.min(bytes.length, 10)).toString('utf8')}`;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// std::fs::read_dir order (the OS directory stream; readdirSync would sort on Unix). Entries
// that fail mid-stream are skipped like `entries.flatten()`.
function readDirOs(path) {
  const dir = opendirSync(path);
  const out = [];
  try { for (;;) { let e; try { e = dir.readSync(); } catch { break; } if (e === null) break; out.push(e); } } finally { try { dir.closeSync(); } catch {} }
  return out;
}

// upstream: deliverables.rs::deliverables_dir
export function deliverablesDir(role, jobId) {
  validateJobIdPathComponent(jobId);
  const roleDir = join(deliverablesRoot(), role);
  const exact = join(roleDir, jobId);
  if (existsSync(exact)) return exact;
  if (existsSync(roleDir)) {
    let entries = [];
    try { entries = readDirOs(roleDir); } catch {}
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith(`${jobId}_`)) return join(roleDir, e.name);
    }
  }
  return exact;
}

const manifestPath = (role, jobId) => join(deliverablesDir(role, jobId), 'manifest.json');

// upstream: deliverables.rs::{Manifest, TaskContext, DeliverableEntry}
const ENTRY = T.struct('DeliverableEntry', [['filename', T.string], ['originalName', T.string], ['deliverableType', T.string],
  ['fileKey', T.option(T.string), null], ['savedAt', T.string], ['sizeBytes', T.i64]]);
const TASK = T.struct('TaskContext', [['shortId', T.string], ['title', T.string], ['tokenSymbol', T.option(T.string), null],
  ['tokenAmount', T.option(T.string), null], ['counterpartyAgentId', T.option(T.string), null], ['counterpartyName', T.option(T.string), null]]);
const MANIFEST = T.struct('Manifest', [['jobId', T.string], ['role', T.string], ['task', TASK], ['entries', T.vec(ENTRY)]]);

const entryJson = (e) => struct({ filename: e.filename, originalName: e.originalName, deliverableType: e.deliverableType,
  fileKey: e.fileKey ?? undefined, savedAt: e.savedAt, sizeBytes: e.sizeBytes });
const manifestJson = (m) => struct({
  jobId: m.jobId, role: m.role,
  task: struct({ shortId: m.task.shortId, title: m.task.title, tokenSymbol: m.task.tokenSymbol ?? undefined, tokenAmount: m.task.tokenAmount ?? undefined,
    counterpartyAgentId: m.task.counterpartyAgentId ?? undefined, counterpartyName: m.task.counterpartyName ?? undefined }),
  entries: m.entries.map(entryJson),
});

// upstream: deliverables.rs::read_manifest → manifest | null (parse errors propagate)
export function readManifest(role, jobId) {
  const path = manifestPath(role, jobId);
  if (!existsSync(path)) return null;
  let data;
  try { data = readFileSync(path); } catch (e) { throw new Error(ioErrorText(e)); }
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('stream did not contain valid UTF-8'); }
  return fromStr(data, MANIFEST);
}

function writeManifest(m) {
  writeFileSync(manifestPath(m.role, m.jobId), stringify(manifestJson(m), true));
}

// upstream: deliverables.rs::handle_save(&SaveParams) → SaveResult { jobId, role, path, totalEntries } (struct order)
export function handleSave(params) {
  const role = params.role;
  if (role !== 'user' && role !== 'asp') throw new Error(`--role must be 'user' or 'asp', got '${role}'`);
  const src = params.filePath;
  if (!existsSync(src)) throw new Error(`file not found: ${src}`);
  let fileSize;
  try { fileSize = statSync(src).size; } catch (e) { throw new Error(ioErrorText(e)); }
  if (fileSize > MAX_FILE_SIZE) throw new Error(`file too large: ${fixed1Ratio(fileSize, 1024 * 1024)} MB (max 100 MB). Please compress or resize the file before saving.`);
  const originalName = basename(src) || 'deliverable';
  const sanitized = sanitizeTitle(params.title, params.jobId);
  const now = localNow();
  const timestamp = localStamp(now);
  const ext = extname(src) || '.txt';
  const destName = `${sanitized}_${timestamp}${ext}`;
  const targetDir = join(deliverablesRoot(), role, `${params.jobId}_${sanitized}`);
  const existing = deliverablesDir(role, params.jobId);
  let dir;
  if (existing === targetDir && existsSync(existing)) dir = existing;
  else if (existsSync(existing)) { try { renameSync(existing, targetDir); } catch {} dir = targetDir; }
  else dir = targetDir;
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw new Error(ioErrorText(e)); }
  const dest = join(dir, destName);
  try { renameSync(src, dest); } catch {
    try { copyFileSync(src, dest); } catch (e) { throw new Error(ioErrorText(e)); }
    try { rmSync(src, { force: true }); } catch {}
  }
  const entry = { filename: destName, originalName, deliverableType: params.deliverableType, fileKey: params.fileKey ?? null,
    savedAt: rfc3339Of(now), sizeBytes: fileSize };
  const manifest = readManifest(role, params.jobId) ?? {
    jobId: params.jobId, role,
    task: { shortId: params.shortId, title: params.title, tokenSymbol: params.tokenSymbol ?? null, tokenAmount: params.tokenAmount ?? null,
      counterpartyAgentId: params.counterpartyAgentId ?? null, counterpartyName: params.counterpartyName ?? null },
    entries: [],
  };
  manifest.entries.push(entry);
  writeManifest(manifest);
  return struct({ jobId: params.jobId, role, path: dest, totalEntries: manifest.entries.length });
}

// ── markers ──
const reviewMarkerPath = (jobId) => join(deliverablesDir('user', jobId), 'review_awaiting_deliverable');
// upstream: deliverables.rs::write_review_marker
export function writeReviewMarker(jobId) {
  const p = reviewMarkerPath(jobId);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
}
// upstream: deliverables.rs::has_review_marker
export function hasReviewMarker(jobId) { try { return existsSync(reviewMarkerPath(jobId)); } catch { return false; } }
// upstream: deliverables.rs::delete_review_marker
export function deleteReviewMarker(jobId) { try { rmSync(reviewMarkerPath(jobId), { force: true }); } catch {} }

const reviewCardSentMarkerPath = (jobId) => join(deliverablesDir('user', jobId), 'review_card_sent');
// upstream: deliverables.rs::has_review_card_sent_marker
export function hasReviewCardSentMarker(jobId) {
  try { return statSync(reviewCardSentMarkerPath(jobId)).isFile(); } catch { return false; }
}
// upstream: deliverables.rs::mark_review_card_sent
export function markReviewCardSent(jobId) {
  const p = reviewCardSentMarkerPath(jobId);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
}

const deliverableRows = (dir, m) => m.entries.map((e) => ({
  path: join(dir, e.filename), originalName: e.originalName, deliverableType: e.deliverableType, sizeBytes: e.sizeBytes, savedAt: e.savedAt,
}));

// upstream: deliverables.rs::handle_list → success data (json! → sorted)
export function handleList(jobId, role) {
  if (role !== 'user' && role !== 'asp') throw new Error(`--role must be 'user' or 'asp', got '${role}'`);
  const m = readManifest(role, jobId);
  if (!m) return { deliverables: [] };
  const dir = deliverablesDir(role, jobId);
  return {
    jobId: m.jobId, shortId: m.task.shortId, title: m.task.title, tokenAmount: m.task.tokenAmount, tokenSymbol: m.task.tokenSymbol,
    counterpartyAgentId: m.task.counterpartyAgentId, counterpartyName: m.task.counterpartyName, deliverables: deliverableRows(dir, m),
  };
}

// upstream: deliverables.rs::handle_list_all → success data
export function handleListAll(role, search) {
  if (role !== 'user' && role !== 'asp') throw new Error(`--role must be 'user' or 'asp', got '${role}'`);
  const roleDir = join(deliverablesRoot(), role);
  if (!existsSync(roleDir)) return { results: [] };
  const keyword = search === undefined || search === null ? undefined : search.toLowerCase();
  const results = [];
  let entries;
  try { entries = readDirOs(roleDir); } catch (e) { throw new Error(ioErrorText(e)); }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const jobId = e.name;
    const m = readManifest(role, jobId);
    if (!m) continue;
    if (keyword !== undefined && !m.task.title.toLowerCase().includes(keyword)) continue;
    const dir = deliverablesDir(role, jobId);
    results.push({
      jobId: m.jobId, shortId: m.task.shortId, title: m.task.title, tokenAmount: m.task.tokenAmount, tokenSymbol: m.task.tokenSymbol,
      counterpartyAgentId: m.task.counterpartyAgentId, counterpartyName: m.task.counterpartyName, deliverableCount: m.entries.length,
      deliverables: deliverableRows(dir, m),
    });
  }
  return { results };
}

export { isDir as _isDir };
