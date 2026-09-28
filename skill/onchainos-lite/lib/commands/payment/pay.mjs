// `payment pay` — upstream commands/payment/dispatcher.rs::execute(X402Pay):
// `--payment-id` → two-phase complete (cmd_pay_two_phase), else legacy sign-only `--payload`.
import { clap, leafValues } from '../../payment/_clap.mjs';
import { cmdPay, cmdPayTwoPhase } from '../../payment/dispatcher.mjs';

export default {
  'payment pay': {
    uses: ['payload', 'paymentId', 'selectedIndex', 'param', 'yes'],
    async run(ctx, o) {
      // clap: `--payload` required_unless_present / conflicts_with `--payment-id`; usize index.
      const { selectedIndex } = clap(ctx, {
        typed: { selectedIndex: 'usize' },
        conflicts: [['payload', 'paymentId']],
        required: o.paymentId === undefined ? ['payload'] : [],
      });
      if (o.paymentId !== undefined) return cmdPayTwoPhase(o.paymentId, selectedIndex, leafValues(ctx, 'param'), !!o.yes);
      return cmdPay(o.payload, selectedIndex);
    },
  },
};
