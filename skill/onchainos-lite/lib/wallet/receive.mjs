// Read-only receive orchestration: current account, wallet-supported chains, token candidates,
// receive address and Common QR — upstream agentic_wallet/receive.rs. Returns the output data.
import { ApiClient } from '../core/http.mjs';
import { isEvmChain, chainDisplayName } from '../core/chains.mjs';
import { buildFundingBundleFromWallets } from '../core/funding.mjs';
import { buildQrOutput } from '../core/qr.mjs';
import { fetchSearch } from '../commands/token/token.mjs';
import { WalletApiClient } from './api.mjs';
import * as store from './store.mjs';
import { ensureTokensRefreshed } from './auth.mjs';
import { resolveActiveAccountId } from './account.mjs';
import { getAllChains } from './chain.mjs';
import { resolve as resolveChainProfile } from './chain-profile.mjs';
import { ERR_NOT_LOGGED_IN } from './common.mjs';
import { refreshWalletAccountsStrict } from './balance/index.mjs';
import { trim } from '../core/rs/str.mjs';
import { isI64, isU64, isObject, get } from '../core/rs/value.mjs';
import { rustPanic } from './utxo/_panic.mjs';

// upstream: receive.rs::RECEIVE_TOKEN_PAGE_LIMIT
export const RECEIVE_TOKEN_PAGE_LIMIT = '10';

const some = (v) => v !== undefined && v !== null;
// json!(QrOutput) — a serialised struct becomes a sorted-key Value.
const qrValue = (qr) => ({ ...qr });

// upstream: receive.rs::cmd_receive
export async function cmdReceive(chain, token, cursor) {
  if (some(chain) && !some(token)) {
    const profile = await resolveChainProfile(chain);
    const wallets = await loadCurrentWallets();
    return receiveAddressValue(fundingBundleFromLoadedWallets(wallets, profile.chainIndex), null);
  }
  if (!some(chain) && some(token)) {
    const query = trim(token);
    if (query === '') throw new Error('Parameter --token cannot be empty');
    const wallets = await loadCurrentWallets();
    const chains = await getAllChains();
    const searchChains = supportedChainIndices(chains);
    if (searchChains === '') throw new Error('wallet receive could not resolve the supported-chain search scope');
    const chainNames = supportedChainNames(chains);
    const client = await ApiClient.create();
    const raw = await fetchSearch(client, query, searchChains, RECEIVE_TOKEN_PAGE_LIMIT, some(cursor) ? cursor : undefined, undefined);
    const candidates = normalizeCandidates(raw, chainNames);
    if (!candidates.length) {
      return { phase: 'funding', decision: 'blocked', reason: 'token_not_found', nextAction: [], payload: { query } };
    }
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (typeof candidate.chainIndex !== 'string') throw new Error('token search result missing chainIndex');
      return receiveAddressValue(fundingBundleFromLoadedWallets(wallets, candidate.chainIndex), candidate);
    }
    return selectionValue(query, candidates);
  }
  if (!some(chain) && !some(token)) return genericReceiveValue(await loadCurrentWallets());
  // Only reachable through the global --chain (clap rejects --chain with --token at the leaf).
  return rustPanic('commands/agentic_wallet/receive.rs', 83, 31, 'internal error: entered unreachable code: clap rejects --chain with --token');
}

// upstream: receive.rs::funding_bundle_from_loaded_wallets → FundingBundle { target, qr }
export const fundingBundleFromLoadedWallets = (wallets, chainIndex) => buildFundingBundleFromWallets(wallets, chainIndex, undefined);

// upstream: receive.rs::load_current_wallets — always refresh account/address facts (a stale
// deposit address is a funds-loss risk).
export async function loadCurrentWallets() {
  const accessToken = await ensureTokensRefreshed();
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  await refreshWalletAccountsStrict(new WalletApiClient(), accessToken, wallets);
  return wallets;
}

// upstream: receive.rs::receive_address_value
export function receiveAddressValue(bundle, token) {
  const t = bundle.target;
  const payload = {
    accountName: t.accountName,
    chainIndex: t.chainIndex,
    chainName: t.chainName,
    receiveAddress: t.receiveAddress,
    sameNetworkRequired: t.sameNetworkRequired,
    gasFree: t.gasFree,
    qr: qrValue(bundle.qr),
  };
  if (token) {
    for (const key of ['tokenName', 'tokenSymbol', 'networkName', 'tokenContractAddress']) {
      payload[key] = isObject(token) && Object.prototype.hasOwnProperty.call(token, key) ? token[key] : null;
    }
  }
  return { phase: 'funding', decision: 'ready', reason: 'funding_target_ready', nextAction: [], payload };
}

