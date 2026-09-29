// Cross-process `paymentId` state for the two-phase `payment quote` → `payment pay` flow —
// upstream commands/payment/state.rs. Files: $HOME/payments/{payment_id}.json (pretty JSON,
// struct field order). Never holds key material or a signed blob.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homePath } from '../core/home.mjs';
import { parse, stringify, struct } from '../core/json.mjs';
import { context } from '../core/errors.mjs';
import { loadWallets } from '../wallet/store.mjs';
import { asBool, asStr, asU64, isObject, get } from '../core/rs/value.mjs';
import { ioErrorText } from '../core/rs/fs.mjs';

// upstream: state.rs::TOKEN_QUOTE_EXPIRED_OR_MISSING / TOKEN_CROSS_USER / MAX_QUOTE_TTL_SECS
export const TOKEN_QUOTE_EXPIRED_OR_MISSING = 'quote_expired_or_missing';
export const TOKEN_CROSS_USER = 'cross_user_payment_id';
export const MAX_QUOTE_TTL_SECS = 300;

// upstream: state.rs::ParamCarrier (serde lowercase; default query)
export const ParamCarrier = Object.freeze({ Query: 'query', Body: 'body', Header: 'header', Path: 'path' });

// upstream: state.rs::AcceptEntry {index, scheme, amount, asset, network}
export const acceptEntry = ({ index, scheme, amount, asset, network }) => struct({ index, scheme, amount, asset, network });

// upstream: state.rs::Candidate (struct order; serde renames)
export const candidate = (c) => struct({
  scheme: c.scheme, acceptsIndex: c.acceptsIndex, chainId: c.chainId, chainName: c.chainName, isMainnet: c.isMainnet,
  tokenSymbol: c.tokenSymbol, amount: c.amount, amountHuman: c.amountHuman, decimals: c.decimals ?? 0, hasBalance: c.hasBalance,
  balanceStatus: c.balanceStatus ?? 'unavailable', availableAmount: c.availableAmount ?? '', requiredAmount: c.requiredAmount ?? '',
  shortfall: c.shortfall ?? '', depositAddress: c.depositAddress ?? '', recommended: c.recommended ?? null,
});

// upstream: state.rs::DecodedChallenge
export const decodedChallenge = (d) => struct({
  amount: d.amount, amountHuman: d.amountHuman, decimals: d.decimals, recipient: d.recipient, expires: d.expires,
  supported: d.supported, unsupported_reason: d.unsupported_reason ?? null,
});

// upstream: state.rs::ParamSpec {name, carrier (default query), required (default false), type (skip empty)}
export const paramSpec = ({ name, carrier = ParamCarrier.Query, required = false, type = '' }) =>
  struct({ name, carrier, required, type: type === '' ? undefined : type });

// upstream: state.rs::default_http_method
export const defaultHttpMethod = () => 'GET';

// upstream: state.rs::PaymentState (struct order, serde defaults / skips)
export function paymentState(s) {
  return struct({
    payment_id: s.payment_id, owner_wallet: s.owner_wallet, created_at: s.created_at, expires_at: s.expires_at,
    accepts: s.accepts.map(acceptEntry), decoded_challenge: decodedChallenge(s.decoded_challenge),
    candidates: s.candidates.map(candidate), known_params: s.known_params, merchant_body: s.merchant_body,
    // resource: Option<Value> — absent → omitted; a JSON null from the challenge is Some(Null) → null.
    endpoint_url: s.endpoint_url, raw_accepts: s.raw_accepts ?? [], resource: s.resource,
    method: s.method ?? defaultHttpMethod(), param_plan: (s.param_plan ?? []).map(paramSpec), mcpTool: s.mcp_tool ?? undefined,
  });
}

// upstream: state.rs::compute_expires_at — min(challenge_expires, created_at + 300); 0 = unpinned.
export function computeExpiresAt(challengeExpires, createdAt) {
  const ceiling = Number(createdAt) + MAX_QUOTE_TTL_SECS;
  return Number(challengeExpires) === 0 ? ceiling : Math.min(Number(challengeExpires), ceiling);
}

// upstream: state.rs::payments_dir (created on demand, default permissions)
export function paymentsDir() {
  const dir = homePath('payments');
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw context('failed to create ~/.onchainos/payments', new Error(ioErrorText(e))); }
  return dir;
}

// upstream: state.rs::state_path — creates payments/ as a side effect.
export const statePath = (id) => join(paymentsDir(), `${id}.json`);

// upstream: state.rs::PaymentState::write — to_string_pretty → {id}.json.tmp → rename.
export function writeState(st) {
  const path = statePath(st.payment_id);
  const tmp = path.replace(/\.json$/, '.json.tmp');
  const body = stringify(paymentState(st), true);
  try { writeFileSync(tmp, body); } catch (e) { throw context(`write ${tmp}`, new Error(ioErrorText(e))); }
  try { renameSync(tmp, path); } catch (e) { throw context(`rename into ${path}`, new Error(ioErrorText(e))); }
}

