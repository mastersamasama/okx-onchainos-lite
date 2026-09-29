// A2MCP request-method resolution and endpoint-evidence helpers — upstream
// commands/agent_commerce/a2mcp_probe/method.rs.
import { urlParseError } from '../../payment/a2mcp.mjs';
import { trim, asciiLower, eqIgnoreAsciiCase, isWhitespace, lines, asciiUpper } from '../../core/rs/str.mjs';
import { isObject, isNumber, numText } from '../../core/rs/value.mjs';
import { ContractError, ProbeDecision, defaultStringType } from './_model.mjs';
import { isSupportedParamType } from './contract.mjs';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mget = (m, k) => (isObject(m) && hasOwn(m, k) && m[k] !== undefined ? m[k] : undefined);
const isAsciiAlnum = (ch) => ch !== undefined && /^[0-9A-Za-z]$/.test(ch);
const cpBefore = (s, i) => (i <= 0 ? undefined : [...s.slice(Math.max(0, i - 2), i)].pop());
const cpAt = (s, i) => (i >= s.length ? undefined : String.fromCodePoint(s.codePointAt(i)));

// upstream: method.rs::normalize_a2mcp_method; throws ContractError
export function normalizeA2mcpMethod(method) {
  const m = asciiUpper(trim(method));
  if (m === 'GET' || m === 'POST') return m;
  throw new ContractError('invalid_a2mcp_routing', `A2MCP request method \`${m}\` is unsupported; expected GET or POST`);
}

const METHOD_LABELS = ['request method', '请求方式', '请求方法'];
const EXAMPLE_LABELS = ['request example', '请求示例', '请求样例'];

// upstream: method.rs::resolve_request_method(description, endpoint (URL), fallback)
export function resolveRequestMethod(description, endpoint, fallback) {
  if (description !== undefined && description !== null) {
    const curl = extractCurlExample(description);
    if (curl !== undefined) return methodFromCurl(curl, endpoint);
    const text = extractLabelledValue(description, METHOD_LABELS);
    if (text !== undefined) return methodFromDeclaredText(text, endpoint);
  }
  if (fallback !== undefined && fallback !== null) return normalizeA2mcpMethod(fallback);
  return 'GET';
}

// upstream: method.rs::fallback_method_for_405(current, allow) → 'GET' | 'POST' | undefined
export function fallbackMethodFor405(current, allow) {
  let alternate;
  if (current === 'GET') alternate = 'POST';
  else if (current === 'POST' && allow !== undefined && allow !== null) alternate = 'GET';
  else return undefined;
  if (allow !== undefined && allow !== null) return allow.split(',').some((m) => eqIgnoreAsciiCase(trim(m), alternate)) ? alternate : undefined;
  return alternate;
}

// upstream: method.rs::should_retry_default_get_after_failure
export const shouldRetryDefaultGetAfterFailure = (input) => input.snapshot.methodWasDefaulted && input.snapshot.method === 'GET';

// upstream: method.rs::should_verify_default_get_challenge_with_post
export const shouldVerifyDefaultGetChallengeWithPost = (input, outcome) =>
  input.snapshot.methodWasDefaulted && input.snapshot.method === 'GET' && outcome.kind === 'Challenge';

// upstream: method.rs::PostVerificationAction
export const PostVerificationAction = Object.freeze({ AdoptPost: 'AdoptPost', KeepGet: 'KeepGet', Block: 'Block' });

// upstream: method.rs::post_verification_action(input, outcome)
export function postVerificationAction(input, outcome) {
  switch (outcome.kind) {
    case 'Challenge': case 'InputRequired': case 'Free': return PostVerificationAction.AdoptPost;
    case 'Failed':
      if (outcome.status === 400) {
        return discoverEndpointParamIssues(outcome.body, input.typedParams, input.snapshot.paramPlan) ? PostVerificationAction.AdoptPost : PostVerificationAction.Block;
      }
      return PostVerificationAction.Block;
    case 'MethodRequired':
      return outcome.allow !== null && outcome.allow !== undefined && outcome.allow.split(',').some((m) => eqIgnoreAsciiCase(trim(m), 'POST'))
        ? PostVerificationAction.Block : PostVerificationAction.KeepGet;
    default: return PostVerificationAction.Block;
  }
}

