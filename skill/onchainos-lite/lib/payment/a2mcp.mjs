// OKX.AI A2MCP prepared-payment + payment-intent state — upstream commands/payment/a2mcp.rs.
//
// Deliberately separate from the generic quote PaymentState (state.mjs): the only dispatch signal
// is the trusted `source` field of $HOME/payments/<id>.json.
//   • prepared payment  : payments/a2prep_<32 hex>.json (source okx_ai_a2mcp_prepared), claimed by
//                         rename to .<id>.claim-<uuid>, consumed / replaced exactly once;
//   • payment intent    : payments/pay_<24 hex>.json (source okx_ai_a2mcp) with an execution state
//                         machine prepared → signing → proof_generated → replaying → terminal.
// Rust structs are classes whose data lives in `.d` (JSON field names); accessors mirror the Rust
// getters (camelCase). Files are pretty JSON in struct declaration order, written with
// home::atomic_write (0600, payments dir 0700).
//
// JS has no Drop: an A2mcpPreparedClaim that is neither committed nor replaced must be released
// with `claim.drop()` (restores the canonical file), typically in a `finally`.
import { readFileSync, renameSync, rmSync, existsSync, mkdirSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { context } from '../core/errors.mjs';
import { stringify, struct, F64 } from '../core/json.mjs';
import { asciiLower, asciiUpper, trim } from '../core/rs/str.mjs';
import { get, asStr, asU64, isObject, cloneValue } from '../core/rs/value.mjs';
import { intFromStrOk, jsonInt, U64_MAX } from '../core/rs/num.mjs';
import { ioErrorText } from '../core/rs/fs.mjs';
import { parseFromRfc3339 } from '../core/rs/time.mjs';
import { fromSlice, T } from '../core/serde.mjs';
import { decodePaymentBlob } from './dispatcher.mjs';
import { extractAmount } from './payment-flow.mjs';
import { prepareA2mcpCandidates, refreshA2mcpCandidateBalances } from './quote.mjs';
import * as state from './state.mjs';

// upstream: a2mcp.rs constants
export const A2MCP_INTENT_VERSION = 1;
export const A2MCP_SOURCE = 'okx_ai_a2mcp';
export const ERR_CONFIRMATION_REQUIRED = 'a2mcp_payment_confirmation_required';
export const ERR_INSUFFICIENT_BALANCE = 'a2mcp_insufficient_balance';
export const ERR_ALREADY_CREATED = 'a2mcp_payment_intent_already_created';
export const ERR_ALREADY_EXECUTED = 'a2mcp_payment_already_executed';
export const ERR_EXPIRED = 'a2mcp_payment_intent_expired';
export const ERR_INVALID_INTENT = 'a2mcp_invalid_payment_intent';
export const ERR_INVALID_PARAMS = 'a2mcp_invalid_typed_params';
export const ERR_OVERRIDES_FORBIDDEN = 'a2mcp_payment_overrides_forbidden';
export const ERR_PREPARED_EXPIRED_OR_MISSING = 'a2mcp_prepared_expired_or_missing';
const A2MCP_PREPARED_SOURCE = 'okx_ai_a2mcp_prepared';
const A2MCP_PREPARED_ID_PREFIX = 'a2prep_';

// upstream: a2mcp.rs::A2mcpPaymentSource
export const A2mcpPaymentSource = Object.freeze({ GenericQuote: 'GenericQuote', OkxAiA2mcp: 'OkxAiA2mcp' });

// upstream: a2mcp.rs::A2mcpExecutionState (serde snake_case)
export const A2mcpExecutionState = Object.freeze({
  Prepared: 'prepared', Signing: 'signing', ProofGenerated: 'proof_generated', Replaying: 'replaying', Success: 'success',
  PendingTerminal: 'pending_terminal', FailedTerminal: 'failed_terminal', Expired: 'expired',
});
const EXECUTION_STATES = Object.values(A2mcpExecutionState);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── serde_json::Value equality (Number: integers by value, floats only equal floats) ──
export function valueEq(a, b) {
  if (a === b) return true;
  if (a instanceof F64 || b instanceof F64) return a instanceof F64 && b instanceof F64 && a.valueOf() === b.valueOf();
  const ai = typeof a === 'number' || typeof a === 'bigint', bi = typeof b === 'number' || typeof b === 'bigint';
  if (ai || bi) return ai && bi && BigInt(a) === BigInt(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valueEq(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && valueEq(a[k], b[k]));
  }
  return false;
}
// Option<Value> equality: undefined = None.
const optValueEq = (a, b) => (a === undefined || b === undefined ? a === b : valueEq(a, b));

// ── strict serde-derive decoding of the persisted structs ────────────
// Schema: 'str' | 'bool' | 'value' | 'map' | {uint: bits} | {opt: s} | {vec: s} | {oneOf: [..]} |
// {struct: [[key, schema, default?]]}. Two passes, both throwing on any mismatch (callers map it
// to their own error token, exactly like upstream's `map_err(|_| …)`):
//   1. serdeT(schema) drives the streaming serde_json decoder (core/serde.mjs), which
//      enforces the derive rules while parsing — `duplicate field`, `missing field`, seq-form
//      structs (an Option field without #[serde(default)] is still required there), trailing
//      input — and applies #[serde(default)]s;
//   2. decode() range-checks integers and resolves unit-enum variants on that result.
const U = (bits) => ({ uint: bits });
function serdeT(schema) {
  if (schema === 'str') return T.string;
  if (schema === 'bool') return T.bool;
  if (schema === 'value') return T.value;
  if (schema === 'map') return T.map(T.value);
  if (schema.uint || schema.oneOf) return T.value;
  if (schema.opt) return T.option(serdeT(schema.opt));
  if (schema.vec) return T.vec(serdeT(schema.vec));
  return T.struct('A2mcp', schema.struct.map(([k, s, def]) => (def === undefined ? [k, serdeT(s)] : [k, serdeT(s), def])));
}
function decode(schema, v) {
  if (schema === 'str') { if (typeof v !== 'string') throw new Error('type'); return v; }
  if (schema === 'bool') { if (typeof v !== 'boolean') throw new Error('type'); return v; }
  if (schema === 'value') return v;
  if (schema === 'map') { if (!isObject(v)) throw new Error('type'); return v; }
  if (schema.uint) {
    const u = asU64(v);
    if (u === undefined || BigInt(u) > (1n << BigInt(schema.uint)) - 1n) throw new Error('type');
    return u;
  }
  if (schema.opt) return v == null ? undefined : decode(schema.opt, v);
  if (schema.vec) { if (!Array.isArray(v)) throw new Error('type'); return v.map((x) => decode(schema.vec, x)); }
  if (schema.oneOf) {
    // serde_json unit variant: "name", or the externally-tagged map form {"name": null}.
    if (typeof v === 'string' && schema.oneOf.includes(v)) return v;
    const keys = isObject(v) ? Object.keys(v) : [];
    if (keys.length === 1 && schema.oneOf.includes(keys[0]) && v[keys[0]] === null) return keys[0];
    throw new Error('variant');
  }
  const fields = schema.struct;
  const out = {};
  if (Array.isArray(v)) {
    if (v.length > fields.length) throw new Error('length');
    fields.forEach(([k, s, def], i) => {
      if (i < v.length) out[k] = decode(s, v[i]);
      else if (def !== undefined) out[k] = def();
      else if (s.opt) out[k] = undefined;
      else throw new Error('length');
    });
    return out;
  }
  if (!isObject(v)) throw new Error('type');
  for (const [k, s, def] of fields) {
    if (hasOwn(v, k)) out[k] = decode(s, v[k]);
    else if (def !== undefined) out[k] = def();
    else if (s.opt) out[k] = undefined;
    else throw new Error(`missing field ${k}`);
  }
  return out;
}

const PARAM_SPEC = { struct: [['name', 'str'], ['carrier', { oneOf: Object.values(state.ParamCarrier) }, () => state.ParamCarrier.Query], ['required', 'bool', () => false], ['type', 'str', () => '']] };
const FROZEN_REQUEST = { struct: [['endpoint', 'str'], ['method', 'str'], ['typedParams', 'map'], ['paramPlan', { vec: PARAM_SPEC }], ['resource', { opt: 'value' }]] };
const CANDIDATE_FIELDS = [
  ['candidateId', 'str'], ['rawAccept', 'value'], ['symbol', 'str'], ['network', 'str'], ['chainId', 'str'], ['chainName', 'str'],
  ['isMainnet', 'bool'], ['scheme', 'str'], ['amountAtomic', 'str'], ['amountDisplay', 'str'], ['decimals', U(32)],
  ['authorizationType', 'str'], ['balanceStatus', 'str'], ['availableAmount', 'str'], ['requiredAmount', 'str'], ['shortfall', 'str'],
  ['depositAddress', 'str'],
];
const SELECTED_ACCEPT_FIELDS = [
  ['raw', 'value'], ['network', 'str'], ['asset', 'str'], ['symbol', 'str'], ['decimals', U(32)], ['scheme', 'str'],
  ['authorizationType', 'str'], ['amount', 'str'], ['payTo', 'str'], ['balanceStatus', 'str'],
];
// #[serde(default)] on every Option → also optional in the seq form.
const NONE = () => undefined;
const CONFIRMATION_FIELDS = [
  ['serviceId', 'str'], ['serviceName', { opt: 'str' }, NONE], ['providerAgentId', { opt: 'str' }, NONE], ['aspAmount', { opt: 'str' }, NONE],
  ['aspSymbol', { opt: 'str' }, NONE],
];
const INTENT = { struct: [
  ['version', U(32)], ['source', 'str'], ['paymentId', 'str'], ['probeId', 'str'], ['ownerAccountId', 'str'], ['payerAddress', 'str'],
  ['frozenRequest', FROZEN_REQUEST], ['selectedAccept', { struct: SELECTED_ACCEPT_FIELDS }],
  ['execution', { struct: [['state', { oneOf: EXECUTION_STATES }], ['signatureAttempts', U(8)]] }],
  ['createdAt', U(64)], ['expiresAt', U(64)],
] };
const PREPARED = { struct: [
  ['version', U(32)], ['source', 'str'], ['frozenRequest', FROZEN_REQUEST],
  ['confirmationContext', { struct: CONFIRMATION_FIELDS }, () => ({ serviceId: '' })],
  ['candidates', { vec: { struct: CANDIDATE_FIELDS } }], ['challengeExpiresAt', U(64)],
  ['walletError', { opt: 'str' }], ['fundingCandidateId', { opt: 'str' }, () => undefined],
] };
const PREPARED_STATE = { struct: [
  ['version', U(32)], ['source', 'str'], ['preparedId', 'str'], ['ownerAccountId', 'str'], ['createdAt', U(64)], ['expiresAt', U(64)],
  ['prepared', PREPARED],
] };

const paramSpecEq = (a, b) => a.name === b.name && a.carrier === b.carrier && a.required === b.required && (a.type ?? '') === (b.type ?? '');
const paramSpecOut = (p) => state.paramSpec({ name: p.name, carrier: p.carrier, required: p.required, type: p.type ?? '' });

// ── A2mcpFrozenRequestV1 ─────────────────────────────────────────────

const RESERVED_HEADERS = ['payment-signature', 'payment-required', 'www-authenticate', 'authorization', 'proxy-authorization', 'host',
  'content-length', 'transfer-encoding', 'connection'];

// upstream: a2mcp.rs::is_scalar (private)
const isScalar = (v) => v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;

// `url` 2.5.8 ParseError Display for an endpoint the WHATWG parser (node:url) rejected. Mirrors the
// crate's parse order: scheme → authority (userinfo, host, port). Special schemes run the host
// through percent-decoding + IDNA (`AsciiDenyList::URL`: any failure or forbidden domain code point
// is IdnaError) and, when it ends in a number, the IPv4 parser; non-special schemes use the opaque
// host parser (forbidden host code point → InvalidDomainCharacter). The host is always checked
// before the port.
const URL_ERR = {
  relative: 'relative URL without a base', emptyHost: 'empty host', idna: 'invalid international domain name',
  port: 'invalid port number', ipv4: 'invalid IPv4 address', ipv6: 'invalid IPv6 address', domainChar: 'invalid domain character',
};
const SPECIAL_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file'];
const FORBIDDEN_HOST = new Set([0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c]);
const forbiddenDomainCp = (c) => FORBIDDEN_HOST.has(c) || c <= 0x1f || c === 0x25 || c === 0x7f;

// url host.rs::parse_ipv4number → number | null (valid, overflows u32) | undefined (not a number)
function ipv4Number(input) {
  let s = input, r = 10;
  if (s === '') return undefined;
  if (s.startsWith('0x') || s.startsWith('0X')) { s = s.slice(2); r = 16; } else if (s.length >= 2 && s.startsWith('0')) { s = s.slice(1); r = 8; }
  if (s === '') return 0;
  const ok = r === 8 ? /^[0-7]+$/.test(s) : r === 10 ? /^[0-9]+$/.test(s) : /^[0-9A-Fa-f]+$/.test(s);
  if (!ok) return undefined;
  const n = BigInt(r === 16 ? `0x${s}` : r === 8 ? `0o${s}` : s);
  return n > 0xffffffffn ? null : Number(n);
}
// url host.rs::ends_in_a_number
function endsInANumber(domain) {
  const parts = domain.split('.');
  let last = parts.pop();
  if (last === '') { if (!parts.length) return false; last = parts.pop(); }
  if (last !== '' && /^[0-9]+$/.test(last)) return true;
  return ipv4Number(last) !== undefined;
}
// url host.rs::parse_ipv4addr (validity only)
function validIpv4(domain) {
  const parts = domain.split('.');
  if (parts[parts.length - 1] === '') parts.pop();
  if (parts.length > 4) return false;
  const nums = parts.map(ipv4Number);
  if (nums.some((n) => n === undefined || n === null)) return false;
  const last = nums.pop();
  if (last > 0xffffffff / 2 ** (8 * nums.length)) return false;
  return !nums.some((n) => n > 255);
}
// WHATWG percent-decode of a host string → Buffer
function percentDecode(s) {
  const b = Buffer.from(s, 'utf8'), out = [];
  for (let i = 0; i < b.length; i++) {
    const h = (x) => (x >= 0x30 && x <= 0x39) || (x >= 0x41 && x <= 0x46) || (x >= 0x61 && x <= 0x66);
    if (b[i] === 0x25 && i + 2 < b.length && h(b[i + 1]) && h(b[i + 2])) { out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16)); i += 2; } else out.push(b[i]);
  }
  return Buffer.from(out);
}
// Special-scheme host (url host.rs::Host::parse_cow) → ParseError text | null when valid.
function specialHostError(host) {
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return URL_ERR.ipv6;
    try { new URL(`https://${host}/`); return null; } catch { return URL_ERR.ipv6; }
  }
  const bytes = percentDecode(host);
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return URL_ERR.idna; }
  // IDNA (UTS 46, non-transitional, CheckHyphens off) — ASCII labels only lowercase; others go
  // through node:url's domainToASCII (also the full host parser, so an empty result is ambiguous).
  let ascii;
  if (/^[\x00-\x7f]*$/.test(decoded) && !/(^|\.)xn--/i.test(decoded)) ascii = asciiLower(decoded);
  else {
    ascii = domainToASCII(decoded);
    if (ascii === '') {
      const mapped = decoded.normalize('NFKC').toLowerCase();
      if (!/^[\x00-\x7f]+$/.test(mapped) || /(^|\.)xn--/.test(mapped) || [...Buffer.from(mapped)].some(forbiddenDomainCp)) return URL_ERR.idna;
      ascii = mapped;
    }
  }
  if ([...Buffer.from(ascii)].some(forbiddenDomainCp)) return URL_ERR.idna;
  if (ascii === '') return URL_ERR.emptyHost;
  if (endsInANumber(ascii) && !validIpv4(ascii)) return URL_ERR.ipv4;
  try { new URL(`https://${host}/`); return null; } catch { return URL_ERR.idna; }
}
// url parser.rs::parse_port (Context::UrlParser) on the text after the host's ':'.
const portError = (s) => (/^[0-9]*$/.test(s) && (s === '' || Number(s) <= 65535) ? null : URL_ERR.port);

