// Wallet authentication lifecycle — upstream agentic_wallet/auth/mod.rs.
//
// Login is the upstream social-login link flow:
//   init : X25519 session keypair + uuid authSessionId → keyring pending state → login URL
//          <base>/account/sociallogin?authSessionId=…&tempPubKey=<b64 pub>&clientType=agent-cli
//   open : best-effort system-browser open of that URL (ONCHAINOS_NO_BROWSER disables)
//   poll : POST auth/session/result every 2 s until the page finished (the page HPKE-seals the
//          Ed25519 session seed to tempPubKey), persist wallets/session/keyring, post-login
//          heartbeat, print the account summary.
// Every JWT command calls ensureTokensRefreshed() first (60 s refresh margin).
import { randomUUID } from 'node:crypto';
import * as keyring from '../core/keyring.mjs';
import { baseUrl } from '../core/http.mjs';
import { openUrl } from '../core/proc.mjs';
import { remove as removeStateFile } from '../core/store.mjs';
import { auditLog } from '../core/audit.mjs';
import { EMPTY } from '../core/context.mjs';
import { parse } from '../core/json.mjs';
import { x25519 } from '../crypto/curve25519.mjs';
import { WalletApiClient, ApiCodeError, decodeVerifyResponse, SerdeError } from './api.mjs';
import * as store from './store.mjs';
import { ERR_NOT_LOGGED_IN, maskEmail } from './common.mjs';
import { switchToAccount } from './account.mjs';
import { forceRefreshChainCache } from './chain.mjs';
import { parseI64, parseU64, isI64, isObject, timeoutAt } from './_rs.mjs';

// ── Token / session helpers ─────────────────────────────────────────

// upstream: auth/mod.rs::TOKEN_EXPIRY_MARGIN_SECS
export const TOKEN_EXPIRY_MARGIN_SECS = 60;
const nowSecs = () => Math.floor(Date.now() / 1000);
const SESSION_EXPIRED = 'session expired, please login again: onchainos wallet login';

// upstream: auth/mod.rs::ensure_tokens (no refresh, no stderr; dead code upstream)
export function ensureTokens() {
  const session = store.loadSession();
  if (isSessionKeyExpired(session ? session.sessionKeyExpireAt : '')) throw new Error(SESSION_EXPIRED);
  const blob = keyring.readBlob();
  const rt = nonEmpty(blob.refresh_token);
  if (!rt) throw new Error(ERR_NOT_LOGGED_IN);
  if (isTokenExpired(rt)) throw new Error(SESSION_EXPIRED);
  const at = nonEmpty(blob.access_token);
  if (!at) throw new Error(ERR_NOT_LOGGED_IN);
  return [at, rt];
}
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

// upstream: auth/mod.rs::ensure_tokens_refreshed → a valid access token (refreshes when either
// JWT is within 60 s of expiry; applies chainUpdated from the refresh response).
export async function ensureTokensRefreshed() {
  const session = store.loadSession();
  if (isSessionKeyExpired(session ? session.sessionKeyExpireAt : '')) return sessionExpiredErr();
  const blob = keyring.readBlob();
  const refreshToken = nonEmpty(blob.refresh_token);
  if (!refreshToken) return sessionExpiredErr();
  const accessToken = nonEmpty(blob.access_token);
  if (!accessToken) return sessionExpiredErr();
  if (isTokenExpired(refreshToken)) {
    process.stderr.write('Session expired. Please log in again: onchainos wallet login\n');
    return sessionExpiredErr();
  }
  if (shouldRefreshTokens(accessToken, refreshToken)) {
    let resp;
    try { resp = await new WalletApiClient().authRefresh(refreshToken); } catch (e) { throw formatApiError(e); }
    keyring.store([['access_token', resp.accessToken], ['refresh_token', resp.refreshToken]]);
    if (resp.chainUpdated && resp.allAccountAddressList.length) {
      applyAllAccountAddressList(resp.allAccountAddressList);
      await forceRefreshChainCache();
    }
    return resp.accessToken;
  }
  return accessToken;
}

// upstream: auth/mod.rs::session_expired_err
export function sessionExpiredErr() { throw new Error(SESSION_EXPIRED); }

