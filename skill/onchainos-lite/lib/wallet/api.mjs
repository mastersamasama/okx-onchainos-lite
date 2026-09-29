// Agentic-wallet API client — upstream wallet_api.rs.
// Transport, envelope handling, the invalid-token force-refresh retry and every endpoint
// wrapper. Response structs are decoded with serde semantics (serde-json error texts) into
// plain objects keyed by their JSON (camelCase) names.
//
// Divergence (documented in docs/PARITY.md): the DoH failover/proxy layer of upstream is not
// reproduced; a connect/timeout error surfaces directly with the same leading context text.
import { request as transport } from '../core/transport.mjs';
import { stringify, F64, formatF64 } from '../core/json.mjs';
import { fromStr, unexpected } from '../core/serde.mjs';
import { trim } from '../core/rs/str.mjs';
import { anonymousHeaders, jwtHeaders, USER_AGENT, baseUrl } from '../core/http.mjs';
import { CliError, context } from '../core/errors.mjs';
import * as keyring from '../core/keyring.mjs';

// reqwest client timeout (WalletApiClient::build).
export const WALLET_HTTP_TIMEOUT_MS = 30000;

// ── Errors ──────────────────────────────────────────────────────────

// upstream: wallet_api.rs::ApiCodeError — Display `Wallet API error (code=<code>): <msg>`.
export class ApiCodeError extends Error {
  constructor(code, msg, httpStatus) {
    super(`Wallet API error (code=${code}): ${msg}`);
    this.code = code;
    this.msg = msg;
    this.httpStatus = httpStatus;
  }
}

// anyhow's `e.to_string()` (Display without `#`) prints only the outermost message; our
// errors carry the whole `{:#}` chain in .message, so strip the cause part when present.
export function displayTop(e) {
  if (e instanceof CliError && e.cause) {
    const inner = `: ${e.cause.message ?? e.cause}`;
    if (e.message.endsWith(inner)) return e.message.slice(0, -inner.length);
  }
  return e?.message ?? String(e);
}

// ── serde-style decoding of response structs ────────────────────────
// Reproduces serde_json error texts for from_value (no line/column).

export class SerdeError extends Error {}

const invalidType = (v, exp) => new SerdeError(`invalid type: ${unexpected(v)}, expected ${exp}`);
const isInt = (v) => typeof v === 'number' || typeof v === 'bigint';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const cmpKeys = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// serde_json::Number Display.
export const numberText = (v) => (v instanceof F64 ? formatF64(v.valueOf()) : String(v));

// Field kinds (the deserializer each Rust field uses).
const K = {
  string: (v) => { if (typeof v !== 'string') throw invalidType(v, 'a string'); return v; },
  bool: (v) => { if (typeof v !== 'boolean') throw invalidType(v, 'a boolean'); return v; },
  value: (v) => v,
  u64: (v) => {
    if (typeof v === 'number' && Number.isInteger(v)) { if (v < 0) throw new SerdeError(`invalid value: integer \`${v}\`, expected u64`); return v; }
    if (typeof v === 'bigint') { if (v < 0n) throw new SerdeError(`invalid value: integer \`${v}\`, expected u64`); return v; }
    throw invalidType(v, 'u64');
  },
  // wallet_api.rs::string_or_number
  stringOrNumber: (v) => {
    if (v === null) return '';
    if (typeof v === 'string') return v;
    if (isInt(v) || v instanceof F64) return numberText(v);
    throw new SerdeError(`expected string or number, got ${stringify(v)}`);
  },
  // wallet_api.rs::bool_or_int
  boolOrInt: (v) => {
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isInteger(v) && v !== 0;
    if (typeof v === 'bigint') return v >= -9223372036854775808n && v <= 9223372036854775807n && v !== 0n;
    if (v instanceof F64) return false;
    throw new SerdeError(`expected bool or integer, got ${stringify(v)}`);
  },
  // wallet_api.rs::nullable_string
  nullableString: (v) => {
    if (v === null) return '';
    if (typeof v === 'string') return v;
    throw new SerdeError(`expected string or null, got ${stringify(v)}`);
  },
  // wallet_api.rs::nullable_bool
  nullableBool: (v) => {
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    throw new SerdeError(`expected bool or null, got ${stringify(v)}`);
  },
};
const vecOf = (item) => (v) => { if (!Array.isArray(v)) throw invalidType(v, 'a sequence'); return v.map(item); };
// wallet_api.rs::nullable_vec (Option<Vec<T>>)
const nullableVecOf = (item) => (v) => (v === null ? [] : vecOf(item)(v));

// Decode a struct: keys visited in sorted order (serde_json Map is a BTreeMap), then missing
// required fields reported in declaration order. fields: [name, decoder, default?]
// (a field with a default is `#[serde(default)]` → may be absent).
function decodeStruct(name, fields) {
  const dec = (v) => {
    if (!isObj(v)) throw invalidType(v, `struct ${name}`);
    const out = {};
    const byName = new Map(fields.map((f) => [f[0], f]));
    for (const k of Object.keys(v).sort(cmpKeys)) {
      const f = byName.get(k);
      if (f) out[k] = f[1](v[k]);
    }
    const res = {};
    for (const [fname, , def] of fields) {
      if (hasOwn(out, fname)) res[fname] = out[fname];
      else if (def !== undefined) res[fname] = typeof def === 'function' ? def() : def;
      else throw new SerdeError(`missing field \`${fname}\``);
    }
    return res;
  };
  dec.structName = name;
  return dec;
}
const fromValue = (decoder, v) => decoder(v);

