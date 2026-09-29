// Common task-system infrastructure — upstream task/common/mod.rs: constants, the
// pre-fetched task context, identity lookups through self-subprocesses (`agent get-agents`,
// `agent get-my-agents`, `agent service-list`), designated-route / my-agents / gate-check /
// communication-check / prepare-create / profile, and `common context`.
//
// Handlers that upstream finish with `output::success(x)` return `x` here (the command layer
// prints the envelope); plain-text handlers return the text.
import { loadWallets } from '../../../wallet/store.mjs';
import { resolveActiveAccountId } from '../../../wallet/account.mjs';
import { fromStr, fromValue, T } from '../../../core/serde.mjs';
import { selfOutput, utf8Lossy } from '../../_proc.mjs';
import { isObject, get, at, asStr, asI64, asU64, asBool, asArray, numText, isNumber } from '../../../core/rs/value.mjs';
import { trim, asciiLower, eqIgnoreAsciiCase, strDebug } from '../../../core/rs/str.mjs';
import { displayF64 } from '../../../core/json.mjs';
import { firstTimestamp, reviewDeadlineFromDetail } from './deadline.mjs';
import { validateJobId, fmtUnixSecs } from './util.mjs';
import { Role, Status } from './state-machine.mjs';
import { PaymentMode } from './payment-mode.mjs';
import { communicationGateJson } from './okx-a2a.mjs';
import { TaskApiClient } from './network/task-api-client.mjs';

// ─── constants ───
export const XLAYER_CHAIN_ID = 196;
export const XLAYER_CHAIN_INDEX = '196';
export const XLAYER_CHAIN_NAME = 'okb';
export const AGENT_ROLE_USER = 1;
export const AGENT_ROLE_ASP = 2;
export const AGENT_ROLE_EVALUATOR = 3;
export const TERMINAL_NOTIFICATION_MARKER = '[onchainos:task-terminal]';
// cfg!(feature = "debug-log") is false in release builds.
export const DEBUG_LOG = false;

export { PaymentMode } from './payment-mode.mjs';
export { ensureSufficientBalance, ensureSufficientBalanceAt, queryXlayerBalance } from './util.mjs';

// upstream: mod.rs::is_test_task
export const isTestTask = (task) => asBool(get(task, 'testFlag')) ?? false;

// upstream: mod.rs::has_same_agent_owner
export function hasSameAgentOwner(task) {
  const norm = (key) => { const s = asStr(get(task, key)); if (s === undefined) return undefined; const t = trim(s); return t === '' ? undefined : asciiLower(t); };
  const b = norm('buyerAgentAddress'), p = norm('providerAgentAddress');
  return b !== undefined && p !== undefined && b === p;
}

// ─── PreFetchedTaskContext ───
// upstream: mod.rs::PreFetchedDeliverable { path, deliverableType, originalName, textContent }
export const preFetchedDeliverable = ({ path, deliverableType, originalName, textContent = null }) => ({ path, deliverableType, originalName, textContent });

// Rust i64 from a JSON number or numeric string (`as_i64().or(as_str().parse())`).
const i64OrParse = (v) => {
  const i = asI64(v);
  if (i !== undefined) return i;
  const s = asStr(v);
  if (s !== undefined && /^[+-]?[0-9]+$/.test(s)) { const b = BigInt(s); if (b >= -9223372036854775808n && b <= 9223372036854775807n) return Number.isSafeInteger(Number(b)) ? Number(b) : b; }
  return undefined;
};

// upstream: mod.rs::PreFetchedTaskContext (fields camelCase; Option → null)
export class PreFetchedTaskContext {
  constructor(fields = {}) {
    Object.assign(this, {
      title: '', description: '', jobType: null, trialType: null, tokenSymbol: '?', tokenAmount: '', paymentMode: null, maxBudget: null,
      providerAgentId: null, providerName: null, userAgentId: null, status: null, deliverable: null, serviceId: null, serviceName: null,
      serviceTokenAddress: null, serviceTokenAmount: null, serviceParams: null, refundReason: null, periodStartTime: null, periodEndTime: null,
      userAgentAddress: null, tokenAddress: null, verifiedTransactionHash: null, refundRequestProvenance: false, expireTime: null,
      reviewExpireTime: null, testFlag: false,
    }, fields);
  }

