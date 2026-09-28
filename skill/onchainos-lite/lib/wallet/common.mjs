// Shared agentic-wallet helpers and the confirm-then-`--force` protocol — upstream
// agentic_wallet/common.rs.
//
// Protocol: a handler that needs explicit user approval for a write (and was not given
// --force) throws WalletPreviewConfirming({ message, next, scene, preview }); main prints
//   {"confirming":true,"scene":…,"message":…,"preview":…,"next":…}   (exit 2)
// where `next` is the same command with --force appended. Backend code 81362 ("needs user
// confirmation") maps to a plain Confirming via handleConfirmingError.
import { WalletPreviewConfirming, Confirming } from '../core/errors.mjs';
import { ApiCodeError } from './api.mjs';

// upstream: common.rs::ERR_NOT_LOGGED_IN
export const ERR_NOT_LOGGED_IN = 'not logged in';

// upstream: common.rs::WalletPreviewConfirming — the error class lives in core/errors.mjs
// (main.rs downcasts it); re-exported here under its upstream module.
export { WalletPreviewConfirming };

// Build the confirming error with the upstream field set (message, next, scene, preview: Value).
export const walletPreviewConfirming = ({ message, next, scene, preview }) => new WalletPreviewConfirming({ message, next, scene, preview });

// upstream: common.rs::mask_email — keep first/last char of the local part, full domain.
export function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const chars = [...email.slice(0, at)];
  const domain = email.slice(at);
  if (chars.length === 0) return `***${domain}`;
  if (chars.length <= 2) return `${chars[0]}***${domain}`;
  return `${chars[0]}***${chars[chars.length - 1]}${domain}`;
}

// upstream: common.rs::is_hex_string — ^0x[0-9A-Fa-f]*$, plus exact byte length when length > 0.
export function isHexString(value, length) {
  if (!value.startsWith('0x') || !/^[0-9A-Fa-f]*$/.test(value.slice(2))) return false;
  if (length !== undefined && length !== null && length > 0) return value.length === 2 + 2 * length;
  return true;
}

export const CONFIRM_WITH_FORCE_NEXT = 'If the user confirms, re-run the same command with --force flag appended to proceed.';

// upstream: common.rs::handle_confirming_error — ApiCodeError 81362 && !force → Confirming
// (exit 2); any other ApiCodeError keeps `Wallet API error (code=N): msg`; others pass through.
export function handleConfirmingError(e, force) {
  if (e instanceof ApiCodeError) {
    if (!force && e.code === '81362') return new Confirming({ message: e.msg, next: CONFIRM_WITH_FORCE_NEXT });
    return e;
  }
  return e;
}
