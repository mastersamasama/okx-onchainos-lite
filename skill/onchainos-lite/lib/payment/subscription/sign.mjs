// Signing orchestration for the x402 `period` scheme — upstream payment/subscription/sign.rs.
// Subscribe / change = double-sign (Permit2 PermitSingle + SubscriptionTerms, bound by
// terms.permitHash); cancel / cancel-pending-change = single signatures; all via the TEE eip712
// path so the contract can `ecrecover` the payer.
import { randomBytes } from 'node:crypto';
import { trim, eqIgnoreAsciiCase } from '../../core/rs/str.mjs';
import { get, asStr, asU64 } from '../../core/rs/value.mjs';
import { u256FromStrRadix, jsonInt } from '../../core/rs/num.mjs';
import { context } from '../../core/errors.mjs';
import { stringify } from '../../core/json.mjs';
import { teeSignEip712, teeSignPersonal } from '../permit2/sign.mjs';
import { allowanceStatus } from './facilitator.mjs';
import {
  accessProofInnerHash, buildCancelAuthTypedData, buildPendingChangeCancelAuthTypedData, buildPermitSingleTypedData,
  buildSubscriptionTermsTypedData, hex0x, permitSingleStructHash, termsDigest,
} from './eip712.mjs';
import { cancelAuth, pendingChangeCancelAuth, subscriptionPayload } from './types.mjs';

// upstream: sign.rs constants
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const DEFAULT_TIMEOUT_SECS = 3600;
const PERMIT_EXPIRATION_BUFFER_SECS = 86400;
const PERIOD_MODE_CALENDAR_MONTH = 1;

const nowSecs = () => Math.floor(Date.now() / 1000);
const randomBytes32Hex = () => '0x' + randomBytes(32).toString('hex');