  // upstream: PreFetchedTaskContext::from_api_response
  static fromApiResponse(v) {
    const string = (keys) => {
      for (const key of keys) {
        const value = get(v, key);
        if (value === undefined) continue;
        const s = asStr(value);
        if (s !== undefined) { const t = trim(s); if (t !== '') return t; }
        const i = asI64(value);
        if (i !== undefined) return String(i);
        const u = asU64(value);
        if (u !== undefined) return String(u);
      }
      return null;
    };
    const integer = (keys) => { for (const key of keys) { const val = get(v, key); if (val === undefined) continue; const n = i64OrParse(val); if (n !== undefined) return n; } return null; };
    const status = asI64(at(v, 'subStatus')) ?? asI64(at(v, 'status')) ?? (() => {
      const s = string(['subStatus', 'status']);
      if (s === null || !/^[+-]?[0-9]+$/.test(s)) return null;
      const b = BigInt(s);
      return b >= -9223372036854775808n && b <= 9223372036854775807n ? (Number.isSafeInteger(Number(b)) ? Number(b) : b) : null;
    })();
    return new PreFetchedTaskContext({
      title: asStr(at(v, 'title')) ?? '',
      description: asStr(at(v, 'description')) ?? '',
      jobType: i64OrParse(at(v, 'jobType')) ?? null,
      trialType: i64OrParse(at(v, 'trialType')) ?? null,
      tokenSymbol: string(['tokenSymbol', 'paymentTokenSymbol']) ?? '?',
      tokenAmount: string(['paymentTokenAmount', 'tokenAmount']) ?? '',
      paymentMode: i64OrParse(at(v, 'paymentMode')) ?? null,
      maxBudget: asStr(at(v, 'paymentMostTokenAmount')) ?? null,
      providerAgentId: string(['providerAgentId', 'aspAgentId']),
      providerName: string(['providerAgentName', 'aspAgentName', 'providerName']),
      userAgentId: string(['buyerAgentId', 'userAgentId']),
      status,
      deliverable: null,
      serviceId: string(['serviceId']),
      serviceName: string(['serviceName']),
      serviceTokenAddress: string(['serviceTokenAddress']),
      serviceTokenAmount: string(['serviceTokenAmount']),
      serviceParams: asStr(at(v, 'serviceParams')) ?? null,
      refundReason: string(['refundReason', 'rejectReason', 'userReason', 'reason']),
      periodStartTime: integer(['subStartTime', 'periodStartTime']),
      periodEndTime: integer(['subEndTime', 'periodEndTime']),
      userAgentAddress: asStr(at(v, 'buyerAgentAddress')) ?? null,
      tokenAddress: string(['paymentTokenAddress', 'tokenAddress']),
      verifiedTransactionHash: null,
      refundRequestProvenance: false,
      expireTime: firstTimestamp(v, ['rejectWindowEndsAt', 'responseDeadline', 'expireTime']) ?? null,
      reviewExpireTime: reviewDeadlineFromDetail(v) ?? null,
      testFlag: asBool(at(v, 'testFlag')) ?? false,
    });
  }

  // upstream: PreFetchedTaskContext::format_inline
  formatInline() {
    const pm = this.paymentMode;
    const pmLabel = pm === null || pm === undefined ? 'unknown' : Number(pm) === 1 ? 'escrow (1)' : Number(pm) === 3 ? 'x402 (3)' : `${pm} (unknown)`;
    const descLine = this.description === '' ? '' : `  description: ${this.description}\n`;
    const spLine = this.serviceParams ? `  serviceParams: ${this.serviceParams}\n` : '';
    const d = this.deliverable;
    const delivLine = d ? `  deliverable: saved | path: ${d.path} | type: ${d.deliverableType} | name: ${d.originalName}\n` : '';
    return '[Pre-fetched task context] (from status-check API — no need to call `common context` again unless a field below is missing)\n'
      + `  title: ${this.title}\n${descLine}`
      + `  tokenSymbol: ${this.tokenSymbol} | tokenAmount: ${this.tokenAmount} | paymentMode: ${pmLabel}\n`
      + `  maxBudget (paymentMostTokenAmount): ${this.maxBudget ?? 'not set'} | providerAgentId: ${this.providerAgentId ?? 'none'} | buyerAgentId: ${this.userAgentId ?? 'none'}\n`
      + spLine + delivLine;
  }
}

