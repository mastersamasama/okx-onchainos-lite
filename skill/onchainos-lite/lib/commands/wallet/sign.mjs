// wallet sign-message
// upstream: commands/agentic_wallet/mod.rs::execute (SignMessage arm) → sign.rs::cmd_sign_message
import { resolve as resolveChainProfile, MessageSignDriver } from '../../wallet/chain-profile.mjs';
import { cmdSignMessage } from '../../wallet/sign.mjs';

export default {
  'wallet sign-message': {
    uses: ['type', 'message', 'chain', 'from', 'force'],
    async run(ctx, o) {
      const profile = await resolveChainProfile(o.chain);
      if (profile.capabilities.messageSign === MessageSignDriver.Unsupported) {
        throw new Error(`wallet sign-message is not supported for chain '${profile.chainName}'`);
      }
      return cmdSignMessage(o.type, o.message, o.chain, o.from, o.force);
    },
  },
};
