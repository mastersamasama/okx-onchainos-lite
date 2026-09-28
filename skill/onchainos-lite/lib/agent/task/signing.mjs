// Task sign-and-broadcast helpers — upstream task/signing.rs. Every broadcast here is
// FUND-MOVING (`POST /priapi/v1/aieco/task/broadcast`); the parity proxy never forwards it.
import { loadWallets, loadSession } from '../../wallet/store.mjs';
import { decodeUnsignedInfoResponse, SerdeError, displayTop } from '../../wallet/api.mjs';
import { get as keyringGet } from '../../core/keyring.mjs';
import { auditLog } from '../../core/audit.mjs';
import { context } from '../../core/errors.mjs';
import { isObj, get, at, asStr, asI64, nowSecs, trim, eqIgnoreAsciiCase } from '../_rs.mjs';
import { fetchAgentById, fetchMyAgents, AGENT_ROLE_USER, XLAYER_CHAIN_INDEX, XLAYER_CHAIN_NAME } from './common/index.mjs';

const NOT_LOGGED_IN = 'not logged in; run `onchainos wallet auth` first';

// upstream: signing.rs::BroadcastResult { apiResponse, txHash }
export const broadcastResult = (apiResponse, txHash) => ({ apiResponse, txHash });

// upstream: signing.rs::extract_biz_type
export const extractBizType = (resp) => asI64(at(resp, 'type')) ?? 0;

// upstream: signing.rs::resolve_wallet → [accountId, address]
export async function resolveWallet(accountId, address) {
  const wallets = loadWallets();
  if (!wallets) throw new Error(NOT_LOGGED_IN);
  const { resolveAddress } = await import('../../wallet/transfer/index.mjs');
  const [resolvedAcct, info] = resolveAddress(wallets, address ?? undefined, XLAYER_CHAIN_NAME);
  return [accountId ?? resolvedAcct, info.address];
}

// upstream: signing.rs::resolve_wallet_by_agent_id → [accountId, address]
export async function resolveWalletByAgentId(agentId) {
  const id = trim(agentId ?? '');
  if (id === '') throw new Error("agent_id must not be empty; pass the provider's own agentId");
  const agent = await fetchAgentById(id);
  const wallet = asStr(get(agent, 'agentWalletAddress')) ?? '';
  if (wallet === '') throw new Error(`cannot resolve wallet for agentId=${id}; agentWalletAddress not found in \`onchainos agent get-agents\``);
  return resolveWallet(undefined, wallet);
}

// upstream: signing.rs::resolve_wallet_and_agent_for_task → [accountId, address, userAgentId]
export async function resolveWalletAndAgentForTask(client, jobId, explicitAgentId) {
  let localAgentId;
  if (explicitAgentId !== undefined && explicitAgentId !== null) localAgentId = explicitAgentId;
  else { try { [localAgentId] = await resolveAgentByRole(AGENT_ROLE_USER, 'user', undefined); } catch { localAgentId = ''; } }
  const resp = await client.getWithIdentity(client.taskPath(jobId), localAgentId);
  const userAddress = asStr(at(resp, 'buyerAgentAddress'));
  if (userAddress === undefined) throw new Error('task detail missing buyerAgentAddress field');
  const userAgentId = asStr(at(resp, 'buyerAgentId')) ?? '';
  const [accountId, address] = await resolveWallet(undefined, userAddress);
  return [accountId, address, userAgentId];
}

// upstream: signing.rs::resolve_agent_by_role (private) → [agentId, ownerAddress]
async function resolveAgentByRole(roleCode, roleLabel, walletAddress) {
  for (const agent of await fetchMyAgents()) {
    if (asI64(at(agent, 'role')) !== roleCode) continue;
    const owner = asStr(at(agent, 'ownerAddress')) ?? '';
    if (walletAddress !== undefined && walletAddress !== null && !eqIgnoreAsciiCase(owner, walletAddress)) continue;
    const id = asStr(at(agent, 'agentId'));
    if (id === undefined) throw new Error('Agent missing agentId field');
    return [id, owner];
  }
  if (walletAddress !== undefined && walletAddress !== null) throw new Error(`current wallet has no ${roleLabel} identity (ownerAddress mismatch); switch wallet or register first`);
  throw new Error(`current account has no ${roleLabel} identity; register first`);
}

