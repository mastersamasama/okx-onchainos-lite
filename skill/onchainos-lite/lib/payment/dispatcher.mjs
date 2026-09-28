// `onchainos payment …` command bodies + the shared x402 / MPP helpers — upstream
// commands/payment/dispatcher.rs. Handlers in lib/commands/payment/*.mjs call the cmd*
// functions; the MPP challenge / credential / nonce helpers are shared with the session
// commands (lib/payment/session*.mjs) and agent flows.
import { randomBytes } from 'node:crypto';
import { context } from '../core/errors.mjs';
import { EMPTY } from '../core/context.mjs';
import { trim } from '../core/_rust-str.mjs';
import * as keyring from '../core/keyring.mjs';
import { keccak256 } from '../crypto/keccak.mjs';
import { ensureTokensRefreshed, formatApiError } from '../wallet/auth.mjs';
import { WalletApiClient } from '../wallet/api.mjs';
import { loadWallets, loadSession } from '../wallet/store.mjs';
import { ERR_NOT_LOGGED_IN } from '../wallet/common.mjs';
import { getChainByRealChainIndex } from '../wallet/chain.mjs';
import { resolveAddress } from '../wallet/transfer/index.mjs';
import { fromStr as serdeFromStr } from '../wallet/_serde-json.mjs';
import { isValidEvmAddress, parseRecipientAddr } from './addr.mjs';
import * as paymentFlow from './payment-flow.mjs';
import { fetchDecodeReceipt } from './decode-receipt.mjs';
import * as paymentCache from './_payment-cache.mjs';
import { hpkeDecryptSessionSk, ed25519Sign, ed25519SignHex } from './_crypto.mjs';
import { GEN_MSG_HASH_PATH, SIGN_MSG_PATH } from './permit2/sign.mjs';
import {
  B64, at, get, asStr, asU64, isObj, parseUint, u256FromStrRadix, hexDecode, addressFromStr, trimStartMatches0x,
  word, wordAddr, parseRfc3339, jcs, b64urlNoPad,
} from './_rs.mjs';


// ── default asset (payment default set|get|unset) ────────────────────

// upstream: dispatcher.rs::chain_id_to_caip2 — numeric EVM chain id → "eip155:<n>".
export function chainIdToCaip2(input) {
  const trimmed = trim(input);
  if (trimmed === '') throw new Error('--chain must not be empty');
  let n;
  try { n = parseUint(trimmed, 64); } catch (e) {
    throw context(`--chain must be a numeric chain id (e.g. "1" for Ethereum, "196" for X Layer), got: ${input}`, e);
  }
  if ([195n, 501n, 607n, 784n].includes(n)) throw new Error(`x402 payments are EVM-only; chain id ${n} is not supported`);
  return `eip155:${n}`;
}

// upstream: dispatcher.rs::caip2_to_chain_id
export const caip2ToChainId = (caip2) => (String(caip2).startsWith('eip155:') ? String(caip2).slice(7) : String(caip2));

// upstream: dispatcher.rs::cmd_default — action {kind:'set', asset, chain, name?, tier?} | {kind:'get'} | {kind:'unset'}
export function cmdDefault(action) {
  if (action.kind === 'set') {
    const asset = trim(action.asset);
    if (!isValidEvmAddress(asset)) throw new Error('--asset must be a valid EVM address (0x + 40 hex chars)');
    const chain = trim(action.chain);
    const network = chainIdToCaip2(chain);
    let name = action.name == null ? null : trim(action.name);
    if (name === '') name = null;
    const t = action.tier == null ? '' : trim(action.tier);
    let tier = null;
    if (t !== '') {
      tier = paymentFlow.PaymentTier.fromServerStr(t);
      if (!tier) throw new Error('--tier must be `basic` or `premium`');
    }
    const cache = paymentCache.load() ?? paymentCache.defaultCache();
    cache.default_asset = { asset, network, name: name ?? undefined };
    const slot = tier === 'basic' ? 'basic_state' : tier === 'premium' ? 'premium_state' : null;
    if (slot && cache[slot] === 'charging_unconfirmed') cache[slot] = 'charging_confirmed';
    try { paymentCache.save(cache); } catch (e) { throw context('failed to save payment cache', e); }
    return { asset, chain, name };
  }
  if (action.kind === 'get') {
    const cache = paymentCache.load() ?? paymentCache.defaultCache();
    const d = cache.default_asset;
    return d ? { asset: d.asset, chain: caip2ToChainId(d.network), name: d.name ?? null } : EMPTY;
  }
  const cache = paymentCache.load() ?? paymentCache.defaultCache();
  cache.default_asset = null;
  try { paymentCache.save(cache); } catch (e) { throw context('failed to save payment cache', e); }
  return EMPTY;
}

