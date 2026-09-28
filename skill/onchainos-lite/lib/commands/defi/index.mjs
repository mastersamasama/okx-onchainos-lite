// `onchainos defi …` — upstream cli/src/commands/defi/mod.rs (DefiCommand + execute).
// Every subcommand except support-chains / support-platforms validates the wallet session and
// refreshes the access token (auth::ensure_tokens_refreshed) before the API client is built.
import { resolveChain } from '../../core/chains.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { clap } from '../token/_clap.mjs';
import {
  fetchChains, fetchProtocols, fetchSearch, fetchDetail, fetchPrepare, fetchEnter, fetchExit, fetchClaim,
  fetchCalculateEntry, fetchRateChart, fetchTvlChart, fetchDepthPriceChart, fetchPositions, fetchPositionDetail,
} from './api.mjs';
import { extractExpectOutput, minimalToDecimalStr, decimalToMinimalStr, precisionOf } from './helpers.mjs';
import { cmdInvest, cmdWithdraw, cmdCollect } from './operations.mjs';
import { get, parseU32, setIndex } from './_rs.mjs';

export * from './api.mjs';
export { extractExpectOutput } from './helpers.mjs';
export { cmdInvest, cmdWithdraw, cmdCollect } from './operations.mjs';

const some = (v) => v !== undefined && v !== null;
const optChain = (c) => (some(c) ? resolveChain(c) : undefined);

// <f64 as FromStr> for clap's f64 value parser (`--range`)
function parseF64Arg(raw) {
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(raw);
  if (!m) throw new Error(raw === '' ? 'cannot parse float from empty string' : 'invalid float literal');
  if (m[2]) return m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity);
  return Number(m[1] + m[3]);
}

const TICKS = { types: { tickLower: 'i64', tickUpper: 'i64' }, hyphen: ['tickLower', 'tickUpper'] };

// upstream: mod.rs::execute — the per-subcommand bodies, keyed by subcommand name. `a` holds the
// clap-typed arguments (numbers already converted).
const COMMANDS = {
  'support-chains': (client) => fetchChains(client),
  'support-platforms': (client) => fetchProtocols(client),
  list: (client, a) => fetchSearch(client, null, null, null, null, a.pageNum),
  search(client, a) {
    if (!some(a.token) && !some(a.platform)) throw new Error('at least one of --token or --platform is required');
    return fetchSearch(client, a.token, a.platform, optChain(a.chain), a.productGroup, a.pageNum);
  },
  detail: (client, a) => fetchDetail(client, a.investmentId),
  prepare: (client, a) => fetchPrepare(client, a.investmentId),
  deposit: (client, a) => fetchEnter(client, a.investmentId, a.address, a.userInput, a.slippage, a.tokenId, a.tickLower, a.tickUpper),
  redeem(client, a) {
    const chainIndex = optChain(a.chain) ?? '';
    return fetchExit(client, a.id, chainIndex, a.address, a.ratio, a.token, a.symbol, a.amount, a.precision, a.tokenId, a.slippage, a.userInput);
  },
  async claim(client, a) {
    const chainIndex = optChain(a.chain) ?? '';
    let autoExpectOutput = null;
    if (!some(a.expectOutput) && some(a.platformId)) {
      try {
        autoExpectOutput = await extractExpectOutput(client, a.address, chainIndex, a.platformId, a.rewardType, a.id);
      } catch {
        autoExpectOutput = null;
      }
    }
    const finalExpectOutput = a.expectOutput ?? autoExpectOutput;
    return fetchClaim(client, a.address, chainIndex, a.rewardType, a.id, a.platformId, a.tokenId, a.principalIndex, finalExpectOutput);
  },
  async 'calculate-entry'(client, a) {
    if (a.inputAmount.includes('.')) {
      throw new Error(`input-amount must be an integer (minimal units), got "${a.inputAmount}". Convert: userAmount x 10^tokenDecimal. Example: 0.005 ETH (decimal=18) -> input-amount="5000000000000000"`);
    }
    const precision = parseU32(a.tokenDecimal);
    if (precision === undefined) throw new Error(`token-decimal must be a non-negative integer, got "${a.tokenDecimal}"`);
    const humanReadableAmount = minimalToDecimalStr(a.inputAmount, precision);
    const result = await fetchCalculateEntry(client, a.id, a.address, a.inputToken, humanReadableAmount, a.tokenDecimal, a.tickLower, a.tickUpper);

    // coinAmount UI decimal → minimal units, plus tokenPrecision, using prepare's precisions.
    const prepareData = await fetchPrepare(client, a.id);
    const precisionMap = new Map();
    const tokens = get(prepareData, 'investWithTokenList');
    if (Array.isArray(tokens)) {
      for (const t of tokens) {
        const addrV = get(t, 'tokenAddress');
        const addr = (typeof addrV === 'string' ? addrV : '').toLowerCase();
        precisionMap.set(addr, precisionOf(get(t, 'tokenPrecision')) ?? 18);
      }
    }
    const output = result;
    const outTokens = get(output, 'investWithTokenList');
    if (Array.isArray(outTokens)) {
      for (const t of outTokens) {
        const addrV = get(t, 'tokenAddress');
        const addr = (typeof addrV === 'string' ? addrV : '').toLowerCase();
        const prec = precisionMap.get(addr) ?? 18;
        const amountStr = get(t, 'coinAmount');
        if (typeof amountStr === 'string') {
          setIndex(t, 'coinAmount', decimalToMinimalStr(amountStr, prec));
          setIndex(t, 'tokenPrecision', String(prec));
        }
      }
    }
    return output;
  },
  'rate-chart': (client, a) => fetchRateChart(client, a.investmentId, a.timeRange),
  'tvl-chart': (client, a) => fetchTvlChart(client, a.investmentId, a.timeRange),
  'depth-price-chart': (client, a) => fetchDepthPriceChart(client, a.investmentId, a.chartType, a.timeRange),
  invest: (client, a) => cmdInvest(client, a.investmentId, a.address, a.token, a.amount, a.token2, a.amount2, a.slippage, a.tokenId, a.tickLower, a.tickUpper, a.range),
  withdraw: (client, a) => cmdWithdraw(client, a.investmentId, a.address, a.chain, a.ratio, a.tokenId, a.slippage, a.amount, a.platformId),
  collect: (client, a) => cmdCollect(client, a.address, a.chain, a.rewardType, a.investmentId, a.platformId, a.tokenId, a.principalIndex),
  positions: (client, a) => fetchPositions(client, a.address, a.chains),
  'position-detail': (client, a) => fetchPositionDetail(client, a.address, resolveChain(a.chain), a.platformId),
};

