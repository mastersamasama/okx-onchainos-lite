// SUI Agentic Wallet transaction API adapter — upstream agentic_wallet/shared/adapters/sui/api.rs.
import { randomUUID } from 'node:crypto';
import { CodedError } from '../../../../core/errors.mjs';
import { WalletApiClient, ApiCodeError } from '../../../api.mjs';
import { firstDataItem } from '../../common/json.mjs';
import { downcast } from '../../_rust.mjs';

const UNSIGNED_INFO_PATH = '/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo';

// upstream: api.rs::SuiApi — methods take a SuiContext.
export class SuiApi {
  constructor() { this.client = new WalletApiClient(); }

  // upstream: api.rs::SuiApi::token_metadata
  async tokenMetadata(ctx, coinType) {
    let data;
    try { data = await this.client.getTokenInfo(ctx.accessToken, ctx.chainIndexU64(), coinType); } catch (e) { throw mapApiError(e); }
    return firstDataItem(data);
  }

  // upstream: api.rs::SuiApi::prepare_transaction — idempotency-key UUID v4 header.
  async prepareTransaction(ctx, to, amount, coinType) {
    const body = { chainIndex: ctx.chainIndexU64(), fromAddr: ctx.address.address, toAddr: to, amount, sessionCert: ctx.sessionCert() };
    if (coinType !== undefined && coinType !== null) body.contractAddr = String(coinType);
    let data;
    try { data = await this.client.postAuthedWithHeaders(UNSIGNED_INFO_PATH, ctx.accessToken, body, [['idempotency-key', randomUUID()]]); } catch (e) { throw mapApiError(e); }
    return firstDataItem(data);
  }

  // upstream: api.rs::SuiApi::prepare_contract_call
  async prepareContractCall(ctx, to, amount, txBytes) {
    const body = buildContractCallBody(ctx.chainIndexU64(), ctx.address.address, to, amount, ctx.sessionCert(), txBytes);
    let data;
    try { data = await this.client.postAuthedWithHeaders(UNSIGNED_INFO_PATH, ctx.accessToken, body, [['idempotency-key', randomUUID()]]); } catch (e) { throw mapApiError(e); }
    return firstDataItem(data);
  }

  // upstream: api.rs::SuiApi::broadcast_transaction — WalletApiClient::broadcast_transaction (no trace headers)
  broadcastTransaction(ctx, extraData) {
    return this.client.broadcastTransaction(ctx.accessToken, ctx.accountId, ctx.address.address, ctx.profile.chainIndex, extraData, null);
  }
}

// upstream: api.rs::build_contract_call_body
export function buildContractCallBody(chainIndex, fromAddr, toAddr, amount, sessionCert, txBytes) {
  return { chainIndex, fromAddr, toAddr: toAddr ?? '0x', amount, contractAddr: '0x0', sessionCert, txParam: { txBytes } };
}

// upstream: api.rs::map_api_error — ApiCodeError → CodedError{code, msg}; others unchanged.
export function mapApiError(error) {
  const api = downcast(error, ApiCodeError);
  return api ? new CodedError(api.code, null, api.msg) : error;
}
