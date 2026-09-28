// agent arbitration / refund list+detail — upstream task/arbitration.rs and task/refund_list.rs.
import { typed } from '../../core/cli.mjs';
import { UsageError } from '../../core/errors.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import { handleArbitrationList, handleArbitrationDetail } from '../../agent/task/arbitration.mjs';
import { handleRefundList, handleRefundDetail } from '../../agent/task/refund-list.mjs';

// clap `value_parser!(u32).range(1..)` value error (exit 2, no usage block).
function rangeAtLeast1(ctx, name, flag, raw) {
  const v = typed(ctx.path, name, raw, 'u32');
  if (Number(v) < 1) throw new UsageError(`error: invalid value '${raw}' for '${flag}': ${v} is not in 1..=4294967295\n\nFor more information, try '--help'.\n`);
  return v;
}
// clap validates each value when its occurrence is consumed, so the first offending flag in
// argv order is the one reported (`--page-size 0 --page 0` → --page-size). Returns the long
// names in the order they first appear after the subcommand token.
function argvOrder(argv, sub, longs) {
  const start = Array.isArray(argv) ? argv.indexOf(sub) : -1;
  const pos = (long) => {
    if (start < 0) return Infinity;
    for (let i = start + 1; i < argv.length; i++) {
      if (argv[i] === '--') break;
      if (argv[i] === `--${long}` || argv[i].startsWith(`--${long}=`)) return i;
    }
    return Infinity;
  };
  return [...longs].sort((a, b) => pos(a) - pos(b));
}
function pageArgs(ctx, o, sub) {
  const spec = { page: ['page', '--page <PAGE>', o.page], 'page-size': ['pageSize', '--page-size <PAGE_SIZE>', o.pageSize] };
  const got = {};
  for (const long of argvOrder(ctx.argv, sub, ['page', 'page-size'])) {
    const [name, flag, raw] = spec[long];
    got[name] = rangeAtLeast1(ctx, name, flag, raw);
  }
  return got;
}

export default {
  'agent arbitration-list': {
    uses: ['agentId', 'page', 'pageSize'],
    async run(ctx, o) {
      const { page, pageSize } = pageArgs(ctx, o, 'arbitration-list');
      await runPreDispatchMaintenance();
      return handleArbitrationList(new TaskApiClient(), o.agentId, page, pageSize);
    },
  },
  'agent arbitration-detail': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleArbitrationDetail(new TaskApiClient(), o.jobId, o.agentId);
    },
  },
  'agent refund-list': {
    uses: ['role', 'scope', 'page', 'pageSize', 'agentId'],
    async run(ctx, o) {
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'u32');
      await runPreDispatchMaintenance();
      return handleRefundList(new TaskApiClient(), o.role, o.scope, page, pageSize, o.agentId ?? '');
    },
  },
  'agent refund-detail': {
    uses: ['jobId', 'role', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleRefundDetail(new TaskApiClient(), o.jobId, o.role, o.agentId ?? '');
    },
  },
};
