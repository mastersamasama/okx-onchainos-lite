// Pure data models shared across the identity module — upstream
// commands/agent_commerce/identity/models.rs.
//
// Rust structs are plain JS objects keyed by their JSON (camelCase) field names; an `Option`
// field holds `null` for None. Serialisation helpers return `struct(...)` objects (declaration
// order, skip rules applied) for the places upstream serialises the struct directly
// (`serde_json::to_string(&card)`), and plain objects (sorted keys) where upstream goes through
// `serde_json::to_value` / `json!`.
//
// Deserialisation types (core/serde.mjs) serve both serde_json::from_str (errors carry
// `at line L column C`) and serde_json::from_value (no position).
import { struct } from '../../core/json.mjs';
import { T } from '../../core/serde.mjs';

// upstream: models.rs constants
export const XLAYER_CHAIN_INDEX = '196';
export const XLAYER_CHAIN_INDEX_NUM = 196;
export const XLAYER_CHAIN_NAME = 'XLayer';

// upstream: models.rs::ServiceOperation (serde rename_all = "lowercase")
export const ServiceOperation = Object.freeze({ Create: 'create', Update: 'update', Delete: 'delete' });

// ── deserialisation ───────────────────────────────────────────────────

// upstream: models.rs::ServiceOperation (Deserialize)
const SERVICE_OPERATION = T.enum('ServiceOperation', Object.values(ServiceOperation).map((v) => [v, v]));
// upstream: models.rs::SubscriptionTier {interval, fee} (both required)
const SUBSCRIPTION_TIER = T.struct('SubscriptionTier', [['interval', T.string], ['fee', T.string]]);
// upstream: models.rs::AgentService (serde field attributes → defaults)
export const AGENT_SERVICE = T.struct('AgentService', [
  ['id', T.option(T.value), null],
  ['serviceName', T.string],
  ['serviceDescription', T.string],
  ['serviceGuide', T.string, ''],
  ['fee', T.string, ''],
  ['serviceType', T.string],
  ['subscription', T.vec(SUBSCRIPTION_TIER), () => []],
  ['freeTrial', T.option(T.string), null],
  ['operation', T.option(SERVICE_OPERATION), null],
  ['endpoint', T.option(T.string), null],
]);
// Vec<AgentService>
export const AGENT_SERVICES = T.vec(AGENT_SERVICE);

// ── serialisation ─────────────────────────────────────────────────────

// upstream: models.rs::SubscriptionTier (Serialize, struct order)
export const subscriptionTierStruct = (t) => struct({ interval: t.interval, fee: t.fee });

// upstream: models.rs::AgentService (Serialize, struct order + skip rules)
export function agentServiceStruct(s) {
  return struct({
    id: s.id === null || s.id === undefined ? undefined : s.id,
    serviceName: s.serviceName,
    serviceDescription: s.serviceDescription,
    serviceGuide: s.serviceGuide === '' ? undefined : s.serviceGuide,
    fee: s.fee,
    serviceType: s.serviceType,
    subscription: s.subscription.map(subscriptionTierStruct),
    freeTrial: s.freeTrial ?? undefined,
    operation: s.operation ?? undefined,
    endpoint: s.endpoint ?? undefined,
  });
}

// serde_json::to_value(AgentService) — a Value object (keys sorted on output).
export function agentServiceValue(s) {
  const o = { serviceName: s.serviceName, serviceDescription: s.serviceDescription, fee: s.fee, serviceType: s.serviceType };
  if (s.id !== null && s.id !== undefined) o.id = s.id;
  if (s.serviceGuide !== '') o.serviceGuide = s.serviceGuide;
  o.subscription = s.subscription.map((t) => ({ interval: t.interval, fee: t.fee }));
  if (s.freeTrial !== null && s.freeTrial !== undefined) o.freeTrial = s.freeTrial;
  if (s.operation !== null && s.operation !== undefined) o.operation = s.operation;
  if (s.endpoint !== null && s.endpoint !== undefined) o.endpoint = s.endpoint;
  return o;
}

// upstream: models.rs::AgentCard (Serialize, struct order; CommunicationAddress skipped when None)
export function agentCardStruct(card) {
  return struct({
    role: card.role,
    name: card.name,
    image: card.profilePicture,
    profileDescription: card.profileDescription,
    CommunicationAddress: card.communicationAddress ?? undefined,
    services: card.services.map(agentServiceStruct),
  });
}
