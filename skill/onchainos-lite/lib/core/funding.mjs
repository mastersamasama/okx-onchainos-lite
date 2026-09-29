// Funding Target Resolver + FundingBundle composition — upstream funding.rs.
// Resolves the current account's receive address for a chain, composes it with the Common QR
// output (core/qr.mjs) and maps every insufficient-balance caller (wallet send, swap, A2A
// payment, task creation) into the same `fundingTarget` / `qr` / `fundingNeed` payload.
//
// Value shapes: every upstream consumer embeds FundingTarget / QrOutput through
// serde_json::to_value or json! — i.e. as sorted-key Values — so this module returns them as
// plain (sorted) objects. FundingBundle = { target, qr }.
//
// Collaborators are imported statically, as upstream links them: Common QR (core/qr.mjs) and the
// wallet foundation (lib/wallet/{account,auth,store,api,common}.mjs). The balance module
// (refresh_wallet_accounts_strict) imports this one and pulls in the BRC-20 / Bitcoin adapters,
// so it is imported on first use.
import { chainDisplayName } from './chains.mjs';
import { buildQrOutput } from './qr.mjs';
import { trim } from './rs/str.mjs';
import { resolveAccountAddressForChain, resolveActiveAccountId } from '../wallet/account.mjs';
import { ensureTokensRefreshed } from '../wallet/auth.mjs';
import { loadWallets } from '../wallet/store.mjs';
import { WalletApiClient } from '../wallet/api.mjs';
import { ERR_NOT_LOGGED_IN } from '../wallet/common.mjs';

// upstream: funding.rs constants
export const FUNDING_REQUIRED_PHASE = 'funding_required';
export const FUNDING_OPERATION_TRANSFER = 'transfer';
export const FUNDING_OPERATION_SWAP = 'swap';
export const FUNDING_OPERATION_A2A_PAYMENT = 'a2a_payment';
export const FUNDING_OPERATION_TASK_CREATION = 'task_creation';

// serde_json::to_value — deep copy that drops struct field order (Values print sorted);
// f64 / raw / F64 / BigInt leaves are kept as-is.
const F64_KEY = Symbol.for('ocl.f64');
const RAW_KEY = Symbol.for('ocl.raw');
function toValue(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toValue(x)));
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && v[F64_KEY] === undefined && v[RAW_KEY] === undefined) {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = toValue(x);
    return o;
  }
  return v;
}

// ── FundingTarget / FundingBundle ───────────────────────────────────

// upstream: funding.rs::FundingTarget (serialised camelCase).
function fundingTarget(accountName, chainIndex, receiveAddress) {
  const ci = String(chainIndex);
  return {
    accountName,
    chainIndex: ci,
    chainName: chainDisplayName(ci),
    receiveAddress,
    gasFree: ci === '196',
    sameNetworkRequired: true,
  };
}

// upstream: funding.rs::selected_account_name — best effort, "" when unresolvable.
function selectedAccountName(wallets) {
  let id;
  try { id = resolveActiveAccountId(wallets); } catch { return ''; }
  const a = (Array.isArray(wallets?.accounts) ? wallets.accounts : []).find((x) => x?.accountId === id);
  return a && typeof a.accountName === 'string' ? a.accountName : '';
}

// upstream: funding.rs::resolve_funding_target — throws (verbatim from the account resolver)
// when the selected account has no address for the chain.
export function resolveFundingTarget(wallets, chainIndex) {
  const receiveAddress = resolveAccountAddressForChain(wallets, String(chainIndex));
  return fundingTarget(selectedAccountName(wallets), chainIndex, receiveAddress);
}

// upstream: funding.rs::build_funding_bundle_from_wallets (private upstream; exported for tests).
export function buildFundingBundleFromWallets(wallets, chainIndex, imageDir) {
  const target = resolveFundingTarget(wallets, chainIndex);
  const qr = toValue(buildQrOutput(target.receiveAddress, imageDir));
  return { target, qr };
}

// upstream: funding.rs::resolve_current_funding_bundle — fresh account/address facts for the
// selected account (refresh tokens → wallets.json → strict account refresh), then target + QR.
export async function resolveCurrentFundingBundle(chainIndex, imageDir) {
  const accessToken = await ensureTokensRefreshed();
  const wallets = loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const client = new WalletApiClient();
  const { refreshWalletAccountsStrict } = await import('../wallet/balance/index.mjs');
  await refreshWalletAccountsStrict(client, accessToken, wallets);
  return buildFundingBundleFromWallets(wallets, chainIndex, imageDir);
}

