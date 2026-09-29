// `payment subscription …` — upstream commands/payment/subscription.rs::execute. subscribe/change
// ignore the global `--chain`; the other subcommands declare their own `--chain` (default xlayer),
// which also receives a global `--chain` given higher up (verified against the 4.6.3 binary).
import { typed } from '../../core/cli.mjs';
import { execute } from '../../payment/subscription.mjs';

const label = (sub) => `payment subscription ${sub}`;

export default {
  'payment subscription subscribe': {
    uses: ['accepts', 'from', 'url'],
    label: label('subscribe'),
    run(ctx, o) {
      return execute({ kind: 'subscribe', accepts: o.accepts, from: o.from, url: o.url });
    },
  },
  'payment subscription access': {
    uses: ['url', 'subId', 'from', 'chain'],
    label: label('access'),
    run(ctx, o) {
      return execute({ kind: 'access', url: o.url, subId: o.subId, from: o.from, chain: o.chain });
    },
  },
  'payment subscription change': {
    uses: ['accepts', 'subId', 'from', 'url'],
    label: label('change'),
    run(ctx, o) {
      return execute({ kind: 'change', accepts: o.accepts, subId: o.subId, from: o.from, url: o.url });
    },
  },
  'payment subscription cancel': {
    uses: ['subId', 'contract', 'token', 'chain', 'from'],
    label: label('cancel'),
    run(ctx, o) {
      return execute({ kind: 'cancel', subId: o.subId, contract: o.contract, token: o.token, chain: o.chain, from: o.from });
    },
  },
  'payment subscription cancel-pending': {
    uses: ['subId', 'newSubId', 'contract', 'token', 'chain', 'from'],
    label: label('cancel-pending'),
    run(ctx, o) {
      return execute({ kind: 'cancel-pending', subId: o.subId, newSubId: o.newSubId, contract: o.contract, token: o.token, chain: o.chain, from: o.from });
    },
  },
  'payment subscription my-subscriptions': {
    uses: ['chain', 'from', 'limit', 'offset'],
    label: label('my-subscriptions'),
    run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'u32');
      const offset = typed(ctx.path, 'offset', o.offset, 'u32');
      return execute({ kind: 'my-subscriptions', chain: o.chain, from: o.from, limit, offset });
    },
  },
  'payment subscription allowance-status': {
    uses: ['token', 'chain', 'from'],
    label: label('allowance-status'),
    run(ctx, o) {
      return execute({ kind: 'allowance-status', token: o.token, chain: o.chain, from: o.from });
    },
  },
};
