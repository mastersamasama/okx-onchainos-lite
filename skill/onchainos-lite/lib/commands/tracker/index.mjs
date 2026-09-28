// tracker — upstream cli/src/commands/tracker.rs (fetch helpers shared with MCP/workflows + CLI handler).
import { resolveChain } from '../../core/chains.mjs';
import { some } from '../market/_g03.mjs';

const TRACKER_TYPES = { smart_money: '1', kol: '2', multi_address: '3' };

// upstream: tracker.rs::resolve_tracker_type — exact name → code, anything else unchanged.
export function resolveTrackerType(t) {
  return Object.prototype.hasOwnProperty.call(TRACKER_TYPES, t) ? TRACKER_TYPES[t] : t;
}

// upstream: tracker.rs::fetch_activities — GET /api/v6/dex/market/address-tracker/trades
export function fetchActivities(client, trackerType, walletAddress, tradeType, chainIndex, minVolume, maxVolume,
  minHolders, minMarketCap, maxMarketCap, minLiquidity, maxLiquidity) {
  const query = [['trackerType', resolveTrackerType(trackerType)]];
  const opt = [['walletAddress', walletAddress], ['tradeType', tradeType], ['chainIndex', chainIndex],
    ['minVolume', minVolume], ['maxVolume', maxVolume], ['minHolders', minHolders], ['minMarketCap', minMarketCap],
    ['maxMarketCap', maxMarketCap], ['minLiquidity', minLiquidity], ['maxLiquidity', maxLiquidity]];
  for (const [k, v] of opt) if (some(v)) query.push([k, v]);
  return client.get('/api/v6/dex/market/address-tracker/trades', query);
}

export default {
  'tracker activities': {
    uses: ['trackerType', 'walletAddress', 'tradeType', 'chain', 'minVolume', 'maxVolume', 'minHolders',
      'minMarketCap', 'maxMarketCap', 'minLiquidity', 'maxLiquidity'],
    async run(ctx, o) {
      const resolved = resolveTrackerType(o.trackerType);
      if ((resolved === '3' || o.trackerType === 'multi_address') && !some(o.walletAddress)) {
        throw new Error('--wallet-address is required when --tracker-type is multi_address');
      }
      const ci = some(o.chain) ? resolveChain(o.chain) : undefined;
      const api = await ctx.api();
      return fetchActivities(api, o.trackerType, o.walletAddress, o.tradeType, ci, o.minVolume, o.maxVolume,
        o.minHolders, o.minMarketCap, o.maxMarketCap, o.minLiquidity, o.maxLiquidity);
    },
  },
};
