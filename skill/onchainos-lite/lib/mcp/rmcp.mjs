// The parts of the rmcp 1.3.0 crate (stdio server) that `onchainos mcp` exposes, reproduced
// byte-for-byte: newline-delimited JSON-RPC framing (transport/async_rw.rs JsonRpcMessageCodec
// driven by tokio-util 0.7.18 FramedRead, incl. its decode_eof quirk after ignored lines),
// message classification (model.rs JsonRpcMessage / ClientRequest / ClientNotification /
// ClientResult untagged unions, with the typed params structs they try first), the
// initialize handshake (service/server.rs serve_server_with_ct_inner), the request loop and
// its stdin-EOF drain (service.rs serve_inner) and the ServerHandler defaults
// (handler/server.rs). The tool router (tools/list, tools/call) is supplied by lib/mcp/index.mjs.
//
// Serialisation: every rmcp message is a struct → field order is declaration order;
// JSON-RPC ids are echoed as received (i64 or string).
import { parse as parseJson, stringify, struct } from '../core/json.mjs';
import { strDebug } from '../core/rs/str.mjs';
import { debugValue, debugMap, debugOpt, debugF64, isObject, isJsonNumber, toF64, sortedKeys } from './serde.mjs';

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
const DRAIN_TIMEOUT_MS = 5000;   // serve_inner: QuitReason::Closed drain timeout

// ErrorCode constants (model.rs)
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

// ErrorData — returned by handlers as a JSON-RPC error response.
export class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Handshake failure (ServerInitializeError Display) — `mcp::serve` returns it as Err.
export class InitializeError extends Error {}

// ── framing ─────────────────────────────────────────────────────────
const utf8 = new TextDecoder('utf-8', { fatal: true });
const withoutCr = (b) => (b.length && b[b.length - 1] === 0x0d ? b.subarray(0, b.length - 1) : b);
const NONE = Symbol('none');

// tokio-util FramedRead (codec/framed_impl.rs poll_next) driving JsonRpcMessageCodec
// (transport/async_rw.rs). `next()` → the next message, or null once the stream has ended
// (EOF or codec error; rmcp's receive() maps both to None).
//   decode:     one "\n"-terminated line (one trailing "\r" stripped) → parsed message; an
//               ignorable notification yields Ok(None), exactly like "no complete line yet".
//   poll_next:  decode → None ⇒ read more; a read of 0 bytes sets `eof`, after which every
//               frame goes through decode_eof.
//   decode_eof: decode first; on None the whole remaining buffer (not just one line) is parsed
//               as a single frame unless it is empty or a lone "\r"; None ends the stream.
// So an ignorable line hit after EOF swallows everything behind it, as upstream does.
function framedRead(input) {
  let buf = Buffer.alloc(0);
  const arrived = [];
  let ended = false;
  let wake = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  input.on('data', (c) => { arrived.push(Buffer.from(c)); notify(); });
  input.on('end', () => { ended = true; notify(); });
  input.on('error', () => { ended = true; notify(); });
  input.resume?.();

  // try_parse_with_compatibility: message | NONE (ignored notification) | null (codec error)
  const parse = (line) => { const m = parseMessage(line); return m === 'ignore' ? NONE : m; };
  const decode = () => {
    const i = buf.indexOf(0x0a);
    if (i < 0) return NONE;
    const line = withoutCr(buf.subarray(0, i));
    buf = buf.subarray(i + 1);
    return parse(line);
  };
  const decodeEof = () => {
    const f = decode();
    if (f !== NONE) return f;
    if (!buf.length || (buf.length === 1 && buf[0] === 0x0d)) return NONE;
    const rest = withoutCr(buf);
    buf = Buffer.alloc(0);
    return parse(rest);
  };

  let eof = false;
  let readable = false;
  let finished = false;
  return async function next() {
    while (!finished) {
      if (readable) {
        const f = eof ? decodeEof() : decode();
        if (f === null || (f === NONE && eof)) break;
        if (f !== NONE) return f;
        readable = false;
      }
      // poll_read_buf: whatever has arrived since the last read, else wait; 0 bytes = EOF.
      while (!arrived.length && !ended) await new Promise((r) => { wake = r; });
      if (arrived.length) {
        buf = Buffer.concat([buf, ...arrived.splice(0)]);
        eof = false;
      } else if (eof) {
        break;
      } else {
        eof = true;
      }
      readable = true;
    }
    finished = true;
    return null;
  };
}