// upstream: receive.rs::generic_receive_value — every address family of the current account,
// with a QR for the EVM address only.
export function genericReceiveValue(wallets) {
  const accountId = resolveActiveAccountId(wallets);
  if (!Object.prototype.hasOwnProperty.call(wallets.accountsMap, accountId)) throw new Error('account not found');
  const list = wallets.accountsMap[accountId].addressList;
  const acct = wallets.accounts.find((a) => a.accountId === accountId);
  const accountName = acct ? acct.accountName : '';
  const findExact = (indices) => list.find((a) => indices.includes(a.chainIndex) && a.address !== '')?.address ?? null;
  const evm = list.find((a) => a.chainIndex !== '196' && isEvmReceiveAddress(a.chainIndex) && a.address !== '')
    ?? list.find((a) => a.chainIndex === '196' && a.address !== '');
  const evmAddress = evm ? evm.address : null;
  const x = findExact(['196']);
  const xLayerAddress = x !== null && x !== evmAddress ? x : null;
  return {
    phase: 'funding',
    decision: 'ready',
    reason: 'receive_addresses_ready',
    nextAction: [
      { id: 'specify_funding_chain', recommend: true, params: {} },
      { id: 'search_receive_token', recommend: false, params: {} },
    ],
    payload: {
      accountName,
      evmAddress,
      evmQr: evmAddress === null ? null : qrValue(buildQrOutput(evmAddress, null)),
      xLayerAddress,
      solanaAddress: findExact(['501']),
      bitcoinAddress: findExact(['0', '5']),
      suiAddress: findExact(['784']),
    },
  };
}

// upstream: receive.rs::is_evm_receive_address
export const isEvmReceiveAddress = (chainIndex) => isEvmChain(chainIndex);

// upstream: receive.rs::value_as_string — string, i64 or u64 rendered; else undefined.
export function valueAsString(value) {
  if (typeof value === 'string') return value;
  if (isI64(value) || isU64(value)) return String(value);
  return undefined;
}

// upstream: receive.rs::supported_chain_indices — distinct non-empty chainIndex values, in order.
export function supportedChainIndices(chains) {
  const seen = new Set();
  const out = [];
  for (const chain of chains) {
    const index = valueAsString(get(chain, 'chainIndex'));
    if (index === undefined || index === '' || seen.has(index)) continue;
    seen.add(index);
    out.push(index);
  }
  return out.join(',');
}

// upstream: receive.rs::supported_chain_names — chainIndex → showName (else chainName); later
// entries overwrite earlier ones (HashMap collect).
export function supportedChainNames(chains) {
  const names = new Map();
  for (const chain of chains) {
    const index = valueAsString(get(chain, 'chainIndex'));
    if (index === undefined) continue;
    let name;
    for (const key of ['showName', 'chainName']) {
      const v = get(chain, key);
      if (typeof v === 'string') { name = v; break; }
    }
    if (name === undefined || name === '') continue;
    names.set(index, name);
  }
  return names;
}

// upstream: receive.rs::normalize_candidates — first 10 raw items; entries without a non-empty
// chainIndex are skipped (sequence stays the raw 1-based position).
export function normalizeCandidates(raw, chainNames) {
  let list = Array.isArray(raw) ? raw : undefined;
  if (list === undefined && Array.isArray(get(raw, 'list'))) list = get(raw, 'list');
  if (list === undefined && Array.isArray(get(raw, 'items'))) list = get(raw, 'items');
  const out = [];
  (list ?? []).slice(0, 10).forEach((candidate, index) => {
    const chainIndex = valueAsString(get(candidate, 'chainIndex'));
    if (chainIndex === undefined || chainIndex === '') return;
    const contract = get(candidate, 'tokenContractAddress');
    const field = (k) => (isObject(candidate) && Object.prototype.hasOwnProperty.call(candidate, k) ? candidate[k] : null);
    out.push({
      sequence: index + 1,
      tokenName: field('tokenName'),
      tokenSymbol: field('tokenSymbol'),
      chainIndex,
      networkName: chainNames.get(chainIndex) ?? chainDisplayName(chainIndex),
      tokenContractAddress: typeof contract === 'string' ? contract : '',
      cursor: field('cursor'),
    });
  });
  return out;
}

// upstream: receive.rs::selection_value
export function selectionValue(query, candidates) {
  let nextCursor = null;
  if (candidates.length === 10) {
    const c = valueAsString(get(candidates[candidates.length - 1], 'cursor'));
    if (c !== undefined && c !== '') nextCursor = c;
  }
  const actions = candidates.map((c) => ({
    id: 'select_receive_token',
    recommend: false,
    params: { sequence: c.sequence, chainIndex: c.chainIndex, tokenContractAddress: c.tokenContractAddress },
  }));
  if (nextCursor !== null) actions.push({ id: 'more_receive_tokens', recommend: false, params: { query, cursor: nextCursor } });
  return {
    phase: 'funding',
    decision: 'requires_user_input',
    reason: 'token_selection_required',
    nextAction: actions,
    payload: { query, list: candidates, pagination: { limit: 10, nextCursor } },
  };
}
