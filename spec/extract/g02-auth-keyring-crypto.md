# g02-auth-keyring-crypto — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the wallet **authentication lifecycle** (`wallet login` in its three phases, JWT refresh, `wallet add`,
`wallet logout`), the account/local-state commands (`wallet switch`, `wallet status`, `wallet addresses`),
`wallet geoblock`, `wallet report-plugin-info`, the **credential store** (`keyring_store.rs` + encrypted-file
fallback `file_keyring.rs`), the on-disk state schemas (`wallet_store.rs`), all crypto primitives (`crypto.rs`:
X25519 session key, HPKE open of `encryptedSessionSk`, Ed25519, secp256k1, EIP-3009/EIP-712, EIP-191), the
complete `WalletApiClient` transport + every endpoint wrapper in `wallet_api.rs`, and the
`WalletPreviewConfirming` / `--force` confirmation protocol types in `common.rs`.

All paths are relative to `upstream/cli/src/`. Conventions G1–G4 of `g06-wallet-core.md` apply and are restated
in §0 where they matter for this group.

> Relevance to the lite skill (from the user request): the lite runtime does **not** need to read or migrate
> an existing onchainos login (keyring blob / session.json), but it should implement the **same login flow**
> (§1, `wallet login` init → open → poll, `auth/refresh`, HPKE session key) so that a lite login yields the
> same server-side session (`accessToken`/`refreshToken`/`sessionCert`/`encryptedSessionSk`) and signing ability.

---

## Sources read

Owned (read fully, including tests):

| file | lines |
|---|---|
| `commands/agentic_wallet/auth/mod.rs` (the whole `auth/` directory = this one file) | 1827 |
| `keyring_store.rs` | 404 |
| `file_keyring.rs` | 677 |
| `crypto.rs` | 810 |
| `wallet_store.rs` | 848 |
| `wallet_api.rs` | 2874 |
| `commands/agentic_wallet/account.rs` | 476 |
| `commands/agentic_wallet/common.rs` | 209 |
| `commands/agentic_wallet/geoblock.rs` | 22 |
| `commands/agentic_wallet/plugin.rs` | 21 |

Consulted for callees / conventions (not owned, only summarised): `commands/agentic_wallet/mod.rs` (clap enum +
dispatch, 1007), `main.rs` (316), `output.rs` (450), `client.rs` (headers, `augment_auth_error_msg`, `ApiClient` auth
modes), `endpoints.rs` (65), `build.rs` (default base URL), `home.rs` (onchainos_home / permissions), `device/id.rs`,
`device/name.rs`, `doh/manager.rs` (User-Agent), `audit.rs` (log), `config.rs`, `payment_cache.rs`,
`payment/subscription/cache.rs`, `commands/agentic_wallet/balance/mod.rs` (`login_account_summary` & address
getters), `commands/agentic_wallet/chain.rs`, `commands/agentic_wallet/chain_profile.rs`, `chains.rs`
(`is_evm_chain`, `chain_family`), `commands/agent_commerce/chat/mod.rs` (`fetch_heartbeat`),
`commands/agent_commerce/task/user/{mod.rs,create.rs,device_routing.rs,subscription_ops.rs}` and
`task/common/mod.rs` (post-login helpers), `mcp/mod.rs` (confirming rendering), `Cargo.toml`/`Cargo.lock`
(serde_json without `preserve_order`; keyring 3.6.3; hpke 0.12.0).

Verification performed while writing this spec (scratch scripts, not part of the repo):
- The HPKE recipe in §2.5.2, implemented with **only `node:crypto`**, decrypts the upstream test vector
  (`auth/mod.rs:1639`) to the expected seed `d84197bf…cda122`.
- The EIP-3009 recipe in §2.5.5 (pure-JS keccak-256 + BigInt secp256k1 with RFC 6979 + low-S) reproduces upstream
  test vector TV2 (`crypto.rs:607`) byte for byte.
- `crypto.scryptSync(id, salt, 32, {N:32768,r:8,p:1})` **fails** with Node's default `maxmem`
  ("memory limit exceeded"); `maxmem: 64*1024*1024` works.

---

## 0. Cross-cutting conventions (govern byte parity)

1. **Envelopes** (`output.rs`, `main.rs:248-315`): one line of JSON on stdout + `\n`, compact unless
   `ONCHAINOS_PRETTY=1` (then `to_string_pretty`, 2-space indent).
   - success with data: `{"ok":true,"data":<data>}`; success without data: `{"ok":true}` (exit 0).
   - error: `{"ok":false,"error":"<format!("{e:#}")>"}` exit **1** (`{e:#}` = anyhow chain, outer first, joined `": "`).
   - `WalletPreviewConfirming` → `{"confirming":true,"scene":S,"message":M,"preview":P,"next":N}` exit **2**
     (struct order; `message`/`next` omitted when empty; `notifications` only if queued).
   - `CliConfirming` → `{"confirming":true,"scene"?:S,"message"?:M,"next"?:N}` exit **2**.
   - clap usage errors → clap text on stderr, exit 2. `notifications` never appears for this group (no `ApiClient` use).
   - Exception: `wallet geoblock` prints a **bare** `{"blocked":true|false}` on success (no envelope).
2. **JSON key order**: `serde_json` has no `preserve_order` (Cargo.lock: serde_json deps itoa, memchr, serde,
   serde_core, zmij — no indexmap). Every `json!{}`/`Value` object — output `data`, request bodies — is emitted
   with keys **sorted by byte order**, recursively. Structs serialised directly keep declaration order (the
   envelope, the on-disk JSON files in §2.6, the confirming structs).
3. **Rust `HashMap`** (std, random seed per process): `wallets.json.accountsMap`, `balance_cache.json.accounts`,
   and the keyring blob have **random key order** per write; any "first key" fallback is random.
4. **Base URL** (`endpoints.rs`): compiled `ONCHAINOS_COMPILED_BASE_URL`, default `https://web3.okx.com`
   (`build.rs:4`); hidden global `--dev` → `https://beta.okex.org` (and DoH disabled). DoH may swap in a proxy base
   URL / resolve override (core-owned, only on connect failures).
5. **HTTP client** (`WalletApiClient::build`, `wallet_api.rs:778`): reqwest, timeout **30 s**, User-Agent
   `OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)` (`doh/manager.rs:263`, `std::env::consts::OS/ARCH`, e.g.
   `windows; x86_64`, `macos; aarch64`, `linux; x86_64`).
6. **Headers** (`client.rs:346 anonymous_headers`, `:377 jwt_headers`):
   `Content-Type: application/json`, `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`,
   `platform: agent-cli`, `device-id: <id>` (only if a valid id is available), `device-name: <raw UTF-8 name>`;
   authed calls add `Authorization: Bearer <accessToken>`. Extra headers are inserted after (overwriting same name).
   `device-id` = `hex(sha256(utf8(machine_uid) || "onchainos"))` (64 hex) or UUIDv4 fallback, cached in
   `session.json.deviceId` (`device/id.rs`, core-owned); `device-name` = OS device name, trimmed, control chars
   stripped, ≤128 bytes, fallback `unknown-device` (`device/name.rs`).
7. **GET query** (`build_query_string`, `wallet_api.rs:106`): pairs in given order, pairs with empty value
   dropped, key raw, value `application/x-www-form-urlencoded` (space→`+`; everything except `A-Za-z0-9*-._`
   → `%XX` uppercase; e.g. `,`→`%2C`). Node's `URLSearchParams` serialiser is identical for values.
8. **Startup/teardown** (main.rs, core-owned): `home::self_heal_permissions()` (unix: chmod 0600 on
   `session.json`, `wallets.json`, `keyring.enc`, `machine-identity`, `audit.jsonl`, `watch/*/daemon.log`), and an
   `audit.jsonl` line after every command (`audit::log("cli", "wallet <sub>", ok, dur, redacted args, err)`).
9. The `debug-log` cargo feature is off in release builds — all `[DEBUG]` stderr lines in these files are absent.

---

## 1. Authentication model (what the lite skill must replicate)

**Only one login mode exists in 4.6.3: browser "social login"** (Google / Apple / Email, chosen on the OKX web
page). There is **no email-OTP CLI flow** (no `auth/init` / `auth/verify` calls anywhere in the source; the
`cache.json.login {email, flowId}` struct is a residue that login merely clears) and **no API-key (AK/HMAC)
CLI flow** (`ApiClient` has only `Jwt` / `Anonymous` modes; `config.json.api_key` is dead). The backend reports
the method in `loginInfo.loginType` (`email` | `google` | `apple` | `ak`), which is only stored/displayed.

Credential material after a successful login:

| item | where | format | produced by |
|---|---|---|---|
| `access_token` | keyring blob | JWT (Bearer) | `session/result` → `accessToken`; rotated by `auth/refresh` |
| `refresh_token` | keyring blob | JWT | `session/result` → `refreshToken`; rotated by `auth/refresh` |
| `session_key` | keyring blob | base64(32-byte X25519 private key) | generated locally at `login --phase init` |
| `sessionCert` | `session.json` | opaque string | `session/result`; sent as `sessionCert` in `unsignedInfo` bodies |
| `encryptedSessionSk` | `session.json` | base64(HPKE enc‖ct) | `session/result`; HPKE-opened with `session_key` → Ed25519 seed |
| `sessionKeyExpireAt` | `session.json` | unix seconds (string) | `session/result`; hard session deadline |
| `saTeeId` | `session.json` | string | `session/result` (optional); used by strategy createOrder |

Signing model (used by transfer / sign / payment / agent groups): `seed = HPKE_open(encryptedSessionSk,
session_key)` (§2.5.2) → Ed25519 signing key → sign server-provided hashes → base64 signature sent as
`sessionSignature`/similar; the TEE verifies with the session public key certified by `sessionCert`.

