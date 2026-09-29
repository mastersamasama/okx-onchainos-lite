// Read-only user query commands — upstream task/user/query.rs (`payment`).
import { get, asStr, asI64 } from '../../../core/rs/value.mjs';
import { resolveAgentId } from '../common/query.mjs';
import { AGENT_ROLE_USER, XLAYER_CHAIN_ID, PaymentMode } from '../common/index.mjs';

// upstream: query.rs::handle_payment — prints the 7-line invoice itself.
export async function handlePayment(client, jobId, agentIdRaw) {
  const agentId = await resolveAgentId(agentIdRaw, AGENT_ROLE_USER);
  const task = await client.getWithIdentity(client.taskPath(jobId), agentId);
  const amount = asStr(get(task, 'tokenAmount')) ?? '?';
  const tokenSymbol = asStr(get(task, 'tokenSymbol')) ?? '?';
  const providerAddr = asStr(get(task, 'providerAgentAddress')) ?? '?';
  const modeInt = Number(BigInt.asIntN(32, BigInt(asI64(get(task, 'paymentMode')) ?? 0)));
  const paymentMode = PaymentMode.asStr(PaymentMode.fromInt(modeInt));
  process.stdout.write('Payment invoice\n'
    + `  jobId:        ${jobId}\n`
    + `  Amount:       ${amount} ${tokenSymbol}\n`
    + `  Token:        ${tokenSymbol} (XLayer)\n`
    + `  Recipient:    ${providerAddr}\n`
    + `  Payment mode: ${paymentMode}\n`
    + `  Chain:        xlayer (chainId=${XLAYER_CHAIN_ID})\n`);
}