// upstream: wallet_api.rs::VerifyAddressInfo
export const decodeVerifyAddressInfo = decodeStruct('VerifyAddressInfo', [
  ['accountId', K.string, ''], ['address', K.string], ['chainIndex', K.stringOrNumber], ['chainName', K.string],
  ['addressType', K.string], ['chainPath', K.nullableString, ''],
]);
// upstream: wallet_api.rs::RefreshAccountItem
export const decodeRefreshAccountItem = decodeStruct('RefreshAccountItem', [
  ['accountId', K.string], ['accountName', K.string], ['isDefault', K.bool, false], ['addresses', vecOf(decodeVerifyAddressInfo), () => []],
]);
// upstream: wallet_api.rs::LoginInfo
export const decodeLoginInfo = decodeStruct('LoginInfo', [
  ['email', K.string, ''], ['nickname', K.string, ''], ['username', K.string, ''], ['loginType', K.string, ''],
]);
const defaultLoginInfo = () => ({ email: '', nickname: '', username: '', loginType: '' });
// upstream: wallet_api.rs::VerifyResponse
export const decodeVerifyResponse = decodeStruct('VerifyResponse', [
  ['refreshToken', K.string], ['accessToken', K.string], ['saTeeId', K.string, ''], ['sessionCert', K.string],
  ['encryptedSessionSk', K.string], ['sessionKeyExpireAt', K.stringOrNumber], ['projectId', K.string],
  ['accountId', K.string], ['accountName', K.string], ['isNew', K.boolOrInt],
  ['addressList', vecOf(decodeVerifyAddressInfo), () => []], ['allAccountAddressList', vecOf(decodeRefreshAccountItem), () => []],
  ['loginInfo', decodeLoginInfo, defaultLoginInfo],
]);
// upstream: wallet_api.rs::RefreshResponse
export const decodeRefreshResponse = decodeStruct('RefreshResponse', [
  ['refreshToken', K.string], ['accessToken', K.string], ['chainUpdated', K.bool, false], ['allAccountAddressList', vecOf(decodeRefreshAccountItem), () => []],
]);
// upstream: wallet_api.rs::CreateAccountResponse
export const decodeCreateAccountResponse = decodeStruct('CreateAccountResponse', [
  ['projectId', K.string], ['accountId', K.string], ['accountName', K.string], ['addressList', vecOf(decodeVerifyAddressInfo), () => []],
]);
// upstream: wallet_api.rs::AccountListItem
export const decodeAccountListItem = decodeStruct('AccountListItem', [
  ['projectId', K.string], ['accountId', K.string], ['accountName', K.string], ['isDefault', K.bool, false],
]);
// upstream: wallet_api.rs::AddressListAccountItem / AddressListData
export const decodeAddressListAccountItem = decodeStruct('AddressListAccountItem', [
  ['accountId', K.string], ['addresses', vecOf(decodeVerifyAddressInfo), () => []],
]);
const decodeAddressListData = decodeStruct('AddressListData', [['accounts', vecOf(decodeAddressListAccountItem), () => []]]);
// upstream: wallet_api.rs::GasStationToken
export const decodeGasStationToken = decodeStruct('GasStationToken', [
  ['feeCoinId', K.u64, 0], ['symbol', K.nullableString, ''], ['feeTokenAddress', K.nullableString, ''], ['serviceCharge', K.nullableString, ''],
  ['balance', K.nullableString, ''], ['sufficient', K.nullableBool, false], ['relayerId', K.nullableString, ''], ['context', K.nullableString, ''],
]);
// upstream: wallet_api.rs::UnsignedInfoResponse (every field #[serde(default)])
export const decodeUnsignedInfoResponse = decodeStruct('UnsignedInfoResponse', [
  ['unsignedTxHash', K.nullableString, ''], ['unsignHash', K.nullableString, ''], ['unsignedTx', K.nullableString, ''],
  ['uopHash', K.nullableString, ''], ['hash', K.nullableString, ''], ['authHashFor7702', K.nullableString, ''],
  ['executeErrorMsg', K.nullableString, ''], ['executeResult', K.value, null], ['extraData', K.value, null],
  ['signType', K.nullableString, ''], ['encoding', K.nullableString, ''], ['jitoUnsignedTx', K.nullableString, ''],
  ['eip712MessageHash', K.nullableString, ''], ['gasStationUsed', K.nullableBool, false], ['gasStationFirstTimePrompt', K.nullableBool, false],
  ['serviceCharge', K.nullableString, ''], ['serviceChargeSymbol', K.nullableString, ''], ['serviceChargeFeeTokenAddress', K.nullableString, ''],
  ['needUpdate7702', K.nullableBool, false], ['gasStationTokenList', nullableVecOf(decodeGasStationToken), () => []],
  ['hasPendingTx', K.nullableBool, false], ['insufficientAll', K.nullableBool, false], ['autoSelectedToken', K.nullableBool, false],
  ['gasStationDisabled', K.nullableBool, false], ['gasStationStatus', K.nullableString, ''], ['contractNonce', K.nullableString, ''],
  ['eoaNonce', K.nullableString, ''], ['user712Data', K.value, null], ['user7702Data', K.value, null], ['defaultGasTokenAddress', K.nullableString, ''],
]);
// upstream: wallet_api.rs::BroadcastResponse
export const decodeBroadcastResponse = decodeStruct('BroadcastResponse', [
  ['pkgId', K.nullableString, ''], ['orderId', K.nullableString, ''], ['orderType', K.nullableString, ''], ['txHash', K.nullableString, ''],
]);

