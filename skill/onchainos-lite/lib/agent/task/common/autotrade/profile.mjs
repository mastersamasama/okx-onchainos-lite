// Local, non-executable routing context for subscription deliveries — upstream autotrade/profile.rs.
// `<home>/autotrade/profile/<jobId>.json` (compact JSON).
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { ConsentError } from './consent.mjs';
import { classifyDescription, candidateTools } from './tooling.mjs';
import { fromSlice, T } from '../../../../core/serde.mjs';
import { home as onchainosHome, writeSecure } from '../../../../core/home.mjs';
import { exists, readBytes } from '../../../../core/rs/fs.mjs';
import { nowMs } from '../../../../core/rs/time.mjs';
import { sha256Hex } from '../../../../core/rs/codec.mjs';

const PROFILE_VERSION = 3;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_ROUTE_VALUE_CHARS = 128;
const MAX_REQUIREMENTS = 16;
const UNREADABLE = 'execution_profile_unreadable';

const enumT = (name, values) => T.enum(name, values.map((v) => [v, v]));
const ASSET_T = enumT('AssetClass', ['spot', 'perp', 'prediction', 'option', 'defi']);
const TOOL_T = enumT('ExecutionTool', ['onchainos', 'trade_kit', 'polymarket_plugin', 'hyperliquid_plugin']);
const VENUE_T = T.struct('VenuePreference', [['assetClass', ASSET_T], ['tool', TOOL_T]], { denyUnknown: true });
const ROUTE_T = T.struct('ModelRoute', [
  ['assetClass', ASSET_T], ['skillId', T.string], ['pluginId', T.option(T.string), null], ['protocol', T.option(T.string), null],
  ['requirements', T.vec(T.string), () => []], ['resolvedFromDeliveryId', T.string], ['updatedAtMs', T.u64],
], { denyUnknown: true });
const PROFILE_T = T.struct('SubscriptionExecutionProfile', [
  ['version', T.u32], ['jobId', T.string], ['serviceId', T.string], ['providerAgentId', T.option(T.string), null],
  ['assetClasses', T.vec(ASSET_T)], ['explicitTools', T.vec(TOOL_T)], ['descriptionHash', T.string],
  ['serviceDescription', T.string, ''], ['venuePreferences', T.vec(VENUE_T), () => []], ['modelRoutes', T.vec(ROUTE_T), () => []],
], { denyUnknown: true });

const routeJson = (r) => struct({
  assetClass: r.assetClass, skillId: r.skillId, pluginId: r.pluginId ?? undefined, protocol: r.protocol ?? undefined,
  requirements: r.requirements.length ? r.requirements : undefined, resolvedFromDeliveryId: r.resolvedFromDeliveryId, updatedAtMs: r.updatedAtMs,
});
// SubscriptionExecutionProfile Serialize (struct order + skip rules)
export const profileJson = (p) => struct({
  version: p.version, jobId: p.jobId, serviceId: p.serviceId, providerAgentId: p.providerAgentId ?? undefined,
  assetClasses: p.assetClasses, explicitTools: p.explicitTools, descriptionHash: p.descriptionHash,
  serviceDescription: p.serviceDescription === '' ? undefined : p.serviceDescription,
  venuePreferences: p.venuePreferences.length ? p.venuePreferences.map((v) => struct({ assetClass: v.assetClass, tool: v.tool })) : undefined,
  modelRoutes: p.modelRoutes.length ? p.modelRoutes.map(routeJson) : undefined,
});

// upstream: profile.rs::profile_path
function profilePath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new ConsentError(UNREADABLE);
  let home;
  try { home = onchainosHome(); } catch { throw new ConsentError(UNREADABLE); }
  return join(home, 'autotrade', 'profile', `${jobId}.json`);
}
function write(profile) {
  const path = profilePath(profile.jobId);
  try { writeSecure(path, stringify(profileJson(profile))); } catch { throw new ConsentError(UNREADABLE); }
}
const emptyProfile = (jobId) => ({
  version: PROFILE_VERSION, jobId, serviceId: '', providerAgentId: null, assetClasses: [], explicitTools: [], descriptionHash: '',
  serviceDescription: '', venuePreferences: [], modelRoutes: [],
});

