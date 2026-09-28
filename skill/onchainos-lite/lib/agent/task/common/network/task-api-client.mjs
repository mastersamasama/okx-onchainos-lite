// Task backend API client — upstream task/common/network/task_api_client.rs.
// Delegates every request to the wallet API client (JWT headers, envelope handling,
// invalid-token force-refresh retry) and adds the task identity header `agenticId`
// plus the `sessionCert` query/body injection. Every method returns the unwrapped `data`.
import { WalletApiClient, reqwestFailure } from '../../../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../../../wallet/auth.mjs';
import { loadSession } from '../../../../wallet/store.mjs';
import { jwtHeaders, baseUrl } from '../../../../core/http.mjs';
import { request as transport } from '../../../../core/transport.mjs';
import { auditLog } from '../../../../core/audit.mjs';
import { context } from '../../../../core/errors.mjs';
import { statusText } from '../../../../core/ws.mjs';
import { isObj, trim } from '../../../_rs.mjs';

// upstream: task_api_client.rs::TASK_PREFIX
export const TASK_PREFIX = '/priapi/v1/aieco/task';
const BROADCAST_PATH = '/priapi/v1/aieco/task/broadcast';

// upstream: task_api_client.rs::log_api — one audit.jsonl row per request.
function logApi(method, path, agentId, ok, elapsedMs, error, extra) {
  const args = [`path=${path}`, `agentId=${agentId}`];
  if (extra !== undefined && extra !== null) args.push(extra);
  auditLog('cli', `api/${method}`, ok, elapsedMs, args, error ?? undefined);
}

// upstream: task_api_client.rs::get_access_token
const getAccessToken = () => ensureTokensRefreshed();

// upstream: task_api_client.rs::get_session_cert → non-empty sessionCert | undefined
export function getSessionCert() {
  let s = null;
  try { s = loadSession(); } catch { return undefined; }
  return s && s.sessionCert !== '' ? s.sessionCert : undefined;
}