// ── payment pay / pay-local / decode-receipt ─────────────────────────

// upstream: dispatcher.rs::cmd_pay — legacy sign-only mode (`--payload`); no saved-default preference.
export async function cmdPay(payload, selectedIndex) {
  let [accepts, resource] = decodePayPayload(payload);
  if (selectedIndex != null) accepts = selectAcceptsIndex(accepts, selectedIndex);
  const [proof, entry] = await paymentFlow.signPaymentWithPreference(accepts, null, null, null);
  return emitPayResult(proof, entry, resource);
}

// upstream: dispatcher.rs::cmd_pay_two_phase — `--payment-id` (confirming gate inside fetch_pay).
export const cmdPayTwoPhase = (paymentId, selectedIndex, param, yes) => paymentFlow.fetchPay(paymentId, selectedIndex, param, yes);

// upstream: dispatcher.rs::execute(Eip3009Sign) — `payment pay-local`.
export async function cmdPayLocal(payload) {
  const [accepts, resource] = decodePayPayload(payload);
  const [proof, entry] = await paymentFlow.signPaymentLocal(accepts, null);
  return emitPayResult(proof, entry, resource);
}

// upstream: dispatcher.rs::cmd_decode_receipt
export const cmdDecodeReceipt = (header, receipt) => fetchDecodeReceipt(header, receipt);

// upstream: dispatcher.rs::decode_pay_payload → [accepts (any JSON), resource | undefined]
export function decodePayPayload(payload) {
  const decoded = decodePaymentBlob(payload);
  const accepts = get(decoded, 'accepts');
  if (accepts === undefined) throw new Error("--payload decoded to JSON without an 'accepts' field");
  return [accepts, get(decoded, 'resource')];
}

// upstream: dispatcher.rs::select_accepts_index → [accepts[index]]
export function selectAcceptsIndex(accepts, index) {
  if (!Array.isArray(accepts)) throw new Error("--selected-index requires the payload's 'accepts' to be an array");
  const i = Number(index);
  if (i >= accepts.length) {
    const n = accepts.length;
    throw new Error(`--selected-index ${index} is out of range (accepts has ${n} entr${n === 1 ? 'y' : 'ies'})`);
  }
  return [accepts[i]];
}

// upstream: dispatcher.rs::emit_pay_result — v2 header card when the payload carried `resource`.
export function emitPayResult(proof, entry, resource) {
  return resource !== undefined ? paymentFlow.payWithHeaderJson(proof, entry, resource) : proof.toPayJson();
}

// ── MPP challenge parsing ────────────────────────────────────────────

// upstream: dispatcher.rs::parse_www_authenticate — RFC 7235 auth-params → {key: string}.
// Quoted-string bytes are pushed as Latin-1 chars (`byte as char`), exactly like upstream.
export function parseWwwAuthenticate(header) {
  const h = String(header);
  const content = h.startsWith('Payment ') ? h.slice(8) : h;
  const bytes = Buffer.from(content, 'utf8');
  const map = {};
  let i = 0;
  while (i < bytes.length) {
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x2c)) i++;
    if (i >= bytes.length) break;
    const keyStart = i;
    while (i < bytes.length && bytes[i] !== 0x3d && bytes[i] !== 0x2c) i++;
    if (i >= bytes.length || bytes[i] !== 0x3d) continue;
    const key = trim(bytes.subarray(keyStart, i).toString('utf8'));
    i++;
    let value;
    if (i < bytes.length && bytes[i] === 0x22) {
      i++;
      value = '';
      while (i < bytes.length) {
        const b = bytes[i];
        if (b === 0x5c && i + 1 < bytes.length) { value += String.fromCharCode(bytes[i + 1]); i += 2; }
        else if (b === 0x22) { i++; break; }
        else { value += String.fromCharCode(b); i++; }
      }
    } else {
      const valStart = i;
      while (i < bytes.length && bytes[i] !== 0x2c && bytes[i] !== 0x20 && bytes[i] !== 0x09) i++;
      value = bytes.subarray(valStart, i).toString('utf8');
    }
    if (key !== '') map[key] = value;
  }
  if (!('id' in map) || !('method' in map) || !('intent' in map)) {
    throw new Error('invalid WWW-Authenticate header: missing required fields (id, method, intent)');
  }
  if (map.method !== 'evm') throw new Error(`unsupported payment challenge method "${map.method}"; this CLI only supports method="evm"`);
  return map;
}

