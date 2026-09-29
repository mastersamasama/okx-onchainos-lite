// wallet funding-check
// upstream: commands/agentic_wallet/mod.rs::execute (FundingCheck arm) → balance/mod.rs::cmd_funding_check
import { cmdFundingCheck } from '../../wallet/balance/index.mjs';

export default {
  'wallet funding-check': {
    uses: ['chain', 'tokenAddress', 'required', 'asset'],
    run: (ctx, o) => cmdFundingCheck(o.chain, o.tokenAddress ?? '', o.required, o.asset),
  },
};
