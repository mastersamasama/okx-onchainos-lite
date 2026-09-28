// Strategy chain whitelist (Phase 1: 6 chains per BE ChainInfoEnum) —
// upstream commands/agentic_wallet/strategy/supported_chains.rs. Deliberately NOT the global
// chain registry: its superset includes chains the strategy BE rejects.

// upstream: supported_chains.rs::SUPPORTED_STRATEGY_CHAINS (ascending by chainIndex)
export const SUPPORTED_STRATEGY_CHAINS = Object.freeze([
  Object.freeze({ chainIndex: '1', name: 'Ethereum' }),
  Object.freeze({ chainIndex: '56', name: 'BSC' }),
  Object.freeze({ chainIndex: '196', name: 'X Layer' }),
  Object.freeze({ chainIndex: '501', name: 'Solana' }),
  Object.freeze({ chainIndex: '8453', name: 'Base' }),
  Object.freeze({ chainIndex: '42161', name: 'Arbitrum' }),
]);

// upstream: supported_chains.rs::ensure_strategy_chain — throws unless whitelisted.
export function ensureStrategyChain(chainIndex, rawInput) {
  if (SUPPORTED_STRATEGY_CHAINS.some((c) => c.chainIndex === chainIndex)) return;
  const supportedList = SUPPORTED_STRATEGY_CHAINS.map((c) => `${c.name} (${c.chainIndex})`).join(', ');
  throw new Error(`chain "${rawInput}" (resolved to chainIndex ${chainIndex}) is not supported for strategy orders. Phase 1 supports: ${supportedList}`);
}

// upstream: supported_chains.rs::is_solana
export const isSolana = (chainIndex) => chainIndex === '501';
