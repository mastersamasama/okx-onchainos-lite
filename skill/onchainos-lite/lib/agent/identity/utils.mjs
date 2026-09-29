// Stateless helpers shared by queries / mutations / signing — upstream
// commands/agent_commerce/identity/utils.rs (+ parts/precheck.rs, parts/rating.rs re-exported
// under the same path, exactly as upstream's `#[path]` child modules).
//
// JSON values are lite's lossless representation (core/json.mjs parse): safe integers are
// numbers, larger integers BigInt, decimals/exponents F64. Plain objects print with sorted keys
// (serde_json::Value), so every `json!` built here is a plain object.
import { createHash } from 'node:crypto';
import { F64 } from '../../core/json.mjs';
import { context } from '../../core/errors.mjs';
import { AGENT_WS_URL } from '../../config.mjs';
import { WalletApiClient, decodeUnsignedInfoResponse, SerdeError as WalletSerdeError } from '../../wallet/api.mjs';
import { T, fromStr, fromValue, SerdeError } from '../../core/serde.mjs';
import { formatFixed, parseF64, parseI64 } from '../../core/rs/num.mjs';
import { trim, asciiLower, eqIgnoreAsciiCase, asciiUpper } from '../../core/rs/str.mjs';
import { isObject, asU64, asI64, asF64, numText } from '../../core/rs/value.mjs';
import { localParts } from '../../core/rs/time.mjs';
import { AGENT_SERVICE, AGENT_SERVICES, ServiceOperation, agentServiceValue } from './models.mjs';

export { convertFeedbackListScores, parseStarsArg, scoreToStars } from './parts/rating.mjs';
export { buildPrecheck, collectOwnedAgents } from './parts/precheck.mjs';

// upstream: utils.rs::SERVICE_GUIDE_MAX_DISPLAY_WIDTH
export const SERVICE_GUIDE_MAX_DISPLAY_WIDTH = 10000;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;
const isInteger = (v) => typeof v === 'number' || typeof v === 'bigint';
// serde_json::Map::get(k) → value | undefined
const mget = (map, k) => (isObject(map) && hasOwn(map, k) && map[k] !== undefined ? map[k] : undefined);

// ─── HTTP client ──────────────────────────────────────────────────────────

// upstream: utils.rs::wallet_client
export const walletClient = () => new WalletApiClient();

// upstream: utils.rs::identity_ws_url — compiled wallet-agentic-identity push endpoint.
export const identityWsUrl = () => AGENT_WS_URL;

// ─── HTTP query building ──────────────────────────────────────────────────

// upstream: utils.rs::push_optional_query
export function pushOptionalQuery(query, key, value) {
  if (value !== undefined && value !== null && trim(value) !== '') query.push([key, trim(value)]);
}

// upstream: utils.rs::push_multi_query
export function pushMultiQuery(query, key, values) {
  for (const v of values || []) if (trim(v) !== '') query.push([key, trim(v)]);
}

// ─── Response shape helpers ───────────────────────────────────────────────

// upstream: utils.rs::normalize_singleton_object
export function normalizeSingletonObject(data) {
  return Array.isArray(data) && data.length === 1 && isObject(data[0]) ? data[0] : data;
}

// upstream: utils.rs::parse_agent_unsigned → decoded UnsignedInfoResponse
export function parseAgentUnsigned(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('pre-transaction response is empty');
  try { return decodeUnsignedInfoResponse(data[0]); } catch (e) {
    if (e instanceof WalletSerdeError) throw context('failed to parse pre-transaction response', e);
    throw e;
  }
}

// ─── Service / Role parsing ───────────────────────────────────────────────

// upstream: utils.rs::parse_services(raw) → normalized AgentService[]
export function parseServices(raw) {
  if (raw === undefined || raw === null) return [];
  let services;
  try { services = fromStr(raw, AGENT_SERVICES); } catch (e) {
    if (e instanceof SerdeError) throw context('failed to parse --service as JSON array', e);
    throw e;
  }
  return services.map(normalizeService);
}

// upstream: utils.rs::normalize_service_id (private) → Value | null
export function normalizeServiceId(id) {
  if (id === undefined || id === null) return null;
  if (typeof id === 'string') return trim(id) === '' ? null : trim(id);
  if (isInteger(id)) return id;
  throw new Error('invalid --service: id must be a string or integer');
}

// upstream: utils.rs::parse_service_deltas(raw) → Value[] (update only)
export function parseServiceDeltas(raw) {
  if (raw === undefined || raw === null) return [];
  let entries;
  try { entries = fromStr(raw, T.vec(T.value)); } catch (e) {
    if (e instanceof SerdeError) throw context('failed to parse --service as JSON array', e);
    throw e;
  }
  return entries.map((entry) => {
    if (mget(entry, 'operation') === 'delete') {
      const id = normalizeServiceId(mget(entry, 'id'));
      if (id === null) throw new Error("invalid --service: operation 'delete' requires an id");
      return { operation: 'delete', id };
    }
    let service;
    try { service = fromValue(entry, AGENT_SERVICE); } catch (e) {
      if (e instanceof SerdeError) throw context('failed to parse --service entry', e);
      throw e;
    }
    return agentServiceValue(normalizeService(service));
  });
}

