// Write-side agent identity commands — upstream commands/agent_commerce/identity/mutations.rs:
//   agent create / update          → pre-transaction/{create,update}-agent + broadcast (+ WS push)
//   agent pre-check                → agent-list scans + agent-consent (unified registration gate)
//   agent activate / deactivate    → agent-status (+ submit-approval)
//   agent upload                   → pre-transaction/upload-picture (multipart)
//   agent feedback-submit          → pre-transaction/create-comment + broadcast
//   agent xmtp-sign                → pre-transaction/sign-msg
// Each `*Impl(args)` returns the `data` value the dispatcher prints ({"ok":true,"data":…}).
// `args` carries the clap fields under their camelCase names (undefined = option absent).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stringify } from '../../core/json.mjs';
import { context } from '../../core/errors.mjs';
import { ensureTokensRefreshed, formatApiError } from '../../wallet/auth.mjs';
import { ensureCommunicationReadyPreflight } from '../task/common/okx-a2a.mjs';
import { ioErrorText, isObj, isNum, numText, trim, asU64, parseU64 } from '../_rs.mjs';
import { XLAYER_CHAIN_INDEX, XLAYER_CHAIN_INDEX_NUM, agentCardStruct } from './models.mjs';
import {
  buildErc8004Overlay, loadAgentSigningSession, loadSessionCert, loadSigningSeed, signAndBroadcastAgentTransaction, signKeyUuid,
} from './signing.mjs';
import { openIdentitySubscription } from './socket.mjs';
import { fileName } from './_std.mjs';
import {
  buildPrecheck, collectOwnedAgents, ensureAspHasAvatar, ensureAspHasService, identityWsUrl, normalizeBcp47, normalizeRole,
  normalizeRoleCode, normalizeSingletonObject, parseAgentUnsigned, parseServiceDeltas, parseServices, parseStarsArg, requireNonEmpty,
  roleToWire, roleTokenFromValue, trimOrEmpty, validateAvatarImage, walletClient,
} from './utils.mjs';

// upstream: mutations.rs::PUSH_WAIT_TIMEOUT
export const PUSH_WAIT_TIMEOUT_MS = 30000;
// upstream: mutations.rs::MAX_UPLOAD_BYTES
export const MAX_UPLOAD_BYTES = 1024 * 1024;

const mget = (m, k) => (isObj(m) && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : undefined);
// `.map_err(format_api_error)` on an awaited call
const mapApi = (p) => p.catch((e) => { throw formatApiError(e); });

// ─── Public command entry points (upstream prints; lite returns the data) ─────

// upstream: mutations.rs::create
export const create = (args) => createImpl(args);
// upstream: mutations.rs::precheck
export const precheck = (args) => precheckImpl(args);
// upstream: mutations.rs::update — A2A readiness preflight first.
export async function update(args) { await ensureCommunicationReadyPreflight(); return updateImpl(args); }
// upstream: mutations.rs::activate — A2A readiness preflight first.
export async function activate(args) { await ensureCommunicationReadyPreflight(); return activateImpl(args); }
// upstream: mutations.rs::deactivate
export const deactivate = (args) => deactivateImpl(args);
// upstream: mutations.rs::upload
export const upload = (args) => uploadImpl(args);
// upstream: mutations.rs::feedback_submit
export const feedbackSubmit = (args) => feedbackSubmitImpl(args);
// upstream: mutations.rs::xmtp_sign
export const xmtpSign = (args) => xmtpSignImpl(args);

// ─── `agent create` ───────────────────────────────────────────────────────

