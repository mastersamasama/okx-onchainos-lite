// Permit2 payload types for the x402 exact + Permit2 / upto schemes — upstream
// payment/permit2/types.rs. Struct builders keep declaration order (serde derive); callers that
// upstream converts with `serde_json::to_value` use `toValue` (sorted keys).
import { struct } from '../../core/json.mjs';

// upstream: types.rs::CLOCK_SKEW_BACKDATE_SECS
export const CLOCK_SKEW_BACKDATE_SECS = 600;

// upstream: types.rs::Permit2Permitted {token, amount}
export const permit2Permitted = ({ token, amount }) => struct({ token, amount });
// upstream: types.rs::Permit2Witness {to, validAfter}
export const permit2Witness = ({ to, validAfter }) => struct({ to, validAfter });
// upstream: types.rs::Permit2Authorization {from, permitted, spender, nonce, deadline, witness}
export const permit2Authorization = ({ from, permitted, spender, nonce, deadline, witness }) =>
  struct({ from, permitted: permit2Permitted(permitted), spender, nonce, deadline, witness: permit2Witness(witness) });
// upstream: types.rs::ExactPermit2Payload {signature, permit2Authorization}
export const exactPermit2Payload = ({ signature, permit2Authorization: a }) => struct({ signature, permit2Authorization: permit2Authorization(a) });
// upstream: types.rs::UptoPermit2Witness {to, facilitator, validAfter}
export const uptoPermit2Witness = ({ to, facilitator, validAfter }) => struct({ to, facilitator, validAfter });
// upstream: types.rs::UptoPermit2Authorization
export const uptoPermit2Authorization = ({ from, permitted, spender, nonce, deadline, witness }) =>
  struct({ from, permitted: permit2Permitted(permitted), spender, nonce, deadline, witness: uptoPermit2Witness(witness) });
// upstream: types.rs::UptoPermit2Payload
export const uptoPermit2Payload = ({ signature, permit2Authorization: a }) => struct({ signature, permit2Authorization: uptoPermit2Authorization(a) });

// serde_json::to_value(struct) → Value (a BTreeMap: keys sorted when printed) — drops struct order.
export function toValue(v) {
  if (Array.isArray(v)) return v.map(toValue);
  if (v && typeof v === 'object' && v.constructor === Object) {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = toValue(v[k]);
    return o;
  }
  return v;
}
