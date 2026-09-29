// Token alias resolution + chain-aware address format validation — upstream token_alias.rs.
// Every command that accepts a user-supplied token address (swap, wallet send
// --contract-token, strategy create-limit) routes through here.
import { asciiLower, byteLen, isAsciiAlnum, isAsciiHex, isAsciiUpper } from './rs/str.mjs';
import { nativeTokenAddress } from './chains.mjs';

// Native placeholders (single definition in chains.rs::native_token_address).
const EVM_NATIVE = nativeTokenAddress('1');
const SOL_NATIVE = nativeTokenAddress('501');
const TRX_NATIVE = nativeTokenAddress('195');
const SUI_NATIVE = nativeTokenAddress('784');
const ARC_NATIVE = nativeTokenAddress('5042');

// upstream: token_alias.rs::TOKEN_MAP — chain index → lowercase alias → canonical address.
export const TOKEN_MAP = Object.freeze({
  // Solana
  501: {
    sol: SOL_NATIVE,
    native: SOL_NATIVE,
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    // Error CA corrections: wSOL SPL token / typo
    so11111111111111111111111111111111111111112: SOL_NATIVE,
    so11111111111111111111111111111111111111111: SOL_NATIVE,
  },
  // Ethereum
  1: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    wbtc: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    dai: '0x6b175474e89094c44da98b954eedeac495271d0f',
    weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  },
  // Base
  8453: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    weth: '0x4200000000000000000000000000000000000006',
    usdbc: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
  },
  // BSC
  56: {
    bnb: EVM_NATIVE,
    native: EVM_NATIVE,
    usdt: '0x55d398326f99059ff775485246999027b3197955',
    usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    weth: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    btcb: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
  },
  // Arbitrum
  42161: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    usdt: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  },
  // Polygon
  137: {
    matic: EVM_NATIVE,
    pol: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    usdt0: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    weth: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    wmatic: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    wpol: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  },
  // Optimism
  10: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    usdt: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
    weth: '0x4200000000000000000000000000000000000006',
    op: '0x4200000000000000000000000000000000000042',
  },
  // Avalanche
  43114: {
    avax: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    usdt: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
    wavax: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
    'weth.e': '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
  },
  // X Layer
  196: {
    okb: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x74b7f16337b8972027f6196a17a631ac6de26d22',
    xlayer_usdt: '0x1e4a5963abfd975d8c9021ce480b42188849d41d',
    usdt0: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
    usdt: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
    weth: '0x5a77f1443d16ee5761d310e38b62f77f726bc71c',
    wokb: '0xe538905cf8410324e03a5a23c1c177a474d59b2b',
  },
  // X Layer Testnet
  1952: {
    okb: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d',
    usdt: '0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c',
    usdg: '0xa78e2baabaf5c4f36b7fc394725deb68d332eec1',
  },
  // Linea
  59144: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
    usdt: '0xa219439258ca9da29e9cc4ce5596924745e12b93',
    weth: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  },
  // Scroll
  534352: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    usdc: '0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4',
    usdt: '0xf55bec9cafdbe8730f096aa55dad6d22d44099df',
    weth: '0x5300000000000000000000000000000000000004',
  },
  // zkSync
  324: {
    eth: EVM_NATIVE,
    native: EVM_NATIVE,
    weth: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91',
    usdt: '0x493257fd37edb34451f62edf8d2a0c418852ba4c',
  },
  // Fantom
  250: {
    ftm: EVM_NATIVE,
    native: EVM_NATIVE,
    wftm: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83',
  },
  // Tron
  195: {
    trx: TRX_NATIVE,
    native: TRX_NATIVE,
    usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    wtrx: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
    eth: 'THb4CqiFdwNHsWsQCs4JhzwjMWys4aqCbF',
  },
  // Sui
  784: {
    sui: SUI_NATIVE,
    native: SUI_NATIVE,
    wusdc: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
    wusdt: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
  },
  // Arc — native gas asset is USDC itself, not the 0xeeee… EVM placeholder.
  5042: {
    usdc: ARC_NATIVE,
    native: ARC_NATIVE,
  },
});

for (const m of Object.values(TOKEN_MAP)) Object.freeze(m);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const chainMap = (ci) => (own(TOKEN_MAP, ci) ? TOKEN_MAP[ci] : undefined);

// upstream: token_alias.rs::has_alias
export function hasAlias(chainIndex, alias) {
  const m = chainMap(String(chainIndex));
  return !!m && own(m, asciiLower(alias));
}

// upstream: token_alias.rs::resolve_token_address — mapped CA, else the input unchanged.
export function resolveTokenAddress(chainIndex, token) {
  const m = chainMap(String(chainIndex));
  const key = asciiLower(token);
  return m && own(m, key) ? m[key] : String(token);
}

const isHexAddr = (t) => (t.startsWith('0x') || t.startsWith('0X')) && byteLen(t) === 42 && [...t.slice(2)].every(isAsciiHex);

// upstream: token_alias.rs::validate_address_for_chain — throws with upstream's text.
export function validateAddressForChain(chainIndex, token, label) {
  const ci = String(chainIndex);
  const chars = [...token];
  switch (ci) {
    case '501': {
      if (token.startsWith('0x') || token.startsWith('0X')) {
        throw new Error(`--${label} looks like an EVM address (0x…) but chain is Solana. Solana uses base58 addresses (e.g. EPjFWdd5...wyTDt1v). Did you mean to use a different chain?`);
      }
      const len = byteLen(token);
      if (len < 32 || len > 44) {
        throw new Error(`--${label} is not a valid Solana address: expected 32-44 base58 characters, got ${len} characters ("${token}")`);
      }
      if (!chars.every((c) => isAsciiAlnum(c) && !['0', 'O', 'I', 'l'].includes(c))) {
        throw new Error(`--${label} is not a valid Solana address: contains characters outside base58 alphabet ("${token}")`);
      }
      return;
    }
    // Tron / TON / Sui — native formats differ; the API validates.
    case '195':
    case '607':
    case '784':
      return;
    default: {
      const len = byteLen(token);
      if (!token.startsWith('0x') && !token.startsWith('0X') && len >= 32 && len <= 44
        && chars.every(isAsciiAlnum) && chars.some(isAsciiUpper)) {
        throw new Error(`--${label} looks like a Solana/base58 address but chain is EVM (chainIndex=${ci}). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?`);
      }
      if (!isHexAddr(token)) {
        throw new Error(`--${label} is not a valid EVM address: expected 0x + 40 hex digits, got "${token}"`);
      }
    }
  }
}

// upstream: token_alias.rs::resolve_and_validate — alias → CA → format check.
export function resolveAndValidate(chainIndex, raw, label) {
  const resolved = resolveTokenAddress(chainIndex, raw);
  validateAddressForChain(chainIndex, resolved, label);
  return resolved;
}
