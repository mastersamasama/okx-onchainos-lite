// Display-ready ASP task list and detail queries — upstream task/asp/task_query.rs.
// Both handlers return the success data (`output::success`); the command layer prints it.
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { get, asStr, asI64, asU64, asBool } from '../../../core/rs/value.mjs';
import { trim, asciiLower, eqIgnoreAsciiCase } from '../../../core/rs/str.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { AGENT_ROLE_ASP, isTestTask } from '../common/index.mjs';
import { resolveAgentIdOrError, statusName, taskStatusLabel, taskStatusDescription } from '../common/query.mjs';
import { formatLocalTimestampWithOffset } from '../common/deadline.mjs';
import { handleProviderArbitrationList, buildDetailResult as buildArbitrationDetailResult } from '../arbitration.mjs';
import { getDisputeStatus } from '../evaluator/dispute-status.mjs';
import { statusLabel as subscriptionStatusLabel, statusDescription as subscriptionStatusDescription } from '../user/subscription-ops.mjs';

// upstream: task_query.rs::TaskKind
export const TaskKind = Object.freeze({ OneTime: 'OneTime', Subscription: 'Subscription' });
const ONE_TIME_BACKEND_PAGE_SIZE = 20n;
const I64_MAX = 9223372036854775807n;
const U64_MAX = 18446744073709551615n;
const num = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// upstream: task_query.rs::scalar_string
export function scalarString(value) {
  if (value === undefined) return undefined;
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); if (t !== '') return t; }
  const i = asI64(value);
  if (i !== undefined) return String(i);
  const u = asU64(value);
  return u !== undefined ? String(u) : undefined;
}

// upstream: task_query.rs::string_from_keys
export function stringFromKeys(value, keys) {
  for (const k of keys) { const v = scalarString(get(value, k)); if (v !== undefined) return v; }
  return undefined;
}

// upstream: task_query.rs::integer_from_keys
export function integerFromKeys(value, keys) {
  for (const k of keys) {
    const v = get(value, k);
    if (v === undefined) continue;
    const i = asI64(v);
    if (i !== undefined) return i;
    const u = asU64(v);
    if (u !== undefined && BigInt(u) <= I64_MAX) return u;
    const s = asStr(v);
    if (s !== undefined) { const p = parseI64(trim(s)); if (p !== undefined) return p; }
  }
  return undefined;
}

// upstream: task_query.rs::bool_from_keys
export function boolFromKeys(value, keys) {
  for (const k of keys) {
    const v = get(value, k);
    if (v === undefined) continue;
    const b = asBool(v);
    if (b !== undefined) return b;
    const i = asI64(v);
    if (i !== undefined) return BigInt(i) !== 0n;
    const s = asStr(v);
    if (s === undefined) continue;
    const l = asciiLower(trim(s));
    if (l === 'true' || l === '1') return true;
    if (l === 'false' || l === '0') return false;
  }
  return undefined;
}

// upstream: task_query.rs::is_zero_amount
export function isZeroAmount(amount) {
  let a = trim(amount);
  while (a.startsWith('+')) a = a.slice(1);
  return a !== '' && /^[0.]+$/.test(a);
}

// upstream: task_query.rs::task_status
export const taskStatus = (value) => integerFromKeys(value, ['subStatus', 'status']) ?? -1;

const taskTypeLabel = (kind) => (kind === TaskKind.OneTime ? 'One-time Task' : 'Subscription Task');

const SUB_STATUS_NAME = { '-1': 'INIT', 0: 'CREATED', 1: 'ACTIVE', 3: 'REJECTED', 4: 'DISPUTED', 6: 'COMPLETED', 7: 'CLOSED', 8: 'EXPIRED', 9: 'FAILED' };

// upstream: task_query.rs::status_fields → [statusName, statusLabel, statusDescription]
export function statusFields(kind, code) {
  if (kind === TaskKind.OneTime) return [statusName(code), taskStatusLabel(code), taskStatusDescription(code)];
  return [SUB_STATUS_NAME[String(code)] ?? 'UNKNOWN', subscriptionStatusLabel(code), subscriptionStatusDescription(code)];
}

function amountAndSymbol(value, kind) {
  const amountKeys = kind === TaskKind.OneTime ? ['tokenAmount', 'paymentTokenAmount'] : ['serviceTokenAmount', 'paymentTokenAmount', 'tokenAmount'];
  const symbolKeys = kind === TaskKind.OneTime ? ['tokenSymbol', 'paymentTokenSymbol'] : ['serviceTokenSymbol', 'paymentTokenSymbol', 'tokenSymbol'];
  return [stringFromKeys(value, amountKeys), stringFromKeys(value, symbolKeys)];
}