// ─── identity subprocess wrappers ───
// `serde_json::from_slice(stdout)` + envelope checks shared by the three spawners.
function parseChildEnvelope(o, label, noErr) {
  const raw = o.stdout;
  let body;
  try { body = fromStr(raw); } catch (e) { throw new Error(`parse \`${label}\` stdout failed: ${e.message}; raw=${utf8Lossy(raw)}`); }
  if (asBool(get(body, 'ok')) !== true) throw new Error(`\`${label}\` returned failure: ${asStr(get(body, 'error')) ?? noErr}`);
  return get(body, 'data') ?? null;
}

// upstream: mod.rs::raw_query_by_ids (`agent get-agents --agent-ids <ids>`)
export async function rawQueryByIds(agentIds) {
  const o = await selfOutput(['agent', 'get-agents', '--agent-ids', agentIds]);
  if (o.spawnError) throw new Error(`spawn \`get-agents\` failed: ${o.spawnError.message}`);
  return flattenAgentGroups(parseChildEnvelope(o, 'get-agents', '(no error message)'));
}

// upstream: mod.rs::raw_query_my_agents (`agent get-my-agents --owner-address <addr> [--role r] --page-size 100`)
export async function rawQueryMyAgents(role) {
  const owner = currentAccountXlayerAddress();
  if (owner === undefined) throw new Error('no current XLayer address');
  const args = ['agent', 'get-my-agents', '--owner-address', owner];
  if (role !== undefined && role !== null) args.push('--role', role);
  args.push('--page-size', '100');
  const o = await selfOutput(args);
  if (o.spawnError) throw new Error(`spawn \`get-my-agents\` failed: ${o.spawnError.message}`);
  return flattenAgentGroups(parseChildEnvelope(o, 'get-my-agents', '(no error)'));
}

// upstream: mod.rs::AgentProfile + fetch_agent_profile (fallback placeholder on any failure)
export async function fetchAgentProfile(agentId) {
  const fallback = () => ({ agentId, name: `Agent ${agentId}`, profileDescription: '(profile unavailable)', agentWalletAddress: null, communicationAddress: null });
  if (agentId === '') return fallback();
  let all;
  try { all = await rawQueryByIds(agentId); } catch { return fallback(); }
  const a = all.find((x) => asStr(get(x, 'agentId')) === agentId);
  if (!a) return fallback();
  return {
    agentId, name: asStr(get(a, 'name')) ?? null, profileDescription: asStr(get(a, 'profileDescription')) ?? null,
    agentWalletAddress: asStr(get(a, 'agentWalletAddress')) ?? null, communicationAddress: asStr(get(a, 'communicationAddress')) ?? null,
  };
}

// upstream: mod.rs::current_account_xlayer_address → lowercase address | undefined
export function currentAccountXlayerAddress() {
  let wallets;
  try { wallets = loadWallets(); } catch { return undefined; }
  if (!wallets) return undefined;
  let accountId;
  try { accountId = resolveActiveAccountId(wallets); } catch { return undefined; }
  const entry = Object.prototype.hasOwnProperty.call(wallets.accountsMap, accountId) ? wallets.accountsMap[accountId] : undefined;
  if (!entry) return undefined;
  const a = entry.addressList.find((x) => x.chainIndex === XLAYER_CHAIN_INDEX);
  return a ? a.address.toLowerCase() : undefined;
}

// upstream: mod.rs::fetch_my_agents (errors → [])
export async function fetchMyAgents() { try { return await rawQueryMyAgents(undefined); } catch { return []; } }
// upstream: mod.rs::fetch_my_agents_by_role (errors → [])
export async function fetchMyAgentsByRole(role) { try { return await rawQueryMyAgents(role); } catch { return []; } }
// upstream: mod.rs::fetch_my_agents_by_role_strict
export const fetchMyAgentsByRoleStrict = (role) => rawQueryMyAgents(role);

// upstream: mod.rs::fetch_agent_by_id → agent | undefined
export async function fetchAgentById(agentId) {
  const id = trim(agentId ?? '');
  if (id === '') return undefined;
  let agents;
  try { agents = await rawQueryByIds(id); } catch { return undefined; }
  return agents.find((a) => asStr(get(a, 'agentId')) === id);
}

