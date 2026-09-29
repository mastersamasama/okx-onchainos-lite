// Generic task-system helpers — upstream task/common/util.rs.
import { CodedError } from '../../../core/errors.mjs';
import { ApiClient } from '../../../core/http.mjs';
import { parse as parseJson, displayF64 } from '../../../core/json.mjs';
import { selfOutput, utf8Lossy } from '../../_proc.mjs';
import { at, asStr, asArray, asI64, asU64, asF64 } from '../../../core/rs/value.mjs';
import { utcRfc3339 } from '../../../core/rs/time.mjs';
import { byteLen, isControl, trim, splitWhitespace } from '../../../core/rs/str.mjs';
import { exitStatusText } from '../../../core/rs/process.mjs';
import { InsufficientBalanceError, DEPOSIT_QR_MARKER, SCAN_TO_DEPOSIT_OPTION } from './deposit-qr.mjs';
import { PaymentMode } from './payment-mode.mjs';

const XLAYER_CHAIN_INDEX = '196';

// upstream: util.rs::fmt_unix_secs — n > 0 → RFC 3339 (UTC), else "—".
export function fmtUnixSecs(secs) {
  if (secs === undefined || secs === null || !(BigInt(secs) > 0n)) return '—';
  return utcRfc3339(secs) ?? String(secs);
}

// upstream: util.rs::json_str
export function jsonStr(obj, key) {
  const v = asStr(at(obj, key));
  if (v === undefined) throw new Error(`response missing field: ${key}`);
  return v;
}

// upstream: util.rs::json_u64
export function jsonU64(obj, key) {
  const n = asU64(at(obj, key));
  if (n !== undefined) return n;
  const s = asStr(at(obj, key));
  if (s !== undefined) {
    if (!/^\+?[0-9]+$/.test(s) || BigInt(s) > 18446744073709551615n) throw new Error(`failed to parse ${key} as u64: ${s}`);
    const b = BigInt(s);
    return Number.isSafeInteger(Number(b)) ? Number(b) : b;
  }
  throw new Error(`response missing field: ${key}`);
}

// upstream: util.rs::resolve_payment_mode → PaymentMode
export async function resolvePaymentMode(client, paymentMode, jobId, agentId) {
  if (paymentMode !== undefined && paymentMode !== null) return PaymentMode.fromStr(paymentMode);
  const task = await client.getWithIdentity(client.taskPath(jobId), agentId);
  const i = asI64(at(task, 'paymentMode')) ?? 0;
  const mode = PaymentMode.fromInt(Number(BigInt.asIntN(32, BigInt(i))));
  return mode === PaymentMode.None ? PaymentMode.Escrow : mode;
}

// upstream: util.rs::resolve_token_symbol_by_address
export async function resolveTokenSymbolByAddress(chainIndex, contractAddress) {
  const { fetchInfo } = await import('../../../commands/token/token.mjs');
  const client = ApiClient.sync();
  const resp = await fetchInfo(client, contractAddress, chainIndex);
  const first = Array.isArray(resp) ? resp[0] : undefined;
  const sym = asStr(at(first ?? null, 'tokenSymbol'));
  if (sym === undefined || sym === '') throw new Error(`token basic-info returned no symbol for chain=${chainIndex} address=${contractAddress}`);
  return sym;
}

// upstream: util.rs::normalize_token_symbol — `₮` → `T`, then Unicode uppercase.
export const normalizeTokenSymbol = (s) => String(s).split('₮').join('T').toUpperCase();

const fundOptions = (currency, amount) => `Fund your wallet — pick one:\n1. ${SCAN_TO_DEPOSIT_OPTION}\n${DEPOSIT_QR_MARKER}\n`
  + `2. Swap on XLayer — "swap <token> to ${amount} ${currency} on xlayer"\n`
  + `3. Bridge from another chain — "bridge ${amount} ${currency} from <chain> to xlayer"\n`
  + `4. Send from OKX exchange — withdraw ${currency} to your wallet address on XLayer network. The exchange may charge a withdrawal fee\n`
  + '\nNote: on-chain gas on XLayer is free after the funds arrive.';

