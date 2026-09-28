// EIP-712 typed-data for x402 Permit2 — upstream payment/permit2/eip712.rs.
// `build_*_typed_data` is the JSON the TEE `gen-msg-hash` API receives; `build_*_struct` +
// `eip712SigningHash` is the local-key digest (alloy `SolStruct::eip712_signing_hash`).
import { PERMIT2_ADDRESS } from '../../core/chains.mjs';
import { context } from '../../core/errors.mjs';
import { signingHash } from '../../crypto/eip712.mjs';
import { addressFromStr, u256FromStr, hex0x } from '../_rs.mjs';

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const ROOT_TYPES = [
  { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' },
];
const TOKEN_PERMISSIONS = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }];
const EXACT_WITNESS = [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }];
const UPTO_WITNESS = [{ name: 'to', type: 'address' }, { name: 'facilitator', type: 'address' }, { name: 'validAfter', type: 'uint256' }];
const clone = (a) => a.map((f) => ({ ...f }));

// upstream: eip712.rs::permit2_domain — {name: "Permit2", chainId, verifyingContract: PERMIT2}
export const permit2Domain = (chainId) => ({ name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS });

const addr = (s, what) => { try { return hex0x(addressFromStr(s)); } catch (e) { throw context(what, e); } };
const uint = (s, what) => { try { return u256FromStr(s); } catch (e) { throw context(what, e); } };

// upstream: eip712.rs::build_exact_permit2_struct — parsed values (throws upstream's contexts).
export function buildExactPermit2Struct(input) {
  return {
    permitted: { token: addr(input.token, 'invalid token address'), amount: uint(input.amount, 'invalid amount uint256') },
    spender: addr(input.spender, 'invalid spender address'),
    nonce: uint(input.nonce, 'invalid nonce uint256'),
    deadline: uint(input.deadline, 'invalid deadline uint256'),
    witness: { to: addr(input.witnessTo, 'invalid witness.to address'), validAfter: uint(input.witnessValidAfter, 'invalid witness.validAfter uint256') },
  };
}

// upstream: eip712.rs::build_upto_permit2_struct
export function buildUptoPermit2Struct(input) {
  return {
    permitted: { token: addr(input.token, 'invalid token address'), amount: uint(input.amount, 'invalid amount uint256') },
    spender: addr(input.spender, 'invalid spender address'),
    nonce: uint(input.nonce, 'invalid nonce uint256'),
    deadline: uint(input.deadline, 'invalid deadline uint256'),
    witness: {
      to: addr(input.witnessTo, 'invalid witness.to address'),
      facilitator: addr(input.witnessFacilitator, 'invalid witness.facilitator address'),
      validAfter: uint(input.witnessValidAfter, 'invalid witness.validAfter uint256'),
    },
  };
}

// alloy SolStruct::eip712_signing_hash for the exact / upto `PermitWitnessTransferFrom`.
export function exactSigningHash(s, chainId) {
  return signingHash({
    types: { EIP712Domain: DOMAIN_TYPES, PermitWitnessTransferFrom: ROOT_TYPES, TokenPermissions: TOKEN_PERMISSIONS, Witness: EXACT_WITNESS },
    primaryType: 'PermitWitnessTransferFrom', domain: permit2Domain(chainId), message: s,
  });
}
export function uptoSigningHash(s, chainId) {
  return signingHash({
    types: { EIP712Domain: DOMAIN_TYPES, PermitWitnessTransferFrom: ROOT_TYPES, TokenPermissions: TOKEN_PERMISSIONS, Witness: UPTO_WITNESS },
    primaryType: 'PermitWitnessTransferFrom', domain: permit2Domain(chainId), message: s,
  });
}

// upstream: eip712.rs::build_exact_permit2_typed_data — input {token, amount, spender, nonce,
// deadline, witnessTo, witnessValidAfter, chainId}; values verbatim.
export function buildExactPermit2TypedData(input) {
  return {
    domain: { name: 'Permit2', chainId: input.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: { EIP712Domain: clone(DOMAIN_TYPES), PermitWitnessTransferFrom: clone(ROOT_TYPES), TokenPermissions: clone(TOKEN_PERMISSIONS), Witness: clone(EXACT_WITNESS) },
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: input.token, amount: input.amount },
      spender: input.spender, nonce: input.nonce, deadline: input.deadline,
      witness: { to: input.witnessTo, validAfter: input.witnessValidAfter },
    },
  };
}

// upstream: eip712.rs::build_upto_permit2_typed_data — Witness gains `facilitator`.
export function buildUptoPermit2TypedData(input) {
  return {
    domain: { name: 'Permit2', chainId: input.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: { EIP712Domain: clone(DOMAIN_TYPES), PermitWitnessTransferFrom: clone(ROOT_TYPES), TokenPermissions: clone(TOKEN_PERMISSIONS), Witness: clone(UPTO_WITNESS) },
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: input.token, amount: input.amount },
      spender: input.spender, nonce: input.nonce, deadline: input.deadline,
      witness: { to: input.witnessTo, facilitator: input.witnessFacilitator, validAfter: input.witnessValidAfter },
    },
  };
}