// upstream: utils.rs::normalize_service — trims, validates, returns the normalized service.
export function normalizeService(service) {
  const s = { ...service, subscription: service.subscription.map((t) => ({ ...t })) };
  s.id = normalizeServiceId(s.id);
  s.serviceName = trim(s.serviceName);
  s.serviceDescription = trim(s.serviceDescription);
  s.serviceGuide = trim(s.serviceGuide);
  s.fee = trim(s.fee);
  s.serviceType = asciiUpper(trim(s.serviceType));
  s.endpoint = s.endpoint === null || s.endpoint === undefined || trim(s.endpoint) === '' ? null : trim(s.endpoint);
  s.freeTrial = s.freeTrial === null || s.freeTrial === undefined || trim(s.freeTrial) === '' ? null : trim(s.freeTrial);

  if (s.serviceName === '') throw new Error('missing required field in --service: serviceName');
  if (s.serviceDescription === '') throw new Error('missing required field in --service: serviceDescription');
  if (s.operation !== ServiceOperation.Delete && s.serviceGuide !== '' && displayWidth(s.serviceGuide) > SERVICE_GUIDE_MAX_DISPLAY_WIDTH) {
    throw new Error(`The service guide for [${s.serviceName}] exceeds the length limit. Shorten it to no more than 5,000 full-width Chinese/Japanese characters or 10,000 Latin characters, then resubmit.`);
  }
  for (const tier of s.subscription) {
    tier.interval = asciiLower(trim(tier.interval));
    tier.fee = trim(tier.fee);
  }
  s.subscription = s.subscription.filter((t) => !(t.interval === '' && t.fee === ''));

  switch (s.serviceType) {
    case 'A2A': {
      s.endpoint = null;
      const hasSingleFee = s.fee !== '';
      const hasSubscription = s.subscription.length > 0;
      if (!hasSingleFee && !hasSubscription) throw new Error('invalid --service for A2A: provide a single-purchase fee or a subscription (exactly one)');
      if (hasSingleFee && hasSubscription) throw new Error('invalid --service for A2A: choose one billing model — a single-purchase fee OR a subscription, not both');
      for (const tier of s.subscription) {
        if (tier.interval !== 'month') throw new Error(`invalid subscription interval in --service: ${tier.interval} (only 'month' is supported)`);
        if (tier.fee === '') throw new Error(`The price for "${s.serviceName}" cannot be empty. Please enter a price and try again.`);
        if (!isPlainNumber(tier.fee, 2)) throw new Error('invalid subscription fee in --service: must be a plain number with up to 2 decimal places (USDT is the default currency)');
        if (isZeroValue(tier.fee)) throw new Error(`The subscription price for "${s.serviceName}" must be greater than 0. Please update the price and try again.`);
      }
      if (hasSingleFee && !isPlainNumber(s.fee, 2)) throw new Error('invalid fee in --service for A2A: must be a plain number with up to 2 decimal places (USDT is the default currency)');
      if (s.freeTrial !== null) {
        if (!hasSubscription) throw new Error('invalid --service for A2A: freeTrial is only allowed on a subscription-priced service');
        if (!isPositiveInteger(s.freeTrial)) throw new Error('invalid freeTrial in --service: must be a positive integer number of hours');
      }
      break;
    }
    case 'A2MCP':
      if (s.subscription.length) throw new Error('invalid --service: A2MCP services do not support subscription pricing');
      if (s.freeTrial !== null) throw new Error('invalid --service: A2MCP services do not support freeTrial');
      if (s.fee === '') throw new Error('missing required field in --service for A2MCP: fee');
      if (!isPlainNumber(s.fee, 6)) throw new Error('invalid fee in --service for A2MCP: must be a plain number with up to 6 decimal places (USDT is the default currency)');
      if (s.endpoint === null) throw new Error('missing required field in --service for A2MCP: endpoint');
      break;
    default:
      throw new Error(`invalid serviceType in --service: ${s.serviceType} (expected: A2A or A2MCP)`);
  }

  if (s.operation === ServiceOperation.Create && s.id !== null) throw new Error("invalid --service: operation 'create' must not carry an id");
  if (s.operation === ServiceOperation.Update && s.id === null) throw new Error("invalid --service: operation 'update' requires an id");
  if (s.operation === ServiceOperation.Delete && s.id === null) throw new Error("invalid --service: operation 'delete' requires an id");
  return s;
}

