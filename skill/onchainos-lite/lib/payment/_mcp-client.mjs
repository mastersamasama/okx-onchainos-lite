// PRIVATE fallback for upstream cli/src/mcp_client.rs (mirror path lib/core/mcp-client.mjs is
// not implemented yet — requested for promotion). Payment MCP client: JSON-RPC 2.0 over
// Streamable HTTP / SSE against a user-supplied A2MCP endpoint; its own HTTP client (never the
// OKX ApiClient). Transport failures surface as `endpoint_unreachable: …` errors.
import { stringify } from '../core/json.mjs';
import { trim, trimStart, asciiLower } from '../core/_rust-str.mjs';
import { UPSTREAM_VERSION } from '../config.mjs';
import { fromStr as serdeFromStr } from '../wallet/_serde-json.mjs';
import { send, headerStr, text as respText } from './_http.mjs';
import { get, isObj, isNum } from './_rs.mjs';

// upstream: mcp_client.rs::MCP_PROTOCOL_VERSION
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const TOKEN_ENDPOINT_UNREACHABLE = 'endpoint_unreachable';
const MCP_TIMEOUT_MS = 30000;
const MAX_ERROR_BODY_CHARS = 500;

const unreachable = (e) => new Error(`${TOKEN_ENDPOINT_UNREACHABLE}: ${e?.message ?? e}`);
const hasKey = (v, k) => isObj(v) && Object.prototype.hasOwnProperty.call(v, k);

// upstream: mcp_client.rs::McpTool (serde: every field defaulted; unknown fields ignored) —
// null when the entry does not deserialize (the caller skips it).
export function decodeMcpTool(v) {
  let name = '', description, inputSchema;
  if (Array.isArray(v)) {
    if (v.length > 3) return null;
    [name = '', description, inputSchema] = v;
  } else if (isObj(v)) {
    name = v.name === undefined ? '' : v.name;
    description = v.description;
    inputSchema = v.inputSchema;
  } else return null;
  if (typeof name !== 'string') return null;
  if (description !== undefined && description !== null && typeof description !== 'string') return null;
  return { name, description: description ?? undefined, inputSchema: inputSchema ?? undefined };
}

