// wallet balance
// upstream: commands/agentic_wallet/mod.rs::execute (Balance arm: token normalisation) →
//   balance/mod.rs::cmd_balance
import { resolve as resolveChainProfile, TransferDriver } from '../../wallet/chain-profile.mjs';
import { normalizeBrc20TokenAddress } from '../../wallet/shared/adapters/bitcoin/validation.mjs';
import { normalizeCoinType } from '../../wallet/shared/adapters/sui/identifiers.mjs';
import { cmdBalance } from '../../wallet/balance/index.mjs';

const some = (v) => v !== undefined && v !== null;

// mod.rs — with both --chain and --token-address, BRC-20 / SUI Coin Type identifiers are
// normalised through the chain profile first (even when --all is also set).
async function normalizedChainToken(chain, tokenAddress) {
  if (!some(chain) || !some(tokenAddress)) return undefined;
  const profile = await resolveChainProfile(chain);
  if (profile.capabilities.transfer === TransferDriver.Bitcoin) return normalizeBrc20TokenAddress(tokenAddress);
  if (profile.capabilities.transfer === TransferDriver.Sui) return normalizeCoinType(tokenAddress);
  return undefined;
}

export default {
  'wallet balance': {
    uses: ['all', 'chain', 'tokenAddress', 'force'],
    async run(ctx, o) {
      const normalized = await normalizedChainToken(o.chain, o.tokenAddress);
      return cmdBalance(o.all, o.chain, normalized ?? o.tokenAddress, o.force);
    },
  },
};
