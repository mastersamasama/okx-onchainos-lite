// Trader Mode (SA / SD-A) primitives: intent build/sign, SD-A activation and the 60018
// retry-once rule — upstream commands/agentic_wallet/strategy/trader_mode.rs.
import { trim } from '../../core/rs/str.mjs';
import { ed25519SignHex, ed25519SignEip191 } from '../../core/crypto.mjs';
import * as api from './api.mjs';
import { isUpgradeRequired } from './status.mjs';
import { isSolana } from './supported-chains.mjs';
import { registerTeeInfoReq } from './types.mjs';

// upstream: trader_mode.rs::STRATEGY_TYPE_NAME_PHASE_1
export const STRATEGY_TYPE_NAME_PHASE_1 = 'LimitOrderUbased';
const INTENT_HEADER = 'You will place an order which will be verified and auto-signed by the trusted execution environment.';

// upstream: trader_mode.rs::build_intent — byte-stable signMsg (LF-separated, no trailing newline).
export function buildIntent({ chainId, recipient, fromToken, toToken, fromAmountRaw, createdAt, expiredAt, timestampMs }) {
  return `${INTENT_HEADER}\n\nChain Index: ${chainId}\n`
    + `Strategy Type: ${STRATEGY_TYPE_NAME_PHASE_1}\n`
    + `Recipient: ${recipient}\n`
    + `Created At: ${createdAt}\n`
    + `Expired At: ${expiredAt}\n`
    + `From Token: ${fromToken}\n`
    + `To Token: ${toToken}\n`
    + `From Amount(precision adjusted): ${fromAmountRaw}\n`
    + `Timestamp: ${timestampMs}`;
}

// upstream: trader_mode.rs::human_decimal_to_raw_integer — human decimal → raw integer string;
// rejects non-numeric input, several dots, excess fractional digits and zero results.
export function humanDecimalToRawInteger(amount, decimals) {
  const t = trim(amount);
  if (t === '') throw new Error('amount is empty');
  if (!/^[0-9.]*$/.test(t)) throw new Error(`amount must be a positive decimal number, got \`${t}\``);
  if ((t.match(/\./g) || []).length > 1) throw new Error(`amount has multiple decimal points, got \`${t}\``);
  const dot = t.indexOf('.');
  const [integerPart, fractionalPart] = dot >= 0 ? [t.slice(0, dot), t.slice(dot + 1)] : [t, ''];
  if (fractionalPart.length > decimals) {
    throw new Error(`amount \`${t}\` has ${fractionalPart.length} fractional digit(s), more than the token's ${decimals} decimals`);
  }
  const buf = integerPart + fractionalPart + '0'.repeat(decimals - fractionalPart.length);
  const stripped = buf.replace(/^0+/, '');
  if (stripped === '') throw new Error(`amount must be > 0, got \`${t}\``);
  return stripped;
}

// upstream: trader_mode.rs::sign_intent — Solana: Ed25519 over the raw intent bytes; other chains:
// Ed25519 over keccak256(EIP-191 prefix + intent). Returns base64.
export function signIntent(intent, chain, sessionSeedB64) {
  if (isSolana(chain)) {
    const hexMsg = Buffer.from(intent, 'utf8').toString('hex');
    try { return ed25519SignHex(hexMsg, sessionSeedB64); } catch (e) { throw new Error(`ed25519 sign failed: ${e.message}`); }
  }
  const seedBytes = Buffer.from(sessionSeedB64, 'base64');
  try { return ed25519SignEip191(intent, seedBytes, 'utf8'); } catch (e) { throw new Error(`eip191 sign failed: ${e.message}`); }
}

// upstream: trader_mode.rs::ActivateCtx
export const activateCtx = ({ accountId, sessionCert, sessionSeedB64, expireMsFromNow }) =>
  ({ accountId, sessionCert, sessionSeedB64, expireMsFromNow });

// upstream: trader_mode.rs::activate — SD-A: getAttestDocHex → Ed25519-sign it → registerTeeInfo,
// then prints `Trader Mode activated.` (plain text on stdout, before the command's JSON line).
export async function activate(client, actx) {
  const attestDocHex = await api.requestAttestDocHexFromSa(client);
  const sig = ed25519SignHex(attestDocHex, actx.sessionSeedB64);
  const nowMs = Date.now();
  const req = registerTeeInfoReq({
    accountId: actx.accountId, timestamp: nowMs, expireTimestamp: nowMs + actx.expireMsFromNow,
    attestDocHex, sessionCert: actx.sessionCert, sessionSig: sig,
  });
  await api.registerTeeInfo(client, req);
  process.stdout.write('Trader Mode activated.\n');
}

// upstream: trader_mode.rs::retry_on_upgrade — run `op`; on UpgradeRequired run `activateFn`
// (its error aborts) and `op` once more; the second result is returned as-is.
export async function retryOnUpgrade(op, activateFn) {
  try {
    return await op();
  } catch (e) {
    if (!isUpgradeRequired(e)) throw e;
    await activateFn();
    return op();
  }
}
