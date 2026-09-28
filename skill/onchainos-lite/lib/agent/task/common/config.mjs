// Task module toggles — upstream task/common/config.rs.
import { eqIgnoreAsciiCase } from '../../_rs.mjs';

// upstream: config.rs::KEEP_CONVERSATION_ON_TERMINAL_DEFAULT (the published binary is built
// without a compile-time ONCHAINOS_KEEP_SESSION, so the default applies).
const KEEP_CONVERSATION_ON_TERMINAL_DEFAULT = false;
const parseBool = (s) => eqIgnoreAsciiCase(s, 'true') || s === '1';

// upstream: config.rs::SubscriptionTradePath
export const SubscriptionTradePath = Object.freeze({ AgentDirect: 'agent_direct', LegacyWrapper: 'legacy_wrapper', default: 'agent_direct' });

// upstream: config.rs::keep_conversation_on_terminal
export function keepConversationOnTerminal() {
  const v = process.env.ONCHAINOS_KEEP_SESSION;
  return v === undefined ? KEEP_CONVERSATION_ON_TERMINAL_DEFAULT : parseBool(v);
}

// upstream: config.rs::is_cli_mode
export function isCliMode() {
  return (process.env.CLAUDECODE ?? '') === '1' || (process.env.CODEX_THREAD_ID ?? '') !== '';
}
