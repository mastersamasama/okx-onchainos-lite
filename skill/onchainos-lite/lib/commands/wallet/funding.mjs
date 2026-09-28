// wallet funding-check
// upstream: commands/agentic_wallet/mod.rs::execute (FundingCheck arm) → balance/mod.rs::cmd_funding_check
import { cmdFundingCheck } from '../../wallet/balance/index.mjs';
import { clap } from '../../wallet/utxo/_clap.mjs';

export default {
  'wallet funding-check': {
    uses: ['chain', 'tokenAddress', 'required', 'asset'],
    run(ctx, o) {
      // The global --chain does not satisfy the leaf's required --chain (clap usage error).
      clap(ctx, {});
      return cmdFundingCheck(o.chain, o.tokenAddress ?? '', o.required, o.asset);
    },
  },
};