const allDigits = (s) => /^[0-9]+$/.test(s);

// upstream: utils.rs::is_plain_number
export function isPlainNumber(s, maxDecimals) {
  const i = s.indexOf('.');
  if (i < 0) return s !== '' && allDigits(s);
  const int = s.slice(0, i), frac = s.slice(i + 1);
  return int !== '' && allDigits(int) && frac.length >= 1 && frac.length <= maxDecimals && allDigits(frac);
}

// upstream: utils.rs::is_zero_value
export const isZeroValue = (s) => s !== '' && /^[0.]+$/.test(s);

// upstream: utils.rs::is_positive_integer
export const isPositiveInteger = (s) => s !== '' && allDigits(s) && /[1-9]/.test(s);

const WIDE_CP_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa960, 0xa97f],
  [0xac00, 0xd7af], [0xd7b0, 0xd7ff], [0xf900, 0xfaff], [0xfe10, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x2fa1f],
];
// upstream: utils.rs::display_width — East-Asian display width (wide = 2).
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += WIDE_CP_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return w;
}

// upstream: utils.rs::normalize_role — strict CLI-input role (user | asp | evaluator).
export function normalizeRole(role) {
  const r = asciiLower(trim(role));
  if (r === 'user' || r === 'asp' || r === 'evaluator') return r;
  throw new Error(`invalid value for --role: ${r} (expected: user, asp, or evaluator)`);
}

// upstream: utils.rs::role_token_from_value — backend integer role code → token | undefined
export function roleTokenFromValue(role) {
  const n = asU64(role);
  if (n === 1) return 'user';
  if (n === 2) return 'asp';
  if (n === 3) return 'evaluator';
  return undefined;
}

// upstream: utils.rs::normalize_role_code — "1" | "2" | "3"
export function normalizeRoleCode(role) {
  const r = normalizeRole(role);
  return r === 'user' ? '1' : r === 'asp' ? '2' : '3';
}

// upstream: utils.rs::role_to_wire — requester | provider | evaluator
export const roleToWire = (role) => (role === 'user' ? 'requester' : role === 'asp' ? 'provider' : 'evaluator');

// upstream: utils.rs::normalize_bcp47 → canonically-cased tag | null
export function normalizeBcp47(value) {
  if (value === undefined || value === null) return null;
  const raw = trim(value);
  if (raw === '') return null;
  const subtags = raw.split(/[-_]/).filter((x) => x !== '');
  const language = subtags.shift();
  if (language === undefined) return null;
  if (language.length < 2 || language.length > 8 || !/^[A-Za-z]+$/.test(language)) return null;
  let out = asciiLower(language);
  for (const subtag of subtags) {
    out += '-';
    const isAlpha = /^[A-Za-z]*$/.test(subtag);
    const isDigit = /^[0-9]*$/.test(subtag);
    const len = Buffer.byteLength(subtag, 'utf8');
    if (len === 4 && isAlpha) out += asciiUpper(subtag[0]) + asciiLower(subtag.slice(1));
    else if ((len === 2 && isAlpha) || (len === 3 && isDigit)) out += asciiUpper(subtag);
    else out += asciiLower(subtag);
  }
  return defaultRegionComplete(out);
}

// upstream: utils.rs::default_region_complete (private)
function defaultRegionComplete(tag) {
  if (tag.includes('-')) return tag;
  return tag === 'zh' ? 'zh-CN' : tag === 'en' ? 'en-US' : tag === 'ja' ? 'ja-JP' : tag;
}

// ─── CLI arg helpers ──────────────────────────────────────────────────────

// upstream: utils.rs::require_non_empty → trimmed value
export function requireNonEmpty(value, flag) {
  if (value !== undefined && value !== null && trim(value) !== '') return trim(value);
  throw new Error(`missing required parameter: ${flag}`);
}

// upstream: utils.rs::trim_or_empty
export const trimOrEmpty = (value) => trim(value ?? '');

// upstream: utils.rs::ensure_asp_has_service
export function ensureAspHasService(card) {
  if (card.role === 'asp' && card.services.length === 0) throw new Error('ASP agents require at least one service; provide --service');
}

// upstream: utils.rs::ensure_asp_has_avatar
export function ensureAspHasAvatar(card) {
  if (card.role === 'asp' && trim(card.profilePicture) === '') throw new Error('ASP agents require an avatar; upload an image and provide --picture');
}

// upstream: utils.rs::detect_image_kind → [label, mime] | null
export function detectImageKind(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['PNG', 'image/png'];
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['JPEG', 'image/jpeg'];
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return ['WebP', 'image/webp'];
  return null;
}

// upstream: utils.rs::validate_avatar_image → [label, mime]
export function validateAvatarImage(bytes) {
  const kind = detectImageKind(bytes);
  if (!kind) throw new Error('unsupported image type — only PNG, JPEG, and WebP are accepted; please convert the file to one of those and retry');
  return kind;
}

