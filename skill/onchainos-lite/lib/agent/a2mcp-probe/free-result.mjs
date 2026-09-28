// Short-lived, one-time state for a successful free A2MCP invocation — upstream
// commands/agent_commerce/a2mcp_probe/free_result.rs. File: $HOME/a2mcp/a2free_<32 hex>.json
// (pretty JSON, struct order, written with home::atomic_write sensitive = true).
import { readFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homePath, writeAtomic } from '../../core/home.mjs';
import { struct, stringify } from '../../core/json.mjs';
import { context } from '../../core/errors.mjs';
import { value } from '../../watch/_serde.mjs';
import { fromStr } from '../identity/_from-str.mjs';
import { trim, isObj, ioErrorText } from '../_rs.mjs';

// upstream: free_result.rs constants
export const FREE_RESULT_VERSION = 1;
export const FREE_RESULT_SOURCE = 'okx_ai_a2mcp_free_result';
export const FREE_RESULT_ID_PREFIX = 'a2free_';
export const FREE_RESULT_TTL_SECS = 300;
export const ERR_FREE_RESULT_EXPIRED_OR_MISSING = 'a2mcp_free_result_expired_or_missing';

const U64_MAX = 18446744073709551615n;
const missing = (id) => new Error(`${ERR_FREE_RESULT_EXPIRED_OR_MISSING}: ${id}`);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// upstream: free_result.rs::FreeResultState (Serialize, struct order + skip rules)
export function freeResultStateStruct(s) {
  return struct({
    version: s.version, source: s.source, confirmationId: s.confirmationId, createdAt: s.createdAt, expiresAt: s.expiresAt,
    serviceId: s.serviceId, serviceName: s.serviceName ?? undefined, providerAgentId: s.providerAgentId ?? undefined,
    endpoint: s.endpoint, method: s.method, typedParams: s.typedParams, statusCode: s.statusCode, result: s.result,
  });
}

// serde_json::from_slice::<FreeResultState> — any failure is reported by the caller as
// expired-or-missing, so only acceptance matters (types, required fields, integer ranges).
function decodeState(bytes) {
  const v = fromStr(Buffer.from(bytes), value);
  if (!isObj(v)) throw new Error('not a struct');
  const int = (k, max) => {
    const x = v[k];
    if (!hasOwn(v, k) || !(typeof x === 'number' || typeof x === 'bigint') || BigInt(x) < 0n || BigInt(x) > max) throw new Error(k);
    return x;
  };
  const str = (k) => { if (!hasOwn(v, k) || typeof v[k] !== 'string') throw new Error(k); return v[k]; };
  const optStr = (k) => { if (!hasOwn(v, k) || v[k] === null) return null; if (typeof v[k] !== 'string') throw new Error(k); return v[k]; };
  const s = {
    version: int('version', 4294967295n), source: str('source'), confirmationId: str('confirmationId'), createdAt: int('createdAt', U64_MAX),
    expiresAt: int('expiresAt', U64_MAX), serviceId: str('serviceId'), serviceName: optStr('serviceName'), providerAgentId: optStr('providerAgentId'),
    endpoint: str('endpoint'), method: str('method'), statusCode: int('statusCode', 65535n),
  };
  if (!hasOwn(v, 'typedParams') || !isObj(v.typedParams)) throw new Error('typedParams');
  if (!hasOwn(v, 'result')) throw new Error('result');
  s.typedParams = v.typedParams;
  s.result = v.result;
  return s;
}

// upstream: FreeResultState::validate
function validateState(s, confirmationId, now) {
  if (Number(s.version) !== FREE_RESULT_VERSION || s.source !== FREE_RESULT_SOURCE || s.confirmationId !== confirmationId || BigInt(now) >= BigInt(s.expiresAt)) {
    throw missing(confirmationId);
  }
  if (trim(s.serviceId) === '' || BigInt(s.createdAt) >= BigInt(s.expiresAt)) throw missing(confirmationId);
  let endpoint;
  try { endpoint = new URL(s.endpoint); } catch { throw missing(confirmationId); }
  if (endpoint.protocol !== 'https:' || !(s.method === 'GET' || s.method === 'POST')) throw missing(confirmationId);
}

