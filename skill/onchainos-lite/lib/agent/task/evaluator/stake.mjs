// `stake` / `increase-stake` — upstream task/evaluator/stake.rs (plain text).
// Both commands route by `myStake.registered` (increaseStake when registered, else stake).
import { auditLog } from '../../../core/audit.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { at } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { ensureCommunicationReadyPreflight, refreshAgentIdentitiesSilently } from '../common/okx-a2a.mjs';
import { resolveWalletAndAgentForEvaluator, signUopAndBroadcast, extractBizType } from '../signing.mjs';
import * as decimalStr from './decimal-str.mjs';
import { getMyStake, getStakingConfig } from './staking-types.mjs';

// upstream: stake.rs::handle_stake
export async function handleStake(client, amount, agentId) {
  await ensureCommunicationReadyPreflight();
  await run(client, amount, agentId, {
    label: 'stake', amountPrefix: '',
    nextHint: 'stake transaction submitted; waiting for on-chain confirmation. Once confirmed, you become an active evaluator candidate and may be drawn into a jury panel.',
  });
  await refreshAgentIdentitiesSilently();
}

// upstream: stake.rs::handle_increase_stake
export const handleIncreaseStake = (client, amount, agentId) => run(client, amount, agentId, {
  label: 'increase-stake', amountPrefix: '+', nextHint: 'increase-stake submitted; waiting for on-chain confirmation.',
});

// upstream: stake.rs::run
async function run(client, amount, agentIdRaw, ux) {
  const trimmed = validateAmount(amount);
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  const [txHash, endpoint] = await executeStakeOrIncrease(client, trimmed, accountId, address, agentId);
  auditLog('cli', endpoint === 'increaseStake' ? 'evaluator/stake_increased' : 'evaluator/staked', true, 0,
    [`agentId=${agentId}`, `amount=${trimmed}`, `endpoint=${endpoint}`, `txHash=${txHash}`]);
  process.stdout.write(`${ux.label} submitted (agentId=${agentId}, via=${endpoint})\n`
    + `  amount:  ${ux.amountPrefix}${trimmed} OKB\n`
    + `  voter:   ${address}\n`
    + `  txHash:  ${txHash}\n`
    + `next: ${ux.nextHint}\n`);
}

// upstream: stake.rs::validate_amount → trimmed amount
export function validateAmount(amount) {
  const trimmed = trim(amount);
  if (trimmed === '') throw new Error('--amount must not be empty (OKB amount in UI units)');
  if (!/^[0-9.]*$/.test(trimmed)) throw new Error(`--amount must be numeric (OKB amount in UI units); use \`.\` for decimal point and no thousands separators, got: ${trimmed}`);
  return trimmed;
}

// upstream: stake.rs::execute_stake_or_increase → [txHash, endpoint]
export async function executeStakeOrIncrease(client, amount, accountId, address, agentId) {
  let m, cfg;
  try { m = await getMyStake(client, agentId); } catch (e) { throw new Error(`failed to fetch my-stake, cannot route stake vs increase-stake: ${displayTop(e)}`); }
  try { cfg = await getStakingConfig(client, agentId); } catch (e) { throw new Error(`failed to fetch staking-config, cannot validate cumulative stake threshold: ${displayTop(e)}`); }
  const active = m.activeStake, minStr = cfg.minCumulativeStakeOkb;
  let total;
  try { total = decimalStr.add(amount, active); } catch { total = undefined; }
  if (total !== undefined) {
    let less = false;
    try { less = decimalStr.cmp(total, minStr) < 0; } catch { less = false; }
    if (less) {
      let needed;
      try { needed = decimalStr.sub(minStr, active); } catch { needed = minStr; }
      throw new Error(`cumulative stake too low: this ${amount} OKB + current activeStake ${active} OKB < platform minimum ${minStr} OKB (minCumulativeStakeOkb). increase --amount by at least ${needed} OKB.`);
    }
  }
  const endpoint = m.registered ? 'increaseStake' : 'stake';
  const tx = await postAndBroadcast(client, endpoint, amount, accountId, address, agentId);
  return [tx, endpoint];
}

// upstream: stake.rs::post_and_broadcast
async function postAndBroadcast(client, endpoint, amount, accountId, address, agentId) {
  const resp = await client.postWithIdentity(`/priapi/v1/aieco/task/staking/${endpoint}`, { amount }, agentId);
  return signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, '', extractBizType(resp), agentId, undefined);
}
