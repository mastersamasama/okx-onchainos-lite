// A2A Pay — upstream commands/payment/a2a_pay.rs. Bridges Buyer & Seller to the Smart-Account
// payment backend:
//   create (Seller): POST /api/v6/pay/a2a/payment/create → paymentId + deliveries (no signing)
//   pay    (Buyer, `charge` intent): GET /p/{id} → rebuild the EIP-3009 authorization from
//          challenge.data.request → TEE-sign → POST /p/{id}/credential
//   status : GET /p/{id}/status (optionally polled until terminal)
// `signEscrow` (escrow intent) is a library entry used by agent-commerce task flows: it derives
// the escrow nonce locally and TEE-signs ReceiveWithAuthorization with no payment-server I/O.
import { randomBytes } from 'node:crypto';
import { context, FundingBlocked } from '../core/errors.mjs';
import { struct } from '../core/json.mjs';
import { eqIgnoreAsciiCase } from '../core/_rust-str.mjs';
import * as keyring from '../core/keyring.mjs';
import { FUNDING_OPERATION_A2A_PAYMENT, buildFundingBundle } from '../core/funding.mjs';
import { keccak256 } from '../crypto/keccak.mjs';
import { ensureTokensRefreshed, formatApiError } from '../wallet/auth.mjs';
import { WalletApiClient } from '../wallet/api.mjs';
import { loadWallets, loadSession } from '../wallet/store.mjs';
import { ERR_NOT_LOGGED_IN } from '../wallet/common.mjs';
import { getChainByRealChainIndex } from '../wallet/chain.mjs';
import { resolveAddress } from '../wallet/transfer/index.mjs';
import { queryTokenReadable, queryTokenMetadata } from '../wallet/balance/index.mjs';
import { minimalToReadable } from '../wallet/shared/common/amount.mjs';
import { hpkeDecryptSessionSk, ed25519Sign } from './_crypto.mjs';
import { GEN_MSG_HASH_PATH, SIGN_MSG_PATH } from './permit2/sign.mjs';
import {
  at, get, asStr, asU64, hexDecode, addressFromStr, trimStartMatches0x, word, wordAddr, parseUint,
} from './_rs.mjs';
import { parseFromRfc3339, isAtOrBeforeNow } from './_chrono.mjs';

// upstream: a2a_pay.rs::DEFAULT_VALID_BEFORE_SEC
export const DEFAULT_VALID_BEFORE_SEC = 3600;
const A2A = '/api/v6/pay/a2a';
const nowSecs = () => Math.floor(Date.now() / 1000);

// ── command entry ────────────────────────────────────────────────────

// upstream: a2a_pay.rs::execute — cmd = {kind:'create', args} | {kind:'pay', args} | {kind:'status', paymentId, wait}.
// Returns the `data` printed by output::success.
export async function execute(cmd) {
  if (cmd.kind === 'create') {
    if (cmd.args.type !== 'charge') throw new Error(`unknown --type '${cmd.args.type}', expected 'charge'`);
    return createPaymentCharge(chargeParamsTryFrom(cmd.args));
  }
  if (cmd.kind === 'pay') {
    const a = cmd.args;
    return pay({ paymentId: a.paymentId, amount: a.amount, currency: a.currency, recipientAddress: a.recipientAddress });
  }
  return fetchStatus(cmd.paymentId, !!cmd.wait);
}

// ── Seller side: charge create ───────────────────────────────────────

// upstream: a2a_pay.rs::ChargeParams::try_from(CreateArgs)
export function chargeParamsTryFrom(a) {
  if (a.recipient == null) throw new Error('--recipient is required for --type charge');
  return {
    amount: a.amount, symbol: a.symbol, recipient: a.recipient, description: a.description ?? undefined,
    externalId: a.externalId ?? undefined, expiresIn: a.expiresIn ?? undefined, realm: a.realm ?? undefined,
  };
}

