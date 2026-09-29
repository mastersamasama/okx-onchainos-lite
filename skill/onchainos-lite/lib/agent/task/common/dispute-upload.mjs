// Off-chain dispute evidence upload (hand-rolled multipart) — upstream
// task/common/dispute_upload.rs.
import { statSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { trim, byteLen, charCount } from '../../../core/rs/str.mjs';
import { fixed1Ratio } from '../../../core/rs/num.mjs';
import { ioErrorText } from '../../../core/rs/fs.mjs';
import { nowNanos } from '../../../core/rs/time.mjs';
import { readManifest, deliverablesDir } from './deliverables.mjs';

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// upstream: dispute_upload.rs::mime_for_ext
export function mimeForExt(ext) {
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', log: 'text/plain', md: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html',
    zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  }[ext] ?? 'application/octet-stream';
}

// upstream: dispute_upload.rs::rand_u64 — (subsec_nanos * 0x9e3779b97f4a7c15 + pid) mod 2^64
function randU64() {
  const subsec = nowNanos() % 1000000000n;
  return BigInt.asUintN(64, subsec * 0x9e3779b97f4a7c15n + BigInt(process.pid));
}

// upstream: dispute_upload.rs::handle_upload_evidence — prints the summary (plain text).
export async function handleUploadEvidence(client, jobId, agentId, role, text, explicitFilePaths, maxFiles) {
  if (role !== 'user' && role !== 'asp') throw new Error(`--role must be 'user' or 'asp', got '${role}'`);
  const textClean = text === undefined || text === null || trim(text) === '' ? undefined : trim(text);
  if (textClean !== undefined && byteLen(textClean) > MAX_TEXT_BYTES) {
    throw new Error(`--text too long: ${byteLen(textClean)} bytes, limit is ${MAX_TEXT_BYTES} bytes`);
  }
  const filePaths = explicitFilePaths.map((p) => [p, true]);
  let manifest = null;
  try { manifest = readManifest(role, jobId); } catch { manifest = null; }
  const manifestFilenames = [];
  if (manifest) {
    const dir = deliverablesDir(role, jobId);
    let entries = manifest.entries;
    if (maxFiles !== undefined && maxFiles !== null) {
      const total = entries.length;
      if (total > maxFiles) {
        process.stderr.write(`[dispute_upload] manifest has ${total} entries; capping to most recent ${maxFiles} (--max-files)\n`);
        entries = entries.slice(total - maxFiles);
      }
    }
    for (const e of entries) { filePaths.push([join(dir, e.filename), false]); manifestFilenames.push(e.filename); }
  }
  if (textClean === undefined && !filePaths.length) {
    throw new Error(`no evidence to upload: --text is blank, no --file was given, and no local deliverables were found at ~/.onchainos/deliverables/${role}/${jobId}/`);
  }
  const parts = [];
  let skipped = 0;
  for (const [idx, [p, isExplicit]] of filePaths.entries()) {
    let meta;
    try { meta = statSync(p); } catch (e) {
      if (isExplicit) throw new Error(`evidence file not found / unreadable: ${p} (${ioErrorText(e)})`);
      skipped++;
      continue;
    }
    if (meta.size > MAX_FILE_BYTES) {
      if (isExplicit) throw new Error(`evidence file too large: ${p} (${fixed1Ratio(meta.size, 1048576)} MB, limit 100 MB). Compress / split before uploading.`);
      skipped++;
      continue;
    }
    let bytes;
    try { bytes = readFileSync(p); } catch (e) {
      if (isExplicit) throw new Error(`failed to read ${p}: ${ioErrorText(e)}`);
      skipped++;
      continue;
    }
    const originalName = basename(p) || 'evidence';
    const ext = extname(p) ? extname(p).slice(1).toLowerCase() : '';
    const filename = /^[\x00-\x7f]*$/.test(originalName) ? originalName : ext === '' ? `evidence_${idx}` : `evidence_${idx}.${ext}`;
    parts.push({ filename, mime: mimeForExt(ext), bytes });
  }
  if (textClean === undefined && !parts.length) {
    throw new Error(`no evidence to upload: --text is blank, no --file was given, and every manifest entry under ~/.onchainos/deliverables/${role}/${jobId}/ was missing or unreadable (${skipped} skipped)`);
  }
  const boundary = `----onchainos-${randU64().toString(16).padStart(16, '0')}`;
  const chunks = [];
  if (textClean !== undefined) {
    const wrapped = `"${textClean.split('\\').join('\\\\').split('"').join('\\"')}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`), Buffer.from(wrapped, 'utf8'), Buffer.from('\r\n'));
  }
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${part.filename}"\r\nContent-Type: ${part.mime}\r\n\r\n`, 'utf8'),
      part.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  await client.rawPostWithIdentity(client.endpoint(jobId, 'evidence/upload'), body, `multipart/form-data; boundary=${boundary}`, agentId);
  let out = '✓ Evidence uploaded (off-chain, effective within 1h preparation window)\n';
  out += `  jobId:    ${jobId}\n`;
  out += `  role:     ${role}\n`;
  if (textClean !== undefined) out += `  text:     ${byteLen(textClean)} bytes (${charCount(textClean)} chars)\n`;
  if (explicitFilePaths.length) out += `  --file:   ${explicitFilePaths.length} explicit attachment(s)\n`;
  const attached = Math.max(manifestFilenames.length - skipped, 0);
  if (attached > 0) out += `  manifest: ${attached} local deliverable(s) auto-attached\n`;
  if (skipped > 0) out += `  skipped:  ${skipped} manifest entry/entries missing or unreadable on disk\n`;
  process.stdout.write(out);
}