// ── message classification ──────────────────────────────────────────
const STANDARD_REQUESTS = new Set([
  'initialize', 'ping', 'prompts/get', 'prompts/list', 'resources/list', 'resources/read', 'resources/subscribe',
  'resources/unsubscribe', 'resources/templates/list', 'tools/call', 'tools/list', 'completion/complete',
  'logging/setLevel', 'roots/list', 'sampling/createMessage',
]);
const STANDARD_NOTIFICATIONS = new Set([
  'notifications/cancelled', 'notifications/initialized', 'notifications/message', 'notifications/progress',
  'notifications/prompts/list_changed', 'notifications/resources/list_changed', 'notifications/resources/updated',
  'notifications/roots/list_changed', 'notifications/tools/list_changed',
]);
const isStandardMethod = (m) => STANDARD_REQUESTS.has(m) || STANDARD_NOTIFICATIONS.has(m);

// async_rw.rs::should_ignore_notification — consulted only when a line fails to parse.
function shouldIgnore(v, method) {
  const isNotification = !(isObject(v) && Object.prototype.hasOwnProperty.call(v, 'id'));
  if (isNotification && !isStandardMethod(method)) return true;
  return method.startsWith('notifications/') && !STANDARD_NOTIFICATIONS.has(method);
}

const I64_MAX = 9223372036854775807n;
// NumberOrString::deserialize
function requestId(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v <= I64_MAX ? v : undefined;
  return undefined;
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const optString = (o, k) => !has(o, k) || o[k] === null || typeof o[k] === 'string';
const optObject = (o, k) => !has(o, k) || o[k] === null || isObject(o[k]);
// WithMeta<P>: params must be a JSON object; `_meta` (Option<Meta>) an object or null.
const withMeta = (p) => isObject(p) && optObject(p, '_meta');

const LOGGING_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
const PAGINATED = { 'prompts/list': 'ListPromptsRequest', 'resources/list': 'ListResourcesRequest', 'resources/templates/list': 'ListResourceTemplatesRequest', 'tools/list': 'ListToolsRequest', 'tasks/list': 'ListTasksRequest' };

// ── serde-derived structs of InitializeRequestParams (model.rs, model/capabilities.rs) ──
// A tiny type table drives both "does it deserialize" and the derived `{:?}`. Struct fields
// are all Option<…> (absent / null → None) unless marked required; no deny_unknown_fields.
const T = {
  str: { ok: (v) => typeof v === 'string', dbg: strDebug },
  bool: { ok: (v) => typeof v === 'boolean', dbg: String },
  object: { ok: isObject, dbg: debugMap },                                  // JsonObject
  mapOfObject: {                                                            // BTreeMap<String, JsonObject>
    ok: (v) => isObject(v) && Object.values(v).every(isObject),
    dbg: (v) => `{${sortedKeys(v).map((k) => `${strDebug(k)}: ${debugMap(v[k])}`).join(', ')}}`,
  },
  vec: (t) => ({ ok: (v) => Array.isArray(v) && v.every(t.ok), dbg: (v) => `[${v.map(t.dbg).join(', ')}]` }),
  enumOf: (variants) => ({ ok: (v) => typeof v === 'string' && has(variants, v), dbg: (v) => variants[v] }),
  // fields: [rust name, json name, type, required?]
  struct: (name, fields) => ({
    ok: (v) => isObject(v) && fields.every(([, j, t, req]) => (req ? has(v, j) && t.ok(v[j]) : !has(v, j) || v[j] === null || t.ok(v[j]))),
    dbg: (v) => (fields.length
      ? `${name} { ${fields.map(([r, j, t, req]) => `${r}: ${req ? t.dbg(v[j]) : debugOpt(has(v, j) ? v[j] : null, t.dbg)}`).join(', ')} }`
      : name),
  }),
};
const ICON = T.struct('Icon', [['src', 'src', T.str, true], ['mime_type', 'mimeType', T.str], ['sizes', 'sizes', T.vec(T.str)],
  ['theme', 'theme', T.enumOf({ light: 'Light', dark: 'Dark' })]]);
const IMPLEMENTATION = T.struct('Implementation', [['name', 'name', T.str, true], ['title', 'title', T.str], ['version', 'version', T.str, true],
  ['description', 'description', T.str], ['icons', 'icons', T.vec(ICON)], ['website_url', 'websiteUrl', T.str]]);
const CLIENT_CAPABILITIES = T.struct('ClientCapabilities', [
  ['experimental', 'experimental', T.mapOfObject],
  ['extensions', 'extensions', T.mapOfObject],
  ['roots', 'roots', T.struct('RootsCapabilities', [['list_changed', 'listChanged', T.bool]])],
  ['sampling', 'sampling', T.struct('SamplingCapability', [['tools', 'tools', T.object], ['context', 'context', T.object]])],
  ['elicitation', 'elicitation', T.struct('ElicitationCapability', [
    ['form', 'form', T.struct('FormElicitationCapability', [['schema_validation', 'schemaValidation', T.bool]])],
    ['url', 'url', T.struct('UrlElicitationCapability', [])]])],
  ['tasks', 'tasks', T.struct('TasksCapability', [
    ['requests', 'requests', T.struct('TaskRequestsCapability', [
      ['sampling', 'sampling', T.struct('SamplingTaskCapability', [['create_message', 'createMessage', T.object]])],
      ['elicitation', 'elicitation', T.struct('ElicitationTaskCapability', [['create', 'create', T.object]])],
      ['tools', 'tools', T.struct('ToolsTaskCapability', [['call', 'call', T.object]])]])],
    ['list', 'list', T.object], ['cancel', 'cancel', T.object]])],
]);
// Reference (#[serde(tag = "type")]): PromptReference { name, title? } | ResourceReference { uri }
function reference(r) {
  if (!isObject(r)) return false;
  if (r.type === 'ref/prompt') return typeof r.name === 'string' && optString(r, 'title');
  if (r.type === 'ref/resource') return typeof r.uri === 'string';
  return false;
}
// Option<CompletionContext { arguments: Option<HashMap<String, String>> }>
function completionContext(o, k) {
  if (!has(o, k) || o[k] === null) return true;
  const c = o[k];
  if (!isObject(c)) return false;
  return !has(c, 'arguments') || c.arguments === null
    || (isObject(c.arguments) && Object.values(c.arguments).every((v) => typeof v === 'string'));
}

// Request<M, P> variants whose params struct is `{ _meta?, <one String field> }`:
// method → [ClientRequest variant, method const type, params struct, JSON field, Rust field]
const SINGLE_FIELD_REQUESTS = {
  'resources/read': ['ReadResourceRequest', 'ReadResourceRequestMethod', 'ReadResourceRequestParams', 'uri', 'uri'],
  'resources/subscribe': ['SubscribeRequest', 'SubscribeRequestMethod', 'SubscribeRequestParams', 'uri', 'uri'],
  'resources/unsubscribe': ['UnsubscribeRequest', 'UnsubscribeRequestMethod', 'UnsubscribeRequestParams', 'uri', 'uri'],
  'tasks/get': ['GetTaskInfoRequest', 'GetTaskInfoMethod', 'GetTaskInfoParams', 'taskId', 'task_id'],
  'tasks/result': ['GetTaskResultRequest', 'GetTaskResultMethod', 'GetTaskResultParams', 'taskId', 'task_id'],
  'tasks/cancel': ['CancelTaskRequest', 'CancelTaskMethod', 'CancelTaskParams', 'taskId', 'task_id'],
};

// ClientRequest (untagged): the typed variant for `method` when its params deserialize, else
// CustomRequest (params: absent / null / object), else undefined (the Request variant fails).
// Every result carries `method` (the typed handlers' method-not-found message).
function classifyRequest(method, hasParams, params) {
  const p = hasParams ? params : undefined;
  const present = hasParams && params !== null;
  let type;
  switch (method) {
    case 'ping': return { type: 'PingRequest', method };
    case 'initialize':
      if (withMeta(p) && typeof p.protocolVersion === 'string' && CLIENT_CAPABILITIES.ok(p.capabilities) && IMPLEMENTATION.ok(p.clientInfo)) {
        return { type: 'InitializeRequest', method, protocolVersion: p.protocolVersion, capabilities: p.capabilities, clientInfo: p.clientInfo };
      }
      break;
    case 'completion/complete':
      if (withMeta(p) && reference(p.ref) && isObject(p.argument) && typeof p.argument.name === 'string'
        && typeof p.argument.value === 'string' && completionContext(p, 'context')) {
        return { type: 'CompleteRequest', method, ref: p.ref, argument: p.argument, context: p.context ?? null };
      }
      break;
    case 'prompts/get':
      if (withMeta(p) && typeof p.name === 'string' && optObject(p, 'arguments')) {
        return { type: 'GetPromptRequest', method, name: p.name, arguments: p.arguments ?? null };
      }
      break;
    case 'resources/read': case 'resources/subscribe': case 'resources/unsubscribe':
    case 'tasks/get': case 'tasks/result': case 'tasks/cancel': {
      const [variant, , , field] = SINGLE_FIELD_REQUESTS[method];
      if (withMeta(p) && typeof p[field] === 'string') return { type: variant, method, value: p[field] };
      break;
    }
    case 'logging/setLevel':
      if (withMeta(p) && LOGGING_LEVELS.includes(p.level)) return { type: 'SetLevelRequest', level: p.level };
      break;
    case 'tools/call':
      if (withMeta(p) && typeof p.name === 'string' && optObject(p, 'arguments') && optObject(p, 'task')) {
        return { type: 'CallToolRequest', name: p.name, arguments: p.arguments ?? null, task: p.task ?? null };
      }
      break;
    default:
      // RequestOptionalParam: the params struct is a flattened Option<P>, so a params object
      // whose fields do not deserialize yields `params: None` instead of failing.
      type = PAGINATED[method];
      if (type && !present) return { type, paramsSome: false, cursor: null };
      if (type && withMeta(p)) {
        const valid = optString(p, 'cursor');
        return { type, paramsSome: valid, cursor: valid ? p.cursor ?? null : null };
      }
  }
  if (!present) return { type: 'CustomRequest', method, params: undefined };
  if (withMeta(p)) {
    const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_meta'));
    return { type: 'CustomRequest', method, params: rest };
  }
  return undefined;
}

function classifyNotification(method, hasParams, params) {
  if (method === 'notifications/initialized') return { type: 'InitializedNotification' };
  if (method === 'notifications/roots/list_changed') return { type: 'RootsListChangedNotification' };
  const present = hasParams && params !== null;
  if (method === 'notifications/cancelled') {
    const p = present ? params : {};
    if ((!present || withMeta(p)) && requestId(p.requestId) !== undefined && optString(p, 'reason')) {
      return { type: 'CancelledNotification', requestId: requestId(p.requestId), reason: p.reason ?? null };
    }
  }
  if (method === 'notifications/progress') {
    // ProgressNotificationParam { progressToken: NumberOrString, progress: f64, total?: f64, message?: String }
    const p = present ? params : {};
    const optNumber = (k) => !has(p, k) || p[k] === null || isJsonNumber(p[k]);
    if ((!present || withMeta(p)) && requestId(p.progressToken) !== undefined && has(p, 'progress')
      && isJsonNumber(p.progress) && optNumber('total') && optString(p, 'message')) {
      return {
        type: 'ProgressNotification', token: requestId(p.progressToken), progress: toF64(p.progress),
        total: has(p, 'total') && p.total !== null ? toF64(p.total) : null, message: p.message ?? null,
      };
    }
  }
  if (!present) return { type: 'CustomNotification', method, params: undefined };
  if (withMeta(params)) return { type: 'CustomNotification', method, params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== '_meta')) };
  return undefined;
}

