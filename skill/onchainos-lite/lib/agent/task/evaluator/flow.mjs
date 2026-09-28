// Evaluator next-action playbooks — upstream task/evaluator/flow.rs (`generate_next_action`
// consumed by `agent next-action --role evaluator`) plus the post-evidence Step 3/4 text that
// `evidence-info` appends.
import { get, asStr, asI64, isNum, numText, parseI64, nowSecs } from '../../_rs.mjs';
import { TaskApiClient } from '../common/network/task-api-client.mjs';
import { getMyStake } from './staking-types.mjs';
import { fmtLocalYmdHmsZ } from './_time.mjs';

const has = (v) => v !== undefined && v !== null;

// upstream: flow.rs::generate_next_action
export async function generateNextAction(jobId, event, agentId, message) {
  const staking = await stakingNextAction(jobId, event, agentId);
  if (staking !== undefined) return staking;
  const dispute = await disputeNextAction(jobId, event, agentId, message);
  if (dispute !== undefined) return dispute;
  return `[unknown event=${event} at jobId=${jobId} ignored.\nDo not pull context; do not guess other notifications.\n`;
}

// upstream: flow.rs::fmt_local_time — ts ≤ 0 → undefined
export function fmtLocalTime(ts) {
  if (!has(ts) || BigInt(ts) <= 0n) return undefined;
  return fmtLocalYmdHmsZ(ts);
}

// upstream: flow.rs::fetch_my_stake (errors → undefined)
async function fetchMyStake(agentId) {
  try { return await getMyStake(new TaskApiClient(), agentId); } catch { return undefined; }
}

// upstream: flow.rs::notify_block
export const notifyBlock = (content) => "Run `onchainos agent user-notify` to push the notification to the user. Translate the content below into the user's language first, then run:\n\n"
  + '```bash\nonchainos agent user-notify --content "<localized content>"\n```\n\n'
  + `Canonical English content:\n    ${content}\n`;

// upstream: flow.rs::notify_block_lines
export const notifyBlockLines = (lines) => "Run `onchainos agent user-notify` to push the notification to the user. Translate the content below into the user's language first, then run:\n\n"
  + '```bash\nonchainos agent user-notify --content "<localized content>"\n```\n\n'
  + `Canonical English content:\n${lines.map((l) => `    ${l}`).join('\n')}\n`;

// upstream: flow.rs::str_field — non-empty string
export const strField = (msg, key) => { const v = asStr(get(msg, key)); return v !== undefined && v !== '' ? v : undefined; };
// upstream: flow.rs::i64_field — number (i64) or `str.parse::<i64>()`
export function i64Field(msg, key) {
  const v = get(msg, key);
  if (v === undefined) return undefined;
  if (isNum(v)) return asI64(v);
  const s = asStr(v);
  return s === undefined ? undefined : parseI64(s);
}
// upstream: flow.rs::display_field — non-empty string or number text
export function displayField(msg, key) {
  const v = get(msg, key);
  if (typeof v === 'string') return v !== '' ? v : undefined;
  if (isNum(v)) return numText(v);
  return undefined;
}

// upstream: flow.rs::hours_left_text
export function hoursLeftText(deadline, now = nowSecs()) {
  const d = BigInt(deadline), n = BigInt(now);
  if (d <= n) return undefined;
  const hrs = (d - n) / 3600n;
  return hrs >= 1n ? `${hrs} hours` : 'less than 1 hour';
}

// upstream: flow.rs::minutes_left_text
export function minutesLeftText(deadline, now = nowSecs()) {
  const d = BigInt(deadline), n = BigInt(now);
  if (d <= n) return undefined;
  const mins = (d - n) / 60n;
  return mins >= 1n ? `${mins} minutes remaining` : 'less than 1 minute remaining';
}

// upstream: flow.rs::terminal_session_hint
export const terminalSessionHint = (jobId) => `\n**Terminal wrap-up — run the cleanup command:**\n\`\`\`bash\nonchainos agent session-cleanup --job-id ${jobId}\n\`\`\`\nThen end this turn.\n`;