// upstream: mod.rs::parse_role_filter → 1 | 2 | 3 | undefined
export function parseRoleFilter(raw) {
  return { user: AGENT_ROLE_USER, asp: AGENT_ROLE_ASP, evaluator: AGENT_ROLE_EVALUATOR }[trim(raw).toLowerCase()];
}
const roleError = (raw) => new Error(`unrecognized --role value: ${strDebug(raw)} (expected user / asp / evaluator)`);

// upstream: mod.rs::query_agent_by_id_direct
export async function queryAgentByIdDirect(agentId) {
  const id = trim(agentId ?? '');
  if (id === '') throw new Error('agent_id must not be empty');
  const all = await rawQueryByIds(id);
  const hit = all.find((a) => asStr(get(a, 'agentId')) === id);
  if (!hit) throw new Error(`agentId=${id} not found in \`get-agents\` response`);
  return hit;
}

// upstream: mod.rs::handle_profile → agent (success data)
export const handleProfile = (agentId) => queryAgentByIdDirect(agentId);

// upstream: mod.rs::spawn_service_list
export const spawnServiceList = (agentId) => spawnServiceListFiltered(agentId, undefined);

// upstream: mod.rs::spawn_service_list_filtered
export async function spawnServiceListFiltered(agentId, serviceId) {
  const args = ['agent', 'service-list', '--agent-id', agentId, '--page', '1', '--page-size', '100'];
  if (serviceId !== undefined && serviceId !== null && serviceId !== '') args.push('--service-id', serviceId);
  const o = await selfOutput(args);
  if (o.spawnError) throw new Error(`spawn \`agent service-list\` failed: ${o.spawnError.message}`);
  return parseChildEnvelope(o, 'agent service-list', '(no error message)');
}

const idText = (v) => { const s = asStr(v); if (s !== undefined) return s; const i = asI64(v); if (i !== undefined) return String(i); const u = asU64(v); return u !== undefined ? String(u) : undefined; };

// upstream: mod.rs::find_service_in_data
export function findServiceInData(data, serviceId) {
  for (const group of asArray(data) ?? []) {
    for (const s of asArray(get(group, 'list')) ?? []) {
      const id = get(s, 'id'), sid = get(s, 'serviceId');
      if ((id !== undefined && idText(id) === serviceId) || (sid !== undefined && idText(sid) === serviceId)) return s;
    }
  }
  return undefined;
}

// upstream: mod.rs::find_service → entry | undefined
export async function findService(agentId, serviceId) {
  if (serviceId === '') return undefined;
  const data = await spawnServiceListFiltered(agentId, serviceId);
  return findServiceInData(data, serviceId);
}

// upstream: mod.rs::scalar_text
export function scalarText(value) {
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); return t === '' ? undefined : t; }
  return isNumber(value) ? numText(value) : undefined;
}

// upstream: mod.rs::service_matching_id
export function serviceMatchingId(services, serviceId) {
  return services.find((s) => {
    const sid = get(s, 'serviceId');
    const t = (sid !== undefined ? scalarText(sid) : undefined) ?? (get(s, 'id') !== undefined ? scalarText(get(s, 'id')) : undefined);
    return t === serviceId;
  });
}

// upstream: mod.rs::designated_route_inner (json! → sorted keys)
export async function designatedRouteInner(providerId, targetServiceId) {
  const id = trim(providerId ?? '');
  if (id === '') throw new Error('--provider must not be empty');
  const [profileRes, svcRes] = await Promise.allSettled([queryAgentByIdDirect(id), spawnServiceList(id)]);
  if (profileRes.status === 'rejected') return { route: 'error', errorType: 'not_provider' };
  const profile = profileRes.value;
  const role = asI64(get(profile, 'role')) ?? 0;
  if (role !== 2) return { route: 'error', errorType: 'not_provider', providerName: asStr(get(profile, 'name')) ?? '' };
  const providerName = asStr(get(profile, 'name')) ?? '';
  const onlineStatus = asI64(get(profile, 'onlineStatus')) ?? 1;
  const servicesData = svcRes.status === 'fulfilled' ? svcRes.value : null;
  const entries = (asArray(servicesData) ?? []).flatMap((item) => asArray(get(item, 'list')) ?? []);
  let selected;
  if (targetServiceId !== undefined && targetServiceId !== null && targetServiceId !== '') {
    selected = serviceMatchingId(entries, targetServiceId);
    if (!selected) return { route: 'error', errorType: 'service_not_found', providerName, onlineStatus, requestedServiceId: targetServiceId };
  } else selected = entries[0];
  const st = selected === undefined ? undefined : asStr(get(selected, 'serviceType'));
  if (st !== undefined && eqIgnoreAsciiCase(st, 'A2MCP')) return { route: 'error', errorType: 'a2mcp_direct_invoke_required', providerName, onlineStatus };
  if (Number(onlineStatus) === 2) return { route: 'error', errorType: 'offline', providerName, onlineStatus };
  return { route: 'a2a', providerName, onlineStatus };
}