export function urlParseError(endpoint) {
  // Url::parse: strip leading/trailing C0 control or space, drop every ASCII tab / newline.
  const s = String(endpoint).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  if (!m) return URL_ERR.relative;
  const scheme = asciiLower(m[1]);
  let rest = s.slice(m[0].length);
  const special = SPECIAL_SCHEMES.includes(scheme);
  if (special) rest = rest.replace(/^[/\\]*/, '');
  else if (rest.startsWith('//')) rest = rest.slice(2);
  else return URL_ERR.domainChar;                                   // cannot-be-a-base: no host
  const authority = rest.split(special ? /[/\\?#]/ : /[/?#]/)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  // host = up to the first ':' outside [...]
  let end = 0, inBrackets = false;
  for (; end < hostPort.length; end++) {
    const c = hostPort[end];
    if (c === ':' && !inBrackets) break;
    if (c === '[') inBrackets = true;
    else if (c === ']') inBrackets = false;
  }
  const host = hostPort.slice(0, end);
  const port = end < hostPort.length ? hostPort.slice(end + 1) : null;
  if (special && scheme !== 'file') {
    if (host === '') return URL_ERR.emptyHost;
    const he = specialHostError(host);
    if (he) return he;
  } else if (host.startsWith('[')) {
    if (!host.endsWith(']')) return URL_ERR.ipv6;
    try { new URL(`https://${host}/`); } catch { return URL_ERR.ipv6; }
  } else if ([...Buffer.from(host)].some((c) => FORBIDDEN_HOST.has(c))) return URL_ERR.domainChar;
  else if (host === '' && authority.includes('@')) return URL_ERR.emptyHost;           // credentials without a host
  if (port !== null) { const pe = portError(port); if (pe) return pe; }
  return special ? URL_ERR.idna : URL_ERR.domainChar;
}

// upstream: a2mcp.rs::A2mcpFrozenRequestV1
export class A2mcpFrozenRequestV1 {
  constructor(d) { this.d = d; }

  // upstream: A2mcpFrozenRequestV1::new — validates; method trimmed + ASCII-uppercased.
  // typedParams: object (serde Map); paramPlan: [{name, carrier, required, type}]; resource: Value | undefined.
  static new(endpoint, method, typedParams, paramPlan, resource) {
    if (trim(endpoint) === '' || trim(method) === '') throw new Error(`${ERR_INVALID_PARAMS}: endpoint and method are required`);
    const m = asciiUpper(trim(method));
    if (m !== 'GET' && m !== 'POST') throw new Error(`${ERR_INVALID_PARAMS}: A2MCP request method must be GET or POST`);
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw new Error(`${ERR_INVALID_PARAMS}: invalid Endpoint URL: ${urlParseError(endpoint)}`); }
    if (parsed.protocol !== 'https:') throw new Error(`${ERR_INVALID_PARAMS}: Endpoint must use HTTPS`);
    for (const spec of paramPlan) {
      if (spec.carrier === state.ParamCarrier.Header && RESERVED_HEADERS.includes(asciiLower(spec.name))) {
        throw new Error(`${ERR_INVALID_PARAMS}: reserved header parameter '${spec.name}'`);
      }
      if (hasOwn(typedParams, spec.name) && spec.carrier !== state.ParamCarrier.Body && !isScalar(typedParams[spec.name])) {
        throw new Error(`${ERR_INVALID_PARAMS}: non-body parameter '${spec.name}' must be scalar`);
      }
    }
    return new A2mcpFrozenRequestV1({ endpoint, method: m, typedParams, paramPlan: paramPlan.map((p) => ({ ...p, type: p.type ?? '' })), resource });
  }

  endpoint() { return this.d.endpoint; }
  method() { return this.d.method; }
  typedParams() { return this.d.typedParams; }
  paramPlan() { return this.d.paramPlan; }
  resource() { return this.d.resource; }
  clone() { return new A2mcpFrozenRequestV1({ ...this.d, typedParams: cloneValue(this.d.typedParams), paramPlan: this.d.paramPlan.map((p) => ({ ...p })), resource: this.d.resource === undefined ? undefined : cloneValue(this.d.resource) }); }
  equals(o) {
    const a = this.d, b = o.d;
    return a.endpoint === b.endpoint && a.method === b.method && valueEq(a.typedParams, b.typedParams)
      && a.paramPlan.length === b.paramPlan.length && a.paramPlan.every((p, i) => paramSpecEq(p, b.paramPlan[i])) && optValueEq(a.resource, b.resource);
  }
  rebuild() { return A2mcpFrozenRequestV1.new(this.d.endpoint, this.d.method, cloneValue(this.d.typedParams), this.d.paramPlan.map((p) => ({ ...p })), this.d.resource === undefined ? undefined : cloneValue(this.d.resource)); }
  toStruct() {
    return struct({ endpoint: this.d.endpoint, method: this.d.method, typedParams: this.d.typedParams, paramPlan: this.d.paramPlan.map(paramSpecOut), resource: this.d.resource });
  }
}

// ── A2mcpPreparedCandidate / A2mcpSelectedAcceptV1 ───────────────────

const STABLE = ['USDT', 'USDC', 'USDG'];

// upstream: a2mcp.rs::A2mcpPreparedCandidate
export class A2mcpPreparedCandidate {
  constructor(d) { this.d = d; }
  candidateId() { return this.d.candidateId; }
  rawAccept() { return this.d.rawAccept; }
  symbol() { return this.d.symbol; }
  network() { return this.d.network; }
  chainId() { return this.d.chainId; }
  chainName() { return this.d.chainName; }
  isMainnet() { return this.d.isMainnet; }
  scheme() { return this.d.scheme; }
  amountAtomic() { return this.d.amountAtomic; }
  amountDisplay() { return this.d.amountDisplay; }
  decimals() { return this.d.decimals; }
  authorizationType() { return this.d.authorizationType; }
  balanceStatus() { return this.d.balanceStatus; }
  availableAmount() { return this.d.availableAmount; }
  requiredAmount() { return this.d.requiredAmount; }
  shortfall() { return this.d.shortfall; }
  depositAddress() { return this.d.depositAddress; }
  clone() { return new A2mcpPreparedCandidate({ ...this.d, rawAccept: cloneValue(this.d.rawAccept) }); }
  toStruct() { return struct(Object.fromEntries(CANDIDATE_FIELDS.map(([k]) => [k, this.d[k]]))); }
}

// upstream: a2mcp.rs::required_str (private)
function requiredStr(value, key) {
  const s = asStr(get(value, key));
  if (s === undefined || s === '') throw new Error(`${ERR_INVALID_INTENT}: missing ${key}`);
  return s;
}

// upstream: a2mcp.rs::A2mcpSelectedAcceptV1
export class A2mcpSelectedAcceptV1 {
  constructor(d) { this.d = d; }

  // upstream: A2mcpSelectedAcceptV1::try_from_prepared_candidate
  static tryFromPreparedCandidate(candidate) {
    const c = candidate instanceof A2mcpPreparedCandidate ? candidate.d : candidate;
    const symbol = asciiUpper(c.symbol);
    if (!STABLE.includes(symbol)) throw new Error(`${ERR_INVALID_INTENT}: unsupported payment asset`);
    const raw = c.rawAccept;
    const scheme = asciiLower(requiredStr(raw, 'scheme'));
    const authorizationType = asciiLower(c.authorizationType);
    const classified = classifyAuthorization(raw);
    if (classified === null) throw new Error(`${ERR_INVALID_INTENT}: unsupported scheme/authorization`);
    if (authorizationType !== classified) throw new Error(`${ERR_INVALID_INTENT}: authorization disagrees with raw entry`);
    const combo = `${scheme}/${authorizationType}`;
    if (!['exact/eip3009', 'exact/permit2', 'upto/permit2', 'aggr_deferred/session'].includes(combo)) {
      throw new Error(`${ERR_INVALID_INTENT}: unsupported scheme/authorization`);
    }
    const network = requiredStr(raw, 'network');
    const asset = requiredStr(raw, 'asset');
    const amount = extractAmount(raw);
    if (amount === '') throw new Error(`${ERR_INVALID_INTENT}: missing amount`);
    const payTo = requiredStr(raw, 'payTo');
    return new A2mcpSelectedAcceptV1({
      raw, network, asset, symbol, decimals: c.decimals, scheme, authorizationType, amount, payTo, balanceStatus: c.balanceStatus,
    });
  }

  raw() { return this.d.raw; }
  scheme() { return this.d.scheme; }
  symbol() { return this.d.symbol; }
  balanceStatus() { return this.d.balanceStatus; }
  equals(o) {
    return SELECTED_ACCEPT_FIELDS.every(([k]) => (k === 'raw' ? valueEq(this.d.raw, o.d.raw) : String(this.d[k]) === String(o.d[k])));
  }
  toStruct() { return struct(Object.fromEntries(SELECTED_ACCEPT_FIELDS.map(([k]) => [k, this.d[k]]))); }
}

// ── A2mcpPaymentIntentV1 ─────────────────────────────────────────────

// upstream: a2mcp.rs::A2mcpPaymentIntentV1
export class A2mcpPaymentIntentV1 {
  constructor(d) { this.d = d; }
  source() { return A2mcpPaymentSource.OkxAiA2mcp; }
  paymentId() { return this.d.paymentId; }
  ownerAccountId() { return this.d.ownerAccountId; }
  payerAddress() { return this.d.payerAddress; }
  frozenRequest() { return this.d.frozenRequest; }
  selectedAccept() { return this.d.selectedAccept; }
  executionState() { return this.d.execution.state; }
  signatureAttempts() { return this.d.execution.signatureAttempts; }

  // upstream: A2mcpPaymentIntentV1::begin_signing
  beginSigning(now) {
    if (BigInt(now) >= BigInt(this.d.expiresAt)) {
      this.d.execution.state = A2mcpExecutionState.Expired;
      this.write();
      throw new Error(`${ERR_EXPIRED}: ${this.d.paymentId}`);
    }
    if (this.d.execution.state !== A2mcpExecutionState.Prepared) throw new Error(`${ERR_ALREADY_EXECUTED}: ${this.d.paymentId}`);
    this.d.execution.state = A2mcpExecutionState.Signing;
    this.write();
  }

  // upstream: A2mcpPaymentIntentV1::record_signature_attempt
  recordSignatureAttempt() {
    if (this.d.execution.state !== A2mcpExecutionState.Signing || this.d.execution.signatureAttempts >= 3) {
      throw new Error(`${ERR_ALREADY_EXECUTED}: invalid signature attempt state`);
    }
    this.d.execution.signatureAttempts += 1;
    this.write();
  }

  // upstream: A2mcpPaymentIntentV1::mark_proof_generated
  markProofGenerated() {
    if (this.d.execution.state !== A2mcpExecutionState.Signing) throw new Error(`${ERR_ALREADY_EXECUTED}: proof generated outside signing`);
    this.d.execution.state = A2mcpExecutionState.ProofGenerated;
    this.write();
  }

  // upstream: A2mcpPaymentIntentV1::mark_replaying
  markReplaying() {
    if (this.d.execution.state !== A2mcpExecutionState.ProofGenerated) throw new Error(`${ERR_ALREADY_EXECUTED}: replay outside proof_generated`);
    this.d.execution.state = A2mcpExecutionState.Replaying;
    this.write();
  }

  markSuccess() { this.markTerminal(A2mcpExecutionState.Success); }
  markPendingTerminal() { this.markTerminal(A2mcpExecutionState.PendingTerminal); }
  markFailedTerminal() { this.markTerminal(A2mcpExecutionState.FailedTerminal); }

  // upstream: A2mcpPaymentIntentV1::mark_terminal (private)
  markTerminal(s) {
    if (![A2mcpExecutionState.Signing, A2mcpExecutionState.ProofGenerated, A2mcpExecutionState.Replaying].includes(this.d.execution.state)) {
      throw new Error(`${ERR_ALREADY_EXECUTED}: terminal transition from invalid state`);
    }
    this.d.execution.state = s;
    this.write();
  }

  // upstream: A2mcpPaymentIntentV1::validate (private)
  validate() {
    const d = this.d;
    if (Number(d.version) !== A2MCP_INTENT_VERSION || d.source !== A2MCP_SOURCE) throw new Error(`${ERR_INVALID_INTENT}: unsupported source or version`);
    if (d.paymentId === '' || d.probeId === '' || d.ownerAccountId === '' || d.payerAddress === '') throw new Error(`${ERR_INVALID_INTENT}: missing identity field`);
    if (BigInt(d.createdAt) >= BigInt(d.expiresAt) || d.execution.signatureAttempts > 3) throw new Error(`${ERR_INVALID_INTENT}: invalid lifetime or signature attempts`);
    if (!d.frozenRequest.rebuild().equals(d.frozenRequest)) throw new Error(`${ERR_INVALID_INTENT}: frozen request is inconsistent`);
    const s = d.selectedAccept.d;
    const checked = A2mcpSelectedAcceptV1.tryFromPreparedCandidate({
      candidateId: 'persisted', rawAccept: cloneValue(s.raw), symbol: s.symbol, network: s.network, chainId: '', chainName: '', isMainnet: true,
      scheme: s.scheme, amountAtomic: s.amount, amountDisplay: '', decimals: s.decimals, authorizationType: s.authorizationType,
      balanceStatus: s.balanceStatus, availableAmount: '', requiredAmount: '', shortfall: '', depositAddress: '',
    });
    if (!checked.equals(d.selectedAccept)) throw new Error(`${ERR_INVALID_INTENT}: selected accept fields disagree with raw entry`);
  }

  toStruct() {
    const d = this.d;
    return struct({
      version: d.version, source: d.source, paymentId: d.paymentId, probeId: d.probeId, ownerAccountId: d.ownerAccountId,
      payerAddress: d.payerAddress, frozenRequest: d.frozenRequest.toStruct(), selectedAccept: d.selectedAccept.toStruct(),
      execution: struct({ state: d.execution.state, signatureAttempts: d.execution.signatureAttempts }),
      createdAt: d.createdAt, expiresAt: d.expiresAt,
    });
  }

  // upstream: A2mcpPaymentIntentV1::write (private) — re-validates, then atomic 0600 write.
  write() {
    this.validate();
    const body = stringify(this.toStruct(), true);
    atomicWriteContext(state.statePath(this.d.paymentId), body, 'write A2MCP payment intent');
  }
}

// home.rs::atomic_write(path, body, sensitive = true) under the caller's `.context(ctx)`: the parent
// dir is ensured (0700 on unix), `<file>.tmp` is written (chmod 600 on unix), then renamed.
function atomicWriteContext(path, body, ctx) {
  const io = (msg, e) => context(ctx, context(msg, new Error(ioErrorText(e))));
  const unix = process.platform !== 'win32';
  const parent = dirname(path);
  if (!existsSync(parent)) { try { mkdirSync(parent, { recursive: true }); } catch (e) { throw io(`failed to create directory ${parent}`, e); } }
  if (unix) {
    let mode;
    try { mode = statSync(parent).mode & 0o777; } catch (e) { throw io(`failed to read metadata for ${parent}`, e); }
    if (mode !== 0o700) { try { chmodSync(parent, 0o700); } catch (e) { throw io(`failed to set 0700 on ${parent}`, e); } }
  }
  const tmp = `${path}.tmp`;
  try { writeFileSync(tmp, Buffer.from(body, 'utf8')); } catch (e) { throw io(`failed to write temp file ${tmp}`, e); }
  if (unix) { try { chmodSync(tmp, 0o600); } catch (e) { throw io(`failed to set 600 on ${tmp}`, e); } }
  try { renameSync(tmp, path); } catch (e) { throw io(`failed to rename ${tmp} to ${path}`, e); }
}

// upstream: a2mcp.rs::create_a2mcp_payment_intent — input {probeId, ownerAccountId, payerAddress,
// frozenRequest, selectedAccept, createdAt, expiresAt (challenge expiry or 0), userConfirmed}.
export function createA2mcpPaymentIntent(input) {
  if (!input.userConfirmed) throw new Error(`${ERR_CONFIRMATION_REQUIRED}: explicit confirmation is required`);
  if (input.selectedAccept.d.balanceStatus !== 'sufficient') throw new Error(`${ERR_INSUFFICIENT_BALANCE}: selected token balance is not sufficient`);
  const expiresAt = computeExpiresAt(input.expiresAt, input.createdAt);
  const paymentId = paymentIdForProbe(input.probeId, input.ownerAccountId);
  if (existsSync(state.statePath(paymentId))) throw new Error(`${ERR_ALREADY_CREATED}: ${input.probeId}`);
  const intent = new A2mcpPaymentIntentV1({
    version: A2MCP_INTENT_VERSION, source: A2MCP_SOURCE, paymentId, probeId: input.probeId, ownerAccountId: input.ownerAccountId,
    payerAddress: input.payerAddress, frozenRequest: input.frozenRequest, selectedAccept: input.selectedAccept,
    execution: { state: A2mcpExecutionState.Prepared, signatureAttempts: 0 }, createdAt: input.createdAt, expiresAt,
  });
  intent.write();
  return intent;
}

// upstream: a2mcp.rs::compute_expires_at (private) — min(challenge expiry, created_at + 300).
export function computeExpiresAt(challengeExpiresAt, createdAt) {
  const ch = BigInt(challengeExpiresAt), created = BigInt(createdAt);
  if (ch !== 0n && ch <= created) throw new Error(`${ERR_EXPIRED}: challenge expired`);
  let local = created + BigInt(state.MAX_QUOTE_TTL_SECS);
  if (local > U64_MAX) local = U64_MAX;
  return jsonInt(ch === 0n ? local : (ch < local ? ch : local));
}

// upstream: a2mcp.rs::payment_id_for_probe (private) — "pay_" + 24 hex of sha256(source‖0‖probe‖0‖owner).
export function paymentIdForProbe(probeId, ownerAccountId) {
  const h = createHash('sha256');
  h.update(A2MCP_SOURCE); h.update(Buffer.from([0])); h.update(String(probeId)); h.update(Buffer.from([0])); h.update(String(ownerAccountId));
  return `pay_${h.digest('hex').slice(0, 24)}`;
}

// upstream: a2mcp.rs::inspect_payment_source
export function inspectPaymentSource(paymentId) {
  validatePaymentId(paymentId);
  const path = state.statePath(paymentId);
  let bytes;
  try { bytes = readFileSync(path); } catch (e) { throw context(`${state.TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${paymentId}`, new Error(ioErrorText(e))); }
  let value;
  try { value = fromSlice(bytes); } catch (e) { throw context(`${state.TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${paymentId}`, e); }
  const source = asStr(get(value, 'source'));
  if (source === undefined) return A2mcpPaymentSource.GenericQuote;
  if (source === A2MCP_SOURCE) return A2mcpPaymentSource.OkxAiA2mcp;
  throw new Error(`${ERR_INVALID_INTENT}: unknown payment source`);
}

// serde_json::from_slice::<T>(bytes) for the persisted A2MCP structs (throws on any serde error).
function strictFromSlice(bytes, schema) {
  return decode(schema, fromSlice(bytes, serdeT(schema)));
}

// Strict serde decode of a persisted intent file → A2mcpPaymentIntentV1 (throws on any mismatch).
function decodeIntent(bytes) {
  const d = strictFromSlice(bytes, INTENT);
  d.frozenRequest = new A2mcpFrozenRequestV1(d.frozenRequest);
  d.selectedAccept = new A2mcpSelectedAcceptV1(d.selectedAccept);
  d.version = jsonInt(d.version); d.createdAt = jsonInt(d.createdAt); d.expiresAt = jsonInt(d.expiresAt);
  return new A2mcpPaymentIntentV1(d);
}

// upstream: a2mcp.rs::read_a2mcp_payment_intent — validated intent owned by `currentOwnerAccountId`;
// an expired intent is persisted as `expired` before failing.
export function readA2mcpPaymentIntent(paymentId, currentOwnerAccountId, now) {
  if (inspectPaymentSource(paymentId) !== A2mcpPaymentSource.OkxAiA2mcp) throw new Error(`${ERR_INVALID_INTENT}: payment state is not an A2MCP intent`);
  let bytes;
  try { bytes = readFileSync(state.statePath(paymentId)); } catch (e) { throw new Error(ioErrorText(e)); }
  let intent;
  try { intent = decodeIntent(bytes); } catch { throw new Error(`${ERR_INVALID_INTENT}: malformed intent`); }
  intent.validate();
  if (intent.d.ownerAccountId !== currentOwnerAccountId) throw new Error(`${state.TOKEN_CROSS_USER}: ${paymentId}`);
  if (BigInt(now) >= BigInt(intent.d.expiresAt)) {
    intent.d.execution.state = A2mcpExecutionState.Expired;
    intent.write();
    throw new Error(`${ERR_EXPIRED}: ${paymentId}`);
  }
  return intent;
}

// upstream: a2mcp.rs::validate_payment_id (private) — [A-Za-z0-9_-]{1,128}
export function validatePaymentId(paymentId) {
  const id = String(paymentId);
  if (id === '' || Buffer.byteLength(id) > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${ERR_INVALID_INTENT}: invalid payment id`);
}

// ── A2mcpConfirmationContextV1 ───────────────────────────────────────

// upstream: a2mcp.rs::A2mcpConfirmationContextV1
export class A2mcpConfirmationContextV1 {
  constructor(d = { serviceId: '' }) { this.d = d; }
  static new(serviceId, serviceName, providerAgentId, aspAmount, aspSymbol) {
    return new A2mcpConfirmationContextV1({
      serviceId, serviceName: serviceName ?? undefined, providerAgentId: providerAgentId ?? undefined,
      aspAmount: aspAmount ?? undefined, aspSymbol: aspSymbol ?? undefined,
    });
  }
  serviceId() { return this.d.serviceId; }
  serviceName() { return this.d.serviceName ?? null; }
  providerAgentId() { return this.d.providerAgentId ?? null; }
  aspAmount() { return this.d.aspAmount ?? null; }
  aspSymbol() { return this.d.aspSymbol ?? null; }
  toStruct() { return struct(Object.fromEntries(CONFIRMATION_FIELDS.map(([k]) => [k, this.d[k] ?? undefined]))); }
}

// ── A2mcpPreparedPayment ─────────────────────────────────────────────

// upstream: a2mcp.rs::A2mcpPreparedPayment — built only by decoding a challenge.
export class A2mcpPreparedPayment {
  constructor(d) { this.d = d; }
  frozenRequest() { return this.d.frozenRequest; }
  confirmationContext() { return this.d.confirmationContext; }
  candidates() { return this.d.candidates; }
  challengeExpiresAt() { return this.d.challengeExpiresAt; }
  walletError() { return this.d.walletError ?? null; }
  fundingCandidateId() { return this.d.fundingCandidateId ?? null; }

  // upstream: A2mcpPreparedPayment::mark_funding_continuation
  markFundingContinuation(candidateId) {
    const c = this.d.candidates.find((x) => x.d.candidateId === candidateId);
    if (!c) throw new Error(`${ERR_INVALID_INTENT}: unknown candidate`);
    if (c.d.balanceStatus === 'sufficient') throw new Error('a2mcp_funding_not_required: selected candidate is sufficient');
    this.d.fundingCandidateId = candidateId;
  }

  // upstream: A2mcpPreparedPayment::clear_funding_continuation
  clearFundingContinuation() { this.d.fundingCandidateId = undefined; }

  // upstream: A2mcpPreparedPayment::select
  select(candidateId) {
    this.validate();
    const c = this.d.candidates.find((x) => x.d.candidateId === candidateId);
    if (!c) throw new Error(`${ERR_INVALID_INTENT}: unknown candidate`);
    return A2mcpSelectedAcceptV1.tryFromPreparedCandidate(c.clone());
  }

  // upstream: A2mcpPreparedPayment::validate (private)
  validate() {
    const d = this.d;
    if (Number(d.version) !== A2MCP_INTENT_VERSION || d.source !== A2MCP_SOURCE) throw new Error(`${ERR_INVALID_INTENT}: invalid prepared payload source or version`);
    if (!d.frozenRequest.rebuild().equals(d.frozenRequest)) throw new Error(`${ERR_INVALID_INTENT}: frozen request is inconsistent`);
    if (!d.candidates.length) throw new Error(`${ERR_INVALID_INTENT}: prepared payload has no candidates`);
    if (d.fundingCandidateId !== undefined && !d.candidates.some((c) => c.d.candidateId === d.fundingCandidateId)) {
      throw new Error(`${ERR_INVALID_INTENT}: invalid Funding continuation`);
    }
    for (const c of d.candidates) {
      if (c.d.candidateId === '' || !['sufficient', 'insufficient', 'unavailable'].includes(c.d.balanceStatus)) {
        throw new Error(`${ERR_INVALID_INTENT}: invalid prepared candidate`);
      }
      const selected = A2mcpSelectedAcceptV1.tryFromPreparedCandidate(c.clone());
      if (selected.d.network !== c.d.network || selected.d.scheme !== c.d.scheme || selected.d.amount !== c.d.amountAtomic) {
        throw new Error(`${ERR_INVALID_INTENT}: candidate display fields disagree with raw entry`);
      }
    }
  }

  clone() {
    return new A2mcpPreparedPayment({
      ...this.d, frozenRequest: this.d.frozenRequest.clone(), confirmationContext: new A2mcpConfirmationContextV1({ ...this.d.confirmationContext.d }),
      candidates: this.d.candidates.map((c) => c.clone()),
    });
  }

  toStruct() {
    const d = this.d;
    return struct({
      version: d.version, source: d.source, frozenRequest: d.frozenRequest.toStruct(), confirmationContext: d.confirmationContext.toStruct(),
      candidates: d.candidates.map((c) => c.toStruct()), challengeExpiresAt: d.challengeExpiresAt, walletError: d.walletError ?? undefined,
      fundingCandidateId: d.fundingCandidateId ?? undefined,
    });
  }
}

// ── prepared state files ─────────────────────────────────────────────

// upstream: a2mcp.rs::validate_prepared_id (private) — "a2prep_" + 32 hex.
export function validatePreparedId(preparedId) {
  const id = String(preparedId);
  if (!id.startsWith(A2MCP_PREPARED_ID_PREFIX)) throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${id}`);
  const suffix = id.slice(A2MCP_PREPARED_ID_PREFIX.length);
  if (Buffer.byteLength(suffix) !== 32 || !/^[0-9a-fA-F]*$/.test(suffix)) throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${id}`);
}

function decodePreparedState(bytes) {
  const s = strictFromSlice(bytes, PREPARED_STATE);
  const p = s.prepared;
  p.frozenRequest = new A2mcpFrozenRequestV1(p.frozenRequest);
  p.confirmationContext = new A2mcpConfirmationContextV1(p.confirmationContext);
  p.candidates = p.candidates.map((c) => new A2mcpPreparedCandidate({ ...c, decimals: jsonInt(c.decimals) }));
  p.version = jsonInt(p.version); p.challengeExpiresAt = jsonInt(p.challengeExpiresAt);
  s.prepared = new A2mcpPreparedPayment(p);
  s.version = jsonInt(s.version); s.createdAt = jsonInt(s.createdAt); s.expiresAt = jsonInt(s.expiresAt);
  return s;
}

// upstream: a2mcp.rs::A2mcpPreparedStateV1::validate (private)
function validatePreparedState(s, preparedId, ownerAccountId, now) {
  if (Number(s.version) !== A2MCP_INTENT_VERSION || s.source !== A2MCP_PREPARED_SOURCE || s.preparedId !== preparedId) {
    throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${preparedId}`);
  }
  if (s.ownerAccountId !== ownerAccountId) throw new Error(`${state.TOKEN_CROSS_USER}: ${preparedId}`);
  if (BigInt(now) >= BigInt(s.expiresAt)) throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${preparedId}`);
  s.prepared.validate();
}

// upstream: a2mcp.rs::read_prepared_state (private)
function readPreparedState(path, preparedId, ownerAccountId, now) {
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${preparedId}`); }
  let s;
  try { s = decodePreparedState(bytes); } catch { throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${preparedId}`); }
  validatePreparedState(s, preparedId, ownerAccountId, now);
  return s;
}

const preparedStateStruct = (s) => struct({
  version: s.version, source: s.source, preparedId: s.preparedId, ownerAccountId: s.ownerAccountId, createdAt: s.createdAt,
  expiresAt: s.expiresAt, prepared: s.prepared.toStruct(),
});

// upstream: a2mcp.rs::store_a2mcp_prepared_payment → preparedId
export function storeA2mcpPreparedPayment(prepared, ownerAccountId, createdAt) {
  if (ownerAccountId === '' || ownerAccountId == null) throw new Error('wallet_login_required: no selected wallet');
  prepared.validate();
  const expiresAt = computeExpiresAt(prepared.d.challengeExpiresAt, createdAt);
  return writeA2mcpPreparedState(prepared, ownerAccountId, createdAt, expiresAt);
}

// upstream: a2mcp.rs::write_a2mcp_prepared_state (private)
function writeA2mcpPreparedState(prepared, ownerAccountId, createdAt, expiresAt) {
  const preparedId = `${A2MCP_PREPARED_ID_PREFIX}${randomUUID().replace(/-/g, '')}`;
  const s = { version: A2MCP_INTENT_VERSION, source: A2MCP_PREPARED_SOURCE, preparedId, ownerAccountId, createdAt, expiresAt, prepared };
  atomicWriteContext(state.statePath(preparedId), stringify(preparedStateStruct(s), true), 'write A2MCP prepared state');
  return preparedId;
}

const startsWithExpired = (e) => String(e?.message ?? e).startsWith(ERR_PREPARED_EXPIRED_OR_MISSING);

// upstream: a2mcp.rs::load_a2mcp_prepared_payment — expired/missing handles are deleted.
export function loadA2mcpPreparedPayment(preparedId, ownerAccountId, now) {
  validatePreparedId(preparedId);
  const path = state.statePath(preparedId);
  try { return readPreparedState(path, preparedId, ownerAccountId, now).prepared; } catch (e) {
    if (startsWithExpired(e)) { try { rmSync(path); } catch {} }
    throw e;
  }
}

// upstream: a2mcp.rs::replace_a2mcp_prepared_payment → new preparedId (original lifetime kept)
export function replaceA2mcpPreparedPayment(preparedId, prepared, ownerAccountId, now) {
  prepared.validate();
  const claim = claimA2mcpPreparedPayment(preparedId, ownerAccountId, now);
  try { return claim.replace(prepared); } finally { claim.drop(); }
}

// upstream: a2mcp.rs::A2mcpPreparedClaim — call drop() unless commit()/replace() finalized it.
export class A2mcpPreparedClaim {
  constructor(canonicalPath, claimPath, s) { Object.assign(this, { canonicalPath, claimPath, state: s, finalized: false }); }
  prepared() { return this.state.prepared; }

  // upstream: A2mcpPreparedClaim::replace — a write failure leaves the claim unfinalized.
  replace(prepared) {
    prepared.validate();
    const replacement = writeA2mcpPreparedState(prepared, this.state.ownerAccountId, this.state.createdAt, this.state.expiresAt);
    try { rmSync(this.claimPath); } catch {}
    this.finalized = true;
    return replacement;
  }

  // upstream: A2mcpPreparedClaim::commit — one-time consumption.
  commit() {
    try { rmSync(this.claimPath); } catch {}
    this.finalized = true;
  }

  // upstream: impl Drop for A2mcpPreparedClaim — restore the canonical handle when unfinalized.
  drop() {
    if (!this.finalized) { try { renameSync(this.claimPath, this.canonicalPath); } catch {} this.finalized = true; }
  }
}

// upstream: a2mcp.rs::claim_a2mcp_prepared_payment
export function claimA2mcpPreparedPayment(preparedId, ownerAccountId, now) {
  validatePreparedId(preparedId);
  const canonicalPath = state.statePath(preparedId);
  try { readPreparedState(canonicalPath, preparedId, ownerAccountId, now); } catch (e) {
    if (startsWithExpired(e)) { try { rmSync(canonicalPath); } catch {} }
    throw e;
  }
  const claimPath = join(dirname(canonicalPath), `.${preparedId}.claim-${randomUUID().replace(/-/g, '')}`);
  try { renameSync(canonicalPath, claimPath); } catch { throw new Error(`${ERR_PREPARED_EXPIRED_OR_MISSING}: ${preparedId}`); }
  let s;
  try { s = readPreparedState(claimPath, preparedId, ownerAccountId, now); } catch (e) {
    try { renameSync(claimPath, canonicalPath); } catch {}
    throw e;
  }
  return new A2mcpPreparedClaim(canonicalPath, claimPath, s);
}

// upstream: a2mcp.rs::consume_a2mcp_prepared_payment
export function consumeA2mcpPreparedPayment(preparedId, ownerAccountId, now) {
  const claim = claimA2mcpPreparedPayment(preparedId, ownerAccountId, now);
  const prepared = claim.prepared().clone();
  claim.commit();
  return prepared;
}

// ── challenge → prepared payment ─────────────────────────────────────

// upstream: a2mcp.rs::prepare_a2mcp_payment_from_challenge — input {challenge (string),
// frozenRequest, confirmationContext}. Decodes the challenge, applies the asset/scheme policy and
// queries balances (basic-info + DEX balances) without writing generic PaymentState.
export async function prepareA2mcpPaymentFromChallenge(input) {
  const decoded = decodePaymentBlob(input.challenge);
  const accepts = get(decoded, 'accepts');
  if (!Array.isArray(accepts)) throw new Error('a2mcp_unsupported_payment_asset: challenge has no accepts');
  const rawAccepts = cloneValue(accepts);
  const [prepared, walletError] = await prepareA2mcpCandidates(rawAccepts);
  const byToken = brandCandidates(prepared, rawAccepts);
  if (!byToken.length) throw new Error('a2mcp_unsupported_payment_asset: no supported token/scheme candidate');
  const frozenRequest = input.frozenRequest.clone();
  const res = get(decoded, 'resource');
  frozenRequest.d.resource = res === undefined ? undefined : cloneValue(res);
  let candidateExpiry = null;
  for (const c of byToken) {
    const e = parseUnixValue(get(c.d.rawAccept, 'expires')) ?? parseUnixValue(get(c.d.rawAccept, 'validBefore'));
    if (e !== undefined && (candidateExpiry === null || e < candidateExpiry)) candidateExpiry = e;
  }
  candidateExpiry = candidateExpiry ?? 0n;
  const ce = get(decoded, 'expires');
  const challengeExpiry = ce === undefined || ce === null ? 0n : parseChallengeExpiry(ce);
  let challengeExpiresAt;
  if (challengeExpiry === 0n) challengeExpiresAt = candidateExpiry;
  else if (candidateExpiry === 0n) challengeExpiresAt = challengeExpiry;
  else challengeExpiresAt = challengeExpiry < candidateExpiry ? challengeExpiry : candidateExpiry;
  return new A2mcpPreparedPayment({
    version: A2MCP_INTENT_VERSION, source: A2MCP_SOURCE, frozenRequest, confirmationContext: input.confirmationContext,
    candidates: byToken, challengeExpiresAt: jsonInt(challengeExpiresAt), walletError: walletError ?? undefined, fundingCandidateId: undefined,
  });
}

// upstream: a2mcp.rs::refresh_a2mcp_prepared_payment — balance preflight only (no token metadata,
// no Endpoint call, no new challenge); candidate metadata is kept.
export async function refreshA2mcpPreparedPayment(prepared) {
  const rawAccepts = prepared.d.candidates.map((c) => cloneValue(c.d.rawAccept));
  const balanceCandidates = prepared.d.candidates.map((c, i) => ({
    scheme: c.d.scheme, acceptsIndex: i, chainId: c.d.chainId, chainName: c.d.chainName, isMainnet: c.d.isMainnet, tokenSymbol: c.d.symbol,
    amount: c.d.amountAtomic, amountHuman: c.d.amountDisplay, decimals: c.d.decimals, hasBalance: false, balanceStatus: 'unavailable',
    availableAmount: '', requiredAmount: c.d.requiredAmount, shortfall: '', depositAddress: c.d.depositAddress, recommended: null,
  }));
  const walletError = await refreshA2mcpCandidateBalances(balanceCandidates, rawAccepts);
  const candidates = prepared.d.candidates.map((c) => c.clone());
  applyBalanceRefresh(candidates, balanceCandidates);
  const refreshed = new A2mcpPreparedPayment({
    version: prepared.d.version, source: prepared.d.source, frozenRequest: prepared.d.frozenRequest.clone(),
    confirmationContext: prepared.d.confirmationContext, candidates, challengeExpiresAt: prepared.d.challengeExpiresAt,
    walletError: walletError ?? undefined, fundingCandidateId: prepared.d.fundingCandidateId,
  });
  refreshed.validate();
  return refreshed;
}

// upstream: a2mcp.rs::apply_balance_refresh (private) — copies only the balance fields.
export function applyBalanceRefresh(candidates, balanceCandidates) {
  if (candidates.length !== balanceCandidates.length) throw new Error(`${ERR_INVALID_INTENT}: candidate set changed during balance refresh`);
  candidates.forEach((c, i) => {
    const b = balanceCandidates[i];
    Object.assign(c.d, {
      balanceStatus: b.balanceStatus, availableAmount: b.availableAmount, requiredAmount: b.requiredAmount, shortfall: b.shortfall,
      depositAddress: b.depositAddress,
    });
  });
}

// upstream: a2mcp.rs::parse_unix_value (private) — u64 number or decimal string → BigInt | undefined
export function parseUnixValue(value) {
  const n = asU64(value);
  if (n !== undefined) return BigInt(n);
  if (typeof value === 'string') return intFromStrOk(value, 'u64');
  return undefined;
}

// upstream: a2mcp.rs::parse_challenge_expiry (private) — u64 / numeric string / RFC 3339 → BigInt seconds
export function parseChallengeExpiry(value) {
  const unix = parseUnixValue(value);
  if (unix !== undefined) return unix;
  if (typeof value !== 'string') throw new Error(`${ERR_INVALID_INTENT}: invalid challenge expiry`);
  let ts;
  try { ts = parseFromRfc3339(value).secs; } catch { throw new Error(`${ERR_INVALID_INTENT}: invalid challenge expiry`); }
  if (ts < 0n) throw new Error(`${ERR_INVALID_INTENT}: invalid challenge expiry`);
  return ts;
}

const byteCmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// upstream: a2mcp.rs::brand_candidates (private) — one candidate per (network, asset) keeping the
// best scheme priority; result ordered by key (BTreeMap). `prepared` = quote Candidate objects.
export function brandCandidates(prepared, rawAccepts) {
  const byToken = new Map();
  for (const c of prepared) {
    const raw = rawAccepts[Number(c.acceptsIndex)];
    if (raw === undefined) throw new Error(`${ERR_INVALID_INTENT}: candidate index out of range`);
    const authorizationType = classifyAuthorization(raw);
    if (authorizationType === null) continue;
    const network = requiredStr(raw, 'network');
    const branded = new A2mcpPreparedCandidate({
      candidateId: `candidate_${c.acceptsIndex}`, rawAccept: cloneValue(raw), symbol: asciiUpper(c.tokenSymbol), network,
      chainId: c.chainId, chainName: c.chainName, isMainnet: c.isMainnet, scheme: asciiLower(c.scheme), amountAtomic: c.amount,
      amountDisplay: c.amountHuman, decimals: c.decimals, authorizationType, balanceStatus: c.balanceStatus,
      availableAmount: c.availableAmount, requiredAmount: c.requiredAmount, shortfall: c.shortfall, depositAddress: c.depositAddress,
    });
    if (!STABLE.includes(branded.d.symbol)) continue;
    const key = [requiredStr(branded.d.rawAccept, 'network'), asciiLower(requiredStr(branded.d.rawAccept, 'asset'))];
    const k = `${key[0]}\u0000${key[1]}`;
    const current = byToken.get(k);
    if (current && schemePriority(current[1]) <= schemePriority(branded)) continue;
    byToken.set(k, [key, branded]);
  }
  return [...byToken.values()].sort((a, b) => byteCmp(a[0][0], b[0][0]) || byteCmp(a[0][1], b[0][1])).map(([, c]) => c);
}

// upstream: a2mcp.rs::classify_authorization (private) → 'eip3009' | 'permit2' | 'session' | null
export function classifyAuthorization(raw) {
  const s = asStr(get(raw, 'scheme'));
  if (s === undefined) return null;
  const scheme = asciiLower(s);
  const transfer = asciiLower(asStr(get(get(raw, 'extra'), 'assetTransferMethod')) ?? '');
  if (scheme === 'exact' && ['', 'eip3009', 'eip-3009'].includes(transfer)) return 'eip3009';
  if ((scheme === 'exact' || scheme === 'upto') && transfer === 'permit2') return 'permit2';
  if (scheme === 'aggr_deferred' && ['', 'session'].includes(transfer)) return 'session';
  return null;
}

// upstream: a2mcp.rs::scheme_priority (private)
export function schemePriority(candidate) {
  const d = candidate instanceof A2mcpPreparedCandidate ? candidate.d : candidate;
  const scheme = asciiLower(asStr(get(d.rawAccept, 'scheme')) ?? '');
  return { 'exact/eip3009': 0, 'exact/permit2': 1, 'upto/permit2': 2, 'aggr_deferred/session': 3 }[`${scheme}/${d.authorizationType}`] ?? 255;
}
