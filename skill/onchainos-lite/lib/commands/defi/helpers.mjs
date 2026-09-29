// DeFi amount conversions and expectOutputList discovery — upstream cli/src/commands/defi/helpers.rs.
import { stringify } from '../../core/json.mjs';
import { fetchPositionDetail } from './api.mjs';
import { get, isObject, asStr, asU64, asI64 } from '../../core/rs/value.mjs';
import { toU32, parseU32 } from '../../core/rs/num.mjs';

// `v.as_str().and_then(|s| s.parse::<u32>().ok()).or_else(|| v.as_u64().map(|n| n as u32))`
export function precisionOf(v) {
  if (typeof v === 'string') return parseU32(v);
  const u = asU64(v);
  return u === undefined ? undefined : toU32(u);
}

// upstream: helpers.rs::convert_minimal_to_decimal — validates each --user-input item (tokenPrecision
// required; coinAmount a non-zero integer string) and converts coinAmount minimal → decimal in place,
// dropping tokenPrecision.
export function convertMinimalToDecimal(items) {
  for (const item of items) {
    const precision = precisionOf(get(item, 'tokenPrecision'));
    if (precision === undefined) {
      throw new Error('tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision');
    }
    const amountStr = asStr(get(item, 'coinAmount'));
    if (amountStr !== undefined) {
      if (amountStr === '' || /^0*$/.test(amountStr)) throw new Error(`coinAmount cannot be zero or empty. Got "${amountStr}".`);
      if (amountStr.includes('.')) {
        throw new Error(`coinAmount must be an integer (minimal units), got "${amountStr}". Convert: userAmount x 10^tokenPrecision. Example: 0.5 USDC (precision=6) -> coinAmount="500000"`);
      }
      item.coinAmount = minimalToDecimalStr(amountStr, precision);
    }
    if (isObject(item)) delete item.tokenPrecision;
  }
}

// upstream: helpers.rs::minimal_to_decimal_str — "500000", 6 → "0.5" (pure string op, no validation)
export function minimalToDecimalStr(amount, precision) {
  if (precision === 0) return amount;
  const zeroPadded = amount.length <= precision ? amount.padStart(precision + 1, '0') : amount;
  const integerPart = zeroPadded.slice(0, zeroPadded.length - precision);
  const trimmed = zeroPadded.slice(zeroPadded.length - precision).replace(/0+$/, '');
  return trimmed === '' ? integerPart : `${integerPart}.${trimmed}`;
}

// upstream: helpers.rs::decimal_to_minimal_str — "0.5", 6 → "500000" (truncates, never rounds)
export function decimalToMinimalStr(amount, precision) {
  if (precision === 0) return amount.split('.')[0];
  const dot = amount.indexOf('.');
  const [integer, decimal] = dot >= 0 ? [amount.slice(0, dot), amount.slice(dot + 1)] : [amount, ''];
  const finalDecimal = decimal.length >= precision ? decimal.slice(0, precision) : decimal.padEnd(precision, '0');
  const stripped = (integer + finalDecimal).replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

// { chainIndex, coinAmount, tokenAddress } from a baseDefiTokenInfos[] element (json!, sorted keys)
const outputToken = (chainIndex, t) => ({
  chainIndex,
  tokenAddress: asStr(get(t, 'tokenAddress')) ?? '',
  coinAmount: asStr(get(t, 'coinAmount')) ?? '0',
});
const arr = (v) => (Array.isArray(v) ? v : undefined);

function pushMatching(tokens, rewards, rewardType, chainIndex) {
  for (const reward of arr(rewards) ?? []) {
    if ((asStr(get(reward, 'rewardType')) ?? '') !== rewardType) continue;
    const base = arr(get(reward, 'baseDefiTokenInfos'));
    if (base) for (const t of base) tokens.push(outputToken(chainIndex, t));
  }
}
// investmentId filter: only a JSON integer equal to the requested id passes.
function idMatches(item, investmentId) {
  if (investmentId === undefined || investmentId === null) return true;
  const n = asI64(get(item, 'investmentId'));
  return n !== undefined && String(n) === investmentId;
}

// upstream: helpers.rs::extract_expect_output — auto-build expectOutputList from position-detail;
// null when the response is not an array or nothing matches; else the compact JSON array text.
export async function extractExpectOutput(client, wallet, chainIndex, platformId, rewardType, investmentId) {
  const raw = await fetchPositionDetail(client, wallet, chainIndex, platformId);
  if (!Array.isArray(raw)) return null;
  const tokens = [];
  for (const platform of raw) {
    const wallets = arr(get(platform, 'walletIdPlatformDetailList'));
    if (!wallets) continue;
    for (const w of wallets) {
      const networks = arr(get(w, 'networkHoldVoList'));
      if (!networks) continue;
      for (const net of networks) {
        const markets = arr(get(net, 'investMarketTokenBalanceVoList'));
        if (['REWARD_INVESTMENT', 'REWARD_OKX_BONUS', 'REWARD_MERKLE_BONUS'].includes(rewardType) && markets) {
          for (const market of markets) {
            for (const side of ['SUPPLY', 'BORROW']) {
              const items = arr(get(get(market, 'assetMap'), side));
              if (!items) continue;
              for (const item of items) {
                if (!idMatches(item, investmentId)) continue;
                pushMatching(tokens, get(item, 'rewardDefiTokenInfo'), rewardType, chainIndex);
              }
            }
          }
        }
        if (markets) for (const market of markets) pushMatching(tokens, get(market, 'marketRewards'), rewardType, chainIndex);
        const standalone = arr(get(net, 'investTokenBalanceVoList'));
        if (standalone) {
          for (const item of standalone) {
            if (!idMatches(item, investmentId)) continue;
            pushMatching(tokens, get(item, 'rewardDefiTokenInfo'), rewardType, chainIndex);
          }
        }
        if (rewardType !== 'REWARD_INVESTMENT') pushMatching(tokens, get(net, 'availableRewards'), rewardType, chainIndex);
      }
    }
  }
  const seen = new Set();
  const deduped = tokens.filter((t) => {
    const key = `${t.chainIndex}:${t.tokenAddress}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.length ? stringify(deduped) : null;
}
