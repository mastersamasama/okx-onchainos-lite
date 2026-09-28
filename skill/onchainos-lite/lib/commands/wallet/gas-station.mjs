// wallet gas-station update-default-token | enable | disable | status | setup
// upstream: commands/agentic_wallet/mod.rs::execute (GasStation arm) → gas_station.rs::execute
import { execute } from '../../wallet/gas-station.mjs';
import { clap } from '../../wallet/utxo/_clap.mjs';

// Every leaf's --chain is required at the leaf (the global --chain does not satisfy it).
const leaf = (uses, toCommand) => ({
  uses,
  run(ctx, o) {
    clap(ctx, {});
    return execute(toCommand(o));
  },
});

export default {
  'wallet gas-station update-default-token': leaf(['chain', 'gasTokenAddress'],
    (o) => ({ kind: 'UpdateDefaultToken', chain: o.chain, gasTokenAddress: o.gasTokenAddress })),
  'wallet gas-station enable': leaf(['chain'], (o) => ({ kind: 'Enable', chain: o.chain })),
  'wallet gas-station disable': leaf(['chain'], (o) => ({ kind: 'Disable', chain: o.chain })),
  'wallet gas-station status': leaf(['chain', 'from'], (o) => ({ kind: 'Status', chain: o.chain, from: o.from })),
  'wallet gas-station setup': leaf(['chain', 'gasTokenAddress', 'relayerId', 'from'],
    (o) => ({ kind: 'Setup', chain: o.chain, gasTokenAddress: o.gasTokenAddress, relayerId: o.relayerId, from: o.from })),
};
