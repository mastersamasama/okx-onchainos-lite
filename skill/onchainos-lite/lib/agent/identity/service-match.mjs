// Marketplace service search with a stable output contract — upstream
// commands/agent_commerce/identity/service_match.rs. Fuzzy search is public (no login state is
// read); precise search (`--sid` / `--asp-agent-id`) is personalised with the account's User
// Agent id (`agenticId` header).
import { numberFromStr } from '../../core/serde.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { trim } from '../../core/rs/str.mjs';
import { isObject, isNumber, asF64, asI64, numText } from '../../core/rs/value.mjs';
import { formatSearchRate, walletClient } from './utils.mjs';
import { getMyAgentsWithAccessToken } from './queries.mjs';

export const SERVICE_MATCH_PATH = '/priapi/v1/aieco/task/asp/service/search';
const PHASE_SUBSCRIPTION_VALIDATION = 'subscription_validation';
const TIP_NO_MATCH = 'No matching services were found on OKX.AI. Try another keyword and search again.';
const TIP_OFFLINE = 'This Agent is offline and cannot provide the service right now. Search for another service.';
const TIP_CONFIRM = 'Reply to confirm that you want to use this service.';
const TIP_MORE = 'Tell me which service you want to use, or ask for more.';
const TIP_NO_MORE = 'There are no more matching services. Tell me which service you want to use.';

const mget = (m, k) => (isObject(m) && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : undefined);

// upstream: service_match.rs::service_match — args {keywords[], aspAgentId, aspName, serviceName,
// serviceId, minPaymentTokenAmount, maxPaymentTokenAmount, searchAfter, limit (u64)} → data
export async function serviceMatch(args) {
  const body = buildRequest(args);
  const client = walletClient();
  let data;
  if (isPreciseSearch(args)) {
    const accessToken = await ensureTokensRefreshed();
    const userAgents = await getMyAgentsWithAccessToken({ role: 'user' }, accessToken);
    const agenticId = requireUserAgentId(userAgents);
    data = await client.postAuthedWithHeaders(SERVICE_MATCH_PATH, accessToken, body, [['agenticId', agenticId]]);
  } else {
    data = await client.postPublic(SERVICE_MATCH_PATH, body);
  }
  normalizeSecurityRatings(data);
  addFlowMetadata(data, args);
  return data;
}

// upstream: service_match.rs::normalize_security_ratings (private)
export function normalizeSecurityRatings(data) {
  const services = mget(data, 'services');
  if (!Array.isArray(services)) return;
  for (const service of services) {
    const asp = mget(service, 'asp');
    if (!isObject(asp)) continue;
    const r = mget(asp, 'securityRate');
    let rating = '—';
    if (isNumber(r)) {
      const rate = asF64(r);
      rating = rate === 0 ? 'No rating yet' : `★ ${formatSearchRate(rate)}`;
    }
    asp.rating = rating;
  }
}

// upstream: service_match.rs::trimmed (private)
const trimmed = (v) => (v === undefined || v === null || trim(v) === '' ? undefined : trim(v));

// upstream: service_match.rs::is_precise_search (private)
export const isPreciseSearch = (args) => trimmed(args.serviceId) !== undefined || trimmed(args.aspAgentId) !== undefined;

// upstream: service_match.rs::agent_id_string (private)
function agentIdString(v) {
  if (typeof v === 'string') return trimmed(v);
  if (isNumber(v)) return numText(v);
  return undefined;
}

// upstream: service_match.rs::extract_user_agent_id (private)
export function extractUserAgentId(data) {
  const list = mget(data, 'list');
  const entries = Array.isArray(list) ? list : Array.isArray(data) ? data : undefined;
  if (!entries) return undefined;
  for (const entry of entries) {
    const agents = mget(entry, 'agentList');
    let id;
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        const a = mget(agent, 'agentId');
        id = a === undefined ? undefined : agentIdString(a);
        if (id !== undefined) break;
      }
    } else {
      const a = mget(entry, 'agentId');
      id = a === undefined ? undefined : agentIdString(a);
    }
    if (id !== undefined) return id;
  }
  return undefined;
}

// upstream: service_match.rs::require_user_agent_id (private)
function requireUserAgentId(data) {
  const id = extractUserAgentId(data);
  if (id === undefined) throw new Error('no User identity found on this account; create a User identity before using precise service search');
  return id;
}

