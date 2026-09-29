// Shared x402 payment signing + two-phase pay + session decision layer — upstream
// commands/payment/payment_flow.rs. Used by `payment pay` / `pay-local`, the ApiClient x402
// auto-pay layer (via x402-header.mjs), subscription, A2MCP and the MCP payment tools.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { home } from '../core/home.mjs';
import * as keyring from '../core/keyring.mjs';
import { context, Confirming } from '../core/errors.mjs';
import { stringify, parse as jsonParse } from '../core/json.mjs';
import { trim, eqIgnoreAsciiCase, asciiLower } from '../core/rs/str.mjs';
import { hpkeDecryptSessionSk, ed25519Sign, eip3009Sign } from '../core/crypto.mjs';
import { at, get, asStr, asU64, isObject, numText, isNumber, cloneValue } from '../core/rs/value.mjs';
import { intFromStr, intFromStrOk, parseU64, u256FromStr, u256FromStrRadix, U256_MAX } from '../core/rs/num.mjs';
import { hexDecode } from '../core/rs/codec.mjs';
import { ReqwestError } from '../core/rs/reqwest.mjs';
import { ioErrorText } from '../core/rs/fs.mjs';
import { isMainnetChain as chainsIsMainnet, PERMIT2_ADDRESS, X402_EXACT_PERMIT2_PROXY, X402_UPTO_PERMIT2_PROXY } from '../core/chains.mjs';
import { ensureTokensRefreshed, formatApiError } from '../wallet/auth.mjs';
import { WalletApiClient } from '../wallet/api.mjs';
import { loadWallets, loadSession } from '../wallet/store.mjs';
import { ERR_NOT_LOGGED_IN } from '../wallet/common.mjs';
import { getChainByRealChainIndex, getChainByIndex, getRealChainIndex } from '../wallet/chain.mjs';
import { resolveAddress } from '../wallet/transfer/index.mjs';
import { resolveChain } from '../core/chains.mjs';
import { parseRecipientAddr } from './addr.mjs';
import * as state from './state.mjs';
import { A2mcpPaymentSource, ERR_CONFIRMATION_REQUIRED, ERR_OVERRIDES_FORBIDDEN, inspectPaymentSource, readA2mcpPaymentIntent } from './a2mcp.mjs';
import { decodeReceipt } from './decode-receipt.mjs';
import { buildRequest, buildTypedRequest } from './http-carrier.mjs';
import { send, headerStr, text as respText } from './_http.mjs';
import { McpClient, coerceArguments } from './_mcp-client.mjs';
import { fetchPermit2Allowance } from './permit2/rpc.mjs';
import { CLOCK_SKEW_BACKDATE_SECS, toValue } from './permit2/types.mjs';
import { signExactPermit2, signUptoPermit2, signExactPermit2Local, signUptoPermit2Local, GEN_MSG_HASH_PATH, SIGN_MSG_PATH } from './permit2/sign.mjs';
import { signSubscribe } from './subscription/sign.mjs';
import * as paymentCache from './_payment-cache.mjs';
import { privateKeyAddress, addressFromStr } from './_alloy.mjs';

// ── PaymentTier ──────────────────────────────────────────────────────
// upstream: payment_flow.rs::PaymentTier — represented by its key string.
export const PaymentTier = Object.freeze({
  Basic: 'basic', Premium: 'premium',
  asKey: (t) => t,
  // upstream: PaymentTier::from_server_str (ASCII case-insensitive)
  fromServerStr: (s) => (eqIgnoreAsciiCase(String(s), 'basic') ? 'basic' : eqIgnoreAsciiCase(String(s), 'premium') ? 'premium' : null),
});

// upstream: payment_flow.rs::read_private_key — env EVM_PRIVATE_KEY, else $HOME/.env.
export function readPrivateKey() {
  if (process.env.EVM_PRIVATE_KEY !== undefined) return process.env.EVM_PRIVATE_KEY;
  // PathBuf::join: appends one separator, never normalises the existing ones (Display parity).
  const h = home();
  const envPath = /[\\/]$/.test(h) ? `${h}.env` : `${h}${sep}.env`;
  let content;
  try { content = readFileSync(envPath, 'utf8'); } catch (e) {
    throw context(`Wallet not logged in and no EVM_PRIVATE_KEY configured. Either run \`onchainos wallet login\`, or create ${envPath} with a line \`EVM_PRIVATE_KEY=0x<hex_key>\`.`, new Error(ioErrorText(e)));
  }
  for (const raw of content.split('\n')) {
    const line = trim(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line.startsWith('EVM_PRIVATE_KEY=')) {
      const val = line.slice('EVM_PRIVATE_KEY='.length);
      if (val !== '') return val;
    }
  }
  throw new Error(`EVM_PRIVATE_KEY not found in ${envPath}`);
}

// ── PaymentProof ─────────────────────────────────────────────────────
// upstream: payment_flow.rs::PaymentProof — { kind: Eip3009 | Permit2 | Upto | Subscription, … }
export class PaymentProof {
  constructor(fields) { Object.assign(this, fields); }
  static eip3009({ signature, authorization, sessionCert = null }) { return new PaymentProof({ kind: 'Eip3009', signature, authorization, sessionCert }); }
  static permit2({ signature, permit2Authorization }) { return new PaymentProof({ kind: 'Permit2', signature, permit2Authorization }); }
  static upto({ signature, permit2Authorization }) { return new PaymentProof({ kind: 'Upto', signature, permit2Authorization }); }
  static subscription({ terms, permitSingle, termsSignature, permitSingleSignature }) {
    return new PaymentProof({ kind: 'Subscription', terms, permitSingle, termsSignature, permitSingleSignature });
  }
  // upstream: PaymentProof::to_pay_json (json! → sorted keys)
  toPayJson() {
    switch (this.kind) {
      case 'Eip3009': {
        const v = { signature: this.signature, authorization: this.authorization };
        if (this.sessionCert != null) v.sessionCert = this.sessionCert;
        return v;
      }
      case 'Permit2': case 'Upto': return { signature: this.signature, permit2Authorization: this.permit2Authorization };
      default: return { terms: this.terms, permitSingle: this.permitSingle, termsSignature: this.termsSignature, permitSingleSignature: this.permitSingleSignature };
    }
  }
}