function feeLabelWith(value, kind, oneTimeSuffix) {
  const [amount, symbol] = amountAndSymbol(value, kind);
  if (amount === undefined) return null;
  if (isZeroAmount(amount)) return 'Free';
  if (symbol === undefined) return null;
  return `${amount} ${symbol}${kind === TaskKind.Subscription ? ' / month' : oneTimeSuffix}`;
}
// upstream: task_query.rs::fee_label
export const feeLabel = (value, kind) => feeLabelWith(value, kind, ' / task');
// upstream: task_query.rs::detail_fee_label
export const detailFeeLabel = (value, kind) => feeLabelWith(value, kind, '');

function formattedTime(value, keys) {
  const t = integerFromKeys(value, keys);
  return (t === undefined ? undefined : formatLocalTimestampWithOffset(t)) ?? null;
}

// upstream: task_query.rs::date_only
export function dateOnly(value, keys) {
  const t = integerFromKeys(value, keys);
  const f = t === undefined ? undefined : formatLocalTimestampWithOffset(t);
  return f === undefined ? undefined : f.slice(0, 10);
}

function currentPeriod(value, kind) {
  const trial = integerFromKeys(value, ['trialType']);
  if (kind !== TaskKind.Subscription || (trial !== undefined && trial === 1) || BigInt(integerFromKeys(value, ['periodIndex']) ?? 0) <= 0n) return null;
  const s = dateOnly(value, ['periodStartTime', 'subStartTime']), e = dateOnly(value, ['periodEndTime', 'subEndTime']);
  return s !== undefined && e !== undefined ? `${s}–${e}` : null;
}

function billingPeriodLabel(value, kind) {
  if (kind !== TaskKind.Subscription) return null;
  if (integerFromKeys(value, ['trialType']) === 1) return 'Trial Period';
  const p = integerFromKeys(value, ['periodIndex']);
  return p !== undefined && BigInt(p) > 0n ? `Billing Period ${p}` : null;
}

function autoRenew(value, kind) {
  if (kind !== TaskKind.Subscription) return [null, false];
  const b = boolFromKeys(value, ['autoRenew']);
  if (b === true) return ['Enabled', true];
  if (b === false) return ['Disabled', false];
  return [null, false];
}

// upstream: task_query.rs::normalize_item (json! → sorted keys)
export function normalizeItem(value, kind) {
  const code = taskStatus(value);
  const [name, label, description] = statusFields(kind, code);
  const [autoRenewLabel, autoRenewEnabled] = autoRenew(value, kind);
  const nextChargeAt = kind === TaskKind.Subscription && code === 1 && autoRenewEnabled ? formattedTime(value, ['nextChargeTime', 'subEndTime']) : null;
  return {
    jobName: stringFromKeys(value, ['title', 'jobName', 'serviceName']) ?? null,
    jobId: stringFromKeys(value, ['jobId', 'subId']) ?? null,
    userName: stringFromKeys(value, ['buyerAgentName', 'userAgentName', 'buyerName', 'userName']) ?? null,
    userAgentId: stringFromKeys(value, ['buyerAgentId', 'userAgentId']) ?? null,
    testFlag: isTestTask(value),
    taskType: kind === TaskKind.Subscription ? 'subscription' : 'one_time',
    taskTypeLabel: taskTypeLabel(kind),
    status: name,
    statusCode: code,
    statusLabel: label,
    statusDescription: description,
    feeLabel: feeLabel(value, kind),
    detailFeeLabel: detailFeeLabel(value, kind),
    billingPeriodLabel: billingPeriodLabel(value, kind),
    billingCycleLabel: kind === TaskKind.Subscription ? 'Monthly' : null,
    currentPeriod: currentPeriod(value, kind),
    nextChargeAt,
    autoRenewLabel,
    createdAt: formattedTime(value, ['createTime', 'createdAt', 'subCreateTime']),
  };
}

// upstream: task_query.rs::page_items
export const pageItems = (value) => (Array.isArray(get(value, 'list')) ? get(value, 'list') : []);
// upstream: task_query.rs::page_total → BigInt-safe count
export function pageTotal(value) {
  const t = asU64(get(value, 'total'));
  return t !== undefined ? t : pageItems(value).length;
}
// upstream: task_query.rs::page_has_more (saturating u64 multiply)
export function pageHasMore(value, page, pageSize) {
  let prod = BigInt(page) * BigInt(pageSize);
  if (prod > U64_MAX) prod = U64_MAX;
  return prod < BigInt(pageTotal(value));
}

