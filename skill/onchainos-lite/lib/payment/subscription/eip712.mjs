// EIP-712 typed-data builders + local hashes for the x402 `period` scheme — upstream
// payment/subscription/eip712.rs. Typestrings must match the backend byte-for-byte.
import { keccak256 } from '../../crypto/keccak.mjs';
import { context } from '../../core/errors.mjs';
import { trim } from '../../core/_rust-str.mjs';
import { addressFromStr, b256FromStr, u256FromStr, word, wordAddr } from '../_rs.mjs';

// upstream: eip712.rs typestrings
export const SUBSCRIPTION_TERMS_TYPESTRING = 'SubscriptionTerms(address payer,address merchant,address facilitator,address token,uint160 amountPerPeriod,uint64 periodSec,uint32 maxPeriods,uint64 startAt,uint32 initialChargePeriods,uint160 initialChargeAmount,uint64 termsDeadline,bytes32 permitHash,bytes32 salt,uint8 planTier,bytes32 changeFromSubId,uint8 changeEffectiveAt,uint8 periodMode)';
export const CANCEL_AUTH_TYPESTRING = 'CancelAuth(uint8 action,bytes32 subId,uint8 initiator,bytes32 nonce,uint64 deadline)';
export const PENDING_CHANGE_CANCEL_AUTH_TYPESTRING = 'PendingChangeCancelAuth(bytes32 subId,bytes32 newSubId,bytes32 nonce,uint64 deadline)';
export const PERMIT_DETAILS_TYPESTRING = 'PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)';
export const PERMIT_SINGLE_TYPESTRING = 'PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)';
const EIP712_DOMAIN_TYPESTRING = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

const SUB_DOMAIN_TYPES = () => [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const subDomain = (d) => ({ name: 'A2APaySubscription', version: '1', chainId: d.chainId, verifyingContract: d.verifyingContract });

// upstream: eip712.rs::build_subscription_terms_typed_data — i = SubscriptionTermsInput
// {payer, merchant, facilitator, token, amountPerPeriod, periodSec, maxPeriods, startAt,
//  initialChargePeriods, initialChargeAmount, termsDeadline, permitHash, salt, planTier,
//  changeFromSubId, changeEffectiveAt, periodMode, domain: {chainId, verifyingContract}}
export function buildSubscriptionTermsTypedData(i) {
  return {
    domain: subDomain(i.domain),
    types: {
      EIP712Domain: SUB_DOMAIN_TYPES(),
      SubscriptionTerms: [
        ['payer', 'address'], ['merchant', 'address'], ['facilitator', 'address'], ['token', 'address'],
        ['amountPerPeriod', 'uint160'], ['periodSec', 'uint64'], ['maxPeriods', 'uint32'], ['startAt', 'uint64'],
        ['initialChargePeriods', 'uint32'], ['initialChargeAmount', 'uint160'], ['termsDeadline', 'uint64'],
        ['permitHash', 'bytes32'], ['salt', 'bytes32'], ['planTier', 'uint8'], ['changeFromSubId', 'bytes32'],
        ['changeEffectiveAt', 'uint8'], ['periodMode', 'uint8'],
      ].map(([name, type]) => ({ name, type })),
    },
    primaryType: 'SubscriptionTerms',
    message: {
      payer: i.payer, merchant: i.merchant, facilitator: i.facilitator, token: i.token, amountPerPeriod: i.amountPerPeriod,
      periodSec: i.periodSec, maxPeriods: i.maxPeriods, startAt: i.startAt, initialChargePeriods: i.initialChargePeriods,
      initialChargeAmount: i.initialChargeAmount, termsDeadline: i.termsDeadline, permitHash: i.permitHash, salt: i.salt,
      planTier: i.planTier, changeFromSubId: i.changeFromSubId, changeEffectiveAt: i.changeEffectiveAt, periodMode: i.periodMode,
    },
  };
}

// upstream: eip712.rs::build_permit_single_typed_data (Permit2 domain, no version)
export function buildPermitSingleTypedData(token, amount, expiration, nonce, spender, sigDeadline, permit2Contract, chainId) {
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: permit2Contract },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
    },
    primaryType: 'PermitSingle',
    message: { details: { token, amount, expiration, nonce }, spender, sigDeadline },
  };
}

// upstream: eip712.rs::build_cancel_auth_typed_data
export function buildCancelAuthTypedData(action, subId, initiator, nonce, deadline, d) {
  return {
    domain: subDomain(d),
    types: {
      EIP712Domain: SUB_DOMAIN_TYPES(),
      CancelAuth: [{ name: 'action', type: 'uint8' }, { name: 'subId', type: 'bytes32' }, { name: 'initiator', type: 'uint8' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }],
    },
    primaryType: 'CancelAuth',
    message: { action, subId, initiator, nonce, deadline },
  };
}