// upstream: a2a_pay.rs::create_payment_charge → CreatePaymentOutput {payment_id, deliveries}
export async function createPaymentCharge(params) {
  validatePositiveDecimalAmount(params.amount);
  requireEvmAddress(params.recipient, 'recipient');
  const client = new WalletApiClient();
  const accessToken = await ensureTokensRefreshed();
  // serde_json::to_value(ChargeParams) (+ type, deliveries) — a Value: keys sorted on the wire.
  const body = { amount: params.amount, symbol: params.symbol, recipient: params.recipient };
  for (const k of ['description', 'externalId', 'expiresIn', 'realm']) if (params[k] != null) body[k] = params[k];
  body.type = 'charge';
  body.deliveries = { includeUrl: true };
  let resp;
  try { resp = await client.postAuthed(`${A2A}/payment/create`, accessToken, body); } catch (e) {
    throw context('Smart-Account /payment/create failed', formatApiError(e));
  }
  return parseCreatePaymentResponse(resp);
}

// upstream: a2a_pay.rs::parse_create_payment_response (private)
export function parseCreatePaymentResponse(resp) {
  const paymentId = asStr(at(resp, 'paymentId'));
  if (paymentId === undefined) throw new Error("missing 'paymentId' in /payment/create response");
  const d = get(resp, 'deliveries');
  return struct({ payment_id: paymentId, deliveries: d === undefined ? null : d });
}

// ── Escrow nonce ─────────────────────────────────────────────────────

// upstream: a2a_pay.rs::compute_escrow_nonce — keccak256(abi.encode(from, provider, receiver,
// arbitrator, currency, uint256 amount, uint64 submitWindow, uint64 disputeWindow, uint64
// arbitrationWindow, uint64 terminationWindow, hook, bytes32 hookDataHash, bytes32 salt, uint256
// chainId, escrowAddress)) — all 15 fields static. Addresses: 20-byte Buffers or 0x strings;
// hookDataHash / salt: 32-byte Buffers or 0x strings; numbers: bigint | number | decimal string.
export function computeEscrowNonce(f) {
  const addr = (v) => wordAddr(Buffer.isBuffer(v) ? v : addressFromStr(v));
  const b32 = (v) => (Buffer.isBuffer(v) ? v : hexDecode(trimStartMatches0x(v)));
  const enc = Buffer.concat([
    addr(f.from), addr(f.provider), addr(f.receiver), addr(f.arbitrator), addr(f.currency), word(BigInt(f.amount)),
    word(BigInt(f.submitWindow)), word(BigInt(f.disputeWindow)), word(BigInt(f.arbitrationWindow)), word(BigInt(f.terminationWindow)),
    addr(f.hook), b32(f.hookDataHash), b32(f.salt), word(BigInt(f.chainId)), addr(f.escrowAddress),
  ]);
  return keccak256(enc);
}

// ── Buyer side: pay ──────────────────────────────────────────────────

