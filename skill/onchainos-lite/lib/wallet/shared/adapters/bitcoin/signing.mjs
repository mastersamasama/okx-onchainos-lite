// Bitcoin `unsignedHashList` signing — upstream agentic_wallet/shared/adapters/bitcoin/signing.rs.
import { signUnsignedHashes as signList, SigningProfile } from '../../common/unsigned-hash-list.mjs';

// upstream: signing.rs::sign_unsigned_hashes
export const signUnsignedHashes = (response, seed) => signList(response, seed, SigningProfile.Bitcoin);