// Strict serde decode of a persisted PaymentState (null on any shape mismatch).
function decodeState(v) {
  if (!isObject(v)) return null;
  const str = (k) => asStr(get(v, k));
  const u64 = (k) => asU64(get(v, k));
  const req = ['payment_id', 'owner_wallet', 'merchant_body', 'endpoint_url'];
  for (const k of req) if (str(k) === undefined) return null;
  if (u64('created_at') === undefined || u64('expires_at') === undefined) return null;
  const accepts = get(v, 'accepts'), cands = get(v, 'candidates'), dc = get(v, 'decoded_challenge'), kp = get(v, 'known_params');
  if (!Array.isArray(accepts) || !Array.isArray(cands) || !isObject(dc) || !isObject(kp)) return null;
  const acc = [];
  for (const a of accepts) {
    if (!isObject(a) || asU64(a.index) === undefined || ['scheme', 'amount', 'asset', 'network'].some((k) => asStr(get(a, k)) === undefined)) return null;
    acc.push({ index: asU64(a.index), scheme: a.scheme, amount: a.amount, asset: a.asset, network: a.network });
  }
  const optStr = (o, k, def) => { const x = get(o, k); return x === undefined ? def : asStr(x); };
  const cs = [];
  for (const c of cands) {
    if (!isObject(c)) return null;
    const x = {
      scheme: asStr(get(c, 'scheme')), acceptsIndex: asU64(get(c, 'acceptsIndex')), chainId: asStr(get(c, 'chainId')),
      chainName: asStr(get(c, 'chainName')), isMainnet: asBool(get(c, 'isMainnet')), tokenSymbol: asStr(get(c, 'tokenSymbol')),
      amount: asStr(get(c, 'amount')), amountHuman: asStr(get(c, 'amountHuman')),
      decimals: get(c, 'decimals') === undefined ? 0 : asU64(get(c, 'decimals')), hasBalance: asBool(get(c, 'hasBalance')),
      balanceStatus: optStr(c, 'balanceStatus', 'unavailable'), availableAmount: optStr(c, 'availableAmount', ''),
      requiredAmount: optStr(c, 'requiredAmount', ''), shortfall: optStr(c, 'shortfall', ''), depositAddress: optStr(c, 'depositAddress', ''),
    };
    if (Object.values(x).some((y) => y === undefined)) return null;
    if (typeof x.decimals !== 'number' || x.decimals > 4294967295) return null;
    const rec = get(c, 'recommended');
    if (rec !== undefined && rec !== null && typeof rec !== 'boolean') return null;
    x.recommended = rec ?? null;
    cs.push(x);
  }
  const d = {
    amount: asStr(get(dc, 'amount')), amountHuman: asStr(get(dc, 'amountHuman')), decimals: asU64(get(dc, 'decimals')),
    recipient: asStr(get(dc, 'recipient')), expires: asU64(get(dc, 'expires')), supported: asBool(get(dc, 'supported')),
  };
  if (Object.values(d).some((y) => y === undefined) || typeof d.decimals !== 'number' || d.decimals > 4294967295) return null;
  const ur = get(dc, 'unsupported_reason');
  if (ur !== undefined && ur !== null && typeof ur !== 'string') return null;
  d.unsupported_reason = ur ?? null;
  const raw = get(v, 'raw_accepts');
  if (raw !== undefined && !Array.isArray(raw)) return null;
  const method = get(v, 'method');
  if (method !== undefined && typeof method !== 'string') return null;
  const plan = get(v, 'param_plan');
  if (plan !== undefined && !Array.isArray(plan)) return null;
  const pp = [];
  for (const p of plan ?? []) {
    if (!isObject(p) || asStr(get(p, 'name')) === undefined) return null;
    // `#[serde(default)]` applies only to an ABSENT key; an explicit `null` is a type error
    // (enum / bool / String cannot deserialize from null) → the whole state is unreadable.
    const orDefault = (k, def) => (Object.prototype.hasOwnProperty.call(p, k) ? p[k] : def);
    const carrier = orDefault('carrier', 'query');
    if (!Object.values(ParamCarrier).includes(carrier)) return null;
    const required = orDefault('required', false);
    if (typeof required !== 'boolean') return null;
    const type = orDefault('type', '');
    if (typeof type !== 'string') return null;
    pp.push({ name: p.name, carrier, required, type });
  }
  const tool = get(v, 'mcpTool');
  if (tool !== undefined && tool !== null && typeof tool !== 'string') return null;
  const resource = get(v, 'resource');
  return {
    payment_id: str('payment_id'), owner_wallet: str('owner_wallet'), created_at: u64('created_at'), expires_at: u64('expires_at'),
    accepts: acc, decoded_challenge: d, candidates: cs, known_params: kp, merchant_body: str('merchant_body'),
    endpoint_url: str('endpoint_url'), raw_accepts: raw ?? [], resource: resource === null ? undefined : resource,
    method: method ?? defaultHttpMethod(), param_plan: pp, mcp_tool: tool ?? undefined,
  };
}

// upstream: state.rs::read — missing/unparseable → quote_expired_or_missing; owner mismatch →
// cross_user_payment_id (checked before TTL); now > expires_at → cleanup + quote_expired_or_missing.
export function read(id, currentOwner, now) {
  const path = statePath(id);
  let body;
  try { body = readFileSync(path, 'utf8'); } catch { throw new Error(`${TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${id}`); }
  let st;
  try { st = decodeState(parse(body)); } catch { st = null; }
  if (!st) throw new Error(`${TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${id}`);
  if (st.owner_wallet !== currentOwner) throw new Error(`${TOKEN_CROSS_USER}: ${id}`);
  if (Number(now) > Number(st.expires_at)) {
    cleanup(id);
    throw new Error(`${TOKEN_QUOTE_EXPIRED_OR_MISSING}: ${id}`);
  }
  return st;
}

// upstream: state.rs::cleanup — best-effort delete.
export function cleanup(id) {
  let path;
  try { path = statePath(id); } catch { return; }
  try { rmSync(path); } catch {}
}

// upstream: state.rs::current_owner_id — selected account id, or null when not logged in.
export function currentOwnerId() {
  let w;
  try { w = loadWallets(); } catch { return null; }
  if (!w) return null;
  return w.selectedAccountId === '' ? null : w.selectedAccountId;
}
