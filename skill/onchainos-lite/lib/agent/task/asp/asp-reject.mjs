// ASP declines a designated assignment (off-chain) — upstream task/asp/asp_reject.rs.
import { auditLog } from '../../../core/audit.mjs';
import { get, asI64, asStr } from '../../../core/rs/value.mjs';

// upstream: asp_reject.rs::handle_asp_reject (prints plain text)
export async function handleAspReject(client, jobId, agentId, reason) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  const body = reason === '' ? {} : { reason };
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'asp/reject'), body, agentId);
  auditLog('cli', 'ASP/asp_reject_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `reason=${reason}`]);
  let out = `✓ Designation declined for jobId=${jobId}\n`;
  const code = asI64(get(resp, 'code'));
  if (code !== undefined) out += `  backend code: ${code}\n`;
  const msg = asStr(get(resp, 'msg'));
  if (msg !== undefined) out += `  backend msg:  ${msg}\n`;
  out += '\n'
    + '⚠️  This is an off-chain decline. Next steps:\n'
    + '    - Do NOT call `apply`. Do NOT proceed to the JobCreated playbook.\n'
    + '    - The User Agent is now free to designate a different ASP or fall back to public.\n'
    + '    - No further system events are expected for this jobId on your side.\n';
  process.stdout.write(out);
}
