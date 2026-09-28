// agent evaluator (arbitration juror + staking) commands — upstream agent_commerce/task/evaluator/**
// (flat `AgentCommand` arms in agent_commerce/mod.rs). All print plain text.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { handleInfo } from '../../agent/task/evaluator/info.mjs';
import { handleCommit } from '../../agent/task/evaluator/commit.mjs';
import { handleReveal } from '../../agent/task/evaluator/reveal.mjs';
import { handleClaim } from '../../agent/task/evaluator/claim.mjs';
import { handleClaimable } from '../../agent/task/evaluator/claimable.mjs';
import { handleStake, handleIncreaseStake } from '../../agent/task/evaluator/stake.mjs';
import { handleRequestUnstake, handleClaimUnstake, handleCancelUnstake } from '../../agent/task/evaluator/unstake.mjs';
import { handleStakingConfig } from '../../agent/task/evaluator/staking-config.mjs';
import { handleMyStake } from '../../agent/task/evaluator/my-stake.mjs';

const printing = (fn) => async (ctx, o) => {
  await runPreDispatchMaintenance();
  await fn(new TaskApiClient(), o);
  return NO_OUTPUT;
};

export default {
  'agent evidence-info': {
    uses: ['jobId', 'agentId', 'roundNum'],
    run: printing((c, o) => handleInfo(c, o.jobId, o.agentId, o.roundNum)),
  },
  'agent vote-commit': {
    uses: ['jobId', 'vote', 'reason', 'reasonSummary', 'agentId'],
    async run(ctx, o) {
      const vote = typed(ctx.path, 'vote', o.vote, 'u8');
      return printing((c) => handleCommit(c, o.jobId, vote, o.reason, o.reasonSummary, o.agentId))(ctx, o);
    },
  },
  'agent vote-reveal': {
    uses: ['jobId', 'agentId'],
    run: printing((c, o) => handleReveal(c, o.jobId, o.agentId)),
  },
  'agent arbitration-claim': {
    uses: ['agentId'],
    run: printing((c, o) => handleClaim(c, o.agentId)),
  },
  'agent arbitration-claimable': {
    uses: ['agentId'],
    run: printing((c, o) => handleClaimable(c, o.agentId)),
  },
  'agent stake': {
    uses: ['amount', 'agentId'],
    run: printing((c, o) => handleStake(c, o.amount, o.agentId)),
  },
  'agent increase-stake': {
    uses: ['amount', 'agentId'],
    run: printing((c, o) => handleIncreaseStake(c, o.amount, o.agentId)),
  },
  'agent request-unstake': {
    uses: ['amount', 'agentId'],
    run: printing((c, o) => handleRequestUnstake(c, o.amount, o.agentId)),
  },
  'agent claim-unstake': {
    uses: ['agentId'],
    run: printing((c, o) => handleClaimUnstake(c, o.agentId)),
  },
  'agent cancel-unstake': {
    uses: ['agentId'],
    run: printing((c, o) => handleCancelUnstake(c, o.agentId)),
  },
  'agent staking-config': {
    uses: ['agentId'],
    run: printing((c, o) => handleStakingConfig(c, o.agentId)),
  },
  'agent my-stake': {
    uses: ['agentId'],
    run: printing((c, o) => handleMyStake(c, o.agentId)),
  },
};
