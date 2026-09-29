// signal — upstream cli/src/commands/signal.rs (fetch helpers shared with MCP/workflows + CLI handlers).
import { resolveChain } from '../../core/chains.mjs';
import { parseU64 } from '../../core/rs/num.mjs';
import { some } from '../market/_g03.mjs';

// upstream: signal.rs::fetch_chains — GET /api/v6/dex/market/signal/supported/chain
export function fetchChains(client) {
  return client.get('/api/v6/dex/market/signal/supported/chain', []);
}

// upstream: signal.rs::fetch_list — POST /api/v6/dex/market/signal/list (json! body → sorted keys).
// Optional args are undefined/null for None; `limit` is validated as a Rust u64 in 1..=100.
export function fetchList(client, chainIndex, walletType, minAmountUsd, maxAmountUsd, minAddressCount, maxAddressCount,
  tokenAddress, minMarketCapUsd, maxMarketCapUsd, minLiquidityUsd, maxLiquidityUsd, limit, cursor) {
  if (some(limit)) {
    const n = parseU64(String(limit));
    if (n === undefined) throw new Error('--limit must be a number between 1 and 100');
    if (!(n >= 1 && n <= 100)) throw new Error(`--limit must be between 1 and 100, got ${n}`);
  }
  const body = { chainIndex, limit: some(limit) ? limit : '20' };
  const opt = { cursor, walletType, minAmountUsd, maxAmountUsd, minAddressCount, maxAddressCount, tokenAddress,
    minMarketCapUsd, maxMarketCapUsd, minLiquidityUsd, maxLiquidityUsd };
  for (const [k, v] of Object.entries(opt)) if (some(v)) body[k] = v;
  return client.post('/api/v6/dex/market/signal/list', body);
}

export default {
  'signal chains': {
    uses: [],
    async run(ctx) {
      return fetchChains(await ctx.api());
    },
  },
  'signal list': {
    uses: ['chain', 'walletType', 'minAmountUsd', 'maxAmountUsd', 'minAddressCount', 'maxAddressCount', 'tokenAddress',
      'minMarketCapUsd', 'maxMarketCapUsd', 'minLiquidityUsd', 'maxLiquidityUsd', 'limit', 'cursor'],
    async run(ctx, o) {
      const ci = resolveChain(o.chain);
      const api = await ctx.api();
      return fetchList(api, ci, o.walletType, o.minAmountUsd, o.maxAmountUsd, o.minAddressCount, o.maxAddressCount,
        o.tokenAddress, o.minMarketCapUsd, o.maxMarketCapUsd, o.minLiquidityUsd, o.maxLiquidityUsd, o.limit, o.cursor);
    },
  },
};