// upstream: utils.rs::parse_u32_arg(value, flag, default, min, max, clamp_max) → number
export function parseU32Arg(value, flag, def, min, max, clampMax) {
  if (value === undefined || value === null) return def;
  const t = trim(value);
  if (!/^\+?[0-9]+$/.test(t) || BigInt(t) > 4294967295n) throw new Error(`invalid value for ${flag}: expected integer`);
  const parsed = Number(BigInt(t));
  if (min !== undefined && min !== null && parsed < min) throw new Error(`invalid value for ${flag}: must be >= ${min}`);
  if (max !== undefined && max !== null && parsed > max) {
    if (clampMax) return max;
    throw new Error(`invalid value for ${flag}: must be <= ${max}`);
  }
  return parsed;
}

// ─── `agent get` row enrichment ──────────────────────────────────────────

// upstream: utils.rs::role_label (private) — canonical token → English label
const ROLE_LABELS = new Map([['user', 'User'], ['asp', 'ASP'], ['evaluator', 'Evaluator']]);
export const roleLabel = (role) => ROLE_LABELS.get(trim(role));

// upstream: utils.rs::role_label_from_value (private)
function roleLabelFromValue(role) {
  const t = roleTokenFromValue(role);
  return t === undefined ? undefined : t === 'user' ? 'User' : t === 'asp' ? 'ASP' : 'Evaluator';
}

// upstream: utils.rs::role_is_asp (private)
const roleIsAsp = (role) => role !== undefined && roleTokenFromValue(role) === 'asp';

// upstream: utils.rs::for_each_agent_row (private)
function forEachAgentRow(v, f) {
  const items = mget(v, 'list');
  if (!Array.isArray(items)) return;
  for (let i = 0; i < items.length; i++) {
    const rows = mget(items[i], 'agentList');
    if (Array.isArray(rows)) for (let j = 0; j < rows.length; j++) rows[j] = f(rows[j]) ?? rows[j];
    else items[i] = f(items[i]) ?? items[i];
  }
}

// upstream: utils.rs::status_label (private)
export function statusLabel(status) {
  let key;
  if (isNumber(status)) {
    const n = asU64(status);
    if (n === undefined) return undefined;
    key = String(n);
  } else if (typeof status === 'string') key = trim(status);
  else return undefined;
  if (key === '1' || key === 'active') return 'active';
  if (key === '2') return 'not listed';
  if (key === '3' || key === '4' || key === '5') return 'unavailable';
  return undefined;
}

// upstream: utils.rs::approval_label (private)
const APPROVAL_LABELS = new Map([
  [1, 'Review not submitted'], [2, 'Listing under review'], [4, 'Listed — eligible for task recommendations'], [5, 'Listing rejected'],
  [7, 'This agent is currently unavailable'],
]);
export const approvalLabel = (status) => APPROVAL_LABELS.get(status);

// upstream: utils.rs::rating_stars (private) → string | undefined
export function ratingStars(reputation) {
  const count = asU64(mget(reputation, 'count'));
  if (count !== undefined && BigInt(count) === 0n) return undefined;
  const score = asU64(mget(reputation, 'score'));
  if (score === undefined) return undefined;
  return formatRatingStars(score);
}

