// Bitcoin / BRC-20 Agentic Wallet API adapter — upstream
// agentic_wallet/shared/adapters/bitcoin/api.rs.
import { randomUUID } from 'node:crypto';
import { context, CliError } from '../../../../core/errors.mjs';
import { WalletApiClient, decodeBroadcastResponse, SerdeError } from '../../../api.mjs';
import { decimalField, valueAsDecimalString } from '../../common/amount.mjs';
import { firstDataItem } from '../../common/json.mjs';
import { mapApiError } from './error.mjs';
import { get } from '../../../../core/rs/value.mjs';
import { trim } from '../../../../core/rs/str.mjs';

// upstream: api.rs::UTXO_MANAGE_BATCH_SIZE / UTXO_ASSET_INFO_BATCH_SIZE
export const UTXO_MANAGE_BATCH_SIZE = 50;
export const UTXO_ASSET_INFO_BATCH_SIZE = 10;

const UNSIGNED_INFO_PATH = '/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo';

// serde_json::from_value::<BroadcastResponse>(item).context(msg)
function parseBroadcast(item, msg) {
  try { return decodeBroadcastResponse(item); } catch (e) { if (e instanceof SerdeError) throw context(msg, e); throw e; }
}

// upstream: api.rs::BtcApi — methods take a BtcContext.
export class BtcApi {
  constructor() { this.client = new WalletApiClient(); }

  // upstream: api.rs::BtcApi::token_metadata
  async tokenMetadata(ctx, tokenAddress) {
    let data;
    try { data = await this.client.getTokenInfo(ctx.accessToken, ctx.chainIndexU64(), tokenAddress); } catch (e) { throw mapApiError(e); }
    return firstDataItem(data);
  }

  // upstream: api.rs::BtcApi::brc20_balance — raw balance payload.
  async brc20Balance(ctx, tokenAddress) {
    const ci = ctx.profile.chainIndex;
    const query = [['accountId', ctx.accountId], ['chains', ci], ['tokenAddresses[0].chainIndex', ci], ['tokenAddresses[0].tokenAddress', tokenAddress]];
    try { return await this.client.balanceSingle(ctx.accessToken, query); } catch (e) { throw mapApiError(e); }
  }

  // upstream: api.rs::BtcApi::availability_details
  availabilityDetails(ctx, queryType) { return this.availabilityDetailsRequest(ctx, queryType, undefined); }

  // upstream: api.rs::BtcApi::brc20_utxo_asset_info — chunks of 10, results concatenated.
  async brc20UtxoAssetInfo(ctx, outpoints) {
    if (!outpoints.length) return [];
    if (ctx.profile.chainIndex !== '0') throw new Error(`BRC-20 UTXO asset details require Bitcoin chainIndex 0, got ${ctx.profile.chainIndex}`);
    const records = [];
    for (let i = 0; i < outpoints.length; i += UTXO_ASSET_INFO_BATCH_SIZE) {
      const body = buildBrc20UtxoAssetInfoBody(ctx, outpoints.slice(i, i + UTXO_ASSET_INFO_BATCH_SIZE));
      let result;
      try { result = await this.client.postAuthed('/priapi/v5/wallet/agentic/utxo/utxo-asset-info', ctx.accessToken, body); } catch (e) { throw mapApiError(e); }
      if (Array.isArray(result)) records.push(...result); else records.push(result);
    }
    return records;
  }

  // upstream: api.rs::BtcApi::brc20_transferable_utxos
  brc20TransferableUtxos(ctx, tokenAddress) { return this.availabilityDetailsRequest(ctx, 'BRC20_TRANSFERABLE_UTXO_LIST', tokenAddress); }

  // upstream: api.rs::BtcApi::availability_details_request
  async availabilityDetailsRequest(ctx, queryType, tokenAddress) {
    const body = { chainIndex: ctx.profile.chainIndex, address: ctx.address.address, queryType };
    if (tokenAddress !== undefined && tokenAddress !== null) body.tokenAddress = tokenAddress;
    let data;
    try { data = await this.client.postAuthed('/priapi/v5/wallet/agentic/utxo/availability-details', ctx.accessToken, body); } catch (e) { throw mapApiError(e); }
    return firstDataItem(data);
  }