Flow (sequence):
```
CLI(init) : sk,pk = X25519 keygen; id = uuidv4
            keyring[pending_auth_session_id]=id; keyring["pending_session_key:"+id]=b64(sk)
            url = <base>/account/sociallogin?authSessionId=id&tempPubKey=b64(pk)&clientType=agent-cli
            (best-effort open browser) → print url
User      : completes Google/Apple/Email login in browser; the page HPKE-encrypts the Ed25519 session seed to pk
CLI(poll) : every 2 s POST /priapi/v5/wallet/agentic/auth/session/result {"authSessionId":id}
            code 10018 → pending; code 0 + data[0].accessToken → done
            persist wallets.json / session.json / keyring(refresh_token, access_token, session_key=b64(sk))
            accounts: data[0].allAccountAddressList or account/list + account/address/list
            post-login (best-effort): agent heartbeat, optional subscription routing, balance summary
Every authed command: ensure_tokens_refreshed() → maybe POST auth/refresh → Bearer accessToken
```

---

## Shared helpers (used across groups or from core)

### 2.1 `auth/mod.rs` — token/session helpers

- `const TOKEN_EXPIRY_MARGIN_SECS: i64 = 60` (`auth/mod.rs:17`).
- `fn auth::token_exp_timestamp(token) -> Option<i64>` (`:314`): split on `.`; exactly 3 parts else `None`;
  decode part[1] with **base64url, no padding, strict** (a `=` makes it fail → `None`); parse JSON; `exp` must be
  an integer JSON number (`as_i64`; floats/strings → `None`). No signature check.
- `fn auth::is_token_expired(token) -> bool` (`:281`, `:285`): `exp` missing/unparseable → **true**; else `now >= exp`.
- `fn is_token_expiring_at(token, now)` (`:303`) → unparseable → true; else `now + 60 >= exp` (saturating).
  `should_refresh_tokens_at(at, rt, now)` (`:299`) = expiring(at) || expiring(rt). Oracle (tests `:1459-1485`):
  with now=1_700_000_000: `exp=now` expired; `exp=now+1` not expired; expiring for `exp ≤ now+60`, not for `now+61`.
- `fn auth::is_session_key_expired(expire_at: &str) -> bool` (`:327`): empty → true; `expire_at.parse::<i64>()`
  (Rust: optional leading `+`/`-`, no whitespace) fails → true; else `now >= exp` (unix seconds).
- `fn auth::format_api_error(e) -> anyhow::Error` (`:338`): if `e` is `ApiCodeError` → new plain error
  `code=<code> msg=<msg>` (note: `msg` may already carry the 50114 suffix); otherwise `e` unchanged.
- `pub(crate) async fn auth::ensure_tokens_refreshed() -> Result<String>` (`:132`) — the auth preamble of every
  JWT command (wallet, payment, strategy, agent, security…):
  1. `session = wallet_store::load_session()?` (parse error propagates: `failed to parse session.json: …`).
     `expire_at = session?.sessionKeyExpireAt or ""`. If `is_session_key_expired` → Err
     `session expired, please login again: onchainos wallet login`.
  2. `blob = keyring_store::read_blob()?` (corruption → `Credentials corrupted. Please login again: onchainos wallet login`).
     `refresh_token` missing/empty → same `session expired…` error; `access_token` missing/empty → same.
  3. If `is_token_expired(refresh_token)` → **stderr** `Session expired. Please log in again: onchainos wallet login`
     and Err `session expired, please login again: onchainos wallet login`.
  4. If `should_refresh_tokens(access, refresh)` → `WalletApiClient::new()?.auth_refresh(refresh_token)`
     (POST `/priapi/v5/wallet/agentic/auth/refresh`, §2.2) mapped through `format_api_error`;
     `keyring_store::store([("access_token", new_at), ("refresh_token", new_rt)])`; if `chainUpdated == true` and
     `allAccountAddressList` non-empty → `apply_all_account_address_list(list)` and
     `chain::force_refresh_chain_cache()` (POST `/priapi/v5/wallet/agentic/chain/support/list`, anonymous, result
     written to `chain_cache.json`; errors ignored). Returns the new access token.
  5. else returns the stored access token.
- `pub(super) fn auth::ensure_tokens() -> Result<(String,String)>` (`:20`): same checks as steps 1-3 without
  refresh and without the stderr line; **dead code** (no callers).
- `fn auth::apply_all_account_address_list(list: &[RefreshAccountItem])` (`:1223`): if `wallets.json` loads to
  `Some` (else silently no-op): `accounts = list.map(|a| {projectId: wallets.projectId, accountId, accountName,
  isDefault})`; `accountsMap` **cleared** then for each item `accountsMap[accountId] = {addressList:
  item.addresses.map(|x| {accountId: item.accountId, address, chainIndex, chainName, addressType, chainPath})}`;
  `save_wallets` (error ignored). `email/isNew/projectId/selectedAccountId/loginType` preserved (oracle test `:1539`).
- `pub(super) fn auth::attach_post_login_subscriptions(summary, snapshot)` (`:549`): inserts
  `postLoginSubscriptions = snapshot` into the summary object iff snapshot is `Some`.
- Login-flow internals (only used by `wallet login`, documented under that command): `build_login_url` (`:358`),
  `classify_poll` (`:390`), `resolve_social_login_timeout_secs` (`:439`), `poll_session_result` (`:448`),
  `try_open_browser` (`:505`), `is_browsable_url` (`:514`), `new_login_session` (`:542`), `complete_login`
  (`:697`), `save_verify_result` (`:866`), `fetch_and_save_account_list` (`:968`), post-login helpers
  (`:559-693`).

### 2.2 `wallet_api.rs` — `WalletApiClient` transport and endpoint wrappers

#### 2.2.1 Error type and envelope
- `struct ApiCodeError {code: String, msg: String, http_status: u16}` (`:12`), Display
  `Wallet API error (code=<code>): <msg>`.
- `fn handle_response(resp)` (`:1173`): read body text; HTTP ≥ 500 → Err
  `Wallet API server error (HTTP <s>): <raw body>`; body not JSON → Err
  `failed to parse wallet API response as JSON (HTTP <s>): <first 500 bytes>`; else `unwrap_wallet_envelope`.
  **HTTP 4xx with a JSON body is treated like 200** (envelope decides).
- `fn unwrap_wallet_envelope(http_status, body)` (`:721`): `code` is `"0"` (string) or `0` (number) → `Ok(body["data"])`
  (missing `data` → `null`). Otherwise `code_str` = string value / number text / JSON text of any other value
  (e.g. missing → `null`); `msg` = first **string** among `msg`, `errorMessage`, `error_message`, `message`,
  `detailMsg`; if none → stderr `[WalletAPI] no msg field in error response (HTTP <s>), raw body: <body>` and
  msg = compact body (if > 200 bytes: first 200 bytes + `…`). Then `augment_auth_error_msg` (client.rs:153): code
  `50114` → `<msg>. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` Returns
  `ApiCodeError{code_str, msg, http_status}`. An `executeResult:false` inside a code-0 envelope is **not** an error here.
- `pub(crate) fn is_invalid_token_error(e) -> bool` (`:644`): true if `e` is `ApiCodeError` with code in
  {`10001`,`10008`,`53017`,`130100031`}, or `e.to_string()` contains `code=<one of those>)`, or lowercase text
  contains `invalid access token` or `access token invalid`. (`code=100010)` does NOT match.)
- `pub(crate) async fn force_refresh_access_token() -> Result<String>` (`:679`): reads keyring blob;
  `refresh_token` missing/empty → Err `refresh_token missing — please run: onchainos wallet login`; calls
  `auth_refresh`; failure → Err `force-refresh failed: <Display of e>` (e.g. `force-refresh failed: Wallet API
  error (code=…): …`); stores `access_token` + `refresh_token`; **does not** apply `chainUpdated`. Also used by
  `ApiClient::new_async` (client.rs:246) for non-wallet (market etc.) commands.

#### 2.2.2 Transport functions (all: URL = `effective_base_url().trim_end_matches('/') + path [+ query]`)
| fn (line) | method | headers | DoH retry | invalid-token retry | notes |
|---|---|---|---|---|---|
| `post_public` (815) | POST json | anonymous | once after DoH failover on connect/timeout or failover-worthy response | no | connect/timeout without failover → Err context `Network unavailable — check your connection and try again`; other send error → `request failed` |
| `get_no_okheaders` (861) | GET | **none** (only reqwest defaults: UA, `accept: */*`) | yes | no | for gateway endpoints that 10008 on any `Ok-Access-*` header |
| `get_public` (1199) | GET + query | anonymous | yes | no | |
| `post_authed` (896) → `post_authed_with_headers` (910) | POST json | jwt (+extra) | yes | **yes**: on `is_invalid_token_error` → `force_refresh_access_token()` then one more attempt with fresh token | |
| `get_authed` (1242) → `get_authed_with_headers` (1256) | GET + query | jwt (+extra) | yes | yes | |
| `post_authed_no_retry_with_headers` (997, private) | POST json | jwt (+extra) | **no** (on connect/timeout: `doh.handle_failure()`, rebuild if proxy, then Err with the supplied "unknown result" context) | no | |
| `post_authed_mutation_no_retry[_with_headers]` (1047/1064) | as above | | no | no | context `Network result is unknown for this state-changing request. Query authoritative state before retrying.` |
| `post_authed_multipart[_with_headers]` (1082/1093) | POST multipart | jwt minus Content-Type (+extra) | no | no | send error context `wallet API request failed` |
| `post_authed_raw_with_headers` (1133) | POST raw bytes | jwt minus Content-Type, explicit `Content-Type` + `Content-Length` (+extra) | no | no | same context |
| `get_authed_bytes_with_headers` (1336) | GET | jwt (+extra) | yes (connect/timeout only) | no | if response `Content-Type` contains `application/json`: code ≠ 0 → Err `download failed (code=<c>): <msg or "unknown error">`, code 0 → **empty bytes**; else HTTP ≥ 400 → Err `download failed (HTTP <s>): <first 500 chars, trimmed>`; else raw bytes |

#### 2.2.3 Serde helpers for responses
`string_or_number` (`:31`: null→"", string, number→text, other → error `expected string or number, got …`),
`bool_or_int` (`:49`: null→false, bool, number→`as_i64()!=0` (non-integers → false)), `nullable_string` (`:66`),
`nullable_bool` (`:81`), `nullable_vec` (`:96`: null→[]). Plain `#[serde(default)]` fields accept *missing* but
**reject `null`** for `String`/`bool`/`Vec` (parse error).

