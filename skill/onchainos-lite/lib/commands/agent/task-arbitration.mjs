// agent arbitration / refund list+detail — upstream task/arbitration.rs and task/refund_list.rs.
import { typed } from '../../core/cli.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { handleArbitrationList, handleArbitrationDetail } from '../../agent/task/arbitration.mjs';
import { handleRefundList, handleRefundDetail } from '../../agent/task/refund-list.mjs';

export default {
  'agent arbitration-list': {
    uses: ['agentId', 'page', 'pageSize'],
    async run(ctx, o) {
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'u32');
      return handleArbitrationList(new TaskApiClient(), o.agentId, page, pageSize);
    },
  },
  'agent arbitration-detail': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      return handleArbitrationDetail(new TaskApiClient(), o.jobId, o.agentId);
    },
  },
  'agent refund-list': {
    uses: ['role', 'scope', 'page', 'pageSize', 'agentId'],
    async run(ctx, o) {
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'u32');
      return handleRefundList(new TaskApiClient(), o.role, o.scope, page, pageSize, o.agentId ?? '');
    },
  },
  'agent refund-detail': {
    uses: ['jobId', 'role', 'agentId'],
    async run(ctx, o) {
      return handleRefundDetail(new TaskApiClient(), o.jobId, o.role, o.agentId ?? '');
    },
  },
};
