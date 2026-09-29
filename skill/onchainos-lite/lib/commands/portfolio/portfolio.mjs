// portfolio — upstream commands/portfolio.rs: public-address balance queries. The fetch*
// exports mirror upstream's pub fns (reused by cross-chain, payment quote, workflows, MCP).
import { resolveChain, resolveChains } from '../../core/chains.mjs';

const SUPPORTED_CHAIN_PATH = '/api/v6/dex/balance/supported/chain';
const TOTAL_VALUE_PATH = '/api/v6/dex/balance/total-value-by-address';
const ALL_BALANCES_PATH = '/api/v6/dex/balance/all-token-balances-by-address';
const TOKEN_BALANCES_PATH = '/api/v6/dex/balance/token-balances-by-address';

// upstream: portfolio.rs::fetch_chains — GET /api/v6/dex/balance/supported/chain
export async function fetchChains(client) {
  return client.get(SUPPORTED_CHAIN_PATH, []);
}

// upstream: portfolio.rs::fetch_total_value — GET /api/v6/dex/balance/total-value-by-address
export async function fetchTotalValue(client, address, chains, assetType, excludeRisk) {
  const query = [['address', address], ['chains', resolveChains(chains)]];
  if (assetType !== undefined && assetType !== null) query.push(['assetType', assetType]);
  if (excludeRisk !== undefined && excludeRisk !== null) query.push(['excludeRiskToken', excludeRisk]);
  return client.get(TOTAL_VALUE_PATH, query);
}

// upstream: portfolio.rs::fetch_all_balances — GET /api/v6/dex/balance/all-token-balances-by-address
export async function fetchAllBalances(client, address, chains, excludeRisk, filter) {
  const query = [['address', address], ['chains', resolveChains(chains)]];
  if (excludeRisk !== undefined && excludeRisk !== null) query.push(['excludeRiskToken', excludeRisk]);
  if (filter !== undefined && filter !== null) query.push(['filter', filter]);
  return client.get(ALL_BALANCES_PATH, query);
}

// upstream: portfolio.rs::fetch_token_balances (inline) — "chainIndex:tokenAddress,…" split on
// ',' and the first ':' with NO trimming; a missing address means the native token ("").
export function parseTokenBalanceList(tokens) {
  return String(tokens).split(',').map((pair) => {
    const colon = pair.indexOf(':');
    const chain = colon < 0 ? pair : pair.slice(0, colon);
    const tokenAddress = colon < 0 ? '' : pair.slice(colon + 1);
    return { chainIndex: resolveChain(chain), tokenContractAddress: tokenAddress };
  });
}

// upstream: portfolio.rs::fetch_token_balances — POST /api/v6/dex/balance/token-balances-by-address
export async function fetchTokenBalances(client, address, tokens, excludeRisk) {
  const body = { address, tokenContractAddresses: parseTokenBalanceList(tokens) };
  if (excludeRisk !== undefined && excludeRisk !== null) body.excludeRiskToken = excludeRisk;
  return client.post(TOKEN_BALANCES_PATH, body);
}

export default {
  'portfolio chains': {
    uses: [],
    async run(ctx) {
      const client = await ctx.api();
      return fetchChains(client);
    },
  },
  'portfolio total-value': {
    uses: ['address', 'chains', 'assetType', 'excludeRisk'],
    async run(ctx, o) {
      // Option<bool> (clap possible values true|false) → b.to_string()
      const client = await ctx.api();
      return fetchTotalValue(client, o.address, o.chains, o.assetType, o.excludeRisk);
    },
  },
  'portfolio all-balances': {
    uses: ['address', 'chains', 'excludeRisk', 'filter'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchAllBalances(client, o.address, o.chains, o.excludeRisk, o.filter);
    },
  },
  'portfolio token-balances': {
    uses: ['address', 'tokens', 'excludeRisk'],
    async run(ctx, o) {
      const client = await ctx.api();
      return fetchTokenBalances(client, o.address, o.tokens, o.excludeRisk);
    },
  },
};