  // upstream: api.rs::BtcApi::manage_utxos — state-changing, no retry.
  async manageUtxos(ctx, action, message, outpoints) {
    const body = buildManageUtxosBody(ctx.profile.chainIndex, action, message, outpoints);
    try { return await this.client.postAuthedMutationNoRetry('/priapi/v5/wallet/agentic/utxo/user-asset-manage', ctx.accessToken, body); } catch (e) { throw mapApiError(e); }
  }

  // upstream: api.rs::BtcApi::prepare_transaction (errors unmapped — callers map)
  prepareTransaction(ctx, to, amount, tokenAddress, signType, feeRate) {
    const body = { chainIndex: ctx.chainIndexU64(), fromAddr: ctx.address.address, toAddr: to, amount, sessionCert: ctx.sessionCert() };
    if (tokenAddress !== undefined && tokenAddress !== null) body.contractAddr = String(tokenAddress);
    if (signType !== undefined && signType !== null) body.signType = String(signType);
    if (feeRate !== undefined && feeRate !== null) body.txParam = { feeRate };
    return this.requestUnsignedInfo(ctx, body);
  }

  // upstream: api.rs::BtcApi::prepare_selected_brc20_transfer
  prepareSelectedBrc20Transfer(ctx, to, amount, tokenAddress, txParam) {
    const body = { chainIndex: ctx.chainIndexU64(), fromAddr: ctx.address.address, toAddr: to, contractAddr: tokenAddress, amount, sessionCert: ctx.sessionCert(), signType: 'transfer', txParam };
    const walletType = ctx.socialWalletType();
    if (walletType !== undefined) body.walletType = walletType;
    return this.requestUnsignedInfo(ctx, body);
  }

  // upstream: api.rs::BtcApi::request_unsigned_info — idempotency-key UUID v4 header.
  async requestUnsignedInfo(ctx, body) {
    const data = await this.client.postAuthedWithHeaders(UNSIGNED_INFO_PATH, ctx.accessToken, body, [['idempotency-key', randomUUID()]]);
    return firstDataItem(data);
  }

  // upstream: api.rs::BtcApi::sign_transaction — inscription `sign-tx` (funds; no retry).
  async signTransaction(ctx, unsigned, signedHashes) {
    const signType = get(unsigned, 'signType');
    if (typeof signType !== 'string' || signType === '') throw new Error('unsignedInfo response is missing signType');
    const txParam = get(unsigned, 'txParam');
    if (txParam === undefined || txParam === null) throw new Error('unsignedInfo response is missing txParam');
    if (!signedHashes.length) throw new Error('signed hash list must not be empty');
    const body = {
      from: ctx.address.address, chainIndex: ctx.chainIndexU64(), sessionCert: ctx.sessionCert(),
      payload: [{ signType, txParam, unsignedHashList: signedHashes }],
    };
    const data = await this.client.postAuthedMutationNoRetry('/priapi/v5/wallet/agentic/pre-transaction/sign-tx', ctx.accessToken, body);
    return firstDataItem(data);
  }

  // upstream: api.rs::BtcApi::broadcast_transaction → BroadcastResponse
  async broadcastTransaction(ctx, extraData) {
    const body = { accountId: ctx.accountId, address: ctx.address.address, chainIndex: ctx.profile.chainIndex, extraData };
    const data = await this.client.postAuthedMutationNoRetry('/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction', ctx.accessToken, body);
    if (!Array.isArray(data) || !data.length) throw new CliError('broadcast: expected a non-empty data array');
    return parseBroadcast(data[0], 'broadcast: failed to parse response');
  }

  // upstream: api.rs::BtcApi::batch_broadcast_transactions → BroadcastResponse[]
  async batchBroadcastTransactions(ctx, body) {
    const data = await this.client.postAuthedMutationNoRetry('/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction', ctx.accessToken, body);
    if (!Array.isArray(data)) throw new CliError('batch broadcast: expected data to be an array');
    return data.map((item, index) => parseBroadcast(item, `batch broadcast: failed to parse response item ${index}`));
  }