// upstream: mutations.rs::create_impl
export async function createImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const signingSession = loadAgentSigningSession(null);
  const fromAddr = signingSession.addrInfo.address;
  const keyUuid = randomUUID();
  const sessionSignature = signKeyUuid(keyUuid, signingSession.signingSeed);
  const normalizedRole = normalizeRole(requireNonEmpty(args.role, '--role'));
  const profileDescription = normalizedRole === 'asp' ? requireNonEmpty(args.description, '--description') : trimOrEmpty(args.description);
  const card = {
    role: normalizedRole,
    name: requireNonEmpty(args.name, '--name'),
    profilePicture: trimOrEmpty(args.picture),
    profileDescription,
    communicationAddress: null,
    services: parseServices(args.service),
  };
  ensureAspHasService(card);
  ensureAspHasAvatar(card);
  const wireRole = roleToWire(normalizedRole);
  card.role = wireRole;
  const body = {
    chainIndex: XLAYER_CHAIN_INDEX_NUM, fromAddr, keyUuid, sessionSignature, sessionCert: signingSession.sessionCert,
    cardJson: stringify(agentCardStruct(card)),
  };
  const response = await client.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/create-agent', accessToken, body);
  const unsigned = parseAgentUnsigned(response);
  const ca = mget(unsigned.extraData, 'communicationAddress');
  const communicationAddress = typeof ca === 'string' ? ca : '';
  const overlay = buildErc8004Overlay([['communicationAddress', communicationAddress], ['role', wireRole], ['keyUuid', keyUuid]]);
  const subscription = await openIdentitySubscription(fromAddr, identityWsUrl()).catch(() => null);
  let txHash;
  try {
    txHash = await signAndBroadcastAgentTransaction(accessToken, unsigned, overlay, signingSession);
  } catch (e) {
    if (subscription) subscription.drop();
    throw e;
  }
  const push = await waitForIdentityPush(subscription, txHash);
  return assembleIdentityEnvelope(txHash, push, extractAgentIdFromPush(push));
}

// ─── `agent consent` (internal to pre-check) ──────────────────────────────

// upstream: mutations.rs::consent_impl — args {consentKey?, agreed?} → {consent, required}
export async function consentImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const fromAddr = loadAgentSigningSession(null).addrInfo.address;
  const body = { chainIndex: XLAYER_CHAIN_INDEX, fromAddr };
  if (args.consentKey !== undefined && args.consentKey !== null) body.consentKey = args.consentKey;
  if (args.agreed !== undefined && args.agreed !== null) body.agreed = args.agreed;
  const response = await mapApi(client.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/agent-consent', accessToken, body));
  const first = Array.isArray(response) && response.length ? response[0] : undefined;
  const consent = mget(first, 'consent');
  const has = consent !== undefined && consent !== null;
  return { required: has, consent: has ? consent : null };
}

// ─── `agent pre-check` ────────────────────────────────────────────────────

// upstream: mutations.rs::fetch_wallet_agents (private)
export async function fetchWalletAgents(role) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const query = [['chainIndex', XLAYER_CHAIN_INDEX]];
  if (role !== undefined && role !== null && trim(role) !== '') query.push(['role', normalizeRoleCode(role)]);
  const data = await mapApi(client.getAuthed('/priapi/v5/wallet/agentic/agent/agent-list', accessToken, query));
  return normalizeSingletonObject(data);
}

// upstream: mutations.rs::precheck_impl
export async function precheckImpl(args) {
  const roleKey = normalizeRole(requireNonEmpty(args.role, '--role'));
  const fromAddr = loadAgentSigningSession(null).addrInfo.address;
  if (args.consentKey !== undefined && args.consentKey !== null && trim(args.consentKey) !== '') {
    await consentImpl({ consentKey: args.consentKey, agreed: true });
  }
  const allAgents = await fetchWalletAgents(null);
  const hasAnyAgent = collectOwnedAgents(allAgents, fromAddr).length > 0;
  if (!hasAnyAgent) {
    const c = await consentImpl({});
    if (c.required === true) {
      return { canCreate: false, role: roleKey, reason: 'You must accept the legal terms before registering an Agent.', consent: c.consent ?? null };
    }
    return buildPrecheck(allAgents, fromAddr, roleKey);
  }
  const roleAgents = await fetchWalletAgents(roleKey);
  return buildPrecheck(roleAgents, fromAddr, roleKey);
}

// ─── `agent update` ───────────────────────────────────────────────────────

