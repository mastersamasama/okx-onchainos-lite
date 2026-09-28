// wallet chains
// upstream: commands/agentic_wallet/mod.rs::execute (Chains arm) → chain.rs::execute → cmd_list
import { execute } from '../../wallet/chain.mjs';

export default {
  // The global --chain is accepted and ignored.
  'wallet chains': {
    uses: [],
    run: () => execute(),
  },
};
