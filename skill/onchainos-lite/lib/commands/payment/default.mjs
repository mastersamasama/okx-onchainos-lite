// `payment default set|get|unset` — upstream commands/payment/dispatcher.rs::cmd_default.
import { cmdDefault } from '../../payment/dispatcher.mjs';

export default {
  'payment default set': {
    uses: ['asset', 'chain', 'name', 'tier'],
    label: 'payment default-set',
    run: (ctx, o) => cmdDefault({ kind: 'set', asset: o.asset, chain: o.chain, name: o.name ?? null, tier: o.tier ?? null }),
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
