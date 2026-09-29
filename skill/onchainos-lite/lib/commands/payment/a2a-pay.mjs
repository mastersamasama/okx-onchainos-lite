// `payment a2a-pay create|pay|status` — upstream commands/payment/a2a_pay.rs::execute.
// The global `--chain` is accepted and ignored.
import { typed } from '../../core/cli.mjs';
import { execute } from '../../payment/a2a-pay.mjs';

export default {
  'payment a2a-pay create': {
    uses: ['type', 'amount', 'symbol', 'recipient', 'description', 'realm', 'externalId', 'expiresIn'],
    label: 'payment a2a-pay create',
    run(ctx, o) {
      const expiresIn = typed(ctx.path, 'expiresIn', o.expiresIn, 'u64');
      return execute({
        kind: 'create',
        args: {
          type: o.type, amount: o.amount, symbol: o.symbol, recipient: o.recipient ?? null, description: o.description ?? null,
          realm: o.realm ?? null, externalId: o.externalId ?? null, expiresIn: expiresIn ?? null,
        },
      });
    },
  },
  'payment a2a-pay pay': {
    uses: ['paymentId', 'amount', 'currency', 'recipientAddress'],
    label: 'payment a2a-pay pay',
    run(ctx, o) {
      return execute({ kind: 'pay', args: { paymentId: o.paymentId, amount: o.amount, currency: o.currency, recipientAddress: o.recipientAddress } });
    },
  },
  'payment a2a-pay status': {
    uses: ['paymentId', 'wait'],
    label: 'payment a2a-pay status',
    run(ctx, o) {
      return execute({ kind: 'status', paymentId: o.paymentId, wait: !!o.wait });
    },
  },
};
