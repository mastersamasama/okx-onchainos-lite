// `payment default set|get|unset` — upstream commands/payment/dispatcher.rs::cmd_default.
import { clap } from '../../payment/_clap.mjs';
import { cmdDefault } from '../../payment/dispatcher.mjs';

export default {
  'payment default set': {
    uses: ['asset', 'chain', 'name', 'tier'],
    label: 'payment default-set',
    run(ctx, o) {
      // The leaf's own required `--chain` is not satisfied by the global `--chain`.
      clap(ctx, { required: ['asset', 'chain'] });
      return cmdDefault({ kind: 'set', asset: o.asset, chain: o.chain, name: o.name ?? null, tier: o.tier ?? null });
    },
  },
  'payment default get': {
    uses: [],
    label: 'payment default-get',
    run: () => cmdDefault({ kind: 'get' }),
  },
  'payment default unset': {
    uses: [],
    label: 'payment default-unset',
    run: () => cmdDefault({ kind: 'unset' }),
  },
};
