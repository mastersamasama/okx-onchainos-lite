// `payment quote` — probe an HTTP 402 / A2MCP endpoint, parse the challenge, preflight
// balances, rank candidates and persist a paymentId for `payment pay --payment-id`. Never
// signs. Upstream commands/payment/quote.rs.
import { createHash } from 'node:crypto';
import { ApiClient } from '../core/http.mjs';
import { chainDisplayName } from '../core/chains.mjs';
import { trim, eqIgnoreAsciiCase, asciiLower } from '../core/rs/str.mjs';
import { get, asStr, asU64, isObject, cloneValue } from '../core/rs/value.mjs';
import { u256FromStrRadix, parseU32, toU32 } from '../core/rs/num.mjs';
import { loadWallets } from '../wallet/store.mjs';
import { fromStr as serdeFromStr } from '../core/serde.mjs';
import { fetchInfo } from '../commands/token/token.mjs';
import { fetchAllBalances } from '../commands/portfolio/portfolio.mjs';
import { decodePaymentBlob } from './dispatcher.mjs';
import { buildRequest } from './http-carrier.mjs';
import { extractAmount, selectAcceptWithPreference, isMainnetChain, rankCandidates } from './payment-flow.mjs';
import * as state from './state.mjs';
import { toValue } from './permit2/types.mjs';
import { McpClient, urlLooksLikeMcp, probeSignalsMcp, coerceArguments } from './_mcp-client.mjs';
import { send, headerStr, text as respText } from './_http.mjs';

// upstream: quote.rs machine tokens
export const TOKEN_ENDPOINT_UNREACHABLE = 'endpoint_unreachable';
export const TOKEN_UNSUPPORTED = 'unsupported';
export const TOKEN_INVALID_INPUT = 'invalid_input';
export const TOKEN_AUTH_REQUIRED = 'auth_required';
export const TOKEN_ENDPOINT_SERVER_ERROR = 'endpoint_server_error';
const PROBE_TIMEOUT_MS = 10000;
const DEFAULT_DECIMALS = 6;

// upstream: quote.rs::QuoteData — `serde_json::to_value` ⇒ keys sorted at every level.
function quoteData(d) {
  return toValue({
    paymentId: d.paymentId ? d.paymentId : undefined,
    needsConfirm: d.needsConfirm, summary: d.summary, nextStep: d.nextStep,
    accepts: d.accepts ?? [], knownParams: d.knownParams, merchantBody: d.merchantBody,
    missingParams: d.missingParams ?? [], paramPlan: (d.paramPlan ?? []).map(state.paramSpec),
    candidates: (d.candidates ?? []).map(state.candidate), alternatives: (d.alternatives ?? []).map(state.candidate),
    decodedChallenge: state.decodedChallenge(d.decodedChallenge), walletError: d.walletError ?? undefined,
    mcpTools: d.mcpTools?.length ? d.mcpTools : undefined, result: d.result,
  });
}

// upstream: quote.rs::run — CLI handler (returns the data payload).
export const run = (url, param, method, tool) => fetchQuote(url, param, method, tool);

// upstream: quote.rs::fetch_quote — CLI + MCP `payment_quote` data path.
export async function fetchQuote(url, param, method, tool) {
  const knownParams = parseParams(param);
  if (tool != null || urlLooksLikeMcp(url)) return fetchQuoteMcp(url, knownParams, tool);
  const outcome = await probeEndpoint(url, knownParams, method);
  if (outcome.kind === 'NoCharge') {
    return quoteData({
      needsConfirm: false, summary: 'Endpoint returned 200 — no payment required', nextStep: '',
      knownParams, merchantBody: outcome.body, decodedChallenge: freeChallenge(),
    });
  }
  if (outcome.kind === 'MaybeMcp') return fetchQuoteMcp(url, knownParams, tool);
  return buildQuoteFromChallenge(url, knownParams, method, outcome.header, outcome.body, null);
}