  // upstream: api.rs::BtcApi::order_detail — validated against the requested context.
  async orderDetail(ctx, txHash, orderId) {
    const query = [['accountId', ctx.accountId], ['chainIndex', ctx.profile.chainIndex], ['address', ctx.address.address]];
    if (txHash !== undefined && txHash !== null) query.push(['txHash', txHash]);
    if (orderId !== undefined && orderId !== null) query.push(['orderId', orderId]);
    const data = await this.client.getAuthed('/priapi/v5/wallet/agentic/order/detail', ctx.accessToken, query);
    const detail = firstDataItem(data);
    validateOrderDetailContext(ctx, detail, txHash, orderId);
    return detail;
  }

  // upstream: api.rs::BtcApi::close_transactions — note the /api/v5 (non-agentic) path.
  closeTransactions(ctx, txHashes) {
    return this.client.postAuthedMutationNoRetry('/api/v5/wallet/pre-transaction/close-transaction', ctx.accessToken, { chainIndex: ctx.profile.chainIndex, txHashList: [...txHashes] });
  }
}

// upstream: api.rs::build_brc20_utxo_asset_info_body
export function buildBrc20UtxoAssetInfoBody(ctx, outpoints) {
  if (!outpoints.length || outpoints.length > UTXO_ASSET_INFO_BATCH_SIZE) {
    throw new Error(`UTXO asset detail requests require 1..=${UTXO_ASSET_INFO_BATCH_SIZE} outpoints per batch`);
  }
  if (!ctx.profile.isBitcoin()) throw new Error('BRC-20 UTXO asset details require a Bitcoin chain profile');
  return { chainIndex: ctx.profile.chainIndex, address: ctx.address.address, assetProtocols: ['BRC20'], utxos: outpoints.map((o) => o.toApiValue()) };
}

// upstream: api.rs::extract_token_decimals
export function extractTokenDecimals(metadata) {
  const d = decimalField(metadata);
  if (d === undefined) throw new Error('BRC-20 token metadata is missing decimal/decimals');
  return d;
}

// upstream: api.rs::validate_order_detail_context
export function validateOrderDetailContext(ctx, detail, txHash, orderId) {
  const ci = valueAsDecimalString(get(detail, 'chainIndex'));
  if (ci !== undefined && ci !== ctx.profile.chainIndex) {
    throw new Error(`ORDER_CONTEXT_MISMATCH: response chainIndex ${ci} does not match requested ${ctx.profile.chainIndex}`);
  }
  const accountId = get(detail, 'accountId');
  if (typeof accountId === 'string' && accountId !== '' && accountId !== ctx.accountId) {
    throw new Error('ORDER_CONTEXT_MISMATCH: response accountId does not match current account');
  }
  if (txHash !== undefined && txHash !== null) {
    const actual = get(detail, 'txHash');
    if (typeof actual === 'string' && actual !== '' && actual !== txHash) throw new Error('ORDER_CONTEXT_MISMATCH: response txHash does not match request');
  }
  if (orderId !== undefined && orderId !== null) {
    const actual = get(detail, 'orderId');
    if (typeof actual === 'string' && actual !== '' && actual !== orderId) throw new Error('ORDER_CONTEXT_MISMATCH: response orderId does not match request');
  }
}

// upstream: api.rs::build_manage_utxos_body
export function buildManageUtxosBody(chainIndex, action, message, outpoints) {
  if (trim(chainIndex) === '') throw new Error('UTXO management chainIndex must not be empty');
  if (action !== 'ignoreAsset' && action !== 'cancelIgnore') throw new Error(`unsupported UTXO management action: ${action}`);
  if (trim(message) === '') throw new Error('UTXO management message must not be empty');
  if (!outpoints.length || outpoints.length > UTXO_MANAGE_BATCH_SIZE) throw new Error(`UTXO management requires 1..=${UTXO_MANAGE_BATCH_SIZE} outpoints per batch`);
  return { chainIndex, action, message, utxos: outpoints.map((o) => o.toApiValue()) };
}
