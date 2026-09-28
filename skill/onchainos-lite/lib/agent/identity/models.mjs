// Pure data models shared across the identity module — upstream
// commands/agent_commerce/identity/models.rs.
//
// Rust structs are plain JS objects keyed by their JSON (camelCase) field names; an `Option`
// field holds `null` for None. Serialisation helpers return `struct(...)` objects (declaration
// order, skip rules applied) for the places upstream serialises the struct directly
// (`serde_json::to_string(&card)`), and plain objects (sorted keys) where upstream goes through
// `serde_json::to_value` / `json!`.
//
// Deserialisers come in two flavours, mirroring serde_json:
//   • streaming `from_str` (errors carry `at line L column C`) — built from the watch module's
//     serde_json combinators (lib/watch/_serde.mjs);
//   • `from_value` over an already-parsed Value (no position) — lib/agent/_serde.mjs.
import { struct } from '../../core/json.mjs';
import { string, vec, struct as deStruct, value, unitEnum } from '../../watch/_serde.mjs';
import { S, SerdeError, unexpected } from '../_serde.mjs';

// upstream: models.rs constants
export const XLAYER_CHAIN_INDEX = '196';
export const XLAYER_CHAIN_INDEX_NUM = 196;
export const XLAYER_CHAIN_NAME = 'XLayer';

// upstream: models.rs::ServiceOperation (serde rename_all = "lowercase")
export const ServiceOperation = Object.freeze({ Create: 'create', Update: 'update', Delete: 'delete' });
const OPERATIONS = ['create', 'update', 'delete'];
const OPERATIONS_EXPECTED = 'one of `create`, `update`, `delete`';

// ── streaming (serde_json::from_str) type definitions ─────────────────

// deserialize_option: `null` → None, anything else → Some(inner).
export const optionDe = (inner) => (de) => {
  if (de.ws() === 0x6e) { de.i++; de.ident('ull'); return null; }
  return inner(de);
};
// deserialize_bool
export function boolDe(de) {
  const p = de.ws();
  if (p === undefined) throw de.peekError('EOF while parsing a value');
  try {
    if (p === 0x74) { de.i++; de.ident('rue'); return true; }
    if (p === 0x66) { de.i++; de.ident('alse'); return false; }
    throw de.invalidType('a boolean');
  } catch (e) { throw de.fix(e); }
}

const none = () => null;
// upstream: models.rs::SubscriptionTier {interval, fee} (both required)
export const SUBSCRIPTION_TIER_DE = deStruct('SubscriptionTier', [
  { name: 'interval', de: string }, { name: 'fee', de: string },
]);
// upstream: models.rs::AgentService (serde field attributes → defaults)
export const AGENT_SERVICE_DE = deStruct('AgentService', [
  { name: 'id', de: optionDe(value), def: none },
  { name: 'serviceName', de: string },
  { name: 'serviceDescription', de: string },
  { name: 'serviceGuide', de: string, def: () => '' },
  { name: 'fee', de: string, def: () => '' },
  { name: 'serviceType', de: string },
  { name: 'subscription', de: vec(SUBSCRIPTION_TIER_DE), def: () => [] },
  { name: 'freeTrial', de: optionDe(string), def: none },
  { name: 'operation', de: optionDe(unitEnum(OPERATIONS)), def: none },
  { name: 'endpoint', de: optionDe(string), def: none },
]);
// Vec<AgentService>
export const AGENT_SERVICES_DE = vec(AGENT_SERVICE_DE);

// ── from_value (serde_json::from_value) type definitions ─────────────

// Unit-variant enum from a Value (serde_json::value::de deserialize_enum).
const operationValue = {
  expecting: 'enum ServiceOperation',
  de(v) {
    let variant, payload;
    if (typeof v === 'string') variant = v;
    else if (v !== null && typeof v === 'object' && !Array.isArray(v) && unexpected(v) === 'map') {
      const keys = Object.keys(v);
      if (keys.length !== 1) throw new SerdeError('invalid value: map, expected map with a single key');
      [variant] = keys;
      payload = v[variant];
    } else throw new SerdeError(`invalid type: ${unexpected(v)}, expected string or map`);
    if (!OPERATIONS.includes(variant)) throw new SerdeError(`unknown variant \`${variant}\`, expected ${OPERATIONS_EXPECTED}`);
    if (payload !== undefined && payload !== null) throw new SerdeError(`invalid type: ${unexpected(payload)}, expected unit`);
    return variant;
  },
};
const tierValue = S.struct('SubscriptionTier', [['interval', S.string], ['fee', S.string]]);
// upstream: models.rs::AgentService via serde_json::from_value
export const AGENT_SERVICE_VALUE = S.struct('AgentService', [
  ['id', S.option(S.value), { default: null }],
  ['serviceName', S.string],
  ['serviceDescription', S.string],
  ['serviceGuide', S.string, { default: '' }],
  ['fee', S.string, { default: '' }],
  ['serviceType', S.string],
  ['subscription', S.vec(tierValue), { default: () => [] }],
  ['freeTrial', S.option(S.string), { default: null }],
  ['operation', S.option(operationValue), { default: null }],
  ['endpoint', S.option(S.string), { default: null }],
]);

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