// upstream: method.rs::method_verification_blocked
export const methodVerificationBlocked = () => ProbeDecision.blocked('endpoint_failure', {
  schemaVersion: 1, message: 'The endpoint request method could not be verified before payment.',
});

// upstream: method.rs::request_method_is_defaulted(description, fallback)
export function requestMethodIsDefaulted(description, fallback) {
  if (fallback !== undefined && fallback !== null) return false;
  if (description === undefined || description === null) return true;
  return extractCurlExample(description) === undefined && extractLabelledValue(description, METHOD_LABELS) === undefined;
}

// upstream: method.rs::fallback_method_for_400(current, status, body, params, plan) → 'POST' | undefined
export function fallbackMethodFor400(current, status, body, params, plan) {
  if (status !== 400 || current !== 'GET' || !Object.keys(params).length) return undefined;
  const code = mget(body, 'code');
  if (mget(body, 'expectedMethod') === 'POST' || code === 'request_body_required' || code === 'body_required') return 'POST';
  const issues = mget(body, 'issues');
  if (!Array.isArray(issues)) return undefined;
  const missing = new Set();
  for (const issue of issues) {
    const name = topLevelIssuePath(issue);
    if (name === undefined) continue;
    const submitted = hasOwn(params, name) && params[name] !== null;
    if (!submitted || !issueReportsMissingValue(issue)) continue;
    const planned = plan.find((f) => f.name === name);
    if (planned && planned.carrier !== null && planned.carrier !== undefined && planned.carrier !== 'body') return undefined;
    missing.add(name);
  }
  return missing.size >= 2 ? 'POST' : undefined;
}

// upstream: method.rs::discover_endpoint_param_issues(body, params, plan) → InputRequired | null
export function discoverEndpointParamIssues(body, params, plan) {
  const fields = [], messages = [], seen = new Set();
  const issues = mget(body, 'issues');
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const name = topLevelIssuePath(issue);
      if (name === undefined) continue;
      if (!hasOwn(params, name) && !plan.some((f) => f.name === name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      if (hasOwn(params, name) && params[name] !== null && issueReportsMissingValue(issue)) continue;
      const description = endpointIssueDescription(issue);
      fields.push(endpointIssueField(name, issue, params, plan, description));
      messages.push(`${name}: ${description}`);
    }
  }
  if (!fields.length) {
    const message = mget(body, 'message');
    if (typeof message !== 'string') return null;
    if (!messageReportsInvalidValue(message)) return null;
    const keys = Object.keys(params).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const named = keys.filter((k) => containsIdentifier(message, k));
    if (named.length === 1) {
      const name = named[0];
      const d = 'The endpoint rejected this value. Provide a valid replacement.';
      fields.push(endpointIssueField(name, null, params, plan, d));
      messages.push(`${name}: ${d}`);
    }
  }
  return fields.length ? { fields, requiredAnyOf: [], message: messages.join('; '), method: null, needsDescriptionFallback: false } : null;
}

// upstream: method.rs::endpoint_issue_description(issue)
export function endpointIssueDescription(issue) {
  const expected = mget(issue, 'expected');
  if (typeof expected === 'string' && isSupportedParamType(expected)) return `The endpoint expects a ${expected} value.`;
  if (mget(issue, 'code') === 'too_small') {
    const minimum = mget(issue, 'minimum');
    if (isNumber(minimum)) return `The endpoint requires a value of at least ${numText(minimum)}.`;
    return 'The endpoint rejected this value because it is below the allowed minimum.';
  }
  return 'The endpoint rejected this value. Provide a valid replacement.';
}

// upstream: method.rs::endpoint_issue_field(name, issue, params, plan, message) → FieldConstraint
export function endpointIssueField(name, issue, params, plan, message) {
  const planned = plan.find((f) => f.name === name);
  const e = mget(issue, 'expected');
  const expected = typeof e === 'string' && isSupportedParamType(e) ? e : undefined;
  const type = expected ?? planned?.type ?? (hasOwn(params, name) ? jsonValueType(params[name]) : undefined) ?? defaultStringType();
  return { name, type, required: true, carrier: planned ? planned.carrier ?? null : null, description: message };
}

// upstream: method.rs::top_level_issue_path(issue) → string | undefined
export function topLevelIssuePath(issue) {
  const path = mget(issue, 'path');
  if (!Array.isArray(path) || path.length !== 1) return undefined;
  return typeof path[0] === 'string' && path[0] !== '' ? path[0] : undefined;
}

