// `payment decode-receipt` — upstream commands/payment/dispatcher.rs::cmd_decode_receipt.
import { clap } from '../../payment/_clap.mjs';
import { cmdDecodeReceipt } from '../../payment/dispatcher.mjs';

export default {
  'payment decode-receipt': {
    uses: ['header', 'receipt'],
    run(ctx, o) {
      // clap: `--header` required_unless_present / conflicts_with `--receipt`.
      clap(ctx, { conflicts: [['header', 'receipt']], required: o.receipt === undefined ? ['header'] : [] });
      return cmdDecodeReceipt(o.header ?? null, o.receipt ?? null);
    },
  },
};