// upstream: utils.rs::format_rating_stars (private)
export function formatRatingStars(score) {
  const s = Number(BigInt(score) < 100n ? BigInt(score) : 100n);
  const hundredths = s * 5;
  const whole = Math.floor(hundredths / 100), frac = hundredths % 100;
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return `${whole}.${frac / 10}`;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

// upstream: utils.rs::enrich_agent_get_rows
export const enrichAgentGetRows = (v) => forEachAgentRow(v, enrichAgentRow);

// upstream: utils.rs::enrich_agent_detail_rows
export function enrichAgentDetailRows(v) {
  if (Array.isArray(v)) for (const row of v) enrichAgentRow(row);
}

// upstream: utils.rs::enrich_agent_row (private) — additive display fields on one object row.
export function enrichAgentRow(row) {
  if (!isObject(row)) return;
  const label = mget(row, 'role') === undefined ? undefined : roleLabelFromValue(mget(row, 'role'));
  if (label !== undefined) row.roleLabel = label;
  const status = mget(row, 'status') === undefined ? undefined : statusLabel(mget(row, 'status'));
  if (status !== undefined) row.statusLabel = status;
  const approvalCode = asU64(mget(row, 'approvalDisplayStatus'));
  const approval = approvalCode === undefined ? undefined : approvalLabel(approvalCode);
  if (approval !== undefined) row.approvalLabel = approval;
  const stars = mget(row, 'reputation') === undefined ? undefined : ratingStars(mget(row, 'reputation'));
  if (stars !== undefined) row.ratingStars = stars;
  const card = buildAgentCard(row);
  if (card.length) row.card = card;
}

// upstream: utils.rs::card_row / cell (private) — json! {label, value}
const cardRow = (label, value) => ({ label, value: String(value) });
const cell = cardRow;

// upstream: utils.rs::short_address (private)
export function shortAddress(address) {
  const a = trim(address);
  let hex;
  if (a.startsWith('0x') || a.startsWith('0X')) hex = a.slice(2);
  else return undefined;
  if (Buffer.byteLength(hex, 'utf8') < 8 || !/^[0-9A-Fa-f]*$/.test(hex)) return undefined;
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

// upstream: utils.rs::first_str (private) — first key holding a JSON string wins, then trim.
export function firstStr(map, keys) {
  for (const k of keys) {
    const v = mget(map, k);
    if (typeof v === 'string') { const t = trim(v); return t === '' ? undefined : t; }
  }
  return undefined;
}

// upstream: utils.rs::first_fee (private) — non-blank string (trimmed) or number text.
export function firstFee(map, keys) {
  for (const k of keys) {
    const v = mget(map, k);
    if (typeof v === 'string' && trim(v) !== '') return trim(v);
    if (isNumber(v)) return numText(v);
  }
  return undefined;
}

// upstream: utils.rs::format_subscription_tiers (private)
export function formatSubscriptionTiers(map) {
  const raw = hasOwn(map, 'subscription') && map.subscription !== undefined ? map.subscription : mget(map, 'Subscription');
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!isObject(t)) continue;
    const fee = firstFee(t, ['fee', 'Fee', 'feeAmount']);
    if (fee === undefined) continue;
    const interval = firstStr(t, ['interval', 'Interval']) ?? 'month';
    const period = eqIgnoreAsciiCase(interval, 'month') ? 'month' : interval;
    out.push(`${fee} USDT / ${period}`);
  }
  return out;
}

