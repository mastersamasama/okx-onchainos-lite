// Subscription lifecycle management + read-only display — upstream task/user/subscription_ops.rs:
// subscribe-cancel, start-autorenew, subscribe-reject (disabled), subscribe-detail,
// subscribe-cost, my-subscriptions, plus the shared subscription helpers other units use.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditLog } from '../../../core/audit.mjs';
import { deviceId as cachedDeviceId, deviceName as cachedDeviceName } from '../../../core/device.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { onchainosHome, writeSecure } from '../../_home.mjs';
import { S, fromValue } from '../../_serde.mjs';
import { get, asStr, asI64, asU64, asBool, asArray, isObj, trim, parseI64, eqIgnoreAsciiCase } from '../../_rs.mjs';
import * as signing from '../signing.mjs';
import { AGENT_ROLE_USER, AGENT_ROLE_ASP, XLAYER_CHAIN_INDEX, fetchAgentProfile, findService } from '../common/index.mjs';
import { resolveAgentId } from '../common/query.mjs';
import { isCliMode } from '../common/config.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { sessionCreate, sessionSend, markRetiredAutotradeModeDecisionsHandled } from '../common/okx-a2a.mjs';
import { parseTimestampValue, formatUtcTimestamp } from '../common/deadline.mjs';
import { resolveTokenSymbolByAddress } from '../common/util.mjs';
import { isZeroDecimal } from './refund.mjs';
import { SUBSCRIBE_API_PREFIX } from './create-subscribe.mjs';
import { resolveUserAgent, content } from './flow-lifecycle/_peers.mjs';

const out = (s) => process.stdout.write(s);
const ACTIVE = 1;
const errWith = (prefix, e) => new Error(`${prefix}: ${displayTop(e)}`);

// ── session consent ──
// upstream: subscription_ops.rs::consent_marker_path
function consentMarkerPath(jobId) {
  if (!jobId || !/^[A-Za-z0-9_-]+$/.test(jobId)) return undefined;
  try { return join(onchainosHome(), 'subscription', 'consent', jobId); } catch { return undefined; }
}
// upstream: subscription_ops.rs::should_ensure_subscription_session
const shouldEnsureSubscriptionSession = (status) => status !== null && status !== undefined && Number(status) === ACTIVE;

// upstream: subscription_ops.rs::ensure_subscription_session (never fails the caller)
export async function ensureSubscriptionSession(jobId, myAgentId, providerAgentId) {
  if (!myAgentId) return;
  if (!providerAgentId || providerAgentId === '?') return;
  const marker = consentMarkerPath(jobId);
  if (marker === undefined || existsSync(marker)) return;
  let created = false;
  try { await sessionCreate(jobId, myAgentId, providerAgentId); created = true; } catch {}
  if (!created) return;
  try { await sessionSend(jobId, providerAgentId, '[SUB_CONSENT] subscription session established.'); } catch {}
  try { writeSecure(marker, Buffer.from('1')); } catch {}
}

