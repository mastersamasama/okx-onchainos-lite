// `onchainos strategy …` handlers — clap-level parsing (value parsers, conflicts) done here, the
// behaviour lives in lib/wallet/strategy (mirror of commands/agentic_wallet/strategy).
import { clap } from './_clap.mjs';
import { execute } from '../../wallet/strategy/index.mjs';
import { parseDirectionValue } from '../../wallet/strategy/handlers.mjs';

export default {
  'strategy create-limit': {
    uses: ['chainId', 'fromToken', 'toToken', 'amount', 'triggerPrice', 'slippage', 'mevProtection', 'direction', 'currentPrice', 'wait'],
    async run(ctx, o) {
      const { direction } = clap(ctx, o, { types: { direction: parseDirectionValue } });
      return execute(ctx, 'create-limit', { ...o, direction });
    },
  },
  'strategy cancel': {
    uses: ['orderId', 'orderIds', 'all', 'wait'],
    async run(ctx, o) {
      // handlers.rs::CancelArgs — conflicts_with_all on each of the three selectors
      clap(ctx, o, {}, { orderId: ['orderIds', 'all'], orderIds: ['orderId', 'all'], all: ['orderId', 'orderIds'] });
      return execute(ctx, 'cancel', o);
    },
  },
  'strategy list': {
    uses: ['orderId', 'status', 'chainId', 'token', 'limit', 'cursor', 'strategyMode'],
    async run(ctx, o) {
      const { limit, strategyMode } = clap(ctx, o, { types: { limit: 'i32', strategyMode: 'i32' } });
      return execute(ctx, 'list', { ...o, limit, strategyMode });
    },
  },
  'strategy resume': {
    uses: ['orderIds', 'wait'],
    async run(ctx, o) {
      clap(ctx, o);
      return execute(ctx, 'resume', o);
    },
  },
};
