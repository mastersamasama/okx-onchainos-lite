// workflow smart-money — upstream cli/src/commands/workflows/smart_money.rs.
//   Step 1: signal list (failure → rawSignals null, not an error) → top 5 tokens by wallet count
//   Step 2: per token, concurrently: price-info + advanced-info + security scan, then
//           tokenDevInfo + tokenBundleInfo when advanced-info carries a protocolId
// fetchAndAssemble is shared with the MCP server (workflow_smart_money).
import { resolveChain } from '../../core/chains.mjs';
import { fetchPriceInfo, fetchAdvancedInfo, fetchSecurity } from '../token/token.mjs';
import { fetchList } from '../signal/index.mjs';
import { fetchByAddress } from '../memepump/index.mjs';
import { okOrNull } from './index.mjs';
import { cloneClient } from '../../core/http.mjs';
import { isLaunchpadToken } from './token-research.mjs';
import { at, asStr, asArray, asU64 } from '../../core/rs/value.mjs';
import { cmpBytes } from '../../core/rs/str.mjs';
import { MEMEPUMP_TOKEN_DEV_INFO_PATH, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH } from './_paths.mjs';

export const TOP_N = 5;

// upstream: smart_money.rs::fetch_and_assemble
export async function fetchAndAssemble(client, chainIndex) {
  // ── Step 1 ──
  const rawSignals = await okOrNull(() => fetchList(client, chainIndex, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined));
  const topTokens = extractTopTokens(rawSignals, TOP_N);

  // ── Step 2: per-token enrichment (JoinSet; every task owns a client clone), re-assembled in
  // `topTokens` order ──
  const tasks = topTokens.map(([addr, signalItem]) => [addr, signalItem, cloneClient(client)]);
  const enriched = await Promise.all(tasks.map(async ([addr, signalItem, c]) => {
    const [c1, c2] = [cloneClient(c), cloneClient(c)];
    const [price, advanced, security] = await Promise.all([
      okOrNull(() => fetchPriceInfo(c, addr, chainIndex)),
      okOrNull(() => fetchAdvancedInfo(c1, addr, chainIndex)),
      okOrNull(() => fetchSecurity(c2, addr, chainIndex)),
    ]);
    let launchpad = null;
    if (isLaunchpadToken(advanced)) {
      const [d1, d2] = [cloneClient(c), cloneClient(c)];
      const [devInfo, bundleInfo] = await Promise.all([
        okOrNull(() => fetchByAddress(d1, MEMEPUMP_TOKEN_DEV_INFO_PATH, addr, chainIndex)),
        okOrNull(() => fetchByAddress(d2, MEMEPUMP_TOKEN_BUNDLE_INFO_PATH, addr, chainIndex)),
      ]);
      launchpad = { devInfo, bundleInfo };
    }
    return { address: addr, data: assembleTokenResult(signalItem, price, advanced, security, launchpad) };
  }));

  return assemble(chainIndex, rawSignals, enriched);
}

// upstream: smart_money.rs::assemble_token_result — pure; json! object.
export function assembleTokenResult(signalItem, price, advanced, security, launchpad) {
  return { signal: signalItem, price, contract: advanced, security, launchpad };
}

// upstream: smart_money.rs::assemble — pure; json! object.
export function assemble(chainIndex, rawSignals, enriched) {
  return { workflow: 'smart-money', chain: chainIndex, rawSignals, topTokens: enriched };
}

// upstream: smart_money.rs::extract_top_tokens — bare array or {"data":[…]}; address =
// tokenContractAddress (string) else address (string), empty skipped; count = walletCount
// (u64) else addressCount (u64) else 0; duplicates keep the strictly higher count (ties keep
// the first); sorted by count desc, address asc (byte order); first n → [[addr, item]].
export function extractTopTokens(signals, n) {
  const arr = asArray(signals) ?? asArray(at(signals, 'data'));
  if (!arr) return [];
  const byAddr = new Map();
  for (const item of arr) {
    const addr = asStr(at(item, 'tokenContractAddress')) ?? asStr(at(item, 'address'));
    if (addr === undefined || addr === '') continue;
    const count = BigInt(asU64(at(item, 'walletCount')) ?? asU64(at(item, 'addressCount')) ?? 0);
    const existing = byAddr.get(addr);
    if (!existing) byAddr.set(addr, [count, item]);
    else if (count > existing[0]) { existing[0] = count; existing[1] = item; }
  }
  const items = [...byAddr].map(([addr, [count, item]]) => [count, addr, item]);
  items.sort((a, b) => (a[0] === b[0] ? cmpBytes(a[1], b[1]) : b[0] > a[0] ? 1 : -1));
  return items.slice(0, n).map(([, addr, item]) => [addr, item]);
}

export default {
  'workflow smart-money': {
    uses: ['chain'],
    // upstream: smart_money.rs::run
    async run(ctx, o) {
      const chainIndex = o.chain !== undefined ? resolveChain(o.chain) : ctx.chainIndexOr('solana');
      const client = await ctx.api();
      return fetchAndAssemble(client, chainIndex);
    },
  },
};