// upstream: funding.rs::build_funding_bundle — wallet-backed one-call funding-blocked result.
// input = FundingBlockedInput { asset, tokenAddress, required, balance?, operation?, errorCode?, errorMessage? }.
export async function buildFundingBundle(chainIndex, input) {
  validateFundingBlockedInput(input);
  const bundle = await resolveCurrentFundingBundle(chainIndex, undefined);
  return buildFundingBlockedResult(bundle, input);
}

// upstream: funding.rs::compose_funding_bundle_for_address (private upstream).
function composeFundingBundleForAddress(accountName, chainIndex, receiveAddress, imageDir) {
  if (trim(chainIndex) === '') throw new Error('funding chain index must not be blank');
  if (trim(receiveAddress) === '') throw new Error('funding receive address must not be blank');
  const target = fundingTarget(accountName, chainIndex, receiveAddress);
  return { target, qr: toValue(buildQrOutput(receiveAddress, imageDir)) };
}

// upstream: funding.rs::build_funding_bundle_for_address — the caller already resolved the
// receiving address (e.g. Agent Commerce). No I/O except the QR image.
export function buildFundingBundleForAddress(accountName, chainIndex, receiveAddress, input) {
  validateFundingBlockedInput(input);
  const bundle = composeFundingBundleForAddress(accountName, chainIndex, receiveAddress, undefined);
  return buildFundingBlockedResult(bundle, input);
}

const given = (v) => v !== undefined && v !== null;

// upstream: funding.rs::validate_funding_blocked_input
export function validateFundingBlockedInput(input) {
  if (trim(input.asset) === '') throw new Error('funding asset must not be blank');
  if (given(input.operation) && trim(input.operation) === '') throw new Error('funding operation must not be blank when provided');
  const required = readableShortfall(input.required, '0');
  if (required === null) throw new Error('funding required amount must be a plain non-negative decimal');
  if (required === '0') throw new Error('funding required amount must be greater than zero');
  if (given(input.balance)) {
    const shortfall = readableShortfall(input.required, input.balance);
    if (shortfall === null) throw new Error('funding balance must be a plain non-negative decimal');
    if (shortfall === '0') throw new Error('funding bundle requires an actual balance shortfall');
  }
}

// upstream: funding.rs::build_funding_blocked_result — json! ⇒ sorted keys throughout.
// Callers wrap it in FundingBlocked (core/errors.mjs) ⇒ {"ok":false,"data":…}, exit 1.
export function buildFundingBlockedResult(bundle, input) {
  const shortfall = given(input.balance) ? readableShortfall(input.required, input.balance) : null;
  const fundingNeed = {
    asset: input.asset,
    tokenAddress: input.tokenAddress,
    required: input.required,
    balance: given(input.balance) ? input.balance : null,
  };
  if (shortfall !== null) fundingNeed.shortfall = shortfall;
  const payload = {
    fundingTarget: bundle.target == null ? null : toValue(bundle.target),
    qr: bundle.qr == null ? null : toValue(bundle.qr),
    fundingNeed,
  };
  if (given(input.operation)) payload.operation = String(input.operation);
  const error = {};
  if (given(input.errorCode) && trim(input.errorCode) !== '') error.code = String(input.errorCode);
  if (given(input.errorMessage) && trim(input.errorMessage) !== '') error.message = String(input.errorMessage);
  if (Object.keys(error).length) payload.error = error;
  return {
    phase: FUNDING_REQUIRED_PHASE,
    decision: 'blocked',
    reason: 'insufficient_balance',
    nextAction: [],
    payload,
  };
}

// upstream: funding.rs::readable_shortfall — `required - available` for plain non-negative
// decimals (exact BigInt arithmetic); "0" when covered; null when either is not a plain decimal
// (signs and scientific notation are rejected).
export function readableShortfall(required, available) {
  const parse = (value) => {
    const parts = trim(value).split('.');
    if (parts.length > 2) return null;
    const [whole, fraction = ''] = parts;
    if ((whole === '' && fraction === '') || !/^[0-9]*$/.test(whole) || !/^[0-9]*$/.test(fraction)) return null;
    return [BigInt((whole === '' ? '0' : whole) + fraction), fraction.length];
  };
  const r = parse(required);
  const a = parse(available);
  if (!r || !a) return null;
  const scale = Math.max(r[1], a[1]);
  const req = r[0] * 10n ** BigInt(scale - r[1]);
  const avail = a[0] * 10n ** BigInt(scale - a[1]);
  if (req <= avail) return '0';
  let digits = (req - avail).toString();
  if (scale === 0) return digits;
  if (digits.length <= scale) digits = '0'.repeat(scale + 1 - digits.length) + digits;
  const split = digits.length - scale;
  return `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/0+$/, '').replace(/\.$/, '');
}