// ── subscribe-cancel ──
// upstream: subscription_ops.rs::handle_subscribe_cancel (prints its own output)
export async function handleSubscribeCancel(client, subId) {
  await ensureTokensRefreshed();
  const [userAgentIdRaw] = await resolveUserAgent();
  const userAgentId = selectSubscriptionAgentId(userAgentIdRaw, '');
  const [accountId, address] = await signing.resolveWalletByAgentId(userAgentId);
  let resp;
  try { resp = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/${subId}/cancel`, {}, userAgentId); } catch (e) { throw errWith('subscribe-cancel failed', e); }
  const txHash = await signing.signUopAndBroadcast(client, get(resp, 'uopData') ?? null, accountId, address, subId, signing.extractBizType(resp), userAgentId, undefined);
  auditLog('cli', 'user/subscribe_cancel', true, 0, [`subId=${subId}`, `txHash=${txHash}`]);
  out(`✓ Subscription cancel in progress (transaction broadcast)\n  subId:  ${subId}\n  txHash: ${txHash}\n`);
  try { await markRetiredAutotradeModeDecisionsHandled(subId); } catch {}
  if (isCliMode()) out(`\n${(await content()).scopedWatchHandoff(subId)}\n`);
}

// ── start-autorenew ──
// upstream: subscription_ops.rs::handle_start_autorenew (prints its own output)
export async function handleStartAutorenew(client, subId) {
  await ensureTokensRefreshed();
  const [userAgentIdRaw] = await resolveUserAgent();
  const userAgentId = selectSubscriptionAgentId(userAgentIdRaw, '');
  const [accountId, address] = await signing.resolveWalletByAgentId(userAgentId);
  let confirm;
  try { confirm = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/providerConfirmStatus`, { subId, autoRenew: 1 }, userAgentId); } catch (e) {
    throw errWith('providerConfirmStatus failed', e);
  }
  if (confirm === null || !isObj(confirm) || Object.keys(confirm).length === 0) throw new Error('providerConfirmStatus returned empty terms');
  const typedData = get(confirm, 'typedData');
  if (typedData === undefined || typedData === null || !isObj(typedData) || Object.keys(typedData).length === 0) throw new Error('providerConfirmStatus response missing typedData');
  const termsSig = await signing.signTypedData(typedData, address);
  const terms = { ...confirm };
  delete terms.typedData;
  let resp;
  try { resp = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/${subId}/startAutoRenew`, { terms, termsSig }, userAgentId); } catch (e) {
    throw errWith('start-autorenew failed', e);
  }
  const txHash = await signing.signUopAndBroadcast(client, get(resp, 'uopData') ?? null, accountId, address, subId, signing.extractBizType(resp), userAgentId, undefined);
  auditLog('cli', 'user/start_autorenew', true, 0, [`subId=${subId}`, `txHash=${txHash}`]);
  out(`✓ Auto-renew enable in progress (transaction broadcast)\n  subId:  ${subId}\n  txHash: ${txHash}\n`);
}

// ── subscribe-reject ──
// upstream: subscription_ops.rs::handle_subscribe_reject_inner → txHash (only reachable from dead code upstream)
export async function handleSubscribeRejectInner(client, subId, reason, userAgentIdRaw) {
  const userAgentId = selectSubscriptionAgentId(userAgentIdRaw, '');
  const [accountId, address] = await signing.resolveWalletByAgentId(userAgentId);
  let resp;
  try { resp = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/${subId}/reject`, {}, userAgentId); } catch (e) { throw errWith('subscribe-reject failed', e); }
  const txHash = await signing.signUopAndBroadcast(client, get(resp, 'uopData') ?? null, accountId, address, subId, signing.extractBizType(resp), userAgentId, { reason });
  auditLog('cli', 'user/subscribe_reject', true, 0, [`subId=${subId}`, `txHash=${txHash}`]);
  return txHash;
}

// upstream: subscription_ops.rs::handle_subscribe_reject — disabled legacy entry.
export async function handleSubscribeReject(_client, subId, _reason) {
  throw new Error(`direct subscribe-reject is disabled by Refund; run \`onchainos agent refund-prepare ${subId} --reason <user-authored-reason>\` and execute only the returned confirmed action`);
}

// ── subscribe-detail ──
// upstream: subscription_ops.rs::fetch_subscribe_detail_for_agent
export async function fetchSubscribeDetailForAgent(client, subId, agentId) {
  try { return await client.getWithIdentity(`${SUBSCRIBE_API_PREFIX}/${subId}`, agentId); } catch (e) { throw errWith('subscribe-detail failed', e); }
}

// upstream: subscription_ops.rs::trial_window → [start, end]
function trialWindow(resp) {
  const read = (a, b) => asI64(get(resp, a) ?? null) ?? asI64(get(resp, b) ?? null) ?? 0;
  return [read('trialStartTime', 'trailStartTime'), read('trialEndTime', 'trailEndTime')];
}

