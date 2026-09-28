// workflow token-research — upstream cli/src/commands/workflows/token_research.rs.
//   Step 1: token::fetch_report (info + price-info + advanced-info + security, concurrent;
//           all four failing is an error, a single failure is null)
//   Step 2: holders + cluster overview + top traders + signal list (concurrent, failures → null)
//   Step 3: launchpad enrichment (4 memepump calls) only when advanced-info has a protocolId
// fetchAndAssemble / searchAndSelect are shared with the MCP server (workflow_token_research).
import { resolveChain } from '../../core/chains.mjs';
import {
  fetchReport, fetchHolders, fetchClusterByAddress, fetchTopTrader, fetchSearch, CLUSTER_OVERVIEW_PATH,
} from '../token/token.mjs';
import { fetchList } from '../signal/index.mjs';
import { fetchByAddress } from '../memepump/index.mjs';
import { okOrNull } from './index.mjs';
import { cloneClient } from '../../core/http.mjs';
import { index, get, asStr, asArray } from './_value.mjs';
import {
  MEMEPUMP_TOKEN_DETAILS_PATH, MEMEPUMP_TOKEN_DEV_INFO_PATH, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH, MEMEPUMP_SIMILAR_TOKEN_PATH,
} from './_paths.mjs';

export const SELECT_TOKEN_MESSAGE = 'Multiple tokens found. Please select one by number (1-5) to continue the full research workflow.';

// upstream: token_research.rs::fetch_and_assemble
export async function fetchAndAssemble(client, address, chainIndex) {
  // ── Step 1: core data via token report composite command ──
  const report = await fetchReport(client, address, chainIndex);
  const info = index(report, 'info');
  const price = index(report, 'priceInfo');
  const advanced = index(report, 'advancedInfo');
  const security = index(report, 'security');

  // ── Step 2: on-chain structure (tokio::join!; one client clone per extra branch) ──
  const [c1, c2, c3] = [cloneClient(client), cloneClient(client), cloneClient(client)];
  const [holders, cluster, topTraders, signals] = await Promise.all([
    okOrNull(() => fetchHolders(client, address, chainIndex, undefined, '100', undefined, undefined)),
    okOrNull(() => fetchClusterByAddress(c1, CLUSTER_OVERVIEW_PATH, address, chainIndex)),
    okOrNull(() => fetchTopTrader(c2, address, chainIndex, undefined, '20', undefined, undefined)),
    okOrNull(() => fetchList(c3, chainIndex, undefined, undefined, undefined, undefined, undefined, address,
      undefined, undefined, undefined, undefined, undefined, undefined)),
  ]);

  // ── Step 3: launchpad supplement (conditional, tokio::join!) ──
  let launchpad = null;
  if (isLaunchpadToken(advanced)) {
    const [c4, c5, c6] = [cloneClient(client), cloneClient(client), cloneClient(client)];
    const [details, devInfo, bundleInfo, similar] = await Promise.all([
      okOrNull(() => fetchByAddress(client, MEMEPUMP_TOKEN_DETAILS_PATH, address, chainIndex)),
      okOrNull(() => fetchByAddress(c4, MEMEPUMP_TOKEN_DEV_INFO_PATH, address, chainIndex)),
      okOrNull(() => fetchByAddress(c5, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH, address, chainIndex)),
      okOrNull(() => fetchByAddress(c6, MEMEPUMP_SIMILAR_TOKEN_PATH, address, chainIndex)),
    ]);
    launchpad = { tokenDetails: details, devInfo, bundleInfo, similarTokens: similar };
  }

  return assemble(address, chainIndex, info, price, advanced, security, holders, cluster, topTraders, signals, launchpad);
}

// upstream: token_research.rs::search_and_select — top 5 search hits as numbered candidates.
export async function searchAndSelect(client, query, chainIndex) {
  const results = await fetchSearch(client, query, chainIndex, '5', undefined, undefined);
  const items = asArray(results) ?? [];
  if (!items.length) {
    throw new Error(`token-research: no tokens found for query '${query}' on chain ${chainIndex}`);
  }
  // `t.get(a).or_else(|| t.get(b)).cloned().unwrap_or(Null)` — a present JSON null counts as present.
  const pick = (t, ...keys) => {
    for (const k of keys) { const v = get(t, k); if (v !== undefined) return v; }
    return null;
  };
  const candidates = items.map((t, i) => ({
    index: i + 1,
    symbol: pick(t, 'tokenSymbol', 'symbol'),
    name: pick(t, 'tokenName', 'name'),
    address: pick(t, 'tokenContractAddress', 'address'),
    chain: pick(t, 'chainIndex', 'chain'),
    price: pick(t, 'price'),
    marketCap: pick(t, 'marketCap'),
    logoUrl: pick(t, 'logoUrl'),
  }));
  return {
    workflow: 'token-research',
    step: 'select-token',
    query,
    message: SELECT_TOKEN_MESSAGE,
    candidates,
  };
}

// upstream: token_research.rs::assemble — pure; json! object (keys print sorted).
export function assemble(address, chainIndex, info, price, advanced, security, holders, cluster, topTraders, signals, launchpad) {
  if (allNull([info, price, advanced, security])) {
    throw new Error(`token-research: all Step 1 sub-calls failed for address ${address} on chain ${chainIndex}`);
  }
  return {
    workflow: 'token-research',
    address,
    chain: chainIndex,
    core: { info, price, contract: advanced, security },
    structure: { holders, cluster, topTraders, signals },
    launchpad,
  };
}

// upstream: token_research.rs::is_launchpad_token — `advanced["protocolId"]` is a non-empty string.
export function isLaunchpadToken(advanced) {
  const p = asStr(index(advanced, 'protocolId'));
  return p !== undefined && p !== '';
}

// upstream: token_research.rs::all_null
export const allNull = (values) => values.every((v) => v === null || v === undefined);

export default {
  'workflow token-research': {
    uses: ['address', 'query', 'chain'],
    // upstream: token_research.rs::run
    async run(ctx, o) {
      if (o.address === undefined && o.query === undefined) throw new Error('token-research requires --address or --query');
      const client = await ctx.api();
      const chainIndex = o.chain !== undefined ? resolveChain(o.chain) : ctx.chainIndexOr('solana');
      if (o.query !== undefined && o.address === undefined) return searchAndSelect(client, o.query, chainIndex);
      return fetchAndAssemble(client, o.address, chainIndex);
    },
  },
};
