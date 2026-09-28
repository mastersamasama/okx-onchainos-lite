// workflow portfolio — upstream cli/src/commands/workflows/portfolio.rs.
// Concurrently: all balances + total value (both over `chains`) + 30d overview on the first chain.
// Failures become null. Shared with MCP (workflow_portfolio, which passes resolved indexes).
import { resolveChain } from '../../core/chains.mjs';
import { fetchPortfolioOverview } from '../market/index.mjs';
import { fetchAllBalances, fetchTotalValue } from '../portfolio/portfolio.mjs';
import { okOrNull } from './index.mjs';
import { cloneClient } from '../../core/http.mjs';

export const DEFAULT_CHAINS = '1,501';
export const DEFAULT_PRIMARY_CHAIN_INDEX = '501';

// upstream: portfolio.rs (workflows)::fetch_and_assemble
export async function fetchAndAssemble(client, address, chainsStr) {
  // First comma segment, untrimmed; an empty first segment falls back to Solana.
  const first = String(chainsStr).split(',')[0];
  const primaryChainIndex = first !== '' ? resolveChain(first) : DEFAULT_PRIMARY_CHAIN_INDEX;

  const [c1, c2] = [cloneClient(client), cloneClient(client)];
  const [balances, totalValue, overview] = await Promise.all([
    okOrNull(() => fetchAllBalances(client, address, chainsStr, undefined, undefined)),
    okOrNull(() => fetchTotalValue(c1, address, chainsStr, undefined, undefined)),
    okOrNull(() => fetchPortfolioOverview(c2, primaryChainIndex, address, '4')),
  ]);
  return assemble(address, chainsStr, balances, totalValue, overview);
}

// upstream: portfolio.rs (workflows)::assemble — pure; json! object.
export function assemble(address, chains, balances, totalValue, overview) {
  return { workflow: 'portfolio', address, chains, balances, totalValue, overview };
}

export default {
  'workflow portfolio': {
    uses: ['address', 'chains'],
    // upstream: portfolio.rs (workflows)::run — `--chains` verbatim, else the resolved global
    // `--chain`, else "1,501" (config default_chain is ignored).
    async run(ctx, o) {
      const client = await ctx.api();
      const chainsStr = ctx.resolveChainsOr(o.chains, DEFAULT_CHAINS);
      return fetchAndAssemble(client, o.address, chainsStr);
    },
  },
};