// upstream: utils.rs::format_free_trial (private)
export function formatFreeTrial(map) {
  if (!formatSubscriptionTiers(map).length) return undefined;
  const raw = firstFee(map, ['freeTrial']);
  if (raw === undefined) return undefined;
  const t = trim(raw);
  if (!isPositiveInteger(t)) return undefined;
  const hours = BigInt(t);
  if (hours > 18446744073709551615n) return undefined;
  if (hours % 24n === 0n) {
    const days = hours / 24n;
    return `${days} day${days === 1n ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1n ? '' : 's'}`;
}

// upstream: utils.rs::unpriced_fee_label (private)
const unpricedFeeLabel = (isA2mcp) => (isA2mcp ? '—' : 'free');

// upstream: utils.rs::format_service_value (private)
export function formatServiceValue(service) {
  if (!isObject(service)) return undefined;
  const name = firstStr(service, ['serviceName', 'ServiceName', 'name']);
  if (name === undefined) return undefined;
  const rawType = firstStr(service, ['serviceType', 'ServiceType', 'servicetype']) ?? '';
  const up = asciiUpper(rawType);
  const typeLabel = up === 'A2MCP' ? 'API service' : up === 'A2A' ? 'agent-to-agent' : up;
  const isA2a = up === 'A2A';
  const isA2mcp = eqIgnoreAsciiCase(rawType, 'A2MCP');
  const subscription = formatSubscriptionTiers(service);
  const fee = firstFee(service, ['fee', 'Fee', 'feeAmount']);
  const feeStr = subscription.length ? subscription.join(', ') : fee !== undefined ? `${fee} USDT` : unpricedFeeLabel(isA2mcp);
  const endpoint = isA2a ? undefined : firstStr(service, ['endpoint', 'Endpoint']);
  const segments = [];
  if (typeLabel !== '') segments.push(typeLabel);
  segments.push(feeStr);
  const trial = formatFreeTrial(service);
  if (trial !== undefined) segments.push(`${trial} free trial`);
  if (endpoint !== undefined) segments.push(endpoint);
  return `${name} — ${segments.join(', ')}`;
}

// upstream: utils.rs::build_agent_card (private) — ordered {label, value} rows.
export function buildAgentCard(map) {
  const card = [];
  const id = readAgentId(map);
  if (id !== undefined) card.push(cardRow('Agent ID', `#${id}`));
  const name = typeof mget(map, 'name') === 'string' ? trim(map.name) : '';
  if (name !== '') card.push(cardRow('Name', name));
  const role = mget(map, 'role') === undefined ? undefined : roleLabelFromValue(map.role);
  if (role !== undefined) card.push(cardRow('Role', role));
  const status = mget(map, 'status') === undefined ? undefined : statusLabel(map.status);
  if (status !== undefined) card.push(cardRow('Status', status));
  const approval = asU64(mget(map, 'approvalDisplayStatus'));
  const aLabel = approval === undefined ? undefined : approvalLabel(approval);
  if (aLabel !== undefined) {
    const remark = typeof mget(map, 'approvalRemark') === 'string' ? trim(map.approvalRemark) : '';
    card.push(cardRow('Approval status', approval === 5 && remark !== '' ? `${aLabel} (reason: ${remark})` : aLabel));
  }
  const addr = firstStr(map, ['address', 'agentWalletAddress', 'ownerAddress']);
  const short = addr === undefined ? undefined : shortAddress(addr);
  if (short !== undefined) card.push(cardRow('Address', short));
  card.push(cardRow('Description', firstStr(map, ['description', 'profileDescription']) ?? '(not set)'));
  card.push(cardRow('Profile photo', firstStr(map, ['picture', 'profilePicture']) ?? 'default'));
  if (roleIsAsp(mget(map, 'role'))) {
    const services = mget(map, 'services');
    if (Array.isArray(services)) {
      let index = 0;
      for (const svc of services) {
        const value = formatServiceValue(svc);
        if (value !== undefined) { index++; card.push(cardRow(`Service ${index}`, value)); }
      }
    }
  }
  const reputation = mget(map, 'reputation');
  if (reputation !== undefined) {
    const stars = ratingStars(reputation);
    if (stars !== undefined) {
      const count = asU64(mget(reputation, 'count')) ?? 0;
      card.push(cardRow('Rating', `★ ${stars} (${count} reviews)`));
    }
  }
  const tx = typeof mget(map, 'txHash') === 'string' ? trim(map.txHash) : '';
  if (tx !== '') card.push(cardRow('txHash', tx));
  return card;
}

// ─── `cells`: table-row cells ─────────────────────────────────────────────

// upstream: utils.rs::truncate_name (private) — by Unicode scalars, `…` when truncated.
export function truncateName(name, max) {
  const chars = [...String(name)];
  return chars.length <= max ? String(name) : `${chars.slice(0, max).join('')}…`;
}

// upstream: utils.rs::read_agent_id (private) — u64 or string, non-blank (untrimmed).
function readAgentId(map) {
  const v = mget(map, 'agentId');
  if (v === undefined) return undefined;
  const n = asU64(v);
  const s = n !== undefined ? String(n) : typeof v === 'string' ? v : undefined;
  return s !== undefined && trim(s) !== '' ? s : undefined;
}

// upstream: utils.rs::build_agent_list_cells (private)
export function buildAgentListCells(map) {
  const id = readAgentId(map);
  const agentId = id !== undefined ? `#${id}` : '—';
  const rawName = typeof mget(map, 'name') === 'string' ? trim(map.name) : '';
  const name = rawName !== '' ? truncateName(rawName, 20) : '—';
  const role = (mget(map, 'role') === undefined ? undefined : roleLabelFromValue(map.role)) ?? '—';
  let status = '—', approval = '—';
  if (role === 'ASP') {
    status = (mget(map, 'status') === undefined ? undefined : statusLabel(map.status)) ?? '—';
    const code = asU64(mget(map, 'approvalDisplayStatus'));
    const label = code === undefined ? undefined : approvalLabel(code);
    if (label !== undefined) {
      const remark = typeof mget(map, 'approvalRemark') === 'string' ? trim(map.approvalRemark) : '';
      if (code === 5 && remark !== '') approval = `Review failed (reason: ${remark})`;
      else if (code === 5) approval = 'Review failed';
      else approval = label;
    }
  }
  const stars = mget(map, 'reputation') === undefined ? undefined : ratingStars(map.reputation);
  const rating = stars !== undefined ? `★ ${stars} (${asU64(mget(map.reputation, 'count')) ?? 0})` : 'No rating yet';
  return [cell('Agent ID', agentId), cell('Name', name), cell('Role', role), cell('Status', status), cell('Approval status', approval), cell('Rating', rating)];
}

// upstream: utils.rs::add_agent_list_cells
export function addAgentListCells(v) {
  if (isObject(v)) deriveHasMore(v);
  forEachAgentRow(v, (row) => { if (isObject(row)) row.cells = buildAgentListCells(row); });
}

// ─── search-result table ──────────────────────────────────────────────────

// upstream: utils.rs::build_search_table_row (private)
export function buildSearchTableRow(map) {
  const id = readAgentId(map);
  const rawName = typeof mget(map, 'name') === 'string' ? trim(map.name) : '';
  const rateV = mget(map, 'feedbackRate');
  let rating = '—';
  if (isNumber(rateV)) {
    const rate = asF64(rateV);
    rating = rate === 0 ? 'No rating yet' : `★ ${formatSearchRate(rate / 20.0)}`;
  }
  const priceV = mget(map, 'serviceMinPrice');
  const services = mget(map, 'services');
  const top = Array.isArray(services) && services.length ? formatTopService(services[0]) : undefined;
  const sold = mget(map, 'soldCount');
  return {
    agentId: id !== undefined ? `#${id}` : '—',
    name: rawName !== '' ? truncateName(rawName, 20) : '—',
    soldCount: sold !== undefined && sold !== null ? sold : '—',
    rating,
    minPrice: isNumber(priceV) ? numText(priceV) : '—',
    recommendService: top ?? '—',
  };
}

// upstream: utils.rs::format_search_rate — `{:.2}` (ties to even), trailing zeros trimmed.
export function formatSearchRate(rate) {
  let s = formatFixed(rate, 2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// upstream: utils.rs::format_top_service (private)
export function formatTopService(service) {
  if (!isObject(service)) return undefined;
  const name = firstStr(service, ['serviceName', 'ServiceName', 'name']);
  if (name === undefined) return undefined;
  const rawType = firstStr(service, ['serviceType', 'ServiceType', 'servicetype']) ?? '';
  const up = asciiUpper(rawType);
  const typeLabel = up === 'A2MCP' ? 'API service' : up === 'A2A' ? 'agent-to-agent' : up;
  const isA2mcp = eqIgnoreAsciiCase(rawType, 'A2MCP');
  const subscription = formatSubscriptionTiers(service);
  const fee = firstFee(service, ['feeAmount', 'fee', 'Fee']);
  const token = firstStr(service, ['feeToken', 'FeeToken']);
  let feeStr;
  if (subscription.length) feeStr = subscription.join(', ');
  else if (fee !== undefined) feeStr = token !== undefined ? `${fee} ${token}` : fee;
  else feeStr = unpricedFeeLabel(isA2mcp);
  const segments = [];
  if (typeLabel !== '') segments.push(typeLabel);
  segments.push(feeStr);
  return truncateName(`${name} (${segments.join(', ')})`, 40);
}

// upstream: utils.rs::build_search_table
export function buildSearchTable(v) {
  const list = mget(v, 'list');
  const rows = Array.isArray(list) ? list.filter(isObject).map(buildSearchTableRow) : [];
  return {
    total: mget(v, 'total') ?? null,
    page: mget(v, 'page') ?? null,
    pageSize: mget(v, 'pageSize') ?? null,
    table: {
      columns: [
        { key: 'agentId', label: 'Agent ID' }, { key: 'name', label: 'Name' }, { key: 'soldCount', label: 'Sold Count' },
        { key: 'rating', label: 'Rating' }, { key: 'minPrice', label: 'Min price' }, { key: 'recommendService', label: 'Top service' },
      ],
      rows,
    },
  };
}

// ─── service-list cells ───────────────────────────────────────────────────

// upstream: utils.rs::build_service_cells (private) → cells | undefined
export function buildServiceCells(index, service) {
  if (!isObject(service)) return undefined;
  const name = firstStr(service, ['serviceName', 'ServiceName', 'name']);
  if (name === undefined) return undefined;
  const rawType = firstStr(service, ['serviceType', 'ServiceType', 'servicetype']) ?? '';
  const up = asciiUpper(rawType);
  const typeLabel = up === '' ? '—' : up;
  const isA2a = up === 'A2A';
  const isA2mcp = eqIgnoreAsciiCase(rawType, 'A2MCP');
  const subscription = formatSubscriptionTiers(service);
  const fee = firstFee(service, ['fee', 'Fee', 'feeAmount']);
  const feeStr = subscription.length ? '—' : fee !== undefined ? `${fee} USDT` : unpricedFeeLabel(isA2mcp);
  const subscriptionStr = subscription.length ? subscription.join(', ') : '—';
  const freeTrial = formatFreeTrial(service) ?? '—';
  const endpoint = isA2a ? '—' : firstStr(service, ['endpoint', 'Endpoint']) ?? '—';
  const d = firstStr(service, ['serviceDescription', 'ServiceDescription', 'servicedescription']);
  const description = d !== undefined ? truncateName(d, 80) : '—';
  return [
    cell('#', String(index)), cell('Name', name), cell('Type', typeLabel), cell('Fee', feeStr), cell('Subscription', subscriptionStr),
    cell('Free trial', freeTrial), cell('Endpoint', endpoint), cell('Description', description),
  ];
}

// upstream: utils.rs::add_service_list_cells
export function addServiceListCells(v) {
  if (Array.isArray(v)) for (const w of v) addServiceCellsToNode(w);
  else addServiceCellsToNode(v);
}

// upstream: utils.rs::add_service_cells_to_node (private)
function addServiceCellsToNode(node) {
  if (!isObject(node)) return;
  deriveHasMore(node);
  const key = ['list', 'services'].find((k) => Array.isArray(mget(node, k)));
  if (key === undefined) return;
  let index = 0;
  for (const svc of node[key]) {
    index++;
    const cells = buildServiceCells(index, svc);
    if (cells) {
      const guide = mget(svc, 'serviceGuide');
      if (typeof guide === 'string' && trim(guide) !== '') {
        svc.serviceGuideHash = `sha256:${createHash('sha256').update(Buffer.from(guide, 'utf8')).digest('hex')}`;
      }
      svc.cells = cells;
    } else index--;
  }
}

// upstream: utils.rs::pagination_value (private) → BigInt | undefined
function paginationValue(v) {
  if (v === undefined) return undefined;
  if (isNumber(v)) { const n = asU64(v); return n === undefined ? undefined : BigInt(n); }
  if (typeof v === 'string') {
    const t = trim(v);
    if (!/^\+?[0-9]+$/.test(t)) return undefined;
    const b = BigInt(t);
    return b <= 18446744073709551615n ? b : undefined;
  }
  return undefined;
}

// upstream: utils.rs::derive_has_more (private) — hasMore = page*pageSize < total (saturating u64)
export function deriveHasMore(map) {
  const page = paginationValue(mget(map, 'page'));
  const size = paginationValue(mget(map, 'pageSize'));
  const total = paginationValue(mget(map, 'total'));
  if (page === undefined || size === undefined || total === undefined) return;
  let prod = page * size;
  if (prod > 18446744073709551615n) prod = 18446744073709551615n;
  map.hasMore = prod < total;
}

// ─── feedback-list cells ──────────────────────────────────────────────────

const p2 = (n) => String(n).padStart(2, '0');
// chrono `%Y` — 4-digit zero pad inside 0..=9999, else an explicit sign.
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));

// Millisecond range for which chrono 0.4.44 `Local.timestamp_millis_opt` is Single: the
// DateTime<Utc> range (-262144-01-01 .. +262143-12-31 UTC), narrowed by one year at each end by
// the Windows local-offset lookup (measured against the upstream toolchain on Windows).
const LOCAL_MILLIS_RANGE = process.platform === 'win32'
  ? [-8334601228800000n, 8210266876799999n] : [-8334632851200000n, 8210298412799999n];

// chrono::Local.timestamp_millis_opt(ms).single().format("%Y-%m-%d") → string | undefined
export function localDateFromMillis(ms) {
  const b = BigInt(ms);
  if (b < LOCAL_MILLIS_RANGE[0] || b > LOCAL_MILLIS_RANGE[1]) return undefined;
  const secs = b >= 0n ? b / 1000n : -((-b + 999n) / 1000n);
  const p = localParts(secs, Number(b - secs * 1000n) * 1e6);
  return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)}` : undefined;
}

// upstream: utils.rs::build_feedback_cells (private)
export function buildFeedbackCells(map) {
  let score100;
  for (const key of ['valueString', 'value']) {
    const v = mget(map, key);
    let parsed;
    if (typeof v === 'string') {
      const t = trim(v);
      parsed = parseF64(t.endsWith('/100') ? t.slice(0, -4) : t);
    } else if (isNumber(v)) parsed = asF64(v);
    if (parsed !== undefined) { score100 = parsed; break; }
  }
  let score;
  if (score100 !== undefined) score = formatSearchRate(score100 / 20.0);
  else {
    const s = asF64(mget(map, 'score'));
    score = s !== undefined ? formatSearchRate(s) : '—';
  }

  let reviewer = firstStr(map, ['agentName']);
  if (reviewer === undefined) {
    const c = mget(map, 'creatorId');
    const n = asU64(c);
    const raw = n !== undefined ? String(n) : typeof c === 'string' ? c : undefined;
    const t = raw === undefined ? '' : trim(raw);
    reviewer = t !== '' ? `#${t}` : '—';
  }

  let date;
  const tv = mget(map, 'time');
  let ts = asI64(tv);
  if (ts === undefined && typeof tv === 'string') ts = parseI64(trim(tv));
  if (ts !== undefined) date = localDateFromMillis(ts);
  if (date === undefined) {
    const c = mget(map, 'createdAt');
    const n = asU64(c);
    const raw = typeof c === 'string' ? c : n !== undefined ? String(n) : undefined;
    const t = raw === undefined ? '' : trim(raw);
    date = t !== '' ? t : '—';
  }

  const comment = firstStr(map, ['content', 'description']) ?? '(no comment)';
  return [cell('Score', score), cell('Reviewer', reviewer), cell('Date', date), cell('Comment', comment)];
}

// upstream: utils.rs::add_feedback_list_cells
export function addFeedbackListCells(v) {
  if (!isObject(v)) return;
  deriveHasMore(v);
  for (const key of ['items', 'list']) {
    const items = mget(v, key);
    if (!Array.isArray(items)) continue;
    for (const item of items) if (isObject(item)) item.cells = buildFeedbackCells(item);
  }
}
