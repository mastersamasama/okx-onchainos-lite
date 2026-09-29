// Agent chat commands — upstream commands/agent_commerce/chat/mod.rs: encrypted attachment
// upload / download, A2A sensitive words, message eligibility, XMTP system config, heartbeat and
// wake-up notify. All JWT-authenticated through the Agentic Wallet client.
//
// `fetchHeartbeat` is also the device-registration heartbeat of the wallet login flow
// (lib/wallet/auth.mjs imports it from here).
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { context } from '../../core/errors.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { WalletApiClient, ApiCodeError } from '../../wallet/api.mjs';
import { ioErrorText, fileName } from '../../core/rs/fs.mjs';

export const HEARTBEAT_PATH = '/priapi/v5/wallet/agentic/agent-heartbeat';
export const UPLOAD_PATH = '/priapi/v1/aieco/im/attachments/xmtp/encrypted/upload';
export const DOWNLOAD_PATH = '/priapi/v1/aieco/im/attachments/xmtp/encrypted/download';
export const SENSITIVE_WORDS_PATH = '/priapi/v1/aieco/im/risk/a2a/sensitive/word/list';
export const MESSAGE_ELIGIBLE_PATH = '/priapi/v1/aieco/im/message/eligible';
export const SYSTEM_CONFIG_PATH = '/priapi/v1/aieco/im/xmtp/system-config';
export const WAKEUP_NOTIFY_PATH = '/priapi/v1/aieco/task/wakeupNotify';

// upstream: chat/mod.rs::agent_commerce_headers (private)
const agentCommerceHeaders = (agentId) => [['agenticId', agentId]];

// upstream: chat/mod.rs::wallet_client (private)
const walletClient = () => new WalletApiClient();

// upstream: chat/mod.rs::ChatCommand variants (kebab command name → handler)
export const ChatCommand = Object.freeze({
  FileUpload: 'FileUpload', FileDownload: 'FileDownload', SensitiveWords: 'SensitiveWords', MessageEligible: 'MessageEligible',
  SystemConfig: 'SystemConfig', Heartbeat: 'Heartbeat', WakeupNotify: 'WakeupNotify',
});

// upstream: chat/mod.rs::run(cmd) — cmd = {kind: ChatCommand, …fields}; returns the data value.
export async function run(cmd) {
  switch (cmd.kind) {
    case ChatCommand.FileUpload: return cmdUpload(cmd.file, cmd.agentId, cmd.jobId);
    case ChatCommand.FileDownload: return cmdDownload(cmd.fileKey, cmd.agentId, cmd.output);
    case ChatCommand.SensitiveWords: {
      const accessToken = await ensureTokensRefreshed();
      return fetchSensitiveWords(walletClient(), accessToken);
    }
    case ChatCommand.MessageEligible: {
      const accessToken = await ensureTokensRefreshed();
      return fetchMessageEligible(walletClient(), accessToken, cmd.agentId, cmd.clientAgentId, cmd.providerAgentId, cmd.jobId, cmd.groupId,
        cmd.direction, cmd.providerSecurityRate, cmd.clientCommunicationAddress, cmd.providerCommunicationAddress, cmd.isOfflineReplay);
    }
    case ChatCommand.SystemConfig: {
      const accessToken = await ensureTokensRefreshed();
      return fetchSystemConfig(walletClient(), accessToken);
    }
    case ChatCommand.Heartbeat: {
      const accessToken = await ensureTokensRefreshed();
      return fetchHeartbeat(walletClient(), accessToken, cmd.chainIndex);
    }
    case ChatCommand.WakeupNotify: {
      if (!cmd.agentIds.length) throw new Error('--agent-ids must contain at least one agent ID');
      const accessToken = await ensureTokensRefreshed();
      return fetchWakeupNotify(walletClient(), accessToken, cmd.agentIds);
    }
    default: throw new Error(`unknown chat command ${cmd.kind}`);
  }
}

// ── Upload ───────────────────────────────────────────────────────────

// upstream: chat/mod.rs::fetch_upload — multipart {file (octet-stream), jobId}, agenticId header.
export function fetchUpload(client, accessToken, fileName_, data, agentId, jobId) {
  const form = [
    { name: 'file', data: Buffer.from(data), filename: fileName_, contentType: 'application/octet-stream' },
    { name: 'jobId', value: String(jobId) },
  ];
  return client.postAuthedMultipartWithHeaders(UPLOAD_PATH, accessToken, form, agentCommerceHeaders(agentId));
}