// upstream: method.rs::issue_reports_missing_value(issue)
export function issueReportsMissingValue(issue) {
  const m = mget(issue, 'message');
  const required = typeof m === 'string' && asciiLower(m).includes('required');
  let received = false;
  if (hasOwn(issue ?? {}, 'received') && isObject(issue)) {
    const r = issue.received;
    if (r === null) received = true;
    else if (typeof r === 'string') received = ['undefined', 'missing'].includes(asciiLower(r));
  }
  return required && received;
}

// upstream: method.rs::json_value_type(value)
export function jsonValueType(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || typeof v === 'bigint') return 'integer';
  if (isNumber(v)) return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (isObject(v)) return 'object';
  return 'string';
}

// str::match_indices(needle) — non-overlapping occurrence starts (UTF-16 indexes).
function matchIndices(hay, needle) {
  const out = [];
  if (needle === '') { for (let i = 0; i <= hay.length; i++) if (i === hay.length || !(hay.charCodeAt(i) >= 0xdc00 && hay.charCodeAt(i) <= 0xdfff)) out.push(i); return out; }
  for (let from = 0; ;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return out;
    out.push(i);
    from = i + needle.length;
  }
}
const identBoundary = (ch) => ch === undefined || (!isAsciiAlnum(ch) && ch !== '_');

// upstream: method.rs::contains_identifier(message, identifier)
export function containsIdentifier(message, identifier) {
  return matchIndices(message, identifier).some((start) => identBoundary(cpBefore(message, start)) && identBoundary(cpAt(message, start + identifier.length)));
}

// upstream: method.rs::message_reports_invalid_value(message)
export function messageReportsInvalidValue(message) {
  const m = asciiLower(message);
  return ['must', 'required', 'invalid', 'expected', 'unsupported'].some((x) => m.includes(x));
}

// upstream: method.rs::extract_labelled_value(description, labels) → string | undefined
export function extractLabelledValue(description, labels) {
  for (const line of lines(description)) {
    const v = labelledValue(line, labels);
    if (v !== undefined) return v;
  }
  return undefined;
}

// upstream: method.rs::extract_curl_example(description) → string | undefined
export function extractCurlExample(description) {
  const ls = lines(description);
  for (let li = 0; li < ls.length; li++) {
    const example = labelledValue(ls[li], EXAMPLE_LABELS);
    if (example === undefined) continue;
    const lower = asciiLower(example);
    const index = lower.indexOf('curl');
    if (index < 0) continue;
    let command = trim(example.slice(index));
    while (trimEnd(command).endsWith('\\')) {
      command = [...command].slice(0, -1).join('');
      li++;
      if (li >= ls.length) return undefined;
      command += ` ${trim(ls[li])}`;
    }
    return command;
  }
  for (const line of ls) {
    const lower = asciiLower(line);
    const index = lower.indexOf('curl');
    if (index < 0) continue;
    const before = cpBefore(lower, index);
    const after = cpAt(lower, index + 4);
    const boundaryBefore = before === undefined || !isAsciiAlnum(before);
    const boundaryAfter = after === undefined || !isAsciiAlnum(after);
    const command = trim(line.slice(index));
    const tokens = shellLikeTokens(command);
    if (boundaryBefore && boundaryAfter && tokens.length && eqIgnoreAsciiCase(tokens[0], 'curl') && tokens.some((t) => t.startsWith('https://'))) return command;
  }
  return undefined;
}
const trimEnd = (s) => { let j = s.length; while (j > 0 && isWhitespace(s.charCodeAt(j - 1))) j--; return s.slice(0, j); };

// upstream: method.rs::labelled_value(line, labels) → string | undefined
export function labelledValue(line, labels) {
  const open = line.indexOf('[');
  if (open < 0) return undefined;
  const rel = line.slice(open + 1).indexOf(']');
  if (rel < 0) return undefined;
  const close = rel + open + 1;
  const label = asciiLower(trim(line.slice(open + 1, close)));
  return labels.some((c) => label === asciiLower(c)) ? trim(line.slice(close + 1)) : undefined;
}

