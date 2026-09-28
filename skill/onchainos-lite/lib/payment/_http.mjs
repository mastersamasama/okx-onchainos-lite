// PRIVATE — a `reqwest::Client` stand-in for the payment flows that talk to hosts other than the
// OKX origin (merchant probe / replay, MCP endpoints, the X Layer RPC). Same wire behaviour as a
// default reqwest 0.12 client built with `default-features = false`: only `accept: */*` is added,
// no user-agent; redirects follow reqwest's default policy (≤ 10 hops, 301/302/303 → GET without
// body, Referer added, sensitive headers dropped cross-host) unless `redirect: 'none'`.
// Errors are ReqwestError whose message is reqwest's `Display` (`e.to_string()`).
import { request as transport } from '../core/transport.mjs';
import { ReqwestError, hrefOf } from './_rs.mjs';

const SENSITIVE = ['authorization', 'cookie', 'proxy-authorization', 'www-authenticate'];
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// http::HeaderValue::from_str — visible ASCII / obs-text / tab; bytes go out as latin1.
export function headerValueOk(v) {
  const b = Buffer.from(String(v), 'utf8');
  return !b.some((x) => (x < 0x20 && x !== 0x09) || x === 0x7f);
}
export const headerNameOk = (k) => TOKEN.test(String(k));

// Builder-level validation (reqwest RequestBuilder records the first error; send() returns it).
export function checkRequest({ url, headers = [] }) {
  let u;
  try { u = new URL(url); } catch { throw new ReqwestError('builder error'); }
  if (!u.host) throw new ReqwestError('builder error', u.href);
  for (const [k, v] of headers) if (!headerNameOk(k) || !headerValueOk(v)) throw new ReqwestError('builder error');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ReqwestError('builder error', u.href);
  return u;
}

// headers: [[name, value], …] (order kept; names lowercased like hyper).
export async function send({ method = 'GET', url, headers = [], body, timeoutMs = 30000, redirect = 'follow' }) {
  let u = checkRequest({ url, headers });
  let m = String(method);
  let payload = body === undefined || body === null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  let hdrs = headers.map(([k, v]) => [String(k).toLowerCase(), Buffer.from(String(v), 'utf8').toString('latin1')]);
  if (!hdrs.some(([k]) => k === 'accept')) hdrs.push(['accept', '*/*']);
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const obj = {};
    for (const [k, v] of hdrs) obj[k] = obj[k] === undefined ? v : `${obj[k]}, ${v}`;
    let r;
    try {
      r = await transport({ method: m, url: u.href, headers: obj, body: payload, timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch (e) {
      throw new ReqwestError('error sending request', u.href, e);
    }
    if (redirect !== 'follow' || ![301, 302, 303, 307, 308].includes(r.status)) return { ...r, url: u.href };
    const loc = r.headers.location;
    if (!loc) return { ...r, url: u.href };
    let next;
    try { next = new URL(Array.isArray(loc) ? loc[0] : loc, u); } catch { return { ...r, url: u.href }; }
    if (hop + 1 > 10) throw new ReqwestError('error following redirect', next.href);
    if ([301, 302, 303].includes(r.status)) {
      payload = undefined;
      hdrs = hdrs.filter(([k]) => !['transfer-encoding', 'content-encoding', 'content-type', 'content-length'].includes(k));
      if (m !== 'GET' && m !== 'HEAD') m = 'GET';
    }
    if (next.host !== u.host || next.protocol !== u.protocol) hdrs = hdrs.filter(([k]) => !SENSITIVE.includes(k));
    if (!(u.protocol === 'https:' && next.protocol === 'http:')) {
      const ref = new URL(u.href); ref.username = ''; ref.password = ''; ref.hash = '';
      hdrs = hdrs.filter(([k]) => k !== 'referer');
      hdrs.push(['referer', ref.href]);
    }
    u = next;
  }
}

// Response header lookup (case-insensitive name; `to_str()` fails on non-visible-ASCII values).
export function headerStr(r, name) {
  const v = r.headers[String(name).toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return undefined;
  return /^[\t\x20-\x7e]*$/.test(s) ? s : undefined;
}
// resp.text() — lossy UTF-8.
export const text = (r) => r.body.toString('utf8');
export { hrefOf };
