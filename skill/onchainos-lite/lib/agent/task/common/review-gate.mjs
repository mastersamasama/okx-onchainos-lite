// Review gate — upstream task/common/review_gate.rs. `<home>/task/<job>/review-gate` holds
// `pending` / `approved`; `complete` (escrow) consumes `approved`.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { taskStateDir } from '../../_home.mjs';
import { trim, readToString, ioErrorText } from '../../_rs.mjs';

function gatePath(jobId) {
  const dir = taskStateDir(jobId);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw new Error(ioErrorText(e)); }   // create_dir_all(..)?
  return join(dir, 'review-gate');
}
// fs::write(..)? — io::Error Display.
const write = (p, text) => { try { writeFileSync(p, text); } catch (e) { throw new Error(ioErrorText(e)); } };
// std::fs::read_to_string(..).ok(): unreadable or non-UTF-8 content counts as absent.
const read = (p) => { try { return readToString(p); } catch { return undefined; } };

// upstream: review_gate.rs::mark_pending
export function markPending(jobId) {
  const path = gatePath(jobId);
  const cur = read(path);
  if (cur !== undefined && (trim(cur) === 'pending' || trim(cur) === 'approved')) return;
  write(path, 'pending');
}

// upstream: review_gate.rs::mark_approved
export function markApproved(jobId) {
  const path = gatePath(jobId);
  const content = read(path);
  if (content === undefined) throw new Error('review-gate file does not exist (job_submitted flow was not executed). Please call next-action --role user with `event=job_submitted` in --message first.');
  if (trim(content) === 'pending') { write(path, 'approved'); return; }
  throw new Error(`review-gate state error: expected 'pending', got '${trim(content)}'. Please run next-action with \`event=job_submitted\` in --message first.`);
}

// upstream: review_gate.rs::check_and_consume
export function checkAndConsume(jobId) {
  const path = gatePath(jobId);
  const content = read(path);
  if (content === undefined) throw new Error('review-gate file does not exist. In escrow mode you must run the next-action job_submitted review flow first (event=job_submitted in --message). Direct calls to complete are not allowed.');
  const c = trim(content);
  if (c === 'approved') { try { rmSync(path, { force: true }); } catch {} return; }
  if (c === 'pending') {
    throw new Error('User has not made a review decision yet (review-gate = pending). Please enqueue a review decision via `onchainos agent pending-decisions-v2 request --source-event job_submitted ...` and wait for the user\'s reply. After the user-session relays the reply back as a system envelope (`event:"user_decision_job_submitted"`, `message.data:<user verbatim>`), call `next-action --role user --agentId <agentId> --message \'{"event":"user_decision_job_submitted","jobId":"<jobId>","data":"<message.data>"}\'` — the returned playbook will instruct you to call `next-action` with `event=approve_review` (when the user approves) or `event=reject_review` (when the user rejects) inside `--message`.');
  }
  throw new Error(`review-gate state error: '${c}'`);
}