// serde_json::from_value::<T>(v).context(ctx)
function parseAs(decoder, v, ctxMsg) {
  try { return fromValue(decoder, v); } catch (e) {
    if (e instanceof SerdeError) throw context(ctxMsg, e);
    throw e;
  }
}
// `.as_array().context(msg)` / `.first().context(msg)`
function asArray(data, msg) { if (!Array.isArray(data)) throw new CliError(msg); return data; }
function first(arr, msg) { if (!arr.length) throw new CliError(msg); return arr[0]; }

// ── GasStationStatus / UnsignedInfoResponse helpers ─────────────────

// upstream: wallet_api.rs::GasStationStatus (as_str form; Unknown = "")
export const GasStationStatus = Object.freeze({
  NotApplicable: 'NOT_APPLICABLE', FirstTimePrompt: 'FIRST_TIME_PROMPT', PendingUpgrade: 'PENDING_UPGRADE',
  ReenableOnly: 'REENABLE_ONLY', ReadyToUse: 'READY_TO_USE', InsufficientAll: 'INSUFFICIENT_ALL',
  HasPendingTx: 'HAS_PENDING_TX', NotSupportIntention: 'NOT_SUPPORT_INTENTION', Unknown: '',
});
const GS_KNOWN = new Set(Object.values(GasStationStatus).filter(Boolean));
// upstream: wallet_api.rs::GasStationStatus::parse (exact, case-sensitive; else Unknown)
export const gasStationStatusParse = (s) => (GS_KNOWN.has(s) ? s : GasStationStatus.Unknown);
// upstream: wallet_api.rs::UnsignedInfoResponse::gs_status
export const gsStatus = (r) => gasStationStatusParse(r.gasStationStatus);
// upstream: wallet_api.rs::UnsignedInfoResponse::has_sign_material
export const hasSignMaterial = (r) => [r.hash, r.eip712MessageHash, r.unsignedTxHash, r.unsignedTx, r.authHashFor7702, r.jitoUnsignedTx].some((x) => x !== '');
const eqIgnoreAsciiCase = (a, b) => a.length === b.length && a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());
// upstream: wallet_api.rs::UnsignedInfoResponse::match_default_sufficient_token
export function matchDefaultSufficientToken(r) {
  if (r.defaultGasTokenAddress === '') return null;
  return r.gasStationTokenList.find((t) => t.sufficient && eqIgnoreAsciiCase(t.feeTokenAddress, r.defaultGasTokenAddress)) ?? null;
}
// upstream: wallet_api.rs::UnsignedInfoResponse::only_sufficient_token
export function onlySufficientToken(r) {
  const s = r.gasStationTokenList.filter((t) => t.sufficient);
  return s.length === 1 ? s[0] : null;
}
// upstream: wallet_api.rs::UnsignedInfoResponse::auto_pick_gas_token
export const autoPickGasToken = (r) => (r.defaultGasTokenAddress === '' ? onlySufficientToken(r) : matchDefaultSufficientToken(r));
// upstream: wallet_api.rs::UnsignedInfoResponse::free_gas
export const freeGas = (r) => isObj(r.extraData) && r.extraData.freeGas === true;

// ── batch helpers ───────────────────────────────────────────────────

// upstream: wallet_api.rs::BATCH_MAX
export const BATCH_MAX = 5;

// upstream: wallet_api.rs::parse_supported_chain_list
export function parseSupportedChainList(data) {
  const arr = asArray(data, 'batch supportChainIndexList: expected data to be an array');
  return arr.map((v) => {
    if (typeof v === 'string') return v;
    if (isI64(v)) return String(v);
    throw new CliError(`batch supportChainIndexList: unexpected element ${debugValue(v)}`);
  });
}
const isI64 = (v) => (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n);
// serde_json::Value Debug ({v:?}) — e.g. Object {"chainIndex": String("1")}
function debugValue(v) {
  if (v === null) return 'Null';
  if (typeof v === 'boolean') return `Bool(${v})`;
  if (typeof v === 'string') return `String(${JSON.stringify(v)})`;
  if (isInt(v) || v instanceof F64) return `Number(${numberText(v)})`;
  if (Array.isArray(v)) return `Array [${v.map(debugValue).join(', ')}]`;
  return `Object {${Object.keys(v).sort(cmpKeys).map((k) => `${JSON.stringify(k)}: ${debugValue(v[k])}`).join(', ')}}`;
}

// upstream: wallet_api.rs::validate_batch_size
export function validateBatchSize(api, len) {
  if (len === 0) throw new CliError(`${api}: empty request array`);
  if (len > BATCH_MAX) throw new CliError(`${api}: backend allows up to ${BATCH_MAX} elements, got ${len}`);
}

// upstream: wallet_api.rs::build_batch_unsignedinfo_body — elements: BatchUnsignedInfoElement
// {chainPath, chainIndex (u64), fromAddr, toAddr, amount, sessionCert, contractAddr?, inputData?,
//  unsignedTx?, gasLimit?, aaDexTokenAddr?, aaDexTokenAmount?, transactionType?} (json! → sorted keys)
export function buildBatchUnsignedinfoBody(elements) {
  return elements.map((e) => {
    const o = { chainPath: e.chainPath, chainIndex: e.chainIndex, fromAddr: e.fromAddr, toAddr: e.toAddr, amount: e.amount, sessionCert: e.sessionCert };
    for (const k of ['contractAddr', 'inputData', 'unsignedTx', 'gasLimit', 'aaDexTokenAddr', 'aaDexTokenAmount', 'transactionType']) {
      if (e[k] !== undefined && e[k] !== null) o[k] = String(e[k]);
    }
    return o;
  });
}