// upstream: free_result.rs::validate_confirmation_id (private)
function validateConfirmationId(id) {
  if (!String(id).startsWith(FREE_RESULT_ID_PREFIX)) throw missing(id);
  const suffix = String(id).slice(FREE_RESULT_ID_PREFIX.length);
  if (Buffer.byteLength(suffix, 'utf8') !== 32 || !/^[0-9A-Fa-f]*$/.test(suffix)) throw missing(id);
}

// upstream: free_result.rs::state_path (private) — validates the id, creates $HOME/a2mcp.
export function statePath(confirmationId) {
  validateConfirmationId(confirmationId);
  const dir = homePath('a2mcp');
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw context('create A2MCP state directory', new Error(ioErrorText(e))); }
  return join(dir, `${confirmationId}.json`);
}

// upstream: free_result.rs::read_state (private)
function readState(path, confirmationId, now) {
  let bytes;
  try { bytes = readFileSync(path); } catch { throw missing(confirmationId); }
  let s;
  try { s = decodeState(bytes); } catch { throw missing(confirmationId); }
  validateState(s, confirmationId, now);
  return s;
}

// upstream: free_result.rs::store_free_result(input, created_at) → FreeResultState
// input: {serviceId, serviceName, providerAgentId, endpoint, method, typedParams, statusCode, result}
export function storeFreeResult(input, createdAt) {
  const confirmationId = `${FREE_RESULT_ID_PREFIX}${randomUUID().replace(/-/g, '')}`;
  let expiresAt = BigInt(createdAt) + BigInt(FREE_RESULT_TTL_SECS);
  if (expiresAt > U64_MAX) expiresAt = U64_MAX;
  const state = {
    version: FREE_RESULT_VERSION, source: FREE_RESULT_SOURCE, confirmationId, createdAt,
    expiresAt: Number.isSafeInteger(Number(expiresAt)) ? Number(expiresAt) : expiresAt,
    serviceId: input.serviceId, serviceName: input.serviceName ?? null, providerAgentId: input.providerAgentId ?? null, endpoint: input.endpoint,
    method: input.method, typedParams: input.typedParams, statusCode: input.statusCode, result: input.result,
  };
  validateState(state, confirmationId, createdAt);
  const body = stringify(freeResultStateStruct(state), true);
  const path = statePath(confirmationId);
  try { writeAtomic(path, Buffer.from(body, 'utf8'), { mode: 0o600 }); } catch (e) { throw context('write A2MCP free result state', new Error(ioErrorText(e))); }
  return state;
}

// upstream: free_result.rs::load_free_result — invalid / expired handles are deleted.
export function loadFreeResult(confirmationId, now) {
  const path = statePath(confirmationId);
  try { return readState(path, confirmationId, now); } catch (e) {
    if (String(e.message).startsWith(ERR_FREE_RESULT_EXPIRED_OR_MISSING)) { try { rmSync(path); } catch {} }
    throw e;
  }
}

// upstream: free_result.rs::consume_free_result — claim by rename, re-read, delete.
export function consumeFreeResult(confirmationId, now) {
  const canonical = statePath(confirmationId);
  readState(canonical, confirmationId, now);
  const claim = join(homePath('a2mcp'), `.${confirmationId}.claim-${randomUUID().replace(/-/g, '')}`);
  try { renameSync(canonical, claim); } catch { throw missing(confirmationId); }
  let state;
  try { state = readState(claim, confirmationId, now); } catch (e) {
    try { renameSync(claim, canonical); } catch {}
    throw e;
  }
  try { rmSync(claim); } catch (e) { throw context('consume A2MCP free result state', new Error(ioErrorText(e))); }
  return state;
}
