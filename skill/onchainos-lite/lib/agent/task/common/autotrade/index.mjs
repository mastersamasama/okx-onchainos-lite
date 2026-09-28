// Automatic signal execution shared submodule — upstream task/common/autotrade/mod.rs.
import { BespokeExit } from '../../../../core/errors.mjs';

// upstream: mod.rs::DEFAULT_AUTOTRADE_TTL_SEC
export const DEFAULT_AUTOTRADE_TTL_SEC = 31536000;
// upstream: mod.rs::EXECUTION_POLICY_NOT_CONFIGURED_REASON
export const EXECUTION_POLICY_NOT_CONFIGURED_REASON = 'execution_policy_not_configured';
// upstream: mod.rs::GUIDE_EXECUTION_UNAVAILABLE_REASON
export const GUIDE_EXECUTION_UNAVAILABLE_REASON = 'guide_execution_unavailable';

// upstream: mod.rs::RETIRED_MODE_CONFIGURATION_EVENTS
export const RETIRED_MODE_CONFIGURATION_EVENTS = Object.freeze(['autotrade_consent', 'autotrade_config_required']);
// upstream: mod.rs::is_retired_mode_configuration_decision (Option<&str>)
export const isRetiredModeConfigurationDecision = (e) => e !== undefined && e !== null && RETIRED_MODE_CONFIGURATION_EVENTS.includes(e);

// upstream: mod.rs::RETIRED_DELIVERY_DECISION_EVENTS
export const RETIRED_DELIVERY_DECISION_EVENTS = Object.freeze([
  'autotrade_consent', 'autotrade_consent_pre_delivery', 'autotrade_config_required', 'autotrade_manual_signal',
  'autotrade_over_cap', 'autotrade_cap_adjust', 'autotrade_tool_select', 'autotrade_plugin_install',
]);
// upstream: mod.rs::is_retired_delivery_decision
export const isRetiredDeliveryDecision = (e) => e !== undefined && e !== null && RETIRED_DELIVERY_DECISION_EVENTS.includes(e);

// upstream: mod.rs audit action names
export const ACTION_AUTOTRADE_DELIVER = 'user/autotrade_deliver';
export const ACTION_GRANT_CHECK = 'agent/autotrade_grant_check';
export const ACTION_AUTOTRADE_CONSENT_SET = 'user/autotrade_consent_set';

// upstream: mod.rs::DegradeReason — wire strings (DegradeReason::as_str). ConsentInvalid(code) /
// GrantDenied(code) carry their code verbatim, so they are represented by the code string itself.
export const DegradeReason = Object.freeze({
  FreshnessExpired: 'freshness_expired',
  SubscriptionNotActive: 'subscription_not_active',
  NoActiveWallet: 'no_active_wallet',
  StructureReject: 'structure_reject',
  TypeDegrade: 'type_degrade',
  OverCap: 'over_cap',
  PctHoldingFail: 'pct_holding_fail',
  HoldingTooSmall: 'holding_too_small',
  HoldingUnavailable: 'holding_unavailable',
  ReplaySkip: 'replay_skip',
  LatchWriteFail: 'latch_write_fail',
  LookupOff: 'lookup_off',
  MissingTradeAmount: 'missing_trade_amount',
  ToolMissing: 'tool_missing',
  EntryOutsideRange: 'entry_outside_range',
  MultipleTakeProfitUnsupported: 'multiple_take_profit_unsupported',
  SchemaVersionTooNew: 'schema_version_too_new',
  InvalidJobId: 'invalid_job_id',
});

// upstream: mod.rs::AutoTradeError — Reject(String) | Degrade(DegradeReason)
export class AutoTradeError extends Error {
  constructor(kind, value) {
    super(kind === 'Reject' ? `signal rejected: ${value}` : String(value));
    this.kind = kind;          // 'Reject' | 'Degrade'
    this.value = value;        // reject text | degrade reason wire string
  }
  static reject(s) { return new AutoTradeError('Reject', s); }
  static degrade(r) { return new AutoTradeError('Degrade', r); }
}

// upstream: mod.rs::CliBespokeExit — the handler already printed its bespoke JSON; main exits
// with `code` after audit::log (core BespokeExit). Its Display is `bespoke exit: {code}`, which
// is the `error` text audit::log records (`{e:#}`); core BespokeExit says "bespoke exit {code}".
export class CliBespokeExit extends BespokeExit {
  constructor(code) {
    super(code);
    this.message = `bespoke exit: ${code}`;
  }
}
