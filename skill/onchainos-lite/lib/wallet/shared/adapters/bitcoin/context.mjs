// Authenticated Bitcoin account context — upstream agentic_wallet/shared/adapters/bitcoin/context.rs.
import { TransferDriver } from '../../../chain-profile.mjs';
import { loadChainContext } from '../../common/context.mjs';
import { sessionCert, SigningSeed } from '../../common/session.mjs';
import { validateWalletAddress, sameAddress } from './validation.mjs';
import { parseU64 } from '../../../../core/rs/num.mjs';

// upstream: context.rs::BtcContext { accessToken, accountId, loginType, profile, address }
export class BtcContext {
  constructor({ accessToken, accountId, loginType, profile, address }) {
    Object.assign(this, { accessToken, accountId, loginType, profile, address });
  }

  // upstream: context.rs::BtcContext::load
  static async load(from) {
    return new BtcContext(await loadChainContext('bitcoin', TransferDriver.Bitcoin, 'Bitcoin', from, validateWalletAddress, sameAddress));
  }

  // upstream: context.rs::BtcContext::chain_index_u64 → JSON integer
  chainIndexU64() {
    const v = parseU64(this.profile.chainIndex);
    if (v === undefined) throw new Error(`Bitcoin runtime chainIndex '${this.profile.chainIndex}' is not numeric`);
    return v;
  }

  // upstream: context.rs::BtcContext::session_cert
  sessionCert() { return sessionCert(); }

  // upstream: context.rs::BtcContext::signing_seed
  signingSeed() { return SigningSeed.load(); }

  // upstream: context.rs::BtcContext::social_wallet_type
  socialWalletType() { return ['email', 'google', 'apple'].includes(this.loginType) ? '12' : undefined; }
}