// upstream: task_api_client.rs::inject_session_cert — only for object bodies without the key.
export function injectSessionCert(body) {
  if (!isObj(body)) return body;
  if (Object.prototype.hasOwnProperty.call(body, 'sessionCert')) return { ...body };
  const cert = getSessionCert();
  return cert === undefined ? { ...body } : { ...body, sessionCert: cert };
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const chainText = (e) => (e?.message ?? String(e));

export class TaskApiClient {
  // upstream: TaskApiClient::new
  constructor() {
    this.baseUrl = baseUrl();
    this.wallet = new WalletApiClient(this.baseUrl);
  }

  // ─── path helpers ───
  // upstream: TaskApiClient::task_path
  taskPath(jobId) { return `${TASK_PREFIX}/${jobId}`; }
  // upstream: TaskApiClient::endpoint
  endpoint(jobId, action) { return `${TASK_PREFIX}/${jobId}/${action}`; }
  // upstream: TaskApiClient::dispute_list_path
  disputeListPath(page, pageSize) { return `${TASK_PREFIX}/dispute/my?page=${page}&pageSize=${pageSize}`; }
  // upstream: TaskApiClient::broadcast_path
  broadcastPath() { return BROADCAST_PATH; }
  // upstream: TaskApiClient::subscribe_path
  subscribePath(subId) { return `${TASK_PREFIX}/subscribe/${subId}`; }

  // upstream: TaskApiClient::fetch_subscription
  async fetchSubscription(jobId, agentId) {
    const agent = trim(agentId ?? '');
    if (agent === '') throw new Error('agenticId is required to fetch subscription detail');
    return this.getWithIdentity(this.subscribePath(jobId), agent);
  }

  async #logged(method, path, agentId, fn, extra) {
    const t0 = process.hrtime.bigint();
    try {
      const r = await fn();
      logApi(method, path, agentId, true, ms(t0), undefined, extra);
      return r;
    } catch (e) {
      logApi(method, path, agentId, false, ms(t0), chainText(e), extra);
      throw e;
    }
  }

  // upstream: TaskApiClient::get_with_agent_id — GET + JWT + agenticId, no query.
  async getWithAgentId(path, agentId) {
    const token = await getAccessToken();
    return this.#logged('get', path, agentId, () => this.wallet.getAuthedWithHeaders(path, token, [], [['agenticId', agentId]]));
  }

  // upstream: TaskApiClient::get_with_identity — GET + JWT + agenticId + `?sessionCert=`.
  async getWithIdentity(path, agentId) {
    const token = await getAccessToken();
    const cert = getSessionCert();
    const query = cert === undefined ? [] : [['sessionCert', cert]];
    return this.#logged('get', path, agentId, () => this.wallet.getAuthedWithHeaders(path, token, query, [['agenticId', agentId]]));
  }

  // upstream: TaskApiClient::get_bytes_with_identity — raw reqwest GET (no DoH / no UA), bytes out.
  async getBytesWithIdentity(path, query, agentId) {
    const token = await getAccessToken();
    const url = this.baseUrl.replace(/\/+$/, '') + path;
    // RequestBuilder::query: serde_urlencoded pairs appended to any query already in `path`.
    const qs = new URLSearchParams((query || []).map(([k, v]) => [String(k), String(v)])).toString();
    const requestUrl = qs === '' ? url : url + (url.includes('?') ? (url.endsWith('?') ? '' : '&') : '?') + qs;
    const headers = { ...jwtHeaders(token), accept: '*/*' };
    // HeaderValue::from_str: every byte must be >= 0x20 (except DEL) or TAB; sent as raw UTF-8 bytes.
    const idBytes = Buffer.from(String(agentId), 'utf8');
    if (!idBytes.some((b) => (b < 0x20 && b !== 0x09) || b === 0x7f)) headers.agenticId = idBytes.toString('latin1');
    const summary = (query || []).map(([k, v]) => `${k}=${v}`).join('&');
    const extra = summary === '' ? undefined : `query=${summary}`;
    const t0 = process.hrtime.bigint();
    let r;
    try {
      r = await transport({ method: 'GET', url: requestUrl, headers, timeoutMs: 600000 });
    } catch (e) {
      const err = context('evidence download request failed', new Error(reqwestFailure(requestUrl, e).text));
      logApi('get_bytes', path, agentId, false, ms(t0), err.message, extra);
      throw err;
    }
    if (r.status < 200 || r.status >= 300) {
      // `{status}` = http::StatusCode Display; `{url}` is the pre-query URL.
      const msg = `evidence download failed (${statusText(r.status)}): ${url}; body=${r.body.toString('utf8')}`;
      logApi('get_bytes', path, agentId, false, ms(t0), msg, extra);
      throw new Error(msg);
    }
    logApi('get_bytes', path, agentId, true, ms(t0), undefined, extra);
    return r.body;
  }

  // upstream: TaskApiClient::post_with_identity — POST JSON (+sessionCert) with retries.
  async postWithIdentity(path, body, agentId) {
    const b = injectSessionCert(body);
    const token = await getAccessToken();
    return this.#logged('post', path, agentId, () => this.wallet.postAuthedWithHeaders(path, token, b, [['agenticId', agentId]]));
  }

  // upstream: TaskApiClient::post_mutation_with_identity — exactly one attempt.
  async postMutationWithIdentity(path, body, agentId) {
    const b = injectSessionCert(body);
    const token = await getAccessToken();
    return this.#logged('post_mutation', path, agentId, () => this.wallet.postAuthedMutationNoRetryWithHeaders(path, token, b, [['agenticId', agentId]]));
  }

  // upstream: TaskApiClient::raw_post_with_identity — caller-built body + Content-Type.
  async rawPostWithIdentity(path, body, contentType, agentId) {
    const token = await getAccessToken();
    const extra = `contentType=${contentType}; contentLength=${body.length}`;
    return this.#logged('post_raw', path, agentId, () => this.wallet.postAuthedRawWithHeaders(path, token, body, contentType, [['agenticId', agentId]]), extra);
  }
}
