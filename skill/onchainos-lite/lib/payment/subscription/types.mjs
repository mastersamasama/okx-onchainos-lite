// Wire + cache types for the x402 `period` scheme — upstream payment/subscription/types.rs.
// Struct builders keep serde declaration order (camelCase); decoders reproduce the serde derive +
// custom `flex_*` deserializers (errors carry serde_json's Display text).
import { struct, stringify, F64, formatF64 } from '../../core/json.mjs';
import { trim, strDebug } from '../../core/rs/str.mjs';
import { isObject, isNumber, numText, asU64, asI64 } from '../../core/rs/value.mjs';

// upstream: types.rs::SubscriptionTermsWire (17 signed fields + unsigned planId)
export const subscriptionTermsWire = (t) => struct({
  payer: t.payer, merchant: t.merchant, facilitator: t.facilitator, token: t.token, amountPerPeriod: t.amountPerPeriod,
  periodSec: t.periodSec, maxPeriods: t.maxPeriods, startAt: t.startAt, initialChargePeriods: t.initialChargePeriods,
  initialChargeAmount: t.initialChargeAmount, termsDeadline: t.termsDeadline, permitHash: t.permitHash, salt: t.salt,
  planId: t.planId, planTier: t.planTier, changeFromSubId: t.changeFromSubId, changeEffectiveAt: t.changeEffectiveAt,
  periodMode: t.periodMode,
});
// upstream: types.rs::PermitDetailsWire
export const permitDetailsWire = (d) => struct({ token: d.token, amount: d.amount, expiration: d.expiration, nonce: d.nonce });
// upstream: types.rs::PermitSingleWire
export const permitSingleWire = (p) => struct({ details: permitDetailsWire(p.details), spender: p.spender, sigDeadline: p.sigDeadline });
// upstream: types.rs::SubscriptionPayload
export const subscriptionPayload = (p) => struct({
  terms: subscriptionTermsWire(p.terms), termsSignature: p.termsSignature, permit: permitSingleWire(p.permit), permitSignature: p.permitSignature,
});
// upstream: types.rs::CancelAuth
export const cancelAuth = (c) => struct({ action: c.action, subId: c.subId, initiator: c.initiator, nonce: c.nonce, deadline: c.deadline, signature: c.signature });
// upstream: types.rs::PendingChangeCancelAuth
export const pendingChangeCancelAuth = (c) => struct({ subId: c.subId, newSubId: c.newSubId, nonce: c.nonce, deadline: c.deadline, signature: c.signature });
// upstream: types.rs::SubscriptionCacheEntry (changedToSubId skipped when None)
export const subscriptionCacheEntry = (e) => struct({
  subId: e.subId, resourceHost: e.resourceHost, merchant: e.merchant, planId: e.planId, planTier: e.planTier,
  maxPeriods: e.maxPeriods, state: e.state, changedToSubId: e.changedToSubId ?? undefined,
});

// ── serde error texts ────────────────────────────────────────────────
// serde `Unexpected` Display for a JSON value.
export function unexpected(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return `boolean \`${v}\``;
  if (typeof v === 'string') return `string ${strDebug(v)}`;
  if (v instanceof F64) return `floating point \`${formatF64(v.valueOf()).replace(/\.0$/, '.0')}\``;
  if (typeof v === 'number' || typeof v === 'bigint') return `integer \`${v}\``;
  if (Array.isArray(v)) return 'sequence';
  return 'map';
}
const invalidType = (v, exp) => new Error(`invalid type: ${unexpected(v)}, expected ${exp}`);
const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// upstream: types.rs::flex_string — string | number → string; null → ""; else error.
export function flexString(v) {
  if (typeof v === 'string') return v;
  if (isNumber(v)) return numText(v);
  if (v === null) return '';
  throw new Error(`expected string or number, got ${stringify(v)}`);
}
// upstream: types.rs::flex_u64 — number (u64) | trimmed string (empty → 0) | null → 0.
export function flexU64(v) {
  if (isNumber(v)) { const u = asU64(v); if (u === undefined) throw new Error('number out of u64 range'); return u; }
  if (typeof v === 'string') {
    const t = trim(v);
    if (t === '') return 0;
    if (!/^\+?[0-9]+$/.test(t)) throw new Error(`invalid u64 string ${strDebug(v)}: invalid digit found in string`);
    const b = BigInt(t.replace(/^\+/, ''));
    if (b > 18446744073709551615n) throw new Error(`invalid u64 string ${strDebug(v)}: number too large to fit in target type`);
    return Number.isSafeInteger(Number(b)) ? Number(b) : b;
  }
  if (v === null) return 0;
  throw new Error(`expected u64 number or string, got ${stringify(v)}`);
}
const plainString = (v) => { if (typeof v !== 'string') throw invalidType(v, 'a string'); return v; };
const uint = (bits, name) => (v) => {
  const u = asU64(v);
  if (u === undefined) {
    const i = asI64(v);
    if (i !== undefined) throw new Error(`invalid value: integer \`${i}\`, expected ${name}`);
    throw invalidType(v, name);
  }
  if (BigInt(u) > (1n << BigInt(bits)) - 1n) throw new Error(`invalid value: integer \`${u}\`, expected ${name}`);
  return u;
};
const bool = (v) => { if (typeof v !== 'boolean') throw invalidType(v, 'a boolean'); return v; };
const opt = (f) => (v) => (v === null ? null : f(v));

