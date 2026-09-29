// Wallet-session loader: HPKE-decrypt the signing seed + resolve the active accountId and its
// addresses — upstream commands/agentic_wallet/strategy/session.rs. Local only (no HTTP); call
// after ctx.api() (which refreshes the JWT), exactly like upstream.
import * as keyring from '../../core/keyring.mjs';
import { loadSession, loadWallets } from '../store.mjs';
import { resolveActiveAccountId } from '../account.mjs';
import { ERR_NOT_LOGGED_IN } from '../common.mjs';
import { hpkeDecryptSessionSk } from '../../core/crypto.mjs';

// upstream: session.rs::WalletSession
export class WalletSession {
  constructor({ accountId, sessionCert, saTeeId, seedB64, evmAddress, solAddress }) {
    Object.assign(this, { accountId, sessionCert, saTeeId, seedB64, evmAddress, solAddress });
  }

  // upstream: session.rs::WalletSession::wallet_address_for — Solana → SOL address, else EVM.
  walletAddressFor(chainId) {
    return chainId === '501' || chainId === 'solana' ? this.solAddress : this.evmAddress;
  }
}

// upstream: session.rs::load
export function load() {
  const session = loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  let sessionKey;
  try { sessionKey = keyring.get('session_key'); } catch { sessionKey = undefined; }
  if (typeof sessionKey !== 'string') throw new Error(ERR_NOT_LOGGED_IN);
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);
  const seedB64 = Buffer.from(seed).toString('base64');
  seed.fill(0);

  const wallets = loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const accountId = resolveActiveAccountId(wallets);
  if (!Object.prototype.hasOwnProperty.call(wallets.accountsMap, accountId)) {
    throw new Error('active account not found in wallets map');
  }
  const list = wallets.accountsMap[accountId].addressList;
  const evmAddress = list.find((a) => a.chainIndex !== '501')?.address ?? '';
  const solAddress = list.find((a) => a.chainIndex === '501')?.address ?? '';
  return new WalletSession({
    accountId, sessionCert: session.sessionCert, saTeeId: session.saTeeId, seedB64, evmAddress, solAddress,
  });
}