// ── accepts selection / amount resolution ────────────────────────────
// upstream: payment_flow.rs::select_accept — honours the saved default asset.
export function selectAccept(accepts) {
  const preferred = paymentCache.load()?.default_asset ?? null;
  return selectAcceptWithPreference(accepts, preferred);
}

// upstream: payment_flow.rs::select_accept_with_preference → [entry, scheme|null]
export function selectAcceptWithPreference(accepts, preferred) {
  if (!accepts.length) throw new Error('accepts array is empty');
  if (preferred) {
    const e = accepts.find((a) => asStr(at(a, 'asset')) === preferred.asset && asStr(at(a, 'network')) === preferred.network);
    if (e) return [cloneValue(e), asStr(at(e, 'scheme')) ?? null];
  }
  const exact = accepts.find((a) => asStr(at(a, 'scheme')) === 'exact');
  if (exact) return [cloneValue(exact), 'exact'];
  const deferred = accepts.find((a) => asStr(at(a, 'scheme')) === 'aggr_deferred');
  if (deferred) return [cloneValue(deferred), 'aggr_deferred'];
  return [cloneValue(accepts[0]), asStr(at(accepts[0], 'scheme')) ?? null];
}

// upstream: payment_flow.rs::extract_amount
export const extractAmount = (entry) => resolveAmount(entry, null);

// upstream: payment_flow.rs::resolve_amount (private)
export function resolveAmount(entry, tier) {
  const amt = get(entry, 'amount');
  if (isObject(amt)) {
    if (!tier) throw new Error('accepts.amount is a tiered object ({basic, premium}) but no tier was specified');
    const key = PaymentTier.asKey(tier);
    const val = get(amt, key);
    if (val === undefined) throw new Error(`accepts.amount is missing '${key}' key`);
    if (typeof val === 'string') return val;
    if (isNumber(val)) return numText(val);
    throw new Error(`accepts.amount.${key} must be a string or number`);
  }
  if (typeof amt === 'string') return amt;
  if (asU64(amt) !== undefined) return String(asU64(amt));
  const max = get(entry, 'maxAmountRequired');
  if (typeof max === 'string') return max;
  if (asU64(max) !== undefined) return String(asU64(max));
  throw new Error("missing 'amount' or 'maxAmountRequired' in accepts entry");
}

// upstream: payment_flow.rs::caip2_to_evm_chain_id (private)
export function caip2ToEvmChainId(network) {
  if (!network.startsWith('eip155:')) throw new Error(`network '${network}' is not a CAIP-2 EVM identifier (eip155:<id>)`);
  try { return intFromStr(network.slice(7), 'u64'); } catch (e) { throw context(`network '${network}' has non-numeric chain id`, e); }
}

// upstream: payment_flow.rs::resolve_entry (private) → ResolvedEntry
export function resolveEntry(entry, scheme, tier) {
  const network = asStr(at(entry, 'network'));
  if (network === undefined) throw new Error("missing 'network' in accepts entry");
  const amount = resolveAmount(entry, tier);
  const payToRaw = asStr(at(entry, 'payTo'));
  if (payToRaw === undefined) throw new Error("missing 'payTo' in accepts entry");
  const chainId = caip2ToEvmChainId(network);
  let payTo;
  try { [payTo] = parseRecipientAddr(payToRaw, chainId); } catch (e) { throw context('accepts.payTo', e); }
  const asset = asStr(at(entry, 'asset'));
  if (asset === undefined) throw new Error("missing 'asset' in accepts entry");
  const maxTimeoutSeconds = asU64(at(entry, 'maxTimeoutSeconds')) ?? 300;
  return { network, amount, payTo, asset, maxTimeoutSeconds, scheme };
}

// upstream: payment_flow.rs::x402_pay_from_accepts (dead upstream; kept for the mirror)
export async function x402PayFromAccepts(accepts, from) {
  let v;
  try { v = jsonParse(accepts); } catch (e) { throw context('accepts must be a valid JSON array', e); }
  const [proof] = await signPaymentWithPreference(v, from ?? null, null, null);
  return proof;
}

// upstream: payment_flow.rs::sign_payment — with the saved default asset.
export async function signPayment(accepts, from, tier) {
  const preferred = paymentCache.load()?.default_asset ?? null;
  return signPaymentWithPreference(accepts, from, tier, preferred);
}

// chain entry fields → [chainIndex, chainName]
function chainIndexOf(entry, missingIdx) {
  const ci = at(entry, 'chainIndex');
  if (typeof ci === 'string') return ci;
  if (asU64(ci) !== undefined) return String(asU64(ci));
  throw new Error(missingIdx);
}
async function loadWalletsOrThrow() {
  const w = loadWallets();
  if (!w) throw new Error(ERR_NOT_LOGGED_IN);
  return w;
}

// upstream: payment_flow.rs::resolve_chain_and_payer(accepted, from) → [chainIndex, realChainId, address]
export async function resolveChainAndPayer(accepted, from) {
  const network = asStr(at(accepted, 'network'));
  if (network === undefined) throw new Error("missing 'network' in accepts entry");
  const realChainId = caip2ToEvmChainId(network);
  const entry = await getChainByRealChainIndex(String(realChainId));
  if (!entry) throw new Error(`chain not found for realChainIndex ${realChainId}`);
  const chainIndex = chainIndexOf(entry, 'missing chainIndex in chain entry');
  const chainName = asStr(at(entry, 'chainName'));
  if (chainName === undefined) throw new Error('missing chainName in chain entry');
  const wallets = await loadWalletsOrThrow();
  const [, info] = resolveAddress(wallets, from ?? undefined, chainName);
  return [chainIndex, realChainId, info.address];
}