// upstream: subscription_ops.rs::normalize_str_array
export function normalizeStrArray(v) {
  const arr = asArray(v);
  return arr ? arr.filter((x) => typeof x === 'string') : [];
}
// upstream: subscription_ops.rs::normalize_optional_str_array → array | null
export function normalizeOptionalStrArray(v) {
  if (v === undefined || v === null) return null;
  return normalizeStrArray(v);
}
// upstream: subscription_ops.rs::device_receives
export function deviceReceives(thisDeviceId, deviceList, defaultAllReceives) {
  if (deviceList === null || deviceList === undefined) return defaultAllReceives;
  return thisDeviceId !== null && thisDeviceId !== undefined && deviceList.includes(thisDeviceId);
}
// upstream: subscription_ops.rs::format_devices_for_human
export function formatDevicesForHuman(deviceList, thisDeviceId) {
  if (deviceList === null || deviceList === undefined) return 'all (default — deviceList is not explicitly configured)';
  if (!deviceList.length) return 'none (no device receives this subscription)';
  return deviceList.map((d) => { const short = [...d].slice(0, 8).join(''); return thisDeviceId === d ? `${short}(this device)` : short; }).join(', ');
}

// upstream: subscription_ops.rs::display_string
function displayString(value) {
  if (value === undefined) return undefined;
  const s = asStr(value);
  if (s !== undefined && trim(s) !== '') return trim(s);
  const i = asI64(value);
  if (i !== undefined) return String(i);
  const u = asU64(value);
  return u === undefined ? undefined : String(u);
}
// upstream: subscription_ops.rs::positive_trial_hours
function positiveTrialHours(value) {
  if (value === undefined || value === null) return undefined;
  const h = asI64(value) ?? (asStr(value) === undefined ? undefined : parseI64(trim(asStr(value))));
  return h !== undefined && BigInt(h) > 0n ? h : undefined;
}
// upstream: subscription_ops.rs::catalog_trial_facts → [supportsTrial?, trialHours?]
function catalogTrialFacts(service) {
  if (service === undefined || service === null) return [undefined, undefined];
  const hours = positiveTrialHours(get(service, 'freeTrial')) ?? positiveTrialHours(get(get(service, 'subscriptionInfo'), 'freeTrial'));
  const explicit = asBool(get(service, 'supportTrial')) ?? asBool(get(get(service, 'subscriptionInfo'), 'supportTrial'));
  return [explicit ?? hours !== undefined, hours];
}

// upstream: subscription_ops.rs::resolve_subscription_display_facts
async function resolveSubscriptionDisplayFacts(detail) {
  const providerAgentId = displayString(get(detail, 'providerAgentId'));
  const serviceId = displayString(get(detail, 'serviceId'));
  const catalog = providerAgentId !== undefined && serviceId !== undefined ? await findService(providerAgentId, serviceId) : undefined;
  let providerName;
  for (const k of ['providerAgentName', 'aspAgentName', 'providerName']) { providerName = displayString(get(detail, k)); if (providerName !== undefined) break; }
  if (providerName === undefined && catalog !== undefined) providerName = displayString(get(catalog, 'providerAgentName'));
  if (providerName === undefined && providerAgentId !== undefined) providerName = (await fetchAgentProfile(providerAgentId)).name ?? undefined;
  let tokenSymbol;
  for (const k of ['serviceTokenSymbol', 'tokenSymbol', 'paymentTokenSymbol']) { tokenSymbol = displayString(get(detail, k)); if (tokenSymbol !== undefined) break; }
  if (tokenSymbol === undefined) {
    const address = displayString(get(detail, 'serviceTokenAddress'));
    if (address !== undefined) tokenSymbol = await resolveTokenSymbolByAddress(XLAYER_CHAIN_INDEX, address);
  }
  const [catalogSupports, catalogHours] = catalogTrialFacts(catalog);
  const inlineHours = positiveTrialHours(get(detail, 'freeTrial'));
  const supportsTrial = asBool(get(detail, 'supportTrial')) ?? catalogSupports ?? (asI64(get(detail, 'trialType') ?? null) === 1 ? true : undefined);
  return { providerName, tokenSymbol, supportsTrial, trialHours: inlineHours ?? catalogHours };
}

// upstream: subscription_ops.rs::trial_duration_label
const trialDurationLabel = (hours) => (BigInt(hours) % 24n === 0n ? `${BigInt(hours) / 24n}-day` : `${hours}-hour`);

// upstream: subscription_ops.rs::subscription_fee_label
function subscriptionFeeLabel(amount, symbol) {
  const a = amount === undefined ? '' : trim(amount);
  if (a === '') return undefined;
  if (isZeroDecimal(a)) return 'Free';
  const s = symbol === undefined ? '' : trim(symbol);
  return s === '' ? undefined : `${a} ${s} / month`;
}