Response structs (camelCase JSON names):
- `VerifyResponse` (`:140`) — required: `refreshToken`, `accessToken`, `sessionCert`, `encryptedSessionSk` (strings),
  `sessionKeyExpireAt` (string_or_number, required key), `projectId`, `accountId`, `accountName` (strings),
  `isNew` (bool_or_int, required key); optional: `saTeeId` (default ""), `addressList` (default [],
  `VerifyAddressInfo`), `allAccountAddressList` (default [], `RefreshAccountItem`), `loginInfo` (default; fields
  `email`, `nickname`, `username`, `loginType`, each default ""). Unknown keys (`teeId`, `apiKey`, `passphrase`) ignored.
- `VerifyAddressInfo` (`:184`): `accountId` (default ""), `address`, `chainIndex` (string_or_number),
  `chainName`, `addressType`, `chainPath` (default + nullable → "").
- `RefreshAccountItem` (`:198`): `accountId`, `accountName`, `isDefault` (default false), `addresses` (default []).
- `RefreshResponse` (`:209`): `refreshToken`, `accessToken`, `chainUpdated` (default false), `allAccountAddressList` (default []).
- `CreateAccountResponse` (`:220`): `projectId`, `accountId`, `accountName`, `addressList` (default []).
- `AccountListItem` (`:230`): `projectId`, `accountId`, `accountName`, `isDefault` (default false).
- `AddressListData` (`:251`): `{accounts: [ {accountId, addresses: [VerifyAddressInfo]} ]}` (other keys `accountCnt`,
  `validAccountCnt`, `addressCnt` ignored).
- `UnsignedInfoResponse` (`:451`): all fields optional; nullable strings `unsignedTxHash`, `unsignHash` (Solana),
  `unsignedTx`, `uopHash`, `hash`, `authHashFor7702`, `executeErrorMsg`, `signType`, `encoding`, `jitoUnsignedTx`,
  `eip712MessageHash`, `serviceCharge`, `serviceChargeSymbol`, `serviceChargeFeeTokenAddress`, `gasStationStatus`,
  `contractNonce`, `eoaNonce`, `defaultGasTokenAddress`; raw values `executeResult`, `extraData`, `user712Data`,
  `user7702Data`; nullable bools `gasStationUsed`, `gasStationFirstTimePrompt`, `needUpdate7702`, `hasPendingTx`,
  `insufficientAll`, `autoSelectedToken`, `gasStationDisabled`; `gasStationTokenList` (nullable vec of
  `GasStationToken {feeCoinId:u64 default 0, symbol, feeTokenAddress, serviceCharge, balance, sufficient, relayerId, context}`).
  Methods: `gs_status()` (`GasStationStatus::parse`: exact, case-sensitive `NOT_APPLICABLE|FIRST_TIME_PROMPT|
  PENDING_UPGRADE|REENABLE_ONLY|READY_TO_USE|INSUFFICIENT_ALL|HAS_PENDING_TX|NOT_SUPPORT_INTENTION`, else `Unknown`
  whose `as_str()` is ""); `has_sign_material()` = any of `hash`, `eip712MessageHash`, `unsignedTxHash`,
  `unsignedTx`, `authHashFor7702`, `jitoUnsignedTx` non-empty; `match_default_sufficient_token()` (default address
  non-empty and a `sufficient` token whose `feeTokenAddress` equals it ASCII-case-insensitively);
  `only_sufficient_token()` (exactly one sufficient token); `auto_pick_gas_token()` = default empty ? only_sufficient
  : match_default; `free_gas()` = `extraData.freeGas` is JSON `true`.
- `BroadcastResponse` (`:624`): nullable strings `pkgId`, `orderId`, `orderType`, `txHash`.

