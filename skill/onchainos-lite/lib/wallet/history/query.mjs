// Wallet order history (list) and order detail query — upstream agentic_wallet/history/query.rs.
import { WalletApiClient } from '../api.mjs';
import * as store from '../store.mjs';
import { ensureTokensRefreshed, formatApiError } from '../auth.mjs';
import { getChainByRealChainIndex } from '../chain.mjs';
import { ERR_NOT_LOGGED_IN } from '../common.mjs';
import { isI64, get } from '../../core/rs/value.mjs';
import { filterDetailResponse, filterListResponse } from './response.mjs';

const some = (v) => v !== undefined && v !== null;

// upstream: query.rs::cmd_query_history → output data
export async function cmdQueryHistory(accountId, chain, address, begin, end, cursor, limit, orderId, txHash, uopHash) {
  const accessToken = await ensureTokensRefreshed();

  let resolvedAccountId;
  if (some(accountId) && accountId !== '') resolvedAccountId = accountId;
  else {
    const wallets = store.loadWallets();
    if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
    if (wallets.selectedAccountId === '') throw new Error(ERR_NOT_LOGGED_IN);
    resolvedAccountId = wallets.selectedAccountId;
  }

  let chainIndex = '';
  if (some(chain) && chain !== '') {
    const entry = await getChainByRealChainIndex(chain);
    if (!entry) throw new Error(`unsupported chain: ${chain}`);
    const ci = get(entry, 'chainIndex');
    chainIndex = typeof ci === 'string' ? ci : isI64(ci) ? String(ci) : '';
  }

  const client = new WalletApiClient();
  if (some(txHash) || some(orderId) || some(uopHash)) {
    if (chainIndex === '') throw new Error('--chain is required for order detail query');
    const query = [['accountId', resolvedAccountId], ['chainIndex', chainIndex]];
    if (some(address) && address !== '') query.push(['address', address]);
    if (some(txHash)) query.push(['txHash', txHash]);
    if (some(orderId)) query.push(['orderId', orderId]);
    if (some(uopHash)) query.push(['uopHash', uopHash]);
    let data;
    try { data = await client.getAuthed('/priapi/v5/wallet/agentic/order/detail', accessToken, query); } catch (e) { throw formatApiError(e); }
    return filterDetailResponse(data);
  }

  const query = [['accountId', resolvedAccountId]];
  if (some(begin)) query.push(['begin', begin]);
  if (some(end)) query.push(['end', end]);
  if (some(cursor)) query.push(['cursor', cursor]);
  if (some(limit)) query.push(['limit', limit]);
  if (chainIndex !== '') query.push(['chainIndex', chainIndex]);
  let data;
  try { data = await client.getAuthed('/priapi/v5/wallet/agentic/order/list', accessToken, query); } catch (e) { throw formatApiError(e); }
  return filterListResponse(data);
}