// upstream: wallet_api.rs::build_batch_broadcast_body — elements: {accountId, address, chainIndex, extraData}
export const buildBatchBroadcastBody = (elements) => elements.map((e) => ({ accountId: e.accountId, address: e.address, chainIndex: e.chainIndex, extraData: e.extraData }));

// ── query string ────────────────────────────────────────────────────

// upstream: wallet_api.rs::build_query_string — ordered pairs, empty values dropped, key raw,
// value application/x-www-form-urlencoded.
export function buildQueryString(query) {
  const pairs = (query || []).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  if (!pairs.length) return '';
  return '?' + pairs.map(([k, v]) => `${k}=${new URLSearchParams([['', String(v)]]).toString().slice(1)}`).join('&');
}

// ── envelope ────────────────────────────────────────────────────────

const byteSlice = (s, n) => Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');

// upstream: wallet_api.rs::unwrap_wallet_envelope
export function unwrapWalletEnvelope(httpStatus, body) {
  const code = isObj(body) ? body.code : undefined;
  const codeOk = code === '0' || code === 0 || code === 0n;
  if (!codeOk) {
    const codeStr = typeof code === 'string' ? code : isInt(code) || code instanceof F64 ? numberText(code) : stringify(code === undefined ? null : code);
    const pick = (k) => (isObj(body) && typeof body[k] === 'string' ? body[k] : undefined);
    let msgRaw = pick('msg') ?? pick('errorMessage') ?? pick('error_message') ?? pick('message') ?? pick('detailMsg');
    if (msgRaw === undefined) {
      const s = stringify(body);
      process.stderr.write(`[WalletAPI] no msg field in error response (HTTP ${httpStatus}), raw body: ${s}\n`);
      msgRaw = Buffer.byteLength(s) <= 200 ? s : `${byteSlice(s, 200)}…`;
    }
    throw new ApiCodeError(codeStr, augmentAuthErrorMsg(codeStr, msgRaw), httpStatus);
  }
  return body.data === undefined ? null : body.data;
}

// client.rs::augment_auth_error_msg (raw msg, no trimming — the wallet path passes it verbatim).
function augmentAuthErrorMsg(code, msg) {
  return code === '50114' ? `${msg}. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` : msg;
}

// ── invalid-token detection + force refresh ─────────────────────────

const INVALID_TOKEN_CODES = ['10001', '10008', '53017', '130100031'];

// upstream: wallet_api.rs::is_invalid_token_error
export function isInvalidTokenError(e) {
  if (e instanceof ApiCodeError && INVALID_TOKEN_CODES.includes(e.code)) return true;
  const s = displayTop(e);
  if (INVALID_TOKEN_CODES.some((c) => s.includes(`code=${c})`))) return true;
  const lower = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return lower.includes('invalid access token') || lower.includes('access token invalid');
}

// upstream: wallet_api.rs::force_refresh_access_token
export async function forceRefreshAccessToken() {
  const blob = keyring.readBlob();
  const refreshToken = typeof blob.refresh_token === 'string' && blob.refresh_token !== '' ? blob.refresh_token : null;
  if (!refreshToken) throw new CliError('refresh_token missing — please run: onchainos wallet login');
  const client = new WalletApiClient();
  let resp;
  try {
    resp = await client.authRefresh(refreshToken);
  } catch (e) {
    throw new CliError(`force-refresh failed: ${displayTop(e)}`);
  }
  keyring.store([['access_token', resp.accessToken], ['refresh_token', resp.refreshToken]]);
  return resp.accessToken;
}

// ── transport ───────────────────────────────────────────────────────

// std::io::Error Display for OS errors: "<strerror / FormatMessage text> (os error N)".
// (Windows text is the English system message; localized Windows installs differ.)
const OS_ERRORS = {
  linux: { ECONNREFUSED: ['Connection refused', 111], ECONNRESET: ['Connection reset by peer', 104], EHOSTUNREACH: ['No route to host', 113],
    ENETUNREACH: ['Network is unreachable', 101], ETIMEDOUT: ['Connection timed out', 110], EPIPE: ['Broken pipe', 32],
    ECONNABORTED: ['Software caused connection abort', 103], EADDRNOTAVAIL: ['Cannot assign requested address', 99] },
  darwin: { ECONNREFUSED: ['Connection refused', 61], ECONNRESET: ['Connection reset by peer', 54], EHOSTUNREACH: ['No route to host', 65],
    ENETUNREACH: ['Network is unreachable', 51], ETIMEDOUT: ['Operation timed out', 60], EPIPE: ['Broken pipe', 32],
    ECONNABORTED: ['Software caused connection abort', 53], EADDRNOTAVAIL: ["Can't assign requested address", 49] },
  win32: { ECONNREFUSED: ['No connection could be made because the target machine actively refused it.', 10061],
    ECONNRESET: ['An existing connection was forcibly closed by the remote host.', 10054],
    EHOSTUNREACH: ['A socket operation was attempted to an unreachable host.', 10065],
    ENETUNREACH: ['A socket operation was attempted to an unreachable network.', 10051],
    ETIMEDOUT: ['A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.', 10060],
    ECONNABORTED: ['An established connection was aborted by the software in your host machine.', 10053],
    EADDRNOTAVAIL: ['The requested address is not valid in its context.', 10049] },
};
const osErrorText = (code) => { const t = (OS_ERRORS[process.platform] ?? OS_ERRORS.linux)[code]; return t ? `${t[0]} (os error ${t[1]})` : undefined; };
function dnsErrorText(code) {
  if (process.platform === 'win32') return code === 'EAI_AGAIN'
    ? 'This is usually a temporary error during hostname resolution and means that the local server did not receive a response from an authoritative server. (os error 11002)'
    : 'No such host is known. (os error 11001)';
  const detail = process.platform === 'darwin' ? 'nodename nor servname provided, or not known'
    : code === 'EAI_AGAIN' ? 'Temporary failure in name resolution' : 'Name or service not known';
  return `failed to lookup address information: ${detail}`;
}
const TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO']);
// hyper parse errors surfaced as `client error (SendRequest): <kind>`
const HYPER_PARSE = { HPE_INVALID_CONSTANT: 'invalid HTTP version parsed', HPE_INVALID_VERSION: 'invalid HTTP version parsed',
  HPE_INVALID_STATUS: 'invalid HTTP status-code parsed', HPE_INVALID_HEADER_TOKEN: 'invalid HTTP header parsed', HPE_HEADER_OVERFLOW: 'message head is too large' };