function errorData(e) {
  return isObject(e) && (typeof e.code === 'number' && Number.isInteger(e.code) && e.code >= -2147483648 && e.code <= 2147483647)
    && typeof e.message === 'string';
}

// JsonRpcMessage<ClientRequest, ClientResult, ClientNotification> (untagged: Request, Response,
// Notification, Error). → { kind: 'request'|'response'|'notification'|'error' } | 'ignore' | null (codec error)
export function parseMessage(line) {
  let text, v;
  try { text = utf8.decode(line); v = parseJson(text); } catch { return null; }
  const method = isObject(v) && typeof v.method === 'string' ? v.method : undefined;
  if (isObject(v) && v.jsonrpc === '2.0') {
    const id = has(v, 'id') ? requestId(v.id) : undefined;
    if (id !== undefined && method !== undefined) {
      const req = classifyRequest(method, has(v, 'params'), v.params);
      if (req) return { kind: 'request', id, req };
    }
    if (id !== undefined && has(v, 'result')) return { kind: 'response', id, result: v.result };
    if (method !== undefined) {
      const note = classifyNotification(method, has(v, 'params'), v.params);
      if (note) return { kind: 'notification', note };
    }
    if (id !== undefined && has(v, 'error') && errorData(v.error)) return { kind: 'error', id, error: v.error };
  }
  if (method !== undefined && shouldIgnore(v, method)) return 'ignore';
  return null;
}