// upstream: a2a_pay.rs::pay — p = {paymentId, amount (minimal units), currency, recipientAddress}
// → PayOutput {payment_id, status, tx_hash, valid_after, valid_before, signature}
export async function pay(p) {
  const client = new WalletApiClient();
  const accessToken = await ensureTokensRefreshed();

  // 1. GET /p/{id} (public buyer link, anonymous; error NOT passed through format_api_error)
  let resp;
  try { resp = await client.getPublic(`${A2A}/p/${p.paymentId}`, []); } catch (e) {
    throw context('Smart-Account GET /p/{id} failed', e);
  }
  const errMsg = asStr(get(resp, 'errorMessage'));
  if (errMsg !== undefined && errMsg !== '') {
    const status = asStr(at(resp, 'status')) ?? 'unknown';
    throw new Error(`payment ${p.paymentId} unavailable (status=${status}): ${errMsg}`);
  }
  let challenge = get(resp, 'challenge');
  if (challenge === undefined && get(resp, 'type') !== undefined) challenge = resp;
  if (challenge === undefined) throw new Error(`GET /payment/${p.paymentId} response missing 'challenge'`);
  const data = get(challenge, 'data');
  if (data === undefined) throw new Error('challenge.data missing');
  const intent = asStr(get(data, 'intent'));
  if (intent === undefined) throw new Error('challenge.data.intent missing');
  if (intent !== 'charge') throw new Error(`pay() supports only 'charge' intent; got '${intent}' — use sign_escrow() for escrow`);
  const expiresStr = asStr(get(data, 'expires'));
  if (expiresStr === undefined) throw new Error('challenge.data.expires missing');
  let expiresAt;
  try { expiresAt = parseFromRfc3339(expiresStr); } catch (e) { throw context(`challenge.data.expires '${expiresStr}' is not RFC3339`, e); }
  // `expires_at <= Utc::now()` — whole seconds, then the sub-second part.
  if (isAtOrBeforeNow(expiresAt)) throw new Error(`challenge expired at ${expiresStr}`);
  const request = get(data, 'request');
  if (request === undefined) throw new Error('challenge.data.request missing');
  const reqStr = (k) => {
    const v = asStr(get(request, k));
    if (v === undefined) throw new Error(`challenge.data.request.${k} missing`);
    return v;
  };
  const amount = reqStr('amount');
  const currency = reqStr('currency');
  const recipient = reqStr('recipient');
  const md = get(request, 'methodDetails');
  if (md === undefined) throw new Error('challenge.data.request.methodDetails missing');
  const chainId = asU64(get(md, 'chainId'));
  if (chainId === undefined) throw new Error('methodDetails.chainId missing');
  const authorizationScheme = asStr(get(md, 'authorizationType'));
  if (authorizationScheme === undefined) throw new Error('methodDetails.authorizationType missing');

  // Pre-sign safety: the caller's expectation must match the on-server challenge.
  if (p.amount !== amount) throw new Error(`amount mismatch: expected ${p.amount}, challenge has ${amount}`);
  if (!eqIgnoreAsciiCase(p.currency, currency)) throw new Error(`currency mismatch: expected ${p.currency}, challenge has ${currency}`);
  if (!eqIgnoreAsciiCase(p.recipientAddress, recipient)) {
    throw new Error(`recipient address mismatch: expected ${p.recipientAddress}, challenge has ${recipient}`);
  }

  // 2. buyer wallet on the target chain; 3. timing; 4. nonce + TEE EIP-3009
  const [chainIndex, fromAddr] = await resolveBuyerWallet(chainId);
  const validAfter = 0;
  const validBefore = nowSecs() + DEFAULT_VALID_BEFORE_SEC;
  const nonceHex = '0x' + randomBytes(32).toString('hex');
  const signatureHex = await teeSignEip3009(client, accessToken, chainIndex, fromAddr, recipient, amount, validAfter, validBefore,
    nonceHex, currency, null, 'eip3009Auth');

  // 5. POST /p/{id}/credential
  const credentialBody = {
    payload: {
      type: 'transaction', signature: signatureHex,
      authorization: {
        type: authorizationScheme, from: fromAddr, to: recipient, value: amount,
        validAfter: String(validAfter), validBefore: String(validBefore), nonce: nonceHex,
      },
    },
  };
  let cred;
  try { cred = await client.postAuthed(`${A2A}/p/${p.paymentId}/credential`, accessToken, credentialBody); } catch (e) {
    throw context('Smart-Account /p/{id}/credential failed', formatApiError(e));
  }
  // code=0 even when the credential is refused by business logic — the outcome is data.success.
  if (get(cred, 'success') === false) {
    const reason = asStr(get(cred, 'errorReason')) ?? 'unknown';
    if (reason === 'insufficient_balance') {
      const scene = await buildA2aInsufficientBalanceScene(chainIndex, currency, amount);
      if (scene != null) throw new FundingBlocked(scene);
    }
    throw new Error(`payment ${p.paymentId} rejected (reason=${reason})`);
  }
  return struct({
    payment_id: p.paymentId, status: asStr(at(cred, 'status')) ?? 'unknown', tx_hash: asStr(at(cred, 'txHash')) ?? null,
    valid_after: validAfter, valid_before: validBefore, signature: signatureHex,
  });
}

