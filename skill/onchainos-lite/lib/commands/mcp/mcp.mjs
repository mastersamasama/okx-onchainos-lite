// `onchainos mcp` — upstream main.rs: `Commands::Mcp` runs `mcp::serve()` before Context/audit
// (no audit entry, no AppConfig load) and serves JSON-RPC over stdio until stdin closes.
// A serve failure (handshake error) prints {"ok":false,"error":…} and exits 1 (main's report).
// The global --chain is accepted and ignored.
import { NO_OUTPUT } from '../../core/context.mjs';

export default {
  mcp: {
    uses: [],
    async run() {
      const { serve } = await import('../../mcp/index.mjs');
      await serve({ input: process.stdin, output: process.stdout });
      // service.waiting() returned: flush stdout, then end even if a dropped tool call still
      // holds a socket or timer (upstream's runtime drops those tasks on return).
      await new Promise((r) => process.stdout.write('', () => r()));
      process.exit(0);
      return NO_OUTPUT;
    },
  },
};