// Generic serde-derive struct decoder: fields [[key, deser, default]] in declaration order.
function decodeStruct(name, fields, v) {
  const out = {};
  if (Array.isArray(v)) {
    fields.forEach(([k, f, def], i) => {
      if (i < v.length) out[k] = f(v[i]);
      else if (def === undefined) throw new Error(`invalid length ${v.length}, expected struct ${name} with ${fields.length} elements`);
      else out[k] = def();
    });
    if (v.length > fields.length) throw new Error(`invalid length ${v.length}, expected struct ${name} with ${fields.length} elements`);
    return out;
  }
  if (!isObject(v)) throw invalidType(v, `struct ${name}`);
  // serde_json::from_value walks the Value's BTreeMap: keys in byte order (not document order),
  // so with several bad fields the first *sorted* one is reported.
  for (const k of Object.keys(v).sort(byteCmp)) {
    const f = fields.find(([fk]) => fk === k);
    if (f && v[k] !== undefined) out[k] = f[1](v[k]);
  }
  for (const [k, , def] of fields) {
    if (out[k] !== undefined) continue;
    if (def === undefined) throw new Error(`missing field \`${k}\``);
    out[k] = def();
  }
  return out;
}

// upstream: types.rs::AllowanceStatus (Deserialize only; every field #[serde(default)])
export function decodeAllowanceStatus(v) {
  const s = () => '', z = () => 0;
  return decodeStruct('AllowanceStatus', [
    ['approvedAmount', flexString, s], ['expiration', flexU64, z], ['nonce', flexU64, z], ['reservedAmount', flexString, s],
    ['reservedExpiration', flexU64, z], ['tokenBalance', flexString, s], ['availableAmount', flexString, s],
    ['permit2Allowance', flexString, s], ['subscriptionContract', plainString, s], ['permit2Contract', plainString, s],
  ], v);
}

const ITEM_FIELDS = [
  ['chainIndex', flexU64, () => 0], ['subId', plainString, undefined], ['state', uint(8, 'u8'), () => 0],
  ['payer', plainString, () => ''], ['token', plainString, () => ''], ['amountPerPeriod', flexString, () => ''],
  ['periodSec', flexU64, () => 0], ['periodMode', uint(8, 'u8'), () => 0], ['billingAnchorAt', flexU64, () => 0],
  ['maxPeriods', uint(32, 'u32'), () => 0], ['startAt', flexU64, () => 0], ['initialChargePeriods', uint(32, 'u32'), () => 0],
  ['initialChargeAmount', flexString, () => ''], ['lastChargedPeriod', uint(32, 'u32'), () => 0], ['totalPulled', flexString, () => ''],
  ['planId', plainString, () => ''], ['planTier', uint(8, 'u8'), () => 0], ['changedToSubId', opt(plainString), () => null],
  ['isActive', bool, () => false], ['serviceEnded', bool, () => false], ['currentPeriod', uint(32, 'u32'), () => 0],
  ['nextChargeableAt', opt(uint(64, 'u64')), () => null],
];
// upstream: types.rs::BuyerSubscriptionItem (Deserialize; re-serialized in declaration order, unknown fields dropped)
export const decodeBuyerSubscriptionItem = (v) => decodeStruct('BuyerSubscriptionItem', ITEM_FIELDS, v);
export const buyerSubscriptionItem = (i) => struct(Object.fromEntries(ITEM_FIELDS.map(([k]) => [k, i[k]])));

// upstream: types.rs::BuyerSubscriptionListResp {subscriptions (default [])}
export function decodeBuyerSubscriptionListResp(v) {
  return decodeStruct('BuyerSubscriptionListResp', [['subscriptions', decodeItemVec, () => []]], v);
}
export function decodeItemVec(v) {
  if (!Array.isArray(v)) throw invalidType(v, 'a sequence');
  return v.map(decodeBuyerSubscriptionItem);
}