// Map a transport failure to reqwest's error chain ({:#}) and the phase it failed in:
//   connect / timeout → `e.is_connect() || e.is_timeout()` (the "Network unavailable" / "…unknown"
//   contexts); send → any other send error ("request failed"); body → resp.text() failed after the
//   status line ("failed to read response body").
export function reqwestFailure(url, e) {
  let href = url;
  try { href = new URL(url).href; } catch {}
  const req = `error sending request for url (${href})`;
  const code = e?.code, msg = String(e?.message ?? e), syscall = e?.syscall;
  if (code === 'ECURL') {                                     // core curl fallback: exit code → phase
    const n = Number((/^curl failed \((\d+)\)/.exec(msg) || [])[1]);
    if (n === 28) return { phase: 'timeout', text: `${req}: operation timed out` };
    if ([5, 6].includes(n)) return { phase: 'connect', text: `${req}: client error (Connect): dns error: ${dnsErrorText('ENOTFOUND')}` };
    if ([7, 35, 51, 58, 59, 60, 77, 83, 90, 91].includes(n)) return { phase: 'connect', text: `${req}: client error (Connect): ${msg}` };
    if ([18, 23, 61].includes(n)) return { phase: 'body', text: 'error decoding response body: request or response body error: error reading a body from connection: end of file before message length reached' };
    if (n === 52) return { phase: 'send', text: `${req}: client error (SendRequest): connection closed before message completed` };
    return { phase: 'send', text: `${req}: ${msg}` };
  }
  if (syscall === 'getaddrinfo' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { phase: 'connect', text: `${req}: client error (Connect): dns error: ${dnsErrorText(code)}` };
  }
  if (code === 'ETIMEDOUT' && syscall !== 'connect') return { phase: 'timeout', text: `${req}: operation timed out` };
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return { phase: 'timeout', text: `${req}: operation timed out` };
  if (syscall === 'connect' || ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code)) {
    return { phase: 'connect', text: `${req}: client error (Connect): tcp connect error: ${osErrorText(code) ?? msg}` };
  }
  if (TLS_CODES.has(code) || /^ERR_SSL_/.test(code || '') || code === 'EPROXY' || /before secure TLS connection/.test(msg)) {
    return { phase: 'connect', text: `${req}: client error (Connect): ${msg}` };
  }
  if (msg === 'aborted' || /^truncated( chunked)? body$/.test(msg) || msg === 'invalid chunk size') {
    return { phase: 'body', text: 'error decoding response body: request or response body error: error reading a body from connection: end of file before message length reached' };
  }
  if (code === 'ECONNRESET' && (msg === 'socket hang up' || msg === 'connection closed before response headers')) {
    return { phase: 'send', text: `${req}: client error (SendRequest): connection closed before message completed` };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') {
    return { phase: 'send', text: `${req}: client error (SendRequest): connection error: ${osErrorText(code) ?? msg}` };
  }
  if (msg === 'connection closed before response headers') return { phase: 'send', text: `${req}: client error (SendRequest): connection closed before message completed` };
  if (HYPER_PARSE[code]) return { phase: 'send', text: `${req}: client error (SendRequest): ${HYPER_PARSE[code]}` };
  return { phase: 'send', text: `${req}: ${msg}` };
}

export const NETWORK_UNAVAILABLE = 'Network unavailable — check your connection and try again';
export const MUTATION_UNKNOWN_RESULT = 'Network result is unknown for this state-changing request. Query authoritative state before retrying.';
export const BROADCAST_UNKNOWN_RESULT = 'Broadcast result is unknown. Query transaction status before attempting another broadcast.';
export const BATCH_BROADCAST_UNKNOWN_RESULT = 'Batch broadcast result is unknown. Query transaction status before attempting another broadcast.';

// reqwest HeaderMap::insert semantics: replace any same-named header (case-insensitive).
// extra: [[name, value], …] (upstream &[(&str, &str)]) or a { name: value } object.
function insertHeaders(h, extra) {
  const pairs = !extra ? [] : Array.isArray(extra) ? extra : Object.entries(extra);
  for (const pair of pairs) {
    const [k, v] = Array.isArray(pair) ? pair : [pair.name, pair.value];
    // HeaderValue::from_str validates the UTF-8 bytes (>= 0x20 except DEL, or TAB); the bytes go
    // on the wire unencoded, so carry them as a latin1 string.
    const bytes = Buffer.from(String(v), 'utf8');
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k) || bytes.some((b) => (b < 0x20 && b !== 0x09) || b === 0x7f)) continue;
    for (const existing of Object.keys(h)) if (existing.toLowerCase() === k.toLowerCase()) delete h[existing];
    h[k] = bytes.toString('latin1');
  }
  return h;
}
const withDefaults = (h) => ({ ...h, accept: '*/*', 'user-agent': USER_AGENT });

