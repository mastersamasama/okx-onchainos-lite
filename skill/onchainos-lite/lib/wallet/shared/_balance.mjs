// PRIVATE — lazy bridge to the agentic_wallet/balance/mod.rs helpers the transaction pipeline
// calls (ensure_wallet_accounts_fresh, query_token_readable, query_token_metadata), which live in
// their owner module lib/wallet/balance/index.mjs. The module is imported on first use rather than
// statically: balance/index.mjs → utxo/brc20.mjs → shared/adapters/bitcoin/context.mjs →
// shared/common/context.mjs (which needs ensure_wallet_accounts_fresh) would otherwise form an
// import cycle evaluated at start-up.
const balance = () => import('../balance/index.mjs');

// upstream: balance/mod.rs::ensure_wallet_accounts_fresh — best effort; mutates `wallets`.
export async function ensureWalletAccountsFresh(client, accessToken, wallets, force) {
  return (await balance()).ensureWalletAccountsFresh(client, accessToken, wallets, force);
}

// upstream: balance/mod.rs::query_token_readable → MatchedToken { balance, symbol?, decimals? } | null
export async function queryTokenReadable(chainIndex, tokenAddress) {
  return (await balance()).queryTokenReadable(chainIndex, tokenAddress);
}

// upstream: balance/mod.rs::query_token_metadata → TokenMetadata { symbol?, decimals }
export async function queryTokenMetadata(chainIndex, tokenAddress) {
  return (await balance()).queryTokenMetadata(chainIndex, tokenAddress);
}