// upstream: mcp_client.rs::url_looks_like_mcp
export function urlLooksLikeMcp(url) {
  const lower = asciiLower(url);
  const i = lower.indexOf('://');
  const afterScheme = i >= 0 ? lower.slice(i + 3) : lower;
  const path = afterScheme.split(/[?#]/)[0].replace(/\/+$/, '');
  return path.endsWith('/mcp') || path.endsWith('/sse');
}

// upstream: mcp_client.rs::probe_signals_mcp
export function probeSignalsMcp(contentType, body) {
  if (asciiLower(contentType).includes('text/event-stream')) return true;
  const t = trimStart(body);
  if (t.startsWith('{') || t.startsWith('data:')) return t.includes('"jsonrpc"');
  return false;
}

// upstream: mcp_client.rs::coerce_arguments — CLI strings → the tool's declared JSON types.
export function coerceArguments(params, inputSchema) {
  const out = {};
  for (const k of Object.keys(params ?? {}).sort()) {
    const v = params[k];
    if (typeof v !== 'string') { out[k] = v; continue; }
    const ty = get(get(get(inputSchema, 'properties'), k), 'type');
    out[k] = coerceOne(v, typeof ty === 'string' ? ty : undefined);
  }
  return out;
}

// upstream: mcp_client.rs::coerce_one (private)
export function coerceOne(raw, ty) {
  const parsed = () => { try { return { v: serdeFromStr(raw) }; } catch { return null; } };
  if (ty === 'integer' || ty === 'number') { const p = parsed(); return p && isNum(p.v) ? p.v : raw; }
  if (ty === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (ty === 'object' || ty === 'array') { const p = parsed(); return p ? p.v : raw; }
  return raw;
}

// upstream: mcp_client.rs::parse_streamable_body — plain JSON or the first SSE `data:` envelope.
export function parseStreamableBody(body) {
  const t = trimStart(body);
  if (t.startsWith('{')) {
    try { const v = serdeFromStr(t); if (hasKey(v, 'result') || hasKey(v, 'error')) return v; } catch {}
  }
  for (let line of String(body).split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const l = trim(line);
    if (!l.startsWith('data:')) continue;
    const data = trim(l.slice(5));
    if (data === '') continue;
    let v;
    try { v = serdeFromStr(data); } catch { continue; }
    if (hasKey(v, 'result') || hasKey(v, 'error')) return v;
  }
  throw new Error(`${TOKEN_ENDPOINT_UNREACHABLE}: no JSON-RPC result/error in MCP response`);
}

// upstream: mcp_client.rs::jsonrpc_result
export function jsonrpcResult(envelope) {
  if (hasKey(envelope, 'error')) {
    const err = envelope.error;
    const m = get(err, 'message');
    const msg = typeof m === 'string' ? m : 'unknown JSON-RPC error';
    const c = get(err, 'code');
    const code = typeof c === 'number' && Number.isInteger(c) ? c
      : typeof c === 'bigint' && c >= -9223372036854775808n && c <= 9223372036854775807n ? c : undefined;
    throw new Error(code !== undefined ? `${TOKEN_ENDPOINT_UNREACHABLE}: JSON-RPC error ${code}: ${msg}` : `${TOKEN_ENDPOINT_UNREACHABLE}: JSON-RPC error: ${msg}`);
  }
  if (!hasKey(envelope, 'result')) throw new Error(`${TOKEN_ENDPOINT_UNREACHABLE}: JSON-RPC response missing result`);
  return envelope.result;
}

// upstream: mcp_client.rs::http_error (private)
export function httpError(stage, status, body) {
  const trimmed = trim(body);
  const chars = [...trimmed];
  const truncated = chars.slice(0, MAX_ERROR_BODY_CHARS).join('');
  const suffix = truncated === '' ? '' : chars.length > MAX_ERROR_BODY_CHARS ? `: ${truncated}…` : `: ${truncated}`;
  return new Error(`${TOKEN_ENDPOINT_UNREACHABLE}: ${stage} returned HTTP ${status}${suffix}`);
}

const reqHeaders = () => [['content-type', 'application/json'], ['accept', 'application/json, text/event-stream']];

// upstream: mcp_client.rs::McpClient
export class McpClient {
  constructor(url) { this.url = String(url); this.sessionId = null; }

  captureSessionId(resp) {
    const sid = headerStr(resp, 'Mcp-Session-Id');
    if (sid !== undefined) this.sessionId = sid;
  }

  // upstream: McpClient::send_rpc — id null → notification.
  async sendRpc(id, method, params) {
    const body = { jsonrpc: '2.0', method };
    if (id != null) body.id = id;
    if (params !== null && params !== undefined) body.params = params;
    const headers = reqHeaders();
    if (this.sessionId != null) headers.push(['mcp-session-id', this.sessionId]);
    try {
      return await send({ method: 'POST', url: this.url, headers, body: stringify(body), timeoutMs: MCP_TIMEOUT_MS });
    } catch (e) { throw unreachable(e); }
  }

  // upstream: McpClient::initialize — initialize (id 1) + notifications/initialized.
  async initialize() {
    const params = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'onchainos', version: UPSTREAM_VERSION } };
    const resp = await this.sendRpc(1, 'initialize', params);
    this.captureSessionId(resp);
    const body = respText(resp);
    if (resp.status < 200 || resp.status > 299) throw httpError('initialize', resp.status, body);
    jsonrpcResult(parseStreamableBody(body));
    try { await this.sendRpc(null, 'notifications/initialized', null); } catch {}
  }

  // upstream: McpClient::list_tools (id 2)
  async listTools() {
    const resp = await this.sendRpc(2, 'tools/list', {});
    this.captureSessionId(resp);
    const body = respText(resp);
    if (resp.status < 200 || resp.status > 299) throw httpError('tools/list', resp.status, body);
    const result = jsonrpcResult(parseStreamableBody(body));
    const entries = get(result, 'tools');
    return (Array.isArray(entries) ? entries : []).map(decodeMcpTool).filter(Boolean);
  }

  // upstream: McpClient::call_tool (id 3) → {kind:'Free', result} | {kind:'Paid', header, body}
  async callTool(tool, args) {
    const resp = await this.sendRpc(3, 'tools/call', { name: tool, arguments: args });
    this.captureSessionId(resp);
    const hname = resp.headers['payment-required'] !== undefined ? 'PAYMENT-REQUIRED' : 'WWW-Authenticate';
    const header = headerStr(resp, hname);
    const body = respText(resp);
    if (resp.status === 402) return { kind: 'Paid', header: header ?? body, body };
    if (resp.status < 200 || resp.status > 299) throw httpError('tools/call', resp.status, body);
    return { kind: 'Free', result: jsonrpcResult(parseStreamableBody(body)) };
  }

  // upstream: McpClient::call_tool_signed (id 4) → [status, PAYMENT-RESPONSE | null, result]
  async callToolSigned(replay, headerName, paymentSignature) {
    if (replay.sessionId != null) this.sessionId = replay.sessionId;
    const body = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: replay.tool, arguments: replay.arguments } };
    const headers = [...reqHeaders(), [headerName, paymentSignature]];
    if (this.sessionId != null) headers.push(['mcp-session-id', this.sessionId]);
    let resp;
    try { resp = await send({ method: 'POST', url: this.url, headers, body: stringify(body), timeoutMs: MCP_TIMEOUT_MS }); } catch (e) { throw unreachable(e); }
    this.captureSessionId(resp);
    const paymentResponse = headerStr(resp, 'PAYMENT-RESPONSE') ?? null;
    const raw = respText(resp);
    let result;
    try { result = jsonrpcResult(parseStreamableBody(raw)); } catch {
      try { result = serdeFromStr(raw); } catch { result = raw; }
    }
    return [resp.status, paymentResponse, result];
  }
}
