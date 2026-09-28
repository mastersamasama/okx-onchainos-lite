// workflow wallet-analysis — upstream cli/src/commands/workflows/wallet_analysis.rs.
//   Step 1 (concurrent): portfolio overview 7d (timeFrame 3) + 30d (timeFrame 4) + all balances
//   Step 2: recent per-token PnL        Step 3: address-tracker activity (multi_address)
// Every failure becomes null; there is no all-fail error. Shared with MCP (workflow_wallet_analysis).
import { resolveChain } from '../../core/chains.mjs';
import { fetchPortfolioOverview, fetchPortfolioRecentPnl } from '../market/index.mjs';
import { fetchAllBalances } from '../portfolio/portfolio.mjs';
import { fetchActivities } from '../tracker/index.mjs';
import { okOrNull } from './index.mjs';
import { cloneClient } from '../../core/http.mjs';

// upstream: wallet_analysis.rs::fetch_and_assemble
export async function fetchAndAssemble(client, address, chainIndex) {
  // ── Step 1: performance + balances (tokio::join!; 30d and balances run on client clones) ──
  const [c1, c2] = [cloneClient(client), cloneClient(client)];
  const [overview7d, overview30d, balances] = await Promise.all([
    okOrNull(() => fetchPortfolioOverview(client, chainIndex, address, '3')),
    okOrNull(() => fetchPortfolioOverview(c1, chainIndex, address, '4')),
    okOrNull(() => fetchAllBalances(c2, address, chainIndex, undefined, undefined)),
  ]);
  // ── Step 2: per-token PnL ──
  const recentPnl = await okOrNull(() => fetchPortfolioRecentPnl(client, chainIndex, address, undefined, undefined));
  // ── Step 3: recent on-chain activity ──
  const activities = await okOrNull(() => fetchActivities(client, 'multi_address', address, undefined, chainIndex,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined));

  return assemble(address, chainIndex, overview7d, overview30d, balances, recentPnl, activities);
}

// upstream: wallet_analysis.rs::assemble — pure; json! object.
export function assemble(address, chainIndex, overview7d, overview30d, balances, recentPnl, activities) {
  return {
    workflow: 'wallet-analysis',
    address,
    chain: chainIndex,
    performance: { '7d': overview7d, '30d': overview30d },
    balances,
    recentPnl,
    activities,
  };
}

export default {
  'workflow wallet-analysis': {
    uses: ['address', 'chain'],
    // upstream: wallet_analysis.rs::run — client first, then the chain.
    async run(ctx, o) {
      const client = await ctx.api();
      const chainIndex = o.chain !== undefined ? resolveChain(o.chain) : ctx.chainIndexOr('solana');
      return fetchAndAssemble(client, o.address, chainIndex);
    },
  },
};