// upstream: chat/mod.rs::cmd_upload (private)
export async function cmdUpload(filePath, agentId, jobId) {
  let st;
  try { st = statSync(filePath); } catch (e) { throw context(`file not found: ${filePath}`, new Error(ioErrorText(e))); }
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`);
  let data;
  try { data = readFileSync(filePath); } catch (e) { throw context(`failed to read file: ${filePath}`, new Error(ioErrorText(e))); }
  const name = fileName(filePath) ?? 'upload';
  const accessToken = await ensureTokensRefreshed();
  return fetchUpload(walletClient(), accessToken, name, data, agentId, jobId);
}

// ── Download ─────────────────────────────────────────────────────────

// upstream: chat/mod.rs::fetch_download → Buffer
export function fetchDownload(client, accessToken, fileKey, agentId) {
  return client.getAuthedBytesWithHeaders(DOWNLOAD_PATH, accessToken, [['fileKey', fileKey]], agentCommerceHeaders(agentId));
}

// upstream: chat/mod.rs::cmd_download (private) → {fileKey, fileSize, outputPath}
export async function cmdDownload(fileKey, agentId, outputPath) {
  const accessToken = await ensureTokensRefreshed();
  const bytes = await fetchDownload(walletClient(), accessToken, fileKey, agentId);
  try { writeFileSync(outputPath, bytes); } catch (e) { throw context(`failed to write file: ${outputPath}`, new Error(ioErrorText(e))); }
  return { fileKey, outputPath, fileSize: bytes.length };
}

// ── Sensitive Words / System Config ──────────────────────────────────

// upstream: chat/mod.rs::fetch_sensitive_words
export const fetchSensitiveWords = (client, accessToken) => client.getAuthed(SENSITIVE_WORDS_PATH, accessToken, []);

// upstream: chat/mod.rs::fetch_system_config
export const fetchSystemConfig = (client, accessToken) => client.getAuthed(SYSTEM_CONFIG_PATH, accessToken, []);

// ── Message Eligible ─────────────────────────────────────────────────

// upstream: chat/mod.rs::fetch_message_eligible — only a genuine backend verdict (HTTP 2xx with
// a non-zero business code other than 50114) becomes {eligible:false, reason}.
export async function fetchMessageEligible(client, accessToken, agentId, clientAgentId, providerAgentId, jobId, groupId, direction,
  providerSecurityRate, clientCommunicationAddress, providerCommunicationAddress, isOfflineReplay) {
  const query = [
    ['clientAgentId', clientAgentId], ['providerAgentId', providerAgentId], ['jobId', jobId], ['groupId', groupId], ['direction', direction],
    ['clientCommunicationAddress', clientCommunicationAddress], ['providerCommunicationAddress', providerCommunicationAddress],
  ];
  if (providerSecurityRate !== undefined && providerSecurityRate !== null) query.push(['providerSecurityRate', providerSecurityRate]);
  const replay = offlineReplayQueryValue(isOfflineReplay);
  if (replay !== undefined) query.push(['isOfflineReplay', replay]);
  try {
    return await client.getAuthedWithHeaders(MESSAGE_ELIGIBLE_PATH, accessToken, query, agentCommerceHeaders(agentId));
  } catch (e) {
    if (e instanceof ApiCodeError && isBusinessRejection(e)) return { eligible: false, reason: e.msg };
    throw e;
  }
}

// upstream: chat/mod.rs::offline_replay_query_value (private)
export const offlineReplayQueryValue = (v) => (v === undefined || v === null ? undefined : v ? 'true' : 'false');

// upstream: chat/mod.rs::is_business_rejection (private)
export const isBusinessRejection = (e) => e.httpStatus >= 200 && e.httpStatus < 300 && e.code !== '50114';

// ── Heartbeat ────────────────────────────────────────────────────────

// upstream: chat/mod.rs::fetch_heartbeat — body {"chainIndex": <u64>}
export function fetchHeartbeat(client, accessToken, chainIndex) {
  const n = typeof chainIndex === 'bigint' ? (Number.isSafeInteger(Number(chainIndex)) ? Number(chainIndex) : chainIndex) : Number(chainIndex);
  return client.postAuthed(HEARTBEAT_PATH, accessToken, { chainIndex: n });
}

// ── Wakeup Notify ────────────────────────────────────────────────────

// upstream: chat/mod.rs::fetch_wakeup_notify — agenticId = first id.
export function fetchWakeupNotify(client, accessToken, agentIds) {
  if (!agentIds.length) throw context('agent_ids must contain at least one agent ID');
  return client.postAuthedWithHeaders(WAKEUP_NOTIFY_PATH, accessToken, { agentIds: [...agentIds] }, agentCommerceHeaders(agentIds[0]));
}
