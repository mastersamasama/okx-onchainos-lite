// `payment quote <URL>` — upstream commands/payment/quote.rs::run (dispatched from dispatcher.rs).
import { leafValues } from '../../payment/_clap.mjs';
import { run } from '../../payment/quote.mjs';

export default {
  'payment quote': {
    uses: ['url', 'param', 'method', 'tool'],
    run: (ctx, o) => run(o.url, leafValues(ctx, 'param'), o.method, o.tool ?? null),
  },
};
