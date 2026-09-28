// wallet utxo user-ignored | unavailable | available | brc20-transferable | unlock | lock | reclaim
// upstream: commands/agentic_wallet/mod.rs::execute (Utxo arms, ensure_bitcoin_command_chain) → utxo/*.rs
import { resolve as resolveChainProfile } from '../../wallet/chain-profile.mjs';
import { cmdUserIgnored, cmdUnavailable, cmdAvailable, cmdBrc20Transferable, cmdUnlock, cmdLock, cmdReclaim } from '../../wallet/utxo/index.mjs';
import { clap } from '../../wallet/utxo/_clap.mjs';

// upstream: mod.rs::ensure_bitcoin_command_chain
async function ensureBitcoinCommandChain(chain) {
  const profile = await resolveChainProfile(chain);
  if (!profile.isBitcoin()) throw new Error('this UTXO command is only supported for Bitcoin');
}

// clap Vec<String> (append): every occurrence, in argv order.
const values = (v) => [].concat(v ?? []);

// --outpoint conflicts with --all and is required unless --all is present.
const manageClap = (ctx) => clap(ctx, { conflicts: [['outpoint', 'all']], requiredUnless: [['outpoint', ['all']]] });

const query = (fn) => ({
  uses: ['chain'],
  async run(ctx, o) {
    clap(ctx, {});
    await ensureBitcoinCommandChain(o.chain);
    return fn();
  },
});

export default {
  'wallet utxo user-ignored': query(cmdUserIgnored),
  'wallet utxo unavailable': query(cmdUnavailable),
  'wallet utxo available': query(cmdAvailable),

  'wallet utxo brc20-transferable': {
    uses: ['chain', 'tokenAddress', 'readableAmount'],
    async run(ctx, o) {
      clap(ctx, {});
      await ensureBitcoinCommandChain(o.chain);
      return cmdBrc20Transferable(o.tokenAddress, o.readableAmount);
    },
  },

  'wallet utxo unlock': {
    uses: ['chain', 'outpoint', 'all', 'operationToken', 'force'],
    async run(ctx, o) {
      manageClap(ctx);
      await ensureBitcoinCommandChain(o.chain);
      return cmdUnlock(values(o.outpoint), o.all, o.operationToken, o.force);
    },
  },

  'wallet utxo lock': {
    uses: ['chain', 'outpoint', 'all', 'operationToken', 'force'],
    async run(ctx, o) {
      manageClap(ctx);
      await ensureBitcoinCommandChain(o.chain);
      return cmdLock(values(o.outpoint), o.all, o.operationToken, o.force);
    },
  },

  'wallet utxo reclaim': {
    uses: ['chain', 'txHash', 'force'],
    async run(ctx, o) {
      clap(ctx, {});
      await ensureBitcoinCommandChain(o.chain);
      return cmdReclaim(values(o.txHash), o.force);
    },
  },
};