// ── A2A insufficient-balance scene ───────────────────────────────────

// upstream: a2a_pay.rs::a2a_funding_input (private) → FundingBlockedInput
export const a2aFundingInput = (currency, assetSymbol, required, balance) => ({
  asset: assetSymbol, tokenAddress: currency, required, balance: balance ?? undefined, operation: FUNDING_OPERATION_A2A_PAYMENT,
});

// upstream: a2a_pay.rs::build_a2a_insufficient_balance_scene (private) → funding result | null.
// Any wallet-load / address-resolution failure → null (caller falls back to the hard error).
export async function buildA2aInsufficientBalanceScene(chainIndex, currency, amount) {
  let balance = null, decimals, assetSymbol;
  try {
    const t = await queryTokenReadable(chainIndex, currency);
    if (t) { balance = t.balance; decimals = t.decimals; assetSymbol = t.symbol; } else balance = '0';
  } catch { balance = null; }
  if (decimals === undefined || assetSymbol === undefined) {
    try {
      const m = await queryTokenMetadata(chainIndex, currency);
      if (decimals === undefined) decimals = m.decimals;
      if (m.symbol !== undefined && assetSymbol === undefined) assetSymbol = m.symbol;
    } catch { /* ignored */ }
  }
  if (decimals === undefined) return null;
  let required;
  try { required = minimalToReadable(amount, decimals); } catch { return null; }
  const asset = assetSymbol ?? currency;
  try { return await buildFundingBundle(chainIndex, a2aFundingInput(currency, asset, required, balance)); } catch { return null; }
}

// ── Buyer side: sign_escrow ──────────────────────────────────────────

// upstream: a2a_pay.rs::sign_escrow — p = {chainId, provider, receiver, arbitrator, currency,
// escrowContract, amount, submitWindow, disputeWindow, arbitrationWindow, terminationWindow, hook,
// hookData, salt, expiredAt} → SignEscrowOutput {type, signature, authorization}
export async function signEscrow(p) {
  for (const [label, v] of [['provider', p.provider], ['receiver', p.receiver], ['arbitrator', p.arbitrator],
    ['currency', p.currency], ['escrow_contract', p.escrowContract], ['hook', p.hook]]) requireEvmAddress(v, label);
  const client = new WalletApiClient();
  const accessToken = await ensureTokensRefreshed();
  const [chainIndex, fromAddrStr] = await resolveBuyerWallet(p.chainId);
  const validAfter = 0;
  let ts;
  try { ts = parseFromRfc3339(p.expiredAt).secs; } catch (e) { throw context(`expired_at '${p.expiredAt}' is not RFC 3339`, e); }
  if (ts < 0n) throw context('expired_at predates unix epoch', new Error('out of range integral type conversion attempted'));
  const validBefore = ts;
  let amount;
  try { amount = parseUint(p.amount, 128); } catch (e) { throw context('amount must be a non-negative integer in minimal units', e); }
  let fromAddr;
  try { fromAddr = addressFromStr(fromAddrStr); } catch (e) { throw context('agentic-wallet address is not a valid EVM address', e); }
  let hookData;
  try { hookData = hexDecode(trimStartMatches0x(p.hookData)); } catch (e) { throw context('hook_data is not valid hex', e); }
  const salt = parseBytes32Hex(p.salt, 'salt');
  const nonceHex = '0x' + Buffer.from(computeEscrowNonce({
    from: fromAddr, provider: p.provider, receiver: p.receiver, arbitrator: p.arbitrator, currency: p.currency, amount,
    submitWindow: p.submitWindow, disputeWindow: p.disputeWindow, arbitrationWindow: p.arbitrationWindow,
    terminationWindow: p.terminationWindow, hook: p.hook, hookDataHash: keccak256(hookData), salt,
    chainId: p.chainId, escrowAddress: p.escrowContract,
  })).toString('hex');
  const signatureHex = await teeSignEip3009(client, accessToken, chainIndex, fromAddrStr, p.escrowContract, p.amount, validAfter,
    validBefore, nonceHex, p.currency, 'eip3009ReceiveAuth', 'eip3009ReceiveAuth');
  return struct({
    type: 'transaction', signature: signatureHex,
    authorization: struct({
      type: 'ReceiveWithAuthorization', from: fromAddrStr, to: p.escrowContract, value: p.amount,
      validAfter: String(validAfter), validBefore: String(validBefore), nonce: nonceHex,
    }),
  });
}