#### 2.2.4 Endpoint wrappers (every body below is compact JSON with sorted keys)
| fn (line) | request | response handling | class |
|---|---|---|---|
| `auth_refresh(rt)` (1429) | POST `/priapi/v5/wallet/agentic/auth/refresh` via `post_public`, body `{"refreshToken":rt}` | `data` must be array (`auth/refresh: expected data to be an array`), non-empty (`auth/refresh: data array is empty`), `data[0]` → `RefreshResponse` (`auth/refresh: failed to parse response`) | auth |
| `session_result(id)` (1449) | POST `/priapi/v5/wallet/agentic/auth/session/result` via `post_public`, body `{"authSessionId":id}` | array / non-empty checks (`session/result: …`); returns raw `data[0]`; pending = backend code `10018` (ApiCodeError) | auth |
| `account_create(at, projectId)` (1462) | POST `/priapi/v5/wallet/agentic/account/create` via `post_authed`, `{"projectId":…}` | `data[0]` → `CreateAccountResponse` (`account/create: …`) | state |
| `account_list(at, projectId)` (1487) | POST `/priapi/v5/wallet/agentic/account/list` via `post_authed`, `{"projectId":…}` | `data` array → `Vec<AccountListItem>` (`account/list: …`) | read |
| `account_address_list(at, ids)` (1511) | POST `/priapi/v5/wallet/agentic/account/address/list` via `post_authed`, `{"accountIds":[…]}` | `data[0]` → `AddressListData`, returns `.accounts` (`account/address/list: …`) | read |
| `balance_batch(at, ids_csv)` (1540) | GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch?accountIds=<csv, commas as %2C>` via `get_authed` | raw `data` | read |
| `balance_single(at, query)` (1552) | GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances` + caller query | raw `data` | read |
| `get_token_info(at, chainIndex:u64, token)` (1570) | POST `/priapi/v5/wallet/agentic/token/get-token-info`, `{"chainIndex":<number>,"source":0,"tokenAddress":…}` | raw `data` | read |
| `pre_transaction_unsigned_info(…)` (1591) | POST `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` via `post_authed_with_headers(trace_headers)`; body `{"amount","chainIndex":<number>,"chainPath","fromAddr","sessionCert","toAddr"}` + optional `contractAddr`, `inputData`, `unsignedTx`, `gasLimit`, `aaDexTokenAddr`, `aaDexTokenAmount`, `jitoUnsignedTx`, `enableGasStation:true` (only when `Some(true)`), `gasTokenAddress`, `relayerId` (only when `Some`) | `data[0]` → `UnsignedInfoResponse` (`unsignedInfo: …`) | state |
| `batch_pre_transaction_unsigned_info(at, elems, trace)` (1673) | `validate_batch_size("batch unsignedInfo", n)` (1..=5: `batch unsignedInfo: empty request array` / `…: backend allows up to 5 elements, got N`); POST `/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo`, body = JSON **array** built by `build_batch_unsignedinfo_body` (`:394`: per element required `chainPath, chainIndex(number), fromAddr, toAddr, amount, sessionCert` + optional `contractAddr, inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, transactionType`) | array; empty → `batch unsignedInfo: response data array is empty`; longer than request → `…: response length X exceeds request length Y`; each → `UnsignedInfoResponse` | state |
| `batch_support_chain_index_list(at)` (1716) | POST `/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList`, body `{}` | `parse_supported_chain_list` (`:364`): array of strings or integers → strings; else `batch supportChainIndexList: expected data to be an array` / `…: unexpected element <v>` | read |
| `report_plugin_info(at, p)` (1732) | POST `/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info`, `{"pluginParameter":p}` via `post_authed` | raw `data` | state |
| `broadcast_transaction(at, accountId, address, chainIndex, extraData, trace)` (1749) | POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` via no-retry, body `{"accountId","address","chainIndex":<string>,"extraData":<string>}`; network-unknown context `Broadcast result is unknown. Query transaction status before attempting another broadcast.` | `data[0]` → `BroadcastResponse` (`broadcast: …`) | **funds** |
| `batch_broadcast_transaction(at, elems, trace)` (1786) | `validate_batch_size("batch broadcast", n)`; POST `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction` no-retry, body array of `{"accountId","address","chainIndex","extraData"}` (`build_batch_broadcast_body` `:434`); context `Batch broadcast result is unknown. Query transaction status before attempting another broadcast.` | length must equal request (`batch broadcast: response length X does not match request length Y`) | **funds** |
| `gas_station_update_default_token(at, chainIndex, token, from)` (1825) | POST `/priapi/v5/wallet/agentic/gas-station/update-default-token`, `{"chainIndex","fromAddr","gasTokenAddress"}` (strings) | raw `data` | state |
| `gas_station_update(at, chainIndex, enable, from?)` (1850) | POST `/priapi/v5/wallet/agentic/gas-station/update`, `{"chainIndex","enabled":bool}` + `fromAddr` if Some | raw `data` | state |

Callers of the non-auth wrappers are documented in g06 (wallet core / transfer); they are listed here because the
wrappers live in this partition.

### 2.3 `keyring_store.rs` — credential blob

- Constants: service `SERVICE = "onchainos"` (`:16`), account/key `UNIFIED_KEY = "agentic-wallet"` (`:17`), env
  `ONCHAINOS_CREDENTIAL_STORE` (`:18`), env `ONCHAINOS_FORCE_FILE_KEYRING` (`:19`).
- The whole credential set is **one JSON object `{string: string}`** (serde `HashMap`, compact, random key order)
  stored as the single secret of entry (`onchainos`, `agentic-wallet`). Keys in use across the CLI:
  `access_token`, `refresh_token`, `session_key`, `pending_auth_session_id`, `pending_session_key:<authSessionId>`.
- `force_file_keyring()` (`:49`): true if `ONCHAINOS_CREDENTIAL_STORE` trimmed equals `file` case-insensitively; or
  `ONCHAINOS_FORCE_FILE_KEYRING` (trimmed) is `1` or `true` (case-insensitive) — when that env var is set it wins
  over the compile-time `option_env!("ONCHAINOS_FORCE_FILE_KEYRING")` (release builds: unset → false).
- `pub fn read_blob() -> Result<HashMap>` (`:79`):
  - forced → `file_keyring::read_blob()`, any error → Err `Credentials corrupted. Please login again: onchainos wallet login`.
  - Linux (`:94`): file first: non-empty → return; error → the same `Credentials corrupted…` error; empty/missing →
    OS keyring (kernel keyutils backend) read: non-empty → return; empty or error → `{}`.
  - macOS / Windows (`:117`): OS keyring first: non-empty → return; empty → fall through; error → **stderr**
    `Warning: OS keyring read failed (<e>), trying file fallback`; then file (errors → `Credentials corrupted…`).
  - OS read: `NoEntry` → `{}`; stored text not a JSON string map → error (`failed to parse keyring blob`).
- `fn write_blob(map)` (`:138`): forced → file only; Linux → write file (its result is returned) **and** best-effort
  OS write; macOS/Windows → OS write; on error **stderr** `Warning: OS keyring write failed (<e>), using file fallback`
  and write file.
- `pub fn get(key)` (`:182`): `read_blob()?`; missing → Err `keyring key '<key>' not found`.
  `get_opt(key)` (`:190`) = `get(key).ok()` (**corruption also yields None**).
  `set(key, v)` (`:194`), `delete(key)` (`:200`): `read_blob()?` (errors propagate) → modify → `write_blob`.
- `pub fn store(pairs)` (`:209`): `read_blob().unwrap_or_default()` (corrupt store is **overwritten from empty**) →
  insert all → `write_blob`. This is the login/refresh write path.
- `pub fn clear_all()` (`:220`): forced → `file_keyring::clear_all()` only; else best-effort OS delete (NoEntry ok,
  errors ignored) then `file_keyring::clear_all()`.
- OS backends (keyring crate 3.6.3, features apple-native / windows-native / linux-native): macOS generic password
  (service `onchainos`, account `agentic-wallet`); Windows Credential Manager generic credential; Linux kernel
  keyutils. Exact native encodings are crate-internal (see Open questions); the lite runtime may use the file
  store exclusively (equivalent to `ONCHAINOS_CREDENTIAL_STORE=file`).

### 2.4 `file_keyring.rs` — encrypted file store (byte-exact)

Files under `$ONCHAINOS_HOME` (default `~/.onchainos`, `home.rs:12`; env `ONCHAINOS_HOME` if non-empty):
`keyring.enc`, `machine-identity`.

- **Identity** (`machine_identity()`, `:46`): read `machine-identity` (`read_to_string`, **trimmed**; empty → error).
  If unreadable: generate `hex_lower(32 random bytes)` (64 chars, `:71`), persist (`:78`: ensure home dir (unix
  0700), write `machine-identity.tmp` (no trailing newline), chmod 0600 (unix), rename to `machine-identity`),
  then re-read; if still unreadable use the volatile identity.
- **Volatile identity** (`:91`): `"<machine_id>:<username>"`; machine_id = trimmed non-empty `/etc/machine-id` →
  `/var/lib/dbus/machine-id` → `/proc/sys/kernel/hostname` → (unix only) `gethostname()` → `"unknown-host"`;
  username = `$USER` → `$LOGNAME` → `"onchainos-user"`. (On Windows this is normally `unknown-host:onchainos-user`.)
- **KDF** (`derive_key`, `:147`): `scrypt(password = UTF-8 bytes of the identity *string* (the 64 hex chars, not
  decoded), salt = 32-byte file salt, log2 N = 15 (N = 32768), r = 8, p = 1, dkLen = 32)`.
  Node: `crypto.scryptSync(identity, salt, 32, {N:32768, r:8, p:1, maxmem: 64*1024*1024})` — **`maxmem` must be
  raised** (default 32 MiB fails). Oracle: identity `test-identity`, salt 32×`00` →
  `79351790853f0ba93b42778c644b59e5333d91b2e3cb1a847d37be138217be3c` (computed with Node).
- **File format** `keyring.enc` = `salt (32 random bytes) ‖ nonce (12 random bytes) ‖ AES-256-GCM(key, nonce,
  aad = empty, plaintext) ciphertext ‖ tag (16 bytes)`. Plaintext = `serde_json::to_string(HashMap<String,String>)`
  (compact, random key order).
- `write_blob(map)` (`:277`): ensure home dir (unix 0700 create/fix; non-unix create only); fresh salt+nonce each
  write; identity via `machine_identity()`; write `keyring.enc.tmp`, chmod 0600 (unix), rename → `keyring.enc`.
- `read_blob()` (`:218`): missing file → `{}`; chmod-fix 0600 (unix); length < 45 (32+12+1) → Err `keyring.enc is
  corrupted (too short)`; try decrypt with persisted identity (creating one if absent); on failure, if the
  volatile identity differs, try it and on success **re-encrypt** with the persisted identity (`write_blob`; failure
  → stderr `Warning: identity migration re-encrypt failed (<e>), will retry next read`); else Err
  `failed to decrypt keyring.enc (wrong machine or corrupted file)`. Decrypted bytes not a JSON string map → Err
  `failed to parse decrypted keyring blob`.
- `clear_all()` (`:310`): delete `keyring.enc` if it exists (`failed to delete keyring.enc` on error).
  **`machine-identity` survives** logout (test `:570`).

### 2.5 `crypto.rs` — primitives (byte-exact, Node recipes)

Base64 everywhere = standard alphabet **with** padding; decoding is strict/canonical (base64 crate `STANDARD`);
Node's `Buffer.from(s,'base64')` is lenient — validate if exact error parity matters.

#### 2.5.1 `generate_x25519_session_keypair() -> (session_private_key_b64, temp_pub_key_b64)` (`:20`)
32 bytes from OS RNG = X25519 static secret (stored **raw/unclamped**; clamping happens inside scalar mult);
public = X25519(sk, basepoint 9). Both base64 (44 chars). Node: `generateKeyPairSync('x25519')`; raw private =
last 32 bytes of PKCS#8 DER, raw public = last 32 bytes of SPKI DER. DER prefixes: X25519 PKCS#8
`302e020100300506032b656e04220420` + 32 bytes; X25519 SPKI `302a300506032b656e032100` + 32 bytes.

#### 2.5.2 `hpke_decrypt_session_sk(encrypted_b64, session_key_b64) -> [u8;32]` (`:39`)
RFC 9180, **mode_base (0x00)**, suite **DHKEM(X25519, HKDF-SHA256) = 0x0020, HKDF-SHA256 = 0x0001,
AES-256-GCM = 0x0002**, `info = "okx-tee-sign"` (ASCII, 12 bytes), `aad = ""` (empty), single-shot open (seq 0).
Steps & errors (in order):
1. base64-decode `encrypted_b64` (`encrypted_session_sk is not valid base64`); base64-decode `session_key_b64`
   (`session_key is not valid base64`); key length must be 32 (`session_key must be 32 bytes, got N`).
2. `len(encrypted) <= 32` → `encrypted_session_sk too short: N bytes (need > 32)`. Split `enc = [0..32)`
   (ephemeral X25519 public key pkE), `ct = [32..)` (ciphertext ‖ 16-byte tag).
3. Decap: `dh = X25519(skR, pkE)`; `pkRm = X25519(skR, 9)`; `kem_context = enc ‖ pkRm`;
   `suite_kem = "KEM" ‖ 0x0020`;
   `eae_prk = HKDF-Extract(salt = "" , ikm = "HPKE-v1" ‖ suite_kem ‖ "eae_prk" ‖ dh)`;
   `shared_secret = HKDF-Expand(eae_prk, info = I2OSP(32,2) ‖ "HPKE-v1" ‖ suite_kem ‖ "shared_secret" ‖ kem_context, 32)`.
4. Key schedule: `suite = "HPKE" ‖ 0x0020 ‖ 0x0001 ‖ 0x0002` (10 bytes);
   `LabeledExtract(salt, label, ikm) = HKDF-Extract(salt, "HPKE-v1" ‖ suite ‖ label ‖ ikm)`;
   `LabeledExpand(prk, label, info, L) = HKDF-Expand(prk, I2OSP(L,2) ‖ "HPKE-v1" ‖ suite ‖ label ‖ info, L)`;
   `psk_id_hash = LabeledExtract("", "psk_id_hash", "")`; `info_hash = LabeledExtract("", "info_hash", "okx-tee-sign")`;
   `ctx = 0x00 ‖ psk_id_hash ‖ info_hash` (65 bytes); `secret = LabeledExtract(shared_secret, "secret", "")`;
   `key = LabeledExpand(secret, "key", ctx, 32)`; `nonce = LabeledExpand(secret, "base_nonce", ctx, 12)`.
   (HKDF-Extract with empty salt = HMAC-SHA256 keyed with 32 zero bytes / empty key — equivalent.)
5. `plaintext = AES-256-GCM-Open(key, nonce, aad = empty, ct)`; failure → `HPKE decryption failed: <e>`.
   `len(plaintext) != 32` → `decrypted signing seed must be 32 bytes, got N`. Result = Ed25519 **seed**.
- **Test vector** (`auth/mod.rs:1639`, verified with node:crypto): `encrypted_b64 =
  D77ghrSZD4FhOjt8h6irNQS9OBxaq7Ry6LobgKyBuV4rPLTulIoZSsEt5pZYptfSFo8AX+XwIYw8RRJXPNRhRSJDno4F0CLdPNFeat16/90=`,
  X25519 private (hex) `7e0e4cb4ce949dcee0ca600713d37a0ecec71e3f20b7a834680ba2306e06c671` (pass as base64) →
  seed `d84197bf9417d10a74cfba304f487868bb41708623e1d61823df44c734cda122`. 30-byte input → error (too short).

#### 2.5.3 Ed25519
- `ed25519_sign(seed: &[u8], msg) -> Vec<u8>` (`:106`): seed must be 32 bytes (`session key must be 32 bytes, got N`);
  RFC 8032 pure Ed25519 (deterministic) → 64-byte signature. Node: key = PKCS#8 DER
  `302e020100300506032b657004220420` ‖ seed; `crypto.sign(null, msg, key)`.
  Oracle (computed with Node): seed 32×`2a`, msg = hex `abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789`
  → base64 `B2oQ7Dq/OUH/G6lZ7QLmDcxPAGCNPHUOFwXqAwJV6T/ab/E5rmZpDOUpVpdw5d/o/eTxexWlvjLLoW+O72dhBg==`.
- `ed25519_sign_encoded(msg, seed_b64, encoding) -> String` (`:124`): decode message first:
  `hex` → strip one leading `0x`; empty → return `""` (no signature); `hex::decode` (case-insensitive, odd length
  rejected) error → `failed to decode hex message: <e>`; `base64` → empty → `""`, decode error →
  `failed to decode base64 message: <e>`; `base58` (bitcoin alphabet) → empty → `""`, error →
  `failed to decode base58 message: <e>`; other → `unsupported encoding: <enc>, expected hex/base64/base58`.
  Then decode seed (`session_key is not valid base64`, `session_key must be 32 bytes, got N`), sign the decoded
  bytes, return base64 signature.
- `ed25519_sign_hex(hex, seed_b64)` (`:170`) = `ed25519_sign_encoded(hex, seed_b64, "hex")`
  (`0xaabb` ≡ `aabb`; `""`/`0x` → `""`).
- `ed25519_sign_eip191(msg, seed: &[u8], encoding) -> String` (`:278`): `msg == ""` → `""`. `hex` → strip `0x`,
  hex-decode (`msg is not valid hex: <e>`; note `"0x"` → 0 data bytes, still signed); `utf8` → UTF-8 bytes; other →
  `unsupported encoding for eip191: <enc>, expected "hex" or "utf8"`. `m = "\x19Ethereum Signed Message:\n" ‖
  decimal(len(data)) ‖ data`; `h = keccak256(m)` (original Keccak, pad 0x01, **not** SHA3-256 — Node has no
  built-in keccak; use pure JS); return base64(Ed25519_sign(seed, h)) (the 32-byte hash is signed, not `m`).
  Oracle: utf8 `hello` → h = `50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750`.

#### 2.5.4 `secp256k1_sign(private_key, hash32) -> 65 bytes` (`:182`)
Errors: `private key must be 32 bytes, got N`; `message hash must be 32 bytes, got N`; invalid scalar (0 or ≥ n)
→ `invalid secp256k1 private key: <e>`. ECDSA over secp256k1 on the **prehash** (no extra hashing), nonce **RFC 6979
(HMAC-SHA256, no extra entropy)**, **low-S normalised** (s > n/2 → s = n − s, flipping the recovery bit).
Self-check: recovered address must equal signer (`signature verification failed: recovered X but expected Y`).
Output `r(32 BE) ‖ s(32 BE) ‖ v` with `v ∈ {0,1}` (y-parity of R).

#### 2.5.5 EIP-3009 / EIP-712 — `eip3009_sign(auth, domain, private_key) -> base64(65)` (`:248`)
- `DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`;
  `domainSeparator = keccak256(DOMAIN_TYPEHASH ‖ keccak256(utf8 name) ‖ keccak256(utf8 version) ‖ u256(chainId) ‖ pad32(verifyingContract))`.
- `TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`;
  `structHash = keccak256(TYPEHASH ‖ pad32(from) ‖ pad32(to) ‖ u256(value) ‖ u256(validAfter) ‖ u256(validBefore) ‖ nonce32)`.
- `digest = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ structHash)`; `sig = secp256k1_sign(pk, digest)`;
  `sig[64] += 27` (→ 27/28); return base64 of the 65 bytes.
- Oracles (`crypto.rs:494-809`, hex of decoded signature): e.g. TV2 — pk
  `ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`, from
  `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, value 1000000,
  validAfter 0, validBefore 2^256−1, nonce 32×`00`, domain {`USD Coin`, `2`, 1,
  `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`} → digest
  `e5e5f84b57f35c2ee0e66b2901522c04eac882bac56b769e07d210b819e62c4c` → sig
  `9c7cc05c1539ce2fee00de51df7e0a13696469b2dd1bb112832d8fe19715aaab416f67528f2f176e837c0b950149c2211a7651b90a62d22c9ecc27c1ebf0b2631b`
  (verified in pure JS). The other nine vectors (TV1, TV3–TV10 + `cross_validates_with_reference_sdk`) are in
  `crypto.rs` and should be copied into the lite test-suite.
