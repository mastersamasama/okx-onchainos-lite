// `staking-config` — upstream task/evaluator/staking_config.rs (plain text; agentId used raw).
import { getStakingConfig, unstakeCooldownDays, commitPhaseHours, revealPhaseHours, slashedCooldownHours } from './staking-types.mjs';

// upstream: staking_config.rs::handle_staking_config
export async function handleStakingConfig(client, agentId) {
  const cfg = await getStakingConfig(client, agentId);
  process.stdout.write('staking & evaluation config\n'
    + `  minCumulativeStakeOkb       : ${cfg.minCumulativeStakeOkb} OKB\n`
    + `  partialUnstakeMinRetainOkb  : ${cfg.partialUnstakeMinRetainOkb} OKB\n`
    + `  unstakeCooldownDays         : ${unstakeCooldownDays(cfg)}\n`
    + `  arbitrationFeeBps           : ${cfg.arbitrationFeeBps}\n`
    + `  commitPhaseHours            : ${commitPhaseHours(cfg)}\n`
    + `  revealPhaseHours            : ${revealPhaseHours(cfg)}\n`
    + `  slashMinorityBps            : ${cfg.slashMinorityBps}\n`
    + `  slashTimeoutBps             : ${cfg.slashTimeoutBps}\n`
    + `  slashedCooldownHours        : ${slashedCooldownHours(cfg)}\n`);
}
