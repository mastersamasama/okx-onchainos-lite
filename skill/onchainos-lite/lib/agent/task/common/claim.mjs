// Account-level reward claim — upstream task/common/claim.rs.
import { at, asStr, asArray } from '../../_rs.mjs';
import { signUopAndBroadcast, extractBizType } from '../signing.mjs';

// upstream: claim.rs::submit_claim_and_broadcast → txHash (FUND-MOVING)
export async function submitClaimAndBroadcast(client, accountId, address, agentId) {
  const resp = await client.postWithIdentity('/priapi/v1/aieco/task/claim', {}, agentId);
  return signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, '', extractBizType(resp), agentId, undefined);
}

// Rust `{:<8}` / `{:>30}` (char-count padding).
const padEnd = (s, w) => { const n = [...s].length; return n >= w ? s : s + ' '.repeat(w - n); };
const padStart = (s, w) => { const n = [...s].length; return n >= w ? s : ' '.repeat(w - n) + s; };

// upstream: claim.rs::fetch_and_print_claimable → has_nonzero (prints the table to stdout)
export async function fetchAndPrintClaimable(client, agentId) {
  const resp = await client.getWithIdentity('/priapi/v1/aieco/task/claimable', agentId);
  const account = asStr(at(resp, 'account')) ?? '';
  let out = `claimable rewards (account=${account}, agentId=${agentId})\n`;
  const rewards = asArray(at(resp, 'rewards'));
  let hasNonzero = false;
  if (rewards && rewards.length) {
    for (const r of rewards) {
      const symbol = asStr(at(r, 'symbol')) ?? '?';
      const amount = asStr(at(r, 'amount')) ?? '0';
      const token = asStr(at(r, 'tokenAddress')) ?? '';
      const raw = asStr(at(r, 'rawAmount')) ?? '0';
      const nonzero = raw !== '0' && raw !== '';
      if (nonzero) hasNonzero = true;
      out += `  ${nonzero ? '•' : ' '} ${padEnd(symbol, 8)} ${padStart(amount, 30)}  (token=${token})\n`;
    }
  } else out += '  (no rewards)\n';
  process.stdout.write(out);
  return hasNonzero;
}
