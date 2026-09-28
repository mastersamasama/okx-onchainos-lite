// `wallet sign-message` (personalSign / EIP-712) — upstream agentic_wallet/sign.rs.
// Signing uses the TEE session: HPKE-open the Ed25519 session seed, sign locally, then the
// backend's sign-msg endpoint produces the chain signature.
import { context } from '../core/errors.mjs';
import { resolveChain } from '../core/chains.mjs';
import { WalletApiClient } from './api.mjs';
import * as store from './store.mjs';
import { ensureTokensRefreshed, formatApiError } from './auth.mjs';
import { getChainByRealChainIndex } from './chain.mjs';
import { ERR_NOT_LOGGED_IN, isHexString, handleConfirmingError } from './common.mjs';
import { resolveAddress } from './transfer/index.mjs';
import { sessionKeyOrNotLoggedIn } from './shared/common/session.mjs';
import { hpkeDecryptSessionSk, ed25519SignHex, ed25519SignEip191 } from './shared/_crypto.mjs';
import { fromStr as serdeFromStr } from './shared/_serde-json.mjs';
import { get, asU64, hexDecode, hexEncode, bs58Encode } from './shared/_rust.mjs';

const SIGN_MSG = '/priapi/v5/wallet/agentic/pre-transaction/sign-msg';
const GEN_MSG_HASH = '/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash';

// upstream: sign.rs::cmd_sign_message → success data
export async function cmdSignMessage(signType, message, chain, from, force) {
  if (message === '') throw new Error('--message must not be empty');
  if (chain === '') throw new Error('--chain must not be empty');
  if (from === '') throw new Error('--from must not be empty');
  switch (signType) {
    case 'personal': return personalSign(message, chain, from, force);
    case 'eip712': return eip712Sign(message, chain, from, force);
    default: throw new Error(`unsupported --type: ${signType}, expected 'personal' or 'eip712'`);
  }
}

// upstream: sign.rs::resolve_chain_and_address → [chainIndex, fromAddress]
export async function resolveChainAndAddress(chain, from) {
  const entry = await getChainByRealChainIndex(chain);
  if (!entry) throw new Error(`unsupported chain: ${chain}`);
  const ci = get(entry, 'chainIndex');
  const u = asU64(ci);
  const chainIndex = typeof ci === 'string' ? ci : u !== undefined ? u.toString() : undefined;
  if (chainIndex === undefined) throw new Error('missing chainIndex in chain entry');
  const chainName = get(entry, 'chainName');
  if (typeof chainName !== 'string') throw new Error('missing chainName in chain entry');
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [, addrInfo] = resolveAddress(wallets, from, chainName);
  return [chainIndex, addrInfo.address];
}

// session.json + keyring session_key → [session, seed]
function loadSigningSession() {
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  const sessionKey = sessionKeyOrNotLoggedIn();
  return [session, hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey)];
}

// upstream: sign.rs::personal_sign
async function personalSign(message, rawChain, from, force) {
  const chain = resolveChain(rawChain);
  const accessToken = await ensureTokensRefreshed();
  const [chainIndex, fromAddress] = await resolveChainAndAddress(chain, from);
  const [session, seed] = loadSigningSession();
  let sessionSignature;
  if (chain === '501') {
    sessionSignature = ed25519SignHex(hexEncode(Buffer.from(message, 'utf8')), seed.toString('base64'));
  } else if (isHexString(message)) {
    const hexPart = message.slice(2);
    sessionSignature = ed25519SignEip191(hexPart.length % 2 ? `0x0${hexPart}` : message, seed, 'hex');
  } else {
    sessionSignature = ed25519SignEip191(message, seed, 'utf8');
  }
  const body = {
    chainIndex, from: fromAddress, sessionCert: session.sessionCert,
    payload: [{ signType: 'personalSign', message: { value: encodeMessageValue(message, chain) }, sessionSignature }],
  };
  if (force) body.skipWarning = true;
  let data;
  try { data = await new WalletApiClient().postAuthed(SIGN_MSG, accessToken, body); } catch (e) { throw handleConfirmingError(e, force); }
  return outputSignResult(data, chain, fromAddress);
}

