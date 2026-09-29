// Permit2 EIP-712 signing for `exact + Permit2` and `upto` — upstream payment/permit2/sign.rs.
// TEE variants sign via the enclave (gen-msg-hash → local Ed25519 session signature → sign-msg);
// local variants sign the alloy EIP-712 digest with an on-disk EOA key (legacy v 27/28).
import * as keyring from '../../core/keyring.mjs';
import { context } from '../../core/errors.mjs';
import { ensureTokensRefreshed, formatApiError } from '../../wallet/auth.mjs';
import { WalletApiClient } from '../../wallet/api.mjs';
import { loadSession } from '../../wallet/store.mjs';
import { ERR_NOT_LOGGED_IN } from '../../wallet/common.mjs';
import { hpkeDecryptSessionSk, ed25519SignHex, ed25519SignEip191, secp256k1Sign } from '../../core/crypto.mjs';
import { at, asStr } from '../../core/rs/value.mjs';
import {
  buildExactPermit2Struct, buildExactPermit2TypedData, buildUptoPermit2Struct, buildUptoPermit2TypedData,
  exactSigningHash, uptoSigningHash,
} from './eip712.mjs';
import { exactPermit2Payload, uptoPermit2Payload } from './types.mjs';

export const GEN_MSG_HASH_PATH = '/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash';
export const SIGN_MSG_PATH = '/priapi/v5/wallet/agentic/pre-transaction/sign-msg';

// wallet_store::load_session()? + keyring_store::get("session_key") → not logged in.
export function loadSessionAndKey() {
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyring.get('session_key'); } catch { throw new Error(ERR_NOT_LOGGED_IN); }
  if (typeof sessionKey !== 'string') throw new Error(ERR_NOT_LOGGED_IN);
  return { session, sessionKey };
}

// upstream: sign.rs::session_sign_msg_hash (private) → [signatureB64, sessionCert]
export function sessionSignMsgHash(msgHash) {
  const { session, sessionKey } = loadSessionAndKey();
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  const sig = ed25519SignHex(msgHash, seed.toString('base64'));
  seed.fill(0);
  return [sig, session.sessionCert];
}

const authorization = (payer, input, upto) => ({
  from: payer,
  permitted: { token: input.token, amount: input.amount },
  spender: input.spender, nonce: input.nonce, deadline: input.deadline,
  witness: upto ? { to: input.witnessTo, facilitator: input.witnessFacilitator, validAfter: input.witnessValidAfter }
    : { to: input.witnessTo, validAfter: input.witnessValidAfter },
});

// upstream: sign.rs::sign_exact_permit2 (TEE)
export async function signExactPermit2(chainIndex, payerAddr, input) {
  const signature = await teeSignEip712(chainIndex, payerAddr, buildExactPermit2TypedData(input));
  return exactPermit2Payload({ signature, permit2Authorization: authorization(payerAddr, input, false) });
}

// upstream: sign.rs::sign_upto_permit2 (TEE)
export async function signUptoPermit2(chainIndex, payerAddr, input) {
  const signature = await teeSignEip712(chainIndex, payerAddr, buildUptoPermit2TypedData(input));
  return uptoPermit2Payload({ signature, permit2Authorization: authorization(payerAddr, input, true) });
}

// upstream: sign.rs::sign_eip712_legacy_v (private)
function signEip712LegacyV(pkBytes, digest) {
  const sig = secp256k1Sign(pkBytes, digest);
  sig[64] += 27;
  return '0x' + sig.toString('hex');
}

// upstream: sign.rs::sign_exact_permit2_local
export function signExactPermit2Local(pkBytes, payerAddr, input) {
  const s = buildExactPermit2Struct(input);
  const signature = signEip712LegacyV(pkBytes, exactSigningHash(s, input.chainId));
  return exactPermit2Payload({ signature, permit2Authorization: authorization(payerAddr, input, false) });
}

// upstream: sign.rs::sign_upto_permit2_local
export function signUptoPermit2Local(pkBytes, payerAddr, input) {
  const s = buildUptoPermit2Struct(input);
  const signature = signEip712LegacyV(pkBytes, uptoSigningHash(s, input.chainId));
  return uptoPermit2Payload({ signature, permit2Authorization: authorization(payerAddr, input, true) });
}

// upstream: sign.rs::tee_gen_msg_hash — POST gen-msg-hash {chainIndex, payload:[{msgType:"eip712", message}]}
export async function teeGenMsgHash(chainIndex, typedData) {
  const accessToken = await ensureTokensRefreshed();
  const client = new WalletApiClient();
  const body = { chainIndex, payload: [{ msgType: 'eip712', message: typedData }] };
  let resp;
  try { resp = await client.postAuthed(GEN_MSG_HASH_PATH, accessToken, body); } catch (e) { throw context('permit2 gen-msg-hash failed', formatApiError(e)); }
  const h = asStr(at(at(resp, 0), 'msgHash'));
  if (h === undefined) throw new Error('missing msgHash in gen-msg-hash response');
  return h;
}

// upstream: sign.rs::tee_sign_eip712 — gen-msg-hash → Ed25519 session signature → sign-msg.
export async function teeSignEip712(chainIndex, payerAddr, typedData) {
  const msgHash = await teeGenMsgHash(chainIndex, typedData);
  const accessToken = await ensureTokensRefreshed();
  const [sessionSignature, sessionCert] = sessionSignMsgHash(msgHash);
  const client = new WalletApiClient();
  const body = {
    chainIndex, from: payerAddr, sessionCert,
    payload: [{ signType: 'eip712', message: typedData, sessionSignature }],
    skipWarning: true,
  };
  let resp;
  try { resp = await client.postAuthed(SIGN_MSG_PATH, accessToken, body); } catch (e) { throw context('permit2 sign-msg failed', formatApiError(e)); }
  const sig = asStr(at(at(resp, 0), 'signature'));
  if (sig === undefined) throw new Error('missing signature in sign-msg response');
  return sig;
}

// upstream: sign.rs::tee_sign_personal — EIP-191 personalSign over a 32-byte value (no gen-msg-hash).
export async function teeSignPersonal(chainIndex, from, valueHex) {
  const accessToken = await ensureTokensRefreshed();
  const { session, sessionKey } = loadSessionAndKey();
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  const sessionSignature = ed25519SignEip191(valueHex, seed, 'hex');
  seed.fill(0);
  const client = new WalletApiClient();
  const body = {
    chainIndex, from, sessionCert: session.sessionCert,
    payload: [{ signType: 'personalSign', message: { value: valueHex }, sessionSignature }],
    skipWarning: true,
  };
  let resp;
  try { resp = await client.postAuthed(SIGN_MSG_PATH, accessToken, body); } catch (e) { throw context('AccessProof personalSign failed', formatApiError(e)); }
  const sig = asStr(at(at(resp, 0), 'signature'));
  if (sig === undefined) throw new Error('missing signature in personalSign response');
  return sig;
}
