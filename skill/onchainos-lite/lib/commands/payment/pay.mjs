// `payment pay` — upstream commands/payment/dispatcher.rs::execute(X402Pay):
// `--payment-id` → two-phase complete (cmd_pay_two_phase), else legacy sign-only `--payload`.
import { typed } from '../../core/cli.mjs';
import { cmdPay, cmdPayTwoPhase } from '../../payment/dispatcher.mjs';

export default {
  'payment pay': {
    uses: ['payload', 'paymentId', 'selectedIndex', 'param', 'yes'],
    async run(ctx, o) {
      const selectedIndex = typed(ctx.path, 'selectedIndex', o.selectedIndex, 'usize');
      if (o.paymentId !== undefined) return cmdPayTwoPhase(o.paymentId, selectedIndex, o.param ?? [], !!o.yes);
      return cmdPay(o.payload, selectedIndex);
    },
  },
};