- General EIP-712 for `wallet sign-message --type eip712` is **not** computed locally: the backend returns the hash
  (`gen-msg-hash` / `eip712MessageHash`) which is Ed25519-signed (sign.rs, g06).

Callers (for orientation; owned elsewhere): transfer/broadcast/gas_station (`ed25519_sign_eip191(unsigned.hash,…,"hex")`
for `hash`, `ed25519_sign_hex(authHashFor7702)`, `ed25519_sign_encoded(unsignedTxHash|unsignHash|jitoUnsignedTx,
encoding)`), sign.rs, payment (dispatcher/payment_flow/a2a_pay: `ed25519_sign(seed, msg_hash_bytes)`;
`eip3009_sign` for local keys), permit2 (`secp256k1_sign`, `ed25519_sign_eip191`), strategy, agent identity/task signing.

### 2.6 `wallet_store.rs` — on-disk state (`$ONCHAINOS_HOME`)

All writers: `ensure_onchainos_home()` (create dir, unix 0700) → `serde_json::to_string_pretty(struct)` (2-space
indent, no trailing newline) → write `<name>.json.tmp` → rename. (No explicit chmod; startup self-heal sets 0600 on
`wallets.json`/`session.json`.) Readers: missing file → `None`/default; read error → `failed to read <name>`;
parse error → `failed to parse <name>` (context, then serde message).

| file | struct (line) | exact serialised field order | notes |
|---|---|---|---|
| `wallets.json` | `WalletsJson` (14) | `email`, `isNew`, `projectId`, `selectedAccountId`, `accountsMap` {accountId → `{"addressList":[AddressInfo…]}`}, `accounts` [AccountInfo…], `loginType` | every field `#[serde(default)]` on read; `accountsMap` random key order |
| — | `AddressInfo` (40) | `accountId`, `address`, `chainIndex`, `chainName`, `addressType`, `chainPath` | `address`, `chainIndex` required on read |
| — | `AccountInfo` (55) | `projectId`, `accountId`, `accountName`, `isDefault` | first three required on read |
| `session.json` | `SessionJson` (130) | `saTeeId`, `sessionCert`, `encryptedSessionSk`, `sessionKeyExpireAt`, `deviceId` | all default ""; `deviceId` written by `device/id.rs` on first HTTP request |
| `cache.json` | `CacheJson` (67) | `login`? (`{"email","flowId"}`), `swapTraceId`? | both omitted when None; `{}` when empty |
| `balance_cache.json` | `BalanceCacheJson` (92) | `batch_updated_at`, `accounts` {accountId → `{"updated_at","data","total_value_usd"}`} | snake_case; `data` is a Value (sorted keys) |
| `chain_cache.json` | `ChainCacheJson` (115) | `updated_at`, `chains` [Value…] | |

Functions: `load_wallets`/`save_wallets`/`delete_wallets` (179/189/199); `load_cache`/`save_cache`/`delete_cache`
(209/219/229); `clear_login_cache` (238: load → `login=None` → save, **creates `cache.json` if absent**);
`set_swap_trace_id`/`get_swap_trace_id`/`clear_swap_trace_id` (245/252/258); `load_balance_cache`/
`save_balance_cache`/`delete_balance_cache` (266/277/287); `get_batch_balance_cache(ttl)` (297: None if no
accounts or `now − batch_updated_at >= ttl`); `set_batch_balance_cache(entries)` (310: sets `batch_updated_at=now`,
inserts/overwrites, never prunes); `get_account_balance_cache` / `set_account_balance_cache` (321/338);
`load_chain_cache`/`save_chain_cache`/`get_chain_cache(ttl)`/`set_chain_cache(chains)` (346/357/368/381);
`load_session`/`save_session`/`delete_session` (391/401/411). Delete fns are no-ops when the file is missing;
errors `failed to delete <name>`.

### 2.7 `account.rs` helpers
- `pub(super) fn switch_to_account(account_id) -> Result<()>` (`:14`): `""` → Err `account id is required`; no
  wallets.json → `not logged in`; `accountsMap` lacks the id → `account not found`; set `selectedAccountId`, save.
- `pub fn resolve_active_account_id(wallets) -> Result<String>` (`:403`): non-empty `selectedAccountId` → it; else
  first `accounts[]` entry with `isDefault` → its id; else **first key of `accountsMap`** (random order); else Err
  `no wallet accounts found`.
- `pub fn resolve_account_address_for_chain(wallets, chain_index) -> Result<String>` (`:445`): active account's
  `accountsMap` entry (`account not found`); first address with exact `chainIndex` and non-empty address; else if
  `chains::is_evm_chain(chain_index)` (chain_cache `isEvmChain` if present, else static list `1,10,56,137,196,250,
  324,1952,8453,42161,43114,59144,…`) → first address whose chain is also EVM; else Err
  `no address for chain "<idx>" on the selected account` (Tron 195 / TON 607 / BTC 0 / unknown never fall back).
- `fn build_wallet_status_summary` (`:194`) and `async fn query_policy` (`:381`): see `wallet status`.

### 2.8 `common.rs` helpers and the confirmation protocol
- `pub const ERR_NOT_LOGGED_IN = "not logged in"` (`:1`).
- `pub(crate) struct WalletPreviewConfirming {message, next, scene, preview: Value}` (`:5`), Display
  `confirming: <message>`. Handlers return it (as an `Err`) when a write needs explicit user approval and `--force`
  was not given; `main.rs:249` prints `{"confirming":true,"scene":<scene>,"message":<message>,"preview":<preview>,
  "next":<next>}` (struct order, `message`/`next` omitted if empty, `preview` keys sorted) and exits **2**. The agent
  shows `preview`, asks the user, and on approval runs the command in `next` (always the same command + `--force`,
  built by the handler). MCP (`mcp/mod.rs:880`) returns the same object as a JSON error string with keys sorted.
  Scenes used by callers (owned elsewhere): `btc_transfer`, `brc20_transfer`, `sui_transfer`, `btc_inscription`,
  `btc_utxo_reclaim`, UTXO manage scenes (e.g. `btc_utxo_manage`).