// upstream: payment_flow.rs::resolve_chain_and_payer_by_chain(chain, from)
export async function resolveChainAndPayerByChain(chain, from) {
  const chainIndex = resolveChain(chain);
  const entry = await getChainByIndex(chainIndex);
  if (!entry) throw new Error(`chain not found: ${chain}`);
  const chainName = asStr(at(entry, 'chainName'));
  if (chainName === undefined) throw new Error('missing chainName in chain entry');
  const realChainId = await getRealChainIndex(chainIndex);
  const wallets = await loadWalletsOrThrow();
  const [, info] = resolveAddress(wallets, from ?? undefined, chainName);
  return [chainIndex, realChainId, info.address];
}

// upstream: payment_flow.rs::prepare_resolved_entry → [entry (amount collapsed), params]
export function prepareResolvedEntry(accepts, tier, preferred) {
  let entry, scheme;
  if (Array.isArray(accepts)) [entry, scheme] = selectAcceptWithPreference(accepts, preferred);
  else { entry = cloneValue(accepts); scheme = asStr(at(accepts, 'scheme')) ?? null; }
  const params = resolveEntry(entry, scheme, tier);
  if (isObject(get(entry, 'amount'))) entry.amount = params.amount;
  return [entry, params];
}

// upstream: payment_flow.rs::detect_permit2_route → [isUpto, isExactPermit2]
export function detectPermit2Route(entry, params) {
  const scheme = asciiLower(params.scheme ?? '');
  const atm = asStr(get(get(entry, 'extra'), 'assetTransferMethod'));
  return [scheme === 'upto', scheme === 'exact' && atm !== undefined && asciiLower(atm) === 'permit2'];
}

// upstream: payment_flow.rs::preflight_permit2_allowance — probe failure → stderr warning, continue.
export async function preflightPermit2Allowance(chainIndex, asset, payer, requiredAmount) {
  let required;
  try { required = u256FromStr(requiredAmount); } catch (e) { throw context(`invalid required amount (decimal uint256): ${requiredAmount}`, e); }
  let allowance;
  try { allowance = await fetchPermit2Allowance(chainIndex, asset, payer); } catch (e) {
    process.stderr.write(`Warning: Permit2 allowance pre-check unavailable on chain ${chainIndex} (${e.message}); falling back to on-chain settle revert\n`);
    return;
  }
  if (allowance < required) {
    throw new Error(`Permit2 allowance insufficient on token ${asset} for chain ${chainIndex}. Current allowance is ${allowance}, but this payment needs ${required}. The buyer must first call IERC20.approve(${PERMIT2_ADDRESS}, MAX) once before any x402 Permit2 payment can be settled.`);
  }
}

const nowSecs = () => Math.floor(Date.now() / 1000);

// upstream: payment_flow.rs::permit2_timing_and_nonce → [validAfter, deadline, nonce] (decimal strings)
export function permit2TimingAndNonce(maxTimeoutSeconds) {
  const now = BigInt(nowSecs());
  const validAfter = (now > BigInt(CLOCK_SKEW_BACKDATE_SECS) ? now - BigInt(CLOCK_SKEW_BACKDATE_SECS) : 0n).toString();
  const d = now + BigInt(maxTimeoutSeconds);
  if (d > 18446744073709551615n) throw new Error('Permit2 deadline overflow');
  const nonce = BigInt('0x' + randomBytes(32).toString('hex')).toString();
  return [validAfter, d.toString(), nonce];
}

const isScheme = (s, name) => s != null && eqIgnoreAsciiCase(s, name);
function facilitatorOf(entry) {
  const f = asStr(get(get(entry, 'extra'), 'facilitatorAddress'));
  if (f === undefined) throw new Error('upto scheme requires extra.facilitatorAddress in the accepts entry, but it is missing or not a string');
  return f;
}
async function chainEntryForNetwork(network) {
  const realChainId = parseEip155ChainId(network);
  const entry = await getChainByRealChainIndex(String(realChainId));
  if (!entry) throw new Error(`chain not found for realChainIndex ${realChainId}`);
  return [realChainId, entry];
}