export class WalletApiClient {
  // WalletApiClient::new() — base URL = endpoints::base_url() (honours --dev / OCL_BASE_URL).
  constructor(base) {
    this.baseUrl = base ?? baseUrl();
  }

  effectiveBaseUrl() { return this.baseUrl; }
  url(path, query) { return this.baseUrl.replace(/\/+$/, '') + path + (query ? buildQueryString(query) : ''); }

  async send(method, url, headers, body, { unknownResult, sendContext } = {}) {
    try {
      return await transport({ method, url, headers, body, timeoutMs: WALLET_HTTP_TIMEOUT_MS });
    } catch (e) {
      // DoH failover is not reproduced (DESIGN non-goal): a connect/timeout error surfaces directly.
      const f = reqwestFailure(url, e);
      const cause = new Error(f.text);
      if (f.phase === 'body') throw context('failed to read response body', cause);   // handle_response: resp.text()
      if (sendContext) throw context(sendContext, cause);
      if (f.phase === 'connect' || f.phase === 'timeout') throw context(unknownResult ?? NETWORK_UNAVAILABLE, cause);
      throw context('request failed', cause);
    }
  }

  // upstream: wallet_api.rs::WalletApiClient::handle_response
  handleResponse(resp) {
    const status = resp.status;
    const raw = resp.body.toString('utf8');
    if (status >= 500) throw new CliError(`Wallet API server error (HTTP ${status}): ${raw}`);
    let body;
    // serde_json::from_str::<Value> (streaming; errors carry `at line L column C`)
    try { body = fromStr(Buffer.from(raw, 'utf8')); } catch (e) {
      const preview = Buffer.byteLength(raw) <= 500 ? raw : byteSlice(raw, 500);
      throw context(`failed to parse wallet API response as JSON (HTTP ${status}): ${preview}`, e);
    }
    return unwrapWalletEnvelope(status, body);
  }

