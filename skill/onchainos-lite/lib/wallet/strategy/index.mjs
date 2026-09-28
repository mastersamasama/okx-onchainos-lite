// `onchainos strategy` — Phase 1 limit orders (4 subcommands); 60018 is handled transparently
// via SD-A → retry once. Upstream commands/agentic_wallet/strategy/mod.rs.
import * as handlers from './handlers.mjs';

// upstream: mod.rs::StrategyCommand (subcommand name → handler)
export const StrategyCommand = Object.freeze({
  'create-limit': handlers.createLimit,
  cancel: handlers.cancel,
  list: handlers.list,
  resume: handlers.resume,
});

// upstream: mod.rs::execute — `cmd` is the subcommand name, `args` its parsed arguments.
export function execute(ctx, cmd, args) {
  const handler = StrategyCommand[cmd];
  if (!handler) throw new Error(`unknown strategy subcommand '${cmd}'`);
  return handler(ctx, args);
}