// upstream: sign.rs::add_calendar_months (private) — chrono checked_add_months in UTC (day clamped).
export function addCalendarMonths(unixSecs, months) {
  const d = new Date(Number(unixSecs) * 1000);
  if (Number.isNaN(d.getTime())) return Number(unixSecs) + months * 31 * 86400;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + Number(months), day = d.getUTCDate();
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const t = Date.UTC(ty, tm, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  if (ty > 262143) return Number(unixSecs) + months * 31 * 86400;
  return Math.floor(t / 1000);
}

// upstream: sign.rs::str_field (private)
function strField(v, key) {
  const s = asStr(get(v, key));
  if (s === undefined) throw new Error(`missing/invalid string field \`${key}\` in accepts entry`);
  return s;
}
const u8 = (n) => Number(BigInt(n) & 0xffn);
const u32 = (n) => Number(BigInt(n) & 0xffffffffn);

// upstream: sign.rs::extract_terms_params (private; checks in upstream order)
export function extractTermsParams(accepted) {
  const extra = get(accepted, 'extra');
  if (extra === undefined) throw new Error('accepts entry missing `extra` (subscription params)');
  const ic = get(extra, 'initialCharge');
  let initialChargePeriods = 0, initialChargeAmount = '0';
  if (ic !== undefined && ic !== null) {
    initialChargePeriods = u32(asU64(get(ic, 'periodCount')) ?? 0);
    initialChargeAmount = asStr(get(ic, 'totalAmount')) ?? '0';
  }
  const plan = get(extra, 'plan');
  if (plan === undefined) throw new Error('accepts entry `extra` missing `plan`');
  const tier = asU64(get(plan, 'tier'));
  if (tier === undefined) throw new Error('`extra.plan.tier` missing or not an integer');
  const planTier = u8(tier);
  const planId = asStr(get(plan, 'id')) ?? '';
  const contracts = get(extra, 'contracts');
  if (contracts === undefined) throw new Error('accepts entry `extra` missing `contracts`');
  const subscriptionContract = asStr(get(contracts, 'subscription'));
  if (subscriptionContract === undefined) throw new Error('`extra.contracts.subscription` missing or not a string');
  const permit2Contract = asStr(get(contracts, 'permit2'));
  if (permit2Contract === undefined) throw new Error('`extra.contracts.permit2` missing or not a string');
  const periodSec = asU64(get(extra, 'periodSec'));
  if (periodSec === undefined) throw new Error('`extra.periodSec` missing or not an integer');
  const periodMode = u8(asU64(get(extra, 'periodMode')) ?? 0);
  if (periodMode === 0 && BigInt(periodSec) === 0n) throw new Error('fixed_seconds mode (periodMode=0) requires periodSec > 0');
  if (periodMode === 1 && BigInt(periodSec) !== 0n) throw new Error('calendar_month mode (periodMode=1) requires periodSec == 0');
  if (periodMode > 1) throw new Error(`invalid periodMode ${periodMode} (expected 0 or 1)`);
  const token = strField(accepted, 'asset');
  const merchant = strField(accepted, 'payTo');
  const facilitator = strField(extra, 'facilitator');
  const amountPerPeriod = strField(extra, 'amountPerPeriod');
  const mp = asU64(get(extra, 'maxPeriods'));
  if (mp === undefined) throw new Error('`extra.maxPeriods` missing or not an integer');
  return {
    token, merchant, facilitator, amountPerPeriod, periodSec, periodMode, maxPeriods: u32(mp),
    startAt: asU64(get(extra, 'startAt')) ?? 0, initialChargePeriods, initialChargeAmount, planTier, planId,
    timeoutSecs: asU64(get(accepted, 'maxTimeoutSeconds')) ?? DEFAULT_TIMEOUT_SECS, subscriptionContract, permit2Contract,
  };
}

// upstream: sign.rs::u256 (private) — decimal or 0x-hex.
export function u256(s) {
  const t = trim(s);
  const hex = t.startsWith('0x');
  let body = t;
  while (body.startsWith('0x')) body = body.slice(2);
  try { return u256FromStrRadix(body, hex ? 16 : 10); } catch (e) { throw context(`invalid uint256: ${s}`, e); }
}

// upstream: sign.rs::addr_eq (private) — authority non-empty AND ASCII case-insensitive equal.
const addrEq = (offer, authority) => authority !== '' && eqIgnoreAsciiCase(authority, offer);

// upstream: sign.rs::verify_contracts_against_authority (private)
export function verifyContractsAgainstAuthority(p, a) {
  if (!addrEq(p.subscriptionContract, a.subscriptionContract)) {
    throw new Error(`subscription contract mismatch: offer=\`${p.subscriptionContract}\`, authority=\`${a.subscriptionContract}\``);
  }
  if (!addrEq(p.permit2Contract, a.permit2Contract)) {
    throw new Error(`permit2 contract mismatch: offer=\`${p.permit2Contract}\`, authority=\`${a.permit2Contract}\``);
  }
}

const sat = (x) => (x > 18446744073709551615n ? 18446744073709551615n : x);
// alloy U256 (ruint) arithmetic operators wrap: result mod 2^256.
export const wrap256 = (x) => BigInt.asUintN(256, x);

// upstream: sign.rs::sign_double (private) → SignedSubscription {payload, subId, chainIndex, planId}
async function signDouble(chainIndex, chainId, payer, accepted, changeFromSubId, changeEffectiveAt) {
  const p = extractTermsParams(accepted);
  const a = await allowanceStatus(payer, p.token, chainIndex);
  verifyContractsAgainstAuthority(p, a);
  const spender = a.subscriptionContract;
  const remaining = BigInt(p.maxPeriods) - BigInt(p.initialChargePeriods);
  if (remaining < 0n) throw new Error('initialChargePeriods exceeds maxPeriods');
  // ruint `+` / `*` on U256 wrap modulo 2^256 (no overflow error, no panic).
  const newCommit = wrap256(u256(p.initialChargeAmount) + wrap256(u256(p.amountPerPeriod) * remaining));
  const reserved = trim(a.reservedAmount) === '' ? 0n : u256(a.reservedAmount);
  const amount = wrap256(reserved + newCommit);
  if (a.permit2Allowance !== '') {
    let layer1;
    try { layer1 = u256(a.permit2Allowance); } catch { layer1 = undefined; }
    if (layer1 !== undefined && layer1 < amount) {
      throw new Error(`Layer-1 Permit2 allowance insufficient on token ${p.token} (chain ${chainIndex}). ERC20.allowance(buyer, Permit2) is ${layer1}, but this subscription needs ${amount}. Approve once first: IERC20.approve(${a.permit2Contract}, MAX) — e.g. via an on-chain contract call — then retry the subscription.`);
    }
  }
  const effectiveStart = BigInt(p.startAt) === 0n ? BigInt(nowSecs()) : BigInt(p.startAt);
  let newSubEnd;
  if (p.periodMode === PERIOD_MODE_CALENDAR_MONTH) {
    const defer = changeEffectiveAt === 2 ? 1 : 0;
    newSubEnd = sat(BigInt(addCalendarMonths(effectiveStart, Math.min(p.maxPeriods + defer, 4294967295))) + BigInt(PERMIT_EXPIRATION_BUFFER_SECS));
  } else {
    const deferred = changeEffectiveAt === 2 ? BigInt(p.periodSec) : 0n;
    newSubEnd = sat(sat(sat(effectiveStart + deferred) + sat(BigInt(p.maxPeriods) * BigInt(p.periodSec))) + BigInt(PERMIT_EXPIRATION_BUFFER_SECS));
  }
  const expiration = jsonInt(BigInt(a.reservedExpiration) > newSubEnd ? BigInt(a.reservedExpiration) : newSubEnd);
  const nonce = a.nonce;
  const now = nowSecs();
  // `now + p.timeout_secs` is a plain u64 `+` — wraps in the (overflow-checks-off) release build.
  const termsDeadline = jsonInt(BigInt.asUintN(64, BigInt(now) + BigInt(p.timeoutSecs)));
  const sigDeadline = String(termsDeadline);
  const amountStr = amount.toString();

  const permitTd = buildPermitSingleTypedData(p.token, amountStr, expiration, nonce, spender, sigDeadline, a.permit2Contract, chainId);
  const permitHash = hex0x(permitSingleStructHash(p.token, amountStr, expiration, nonce, spender, sigDeadline));
  const permitSig = await teeSignEip712(chainIndex, payer, permitTd);

  const salt = randomBytes32Hex();
  const termsIn = {
    payer, merchant: p.merchant, facilitator: p.facilitator, token: p.token, amountPerPeriod: p.amountPerPeriod,
    periodSec: p.periodSec, maxPeriods: p.maxPeriods, startAt: p.startAt, initialChargePeriods: p.initialChargePeriods,
    initialChargeAmount: p.initialChargeAmount, termsDeadline, permitHash, salt, planTier: p.planTier,
    changeFromSubId, changeEffectiveAt, periodMode: p.periodMode, domain: { chainId, verifyingContract: spender },
  };
  const termsSig = await teeSignEip712(chainIndex, payer, buildSubscriptionTermsTypedData(termsIn));
  const subId = hex0x(termsDigest(termsIn));
  const payload = subscriptionPayload({
    terms: { ...termsIn, planId: p.planId },
    termsSignature: termsSig,
    permit: { details: { token: p.token, amount: amountStr, expiration, nonce }, spender, sigDeadline },
    permitSignature: permitSig,
  });
  return { payload, subId, chainIndex, planId: p.planId };
}

// upstream: sign.rs::sign_subscribe — changeFromSubId = 0x00.., changeEffectiveAt = 0.
export const signSubscribe = (chainIndex, chainId, payer, accepted) => signDouble(chainIndex, chainId, payer, accepted, ZERO_BYTES32, 0);

// upstream: sign.rs::sign_change
export async function signChange(chainIndex, chainId, payer, oldSubId, accepted) {
  const changeFrom = get(get(accepted, 'extra'), 'changeFrom');
  let fromSubId;
  if (oldSubId !== '') fromSubId = oldSubId;
  else {
    fromSubId = asStr(get(changeFrom, 'fromSubId'));
    if (fromSubId === undefined) throw new Error('change requires --sub-id or extra.changeFrom.fromSubId');
  }
  const effectiveAt = changeEffectiveAtFrom(changeFrom);
  return signDouble(chainIndex, chainId, payer, accepted, fromSubId, effectiveAt);
}

// upstream: sign.rs::change_effective_at_from (private)
export function changeEffectiveAtFrom(changeFrom) {
  if (changeFrom === undefined) throw new Error('change offer missing extra.changeFrom');
  const ea = asStr(get(changeFrom, 'effectiveAt'));
  if (ea !== undefined) {
    if (ea === 'immediate') return 1;
    if (ea === 'period_end') return 2;
    throw new Error(`unknown changeFrom.effectiveAt: ${ea}`);
  }
  const dir = asStr(get(changeFrom, 'direction'));
  if (dir === 'upgrade') return 1;
  if (dir === 'downgrade') return 2;
  if (dir !== undefined) throw new Error(`unknown changeFrom.direction: ${dir}`);
  throw new Error('changeFrom missing both effectiveAt and direction');
}

// upstream: sign.rs::sign_cancel → CancelAuth
export async function signCancel(chainIndex, chainId, payer, subId, verifyingContract) {
  const nonce = randomBytes32Hex();
  const deadline = nowSecs() + DEFAULT_TIMEOUT_SECS;
  const td = buildCancelAuthTypedData(0, subId, 0, nonce, deadline, { chainId, verifyingContract });
  const signature = await teeSignEip712(chainIndex, payer, td);
  return cancelAuth({ action: 0, subId, initiator: 0, nonce, deadline, signature });
}

// upstream: sign.rs::sign_cancel_pending_change → PendingChangeCancelAuth
export async function signCancelPendingChange(chainIndex, chainId, payer, subId, newSubId, verifyingContract) {
  const nonce = randomBytes32Hex();
  const deadline = nowSecs() + DEFAULT_TIMEOUT_SECS;
  const td = buildPendingChangeCancelAuthTypedData(subId, newSubId, nonce, deadline, { chainId, verifyingContract });
  const signature = await teeSignEip712(chainIndex, payer, td);
  return pendingChangeCancelAuth({ subId, newSubId, nonce, deadline, signature });
}

// upstream: sign.rs::build_access_proof → ["APP-Access", base64(JSON SubscriptionProof)]
export async function buildAccessProof(chainIndex, payer, subId) {
  const timestamp = nowSecs();
  const inner = accessProofInnerHash(subId, payer, timestamp);
  const signature = await teeSignPersonal(chainIndex, payer, hex0x(inner));
  const proof = { kind: 'subscription-id', subId, payer, timestamp, signature };
  return ['APP-Access', Buffer.from(stringify(proof), 'utf8').toString('base64')];
}
