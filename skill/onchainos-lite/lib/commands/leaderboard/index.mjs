// leaderboard — upstream cli/src/commands/leaderboard.rs (fetch helpers shared with MCP + CLI handlers).
import { resolveChain } from '../../core/chains.mjs';
import { some } from '../market/_g03.mjs';

// upstream: leaderboard.rs::fetch_chains — GET /api/v6/dex/market/leaderboard/supported/chain
export function fetchChains(client) {
  return client.get('/api/v6/dex/market/leaderboard/supported/chain', []);
}

const WALLET_TYPES = { smartMoney: '1', influencer: '2', sniper: '3', dev: '4', fresh: '5', pump: '6' };

// upstream: leaderboard.rs::resolve_leaderboard_wallet_type — exact, case-sensitive name → code.
export function resolveLeaderboardWalletType(walletType) {
  return Object.prototype.hasOwnProperty.call(WALLET_TYPES, walletType) ? WALLET_TYPES[walletType] : walletType;
}

// upstream: leaderboard.rs::fetch_list — GET /api/v6/dex/market/leaderboard/list
export function fetchList(client, chainIndex, timeFrame, sortBy, walletType, minRealizedPnl, maxRealizedPnl,
  minWinRate, maxWinRate, minTxs, maxTxs, minTxVolume, maxTxVolume) {
  const query = [['chainIndex', chainIndex], ['timeFrame', timeFrame], ['sortBy', sortBy]];
  const opt = [['walletType', walletType], ['minRealizedPnlUsd', minRealizedPnl], ['maxRealizedPnlUsd', maxRealizedPnl],
    ['minWinRatePercent', minWinRate], ['maxWinRatePercent', maxWinRate], ['minTxs', minTxs], ['maxTxs', maxTxs],
    ['minTxVolume', minTxVolume], ['maxTxVolume', maxTxVolume]];
  for (const [k, v] of opt) if (some(v)) query.push([k, v]);
  return client.get('/api/v6/dex/market/leaderboard/list', query);
}

export default {
  'leaderboard supported-chains': {
    uses: [],
    async run(ctx) {
      return fetchChains(await ctx.api());
    },
  },
  'leaderboard list': {
    uses: ['chain', 'timeFrame', 'sortBy', 'walletType', 'minRealizedPnlUsd', 'maxRealizedPnlUsd', 'minWinRatePercent',
      'maxWinRatePercent', 'minTxs', 'maxTxs', 'minTxVolume', 'maxTxVolume'],
    async run(ctx, o) {
      const ci = resolveChain(o.chain);
      const api = await ctx.api();
      const walletType = some(o.walletType) ? resolveLeaderboardWalletType(o.walletType) : undefined;
      return fetchList(api, ci, o.timeFrame, o.sortBy, walletType, o.minRealizedPnlUsd, o.maxRealizedPnlUsd,
        o.minWinRatePercent, o.maxWinRatePercent, o.minTxs, o.maxTxs, o.minTxVolume, o.maxTxVolume);
    },
  },
};