const m = (message, f, key) => (has(message) ? f(message, key) : undefined);

// upstream: flow.rs::staking_next_action
async function stakingNextAction(_jobId, event, agentId) {
  if (event === 'staked') {
    const s = await fetchMyStake(agentId);
    const content = s !== undefined ? `Your stake is now active on-chain. Current activeStake is ${s.activeStake} OKB.` : 'Your stake is now active on-chain.';
    return `[Current Event] staked\n\n${notifyBlock(content)}`;
  }
  if (event === 'unstake_requested') {
    const s = await fetchMyStake(agentId);
    let content;
    if (s !== undefined) {
      const local = fmtLocalTime(s.unstakeAvailableAt);
      content = local !== undefined
        ? `The unstake request has been recorded on-chain. Current cumulative pending unstake is ${s.pendingUnstake} OKB; the last claimable time is ${local}. You can cancel the unstake mid-way.`
        : `The unstake request has been recorded on-chain. Current cumulative pending unstake is ${s.pendingUnstake} OKB. You can cancel the unstake before the cooldown ends.`;
    } else content = 'The unstake request has been recorded on-chain. You can cancel the unstake before the cooldown ends.';
    return `[Current Event] unstake_requested\n\n${notifyBlock(content)}`;
  }
  if (event === 'unstake_claimed') return `[Current Status] unstake_claimed\n\n${notifyBlock('Your unstake has been claimed; OKB has been credited to your wallet.')}`;
  if (event === 'unstake_cancelled') return `[Current Status] unstake_cancelled\n\n${notifyBlock('Your unstake has been cancelled; the pending OKB is back in staked state.')}`;
  if (event === 'stake_stopped') return `[Current Status] stake_stopped\n\n${notifyBlock('You have exited the voter pool and will no longer be selected as a juror.')}`;
  return undefined;
}

function missedLines(agentName, phase, jobTitle, jobId, slashTimeoutBps) {
  const lines = [agentName !== undefined
    ? `【⚖️ Your Agent ${agentName} missed [${phase}] for task [${jobTitle}] evaluation — penalty incoming】`
    : `⚖️ You missed [${phase}] for task [${jobTitle}] evaluation — penalty incoming`];
  lines.push(`Task title: ${jobTitle}`, `Task ID: #${jobId}`, `You did not participate in [${phase}]`);
  if (slashTimeoutBps !== undefined) lines.push('🚫 Penalty applied', `• Stake slashed ${slashTimeoutBps}`);
  return lines;
}

function deadlineWarn(event, jobId, message, kind) {
  const jobTitle = m(message, strField, 'jobTitle') ?? '';
  const deadline = m(message, i64Field, kind === 'vote' ? 'commitDeadline' : 'revealDeadline');
  const slashTimeoutBps = m(message, strField, 'slashTimeoutBps');
  const cooldown = m(message, i64Field, 'slashedCooldownSeconds');
  const lines = [`【⏰ URGENT: Evaluation ${kind} for task [${jobTitle}] is about to close】`, `Task title: ${jobTitle}`, `Task ID: #${jobId}`];
  if (deadline !== undefined) {
    const local = fmtLocalTime(deadline), text = minutesLeftText(deadline);
    if (local !== undefined && text !== undefined) lines.push(`${kind === 'vote' ? 'Commit' : 'Reveal'} deadline: ${local} (${text})`);
  }
  lines.push(`Current Status: Agent has not ${kind === 'vote' ? 'committed' : 'revealed'} yet`, '🚨 Timeout consequences:');
  if (slashTimeoutBps !== undefined) lines.push(`• Stake slashed ${slashTimeoutBps}`);
  if (cooldown !== undefined) lines.push(`• Enter a ${BigInt(cooldown) / 3600n}h cooldown during which you cannot be selected`);
  lines.push('• Miss the base validation fee', `⚡ Have the Agent ${kind} immediately`);
  return `[Current Status] ${event}\n\n${notifyBlockLines(lines)}`;
}