// upstream: eip712.rs::build_pending_change_cancel_auth_typed_data
export function buildPendingChangeCancelAuthTypedData(subId, newSubId, nonce, deadline, d) {
  return {
    domain: subDomain(d),
    types: {
      EIP712Domain: SUB_DOMAIN_TYPES(),
      PendingChangeCancelAuth: [{ name: 'subId', type: 'bytes32' }, { name: 'newSubId', type: 'bytes32' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }],
    },
    primaryType: 'PendingChangeCancelAuth',
    message: { subId, newSubId, nonce, deadline },
  };
}

// ── local hash helpers ───────────────────────────────────────────────
// upstream: eip712.rs::word_addr / word_uint_dec / word_u64 / word_b32 (private)
function wordAddrStr(s) { try { return wordAddr(addressFromStr(trim(s))); } catch (e) { throw context(`invalid address: ${s}`, e); } }
function wordUintDec(s) { try { return word(u256FromStr(trim(s))); } catch (e) { throw context(`invalid uint (decimal): ${s}`, e); } }
const wordU64 = (n) => word(BigInt(n));
function wordB32(s) { try { return b256FromStr(trim(s)); } catch (e) { throw context(`invalid bytes32: ${s}`, e); } }
const kc = (s) => keccak256(Buffer.from(s, 'utf8'));

// upstream: eip712.rs::permit_single_struct_hash → 32-byte Buffer (hashStruct, not the digest)
export function permitSingleStructHash(token, amount, expiration, nonce, spender, sigDeadline) {
  const details = keccak256(Buffer.concat([kc(PERMIT_DETAILS_TYPESTRING), wordAddrStr(token), wordUintDec(amount), wordU64(expiration), wordU64(nonce)]));
  return keccak256(Buffer.concat([kc(PERMIT_SINGLE_TYPESTRING), details, wordAddrStr(spender), wordUintDec(sigDeadline)]));
}

// upstream: eip712.rs::subscription_terms_struct_hash
export function subscriptionTermsStructHash(i) {
  return keccak256(Buffer.concat([
    kc(SUBSCRIPTION_TERMS_TYPESTRING),
    wordAddrStr(i.payer), wordAddrStr(i.merchant), wordAddrStr(i.facilitator), wordAddrStr(i.token),
    wordUintDec(i.amountPerPeriod), wordU64(i.periodSec), wordU64(i.maxPeriods), wordU64(i.startAt),
    wordU64(i.initialChargePeriods), wordUintDec(i.initialChargeAmount), wordU64(i.termsDeadline),
    wordB32(i.permitHash), wordB32(i.salt), wordU64(i.planTier), wordB32(i.changeFromSubId),
    wordU64(i.changeEffectiveAt), wordU64(i.periodMode),
  ]));
}

// upstream: eip712.rs::sub_domain_separator (private)
function subDomainSeparator(d) {
  return keccak256(Buffer.concat([kc(EIP712_DOMAIN_TYPESTRING), kc('A2APaySubscription'), kc('1'), wordU64(d.chainId), wordAddrStr(d.verifyingContract)]));
}

// upstream: eip712.rs::terms_digest — keccak256(0x1901 ‖ domainSeparator ‖ termsStructHash) = subId
export function termsDigest(i) {
  const sep = subDomainSeparator(i.domain);
  const sh = subscriptionTermsStructHash(i);
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), sep, sh]));
}

// upstream: eip712.rs::ACCESS_PROOF_TIMESTAMP_BYTES
const ACCESS_PROOF_TIMESTAMP_BYTES = 32;

// upstream: eip712.rs::access_proof_inner_hash — keccak256(subId 32B ‖ payer 20B ‖ timestamp BE)
export function accessProofInnerHash(subId, payer, timestamp) {
  let sub, addr;
  try { sub = b256FromStr(trim(subId)); } catch (e) { throw context(`invalid subId bytes32: ${subId}`, e); }
  try { addr = addressFromStr(trim(payer)); } catch (e) { throw context(`invalid payer address: ${payer}`, e); }
  const ts = word(BigInt(timestamp));
  return keccak256(Buffer.concat([sub, addr, ts.subarray(32 - ACCESS_PROOF_TIMESTAMP_BYTES)]));
}

// upstream: eip712.rs::hex0x
export const hex0x = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