const SUBSCRIPTION_STATUS_NAMES = new Map([
  ['init', -1], ['created', 0], ['accepted', 1], ['active', 1], ['rejected', 3], ['disputed', 4],
  ['complete', 6], ['completed', 6], ['close', 7], ['closed', 7], ['expired', 8], ['failed', 9],
]);

// upstream: task_query.rs::subscription_status_code (a Map, so `constructor` / `__proto__` /
// `toString` stay unknown statuses instead of resolving to Object.prototype members)
export function subscriptionStatusCode(status) {
  const t = trim(status);
  const n = parseI64(t);
  if (n !== undefined) return n;
  return SUBSCRIPTION_STATUS_NAMES.get(asciiLower(t));
}

const nonBlankStatus = (status) => (status === undefined || status === null || trim(status) === '' ? undefined : trim(status));

function subscriptionMatchesStatus(value, status) {
  const s = nonBlankStatus(status);
  if (s === undefined) return true;
  const expected = subscriptionStatusCode(s);
  return expected !== undefined && BigInt(taskStatus(value)) === BigInt(expected);
}

// upstream: task_query.rs::subscription_list_path → path | undefined
export function subscriptionListPath(page, pageSize, status) {
  let path = `/priapi/v1/aieco/task/subscribe/my?page=${page}&pageSize=${pageSize}&statusType=0`;
  const s = nonBlankStatus(status);
  if (s !== undefined) {
    const code = subscriptionStatusCode(s);
    if (code === undefined) return undefined;
    path += `&statusList=${code}`;
  }
  return path;
}

// upstream: task_query.rs::one_time_list_path
export function oneTimeListPath(page, status) {
  let path = `/priapi/v1/aieco/task/my?page=${page}&page_size=${ONE_TIME_BACKEND_PAGE_SIZE}`;
  const s = nonBlankStatus(status);
  if (s !== undefined) path += `&status=${s}`;
  return path;
}

// upstream: task_query.rs::fetch_one_time_page
async function fetchOneTimePage(client, agentId, page, pageSize, status) {
  const start = BigInt(page - 1) * BigInt(pageSize);
  const end = start + BigInt(pageSize);
  const first = start / ONE_TIME_BACKEND_PAGE_SIZE + 1n;
  const last = (end > 0n ? end - 1n : 0n) / ONE_TIME_BACKEND_PAGE_SIZE + 1n;
  let total = 0;
  const items = [];
  for (let bp = first; bp <= last; bp++) {
    const response = await client.getWithIdentity(oneTimeListPath(bp, status), agentId);
    total = pageTotal(response);
    items.push(...pageItems(response));
    if (bp * ONE_TIME_BACKEND_PAGE_SIZE >= BigInt(total)) break;
  }
  const skip = Number(start % ONE_TIME_BACKEND_PAGE_SIZE);
  const list = items.slice(skip, skip + pageSize);
  return { page, pageSize, total, list };
}

const addSat = (a, b) => { const s = BigInt(a) + BigInt(b); return num(s > U64_MAX ? U64_MAX : s); };

// upstream: task_query.rs::build_list_result (json! → sorted keys)
export function buildListResult(agentId, page, pageSize, status, oneTime, subscriptions) {
  const subItems = pageItems(subscriptions)
    .filter((item) => { const pid = stringFromKeys(item, ['providerAgentId', 'aspAgentId']); return pid === undefined || pid === agentId; })
    .filter((item) => subscriptionMatchesStatus(item, status));
  const subscriptionTotal = pageTotal(subscriptions);
  const oneTimeTotal = pageTotal(oneTime);
  const items = subItems.map((item) => normalizeItem(item, TaskKind.Subscription));
  items.push(...pageItems(oneTime).map((item) => normalizeItem(item, TaskKind.OneTime)));
  const subscriptionHasMore = pageHasMore(subscriptions, page, pageSize);
  const oneTimeHasMore = pageHasMore(oneTime, page, pageSize);
  const allowedJobIds = items.map((i) => i.jobId).filter((j) => typeof j === 'string');
  return {
    phase: 'provider_task_list', decision: 'ready', reason: items.length ? 'tasks_found' : 'no_tasks',
    nextAction: [{ id: 'view_provider_task', actionLabel: 'View task details', recommend: false, params: { allowedJobIds, confirmationRequired: false } }],
    payload: {
      agentId, page, pageSize, paginationScope: 'per_task_type', subscriptionTotal, subscriptionHasMore, oneTimeTotal, oneTimeHasMore,
      total: addSat(oneTimeTotal, subscriptionTotal), hasMore: subscriptionHasMore || oneTimeHasMore,
      hasSubscriptionTasks: items.some((i) => i.taskType === 'subscription'), items,
    },
  };
}