// upstream: flow.rs::dispute_next_action
async function disputeNextAction(jobId, event, agentId, message) {
  switch (event) {
    case 'evaluator_selected': {
      const jobTitle = m(message, strField, 'jobTitle') ?? '';
      const agentName = m(message, strField, 'agentName');
      const budget = m(message, displayField, 'budget');
      const tokenSymbol = m(message, strField, 'tokenSymbol');
      const commitDeadline = m(message, i64Field, 'commitDeadline');
      const roundNum = m(message, i64Field, 'roundNum');
      const lines = [agentName !== undefined ? `【Your Agent ${agentName} has been selected as juror for task [${jobTitle}]】` : `You have been selected as juror for task [${jobTitle}]`];
      lines.push(`Task title: ${jobTitle}`, `Task ID: #${jobId}`);
      if (budget !== undefined && tokenSymbol !== undefined) lines.push(`Task Amount: ${budget} ${tokenSymbol}`);
      if (commitDeadline !== undefined) {
        const text = hoursLeftText(commitDeadline);
        if (text !== undefined) lines.push('⏰ Key deadline', `Your Agent must vote within ${text}`);
      }
      const step2 = roundNum !== undefined
        ? '**Step 2 — Fetch evidence:**\n'
          + '```bash\n'
          + `onchainos agent evidence-info ${jobId} --agent-id ${agentId} --round-num ${roundNum}\n`
          + '```\n\n'
          + 'Evidence JSON top-level: `{ title, description, provider: {reason, texts[], files[]}, client: {reason, texts[], files[]} }`. `description` / `title` is the task\'s original definition. Per side: `reason` is the party\'s stated motivation (`provider.reason` = why evaluation was raised; `client.reason` = why delivery was rejected); `texts[]` is free-text evidence; `files[]` is **any file type** (image / PDF / video / archive / unknown binary), already downloaded — each item has `localPath` (absolute path; **the local file has NO extension** — CLI deliberately leaves type detection to the agent).\n\n'
          + '**Post-evidence hard constraints** (only the rules the agent could not infer on its own — tool choice / commands are the agent\'s call):\n'
          + '- `files[]` items arrive **without extensions** by design; probe the type yourself (`file --mime-type`, hexdump, whatever) and use whatever tools you have to inspect each one. If you rename a file to give it an extension, **update the `localPath` you cite in the verdict**.\n'
          + '- **Never vote blindly on an item you could not inspect.** If a file is unreadable for any reason (unsupported format, conversion failed, archive contents inaccessible, download error), cite it in the verdict as `<short reason> — contents unreviewable` and apply the rubric\'s evidence-missing rule for that item.\n'
          + '- **Do not recurse into nested archives** (zip-in-tar-in-gz etc.). One extraction layer at most; deeper = treat as unreviewable.\n'
          + '- A `files[]` item with `downloadError` set = CLI already gave up after 3 retries; treat as missing. Do not re-run `evidence-info` and do not scan local disk for replacements.\n'
        : '**Step 2 aborted** — message envelope is missing `roundNum`; cannot fetch evidence. End this turn and wait for a fresh notification.\n';
      return '[Current Status] evaluator_selected\n\n'
        + "**Step 1 — Notify the user that you've been selected as a juror:**\n\n"
        + `${notifyBlockLines(lines)}\n`
        + '→ **Once Step 1 has attempted the `onchainos agent user-notify` call (whether it succeeds or errors), continue with Step 2 in this same turn.** Step 1 is a user-facing notification, not a precondition for Step 2.\n\n'
        + step2;
    }
    case 'vote_committed': {
      const jobTitle = m(message, strField, 'jobTitle') ?? '';
      const vote = m(message, i64Field, 'vote');
      const lines = [`【Evaluation vote committed for task [${jobTitle}] · waiting for Reveal】`, `Task title: ${jobTitle}`, `Task ID: #${jobId}`];
      if (vote !== undefined) lines.push(`🗳️ Your Agent supports: ${BigInt(vote) === 0n ? 'User' : 'ASP'}`);
      return `[Current Status] vote_committed\n\n${notifyBlockLines(lines)}`;
    }
    case 'vote_commit_deadline_warn': return deadlineWarn(event, jobId, message, 'vote');
    case 'vote_reveal_deadline_warn': return deadlineWarn(event, jobId, message, 'reveal');
    case 'reveal_started':
      return '[Current Status] reveal_started\n\n'
        + '**Step 1 — Execute reveal:**\n'
        + '```bash\n'
        + `onchainos agent vote-reveal ${jobId} --agent-id ${agentId}\n`
        + '```\n\n'
        + '[Error mapping]\n'
        + '- `canReveal=false` → CLI has already pre-checked and rejected; no retry needed. This round may have settled already (wait for dispute_resolved) or you did not commit (normal skip). **End this turn; skip Step 2.**\n'
        + '- `voter has not committed` → you did not commit this round; skipping reveal is normal. **End this turn; skip Step 2.**\n'
        + '- Other failures: retry up to 3 times.\n\n'
        + '**Step 2 — Notify the user that the reveal has been submitted via `onchainos agent user-notify`.**\n\n'
        + notifyBlock(`Your agent has submitted the reveal transaction for Job jobId=${jobId}. Waiting for chain confirmation — no action needed from you.`);
    case 'vote_revealed':
      return `[Current Status] vote_revealed\n\n${notifyBlock(`Your agent has revealed its vote on-chain for Job jobId=${jobId}. Waiting for the evaluation result — no action needed from you.`)}`;
    case 'dispute_resolved': {
      const jobTitle = m(message, strField, 'jobTitle') ?? '';
      const agentName = m(message, strField, 'agentName');
      const vote = m(message, i64Field, 'vote');
      const jobStatus = m(message, strField, 'jobStatus');
      const slashMinorityBps = m(message, strField, 'slashMinorityBps');
      const slashTimeoutBps = m(message, strField, 'slashTimeoutBps');
      const hasCommit = BigInt(m(message, i64Field, 'hasCommit') ?? 1);
      const hasReveal = BigInt(m(message, i64Field, 'hasReveal') ?? 1);
      const yourVote = vote === undefined ? undefined : (BigInt(vote) === 0n ? 'User' : 'ASP');
      const winningSide = jobStatus === 'complete' ? 'ASP' : jobStatus === 'failed' ? 'User' : undefined;
      const branch = hasCommit === 0n ? 'MissedCommit' : hasReveal === 0n ? 'MissedReveal'
        : (yourVote !== undefined && winningSide !== undefined && yourVote === winningSide ? 'Won' : 'Lost');
      if (branch === 'MissedCommit' || branch === 'MissedReveal') {
        const phase = branch === 'MissedCommit' ? 'Commit' : 'Reveal';
        return `[Current Status] dispute_resolved\n\n${notifyBlockLines(missedLines(agentName, phase, jobTitle, jobId, slashTimeoutBps))}\n`
          + `Missed-${phase.toLowerCase()} branch ends this turn; do not call \`arbitration-claim\`.\n${terminalSessionHint(jobId)}`;
      }
      if (branch === 'Won') {
        const lines = [`【🎉 Evaluation result for task [${jobTitle}]: your vote aligned with the majority — reward eligible】`, `Task title: ${jobTitle}`, `Task ID: #${jobId}`];
        if (yourVote !== undefined) lines.push(`Your vote: backed ${yourVote} ✓ aligned with majority`);
        return `[Current Status] dispute_resolved\n\n${notifyBlockLines(lines)}\n`
          + 'Pull claimable then claim:\n'
          + '```bash\n'
          + `onchainos agent arbitration-claimable --agent-id ${agentId}\n`
          + '```\n'
          + 'The last line is the stable marker `hasClaimable: yes | no`. Decide on that line only; do not parse amounts.\n'
          + '- `hasClaimable: no` → end this turn; do not call claim (reward may be pending settlement; a later `reward_claimed` event will close the loop).\n'
          + '- `hasClaimable: yes` →\n'
          + '  ```bash\n'
          + `  onchainos agent arbitration-claim --agent-id ${agentId}\n`
          + '  ```\n'
          + '  ⚠️ Account-level pull: aside from `--agent-id`, pass no other business params. Retry up to 3 times on failure. Final credit confirmation arrives via the later `reward_claimed` event.\n';
      }
      const lines = [`【⚠️ Evaluation result for task [${jobTitle}]: your vote disagreed with the majority — slash penalty incoming】`, `Task title: ${jobTitle}`, `Task ID: #${jobId}`];
      if (yourVote !== undefined) lines.push(`Your vote: backed ${yourVote} ✗ opposed majority`);
      if (slashMinorityBps !== undefined) lines.push('🚫 Penalty applied', `• Stake slashed ${slashMinorityBps}`);
      return `[Current Status] dispute_resolved\n\n${notifyBlockLines(lines)}\n`
        + 'Lost branch ends this turn; do not call `arbitration-claim` (nothing to claim). The slash was conveyed in the notification above — no follow-up event will arrive.\n'
        + terminalSessionHint(jobId);
    }
    case 'cooldown_entered': {
      const s = await fetchMyStake(agentId);
      const local = s === undefined ? undefined : fmtLocalTime(s.cooldownEndsAt);
      const content = local !== undefined
        ? `You've entered the absence cooldown period; you won't be selected as a juror before ${local}.`
        : "You've entered the absence cooldown period and won't be selected as a juror during this period.";
      return `[Current Status] cooldown_entered\n\n${notifyBlock(content)}`;
    }
    case 'round_failed': {
      const jobTitle = m(message, strField, 'jobTitle') ?? '';
      const agentName = m(message, strField, 'agentName');
      const abstainCount = m(message, displayField, 'abstainCount');
      const totalSlashed = m(message, displayField, 'totalSlashed');
      const slashTimeoutBps = m(message, strField, 'slashTimeoutBps');
      const revealCount = m(message, displayField, 'revealCount');
      const hasCommit = BigInt(m(message, i64Field, 'hasCommit') ?? 1);
      const hasReveal = BigInt(m(message, i64Field, 'hasReveal') ?? 1);
      if (hasCommit === 0n || hasReveal === 0n) {
        const phase = hasCommit === 0n ? 'Commit' : 'Reveal';
        return `[Current Status] round_failed\n\n${notifyBlockLines(missedLines(agentName, phase, jobTitle, jobId, slashTimeoutBps))}\n`
          + `Missed-${phase.toLowerCase()} branch ends this turn.\n${terminalSessionHint(jobId)}`;
      }
      const lines = [`【⚖️ Task [${jobTitle}] evaluation round invalidated】`, `Task title: ${jobTitle}`, `Task ID: #${jobId}`, 'Tally: no side reached ≥ 50%'];
      if (abstainCount !== undefined && totalSlashed !== undefined && slashTimeoutBps !== undefined && revealCount !== undefined) {
        lines.push('💰 Abstain-slash pool distribution', `• Source: ${abstainCount} abstainers × ${slashTimeoutBps} = ${totalSlashed} OKB total`, `• Split evenly among ${revealCount} revealers`);
      }
      return `[Current Status] round_failed\n\n${notifyBlockLines(lines)}\n${terminalSessionHint(jobId)}`;
    }
    case 'reward_claimed':
      return `[Current Status] reward_claimed\n\n${notifyBlock('Your evaluation reward has been credited.')}\n${terminalSessionHint(jobId)}`;
    default:
      return undefined;
  }
}