// upstream: auth/mod.rs::is_token_expired
export const isTokenExpired = (token) => isTokenExpiredAt(token, nowSecs());
// upstream: auth/mod.rs::is_token_expired_at
export function isTokenExpiredAt(token, now) {
  const exp = tokenExpTimestamp(token);
  return exp === null ? true : BigInt(now) >= exp;
}
// upstream: auth/mod.rs::should_refresh_tokens
export const shouldRefreshTokens = (at, rt) => shouldRefreshTokensAt(at, rt, nowSecs());
// upstream: auth/mod.rs::should_refresh_tokens_at
export const shouldRefreshTokensAt = (at, rt, now) => isTokenExpiringAt(at, now) || isTokenExpiringAt(rt, now);
// upstream: auth/mod.rs::is_token_expiring_at
export function isTokenExpiringAt(token, now) {
  const exp = tokenExpTimestamp(token);
  return exp === null ? true : isExpiringTimestamp(exp, now);
}
// upstream: auth/mod.rs::is_expiring_timestamp — now.saturating_add(60) >= exp
export function isExpiringTimestamp(exp, now) {
  const I64_MAX = 9223372036854775807n;
  let n = BigInt(now) + BigInt(TOKEN_EXPIRY_MARGIN_SECS);
  if (n > I64_MAX) n = I64_MAX;
  return n >= BigInt(exp);
}