// upstream: dispatcher.rs::decode_challenge_request — base64url (no-pad, then padded) JSON.
export function decodeChallengeRequest(challenge) {
  const b64 = asStr(at(challenge, 'request'));
  if (b64 === undefined) throw new Error("missing 'request' in challenge");
  let bytes;
  try { bytes = B64.URL_SAFE_NO_PAD(b64); } catch {
    try { bytes = B64.URL_SAFE(b64); } catch (e) { throw context('invalid base64url in challenge request', e); }
  }
  try { return serdeFromStr(bytes); } catch (e) { throw context('invalid JSON in challenge request', e); }
}

const tryJson = (bytes) => { try { return { v: serdeFromStr(bytes) }; } catch { return null; } };

// upstream: dispatcher.rs::decode_payment_blob — WWW-Authenticate challenge | base64(url) JSON | JSON.
export function decodePaymentBlob(input) {
  const trimmed = trim(input);
  const head = Buffer.from(trimmed, 'utf8').subarray(0, 8);
  if (head.length === 8 && head.toString('latin1').toLowerCase() === 'payment ') {
    const challenge = parseWwwAuthenticate(trimmed);
    if (typeof challenge.request === 'string') challenge.request = decodeChallengeRequest(challenge);
    return challenge;
  }
  for (const engine of [B64.STANDARD, B64.STANDARD_NO_PAD, B64.URL_SAFE, B64.URL_SAFE_NO_PAD]) {
    let bytes;
    try { bytes = engine(trimmed); } catch { continue; }
    const r = tryJson(bytes);
    if (r) return r.v;
  }
  const r = tryJson(Buffer.from(trimmed, 'utf8'));
  if (r) return r.v;
  throw new Error('could not decode payment blob: not a WWW-Authenticate challenge, base64-encoded JSON, or plain JSON');
}

// upstream: dispatcher.rs::build_challenge_echo (json! → sorted; `request` is the raw base64url string)
export function buildChallengeEcho(challenge) {
  return {
    id: at(challenge, 'id'), realm: at(challenge, 'realm'), method: at(challenge, 'method'),
    intent: at(challenge, 'intent'), request: at(challenge, 'request'), expires: get(challenge, 'expires') ?? null,
  };
}

// upstream: dispatcher.rs::base64url_encode_json — serde_jcs (RFC 8785) → base64url, no padding.
export const base64urlEncodeJson = (value) => b64urlNoPad(Buffer.from(jcs(value), 'utf8'));

// upstream: dispatcher.rs::parse_challenge_expires_unix → BigInt seconds | null
export function parseChallengeExpiresUnix(challenge) {
  const s = asStr(get(challenge, 'expires'));
  if (s === undefined) return null;
  let ts;
  try { ts = parseRfc3339(s); } catch (e) { throw context(`challenge.expires is not RFC3339: ${s}`, e); }
  if (ts < 0n) throw new Error(`challenge.expires is before Unix epoch: ${s}`);
  return ts;
}

const U64_MAX = 18446744073709551615n;
const satAdd64 = (a, b) => (a + b > U64_MAX ? U64_MAX : a + b);

// upstream: dispatcher.rs::compute_valid_before — max(now+300, expires+60); decimal string.
export function computeValidBefore(challenge, nowUnix) {
  const now = BigInt(nowUnix);
  const fromNow = satAdd64(now, 300n);
  const exp = parseChallengeExpiresUnix(challenge);
  if (exp === null) return fromNow.toString();
  if (exp < now) throw new Error('challenge.expires is already in the past');
  const g = satAdd64(exp, 60n);
  return (fromNow > g ? fromNow : g).toString();
}