// upstream: payment_flow.rs::sign_payment_with_preference — the TEE x402 signer → [proof, entry]
export async function signPaymentWithPreference(accepts, from, tier, preferred) {
  const [entry, params] = prepareResolvedEntry(accepts, tier, preferred);
  const accessToken = await ensureTokensRefreshed();
  const [realChainId, chainEntry] = await chainEntryForNetwork(params.network);
  const chainIndex = chainIndexOf(chainEntry, 'missing chainIndex in chain entry');
  const chainName = asStr(at(chainEntry, 'chainName'));
  if (chainName === undefined) throw new Error('missing chainName in chain entry');
  const wallets = await loadWalletsOrThrow();
  const [, addrInfo] = resolveAddress(wallets, from ?? undefined, chainName);
  const payer = addrInfo.address;
  const [isUpto, isExactPermit2] = detectPermit2Route(entry, params);

  if (isScheme(params.scheme, 'period')) {
    const signed = await signSubscribe(chainIndex, realChainId, payer, entry);
    return [PaymentProof.subscription({
      terms: toValue(signed.payload.terms), permitSingle: toValue(signed.payload.permit),
      termsSignature: signed.payload.termsSignature, permitSingleSignature: signed.payload.permitSignature,
    }), entry];
  }

  if (isUpto || isExactPermit2) {
    await preflightPermit2Allowance(chainIndex, params.asset, payer, params.amount);
    const [validAfter, deadline, nonce] = permit2TimingAndNonce(params.maxTimeoutSeconds);
    if (isExactPermit2) {
      const input = { token: params.asset, amount: params.amount, spender: X402_EXACT_PERMIT2_PROXY, nonce, deadline, witnessTo: params.payTo, witnessValidAfter: validAfter, chainId: realChainId };
      const payload = await signExactPermit2(chainIndex, payer, input);
      return [PaymentProof.permit2({ signature: payload.signature, permit2Authorization: toValue(payload.permit2Authorization) }), entry];
    }
    const facilitator = facilitatorOf(entry);
    const input = { token: params.asset, amount: params.amount, spender: X402_UPTO_PERMIT2_PROXY, nonce, deadline, witnessTo: params.payTo, witnessFacilitator: facilitator, witnessValidAfter: validAfter, chainId: realChainId };
    const payload = await signUptoPermit2(chainIndex, payer, input);
    return [PaymentProof.upto({ signature: payload.signature, permit2Authorization: toValue(payload.permit2Authorization) }), entry];
  }

  // EIP-3009 / aggr_deferred
  const isDeferred = isScheme(params.scheme, 'aggr_deferred');
  let validBefore;
  if (isDeferred) validBefore = U256_MAX.toString();
  else {
    const vb = BigInt(nowSecs()) + BigInt(params.maxTimeoutSeconds);
    if (vb > 18446744073709551615n) throw new Error('timeout overflow');
    validBefore = vb.toString();
  }
  const nonce = '0x' + randomBytes(32).toString('hex');
  const base = { chainIndex, from: payer, to: params.payTo, value: params.amount, validAfter: '0', validBefore, nonce, verifyingContract: params.asset };
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyring.get('session_key'); } catch { throw new Error(ERR_NOT_LOGGED_IN); }
  if (typeof sessionKey !== 'string') throw new Error(ERR_NOT_LOGGED_IN);
  const client = new WalletApiClient();
  let hashResp;
  try { hashResp = await client.postAuthed(GEN_MSG_HASH_PATH, accessToken, base); } catch (e) { throw context('payment gen-msg-hash failed', formatApiError(e)); }
  const msgHash = asStr(at(at(hashResp, 0), 'msgHash'));
  if (msgHash === undefined) throw new Error('missing msgHash in gen-msg-hash response');
  const domainHash = asStr(at(at(hashResp, 0), 'domainHash'));
  if (domainHash === undefined) throw new Error('missing domainHash in gen-msg-hash response');
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  let hashBytes;
  try { hashBytes = hexDecode(trimStart0x(msgHash)); } catch (e) { throw context('invalid msgHash hex', e); }
  const sessionSignature = ed25519Sign(seed, hashBytes).toString('base64');
  seed.fill(0);
  const authorization = { from: payer, to: params.payTo, value: params.amount, validAfter: '0', validBefore, nonce };
  if (isDeferred) return [PaymentProof.eip3009({ signature: sessionSignature, authorization, sessionCert: session.sessionCert }), entry];
  const signBody = { ...base, domainHash, sessionCert: session.sessionCert, sessionSignature };
  let signResp;
  try { signResp = await client.postAuthed(SIGN_MSG_PATH, accessToken, signBody); } catch (e) { throw context('payment sign-msg failed', formatApiError(e)); }
  const sig = asStr(at(at(signResp, 0), 'signature'));
  if (sig === undefined) throw new Error('missing signature in sign-msg response');
  return [PaymentProof.eip3009({ signature: sig, authorization, sessionCert: null }), entry];
}
const trimStart0x = (s) => { let t = s; while (t.startsWith('0x')) t = t.slice(2); return t; };

// upstream: payment_flow.rs::sign_payment_local — no saved-default preference.
export const signPaymentLocal = (accepts, tier) => signPaymentLocalWithPreference(accepts, tier, null);

// EVM_PRIVATE_KEY → 32 key bytes (upstream's inline decode in both local signers).
function loadLocalKey() {
  const pkHex = readPrivateKey();
  const t = trim(pkHex);
  const clean = t.startsWith('0x') ? t.slice(2) : t;
  let pk;
  try { pk = hexDecode(clean); } catch (e) { throw context('EVM_PRIVATE_KEY is not valid hex', e); }
  if (pk.length !== 32) throw new Error(`EVM_PRIVATE_KEY must be 32 bytes (64 hex chars), got ${pk.length}`);
  let from;
  try { from = privateKeyAddress(pk); } catch (e) { throw new Error(`invalid secp256k1 private key: ${e.message}`); }
  return [pk, from];
}

// upstream: payment_flow.rs::sign_payment_local_with_preference
export async function signPaymentLocalWithPreference(accepts, tier, preferred) {
  const isDeferred = (s) => isScheme(s, 'aggr_deferred');
  let [entry, params] = prepareResolvedEntry(accepts, tier, preferred);
  if (isDeferred(params.scheme)) {
    const filtered = (Array.isArray(accepts) ? accepts : []).filter((a) => { const s = asStr(at(a, 'scheme')); return s === undefined || !eqIgnoreAsciiCase(s, 'aggr_deferred'); });
    if (filtered.length) [entry, params] = prepareResolvedEntry(filtered, tier, preferred);
  }
  if (isDeferred(params.scheme)) {
    throw new Error('aggr_deferred requires a TEE session key — not supported in local-key mode. Run `onchainos wallet login` to enable TEE signing.');
  }
  const [isUpto, isExactPermit2] = detectPermit2Route(entry, params);
  if (isUpto || isExactPermit2) return signPermit2LocalInner(entry, params, isUpto);

  const domainName = asStr(at(at(entry, 'extra'), 'name'));
  if (domainName === undefined) throw new Error("missing 'extra.name' (EIP-712 domain name) in accepts entry");
  const domainVersion = asStr(at(at(entry, 'extra'), 'version')) ?? '2';
  const [pk, from] = loadLocalKey();
  const chainId = parseEip155ChainId(params.network);
  const vb = BigInt(nowSecs()) + BigInt(params.maxTimeoutSeconds);
  if (vb > 18446744073709551615n) throw new Error('timeout overflow');
  const nonce = randomBytes(32);
  let to, value, verifyingContract;
  try { to = '0x' + addressFromStr(params.payTo).toString('hex'); } catch (e) { throw context('payTo is not a valid EVM address', e); }
  try { value = u256FromStrRadix(params.amount, 10); } catch (e) { throw new Error(`amount not a valid integer: ${e.message}`); }
  try { verifyingContract = '0x' + addressFromStr(params.asset).toString('hex'); } catch (e) { throw context('asset is not a valid EVM address', e); }
  const sigB64 = eip3009Sign(
    { from, to, value, validAfter: 0n, validBefore: vb, nonce: '0x' + nonce.toString('hex') },
    { name: domainName, version: domainVersion, chainId, verifyingContract }, pk);
  pk.fill(0);
  const signature = '0x' + Buffer.from(sigB64, 'base64').toString('hex');
  const authorization = { from, to: params.payTo, value: params.amount, validAfter: '0', validBefore: vb.toString(), nonce: '0x' + nonce.toString('hex') };
  return [PaymentProof.eip3009({ signature, authorization, sessionCert: null }), entry];
}