- `pub(crate) fn handle_confirming_error(e, force) -> anyhow::Error` (`:67`): `ApiCodeError` with code `81362` and
  `!force` → `CliConfirming{message: <backend msg>, next: "If the user confirms, re-run the same command with --force
  flag appended to proceed.", scene: None}` → stdout `{"confirming":true,"message":<msg>,"next":"If the user confirms,
  re-run the same command with --force flag appended to proceed."}` exit 2. With `force`, or any other code → the
  `ApiCodeError` itself (error text `Wallet API error (code=<c>): <msg>`, exit 1). Non-API errors pass through.
- `pub(super) fn mask_email(email)` (`:30`): split at first `@`; local part (by chars) len 0 → `***@dom`; 1–2 →
  `<c0>***@dom`; ≥3 → `<c0>***<clast>@dom`; no `@` → `***`. (`user@example.com` → `u***r@example.com`.)
- `pub(crate) fn is_hex_string(v, len)` (`:50`): `^0x[0-9A-Fa-f]*$`; if `len = Some(n>0)` also `v.len() == 2+2n`.

### 2.9 Helpers named only (owned elsewhere)
- `balance::login_account_summary(client, at, wallets, account_id)` (balance/mod.rs:522): `{"accountName",
  "evmAddress","solAddress","btcAddress","suiAddress","accountCount","totalValueUsd"}` — name from `accounts`;
  evm = first address whose `chain_family(chainIndex)=="evm"` (i.e. **any chainIndex ≠ "501"**), sol = `501`, btc =
  `0`|`5`, sui = `784` (each "" if absent); `accountCount = max(len(accounts), len(accountsMap))`; `totalValueUsd` =
  `format!("{:.2}")` of the USD sum from one GET `wallet-all-token-balances-batch?accountIds=<accountsMap keys joined
  ",">` (also rewrites `balance_cache.json` entries), `""` if `accountsMap` empty or the call fails.
- `chain::force_refresh_chain_cache()` (chain.rs:114), `chain::get_all_chains()` (chain.rs:31, TTL 600 s,
  POST `/priapi/v5/wallet/agentic/chain/support/list` `{}` anonymous), `chain_profile::resolve(input)`
  (chain_profile.rs:50, errors like `unsupported chain: <input>`).
- `agent_commerce::chat::fetch_heartbeat(client, at, chainIndex)` (chat/mod.rs:370): POST
  `/priapi/v5/wallet/agentic/agent-heartbeat` `{"chainIndex":196}` via `post_authed` (device upsert keyed by the
  `device-id`/`device-name` headers).
- `agent_commerce::task::user::{resolve_post_login_agentic_id, prepare_post_login_subscriptions,
  finalize_post_login_subscriptions}` (task/user/mod.rs:1655/1687/1731): resolve spawns
  `<current_exe> agent get-my-agents --owner-address <xlayer addr> --role user --page-size 100` (subprocess →
  GET `/priapi/v5/wallet/agentic/agent/agent-list`); prepare reads GET `/priapi/v5/wallet/agentic/agent/device-list`
  and `$ONCHAINOS_HOME/subscription-device-routing-pending/<sha256>.pending` markers; finalize reads
  `/priapi/v1/aieco/task/subscribe/my`, may POST `/priapi/v1/aieco/task/subscribe/device/batchUpdate`, and returns
  `{"activeSubscriptionCount":N}` or None. Specified by the agent partitions (g11/g12/g13).
- `audit::log` (audit.rs:140), `payment_cache::PaymentCache::delete` (`payment_cache.json`),
  `payment::subscription::cache::SubscriptionCache::delete` (`subscriptions.json`), `open::that_detached(url)`
  (system browser opener), `device::id::get_cached_device_id`, `device::name::get_cached_device_name`.
- `ApiClient` (client.rs, core): non-wallet commands use `Jwt(access_token)` when a non-empty access token exists in
  the keyring (sync `new()`: no expiry check) or `new_async()` (expired access + valid refresh →
  `force_refresh_access_token`; refresh expired → stderr `Session expired. Please log in again: onchainos wallet
  login` and anonymous; refresh failure → stderr `Failed to refresh session (<e>). Falling back to anonymous access.`).

---

## Commands

Dispatch: `commands/agentic_wallet/mod.rs:595 execute`. Every wallet leaf also accepts the global `--chain <CHAIN>`
(ignored by all commands below except `addresses`, whose own `--chain` shadows it) and the hidden global `--dev`.

### `onchainos wallet login`  (hidden: no)
- Handler: `mod.rs:597-610` → `auth::cmd_login_init` (`auth/mod.rs:761`) | `auth::cmd_login_open` (`:814`) |
  `auth::cmd_login_poll` (`:831`).
- Options (clap, `mod.rs:44-55`):
  - `--phase <PHASE>`: `ValueEnum` `init` | `open` | `poll`, default `init`. Invalid → clap error exit 2.
  - `--url <URL>`: optional string; required (runtime check) for `--phase open`; ignored otherwise.
  - `--session-id <SESSION_ID>`: optional string; used by `poll` (empty string treated as absent); ignored otherwise.
  - Env: `ONCHAINOS_NO_BROWSER` (presence, any value → never open a browser), `SOCIAL_LOGIN_TIMEOUT_SECS`
    (poll timeout, u64 ≥ 10, else 300), `ONCHAINOS_HOME`, `ONCHAINOS_CREDENTIAL_STORE`, `ONCHAINOS_FORCE_FILE_KEYRING`.
- Auth: anonymous (`session/result` is public; the login is proven by possession of the X25519 private key that
  decrypts `encryptedSessionSk`). Post-login calls use the new JWT.

**Phase `init`** (default; also bare `onchainos wallet login`):
1. `prev = keyring.get_opt("pending_auth_session_id")`; if non-empty → `keyring.delete("pending_session_key:"+prev)`
   (errors ignored).
2. `auth_session_id = uuid v4` (lowercase, hyphenated); `(sk_b64, pk_b64) = generate_x25519_session_keypair()`.
3. `login_url = base_url().trim_end_matches('/') + "/account/sociallogin?" + form_urlencoded(
   authSessionId=<id>, tempPubKey=<pk_b64>, clientType=agent-cli)` — e.g.
   `https://web3.okx.com/account/sociallogin?authSessionId=3f2a…&tempPubKey=AB%2B%2F…%3D&clientType=agent-cli`
   (`+`→`%2B`, `/`→`%2F`, `=`→`%3D`).
4. `keyring.store([("pending_auth_session_id", id), ("pending_session_key:"+id, sk_b64)])` (error → exit 1).
5. `opened = is_browsable_url(url) (scheme http|https) && !ONCHAINOS_NO_BROWSER && open::that_detached(url).is_ok()`.
   **Note:** despite the `Init` doc-comment ("No browser"), init *does* try to open the browser.
6. No HTTP request is made.
- Output `data` (sorted): `{"authSessionId":<id>,"loginUrl":<url>,"nextSteps":{"completeLogin":"onchainos wallet login
  --phase poll --session-id <id>","displayLoginUrl":<url>,"openLoginUrl":<url> (only when opened=false),
  "requiredOrder":["displayLoginUrl","completeLogin"]},"opened":<bool>}`.

**Phase `open`**:
1. `--url` missing → Err with text `` `--url` is required for `--phase open` `` (raised in `mod.rs:605`, before the handler).
2. Not parseable as URL or scheme ∉ {http, https} → Err `` `--url` must be an http(s) URL ``.
3. `opened = !ONCHAINOS_NO_BROWSER && open::that_detached(url).is_ok()`. Output `{"opened":<bool>}`. No HTTP, no state.

**Phase `poll`**:
1. `auth_session_id = --session-id` if non-empty, else `keyring.get_opt("pending_auth_session_id")` non-empty,
   else Err `no login in progress — run \`onchainos wallet login --phase init\` first`.
2. `sk_b64 = keyring.get_opt("pending_session_key:"+id)` non-empty, else Err
   `no login in progress for this session — run \`onchainos wallet login --phase init\` first`.
   (Keyring corruption also lands here because `get_opt` swallows errors.)
3. `WalletApiClient::new()`; **poll loop** (`poll_session_result`, `:448`): `deadline = now + timeout`
   (`SOCIAL_LOGIN_TIMEOUT_SECS` parsed as u64, used only if ≥ 10, else 300 s); `transient = 0`; loop:
   - POST `/priapi/v5/wallet/agentic/auth/session/result` body `{"authSessionId":<id>}` (anonymous headers, DoH retry).
   - classify: `Ok(data0)` with non-empty string `accessToken` → **Ready** (exit loop); `Ok` otherwise → Pending;
     `Err(ApiCodeError code "10018")` → Pending; `Err` without code (transport, HTTP ≥ 500, non-JSON, `data` not an
     array / empty array) → Transient; `Err(ApiCodeError other code)` → **Terminal** → return
     `format_api_error(e)` = `code=<code> msg=<msg>`.
   - Pending → `transient = 0`. Transient → `transient += 1`; if `transient >= 5` → return the error (unchanged text).
   - if `now >= deadline` → Err `login timed out waiting for the result. The login link is still valid — finish login
     in the browser, then check the result again (\`onchainos wallet login --phase poll\`), or start a fresh login
     (\`onchainos wallet login --phase init\`)`; else sleep **2 s** and repeat (first request is immediate).
4. Parse `data[0]` as `VerifyResponse` (§2.2.3); failure → Err `social login: failed to parse result: <serde msg>`.
   `email = loginInfo.email`, `login_type = loginInfo.loginType`.
