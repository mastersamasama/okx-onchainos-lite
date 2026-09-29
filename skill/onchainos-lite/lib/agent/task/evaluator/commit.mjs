// `vote-commit` — upstream task/evaluator/commit.rs (prints plain text).
import { auditLog } from '../../../core/audit.mjs';
import { at, asStr } from '../../../core/rs/value.mjs';
import { trim, charCount } from '../../../core/rs/str.mjs';
import { resolveWalletAndAgentForEvaluator, signUopAndBroadcastWithCommitMeta, extractBizType } from '../signing.mjs';

// upstream: commit.rs::unescape_reason — `\n` `\t` `\r` `\\` `\"`; unknown `\x` kept verbatim.
export function unescapeReason(raw) {
  let out = '';
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\') { out += c; continue; }
    const n = chars[++i];
    if (n === undefined) out += '\\';
    else if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '\\') out += '\\';
    else if (n === '"') out += '"';
    else out += `\\${n}`;
  }
  return out;
}

// upstream: commit.rs::handle_commit (vote: u8 number)
export async function handleCommit(client, jobId, vote, reasonRaw, reasonSummaryRaw, agentIdRaw) {
  if (vote !== 0 && vote !== 1) throw new Error('--vote must be 0 (Approve, Client wins) or 1 (Reject, Provider wins)');
  const reason = unescapeReason(trim(reasonRaw));
  if (trim(reason) === '') throw new Error('--reason must not be empty');
  const reasonSummary = trim(reasonSummaryRaw);
  if (reasonSummary === '') throw new Error('--reason-summary must not be empty');
  const summaryLen = charCount(reasonSummary);
  if (summaryLen > 30) throw new Error(`--reason-summary must be ≤30 characters (got ${summaryLen}); compress the verdict further`);
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'vote/commit'), { vote }, agentId);
  const salt = asStr(at(resp, 'salt')) ?? '';
  if (salt === '') throw new Error('backend did not return salt, cannot broadcast vote/commit');
  const commitHash = asStr(at(resp, 'commitHash')) ?? '';
  const txHash = await signUopAndBroadcastWithCommitMeta(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, salt, vote, reason, reasonSummary);
  const voteLabel = vote === 0 ? 'Approve (Client wins)' : 'Reject (Provider wins)';
  auditLog('cli', 'evaluator/vote_committed', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `vote=${vote}`, `reasonLen=${charCount(reason)}`,
    `reasonSummaryLen=${summaryLen}`, `commitHash=${commitHash}`, `txHash=${txHash}`]);
  let out = `vote committed (jobId=${jobId})\n  vote:       ${vote} (${voteLabel})\n  voter:      ${address}\n`;
  if (commitHash !== '') out += `  commitHash: ${commitHash}\n`;
  out += `  txHash:     ${txHash}\n`;
  process.stdout.write(out);
}