// upstream: mod.rs::handle_designated_route → route JSON
export const handleDesignatedRoute = (providerId, targetServiceId) => designatedRouteInner(providerId, targetServiceId);

// upstream: mod.rs::handle_my_agents → agent array
export async function handleMyAgents(role) {
  let filter;
  if (role !== undefined && role !== null) {
    filter = parseRoleFilter(role);
    if (filter === undefined) throw roleError(role);
  }
  let agents = await fetchMyAgents();
  if (filter !== undefined) agents = agents.filter((a) => asI64(get(a, 'role')) === filter);
  return agents;
}

// upstream: mod.rs::preflight_inner
export async function preflightInner(roleRaw) {
  const roleNum = parseRoleFilter(roleRaw);
  if (roleNum === undefined) throw roleError(roleRaw);
  const roleLabel = { 1: 'user', 2: 'asp', 3: 'evaluator' }[roleNum];
  let walletDetail;
  let wallets = null;
  try { wallets = loadWallets(); } catch { wallets = null; }
  if (wallets) {
    let accountId;
    try { accountId = resolveActiveAccountId(wallets); } catch { accountId = undefined; }
    if (accountId !== undefined) {
      const acct = wallets.accounts.find((a) => a.accountId === accountId);
      walletDetail = { ok: true, email: wallets.email, accountId, accountName: acct ? acct.accountName : '' };
    } else walletDetail = { ok: false, hint: 'wallet loaded but no active account; run `onchainos wallet login`' };
  } else walletDetail = { ok: false, hint: 'not logged in; run `onchainos wallet login`' };

  let identityDetail;
  if (!walletDetail.ok) identityDetail = { ok: false, hint: 'skipped — wallet not logged in' };
  else {
    const agents = (await fetchMyAgents()).filter((a) => asI64(get(a, 'role')) === roleNum);
    if (!agents.length) {
      identityDetail = { ok: false, role: roleLabel, hint: `no ${roleLabel} agent found; route to \`okx-ai\` with the intent "Register a ${roleLabel} identity"` };
    } else {
      const first = agents[0];
      identityDetail = { ok: true, role: roleLabel, agentId: asStr(get(first, 'agentId')) ?? '', name: asStr(get(first, 'name')) ?? '', status: get(first, 'status') ?? null };
    }
  }
  const walletOk = walletDetail.ok === true, identityOk = identityDetail.ok === true;
  const communicationDetail = !walletOk || !identityOk
    ? { ok: false, hint: 'skipped — resolve the wallet / identity gate first' }
    : await communicationGateJson();
  const communicationOk = asBool(get(communicationDetail, 'ok')) ?? false;
  return { ready: walletOk && identityOk && communicationOk, wallet: walletDetail, identity: identityDetail, communication: communicationDetail };
}

// upstream: mod.rs::handle_preflight → gate-check JSON
export const handlePreflight = (roleRaw) => preflightInner(roleRaw);

// upstream: mod.rs::handle_communication_check
export const handleCommunicationCheck = () => communicationGateJson();

// upstream: mod.rs::handle_prepare_create → success data (budget / maxBudget are f64 or undefined)
export async function handlePrepareCreate(description, title, budget, maxBudget, currency, provider) {
  // user/create.rs::validate_draft_fields — imported on first use: task/user/create imports this module
  const { validateDraftFields } = await import('../user/create.mjs');
  const validation = validateDraftFields(description, title, budget, maxBudget, currency);
  if (!(asBool(get(validation, 'ok')) ?? false)) return { ok: false, stage: 'validation', validation };
  const preflight = await preflightInner('user');
  if (!(asBool(get(preflight, 'ready')) ?? false)) return { ok: false, stage: 'preflight', validation, preflight };
  let routing;
  if (provider !== undefined && provider !== null && provider !== '') {
    try { routing = await designatedRouteInner(provider, undefined); } catch (e) {
      return { ok: false, stage: 'routing', validation, preflight, routing: { error: e.message } };
    }
  }
  const result = { ok: true, validation, preflight };
  if (routing !== undefined) result.routing = routing;
  return result;
}

