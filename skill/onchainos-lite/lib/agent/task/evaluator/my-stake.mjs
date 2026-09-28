// `my-stake` — upstream task/evaluator/my_stake.rs (plain text).
import { getMyStake } from './staking-types.mjs';
import { fmtLocalYmdHmsZ } from './_time.mjs';

// upstream: my_stake.rs::fmt_unix_seconds
export function fmtUnixSeconds(ts, noneLabel) {
  if (BigInt(ts) === 0n) return `0 (${noneLabel})`;
  const local = fmtLocalYmdHmsZ(ts);
  return local === undefined ? `${ts} (unparseable)` : `${ts} (${local})`;
}

// upstream: my_stake.rs::handle_my_stake
export async function handleMyStake(client, agentId) {
  const s = await getMyStake(client, agentId);
  process.stdout.write('my stake (on-chain staking state)\n'
    + `  voter address      : ${s.voterAddress}\n`
    + `  agentId            : ${s.agentId} (registered=${s.registered})\n`
    + `  activeStake        : ${s.activeStake} OKB  # currently staked (net of slashing)\n`
    + `  pendingUnstake     : ${s.pendingUnstake} OKB  # in cooldown, awaiting unlock\n`
    + `  validStake         : ${s.validStake} OKB  # weight-eligible = activeStake - pendingUnstake\n`
    + `  activeDisputes     : ${s.activeDisputes}  # evaluations in progress (unstake available when 0)\n`
    + `  unstakeAvailableAt : ${fmtUnixSeconds(s.unstakeAvailableAt, 'no pending unstake')}\n`
    + `  cooldownEndsAt     : ${fmtUnixSeconds(s.cooldownEndsAt, 'not in slashing cooldown')}\n`);
}
