// Shared EVM/Solana post-unsignedInfo broadcast — upstream agentic_wallet/broadcast.rs.
// Used by agent-commerce identity mutations: simulation check → msgForSign → extraData →
// broadcast-transaction (+ 81362 confirming mapping).
import { context } from '../core/errors.mjs';
import { stringify } from '../core/json.mjs';
import { WalletApiClient } from './api.mjs';
import { handleConfirmingError } from './common.mjs';
import { ed25519SignEip191, ed25519SignHex, ed25519SignEncoded } from './shared/_crypto.mjs';
import { isObject } from './shared/_rust.mjs';

// upstream: broadcast.rs::BroadcastCtx
// { accessToken, accountId, addrInfo, sessionCert, signingSeed (32-byte Buffer), unsigned
//   (decoded UnsignedInfoResponse), isContractCall, mevProtection, force,
//   extraDataOverlay ({key: value} | null), traceHeaders ([[name, value]] | null) }

// upstream: broadcast.rs::broadcast_unsigned → txHash
export async function broadcastUnsigned(ctx) {
  const { accessToken, accountId, addrInfo, sessionCert, signingSeed, unsigned, isContractCall, mevProtection, force, extraDataOverlay, traceHeaders } = ctx;
  const execOk = typeof unsigned.executeResult === 'boolean' ? unsigned.executeResult : true;
  if (!execOk) {
    throw new Error(`transaction simulation failed: ${unsigned.executeErrorMsg === '' ? 'transaction simulation failed' : unsigned.executeErrorMsg}`);
  }
  const seedB64 = Buffer.from(signingSeed).toString('base64');
  const msgForSign = {};
  if (unsigned.hash !== '') msgForSign.signature = ed25519SignEip191(unsigned.hash, signingSeed, 'hex');
  if (unsigned.authHashFor7702 !== '') msgForSign.authSignatureFor7702 = ed25519SignHex(unsigned.authHashFor7702, seedB64);
  if (unsigned.unsignedTxHash !== '') {
    const sig = ed25519SignEncoded(unsigned.unsignedTxHash, seedB64, unsigned.encoding);
    msgForSign.unsignedTxHash = unsigned.unsignedTxHash;
    msgForSign.sessionSignature = sig;
  }
  if (unsigned.unsignedTx !== '') msgForSign.unsignedTx = unsigned.unsignedTx;
  if (unsigned.jitoUnsignedTx !== '') {
    const sig = ed25519SignEncoded(unsigned.jitoUnsignedTx, seedB64, unsigned.encoding);
    msgForSign.jitoUnsignedTx = unsigned.jitoUnsignedTx;
    msgForSign.jitoSessionSignature = sig;
  }
  if (sessionCert !== '') msgForSign.sessionCert = sessionCert;

  const extraData = isObject(unsigned.extraData) ? { ...unsigned.extraData } : {};
  extraData.checkBalance = true;
  extraData.uopHash = unsigned.uopHash;
  extraData.encoding = unsigned.encoding;
  extraData.signType = unsigned.signType;
  extraData.msgForSign = msgForSign;
  if (!isContractCall) extraData.txType = 2;
  if (mevProtection) extraData.isMEV = true;
  if (force) extraData.skipWarning = true;
  if (extraDataOverlay) for (const [k, v] of Object.entries(extraDataOverlay)) extraData[k] = v;
  let extraDataStr;
  try { extraDataStr = stringify(extraData); } catch (e) { throw context('failed to serialize extraData', e); }

  let resp;
  try {
    resp = await new WalletApiClient().broadcastTransaction(accessToken, accountId, addrInfo.address, addrInfo.chainIndex, extraDataStr, traceHeaders ?? null);
  } catch (e) {
    throw handleConfirmingError(e, force);
  }
  return resp.txHash;
}