// ── Rust `{:?}` of a ClientJsonRpcMessage (ServerInitializeError texts) ──
const debugId = (id) => (typeof id === 'string' ? `String(${strDebug(id)})` : `Number(${id})`);
const debugOptStr = (v) => debugOpt(v, strDebug);
const LEVEL_DEBUG = Object.fromEntries(LOGGING_LEVELS.map((l) => [l, l[0].toUpperCase() + l.slice(1)]));

function debugRequest(r) {
  const ext = 'extensions: Extensions';
  switch (r.type) {
    case 'PingRequest': return `PingRequest(RequestNoParam { method: PingRequestMethod, ${ext} })`;
    case 'InitializeRequest':
      return `InitializeRequest(Request { method: InitializeResultMethod, params: InitializeRequestParams { meta: None, `
        + `protocol_version: ProtocolVersion(${strDebug(r.protocolVersion)}), capabilities: ${CLIENT_CAPABILITIES.dbg(r.capabilities)}, `
        + `client_info: ${IMPLEMENTATION.dbg(r.clientInfo)} }, ${ext} })`;
    case 'SetLevelRequest':
      return `SetLevelRequest(Request { method: SetLevelRequestMethod, params: SetLevelRequestParams { meta: None, level: ${LEVEL_DEBUG[r.level]} }, ${ext} })`;
    case 'CallToolRequest':
      return `CallToolRequest(Request { method: CallToolRequestMethod, params: CallToolRequestParams { meta: None, name: ${strDebug(r.name)}, `
        + `arguments: ${debugOpt(r.arguments, debugMap)}, task: ${debugOpt(r.task, debugMap)} }, ${ext} })`;
    case 'ListToolsRequest': case 'ListPromptsRequest': case 'ListResourcesRequest': case 'ListResourceTemplatesRequest': case 'ListTasksRequest': {
      const m = { ListToolsRequest: 'ListToolsRequestMethod', ListPromptsRequest: 'ListPromptsRequestMethod', ListResourcesRequest: 'ListResourcesRequestMethod', ListResourceTemplatesRequest: 'ListResourceTemplatesRequestMethod', ListTasksRequest: 'ListTasksMethod' }[r.type];
      const params = r.paramsSome ? `Some(PaginatedRequestParams { meta: None, cursor: ${debugOptStr(r.cursor)} })` : 'None';
      return `${r.type}(RequestOptionalParam { method: ${m}, params: ${params}, ${ext} })`;
    }
    case 'CompleteRequest': {
      const ref = r.ref.type === 'ref/prompt'
        ? `Prompt(PromptReference { name: ${strDebug(r.ref.name)}, title: ${debugOptStr(r.ref.title)} })`
        : `Resource(ResourceReference { uri: ${strDebug(r.ref.uri)} })`;
      // HashMap<String, String>: Rust iterates in random order; one entry prints deterministically.
      const args = (m) => `{${sortedKeys(m).map((k) => `${strDebug(k)}: ${strDebug(m[k])}`).join(', ')}}`;
      const context = debugOpt(r.context, (c) => `CompletionContext { arguments: ${debugOpt(c.arguments, args)} }`);
      return `CompleteRequest(Request { method: CompleteRequestMethod, params: CompleteRequestParams { meta: None, ref: ${ref}, `
        + `argument: ArgumentInfo { name: ${strDebug(r.argument.name)}, value: ${strDebug(r.argument.value)} }, context: ${context} }, ${ext} })`;
    }
    case 'GetPromptRequest':
      return `GetPromptRequest(Request { method: GetPromptRequestMethod, params: GetPromptRequestParams { meta: None, name: ${strDebug(r.name)}, `
        + `arguments: ${debugOpt(r.arguments, debugMap)} }, ${ext} })`;
    case 'ReadResourceRequest': case 'SubscribeRequest': case 'UnsubscribeRequest':
    case 'GetTaskInfoRequest': case 'GetTaskResultRequest': case 'CancelTaskRequest': {
      const [variant, methodType, paramsType, , field] = SINGLE_FIELD_REQUESTS[r.method];
      return `${variant}(Request { method: ${methodType}, params: ${paramsType} { meta: None, ${field}: ${strDebug(r.value)} }, ${ext} })`;
    }
    default:
      return `CustomRequest(CustomRequest { method: ${strDebug(r.method)}, params: ${debugOpt(r.params, debugValue)}, ${ext} })`;
  }
}