// upstream: method.rs::method_from_curl(curl, endpoint); throws ContractError
export function methodFromCurl(curl, endpoint) {
  const tokens = shellLikeTokens(curl);
  if (!tokens.length || !eqIgnoreAsciiCase(tokens[0], 'curl')) throw invalidMethodContract('request example is not a curl command');
  const target = tokens.slice(1).find((t) => t.startsWith('https://'));
  if (target === undefined) throw invalidMethodContract('curl example must contain an HTTPS URL');
  validateContractTarget(target, endpoint, 'curl example');
  let explicit, forceGet = false, hasBody = false, implicitUnsupported;
  for (let index = 1; index < tokens.length; index++) {
    const t = tokens[index];
    if (t === '-X' || t === '--request') { explicit = tokens[index + 1]; index++; }
    else if (t.startsWith('--request=')) explicit = t.slice('--request='.length);
    else if (t.startsWith('-X') && Buffer.byteLength(t) > 2) explicit = t.slice(2);
    else if (t === '-G' || t === '--get') forceGet = true;
    else if (t === '-I' || t === '--head') implicitUnsupported = 'HEAD';
    else if (t === '-T' || t === '--upload-file' || (t.startsWith('-T') && Buffer.byteLength(t) > 2) || t.startsWith('--upload-file=')) implicitUnsupported = 'PUT';
    else if (t === '-d' || t === '-F' || (t.startsWith('-d') && Buffer.byteLength(t) > 2) || (t.startsWith('-F') && Buffer.byteLength(t) > 2) || t === '--data'
      || t.startsWith('--data=') || t.startsWith('--data-') || t === '--json' || t.startsWith('--json=') || t === '--form' || t.startsWith('--form=')) hasBody = true;
  }
  if (explicit !== undefined) return normalizeA2mcpMethod(explicit);
  if (implicitUnsupported !== undefined) return normalizeA2mcpMethod(implicitUnsupported);
  if (forceGet) return 'GET';
  if (hasBody) return 'POST';
  return 'GET';
}

// upstream: method.rs::method_from_declared_text(text, endpoint); throws ContractError
export function methodFromDeclaredText(text, endpoint) {
  const hasGet = containsAsciiToken(text, 'GET');
  const hasPost = containsAsciiToken(text, 'POST');
  if (!hasGet && !hasPost) throw invalidMethodContract('request method must identify GET or POST');
  const method = hasGet && !hasPost ? 'GET' : 'POST';
  for (const token of shellLikeTokens(text)) {
    if (token.startsWith('https://')) validateContractTarget(token, endpoint, 'request method');
    else if (token.startsWith('/')) {
      const declaredPath = token.split(/[?#]/)[0];
      if (declaredPath !== endpoint.pathname) throw invalidMethodContract('request method path does not match serviceSnapshot.endpoint');
    }
  }
  return method;
}

const KNOWN_PORTS = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 };
// url::Url::port_or_known_default
const portOrKnownDefault = (u) => (u.port !== '' ? Number(u.port) : KNOWN_PORTS[u.protocol] ?? null);

// upstream: method.rs::validate_contract_target(target, endpoint, source); throws ContractError
export function validateContractTarget(target, endpoint, source) {
  let parsed;
  try { parsed = new URL(target); } catch { throw invalidMethodContract(`${source} URL is invalid: ${urlParseError(target)}`); }
  const same = parsed.protocol === endpoint.protocol && parsed.hostname === endpoint.hostname
    && portOrKnownDefault(parsed) === portOrKnownDefault(endpoint) && parsed.pathname === endpoint.pathname;
  if (!same) throw invalidMethodContract(`${source} URL does not match serviceSnapshot.endpoint`);
}

// upstream: method.rs::contains_ascii_token(text, expected)
export function containsAsciiToken(text, expected) {
  const upper = asciiUpper(text);
  return matchIndices(upper, expected).some((i) => identBoundary(cpBefore(upper, i)) && identBoundary(cpAt(upper, i + expected.length)));
}

// upstream: method.rs::shell_like_tokens(value)
export function shellLikeTokens(value) {
  const tokens = [];
  let current = '', quote = null, escaped = false;
  for (const ch of String(value)) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote !== null) { if (ch === quote) quote = null; else current += ch; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (isWhitespace(ch)) { if (current !== '') { tokens.push(current); current = ''; } }
    else current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

// upstream: method.rs::invalid_method_contract(message)
export const invalidMethodContract = (message) => new ContractError('invalid_a2mcp_routing', message);
