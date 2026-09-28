// wallet receive
// upstream: commands/agentic_wallet/mod.rs::execute (Receive arm) → receive.rs::cmd_receive
import { cmdReceive } from '../../wallet/receive.mjs';
import { clap } from '../../wallet/utxo/_clap.mjs';

export default {
  'wallet receive': {
    uses: ['chain', 'token', 'cursor'],
    run(ctx, o) {
      // clap: --chain conflicts_with_all [token, cursor]; --cursor requires --token.
      clap(ctx, { conflicts: [['chain', 'token'], ['chain', 'cursor']], requires: [['cursor', 'token']] });
      return cmdReceive(o.chain, o.token, o.cursor);
    },
  },
};
