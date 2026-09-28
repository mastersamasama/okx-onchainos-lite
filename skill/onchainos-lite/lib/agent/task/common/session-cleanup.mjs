// Terminal-state session cleanup — upstream task/common/session_cleanup.rs.
import { cancelAllForJob } from './pending-v2.mjs';
import * as prefilledNotify from './prefilled-notify.mjs';
import * as prefilledRating from './prefilled-rating.mjs';
import { keepConversationOnTerminal } from './config.mjs';
import { sessionDelete } from './okx-a2a.mjs';

// upstream: session_cleanup.rs::handle_session_cleanup — returns the summary text; prints it
// (`OK` without a trailing newline) when printOutput is set.
export async function handleSessionCleanup(jobId, printOutput) {
  try { await cancelAllForJob(jobId); } catch {}
  try { prefilledNotify.clear(jobId); } catch {}
  try { prefilledRating.clear(jobId); } catch {}
  let out = '';
  if (keepConversationOnTerminal()) out += 'ℹ️ KEEP_SESSION=true — conversation history retained. No further action needed.\n';
  else {
    try { await sessionDelete(jobId, undefined); out += 'OK'; } catch (e) { out += `⚠️ sub session delete failed: ${e.message}\n`; }
  }
  if (printOutput) process.stdout.write(out);
  return out;
}
