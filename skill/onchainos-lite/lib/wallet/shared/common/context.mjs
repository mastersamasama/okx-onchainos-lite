// Chain command context loader — upstream agentic_wallet/shared/common/context.rs.
import { WalletApiClient } from '../../api.mjs';
import * as store from '../../store.mjs';
import { ensureTokensRefreshed } from '../../auth.mjs';
import { resolveActiveAccountId } from '../../account.mjs';
import { resolve as resolveChainProfile } from '../../chain-profile.mjs';
import { ERR_NOT_LOGGED_IN } from '../../common.mjs';
import { ensureWalletAccountsFresh } from '../_balance.mjs';

// upstream: context.rs::LoadedChainContext
// → { accessToken, accountId, loginType, profile: ResolvedChainProfile, address: AddressInfo }

// upstream: context.rs::load_chain_context — auth, chain profile, account and its single
// address for the chain (one forced account refresh + retry when the selection fails).
export async function loadChainContext(resolverInput, expectedDriver, chainLabel, from, validateAddress, sameAddress) {
  const accessToken = await ensureTokensRefreshed();
  const profile = await resolveChainProfile(resolverInput);
  if (profile.capabilities.transfer !== expectedDriver) throw new Error(`${resolverInput} profile resolved to a non-${chainLabel} chain`);
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const accountId = resolveActiveAccountId(wallets);
  const select = () => selectCurrentAddress(wallets, accountId, profile, chainLabel, from, sameAddress);
  let address;
  try {
    address = select();
  } catch {
    await ensureWalletAccountsFresh(new WalletApiClient(), accessToken, wallets, true);
    address = select();
  }
  validateAddress(address.address);
  return { accessToken, accountId, loginType: wallets.loginType, profile, address };
}

// upstream: context.rs::select_current_address — exactly one address of the account on the
// profile's chainIndex; an explicit `from` must be that same address.
export function selectCurrentAddress(wallets, accountId, profile, chainLabel, from, sameAddress) {
  if (!Object.prototype.hasOwnProperty.call(wallets.accountsMap, accountId)) throw new Error(`current account '${accountId}' was not found`);
  const candidates = wallets.accountsMap[accountId].addressList.filter((a) => a.chainIndex === profile.chainIndex);
  if (candidates.length === 0) throw new Error(`current account '${accountId}' has no ${chainLabel} address`);
  if (candidates.length !== 1) throw new Error(`current account '${accountId}' has multiple ${chainLabel} addresses`);
  const selected = candidates[0];
  if (from !== undefined && from !== null && !sameAddress(from, selected.address)) {
    throw new Error(`--from must be the ${chainLabel} address of the current account`);
  }
  return { ...selected };
}