5. `save_verify_result` (`:866`), in order (each `?` aborts with exit 1, earlier writes are kept):
   a. If an existing `wallets.json` has a non-empty `email` different from the new one → `audit::log("cli",
      "login_account_switch", true, 0, ["previous_email=<mask_email(prev)>", "new_email=<mask_email(new)>",
      "login_type=<loginType>"], None)`.
   b. `save_wallets({email, isNew, projectId, selectedAccountId: accountId, accountsMap: {}, accounts: [], loginType})`
      (**overwrites** the file; previous accounts are dropped).
   c. `delete_balance_cache()`.
   d. `session = load_session() (errors/absent → default)`; set `saTeeId`, `sessionCert`, `encryptedSessionSk`,
      `sessionKeyExpireAt` (number → decimal string); keep `deviceId`; `save_session`.
   e. `keyring.store([("refresh_token", rt), ("access_token", at), ("session_key", sk_b64)])`.
   f. If `allAccountAddressList` is empty → `fetch_and_save_account_list` (`:968`, all failures silent):
      POST `/priapi/v5/wallet/agentic/account/list` `{"projectId":<projectId>}` (Bearer new at) → `accounts =
      items.map({projectId, accountId, accountName, isDefault})`, save; then POST
      `/priapi/v5/wallet/agentic/account/address/list` `{"accountIds":[…in account/list order]}` → for each account
      `accountsMap[accountId] = {addressList: addresses.map({accountId: item.accountId, address, chainIndex,
      chainName, addressType, chainPath})}`, save. Else `apply_all_account_address_list(list)` (§2.1, no HTTP).
   g. `clear_login_cache()` (writes `cache.json`, `{}` if nothing else there).
6. Post-login setup (all best-effort, never fails login): `prep_deadline = now + 4 s`, `setup_deadline = now + 15 s`.
   - `agentic_id = resolve_post_login_agentic_id()` bounded by `prep_deadline` (spawns `onchainos agent
     get-my-agents …`, §2.9); trimmed, empty → None.
   - If `agentic_id`: `prepare_post_login_subscriptions(agentic_id)` bounded by `prep_deadline`.
   - **Always**: device heartbeat POST `/priapi/v5/wallet/agentic/agent-heartbeat` `{"chainIndex":196}` with
     `Authorization: Bearer <new access token>` (plus device headers), 4 s timeout; result → `device_registration_succeeded`.
   - If prepared: `finalize_post_login_subscriptions(prepared, succeeded)` bounded by `setup_deadline` →
     `Some({"activeSubscriptionCount":N})` or None.
7. Summary: `wallets = load_wallets()?.unwrap_or_default()`; `summary = login_account_summary(client, at, wallets,
   accountId)` (§2.9; one GET `wallet-all-token-balances-batch`, rewrites `balance_cache.json`); insert
   `accountId`, `loginType`, `email`, `isNew`; insert `postLoginSubscriptions` if Some.
8. Print success, then cleanup: `keyring.delete("pending_session_key:"+id)`; if `pending_auth_session_id == id` →
   `keyring.delete("pending_auth_session_id")` (errors ignored). On any failure before this point the pending
   state is kept, so `poll` can be re-run.
- Output `data` (poll, keys sorted): `{"accountCount":<int>,"accountId":<str>,"accountName":<str>,"btcAddress":<str>,
  "email":<str>,"evmAddress":<str>,"isNew":<bool>,"loginType":<str>,"postLoginSubscriptions"?:{"activeSubscriptionCount":<int>},
  "solAddress":<str>,"suiAddress":<str>,"totalValueUsd":"<x.xx>"|""}`.
- Errors (exit 1): see messages above; keyring/filesystem errors propagate with their context text.
- Side effects: init/open — local keyring only; poll — **auth** (server issues session/tokens; consumes the
  one-time auth session), local writes: `wallets.json`, `session.json`, keyring, `cache.json`,
  `balance_cache.json` (deleted then rewritten), audit line(s); server device upsert
  (heartbeat) and possibly subscription device routing. No funds.
- Nondeterminism: `authSessionId` (UUIDv4), X25519 keypair → `tempPubKey` in URL, `opened` (environment),
  poll timing/number of `session/result` calls, `totalValueUsd`, `isNew`, account data, HashMap order of
  `accountIds` in the balance query, whether post-login steps finish within deadlines.
- Parity test cases:
  1. `ONCHAINOS_NO_BROWSER=1 onchainos wallet login` → no HTTP; data shape as above with `opened:false` and
     `openLoginUrl` present (SAFE; normalise uuid/key).
  2. `onchainos wallet login --phase open` → `{"ok":false,"error":"`--url` is required for `--phase open`"}` exit 1 (SAFE).
  3. `ONCHAINOS_NO_BROWSER=1 onchainos wallet login --phase open --url file:///etc/passwd` → `` `--url` must be an http(s) URL `` exit 1 (SAFE).
  4. fresh `ONCHAINOS_HOME`, `onchainos wallet login --phase poll` → `no login in progress — run \`onchainos wallet login --phase init\` first` (SAFE, no HTTP).
  5. after init, `SOCIAL_LOGIN_TIMEOUT_SECS=10 onchainos wallet login --phase poll` without completing the browser
     step → ~6 POSTs of `auth/session/result` (t≈0,2,4,6,8,10 s) then the timeout error (SAFE).

### `onchainos wallet add`  (hidden: no)
- Handler: `auth::cmd_add` (`auth/mod.rs:1043`).
- Options: none (global `--chain` ignored).
- Auth: jwt-required (`ensure_tokens_refreshed`).
- Steps:
  1. `at = ensure_tokens_refreshed()` (§2.1; may POST `auth/refresh`).
  2. `wallets.json` absent or `projectId == ""` → Err `not logged in`.
  3. POST `/priapi/v5/wallet/agentic/account/create` `{"projectId":<projectId>}` (`post_authed`, token-retry) →
     `CreateAccountResponse`; errors via `format_api_error` (`code=<c> msg=<m>`).
  4. `wallets = load_wallets()?.unwrap_or_default()`; push `{projectId: resp.projectId, accountId, accountName,
     isDefault:false}` to `accounts`; `accountsMap[accountId] = {addressList: resp.addressList.map({accountId:
     resp.accountId, address, chainIndex, chainName, addressType, chainPath})}`; save.
  5. POST `/priapi/v5/wallet/agentic/account/list` `{"projectId":<projectId>}`; success → reload wallets, replace
     `accounts` with the list, save; failure ignored.
  6. `switch_to_account(resp.accountId)` → `selectedAccountId = new id`, save.
- Output `data`: `{"accountId":<str>,"accountName":<str>,"addressList":[{"address":<str>,"chainIndex":<str>,"chainName":<str>}…]}`
  (address list in response order; `chainIndex` always a string).
- Errors: `session expired, please login again: onchainos wallet login`; `Credentials corrupted. Please login again:
  onchainos wallet login`; `not logged in`; `code=<c> msg=<m>`; parse errors `account/create: …`.
- Side effects: state-changing (server creates a new sub-account/addresses); local `wallets.json`; possibly keyring
  (refresh). No funds.
- Nondeterminism: new account id/name/addresses.
- Parity test cases: 1. logged-out home → `session expired, please login again: onchainos wallet login` (SAFE, no
  HTTP). 2. logged-in → `onchainos wallet add` (UNSAFE: creates a server-side account).

### `onchainos wallet switch <ACCOUNT_ID>`  (hidden: no)
- Handler: `account::cmd_switch` (`account.rs:48`) → `switch_to_account` (`:14`).
- Options: positional `ACCOUNT_ID` (required string).
- Auth: none (local only; no token/session check).
- Steps: `switch_to_account(id)` (§2.7). No HTTP.
- Output: `{"ok":true}`.
- Errors: `account id is required` (empty string), `not logged in`, `account not found`, file read/parse/write errors.
- Side effects: local-only (`wallets.json.selectedAccountId`).
- Nondeterminism: none (file `accountsMap` order may change on rewrite).
- Parity test cases: 1. no wallets.json: `onchainos wallet switch abc` → `{"ok":false,"error":"not logged in"}` (SAFE).
  2. existing account id → `{"ok":true}` (SAFE, local). 3. `onchainos wallet switch ""` → `account id is required` (SAFE).

### `onchainos wallet status`  (hidden: no)
- Handler: `account::cmd_status` (`account.rs:218`).
- Options: hidden `--include-subscriptions` (bool flag, `hide = true`, legacy no-op).
- Auth: jwt-optional (only the policy query uses the JWT).
- Steps:
  1. `wallets.json` absent → success `{"accountCount":0,"currentAccountId":"","currentAccountName":"","email":"","loggedIn":false}` (no `loginType`/`policy` keys), done.
  2. `session = load_session()?` (parse errors propagate) default if absent; `blob = keyring.read_blob()?`
     (corruption → `Credentials corrupted. Please login again: onchainos wallet login`).
  3. `loggedIn = !is_session_key_expired(session.sessionKeyExpireAt) && blob.refresh_token non-empty &&
     !is_token_expired(refresh_token)` (no 60 s margin here).
  4. `currentAccountName` = name of the `accounts[]` entry whose id == `selectedAccountId`, else "".
  5. If `loggedIn && selectedAccountId != ""` → `query_policy`: `ensure_tokens_refreshed()` (may POST
     `auth/refresh`) then GET `/priapi/v5/wallet/agentic/policy/query?accountId=<selectedAccountId>` (`get_authed`)
     → `data[0]` or `null`; **any error → `null`** (swallowed). Else `policy = null`.
- Output `data`: `{"accountCount":len(accounts),"currentAccountId":<selectedAccountId>,"currentAccountName":<str>,
  "email":<str>,"loggedIn":<bool>,"loginType":<str>|null,"policy":<data[0] passthrough, keys sorted>|null}`;
  `loginType` is null when not logged in or empty.
- Errors: session.json/wallets.json parse errors, keyring corruption (exit 1).
- Side effects: read-only (may rotate tokens via refresh → keyring write).
- Nondeterminism: `policy` content, token expiry state.
- Parity test cases: 1. empty home → exact output above (SAFE). 2. logged-in → one GET `policy/query` (SAFE).
  3. `onchainos wallet status --include-subscriptions` → same as 2 (SAFE).

