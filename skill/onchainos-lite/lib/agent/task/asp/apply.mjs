// ASP applies for a job — upstream task/asp/apply.rs (prints plain text).
import { auditLog } from '../../../core/audit.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import { at } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';

// `str.parse::<f64>()` → number | undefined
function parseF64(s) { try { return parseRustF64(s); } catch { return undefined; } }

// upstream: apply.rs::handle_apply
export async function handleApply(client, jobId, tokenAmount, tokenSymbol, agentId) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  const amtTrim = trim(tokenAmount);
  const parsed = parseF64(amtTrim);
  if (amtTrim === '' || !(parsed !== undefined && parsed >= 0)) {
    throw new Error(`--token-amount must be a non-negative number; got \`${tokenAmount}\`. Read the locked \`tokenAmount\` from the task fields (set at accept time) — for a designated assignment use the \`tokenAmount\` carried by the \`JobAspSelected\` envelope. Empty / negative = malformed apply, refusing to broadcast.`);
  }
  if (trim(tokenSymbol) === '') {
    throw new Error(`--token-symbol must not be empty; got \`${tokenSymbol}\`. Read the locked \`tokenSymbol\` from the task fields (set at accept time) — for a designated assignment use the \`tokenSymbol\` carried by the \`JobAspSelected\` envelope. Do NOT assume USDT.`);
  }
  const [accountId, address] = await resolveWalletByAgentId(agentId);
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'apply'), { tokenAmount, tokenSymbol }, agentId);
  const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
  auditLog('cli', 'ASP/apply_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `tokenSymbol=${tokenSymbol}`, `tokenAmount=${tokenAmount}`, `txHash=${txHash}`]);
  process.stdout.write('✓ Application submitted (apply), waiting for on-chain confirmation (provider_applied)\n'
    + `  Quote: ${tokenAmount} ${tokenSymbol}\n`
    + `  txHash: ${txHash}\n`
    + '\n'
    + '⚠️  Next steps are driven by system notifications — do not proactively message the User Agent:\n'
    + '    - You will receive a `provider_applied` system notification after on-chain confirmation\n');
}
