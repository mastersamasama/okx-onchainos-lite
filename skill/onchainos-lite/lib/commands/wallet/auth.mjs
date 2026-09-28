// wallet login | add | switch | status | addresses | logout | geoblock | report-plugin-info
// upstream: commands/agentic_wallet/mod.rs::execute → auth/mod.rs, account.rs, geoblock.rs, plugin.rs
import { NO_OUTPUT } from '../../core/context.mjs';
import { cmdLoginInit, cmdLoginOpen, cmdLoginPoll, cmdAdd, cmdLogout } from '../../wallet/auth.mjs';
import { cmdSwitch, cmdStatus, cmdAddresses } from '../../wallet/account.mjs';
import { cmdCheck } from '../../wallet/geoblock.mjs';
import { cmdReportPluginInfo } from '../../wallet/plugin.mjs';

export default {
  'wallet login': {
    uses: ['phase', 'url', 'sessionId'],
    async run(ctx, o) {
      switch (o.phase) {
        case 'open':
          if (o.url === undefined) throw new Error('`--url` is required for `--phase open`');
          return cmdLoginOpen(o.url);
        case 'poll':
          return cmdLoginPoll(o.sessionId);
        default:
          return cmdLoginInit();
      }
    },
  },

  'wallet add': {
    uses: [],
    run: () => cmdAdd(),
  },

  'wallet switch': {
    uses: ['accountId'],
    run: (ctx, o) => cmdSwitch(o.accountId),
  },

  // Hidden legacy flag `--include-subscriptions` is a no-op upstream (not in lib/spec.json).
  'wallet status': {
    uses: [],
    ignores: ['includeSubscriptions'],   // hidden legacy flag (mod.rs:67), accepted and ignored upstream
    run: () => cmdStatus(),
  },

  // The subcommand's own --chain (clap also propagates a global --chain into it).
  'wallet addresses': {
    uses: ['chain'],
    run: (ctx, o) => cmdAddresses(o.chain),
  },

  'wallet logout': {
    uses: [],
    run: () => cmdLogout(),
  },

  // Prints a bare {"blocked":bool} line (no envelope) on success.
  'wallet geoblock': {
    uses: [],
    async run() {
      await cmdCheck();
      return NO_OUTPUT;
    },
  },

  'wallet report-plugin-info': {
    uses: ['pluginParameter'],
    run: (ctx, o) => cmdReportPluginInfo(o.pluginParameter),
  },
};
