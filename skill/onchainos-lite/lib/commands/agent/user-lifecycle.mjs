// agent user-lifecycle commands — upstream task/user/{asp_ops,refund,close,claim_auto_refund,
// subscription_ops,subscription_list}.rs and v2/complete.rs, dispatched through
// agent_commerce/mod.rs → task::user::run_task.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import * as aspOps from '../../agent/task/user/asp-ops.mjs';
import * as refund from '../../agent/task/user/refund.mjs';
import * as subscriptionOps from '../../agent/task/user/subscription-ops.mjs';
import { handleSubscriptionList } from '../../agent/task/user/subscription-list.mjs';
import { handleClose } from '../../agent/task/user/close.mjs';
import { handleClaimAutoRefund } from '../../agent/task/user/claim-auto-refund.mjs';
import * as complete from '../../agent/task/user/v2/complete.mjs';

const print = (s) => { process.stdout.write(s); return NO_OUTPUT; };
const jsonOrText = (r) => (r.json !== undefined ? r.json : print(r.text));

export default {
  'agent asp-match': {
    uses: ['jobId', 'providerAgentId', 'paymentTokenAmount', 'page', 'agentId', 'format'],
    async run(ctx, o) {
      const amount = typed(ctx.path, 'paymentTokenAmount', o.paymentTokenAmount, 'f64');
      const page = typed(ctx.path, 'page', o.page, 'usize');
      return jsonOrText(await aspOps.handleAspMatch(new TaskApiClient(), o.jobId, o.providerAgentId, amount, page, o.agentId, o.format));
    },
  },
  'agent task-service-select': {
    uses: ['keywords', 'aspAgentId', 'aspName', 'serviceName', 'sid', 'minPaymentTokenAmount', 'maxPaymentTokenAmount', 'searchAfter', 'limit', 'agenticId', 'format'],
    async run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'u64');
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
      await aspOps.handleSetAsp(new TaskApiClient(), o.jobId, o.providerAgentId, o.serviceId, o.serviceType, o.serviceParams, o.serviceTokenAddress,
        o.serviceTokenAmount, o.paymentTokenSymbol, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent reset-asp': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await aspOps.handleResetAsp(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent user-reject': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await aspOps.handleUserReject(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent complete': {
    uses: ['jobId'],
    async run(ctx, o) {
      return complete.handle(new TaskApiClient(), o.jobId);
    },
  },
  // `agent reject` (disabled stub inline in user/mod.rs::run_task) is registered by
  // commands/agent/user-create.mjs, which owns run_task.
  'agent refund-prepare': {
    uses: ['jobId', 'reason'],
    async run(ctx, o) {
      return refund.handlePrepare(new TaskApiClient(), o.jobId, o.reason);
    },
  },
  'agent refund-execute': {
    uses: ['jobId', 'operation', 'refundContextId', 'reason', 'confirm'],
    async run(ctx, o) {
      return refund.handleExecute(new TaskApiClient(), o.jobId, o.operation, o.refundContextId, o.reason, !!o.confirm);
    },
  },
  'agent close': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      return handleClose(new TaskApiClient(), o.jobId, o.agentId);
    },
  },
  'agent claim-auto-refund': {
    uses: ['jobId'],
    async run(ctx, o) {
      return handleClaimAutoRefund(new TaskApiClient(), o.jobId);
    },
  },
  'agent subscribe-cancel': {
    uses: ['subId'],
    async run(ctx, o) {
      await subscriptionOps.handleSubscribeCancel(new TaskApiClient(), o.subId);
      return NO_OUTPUT;
    },
  },
  'agent start-autorenew': {
    uses: ['subId'],
    async run(ctx, o) {
      await subscriptionOps.handleStartAutorenew(new TaskApiClient(), o.subId);
      return NO_OUTPUT;
    },
  },
  'agent subscribe-reject': {
    uses: ['subId', 'reason'],
    async run(ctx, o) {
      return subscriptionOps.handleSubscribeReject(new TaskApiClient(), o.subId, '');
    },
  },
  'agent subscribe-detail': {
    uses: ['subId', 'format'],
    async run(ctx, o) {
      return jsonOrText(await subscriptionOps.handleSubscribeDetail(new TaskApiClient(), o.subId, o.format));
    },
  },
  'agent subscribe-cost': {
    uses: [],
    async run() {
      return subscriptionOps.handleSubscribeCost(new TaskApiClient());
    },
  },
  'agent my-subscriptions': {
    uses: ['role', 'status'],
    // upstream: subscription_ops.rs — `value_parser = parse_status_filter`
    parsers: { status: subscriptionOps.parseStatusFilter },
    async run(ctx, o) {
      return subscriptionOps.handleMySubscriptions(new TaskApiClient(), o.role, o.status);
    },
  },
  'agent subscription-list': {
    uses: ['cursor', 'pageSize'],
    async run(ctx, o) {
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'u32');
      return handleSubscriptionList(o.cursor, pageSize);
    },
  },
};