// upstream: flow.rs::evaluator_selected_post_evidence_steps
export function evaluatorSelectedPostEvidenceSteps(jobId, agentId) {
  const RUBRIC = 'skills/okx-ai/references/a2a/evaluator/rubric.md';
  return '→ **Continue with Step 3 in this same turn — it is NOT event-driven.**\n\n'
    + `**Step 3 — Read \`${RUBRIC}\` directly and render the verdict:**\n`
    + `- **Prerequisite — file readability check**: read \`${RUBRIC}\`.\n`
    + '  Read failure / file missing / empty content → **stop this turn immediately** (no commit, no fallback default rules, no search for replacement file). Run `onchainos agent user-notify` (🌐 localize first), then end the turn:\n\n'
    + '```bash\n'
    + 'onchainos agent user-notify --content "<localized content>"\n'
    + '```\n\n'
    + 'Canonical English content (substitute placeholders first):\n'
    + `    Evaluation aborted for task jobId=${jobId}: the decision rubric \`${RUBRIC}\` is missing or unreadable; this round's vote is skipped.\n`
    + '    ⚠️ commit window timeout will slash your stake — please restore the file as soon as possible.\n\n'
    + "- Read success and evidence already output → produce the final `vote` and the verdict text per the rubric's Verdict section (whichever heading defines the verdict template).\n\n"
    + "→ **Once Step 3's verdict text is produced, continue with Step 4 in this same turn.**\n\n"
    + '**Step 4 — Execute commit:**\n'
    + '- **Flatten the entire verdict text into a single line** with `\\n` literal escapes (two characters: `\\` + `n`, not a real newline) replacing every real newline; pass via `--reason`.\n'
    + '- **Compress the verdict into a ≤30-character one-sentence summary** that captures the decision. Count is Unicode characters, not bytes — CJK and Latin characters each count as 1. The CLI hard-fails if the value is empty or exceeds 30 characters. Pass via `--reason-summary`.\n'
    + '```bash\n'
    + `onchainos agent vote-commit ${jobId} --vote <0|1> --reason "<flattened verdict text from Step 3, with every real newline replaced by the two-character escape \\n>" --reason-summary "<≤30-char one-sentence summary>" --agent-id ${agentId}\n`
    + '```\n'
    + '⚠️ **Only 0 (Approve / Client wins) or 1 (Reject / Provider wins) — skip is forbidden**.\n'
    + `⚠️ **The \`<0|1>\` value MUST come from Step 3** — it is the binary vote that Step 3 derived by applying \`${RUBRIC}\` (whatever decision procedure that document defines) to the evidence. Do **not** commit a vote that bypassed Step 3 — guessing / pattern-matching / averaging a value here violates the rubric and produces an unfounded ruling.\n`
    + '⚠️ **`--reason` is the full verdict produced by Step 3**. Empty / whitespace-only values are rejected by the CLI. CLI un-escapes `\\n` → newline, `\\t` → tab, `\\r` → CR, `\\\\` → `\\`, `\\"` → `"` before sending to backend; the backend stores it as the human-readable on-chain audit trail. If the user-customized rubric (no verdict template defined), still pass a minimal one-line reason such as `"Verdict not generated — rubric verdict missing."` \n'
    + '⚠️ **`--reason-summary` is a ≤30-Unicode-character one-sentence headline** distilled from the same verdict — no markdown / line breaks / bullet markers. If you can\'t compress further, drop low-information words first; do not truncate mid-character to dodge the limit (the CLI counts after trim and rejects overflows).\n'
    + '- **Character taboos inside both `--reason` and `--reason-summary` values** (otherwise the shell will corrupt the argument before the CLI even sees it):\n'
    + '  - `"` (double quote) → escape as `\\"`\n'
    + "  - `` ` `` (backtick) → either replace with `'` (single quote) or escape as `` \\` ``; an unescaped backtick triggers shell command substitution\n"
    + '  - `$` → escape as `\\$` to prevent shell variable expansion\n'
    + '  - Real newlines / tabs / CRs → **must** use `\\n` / `\\t` / `\\r` escapes; never embed a literal newline (the command will break across lines)\n'
    + 'Retry up to 3 times on failure (CRITICAL — closing of the commit window triggers timeout slashing).\n';
}
