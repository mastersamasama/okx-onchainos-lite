// Unified, read-only subscription-task listing for the current User identity — upstream
// task/user/subscription_list.rs (`agent subscription-list`). Active then Ended pages are
// presented as one stream with an opaque base64url cursor.
import { stringify, struct } from '../../../core/json.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { fromSlice, T } from '../../../core/serde.mjs';
import { get, asStr, asU64, asBool, asArray, isObject } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { B64 } from '../../../core/rs/codec.mjs';
import { resolveAgentId } from '../common/query.mjs';
import { AGENT_ROLE_USER, XLAYER_CHAIN_INDEX } from '../common/index.mjs';
import { TaskApiClient } from '../common/network/task-api-client.mjs';
import { formatUtcTimestamp } from '../common/deadline.mjs';
import { resolveTokenSymbolByAddress } from '../common/util.mjs';
import { enrichBuyerSubscriptionPage } from './subscription-ops.mjs';
import { fetchDeviceListSnapshot } from './flow-lifecycle/_peers.mjs';

const SUBSCRIPTION_MY_PATH = '/priapi/v1/aieco/task/subscribe/my';
const CURSOR_VERSION = 1;
const U32_MAX = 4294967295;

// upstream: subscription_list.rs::CursorStage (serde snake_case unit variants)
const STAGE = T.enum('CursorStage', [['active', 'active'], ['ended', 'ended']]);
// upstream: subscription_list.rs::SubscriptionCursor (struct field order)
const CURSOR = T.struct('SubscriptionCursor', [['version', T.u8], ['stage', STAGE], ['page', T.u32], ['offset', T.usize], ['page_size', T.u32],
  ['active_count', T.u64], ['ended_count', T.u64]]);

// upstream: subscription_list.rs::encode_cursor
export function encodeCursor(c) {
  const json = stringify(struct({ version: c.version, stage: c.stage, page: c.page, offset: c.offset, page_size: c.pageSize, active_count: c.activeCount, ended_count: c.endedCount }));
  return B64.URL_SAFE_NO_PAD.encode(Buffer.from(json, 'utf8'));
}

// upstream: subscription_list.rs::decode_cursor
export function decodeCursor(raw) {
  const invalid = () => new Error('invalid subscription cursor');
  let c;
  try { c = fromSlice(B64.URL_SAFE_NO_PAD.decode(raw), CURSOR); } catch { throw invalid(); }
  if (Number(c.version) !== CURSOR_VERSION || Number(c.page) === 0 || Number(c.page_size) === 0) throw invalid();
  return { version: c.version, stage: c.stage, page: c.page, offset: Number(c.offset), pageSize: c.page_size, activeCount: c.active_count, endedCount: c.ended_count };
}

const cursor = (stage, page, offset, pageSize, activeCount, endedCount) => ({ version: CURSOR_VERSION, stage, page, offset, pageSize, activeCount, endedCount });

// upstream: subscription_list.rs::subscription_path
const subscriptionPath = (page, pageSize, statusType) => `${SUBSCRIPTION_MY_PATH}?page=${page}&pageSize=${pageSize}&statusType=${statusType}`;

