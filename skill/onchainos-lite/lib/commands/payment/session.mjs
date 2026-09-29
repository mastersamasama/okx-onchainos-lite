// `payment session open|voucher|topup|close` — upstream commands/payment/dispatcher.rs
// (cmd_mpp_session_*). The global `--chain` is accepted and ignored (`--chain-id` is the leaf's own).
import { typed } from '../../core/cli.mjs';
import { cmdMppSessionOpen, cmdMppSessionVoucher, cmdMppSessionTopup, cmdMppSessionClose } from '../../payment/session.mjs';

export default {
  'payment session open': {
    uses: ['challenge', 'deposit', 'from', 'txHash', 'salt', 'initialCum', 'prepayFirst'],
    label: 'payment session open',
    run(ctx, o) {
      return cmdMppSessionOpen(o.challenge, o.deposit, o.from ?? null, o.txHash ?? null, o.salt ?? null, o.initialCum ?? null, !!o.prepayFirst);
    },
  },
  'payment session voucher': {
    uses: ['challenge', 'channelId', 'cumulativeAmount', 'escrow', 'chainId', 'from', 'reuseSignature'],
    label: 'payment session voucher',
    run(ctx, o) {
      const chainId = typed(ctx.path, 'chainId', o.chainId, 'u64');
      return cmdMppSessionVoucher(o.challenge, o.channelId, o.cumulativeAmount, o.escrow ?? null, chainId ?? null, o.from ?? null, o.reuseSignature ?? null);
    },
  },
  'payment session topup': {
    uses: ['challenge', 'channelId', 'additionalDeposit', 'escrow', 'chainId', 'currency', 'from', 'txHash'],
    label: 'payment session topup',
    run(ctx, o) {
      const chainId = typed(ctx.path, 'chainId', o.chainId, 'u64');
      return cmdMppSessionTopup(o.challenge, o.channelId, o.additionalDeposit, o.escrow, chainId, o.currency ?? null, o.from ?? null, o.txHash ?? null);
    },
  },
  'payment session close': {
    uses: ['channelId', 'cumulativeAmount', 'escrow', 'chainId', 'challenge', 'from'],
    label: 'payment session close',
    run(ctx, o) {
      const chainId = typed(ctx.path, 'chainId', o.chainId, 'u64');
      return cmdMppSessionClose(o.channelId, o.cumulativeAmount, o.escrow, chainId, o.challenge, o.from ?? null);
    },
  },
};