// upstream: quote.rs::fetch_quote_mcp (private)
async function fetchQuoteMcp(url, knownParams, tool) {
  const client = new McpClient(url);
  await client.initialize();
  const tools = await client.listTools();
  if (tool == null) {
    return quoteData({
      needsConfirm: false, summary: `MCP server exposes ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
      nextStep: `onchainos payment quote ${url} --tool <name> [--param k=v] — pick a tool to trigger its 402`,
      knownParams: cloneValue(knownParams), merchantBody: '', decodedChallenge: freeChallenge(), mcpTools: tools,
    });
  }
  const selected = tools.find((t) => t.name === tool);
  if (!selected) throw new Error(`${TOKEN_INVALID_INPUT}: tool '${tool}' not found; available tools: [${tools.map((t) => t.name).join(', ')}]`);
  const args = coerceArguments(knownParams, selected.inputSchema);
  const outcome = await client.callTool(tool, args);
  if (outcome.kind === 'Paid') return buildQuoteFromChallenge(url, args, 'POST', outcome.header, outcome.body, tool);
  return quoteData({
    needsConfirm: false, summary: `MCP tool '${tool}' returned a result — no payment required`, nextStep: '',
    knownParams: cloneValue(knownParams), merchantBody: '', decodedChallenge: freeChallenge(), result: outcome.result,
  });
}

// upstream: quote.rs::build_quote_from_challenge (private) — decode, rank, preflight, persist.
async function buildQuoteFromChallenge(url, knownParams, method, challengeHeader, merchantBody, mcpTool) {
  let decoded;
  try { decoded = decodePaymentBlob(challengeHeader); } catch (e) { throw new Error(`${TOKEN_UNSUPPORTED}: could not decode 402 challenge: ${e.message}`); }
  const acceptsVal = get(decoded, 'accepts');
  if (!Array.isArray(acceptsVal)) throw new Error(`${TOKEN_UNSUPPORTED}: 402 challenge has no accepts[] array`);
  if (!acceptsVal.length) throw new Error(`${TOKEN_UNSUPPORTED}: 402 challenge accepts[] is empty`);

  const accepts = buildAccepts(acceptsVal);
  const resolver = new DecimalResolver();
  const decodedChallenge = await buildDecodedChallenge(acceptsVal, resolver);
  if (!decodedChallenge.supported) throw new Error(`${TOKEN_UNSUPPORTED}: ${decodedChallenge.unsupported_reason ?? 'no supported scheme'}`);

  const outputSchema = findOutputSchema(decoded, merchantBody);
  const inputSpec = get(outputSchema, 'input');
  const paramPlan = inputSpec === undefined ? [] : parseParamPlan(inputSpec);
  const paidMethod = asStr(get(outputSchema, 'method')) ?? method;

  const candidates0 = await buildCandidates(acceptsVal, accepts, resolver);
  const walletError = await preflightBalances(candidates0, accepts);
  const [candidates, alternatives] = rankCandidates(candidates0);

  const createdAt = nowUnix();
  const owner = state.currentOwnerId() ?? '';
  const paymentId = newPaymentId(url, createdAt);
  const expiresAt = state.computeExpiresAt(decodedChallenge.expires, createdAt);
  const missing = missingParams(merchantBody, knownParams, paramPlan);
  state.writeState({
    payment_id: paymentId, owner_wallet: owner, created_at: createdAt, expires_at: expiresAt, accepts,
    decoded_challenge: decodedChallenge, candidates: [...candidates, ...alternatives], known_params: knownParams,
    merchant_body: merchantBody, endpoint_url: url, raw_accepts: acceptsVal, resource: get(decoded, 'resource'),
    method: paidMethod, param_plan: paramPlan, mcp_tool: mcpTool ?? undefined,
  });
  return quoteData({
    paymentId, needsConfirm: true, summary: buildSummary(candidates, alternatives, decodedChallenge),
    nextStep: `onchainos payment pay --payment-id ${paymentId} --selected-index <n> --yes`,
    accepts, knownParams, merchantBody, missingParams: missing, paramPlan, candidates, alternatives, decodedChallenge,
    walletError,
  });
}

// upstream: quote.rs::parse_params — repeatable k=v → sorted map of strings.
export function parseParams(param) {
  const map = {};
  for (const raw of param ?? []) {
    const i = raw.indexOf('=');
    if (i < 0) throw new Error(`${TOKEN_INVALID_INPUT}: --param must be key=value, got '${raw}'`);
    const k = trim(raw.slice(0, i));
    if (k === '') throw new Error(`${TOKEN_INVALID_INPUT}: --param key must not be empty`);
    map[k] = raw.slice(i + 1);
  }
  return map;
}

const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedKeys = (o) => Object.keys(o).sort(byteCmp);

// upstream: quote.rs::probe_endpoint (private) → {kind: NoCharge|Challenge|MaybeMcp}
export async function probeEndpoint(url, knownParams, method) {
  const params = sortedKeys(knownParams).filter((k) => typeof knownParams[k] === 'string').map((k) => [k, knownParams[k]]);
  const req = buildRequest(method, url, params, []);
  let resp;
  try { resp = await send({ ...req, timeoutMs: PROBE_TIMEOUT_MS }); } catch (e) { throw new Error(`${TOKEN_ENDPOINT_UNREACHABLE}: ${e.message}`); }
  const status = resp.status;
  const hname = resp.headers['payment-required'] !== undefined ? 'PAYMENT-REQUIRED' : 'WWW-Authenticate';
  const header = headerStr(resp, hname);
  const contentType = headerStr(resp, 'content-type') ?? '';
  const body = respText(resp);
  if (status === 402) return { kind: 'Challenge', header: header ?? body, body };
  if (probeSignalsMcp(contentType, body)) return { kind: 'MaybeMcp' };
  if (status >= 200 && status <= 299) return { kind: 'NoCharge', body };
  const token = classifyProbeError(status);
  if (status === 405) {
    throw new Error(`${token}: endpoint returned HTTP 405 to the ${method} probe — if this is an A2MCP endpoint, retry with --tool <name> (MCP transport) or --method POST (REST)`);
  }
  throw new Error(`${token}: unexpected HTTP ${status} (expected 402 or 200)`);
}

// upstream: quote.rs::classify_probe_error (private)
export function classifyProbeError(status) {
  if (status === 401 || status === 403) return TOKEN_AUTH_REQUIRED;
  if (status >= 500 && status <= 599) return TOKEN_ENDPOINT_SERVER_ERROR;
  return TOKEN_ENDPOINT_UNREACHABLE;
}

const strOr = (v, k) => asStr(get(v, k)) ?? '';
function extractAmountOrEmpty(e) { try { return extractAmount(e); } catch { return ''; } }

// upstream: quote.rs::build_accepts (private) → AcceptEntry[]
export function buildAccepts(acceptsVal) {
  return acceptsVal.map((e, i) => ({ index: i, scheme: strOr(e, 'scheme'), amount: extractAmountOrEmpty(e), asset: strOr(e, 'asset'), network: strOr(e, 'network') }));
}

// upstream: quote.rs::declared_decimals (private) — extra.decimals, else top-level decimals.
export function declaredDecimals(entry) {
  const extra = get(entry, 'extra');
  const v = get(extra, 'decimals') !== undefined ? get(extra, 'decimals') : get(entry, 'decimals');
  if (v === undefined) return undefined;
  const n = asU64(v);
  if (n !== undefined) return toU32(n);
  return typeof v === 'string' ? parseU32(v) : undefined;
}

// upstream: quote.rs::entry_asset_and_chain (private) → [chainId, asset] | undefined
function entryAssetAndChain(entry) {
  const asset = asStr(get(entry, 'asset'));
  if (asset === undefined || asset === '') return undefined;
  const network = asStr(get(entry, 'network')) ?? '';
  return [network.startsWith('eip155:') ? network.slice(7) : network, asset];
}

// upstream: quote.rs::fetch_token_meta_from_okx_dex (private) — best-effort basic-info lookup.
async function fetchTokenMetaFromOkxDex(client, chainId, address) {
  let resp;
  try { resp = await fetchInfo(client, address, chainId); } catch { return {}; }
  const item = Array.isArray(resp) ? resp[0] : undefined;
  if (item === undefined) return {};
  const d = get(item, 'decimal');
  let decimals = typeof d === 'string' ? parseU32(d) : undefined;
  if (decimals === undefined) { const n = asU64(get(item, 'decimals')); if (n !== undefined) decimals = toU32(n); }
  const s = get(item, 'symbol') !== undefined ? get(item, 'symbol') : get(item, 'tokenSymbol');
  const symbol = typeof s === 'string' && s !== '' ? s : undefined;
  return { decimals, symbol };
}

// upstream: quote.rs::DecimalResolver — memoised (chainIndex, address) basic-info lookups.
export class DecimalResolver {
  constructor() {
    try { this.client = ApiClient.sync(); } catch { this.client = null; }
    this.memo = new Map();
  }
  async ensureMeta(entry) {
    const ka = entryAssetAndChain(entry);
    if (!ka) return undefined;
    const key = `${ka[0]}\u0000${ka[1]}`;
    if (!this.memo.has(key)) this.memo.set(key, this.client ? await fetchTokenMetaFromOkxDex(this.client, ka[0], ka[1]) : {});
    return this.memo.get(key);
  }
  async resolve(entry) {
    const d = declaredDecimals(entry);
    if (d !== undefined) return d;
    const meta = await this.ensureMeta(entry);
    return meta?.decimals ?? DEFAULT_DECIMALS;
  }
  async resolveSymbol(entry) { return (await this.ensureMeta(entry))?.symbol; }
}

// upstream: quote.rs::build_decoded_challenge (private)
async function buildDecodedChallenge(acceptsVal, resolver) {
  let entry;
  try { [entry] = selectAcceptWithPreference(acceptsVal, null); } catch (e) { throw new Error(`${TOKEN_UNSUPPORTED}: ${e.message}`); }
  const amount = extractAmountOrEmpty(entry);
  const decimals = await resolver.resolve(entry);
  const recipient = strOr(entry, 'payTo');
  let expires = 0;
  for (const e of acceptsVal) { const x = asU64(get(e, 'expires')); if (x !== undefined) { expires = x; break; } }
  const known = ['exact', 'aggr_deferred', 'charge', 'upto', 'period'];
  const supported = acceptsVal.some((e) => known.includes(asStr(get(e, 'scheme'))));
  return {
    amount, amountHuman: humanAmount(amount, decimals), decimals, recipient, expires, supported,
    unsupported_reason: supported ? null : 'no supported payment scheme in accepts[]',
  };
}

// upstream: quote.rs::build_candidates (private)
async function buildCandidates(acceptsVal, accepts, resolver) {
  const out = [];
  for (const a of accepts) {
    const entry = acceptsVal[a.index];
    const chainId = a.network.startsWith('eip155:') ? a.network.slice(7) : a.network;
    const tokenSymbol = (await resolver.resolveSymbol(entry)) ?? asStr(get(get(entry, 'extra'), 'name')) ?? a.asset;
    const decimals = await resolver.resolve(entry);
    out.push({
      scheme: a.scheme, acceptsIndex: a.index, chainId, chainName: chainDisplayName(chainId), isMainnet: isMainnetChain(chainId),
      tokenSymbol, amount: a.amount, amountHuman: humanAmount(a.amount, decimals), decimals, hasBalance: false,
      balanceStatus: 'unavailable', availableAmount: '', requiredAmount: humanAmount(a.amount, decimals), shortfall: '',
      depositAddress: '', recommended: null,
    });
  }
  return out;
}

// upstream: quote.rs::preflight_balances (private) — mutates candidates; → walletError | null
async function preflightBalances(candidates, accepts) {
  let wallets;
  try { wallets = loadWallets(); } catch { wallets = null; }
  if (!wallets || wallets.selectedAccountId === '') return 'login_required';
  const account = Object.prototype.hasOwnProperty.call(wallets.accountsMap, wallets.selectedAccountId) ? wallets.accountsMap[wallets.selectedAccountId] : undefined;
  if (!account) return 'login_required';
  const client = ApiClient.sync();
  let anyError = false;
  const chainIds = [...new Set(candidates.map((c) => c.chainId))].sort(byteCmp);
  for (const chainId of chainIds) {
    const addr = account.addressList.find((a) => a.chainIndex === chainId)?.address;
    if (addr === undefined) { anyError = true; continue; }
    for (const c of candidates) if (c.chainId === chainId) c.depositAddress = addr;
    let bal;
    try { bal = await fetchAllBalances(client, addr, chainId, undefined, undefined); } catch { anyError = true; continue; }
    for (const c of candidates.filter((x) => x.chainId === chainId)) {
      const asset = accepts.find((a) => a.index === c.acceptsIndex)?.asset ?? '';
      const available = candidateBalanceAtomic(bal, c.tokenSymbol, asset, c.decimals);
      if (available === undefined) { anyError = true; c.balanceStatus = 'unavailable'; continue; }
      let required;
      try { required = u256FromStrRadix(c.amount, 10); } catch { anyError = true; c.balanceStatus = 'unavailable'; continue; }
      c.hasBalance = available > 0n;
      c.availableAmount = humanAmount(available.toString(), c.decimals);
      c.requiredAmount = c.amountHuman;
      if (available >= required) { c.balanceStatus = 'sufficient'; c.shortfall = '0'; }
      else { c.balanceStatus = 'insufficient'; c.shortfall = humanAmount((required - available).toString(), c.decimals); }
    }
  }
  return anyError ? 'balance_unavailable' : null;
}

// upstream: quote.rs::prepare_a2mcp_candidates — build + preflight, no ranking, no state file.
export async function prepareA2mcpCandidates(acceptsVal) {
  const accepts = buildAccepts(acceptsVal);
  const candidates = await buildCandidates(acceptsVal, accepts, new DecimalResolver());
  const walletError = await preflightBalances(candidates, accepts);
  return [candidates, walletError];
}

// upstream: quote.rs::refresh_a2mcp_candidate_balances — balance fields only (mutates).
export async function refreshA2mcpCandidateBalances(candidates, acceptsVal) {
  return preflightBalances(candidates, buildAccepts(acceptsVal));
}

// upstream: quote.rs::balance_entry_addr (private)
function balanceEntryAddr(o) {
  const k = ['tokenContractAddress', 'tokenAddress', 'contractAddress'].find((x) => get(o, x) !== undefined);
  return k === undefined ? undefined : asStr(o[k]);
}

// upstream: quote.rs::balance_has_contract_addr_field (private)
function balanceHasContractAddrField(v) {
  if (Array.isArray(v)) return v.some(balanceHasContractAddrField);
  if (isObject(v)) return balanceEntryAddr(v) !== undefined || sortedKeys(v).some((k) => balanceHasContractAddrField(v[k]));
  return false;
}

// upstream: quote.rs::find_balance_entry (private) — depth-first; object tested before its values.
function findBalanceEntry(v, matches) {
  if (Array.isArray(v)) { for (const x of v) { const r = findBalanceEntry(x, matches); if (r) return r; } return undefined; }
  if (isObject(v)) {
    if (matches(v)) return v;
    for (const k of sortedKeys(v)) { const r = findBalanceEntry(v[k], matches); if (r) return r; }
  }
  return undefined;
}

// upstream: quote.rs::human_to_atomic (private) → BigInt | undefined
export function humanToAtomic(human, decimals) {
  const raw = trim(human);
  if (raw === '' || raw.startsWith('-') || /[eE]/.test(raw)) return undefined;
  const i = raw.indexOf('.');
  const whole = i < 0 ? raw : raw.slice(0, i), fraction = i < 0 ? '' : raw.slice(i + 1);
  if (!/^[0-9]*$/.test(whole) || !/^[0-9]*$/.test(fraction) || fraction.length > decimals) return undefined;
  const normalized = (whole + fraction + '0'.repeat(decimals - fraction.length)).replace(/^0+/, '');
  try { return u256FromStrRadix(normalized === '' ? '0' : normalized, 10); } catch { return undefined; }
}

// upstream: quote.rs::balance_entry_atomic (private)
function balanceEntryAtomic(entry, decimals) {
  const rk = get(entry, 'rawBalance') !== undefined ? 'rawBalance' : 'balanceRawAmount';
  const raw = asStr(get(entry, rk));
  if (raw !== undefined) { try { return u256FromStrRadix(raw, 10); } catch {} }
  const b = asStr(get(entry, 'balance'));
  return b === undefined ? undefined : humanToAtomic(b, decimals);
}

// upstream: quote.rs::candidate_balance_atomic (private) — contract address first, symbol fallback.
export function candidateBalanceAtomic(balances, symbol, asset, decimals) {
  const byAddress = asset !== '' && balanceHasContractAddrField(balances);
  const entry = findBalanceEntry(balances, (o) => {
    if (byAddress) { const a = balanceEntryAddr(o); return a !== undefined && eqIgnoreAsciiCase(a, asset); }
    const s = asStr(get(o, 'symbol'));
    return s !== undefined && eqIgnoreAsciiCase(s, symbol);
  });
  return entry ? balanceEntryAtomic(entry, decimals) : 0n;
}

// upstream: quote.rs::build_summary (private)
export function buildSummary(candidates, _alternatives, challenge) {
  const pick = candidates.find((c) => c.recommended === true) ?? candidates[0];
  if (!pick) return `Will pay ${challenge.amountHuman}`;
  const verb = eqIgnoreAsciiCase(pick.scheme, 'upto') ? 'Will pay up to' : 'Will pay';
  return `${verb} ${pick.amountHuman} ${pick.tokenSymbol} (${pick.scheme}, ${pick.chainName})`;
}

const parseJson = (s) => { try { return { v: serdeFromStr(s) }; } catch { return null; } };

// upstream: quote.rs::missing_params (private) — plan-required first, then body missingParams/required.
export function missingParams(merchantBody, knownParams, plan) {
  const out = [];
  const push = (k) => { if (!Object.prototype.hasOwnProperty.call(knownParams, k) && !out.includes(k)) out.push(k); };
  for (const s of plan) if (s.required) push(s.name);
  const p = parseJson(merchantBody);
  if (p) {
    const list = get(p.v, 'missingParams') !== undefined ? get(p.v, 'missingParams') : get(p.v, 'required');
    if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') push(k);
  }
  return out;
}

// upstream: quote.rs::find_output_schema (private)
export function findOutputSchema(decoded, merchantBody) {
  const s = get(decoded, 'outputSchema');
  if (s !== undefined && s !== null) return cloneValue(s);
  const p = parseJson(merchantBody);
  const b = p ? get(p.v, 'outputSchema') : undefined;
  return b === undefined || b === null ? undefined : b;
}

// upstream: quote.rs::parse_carrier (private)
export function parseCarrier(s) {
  const l = asciiLower(s);
  return l === 'body' || l === 'header' || l === 'path' ? l : state.ParamCarrier.Query;
}

// upstream: quote.rs::param_spec_from (private)
function paramSpecFrom(name, spec) {
  const c = asStr(get(spec, 'carrier'));
  const r = get(spec, 'required');
  return { name, carrier: c === undefined ? state.ParamCarrier.Query : parseCarrier(c), required: typeof r === 'boolean' ? r : false, type: asStr(get(spec, 'type')) ?? '' };
}

// upstream: quote.rs::parse_param_plan (private) — object map (sorted keys) or array of {name,…}.
export function parseParamPlan(input) {
  if (isObject(input)) return sortedKeys(input).map((k) => paramSpecFrom(k, input[k]));
  if (Array.isArray(input)) return input.filter((s) => typeof get(s, 'name') === 'string').map((s) => paramSpecFrom(s.name, s));
  return [];
}

// upstream: quote.rs::now_unix (private)
export const nowUnix = () => Math.max(0, Math.floor(Date.now() / 1000));

// upstream: quote.rs::new_payment_id — "pay_" + hex(sha256(url ‖ createdAt LE ‖ nanos LE)[0..12]).
export function newPaymentId(url, createdAt, nanos = BigInt(Date.now()) * 1000000n + process.hrtime.bigint() % 1000000n) {
  const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return b; };
  const h = createHash('sha256').update(Buffer.from(String(url), 'utf8')).update(le64(createdAt)).update(le64(nanos)).digest();
  return 'pay_' + h.subarray(0, 12).toString('hex');
}

// upstream: quote.rs::human_amount — string-based atomic → human (no float rounding).
export function humanAmount(atomic, decimals) {
  const digits = String(atomic).replace(/[^0-9]/g, '');
  if (digits === '') return '0';
  const d = Number(decimals);
  if (d === 0) return digits.replace(/^0+/, '') || '0';
  const padded = digits.padStart(d + 1, '0');
  const split = padded.length - d;
  const intPart = padded.slice(0, split).replace(/^0+/, '') || '0';
  const frac = padded.slice(split).replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

// upstream: quote.rs::free_challenge (private)
export const freeChallenge = () => ({ amount: '0', amountHuman: '0', decimals: 0, recipient: '', expires: 0, supported: true, unsupported_reason: null });
