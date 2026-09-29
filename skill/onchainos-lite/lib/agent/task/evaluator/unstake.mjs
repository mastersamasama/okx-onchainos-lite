// `request-unstake` / `claim-unstake` / `cancel-unstake` — upstream task/evaluator/unstake.rs.
import { auditLog } from '../../../core/audit.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { at } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { nowSecs, fmtLocalYmdHmsZ } from '../../../core/rs/time.mjs';
import { resolveWalletAndAgentForEvaluator, signUopAndBroadcast, extractBizType } from '../signing.mjs';
import * as decimalStr from './decimal-str.mjs';
import { getMyStake, getStakingConfig, unstakeCooldownDays } from './staking-types.mjs';

// upstream: unstake.rs::fmt_local_ts
export function fmtLocalTs(ts) {
  const local = fmtLocalYmdHmsZ(ts);
  return local === undefined ? String(ts) : `${ts} (local time ${local})`;
}

async function stakingPost(client, path, body, accountId, address, agentId) {
  const resp = await client.postWithIdentity(path, body, agentId);
  return signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, '', extractBizType(resp), agentId, undefined);
}

// upstream: unstake.rs::handle_request_unstake
export async function handleRequestUnstake(client, amount, agentIdRaw) {
  const trimmed = trim(amount);
  if (trimmed === '') throw new Error('--amount must not be empty (OKB amount in UI units, e.g. 50)');
  if (!/^[0-9.]*$/.test(trimmed)) throw new Error(`--amount must be numeric (OKB amount in UI units, no precision suffix), got: ${trimmed}`);
  let positive;
  try { positive = decimalStr.cmp(trimmed, '0'); } catch (e) { throw new Error(`--amount parse failed (invalid format), got: ${trimmed}: ${e.message}`); }
  if (positive !== 1) throw new Error(`--amount must be > 0, got: ${trimmed}`);

  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  let m;
  try { m = await getMyStake(client, agentId); } catch (e) { throw new Error(`failed to fetch my-stake, cannot validate request-unstake preconditions: ${displayTop(e)}`); }
  const disputes = /^\+?[0-9]+$/.test(m.activeDisputes) && BigInt(m.activeDisputes) <= 18446744073709551615n ? BigInt(m.activeDisputes) : 0n;
  if (disputes > 0n) throw new Error(`${disputes} evaluation(s) are in progress; unstake becomes available after they are settled.`);
  const active = m.activeStake;
  let over;
  try { over = decimalStr.cmp(trimmed, active); } catch (e) { throw new Error(`activeStake parse failed (${active}): ${e.message}`); }
  if (over === 1) throw new Error(`--amount ${trimmed} OKB exceeds current activeStake ${active} OKB; max unstake is ${active} OKB (full redemption).`);

  let cfg;
  try { cfg = await getStakingConfig(client, agentId); } catch (e) { throw new Error(`failed to fetch staking-config, cannot validate partial-unstake min retain: ${displayTop(e)}`); }
  const retain = cfg.partialUnstakeMinRetainOkb;
  let remaining;
  try { remaining = decimalStr.sub(active, trimmed); } catch (e) { throw new Error(`unstake pre-check: activeStake ${active} - amount ${trimmed} computation failed: ${e.message}`); }
  let isFull = false;
  try { isFull = decimalStr.cmp(remaining, '0') === 0; } catch { isFull = false; }
  if (!isFull) {
    let below;
    try { below = decimalStr.cmp(remaining, retain) === -1; } catch (e) { throw new Error(`partialUnstakeMinRetainOkb parse failed (${retain}): ${e.message}`); }
    if (below) {
      throw new Error(`partial unstake would leave ${remaining} OKB, below min retain ${retain} OKB (partialUnstakeMinRetainOkb). switch to full redemption (amount = ${active} OKB), or reduce --amount so remaining >= ${retain} OKB.`);
    }
  }

  const txHash = await stakingPost(client, '/priapi/v1/aieco/task/staking/requestUnstake', { amount: trimmed }, accountId, address, agentId);
  auditLog('cli', 'evaluator/unstake_requested', true, 0, [`agentId=${agentId}`, `amount=${trimmed}`, `txHash=${txHash}`]);
  process.stdout.write(`request-unstake submitted (agentId=${agentId})\n`
    + `  amount:  -${trimmed} OKB (pending)\n`
    + `  voter:   ${address}\n`
    + `  txHash:  ${txHash}\n`
    + `next: request submitted, awaiting on-chain confirmation; after confirm, enters ${unstakeCooldownDays(cfg)}-day cooldown — claimable on expiry, cancellable during cooldown.\n`
    + `  config: partial-unstake min retain ${cfg.partialUnstakeMinRetainOkb} OKB (below this, only full redemption is allowed)\n`);
}

// upstream: unstake.rs::handle_claim_unstake
export async function handleClaimUnstake(client, agentIdRaw) {
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  let m;
  try { m = await getMyStake(client, agentId); } catch { m = undefined; }
  if (m !== undefined) {
    const at0 = BigInt(m.unstakeAvailableAt);
    if (at0 === 0n) throw new Error('no pending unstake request to claim. Submit an unstake request first.');
    if (BigInt(nowSecs()) < at0) throw new Error(`unstake cooldown not finished (unlocks at ${fmtLocalTs(m.unstakeAvailableAt)}); claim after expiry.`);
  }
  const txHash = await stakingPost(client, '/priapi/v1/aieco/task/staking/claimUnstake', {}, accountId, address, agentId);
  auditLog('cli', 'evaluator/unstake_claimed', true, 0, [`agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write(`claim-unstake submitted (agentId=${agentId})\n`
    + `  voter:   ${address}\n`
    + `  txHash:  ${txHash}\n`
    + 'next: claim tx submitted, awaiting on-chain confirmation and settlement.\n');
}

// upstream: unstake.rs::handle_cancel_unstake
export async function handleCancelUnstake(client, agentIdRaw) {
  const [accountId, address, agentId] = await resolveWalletAndAgentForEvaluator(agentIdRaw);
  let m;
  try { m = await getMyStake(client, agentId); } catch { m = undefined; }
  if (m !== undefined) {
    const at0 = BigInt(m.unstakeAvailableAt);
    if (at0 === 0n) throw new Error('no pending unstake request to cancel.');
    if (BigInt(nowSecs()) >= at0) throw new Error('unstake cooldown has finished and the request is already claimable; cancel is no longer valid. Use claim-unstake instead.');
  }
  const txHash = await stakingPost(client, '/priapi/v1/aieco/task/staking/cancelUnstake', {}, accountId, address, agentId);
  auditLog('cli', 'evaluator/unstake_cancelled', true, 0, [`agentId=${agentId}`, `txHash=${txHash}`]);
  process.stdout.write(`cancel-unstake submitted (agentId=${agentId})\n`
    + `  voter:   ${address}\n`
    + `  txHash:  ${txHash}\n`
    + 'next: cancel tx submitted, awaiting on-chain confirmation; stake will be restored after confirm.\n');
}
