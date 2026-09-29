// wallet inscription create | status
// upstream: commands/agentic_wallet/mod.rs::execute (Inscription arms: chain capability check) →
//   inscription/bitcoin.rs::{cmd_create, cmd_query_status}
import { resolve as resolveChainProfile, InscriptionDriver } from '../../wallet/chain-profile.mjs';
import { cmdCreate, cmdQueryStatus } from '../../wallet/inscription/bitcoin.mjs';

async function ensureInscriptionChain(chain) {
  const profile = await resolveChainProfile(chain);
  if (profile.capabilities.inscription !== InscriptionDriver.Bitcoin) throw new Error(`wallet inscription is not supported for chain '${profile.chainName}'`);
}

export default {
  'wallet inscription create': {
    uses: ['chain', 'tokenAddress', 'readableAmount', 'from', 'operationToken', 'feeRate', 'force'],
    async run(ctx, o) {
      await ensureInscriptionChain(o.chain);
      return cmdCreate(o.tokenAddress, o.readableAmount, o.from, o.operationToken, o.feeRate, o.force);
    },
  },

  'wallet inscription status': {
    uses: ['chain', 'txHash', 'orderId'],
    async run(ctx, o) {
      await ensureInscriptionChain(o.chain);
      return cmdQueryStatus(o.txHash, o.orderId);
    },
  },
};
