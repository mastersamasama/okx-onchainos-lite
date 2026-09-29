// CLI handlers for the x402 `period` scheme — upstream commands/payment/subscription.rs.
// subscribe / change / cancel / cancel-pending sign and emit a PAYMENT-SIGNATURE header (or a
// signed CancelAuth) for the agent to relay to the Seller; allowance-status / my-subscriptions
// are buyer-direct reads; access resolves a subId (cache or --sub-id) and personal-signs an
// APP-Access AccessProof header. The signing / facilitator / cache library is payment/subscription/.
import { context } from '../core/errors.mjs';
import { stringify, toValue } from '../core/json.mjs';
import { resolveChain } from '../core/chains.mjs';
import { fromStr as serdeFromStr } from '../core/serde.mjs';
import { resolveChainAndPayer, resolveChainAndPayerByChain } from './payment-flow.mjs';
import { SubscriptionCache, hostOf } from './subscription/cache.mjs';
import * as facilitator from './subscription/facilitator.mjs';
import * as sign from './subscription/sign.mjs';
import { get } from '../core/rs/value.mjs';

// upstream: subscription.rs::execute — cmd = {kind, …args}; returns the `data` output::success prints.
export async function execute(cmd) {
  switch (cmd.kind) {
    case 'subscribe': return cmdSubscribe(cmd.accepts, cmd.from ?? null, cmd.url ?? null);
    case 'access': return cmdAccess(cmd.url, cmd.subId ?? null, cmd.from ?? null, resolveChain(cmd.chain));
    case 'change': return cmdChange(cmd.accepts, cmd.subId ?? null, cmd.from ?? null, cmd.url ?? null);
    case 'cancel': return cmdCancel(cmd.subId, null, cmd.contract ?? null, cmd.token ?? null, resolveChain(cmd.chain), cmd.from ?? null, false);
    case 'cancel-pending':
      return cmdCancel(cmd.subId, cmd.newSubId, cmd.contract ?? null, cmd.token ?? null, resolveChain(cmd.chain), cmd.from ?? null, true);
    case 'my-subscriptions': return cmdMySubscriptions(resolveChain(cmd.chain), cmd.from ?? null, cmd.limit, cmd.offset);
    case 'allowance-status': return cmdAllowanceStatus(cmd.token, resolveChain(cmd.chain), cmd.from ?? null);
    default: throw new Error(`unknown subscription command ${cmd.kind}`);
  }
}

// upstream: subscription.rs::select_subscription_entry (private) — first `scheme == "period"` of an
// array (exact, case-sensitive), or the value itself when it is not an array.
export function selectSubscriptionEntry(accepts) {
  if (!Array.isArray(accepts)) return accepts;
  const e = accepts.find((x) => get(x, 'scheme') === 'period');
  if (e === undefined) throw new Error('no period entry in accepts[]');
  return e;
}

// upstream: subscription.rs::build_subscription_payment_header (private) → ["PAYMENT-SIGNATURE",
// base64(compact sorted JSON of the x402 v2 envelope + subscription payload)]
export function buildSubscriptionPaymentHeader(accepted, resourceUrl, payload) {
  const body = {
    x402Version: 2,
    resource: { url: resourceUrl ?? '', mimeType: 'application/json' },
    accepted,
    payload: {
      permitSingle: toValue(payload.permit),
      permitSingleSignature: payload.permitSignature,
      terms: toValue(payload.terms),
      termsSignature: payload.termsSignature,
    },
  };
  return ['PAYMENT-SIGNATURE', Buffer.from(stringify(body), 'utf8').toString('base64')];
}

// upstream: subscription.rs::cache_subscription (private) — write-through subId cache update.
export function cacheSubscription(url, payload, subId, planId) {
  if (url == null) {
    process.stderr.write('Warning: subscription NOT cached (no --url). Subsequent `payment subscription access` can\'t find this subId — pass --url to subscribe.\n');
    return;
  }
  const cache = SubscriptionCache.load();
  const entry = {
    subId, resourceHost: hostOf(url), merchant: payload.terms.merchant, planId, planTier: payload.terms.planTier,
    maxPeriods: payload.terms.maxPeriods, state: 'active', changedToSubId: null,
  };
  const oldSubId = payload.terms.changeFromSubId;
  let stripped = oldSubId;
  while (stripped.startsWith('0x')) stripped = stripped.slice(2);
  const isChange = stripped.replace(/^0+|0+$/g, '') !== '';
  if (isChange) {
    // changeEffectiveAt: 1 = upgrade (immediate) / 2 = downgrade (period_end).
    if (payload.terms.changeEffectiveAt === 2) {
      process.stderr.write('Note: downgrade scheduled — current plan stays active until period end. Run `payment subscription my-subscriptions` after it activates to switch.\n');
    } else cache.markChanged(oldSubId, entry);
  } else cache.put(entry);
  try { cache.save(); } catch (e) { process.stderr.write(`Warning: failed to update subscription cache: ${e.message}\n`); }
}

function parseAccepts(accepts) {
  try { return serdeFromStr(Buffer.from(String(accepts), 'utf8')); } catch (e) { throw context('parse --accepts JSON', e); }
}