// upstream: task_query.rs::handle_list → success data
export async function handleList(client, status, page, pageSize, agentIdRaw) {
  if (Number(page) === 0 || Number(pageSize) === 0) throw new Error('page and page size must be greater than 0');
  const agentId = await resolveAgentIdOrError(agentIdRaw, AGENT_ROLE_ASP);
  if (status !== undefined && status !== null && eqIgnoreAsciiCase(trim(status), 'disputed')) {
    return handleProviderArbitrationList(client, agentId, page, pageSize);
  }
  await ensureTokensRefreshed();
  const subPath = subscriptionListPath(page, pageSize, status);
  const [oneTime, subscriptions] = await Promise.all([
    fetchOneTimePage(client, agentId, page, pageSize, status),
    subPath !== undefined ? client.getWithAgentId(subPath, agentId) : Promise.resolve({ page, pageSize, total: 0, list: [] }),
  ]);
  return buildListResult(agentId, page, pageSize, status, oneTime, subscriptions);
}

// upstream: task_query.rs::build_detail_result
export const buildDetailResult = (agentId, value, kind) => ({
  phase: 'provider_task_detail', decision: 'ready', reason: 'task_found', nextAction: [],
  payload: { agentId, task: normalizeItem(value, kind) },
});

// upstream: task_query.rs::build_provider_arbitration_detail_result
export function buildProviderArbitrationDetailResult(agentId, detail, kind, dispute) {
  const result = buildDetailResult(agentId, detail, kind);
  const arbitration = buildArbitrationDetailResult(asStr(get(detail, 'jobId')) ?? dispute.jobId, detail, dispute, undefined, undefined);
  result.nextAction = arbitration.nextAction;
  result.payload.arbitration = arbitration.payload;
  return result;
}

// upstream: task_query.rs::arbitration_detail_if_present → dispute | undefined
async function arbitrationDetailIfPresent(client, jobId, agentId, detail) {
  const s = BigInt(taskStatus(detail));
  if (s === 4n) return getDisputeStatus(client, jobId, agentId);
  if (s === 6n || s === 9n) { try { return await getDisputeStatus(client, jobId, agentId); } catch { return undefined; } }
  return undefined;
}

// upstream: task_query.rs::handle_detail → success data
export async function handleDetail(client, jobIdRaw, agentIdRaw) {
  const jobId = trim(jobIdRaw);
  if (jobId === '') throw new Error('jobId must not be empty');
  const agentId = await resolveAgentIdOrError(agentIdRaw, AGENT_ROLE_ASP);
  let detail, kind;
  try {
    const ordinary = await client.getWithIdentity(client.taskPath(jobId), agentId);
    const jt = integerFromKeys(ordinary, ['jobType']);
    if (jt !== undefined && BigInt(jt) === 1n) {
      try { detail = await client.fetchSubscription(jobId, agentId); } catch { detail = ordinary; }
      kind = TaskKind.Subscription;
    } else { detail = ordinary; kind = TaskKind.OneTime; }
  } catch (taskError) {
    try {
      detail = await client.fetchSubscription(jobId, agentId);
      kind = TaskKind.Subscription;
    } catch {
      let dispute;
      try { dispute = await getDisputeStatus(client, jobId, agentId); } catch { throw taskError; }
      const dkind = dispute.jobType !== null && Number(dispute.jobType) === 1 ? TaskKind.Subscription : TaskKind.OneTime;
      const synthetic = { jobId, jobType: dispute.jobType, status: dispute.taskStatus, tokenAmount: dispute.tokenAmount, tokenSymbol: dispute.tokenSymbol };
      return buildProviderArbitrationDetailResult(agentId, synthetic, dkind, dispute);
    }
  }
  const dispute = await arbitrationDetailIfPresent(client, jobId, agentId, detail);
  if (dispute !== undefined) return buildProviderArbitrationDetailResult(agentId, detail, kind, dispute);
  return buildDetailResult(agentId, detail, kind);
}

