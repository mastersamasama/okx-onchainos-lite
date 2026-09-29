// Active-subscription determination for model-routed deliveries — upstream autotrade/subscription.rs.
import { AutoTradeError, DegradeReason } from './index.mjs';
import { get, asI64, asStr } from '../../../../core/rs/value.mjs';
import { trim } from '../../../../core/rs/str.mjs';
import { parseI64 } from '../../../../core/rs/num.mjs';

// upstream: subscription.rs::AUTOTRADE_ACTIVE_STATUS
const AUTOTRADE_ACTIVE_STATUS = 1;

// upstream: subscription.rs::as_int — JSON integer or trimmed numeric string
function asInt(v) {
  if (v === undefined) return undefined;
  const n = asI64(v);
  if (n !== undefined) return n;
  const s = asStr(v);
  return s === undefined ? undefined : parseI64(trim(s));
}
// upstream: subscription.rs::as_string — JSON string or integer rendered
function asString(v) {
  if (v === undefined) return undefined;
  const s = asStr(v);
  if (s !== undefined) return s;
  const n = asI64(v);
  return n === undefined ? undefined : String(n);
}

// upstream: subscription.rs::decide_active → { providerAgentId, serviceId } (throws AutoTradeError)
export function decideActive(data) {
  const status = asInt(get(data, 'status'));
  if (status === undefined || BigInt(status) !== BigInt(AUTOTRADE_ACTIVE_STATUS)) throw AutoTradeError.degrade(DegradeReason.SubscriptionNotActive);
  return {
    providerAgentId: asString(get(data, 'providerAgentId')) ?? '',
    serviceId: asString(get(data, 'serviceId')) ?? '',
  };
}

// upstream: subscription.rs::determine_active_delivery — query error ⇒ lookup_off; non-Active ⇒ subscription_not_active.
export async function determineActiveDelivery(client, jobId, agentId) {
  let data;
  try { data = await client.fetchSubscription(jobId, agentId); } catch { throw AutoTradeError.degrade(DegradeReason.LookupOff); }
  return decideActive(data);
}