// upstream: mod.rs::flatten_agent_groups
export function flattenAgentGroups(data) {
  if (Array.isArray(data) && data.length && get(data[0], 'agentId') !== undefined) return [...data];
  const listVal = get(data, 'list') ?? (Array.isArray(data) && data.length ? get(data[0], 'list') : undefined);
  const list = asArray(listVal);
  if (!list) return [];
  const flat = [];
  for (const entry of list) {
    const agents = asArray(get(entry, 'agentList'));
    if (agents) {
      const owner = asStr(get(entry, 'ownerAddress')), account = asStr(get(entry, 'accountName'));
      for (const a of agents) {
        if (isObject(a)) {
          const agent = { ...a };
          if (!Object.prototype.hasOwnProperty.call(agent, 'ownerAddress') && owner !== undefined) agent.ownerAddress = owner;
          if (!Object.prototype.hasOwnProperty.call(agent, 'accountName') && account !== undefined) agent.accountName = account;
          flat.push(agent);
        } else flat.push(a);
      }
      continue;
    }
    if (get(entry, 'agentId') !== undefined) flat.push(entry);
  }
  return flat;
}

// ─── `common context` ───
// upstream: mod.rs::status_desc
export function statusDesc(s) {
  return {
    init: 'Initializing (awaiting on-chain confirmation)', created: 'Awaiting acceptance (Created)', accepted: 'Accepted; ASP executing (Accepted)',
    submitted: 'ASP submitted deliverable; awaiting User Agent review (Submitted)',
    rejected: 'User Agent rejected deliverable; evaluation possible within freeze period (Rejected)',
    disputed: 'Evaluation in progress (Disputed)', admin_stopped: 'Admin stopped the task (AdminStopped)',
    completed: 'Task completed; funds released (Complete)', complete: 'Task completed; funds released (Complete)',
    failed: 'Refund completed; task closed (backend Failed)', close: 'User Agent closed the task (Close)', expired: 'Task expired (Expired)',
  }[s] ?? 'Unknown status';
}

// upstream: mod.rs::TaskDetail (derive(Deserialize), camelCase)
const TASK_DETAIL = T.struct('TaskDetail', [
  ['jobId', T.string], ['taskId', T.option(T.i64)], ['title', T.string], ['description', T.string], ['contentHash', T.option(T.string)],
  ['tokenAddress', T.option(T.string)], ['tokenSymbol', T.option(T.string)], ['tokenAmount', T.option(T.string)], ['paymentMode', T.option(T.i32)],
  ['status', T.option(T.i32)], ['sensitiveStatus', T.option(T.i32)], ['categoryCodes', T.option(T.vec(T.string))], ['chainId', T.option(T.i32)],
  ['minCreditScore', T.option(T.f64)], ['userAgentAddress', T.option(T.string)], ['userAgentId', T.option(T.string)],
  ['providerAgentAddress', T.option(T.string)], ['providerAgentId', T.option(T.string)], ['groupId', T.option(T.string)],
  ['expireConfig', T.option(T.value)], ['expireTime', T.option(T.i64)], ['paymentMostTokenAmount', T.option(T.string)], ['createTime', T.option(T.i64)],
]);

