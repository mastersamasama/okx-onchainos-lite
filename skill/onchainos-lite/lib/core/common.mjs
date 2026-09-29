// Shared DEX helpers — upstream commands/common.rs: on-chain tx waiting used by
// swap / cross-chain (approve → wait → swap).
import { sleep } from './proc.mjs';
import { eqIgnoreAsciiCase } from './rs/str.mjs';

const TX_DETAIL_PATH = '/api/v6/dex/post-transaction/transaction-detail-by-txhash';
const POLL_INTERVAL_MS = 1000;

// upstream: common.rs::tx_confirmation_timeout — per-chain confirmation timeout, in milliseconds
// (Rust Duration): ETH (1) / Linea (59144) → 20 s, every other chain → 10 s.
export function txConfirmationTimeout(chainIndex) {
  switch (String(chainIndex)) {
    case '1':
    case '59144':
      return 20000;
    default:
      return 10000;
  }
}

// upstream: common.rs::unwrap_api_array — first element of an array (null when empty), else as-is.
const unwrapApiArray = (data) => (Array.isArray(data) ? (data.length ? data[0] : null) : data);

// upstream: common.rs::wait_tx_onchain — poll the public tx-detail endpoint (full ApiClient.get
// semantics) until txStatus is "success" (resolve) or "fail" (throw), or the per-chain timeout
// elapses (throw). Request errors are ignored; the deadline is checked after every attempt.
export async function waitTxOnchain(client, txHash, chainIndex) {
  const timeout = txConfirmationTimeout(chainIndex);
  const deadline = performance.now() + timeout;
  for (;;) {
    let data;
    let ok = true;
    try {
      data = await client.get(TX_DETAIL_PATH, [['chainIndex', chainIndex], ['txHash', txHash]]);
    } catch {
      ok = false;
    }
    if (ok) {
      const detail = unwrapApiArray(data);
      const s = detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? detail.txStatus : undefined;
      const status = typeof s === 'string' ? s : '';
      if (eqIgnoreAsciiCase(status, 'success')) return;
      if (eqIgnoreAsciiCase(status, 'fail')) throw new Error(`tx ${txHash} failed on-chain (chain=${chainIndex})`);
    }
    if (performance.now() >= deadline) {
      throw new Error(`tx ${txHash} not confirmed on-chain within ${timeout / 1000}s (chain=${chainIndex})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