// upstream: mutations.rs::update_impl
export async function updateImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const signingSession = loadAgentSigningSession(null);
  const card = { agentId };
  const name = trimOrEmpty(args.name);
  if (name !== '') card.name = name;
  const description = trimOrEmpty(args.description);
  if (description !== '') card.profileDescription = description;
  const picture = trimOrEmpty(args.picture);
  if (picture !== '') card.image = picture;
  if (args.service !== undefined && args.service !== null) card.services = parseServiceDeltas(args.service);
  const body = { chainIndex: XLAYER_CHAIN_INDEX_NUM, sessionCert: signingSession.sessionCert, cardJson: stringify(card) };
  const response = await client.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/update-agent', accessToken, body);
  const unsigned = parseAgentUnsigned(response);
  const subscription = await openIdentitySubscription(signingSession.addrInfo.address, identityWsUrl()).catch(() => null);
  let txHash;
  try {
    txHash = await signAndBroadcastAgentTransaction(accessToken, unsigned, null, signingSession);
  } catch (e) {
    if (subscription) subscription.drop();
    throw e;
  }
  const push = await waitForIdentityPush(subscription, txHash);
  return assembleIdentityEnvelope(txHash, push, extractAgentIdFromPush(push));
}

// ─── `agent activate` / `agent deactivate` ────────────────────────────────

// upstream: mutations.rs::activate_impl
export async function activateImpl(args) {
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const info = await fetchAgentInfoById(agentId);
  if (info === null) throw new Error(`agent ${agentId} not found or not accessible`);
  if (info.role !== 'asp') {
    return { blockType: 1, reason: 'only ASP agents can be listed; user and evaluator roles are not supported.', agentRole: info.role };
  }
  const activate = normalizeSingletonObject(await agentStatusImpl(agentId, 1));
  const st = mget(activate, 'approvalStatus');
  let code = asU64(st);
  if (code === undefined && typeof st === 'string') code = parseU64(st);
  const needsApproval = code === 1 || code === 5;
  if (!needsApproval) return { activate };
  const submitApproval = await submitApprovalImpl(agentId, args.preferredLanguage);
  return { activate, submitApproval };
}

// upstream: mutations.rs::fetch_agent_info_by_id (private) → {role, name, description} | null
export async function fetchAgentInfoById(agentId) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const raw = await mapApi(client.getAuthed('/priapi/v5/wallet/agentic/agent/agent-list', accessToken, [['chainIndex', XLAYER_CHAIN_INDEX], ['agentIdList', agentId]]));
  const items = mget(normalizeSingletonObject(raw), 'list');
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const info = parseAgentInfoRow(item);
    if (info) return info;
    const rows = mget(item, 'agentList');
    if (Array.isArray(rows)) for (const row of rows) { const r = parseAgentInfoRow(row); if (r) return r; }
  }
  return null;
}

// upstream: mutations.rs::parse_agent_info_row (private)
function parseAgentInfoRow(row) {
  const r = mget(row, 'role');
  if (r === undefined) return null;
  const role = roleTokenFromValue(r);
  if (role === undefined) return null;
  const name = typeof mget(row, 'name') === 'string' ? trim(row.name) : '';
  let description = '';
  for (const k of ['description', 'profileDescription']) { if (typeof mget(row, k) === 'string') { description = trim(row[k]); break; } }
  return { role, name, description };
}

// upstream: mutations.rs::deactivate_impl
export async function deactivateImpl(args) {
  return normalizeSingletonObject(await agentStatusImpl(args.agentId, 2));
}

// upstream: mutations.rs::agent_status_impl(agent_id, status)
export async function agentStatusImpl(agentIdOpt, status) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(agentIdOpt, '--agent-id');
  return mapApi(client.postAuthed('/priapi/v5/wallet/agentic/agent-status', accessToken, { agentId, chainIndex: XLAYER_CHAIN_INDEX, status }));
}

// upstream: mutations.rs::submit_approval_impl(agent_id, preferred_language)
export async function submitApprovalImpl(agentIdOpt, preferredLanguageOpt) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(agentIdOpt, '--agent-id');
  const body = { agentId, chainIndex: XLAYER_CHAIN_INDEX };
  const lang = normalizeBcp47(preferredLanguageOpt);
  if (lang !== null) body.preferredLanguage = lang;
  return mapApi(client.postAuthed('/priapi/v5/wallet/agentic/agent/submit-approval', accessToken, body));
}

// ─── `agent upload` ───────────────────────────────────────────────────────