// upstream: payment_flow.rs::sign_permit2_local_inner (private)
async function signPermit2LocalInner(entry, params, isUpto) {
  const [pk, payer] = loadLocalKey();
  const [realChainId, chainEntry] = await chainEntryForNetwork(params.network);
  const chainIndex = chainIndexOf(chainEntry, 'missing chainIndex in chain entry');
  await preflightPermit2Allowance(chainIndex, params.asset, payer, params.amount);
  const [validAfter, deadline, nonce] = permit2TimingAndNonce(params.maxTimeoutSeconds);
  if (isUpto) {
    const facilitator = facilitatorOf(entry);
    const input = { token: params.asset, amount: params.amount, spender: X402_UPTO_PERMIT2_PROXY, nonce, deadline, witnessTo: params.payTo, witnessFacilitator: facilitator, witnessValidAfter: validAfter, chainId: realChainId };
    const payload = signUptoPermit2Local(pk, payer, input);
    return [PaymentProof.upto({ signature: payload.signature, permit2Authorization: toValue(payload.permit2Authorization) }), cloneValue(entry)];
  }
  const input = { token: params.asset, amount: params.amount, spender: X402_EXACT_PERMIT2_PROXY, nonce, deadline, witnessTo: params.payTo, witnessValidAfter: validAfter, chainId: realChainId };
  const payload = signExactPermit2Local(pk, payer, input);
  return [PaymentProof.permit2({ signature: payload.signature, permit2Authorization: toValue(payload.permit2Authorization) }), cloneValue(entry)];
}

// upstream: payment_flow.rs::sign_payment_auto — TEE when wallets.json exists, else local key.
export async function signPaymentAuto(accepts, tier) {
  const preferred = paymentCache.load()?.default_asset ?? null;
  const loggedIn = loadWallets() !== null;
  if (loggedIn) return signPaymentWithPreference(accepts, null, tier, preferred);
  warnLocalSigningOnce();
  return signPaymentLocalWithPreference(accepts, tier, preferred);
}

// upstream: payment_flow.rs::write_local_signing_warning (private)
export const LOCAL_SIGNING_WARNING = '[onchainos] payment signed locally with EVM_PRIVATE_KEY (NOT protected by TEE); run `onchainos wallet login` for TEE signing.';

// upstream: payment_flow.rs::warn_local_signing_once — once per process and per cache lifetime.
let warned = false;
export function warnLocalSigningOnce() {
  if (warned) return;
  warned = true;
  const prior = paymentCache.load() ?? paymentCache.defaultCache();
  if (prior.local_signing_warned) return;
  process.stderr.write(LOCAL_SIGNING_WARNING + '\n');
  const fresh = paymentCache.load() ?? paymentCache.defaultCache();
  fresh.local_signing_warned = true;
  try { paymentCache.save(fresh); } catch {}
}

// upstream: payment_flow.rs::build_payment_header — resource {url, mimeType:"application/json"}.
export function buildPaymentHeader(proof, entry, resource) {
  return assembleV2PaymentHeader(proof, entry, { url: resource, mimeType: 'application/json' });
}

// upstream: payment_flow.rs::assemble_v2_payment_header → ["PAYMENT-SIGNATURE", base64(JSON)]
export function assembleV2PaymentHeader(proof, entry, resource) {
  const accepted = cloneValue(entry);
  let inner;
  if (proof.kind === 'Eip3009') {
    if (proof.sessionCert != null && isObject(accepted)) {
      if (accepted.extra === undefined) accepted.extra = {};
      if (isObject(accepted.extra)) accepted.extra.sessionCert = proof.sessionCert;
    }
    inner = { signature: proof.signature, authorization: proof.authorization };
  } else if (proof.kind === 'Permit2' || proof.kind === 'Upto') {
    inner = { signature: proof.signature, permit2Authorization: proof.permit2Authorization };
  } else {
    inner = { terms: proof.terms, permitSingle: proof.permitSingle, termsSignature: proof.termsSignature, permitSingleSignature: proof.permitSingleSignature };
  }
  const body = { x402Version: 2, resource, accepted, payload: inner };
  return ['PAYMENT-SIGNATURE', Buffer.from(stringify(body), 'utf8').toString('base64')];
}

// upstream: payment_flow.rs::pay_with_header_json
export function payWithHeaderJson(proof, entry, resource) {
  const [headerName, headerValue] = assembleV2PaymentHeader(proof, entry, resource);
  const pay = proof.toPayJson();
  const auth = get(pay, 'authorization') ?? get(pay, 'permit2Authorization');
  const wallet = asStr(get(auth, 'from')) ?? null;
  return { authorization_header: headerValue, header_name: headerName, scheme: asStr(get(entry, 'scheme')) ?? '', wallet };
}