// upstream: subscription_ops.rs::free_trial_label
function freeTrialLabel(detail, facts) {
  const trialType = asI64(get(detail, 'trialType') ?? null);
  if (trialType === 1) {
    const [start, end] = trialWindow(detail);
    // i64 arithmetic (values may exceed 2^53, e.g. ns timestamps): `(end - start) / 3600` truncates.
    const s = BigInt(start), e = BigInt(end);
    const derivedBig = s > 0n && e > s ? (e - s) / 3600n : undefined;
    const derived = derivedBig === undefined ? undefined : (Number.isSafeInteger(Number(derivedBig)) ? Number(derivedBig) : derivedBig);
    const hours = facts.trialHours ?? (derived !== undefined && derived > 0 ? derived : undefined);
    if (hours === undefined) return undefined;
    const firstCharge = formatUtcTimestamp(end);
    if (firstCharge === undefined) return undefined;
    const amount = asStr(get(detail, 'serviceTokenAmount'));
    if (amount === undefined || facts.tokenSymbol === undefined) return undefined;
    return `${trialDurationLabel(hours)} free trial. The first subscription fee of ${amount} ${facts.tokenSymbol} will be charged at ${firstCharge}.`;
  }
  if (trialType === 0 && facts.supportsTrial === true) return 'You have already used the free trial for this service. The subscription fee is charged directly.';
  if (trialType === 0 && facts.supportsTrial === false) return 'Free trial is not supported.';
  return undefined;
}

// upstream: subscription_ops.rs::status_name / status_label / status_description
export function statusName(status) {
  return { '-1': 'INIT', 0: 'CREATED', 1: 'ACTIVE', 3: 'REJECTED', 4: 'DISPUTED', 6: 'COMPLETED', 7: 'CLOSED', 8: 'EXPIRED', 9: 'FAILED' }[String(status)] ?? `UNKNOWN_${status}`;
}
export function statusLabel(status) {
  return { '-1': 'Initializing', 0: 'Awaiting ASP acceptance', 1: 'Active', 3: 'Awaiting ASP decision', 4: 'Evaluation in progress', 6: 'Completed',
    7: 'Closed', 8: 'Expired', 9: 'Refund completed' }[String(status)] ?? 'Status unavailable';
}
export function statusDescription(status) {
  return { '-1': 'The subscription record was created and is awaiting on-chain confirmation.', 0: 'The subscription is waiting for an ASP to accept it.',
    1: 'The subscription is active.', 3: "The buyer rejected the current delivery and is waiting for the ASP's decision.", 4: 'The refund request is in Evaluation.',
    6: 'The subscription completed without a refund.', 7: 'The subscription is closed.', 8: 'The subscription expired.', 9: 'The refund completed successfully.' }[String(status)]
    ?? 'The subscription status is currently unavailable.';
}

// upstream: subscription_ops.rs::parse_status_filter → i32 (throws the clap value-parser message)
export function parseStatusFilter(s) {
  if (/^[+-]?[0-9]+$/.test(s)) {
    const n = BigInt(s);
    if (n >= -2147483648n && n <= 2147483647n) return Number(n);
  }
  const v = { INIT: -1, CREATED: 0, ACTIVE: 1, REJECTED: 3, DISPUTED: 4, COMPLETED: 6, CLOSED: 7, EXPIRED: 8, FAILED: 9 }[String(s).replace(/[a-z]/g, (c) => c.toUpperCase())];
  if (v !== undefined) return v;
  throw new Error(`invalid status '${s}': expected a code (-1/0/1/3/4/6/7/8/9) or a name (INIT/CREATED/ACTIVE/REJECTED/DISPUTED/COMPLETED/CLOSED/EXPIRED/FAILED)`);
}

const thisDeviceIdOrNull = () => { try { return cachedDeviceId() || null; } catch { return null; } };

