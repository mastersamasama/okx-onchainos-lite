// agent ASP (provider) commands — upstream agent_commerce/task/asp/** (dispatch: task/asp/mod.rs
// `run_provider` / `run_dispute` and the flat `AgentCommand` arms in agent_commerce/mod.rs).
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { runProvider, runDispute } from '../../agent/task/asp/index.mjs';
import { handleActive, handleAgreeRefund, handleAspClaim, handleDispute } from '../../agent/task/asp/subscription.mjs';

// Handlers that print their own output return undefined → NO_OUTPUT; JSON handlers return data.
const out = (r) => (r === undefined ? NO_OUTPUT : r);

const provider = (kind, map) => async (ctx, o) => out(await runProvider({ kind, ...map(ctx, o) }));

export default {
  'agent apply': {
    uses: ['jobId', 'tokenAmount', 'tokenSymbol', 'agentId'],
    run: provider('Apply', (ctx, o) => ({ jobId: o.jobId, tokenAmount: o.tokenAmount, tokenSymbol: o.tokenSymbol, agentId: o.agentId })),
  },
  'agent deliver': {
    uses: ['jobId', 'file', 'deliverableText', 'agentId'],
    run: provider('Deliver', (ctx, o) => ({
      jobId: o.jobId, file: o.file, deliverableText: o.deliverableText, agentId: o.agentId,
    })),
  },
  'agent agree-refund': {
    uses: ['jobId', 'agentId'],
    run: provider('AgreeRefund', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId })),
  },
  'agent asp-reject': {
    uses: ['jobId', 'agentId', 'reason'],
    run: provider('AspReject', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId, reason: o.reason })),
  },
  'agent accept-job-by-provider': {
    uses: ['jobId', 'agentId'],
    run: provider('AcceptJobByProvider', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId })),
  },
  'agent decline-job-by-provider': {
    uses: ['jobId', 'agentId', 'reason'],
    run: provider('DeclineJobByProvider', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId, reason: o.reason })),
  },
  'agent accept-subscription': {
    uses: ['jobId', 'agentId'],
    run: provider('AcceptSubscription', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId })),
  },
  'agent decline-subscription': {
    uses: ['jobId', 'agentId', 'reason'],
    run: provider('DeclineSubscription', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId, reason: o.reason })),
  },
  'agent claim-auto-complete': {
    uses: ['jobId', 'agentId'],
    run: provider('ClaimAutoComplete', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId })),
  },
  'agent asp-claimable': {
    uses: ['agentId'],
    run: provider('Claimable', (ctx, o) => ({ agentId: o.agentId })),
  },
  'agent asp-claim-rewards': {
    uses: ['agentId'],
    run: provider('ClaimRewards', (ctx, o) => ({ agentId: o.agentId })),
  },
  'agent asp status': {
    uses: ['jobId', 'agentId'],
    label: 'agent asp status',
    run: provider('Status', (ctx, o) => ({ jobId: o.jobId, agentId: o.agentId })),
  },
  'agent asp list-tasks': {
    uses: ['status', 'page', 'limit', 'agentId'],
    label: 'agent asp list-tasks',
    async run(ctx, o) {
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const limit = typed(ctx.path, 'limit', o.limit, 'u32');
      return out(await runProvider({ kind: 'List', status: o.status, page, limit, agentId: o.agentId }));
    },
  },
  'agent subscribe-active': {
    uses: ['agentId'],
    async run(ctx, o) {
      return handleActive(new TaskApiClient(), o.agentId);
    },
  },
  'agent subscribe-agree-refund': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await handleAgreeRefund(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent subscribe-asp-claim': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await handleAspClaim(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent subscribe-dispute': {
    uses: ['jobId', 'reason', 'agentId'],
    async run(ctx, o) {
      await handleDispute(new TaskApiClient(), o.jobId, o.reason, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent dispute raise': {
    uses: ['jobId', 'reason', 'agentId'],
    label: 'agent dispute Discriminant(0)',
    async run(ctx, o) {
      return out(await runDispute({ kind: 'Raise', jobId: o.jobId, reason: o.reason, agentId: o.agentId }));
    },
  },
  'agent dispute confirm': {
    uses: ['jobId', 'reason', 'reasonB64', 'agentId'],
    label: 'agent dispute Discriminant(1)',
    async run(ctx, o) {
      return out(await runDispute({ kind: 'Confirm', jobId: o.jobId, reason: o.reason, reasonB64: o.reasonB64, agentId: o.agentId }));
    },
  },
};
