// OKX API client — upstream client.rs::ApiClient semantics.
// All HTTP to the OKX origin goes through here: headers, envelope unwrap,
// JWT refresh-and-retry, x402 pre-sign / 402 retry, payment notifications.
import { STATUS_CODES } from 'node:http';
import { request as transport } from './transport.mjs';
import { parse, stringify } from './json.mjs';
import { deviceId, deviceName } from './device.mjs';
import { osArch } from './audit.mjs';
import { PaymentState } from './paystate.mjs';
import { Confirming, context } from './errors.mjs';
import { UPSTREAM_VERSION, CLIENT_TYPE, BASE_URL, DEV_BASE_URL } from '../config.mjs';
import * as keyring from './keyring.mjs';
import { resolveApiKey, akHeaders } from './apikey.mjs';

let devMode = false;
export const setDevMode = (on) => { devMode = !!on; };
export const baseUrl = () => (devMode ? DEV_BASE_URL : BASE_URL);

const { os, arch } = osArch();
export const USER_AGENT = `OKX/@okx_ai/onchainos-cli/${UPSTREAM_VERSION} (${os}; ${arch})`;
const CONFIG_PATH = '/api/v6/dex/market/config';

// UTF-8 bytes as a latin1 string so Node writes the raw bytes (upstream sends device-name unencoded).
const rawUtf8 = (s) => Buffer.from(String(s), 'utf8').toString('latin1');

export function anonymousHeaders() {
  const h = { 'Content-Type': 'application/json', 'ok-client-version': UPSTREAM_VERSION, 'Ok-Access-Client-type': CLIENT_TYPE, platform: CLIENT_TYPE };
  const id = deviceId();
  if (id) h['device-id'] = id;
  h['device-name'] = rawUtf8(deviceName());
  return h;
}
export const jwtHeaders = (token) => ({ ...anonymousHeaders(), Authorization: `Bearer ${token}` });

// ── JWT helpers ─────────────────────────────────────────────────────
export function jwtExp(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return undefined;
  try {
    const v = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isInteger(v.exp) ? v.exp : undefined;
  } catch { return undefined; }
}
export const isJwtExpired = (t) => { const e = jwtExp(t); return e === undefined || Math.floor(Date.now() / 1000) >= e; };

const INVALID_TOKEN = [/code=10001\)/, /code=10008\)/, /code=53017\)/, /code=130100031\)/, /invalid access token/i, /access token invalid/i];
export const isInvalidTokenError = (e) => INVALID_TOKEN.some((re) => re.test(String(e?.message ?? e)));

// wallet_api::force_refresh_access_token and client.rs::sign_header_from_accepts are imported on
// first use: the wallet and payment modules import this one.
const forceRefreshAccessToken = async () => (await import('../wallet/api.mjs')).forceRefreshAccessToken();
const signHeaderFromAccepts = async (req) => (await import('../payment/x402-header.mjs')).signHeaderFromAccepts(req);

export class PaymentRequired extends Error {
  constructor(accepts, rawBody) {
    super(rawBody && typeof rawBody === 'object' && typeof rawBody.error === 'string' ? `HTTP 402 Payment Required: ${rawBody.error}` : 'HTTP 402 Payment Required');
    this.accepts = accepts; this.rawBody = rawBody;
  }
}

function extractMsg(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : 'unknown error';
}
export function augmentAuthErrorMsg(code, msg) {
  return code === '50114' ? `${msg}. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` : msg;
}
const codeText = (c) => (c === undefined || c === null ? 'null' : typeof c === 'string' ? c : stringify(c));