// ── TEE EIP-3009 (shared by pay and sign_escrow) ─────────────────────

// upstream: a2a_pay.rs::tee_sign_eip3009 (private) — gen-msg-hash → local Ed25519 → sign-msg.
export async function teeSignEip3009(client, accessToken, chainIndex, from, to, value, validAfter, validBefore, nonceHex,
  verifyingContract, signType, msgType) {
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyring.get('session_key'); } catch { sessionKey = undefined; }
  if (typeof sessionKey !== 'string') throw new Error(ERR_NOT_LOGGED_IN);

  const base = {
    chainIndex, from, to, value, validAfter: String(validAfter), validBefore: String(validBefore), nonce: nonceHex, verifyingContract,
  };
  if (signType != null) base.signType = signType;
  const genBody = { ...base };
  if (msgType != null) genBody.msgType = msgType;
  let hashResp;
  try { hashResp = await client.postAuthed(GEN_MSG_HASH_PATH, accessToken, genBody); } catch (e) {
    throw context('a2a-pay: gen-msg-hash failed', formatApiError(e));
  }
  const msgHash = asStr(at(at(hashResp, 0), 'msgHash'));
  if (msgHash === undefined) throw new Error("missing 'msgHash' in gen-msg-hash response");
  const domainHash = asStr(at(at(hashResp, 0), 'domainHash'));
  if (domainHash === undefined) throw new Error("missing 'domainHash' in gen-msg-hash response");

  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  let msgHashBytes;
  try { msgHashBytes = hexDecode(trimStartMatches0x(msgHash)); } catch (e) { seed.fill(0); throw context('invalid msgHash hex', e); }
  const sig = ed25519Sign(seed, msgHashBytes);
  seed.fill(0);
  const signBody = { ...base, domainHash, sessionCert: session.sessionCert, sessionSignature: sig.toString('base64') };
  let signed;
  try { signed = await client.postAuthed(SIGN_MSG_PATH, accessToken, signBody); } catch (e) {
    throw context('a2a-pay: sign-msg failed', formatApiError(e));
  }
  const signature = asStr(at(at(signed, 0), 'signature'));
  if (signature === undefined) throw new Error("missing 'signature' in sign-msg response");
  return signature;
}

// upstream: a2a_pay.rs::resolve_buyer_wallet (private) → [chainIndex, address] (selected account)
export async function resolveBuyerWallet(chainId) {
  const entry = await getChainByRealChainIndex(String(chainId));
  if (!entry) throw new Error(`chain (chainId=${chainId}) not found in chain registry`);
  const ci = at(entry, 'chainIndex');
  let chainIndex = asStr(ci);
  if (chainIndex === undefined && asU64(ci) !== undefined) chainIndex = String(asU64(ci));
  if (chainIndex === undefined) throw new Error('missing chainIndex in chain entry');
  const chainName = asStr(at(entry, 'chainName'));
  if (chainName === undefined) throw new Error('missing chainName in chain entry');
  const wallets = loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [, addrInfo] = resolveAddress(wallets, undefined, chainName);
  return [chainIndex, addrInfo.address];
}

