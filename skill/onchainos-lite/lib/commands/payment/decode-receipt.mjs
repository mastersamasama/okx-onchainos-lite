// `payment decode-receipt` — upstream commands/payment/dispatcher.rs::cmd_decode_receipt.
import { cmdDecodeReceipt } from '../../payment/dispatcher.mjs';

export default {
  'payment decode-receipt': {
    uses: ['header', 'receipt'],
    run: (ctx, o) => cmdDecodeReceipt(o.header ?? null, o.receipt ?? null),
  },
};