// upstream: auth/mod.rs::token_exp_timestamp — JWT `exp` (base64url no-pad strict) → BigInt | null
export function tokenExpTimestamp(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const p = parts[1];
  if (!/^[A-Za-z0-9_-]*$/.test(p) || p.length % 4 === 1) return null;
  const bytes = Buffer.from(p, 'base64url');
  if (bytes.toString('base64url') !== p) return null;            // non-canonical trailing bits
  let val;
  try { val = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  const exp = isObject(val) ? val.exp : undefined;
  return isI64(exp) ? BigInt(exp) : null;
}

// upstream: auth/mod.rs::is_session_key_expired — "" / unparseable → expired.
export function isSessionKeyExpired(expireAt) {
  if (expireAt === '') return true;
  const exp = parseI64(expireAt);
  if (exp === undefined) return true;
  return BigInt(nowSecs()) >= exp;
}

// upstream: auth/mod.rs::format_api_error — ApiCodeError → "code=<c> msg=<m>", else unchanged.
export function formatApiError(e) {
  if (e instanceof ApiCodeError) return new Error(`code=${e.code} msg=${e.msg}`);
  return e;
}

// ── Social login ────────────────────────────────────────────────────

// upstream: auth/mod.rs::SOCIAL_LOGIN_PATH
export const SOCIAL_LOGIN_PATH = '/account/sociallogin';
export const SOCIAL_LOGIN_TIMEOUT_DEFAULT_SECS = 300;
export const SOCIAL_LOGIN_TIMEOUT_FLOOR_SECS = 10;
export const SOCIAL_LOGIN_POLL_INTERVAL_SECS = 2;
export const MAX_CONSECUTIVE_TRANSIENT_POLLS = 5;
export const POST_LOGIN_SETUP_TIMEOUT_SECS = 15;
export const POST_LOGIN_PREPARE_TIMEOUT_SECS = 4;
export const LOGIN_HEARTBEAT_CHAIN_INDEX = 196;
export const POST_LOGIN_HEARTBEAT_TIMEOUT_SECS = 4;
export const PENDING_AUTH_SESSION_ID = 'pending_auth_session_id';
export const PENDING_SESSION_KEY_PREFIX = 'pending_session_key:';

// upstream: auth/mod.rs::social_login_base_url (endpoints::base_url)
export const socialLoginBaseUrl = () => baseUrl();

// upstream: auth/mod.rs::build_login_url — form-urlencoded query (+ / = in the key are escaped).
export function buildLoginUrl(base, authSessionId, tempPubKey) {
  const query = new URLSearchParams([['authSessionId', authSessionId], ['tempPubKey', tempPubKey], ['clientType', 'agent-cli']]).toString();
  return `${base.replace(/\/+$/, '')}${SOCIAL_LOGIN_PATH}?${query}`;
}

// upstream: auth/mod.rs::PollOutcome
export const PollOutcome = Object.freeze({ Ready: 'Ready', Pending: 'Pending', Transient: 'Transient', Terminal: 'Terminal' });

// upstream: auth/mod.rs::classify_poll — result: { value } | { error }
export function classifyPoll(result) {
  if (!('error' in result)) {
    const t = isObject(result.value) ? result.value.accessToken : undefined;
    return typeof t === 'string' && t !== '' ? PollOutcome.Ready : PollOutcome.Pending;
  }
  const e = result.error;
  if (!(e instanceof ApiCodeError)) return PollOutcome.Transient;
  return e.code === '10018' ? PollOutcome.Pending : PollOutcome.Terminal;
}

// upstream: auth/mod.rs::resolve_social_login_timeout_secs
export function resolveSocialLoginTimeoutSecs(raw) {
  if (raw === undefined || raw === null) return SOCIAL_LOGIN_TIMEOUT_DEFAULT_SECS;
  const v = parseU64(raw);
  return v !== undefined && v >= BigInt(SOCIAL_LOGIN_TIMEOUT_FLOOR_SECS) ? Number(v) : SOCIAL_LOGIN_TIMEOUT_DEFAULT_SECS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// upstream: auth/mod.rs::poll_session_result — 2 s cadence, SOCIAL_LOGIN_TIMEOUT_SECS (≥10, default 300).
export async function pollSessionResult(client, authSessionId) {
  const timeoutSecs = resolveSocialLoginTimeoutSecs(process.env.SOCIAL_LOGIN_TIMEOUT_SECS);
  const deadline = Date.now() + timeoutSecs * 1000;
  let transient = 0;
  for (;;) {
    let result;
    try { result = { value: await client.sessionResult(authSessionId) }; } catch (error) { result = { error }; }
    switch (classifyPoll(result)) {
      case PollOutcome.Ready: return result.value;
      case PollOutcome.Terminal: throw formatApiError(result.error);
      case PollOutcome.Transient:
        transient += 1;
        if (transient >= MAX_CONSECUTIVE_TRANSIENT_POLLS) throw formatApiError(result.error);
        break;
      default: transient = 0;
    }
    if (Date.now() >= deadline) {
      throw new Error('login timed out waiting for the result. The login link is still valid — finish login in the browser, then check the result again (`onchainos wallet login --phase poll`), or start a fresh login (`onchainos wallet login --phase init`)');
    }
    await sleep(SOCIAL_LOGIN_POLL_INTERVAL_SECS * 1000);
  }
}

// upstream: auth/mod.rs::try_open_browser — false when ONCHAINOS_NO_BROWSER is set or spawn fails.
export function tryOpenBrowser(url) {
  if (process.env.ONCHAINOS_NO_BROWSER !== undefined) return false;
  return openUrl(url);
}

// upstream: auth/mod.rs::is_browsable_url — http/https only.
export function isBrowsableUrl(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

// upstream: auth/mod.rs::pending_session_key_name
export const pendingSessionKeyName = (authSessionId) => `${PENDING_SESSION_KEY_PREFIX}${authSessionId}`;

// upstream: auth/mod.rs::new_login_session → [authSessionId, sessionPrivateKeyB64, loginUrl]
export function newLoginSession() {
  const authSessionId = randomUUID();
  const [sessionPrivateKey, tempPubKey] = generateX25519SessionKeypair();
  return [authSessionId, sessionPrivateKey, buildLoginUrl(socialLoginBaseUrl(), authSessionId, tempPubKey)];
}

// crypto.rs::generate_x25519_session_keypair → [session_private_key_b64, temp_pub_key_b64]
function generateX25519SessionKeypair() {
  const { secret, publicKey } = x25519.generate();
  return [secret.toString('base64'), publicKey.toString('base64')];
}

// upstream: auth/mod.rs::attach_post_login_subscriptions
export function attachPostLoginSubscriptions(summary, snapshot) {
  if (!isObject(summary) || snapshot === null || snapshot === undefined) return;
  summary.postLoginSubscriptions = snapshot;
}

// upstream: auth/mod.rs::validated_post_login_agentic_id — trimmed, non-empty.
export function validatedPostLoginAgenticId(agenticId) {
  if (typeof agenticId !== 'string') return null;
  const t = agenticId.trim();
  return t === '' ? null : t;
}

// ── collaborators owned by other units (late-bound, private fallbacks) ──
async function importOptional(rel, name) {
  try {
    const m = await import(new URL(rel, import.meta.url).href);
    return typeof m[name] === 'function' ? m[name] : null;
  } catch { return null; }
}
async function agentTaskUser(name) {
  return (await importOptional('../agent/task/user/index.mjs', name)) ?? (await import('./_post-login.mjs'))[name];
}
async function fetchHeartbeat(client, accessToken, chainIndex) {
  const f = (await importOptional('../agent/chat/index.mjs', 'fetchHeartbeat')) ?? (await import('./_post-login.mjs')).fetchHeartbeat;
  return f(client, accessToken, chainIndex);
}
async function loginAccountSummary(client, accessToken, wallets, accountId) {
  const f = (await importOptional('./balance/index.mjs', 'loginAccountSummary')) ?? (await import('./_login-summary.mjs')).loginAccountSummary;
  return f(client, accessToken, wallets, accountId);
}

// upstream: auth/mod.rs::prepare_post_login_subscriptions_bounded
async function preparePostLoginSubscriptionsBounded(agenticId, deadlineMs) {
  const prepare = await agentTaskUser('preparePostLoginSubscriptions');
  const r = await timeoutAt(Promise.resolve().then(() => prepare(agenticId)), deadlineMs);
  return r.ok && !r.error ? r.value ?? null : null;
}

// upstream: auth/mod.rs::finalize_post_login_subscriptions_bounded
async function finalizePostLoginSubscriptionsBounded(prepared, deviceRegistrationSucceeded, deadlineMs) {
  const finalize = await agentTaskUser('finalizePostLoginSubscriptions');
  const r = await timeoutAt(Promise.resolve().then(() => finalize(prepared, deviceRegistrationSucceeded)), deadlineMs);
  return r.ok && !r.error ? r.value ?? null : null;
}

// upstream: auth/mod.rs::report_post_login_device — heartbeat with a 4 s budget; never fails.
export async function reportPostLoginDevice(client, accessToken) {
  const r = await timeoutAt(Promise.resolve().then(() => fetchHeartbeat(client, accessToken, LOGIN_HEARTBEAT_CHAIN_INDEX)), Date.now() + POST_LOGIN_HEARTBEAT_TIMEOUT_SECS * 1000);
  return r.ok && !r.error;
}

// upstream: auth/mod.rs::report_device_and_finalize_post_login
async function reportDeviceAndFinalizePostLogin(client, accessToken, prepared, deadlineMs) {
  const succeeded = await reportPostLoginDevice(client, accessToken);
  if (prepared === null || prepared === undefined) return null;
  return finalizePostLoginSubscriptionsBounded(prepared, succeeded, deadlineMs);
}

// upstream: auth/mod.rs::run_post_login_setup
export async function runPostLoginSetup(client, accessToken, agenticId, preparationDeadlineMs, deadlineMs) {
  const id = validatedPostLoginAgenticId(agenticId);
  const prepared = id ? await preparePostLoginSubscriptionsBounded(id, preparationDeadlineMs) : null;
  return reportDeviceAndFinalizePostLogin(client, accessToken, prepared, deadlineMs);
}

// upstream: auth/mod.rs::complete_login → the login-success summary (printed as data).
export async function completeLogin(client, authSessionId, sessionPrivateKey) {
  const result = await pollSessionResult(client, authSessionId);
  let resp;
  try { resp = decodeVerifyResponse(result); } catch (e) {
    if (e instanceof SerdeError) throw new Error(`social login: failed to parse result: ${e.message}`);
    throw e;
  }
  const email = resp.loginInfo.email;
  const loginType = resp.loginInfo.loginType;
  await saveVerifyResult(client, resp, sessionPrivateKey, email);

  const postLoginDeadline = Date.now() + POST_LOGIN_SETUP_TIMEOUT_SECS * 1000;
  const preparationDeadline = Date.now() + POST_LOGIN_PREPARE_TIMEOUT_SECS * 1000;
  const resolveAgenticId = await agentTaskUser('resolvePostLoginAgenticId');
  const resolved = await timeoutAt(Promise.resolve().then(() => resolveAgenticId({ deadlineMs: preparationDeadline })), preparationDeadline);
  const agenticId = validatedPostLoginAgenticId(resolved.ok && !resolved.error ? resolved.value : null);
  const postLogin = await runPostLoginSetup(client, resp.accessToken, agenticId, preparationDeadline, postLoginDeadline);

  const wallets = store.loadWallets() ?? store.walletsJson();
  const summary = await loginAccountSummary(client, resp.accessToken, wallets, resp.accountId);
  if (isObject(summary)) {
    summary.accountId = resp.accountId;
    summary.loginType = loginType;
    summary.email = email;
    summary.isNew = resp.isNew;
  }
  attachPostLoginSubscriptions(summary, postLogin);
  return summary;
}

// upstream: auth/mod.rs::cmd_login_init → {authSessionId, loginUrl, nextSteps, opened}
export function cmdLoginInit() {
  const prev = nonEmpty(keyring.getOpt(PENDING_AUTH_SESSION_ID));
  if (prev) { try { keyring.del(pendingSessionKeyName(prev)); } catch {} }
  const [authSessionId, sessionPrivateKey, loginUrl] = newLoginSession();
  keyring.store([[PENDING_AUTH_SESSION_ID, authSessionId], [pendingSessionKeyName(authSessionId), sessionPrivateKey]]);
  const opened = isBrowsableUrl(loginUrl) && tryOpenBrowser(loginUrl);
  return { loginUrl, authSessionId, opened, nextSteps: nextStepsForLogin(authSessionId, opened, loginUrl) };
}

// upstream: auth/mod.rs::next_steps_for_login
export function nextStepsForLogin(authSessionId, opened, loginUrl) {
  const steps = {
    displayLoginUrl: loginUrl,
    completeLogin: `onchainos wallet login --phase poll --session-id ${authSessionId}`,
    requiredOrder: ['displayLoginUrl', 'completeLogin'],
  };
  if (!opened) steps.openLoginUrl = loginUrl;
  return steps;
}

// upstream: auth/mod.rs::cmd_login_open → {opened}
export function cmdLoginOpen(url) {
  if (!isBrowsableUrl(url)) throw new Error('`--url` must be an http(s) URL');
  return { opened: tryOpenBrowser(url) };
}

// upstream: auth/mod.rs::cmd_login_poll — pending state is cleared only after a successful login.
export async function cmdLoginPoll(sessionId) {
  let authSessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  if (!authSessionId) {
    authSessionId = nonEmpty(keyring.getOpt(PENDING_AUTH_SESSION_ID));
    if (!authSessionId) throw new Error('no login in progress — run `onchainos wallet login --phase init` first');
  }
  const pendingKey = pendingSessionKeyName(authSessionId);
  const sessionPrivateKey = nonEmpty(keyring.getOpt(pendingKey));
  if (!sessionPrivateKey) throw new Error('no login in progress for this session — run `onchainos wallet login --phase init` first');
  const summary = await completeLogin(new WalletApiClient(), authSessionId, sessionPrivateKey);
  try { keyring.del(pendingKey); } catch {}
  try { if (keyring.getOpt(PENDING_AUTH_SESSION_ID) === authSessionId) keyring.del(PENDING_AUTH_SESSION_ID); } catch {}
  return summary;
}

// upstream: auth/mod.rs::save_verify_result — persist credentials and the account set.
export async function saveVerifyResult(client, resp, sessionPrivateKey, email) {
  let previousEmail = null;
  try { previousEmail = store.loadWallets()?.email || null; } catch {}
  if (previousEmail && previousEmail !== email) {
    auditLog('cli', 'login_account_switch', true, 0, [
      `previous_email=${maskEmail(previousEmail)}`, `new_email=${maskEmail(email)}`, `login_type=${resp.loginInfo.loginType}`,
    ], undefined);
  }
  store.saveWallets({
    email, isNew: resp.isNew, projectId: resp.projectId, selectedAccountId: resp.accountId,
    accountsMap: {}, accounts: [], loginType: resp.loginInfo.loginType,
  });
  store.deleteBalanceCache();
  let session;
  try { session = store.loadSession(); } catch { session = null; }
  session = session ?? store.sessionJson();
  session.saTeeId = resp.saTeeId;
  session.sessionCert = resp.sessionCert;
  session.encryptedSessionSk = resp.encryptedSessionSk;
  session.sessionKeyExpireAt = resp.sessionKeyExpireAt;
  store.saveSession(session);
  keyring.store([['refresh_token', resp.refreshToken], ['access_token', resp.accessToken], ['session_key', sessionPrivateKey]]);
  if (!resp.allAccountAddressList.length) await fetchAndSaveAccountList(client, resp.accessToken, resp.projectId);
  else applyAllAccountAddressList(resp.allAccountAddressList);
  store.clearLoginCache();
}

const toAddressInfo = (accountId, a) => ({ accountId, address: a.address, chainIndex: a.chainIndex, chainName: a.chainName, addressType: a.addressType, chainPath: a.chainPath });

// upstream: auth/mod.rs::fetch_and_save_account_list — account/list + account/address/list; silent.
export async function fetchAndSaveAccountList(client, accessToken, projectId) {
  let accountList;
  try { accountList = await client.accountList(accessToken, projectId); } catch { return; }
  try {
    const w = store.loadWallets();
    if (w) {
      w.accounts = accountList.map((a) => ({ projectId: a.projectId, accountId: a.accountId, accountName: a.accountName, isDefault: a.isDefault }));
      try { store.saveWallets(w); } catch {}
    }
  } catch {}
  let addressAccounts;
  try { addressAccounts = await client.accountAddressList(accessToken, accountList.map((a) => a.accountId)); } catch { return; }
  try {
    const w = store.loadWallets();
    if (w) {
      for (const item of addressAccounts) w.accountsMap[item.accountId] = { addressList: item.addresses.map((a) => toAddressInfo(item.accountId, a)) };
      try { store.saveWallets(w); } catch {}
    }
  } catch {}
}

// ── Add ─────────────────────────────────────────────────────────────

// upstream: auth/mod.rs::cmd_add → {accountId, accountName, addressList:[{address, chainIndex, chainName}]}
export async function cmdAdd() {
  const accessToken = await ensureTokensRefreshed();
  const current = store.loadWallets();
  if (!current || current.projectId === '') throw new Error(ERR_NOT_LOGGED_IN);
  const client = new WalletApiClient();
  let resp;
  try { resp = await client.accountCreate(accessToken, current.projectId); } catch (e) { throw formatApiError(e); }
  const wallets = store.loadWallets() ?? store.walletsJson();
  wallets.accounts.push({ projectId: resp.projectId, accountId: resp.accountId, accountName: resp.accountName, isDefault: false });
  wallets.accountsMap[resp.accountId] = { addressList: resp.addressList.map((a) => toAddressInfo(resp.accountId, a)) };
  store.saveWallets(wallets);
  let accountList = null;
  try { accountList = await client.accountList(accessToken, wallets.projectId); } catch {}
  if (accountList) {
    const w = store.loadWallets() ?? store.walletsJson();
    w.accounts = accountList.map((a) => ({ projectId: a.projectId, accountId: a.accountId, accountName: a.accountName, isDefault: a.isDefault }));
    store.saveWallets(w);
  }
  switchToAccount(resp.accountId);
  return {
    accountId: resp.accountId, accountName: resp.accountName,
    addressList: resp.addressList.map((a) => ({ chainIndex: a.chainIndex, chainName: a.chainName, address: a.address })),
  };
}

// ── Logout ──────────────────────────────────────────────────────────

// upstream: auth/mod.rs::cmd_logout — local only (tokens are not revoked server-side).
export function cmdLogout() {
  keyring.clearAll();
  store.deleteSession();
  store.deleteWallets();
  store.deleteCache();
  store.deleteBalanceCache();
  removeStateFile('payment_cache.json');        // payment_cache.rs::PaymentCache::delete
  removeStateFile('subscriptions.json');        // payment/subscription/cache.rs::SubscriptionCache::delete
  return EMPTY;
}

// ── Chain update helpers ────────────────────────────────────────────

// upstream: auth/mod.rs::apply_all_account_address_list — overwrite accounts + accountsMap.
export function applyAllAccountAddressList(list) {
  let wallets;
  try { wallets = store.loadWallets(); } catch { return; }
  if (!wallets) return;
  wallets.accounts = list.map((a) => ({ projectId: wallets.projectId, accountId: a.accountId, accountName: a.accountName, isDefault: a.isDefault }));
  wallets.accountsMap = {};
  for (const item of list) wallets.accountsMap[item.accountId] = { addressList: item.addresses.map((a) => toAddressInfo(item.accountId, a)) };
  try { store.saveWallets(wallets); } catch {}
}