// Shared tail of cmd_subscribe / cmd_change.
function signedOutput(accepted, url, signed) {
  const [hname, hvalue] = buildSubscriptionPaymentHeader(accepted, url, signed.payload);
  cacheSubscription(url, signed.payload, signed.subId, signed.planId);
  return {
    paymentHeaderName: hname, paymentHeaderValue: hvalue, subId: signed.subId, chainIndex: signed.chainIndex,
    payload: toValue(signed.payload),
  };
}

// upstream: subscription.rs::cmd_subscribe (private)
export async function cmdSubscribe(accepts, from, url) {
  const accepted = selectSubscriptionEntry(parseAccepts(accepts));
  const [chainIndex, chainId, payer] = await resolveChainAndPayer(accepted, from);
  const signed = await sign.signSubscribe(chainIndex, chainId, payer, accepted);
  return signedOutput(accepted, url, signed);
}

// upstream: subscription.rs::cmd_change (private)
export async function cmdChange(accepts, subId, from, url) {
  const accepted = selectSubscriptionEntry(parseAccepts(accepts));
  const [chainIndex, chainId, payer] = await resolveChainAndPayer(accepted, from);
  const signed = await sign.signChange(chainIndex, chainId, payer, subId ?? '', accepted);
  return signedOutput(accepted, url, signed);
}

// upstream: subscription.rs::cmd_access (private) — `chain` already passed through resolve_chain.
export async function cmdAccess(url, subId, from, chain) {
  let resolvedSub, source;
  if (subId != null) { resolvedSub = subId; source = 'override'; }
  else {
    const entry = SubscriptionCache.load().resolve(url);
    if (!entry) {
      throw new Error(`no active subscription cached for host ${hostOf(url)}. Run \`payment subscription my-subscriptions\` to reconcile, or pass --sub-id.`);
    }
    resolvedSub = entry.subId;
    source = 'cache';
  }
  const [chainIndex, , payer] = await resolveChainAndPayerByChain(chain, from);
  const [hname, hvalue] = await sign.buildAccessProof(chainIndex, payer, resolvedSub);
  return { subId: resolvedSub, host: hostOf(url), source, accessHeaderName: hname, accessHeaderValue: hvalue };
}

// upstream: subscription.rs::resolve_contract (private) — --contract, else allowance-status by --token.
export async function resolveContract(contract, token, payer, chainIndex) {
  if (contract != null) return contract;
  if (token == null) throw new Error('cancel requires --contract (subscription contract) or --token (to look it up)');
  const a = await facilitator.allowanceStatus(payer, token, chainIndex);
  if (a.subscriptionContract === '') throw new Error(`allowance-status returned no subscriptionContract for token ${token}`);
  return a.subscriptionContract;
}

// upstream: subscription.rs::cmd_cancel (private) — CancelAuth, or PendingChangeCancelAuth (pending).
// The cache is not touched: the sub stays billable until the contract executes the cancel.
export async function cmdCancel(subId, newSubId, contract, token, chain, from, pending) {
  const [chainIndex, chainId, payer] = await resolveChainAndPayerByChain(chain, from);
  const verifyingContract = await resolveContract(contract, token, payer, chainIndex);
  if (pending) {
    if (newSubId == null) throw new Error("cancel-pending requires --new-sub-id (the PENDING downgrade's newSubId)");
    const auth = await sign.signCancelPendingChange(chainIndex, chainId, payer, subId, newSubId, verifyingContract);
    return { pendingChangeCancelAuth: toValue(auth), chainIndex };
  }
  const auth = await sign.signCancel(chainIndex, chainId, payer, subId, verifyingContract);
  return { cancelAuth: toValue(auth), chainIndex };
}

// upstream: subscription.rs::cmd_my_subscriptions (private) — list + reconcile the local cache.
export async function cmdMySubscriptions(chain, from, limit, offset) {
  const [, , payer] = await resolveChainAndPayerByChain(chain, from);
  const resp = await facilitator.mySubscriptions(payer, limit, offset);
  const cache = SubscriptionCache.load();
  cache.reconcileFrom(resp.subscriptions);
  try { cache.save(); } catch (e) { process.stderr.write(`Warning: failed to reconcile subscription cache: ${e.message}\n`); }
  return { subscriptions: resp.subscriptions.map((i) => toValue(i)) };
}

// upstream: subscription.rs::cmd_allowance_status (private)
export async function cmdAllowanceStatus(token, chain, from) {
  const [chainIndex, , payer] = await resolveChainAndPayerByChain(chain, from);
  const a = await facilitator.allowanceStatus(payer, token, chainIndex);
  return {
    approvedAmount: a.approvedAmount, expiration: a.expiration, nonce: a.nonce, reservedAmount: a.reservedAmount,
    reservedExpiration: a.reservedExpiration, tokenBalance: a.tokenBalance, availableAmount: a.availableAmount,
    permit2Allowance: a.permit2Allowance, subscriptionContract: a.subscriptionContract, permit2Contract: a.permit2Contract,
  };
}
