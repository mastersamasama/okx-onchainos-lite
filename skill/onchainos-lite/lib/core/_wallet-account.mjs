// PRIVATE FALLBACK — used by core/funding.mjs only until lib/wallet/account.mjs (owned by the
// wallet foundation) is available. Faithful port of the two pure resolvers funding needs,
// operating on the parsed wallets.json object (WalletsJson, camelCase keys, serde defaults).
// Requested for promotion: funding.mjs switches to lib/wallet/account.mjs automatically
// whenever that module loads.
import { isEvmChain } from './chains.mjs';

const str = (v) => (typeof v === 'string' ? v : '');
const accountsOf = (w) => (Array.isArray(w?.accounts) ? w.accounts : []);
const accountsMapOf = (w) => (w?.accountsMap && typeof w.accountsMap === 'object' ? w.accountsMap : {});

// upstream: agentic_wallet/account.rs::resolve_active_account_id — selected → is_default → first key.
export function resolveActiveAccountId(wallets) {
  const selected = str(wallets?.selectedAccountId);
  if (selected !== '') return selected;
  const def = accountsOf(wallets).find((a) => a?.isDefault === true);
  if (def) return str(def.accountId);
  const first = Object.keys(accountsMapOf(wallets))[0];
  if (first === undefined) throw new Error('no wallet accounts found');
  return first;
}

// upstream: agentic_wallet/account.rs::resolve_account_address_for_chain — the selected
// account's own address: exact chain match, else the shared EVM address for EVM chains.
export function resolveAccountAddressForChain(wallets, chainIndex) {
  const accountId = resolveActiveAccountId(wallets);
  const map = accountsMapOf(wallets);
  if (!Object.prototype.hasOwnProperty.call(map, accountId)) throw new Error('account not found');
  const list = Array.isArray(map[accountId]?.addressList) ? map[accountId].addressList : [];
  const exact = list.find((a) => str(a?.chainIndex) === chainIndex && str(a?.address) !== '');
  if (exact) return exact.address;
  if (isEvmChain(chainIndex)) {
    const evm = list.find((a) => isEvmChain(str(a?.chainIndex)) && str(a?.address) !== '');
    if (evm) return evm.address;
  }
  throw new Error(`no address for chain "${chainIndex}" on the selected account`);
}