// `hash_resp[0]["msgHash"].as_str()` — Value indexing (Null on any mismatch).
const firstField = (data, key) => (Array.isArray(data) && data.length ? get(data[0], key) : undefined);

// gen-msg-hash → msgHash (errors `gen-msg-hash failed: code=… msg=…`)
async function genMsgHash(client, accessToken, chainIndex, typedData) {
  let resp;
  try {
    resp = await client.postAuthed(GEN_MSG_HASH, accessToken, { chainIndex, payload: [{ msgType: 'eip712', message: typedData }] });
  } catch (e) {
    throw context('gen-msg-hash failed', formatApiError(e));
  }
  const msgHash = firstField(resp, 'msgHash');
  if (typeof msgHash !== 'string') throw new Error('missing msgHash in gen-msg-hash response');
  return msgHash;
}

// upstream: sign.rs::eip712_sign_raw → signature (gen-msg-hash → Ed25519 → sign-msg); used by
// agent-commerce task signing as well. 81362 is not mapped to confirming here.
export async function eip712SignRaw(typedData, chainIndex, fromAddress) {
  const accessToken = await ensureTokensRefreshed();
  const client = new WalletApiClient();
  const msgHash = await genMsgHash(client, accessToken, chainIndex, typedData);
  const [session, seed] = loadSigningSession();
  const sessionSignature = ed25519SignHex(msgHash, seed.toString('base64'));
  const body = { chainIndex, from: fromAddress, sessionCert: session.sessionCert, payload: [{ signType: 'eip712', message: typedData, sessionSignature }] };
  let data;
  try { data = await client.postAuthed(SIGN_MSG, accessToken, body); } catch (e) { throw context('sign-msg failed', e); }
  const signature = firstField(data, 'signature');
  if (typeof signature !== 'string') throw new Error('missing signature in sign-msg response');
  return signature;
}

// upstream: sign.rs::eip712_sign
async function eip712Sign(message, rawChain, from, force) {
  const chain = resolveChain(rawChain);
  if (chain === '501') throw new Error('eip712 signing is not supported on Solana (chain 501)');
  let parsed;
  try { parsed = serdeFromStr(message); } catch (e) { throw context('--message must be valid JSON for eip712', e); }
  const [chainIndex, fromAddress] = await resolveChainAndAddress(chain, from);
  if (!force) return { signature: await eip712SignRaw(parsed, chainIndex, fromAddress) };

  const accessToken = await ensureTokensRefreshed();
  const client = new WalletApiClient();
  const msgHash = await genMsgHash(client, accessToken, chainIndex, parsed);
  const [session, seed] = loadSigningSession();
  const sessionSignature = ed25519SignHex(msgHash, seed.toString('base64'));
  const body = {
    chainIndex, from: fromAddress, sessionCert: session.sessionCert,
    payload: [{ signType: 'eip712', message: parsed, sessionSignature }], skipWarning: true,
  };
  let data;
  try { data = await client.postAuthed(SIGN_MSG, accessToken, body); } catch (e) { throw handleConfirmingError(e, force); }
  return outputSignResult(data, chain, fromAddress);
}

// upstream: sign.rs::sign_eip7702_auth → base64 signature (no callers upstream)
export function signEip7702Auth(authHash) {
  const [, seed] = loadSigningSession();
  return ed25519SignHex(authHash, seed.toString('base64'));
}

// upstream: sign.rs::encode_message_value — base58(utf8) for Solana, verbatim elsewhere.
export const encodeMessageValue = (message, chain) => (chain === '501' ? bs58Encode(Buffer.from(message, 'utf8')) : message);

// upstream: sign.rs::output_sign_result → success data
export function outputSignResult(data, chain, fromAddress) {
  if (!Array.isArray(data) || !data.length) throw new Error('sign-msg: empty response data');
  const signature = get(data[0], 'signature');
  if (typeof signature !== 'string') throw new Error('missing signature in sign-msg response');
  if (chain === '501') {
    let bytes;
    try { bytes = hexDecode(signature.replace(/^(0x)+/, '')); } catch (e) { throw context('invalid hex signature from API', e); }
    return { signature: bs58Encode(bytes), publicKey: fromAddress };
  }
  return { signature };
}