// upstream: subscription_ops.rs::enrich_subscription_detail (pure)
export function enrichSubscriptionDetail(detail, thisDeviceId, defaultAllReceives, facts) {
  if (!isObj(detail)) return detail;
  const obj = detail;
  const code = asI64(get(obj, 'status') ?? null) ?? -1;
  obj.statusName = statusName(code);
  obj.statusLabel = statusLabel(code);
  obj.statusDescription = statusDescription(code);
  const deviceList = normalizeOptionalStrArray(get(obj, 'deviceList'));
  const categoryCodes = normalizeOptionalStrArray(get(obj, 'categoryCodes')) ?? [];
  const receives = deviceReceives(thisDeviceId, deviceList, defaultAllReceives);
  obj.deviceList = deviceList;
  obj.categoryCodes = categoryCodes;
  obj.thisDeviceReceives = receives;
  obj.thisDeviceId = thisDeviceId ?? null;
  obj.thisDeviceName = cachedDeviceName();
  const autoRenew = asI64(get(obj, 'autoRenew') ?? null);
  obj.autoRenewLabel = autoRenew === 1 ? 'Enabled' : autoRenew === 0 ? 'Disabled' : '—';
  let billing;
  if (asI64(get(obj, 'trialType') ?? null) === 1) billing = 'Trial Period';
  else { const p = asI64(get(obj, 'periodIndex') ?? null); billing = p !== undefined && BigInt(p) > 0n ? `Billing Period ${p}` : '—'; }
  obj.billingPeriodLabel = billing;
  let currentPeriodLabel = null;
  for (const [a, b] of [['periodStartTime', 'periodEndTime'], ['subStartTime', 'subEndTime']]) {
    const va = get(obj, a), vb = get(obj, b);
    const s = va === undefined ? undefined : parseTimestampValue(va);
    if (s === undefined) continue;
    const e = vb === undefined ? undefined : parseTimestampValue(vb);
    if (e === undefined) continue;
    const fs = formatUtcTimestamp(s), fe = formatUtcTimestamp(e);
    if (fs === undefined || fe === undefined) continue;
    currentPeriodLabel = `${fs}–${fe}`;
    break;
  }
  obj.currentPeriodLabel = currentPeriodLabel;
  const offline = asI64(get(obj, 'offlineReceiveFlag') ?? null);
  obj.offlineMessageHandlingLabel = offline === 1 ? 'Clear' : offline === 0 ? 'Resume delivery when back online' : '—';
  obj.receiveOnThisDeviceLabel = receives ? 'Receive' : 'Do not receive';
  obj.providerName = facts.providerName ?? null;
  const pid = displayString(get(obj, 'providerAgentId'));
  const name = facts.providerName;
  obj.serviceProviderLabel = name !== undefined && pid !== undefined ? `${name} (${pid})` : pid !== undefined ? `Agent ID ${pid}` : name !== undefined ? name : null;
  obj.feeTokenSymbol = facts.tokenSymbol ?? null;
  obj.feeLabel = subscriptionFeeLabel(asStr(get(obj, 'serviceTokenAmount')), facts.tokenSymbol) ?? null;
  obj.freeTrialLabel = freeTrialLabel(obj, facts) ?? null;
  const missing = [];
  for (const [field, key] of [['Job ID', 'jobId'], ['Job Name', 'title'], ['Job Description', 'description'], ['Service Provider', 'serviceProviderLabel'],
    ['Free Trial', 'freeTrialLabel'], ['Fee', 'feeLabel'], ['Current Period', 'currentPeriodLabel']]) {
    if (displayString(get(obj, key)) === undefined) missing.push(field);
  }
  obj.displayReady = displayString(get(obj, 'jobId')) !== undefined;
  obj.displayMissingFields = missing;
  return obj;
}