// upstream: service_match.rs::add_flow_metadata (private)
export function addFlowMetadata(data, args) {
  if (!isObject(data)) return;
  const svc = mget(data, 'services');
  const services = Array.isArray(svc) ? svc : [];
  const precise = isPreciseSearch(args);
  let tip, duplicate;
  if (!services.length) tip = TIP_NO_MATCH;
  else if (precise && services.some(serviceIsOffline)) tip = TIP_OFFLINE;
  else if (services.length === 1) {
    if (precise) {
      duplicate = activeSubscriptionPayload(services[0]);
      if (duplicate === undefined) tip = TIP_CONFIRM;
    } else tip = TIP_CONFIRM;
  } else if (mget(data, 'hasMore') === true) tip = TIP_MORE;
  else tip = TIP_NO_MORE;

  delete data.action;
  if (duplicate !== undefined) {
    delete data.tip;
    data.phase = PHASE_SUBSCRIPTION_VALIDATION;
    data.decision = 'blocked';
    data.reason = 'duplicate_subscription';
    data.nextAction = [{ id: 'restore_subscription', recommend: true }];
    data.payload = duplicate;
  } else {
    for (const k of ['phase', 'decision', 'reason', 'nextAction', 'payload']) delete data[k];
    if (tip !== undefined) data.tip = tip;
  }
}

// upstream: service_match.rs::active_subscription_payload (private)
export function activeSubscriptionPayload(service) {
  const info = mget(service, 'subscribedInfo');
  if (info === undefined) return undefined;
  if (mget(info, 'isActive') !== true) return undefined;
  const j = mget(info, 'jobId');
  if (typeof j !== 'string') return undefined;
  const jobId = trim(j);
  if (jobId === '') return undefined;
  const payload = { jobId, active: true };
  for (const key of ['title', 'status']) { const v = mget(info, key); if (v !== undefined) payload[key] = v; }
  return payload;
}

// upstream: service_match.rs::service_is_offline (private)
export function serviceIsOffline(service) {
  const status = mget(mget(service, 'asp'), 'onlineStatus');
  if (isNumber(status)) return asI64(status) !== 1;
  return true;
}

// upstream: service_match.rs::build_request (private) → request body (json! → sorted keys)
export function buildRequest(args) {
  const rawKeywords = args.keywords || [];
  if (rawKeywords.length > 10) throw new Error('service search accepts at most 10 keywords');
  const keywords = rawKeywords.map(trim).filter((k) => k !== '');
  const aspAgentId = trimmed(args.aspAgentId);
  const aspName = trimmed(args.aspName);
  const serviceName = trimmed(args.serviceName);
  const serviceId = trimmed(args.serviceId);
  const searchAfter = trimmed(args.searchAfter);
  const minAmount = trimmed(args.minPaymentTokenAmount) === undefined ? undefined : parseNonNegativeDecimal(trimmed(args.minPaymentTokenAmount), '--min-payment-token-amount');
  const maxAmount = trimmed(args.maxPaymentTokenAmount) === undefined ? undefined : parseNonNegativeDecimal(trimmed(args.maxPaymentTokenAmount), '--max-payment-token-amount');
  if (minAmount !== undefined && maxAmount !== undefined && asF64(minAmount) > asF64(maxAmount)) {
    throw new Error('minPaymentTokenAmount must be less than or equal to maxPaymentTokenAmount');
  }
  const hasInitial = keywords.length > 0 || [aspAgentId, aspName, serviceName, serviceId, minAmount, maxAmount].some((x) => x !== undefined);
  if (searchAfter !== undefined && hasInitial) throw new Error('--search-after cannot be combined with initial search conditions');
  const body = {};
  if (searchAfter !== undefined) body.searchAfter = searchAfter;
  else {
    if (keywords.length) body.keywords = keywords;
    if (aspAgentId !== undefined) body.aspAgentId = aspAgentId;
    if (aspName !== undefined) body.aspName = aspName;
    if (serviceName !== undefined) body.serviceName = serviceName;
    if (serviceId !== undefined) body.sid = serviceId;
    if (minAmount !== undefined) body.minPaymentTokenAmount = minAmount;
    if (maxAmount !== undefined) body.maxPaymentTokenAmount = maxAmount;
  }
  body.limit = args.limit;
  return body;
}

// upstream: service_match.rs::parse_non_negative_decimal (private) → serde_json::Number
export function parseNonNegativeDecimal(value, argument) {
  let number;
  try { number = numberFromStr(value); } catch (e) { throw new Error(`${argument} must be a valid decimal: ${e.message}`); }
  const amount = asF64(number);
  if (!(Number.isFinite(amount) && amount >= 0)) throw new Error(`${argument} must be greater than or equal to 0`);
  return number;
}
