// Account selection, status and address listing — upstream agentic_wallet/account.rs.
import * as keyring from '../core/keyring.mjs';
import { isEvmChain } from '../core/chains.mjs';
import { EMPTY } from '../core/context.mjs';
import { WalletApiClient } from './api.mjs';
import * as store from './store.mjs';
import { ensureTokensRefreshed, isSessionKeyExpired, isTokenExpired } from './auth.mjs';
import { ERR_NOT_LOGGED_IN } from './common.mjs';
import { resolve as resolveChainProfile } from './chain-profile.mjs';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// upstream: account.rs::switch_to_account
export function switchToAccount(accountId) {
  if (accountId === '') throw new Error('account id is required');
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  if (!has(wallets.accountsMap, accountId)) throw new Error('account not found');
  wallets.selectedAccountId = accountId;
  store.saveWallets(wallets);
}

// upstream: account.rs::cmd_switch → {"ok":true}
export function cmdSwitch(accountId) {
  switchToAccount(accountId);
  return EMPTY;
}

// upstream: account.rs::build_wallet_status_summary (json! → sorted keys)
export function buildWalletStatusSummary(wallets, loggedIn, currentAccountName, policy) {
  const loginType = !loggedIn || wallets.loginType === '' ? null : wallets.loginType;
  return {
    email: wallets.email, loggedIn, loginType, currentAccountId: wallets.selectedAccountId,
    currentAccountName, accountCount: wallets.accounts.length, policy,
  };
}

// upstream: account.rs::cmd_status
export async function cmdStatus() {
  const wallets = store.loadWallets();
  if (!wallets) return { email: '', loggedIn: false, currentAccountId: '', currentAccountName: '', accountCount: 0 };
  const session = store.loadSession() ?? store.sessionJson();
  // read_blob propagates corruption ("Credentials corrupted…") instead of reporting loggedIn:false
  const blob = keyring.readBlob();
  const rt = blob.refresh_token;
  const loggedIn = !isSessionKeyExpired(session.sessionKeyExpireAt) && typeof rt === 'string' && rt !== '' && !isTokenExpired(rt);
  const current = wallets.accounts.find((a) => a.accountId === wallets.selectedAccountId);
  const currentAccountName = current ? current.accountName : '';
  let policy = null;
  if (loggedIn && wallets.selectedAccountId !== '') {
    try { policy = await queryPolicy(wallets.selectedAccountId); } catch { policy = null; }
  }
  return buildWalletStatusSummary(wallets, loggedIn, currentAccountName, policy);
}

// cmd_addresses `match addr.chain_index.as_str()` arms (anything else → evm)
const BUCKETS = new Map([['0', 'bitcoin'], ['784', 'sui'], ['196', 'xlayer'], ['501', 'solana']]);

// upstream: account.rs::cmd_addresses — current account's addresses bucketed by chain family.
export async function cmdAddresses(chain) {
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const accountId = resolveActiveAccountId(wallets);
  if (!has(wallets.accountsMap, accountId)) throw new Error('account not found');
  const entry = wallets.accountsMap[accountId];
  const acct = wallets.accounts.find((a) => a.accountId === accountId);
  const accountName = acct ? acct.accountName : '';
  const chainFilter = chain !== undefined && chain !== null ? (await resolveChainProfile(chain)).chainIndex : null;
  const buckets = { xlayer: [], evm: [], solana: [], bitcoin: [], sui: [] };
  for (const addr of entry.addressList) {
    if (chainFilter !== null && addr.chainIndex !== chainFilter) continue;
    const item = { address: addr.address, chainIndex: addr.chainIndex, chainName: addr.chainName };
    const bucket = BUCKETS.get(addr.chainIndex) ?? 'evm';
    buckets[bucket].push(item);
  }
  return { accountId, accountName, ...buckets };
}

// upstream: account.rs::query_policy — GET policy/query → data[0] | null
export async function queryPolicy(accountId) {
  const accessToken = await ensureTokensRefreshed();
  const data = await new WalletApiClient().getAuthed('/priapi/v5/wallet/agentic/policy/query', accessToken, [['accountId', accountId]]);
  return Array.isArray(data) && data.length ? data[0] : null;
}

// upstream: account.rs::resolve_active_account_id — selected → isDefault → first accountsMap key.
export function resolveActiveAccountId(wallets) {
  if (wallets.selectedAccountId !== '') return wallets.selectedAccountId;
  const def = wallets.accounts.find((a) => a.isDefault);
  if (def) return def.accountId;
  const firstKey = Object.keys(wallets.accountsMap)[0];
  if (firstKey === undefined) throw new Error('no wallet accounts found');
  return firstKey;
}

// upstream: account.rs::shares_evm_address
export const sharesEvmAddress = (chainIndex) => isEvmChain(chainIndex);

// upstream: account.rs::resolve_account_address_for_chain — exact chain match, else the shared
// EVM address for EVM-family chains; never falls back for BTC/Tron/TON/unknown chains.
export function resolveAccountAddressForChain(wallets, chainIndex) {
  const accountId = resolveActiveAccountId(wallets);
  if (!has(wallets.accountsMap, accountId)) throw new Error('account not found');
  const list = wallets.accountsMap[accountId].addressList;
  const exact = list.find((a) => a.chainIndex === chainIndex && a.address !== '');
  if (exact) return exact.address;
  if (sharesEvmAddress(chainIndex)) {
    const evm = list.find((a) => sharesEvmAddress(a.chainIndex) && a.address !== '');
    if (evm) return evm.address;
  }
  throw new Error(`no address for chain "${chainIndex}" on the selected account`);
}
