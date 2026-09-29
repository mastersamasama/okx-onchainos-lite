// Unified buyer-side listing for subscription and one-time tasks — upstream task/user/my_tasks.rs.
import { CodedError } from '../../../core/errors.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { get, asArray, asU64, asI64, isObject } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { resolveAgentId, taskStatusLabel, taskStatusDescription } from '../common/query.mjs';
import { Status } from '../common/state-machine.mjs';
import { AGENT_ROLE_USER } from '../common/index.mjs';
import { enrichBuyerSubscriptionPage } from './subscription-ops.mjs';

const TASK_MY_PATH = '/priapi/v1/aieco/task/my';
const SUBSCRIPTION_MY_PATH = '/priapi/v1/aieco/task/subscribe/my';

// upstream: my_tasks.rs::MyTaskType ('all' | 'subscription' | 'one-time')
export const MyTaskType = Object.freeze({
  All: 'all', Subscription: 'subscription', OneTime: 'one-time',
  includes: (t, kind) => t === 'all' || t === kind,
});
const KIND_LABEL = { subscription: 'subscription', 'one-time': 'one-time' };

// upstream: my_tasks.rs::list_path (private)
export function listPath(kind, page, pageSize, statusType) {
  const base = kind === 'subscription' ? SUBSCRIPTION_MY_PATH : TASK_MY_PATH;
  return `${base}?page=${page}&pageSize=${pageSize}&statusType=${statusType === 0 ? 1 : statusType}`;
}

// upstream: my_tasks.rs::enrich_one_time_status_names (private)
function enrichOneTimeStatusNames(list) {
  for (const row of list) {
    if (!isObject(row)) continue;
    const code = asI64(get(row, 'status'));
    if (code === undefined) continue;
    const inI32 = typeof code === 'number' && code >= -2147483648 && code <= 2147483647;
    row.statusName = inI32 ? Status.asStr(Status.fromInt(code)) : `status_${code}`;
    row.statusLabel = taskStatusLabel(code);
    row.statusDescription = taskStatusDescription(code);
  }
}

const u32 = (v) => { const n = asU64(v); return n !== undefined && BigInt(n) <= 4294967295n ? Number(n) : undefined; };

// upstream: my_tasks.rs::Page::from_value (private)
export function pageFromValue(value, kind) {
  const label = KIND_LABEL[kind];
  if (!isObject(value)) throw new Error(`${label} task page must be a JSON object`);
  const total = asU64(get(value, 'total'));
  if (total === undefined) throw new Error(`${label} task page is missing numeric total`);
  const totalNoCondition = asU64(get(value, 'totalNoCondition'));
  if (totalNoCondition === undefined) throw new Error(`${label} task page is missing numeric totalNoCondition`);
  const page = u32(get(value, 'page'));
  if (page === undefined) throw new Error(`${label} task page is missing numeric page`);
  const pageSize = u32(get(value, 'pageSize'));
  if (pageSize === undefined) throw new Error(`${label} task page is missing numeric pageSize`);
  const list = asArray(get(value, 'list'));
  if (!list) throw new Error(`${label} task page is missing list array`);
  const rows = [...list];
  if (kind === 'one-time') enrichOneTimeStatusNames(rows);
  return {
    list: rows, total, totalNoCondition, page, pageSize,
    thisDeviceId: kind === 'subscription' ? get(value, 'thisDeviceId') : undefined,
    thisDeviceName: kind === 'subscription' ? get(value, 'thisDeviceName') : undefined,
  };
}

// upstream: my_tasks.rs::split_summary_and_page (private) → [counts, page, displayedStatusType]
function splitSummaryAndPage(statusType, page) {
  if (statusType === 0) return [{ all: page.totalNoCondition, active: page.total }, page, 1];
  if (statusType === 1) return [{ active: page.total }, page, 1];
  if (statusType === 2) return [{ ended: page.total }, page, 2];
  throw new Error(`status-type must be 0, 1, or 2; got ${statusType}`);
}

// upstream: my_tasks.rs::page_section (private; Map → sorted keys)
function pageSection(kind, statusType, page) {
  const section = {
    statusType, page: page.page, pageSize: page.pageSize, total: page.total, totalNoCondition: page.totalNoCondition,
    hasNext: BigInt(page.page) * BigInt(page.pageSize) < BigInt(page.total),
  };
  if (kind === 'subscription') {
    section.thisDeviceId = page.thisDeviceId ?? null;
    section.thisDeviceName = page.thisDeviceName ?? null;
  }
  section.list = page.list;
  return section;
}

// upstream: my_tasks.rs::compose_output
export function composeOutput(taskType, statusType, page, pageSize, subscriptions, oneTime) {
  if (!(statusType >= 0 && statusType <= 2)) throw new Error(`status-type must be 0, 1, or 2; got ${statusType}`);
  const summary = {};
  const output = { query: { taskType, statusType, page, pageSize } };
  if (MyTaskType.includes(taskType, 'subscription')) {
    if (!subscriptions) throw new Error('subscription results are required for this task type');
    const [counts, displayed, st] = splitSummaryAndPage(statusType, subscriptions);
    summary.subscription = counts;
    output.subscriptions = pageSection('subscription', st, displayed);
  } else if (subscriptions) throw new Error('subscription results were supplied for an unrequested task type');
  if (MyTaskType.includes(taskType, 'one-time')) {
    if (!oneTime) throw new Error('one-time results are required for this task type');
    const [counts, displayed, st] = splitSummaryAndPage(statusType, oneTime);
    summary.oneTime = counts;
    output.oneTimeTasks = pageSection('one-time', st, displayed);
  } else if (oneTime) throw new Error('one-time results were supplied for an unrequested task type');
  output.summary = summary;
  return output;
}

// upstream: my_tasks.rs::fetch_page (private)
async function fetchPage(client, agentId, kind, statusType, page, pageSize) {
  const path = listPath(kind, page, pageSize, statusType);
  let raw;
  try { raw = await client.getWithAgentId(path, agentId); } catch (e) {
    throw new Error(`${kind === 'subscription' ? 'failed to fetch subscription tasks' : 'failed to fetch one-time tasks'}: ${displayTop(e)}`);
  }
  const prepared = kind === 'subscription' ? enrichBuyerSubscriptionPage(raw, agentId) : raw;
  return pageFromValue(prepared, kind);
}

// upstream: my_tasks.rs::require_user_agent_id (private) — CodedError user_identity_required
function requireUserAgentId(agentId) {
  const id = trim(agentId);
  if (id === '') {
    throw new CodedError('user_identity_required', null, 'no User identity found on this account; register a User identity before listing tasks',
      { nextSteps: [{ action: 'register_user_identity', label: 'Register a User identity' }] });
  }
  return id;
}

// upstream: my_tasks.rs::handle_my_tasks → success data
export async function handleMyTasks(client, taskType, statusType, page, pageSize) {
  if (!(statusType >= 0 && statusType <= 2)) throw new Error(`status-type must be 0, 1, or 2; got ${statusType}`);
  const agentId = requireUserAgentId(await resolveAgentId('', AGENT_ROLE_USER));
  const subscriptions = MyTaskType.includes(taskType, 'subscription') ? await fetchPage(client, agentId, 'subscription', statusType, page, pageSize) : undefined;
  const oneTime = MyTaskType.includes(taskType, 'one-time') ? await fetchPage(client, agentId, 'one-time', statusType, page, pageSize) : undefined;
  return composeOutput(taskType, statusType, page, pageSize, subscriptions, oneTime);
}
