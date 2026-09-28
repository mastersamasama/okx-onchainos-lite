// Read-side agent identity commands — upstream commands/agent_commerce/identity/queries.rs:
// get (hidden), get-my-agents, get-agents, search, service-list, feedback-list, task-feedback,
// get-by-address (hidden). Every call is JWT-authenticated (Agentic Wallet login).
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { trim } from '../_rs.mjs';
import { XLAYER_CHAIN_INDEX } from './models.mjs';
import {
  addAgentListCells, addFeedbackListCells, addServiceListCells, buildSearchTable, convertFeedbackListScores, enrichAgentDetailRows,
  enrichAgentGetRows, normalizeRoleCode, normalizeSingletonObject, parseU32Arg, pushMultiQuery, pushOptionalQuery, requireNonEmpty,
  walletClient,
} from './utils.mjs';

const given = (v) => v !== undefined && v !== null;

// ─── Public command entry points (upstream prints; lite returns the data) ─────
export const getMyAgents = (args) => getMyAgentsImpl(args);
export const getAgents = (args) => getAgentsImpl(args);
export const get = (args) => getImpl(args);
export const search = (args) => searchImpl(args);
export const serviceList = (args) => serviceListImpl(args);
export const feedbackList = (args) => feedbackListImpl(args);
export const taskFeedback = (args) => taskFeedbackImpl(args);
export const getByAddress = (args) => getByAddressImpl(args);

// upstream: queries.rs::get_my_agents_impl
export async function getMyAgentsImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  return getMyAgentsWithAccessToken(args, accessToken);
}

// upstream: queries.rs::get_my_agents_with_access_token (also used by precise service-match)
export async function getMyAgentsWithAccessToken(args, accessToken) {
  const client = walletClient();
  const query = buildGetMyAgentsQuery(args);
  const out = normalizeSingletonObject(await client.getAuthed('/priapi/v5/wallet/agentic/agent/agent-list', accessToken, query));
  enrichAgentGetRows(out);
  addAgentListCells(out);
  return out;
}

// upstream: queries.rs::build_get_my_agents_query (private)
export function buildGetMyAgentsQuery(args) {
  const query = [['chainIndex', XLAYER_CHAIN_INDEX]];
  if (given(args.role) && trim(args.role) !== '') query.push(['role', normalizeRoleCode(args.role)]);
  pushOptionalQuery(query, 'ownerAddress', args.ownerAddress);
  pushOptionalQuery(query, 'agentIdList', args.agentIds);
  if (given(args.page)) query.push(['page', String(parseU32Arg(args.page, '--page', 1, 1, null, false))]);
  query.push(['pageSize', String(parseU32Arg(args.pageSize, '--page-size', 10, 1, null, false))]);
  return query;
}

// upstream: queries.rs::get_impl
export async function getImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const query = [['chainIndex', XLAYER_CHAIN_INDEX]];
  pushOptionalQuery(query, 'agentIdList', args.agentIds);
  if (given(args.page)) query.push(['page', String(parseU32Arg(args.page, '--page', 1, 1, null, false))]);
  query.push(['pageSize', String(parseU32Arg(args.pageSize, '--page-size', 5, 1, null, false))]);
  const out = normalizeSingletonObject(await client.getAuthed('/priapi/v5/wallet/agentic/agent/agent-list', accessToken, query));
  enrichAgentGetRows(out);
  if (!given(args.agentIds)) addAgentListCells(out);
  return out;
}

// upstream: queries.rs::get_agents_impl
export async function getAgentsImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const rawIds = requireNonEmpty(args.agentIds, '--agent-ids');
  const ids = rawIds.split(',').map(trim).filter((s) => s !== '');
  if (!ids.length) throw new Error('--agent-ids must contain at least one agent ID');
  const query = ids.map((id) => ['agentIdList', id]);
  query.push(['needBlackStatus', 'false'], ['needAgentService', 'false']);
  const out = await client.getAuthed('/priapi/v5/wallet/agentic/agent/batch-list', accessToken, query);
  enrichAgentDetailRows(out);
  return out;
}

// upstream: queries.rs::search_impl
export async function searchImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const queryText = requireNonEmpty(args.query, '--query');
  const query = [['query', queryText]];
  if (given(args.page)) query.push(['page', String(parseU32Arg(args.page, '--page', 1, 1, null, false))]);
  query.push(['pageSize', String(parseU32Arg(args.pageSize, '--page-size', 5, 1, 100, true))]);
  pushMultiQuery(query, 'feedback', args.feedback);
  pushMultiQuery(query, 'agentInfo', args.agentInfo);
  pushMultiQuery(query, 'status', args.status);
  pushMultiQuery(query, 'service', args.service);
  const out = normalizeSingletonObject(await client.getAuthed('/priapi/v5/wallet/agentic/search/agent-search', accessToken, query));
  return buildSearchTable(out);
}

// upstream: queries.rs::build_service_list_query (private)
export function buildServiceListQuery(agentId, serviceId, page, pageSize) {
  const p = parseU32Arg(page, '--page', 1, 1, null, false);
  const ps = parseU32Arg(pageSize, '--page-size', 3, 1, null, false);
  const query = [['agentId', agentId], ['page', String(p)], ['pageSize', String(ps)]];
  if (given(serviceId)) {
    const t = trim(serviceId);
    if (t === '') throw new Error('invalid parameter: --service-id must not be blank');
    query.push(['serviceId', t]);
  }
  return query;
}

// upstream: queries.rs::service_list_impl
export async function serviceListImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const query = buildServiceListQuery(agentId, args.serviceId, args.page, args.pageSize);
  const out = await client.getAuthed('/priapi/v5/wallet/agentic/agent/services', accessToken, query);
  addServiceListCells(out);
  return out;
}

// upstream: queries.rs::build_feedback_list_query (private)
export function buildFeedbackListQuery(agentId, page, pageSize) {
  const p = parseU32Arg(page, '--page', 1, 1, null, false);
  const ps = parseU32Arg(pageSize, '--page-size', 5, 1, 50, true);
  return [['agentId', agentId], ['pageNo', String(p)], ['pageSize', String(ps)]];
}

// upstream: queries.rs::feedback_list_impl
export async function feedbackListImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const query = buildFeedbackListQuery(agentId, args.page, args.pageSize);
  const out = normalizeSingletonObject(await client.getAuthed('/priapi/v5/wallet/agentic/agent/reviews', accessToken, query));
  convertFeedbackListScores(out);
  addFeedbackListCells(out);
  return out;
}

// upstream: queries.rs::task_feedback_impl
export async function taskFeedbackImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const taskId = requireNonEmpty(args.taskId, '--task-id');
  return client.getAuthed('/priapi/v5/wallet/agentic/agent/task-feedback', accessToken,
    [['agentId', agentId], ['taskId', taskId], ['chainIndex', XLAYER_CHAIN_INDEX]]);
}

// upstream: queries.rs::get_by_address_impl
export async function getByAddressImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const communicationAddress = requireNonEmpty(args.communicationAddress, '--communication-address');
  const chainIndex = given(args.chainIndex) && trim(args.chainIndex) !== '' ? trim(args.chainIndex) : XLAYER_CHAIN_INDEX;
  const data = await client.getAuthed('/priapi/v5/wallet/agentic/agent/by-communication-address', accessToken,
    [['communicationAddress', communicationAddress], ['chainIndex', chainIndex]]);
  return normalizeSingletonObject(data);
}