// ── Status ───────────────────────────────────────────────────────────

// upstream: a2a_pay.rs::status — GET /p/{id}/status (JWT) → StatusOutput
export async function status(paymentId) {
  const client = new WalletApiClient();
  const accessToken = await ensureTokensRefreshed();
  let resp;
  try { resp = await client.getAuthed(`${A2A}/p/${paymentId}/status`, accessToken, []); } catch (e) {
    throw context('Smart-Account /p/{id}/status failed', formatApiError(e));
  }
  const executed = at(resp, 'executed'), fee = at(resp, 'fee');
  return struct({
    payment_id: paymentId,
    status: asStr(at(resp, 'status')) ?? 'unknown',
    tx_hash: asStr(at(executed, 'txHash')) ?? null,
    block_number: asU64(at(executed, 'blockNumber')) ?? null,
    block_timestamp: asStr(at(executed, 'blockTimestamp')) ?? null,
    fee_amount: asStr(at(fee, 'amount')) ?? null,
    fee_bps: asU64(at(fee, 'bps')) ?? null,
  });
}

// upstream: a2a_pay.rs::is_terminal_status
export const isTerminalStatus = (s) => ['completed', 'failed', 'expired', 'cancelled'].includes(s);

// upstream: a2a_pay.rs::A2aStatusData — to_value ⇒ sorted keys.
const statusData = (status, terminal, timedOut) => ({ status, terminal, timed_out: timedOut });

// upstream: a2a_pay.rs::fetch_status — one GET, or (wait) poll every 3 s up to a 60 s ceiling.
// Also the MCP tool `payment_a2a_status`.
export async function fetchStatus(paymentId, wait, { intervalMs = 3000, ceilingMs = 60000 } = {}) {
  const out = await status(paymentId);
  if (!wait || isTerminalStatus(out.status)) return statusData(out.status, isTerminalStatus(out.status), false);
  const start = Date.now();
  let last = out.status;
  for (;;) {
    if (Date.now() - start >= ceilingMs) return statusData(last, false, true);
    await new Promise((r) => setTimeout(r, intervalMs));
    last = (await status(paymentId)).status;
    if (isTerminalStatus(last)) return statusData(last, true, false);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

// upstream: a2a_pay.rs::validate_positive_decimal_amount (private) — "50", "0.01", ".5", "1."
export function validatePositiveDecimalAmount(s) {
  const str = String(s);
  const i = str.indexOf('.');
  const intPart = i >= 0 ? str.slice(0, i) : str;
  const fracPart = i >= 0 ? str.slice(i + 1) : '';
  if (intPart === '' && fracPart === '') throw new Error('amount must not be empty');
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) throw new Error(`amount must be a non-negative decimal number, got: ${str}`);
  if (!/[1-9]/.test(intPart) && !/[1-9]/.test(fracPart)) throw new Error('amount must be greater than zero');
}

// upstream: a2a_pay.rs::is_valid_evm_address (private) — 0x + 40 hex, no checksum check.
export const isValidEvmAddress = (addr) => String(addr).startsWith('0x') && Buffer.byteLength(String(addr)) === 42 && /^[0-9a-fA-F]*$/.test(String(addr).slice(2));

// upstream: a2a_pay.rs::require_evm_address (private)
export function requireEvmAddress(addr, label) {
  if (!isValidEvmAddress(addr)) throw new Error(`--${label} is not a valid EVM address: ${addr}`);
}

// upstream: a2a_pay.rs::parse_bytes32_hex (private) → 32-byte Buffer
export function parseBytes32Hex(s, label) {
  const str = String(s);
  const clean = str.startsWith('0x') ? str.slice(2) : str;
  if (Buffer.byteLength(clean) !== 64) throw new Error(`${label} must be 32 bytes (64 hex chars), got ${Buffer.byteLength(clean)}`);
  try { return hexDecode(clean); } catch (e) { throw context(`${label} is not valid hex`, e); }
}

