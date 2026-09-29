// Bitcoin / SUI `unsignedHashList` signing and direct-broadcast payload —
// upstream agentic_wallet/shared/common/unsigned_hash_list.rs.
import { context } from '../../../core/errors.mjs';
import { stringify } from '../../../core/json.mjs';
import { requiredString } from './json.mjs';
import { decodeHex } from './session.mjs';
import { ed25519Sign } from '../../../core/crypto.mjs';
import { get, isObject, asU64 } from '../../../core/rs/value.mjs';
import { parseU64 } from '../../../core/rs/num.mjs';
import { B64, bs58Decode } from '../../../core/rs/codec.mjs';

// upstream: unsigned_hash_list.rs::SigningProfile
export const SigningProfile = Object.freeze({ Bitcoin: 'Bitcoin', Sui: 'Sui' });

// upstream: unsigned_hash_list.rs::sign_unsigned_hashes — every item cloned + `sessionSignature`
// (base64 Ed25519 over the decoded hash). `seed` is a SigningSeed.
export function signUnsignedHashes(response, seed, profile) {
  const items = get(response, 'unsignedHashList');
  if (!Array.isArray(items)) throw new Error('signing response is missing unsignedHashList');
  if (items.length === 0) throw new Error('unsignedHashList must not be empty');
  const defaultEncoding = get(response, 'encoding');
  if (typeof defaultEncoding !== 'string' || defaultEncoding === '') throw new Error('signing response is missing encoding');
  validateProfileEncoding(defaultEncoding, profile);

  const indices = new Set();
  const validated = [];
  for (const item of items) {
    const rawIndex = get(item, 'index');
    const index = asU64(rawIndex) ?? (typeof rawIndex === 'string' ? parseU64(rawIndex) : undefined);
    if (index === undefined) throw new Error('unsignedHashList item is missing index');
    if (indices.has(index)) throw new Error(`unsignedHashList contains duplicate index ${index}`);
    indices.add(index);
    const unsignedHash = get(item, 'unsignedHash');
    if (typeof unsignedHash !== 'string' || unsignedHash === '') throw new Error(`unsignedHashList[${index}] is missing unsignedHash`);
    if (profile === SigningProfile.Bitcoin) {
      const sig = get(item, 'unsignedHashSig');
      if (typeof sig !== 'string' || sig === '') throw new Error(`unsignedHashList[${index}] is missing unsignedHashSig`);
    }
    let encoding = defaultEncoding;
    if (profile === SigningProfile.Bitcoin) {
      const e = get(item, 'encoding');
      if (typeof e === 'string' && e !== '') encoding = e;
    }
    validateProfileEncoding(encoding, profile);
    validated.push([item, unsignedHash, encoding]);
  }

  return validated.map(([item, unsignedHash, encoding]) => {
    const bytes = decodeUnsignedHash(unsignedHash, encoding, profile);
    const signature = ed25519Sign(seed.asBytes(), bytes);
    return { ...item, sessionSignature: signature.toString('base64') };
  });
}

// upstream: unsigned_hash_list.rs::validate_profile_encoding
function validateProfileEncoding(encoding, profile) {
  const supported = profile === SigningProfile.Bitcoin ? ['eip2519', 'hex', 'base64', 'base58'] : ['eip2519', 'base64'];
  if (!supported.includes(encoding)) throw new Error(`unsupported transaction encoding: ${encoding}`);
}

// upstream: unsigned_hash_list.rs::decode_unsigned_hash
export function decodeUnsignedHash(value, encoding, profile) {
  let bytes;
  if (value.startsWith('0x') || encoding === 'eip2519' || encoding === 'hex') {
    bytes = decodeHex(value, 'unsignedHash');
  } else if (encoding === 'base64') {
    try { bytes = B64.STANDARD.decode(value); } catch (e) { throw context('unsignedHash is not valid base64', e); }
  } else if (encoding === 'base58') {
    try { bytes = bs58Decode(value); } catch (e) { throw context('unsignedHash is not valid base58', e); }
  } else {
    throw new Error(`unsupported transaction encoding: ${encoding}`);
  }
  if (profile === SigningProfile.Sui && bytes.length !== 32) throw new Error(`SUI unsignedHash must decode to 32 bytes, got ${bytes.length}`);
  return bytes;
}

// upstream: unsigned_hash_list.rs::build_direct_extra_data → serialized extraData string
export function buildDirectExtraData(prepared, signedHashes, sessionCert, force, chainLabel) {
  if (!signedHashes.length) throw new Error('signed hash list must not be empty');
  const unsignedTx = requiredString(prepared, 'unsignedTx', 'unsignedInfo response');
  const signType = requiredString(prepared, 'signType', 'unsignedInfo response');
  const encoding = requiredString(prepared, 'encoding', 'unsignedInfo response');
  const txParam = get(prepared, 'txParam');
  if (txParam === undefined || txParam === null) throw new Error('unsignedInfo response is missing txParam');
  for (const item of signedHashes) {
    requiredString(item, 'unsignedHash', 'signed hash item');
    requiredString(item, 'sessionSignature', 'signed hash item');
  }
  const msgForSign = { unsignedTx, sessionCert, txParam, unsignedHashList: signedHashes };
  const unsignedTxHash = get(prepared, 'unsignedTxHash');
  if (typeof unsignedTxHash === 'string' && unsignedTxHash !== '') msgForSign.unsignedTxHash = unsignedTxHash;

  const base = get(prepared, 'extraData');
  const extraData = isObject(base) ? { ...base } : {};
  extraData.checkBalance = true;
  const uopHash = get(prepared, 'uopHash');
  extraData.uopHash = uopHash === undefined ? '' : uopHash;
  extraData.encoding = encoding;
  extraData.signType = signType;
  extraData.msgForSign = msgForSign;
  delete extraData.signTx;
  if (force) extraData.skipWarning = true;
  try {
    return stringify(extraData);
  } catch (e) {
    throw context(`failed to serialize ${chainLabel} extraData`, e);
  }
}
