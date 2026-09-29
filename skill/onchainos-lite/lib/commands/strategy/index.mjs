// `onchainos strategy …` handlers — the behaviour lives in lib/wallet/strategy (mirror of
// commands/agentic_wallet/strategy).
import { typed } from '../../core/cli.mjs';
import { execute } from '../../wallet/strategy/index.mjs';
import { parseDirectionValue } from '../../wallet/strategy/handlers.mjs';

export default {
  'strategy create-limit': {
    uses: ['chainId', 'fromToken', 'toToken', 'amount', 'triggerPrice', 'slippage', 'mevProtection', 'direction', 'currentPrice', 'wait'],
    // upstream: handlers.rs — `value_parser = parse_direction_value`
    parsers: { direction: parseDirectionValue },
    run: (ctx, o) => execute(ctx, 'create-limit', o),
  },
  'strategy cancel': {
    uses: ['orderId', 'orderIds', 'all', 'wait'],
    run: (ctx, o) => execute(ctx, 'cancel', o),
  },
  'strategy list': {
    uses: ['orderId', 'status', 'chainId', 'token', 'limit', 'cursor', 'strategyMode'],
    async run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'i32');
      const strategyMode = typed(ctx.path, 'strategyMode', o.strategyMode, 'i32');
      return execute(ctx, 'list', { ...o, limit, strategyMode });
    },
  },
  'strategy resume': {
    uses: ['orderIds', 'wait'],
    run: (ctx, o) => execute(ctx, 'resume', o),
  },
};
