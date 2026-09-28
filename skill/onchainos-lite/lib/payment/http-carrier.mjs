// Carrier-aware HTTP request assembly for the two-phase payment flow — upstream
// commands/payment/http_carrier.rs. Each business param rides on its declared carrier
// (query | body | header | path); the result is a request description for _http.mjs `send`
// ({method, url, headers:[[k, v]], body?}) — the stand-in for upstream's reqwest RequestBuilder.
import { stringify } from '../core/json.mjs';
import { asciiUpper } from '../core/_rust-str.mjs';
import { ParamCarrier } from './state.mjs';
import { isObj, isNum, numText, ReqwestError } from './_rs.mjs';

const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// upstream: http_carrier.rs::is_body_bearing
export const isBodyBearing = (method) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(asciiUpper(method));

// upstream: http_carrier.rs::carrier_for
export function carrierFor(name, plan, bodyBearing) {
  const spec = (plan ?? []).find((s) => s.name === name);
  if (spec) return spec.carrier ?? ParamCarrier.Query;
  return bodyBearing ? ParamCarrier.Body : ParamCarrier.Query;
}

// percent_encoding::utf8_percent_encode(v, NON_ALPHANUMERIC)
export function percentEncodeNonAlnum(v) {
  let out = '';
  for (const b of Buffer.from(String(v), 'utf8')) {
    out += (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// reqwest RequestBuilder::query → url::Url::query_pairs_mut().extend_pairs (form-urlencoded,
// appended with '&' after an existing non-empty query).
export function appendQuery(url, pairs) {
  let u;
  try { u = new URL(url); } catch { return { url, error: true }; }
  const enc = new URLSearchParams(pairs.map(([k, v]) => [String(k), String(v)])).toString();
  const hash = u.hash;
  const base = u.href.slice(0, u.href.length - hash.length);
  const q = base.indexOf('?');
  let out;
  if (q < 0) out = `${base}?${enc}`;
  else out = base.length > q + 1 ? `${base}&${enc}` : `${base}${enc}`;
  return { url: out + hash };
}

// Method::from_bytes — an HTTP token (any case kept verbatim by `from_bytes`).
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// upstream: http_carrier.rs::build_request(method, url, params [[k, v]], plan)
export function buildRequest(method, url, params, plan) {
  const bodyBearing = isBodyBearing(method);
  let finalUrl = String(url);
  const query = [], body = {}, headers = [];
  let hasBody = false;
  for (const [k, v] of params) {
    switch (carrierFor(k, plan, bodyBearing)) {
      case ParamCarrier.Path: finalUrl = finalUrl.split(`{${k}}`).join(percentEncodeNonAlnum(v)); break;
      case ParamCarrier.Query: query.push([k, v]); break;
      case ParamCarrier.Body: body[k] = String(v); hasBody = true; break;
      case ParamCarrier.Header: headers.push([k, v]); break;
      default: query.push([k, v]);
    }
  }
  const up = asciiUpper(method);
  const m = METHOD_TOKEN.test(up) ? up : 'GET';
  const req = { method: m, url: finalUrl, headers };
  if (query.length) {
    const q = appendQuery(finalUrl, query);
    req.url = q.url;
  }
  if (bodyBearing && hasBody) {
    req.body = stringify(body);
    req.headers.unshift(['content-type', 'application/json']);
  }
  return req;
}

// upstream: http_carrier.rs::scalar_text (private) — null / bool / number / string → text.
export function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (isNum(value)) return numText(value);
  if (typeof value === 'string') return value;
  return undefined;
}

// upstream: http_carrier.rs::build_typed_request (A2MCP) — typed JSON body, fail-closed schema checks.
export function buildTypedRequest(method, url, params, plan) {
  const bodyBearing = isBodyBearing(method);
  if (!METHOD_TOKEN.test(String(method))) throw new Error('a2mcp_invalid_typed_params: invalid HTTP method');
  let finalUrl = String(url);
  const query = [], body = {}, headers = [];
  let hasBody = false;
  // `params` is a serde_json::Map (BTreeMap): iterate keys in byte order, not insertion order —
  // it fixes the query-string / header order and which bad key is reported first.
  const obj = isObj(params) ? params : {};
  for (const key of Object.keys(obj).sort(byteCmp)) {
    const value = obj[key];
    if (value === undefined) continue;
    const carrier = carrierFor(key, plan, bodyBearing);
    if (carrier === ParamCarrier.Body) {
      if (!bodyBearing) throw new Error(`a2mcp_invalid_typed_params: body parameter '${key}' is invalid for ${method}`);
      body[key] = value; hasBody = true;
      continue;
    }
    const scalar = scalarText(value);
    if (scalar === undefined) throw new Error(`a2mcp_invalid_typed_params: non-body parameter '${key}' must be scalar`);
    if (carrier === ParamCarrier.Path) {
      const placeholder = `{${key}}`;
      if (!finalUrl.includes(placeholder)) throw new Error(`a2mcp_invalid_typed_params: path placeholder '${placeholder}' is missing`);
      finalUrl = finalUrl.split(placeholder).join(percentEncodeNonAlnum(scalar));
    } else if (carrier === ParamCarrier.Query) query.push([key, scalar]);
    else headers.push([key, scalar]);
  }
  const req = { method: String(method), url: finalUrl, headers };
  if (query.length) req.url = appendQuery(finalUrl, query).url;
  if (bodyBearing && (hasBody || /^post$/i.test(String(method)))) {
    req.body = stringify(body);
    req.headers.unshift(['content-type', 'application/json']);
  }
  return req;
}
export { ReqwestError };
