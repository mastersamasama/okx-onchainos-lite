// Polymarket geoblock probe — upstream agentic_wallet/geoblock.rs.
import { WalletApiClient } from './api.mjs';

const PATH = '/priapi/v5/wallet/agentic/geoblock/check';

// upstream: geoblock.rs::cmd_check — header-less GET; prints a bare {"blocked":bool} line
// (no envelope, never pretty-printed). Returns the boolean after printing.
export async function cmdCheck() {
  const data = await new WalletApiClient().getNoOkheaders(PATH);
  const item = Array.isArray(data) ? data[0] : undefined;
  const blocked = item !== null && typeof item === 'object' && !Array.isArray(item) ? item.blocked : undefined;
  if (typeof blocked !== 'boolean') throw new Error('malformed response: missing data[0].blocked');
  process.stdout.write(`{"blocked":${blocked}}\n`);
  return blocked;
}