function debugNotification(n) {
  const ext = 'extensions: Extensions';
  switch (n.type) {
    case 'InitializedNotification': return `InitializedNotification(NotificationNoParam { method: InitializedNotificationMethod, ${ext} })`;
    case 'RootsListChangedNotification': return `RootsListChangedNotification(NotificationNoParam { method: RootsListChangedNotificationMethod, ${ext} })`;
    case 'CancelledNotification':
      return `CancelledNotification(Notification { method: CancelledNotificationMethod, params: CancelledNotificationParam { request_id: ${debugId(n.requestId)}, reason: ${debugOptStr(n.reason)} }, ${ext} })`;
    case 'ProgressNotification':
      return `ProgressNotification(Notification { method: ProgressNotificationMethod, params: ProgressNotificationParam { `
        + `progress_token: ProgressToken(${debugId(n.token)}), progress: ${debugF64(n.progress)}, total: ${debugOpt(n.total, debugF64)}, `
        + `message: ${debugOptStr(n.message)} }, ${ext} })`;
    default:
      return `CustomNotification(CustomNotification { method: ${strDebug(n.method)}, params: ${debugOpt(n.params, debugValue)}, ${ext} })`;
  }
}

// ClientResult (untagged: CreateMessageResult | ListRootsResult | CreateElicitationResult |
// EmptyResult | CustomResult). EmptyObject denies unknown fields, so only `{}` is EmptyResult.
const ELICITATION_ACTIONS = { accept: 'Accept', decline: 'Decline', cancel: 'Cancel' };
function debugClientResult(v) {
  if (isObject(v)) {
    if (Array.isArray(v.roots) && v.roots.every((r) => isObject(r) && typeof r.uri === 'string' && optString(r, 'name'))) {
      const roots = v.roots.map((r) => `Root { uri: ${strDebug(r.uri)}, name: ${debugOptStr(r.name)} }`).join(', ');
      return `ListRootsResult(ListRootsResult { roots: [${roots}] })`;
    }
    if (typeof v.action === 'string' && has(ELICITATION_ACTIONS, v.action)) {
      const content = debugOpt(has(v, 'content') ? v.content : null, debugValue);
      return `CreateElicitationResult(CreateElicitationResult { action: ${ELICITATION_ACTIONS[v.action]}, content: ${content} })`;
    }
    if (!Object.keys(v).length) return 'EmptyResult(EmptyObject)';
  }
  return `CustomResult(CustomResult(${debugValue(v)}))`;
}

