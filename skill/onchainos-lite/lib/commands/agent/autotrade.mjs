// agent trade-kit-readiness + every agent autotrade-* command — upstream
// commands/agent_commerce/mod.rs (inline handlers, dispatch 2042-2287) over
// task/common/autotrade/*. `autotrade-grant-write` exists only in debug builds of upstream
// (#[cfg(debug_assertions)]) and `autotrade-consent-set` is compiled out (#[cfg(any())]); the
// release surface (lib/spec.json) has neither, so neither is implemented.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { toValue, stringify } from '../../core/json.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import { CliBespokeExit, GUIDE_EXECUTION_UNAVAILABLE_REASON } from '../../agent/task/common/autotrade/index.mjs';
import { checkGrant, GrantDeny, DENY_INVALID_FORMAT } from '../../agent/task/common/autotrade/grants.mjs';
import { parseRuntimeAssetClasses, TradeEnvironment, probeRuntime } from '../../agent/task/common/autotrade/trade-kit.mjs';
import { updateActiveConsentValues, createActiveConsentFromGuide } from '../../agent/task/common/autotrade/guide.mjs';
import * as executor from '../../agent/task/common/autotrade/executor.mjs';
import { loadConsent, ConsentMode, evaluateConsent, ConsentDecision, loadPendingDeliveryContext } from '../../agent/task/common/autotrade/consent.mjs';
import { makeCapAdjustDecision, decisionListLabel, decisionRequestJson } from '../../agent/task/common/autotrade/card.mjs';
import { Decimal } from '../../agent/task/common/autotrade/amount.mjs';
import { fromStr, T } from '../../agent/task/common/autotrade/_serde-json.mjs';
import { markRetiredAutotradeModeDecisionsHandled } from '../../agent/task/common/okx-a2a.mjs';
import { pushDecisionDirect } from '../../agent/task/common/pending-v2.mjs';

// upstream: output.rs::bespoke_ok / bespoke_deny — `println!("{}", json!(…))` (Value Display) is
// always compact: unlike output::success they ignore ONCHAINOS_PRETTY. core/output.mjs's
// bespokeOk/bespokeDeny pretty-print under ONCHAINOS_PRETTY=1, so print here (fix requested).
const bespokeOk = () => process.stdout.write(`${stringify({ ok: true })}\n`);
const bespokeDeny = (reason) => process.stdout.write(`${stringify({ ok: false, reason })}\n`);

// serde_json::from_str::<BTreeMap<String, Value>>(values_json)
function parseValuesJson(valuesJson) {
  try { return fromStr(valuesJson, T.map(T.value)); } catch (e) { throw new Error(`--values-json must be a JSON object: ${e.message}`); }
}

export default {
  'agent trade-kit-readiness': {
    uses: ['assetClass', 'environment'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      const classes = parseRuntimeAssetClasses(o.assetClass ?? []);
      const environment = TradeEnvironment.parse(o.environment);
      return probeRuntime(classes, environment);
    },
  },

  'agent autotrade-grant-check': {
    uses: ['jobId', 'venue', 'action', 'amount', 'format'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      if (o.format !== 'json') {
        bespokeDeny(DENY_INVALID_FORMAT);
        throw new CliBespokeExit(1);
      }
      try {
        checkGrant(o.jobId, o.venue, o.action, o.amount);
      } catch (e) {
        if (!(e instanceof GrantDeny)) throw e;
        bespokeDeny(e.reason);
        throw new CliBespokeExit(1);
      }
      bespokeOk();
      return NO_OUTPUT;
    },
  },

  'agent autotrade-guide-consent-update': {
    uses: ['jobId', 'valuesJson'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      const values = parseValuesJson(o.valuesJson);
      const consent = updateActiveConsentValues(o.jobId, values);
      return { jobId: consent.jobId, consentStatus: 'active', guideHash: consent.guideHash, updated: true };
    },
  },

  'agent autotrade-guide-consent-new': {
    uses: ['jobId', 'valuesJson', 'ttlSec'],
    async run(ctx, o) {
      const ttlSec = typed(ctx.path, 'ttlSec', o.ttlSec, 'u64');
      await runPreDispatchMaintenance();
      const values = parseValuesJson(o.valuesJson);
      const consent = createActiveConsentFromGuide(o.jobId, values, ttlSec);
      return { jobId: consent.jobId, consentStatus: 'active', guideHash: consent.guideHash, created: true };
    },
  },

  'agent autotrade-consent-request': {
    uses: ['jobId', 'agentId', 'deliveryId', 'signalType'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      const outcome = await executor.reportDelivery(o.jobId, o.deliveryId, 'skipped', GUIDE_EXECUTION_UNAVAILABLE_REASON);
      try { await markRetiredAutotradeModeDecisionsHandled(o.jobId); } catch {}
      // json! literal: every key sorted, including inside the embedded outcome struct
      return {
        decision: false, decisionPushed: false, status: 'skipped', reason: GUIDE_EXECUTION_UNAVAILABLE_REASON, jobId: o.jobId,
        deliveryId: o.deliveryId, terminal: true, outcome: toValue(outcome),
        guidance: 'The Signal remains saved for receive/display only. This retired Consent flow cannot authorize Guide-driven execution; do not create another execution decision.',
      };
    },
  },

  'agent autotrade-direct-claim': {
    uses: ['jobId', 'deliveryId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.claimGuideDirect(o.jobId, o.deliveryId);
    },
  },

  'agent autotrade-guide-prepare': {
    uses: ['jobId', 'deliveryId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.prepareGuideDirect(o.jobId, o.deliveryId);
    },
  },

  'agent autotrade-direct-finalize': {
    uses: ['jobId', 'deliveryId', 'status', 'toolId', 'receiptId', 'reason'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.finalizeDirect(o.jobId, o.deliveryId, o.status, o.toolId, o.receiptId ?? null, o.reason ?? null);
    },
  },

  'agent autotrade-once-authorize': {
    uses: ['jobId', 'deliveryId', 'amount'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.authorizeOneTime(o.jobId, o.deliveryId, o.amount);
    },
  },

  'agent autotrade-outcome-flush': {
    uses: ['jobId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.flush(o.jobId);
    },
  },

  'agent autotrade-delivery-report': {
    uses: ['jobId', 'deliveryId', 'status', 'reason'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return executor.reportDelivery(o.jobId, o.deliveryId, o.status, o.reason);
    },
  },

  'agent autotrade-cap-adjust-request': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      let file;
      try { file = loadConsent(o.jobId); } catch (e) { throw new Error(e.code ?? e.message); }
      if (!file) throw new Error('no live auto-trade consent');
      if (file.mode !== ConsentMode.Auto) throw new Error('cap adjustment is only valid for auto consent');
      const amount = file.tradeAmountU ?? '';
      const cap = file.capU ?? '';
      const amountDecimal = Decimal.parse(amount);
      let decision;
      try { decision = evaluateConsent(o.jobId, amountDecimal); } catch { decision = undefined; }
      if (decision !== ConsentDecision.AutoOverCap) return { capAlreadySufficient: true };
      const d = makeCapAdjustDecision('trade', o.jobId, o.agentId, amount, cap);
      const target = loadPendingDeliveryContext(o.jobId)?.providerAgentId ?? null;
      try {
        await pushDecisionDirect(o.jobId, 'user', o.agentId, target, d.userContent, decisionListLabel(d), d.sourceEvent);
      } catch {
        return decisionRequestJson(d);
      }
      return { decision: true, decisionPushed: true, sourceEvent: d.sourceEvent };
    },
  },
};