// upstream: dispatcher.rs::compute_primary_split_amounts → [primaryAmount, [{amount, canonical, display}]]
export function computePrimarySplitAmounts(request, chainId) {
  const amountStr = asStr(at(request, 'amount'));
  if (amountStr === undefined) throw new Error("missing 'amount' in challenge request");
  let amount;
  try { amount = u256FromStrRadix(amountStr, 10); } catch (e) { throw new Error(`challenge amount '${amountStr}' is not a base-10 integer: ${e.message}`); }
  const splits = at(at(request, 'methodDetails'), 'splits');
  if (!Array.isArray(splits)) return [amountStr, []];
  if (!splits.length) throw new Error('challenge methodDetails.splits is present but empty (spec requires >= 1 entry)');
  if (splits.length > 10) throw new Error(`challenge splits count ${splits.length} exceeds spec max of 10`);
  let sum = 0n;
  const parsed = [];
  splits.forEach((s, i) => {
    const a = asStr(at(s, 'amount'));
    if (a === undefined) throw new Error(`splits[${i}].amount missing or not a string`);
    const r = asStr(at(s, 'recipient'));
    if (r === undefined) throw new Error(`splits[${i}].recipient missing or not a string`);
    let v;
    try { v = u256FromStrRadix(a, 10); } catch (e) { throw new Error(`splits[${i}].amount '${a}' is not a base-10 integer: ${e.message}`); }
    if (v === 0n) throw new Error(`splits[${i}].amount must be > 0`);
    sum += v;
    if (sum >= 1n << 256n) throw new Error(`splits sum overflow at index ${i}`);
    let canonical, display;
    try { [canonical, display] = parseRecipientAddr(r, chainId); } catch (e) { throw context(`splits[${i}].recipient`, e); }
    parsed.push({ amount: a, canonical, display });
  });
  if (sum >= amount) throw new Error(`splits sum (${sum}) must be strictly less than challenge amount (${amount}) per spec §Constraints`);
  return [(amount - sum).toString(), parsed];
}

// alloy `Address::from_str` + `.context(label)` → 32-byte ABI word.
function addrWord(s, label) {
  try { return wordAddr(addressFromStr(s)); } catch (e) { throw context(label, e); }
}
// hex::decode(s.trim_start_matches("0x")) (+ context) → exactly 32 bytes.
function bytes32(s, hexLabel, lenMsg) {
  let b;
  try { b = hexDecode(trimStartMatches0x(s)); } catch (e) { throw context(hexLabel, e); }
  if (b.length !== 32) throw new Error(lenMsg);
  return b;
}
const hex0x = (b) => '0x' + Buffer.from(b).toString('hex');

// upstream: dispatcher.rs::compute_topup_nonce — keccak256(abi.encode(bytes32, uint128, address, bytes32))
export function computeTopupNonce(payer, channelId, additionalDeposit, topUpSaltHex) {
  const payerW = addrWord(payer, 'invalid payer address');
  const cid = bytes32(channelId, 'channelId must be hex', 'channelId must be 32 bytes (64 hex chars)');
  let additional;
  try { additional = parseUint(additionalDeposit, 128); } catch (e) { throw context('additionalDeposit must be decimal uint128', e); }
  const salt = bytes32(topUpSaltHex, 'topUpSalt must be hex', 'topUpSalt must be 32 bytes (64 hex chars)');
  return hex0x(keccak256(Buffer.concat([cid, word(additional), payerW, salt])));
}

// upstream: dispatcher.rs::parse_session_splits → [recipients (canonical 0x), bps]
export function parseSessionSplits(request, chainId) {
  const splits = at(at(request, 'methodDetails'), 'splits');
  if (!Array.isArray(splits) || !splits.length) return [[], []];
  const recipients = [], bps = [];
  splits.forEach((s, i) => {
    const r = asStr(at(s, 'recipient'));
    if (r === undefined) throw new Error(`splits[${i}].recipient missing`);
    const b = asU64(at(s, 'bps'));
    if (b === undefined) throw new Error(`splits[${i}].bps missing or not integer`);
    if (BigInt(b) < 1n || BigInt(b) > 9999n) throw new Error(`splits[${i}].bps out of range 1-9999: ${b}`);
    let canonical;
    try { [canonical] = parseRecipientAddr(r, chainId); } catch (e) { throw context(`splits[${i}].recipient`, e); }
    recipients.push(canonical);
    bps.push(Number(b));
  });
  return [recipients, bps];
}