// upstream: subscription_list.rs::add_display_fields
function addDisplayFields(object, stage) {
  object.feeLabel = null;
  const autoRenew = typeof object.autoRenew === 'number' || typeof object.autoRenew === 'bigint' ? Number(object.autoRenew) : undefined;
  object.autoRenewLabel = autoRenew === 1 ? 'Enabled' : autoRenew === 0 ? 'Disabled' : '—';
  const intOf = (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint' ? Number(v) : undefined;
  let billing;
  if (intOf(object.trialType) === 1) billing = 'Trial Period';
  else { const p = intOf(object.periodIndex); billing = p !== undefined && p > 0 ? `Billing Period ${object.periodIndex}` : '—'; }
  object.billingPeriodLabel = billing;
  const awaiting = intOf(object.status) === 0;
  let nextCharge;
  if (stage === 'active' && autoRenew === 1 && !awaiting) nextCharge = formatUtcTimestamp(intOf(object.subEndTime) === undefined ? 0 : object.subEndTime);
  object.nextChargeAt = nextCharge ?? null;
  object.nextChargeLabel = nextCharge ?? (awaiting ? 'Pending acceptance' : '—');
  object.hasNoReceivingDevices = Array.isArray(object.deviceList) && object.deviceList.length === 0;
}

// upstream: subscription_list.rs::parse_page → { items, page, pageSize, total, hasNext }
export function parsePage(value, stage) {
  if (!isObject(value)) throw new Error('subscription page must be a JSON object');
  const total = asU64(get(value, 'total'));
  if (total === undefined) throw new Error('subscription page is missing numeric total');
  const page = asU64(get(value, 'page'));
  if (page === undefined || BigInt(page) > BigInt(U32_MAX)) throw new Error('subscription page is missing numeric page');
  const pageSize = asU64(get(value, 'pageSize'));
  if (pageSize === undefined || BigInt(pageSize) > BigInt(U32_MAX)) throw new Error('subscription page is missing numeric pageSize');
  const list = asArray(get(value, 'list'));
  if (!list) throw new Error('subscription page is missing list array');
  const items = list.map((item) => {
    if (!isObject(item)) return item;
    const o = { ...item, listStatus: stage };
    addDisplayFields(o, stage);
    return o;
  });
  return { items, page: Number(page), pageSize: Number(pageSize), total, hasNext: BigInt(page) * BigInt(pageSize) < BigInt(total) };
}

// upstream: subscription_list.rs::fetch_page
async function fetchPage(agentId, stage, page, pageSize) {
  const client = new TaskApiClient();
  let raw;
  try { raw = await client.getWithAgentId(subscriptionPath(page, pageSize, stage === 'active' ? 1 : 2), agentId); } catch (e) {
    throw new Error(`failed to fetch subscription tasks: ${displayTop(e)}`);
  }
  return parsePage(enrichBuyerSubscriptionPage(raw, agentId), stage);
}

// upstream: subscription_list.rs::identity_required (json! → sorted)
const identityRequired = () => ({
  phase: 'identity', decision: 'blocked', reason: 'user_identity_required',
  nextAction: [{ id: 'register_user_identity', recommend: true, params: { role: 'user' } }], payload: {},
});

// upstream: subscription_list.rs::subscription_actions
export function subscriptionActions(items, nextCursor, pageSize) {
  const all = items.map((i) => asStr(get(i, 'jobId'))).filter((x) => x !== undefined);
  const active = items.filter((i) => asStr(get(i, 'listStatus')) === 'active').map((i) => asStr(get(i, 'jobId'))).filter((x) => x !== undefined);
  const actions = [];
  if (active.length) actions.push({ id: 'manage_subscription_devices', actionLabel: 'Adjust receiving devices', recommend: true, params: { allowedJobIds: active } });
  if (all.length) actions.push({ id: 'view_subscription_detail', actionLabel: 'View subscription details', recommend: actions.length === 0, params: { allowedJobIds: all } });
  if (active.length) actions.push({ id: 'cancel_subscription', actionLabel: 'Cancel subscription', recommend: false, params: { allowedJobIds: active } });
  if (nextCursor !== null) actions.push({ id: 'next_subscription_page', actionLabel: 'View next page', recommend: actions.length === 0, params: { cursor: nextCursor, pageSize } });
  return actions;
}

// upstream: subscription_list.rs::ready_output
function readyOutput(items, c, pageSize, activeCount, endedCount) {
  const nextCursor = c ? encodeCursor(c) : null;
  return {
    phase: 'subscription_browsing', decision: 'ready', reason: 'subscription_list_loaded', nextAction: subscriptionActions(items, nextCursor, pageSize),
    payload: { items, nextCursor, pageSize, summary: { activeCount, endedCount } },
  };
}

// upstream: subscription_list.rs::next_from_active
function nextFromActive(page, activeCount, endedCount) {
  if (page.hasNext) return cursor('active', page.page + 1, 0, page.pageSize, activeCount, endedCount);
  if (BigInt(endedCount) > 0n) return cursor('ended', 1, 0, page.pageSize, activeCount, endedCount);
  return undefined;
}
// upstream: subscription_list.rs::next_from_ended
function nextFromEnded(page, consumed, activeCount, endedCount) {
  if (consumed < page.items.length) return cursor('ended', page.page, consumed, page.pageSize, activeCount, endedCount);
  if (page.hasNext) return cursor('ended', page.page + 1, 0, page.pageSize, activeCount, endedCount);
  return undefined;
}
// upstream: subscription_list.rs::append_ended
function appendEnded(items, ended, pageSize) {
  const remaining = Math.max(0, pageSize - items.length);
  const take = Math.min(remaining, ended.items.length);
  items.push(...ended.items.slice(0, take));
  return take;
}

// upstream: subscription_list.rs::initial_page
async function initialPage(agentId, pageSize) {
  const [active, ended] = await Promise.all([fetchPage(agentId, 'active', 1, pageSize), fetchPage(agentId, 'ended', 1, pageSize)]);
  const activeCount = active.total, endedCount = ended.total;
  const items = active.items.slice(0, pageSize);
  let c;
  if (active.hasNext) c = cursor('active', active.page + 1, 0, pageSize, activeCount, endedCount);
  else c = nextFromEnded(ended, appendEnded(items, ended, pageSize), activeCount, endedCount);
  return readyOutput(items, c, pageSize, activeCount, endedCount);
}

// upstream: subscription_list.rs::continue_page
async function continuePage(agentId, c) {
  const page = await fetchPage(agentId, c.stage, c.page, c.pageSize);
  const items = page.items.slice(c.offset).slice(0, c.pageSize);
  let next;
  if (c.stage === 'active' && page.hasNext) next = nextFromActive(page, c.activeCount, c.endedCount);
  else if (c.stage === 'active') {
    const ended = await fetchPage(agentId, 'ended', 1, c.pageSize);
    next = nextFromEnded(ended, appendEnded(items, ended, c.pageSize), c.activeCount, c.endedCount);
  } else next = nextFromEnded(page, c.offset + items.length, c.activeCount, c.endedCount);
  return readyOutput(items, next, c.pageSize, c.activeCount, c.endedCount);
}

// upstream: subscription_list.rs::set_fee_label
function setFeeLabel(object, symbol) {
  const a = asStr(get(object, 'serviceTokenAmount'));
  const amount = a === undefined || trim(a) === '' ? undefined : trim(a);
  const label = amount !== undefined && symbol !== undefined ? `${amount} ${symbol} / month` : undefined;
  object.feeTokenSymbol = symbol ?? null;
  object.feeLabel = label ?? null;
  object.feeDisplayReady = label !== undefined;
}

const INLINE_SYMBOL_KEYS = ['serviceTokenSymbol', 'tokenSymbol', 'paymentTokenSymbol'];
// upstream: subscription_list.rs::attach_fee_labels
async function attachFeeLabels(output) {
  const payload = get(output, 'payload');
  const items = asArray(get(payload, 'items'));
  if (!isObject(payload) || !items) return;
  const symbols = new Map();
  for (const item of items) {
    const hasInline = INLINE_SYMBOL_KEYS.some((k) => { const s = asStr(get(item, k)); return s !== undefined && trim(s) !== ''; });
    if (hasInline) continue;
    const raw = asStr(get(item, 'serviceTokenAddress'));
    if (raw === undefined || trim(raw) === '') continue;
    const address = trim(raw);
    if (symbols.has(address)) continue;
    let symbol;
    try { symbol = await resolveTokenSymbolByAddress(XLAYER_CHAIN_INDEX, address); } catch { symbol = undefined; }
    symbols.set(address, symbol);
  }
  for (const item of items) {
    if (!isObject(item)) continue;
    let inline;
    for (const k of INLINE_SYMBOL_KEYS) { const s = asStr(get(item, k)); if (s !== undefined) { inline = s; break; } }
    const inlineSymbol = inline !== undefined && trim(inline) !== '' ? trim(inline) : undefined;
    const addr = asStr(get(item, 'serviceTokenAddress'));
    const resolved = addr === undefined ? undefined : symbols.get(trim(addr));
    setFeeLabel(item, inlineSymbol ?? resolved);
  }
  const missing = items.filter((i) => asBool(get(i, 'feeDisplayReady')) !== true).map((i) => asStr(get(i, 'jobId'))).filter((x) => x !== undefined);
  payload.displayReady = missing.length === 0;
  payload.displayMissingFeeJobIds = missing;
}

// upstream: subscription_list.rs::attach_device_receipts
function attachDeviceReceipts(output, snapshot) {
  const payload = get(output, 'payload');
  if (!isObject(payload)) return;
  const devices = asArray(get(snapshot, 'list'));
  if (!devices) { payload.deviceDataAvailable = false; return; }
  payload.deviceDataAvailable = true;
  payload.devices = devices;
  payload.deviceColumns = devices.map((d) => {
    const id = asStr(get(d, 'deviceId')) ?? '';
    const n = asStr(get(d, 'deviceName'));
    const name = n !== undefined && n !== '' ? n : id;
    return { key: id, label: (asBool(get(d, 'isThisDevice')) ?? false) ? `${name} (This Device)` : name };
  });
  for (const item of asArray(get(payload, 'items')) ?? []) {
    if (!isObject(item)) continue;
    const configured = asArray(get(item, 'deviceList'));
    const dl = get(item, 'deviceList');
    const defaultAll = dl === undefined || dl === null;
    const cells = {};
    item.deviceReceipts = devices.map((d) => {
      const id = asStr(get(d, 'deviceId')) ?? '';
      const receives = defaultAll || (configured !== undefined && configured.some((x) => asStr(x) === id));
      const label = receives ? '✅' : '❌';
      cells[id] = label;
      const dn = get(d, 'deviceName');
      const td = get(d, 'isThisDevice');
      return { deviceId: id, deviceName: dn === undefined ? null : dn, isThisDevice: td === undefined ? false : td, receives, receivesLabel: label };
    });
    item.deviceReceiptCells = cells;
  }
}

// upstream: subscription_list.rs::handle_subscription_list → data
export async function handleSubscriptionList(cursorRaw, pageSize) {
  const agentId = await resolveAgentId('', AGENT_ROLE_USER);
  if (trim(agentId) === '') return identityRequired();
  let output;
  if (cursorRaw !== undefined && cursorRaw !== null) {
    const c = decodeCursor(cursorRaw);
    if (Number(c.pageSize) !== Number(pageSize)) throw new Error('--page-size must match the subscription cursor page size');
    output = await continuePage(agentId, c);
  } else output = await initialPage(agentId, pageSize);
  await attachFeeLabels(output);
  let snapshot;
  try { snapshot = await fetchDeviceListSnapshot(new TaskApiClient(), agentId, 1, 100); } catch { snapshot = undefined; }
  attachDeviceReceipts(output, snapshot);
  return output;
}
