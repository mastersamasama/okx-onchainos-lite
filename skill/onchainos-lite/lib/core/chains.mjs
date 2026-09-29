// Chain registry — upstream chains.rs.
import { loadChainCache } from './store.mjs';
import { XLAYER_RPC_URL } from '../config.mjs';
import { trim } from './rs/str.mjs';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
export const X402_UPTO_PERMIT2_PROXY = '0x4020e7393B728A3939659E5732F87fdd8e680002';
export const SUPPORTED_CHAIN_INDICES = ['1', '10', '56', '137', '195', '196', '250', '324', '501', '534352', '607', '784', '1952', '8453', '42161', '43114', '59144'];
const EVM = new Set(['1', '10', '56', '137', '196', '250', '324', '1952', '8453', '42161', '43114', '59144', '534352']);

const ALIASES = {
  ethereum: '1', eth: '1', solana: '501', sol: '501', bitcoin: '0', btc: '0', bsc: '56', bnb: '56',
  polygon: '137', matic: '137', arbitrum: '42161', arb: '42161', base: '8453',
  xlayer: '196', 'x layer': '196', 'x-layer': '196', okb: '196', xlayer_test: '1952',
  avalanche: '43114', avax: '43114', optimism: '10', op: '10', fantom: '250', ftm: '250',
  sui: '784', tron: '195', trx: '195', ton: '607', linea: '59144', scroll: '534352', zksync: '324', tempo: '4217',
};

const cacheChains = () => { try { return loadChainCache()?.chains ?? []; } catch { return []; } };
const idx = (c) => (c?.chainIndex === undefined || c?.chainIndex === null ? undefined : String(c.chainIndex));
const cacheEntry = (ci) => cacheChains().find((c) => idx(c) === ci);

export function resolveChain(name) {
  const lower = String(name).toLowerCase();
  const hit = cacheChains().find((c) => typeof c?.chainName === 'string' && c.chainName.toLowerCase() === lower);
  if (hit && idx(hit) !== undefined) return idx(hit);
  return ALIASES[lower] ?? String(name);
}

export const resolveChains = (names) => String(names).split(',').map((s) => resolveChain(trim(s))).join(',');

export function ensureSupportedChain(ci, raw) {
  if (cacheEntry(ci) || SUPPORTED_CHAIN_INDICES.includes(ci)) return;
  throw new Error(`unsupported chain: "${raw}" (resolved to "${ci}"). Use \`onchainos swap chains\` to list supported chains.`);
}

export function isEvmChain(ci) {
  const e = cacheEntry(ci);
  if (e && typeof e.isEvmChain === 'boolean') return e.isEvmChain;
  return EVM.has(ci);
}

export function isMainnetChain(ci) {
  const e = cacheEntry(ci);
  if (e) {
    if (typeof e.isTestnet === 'boolean') return !e.isTestnet;
    if (typeof e.testnet === 'boolean') return !e.testnet;
    return !String(e.chainName ?? '').toLowerCase().includes('test');
  }
  if (ci === '1952') return false;
  return SUPPORTED_CHAIN_INDICES.includes(ci);
}

const NAMES = { 1: 'ethereum', 0: 'bitcoin', 10: 'optimism', 56: 'bsc', 137: 'polygon', 195: 'tron', 196: 'xlayer', 250: 'fantom', 324: 'zksync', 501: 'solana', 534352: 'scroll', 607: 'ton', 784: 'sui', 1952: 'xlayer_test', 8453: 'base', 42161: 'arbitrum', 43114: 'avalanche', 59144: 'linea' };
export const chainNameForIndex = (ci) => NAMES[ci];

const DISPLAY = { 0: 'Bitcoin', 5: 'Bitcoin', 1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon', 195: 'Tron', 196: 'X Layer', 1952: 'X Layer Testnet', 250: 'Fantom', 324: 'zkSync', 501: 'Solana', 534352: 'Scroll', 607: 'TON', 784: 'Sui', 8453: 'Base', 42161: 'Arbitrum One', 43114: 'Avalanche', 59144: 'Linea', 5042: 'Arc' };
export const chainDisplayName = (ci) => DISPLAY[ci] ?? String(ci);

export function nativeTokenSymbol(ci) {
  if (['0', '5'].includes(ci)) return 'BTC';
  if (['1', '10', '324', '534352', '8453', '42161', '59144'].includes(ci)) return 'ETH';
  return { 56: 'BNB', 137: 'MATIC', 195: 'TRX', 196: 'OKB', 1952: 'OKB', 250: 'FTM', 43114: 'AVAX', 501: 'SOL', 607: 'TON', 784: 'SUI', 5042: 'USDC' }[ci] ?? 'native token';
}

export function nativeTokenAddress(ci) {
  return {
    0: '', 5: '', 501: '11111111111111111111111111111111', 784: '0x2::sui::SUI', 195: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    607: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c', 5042: '0x3600000000000000000000000000000000000000',
  }[ci] ?? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
}

export const chainFamily = (ci) => (ci === '501' ? 'solana' : 'evm');
export const mergesBatchUnsignedInfo = (ci) => ci === '196' || ci === '1952';
export const rpcUrlForChain = (ci) => (ci === '196' ? XLAYER_RPC_URL : undefined);
export const cachedChains = cacheChains;