// upstream: dispatcher.rs::compute_open_nonce —
// keccak256(abi.encode(address,address,address,bytes32,address,address[],uint16[]))
export function computeOpenNonce(payer, payee, token, saltHex, authorizedSigner, splitRecipients, splitBps) {
  const head = [
    addrWord(payer, 'invalid payer address'), addrWord(payee, 'invalid payee address'), addrWord(token, 'invalid token address'),
  ];
  const auth = addrWord(authorizedSigner, 'invalid authorizedSigner address');
  const salt = bytes32(saltHex, 'salt must be hex', 'salt must be 32 bytes (64 hex chars)');
  const recips = splitRecipients.map((s) => addrWord(s, 'invalid split recipient'));
  const n = recips.length;
  const off1 = 7n * 32n, off2 = off1 + 32n + 32n * BigInt(n);
  const enc = Buffer.concat([
    ...head, salt, auth, word(off1), word(off2),
    word(BigInt(n)), ...recips,
    word(BigInt(splitBps.length)), ...splitBps.map((x) => word(BigInt(x))),
  ]);
  return hex0x(keccak256(enc));
}

// upstream: dispatcher.rs::compute_channel_id —
// keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, escrow, uint256 chainId))
export function computeChannelId(payer, payee, token, saltHex, authorizedSigner, escrow, chainId) {
  const w = [
    addrWord(payer, 'invalid payer address'), addrWord(payee, 'invalid payee address'), addrWord(token, 'invalid token address'),
  ];
  const auth = addrWord(authorizedSigner, 'invalid authorizedSigner address');
  const esc = addrWord(escrow, 'invalid escrow address');
  const salt = bytes32(saltHex, 'salt must be hex', 'salt must be 32 bytes (64 hex chars)');
  return hex0x(keccak256(Buffer.concat([...w, salt, auth, esc, word(BigInt(chainId))])));
}

// upstream: dispatcher.rs::Eip3009AuthType — Receive adds msgType / signType "eip3009ReceiveAuth".
export const Eip3009AuthType = Object.freeze({
  Transfer: 'Transfer', Receive: 'Receive',
  overrideType: (t) => (t === 'Receive' ? 'eip3009ReceiveAuth' : null),
});

// session.json + keyring session_key, or "not logged in".
function sessionAndKey() {
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyring.get('session_key'); } catch { sessionKey = undefined; }
  if (typeof sessionKey !== 'string') throw new Error(ERR_NOT_LOGGED_IN);
  return [session, sessionKey];
}

// upstream: dispatcher.rs::tee_sign_eip3009 → [signature, from]
export async function teeSignEip3009(authType, chainIndex, from, to, amount, validBefore, nonce, asset) {
  const accessToken = await ensureTokensRefreshed();
  const [session, sessionKey] = sessionAndKey();
  const base = { chainIndex, from, to, value: amount, validAfter: '0', validBefore, nonce, verifyingContract: asset };
  const client = new WalletApiClient();
  const t = Eip3009AuthType.overrideType(authType);
  const genBody = { ...base };
  if (t) genBody.msgType = t;
  let hashResp;
  try { hashResp = await client.postAuthed(GEN_MSG_HASH_PATH, accessToken, genBody); } catch (e) { throw context('eip3009 gen-msg-hash failed', formatApiError(e)); }
  const msgHash = asStr(at(at(hashResp, 0), 'msgHash'));
  if (msgHash === undefined) throw new Error('missing msgHash in gen-msg-hash response');
  const domainHash = asStr(at(at(hashResp, 0), 'domainHash'));
  if (domainHash === undefined) throw new Error('missing domainHash in gen-msg-hash response');
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  let hashBytes;
  try { hashBytes = hexDecode(trimStartMatches0x(msgHash)); } catch (e) { seed.fill(0); throw context('invalid msgHash hex', e); }
  const sig = ed25519Sign(seed, hashBytes);
  seed.fill(0);
  const signBody = { ...base, domainHash, sessionCert: session.sessionCert, sessionSignature: sig.toString('base64'), skipWarning: true };
  if (t) signBody.signType = t;
  let signResp;
  try { signResp = await client.postAuthed(SIGN_MSG_PATH, accessToken, signBody); } catch (e) { throw context('eip3009 sign-msg failed', formatApiError(e)); }
  const signature = asStr(at(at(signResp, 0), 'signature'));
  if (signature === undefined) throw new Error('missing signature in sign-msg response');
  return [signature, from];
}

