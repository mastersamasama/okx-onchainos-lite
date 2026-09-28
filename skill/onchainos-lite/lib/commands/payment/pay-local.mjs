// `payment pay-local` — upstream commands/payment/dispatcher.rs::execute(Eip3009Sign):
// sign the decoded `--payload` locally with EVM_PRIVATE_KEY (env, else $HOME/.env).
import { cmdPayLocal } from '../../payment/dispatcher.mjs';

export default {
  'payment pay-local': {
    uses: ['payload'],
    run: (ctx, o) => cmdPayLocal(o.payload),
  },
};
