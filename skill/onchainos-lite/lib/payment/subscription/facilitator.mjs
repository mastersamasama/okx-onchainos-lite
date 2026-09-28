// Buyer-direct, read-only facilitator endpoints for `period` — upstream
// payment/subscription/facilitator.rs. Both reads are unauthenticated, no OK headers.
import { context } from '../../core/errors.mjs';
import { WalletApiClient } from '../../wallet/api.mjs';
import { decodeAllowanceStatus, decodeBuyerSubscriptionListResp, decodeItemVec } from './types.mjs';
import { get } from '../_rs.mjs';

const BASE = '/api/v6/pay/x402';

// upstream: facilitator.rs::unwrap_first (private) — non-empty array → first element.
export const unwrapFirst = (data) => (Array.isArray(data) && data.length ? data[0] : data);

// upstream: facilitator.rs::allowance_status — GET …/buyers/{buyer}/allowance-status?token=..&chainIndex=..
export async function allowanceStatus(buyer, token, chainIndex) {
  const client = new WalletApiClient();
  const path = `${BASE}/buyers/${buyer}/allowance-status?token=${token}&chainIndex=${chainIndex}`;
  let data;
  try { data = await client.getNoOkheaders(path); } catch (e) { throw context('allowance-status query failed', e); }
  try { return decodeAllowanceStatus(unwrapFirst(data)); } catch (e) { throw context('parse allowance-status response', e); }
}

// upstream: facilitator.rs::my_subscriptions — limit clamped to 1..=100.
export async function mySubscriptions(buyer, limit, offset) {
  const client = new WalletApiClient();
  const l = Math.min(Math.max(Number(limit), 1), 100);
  const path = `${BASE}/buyers/${buyer}/subscriptions?limit=${l}&offset=${offset}`;
  let data;
  try { data = await client.getNoOkheaders(path); } catch (e) { throw context('my-subscriptions query failed', e); }
  return parseSubscriptionList(data);
}

// upstream: facilitator.rs::parse_subscription_list (private) — {subscriptions}, [{subscriptions}] or bare items.
export function parseSubscriptionList(data) {
  if (Array.isArray(data)) {
    const looksLikeEnvelope = data.length > 0 && get(data[0], 'subscriptions') !== undefined;
    if (!looksLikeEnvelope) {
      let subscriptions;
      try { subscriptions = decodeItemVec(data); } catch (e) { throw context('parse subscriptions array', e); }
      return { subscriptions };
    }
  }
  try { return decodeBuyerSubscriptionListResp(unwrapFirst(data)); } catch (e) { throw context('parse my-subscriptions response', e); }
}
