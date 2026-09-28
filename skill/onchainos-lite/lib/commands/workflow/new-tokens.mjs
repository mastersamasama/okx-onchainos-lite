// workflow new-tokens — upstream cli/src/commands/workflows/new_tokens.rs.
//   Step 1: memepump tokenList for the stage (failure → tokenList null, not an error)
//   Step 2: first 10 unique tokens (API order), each enriched concurrently with security scan +
//           advanced-info + tokenDevInfo + tokenBundleInfo
// fetchAndAssemble is shared with the MCP server (workflow_new_tokens).
import { resolveChain } from '../../core/chains.mjs';
import { fetchSecurity, fetchAdvancedInfo } from '../token/token.mjs';
import { fetchByAddress } from '../memepump/index.mjs';
import { okOrNull } from './index.mjs';
import { cloneClient } from '../../core/http.mjs';
import { index, asStr, asArray, toAsciiUppercase, debugStrList } from './_value.mjs';
import { MEMEPUMP_TOKEN_DEV_INFO_PATH, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH, MEMEPUMP_TOKEN_LIST_PATH } from './_paths.mjs';

export const ENRICH_TOP_N = 10;
export const VALID_STAGES = ['MIGRATED', 'MIGRATING'];
export const DEFAULT_STAGE = 'MIGRATED';

// upstream: new_tokens.rs::fetch_and_assemble
export async function fetchAndAssemble(client, chainIndex, stage) {
  const stageNorm = toAsciiUppercase(stage);
  if (!VALID_STAGES.includes(stageNorm)) {
    throw new Error(`stage must be one of ${debugStrList(VALID_STAGES)} (case-insensitive), got: ${stage}`);
  }

  // ── Step 1: launchpad token list ──
  const tokenList = await okOrNull(() => client.get(MEMEPUMP_TOKEN_LIST_PATH, [['chainIndex', chainIndex], ['stage', stageNorm]]));
  const topTokens = extractTopTokens(tokenList, ENRICH_TOP_N);

  // ── Step 2: per-token enrichment (JoinSet; every task owns a client clone), re-assembled in API order ──
  const tasks = topTokens.map(([addr, tokenItem]) => [addr, tokenItem, cloneClient(client)]);
  const results = await Promise.all(tasks.map(async ([addr, tokenItem, c]) => {
    const [c1, c2, c3] = [cloneClient(c), cloneClient(c), cloneClient(c)];
    const [security, advanced, devInfo, bundleInfo] = await Promise.all([
      okOrNull(() => fetchSecurity(c, addr, chainIndex)),
      okOrNull(() => fetchAdvancedInfo(c1, addr, chainIndex)),
      okOrNull(() => fetchByAddress(c2, MEMEPUMP_TOKEN_DEV_INFO_PATH, addr, chainIndex)),
      okOrNull(() => fetchByAddress(c3, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH, addr, chainIndex)),
    ]);
    return { address: addr, data: assembleTokenResult(tokenItem, security, advanced, devInfo, bundleInfo) };
  }));

  return assemble(chainIndex, stageNorm, tokenList, results);
}

// upstream: new_tokens.rs::assemble_token_result — pure; json! object.
export function assembleTokenResult(tokenItem, security, advanced, devInfo, bundleInfo) {
  return { token: tokenItem, security, contract: advanced, devInfo, bundleInfo };
}

// upstream: new_tokens.rs::assemble — pure; json! object.
export function assemble(chainIndex, stage, tokenList, enriched) {
  return { workflow: 'new-tokens', chain: chainIndex, stage, tokenList, enriched };
}

// upstream: new_tokens.rs::extract_top_tokens — bare array or {"data":[…]}; same address rule as
// smart-money; keeps API order, first occurrence of an address wins, stops once n are taken.
export function extractTopTokens(list, n) {
  const arr = asArray(list) ?? asArray(index(list, 'data'));
  if (!arr) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const addr = asStr(index(item, 'tokenContractAddress')) ?? asStr(index(item, 'address'));
    if (addr === undefined || addr === '') continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push([addr, item]);
    if (out.length === n) break;
  }
  return out;
}

export default {
  'workflow new-tokens': {
    uses: ['chain', 'stage'],
    // upstream: new_tokens.rs::run — the client is created before the stage is validated.
    async run(ctx, o) {
      const chainIndex = o.chain !== undefined ? resolveChain(o.chain) : ctx.chainIndexOr('solana');
      const stage = o.stage ?? DEFAULT_STAGE;
      const client = await ctx.api();
      return fetchAndAssemble(client, chainIndex, stage);
    },
  },
};