export function unwrapEnvelope(body) {
  if (Array.isArray(body)) return body;
  const code = body?.code;
  if (code === '0' || code === 0) return body.data === undefined ? null : body.data;
  const c = codeText(code);
  throw new Error(`API error (code=${c}): ${augmentAuthErrorMsg(c, extractMsg(body?.msg))}`);
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT']);
const isNetworkError = (e) => NETWORK_CODES.has(e?.code) || /timed out|timeout/i.test(e?.message ?? '');
const reason = (s) => STATUS_CODES[s] || 'Error';

export class ApiClient {
  constructor({ token = null, ak = null } = {}) {
    this.token = token;
    this.ak = token ? null : ak;   // lite extension: OKX API-key auth when no wallet JWT
    this.base = baseUrl();
    this.pay = new PaymentState();
  }

  // #[derive(Clone)]: the auth mode is copied (a refresh in one clone stays there), the x402
  // payment state (Arc<Mutex<PaymentState>>) is shared.
  clone() {
    return Object.assign(Object.create(ApiClient.prototype), this);
  }

  // ApiClient::new — keyring access_token, no expiry check.
  static sync() {
    const t = keyring.getOpt('access_token');
    return t ? new ApiClient({ token: t }) : new ApiClient({ ak: resolveApiKey() });
  }

  // ApiClient::new_async — full JWT lifecycle.
  static async create() {
    // No usable JWT → API key (lite extension, v3.3.15 semantics) → anonymous.
    const fallback = () => new ApiClient({ ak: resolveApiKey() });
    const access = keyring.getOpt('access_token');
    if (!access) return fallback();
    if (!isJwtExpired(access)) return new ApiClient({ token: access });
    const rt = keyring.getOpt('refresh_token');
    if (!rt) return fallback();
    if (isJwtExpired(rt)) {
      process.stderr.write('Session expired. Please log in again: onchainos wallet login\n');
      return fallback();
    }
    try {
      return new ApiClient({ token: await forceRefreshAccessToken() });
    } catch (e) {
      process.stderr.write(`Failed to refresh session (${e.message}). Falling back to anonymous access.\n`);
      return fallback();
    }
  }

  get isAuthed() { return !!this.token; }
  // sign = { method, url, body } — needed only for API-key HMAC signing.
  headers(extra, sign) {
    const h = this.token ? jwtHeaders(this.token) : anonymousHeaders();
    if (!this.token && this.ak && sign) {
      const origin = this.base.replace(/\/+$/, '');
      const u = new URL(sign.url);
      const requestPath = sign.url.startsWith(origin) ? sign.url.slice(origin.length) : u.pathname + u.search;
      Object.assign(h, akHeaders(this.ak, sign.method, requestPath, sign.body ?? ''));
    }
    h.accept = '*/*';
    h['user-agent'] = USER_AGENT;
    for (const [k, v] of Object.entries(extra || {})) {
      for (const existing of Object.keys(h)) if (existing.toLowerCase() === k.toLowerCase()) delete h[existing];
      h[k] = v;
    }
    return h;
  }

  url(path, query) {
    const pairs = (query || []).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => [k, String(v)]);
    const qs = new URLSearchParams(pairs).toString();
    return this.base.replace(/\/+$/, '') + path + (qs ? `?${qs}` : '');
  }

  async send(method, url, { body, headers, timeoutMs = 10000, noRetryContext } = {}) {
    try {
      return await transport({ method, url, headers, body, timeoutMs });
    } catch (e) {
      if (noRetryContext) throw context(isNetworkError(e) ? noRetryContext : 'request failed', e);
      if (isNetworkError(e)) throw context('Network unavailable — check your connection and try again', e);
      throw context('request failed', e);
    }
  }

  // ── payment config (x402) ──────────────────────────────────────────
  async ensurePaymentConfig() {
    const p = this.pay;
    if (p.configLoaded) return;
    if (p.restoreFromCache()) return;
    if (!p.anyCharging()) return;
    p.configLoaded = true;
    try {
      const u = this.url(CONFIG_PATH, []);
      const r = await this.send('GET', u, { headers: this.headers(undefined, { method: 'GET', url: u }) });
      const data = await this.handleResponse(CONFIG_PATH, r);
      p.applyConfig(data);
    } catch {
      p.configLoaded = false;
    }
  }

  async maybeSignPayment(path) {
    const p = this.pay;
    const tier = p.endpoints.get(path);
    if (!tier || p.tierState(tier) !== 'charging_confirmed' || p.accepts == null) return null;
    try { return await this.signHeader(p.accepts, path, tier); } catch { return null; }
  }

  async signHeader(accepts, path, tier) {
    return signHeaderFromAccepts({ accepts, tier, resource: this.base.replace(/\/+$/, '') + path });   // → [name, value]
  }

  // handle_response / handle_response_raw
  async handleResponse(path, r, { raw = false } = {}) {
    const p = this.pay;
    p.pendingOverQuota.clear();
    p.applyHeader(r.headers['ok-web3-openapi-pay']);
    let headerAccepts = null;
    const pr = r.headers['payment-required'];
    if (pr) { try { headerAccepts = JSON.parse(Buffer.from(pr, 'base64').toString('utf8')).accepts ?? null; } catch {} }
    if (path !== CONFIG_PATH) {
      if (!p.endpoints.size && p.anyCharging()) await this.ensurePaymentConfig();
      p.dispatchNotifications(path, headerAccepts);
    }
    if (r.status === 429) throw new Error('Rate limited — retry with backoff');
    if (r.status >= 500) throw new Error(`Server error (HTTP ${r.status})`);
    const text = r.body.toString('utf8');
    if (!text.length) {
      if (r.status === 402) throw new PaymentRequired(headerAccepts, null);
      throw new Error(`Empty response body (HTTP ${r.status}). The requested operation may not be supported for the given parameters.`);
    }
    let body;
    try { body = parse(text); } catch { throw new Error(`HTTP ${r.status} ${reason(r.status)}: ${text.trim()}`); }
    if (r.status === 402) throw new PaymentRequired(headerAccepts ?? body?.accepts ?? null, body);
    return raw ? body : unwrapEnvelope(body);
  }

  async request(method, path, { query, body, headers, raw = false, retryAuth = true } = {}) {
    await this.ensurePaymentConfig();
    const payHeader = await this.maybeSignPayment(path);
    const attempt = async (pay) => {
      const url = method === 'GET' ? this.url(path, query) : this.url(path, []);
      const payload = body === undefined ? undefined : stringify(body);
      const h = this.headers(headers, { method, url, body: payload });
      if (pay) h[pay[0]] = pay[1];
      const r = await this.send(method, url, { body: payload, headers: h });
      return this.handleResponse(path, r, { raw });
    };
    try {
      return await attempt(payHeader);
    } catch (e) {
      if (retryAuth && this.token && isInvalidTokenError(e)) {
        this.token = await forceRefreshAccessToken();
        return attempt(payHeader);
      }
      if (!(e instanceof PaymentRequired)) throw e;
      if (this.pay.consumePendingConfirmation(path)) throw new Confirming({ message: '', next: '' });
      const accepts = e.accepts ?? this.pay.accepts;
      if (accepts == null) throw new Error('HTTP 402 but no payment requirements available — response had no accepts and no cached config. Retry after /api/v6/dex/market/config becomes reachable.');
      const tier = this.pay.endpoints.get(path) ?? 'basic';
      return attempt(await this.signHeader(accepts, path, tier));
    }
  }

  get(path, query = [], headers) { return this.request('GET', path, { query, headers }); }
  post(path, body, headers) { return this.request('POST', path, { body, headers }); }
  getRaw(path, query = [], headers) { return this.request('GET', path, { query, headers, raw: true, retryAuth: false }); }
  postRaw(path, body, headers) { return this.request('POST', path, { body, headers, raw: true, retryAuth: false }); }

  // post_no_retry_with_headers (broadcast): no DoH/x402/refresh; network errors say "NOT sent".
  async postNoRetry(path, body, headers) {
    const u = this.url(path, []), payload = stringify(body);
    const r = await this.send('POST', u, {
      body: payload, headers: this.headers(headers, { method: 'POST', url: u, body: payload }),
      noRetryContext: 'Network error during broadcast — transaction was NOT sent. Safe to retry the same command.',
    });
    return this.handleResponse(path, r);
  }

  // get_with_headers_response: raw response, no envelope handling.
  async getResponse(path, query = [], headers) {
    const u = this.url(path, query);
    return this.send('GET', u, { headers: this.headers(headers, { method: 'GET', url: u }) });
  }

  async getBytes(path, query = [], headers) {
    const u = this.url(path, query);
    const r = await this.send('GET', u, { headers: this.headers(headers, { method: 'GET', url: u }), timeoutMs: 60000 });
    if (r.status >= 400) throw new Error(`download failed (HTTP ${r.status})`);
    if (String(r.headers['content-type'] || '').includes('application/json')) {
      let v;
      try { v = parse(r.body.toString('utf8')); } catch { throw new Error('failed to parse error response'); }
      if (v?.code === '0' || v?.code === 0) return Buffer.alloc(0);
      throw new Error(`download failed (code=${codeText(v?.code)}): ${typeof v?.msg === 'string' ? v.msg : 'unknown error'}`);
    }
    return r.body;
  }

  // post_multipart(_raw): parts = [{ name, value } | { name, data: Buffer, filename, contentType }]
  async postMultipart(path, parts, headers, { raw = false } = {}) {
    const boundary = '----ocl' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const chunks = [];
    for (const p of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n${p.contentType ? `Content-Type: ${p.contentType}\r\n` : ''}\r\n`));
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.value ?? p.data ?? '')));
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const h = this.headers(headers);
    delete h['Content-Type'];
    h['content-type'] = `multipart/form-data; boundary=${boundary}`;
    const r = await this.send('POST', this.url(path, []), { body: Buffer.concat(chunks), headers: h, timeoutMs: 60000 });
    if (raw) return r;
    return this.handleResponse(path, r);
  }
}

// `client.clone()`, also for test doubles without a clone method (the same shallow copy).
export const cloneClient = (client) => (typeof client?.clone === 'function' ? client.clone() : Object.assign(Object.create(Object.getPrototypeOf(client)), client));

// handle_agent_commerce_response — used by agent-commerce callers of raw responses.
export function handleAgentCommerceResponse(r) {
  const server = String(r.headers.server || '').toLowerCase();
  const isGateway = server.includes('openresty') || server.includes('nginx');
  const text = r.body.toString('utf8');
  let body = null;
  if (text.trim()) { try { body = parse(text); } catch { body = null; } }
  if (r.status >= 200 && r.status < 300 && body && (body.code === '0' || body.code === 0)) return body.data === undefined ? null : body.data;
  if (isGateway) {
    const why = { 413: 'payload too large', 429: 'rate limited', 502: 'bad gateway (backend unreachable)', 503: 'service unavailable', 504: 'gateway timeout' }[r.status] ?? 'gateway rejected request';
    throw new Error(`Gateway error (HTTP ${r.status}): ${why}`);
  }
  if (body && typeof body === 'object') {
    const detail = typeof body.detailMsg === 'string' && body.detailMsg ? ` — ${body.detailMsg}` : '';
    throw new Error(`API error (HTTP ${r.status}, backend_code=${codeText(body.code)}): ${typeof body.msg === 'string' ? body.msg : 'unknown error'}${detail}`);
  }
  if (r.status === 429) throw new Error('Rate limited — retry with backoff (HTTP 429)');
  if (r.status >= 500) throw new Error(`Server error (HTTP ${r.status})`);
  if (!text.trim()) throw new Error(`Empty response body (HTTP ${r.status})`);
  throw new Error(`HTTP ${r.status}: ${text.trim().slice(0, 500)}`);
}