// upstream: payment_flow.rs::parse_eip155_chain_id
export function parseEip155ChainId(network) {
  if (!network.startsWith('eip155:')) throw new Error(`unsupported network format: expected 'eip155:<chainId>', got '${network}'`);
  const id = network.slice(7);
  const v = parseU64(id);
  if (v === undefined) throw new Error(`invalid chain ID '${id}': must be a valid unsigned integer`);
  return v;
}

// ── two-phase quote/pay support ──────────────────────────────────────
// upstream: payment_flow.rs::is_mainnet_chain
export const isMainnetChain = (chainId) => chainsIsMainnet(String(chainId));

// upstream: payment_flow.rs::scheme_rank (private)
export const schemeRank = (s) => ({ aggr_deferred: 0, exact: 1, upto: 2, charge: 3 }[s] ?? 4);

const U128_MAX = (1n << 128n) - 1n;
const u128OrMax = (s) => intFromStrOk(s, 'u128') ?? U128_MAX;

// upstream: payment_flow.rs::cmp_candidates (private)
export function cmpCandidates(a, b) {
  if (a.tokenSymbol === b.tokenSymbol) {
    const av = u128OrMax(a.amount), bv = u128OrMax(b.amount);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (a.isMainnet && !b.isMainnet) return -1;
  if (!a.isMainnet && b.isMainnet) return 1;
  return schemeRank(a.scheme) - schemeRank(b.scheme);
}

// upstream: payment_flow.rs::rank_candidates → [candidates, alternatives]
export function rankCandidates(candidates) {
  if (!candidates.length) return [[], []];
  const distinct = new Set(candidates.map((c) => c.scheme).filter((s) => ['exact', 'aggr_deferred', 'charge'].includes(s)));
  const multi = distinct.size >= 2;
  const anyBalance = candidates.some((c) => c.balanceStatus === 'sufficient');
  const ranked = candidates.map((c) => ({ ...c })).sort((a, b) => {
    const sa = a.balanceStatus === 'sufficient', sb = b.balanceStatus === 'sufficient';
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;
    return cmpCandidates(a, b);
  });
  if (!multi) {
    const best = ranked.shift();
    best.recommended = best.balanceStatus === 'sufficient' ? true : null;
    for (const c of ranked) c.recommended = false;
    return [[best], ranked];
  }
  if (!anyBalance) {
    for (const c of ranked) c.recommended = null;
    return [ranked, []];
  }
  const winner = ranked.shift();
  winner.recommended = true;
  for (const c of ranked) c.recommended = false;
  return [[winner], ranked];
}

// upstream: payment_flow.rs::PayResult — serde_json::to_value → sorted keys.
const payResult = ({ ok, paymentId, scheme, status, txHash, result, error, decodedReceipt }) =>
  ({ ok, paymentId, scheme, status, txHash: txHash ?? null, result, error: error ?? null, decodedReceipt: decodedReceipt ?? null });

// upstream: payment_flow.rs::now_unix (private)
export const nowUnix = () => Math.max(0, nowSecs());

// upstream: payment_flow.rs::parse_kv (private) → [[k, v], …]
export function parseKv(param) {
  return (param ?? []).map((raw) => {
    const i = raw.indexOf('=');
    if (i < 0) throw new Error(`invalid_input: --param must be key=value, got '${raw}'`);
    const k = trim(raw.slice(0, i));
    if (k === '') throw new Error('invalid_input: --param key must not be empty');
    return [k, raw.slice(i + 1)];
  });
}

// upstream: payment_flow.rs::pay_confirming (private) → Confirming {message, next}
export function payConfirming(st, selectedIndex) {
  const ch = st.decoded_challenge;
  const picked = selectedIndex != null
    ? st.candidates.find((c) => Number(c.acceptsIndex) === Number(selectedIndex))
    : st.candidates.find((c) => c.recommended === true) ?? st.candidates[0];
  let message;
  if (picked) {
    const verb = eqIgnoreAsciiCase(picked.scheme, 'upto') ? 'Will pay up to' : 'Will pay';
    message = `${verb} ${picked.amountHuman} ${picked.tokenSymbol} (${picked.scheme}, ${picked.chainName}) to ${ch.recipient} - confirm to proceed`;
  } else if (selectedIndex != null && st.accepts[Number(selectedIndex)]) {
    const a = st.accepts[Number(selectedIndex)];
    const verb = eqIgnoreAsciiCase(a.scheme, 'upto') ? 'Will pay up to' : 'Will pay';
    message = `${verb} ${a.amount} ${a.asset} (${a.scheme}) to ${ch.recipient} - confirm to proceed`;
  } else {
    message = `Will pay ${ch.amountHuman} to ${ch.recipient} - confirm to proceed`;
  }
  let next = `onchainos payment pay --payment-id ${st.payment_id}`;
  if (selectedIndex != null) next += ` --selected-index ${selectedIndex}`;
  next += ' --yes';
  return new Confirming({ message, next });
}

// upstream: payment_flow.rs::fetch_pay — CLI + MCP `payment_pay` entry (two-phase complete).
export async function fetchPay(paymentId, selectedIndex, param, yes) {
  const owner = state.currentOwnerId() ?? '';
  if (inspectPaymentSource(paymentId) === A2mcpPaymentSource.OkxAiA2mcp) {
    if (selectedIndex != null || (param ?? []).length) throw new Error(`${ERR_OVERRIDES_FORBIDDEN}: A2MCP payment intent does not accept pay-time overrides`);
    if (!yes) throw new Error(`${ERR_CONFIRMATION_REQUIRED}: payment pay requires --yes`);
    return payA2mcpIntent(paymentId, owner);
  }
  const st = state.read(paymentId, owner, nowUnix());
  if (selectedIndex != null && Number(selectedIndex) >= st.raw_accepts.length) {
    const n = st.raw_accepts.length;
    throw new Error(`invalid_input: --selected-index ${selectedIndex} is out of range (accepts has ${n} entr${n === 1 ? 'y' : 'ies'})`);
  }
  const biz = parseKv(param);
  if (!yes) throw payConfirming(st, selectedIndex);
  return payFromState(st, selectedIndex, biz);
}

// upstream: payment_flow.rs::pay_a2mcp_intent (private) — A2MCP intent state machine (a2mcp.rs).
export async function payA2mcpIntent(paymentId, owner) {
  const intent = readA2mcpPaymentIntent(paymentId, owner, nowUnix());
  await intent.beginSigning(nowUnix());
  const accepts = [cloneValue(intent.selectedAccept().raw())];
  let proof, entry;
  for (;;) {
    await intent.recordSignatureAttempt();
    try {
      [proof, entry] = await signPaymentWithPreference(accepts, intent.payerAddress(), null, null);
      break;
    } catch (e) {
      if (intent.signatureAttempts() < 3 && isRetryableA2mcpSigningAuthorizationError(e)) continue;
      await intent.markFailedTerminal();
      throw e;
    }
  }
  await intent.markProofGenerated();
  let header;
  try {
    const resource = intent.frozenRequest().resource();
    header = resource != null ? assembleV2PaymentHeader(proof, entry, resource)
      : ['PAYMENT-SIGNATURE', Buffer.from(stringify(proof.toPayJson()), 'utf8').toString('base64')];
  } catch (e) {
    await intent.markFailedTerminal();
    throw e;
  }
  await intent.markReplaying();
  const [status, txHash, result, error, decodedReceipt] = await replayA2mcp(intent, header[0], header[1]);
  if (status === 'success') await intent.markSuccess();
  else if (status === 'pending') await intent.markPendingTerminal();
  else await intent.markFailedTerminal();
  return payResult({ ok: status === 'success', paymentId, scheme: intent.selectedAccept().scheme(), status, txHash, result, error, decodedReceipt });
}

// upstream: payment_flow.rs::is_retryable_a2mcp_signing_authorization_error (private)
export function isRetryableA2mcpSigningAuthorizationError(error) {
  const m = asciiLower(String(error?.message ?? error));
  return ['payment gen-msg-hash failed', 'payment sign-msg failed', 'permit2 gen-msg-hash failed', 'permit2 sign-msg failed',
    'missing signature in sign-msg response', 'missing msghash in gen-msg-hash response'].some((n) => m.includes(n));
}

// upstream: payment_flow.rs::replay_a2mcp (private)
async function replayA2mcp(intent, headerName, headerValue) {
  const f = intent.frozenRequest();
  return replayA2mcpMerchant(f.endpoint(), f.method(), f.paramPlan(), f.typedParams(), headerName, headerValue);
}

// upstream: payment_flow.rs::pay_from_state (private) — sign (TEE) → header → replay → receipt.
export async function payFromState(st, selectedIndex, bizParams) {
  const acceptsForSign = selectedIndex != null ? [cloneValue(st.raw_accepts[Number(selectedIndex)])] : st.raw_accepts.map(cloneValue);
  const [proof, entry] = await signPaymentWithPreference(acceptsForSign, null, null, null);
  const scheme = asStr(get(entry, 'scheme')) ?? '';
  const [headerName, headerValue] = st.resource != null
    ? assembleV2PaymentHeader(proof, entry, st.resource)
    : ['PAYMENT-SIGNATURE', Buffer.from(stringify(proof.toPayJson()), 'utf8').toString('base64')];
  const [status, txHash, result, error, decodedReceipt] = st.mcp_tool != null
    ? await replayMcp(st, st.mcp_tool, headerName, headerValue, bizParams)
    : await replayMerchant(st.endpoint_url, st.method, st.param_plan, headerName, headerValue, bizParams, proof, entry);
  if (status === 'success') state.cleanup(st.payment_id);
  return payResult({ ok: status === 'success', paymentId: st.payment_id, scheme, status, txHash, result, error, decodedReceipt });
}

const errString = (e) => (e instanceof ReqwestError ? e.message : String(e?.message ?? e));

// upstream: payment_flow.rs::replay_a2mcp_merchant (private) — redirects disabled, 30 s.
async function replayA2mcpMerchant(url, method, plan, typedParams, headerName, headerValue) {
  let req;
  try { req = buildTypedRequest(method, url, typedParams, plan); } catch (e) { return failedReplay(errString(e)); }
  req.headers.push([headerName, headerValue]);
  let r;
  try { r = await send({ ...req, timeoutMs: 30000, redirect: 'none' }); } catch (e) { return failedReplay(errString(e)); }
  return mapHttpReplayResponse(r);
}

// upstream: payment_flow.rs::failed_replay (private)
export const failedReplay = (error) => ['failed', null, null, error, null];

// upstream: payment_flow.rs::map_http_replay_response (private)
function mapHttpReplayResponse(r) {
  const paymentResponse = headerStr(r, 'PAYMENT-RESPONSE');
  const body = respText(r);
  return mapReplayParts(r.status, paymentResponse, parseOrString(body));
}
function parseOrString(body) {
  try { return jsonParse(body); } catch { return body; }
}

function decodedReceiptOf(paymentResponse) {
  if (paymentResponse == null) return null;
  try { const d = decodeReceipt(paymentResponse, null); return { amount: d.amount, chainId: d.chainId, payer: d.payer, status: d.status, transaction: d.transaction }; } catch { return null; }
}

// upstream: payment_flow.rs::map_replay_parts (private)
export function mapReplayParts(statusCode, paymentResponse, result) {
  const decoded = decodedReceiptOf(paymentResponse);
  const tx = decoded && decoded.transaction !== '' ? decoded.transaction : null;
  if (statusCode >= 200 && statusCode < 300) return ['success', tx, result, null, decoded];
  if (statusCode === 402) return ['pending', tx, result, 'facilitator non-terminal: HTTP 402', decoded];
  return ['failed', tx, result, `merchant returned HTTP ${statusCode}`, decoded];
}

// upstream: payment_flow.rs::replay_merchant (private) — default redirect policy, 30 s; never throws.
async function replayMerchant(url, method, plan, headerName, headerValue, bizParams, proof, entry) {
  void proof; void entry;
  const req = buildRequest(method, url, bizParams, plan);
  req.headers.push([headerName, headerValue]);
  let r;
  try { r = await send({ ...req, timeoutMs: 30000 }); } catch (e) { return ['failed', null, null, errString(e), null]; }
  const paymentResponse = headerStr(r, 'PAYMENT-RESPONSE');
  return mapReplayParts(r.status, paymentResponse, parseOrString(respText(r)));
}

// upstream: payment_flow.rs::replay_mcp (private) — re-handshake + signed tools/call; never throws.
async function replayMcp(st, tool, headerName, paymentSignature, bizParams) {
  let client;
  try { client = new McpClient(st.endpoint_url); } catch (e) { return ['failed', null, null, errString(e), null]; }
  try { await client.initialize(); } catch (e) { return ['failed', null, null, errString(e), null]; }
  const args = await mergeMcpReplayArgs(client, st, tool, bizParams);
  let out;
  try { out = await client.callToolSigned({ sessionId: null, tool, arguments: args }, headerName, paymentSignature); } catch (e) {
    return ['failed', null, null, errString(e), null];
  }
  const [statusCode, paymentResponse, result] = out;
  return mapReplayParts(statusCode, paymentResponse, result);
}

// upstream: payment_flow.rs::merge_mcp_replay_args (private)
async function mergeMcpReplayArgs(client, st, tool, bizParams) {
  if (!bizParams.length) return cloneValue(st.known_params);
  let schema = null;
  try { const tools = await client.listTools(); schema = tools.find((t) => t.name === tool)?.inputSchema ?? null; } catch {}
  return applyParamOverrides(st.known_params, bizParams, schema);
}

// upstream: payment_flow.rs::apply_param_overrides (private; pure)
export function applyParamOverrides(known, bizParams, inputSchema) {
  const merged = cloneValue(known);
  const overrides = {};
  for (const [k, v] of bizParams) overrides[k] = v;
  const coerced = coerceArguments(overrides, inputSchema);
  for (const [k, v] of Object.entries(coerced)) merged[k] = v;
  return merged;
}

// ── session decision layer ───────────────────────────────────────────
// upstream: payment_flow.rs::SessionParams (all optional but `action`)
export const sessionParams = (p) => ({
  action: p.action ?? '', channel_id: p.channel_id ?? null, challenge: p.challenge ?? null, unit_amount: p.unit_amount ?? null,
  cumulative_amount: p.cumulative_amount ?? null, escrow: p.escrow ?? null, chain_id: p.chain_id ?? null, deposit: p.deposit ?? null,
  from: p.from ?? null, reuse_signature: p.reuse_signature ?? null, server_cumulative: p.server_cumulative ?? null,
});

const satAdd = (a, b) => (a + b > U128_MAX ? U128_MAX : a + b);
// upstream: payment_flow.rs::needs_top_up / compute_refund / classify_recovery (u128 BigInt)
export const needsTopUp = (cur, unit, dep) => satAdd(BigInt(cur), BigInt(unit)) > BigInt(dep);
export const computeRefund = (dep, fin) => (BigInt(dep) > BigInt(fin) ? BigInt(dep) - BigInt(fin) : 0n);
export function classifyRecovery(cur, unit, dep) {
  if (satAdd(BigInt(cur), BigInt(unit)) > BigInt(dep)) return 'amount_exceeds_deposit';
  if (BigInt(unit) === 0n) return 'delta_too_small';
  return null;
}
const u128OrZero = (s) => (s == null ? 0n : intFromStrOk(s, 'u128') ?? 0n);

// upstream: payment_flow.rs::fetch_session — pure decision layer → SessionData (sorted keys).
export async function fetchSession(params) {
  const p = sessionParams(params);
  const current = u128OrZero(p.cumulative_amount), unit = u128OrZero(p.unit_amount), deposit = u128OrZero(p.deposit);
  const hasDeposit = p.deposit != null;
  const srv = p.server_cumulative == null ? undefined : intFromStrOk(p.server_cumulative, 'u128');
  const drift = srv !== undefined && srv !== current ? srv : undefined;
  const base = drift ?? current;
  const newCum = satAdd(base, unit);
  const needs = hasDeposit && needsTopUp(base, unit, deposit);
  const recovery = hasDeposit ? classifyRecovery(base, unit, deposit) : null;
  const strategy = needs ? 'topup' : drift !== undefined ? 'sign' : p.reuse_signature != null && recovery == null ? 'reuse' : 'sign';
  let reasonText = recovery == null ? null : ({
    amount_exceeds_deposit: 'voucher cumulative exceeds the channel deposit',
    delta_too_small: 'voucher delta is zero — nothing to authorize',
    invalid_signature: 'voucher signature failed verification',
  }[recovery] ?? recovery);
  if (drift !== undefined && reasonText == null) reasonText = `voucher cumulative drifted (70015): server cumulative ${base}, recomputed to ${newCum} and resigned`;
  const refund = p.action === 'close' && hasDeposit ? computeRefund(deposit, newCum).toString() : undefined;
  return {
    strategy, cumulative_amount: newCum.toString(), needsTopUp: needs,
    sessionSnapshot: { channelId: p.channel_id, deposit: p.deposit, cumulative: newCum.toString() },
    refund, recovery: recovery ?? undefined, reason_text: reasonText ?? undefined,
  };
}
