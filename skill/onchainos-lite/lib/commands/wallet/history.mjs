// wallet history
// upstream: commands/agentic_wallet/mod.rs::execute (History arm) → history/query.rs::cmd_query_history
import { cmdQueryHistory } from '../../wallet/history/index.mjs';

export default {
  'wallet history': {
    uses: ['accountId', 'chain', 'address', 'begin', 'end', 'cursor', 'limit', 'orderId', 'txHash', 'uopHash'],
    run: (ctx, o) => cmdQueryHistory(o.accountId, o.chain, o.address, o.begin, o.end, o.cursor, o.limit, o.orderId, o.txHash, o.uopHash),
  },
};