// upstream: signing.rs::resolve_wallet_and_agent_for_evaluator → [accountId, address, agentId]
export async function resolveWalletAndAgentForEvaluator(agentId) {
  const id = trim(agentId ?? '');
  if (id === '') throw new Error('agent_id must not be empty (envelope top-level agentId required)');
  const owner = asStr(get(await fetchAgentById(id), 'agentWalletAddress')) ?? '';
  if (owner === '') {
    auditLog('cli', 'evaluator/wallet_resolve_failed', false, 0, [`agentId=${id}`, 'reason=missing_agent_wallet_address'], 'fetch_agent_by_id returned no agentWalletAddress');
    throw new Error(`cannot get wallet address for agentId=${id}; verify the agentId exists in \`onchainos agent get-my-agents\``);
  }
  try {
    const [accountId, address] = await resolveWallet(undefined, owner);
    return [accountId, address, id];
  } catch (e) {
    const msg = displayTop(e);
    auditLog('cli', 'evaluator/wallet_resolve_failed', false, 0, [`agentId=${id}`, `ownerAddress=${owner}`, 'reason=wallet_not_in_local_store'], msg);
    throw new Error(`agentId=${id} wallet ${owner} not found locally (${msg})`);
  }
}

// upstream: signing.rs::resolve_agent_id_by_role → agentId | "" (never throws)
export async function resolveAgentIdByRole(roleCode) {
  const label = { 1: 'user', 2: 'asp', 3: 'evaluator' }[roleCode] ?? 'unknown';
  try { const [id] = await resolveAgentByRole(roleCode, label, undefined); return id; } catch { return ''; }
}

// upstream: signing.rs::merge_biz_context (json! → sorted)
export function mergeBizContext(jobId, bizType, extra) {
  const ctx = { jobId, bizType };
  if (isObj(extra)) for (const k of Object.keys(extra)) ctx[k] = extra[k];
  return ctx;
}

// uopData → UnsignedInfoResponse + backend preflight guard (shared by the three variants).
function decodeUop(uopData) {
  if (uopData === undefined || uopData === null) throw new Error('backend did not return uopData; cannot sign and broadcast');
  let unsigned;
  try { unsigned = decodeUnsignedInfoResponse(uopData); } catch (e) {
    if (e instanceof SerdeError) throw new Error(`failed to parse uopData: ${e.message}`);
    throw e;
  }
  const execOk = typeof unsigned.executeResult === 'boolean' ? unsigned.executeResult : true;
  if (!execOk) throw new Error(`backend transaction preflight failed: ${unsigned.executeErrorMsg === '' ? 'no error detail returned' : unsigned.executeErrorMsg}`);
  return unsigned;
}
async function broadcastBody(unsigned, accountId, address) {
  const { buildBroadcastBody } = await import('../../wallet/transfer/index.mjs');
  return buildBroadcastBody(unsigned, accountId, address, XLAYER_CHAIN_INDEX, true, false, false);
}

// upstream: signing.rs::sign_uop_and_broadcast_full → data[0] | null
export async function signUopAndBroadcastFull(client, uopData, accountId, address, jobId, bizType, agentId, bizContextExtra) {
  const unsigned = decodeUop(uopData);
  const body = await broadcastBody(unsigned, accountId, address);
  body.bizContext = mergeBizContext(jobId, bizType, bizContextExtra);
  let resp;
  try { resp = await client.postMutationWithIdentity(client.broadcastPath(), body, agentId); } catch (e) { throw context('broadcast failed', e); }
  return get(resp, 0) ?? null;
}