// upstream: mod.rs::build_context
export function buildContext(task, role, agentId, profile) {
  const roleEnum = Role.parse(role);
  const roleCn = { user: 'User Agent', asp: 'Agent Service Provider (ASP)', evaluator: 'Evaluator Agent' }[roleEnum] ?? role;
  const taskStatus = task.status === null ? 'unknown' : Status.fromInt(task.status);
  const statusText = `${taskStatus} — ${statusDesc(taskStatus)}`;
  let out = `You are the ${roleCn} in the task system.\n\n`;
  out += '[Your Identity]\n';
  out += `- Role: ${roleCn}\n`;
  out += `- AgentID: ${agentId}\n`;
  if (profile.agentWalletAddress !== null) out += `- Wallet address: ${profile.agentWalletAddress}\n`;
  if (profile.communicationAddress !== null) out += `- Communication address: ${profile.communicationAddress}\n`;
  if (profile.name !== null) out += `- Name: ${profile.name}\n`;
  if (profile.profileDescription !== null) out += `- Description: ${profile.profileDescription}\n`;
  out += '\n[Task Details]\n';
  out += `- Job ID: ${task.jobId}\n`;
  if (task.taskId !== null) out += `- Internal ID: ${task.taskId}\n`;
  out += `- Title: ${task.title}\n`;
  out += `- Description: ${task.description}\n`;
  const amount = task.tokenAmount ?? 'not set', token = task.tokenAddress ?? '', symbol = task.tokenSymbol ?? 'UNKNOWN';
  out += `- Budget: ${amount} ${symbol} (token: ${token})\n`;
  if (task.paymentMostTokenAmount !== null) out += `- 🔒 INTERNAL max budget (paymentMostTokenAmount): ${task.paymentMostTokenAmount} ${symbol} ← for internal decisions only; NEVER include in any message sent to the ASP\n`;
  const pm = task.paymentMode ?? 0;
  out += `- Payment mode (paymentType=${pm}): ${PaymentMode.desc(PaymentMode.fromInt(pm))}\n`;
  if (task.chainId !== null) out += `- Chain: chainId=${task.chainId}\n`;
  if (task.minCreditScore !== null) out += `- Min credit score: ${displayF64(task.minCreditScore)}\n`;
  if (task.expireConfig !== null) {
    const open = asU64(get(task.expireConfig, 'openExpireSec')), acc = asU64(get(task.expireConfig, 'acceptedExpireSec'));
    if (open !== undefined && acc !== undefined) out += `- Expiry: acceptance window ${BigInt(open) / 3600n}h, delivery window ${BigInt(acc) / 3600n}h\n`;
  }
  out += `- Created: ${fmtUnixSecs(task.createTime)}\n`;
  out += '\n[Current Status]\n';
  out += `- ${statusText}\n`;
  out += '\n[User Agent Info]\n';
  if (task.userAgentId !== null && task.userAgentAddress !== null) out += `- AgentID: ${task.userAgentId}\n- Communication address: ${task.userAgentAddress}\n`;
  else if (task.userAgentId !== null) out += `- AgentID: ${task.userAgentId}\n`;
  else out += '- Unknown\n';
  out += '\n[ASP Info]\n';
  if (task.providerAgentId !== null && task.providerAgentAddress !== null) out += `- AgentID: ${task.providerAgentId}\n- Communication address: ${task.providerAgentAddress}\n`;
  else if (task.providerAgentId !== null) out += `- AgentID: ${task.providerAgentId}\n`;
  else out += '- No ASP matched yet\n';
  const ref = { user: 'references/a2a/user/router.md', asp: 'references/a2a/provider/router.md', evaluator: 'references/a2a/evaluator/router.md' }[role] ?? '';
  if (ref !== '') {
    out += '[⚠️ Must Execute Immediately]\n';
    out += `The role is already bound. Read skills/okx-ai/${ref} directly; do not re-enter the A2A parent router. It contains the complete role-scoped rules.\n`;
  }
  return out;
}

// upstream: mod.rs::run_context → context text (printed with println!)
export async function runContext(jobId, role, agentId) {
  const msg = validateJobId(jobId);
  if (msg !== undefined) throw new Error(msg);
  if (!['user', 'asp', 'evaluator'].includes(role)) throw new Error('--role must be user / asp / evaluator');
  if (agentId === '') throw new Error('--agent-id is required (beta backend requires non-empty agenticId header)');
  const client = new TaskApiClient();
  let resp;
  try { resp = await client.getWithIdentity(client.taskPath(jobId), agentId); } catch (e) {
    const { displayTop } = await import('../../../wallet/api.mjs');
    throw new Error(`failed to get task detail: ${displayTop(e)}`);
  }
  let task;
  try { task = fromValue(resp, TASK_DETAIL); } catch (e) { throw new Error(`failed to parse response: ${e.message}`); }
  const profile = await fetchAgentProfile(agentId);
  return buildContext(task, role, agentId, profile);
}

// upstream: mod.rs::run (CommonCommand::Context)
export const run = (cmd) => runContext(cmd.jobId, cmd.role, cmd.agentId);
