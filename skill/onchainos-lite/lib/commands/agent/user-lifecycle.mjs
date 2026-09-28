// agent user-lifecycle commands — upstream task/user/{asp_ops,refund,close,claim_auto_refund,
// subscription_ops,subscription_list}.rs and v2/complete.rs, dispatched through
// agent_commerce/mod.rs → task::user::run_task.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { UsageError } from '../../core/errors.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import * as aspOps from '../../agent/task/user/asp-ops.mjs';
import * as refund from '../../agent/task/user/refund.mjs';
import * as subscriptionOps from '../../agent/task/user/subscription-ops.mjs';
import { handleSubscriptionList } from '../../agent/task/user/subscription-list.mjs';
import { handleClose } from '../../agent/task/user/close.mjs';
import { handleClaimAutoRefund } from '../../agent/task/user/claim-auto-refund.mjs';
import * as complete from '../../agent/task/user/v2/complete.mjs';

const print = (s) => { process.stdout.write(s); return NO_OUTPUT; };
const jsonOrText = (r) => (r.json !== undefined ? r.json : print(r.text));

// clap value error for a value parser rejection (no usage block, exit 2).
const valueError = (raw, display, msg) => new UsageError(`error: invalid value '${raw}' for '${display}': ${msg}\n\nFor more information, try '--help'.\n`);

// upstream: `--page-size` = value_parser!(u32).range(1..=100)
function pageSizeRange(ctx, raw) {
  const v = typed(ctx.path, 'pageSize', raw, 'u32');
  if (v < 1 || v > 100) throw valueError(raw, '--page-size <PAGE_SIZE>', `${v} is not in 1..=100`);
  return v;
}

// upstream: `--status` = subscription_ops::parse_status_filter
function statusFilter(raw) {
  if (raw === undefined || raw === null) return undefined;
  try { return subscriptionOps.parseStatusFilter(String(raw)); } catch (e) { throw valueError(raw, '--status <STATUS>', e.message); }
}

export default {
  'agent asp-match': {
    uses: ['jobId', 'providerAgentId', 'paymentTokenAmount', 'page', 'agentId', 'format'],
    async run(ctx, o) {
      const amount = typed(ctx.path, 'paymentTokenAmount', o.paymentTokenAmount, 'f64');
      const page = typed(ctx.path, 'page', o.page, 'usize');
      await runPreDispatchMaintenance();
      return jsonOrText(await aspOps.handleAspMatch(new TaskApiClient(), o.jobId, o.providerAgentId, amount, page, o.agentId, o.format));
    },
  },
  'agent task-service-select': {
    uses: ['keywords', 'aspAgentId', 'aspName', 'serviceName', 'sid', 'minPaymentTokenAmount', 'maxPaymentTokenAmount', 'searchAfter', 'limit', 'agenticId', 'format'],
    async run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'u64');
      await runPreDispatchMaintenance();
      const args = {
        keywords: o.keywords ?? [], aspAgentId: o.aspAgentId, aspName: o.aspName, serviceName: o.serviceName, sid: o.sid,
        minPaymentTokenAmount: o.minPaymentTokenAmount, maxPaymentTokenAmount: o.maxPaymentTokenAmount, searchAfter: o.searchAfter, limit,
      };
      return jsonOrText(await aspOps.handleTaskServiceSelect(new TaskApiClient(), args, o.agenticId, o.format));
    },
  },
  'agent set-asp': {
    uses: ['jobId', 'providerAgentId', 'serviceId', 'serviceType', 'serviceParams', 'serviceTokenAddress', 'serviceTokenAmount', 'paymentTokenSymbol', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await aspOps.handleSetAsp(new TaskApiClient(), o.jobId, o.providerAgentId, o.serviceId, o.serviceType, o.serviceParams, o.serviceTokenAddress,
        o.serviceTokenAmount, o.paymentTokenSymbol, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent reset-asp': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await aspOps.handleResetAsp(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent user-reject': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await aspOps.handleUserReject(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent complete': {
    uses: ['jobId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return complete.handle(new TaskApiClient(), o.jobId);
    },
  },
  // `agent reject` (disabled stub inline in user/mod.rs::run_task) is registered by
  // commands/agent/user-create.mjs, which owns run_task.
  'agent refund-prepare': {
    uses: ['jobId', 'reason'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return refund.handlePrepare(new TaskApiClient(), o.jobId, o.reason);
    },
  },
  'agent refund-execute': {
    uses: ['jobId', 'operation', 'refundContextId', 'reason', 'confirm'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return refund.handleExecute(new TaskApiClient(), o.jobId, o.operation, o.refundContextId, o.reason, !!o.confirm);
    },
  },
  'agent close': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleClose(new TaskApiClient(), o.jobId, o.agentId);
    },
  },
  'agent claim-auto-refund': {
    uses: ['jobId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleClaimAutoRefund(new TaskApiClient(), o.jobId);
    },
  },
  'agent subscribe-cancel': {
    uses: ['subId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await subscriptionOps.handleSubscribeCancel(new TaskApiClient(), o.subId);
      return NO_OUTPUT;
    },
  },
  'agent start-autorenew': {
    uses: ['subId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await subscriptionOps.handleStartAutorenew(new TaskApiClient(), o.subId);
      return NO_OUTPUT;
    },
  },
  'agent subscribe-reject': {
    uses: ['subId', 'reason'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return subscriptionOps.handleSubscribeReject(new TaskApiClient(), o.subId, '');
    },
  },
  'agent subscribe-detail': {
    uses: ['subId', 'format'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return jsonOrText(await subscriptionOps.handleSubscribeDetail(new TaskApiClient(), o.subId, o.format));
    },
  },
  'agent subscribe-cost': {
    uses: [],
    async run() {
      await runPreDispatchMaintenance();
      return subscriptionOps.handleSubscribeCost(new TaskApiClient());
    },
  },
  'agent my-subscriptions': {
    uses: ['role', 'status'],
    async run(ctx, o) {
      const status = statusFilter(o.status);
      await runPreDispatchMaintenance();
      return subscriptionOps.handleMySubscriptions(new TaskApiClient(), o.role, status);
    },
  },
  'agent subscription-list': {
    uses: ['cursor', 'pageSize'],
    async run(ctx, o) {
      const pageSize = pageSizeRange(ctx, o.pageSize);
      await runPreDispatchMaintenance();
      return handleSubscriptionList(o.cursor, pageSize);
    },
  },
};