// upstream: signing.rs::sign_uop_and_broadcast → txHash | "pending"
export async function signUopAndBroadcast(client, uopData, accountId, address, jobId, bizType, agentId, bizContextExtra) {
  const first = await signUopAndBroadcastFull(client, uopData, accountId, address, jobId, bizType, agentId, bizContextExtra);
  return asStr(at(first, 'txHash')) ?? 'pending';
}

// upstream: signing.rs::sign_uop_and_broadcast_with_commit_meta → txHash | "pending"
export async function signUopAndBroadcastWithCommitMeta(client, uopData, accountId, address, jobId, bizType, agentId, commitSalt, vote, voteReport, voteReportSummary) {
  const unsigned = decodeUop(uopData);
  const body = await broadcastBody(unsigned, accountId, address);
  body.bizContext = { jobId, bizType, commitSalt, vote: Number(vote), voteReport, voteReportSummary };
  let resp;
  try { resp = await client.postMutationWithIdentity(client.broadcastPath(), body, agentId); } catch (e) { throw new Error(`broadcast failed: ${displayTop(e)}`); }
  return asStr(at(at(resp, 0), 'txHash')) ?? 'pending';
}

// upstream: signing.rs::sign_uop_and_broadcast_with_payment → txHash | "pending"
export async function signUopAndBroadcastWithPayment(client, uopData, accountId, address, jobId, bizType, agentId, paymentVerify) {
  const unsigned = decodeUop(uopData);
  const body = await broadcastBody(unsigned, accountId, address);
  body.bizContext = { jobId, bizType, paymentVerify };
  let resp;
  try { resp = await client.postMutationWithIdentity(client.broadcastPath(), body, agentId); } catch (e) { throw new Error(`broadcast failed: ${displayTop(e)}`); }
  return asStr(at(at(resp, 0), 'txHash')) ?? 'pending';
}

// upstream: signing.rs::sign_digest_with_session_key → signature (crypto.rs::ed25519_sign_hex)
export async function signDigestWithSessionKey(digest) {
  const session = loadSession();
  if (!session) throw new Error(NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyringGet('session_key'); } catch { throw new Error(NOT_LOGGED_IN); }
  if (sessionKey === undefined || sessionKey === null) throw new Error(NOT_LOGGED_IN);
  const { hpkeDecryptSessionSk, ed25519SignHex } = await import('../../wallet/shared/_crypto.mjs');
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  return ed25519SignHex(digest, Buffer.from(seed).toString('base64'));
}

// upstream: signing.rs::sign_typed_data → ECDSA signature hex (wallet eip712_sign_raw)
export async function signTypedData(typedData, fromAddress) {
  const { eip712SignRaw } = await import('../../wallet/sign.mjs');
  return eip712SignRaw(typedData, XLAYER_CHAIN_INDEX, fromAddress);
}

// upstream: signing.rs::task_dual_sign_and_broadcast → { apiResponse, txHash }
export async function taskDualSignAndBroadcast(client, jobId, preAction, mainAction, extraMainFields, accountId, address, agentId, bizContextExtra) {
  const deadline = nowSecs() + 1800;
  let preResp;
  try { preResp = await client.postWithIdentity(client.endpoint(jobId, preAction), { deadline }, agentId); } catch (e) { throw new Error(`${preAction} request failed: ${displayTop(e)}`); }
  const typedData = at(preResp, 'typedData');
  if (typedData === null) throw new Error(`${preAction} did not return typedData`);
  const nonce = asStr(at(preResp, 'nonce')) ?? '';
  const signature = await signTypedData(typedData, address);
  const mainBody = { signatureData: { signature, deadline, nonce } };
  if (isObj(extraMainFields)) for (const k of Object.keys(extraMainFields)) mainBody[k] = extraMainFields[k];
  let mainResp;
  try { mainResp = await client.postWithIdentity(client.endpoint(jobId, mainAction), mainBody, agentId); } catch (e) { throw new Error(`${mainAction} request failed: ${displayTop(e)}`); }
  const txHash = await signUopAndBroadcast(client, at(mainResp, 'uopData'), accountId, address, jobId, extractBizType(mainResp), agentId, bizContextExtra);
  return broadcastResult(mainResp, txHash);
}
