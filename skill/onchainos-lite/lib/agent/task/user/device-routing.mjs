// Device routing for subscription messages (buyer side) — upstream task/user/device_routing.rs:
// `device-list`, `subscribe-device-update`, and the new-device routing marker / fan-out used by
// the wallet-login post-condition.
import { existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deviceId as cachedDeviceId } from '../../../core/device.mjs';
import { homePath, writeAtomic } from '../../../core/home.mjs';
import { stringify, struct } from '../../../core/json.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { fromStr, T } from '../../../wallet/_serde-json.mjs';
import { S, fromValue } from '../../_serde.mjs';
import { get, asStr, asArray, isObj, localParts, trim } from '../../_rs.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { resolveUserAgent } from './create.mjs';
import { SUBSCRIBE_API_PREFIX } from './create-subscribe.mjs';

// upstream: device_routing.rs constants
export const DEVICE_LIST_PATH = '/priapi/v5/wallet/agentic/agent/device-list';
export const MAX_UPDATE_ITEMS = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGES = 10000;
const PENDING_ROUTING_DIR = 'subscription-device-routing-pending';
const ROUTING_MARKER_VERSION = 2;

// ─── routing marker ───────────────────────────────────────────────────

// upstream: device_routing.rs::normalize_routing_scope (private)
export function normalizeRoutingScope(apiBaseUrl) {
  let url;
  try { url = new URL(apiBaseUrl); } catch (e) { throw new Error(`invalid API base URL for device-routing state: ${e.message}`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('device-routing state requires an HTTP(S) API origin');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

// upstream: device_routing.rs::pending_routing_marker_path (private)
export function pendingRoutingMarkerPath(apiBaseUrl, agentId, deviceId) {
  if (!agentId || !deviceId) throw new Error('cannot address device-routing state without agent and device ids');
  const scope = normalizeRoutingScope(apiBaseUrl);
  const h = createHash('sha256');
  h.update(Buffer.from(scope, 'utf8')); h.update(Buffer.from([0])); h.update(Buffer.from(agentId, 'utf8')); h.update(Buffer.from([0])); h.update(Buffer.from(deviceId, 'utf8'));
  return homePath(PENDING_ROUTING_DIR, `${h.digest('hex')}.pending`);
}

const MARKER = T.struct('RoutingMarker', [['version', T.i64], ['phase', T.string], ['remainingJobIds', T.vec(T.string), () => []]]);

// upstream: device_routing.rs::read_routing_marker (private) → marker | undefined
function readRoutingMarker(apiBaseUrl, agentId, deviceId) {
  const path = pendingRoutingMarkerPath(apiBaseUrl, agentId, deviceId);
  let isFile = false;
  try { isFile = statSync(path).isFile(); } catch {}
  if (!isFile) return undefined;
  let bytes;
  try { bytes = readFileSync(path); } catch (e) { throw new Error(`failed to read device-routing state ${path}: ${e.message}`); }
  let marker;
  try {
    marker = fromStr(bytes, MARKER);
    if (!['detected', 'routing', 'completed'].includes(marker.phase)) throw new Error(`unknown variant \`${marker.phase}\`, expected one of \`detected\`, \`routing\`, \`completed\``);
  } catch (e) { throw new Error(`failed to parse device-routing state ${path}: ${e.message}`); }
  if (marker.version !== ROUTING_MARKER_VERSION) throw new Error(`unsupported device-routing state version ${marker.version} in ${path}`);
  return marker;
}

// upstream: device_routing.rs::write_routing_marker (private) — compact struct JSON, atomic, 0600.
function writeRoutingMarker(apiBaseUrl, agentId, deviceId, marker) {
  const path = pendingRoutingMarkerPath(apiBaseUrl, agentId, deviceId);
  const bytes = stringify(struct({ version: ROUTING_MARKER_VERSION, phase: marker.phase, remainingJobIds: [...(marker.remainingJobIds ?? [])] }));
  try { writeAtomic(path, bytes, { mode: 0o600 }); } catch (e) { throw new Error(`failed to write temp file ${path}.tmp: ${e.message}`); }
}

// upstream: device_routing.rs::new_device_routing_is_pending
export function newDeviceRoutingIsPending(apiBaseUrl, agentId, deviceId) {
  const m = readRoutingMarker(apiBaseUrl, agentId, deviceId);
  return m !== undefined && (m.phase === 'detected' || m.phase === 'routing');
}
// upstream: device_routing.rs::mark_new_device_routing_pending
export const markNewDeviceRoutingPending = (apiBaseUrl, agentId, deviceId) => writeRoutingMarker(apiBaseUrl, agentId, deviceId, { phase: 'detected', remainingJobIds: [] });
// upstream: device_routing.rs::mark_new_device_routing_completed
export const markNewDeviceRoutingCompleted = (apiBaseUrl, agentId, deviceId) => writeRoutingMarker(apiBaseUrl, agentId, deviceId, { phase: 'completed', remainingJobIds: [] });
// upstream: device_routing.rs::clear_new_device_routing_state
export function clearNewDeviceRoutingState(apiBaseUrl, agentId, deviceId) {
  const path = pendingRoutingMarkerPath(apiBaseUrl, agentId, deviceId);
  if (existsSync(path)) {
    try { rmSync(path); } catch (e) { throw new Error(`failed to clear device-routing state ${path}: ${e.message}`); }
  }
}

// ─── device-list ──────────────────────────────────────────────────────

const p2 = (n) => String(n).padStart(2, '0');
// upstream: device_routing.rs::fmt_unix_millis — "0" | local "%Y-%m-%d %H:%M:%S %Z" | "{ms} (unparseable)"
export function fmtUnixMillis(tsMs) {
  const ms = BigInt(tsMs);
  if (ms === 0n) return '0';
  const secs = ms >= 0n ? ms / 1000n : -((-ms + 999n) / 1000n);
  const p = localParts(secs);
  if (!p) return `${tsMs} (unparseable)`;
  const a = Math.abs(p.off);
  const off = `${p.off < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}${a % 60 ? `:${p2(a % 60)}` : ''}`;
  const y = p.y >= 0 && p.y <= 9999 ? String(p.y).padStart(4, '0') : (p.y < 0 ? '-' : '+') + String(Math.abs(p.y)).padStart(4, '0');
  return `${y}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)} ${off}`;
}

const DEVICE_ROW = S.struct('DeviceRow', [['deviceId', S.string, { default: '' }], ['deviceName', S.string, { default: '' }], ['lastOnlineTime', S.i64, { default: 0 }]]);
const DEVICE_PAGE = S.struct('DevicePage', [['list', S.vec(DEVICE_ROW), { default: () => [] }], ['total', S.i64, { default: 0 }]]);

// upstream: device_routing.rs::decode_device_page (private)
export function decodeDevicePage(data) {
  const de = (v) => { try { return fromValue(DEVICE_PAGE, v); } catch (e) { throw new Error(`failed to parse device page: ${e.message}`); } };
  if (Array.isArray(data)) return data.length ? de(data[0]) : { list: [], total: 0 };
  if (data === null || data === undefined) return { list: [], total: 0 };
  return de(data);
}

// upstream: device_routing.rs::normalize_page_params (private) → [startPage, pageSize]
export const normalizePageParams = (page, pageSize) => [page < 1 ? 1 : page, pageSize < 1 ? DEFAULT_PAGE_SIZE : pageSize];

// upstream: device_routing.rs::pagination_done (private)
export function paginationDone(got, normSize, pageTotal, accLen, cur, startPage) {
  const reachedTotal = pageTotal > 0 && accLen >= pageTotal;
  return got === 0 || got < normSize || reachedTotal || cur - startPage >= MAX_PAGES;
}

// i64 values (page, pageSize, total) are carried as BigInt so values beyond 2^53 keep every digit
// in the request query and the echoed snapshot; serialised back as a number when JS-safe.
const i64Out = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b);

// upstream: device_routing.rs::fetch_all_devices (private) — page / pageSize: number | bigint (i64)
async function fetchAllDevices(client, agentIdRaw, page, pageSize) {
  const agentId = selectSubscriptionAgentId(agentIdRaw, '');
  const [sp, ns] = normalizePageParams(BigInt(page), BigInt(pageSize));
  const startPage = BigInt(sp), normSize = BigInt(ns);
  const acc = [];
  let cur = startPage;
  for (;;) {
    const data = await client.getWithAgentId(`${DEVICE_LIST_PATH}?page=${cur}&pageSize=${normSize}`, agentId);
    const dpage = decodeDevicePage(data);
    const pageTotal = BigInt(dpage.total);
    const got = dpage.list.length;
    acc.push(...dpage.list);
    if (paginationDone(got, normSize, pageTotal, acc.length, cur, startPage)) {
      const accLen = BigInt(acc.length);
      return { list: acc, total: i64Out(pageTotal > accLen ? pageTotal : accLen) };   // resolve_total
    }
    cur += 1n;
  }
}

// upstream: device_routing.rs::fetch_device_list_snapshot (json! → sorted keys)
export async function fetchDeviceListSnapshot(client, agentId, page, pageSize) {
  const aggregated = await fetchAllDevices(client, agentId, page, pageSize);
  const thisId = cachedDeviceId();
  const list = aggregated.list.map((row) => ({
    deviceId: row.deviceId, deviceName: row.deviceName, lastOnlineTime: row.lastOnlineTime,
    lastOnlineLocal: fmtUnixMillis(row.lastOnlineTime), isThisDevice: thisId !== undefined && thisId !== null && thisId === row.deviceId,
  }));
  const [echoedPage, echoedSize] = normalizePageParams(BigInt(page), BigInt(pageSize)).map((v) => i64Out(BigInt(v)));
  return { list, total: aggregated.total, page: echoedPage, pageSize: echoedSize, thisDeviceId: thisId ?? null };
}

// Shared wrapper: ensure_tokens_refreshed with the device commands' error text.
async function requireSession() {
  try { await ensureTokensRefreshed(); } catch (e) { throw new Error(`session has expired; run \`onchainos wallet login\` first: ${displayTop(e)}`); }
}

// upstream: device_routing.rs::handle_device_list → snapshot (success data)
export async function handleDeviceList(client, page, pageSize) {
  await requireSession();
  const [agentId] = await resolveUserAgent();
  return fetchDeviceListSnapshot(client, agentId, page, pageSize);
}

// ─── subscribe-device-update ──────────────────────────────────────────

// upstream: device_routing.rs::parse_csv_devices (private) — Rust `str::trim` (Unicode White_Space:
// strips U+0085, keeps U+FEFF), not JS `String#trim`.
export const parseCsvDevices = (csv) => (csv === undefined || csv === null ? [] : String(csv).split(',').map((s) => trim(s)).filter((d) => d !== ''));

const UPDATE_ITEMS = T.vec(T.struct('UpdateItem', [['jobId', T.string], ['deviceList', T.vec(T.string), () => []]]));

// upstream: device_routing.rs::normalize_items (private) → [{jobId, deviceList}]
export function normalizeItems(jobId, deviceList, items) {
  if (items !== undefined && items !== null) {
    let parsed;
    try { parsed = fromStr(items, UPDATE_ITEMS); } catch (e) { throw new Error(`--items must be a JSON array of {jobId, deviceList} objects: ${e.message}`); }
    if (parsed.some((it) => it.jobId === '')) throw new Error('--items entries must each carry a non-empty jobId');
    return parsed;
  }
  if (jobId === undefined || jobId === null) throw new Error('either --job-id (form A) or --items (form B) is required');
  if (jobId === '') throw new Error('--job-id must not be empty');
  return [{ jobId, deviceList: parseCsvDevices(deviceList) }];
}

// upstream: device_routing.rs::validate_items_len (private)
export function validateItemsLen(len) {
  if (len === 0) throw new Error('no subscriptions to update: provide --job-id or a non-empty --items array');
  if (len > MAX_UPDATE_ITEMS) throw new Error(`too many items (${len}); at most ${MAX_UPDATE_ITEMS} subscriptions per batch`);
}

// upstream: device_routing.rs::build_items_array (json! → sorted)
export const buildItemsArray = (items) => items.map((it) => ({ jobId: it.jobId, deviceList: [...it.deviceList] }));

// upstream: device_routing.rs::plan_new_device_updates
export function planNewDeviceUpdates(subscriptions, deviceId) {
  if (!deviceId) throw new Error('cannot enable subscription delivery for an empty device id');
  const list = asArray(get(subscriptions, 'list'));
  if (!list) throw new Error('subscription snapshot is missing its list');
  const updates = [];
  for (const row of list) {
    const raw = get(row, 'deviceList');
    if (raw === undefined || raw === null) continue;
    const devices = asArray(raw);
    if (!devices) throw new Error('subscription snapshot contains a malformed deviceList');
    if (devices.some((v) => asStr(v) === deviceId)) continue;
    const jobId = asStr(get(row, 'jobId'));
    if (jobId === undefined || jobId === '') throw new Error('subscription requiring a device update is missing its jobId');
    const next = [];
    for (const v of devices) {
      const id = asStr(v);
      if (id === undefined) throw new Error('subscription snapshot contains a non-string device id');
      next.push(id);
    }
    next.push(deviceId);
    updates.push({ jobId, deviceList: next });
  }
  return updates;
}

// upstream: device_routing.rs::reflect_new_device_in_snapshot (private; mutates subscriptions)
function reflectNewDeviceInSnapshot(subscriptions, deviceId, updatedJobIds) {
  const list = asArray(get(subscriptions, 'list'));
  if (!list) throw new Error('subscription snapshot is missing its list');
  for (const row of list) {
    if (!isObj(row)) throw new Error('subscription snapshot contains a malformed row');
    const jobId = asStr(get(row, 'jobId'));
    const devices = get(row, 'deviceList');
    let receives;
    if (devices === undefined || devices === null) receives = true;
    else if (Array.isArray(devices)) {
      if (jobId !== undefined && updatedJobIds.includes(jobId) && !devices.some((v) => asStr(v) === deviceId)) devices.push(deviceId);
      receives = devices.some((v) => asStr(v) === deviceId);
    } else throw new Error('subscription snapshot contains a malformed deviceList');
    row.thisDeviceReceives = receives;
  }
}

// upstream: device_routing.rs::post_update_items (private)
async function postUpdateItems(client, agentIdRaw, items) {
  const agentId = selectSubscriptionAgentId(agentIdRaw, '');
  validateItemsLen(items.length);
  let resp;
  try { resp = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/device/batchUpdate`, { items: buildItemsArray(items) }, agentId); } catch (e) {
    throw new Error(`subscribe-device-update failed: ${displayTop(e)}`);
  }
  if (resp !== true) throw new Error(`subscribe-device-update failed: backend did not confirm the update (data != true): ${stringify(resp ?? null)}`);
}

// upstream: device_routing.rs::select_updates_for_routing_marker (private)
function selectUpdatesForRoutingMarker(planned, marker) {
  let targets;
  if (marker.phase === 'detected') targets = planned.map((i) => i.jobId);
  else if (marker.phase === 'routing') targets = marker.remainingJobIds;
  else throw new Error('new-device routing is already completed; refusing to rewrite subscriptions');
  return planned.filter((i) => targets.includes(i.jobId));
}

// upstream: device_routing.rs::add_new_device_to_all_subscriptions → number of updated jobs
export async function addNewDeviceToAllSubscriptions(client, apiBaseUrl, agentId, subscriptions, deviceId) {
  const planned = planNewDeviceUpdates(subscriptions, deviceId);
  const marker = readRoutingMarker(apiBaseUrl, agentId, deviceId);
  if (!marker) throw new Error('new-device routing state is missing');
  const updates = selectUpdatesForRoutingMarker(planned, marker);
  let remaining = updates.map((i) => i.jobId);
  const phase = () => (remaining.length ? 'routing' : 'completed');
  writeRoutingMarker(apiBaseUrl, agentId, deviceId, { phase: phase(), remainingJobIds: remaining });
  for (let i = 0; i < updates.length; i += MAX_UPDATE_ITEMS) {
    const chunk = updates.slice(i, i + MAX_UPDATE_ITEMS);
    await postUpdateItems(client, agentId, chunk);
    remaining = remaining.filter((j) => !chunk.some((c) => c.jobId === j));
    writeRoutingMarker(apiBaseUrl, agentId, deviceId, { phase: phase(), remainingJobIds: remaining });
  }
  reflectNewDeviceInSnapshot(subscriptions, deviceId, updates.map((i) => i.jobId));
  return updates.length;
}

// upstream: device_routing.rs::handle_subscribe_device_update → {updated:[…]} (success data)
export async function handleSubscribeDeviceUpdate(client, jobId, deviceList, items) {
  const normalized = normalizeItems(jobId, deviceList, items);
  validateItemsLen(normalized.length);
  await requireSession();
  const [userAgentId] = await resolveUserAgent();
  await postUpdateItems(client, userAgentId, normalized);
  return { updated: buildItemsArray(normalized) };
}

