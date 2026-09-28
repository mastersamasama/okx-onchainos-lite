// agent a2mcp-probe commands — upstream commands/agent_commerce/a2mcp_probe/mod.rs::run
// (dispatched from agent_commerce/mod.rs after the per-invocation maintenance prelude).
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import { run, A2mcpProbeCommand } from '../../agent/a2mcp-probe/index.mjs';

const leaf = (kind, uses) => ({
  uses,
  async run(ctx, o) {
    await runPreDispatchMaintenance();
    return run({ kind, ...o });
  },
});

export default {
  'agent a2mcp-probe probe': leaf(A2mcpProbeCommand.Probe, ['routingJson', 'routingBase64', 'paramsJson', 'paramsBase64']),
  'agent a2mcp-probe confirm-free': leaf(A2mcpProbeCommand.ConfirmFree, ['confirmationId', 'yes']),
  'agent a2mcp-probe refresh-balance': leaf(A2mcpProbeCommand.RefreshBalance, ['preparedId']),
  'agent a2mcp-probe funding': leaf(A2mcpProbeCommand.Funding, ['preparedId', 'candidateId']),
  'agent a2mcp-probe resume-after-funding': leaf(A2mcpProbeCommand.ResumeAfterFunding, ['preparedId', 'candidateId', 'yes']),
  'agent a2mcp-probe prepare-payment': leaf(A2mcpProbeCommand.PreparePayment, ['preparedId', 'candidateId', 'yes']),
};