// upstream: mutations.rs::upload_impl
export async function uploadImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const file = requireNonEmpty(args.file, '--file');
  let bytes;
  try { bytes = readFileSync(file); } catch (e) { throw context(`failed to read file: ${file}`, new Error(ioErrorText(e))); }
  const [, mime] = validateAvatarImage(bytes);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`file size ${bytes.length} bytes exceeds the 1 MB limit — please downscale the image and retry`);
  const filename = fileName(file) ?? 'upload.bin';
  const data = await client.postAuthedMultipart('/priapi/v5/wallet/agentic/pre-transaction/upload-picture', accessToken,
    [{ name: 'file', data: bytes, filename, contentType: mime }]);
  let url;
  if (typeof mget(data, 'url') === 'string') url = data.url;
  else if (Array.isArray(data) && data.length) {
    const first = data[0];
    if (typeof mget(first, 'url') === 'string') url = first.url;
    else if (typeof first === 'string') url = first;
    else throw new Error('upload response missing url');
  } else throw new Error('upload response missing url');
  return { url };
}

// ─── `agent feedback-submit` ──────────────────────────────────────────────

// upstream: mutations.rs::feedback_submit_impl
export async function feedbackSubmitImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const agentId = requireNonEmpty(args.agentId, '--agent-id');
  const creatorId = requireNonEmpty(args.creatorId, '--creator-id');
  const score = parseStarsArg(requireNonEmpty(args.score, '--score'), '--score');
  const feedbackDesc = trimOrEmpty(args.description);
  const taskId = requireNonEmpty(args.taskId, '--task-id');
  const signingSession = loadAgentSigningSession(null);
  const comment = { agentid: agentId, value: String(score), comment: feedbackDesc };
  const body = {
    chainIndex: XLAYER_CHAIN_INDEX_NUM, sessionCert: signingSession.sessionCert, feedBackAgentId: creatorId, comment: stringify(comment), taskId,
  };
  const response = await client.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/create-comment', accessToken, body);
  const unsigned = parseAgentUnsigned(response);
  const overlay = buildErc8004Overlay([['taskId', taskId], ['feedBackAgentId', creatorId]]);
  const txHash = await signAndBroadcastAgentTransaction(accessToken, unsigned, overlay, signingSession);
  return { txHash };
}

// ─── `agent xmtp-sign` ────────────────────────────────────────────────────

// upstream: mutations.rs::xmtp_sign_impl
export async function xmtpSignImpl(args) {
  const accessToken = await ensureTokensRefreshed();
  const client = walletClient();
  const keyUuid = requireNonEmpty(args.keyUuid, '--key-uuid');
  const message = requireNonEmpty(args.message, '--message');
  const signingSeed = loadSigningSeed();
  const sessionCert = loadSessionCert();
  const sessionSignature = signKeyUuid(keyUuid, signingSeed);
  const body = { chainIndex: XLAYER_CHAIN_INDEX, sessionCert, sessionSignature, signType: 'aiagentsign', keyUuid, message };
  const data = await mapApi(client.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/sign-msg', accessToken, body));
  if (!Array.isArray(data) || !data.length) throw new Error('xmtp-sign response is empty');
  const first = data[0];
  const sig = mget(first, 'signature');
  if (typeof sig !== 'string' || sig === '') throw new Error('xmtp-sign response missing signature');
  return first;
}

// ─── Post-broadcast finalize helpers (create / update) ────────────────────

// upstream: mutations.rs::wait_for_identity_push (private) — any failure / timeout → null.
export async function waitForIdentityPush(subscription, txHash) {
  if (!subscription) return null;
  try { return await subscription.waitForMatch(txHash, PUSH_WAIT_TIMEOUT_MS); } catch { return null; }
}

// upstream: mutations.rs::assemble_identity_envelope (private) — {agent?, newAgentId, txHash}
export function assembleIdentityEnvelope(txHash, push, newAgentId) {
  const out = { txHash };
  if (push !== null && push !== undefined) out.agent = push;
  out.newAgentId = newAgentId ?? null;
  return out;
}

// upstream: mutations.rs::extract_agent_id_from_push (private)
export function extractAgentIdFromPush(push) {
  if (push === null || push === undefined) return null;
  const id = mget(push, 'agentId');
  if (typeof id === 'string' && trim(id) !== '') return trim(id);
  if (isNum(id)) return numText(id);
  return null;
}
