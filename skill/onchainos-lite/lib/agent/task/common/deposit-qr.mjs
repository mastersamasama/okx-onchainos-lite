// Deposit-address QR enrichment for insufficient-balance errors — upstream
// task/common/deposit_qr.rs.
import { InsufficientBalance } from '../../../core/errors.mjs';
import { resolveChain } from '../../../core/chains.mjs';
import { renderAddressQrUnicode } from '../../../core/qr.mjs';
import { displayF64, trim } from '../../_rs.mjs';

const DEPOSIT_CHAIN_LABEL = 'XLayer';
const MIN_QR_COLUMNS = 33;
// upstream: deposit_qr.rs::SCAN_TO_DEPOSIT_OPTION
export const SCAN_TO_DEPOSIT_OPTION = 'Scan code and recharge directly for your wallet';
// upstream: deposit_qr.rs::DEPOSIT_QR_MARKER
export const DEPOSIT_QR_MARKER = '{{DEPOSIT_QR}}';

// upstream: deposit_qr.rs::fill_qr_marker
export const fillQrMarker = (message, _address) => String(message).split(`${DEPOSIT_QR_MARKER}\n`).join('').split(DEPOSIT_QR_MARKER).join('');

// upstream: deposit_qr.rs::InsufficientBalanceError — Display = message; caught by core main.mjs
// (`InsufficientBalance`) and printed as the special insufficient-balance envelope.
export class InsufficientBalanceError extends InsufficientBalance {
  // upstream: InsufficientBalanceError::new(message, currency, required: f64, available: f64)
  constructor(message, currency, required, available) {
    const shortfall = Math.max(required - available, 0);
    super({ message, currency, shortfall: displayF64(shortfall), depositChain: DEPOSIT_CHAIN_LABEL, depositAddress: undefined });
    this.required = displayF64(required);
    this.available = displayF64(available);
    this.chainIndex = resolveChain('xlayer');
    this.depositChain = DEPOSIT_CHAIN_LABEL;
    this.depositAddress = undefined;
  }
  clone() {
    const c = Object.create(InsufficientBalanceError.prototype);
    Object.assign(c, this);
    c.message = this.message;
    c.stack = this.stack;
    return c;
  }
}

// upstream: deposit_qr.rs::deposit_info_for_address
export const depositInfoForAddress = (address) => ({ address, depositChain: DEPOSIT_CHAIN_LABEL, chainIndex: resolveChain('xlayer') });

// upstream: deposit_qr.rs::resolve_current_deposit_info → info | undefined
export async function resolveCurrentDepositInfo(agentId) {
  const { resolveWalletByAgentId } = await import('../signing.mjs');
  try {
    const [, address] = await resolveWalletByAgentId(agentId);
    return address !== '' ? depositInfoForAddress(address) : undefined;
  } catch { return undefined; }
}

const detectedColumns = () => {
  const v = process.env.COLUMNS;
  if (v === undefined) return undefined;
  const t = trim(v);
  return /^\+?[0-9]+$/.test(t) ? Number(t) : undefined;
};
const addressHint = (info, currency, shortfall) => `Deposit ${currency} to this ${info.depositChain} address (short ${shortfall}):\n${info.address}`;

// upstream: deposit_qr.rs::maybe_render_qr_stderr — only when stderr is a TTY.
export function maybeRenderQrStderr(info, currency, shortfall) {
  if (!process.stderr.isTTY) return;
  const cols = detectedColumns();
  if (cols !== undefined && cols < MIN_QR_COLUMNS) { process.stderr.write(addressHint(info, currency, shortfall) + '\n'); return; }
  process.stderr.write(`1. ${SCAN_TO_DEPOSIT_OPTION}\n`);
  try { process.stderr.write(renderAddressQrUnicode(info.address) + '\n'); } catch {}
  process.stderr.write(addressHint(info, currency, shortfall) + '\n');
}

// anyhow `downcast_ref` walks the context chain: find the InsufficientBalanceError in `cause`s.
function findIb(err) { let e = err; while (e && !(e instanceof InsufficientBalanceError)) e = e.cause; return e; }

// upstream: deposit_qr.rs::enrich_blocking
export async function enrichBlocking(err, agentId) {
  const ib = findIb(err);
  if (!ib) return err;
  const enriched = ib.clone();
  enriched.message = err.message;
  const info = await resolveCurrentDepositInfo(agentId);
  if (info) {
    enriched.depositAddress = info.address;
    enriched.message = fillQrMarker(enriched.message, info.address);
    maybeRenderQrStderr(info, enriched.currency, enriched.shortfall);
  } else {
    enriched.message = fillQrMarker(enriched.message, undefined);
  }
  return enriched;
}

// upstream: deposit_qr.rs::enrich_blocking_at
export function enrichBlockingAt(err, address) {
  const ib = findIb(err);
  if (!ib) return err;
  const enriched = ib.clone();
  enriched.depositAddress = address;
  enriched.message = fillQrMarker(err.message, address);
  maybeRenderQrStderr(depositInfoForAddress(address), enriched.currency, enriched.shortfall);
  return enriched;
}

// upstream: deposit_qr.rs::balance_warning_base (json! → sorted keys)
export function balanceWarningBase(err) {
  return { sufficient: false, chain: err.depositChain, chainIndex: err.chainIndex, currency: err.currency, required: err.required, available: err.available, shortfall: err.shortfall };
}

// upstream: deposit_qr.rs::balance_warning_json → [warning, message]
export async function balanceWarningJson(err, agentId) {
  const info = await resolveCurrentDepositInfo(agentId);
  if (info) {
    const obj = { ...balanceWarningBase(err), depositAddress: info.address, depositChain: info.depositChain };
    maybeRenderQrStderr(info, err.currency, err.shortfall);
    return [obj, fillQrMarker(err.message, info.address)];
  }
  return [balanceWarningBase(err), fillQrMarker(err.message, undefined)];
}