// upstream: profile.rs::load → profile | null (throws ConsentError)
export function load(jobId) {
  const path = profilePath(jobId);
  if (!exists(path)) return null;
  let p;
  try { p = fromSlice(readBytes(path), PROFILE_T); } catch { throw new ConsentError(UNREADABLE); }
  if (p.version > PROFILE_VERSION || p.jobId !== jobId) throw new ConsentError(UNREADABLE);
  return p;
}
const loadQuiet = (jobId) => { try { return load(jobId); } catch { return null; } };

// upstream: profile.rs::save_from_description
export function saveFromDescription(jobId, serviceId, providerAgentId, description) {
  const classified = classifyDescription(description);
  const previous = loadQuiet(jobId);
  const descriptionHash = sha256Hex(description);
  const profile = {
    version: PROFILE_VERSION, jobId, serviceId, providerAgentId: providerAgentId ?? null,
    assetClasses: classified.classes, explicitTools: classified.explicit, descriptionHash,
    serviceDescription: [...description].slice(0, MAX_DESCRIPTION_CHARS).join(''),
    venuePreferences: previous ? previous.venuePreferences : [],
    modelRoutes: previous && previous.serviceId === serviceId && (previous.providerAgentId ?? null) === (providerAgentId ?? null) && previous.descriptionHash === descriptionHash ? previous.modelRoutes : [],
  };
  write(profile);
  return profile;
}

// upstream: profile.rs::explicit_tool_for → tool | null
export function explicitToolFor(jobId, cls) {
  const p = loadQuiet(jobId);
  if (!p) return null;
  const valid = candidateTools(cls);
  const matched = p.explicitTools.filter((t) => valid.includes(t));
  return matched.length === 1 ? matched[0] : null;
}
// upstream: profile.rs::selected_tool_for → tool | null
export function selectedToolFor(jobId, cls) {
  const p = loadQuiet(jobId);
  return p ? p.venuePreferences.find((v) => v.assetClass === cls)?.tool ?? null : null;
}
// upstream: profile.rs::write_selected_tool
export function writeSelectedTool(jobId, cls, tool) {
  if (!candidateTools(cls).includes(tool)) throw new ConsentError(UNREADABLE);
  const p = load(jobId) ?? emptyProfile(jobId);
  p.version = PROFILE_VERSION;
  p.venuePreferences = p.venuePreferences.filter((v) => v.assetClass !== cls);
  p.venuePreferences.push({ assetClass: cls, tool });
  write(p);
}
// upstream: profile.rs::route_value_is_safe
const routeValueIsSafe = (v) => v !== '' && [...v].length <= MAX_ROUTE_VALUE_CHARS && /^[A-Za-z0-9._:/-]+$/.test(v);
// upstream: profile.rs::write_model_route → ModelRoute
export function writeModelRoute(jobId, assetClass, skillId, pluginId, protocol, requirements, deliveryId) {
  const none = (v) => v === null || v === undefined;
  if (!routeValueIsSafe(skillId) || (!none(pluginId) && !routeValueIsSafe(pluginId)) || (!none(protocol) && !routeValueIsSafe(protocol))
    || !routeValueIsSafe(deliveryId) || requirements.length > MAX_REQUIREMENTS || requirements.some((v) => !routeValueIsSafe(v))) {
    throw new ConsentError('execution_route_invalid');
  }
  const p = load(jobId) ?? emptyProfile(jobId);
  const route = { assetClass, skillId, pluginId: pluginId ?? null, protocol: protocol ?? null, requirements: [...requirements], resolvedFromDeliveryId: deliveryId, updatedAtMs: nowMs() };
  p.version = PROFILE_VERSION;
  p.modelRoutes = p.modelRoutes.filter((r) => r.assetClass !== assetClass);
  p.modelRoutes.push(route);
  write(p);
  return route;
}
// upstream: profile.rs::clear_model_routes
export function clearModelRoutes(jobId) {
  const p = load(jobId);
  if (!p) return;
  p.version = PROFILE_VERSION;
  p.modelRoutes = [];
  write(p);
}