// upstream: dispatcher.rs::build_voucher_typed_data — MPP `Voucher(bytes32 channelId, uint128 cumulativeAmount)`.
export function buildVoucherTypedData(channelId, cumulativeAmount, escrow, chainId) {
  return {
    domain: { name: 'EVM Payment Channel', version: '1', chainId, verifyingContract: escrow },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }],
    },
    primaryType: 'Voucher',
    message: { channelId, cumulativeAmount },
  };
}

// upstream: dispatcher.rs::tee_sign_voucher — generic EIP-712 TEE path → 0x signature.
export async function teeSignVoucher(chainIndex, payerAddr, channelId, cumulativeAmount, escrow, chainId) {
  const accessToken = await ensureTokensRefreshed();
  const [session, sessionKey] = sessionAndKey();
  const typedData = buildVoucherTypedData(channelId, cumulativeAmount, escrow, chainId);
  const client = new WalletApiClient();
  let hashResp;
  try {
    hashResp = await client.postAuthed(GEN_MSG_HASH_PATH, accessToken, { chainIndex, payload: [{ msgType: 'eip712', message: typedData }] });
  } catch (e) { throw context('mpp voucher gen-msg-hash failed', formatApiError(e)); }
  const msgHash = asStr(at(at(hashResp, 0), 'msgHash'));
  if (msgHash === undefined) throw new Error('missing msgHash');
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  const seedB64 = seed.toString('base64');
  seed.fill(0);
  const sessionSignature = ed25519SignHex(msgHash, seedB64);
  const body = {
    chainIndex, from: payerAddr, sessionCert: session.sessionCert,
    payload: [{ signType: 'eip712', message: typedData, sessionSignature }], skipWarning: true,
  };
  let signResp;
  try { signResp = await client.postAuthed(SIGN_MSG_PATH, accessToken, body); } catch (e) { throw context('mpp voucher sign-msg failed', formatApiError(e)); }
  const signature = asStr(at(at(signResp, 0), 'signature'));
  if (signature === undefined) throw new Error('missing signature');
  return signature;
}

// upstream: dispatcher.rs::resolve_chain_and_payer(chain_id: u64, from) → [chainIndex, payerAddress]
export async function resolveChainAndPayer(chainId, from) {
  const entry = await getChainByRealChainIndex(String(chainId));
  if (!entry) throw new Error(`chain not found for chainId ${chainId}`);
  const ci = at(entry, 'chainIndex');
  const chainIndex = typeof ci === 'string' ? ci : asU64(ci) !== undefined ? String(asU64(ci)) : undefined;
  if (chainIndex === undefined) throw new Error('missing chainIndex');
  const chainName = asStr(at(entry, 'chainName'));
  if (chainName === undefined) throw new Error('missing chainName');
  const wallets = loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [, info] = resolveAddress(wallets, from ?? undefined, chainName);
  return [chainIndex, info.address];
}

// upstream: dispatcher.rs::random_nonce_hex — 32 OS-random bytes → 0x + 64 hex.
export const randomNonceHex = () => '0x' + randomBytes(32).toString('hex');

// upstream: dispatcher.rs::normalize_bytes32_hex
export function normalizeBytes32Hex(value, label) {
  const body = trimStartMatches0x(value);
  if (Buffer.byteLength(body) !== 64) throw new Error(`${label} must be 32 bytes (0x + 64 hex chars), got ${Buffer.byteLength(body)} chars`);
  if (!/^[0-9a-fA-F]{64}$/.test(body)) throw new Error(`${label} contains non-hex characters`);
  return '0x' + body.toLowerCase();
}

// ── payment charge (MPP one-shot) ────────────────────────────────────

const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));

