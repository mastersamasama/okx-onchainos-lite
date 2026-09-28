// Authenticated SUI account context — upstream agentic_wallet/shared/adapters/sui/context.rs.
import { TransferDriver } from '../../../chain-profile.mjs';
import { loadChainContext } from '../../common/context.mjs';
import { sessionCert, SigningSeed } from '../../common/session.mjs';
import { normalizeAddress, sameAddress } from './identifiers.mjs';
import { parseU64, u64Json } from '../../_rust.mjs';

// upstream: context.rs::validate_sui_address
const validateSuiAddress = (value) => { normalizeAddress(value); };

// upstream: context.rs::SuiContext { accessToken, accountId, profile, address }
export class SuiContext {
  constructor({ accessToken, accountId, profile, address }) {
    Object.assign(this, { accessToken, accountId, profile, address });
  }

  // upstream: context.rs::SuiContext::load
  static async load(from) {
    return new SuiContext(await loadChainContext('sui', TransferDriver.Sui, 'SUI', from, validateSuiAddress, sameAddress));
  }

  // upstream: context.rs::SuiContext::chain_index_u64 → JSON integer
  chainIndexU64() {
    const v = parseU64(this.profile.chainIndex);
    if (v === undefined) throw new Error(`SUI runtime chainIndex '${this.profile.chainIndex}' is not numeric`);
    return u64Json(v);
  }

  // upstream: context.rs::SuiContext::session_cert
  sessionCert() { return sessionCert(); }

  // upstream: context.rs::SuiContext::signing_seed
  signingSeed() { return SigningSeed.load(); }
}
