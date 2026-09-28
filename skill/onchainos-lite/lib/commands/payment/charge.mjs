// `payment charge` — upstream commands/payment/dispatcher.rs::cmd_mpp_charge (MPP one-shot charge:
// TEE EIP-3009 transaction mode, or hash mode wrapping a client-broadcast tx).
import { cmdMppCharge } from '../../payment/dispatcher.mjs';

export default {
  'payment charge': {
    uses: ['challenge', 'from', 'txHash'],
    run: (ctx, o) => cmdMppCharge(o.challenge, o.from ?? null, o.txHash ?? null),
  },
};