// upstream: subscription_ops.rs::handle_subscribe_detail → { json } | { text }
export async function handleSubscribeDetail(client, subId, format) {
  await ensureTokensRefreshed();
  const userAgentId = await signing.resolveAgentIdByRole(AGENT_ROLE_USER);
  const aspAgentId = trim(userAgentId) === '' ? await signing.resolveAgentIdByRole(AGENT_ROLE_ASP) : '';
  const agentId = selectSubscriptionAgentId(userAgentId, aspAgentId);
  const jsonMode = eqIgnoreAsciiCase(format, 'json');
  const resp = await fetchSubscribeDetailForAgent(client, subId, agentId);
  const isBuyer = agentId !== '' && asStr(get(resp, 'buyerAgentId')) === agentId;
  if (isBuyer && shouldEnsureSubscriptionSession(asI64(get(resp, 'status') ?? null) ?? -1)) {
    await ensureSubscriptionSession(subId, agentId, asStr(get(resp, 'providerAgentId')) ?? '');
  }
  if (jsonMode) {
    const facts = await resolveSubscriptionDisplayFacts(resp);
    return { json: enrichSubscriptionDetail(resp, thisDeviceIdOrNull(), isBuyer, facts) };
  }
  const s = (k, d) => asStr(get(resp, k)) ?? d;
  const title = s('title', '?');
  const trialType = asI64(get(resp, 'trialType') ?? null) ?? 0;
  const autoRenew = asI64(get(resp, 'autoRenew') ?? null) ?? 0;
  const periodIndex = asU64(get(resp, 'periodIndex') ?? null) ?? 0;
  const subStart = asI64(get(resp, 'subStartTime') ?? null), subEnd = asI64(get(resp, 'subEndTime') ?? null);
  let t = `Subscription Detail: ${title}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  t += `  subId:     ${s('jobId', subId)}\n  buyer:     #${s('buyerAgentId', '?')}\n  provider:  #${s('providerAgentId', '?')}\n`;
  t += `  fee:       ${s('serviceTokenAmount', '?')}/month\n  period:    ${periodIndex}\n  autoRenew: ${autoRenew}\n`;
  if (subStart !== undefined && subEnd !== undefined) t += `  current:   ${subStart} ~ ${subEnd}\n`;
  if (trialType === 1) { const [a, b] = trialWindow(resp); t += `  trial:     ${a} ~ ${b}\n`; }
  const offline = asI64(get(resp, 'offlineReceiveFlag') ?? null);
  const offlineLine = offline === 1 ? '1 (discard)' : offline === 0 ? '0 (keep — default)' : offline !== undefined ? `${offline} (keep — default)` : 'missing (keep — default)';
  t += `  offline:   ${offlineLine}\n`;
  t += `  devices:   ${formatDevicesForHuman(normalizeOptionalStrArray(get(resp, 'deviceList')), thisDeviceIdOrNull())}\n`;
  return { text: t };
}

// ── subscribe-cost ──
// upstream: subscription_ops.rs::handle_subscribe_cost → data
export async function handleSubscribeCost(client) {
  await ensureTokensRefreshed();
  const [agentIdRaw] = await resolveUserAgent();
  const agentId = selectSubscriptionAgentId(agentIdRaw, '');
  let resp;
  try { resp = await client.getWithIdentity(`${SUBSCRIBE_API_PREFIX}/cost/active`, agentId); } catch (e) { throw errWith('subscribe-cost failed', e); }
  auditLog('cli', 'user/subscribe_cost', true, 0, [`agentId=${agentId}`]);
  return resp;
}