// upstream: mod.rs::execute
export async function execute(ctx, cmd, a) {
  const requiresLogin = cmd !== 'support-chains' && cmd !== 'support-platforms';
  if (requiresLogin) await ensureTokensRefreshed();
  const client = await ctx.api();
  return COMMANDS[cmd](client, a);
}

// Handler: clap pass (typed values, hyphen rules, leaf-required --chain) → execute.
function handler(sub, uses, clapOpts = {}, ignores = []) {
  return {
    uses,
    ignores,
    async run(ctx, o) {
      const typed = clap(ctx, o, clapOpts);
      return execute(ctx, sub, { ...o, ...typed });
    },
  };
}

export default {
  'defi support-chains': handler('support-chains', []),
  'defi support-platforms': handler('support-platforms', []),
  'defi list': handler('list', ['pageNum'], { types: { pageNum: 'u32' } }),
  'defi search': handler('search', ['token', 'platform', 'chain', 'productGroup', 'pageNum'], { types: { pageNum: 'u32' } }),
  'defi detail': handler('detail', ['investmentId']),
  'defi prepare': handler('prepare', ['investmentId']),
  'defi deposit': handler('deposit', ['investmentId', 'address', 'userInput', 'slippage', 'tokenId', 'tickLower', 'tickUpper'], TICKS),
  'defi redeem': handler('redeem', ['id', 'address', 'ratio', 'tokenId', 'slippage', 'chain', 'userInput', 'token', 'symbol', 'amount', 'precision'], { types: { precision: 'u32' } }),
  'defi claim': handler('claim', ['address', 'chain', 'rewardType', 'id', 'platformId', 'tokenId', 'principalIndex', 'expectOutput']),
  'defi calculate-entry': handler('calculate-entry', ['id', 'address', 'inputToken', 'inputAmount', 'tokenDecimal', 'tickLower', 'tickUpper'], TICKS),
  'defi rate-chart': handler('rate-chart', ['investmentId', 'timeRange']),
  'defi tvl-chart': handler('tvl-chart', ['investmentId', 'timeRange']),
  'defi depth-price-chart': handler('depth-price-chart', ['investmentId', 'chartType', 'timeRange']),
  // --chain is parsed but ignored upstream (`chain: _chain`).
  'defi invest': handler('invest', ['investmentId', 'address', 'token', 'amount', 'token2', 'amount2', 'slippage', 'tokenId', 'tickLower', 'tickUpper', 'range'],
    { types: { tickLower: 'i64', tickUpper: 'i64', range: parseF64Arg }, hyphen: ['tickLower', 'tickUpper'] }, ['chain']),
  'defi withdraw': handler('withdraw', ['investmentId', 'address', 'chain', 'ratio', 'tokenId', 'slippage', 'amount', 'platformId'], { leafRequired: ['chain'] }),
  'defi collect': handler('collect', ['address', 'chain', 'rewardType', 'investmentId', 'platformId', 'tokenId', 'principalIndex'], { leafRequired: ['chain'] }),
  'defi positions': handler('positions', ['address', 'chains']),
  'defi position-detail': handler('position-detail', ['address', 'chain', 'platformId'], { leafRequired: ['chain'] }),
};