export function debugMessage(m) {
  const rpc = 'jsonrpc: JsonRpcVersion2_0';
  switch (m.kind) {
    case 'request': return `Request(JsonRpcRequest { ${rpc}, id: ${debugId(m.id)}, request: ${debugRequest(m.req)} })`;
    case 'notification': return `Notification(JsonRpcNotification { ${rpc}, notification: ${debugNotification(m.note)} })`;
    case 'response':
      return `Response(JsonRpcResponse { ${rpc}, id: ${debugId(m.id)}, result: ${debugClientResult(m.result)} })`;
    default:
      return `Error(JsonRpcError { ${rpc}, id: ${debugId(m.id)}, error: ErrorData { code: ErrorCode(${m.error.code}), `
        + `message: ${strDebug(m.error.message)}, data: ${debugOpt(has(m.error, 'data') ? m.error.data : null, debugValue)} } })`;
  }
}

// ── outgoing messages (ServerJsonRpcMessage) ────────────────────────
export const responseLine = (id, result) => stringify(struct({ jsonrpc: '2.0', id, result }));
export const errorLine = (id, code, message) => stringify(struct({ jsonrpc: '2.0', id, error: struct({ code, message }) }));
// CallToolResult { content: [Content::text], structuredContent (none), isError, _meta (none) }
export const callToolResult = (text, isError) => struct({ content: [struct({ type: 'text', text })], isError });
const EMPTY = {};