// `asset["balance"].as_str().parse::<f64>().or(as_f64).unwrap_or(0.0)`
function balanceOf(asset) {
  const s = asStr(at(asset, 'balance'));
  if (s !== undefined && /^[+-]?(inf|infinity|nan|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$/i.test(s)) {
    const w = s.toLowerCase().replace(/^[+-]/, '');
    if (w === 'nan') return NaN;
    if (w === 'inf' || w === 'infinity') return s.startsWith('-') ? -Infinity : Infinity;
    return Number(s);
  }
  return asF64(at(asset, 'balance')) ?? 0;
}

// upstream: util.rs::ensure_sufficient_balance (spawns `wallet balance --chain 196`)
export async function ensureSufficientBalance(required, currency) {
  const o = await selfOutput(['wallet', 'balance', '--chain', XLAYER_CHAIN_INDEX]);
  if (o.spawnError) throw new Error(`balance query failed: ${o.spawnError.message}`);
  if (o.code !== 0) throw new Error(`balance query failed (exit ${exitStatusText(o.code, o.signal)}), please check login status`);
  let parsed;
  try { parsed = parseJson(utf8Lossy(o.stdout)); } catch (e) { throw new Error(`failed to parse balance query result: ${e.message}`); }
  const norm = normalizeTokenSymbol(currency);
  for (const detail of asArray(at(at(parsed, 'data'), 'details')) ?? []) {
    const assets = asArray(at(detail, 'tokenAssets')) ?? asArray(at(detail, 'assets'));
    for (const asset of assets ?? []) {
      const symbol = asStr(at(asset, 'tokenSymbol')) ?? asStr(at(asset, 'symbol')) ?? '';
      const s = normalizeTokenSymbol(symbol);
      if (s === norm || s === `${norm}0`) {
        const balance = balanceOf(asset);
        if (balance < required) {
          const shortfall = required - balance;
          const message = `Insufficient ${currency} balance on XLayer (current: ${displayF64(balance)}, need: ${displayF64(required)}, shortfall: ${displayF64(shortfall)})\n\n${fundOptions(currency, displayF64(shortfall))}`;
          throw new InsufficientBalanceError(message, currency, required, balance);
        }
        return;
      }
    }
  }
  const message = `${currency} balance not found on XLayer (need ${displayF64(required)} ${currency})\n\n${fundOptions(currency, displayF64(required))}`;
  throw new InsufficientBalanceError(message, currency, required, 0);
}

async function portfolioAssets(address, failSuffix) {
  const o = await selfOutput(['portfolio', 'all-balances', '--address', address, '--chains', XLAYER_CHAIN_INDEX]);
  if (o.spawnError) throw new Error(`portfolio balance query failed: ${o.spawnError.message}`);
  if (o.code !== 0) throw new Error(`portfolio balance query failed (exit ${exitStatusText(o.code, o.signal)})${failSuffix}`);
  let parsed;
  try { parsed = parseJson(utf8Lossy(o.stdout)); } catch (e) { throw new Error(`failed to parse portfolio balance result: ${e.message}`); }
  return (asArray(at(parsed, 'data')) ?? []).flatMap((chain) => asArray(at(chain, 'tokenAssets')) ?? []);
}

// upstream: util.rs::query_xlayer_balance
export async function queryXlayerBalance(address, currency) {
  const norm = normalizeTokenSymbol(currency);
  for (const asset of await portfolioAssets(address, '')) {
    const symbol = asStr(at(asset, 'symbol')) ?? asStr(at(asset, 'tokenSymbol')) ?? '';
    const s = normalizeTokenSymbol(symbol);
    if (s === norm || s === `${norm}0`) return balanceOf(asset);
  }
  return 0;
}

// upstream: util.rs::ensure_sufficient_balance_at
export async function ensureSufficientBalanceAt(required, currency, address) {
  const norm = normalizeTokenSymbol(currency);
  for (const asset of await portfolioAssets(address, `, address=${address}`)) {
    const symbol = asStr(at(asset, 'symbol')) ?? asStr(at(asset, 'tokenSymbol')) ?? '';
    const s = normalizeTokenSymbol(symbol);
    if (s === norm || s === `${norm}0`) {
      const balance = balanceOf(asset);
      if (balance < required) {
        const shortfall = required - balance;
        const message = `Insufficient ${currency} balance on XLayer (current: ${displayF64(balance)}, need: ${displayF64(required)}, shortfall: ${displayF64(shortfall)}, address: ${address})\n\n${fundOptions(currency, displayF64(shortfall))}`;
        throw new InsufficientBalanceError(message, currency, required, balance);
      }
      return;
    }
  }
  const message = `${currency} balance not found on XLayer (need ${displayF64(required)} ${currency}, address: ${address})\n\n${fundOptions(currency, displayF64(required))}`;
  throw new InsufficientBalanceError(message, currency, required, 0);
}

// upstream: util.rs::MAX_JOB_ID_LEN
export const MAX_JOB_ID_LEN = 256;

// upstream: util.rs::is_single_safe_component
function isSingleSafeComponent(s) {
  if (s === '') return false;
  if (byteLen(s) > MAX_JOB_ID_LEN) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  if (s === '.' || s === '..') return false;
  if ([...s].some(isControl)) return false;
  // R6: exactly one Component::Normal equal to the input (Windows: no drive/verbatim prefix).
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(s)) return false;
  return true;
}

// upstream: util.rs::validate_job_id_path_component
export function validateJobIdPathComponent(jobId) {
  if (!isSingleSafeComponent(jobId)) throw new CodedError('UNSAFE_JOB_PATH_COMPONENT', null, 'jobId is not a safe path component');
}

// upstream: util.rs::validate_job_id → undefined (Ok) | error message string (Err)
export function validateJobId(jobId) {
  if (jobId === '_') return undefined;
  if (jobId.startsWith('system_')) return undefined;
  if (!jobId.startsWith('0x') || byteLen(jobId) !== 66) {
    return `--jobid invalid (must be \`0x\` + 64 chars, got ${byteLen(jobId)} chars). Re-read jobId from envelope (system event / user_decision_* → \`message.jobId\`; a2a-agent-chat → top-level \`jobId\`), then retry.`;
  }
  return undefined;
}

// upstream: util.rs::short_job_id — ≤12 chars as-is, else first 6 + "…" + last 4 (chars).
export function shortJobId(jobId) {
  const chars = [...String(jobId)];
  if (chars.length <= 12) return String(jobId);
  return `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}`;
}

// upstream: util.rs::sanitize_title_for_shell
export function sanitizeTitleForShell(title) {
  let mapped = '';
  for (const ch of String(title)) {
    if (ch === '&' || ch === '|' || ch === ';') mapped += ' ';
    else if ('`$><()!'.includes(ch)) continue;
    else mapped += ch;
  }
  return splitWhitespace(mapped).join(' ');
}

export { trim };