// ── typed subscription rows ──
const devArray = {
  expecting: 'any valid JSON value', option: true,
  de: (v) => (v === null ? null : normalizeStrArray(v)),
};
// upstream: subscription_ops.rs::SubscriptionInfo (serde(default, rename_all = "camelCase"))
const SUBSCRIPTION_INFO = S.struct('SubscriptionInfo', [
  ['jobId', S.string, { default: '' }], ['jobType', S.i64, { default: 0 }], ['status', S.i64, { default: 0 }], ['chainId', S.i64, { default: 0 }],
  ['title', S.string, { default: '' }], ['description', S.string, { default: '' }], ['descriptionSummary', S.string, { default: '' }],
  ['buyerAgentId', S.string, { default: '' }], ['buyerAgentAddress', S.string, { default: '' }], ['providerAgentId', S.string, { default: '' }],
  ['providerAgentAddress', S.string, { default: '' }], ['trialType', S.i64, { default: 0 }],
  ['trialStartTime', S.option(S.i64), { default: null, aliases: ['trailStartTime'] }], ['trialEndTime', S.option(S.i64), { default: null, aliases: ['trailEndTime'] }],
  ['subStartTime', S.option(S.i64), { default: null }], ['subEndTime', S.option(S.i64), { default: null }], ['subBufferEndTime', S.option(S.i64), { default: null }],
  ['autoRenew', S.i64, { default: 0 }], ['copyTrade', S.i64, { default: 0 }], ['periodIndex', S.option(S.i64), { default: null }],
  ['serviceId', S.string, { default: '' }], ['serviceDescription', S.string, { default: '' }], ['serviceParams', S.string, { default: '' }],
  ['serviceTokenAddress', S.string, { default: '' }], ['serviceTokenAmount', S.string, { default: '' }], ['paymentTokenAddress', S.string, { default: '' }],
  ['paymentTokenAmount', S.string, { default: '' }], ['paymentCurrencyAmount', S.string, { default: '' }], ['offlineReceiveFlag', S.i64, { default: 0 }],
  ['role', S.string, { default: '' }], ['hasFeedBack', S.bool, { default: false }],
  ['deviceList', devArray, { default: null }], ['categoryCodes', devArray, { default: null }],
]);
// upstream: subscription_ops.rs::SubscriptionList
const SUBSCRIPTION_LIST = S.struct('SubscriptionList', [
  ['list', S.vec(SUBSCRIPTION_INFO), { default: () => [] }], ['total', S.u64, { default: 0 }], ['totalNoCondition', S.option(S.u64), { default: null }],
  ['page', S.option(S.u32), { default: null }], ['pageSize', S.option(S.u32), { default: null }],
]);
export const decodeSubscriptionList = (v) => fromValue(SUBSCRIPTION_LIST, v);

// upstream: subscription_ops.rs::enrich_subscription_info (mutates the typed row)
function enrichSubscriptionInfo(item, thisDeviceId, defaultAllReceives) {
  item.statusName = statusName(item.status);
  item.statusLabel = statusLabel(item.status);
  item.statusDescription = statusDescription(item.status);
  item.thisDeviceReceives = deviceReceives(thisDeviceId, item.deviceList, defaultAllReceives);
  item.categoryCodes = item.categoryCodes ?? [];
}
// serde_json::to_value(SubscriptionInfo) → sorted plain object
export function subscriptionInfoValue(item) {
  const v = { ...item };
  v.statusName ??= ''; v.statusLabel ??= ''; v.statusDescription ??= ''; v.thisDeviceReceives ??= false;
  if (v.serviceDescription === '') delete v.serviceDescription;
  return v;
}

// upstream: subscription_ops.rs::filter_subscriptions
function filterSubscriptions(list, role, selfAgentId, status) {
  return list.filter((item) => (role === 'buyer' ? item.buyerAgentId === selfAgentId : item.providerAgentId === selfAgentId))
    .filter((item) => status === undefined || status === null || BigInt(item.status) === BigInt(status));
}

// upstream: subscription_ops.rs::enrich_buyer_subscription_page
export function enrichBuyerSubscriptionPage(data, agentId) {
  let wrapper;
  try { wrapper = decodeSubscriptionList(data); } catch (e) { throw new Error(`failed to parse subscription page: ${e.message}`); }
  const thisId = thisDeviceIdOrNull();
  const list = filterSubscriptions(wrapper.list, 'buyer', agentId, undefined);
  for (const item of list) enrichSubscriptionInfo(item, thisId, true);
  const page = { list: list.map(subscriptionInfoValue), total: wrapper.total };
  if (wrapper.totalNoCondition !== null) page.totalNoCondition = wrapper.totalNoCondition;
  if (wrapper.page !== null) page.page = wrapper.page;
  if (wrapper.pageSize !== null) page.pageSize = wrapper.pageSize;
  page.thisDeviceId = thisId;
  page.thisDeviceName = cachedDeviceName();
  return page;
}

// upstream: subscription_ops.rs::ExistingSubscriptionSummary
function summarizeActiveBuyerSubscriptions(list, buyerAgentId) {
  return list.filter((i) => i.buyerAgentId === buyerAgentId && Number(i.status) === ACTIVE).map((i) => ({
    jobId: i.jobId, serviceId: i.serviceId, providerAgentId: i.providerAgentId, statusName: statusName(i.status), statusLabel: statusLabel(i.status),
    statusDescription: statusDescription(i.status), restoreListeningAvailable: Number(i.status) === ACTIVE, title: i.title, status: i.status,
  })).sort((a, b) => Buffer.compare(Buffer.from(a.jobId), Buffer.from(b.jobId)));
}
// serde_json::to_value(ExistingSubscriptionSummary) — statusName/title/status are skip_serializing.
export const existingSubscriptionValue = (s) => ({
  jobId: s.jobId, serviceId: s.serviceId, providerAgentId: s.providerAgentId, statusLabel: s.statusLabel, statusDescription: s.statusDescription,
  restoreListeningAvailable: s.restoreListeningAvailable,
});