  // upstream: wallet_api.rs::post_public — anonymous headers.
  async postPublic(path, body) {
    const r = await this.send('POST', this.url(path), withDefaults(anonymousHeaders()), stringify(body));
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::get_no_okheaders — no OK headers at all (only reqwest defaults).
  async getNoOkheaders(path) {
    const r = await this.send('GET', this.url(path), withDefaults({}));
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::get_public
  async getPublic(path, query) {
    const r = await this.send('GET', this.url(path, query), withDefaults(anonymousHeaders()));
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::post_authed
  postAuthed(path, accessToken, body) { return this.postAuthedWithHeaders(path, accessToken, body, null); }

  // upstream: wallet_api.rs::post_authed_with_headers — force-refresh + one retry on invalid token.
  async postAuthedWithHeaders(path, accessToken, body, extraHeaders) {
    try {
      return await this.postAuthedWithHeadersOnce(path, accessToken, body, extraHeaders);
    } catch (e) {
      if (!isInvalidTokenError(e)) throw e;
      const fresh = await forceRefreshAccessToken();
      return this.postAuthedWithHeadersOnce(path, fresh, body, extraHeaders);
    }
  }

  async postAuthedWithHeadersOnce(path, accessToken, body, extraHeaders) {
    const h = insertHeaders(jwtHeaders(accessToken), extraHeaders);
    const r = await this.send('POST', this.url(path), withDefaults(h), stringify(body));
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::post_authed_no_retry_with_headers (private upstream)
  async postAuthedNoRetryWithHeaders(path, accessToken, body, extraHeaders, unknownResultMessage) {
    const h = insertHeaders(jwtHeaders(accessToken), extraHeaders);
    const r = await this.send('POST', this.url(path), withDefaults(h), stringify(body), { unknownResult: unknownResultMessage });
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::post_authed_mutation_no_retry
  postAuthedMutationNoRetry(path, accessToken, body) {
    return this.postAuthedNoRetryWithHeaders(path, accessToken, body, null, MUTATION_UNKNOWN_RESULT);
  }

  // upstream: wallet_api.rs::post_authed_mutation_no_retry_with_headers
  postAuthedMutationNoRetryWithHeaders(path, accessToken, body, extraHeaders) {
    return this.postAuthedNoRetryWithHeaders(path, accessToken, body, extraHeaders, MUTATION_UNKNOWN_RESULT);
  }

  // upstream: wallet_api.rs::post_authed_multipart
  postAuthedMultipart(path, accessToken, form) { return this.postAuthedMultipartWithHeaders(path, accessToken, form, null); }

  // upstream: wallet_api.rs::post_authed_multipart_with_headers — form: [{name, value} | {name, data: Buffer, filename?, contentType?}]
  async postAuthedMultipartWithHeaders(path, accessToken, form, extraHeaders) {
    const boundary = multipartBoundary();
    const payload = encodeMultipart(form, boundary);
    const h = jwtHeaders(accessToken);
    delete h['Content-Type'];
    insertHeaders(h, extraHeaders);
    h['content-type'] = `multipart/form-data; boundary=${boundary}`;
    const r = await this.send('POST', this.url(path), withDefaults(h), payload, { sendContext: 'wallet API request failed' });
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::post_authed_raw_with_headers — caller-built body + explicit Content-Type.
  async postAuthedRawWithHeaders(path, accessToken, body, contentType, extraHeaders) {
    const h = jwtHeaders(accessToken);
    delete h['Content-Type'];
    insertHeaders(h, extraHeaders);
    h['Content-Type'] = contentType;
    const r = await this.send('POST', this.url(path), withDefaults(h), Buffer.from(body), { sendContext: 'wallet API request failed' });
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::get_authed
  getAuthed(path, accessToken, query) { return this.getAuthedWithHeaders(path, accessToken, query, null); }

  // upstream: wallet_api.rs::get_authed_with_headers — force-refresh + one retry on invalid token.
  async getAuthedWithHeaders(path, accessToken, query, extraHeaders) {
    try {
      return await this.getAuthedWithHeadersOnce(path, accessToken, query, extraHeaders);
    } catch (e) {
      if (!isInvalidTokenError(e)) throw e;
      const fresh = await forceRefreshAccessToken();
      return this.getAuthedWithHeadersOnce(path, fresh, query, extraHeaders);
    }
  }

  async getAuthedWithHeadersOnce(path, accessToken, query, extraHeaders) {
    const h = insertHeaders(jwtHeaders(accessToken), extraHeaders);
    const r = await this.send('GET', this.url(path, query), withDefaults(h));
    return this.handleResponse(r);
  }

  // upstream: wallet_api.rs::get_authed_bytes_with_headers → Buffer
  async getAuthedBytesWithHeaders(path, accessToken, query, extraHeaders) {
    const h = insertHeaders(jwtHeaders(accessToken), extraHeaders);
    const r = await this.send('GET', this.url(path, query), withDefaults(h));
    const contentType = String(r.headers['content-type'] ?? '');
    if (contentType.includes('application/json')) {
      let body;
      try { body = fromStr(r.body); } catch (e) {
        throw context('failed to parse wallet API response as JSON', e);
      }
      const code = isObj(body) ? body.code : undefined;
      if (!(code === '0' || code === 0 || code === 0n)) {
        const codeStr = typeof code === 'string' ? code : isInt(code) || code instanceof F64 ? numberText(code) : stringify(code === undefined ? null : code);
        const pick = (k) => (isObj(body) && typeof body[k] === 'string' ? body[k] : undefined);
        const msg = pick('msg') ?? pick('errorMessage') ?? pick('error_message') ?? pick('message') ?? pick('detailMsg') ?? 'unknown error';
        throw new CliError(`download failed (code=${codeStr}): ${msg}`);
      }
      return Buffer.alloc(0);
    }
    if (r.status >= 400) {
      const preview = [...trim(r.body.toString('utf8'))].slice(0, 500).join('');
      throw new CliError(`download failed (HTTP ${r.status}): ${preview}`);
    }
    return r.body;
  }

  // ── Public API methods ────────────────────────────────────────────

  // upstream: wallet_api.rs::auth_refresh — POST /priapi/v5/wallet/agentic/auth/refresh
  async authRefresh(refreshToken) {
    const data = await this.postPublic('/priapi/v5/wallet/agentic/auth/refresh', { refreshToken });
    const arr = asArray(data, 'auth/refresh: expected data to be an array');
    const item = first(arr, 'auth/refresh: data array is empty');
    return parseAs(decodeRefreshResponse, item, 'auth/refresh: failed to parse response');
  }

  // upstream: wallet_api.rs::session_result — POST /priapi/v5/wallet/agentic/auth/session/result → raw data[0]
  async sessionResult(authSessionId) {
    const data = await this.postPublic('/priapi/v5/wallet/agentic/auth/session/result', { authSessionId });
    const arr = asArray(data, 'session/result: expected data to be an array');
    return first(arr, 'session/result: data array is empty');
  }

  // upstream: wallet_api.rs::account_create
  async accountCreate(accessToken, projectId) {
    const data = await this.postAuthed('/priapi/v5/wallet/agentic/account/create', accessToken, { projectId });
    const arr = asArray(data, 'account/create: expected data to be an array');
    const item = first(arr, 'account/create: data array is empty');
    return parseAs(decodeCreateAccountResponse, item, 'account/create: failed to parse response');
  }

  // upstream: wallet_api.rs::account_list
  async accountList(accessToken, projectId) {
    const data = await this.postAuthed('/priapi/v5/wallet/agentic/account/list', accessToken, { projectId });
    const arr = asArray(data, 'account/list: expected data to be an array');
    return parseAs(vecOf(decodeAccountListItem), arr, 'account/list: failed to parse response');
  }

  // upstream: wallet_api.rs::account_address_list → AddressListAccountItem[]
  async accountAddressList(accessToken, accountIds) {
    const data = await this.postAuthed('/priapi/v5/wallet/agentic/account/address/list', accessToken, { accountIds: [...accountIds] });
    const arr = asArray(data, 'account/address/list: expected data to be an array');
    const item = first(arr, 'account/address/list: data array is empty');
    return parseAs(decodeAddressListData, item, 'account/address/list: failed to parse response').accounts;
  }

  // upstream: wallet_api.rs::balance_batch
  balanceBatch(accessToken, accountIds) {
    return this.getAuthed('/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch', accessToken, [['accountIds', accountIds]]);
  }

  // upstream: wallet_api.rs::balance_single
  balanceSingle(accessToken, query) {
    return this.getAuthed('/priapi/v5/wallet/agentic/asset/wallet-all-token-balances', accessToken, query);
  }

  // upstream: wallet_api.rs::get_token_info — chainIndex is a u64 (JSON number).
  getTokenInfo(accessToken, chainIndex, tokenAddress) {
    return this.postAuthed('/priapi/v5/wallet/agentic/token/get-token-info', accessToken, { chainIndex: toU64(chainIndex), tokenAddress, source: 0 });
  }

  // upstream: wallet_api.rs::pre_transaction_unsigned_info
  async preTransactionUnsignedInfo(accessToken, chainPath, chainIndex, fromAddr, toAddr, amount, contractAddr, sessionCert,
    inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, jitoUnsignedTx, traceHeaders, enableGasStation, gasTokenAddress, relayerId) {
    const body = { chainPath, chainIndex: toU64(chainIndex), fromAddr, toAddr, amount, sessionCert };
    const opt = (k, v) => { if (v !== undefined && v !== null) body[k] = String(v); };
    opt('contractAddr', contractAddr); opt('inputData', inputData); opt('unsignedTx', unsignedTx); opt('gasLimit', gasLimit);
    opt('aaDexTokenAddr', aaDexTokenAddr); opt('aaDexTokenAmount', aaDexTokenAmount); opt('jitoUnsignedTx', jitoUnsignedTx);
    if (enableGasStation === true) body.enableGasStation = true;
    opt('gasTokenAddress', gasTokenAddress); opt('relayerId', relayerId);
    const data = await this.postAuthedWithHeaders('/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo', accessToken, body, traceHeaders);
    const arr = asArray(data, 'unsignedInfo: expected data to be an array');
    const item = first(arr, 'unsignedInfo: data array is empty');
    return parseAs(decodeUnsignedInfoResponse, item, 'unsignedInfo: failed to parse response');
  }

  // upstream: wallet_api.rs::batch_pre_transaction_unsigned_info
  async batchPreTransactionUnsignedInfo(accessToken, elements, traceHeaders) {
    validateBatchSize('batch unsignedInfo', elements.length);
    const body = buildBatchUnsignedinfoBody(elements.map((e) => ({ ...e, chainIndex: toU64(e.chainIndex) })));
    const data = await this.postAuthedWithHeaders('/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo', accessToken, body, traceHeaders);
    const arr = asArray(data, 'batch unsignedInfo: expected data to be an array');
    if (!arr.length) throw new CliError('batch unsignedInfo: response data array is empty');
    if (arr.length > elements.length) throw new CliError(`batch unsignedInfo: response length ${arr.length} exceeds request length ${elements.length}`);
    return arr.map((item, i) => parseAs(decodeUnsignedInfoResponse, item, `batch unsignedInfo: failed to parse element ${i}`));
  }

  // upstream: wallet_api.rs::batch_support_chain_index_list
  async batchSupportChainIndexList(accessToken) {
    const data = await this.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList', accessToken, {});
    return parseSupportedChainList(data);
  }

  // upstream: wallet_api.rs::report_plugin_info
  reportPluginInfo(accessToken, pluginParameter) {
    return this.postAuthed('/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info', accessToken, { pluginParameter });
  }

  // upstream: wallet_api.rs::broadcast_transaction — no retry of any kind.
  async broadcastTransaction(accessToken, accountId, address, chainIndex, extraData, traceHeaders) {
    const data = await this.postAuthedNoRetryWithHeaders('/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction', accessToken,
      { accountId, address, chainIndex, extraData }, traceHeaders, BROADCAST_UNKNOWN_RESULT);
    const arr = asArray(data, 'broadcast: expected data to be an array');
    const item = first(arr, 'broadcast: data array is empty');
    return parseAs(decodeBroadcastResponse, item, 'broadcast: failed to parse response');
  }

  // upstream: wallet_api.rs::batch_broadcast_transaction
  async batchBroadcastTransaction(accessToken, elements, traceHeaders) {
    validateBatchSize('batch broadcast', elements.length);
    const data = await this.postAuthedNoRetryWithHeaders('/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction', accessToken,
      buildBatchBroadcastBody(elements), traceHeaders, BATCH_BROADCAST_UNKNOWN_RESULT);
    const arr = asArray(data, 'batch broadcast: expected data to be an array');
    if (arr.length !== elements.length) throw new CliError(`batch broadcast: response length ${arr.length} does not match request length ${elements.length}`);
    return arr.map((item, i) => parseAs(decodeBroadcastResponse, item, `batch broadcast: failed to parse element ${i}`));
  }

  // upstream: wallet_api.rs::gas_station_update_default_token
  gasStationUpdateDefaultToken(accessToken, chainIndex, gasTokenAddress, fromAddr) {
    return this.postAuthed('/priapi/v5/wallet/agentic/gas-station/update-default-token', accessToken, { chainIndex, gasTokenAddress, fromAddr });
  }

  // upstream: wallet_api.rs::gas_station_update
  gasStationUpdate(accessToken, chainIndex, enable, fromAddr) {
    const body = { chainIndex, enabled: !!enable };
    if (fromAddr !== undefined && fromAddr !== null) body.fromAddr = String(fromAddr);
    return this.postAuthed('/priapi/v5/wallet/agentic/gas-station/update', accessToken, body);
  }
}

// u64 parameters arrive as numbers, BigInts or decimal strings; serialise as a JSON integer.
function toU64(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  if (typeof v === 'number') return v;
  const b = BigInt(String(v));
  return Number.isSafeInteger(Number(b)) ? Number(b) : b;
}

// reqwest multipart: "--<boundary>\r\nContent-Disposition: form-data; name=…" parts.
function multipartBoundary() {
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${hex()}${hex()}-${hex()}${hex()}-${hex()}${hex()}-${hex()}${hex()}`;
}
function encodeMultipart(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    chunks.push(Buffer.from(head + '\r\n'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.value ?? p.data ?? '')));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
