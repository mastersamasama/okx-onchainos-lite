// x402 auto-pay signer for the OKX ApiClient — upstream client.rs::sign_header_from_accepts:
// `payment_flow::sign_payment_auto(accepts, Some(tier))` (TEE when wallets.json exists, else
// the local EVM_PRIVATE_KEY) → `payment_flow::build_payment_header(proof, entry, resource)`.
// core/http.mjs lazily imports this module; importing it registers the signer.
import { setPaymentSigner } from '../core/http.mjs';
import { signPaymentAuto, buildPaymentHeader } from './payment-flow.mjs';

// upstream: client.rs::sign_header_from_accepts → ["PAYMENT-SIGNATURE", base64(JSON)]
// ({accepts, tier: "basic"|"premium", resource: `<base_url><path>`}).
export async function signHeaderFromAccepts({ accepts, tier, resource }) {
  const [proof, entry] = await signPaymentAuto(accepts, tier ?? 'basic');
  return buildPaymentHeader(proof, entry, resource);
}

setPaymentSigner(signHeaderFromAccepts);