// upstream: subscription_ops.rs::fetch_active_buyer_subscriptions_for_agent
export async function fetchActiveBuyerSubscriptionsForAgent(client, buyerAgentIdRaw) {
  const buyerAgentId = selectSubscriptionAgentId(buyerAgentIdRaw, '');
  let data;
  try { data = await client.getWithAgentId(`${SUBSCRIBE_API_PREFIX}/my`, buyerAgentId); } catch (e) { throw errWith('failed to check existing subscriptions', e); }
  let wrapper;
  try { wrapper = decodeSubscriptionList(data); } catch (e) { throw new Error(`failed to parse existing subscriptions: ${e.message}`); }
  return summarizeActiveBuyerSubscriptions(wrapper.list, buyerAgentId);
}

// upstream: subscription_ops.rs::existing_subscription_for_service
export const existingSubscriptionForService = (subscriptions, serviceId) => subscriptions.find((i) => i.serviceId === serviceId);

const normRole = (role) => String(role).toLowerCase();
const agentRole = (role) => (normRole(role) === 'buyer' ? AGENT_ROLE_USER : AGENT_ROLE_ASP);

// upstream: subscription_ops.rs::fetch_my_subscriptions_snapshot_for_agent_with_mode → { data, agentId, isEmpty }
async function fetchMySubscriptionsSnapshotForAgentWithMode(client, roleRaw, status, headerAgentRaw, establishSessions) {
  const role = normRole(roleRaw);
  const headerAgent = selectSubscriptionAgentId(headerAgentRaw, '');
  let data;
  try { data = await client.getWithAgentId(`${SUBSCRIBE_API_PREFIX}/my`, headerAgent); } catch (e) { throw errWith('failed to fetch subscriptions', e); }
  let wrapper;
  try { wrapper = decodeSubscriptionList(data); } catch (e) { throw new Error(`failed to parse subscription list: ${e.message}`); }
  const list = filterSubscriptions(wrapper.list, role, headerAgent, status);
  const thisId = thisDeviceIdOrNull();
  for (const item of list) enrichSubscriptionInfo(item, thisId, role === 'buyer');
  if (establishSessions && role === 'buyer') {
    for (const item of list) if (shouldEnsureSubscriptionSession(item.status)) await ensureSubscriptionSession(item.jobId, headerAgent, item.providerAgentId);
  }
  return { data: { list: list.map(subscriptionInfoValue), thisDeviceId: thisId, thisDeviceName: cachedDeviceName() }, agentId: headerAgent, isEmpty: list.length === 0 };
}

// upstream: subscription_ops.rs::fetch_my_subscriptions_snapshot_for_agent
export const fetchMySubscriptionsSnapshotForAgent = (client, role, status, headerAgent) => fetchMySubscriptionsSnapshotForAgentWithMode(client, role, status, headerAgent, true);
// upstream: subscription_ops.rs::fetch_my_subscriptions_snapshot_for_agent_read_only
export const fetchMySubscriptionsSnapshotForAgentReadOnly = (client, role, status, headerAgent) => fetchMySubscriptionsSnapshotForAgentWithMode(client, role, status, headerAgent, false);

// upstream: subscription_ops.rs::fetch_my_subscriptions_snapshot
export async function fetchMySubscriptionsSnapshot(client, role, status) {
  const headerAgent = await resolveAgentId('', agentRole(role));
  return fetchMySubscriptionsSnapshotForAgent(client, role, status, headerAgent);
}

// upstream: subscription_ops.rs::handle_my_subscriptions → data
export async function handleMySubscriptions(client, role, status) {
  return (await fetchMySubscriptionsSnapshot(client, role, status)).data;
}