// ServerHandler default methods (handler/server.rs) for everything but tools.
async function handleRequest(handler, req) {
  switch (req.type) {
    case 'PingRequest': return EMPTY;
    case 'InitializeRequest': return handler.getInfo(LATEST_PROTOCOL_VERSION);
    case 'CompleteRequest': return struct({ completion: struct({ values: [] }) });
    case 'ListPromptsRequest': return struct({ prompts: [] });
    case 'ListResourcesRequest': return struct({ resources: [] });
    case 'ListResourceTemplatesRequest': return struct({ resourceTemplates: [] });
    case 'ListToolsRequest': return handler.listTools();
    case 'CallToolRequest': return handler.callTool(req);
    case 'SetLevelRequest': throw new RpcError(METHOD_NOT_FOUND, 'logging/setLevel');
    case 'ListTasksRequest': throw new RpcError(METHOD_NOT_FOUND, 'tasks/list');
    default: throw new RpcError(METHOD_NOT_FOUND, req.method);   // incl. typed method-not-found defaults
  }
}

const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// serve_server + service.waiting(): resolves when stdin closes (after draining in-flight
// responses for at most 5 s); rejects with InitializeError when the handshake fails.
export async function serve(handler, { input = process.stdin, output = process.stdout } = {}) {
  const receive = framedRead(input);   // Transport::receive: message | null (closed)
  const send = (line) => new Promise((r) => { output.write(line + '\n', () => r()); });

  // ── handshake: pings may precede initialize ──
  let init;
  for (;;) {
    const m = await receive();
    if (!m) throw new InitializeError('connection closed: initialize request');
    if (m.kind === 'request' && m.req.type === 'PingRequest') { await send(responseLine(m.id, EMPTY)); continue; }
    if (m.kind === 'request') { init = m; break; }
    throw new InitializeError(`expect initialized request, but received: Some(${debugMessage(m)})`);
  }
  if (init.req.type !== 'InitializeRequest') {
    throw new InitializeError(`expect initialized request, but received: Some(${debugMessage(init)})`);
  }
  // Version negotiation: the client's version when it sorts before the server's, else the server's.
  const clientVersion = init.req.protocolVersion;
  const version = cmpBytes(clientVersion, LATEST_PROTOCOL_VERSION) < 0 ? clientVersion : LATEST_PROTOCOL_VERSION;
  await send(responseLine(init.id, handler.getInfo(version)));
  // ── wait for notifications/initialized (logging/setLevel and ping answered meanwhile) ──
  for (;;) {
    const m = await receive();
    if (!m) throw new InitializeError('connection closed: initialize notification');
    if (m.kind === 'notification' && m.note.type === 'InitializedNotification') break;
    if (m.kind === 'request' && (m.req.type === 'SetLevelRequest' || m.req.type === 'PingRequest')) {
      await send(responseLine(m.id, EMPTY));
      continue;
    }
    throw new InitializeError(`expect initialized notification, but received: Some(${debugMessage(m)})`);
  }

  // ── serve loop: every request runs concurrently; notifications/responses are ignored ──
  const inflight = new Set();
  for (;;) {
    const m = await receive();
    if (!m) break;
    if (m.kind !== 'request') continue;
    const task = (async () => {
      let line;
      try {
        line = responseLine(m.id, await handleRequest(handler, m.req));
      } catch (e) {
        line = e instanceof RpcError ? errorLine(m.id, e.code, e.message) : errorLine(m.id, INTERNAL_ERROR, String(e?.message ?? e));
      }
      await send(line);
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }
  // stdin EOF: drain in-flight handler responses (5 s), then close.
  if (inflight.size) {
    let timer;
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => { timer = setTimeout(r, DRAIN_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
  }
}
