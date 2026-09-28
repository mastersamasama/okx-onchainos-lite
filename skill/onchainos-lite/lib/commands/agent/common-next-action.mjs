// agent next-action — upstream agent_commerce/mod.rs (inline dispatcher + freshness gate).
import { NO_OUTPUT } from '../../core/context.mjs';
import { runPreDispatchMaintenance, runNextAction } from '../../agent/index.mjs';

export default {
  'agent next-action': {
    uses: ['agentId', 'role', 'message', 'a2aFile'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      const prompt = await runNextAction({ agentId: o.agentId, role: o.role, message: o.message, a2aFile: o.a2aFile });
      process.stdout.write(`${prompt}\n`);
      return NO_OUTPUT;
    },
  },
};