// upstream: dispatcher.rs::cmd_mpp_charge → output data (json! sorted)
export async function cmdMppCharge(challengeHeader, from, txHash) {
  const challenge = parseWwwAuthenticate(challengeHeader);
  const request = decodeChallengeRequest(challenge);
  const recipientIn = asStr(at(request, 'recipient'));
  if (recipientIn === undefined) throw new Error("missing 'recipient' in challenge request");
  const amount = asStr(at(request, 'amount'));
  if (amount === undefined) throw new Error("missing 'amount' in challenge request");
  const currency = asStr(at(request, 'currency'));
  if (currency === undefined) throw new Error("missing 'currency' in challenge request");
  const md = at(request, 'methodDetails');
  const chainId = asU64(at(md, 'chainId'));
  if (chainId === undefined) throw new Error("missing 'methodDetails.chainId'");
  const fp = at(md, 'feePayer');
  const feePayer = typeof fp === 'boolean' ? fp : true;
  let recipient, recipientDisplay;
  try { [recipient, recipientDisplay] = parseRecipientAddr(recipientIn, chainId); } catch (e) { throw context('challenge.request.recipient', e); }
  const [chainIndex, payer] = await resolveChainAndPayer(chainId, from);
  const out = (mode, header) => ({
    protocol: 'mpp', method: 'evm', intent: 'charge', mode, authorization_header: header, wallet: payer,
    challenge: { id: at(challenge, 'id'), realm: at(challenge, 'realm') },
  });
  const source = `did:pkh:eip155:${chainId}:${payer}`;

  if (!feePayer) {
    if (txHash == null) throw new Error('challenge.methodDetails.feePayer=false requires --tx-hash (broadcast transferWithAuthorization yourself first)');
    if (!txHash.startsWith('0x') || Buffer.byteLength(txHash) !== 66 || !/^[0-9a-fA-F]*$/.test(txHash.slice(2))) {
      throw new Error('--tx-hash must be 0x + 64 hex chars');
    }
    const credential = { challenge: buildChallengeEcho(challenge), source, payload: { type: 'hash', hash: txHash } };
    return out('hash', `Payment ${base64urlEncodeJson(credential)}`);
  }
  if (txHash != null) throw new Error('--tx-hash is only valid when challenge.methodDetails.feePayer=false');

  const [primary, splits] = computePrimarySplitAmounts(request, chainId);
  const validBefore = computeValidBefore(challenge, nowSecs());
  const nonce = randomNonceHex();
  const [signature] = await teeSignEip3009(Eip3009AuthType.Transfer, chainIndex, payer, recipient, primary, validBefore, nonce, currency);
  const authorization = { type: 'eip-3009', from: payer, to: recipientDisplay, value: primary, validAfter: '0', validBefore, nonce, signature };
  if (splits.length) {
    const signed = [];
    for (const [i, s] of splits.entries()) {
      const splitNonce = randomNonceHex();
      let sig;
      try { [sig] = await teeSignEip3009(Eip3009AuthType.Transfer, chainIndex, payer, s.canonical, s.amount, validBefore, splitNonce, currency); } catch (e) {
        throw context(`splits[${i}] TEE sign failed`, e);
      }
      signed.push({ from: payer, to: s.display, value: s.amount, validAfter: '0', validBefore, nonce: splitNonce, signature: sig });
    }
    authorization.splits = signed;
  }
  const credential = { challenge: buildChallengeEcho(challenge), source, payload: { type: 'transaction', authorization } };
  return out('transaction', `Payment ${base64urlEncodeJson(credential)}`);
}

// ── session helpers shared with the session commands ─────────────────

// upstream: dispatcher.rs::emit_session — merge the fetch_session decision into `base` (best-effort).
export async function emitSession(base, params) {
  try {
    const decision = await paymentFlow.fetchSession(params);
    if (isObj(base) && isObj(decision)) for (const [k, v] of Object.entries(decision)) if (v !== undefined) base[k] = v;
  } catch {}
  return base;
}

// upstream: dispatcher.rs::persist_channel_open — best-effort sessions/{channelId}.json write
// (session_state.rs is owned by the session unit: lib/payment/session-state.mjs).
export async function persistChannelOpen(channelId, payerAddr, deposit, initialCum) {
  try {
    const ss = await import('./session-state.mjs');
    const now = ss.nowUnix();
    const st = { channel_id: channelId, owner_wallet: payerAddr, deposit, cumulative: initialCum, created_at: now, updated_at: now };
    if (typeof ss.write === 'function') await ss.write(st);
    else if (ss.ChannelState) await new ss.ChannelState(st).write();
  } catch {}
}

// upstream: dispatcher.rs::session_open_params
export const sessionOpenParams = (channelId, deposit, initialCum) =>
  ({ action: 'open', channel_id: channelId, cumulative_amount: initialCum, unit_amount: '0', deposit });

// upstream: dispatcher.rs::voucher_advances_cumulative (u128 BigInt; deposit null = unknown)
export const voucherAdvancesCumulative = (unit, newCum, deposit) =>
  BigInt(unit) > 0n && (deposit == null || BigInt(newCum) <= BigInt(deposit));