### `onchainos wallet addresses`  (hidden: no)
- Handler: `account::cmd_addresses` (`account.rs:316`).
- Options: `--chain <CHAIN>` (optional; chain name, alias or index; shadows the global `--chain`).
- Auth: none (reads local `wallets.json`; no session/token check).
- Steps:
  1. no wallets.json → Err `not logged in`.
  2. `account_id = resolve_active_account_id(wallets)?` (§2.7); `accountsMap[account_id]` missing → `account not found`.
  3. `accountName` = matching `accounts[]` name or "".
  4. `--chain` given → `chain_profile::resolve(input)` (chain cache ≤600 s old, else POST
     `/priapi/v5/wallet/agentic/chain/support/list` `{}` anonymous and rewrite `chain_cache.json`); filter =
     resolved `chainIndex` (string equality).
  5. For each address in stored order (after filter): item `{"address","chainIndex","chainName"}`; bucket by
     `chainIndex`: `"0"`→`bitcoin`, `"784"`→`sui`, `"196"`→`xlayer`, `"501"`→`solana`, anything else → `evm`.
- Output `data`: `{"accountId":<str>,"accountName":<str>,"bitcoin":[…],"evm":[…],"solana":[…],"sui":[…],"xlayer":[…]}`.
- Errors: `not logged in`, `account not found`, `no wallet accounts found`, chain resolution errors (e.g.
  `unsupported chain: <input>`), network errors when the chain list must be fetched.
- Side effects: read-only (may write `chain_cache.json`).
- Nondeterminism: none beyond the random `accountsMap` fallback when no account is selected/default.
- Parity test cases: 1. empty home → `not logged in` (SAFE). 2. logged-in `onchainos wallet addresses` (SAFE, no
  HTTP). 3. `onchainos wallet addresses --chain solana` with a stale/absent chain cache → one POST chain/support/list (SAFE).

### `onchainos wallet logout`  (hidden: no)
- Handler: `auth::cmd_logout` (`auth/mod.rs:1176`).
- Options: none.
- Auth: none. **No server call** (tokens are not revoked server-side).
- Steps (each `?` aborts): `keyring_store::clear_all()` (§2.3); delete `session.json`, `wallets.json`, `cache.json`,
  `balance_cache.json`, `payment_cache.json`, `subscriptions.json` (each only if present). Kept: `machine-identity`,
  `chain_cache.json`, `doh-cache.json`, `audit.jsonl`, `config.json`, task/watch state, routing markers.
- Output: `{"ok":true}`.
- Errors: `failed to delete <file>: <io error>`, keyring errors (`failed to delete keyring.enc`).
- Side effects: local-only (destroys the local session). Nondeterminism: none.
- Parity test cases: 1. empty home → `{"ok":true}` (SAFE). 2. after login → `{"ok":true}` and the files above are gone (SAFE).

### `onchainos wallet geoblock`  (hidden: no)
- Handler: `geoblock::cmd_check` (`geoblock.rs:5`).
- Options: none.
- Auth: anonymous and **header-less** (`get_no_okheaders`: no `ok-client-version`/`Ok-Access-*`/`device-*`,
  no Content-Type; only reqwest defaults incl. the User-Agent).
- Steps: GET `/priapi/v5/wallet/agentic/geoblock/check` (DoH retry) → envelope → `data[0].blocked` must be a JSON bool.
- Output: **bare** `{"blocked":true}` or `{"blocked":false}` + `\n` (no `ok`/`data` envelope), exit 0.
- Errors: missing/non-bool → `{"ok":false,"error":"malformed response: missing data[0].blocked"}` exit 1;
  envelope errors `Wallet API error (code=<c>): <m>`; network errors. (Skills treat any non-zero exit as blocked.)
- Side effects: read-only. Nondeterminism: depends on caller IP/region.
- Parity test cases: 1. `onchainos wallet geoblock` → one header-less GET (SAFE).

### `onchainos wallet report-plugin-info`  (hidden: no)
- Handler: `plugin::cmd_report_plugin_info` (`plugin.rs:9`).
- Options: `--plugin-parameter <PLUGIN_PARAMETER>` (required string).
- Auth: jwt-required.
- Steps: `plugin_parameter.trim().is_empty()` → Err `--plugin-parameter must not be empty`;
  `at = ensure_tokens_refreshed()`; POST `/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info`
  `{"pluginParameter":<value as given, untrimmed>}` (`post_authed`, token-retry); errors via `format_api_error`.
- Output: `{"ok":true,"data":<backend data passthrough, keys sorted; null → "data":null>}`.
- Errors: `--plugin-parameter must not be empty`, `session expired, please login again: onchainos wallet login`,
  `code=<c> msg=<m>`.
- Side effects: state-changing (server-side report; no funds). Nondeterminism: backend `data`.
- Parity test cases: 1. `onchainos wallet report-plugin-info --plugin-parameter "  "` → validation error, no HTTP
  (SAFE). 2. logged-out with a value → `session expired…` (SAFE). 3. logged-in with a value (UNSAFE: writes server state).

---

## 4. Endpoint classification (this partition's wrappers + calls made by its commands)

| Method + path | Class | Client fn | Used by |
|---|---|---|---|
| POST `/priapi/v5/wallet/agentic/auth/session/result` | auth | `post_public` | login poll |
| POST `/priapi/v5/wallet/agentic/auth/refresh` | auth | `post_public` | `ensure_tokens_refreshed`, `force_refresh_access_token`, `ApiClient::new_async` |
| POST `/priapi/v5/wallet/agentic/account/create` | state | `post_authed` | wallet add |
| POST `/priapi/v5/wallet/agentic/account/list` | read | `post_authed` | login (fallback), wallet add, balance group |
| POST `/priapi/v5/wallet/agentic/account/address/list` | read | `post_authed` | login (fallback), balance group |
| GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch` | read | `get_authed` | login summary, balance --all |
| GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances` | read | `get_authed` | balance group |
| POST `/priapi/v5/wallet/agentic/token/get-token-info` | read | `post_authed` | send `--readable-amount`, others |
| POST `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` | state | `post_authed_with_headers` | transfer / contract-call / gas-station / inscription |
| POST `/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo` | state | `post_authed_with_headers` | swap/batch flows |
| POST `/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList` | read | `post_authed` | batch gating |
| POST `/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info` | state | `post_authed` | report-plugin-info |
| POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` | funds | `post_authed_no_retry_with_headers` | transfer / contract-call / swap |
| POST `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction` | funds | `post_authed_no_retry_with_headers` | batch flows |
| POST `/priapi/v5/wallet/agentic/gas-station/update-default-token` | state | `post_authed` | gas-station group |
| POST `/priapi/v5/wallet/agentic/gas-station/update` | state | `post_authed` | gas-station group |
| GET `/priapi/v5/wallet/agentic/geoblock/check` | read | `get_no_okheaders` | wallet geoblock |
| GET `/priapi/v5/wallet/agentic/policy/query` | read | `get_authed` | wallet status |
| POST `/priapi/v5/wallet/agentic/agent-heartbeat` | state | `post_authed` (via `fetch_heartbeat`) | login poll (post-login) |
| POST `/priapi/v5/wallet/agentic/chain/support/list` | read | `post_public` (chain.rs) | refresh with `chainUpdated`, addresses `--chain` |
| GET `/priapi/v5/wallet/agentic/agent/agent-list` | read | spawned `agent get-my-agents` | login poll (optional post-login) |
| GET `/priapi/v5/wallet/agentic/agent/device-list` | read | TaskApiClient (agent-owned) | login poll (optional post-login) |
| GET `/priapi/v1/aieco/task/subscribe/my` | read | TaskApiClient (agent-owned) | login poll (optional post-login) |
| POST `/priapi/v1/aieco/task/subscribe/device/batchUpdate` | state | TaskApiClient (agent-owned) | login poll (optional post-login) |

## 5. External hosts
- OKX base URL only (`https://web3.okx.com`, or `https://beta.okex.org` with `--dev`). The login page URL on the
  same host is opened in the **system browser**, not fetched by the CLI.
- Transitively via `DohManager` (core-owned) on connectivity failure: DoH/proxy nodes and the `okx-pilot` binary
  download hosts `static.okx.com`, `static.coinall.ltd`, `okg-pub-hk.oss-cn-hongkong.aliyuncs.com`,
  `static.jingyunyilian.com`.

## 6. Open questions
1. No email-OTP or API-key login exists in 4.6.3 source; `loginInfo.loginType` may be `ak`, but only via the
   browser page. If the lite skill must offer those modes, their protocol cannot be derived from this tree.
2. OS keyring native encodings (keyring crate 3.6.3, not vendored): Windows target name (crate default is
   believed to be `agentic-wallet.onchainos`), password stored as UTF-16LE with a 2560-byte Credential-Manager
   limit; a large blob would make the OS write fail and fall back to `keyring.enc` while a stale smaller OS entry is
   still read first (possible inconsistency). Irrelevant if the lite runtime uses the file store only.
3. `LoginPhase::Init` doc-comment says "No browser" but `cmd_login_init` opens the browser (unless
   `ONCHAINOS_NO_BROWSER`). This spec follows the code.
4. Post-login agent-commerce steps (subprocess `agent get-my-agents`, device list, subscription routing, autotrade
   prechecks) run under 4 s / 15 s deadlines and only add `postLoginSubscriptions`; whether the lite runtime must
   reproduce them (beyond the heartbeat) is a product decision.
5. `wallet-all-token-balances-batch?accountIds=` order follows Rust `HashMap` iteration (random) — the parity
   harness must compare it as a set.
6. The user request mentions supporting "the muse"; nothing named `muse` exists in the upstream CLI source, so it
   is not covered here.
7. `saTeeId`/`loginInfo.*`/`isDefault` set to JSON `null` by the backend would make parsing fail
   (`social login: failed to parse result: invalid type: null, expected a string`); unclear whether the backend
   ever sends null.
8. `balance::get_evm_address` treats every chainIndex ≠ 501 as EVM, so `evmAddress` in the login summary can be a
   BTC/SUI address if one is listed first (owned by the balance group).
9. Rust `{e:#}` texts of reqwest/IO errors (e.g. `…: error sending request for url (…)`) cannot be reproduced
   byte-exactly in Node; only the leading context strings above are stable.
