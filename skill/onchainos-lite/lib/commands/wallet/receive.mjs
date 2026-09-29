// wallet receive
// upstream: commands/agentic_wallet/mod.rs::execute (Receive arm) → receive.rs::cmd_receive
import { cmdReceive } from '../../wallet/receive.mjs';

export default {
  'wallet receive': {
    uses: ['chain', 'token', 'cursor'],
    run: (ctx, o) => cmdReceive(o.chain, o.token, o.cursor),
  },
};
