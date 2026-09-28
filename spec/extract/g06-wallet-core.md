# g06-wallet-core — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the `onchainos wallet …` command enum and its dispatcher (`commands/agentic_wallet/mod.rs`), plus the
handlers owned by this partition: `wallet chains`, `wallet balance`, `wallet funding-check`, `wallet history`,
`wallet receive`, `wallet sign-message`, `wallet inscription create|status`, `wallet utxo *` (7 leaves),
`wallet gas-station *` (5 leaves), and the dispatch-level pre-processing of `wallet send` / `wallet contract-call`
(whose handlers live in `transfer/`, owned by another group). It also specifies the shared helpers in
`agentic_wallet/shared/` (Bitcoin + SUI adapters, unsignedHashList signing pipeline, direct-broadcast extraData
builder), `broadcast.rs` (shared EVM/Solana post-unsignedInfo broadcast), `chain.rs` (chain list cache),
`chain_profile.rs` (chain capability routing) and the balance helpers reused by transfer / swap / payment.

Behaviour owned elsewhere (HTTP client core, DoH, auth/login/refresh, keyring, account/status/addresses,
transfer handlers, funding/QR, token search) is named with a one-line summary only.

## Sources read

Partition files — every file read fully, including `#[cfg(test)]` modules (used as oracles below):

| File (under `cli/src/commands/agentic_wallet/`) | Lines |
|---|---|
| `mod.rs` | 1007 |
| `balance/mod.rs` | 2101 |
| `history/mod.rs` | 6 |
| `history/query.rs` | 167 |
| `history/response.rs` | 243 |
| `inscription.rs` | 3 |
| `inscription/bitcoin.rs` | 298 |
| `utxo.rs` | 11 |
| `utxo/brc20.rs` | 798 |
| `utxo/manage.rs` | 577 |
| `utxo/query.rs` | 255 |
| `utxo/reclaim.rs` | 180 |
| `shared/mod.rs` | 5 |
| `shared/adapters/mod.rs` | 4 |
| `shared/adapters/bitcoin/mod.rs` | 9 |
| `shared/adapters/bitcoin/api.rs` | 627 |
| `shared/adapters/bitcoin/broadcast.rs` | 282 |
| `shared/adapters/bitcoin/context.rs` | 123 |
| `shared/adapters/bitcoin/error.rs` | 109 |
| `shared/adapters/bitcoin/models.rs` | 235 |
| `shared/adapters/bitcoin/signing.rs` | 95 |
| `shared/adapters/bitcoin/validation.rs` | 651 |
| `shared/adapters/sui/mod.rs` | 6 |
| `shared/adapters/sui/api.rs` | 168 |
| `shared/adapters/sui/context.rs` | 122 |
| `shared/adapters/sui/identifiers.rs` | 110 |
| `shared/adapters/sui/signing.rs` | 135 |
| `shared/common/mod.rs` | 7 |
| `shared/common/amount.rs` | 89 |
| `shared/common/context.rs` | 106 |
| `shared/common/json.rs` | 48 |
| `shared/common/session.rs` | 47 |
| `shared/common/unsigned_hash_list.rs` | 210 |
| `broadcast.rs` | 166 |
| `chain.rs` | 175 |
| `chain_profile.rs` | 286 |
| `gas_station.rs` | 441 |
| `receive.rs` | 431 |
| `sign.rs` | 501 |

Other files consulted only to follow calls out of the partition (relevant parts):

| File (under `cli/`) | Lines | Why |
|---|---|---|
| `Cargo.toml` / `Cargo.lock` | 107 / – | `serde_json` 1.0.149 **without `preserve_order`** (no indexmap dep) → every `serde_json::Value` object is a BTreeMap (sorted keys); `bitcoin` 0.32.11; `serde_jcs` 0.1.0; `debug-log` feature off |
| `build.rs`, `.env` | – | compiled base URL (default `https://web3.okx.com`; this checkout's `.env` sets `OKX_BASE_URL=http://127.0.0.1:18899`) |
| `src/main.rs` | 316 | global flags, error → exit-code mapping |
| `src/output.rs` | 450 | envelopes: `success`, `error`, `error_coded_details`, `confirming_scene`, `agentic_wallet_confirming`, `setup_required` |
| `src/wallet_api.rs` | 2874 | `WalletApiClient` transport, envelope unwrap, all wallet endpoints used here |
| `src/client.rs` | 2469 | `anonymous_headers`, `jwt_headers`, `augment_auth_error_msg`, `ApiClient::new_async` |
| `src/wallet_store.rs` | 848 | `wallets.json`, `balance_cache.json`, `chain_cache.json`, `session.json` schemas + TTL helpers |
| `src/chains.rs` | 623 | `resolve_chain`, `resolve_chains`, `chain_family`, `chain_display_name`, `is_evm_chain` |
| `src/crypto.rs` | 810 | `hpke_decrypt_session_sk`, `ed25519_sign`, `ed25519_sign_encoded`, `ed25519_sign_hex`, `ed25519_sign_eip191` |
| `src/funding.rs` | 527 | `readable_shortfall`, `resolve_funding_target`, `resolve_current_funding_bundle`, `FundingTarget` |
| `src/qr.rs` | 720 | `QrOutput` shape, display-mode detection |
| `src/validators.rs` | 442 | `readable_to_minimal_str` |
| `src/token_alias.rs` | 536 | `resolve_and_validate` |
| `src/endpoints.rs` | 65 | base URL / `--dev` |
| `src/home.rs` | 500 | `ONCHAINOS_HOME` |
| `src/keyring_store.rs` | 404 | `get("session_key")`, `read_blob` (names only) |
| `src/commands/sink.rs` | 1022 | `CodedError` |
| `src/commands/token.rs` | 1197 | `fetch_search`, `finalize_token_page` |
| `commands/agentic_wallet/auth/mod.rs` | 1827 | `ensure_tokens_refreshed`, `format_api_error`, handler names |
| `commands/agentic_wallet/account.rs` | 476 | `resolve_active_account_id`, `resolve_account_address_for_chain`, handler names |
| `commands/agentic_wallet/common.rs` | 209 | `ERR_NOT_LOGGED_IN`, `WalletPreviewConfirming`, `is_hex_string`, `handle_confirming_error` |
| `commands/agentic_wallet/geoblock.rs`, `plugin.rs` | 22 / 21 | dispatch targets (read fully) |
| `commands/agentic_wallet/transfer/mod.rs` | 2545 | `resolve_address`, `cmd_send`, `cmd_send_with_readable`, `cmd_contract_call` signatures |
| `spec/cli-tree.json` | – | cross-check of every wallet leaf/flag (30 wallet leaves; all flags match source) |

---

## Global conventions (apply to every command in this group)

### G1. Root / global flags (`main.rs:41-52`)
- `--dev` (**hidden**, global bool): base URL becomes `https://beta.okex.org` and DoH failover is disabled.
- `--chain <CHAIN>` (global, optional): top-level `Cli.chain`. Wallet subcommands that declare their own `--chain`
  (`addresses`, `receive`, `balance`, `funding-check`, `send`, `history`, `inscription *`, `utxo *`, `sign-message`,
  `contract-call`, `gas-station *`) show their own definition in `--help` (clap skips propagating a global into a
  subcommand that already defines that arg id). For `login|add|switch|status|logout|chains|geoblock|report-plugin-info`
  the global `--chain` is accepted and ignored. (See openQuestions for value propagation of `onchainos --chain X wallet balance`.)
- Hidden subcommand flag: `wallet status --include-subscriptions` (`mod.rs:67`, `hide = true`, bool, legacy no-op).
  There are **no hidden wallet subcommands**.

### G2. stdout envelopes and exit codes (`output.rs`, `main.rs:248-315`)
Every response is one line on stdout (`println!` → trailing `\n`), compact JSON (`ONCHAINOS_PRETTY=1` → serde_json
pretty print, 2-space indent).
- Success: `{"ok":true,"data":<data>}` (+ `"notifications":[…]` only if payment_notify queued events — none are queued by
  this group). Envelope key order is struct order (`ok`,`data`,`error`,`notifications`). Exit 0.
- Plain error: `{"ok":false,"error":"<anyhow {e:#}>"}` exit **1**. `{e:#}` = outermost message followed by each
  context/source joined with `": "`.
- `CodedError` (`commands/sink.rs`): printed by `error_coded_details` as a `json!` object ⇒ **keys sorted**:
  `{"data"?:…,"error":"<message>","errorCode":"<code>","errorField"?:"<field>","nextSteps"?:…,"ok":false}` exit **1**.
- `WalletPreviewConfirming` (`common.rs:5`): `{"confirming":true,"scene":"<scene>","message":"<msg>","preview":<obj>,"next":"<cmd>"}`
  (struct order; `message`/`next` omitted if empty) exit **2**.
- `CliConfirming` (81362): `{"confirming":true,"message":"<msg>","next":"<next>"}` (`scene` omitted when None) exit **2**.
- `CliSetupRequired`: `{"data":…,"errorCode":…,"message":…,"ok":false}` exit **3** (not raised by this group's own code).
- clap parse errors (missing required, conflicts, unknown flag): clap's text on stderr, exit **2**; `--help` → stdout exit 0.
- Before dispatch every run calls `home::self_heal_permissions()` (stderr `Warning: <e>` on failure) and after dispatch
  appends an audit record (`audit::log`, core-owned). The `debug-log` feature is off in release builds (no `[DEBUG]` stderr).

### G3. JSON value semantics (critical for byte parity)
- `serde_json` is compiled **without `preserve_order`**: every `json!{}` object, every backend object that passes through
  `serde_json::Value`, every request body, and every `extraData` string is serialised with **object keys sorted by
  byte order**, recursively. Structs serialised directly (envelopes above, `BalanceCacheEntry` fields inside
  `json!`, QR, FundingTarget) become `Value` maps when embedded via `json!`/`to_value` ⇒ also sorted.
  All output shapes below are therefore listed in sorted-key order.
- Numbers: backend integers that fit u64/i64 round-trip verbatim; any number with a fraction/exponent, or > u64,
  is parsed as f64 and re-emitted with ryu formatting (`4500.0` stays `4500.0`, `1e20`→`1e20`, integral floats keep
  `.0`). A Node port must use a lossless JSON parser/serialiser that reproduces these rules (JSON.parse/stringify do not).
- Duplicate keys in backend JSON: last wins.
- Recursive walks over objects (`find_string`, `collect_outpoints`, `find_token_asset`, `annotate_utxos`) iterate values
  in **sorted key order**.
- `format!("{:.2}", f64)` / `{:.6}`: Rust exact-decimal rounding of the binary value, ties to even (see openQuestions);
  `-0.00` is normalised to `0.00` where noted.

### G4. WalletApiClient transport (core-owned, `wallet_api.rs`; summarised because every endpoint below uses it)
- Base URL: compiled `ONCHAINOS_COMPILED_BASE_URL` (default `https://web3.okx.com`) or `https://beta.okex.org` with
  `--dev`; DoH (`doh::DohManager`, API host `web3.okx.com`) may substitute a proxy base URL / resolve override. Timeout 30 s.
  User-Agent from DoH manager.
- Headers (`client.rs:346 anonymous_headers`): `Content-Type: application/json`, `ok-client-version: 4.6.3` (`CARGO_PKG_VERSION`),
  `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <id>` (if cached), `device-name: <name>`.
  Authed calls add `Authorization: Bearer <accessToken>` (`jwt_headers`). Extra headers (e.g. `idempotency-key`) inserted after.
- GET query (`build_query_string`, `wallet_api.rs:106`): pairs in push order; **pairs with empty value dropped**; key emitted
  raw (so `tokenAddresses[0].chainIndex` keeps literal `[`,`]`,`.`); value `application/x-www-form-urlencoded`
  (space→`+`, everything except `A-Za-z0-9*-._` → `%XX` uppercase; e.g. `,`→`%2C`, `:`→`%3A`).
- POST body: `serde_json` compact, sorted keys (G3).
- Envelope (`unwrap_wallet_envelope`, `wallet_api.rs:721`; `handle_response` `:1173`): HTTP ≥ 500 → error
  `Wallet API server error (HTTP <s>): <raw body>`; non-JSON → `failed to parse wallet API response as JSON (HTTP <s>): <first 500 chars>`;
  `code` `"0"`/`0` → returns `data` verbatim; otherwise `ApiCodeError{code,msg}` whose Display is
  `Wallet API error (code=<code>): <msg>`; `msg` taken from `msg`|`errorMessage`|`error_message`|`message`|`detailMsg`
  else raw body (≤200 chars + `…`, and stderr `[WalletAPI] no msg field in error response (HTTP <s>), raw body: <body>`);
  code `50114` gets suffix `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.`
- Retry semantics:
  - `post_public`, `get_no_okheaders`, `get_public`: one retry after DoH failover on connect/timeout; network error text
    `Network unavailable — check your connection and try again`; other send errors `request failed`.
  - `post_authed[_with_headers]`, `get_authed[_with_headers]`: as above, plus on invalid-token (`10001|10008|53017|130100031`
    or message containing `invalid access token`/`access token invalid`) → `force_refresh_access_token()` (POST
    `/priapi/v5/wallet/agentic/auth/refresh`, persists tokens) and one retry with the fresh token.
  - `post_authed_mutation_no_retry` (and `broadcast_transaction`/`batch_broadcast_transaction`): **no retry of any kind**;
    connect/timeout → error context `Network result is unknown for this state-changing request. Query authoritative state before retrying.`
    (`broadcast_transaction`: `Broadcast result is unknown. Query transaction status before attempting another broadcast.`).
- `format_api_error` (`auth/mod.rs:338`): `ApiCodeError` → plain error `code=<code> msg=<msg>`; other errors unchanged.

### G5. Auth preamble `ensure_tokens_refreshed` (`auth/mod.rs:132`, auth-owned)
Reads `$ONCHAINOS_HOME/session.json` (`sessionKeyExpireAt`); missing/expired/unparseable → error
`session expired, please login again: onchainos wallet login`. Reads keyring blob (`refresh_token`, `access_token`); missing → same
error. Refresh token JWT expired → stderr `Session expired. Please log in again: onchainos wallet login` + same error. If either
JWT's `exp` is within 60 s (or unparseable) → POST `/priapi/v5/wallet/agentic/auth/refresh` `{"refreshToken":…}` (anonymous
headers), stores rotated tokens; if `chainUpdated` and `allAccountAddressList` non-empty → updates wallets.json and force-refreshes
the chain cache (POST chain/support/list). Refresh errors via `format_api_error`. Returns the access token.
**Not logged in therefore surfaces as `session expired, please login again: onchainos wallet login`**, not `not logged in`,
for every command that calls this first.

### G6. Local files under `$ONCHAINOS_HOME` (default `~/.onchainos`; env `ONCHAINOS_HOME`) touched by this group
All writes are `to_string_pretty` → `<file>.json.tmp` → rename.
- `wallets.json` (`WalletsJson`, camelCase, struct order): `{"email","isNew","projectId","selectedAccountId","accountsMap":{<accountId>:{"addressList":[{"accountId","address","chainIndex","chainName","addressType","chainPath"}]}},"accounts":[{"projectId","accountId","accountName","isDefault"}],"loginType"}`.
  `accountsMap` is a Rust `HashMap` ⇒ its key order in the file (and any "first key" fallback) is random per process.
- `balance_cache.json`: `{"batch_updated_at":<unix s>,"accounts":{<accountId>:{"updated_at":<unix s>,"data":[<group>],"total_value_usd":"<x.xx>"}}}`
  (snake_case; `accounts` HashMap; entries are only ever inserted/overwritten, never pruned).
- `chain_cache.json`: `{"updated_at":<unix s>,"chains":[<chain entry>…]}`; fresh iff `chains` non-empty and `now-updated_at < TTL`.
- `session.json` (read only here): `{"saTeeId","sessionCert","encryptedSessionSk","sessionKeyExpireAt","deviceId"}`.
- Keyring (read only here, keyring_store-owned): service `onchainos`, blob `agentic-wallet`, entries `access_token`,
  `refresh_token`, `session_key` (base64 X25519 private key). Env `ONCHAINOS_CREDENTIAL_STORE`, `ONCHAINOS_FORCE_FILE_KEYRING`.
- QR PNGs (receive / funding-check, qr-owned, image-notify mode only): `$ONCHAINOS_FUNDING_IMAGE_DIR` →
  `$ONCHAINOS_HOME/tmp/funding-qr` → `./.onchainos/tmp/funding-qr` → OS temp dir; file `<prefix>-<pid>-<ns>.png`.

### G7. Endpoint classification (all on the OKX base URL)
| Method + path | Class | Client fn | Used by |
|---|---|---|---|
| POST `/priapi/v5/wallet/agentic/chain/support/list` | read | `post_public` (anonymous) | chain cache (all commands that resolve chains) |
| POST `/priapi/v5/wallet/agentic/auth/refresh` | auth | `post_public` | G5 preamble, invalid-token retry |
| POST `/priapi/v5/wallet/agentic/account/list` | read | `post_authed` | balance (default), funding-check, receive, BTC/SUI context refresh |
| POST `/priapi/v5/wallet/agentic/account/address/list` | read | `post_authed` | same as above |
| GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances` | read | `get_authed` | balance, funding-check, BRC-20 balance |
| GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch` | read | `get_authed` | balance --all, login summary |
| POST `/priapi/v5/wallet/agentic/token/get-token-info` | read | `post_authed` | send `--readable-amount` (token), inscription, BRC-20 queries, `query_token_metadata` |
| GET `/priapi/v5/wallet/agentic/order/list` | read | `get_authed` | history (list) |
| GET `/priapi/v5/wallet/agentic/order/detail` | read | `get_authed` | history (detail), inscription status, utxo reclaim |
| POST `/priapi/v5/wallet/agentic/utxo/availability-details` | read | `post_authed` | all utxo commands, inscription create, BRC-20 balance |
| POST `/priapi/v5/wallet/agentic/utxo/utxo-asset-info` | read | `post_authed` | utxo queries, brc20-transferable |
| POST `/priapi/v5/wallet/agentic/utxo/user-asset-manage` | state | `post_authed_mutation_no_retry` | utxo unlock / lock (`--force`) |
| POST `/api/v5/wallet/pre-transaction/close-transaction` (**note: `/api/v5`, no `agentic`**) | state | `post_authed_mutation_no_retry` | utxo reclaim (`--force`) |
| POST `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` | state (builds a server-side pre-transaction/uopHash; no funds; BTC/SUI calls carry `idempotency-key`) | `post_authed_with_headers` | inscription create, gas-station status/setup probe, transfer handlers |
| POST `/priapi/v5/wallet/agentic/pre-transaction/sign-tx` | funds (TEE signs a transaction) | `post_authed_mutation_no_retry` | inscription create `--force` |
| POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` | funds | `post_authed_no_retry_with_headers` / `post_authed_mutation_no_retry` | `broadcast_unsigned`, BTC/SUI direct transfer |
| POST `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction` | funds | `post_authed_mutation_no_retry` | inscription create `--force` |
| POST `/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` | read (pure hash computation) | `post_authed` | sign-message eip712 |
| POST `/priapi/v5/wallet/agentic/pre-transaction/sign-msg` | funds (TEE produces a wallet signature that can authorise transfers, e.g. EIP-712 permits) | `post_authed` | sign-message |
| POST `/priapi/v5/wallet/agentic/gas-station/update-default-token` | state | `post_authed` | gas-station update-default-token / setup |
| POST `/priapi/v5/wallet/agentic/gas-station/update` | state | `post_authed` | gas-station enable / disable |
| GET `/api/v6/dex/market/token/search` | read | `ApiClient::get` (core) | receive `--token` |
| GET `/priapi/v5/wallet/agentic/geoblock/check` | read | `get_no_okheaders` (no headers at all) | geoblock (dispatch only) |
| POST `/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info` | state | `post_authed` | report-plugin-info (dispatch only) |

External hosts: none contacted directly by this partition. Transitively: DoH resolvers / proxy nodes via `DohManager`
(core-owned; `doh/binary.rs` lists `static.okx.com`, `static.coinall.ltd`, `okg-pub-hk.oss-cn-hongkong.aliyuncs.com`,
`static.jingyunyilian.com` pilot download hosts); `https://beta.okex.org` with `--dev`.

### G8. Chain resolution primitives used everywhere
- `chains::resolve_chain(name)` (core): lowercase match on `chain_cache.json` `chainName` (any age) → chainIndex; else static
  table (`ethereum|eth`→1, `solana|sol`→501, `bitcoin|btc`→0, `bsc|bnb`→56, `polygon|matic`→137, `arbitrum|arb`→42161,
  `base`→8453, `xlayer|x layer|x-layer|okb`→196, `xlayer_test`→1952, `avalanche|avax`→43114, `optimism|op`→10,
  `fantom|ftm`→250, `sui`→784, `tron|trx`→195, `ton`→607, `linea`→59144, `scroll`→534352, `zksync`→324, `tempo`→4217);
  else input unchanged. No I/O besides reading the cache file.
- `chain::get_chain_by_real_chain_index` and `chain_profile::resolve` (this partition, see Shared helpers) — these call
  `get_all_chains()` and may therefore issue POST chain/support/list.

---

## Wallet command dispatch table (`mod.rs:595 execute`)

| Leaf | Enum variant (mod.rs line) | Handler (file:line) | Owner |
|---|---|---|---|
| `wallet login` | `Login` (44) | `--phase init` → `auth::cmd_login_init` (auth/mod.rs:761); `open` → requires `--url` else error ``\`--url\` is required for \`--phase open\``` → `auth::cmd_login_open` (814); `poll` → `auth::cmd_login_poll(session_id)` (831) | auth group |
| `wallet add` | `Add` (57) | `auth::cmd_add` (auth/mod.rs:1043) | auth group |
| `wallet switch <ACCOUNT_ID>` | `Switch` (59) | `account::cmd_switch` (account.rs:48) | account group |
| `wallet status` | `Status` (64; hidden `--include-subscriptions` ignored) | `account::cmd_status` (account.rs:218) | account group |
| `wallet addresses` | `Addresses` (71) | `account::cmd_addresses(chain)` (account.rs:316) | account group |
| `wallet receive` | `Receive` (78) | `receive::cmd_receive` (receive.rs:25) | **this group** |
| `wallet logout` | `Logout` (92) | `auth::cmd_logout` (auth/mod.rs:1176) | auth group |
| `wallet chains` | `Chains` (94) | `chain::execute(ChainCommand::List)` (chain.rs:16 → `cmd_list` :23) | **this group** |
| `wallet geoblock` | `Geoblock` (97) | `geoblock::cmd_check` (geoblock.rs:5) | other (see Commands) |
| `wallet balance` | `Balance` (99) | token normalisation in mod.rs:629-650, then `balance::cmd_balance` (balance/mod.rs:583) | **this group** |
| `wallet funding-check` | `FundingCheck` (116) | `balance::cmd_funding_check` (balance/mod.rs:866) | **this group** |
| `wallet send` | `Send` (135) | routing mod.rs:689-773 → `transfer::bitcoin::cmd_send` (transfer/bitcoin.rs:20) / `transfer::sui::cmd_send` (transfer/sui.rs:24) / `transfer::cmd_send_with_readable` (transfer/mod.rs:1273) | dispatch: this group; handlers: transfer group |
| `wallet history` | `History` (175) | `history::cmd_query_history` (history/query.rs:15) | **this group** |
| `wallet inscription create` | `InscriptionCommand::Create` (312) | profile check mod.rs:811-817 → `inscription::bitcoin::cmd_create` (inscription/bitcoin.rs:21) | **this group** |
| `wallet inscription status` | `InscriptionCommand::Status` (334) | profile check → `inscription::bitcoin::cmd_query_status` (inscription/bitcoin.rs:198) | **this group** |
| `wallet utxo user-ignored` | `UtxoCommand::UserIgnored` (352) | `ensure_bitcoin_command_chain` (mod.rs:587) → `utxo::cmd_user_ignored` (utxo/query.rs:75) | **this group** |
| `wallet utxo unavailable` | `Unavailable` (358) | → `utxo::cmd_unavailable` (utxo/query.rs:80) | **this group** |
| `wallet utxo available` | `Available` (364) | → `utxo::cmd_available` (utxo/query.rs:85) | **this group** |
| `wallet utxo brc20-transferable` | `Brc20Transferable` (369) | → `utxo::cmd_brc20_transferable` (utxo/brc20.rs:245) | **this group** |
| `wallet utxo unlock` | `Unlock` (380) | → `utxo::cmd_unlock` (utxo/manage.rs:19) | **this group** |
| `wallet utxo lock` | `Lock` (397) | → `utxo::cmd_lock` (utxo/manage.rs:41) | **this group** |
| `wallet utxo reclaim` | `Reclaim` (410) | → `utxo::cmd_reclaim` (utxo/reclaim.rs:20) | **this group** |
| `wallet sign-message` | `SignMessage` (218) | profile check mod.rs:904-915 → `sign::cmd_sign_message` (sign.rs:11) | **this group** |
| `wallet report-plugin-info` | `ReportPluginInfo` (236) | `plugin::cmd_report_plugin_info` (plugin.rs:9) | other (see Commands) |
| `wallet contract-call` | `ContractCall` (245) | routing mod.rs:938-1003 → `transfer::sui::cmd_contract_call` (transfer/sui.rs:223) / `transfer::cmd_contract_call` (transfer/mod.rs:1516) | dispatch: this group; handlers: transfer group |
| `wallet gas-station update-default-token` | `GasStationCommand::UpdateDefaultToken` (425) | `gas_station::execute` (gas_station.rs:10) → `fetch_update_default_token` (:304) | **this group** |
| `wallet gas-station enable` | `Enable` (436) | → `fetch_update(chain,true)` (:324) | **this group** |
| `wallet gas-station disable` | `Disable` (443) | → `fetch_update(chain,false)` (:324) | **this group** |
| `wallet gas-station status` | `Status` (452) | → `cmd_status` (:116) | **this group** |
| `wallet gas-station setup` | `Setup` (464) | → `cmd_setup` (:199) | **this group** |

---

## Shared helpers (used across groups or from core)

### chain.rs
- `const CHAIN_CACHE_TTL = 600` (chain.rs:8) seconds.
- `fn chain::get_all_chains() -> Vec<Value>` (chain.rs:31): `wallet_store::get_chain_cache(600)` hit → cached `chains`;
  else `fetch_chains_from_api()` then `set_chain_cache(chains)` (writes `{"updated_at":now,"chains":…}` even if empty —
  an empty list is never considered fresh, so it is re-fetched every call). Fetch errors propagate.
- `fn chain::fetch_chains_from_api()` (chain.rs:141): `WalletApiClient::new()`, POST `/priapi/v5/wallet/agentic/chain/support/list`
  body `{}` via `post_public` (anonymous headers). `chains = data` if `data` is an array, else `data.chainList` if array, else `[]`.
- `fn chain::get_chain_by_index(idx)` (chain.rs:42): first entry whose `chainIndex` (string, or i64 rendered) == idx.
- `fn chain::get_real_chain_index(idx) -> u64` (chain.rs:56): entry by index → `realChainIndex` (string parsed u64, or u64);
  errors `Chain index <idx> not found in supported chains` / `Cannot resolve realChainIndex for chain index <idx>`.
- `fn chain::get_chain_by_name(name)` (chain.rs:74): case-insensitive (`to_lowercase`) `chainName` equality.
- `fn chain::get_chain_by_real_chain_index(input)` (chain.rs:85): `input.trim()`; first entry (list order) where any of
  `chainIndex`, `realChainIndex`, `chainName` matches — string fields compared ASCII-case-insensitively, numeric fields
  compared as `i64.to_string() == input` — or any string in `alias[]` equals input ASCII-case-insensitively.
- `fn chain::force_refresh_chain_cache()` (chain.rs:114): fetch + write, errors ignored.
- `fn chain::show_name_for_real_id_sync(u64) -> Option<String>` (chain.rs:124): cache only (any age), `showName` of entry whose
  `realChainIndex` matches. No I/O besides the file.
- `fn chain::ensure_chain_cache_fresh()` (chain.rs:156): if cache not fresh → `force_refresh_chain_cache()` (errors ignored).

### chain_profile.rs
- `enum TransferDriver {LegacyAccount, Bitcoin, Sui, Unsupported}`, `InscriptionDriver {Bitcoin, Unsupported}`,
  `MessageSignDriver {LegacyAccount, Unsupported}`; `ResolvedChainProfile {chain_index, real_chain_index, chain_name,
  native_symbol, native_decimals, capabilities{transfer, inscription, contract_call, message_sign}}`; `is_bitcoin()` ⇔ transfer==Bitcoin.
- `fn chain_profile::resolve(input)` (chain_profile.rs:50): `get_chain_by_real_chain_index(input)`; if none, first entry
  of `get_all_chains()` satisfying `entry_matches_name_or_alias(entry,input)`; else error `unsupported chain: <input>` (input as given).
  Then `from_entry`.
- `fn entry_matches_name_or_alias(entry, input)` (chain_profile.rs:63): input trimmed; true if `chainIndex` (string/i64 as
  string) == input, or `chainName` eq-ignore-ascii-case, or any `alias` eq-ignore-ascii-case; additionally, if input
  (lowercased) is `bitcoin`|`btc` and entry `chainName` (lowercased) is `bitcoin`|`btc` → true.
- `fn from_entry(entry)` (chain_profile.rs:102): requires `chainIndex`, `realChainIndex`, `chainName` (string or i64) else errors
  `chain profile: chain entry missing chainIndex|realChainIndex|chainName`; empty/whitespace identifiers →
  `chain profile: chain identifiers must not be empty`. Overlay (`:125`), `server_symbol` = first non-empty of
  `nativeSymbol|chainSymbol|symbol`:
  - matches name/alias `bitcoin` or `btc` → symbol (default `BTC`), decimals 8, transfer Bitcoin, inscription Bitcoin, contract_call false, message_sign Unsupported;
  - else matches `sui` → symbol (default `SUI`), 9, Sui, Unsupported, contract_call **true**, message_sign Unsupported;
  - else `isEvmChain == true` or matches `solana|sol|tron|trx|ton` → symbol (default ""), **18** (also for Solana), LegacyAccount, Unsupported, true, LegacyAccount;
  - else → symbol (default ""), 0, Unsupported, Unsupported, false, Unsupported.
  Oracles: `{"chainIndex":"0","realChainIndex":"5","chainName":"Bitcoin"}` → Bitcoin, index "0", decimals 8;
  `{"chainIndex":784,…,"chainName":"sui"}` → Sui, contract_call true; `{"chainName":"Future Chain"}` → Unsupported;
  Tempo `isEvmChain:true` → LegacyAccount.

### balance/mod.rs helpers (used by transfer, swap, payment, auth, funding)
- `fn wallet_accounts_need_refresh(w)` (19): `accounts` empty OR any `accounts[].accountId` missing from `accountsMap`.
- `fn get_evm_address(w,id)` (28): first address in that account's `addressList` whose `chains::chain_family(chainIndex)=="evm"`
  — i.e. **any chainIndex other than "501"** (so a Bitcoin/SUI/Tron address listed first is returned as "evmAddress"; bug-compatible). `""` if none.
- `fn get_sol_address` (42): chainIndex `"501"`; `get_btc_address` (52): chainIndex `"0"` or `"5"`; `get_sui_address` (66): `"784"`. `""` if none.
- `fn ensure_wallet_accounts_fresh(client, token, &mut wallets, force)` (82): if `!force && !need_refresh` → no-op. Else POST
  `account/list` `{"projectId":<wallets.projectId>}`; **only if it succeeds**: replace `wallets.accounts` with
  `[{projectId,accountId,accountName,isDefault}]`, then POST `account/address/list` `{"accountIds":[ids in list order]}`; if that
  succeeds, insert/overwrite `accountsMap[accountId] = {addressList:[{accountId,address,chainIndex,chainName,addressType,chainPath}]}`
  (other map entries are kept); then `save_wallets` (even if address/list failed). All API errors swallowed; save errors propagate.
  `account/address/list` response: `data[0].accounts[]` (`{accountId, addresses:[{address, chainIndex(str|num), chainName, addressType, chainPath(nullable)}]}`).
- `fn refresh_wallet_accounts_strict(client, token, &mut wallets)` (136): same two POSTs but errors propagate via
  `format_api_error` (`code=<c> msg=<m>`); replaces `accounts` and `accountsMap` wholesale; if `selectedAccountId` not among
  returned ids → default account id, else first, else `""`; `save_wallets`.
- `fn enrich_with_usd_value(data)` (321) / `enrich_group_usd_value` (286): for each group (array element, or the value itself),
  in the first of `tokenAssets`|`assets` that is an array: if token has `usdValue` that is non-null and (if a string) non-empty
  → keep; else set `usdValue = format!("{:.6}", balance*tokenPrice)` (string) where each operand is `str.parse::<f64>()` (Rust
  f64 grammar, no whitespace) or JSON number, default 0.0. Oracles: (2.0,100.0)→`"200.000000"`; existing `"999.0"` kept; null → computed.
- `fn project_token_fields(data)` (377): same traversal; each object token is round-tripped through the 9-field whitelist
  `balance, chainIndex, decimal, rawBalance, symbol, tokenAddress, tokenName, tokenPrice, usdValue` (values kept as-is,
  absent/null keys dropped, `""` kept, output keys alphabetical). Non-object entries untouched. Group-level fields untouched.
  Dropped examples: `address, absSpendingPendingBalance, spendingPendingBalance, receivedPendingBalance, activeBuy, coinTypeNo,
  customName, customSymbol, multiplier, tokenType, imageUrl, priceChangeRate24H`.
- `fn sort_token_assets(data)` (205) / `sort_tokens_vec` (221): stable sort of each group's first `tokenAssets`|`assets` array:
  chainIndex `"196"` first; different chains → by per-chain total USD desc (sum of `token_usd` over that chain);
  same chain → token USD desc. `token_chain_index` = string or number→string; `token_usd` = `usdValue` parsed (string f64 or number) else 0.
  Oracle: [501 SOL 0.61, 196 OKB 0.40, 1 ETH 0.36, 56 BNB 0.34, 8453 ETH 0.23, 501 CORGI 0.11, 501 USDC 0.02] →
  196 OKB, 501 SOL, 501 CORGI, 501 USDC, 1 ETH, 56 BNB, 8453 ETH.
- `fn compute_total_value_usd(data) -> String` (407): sum over groups/tokens (`tokenAssets` else `assets`) of: `usdValue` string
  parsed f64, else `usdValue` number, else `balance*tokenPrice`; `-0` → 0; `format!("{:.2}")`. Oracles: `"300.0"`→`"300.00"`,
  numeric 123.45→`"123.45"`, empty→`"0.00"`.
- `fn sum_cache_total(cache)` (452): sum of `total_value_usd.parse::<f64>()` (unparseable → 0), `-0`→0, `{:.2}`.
- `fn retain_requested_accounts(data, ids)` (470): if array, keep groups whose `accountId` string ∈ ids.
- `fn cache_for_accounts(cache, ids)` (483): copy with only those account entries.
- `fn login_identity_summary(w,id)` (500) → `{"accountCount": max(accounts.len, accountsMap.len), "accountName", "btcAddress","evmAddress","solAddress","suiAddress"}`.
- `fn login_account_summary(client, token, w, id)` (522, called by `auth` after login): identity summary + `totalValueUsd`:
  if accountsMap empty → `""`; else GET `wallet-all-token-balances-batch?accountIds=<map keys joined ",">` (HashMap order);
  on success: enrich, retain requested, write batch cache entries `{updated_at:now, data:[group] (enriched, **not projected**), total_value_usd}`
  (errors ignored), `totalValueUsd = compute_total_value_usd(data)`; on failure `""`.
- `pub async fn query_token_readable(chain_index, token_address) -> Option<MatchedToken{balance,symbol,decimals}>` (1126):
  G5 preamble; load wallets (`not logged in`); `ensure_wallet_accounts_fresh(force=false)`; `resolve_active_account_id`;
  GET `wallet-all-token-balances?accountId=<id>&chains=<chain_index>`; errors `format_api_error`; `project_token_fields`;
  `match_readable_token` (1040): first token (groups in order) with `chainIndex` (string/number) == chain_index exactly and
  `tokenAddress` eq-ignore-ascii-case token_address (`""` = native); balance must be string or number (else None);
  `symbol` trimmed, empty→None; `decimals` from `decimal` (u64 or numeric string). `query_token_readable_balance` (1106) → `.balance`.
- `pub async fn query_token_metadata(chain_index, token_address) -> {symbol, decimals}` (998): G5; chain_index must parse u64
  (`invalid numeric chain index: <x>`); POST `token/get-token-info` `{"chainIndex":<u64>,"source":0,"tokenAddress":…}` (errors
  `format_api_error`); item = `data[0]` if array else data; decimals from `decimals` then `decimal` (u64 or numeric string) else
  `token metadata missing decimals`; symbol = non-empty `tokenSymbol` then `symbol`.

### broadcast.rs — shared EVM/Solana post-unsignedInfo broadcast
`pub(crate) async fn broadcast_unsigned(ctx: BroadcastCtx) -> Result<String /*txHash*/>` (broadcast.rs:43). Used by
`agent_commerce/identity/signing.rs`. Inputs: access_token, account_id, addr_info, session_cert, signing_seed [32],
unsigned (`UnsignedInfoResponse`), is_contract_call, mev_protection, force, extra_data_overlay (map), trace_headers.
1. `executeResult`: JSON bool → that value; null/other → true. False → error `transaction simulation failed: <executeErrorMsg or "transaction simulation failed">`.
2. `msgForSign` (only non-empty sources):
   - `hash` → `signature` = `ed25519_sign_eip191(hash, seed, "hex")` (see crypto below; base64).
   - `authHashFor7702` → `authSignatureFor7702` = base64(Ed25519(seed, hexdecode(hash))).
   - `unsignedTxHash` → `unsignedTxHash` (verbatim) + `sessionSignature` = base64(Ed25519(seed, decode(unsignedTxHash, unsigned.encoding))) —
     encoding must be `hex|base64|base58` else error `unsupported encoding: <enc>, expected hex/base64/base58`; empty decoded input → signature `""`.
   - `unsignedTx` → `unsignedTx` verbatim.
   - `jitoUnsignedTx` → `jitoUnsignedTx` + `jitoSessionSignature` (same as sessionSignature over jito tx bytes).
   - `session_cert` non-empty → `sessionCert`.
3. `extraData` = `unsigned.extraData` if object else `{}`; set `checkBalance:true`, `uopHash`, `encoding`, `signType`,
   `msgForSign`; `txType:2` iff `!is_contract_call`; `isMEV:true` iff mev; `skipWarning:true` iff force; then overlay keys
   inserted (override). Serialised compact, sorted keys.
4. POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` body
   `{"accountId","address":addr_info.address,"chainIndex":addr_info.chainIndex (string),"extraData":<string>}`, extra headers = trace_headers,
   no retry. Response `data[0]` → `{pkgId,orderId,orderType,txHash}` (errors `broadcast: expected data to be an array`,
   `broadcast: data array is empty`, `broadcast: failed to parse response`). Errors mapped with `handle_confirming_error(e, force)`:
   `ApiCodeError` code `81362` and !force → `CliConfirming{message: api msg, next: "If the user confirms, re-run the same command with --force flag appended to proceed."}` (exit 2);
   other `ApiCodeError` → `Wallet API error (code=N): msg`.

### crypto primitives used here (core-owned `crypto.rs`, algorithm needed for parity)
- `hpke_decrypt_session_sk(enc_b64, session_key_b64)` (crypto.rs:39): RFC 9180 base mode, DHKEM(X25519,HKDF-SHA256) /
  HKDF-SHA256 / AES-256-GCM, `info="okx-tee-sign"`, empty AAD; input = base64(enc[32] ‖ ciphertext+tag); session key 32 bytes;
  plaintext must be 32 bytes (Ed25519 seed). Error texts: `encrypted_session_sk is not valid base64`, `session_key must be 32 bytes, got N`,
  `encrypted_session_sk too short: N bytes (need > 32)`, `HPKE decryption failed: …`, `decrypted signing seed must be 32 bytes, got N`.
- `ed25519_sign(seed, msg)` (106): RFC 8032 Ed25519 with 32-byte seed (deterministic).
- `ed25519_sign_encoded(msg, seed_b64, enc)` (124): decode msg per `hex` (strip `0x`) / `base64` (standard) / `base58`; empty → returns `""`; base64 signature.
  `ed25519_sign_hex(h, seed_b64)` (170) = encoded with `hex`.
- `ed25519_sign_eip191(msg, seed, enc)` (278): empty msg → `""`; data = hexdecode(strip `0x`) for `hex`, UTF-8 bytes for `utf8`;
  digest = Keccak-256(`"\x19Ethereum Signed Message:\n" + decimal(len(data)) + data`); base64(Ed25519(seed, digest)).
  (Node: Keccak-256 is not `sha3-256`; needs an in-repo implementation.)

### shared/common
- `amount::parse_minimal(v, field, allow_zero)` (amount.rs:6): trim; non-empty ASCII digits else `<field> must be a non-negative integer in minimal units`;
  leading zero with len>1 → `<field> must not contain leading zeros`; zero when !allow_zero → `<field> must be greater than zero`. BigUint.
- `amount::readable_to_minimal(v, decimals)` (amount.rs:24): decimals>255 → `asset decimal exceeds the supported limit`;
  `validators::readable_to_minimal_str` (errors: `--readable-amount must be a positive number, got "<v>"`,
  `--readable-amount "<v>" has more decimal places than this token supports (<d> decimals)`,
  `--readable-amount <v> is too small for this token (<d> decimals); results in zero minimal units`; leading `.` allowed,
  trailing zeros beyond precision allowed); then `parse_minimal(.., "readable-amount", false)`. Oracles: ("1.00000001",8)→"100000001", ("1",18)→"1000000000000000000".
- `amount::minimal_to_readable(v, decimals)` (amount.rs:32): parse_minimal(v,"amount",true); left-pad, insert point, trim trailing zeros and point. ("1000",8)→"0.00001".
- `amount::value_as_decimal_string(v)` (63): string as-is, or u64 → string; else None (floats/negatives → None).
- `amount::decimal_field(v)` (71): first present of `decimal`, `decimals` → decimal string → u32.
- `json::first_data_item(v)` (json.rs:7): array of exactly one element → that element; otherwise unchanged.
- `json::shell_arg(s)` (json.rs:15): unchanged if every byte ∈ `[A-Za-z0-9_\-.:/]`, else `'` + s with `'`→`'"'"'` + `'`.
- `json::find_string(v, keys)` (json.rs:26): object: for each key in order, if present and string/u64 → return; else recurse into values (sorted-key order); arrays in order.
- `json::required_string(v, key, source)` (json.rs:42): non-empty string else `<source> is missing <key>`.
- `session::SigningSeed::load()` (session.rs:10): `session.json` else `not logged in`; keyring `session_key` else `not logged in`; HPKE decrypt.
- `session::session_cert()` (session.rs:37): `session.json.sessionCert` (else `not logged in`).
- `context::load_chain_context(resolver_input, driver, label, from, validate, same)` (context.rs:20): G5 preamble;
  `chain_profile::resolve(resolver_input)` (literal `"bitcoin"` / `"sui"`); driver mismatch → `<resolver_input> profile resolved to a non-<label> chain`;
  load wallets (`not logged in`); `resolve_active_account_id`; `select_current_address` (context.rs:76); on any error →
  `ensure_wallet_accounts_fresh(force=true)` (2 POSTs, best-effort) and retry once; then `validate(address)`.
  Returns `{access_token, account_id, login_type: wallets.loginType, profile, address}`.
  `select_current_address` errors: `current account '<id>' was not found`, `current account '<id>' has no <label> address`,
  `current account '<id>' has multiple <label> addresses` (addresses whose `chainIndex == profile.chain_index`),
  `--from must be the <label> address of the current account` (after `same_address(from, selected)`; parse errors of `from` propagate).
- `account::resolve_active_account_id(w)` (account.rs:403, account-owned): `selectedAccountId` if non-empty; else first
  `accounts[]` with `isDefault`; else **first key of the accountsMap HashMap (random order)**; else `no wallet accounts found`.

### shared/common/unsigned_hash_list.rs — Bitcoin/SUI signing pipeline
- `sign_unsigned_hashes(response, seed, profile{Bitcoin|Sui})` (unsigned_hash_list.rs:17):
  1. `response.unsignedHashList` array else `signing response is missing unsignedHashList`; empty → `unsignedHashList must not be empty`.
  2. default encoding = non-empty `response.encoding` else `signing response is missing encoding`; must be allowed for profile
     (Bitcoin: `eip2519|hex|base64|base58`; Sui: `eip2519|base64`) else `unsupported transaction encoding: <enc>`.
  3. Validate every item first: `index` (u64 or numeric string) else `unsignedHashList item is missing index`; duplicates →
     `unsignedHashList contains duplicate index <i>`; non-empty `unsignedHash` else `unsignedHashList[<i>] is missing unsignedHash`;
     Bitcoin also requires non-empty `unsignedHashSig` else `unsignedHashList[<i>] is missing unsignedHashSig`;
     per-item encoding: Bitcoin = item `encoding` if non-empty else default; Sui = default (item encoding ignored); validated as above.
  4. For each item in order: bytes = hexdecode(strip `0x`) if value starts with `0x` or encoding ∈ {`eip2519`,`hex`}
     (`unsignedHash is not valid hex: <hex err>`), else base64 standard (`unsignedHash is not valid base64: …`) or base58
     (`unsignedHash is not valid base58: …`). Sui requires 32 bytes (`SUI unsignedHash must decode to 32 bytes, got N`).
     `sessionSignature` = base64(Ed25519(seed, bytes)); output item = input item clone (all backend fields preserved) + `sessionSignature`.
  Oracles: `{"encoding":"eip2519","unsignedHashList":[{"index":0,"unsignedHash":"0x"+"ab"*32,"unsignedHashSig":"service-proof"}]}` with seed `[1;32]`
  → `sessionSignature = base64(ed25519([1;32],[0xab;32]))`.
- `build_direct_extra_data(prepared, signed, session_cert, force, label) -> String` (unsigned_hash_list.rs:126): errors
  `signed hash list must not be empty`, `unsignedInfo response is missing unsignedTx|signType|encoding`,
  `unsignedInfo response is missing txParam` (null/absent), `signed hash item is missing unsignedHash|sessionSignature`.
  `msgForSign = {"sessionCert","txParam","unsignedHashList":signed,"unsignedTx", "unsignedTxHash"? (if non-empty string)}`;
  `extraData` = `prepared.extraData` if object else `{}`, then `checkBalance:true`, `uopHash` = `prepared.uopHash` (any JSON) or `""`,
  `encoding`, `signType`, `msgForSign`, remove key `signTx`, `skipWarning:true` iff force. Returns compact sorted JSON string
  (error `failed to serialize <label> extraData`). Oracle test in bitcoin/broadcast.rs:174.

### shared/adapters/bitcoin
- `BtcContext::load(from)` (context.rs:20): `load_chain_context("bitcoin", Bitcoin, "Bitcoin", from, validate_wallet_address, same_address)`.
  `chain_index_u64()` (41) error `Bitcoin runtime chainIndex '<x>' is not numeric`; `session_cert()`, `signing_seed()`;
  `social_wallet_type()` (61) = `"12"` iff loginType ∈ {`email`,`google`,`apple`}.
- `BtcApi` (api.rs) — all errors of methods marked (M) are mapped through `error::map_api_error`:
  - `token_metadata(ctx, token)` (31, M): POST `token/get-token-info` `{"chainIndex":<u64>,"source":0,"tokenAddress":token}` → `first_data_item`.
  - `brc20_balance(ctx, token)` (52, M): GET `wallet-all-token-balances?accountId=<id>&chains=<idx>&tokenAddresses[0].chainIndex=<idx>&tokenAddresses[0].tokenAddress=<token>`; raw data.
  - `availability_details(ctx, queryType)` (71, M) / `brc20_transferable_utxos(ctx, token)` (120, M; queryType `BRC20_TRANSFERABLE_UTXO_LIST` + `tokenAddress`):
    POST `utxo/availability-details` `{"address":<btc addr>,"chainIndex":"<idx>"(string),"queryType":…,"tokenAddress"?}` → `first_data_item`.
  - `brc20_utxo_asset_info(ctx, outpoints)` (85, M): empty → `[]` (no request); chainIndex ≠ `"0"` → `BRC-20 UTXO asset details require Bitcoin chainIndex 0, got <idx>`;
    chunks of 10 (order as given) → POST `utxo/utxo-asset-info` `{"address","assetProtocols":["BRC20"],"chainIndex":"0","utxos":[{"txHash","voutIndex":"<n>"}]}`;
    array results concatenated, non-array result pushed as one record.
  - `manage_utxos(ctx, action, message, outpoints)` (161, M, no-retry): body `{"action":"ignoreAsset"|"cancelIgnore","chainIndex":"<idx>","message":…,"utxos":[…]}`
    to `utxo/user-asset-manage`; guards: empty chainIndex `UTXO management chainIndex must not be empty`, other action
    `unsupported UTXO management action: <a>`, blank message `UTXO management message must not be empty`, 0 or >50 outpoints
    `UTXO management requires 1..=50 outpoints per batch`.
  - `prepare_transaction(ctx, to, amount, token?, signType?, feeRate?)` (182): body `{"amount","chainIndex":<u64>,"contractAddr"?,"fromAddr","sessionCert","signType"?,"toAddr","txParam"?:{"feeRate":<number>}}`.
  - `prepare_selected_brc20_transfer(ctx, to, amount, token, txParam)` (211): `{"amount","chainIndex":<u64>,"contractAddr":token,"fromAddr","sessionCert","signType":"transfer","toAddr","txParam":<given>,"walletType"?:"12"}`.
  - `request_unsigned_info` (236): POST `pre-transaction/unsignedInfo` with header `idempotency-key: <uuid v4>` (same key reused on
    DoH/invalid-token retries) → `first_data_item(data)`. Not mapped (callers map).
  - `sign_transaction(ctx, unsigned, signed_hashes)` (252, no-retry): requires `unsigned.signType` (`unsignedInfo response is missing signType`),
    non-null `txParam` (`unsignedInfo response is missing txParam`), non-empty hashes (`signed hash list must not be empty`);
    POST `pre-transaction/sign-tx` `{"chainIndex":<u64>,"from":<btc addr>,"payload":[{"signType","txParam","unsignedHashList":<signed>}],"sessionCert"}` → `first_data_item`.
  - `broadcast_transaction(ctx, extraData)` (293, no-retry): POST `pre-transaction/broadcast-transaction` `{"accountId","address","chainIndex":"<idx>","extraData"}`;
    `data[0]` → BroadcastResponse (`broadcast: expected a non-empty data array` / `broadcast: failed to parse response`).
  - `batch_broadcast_transactions(ctx, body)` (320, no-retry): POST `pre-transaction/batch-broadcast-transaction`; data must be array
    (`batch broadcast: expected data to be an array`), each → BroadcastResponse (`batch broadcast: failed to parse response item <i>`).
  - `order_detail(ctx, txHash?, orderId?)` (348, **not mapped**): GET `order/detail?accountId=<id>&chainIndex=<idx>&address=<btc>[&txHash=…][&orderId=…]`
    → `first_data_item` → `validate_order_detail_context` (426): response `chainIndex` (string/u64) ≠ idx →
    `ORDER_CONTEXT_MISMATCH: response chainIndex <x> does not match requested <idx>`; non-empty `accountId` ≠ →
    `ORDER_CONTEXT_MISMATCH: response accountId does not match current account`; non-empty `txHash`/`orderId` ≠ request →
    `ORDER_CONTEXT_MISMATCH: response txHash does not match request` / `… orderId does not match request`.
  - `close_transactions(ctx, hashes)` (379, no-retry, not mapped): POST **`/api/v5/wallet/pre-transaction/close-transaction`** `{"chainIndex":"<idx>","txHashList":[…]}`.
  - `extract_token_decimals(meta)` (420): `decimal_field` else `BRC-20 token metadata is missing decimal/decimals`.
- `error::map_api_error(e)` (error.rs:12): `ApiCodeError{code,msg}` → `CodedError{code, message: msg}` with extras:
  `44001` data `{"state":"INSUFFICIENT_UTXO"}` + nextSteps `{queryUnavailableUtxos}`; `44002` data `{"state":"INSUFFICIENT_BTC_FOR_INSCRIPTION"}`
  + nextSteps `{showBitcoinAddress, refreshBtcBalance}`; `44003` `{"state":"NEED_INSCRIBE"}`; `82001` `{"state":"UTXO_PERMISSION_DENIED"}`;
  `82002` `{"state":"UTXO_NOT_FOUND"}` + `{queryUnavailableUtxos}`; `82003` `{"state":"INVALID_UTXO_REQUEST"}`;
  `82005` `{"state":"UTXO_ALREADY_SPENT"}` + `{queryUnavailableUtxos}`. Other errors unchanged.
- `models::BtcOutPoint::parse(s)` (models.rs:19): rust-bitcoin 0.32 `OutPoint::from_str` (`<64-hex txid>:<u32 vout>`, len ≤ 75,
  exactly one `:`, no leading `0`/`+` in vout) → canonical `"<lowercase txid>:<vout>"`; error `invalid outpoint '<s>': <bitcoin error>`.
  `to_api_value` → `{"txHash":…,"voutIndex":"<vout as string>"}`. Ord = (tx_hash string, vout numeric).
- `models::next_steps([...])` (95) → object of read-only commands (keys sorted): `checkInscriptionStatus` =
  `onchainos wallet inscription status --chain bitcoin --tx-hash <h>` (txHash preferred) or `… --order-id <id>`;
  `queryUnavailableUtxos` = `onchainos wallet utxo unavailable --chain bitcoin`; `showBitcoinAddress` = `onchainos wallet addresses --chain bitcoin`;
  `refreshBtcBalance` = `onchainos wallet balance --chain bitcoin --force`; `queryBrc20TransferableUtxos` =
  `onchainos wallet utxo brc20-transferable --chain bitcoin --token-address <t>` (values `shell_arg`-quoted). Guard: must start with one of the 5 prefixes
  else `nextSteps rejected non-read-only command: <cmd>`; empty token → `token address is required for a transferable BRC-20 UTXO query`;
  neither id → `txHash or orderId is required for a status continuation`.
- `models::collect_outpoints(v)` (141): recursive (sorted-key order); any object having a string under the first present of
  `txHash|txhash|txid|txId` and a u64/numeric-string under the first present of `voutIndex|voutindex|vout` (fitting u32) yields
  `{tx_hash as-is (case preserved), vout}`; dedup by canonical string; **result ordered by canonical string** (lexicographic: `…:10` < `…:2`).
- `validation::validate_wallet_address(a)` (validation.rs:26): mainnet parse (`invalid wallet Bitcoin address: <e>` /
  `wallet must be a Bitcoin mainnet address: <e>`), must be P2TR else `current Agentic Wallet Bitcoin address must be Taproot (P2TR)`.
- `validation::validate_recipient(a)` (35): mainnet parse with field `recipient`.
- `validation::same_address(l, r)` (103): scriptPubKey equality after parsing `l` as field `from` and `r` as `wallet`.
- `validation::parse_fee_rate(s)` (44): trim; `^\d+(\.\d+)?$` with no leading zero on multi-digit integer part, else
  `--fee-rate must be a decimal sat/vB value`; value < 0.1 → `--fee-rate must be at least 0.1 sat/vB`; returns the JSON number
  parsed by serde_json (`"8"`→`8`, `"1.25"`→`1.25`, `"0.10"`→`0.1`). Oracles: `0.1` ok, `0.01`/`0`/`1e2`/`1.` errors.
- `validation::normalize_brc20_token_address(s)` (81): trim; must start (ASCII-case-insensitive) with `btc-brc20-`, have a non-empty
  ticker and total length ≤ `10+64` bytes, else `BRC-20 token address must use btc-brc20-<ticker>`; ticker containing ASCII
  whitespace/control/`/` → `BRC-20 ticker contains unsupported characters`; returns `btc-brc20-<ticker lowercased (ASCII)>`.
  Oracles: `BTC-BRC20-ORDI`→`btc-brc20-ordi`; `铭文btc-brc20-ordi` → error.
- `validation::preview_from_response(resp, op, chainIndex, from, to, token?, amount, readable, nativeDecimals)` (110):
  `executeResult` bool required (`INCOMPLETE_TRANSACTION_PREVIEW: missing executeResult`); false →
  `PRE_EXECUTION_FAILED: <executeErrorMsg or "Bitcoin transaction pre-execution failed">`; `txParam` object
  (`INCOMPLETE_TRANSACTION_PREVIEW: response is missing txParam`); `txParam.inputs` non-empty array (`… txParam.inputs is empty`);
  outputs = `txParam.outputs` or `[]`, non-empty unless op=`BRC20_INSCRIBE` (`… txParam.outputs is empty`); `unsignedHashList` non-empty
  (`… unsignedHashList is empty`); `signType` non-empty (`… missing signType`) and == `brc20Inscribe` for `BRC20_INSCRIBE` else `transfer`
  (`PREVIEW_INTENT_MISMATCH: expected signType <e>, got <g>`); `encoding` non-empty (`… missing encoding`).
  Returns (sorted): `{"asset":{"amount","readableAmount","symbol": token minus "btc-brc20-" or "BTC","tokenAddress": token|null},
  "chainIndex","changeAddress": txParam.changeAddress|null,"fee": txParam.fee|null,"feeRate": txParam.feeRate|null,
  "feeReadable": minimal_to_readable(fee (string/u64), nativeDecimals)|null,"feeSymbol":"BTC","from","inputs","network":"bitcoin",
  "operationType":op,"outputs","preExecution":{"executeErrorMsg": resp.executeErrorMsg|null,"executeResult":true},
  "signing":{"encoding","signType","unsignedItemCount":len},"to","transaction": txParam,"warnings": resp.warnings|[]}`.
  Oracle: fee `"1000"` with 8 decimals → `feeReadable "0.00001"`.
- `validation::bind_utxo_availability(preview, snapshot)` (223): selected = `collect_outpoints(preview.inputs)`; unavailable =
  `collect_outpoints(snapshot)`; if `/unavailableBreakdown/totalUnavailableCount` (u64/str) > unavailable count →
  `INCOMPLETE_UTXO_SNAPSHOT: unavailable UTXO count exceeds the returned outpoint set`; any selected ∈ unavailable →
  `PREVIEW_UTXO_UNAVAILABLE: selected inputs are unavailable: <a>, <b>`; else `preview.utxoAvailability =
  {"queryType":"UNAVAILABLE_BREAKDOWN","selectedAvailableInputs":[canonical…],"unavailable":snapshot}`.
- `validation::validate_preview_intent(preview, op, chainIndex, from, to?, amount?)` (270): `compare_if_present` (416) — if a key
  exists, its string (or u64 as string, else "") must equal expected else `PREVIEW_INTENT_MISMATCH: <field> changed from '<exp>' to '<act>'`
  — for `operationType|operation`, `chainIndex`, `from|fromAddr`, `to|toAddr` (if given), `asset.amount` (if given); then
  `validate_transaction_shape` (297): inputs array (`… missing inputs`); each input needs `txId|txHash` (`… input txId missing`),
  `vout|voutIndex` (`… input vout missing`), valid outpoint, unique (`INCOMPLETE_TRANSACTION_PREVIEW: duplicate input <op>`),
  `amount` string/u64 (`… input amount missing`) passing `parse_minimal(.., "input amount", false)`; optional input `address` must
  `same_address(address, from)` (`PREVIEW_INTENT_MISMATCH: input address is not the current account`); non-empty `changeAddress` must
  equal from (`… change address is not the current account`); outputs array (`… missing outputs`); each output `amount`
  (`… output amount missing`, `parse_minimal(.., "output amount", true)`) and `address` (`… output address missing`, `validate_recipient`);
  op ≠ `BRC20_INSCRIBE`: `to` required (`preview recipient is required`); an output whose address equals `to` required
  (`PREVIEW_INTENT_MISMATCH: recipient output is missing`); for `BTC_TRANSFER` its amount must equal amount.
- `validation::local_transaction_token(resp, preview)` (392): `"sha256:" + hex(SHA-256(JCS({"encoding": resp.encoding|null,
  "extraData": resp.extraData|null, "preview": preview, "signType": resp.signType|null, "unsignedHashList": resp.unsignedHashList|null})))`
  (RFC 8785 via `serde_jcs` 0.1.0). `is_local_continuation(t)` (407): `sha256:` + exactly 64 hex chars.
- `broadcast::submit_direct_transaction(api, ctx, prepared, signed, force)` (bitcoin/broadcast.rs:14): `build_direct_extra_data(.., label "Bitcoin")` → `BtcApi::broadcast_transaction`.
- `broadcast::submit_inscription_transactions(api, ctx, prepared, signed, token, amount, force)` (32): `sign_transaction` then
  `build_inscription_batch_body` (50): signed items = `signed.signedTxList` if non-empty array else `[signed]`; `signType`,
  `encoding` required from prepared (`unsignedInfo response is missing …`); `txParam` = prepared.txParam object, or JSON-string parsed, else `{}`;
  commit hash = first item's `txHash`; for item i: `signedTx` required (`sign-tx response item is missing signedTx`);
  extraData = prepared.extraData (object) or `{}` + `txHash` (item txHash or ""), `tokenAddress`, `txType:51`, `coinAmount`: amount,
  `toAdr`: own address, `checkBalance:true`, `encoding`, `signType`, `serviceCharge` (i=0: `txParam.commitFee`; i>0:
  `txParam.revealFees[i-1]` else `txParam.revealFee`; string or number→string; omitted if absent), `dependTx:[commitHash]` for i>0 when commit hash non-empty,
  `extJson` = existing extJson (object or JSON-string object) or `{}` with `batchBroadcastType:0`, `skipWarning:true` iff force;
  element = `{"accountId","address": i==0 ? own address : (txParam.commitAddress non-empty ? that : own),"chainIndex":"<idx>","extraData":<sorted JSON string>,"signedTx"}`.
  Then `batch_broadcast_transactions`. Oracle test bitcoin/broadcast.rs:221.
- `signing::sign_unsigned_hashes(resp, seed)` (bitcoin/signing.rs:10) = pipeline with profile Bitcoin.

### shared/adapters/sui
- `SuiContext::load(from)` (sui/context.rs:19): `load_chain_context("sui", Sui, "SUI", from, normalize_address-check, same_address)`;
  `chain_index_u64` error `SUI runtime chainIndex '<x>' is not numeric`.
- `SuiApi::token_metadata` (sui/api.rs:27): get-token-info (mapped: `ApiCodeError` → `CodedError{code,msg}` without data).
- `SuiApi::prepare_transaction(ctx,to,amount,coinType?)` (37): POST unsignedInfo `{"amount","chainIndex":<u64>,"contractAddr"?,"fromAddr","sessionCert","toAddr"}` + `idempotency-key` uuid; mapped; `first_data_item`.
- `SuiApi::prepare_contract_call(ctx,to?,amount,txBytes)` (70) / `build_contract_call_body` (121): `{"amount","chainIndex":<u64>,"contractAddr":"0x0","fromAddr","sessionCert","toAddr": to or "0x","txParam":{"txBytes":…}}` + idempotency-key.
- `SuiApi::broadcast_transaction` (101): `WalletApiClient::broadcast_transaction` (no trace headers).
- `identifiers::normalize_address(s)` (sui/identifiers.rs:8): trim, strip `0x`/`0X`, 1–64 hex chars else `SUI address must contain 1 to 64 hexadecimal characters`; → `0x` + lowercase left-padded to 64.
- `identifiers::normalize_coin_type(s)` (26): trim; no whitespace; split on first two `::` → package, module (identifier `[A-Za-z_][A-Za-z0-9_]*`),
  type (chars `[A-Za-z0-9_:,<>]` with balanced `<>`) else `SUI Coin Type must be a complete <package>::<module>::<type> value`;
  package normalised then leading zeros stripped (`0x0002`→`0x2`, all-zero→`0x0`). Oracles: `0x0002::sui::SUI`→`0x2::sui::SUI`; `SUI` → error.
  `NATIVE_COIN_TYPE = "0x2::sui::SUI"`.
- `signing::sign_unsigned_hashes` (sui/signing.rs:10) = pipeline with profile Sui.

### sign.rs helpers
- `pub(crate) async fn eip712_sign_raw(typed_data, chain_index, from_address) -> String` (sign.rs:218): used by `wallet sign-message`
  (non-force) and `agent_commerce/task/signing.rs`. Steps: G5; POST `gen-msg-hash` `{"chainIndex":"<idx>","payload":[{"message":<typed_data>,"msgType":"eip712"}]}`
  (errors `gen-msg-hash failed: code=<c> msg=<m>`); `msgHash = data[0].msgHash` else `missing msgHash in gen-msg-hash response`;
  seed via session.json + keyring `session_key` (`not logged in`) + HPKE; `sessionSignature = ed25519_sign_hex(msgHash)`;
  POST `sign-msg` `{"chainIndex","from","payload":[{"message":<typed_data>,"sessionSignature","signType":"eip712"}],"sessionCert"}`
  (errors `sign-msg failed: Wallet API error (code=<c>): <m>` — **no 81362 confirming mapping here**); returns `data[0].signature`
  else `missing signature in sign-msg response`. Note typed_data object keys are re-serialised sorted.
- `pub fn sign_eip7702_auth(hash) -> base64` (sign.rs:397): dead code (no callers).

### utxo/brc20.rs helpers used by transfer
- `select_brc20_transferable_utxos(snapshot, selections)` (utxo/brc20.rs:327): empty → `BRC-20 transfers require at least one --brc20-outpoint selected from wallet utxo brc20-transferable`;
  parse each (`invalid outpoint …`), duplicate → `BRC-20 UTXO <c> was selected more than once`; missing from snapshot →
  `selected BRC-20 UTXO is no longer transferable: <c>`; returns in request order.
- `Brc20TransferableUtxo::build_tx_param_input(addr)` (220) → `{"address","amount": utxoAmountRaw,"txId","vout":<number>}`.

### Other helpers named only (owned elsewhere)
- `account::resolve_account_address_for_chain(w, idx)` (account.rs:445): selected account; exact chainIndex match with non-empty address,
  else (if `chains::is_evm_chain(idx)`) first EVM-classified address; else `no address for chain "<idx>" on the selected account` (`account not found`).
- `funding::readable_shortfall(required, available) -> Option<String>` (funding.rs:278): plain non-negative decimals (`"5."`/`".5"` accepted, not both empty);
  `"0"` if required ≤ available else exact decimal difference, trailing zeros trimmed.
- `funding::resolve_funding_target(w, idx)` (funding.rs): `FundingTarget{accountName, chainIndex, chainName: chains::chain_display_name(idx), receiveAddress, gasFree: idx=="196", sameNetworkRequired:true}`.
- `funding::resolve_current_funding_bundle(idx, None)` (funding.rs:181): G5 + load wallets + `refresh_wallet_accounts_strict` (2 POSTs) + target + QR.
- `qr::build_qr_output(address, None)` (qr.rs:185): `QrOutput{requestedFormat:"auto", resolvedFormat?, displayMode:"terminal-unicode"|"image-notify", terminalQr?, imagePath?, mimeType?, markdownImage?, notifyCommandArgs?}`;
  mode = `CODEX_THREAD_ID` session metadata, else `terminal-unicode` iff stdout or stderr is a TTY, else `image-notify` (writes a PNG, see G6).
- `chains::chain_display_name(idx)`: `0|5` Bitcoin, `1` Ethereum, `10` Optimism, `56` BNB Chain, `137` Polygon, `195` Tron, `196` X Layer,
  `1952` X Layer Testnet, `250` Fantom, `324` zkSync, `501` Solana, `534352` Scroll, `607` TON, `784` Sui, `8453` Base, `42161` Arbitrum One,
  `43114` Avalanche, `59144` Linea, `5042` Arc, else idx.
- `chains::is_evm_chain(idx)`: cached entry `isEvmChain` bool if present, else static allowlist `1,10,56,137,196,250,324,1952,8453,42161,43114,59144,534352`.
- `token_alias::resolve_and_validate(chain, raw, "contract-token")`: alias (e.g. `usdc`) → CA, then chain-aware address-format check.
- `transfer::resolve_address(w, from?, chainName)` (transfer/mod.rs:26): with from → first (HashMap order) address with
  `address` eq-ignore-ascii-case from and `chainName == chainName` else `no address matches from=<f> chain=<c>`; without →
  `selectedAccountId` (`no currentAccountId`), entry (`not found currentAccountId`), first address with that chainName
  (`no address for chain=<c> in account=<id>`).
- `commands::token::fetch_search(client, q, chains, Some("10"), cursor, None)` (token.rs:614): GET `/api/v6/dex/market/token/search?chains=<resolve_chains>&search=<q>&limit=10[&cursor=<c>]` via `ApiClient` (JWT if a valid/refreshable access token exists, else anonymous).

---

## Commands

### `onchainos wallet chains`  (hidden: no)
- Handler: mod.rs:621 → chain.rs:16 `execute` → chain.rs:23 `cmd_list`.
- Options: none of its own; global `--chain` ignored; hidden global `--dev`.
- Auth: anonymous (post_public; no Authorization header; device headers sent).
- Steps:
  1. `get_all_chains()`: read `chain_cache.json`; fresh (non-empty, `now-updated_at < 600`) → use.
  2. Else POST `/priapi/v5/wallet/agentic/chain/support/list` body `{}`; chains = data array | data.chainList | `[]`; write `chain_cache.json`.
- Output: `data` = the chain entry array verbatim (backend objects; keys sorted per G3). Typical entry keys (backend-defined):
  `alias`, `chainIndex`, `chainName`, `isEvmChain`, `realChainIndex`, `showName`, `nativeSymbol`… (passthrough, not guaranteed).
- Errors: G4 transport/envelope errors (`Wallet API error (code=…): …`, `Network unavailable — …`, `Wallet API server error (HTTP …)…`);
  `failed to read chain_cache.json` / `failed to parse chain_cache.json: <serde>`; all exit 1.
- Side effects: read-only (server); writes `chain_cache.json` on miss.
- Nondeterminism: none in stdout.
- Parity test cases: `onchainos wallet chains` (SAFE); `onchainos wallet chains` twice within 10 min (second run: no HTTP) (SAFE);
  `onchainos --chain eth wallet chains` (SAFE, flag ignored).

### `onchainos wallet balance`  (hidden: no)
- Handler: mod.rs:623-660 (dispatch normalisation) → balance/mod.rs:583 `cmd_balance`.
- Options: `--all` (bool); `--chain <CHAIN>` (optional); `--token-address <TOKEN_ADDRESS>` (optional; needs `--chain` at runtime, not a clap `requires`);
  `--force` (bool, `default_value="false"`). No conflicts declared: `--all` wins over the others inside the handler.
- Auth: jwt-required (G5).
- Steps:
  1. **Dispatch** (only when both `--chain` and `--token-address` given): `chain_profile::resolve(chain)` (may fetch chain list; errors
     propagate, e.g. `unsupported chain: <x>`). Bitcoin driver → token := `normalize_brc20_token_address(token)` (so any non-BRC-20 token on
     Bitcoin fails with `BRC-20 token address must use btc-brc20-<ticker>`); Sui driver → token := `normalize_coin_type(token)`; others unchanged.
     This runs even when `--all` is also set.
  2. `ensure_chain_cache_fresh()` (silent chain list refresh if stale; errors ignored).
  3. G5 `ensure_tokens_refreshed()`.
  4. Load `wallets.json` else error `not logged in`. `WalletApiClient::new()`.
  5. **Scenario 1 `--all`**: account_ids = `accountsMap` keys (HashMap order); empty → `no wallet accounts found`.
     - If `!--force` and `balance_cache.json` has non-empty `accounts` and `now - batch_updated_at < 60` → filter cache to account_ids →
       output `{details, totalValueUsd}` (no HTTP).
     - Else GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances-batch?accountIds=<ids joined by "," → encoded %2C>` (errors `format_api_error`);
       `retain_requested_accounts`; for each group with string `accountId`: `account_data=[group]` → enrich usd → project 9 fields →
       `total = compute_total_value_usd` → entry `{updated_at: now, data: account_data, total_value_usd: total}`;
       `set_batch_balance_cache(entries)` (sets `batch_updated_at=now`, merges); reload cache, filter to account_ids, output.
  6. Resolve active account id (`resolve_active_account_id`, before any refresh).
  7. **Scenario 4 `--token-address`**: `--chain` missing → `--chain is required when using --token-address`. `chain_profile::resolve(chain)`.
     If Bitcoin and token (trimmed, lowercased) starts with `btc-brc20-` → `utxo::cmd_brc20_balance(token)` (see below) and return.
     Else GET `wallet-all-token-balances?accountId=<id>&chains=<chainIndex>&tokenAddresses[0].chainIndex=<chainIndex>&tokenAddresses[0].tokenAddress=<token trimmed>`
     (errors `format_api_error`); enrich; project; output `{details: data}`.
  8. **Scenario 3 `--chain` only**: resolve profile; GET `wallet-all-token-balances?accountId=<id>&chains=<chainIndex>`; enrich; project;
     output `{details, totalValueUsd}` (no sorting).
  9. **Scenario 2 (no flags)**: `ensure_wallet_accounts_fresh(force = --force)` (0 or 2 POSTs, best-effort, may rewrite wallets.json);
     GET `wallet-all-token-balances?accountId=<id>`; enrich; project; `sort_token_assets`; total; output identity + details.
  - BRC-20 sub-flow `cmd_brc20_balance(token)` (utxo/brc20.rs:100): normalise token; `BtcContext::load(None)` (G5 again, `chain_profile::resolve("bitcoin")`,
    wallet/address checks, possible forced account refresh); `BtcApi::token_metadata` → decimals (`extract_token_decimals`);
    **concurrently** (`tokio::try_join!`) `brc20_balance` (GET balances with tokenAddresses[0]…) and `brc20_transferable_utxos`
    (POST availability-details `BRC20_TRANSFERABLE_UTXO_LIST` + tokenAddress); `build_brc20_template_values` (23):
    asset = first `tokenAssets[]` entry (recursive, sorted-key search) with `tokenAddress` eq-ignore-case token else
    `BRC-20 balance response did not contain <token>`; `totalAmount` = asset.balance (string/u64) else `BRC-20 balance response is missing balance`;
    transferable UTXOs parsed (see brc20-transferable); `transferableRaw` = `/brc20TransferableUtxoList/sumValueRaw` (string/u64) else Σ valueRaw;
    `transferableAmount = minimal_to_readable(raw, decimals)`; `remainingInscribableAmount = totalAmount − transferableAmount` (exact decimal;
    negative → `transferable BRC-20 amount cannot exceed BRC-20 total amount`; non-plain decimal → `<field> must be a non-negative plain decimal`);
    `tokenPrice` = asset.tokenPrice if string/u64 **and** plain decimal else null; `totalUsd` = asset.usdValue same rule;
    `transferableUsd` / `remainingInscribableUsd` = exact decimal product with tokenPrice (null without price); `denominations` = readable
    token amount of each transferable UTXO; `count`; `ticker` = token minus `btc-brc20-`; plus `tokenAddress`.
- Output (`data`, sorted keys):
  - `--all`: `{"details":{"<accountId>":{"data":[<group>],"total_value_usd":"<x.xx>","updated_at":<unix s>}},"totalValueUsd":"<x.xx>"}`
    (details keyed/sorted by accountId; `<group>` = backend group passthrough with `tokenAssets`/`assets` trimmed to the 9 fields
    (enriched `usdValue`); entries written by `login_account_summary` are enriched but not trimmed; `totalValueUsd` = Σ cached `total_value_usd`).
  - `--chain X`: `{"details":<data>,"totalValueUsd":"<x.xx>"}`; `--chain X --token-address T`: `{"details":<data>}`.
  - default: `{"accountCount":<max(accounts,accountsMap)>,"accountId","accountName"(""),"btcAddress","details":<data sorted>,"evmAddress","solAddress","suiAddress","totalValueUsd"}`.
  - BRC-20: `{"count":n,"denominations":["1","2"],"remainingInscribableAmount","remainingInscribableUsd"|null,"ticker","tokenAddress","tokenPrice"|null,"totalAmount","totalUsd"|null,"transferableAmount","transferableUsd"|null}`.
    Oracle (utxo/brc20.rs:614): balance 4.25, price 1.2, usd 5.1, UTXOs 1e18+2e18 raw @18 dec → totalAmount "4.25", transferableAmount "3",
    remainingInscribableAmount "1.25", transferableUsd "3.6", remainingInscribableUsd "1.5", count 2, denominations ["1","2"].
  - `<data>` is the backend `data` (typically `[{accountId?, tokenAssets:[…]}]`) with each token = 9 whitelisted keys, `usdValue` string
    computed as `{:.6}` when missing.
- Errors: `not logged in`; `no wallet accounts found`; `--chain is required when using --token-address`; `unsupported chain: <x>`;
  normalisation errors above; `code=<c> msg=<m>` for API errors; BRC-20 path: BTC context errors, `CodedError` via `map_api_error`
  (`errorCode` = backend code), template errors. Exit 1.
- Side effects: read-only (server). Local writes: `balance_cache.json` (`--all` miss), `wallets.json` (default scenario refresh / BTC context
  refresh), `chain_cache.json`.
- Nondeterminism: `updated_at` in `--all` output; `accountIds` param order (HashMap iteration) in `--all`; account fallback when no
  selected/default account; cache-hit vs miss depends on wall clock.
- Parity test cases: `wallet balance` (SAFE); `wallet balance --chain ethereum` (SAFE); `wallet balance --chain 1 --token-address 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` (SAFE);
  `wallet balance --all --force` (SAFE); `wallet balance --chain bitcoin --token-address BTC-BRC20-ORDI` (SAFE).

### `onchainos wallet funding-check`  (hidden: no)
- Handler: mod.rs:661-674 → balance/mod.rs:866 `cmd_funding_check(chain, token_address or "", required, asset)`.
- Options: `--chain <CHAIN>` (required); `--token-address <ADDR>` (optional; omitted ⇒ `""` = native); `--required <REQUIRED>` (required, readable units);
  `--asset <ASSET>` (required, display symbol).
- Auth: jwt-required (but auth failures inside the balance query are reported as `balance_unavailable`, exit 0).
- Steps:
  1. `asset.trim()` empty → `--asset must not be blank`.
  2. `readable_shortfall(required, "0")` None → `--required must be a non-negative plain decimal`.
  3. `chain_profile::resolve(chain)` (errors propagate, exit 1).
  4. `query_token_readable(profile.chainIndex, token)` (G5, wallets, `ensure_wallet_accounts_fresh(false)`, GET balances `accountId`+`chains`).
     **Any error** → output blocked `balance_unavailable` (below) and exit 0.
  5. current = matched balance or `"0"` (absent = zero holding); symbol = matched non-empty symbol or trimmed `--asset`.
  6. shortfall = `readable_shortfall(required, current)`; None → error `wallet returned a non-decimal balance` (exit 1). sufficient ⇔ shortfall == "0".
  7. If insufficient: `resolve_current_funding_bundle(chainIndex)` (G5 + account/list + account/address/list + wallets.json rewrite + QR);
     error → blocked `funding_target_unavailable` (payload without fundingTarget/qr), exit 0; else add `fundingTarget`, `qr`.
- Output (`data`):
  `{"decision":"ready"|"blocked","nextAction":[],"payload":{"asset":{"symbol","tokenAddress"},"chainIndex","chainName": chain_display_name(idx),"currentBalance","fundingTarget"?:{"accountName","chainIndex","chainName","gasFree","receiveAddress","sameNetworkRequired"},"qr"?:{…QrOutput sorted},"required": <--required verbatim>,"shortfall","sufficient":bool},"phase":"funding_verification","reason":"funding_sufficient"|"insufficient_balance"|"funding_target_unavailable"}`.
  balance_unavailable variant: `{"decision":"blocked","nextAction":[],"payload":{"asset":{"symbol": <--asset trimmed>,"tokenAddress"},"chainIndex","chainName","currentBalance":null,"required","shortfall":null,"sufficient":null},"phase":"funding_verification","reason":"balance_unavailable"}`.
- Errors: validation errors above, `unsupported chain: <x>`, `wallet returned a non-decimal balance` (exit 1).
- Side effects: read-only (server); may rewrite `wallets.json`; may write a QR PNG (image-notify mode).
- Nondeterminism: `qr` content depends on TTY/Codex env (terminal vs image; image path has pid+ns timestamp).
- Parity test cases: `wallet funding-check --chain xlayer --required 1 --asset OKB` (SAFE); `wallet funding-check --chain 1 --token-address 0xdac17f958d2ee523a2206206994597c13d831ec7 --required 0 --asset USDT` (SAFE, ready);
  `wallet funding-check --chain 1 --required abc --asset ETH` (SAFE, local error `--required must be a non-negative plain decimal`).

### `onchainos wallet history`  (hidden: no)
- Handler: mod.rs:775-800 → history/query.rs:15 `cmd_query_history`.
- Options (all optional strings, no validation): `--account-id`, `--chain`, `--address`, `--begin` (ms), `--end` (ms), `--cursor`, `--limit`,
  `--order-id`, `--tx-hash`, `--uop-hash`. No `--page-num` (rejected by clap).
- Auth: jwt-required.
- Steps:
  1. G5.
  2. account = `--account-id` if non-empty, else wallets.json `selectedAccountId` (missing file or empty id → `not logged in`).
  3. If `--chain` non-empty: `chain::get_chain_by_real_chain_index(chain)` else `unsupported chain: <chain>`; chainIndex = entry `chainIndex` (string or i64) or `""`.
  4. **Detail mode** (any of `--tx-hash|--order-id|--uop-hash` present, even empty): chainIndex empty → `--chain is required for order detail query`.
     GET `/priapi/v5/wallet/agentic/order/detail?accountId=<id>&chainIndex=<idx>[&address=<a>][&txHash=…][&orderId=…][&uopHash=…]`
     (empty values dropped). Errors `format_api_error`. Output `filter_detail_response(data)`.
  5. **List mode**: GET `/priapi/v5/wallet/agentic/order/list?accountId=<id>[&begin][&end][&cursor][&limit][&chainIndex]` (that order; empty dropped).
     Output `filter_list_response(data)`.
- Mappings (history/response.rs): `map_tx_status` (string only; numbers map to `""`): `"1"|"2"`→`PENDING`, `"3"`→`ERROR`, `"4"`→`SUCCESS`,
  `"6"`→`CANCELLED`, other string unchanged. `map_direction`: `"1"`→`IN`, `"2"`→`OUT`, other string unchanged, non-string → `""`.
- Output:
  - Detail: array (data array, or `[data]`), each (sorted keys; missing fields emitted as `null`):
    `{"chainIndex","chainSymbol","coinAmount","coinSymbol","confirmedCount","direction": map_direction(txType),"explorerUrl","failReason","from","hideTxType","repeatTxType","serviceCharge","to","txHash","txStatus": mapped,"txTime"}`
    plus only-if-non-empty-string: `serviceChargeUsd`, `serviceChargeSymbol` (from `feeName`), `serviceChargeDecimal` (from `feeDecimalNum`),
    `feeRebate`, `feeRebateUsd`, `tipsType`, `contractName` (from `contractInfo.name`); if `feeContainCreateAccount` is a bool →
    `networkFeeLabel` = `"Network fee and Rent fee"` (true) / `"Network fee"` (false); `input`/`output` (only if arrays) = `[{"amount","direction": mapped,"name"}]`.
  - List: array (per data element) of `{"cursor": <string or "">, "orderList":[…]}`; each order:
    `{"chainSymbol","coinAmount","coinSymbol","confirmedCount","direction": map_direction(direction),"from","hideTxType","repeatTxType","serviceCharge","to","txCreateTime","txHash","txStatus","txTime"}`
    + non-empty-string-only `failReason`, `contractName`, `nftCollectionName`, `approveSymbol`, `tipsType`; if `assetChange` is an array:
    `assetChange` = `[{"coinAmount","coinSymbol","direction": mapped,"nftId"?,"nftImageUrl"?}]` and, when non-empty, top-level `direction`,
    `coinSymbol`, `coinAmount` are overwritten by the first change.
  Oracle: detail `[{"chainIndex":"0","txHash":"btc-hash","txStatus":"4"},{"chainIndex":"784","txStatus":"2"}]` → txStatus `SUCCESS`, `PENDING`.
- Errors: `not logged in`, `unsupported chain: <x>`, `--chain is required for order detail query`, `code=<c> msg=<m>`. Exit 1.
- Side effects: read-only. Nondeterminism: none added.
- Parity test cases: `wallet history --limit 20` (SAFE); `wallet history --limit 20 --cursor next-page-token` (SAFE);
  `wallet history --chain 1 --tx-hash 0xabc` (SAFE); `wallet history --tx-hash 0xabc` (SAFE, local error).

### `onchainos wallet receive`  (hidden: no)
- Handler: mod.rs:615-619 → receive.rs:25 `cmd_receive`.
- Options: `--chain <CHAIN>` (conflicts with `--token`, `--cursor`); `--token <TOKEN>`; `--cursor <CURSOR>` (clap `requires = "token"`). Violations → clap error exit 2.
- Auth: jwt-required (strict account refresh always runs).
- Steps:
  - Common `load_current_wallets()` (receive.rs:100): G5; load wallets (`not logged in`); `refresh_wallet_accounts_strict` (POST account/list,
    POST account/address/list; errors `code=<c> msg=<m>`; rewrites wallets.json).
  - `--chain X`: `chain_profile::resolve(X)` **first** (before auth); then load_current_wallets; `resolve_funding_target(w, profile.chainIndex)`
    (errors `no address for chain "<idx>" on the selected account` / `account not found` / `no wallet accounts found`); QR; output ready.
  - `--token Q`: `Q.trim()` empty → `Parameter --token cannot be empty`; load_current_wallets; `get_all_chains()`; search scope =
    distinct non-empty `chainIndex` (string/i64/u64) in list order joined by `,` (empty → `wallet receive could not resolve the supported-chain search scope`);
    chain names = `showName` else `chainName` per index; `ApiClient::new_async()`; GET `/api/v6/dex/market/token/search?chains=<scope>&search=<Q>&limit=10[&cursor=<c>]`
    (empty cursor omitted; errors propagate as core `ApiClient` errors); candidates = first 10 of `data` (array | `.list` | `.items`), skipping
    entries without a non-empty chainIndex: `{"chainIndex":"<s>","cursor": item.cursor|null,"networkName": chain name map or chain_display_name,"sequence": position+1 (1-based over the first 10 raw items),"tokenContractAddress": string or "","tokenName": |null,"tokenSymbol": |null}`.
    0 → blocked `token_not_found`; 1 → funding target for candidate chainIndex + token fields; >1 → selection.
  - neither: load_current_wallets; generic view.
- Output (`data`):
  - ready (chain or single token): `{"decision":"ready","nextAction":[],"payload":{"accountName","chainIndex","chainName","gasFree","qr":{…},"receiveAddress","sameNetworkRequired":true[,"networkName","tokenContractAddress","tokenName","tokenSymbol"]},"phase":"funding","reason":"funding_target_ready"}`.
  - not found: `{"decision":"blocked","nextAction":[],"payload":{"query":"<Q trimmed>"},"phase":"funding","reason":"token_not_found"}`.
  - selection: `{"decision":"requires_user_input","nextAction":[{"id":"select_receive_token","params":{"chainIndex","sequence","tokenContractAddress"},"recommend":false}…(+{"id":"more_receive_tokens","params":{"cursor","query"},"recommend":false} when exactly 10 candidates and the last has a non-empty cursor)],"payload":{"list":[candidates],"pagination":{"limit":10,"nextCursor":<last cursor>|null},"query"},"phase":"funding","reason":"token_selection_required"}`.
  - generic: `{"decision":"ready","nextAction":[{"id":"specify_funding_chain","params":{},"recommend":true},{"id":"search_receive_token","params":{},"recommend":false}],"payload":{"accountName","bitcoinAddress","evmAddress","evmQr","solanaAddress","suiAddress","xLayerAddress"},"phase":"funding","reason":"receive_addresses_ready"}` where
    evmAddress = first non-empty address with chainIndex ≠ 196 and `is_evm_chain`, else first non-empty 196 address, else null; evmQr = QR of evmAddress or null;
    xLayerAddress = first non-empty 196 address if different from evmAddress else null; solana `501`; bitcoin `0|5`; sui `784` (null when absent).
    Account resolution: `resolve_active_account_id`; `account not found` if the id has no map entry.
- Errors: `unsupported chain: <x>`, `Parameter --token cannot be empty`, scope error, address errors, `code=<c> msg=<m>`, core ApiClient errors. Exit 1.
- Side effects: read-only (server); rewrites `wallets.json`; may write QR PNG.
- Nondeterminism: QR display mode/image path (G6).
- Parity test cases: `wallet receive` (SAFE); `wallet receive --chain ethereum` (SAFE); `wallet receive --token USDT` (SAFE);
  `wallet receive --token USDT --cursor 9` (SAFE); `wallet receive --chain 1 --token USDT` (SAFE, clap error exit 2).

### `onchainos wallet sign-message`  (hidden: no)
- Handler: mod.rs:897-917 → sign.rs:11 `cmd_sign_message`.
- Options: `--type <TYPE>` (string, default `personal`; values `personal|eip712` checked at runtime); `--message <MESSAGE>` (required);
  `--chain <CHAIN>` (required); `--from <FROM>` (required); `--force` (bool).
- Auth: session-key signature (JWT + HPKE-decrypted Ed25519 session seed).
- Steps:
  1. Dispatch: `chain_profile::resolve(chain)` (`unsupported chain: <x>`); `message_sign == Unsupported` (Bitcoin, SUI, unknown chains) →
     `wallet sign-message is not supported for chain '<chainName>'`.
  2. Empty checks: `--message must not be empty`, `--chain must not be empty`, `--from must not be empty`.
  3. `--type`: `personal` / `eip712`, else `unsupported --type: <t>, expected 'personal' or 'eip712'`.
  - **personal** (sign.rs:84): `chain := chains::resolve_chain(chain)`; G5; `resolve_chain_and_address(chain, from)` (sign.rs:48):
    `get_chain_by_real_chain_index(chain)` (`unsupported chain: <chain>`), chainIndex (string or u64; `missing chainIndex in chain entry`),
    chainName (`missing chainName in chain entry`), wallets (`not logged in`), `transfer::resolve_address(w, Some(from), chainName)`
    (`no address matches from=<from> chain=<chainName>`) → from_address. session.json (`not logged in`), keyring `session_key`
    (`not logged in`), HPKE decrypt.
    - chain `"501"`: `sessionSignature = ed25519_sign_hex(hex(utf8(message)))` = base64(Ed25519(seed, message bytes)); message value = base58(utf8 bytes).
    - otherwise: if `is_hex_string(message)` (`0x` + only hex digits, `0x` alone included) → sign `0x0<rest>` when the hex part has odd
      length else message, encoding `hex`; else encoding `utf8`; `sessionSignature = ed25519_sign_eip191(...)`; message value = message verbatim (unpadded).
    - POST `/priapi/v5/wallet/agentic/pre-transaction/sign-msg` body
      `{"chainIndex":"<idx>","from":"<addr>","payload":[{"message":{"value":"<v>"},"sessionSignature":"<b64>","signType":"personalSign"}],"sessionCert":"<cert>"[,"skipWarning":true]}`
      (`skipWarning` iff `--force`). Errors `handle_confirming_error(e, force)`: code 81362 without `--force` → confirming (exit 2).
    - `output_sign_result` (sign.rs:425): `data` must be a non-empty array (`sign-msg: empty response data`), `data[0].signature` string
      (`missing signature in sign-msg response`); Solana → hex-decode (strip `0x`; `invalid hex signature from API: …`) and base58.
  - **eip712** (sign.rs:306): `chain := resolve_chain(chain)`; `"501"` → `eip712 signing is not supported on Solana (chain 501)`;
    parse `--message` as JSON (`--message must be valid JSON for eip712: <serde error>`); `resolve_chain_and_address` (as above, no G5 yet).
    - without `--force`: `eip712_sign_raw` (Shared helpers) → output `{"signature":…}`. 81362 is **not** mapped to confirming here
      (error `sign-msg failed: Wallet API error (code=81362): …`, exit 1).
    - with `--force`: G5; POST `gen-msg-hash` `{"chainIndex","payload":[{"message":<typed>,"msgType":"eip712"}]}` (`gen-msg-hash failed: code=<c> msg=<m>`);
      msgHash (`missing msgHash in gen-msg-hash response`); seed; `ed25519_sign_hex(msgHash)`; POST `sign-msg`
      `{"chainIndex","from","payload":[{"message":<typed>,"sessionSignature","signType":"eip712"}],"sessionCert","skipWarning":true}`
      (errors `handle_confirming_error(e,true)` ⇒ plain `Wallet API error (code=…): …`); `output_sign_result`.
- Output: EVM `{"signature":"<backend signature>"}`; Solana `{"publicKey":"<from address>","signature":"<base58>"}`.
  Confirming (personal, 81362, no `--force`): `{"confirming":true,"message":"<backend msg>","next":"If the user confirms, re-run the same command with --force flag appended to proceed."}` exit 2.
- Errors: as listed; exit 1 (2 for confirming).
- Side effects: FUND-MOVING-capable authorisation: `/pre-transaction/sign-msg` produces a wallet signature (no broadcast).
- Nondeterminism: none on the client side (Ed25519 deterministic); backend signature may vary.
- Parity test cases: `wallet sign-message --chain 1 --from <evm> --message hello` (UNSAFE: real signature);
  `wallet sign-message --chain solana --from <sol> --message hello` (UNSAFE);
  `wallet sign-message --type eip712 --chain 501 --from <sol> --message {}` (SAFE, local error);
  `wallet sign-message --chain bitcoin --from x --message y` (SAFE, `wallet sign-message is not supported for chain '<name>'`);
  `wallet sign-message --type foo --chain 1 --from 0x1 --message m` (SAFE, local error).

### `onchainos wallet inscription create`  (hidden: no)
- Handler: mod.rs:802-827 → inscription/bitcoin.rs:21 `cmd_create`.
- Options: `--chain <CHAIN>` (required; must resolve to a Bitcoin profile); `--token-address <T>` (required, `btc-brc20-<ticker>`);
  `--readable-amount <A>` (required); `--from <ADDR>` (optional; must be the current account's BTC address); `--operation-token <TOKEN>`
  (optional, continuation token `sha256:<64 hex>`); `--fee-rate <sat/vB>` (optional); `--force` (bool).
- Auth: session-key signature (with `--force`); jwt-required for preview.
- Steps:
  1. Dispatch: `chain_profile::resolve(chain)`; `inscription != Bitcoin` → `wallet inscription is not supported for chain '<chainName>'`.
  2. `normalize_brc20_token_address`; `parse_fee_rate` (if given).
  3. `--force` without `--operation-token` → `confirmed inscription requires --operation-token`; token without `--force` →
     `--operation-token is only valid with --force`; malformed token → `invalid Bitcoin preview continuation`.
  4. `BtcContext::load(from)`.
  5. POST get-token-info → decimals (`BRC-20 token metadata is missing decimal/decimals`); amount = `readable_to_minimal(readable, decimals)`.
  6. POST availability-details `{"address","chainIndex","queryType":"UNAVAILABLE_BREAKDOWN"}`.
  7. POST unsignedInfo (header `idempotency-key: <uuid4>`) body `{"amount":<minimal>,"chainIndex":<u64>,"contractAddr":<token>,"fromAddr":<own>,"sessionCert","signType":"brc20Inscribe","toAddr":<own>[,"txParam":{"feeRate":<number>}]}`
     → `first_data_item`; errors → `map_api_error` (CodedError; 44001/44002/44003 extras).
  8. `preview_from_response(prepared, "BRC20_INSCRIBE", idx, own, own, token, amount, readable, 8)`; `validate_preview_intent(.., to=own, amount)`;
     `bind_utxo_availability(preview, unavailable)`; `local = local_transaction_token(prepared, preview)`.
  9. next = `onchainos wallet inscription create --chain bitcoin --token-address <shell_arg(token)> --readable-amount <shell_arg(readable)> --operation-token <local>[ --fee-rate <json number>] --force` (`--from` is not carried).
  10. `--force` and token ≠ local → `WalletPreviewConfirming{scene:"btc_inscription", message:"The BRC-20 inscription changed after the previous preview. Review the refreshed funding inputs and fees before confirming again.", next, preview}` (exit 2).
  11. `--force` and token == local: seed (`SigningSeed::load`); `sign_unsigned_hashes(prepared, seed)` (Bitcoin profile); POST
      `pre-transaction/sign-tx`; build batch; POST `pre-transaction/batch-broadcast-transaction` (errors mapped via `map_api_error`);
      reveal = **last** broadcast item; nextSteps: `checkInscriptionStatus` with `--order-id <reveal orderId>` if non-empty, else `--tx-hash <reveal txHash>` if non-empty, else none.
  12. Without `--force`: `WalletPreviewConfirming{scene:"btc_inscription", message:"Review BRC-20 inscription. From: <own>. Ticker/token: <token>. Amount: <readable>. This submits an asynchronous inscription only; review every funding input, output, fee, and warning before confirming.", next, preview}` exit 2.
- Output (success): `{"accountId","amount":<minimal>,"broadcasts":[{"orderId","txHash"}…],"chainIndex","from","message":"BRC-20 inscription submitted. Inscription is asynchronous; query it later with the returned Reveal order ID.","nextSteps"?:{"checkInscriptionStatus":"…"},"orderId":<reveal>,"state":"INSCRIBING","tokenAddress","txHash":<reveal>}`.
  Confirming: G2 WalletPreviewConfirming with `preview` = the preview object (Shared helpers) incl. `utxoAvailability`.
- Errors: all validation/preview errors above (exit 1), `CodedError` from mapped API errors (exit 1, `errorCode` = backend code), confirming (exit 2).
- Side effects: preview → state (unsignedInfo); `--force` → **FUND-MOVING** (`/pre-transaction/sign-tx` + `/pre-transaction/batch-broadcast-transaction` broadcast commit + reveal BTC transactions).
- Nondeterminism: `idempotency-key` UUID header; `local` token changes whenever any prepared/preview/snapshot content changes.
- Parity test cases: `wallet inscription create --chain bitcoin --token-address btc-brc20-ordi --readable-amount 1` (SAFE: preview only, no funds; creates unsignedInfo);
  `… --readable-amount 1 --force` (SAFE, local error `confirmed inscription requires --operation-token`);
  `… --operation-token sha256:<64 hex> --force` (UNSAFE: broadcasts if token matches);
  `wallet inscription create --chain ethereum --token-address btc-brc20-x --readable-amount 1` (SAFE, not-supported error).

### `onchainos wallet inscription status`  (hidden: no)
- Handler: mod.rs:828-842 → inscription/bitcoin.rs:198 `cmd_query_status`.
- Options: `--chain <CHAIN>` (required, Bitcoin); `--tx-hash <H>` / `--order-id <ID>`: exactly one (clap `conflicts_with` + `required_unless_present`).
- Auth: jwt-required.
- Steps: profile check (as create); `BtcContext::load(None)`; `BtcApi::order_detail(ctx, tx_hash, order_id)` (GET order/detail with accountId,
  chainIndex, address, txHash|orderId; context validation → `ORDER_CONTEXT_MISMATCH: …`; API errors unmapped → `Wallet API error (code=…): …`);
  raw = `find_string(detail, ["status","txStatus"])` else `UNKNOWN`; status = uppercase(raw) mapped `1|2`→`INSCRIBING`, `3|6`→`FAILED`,
  `4`→`READY_TO_TRANSFER`, else uppercased raw; pending ⇔ status ∈ {INSCRIBING, WAITING_CONFIRMATION, WAITING_INDEXER};
  has_poll = `find_string(detail, ["nextQueryAt","pollAfterSeconds"])` present.
- Output: `{"detail":<detail passthrough>,"message":<msg>,"nextSteps"?,"orderId":<arg>|null,"status","txHash":<arg>|null}` where message:
  READY_TO_TRANSFER → `The BRC-20 inscription is ready. Refresh the transferable balance before starting a separate transfer.`;
  FAILED/UNKNOWN → `The BRC-20 inscription is not available; review the service detail before deciding whether to create another inscription.`;
  else with poll → `The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query again at the service-recommended time.`;
  else → `The BRC-20 inscription is asynchronous and is not ready to transfer yet. Query it again later with the returned transaction hash or order ID.`
  nextSteps: pending && poll → `{checkInscriptionStatus}` (tx-hash preferred); READY_TO_TRANSFER and `find_string(detail,["tokenAddress","contractAddr"])` → `{queryBrc20TransferableUtxos}`.
- Errors: `wallet inscription is not supported for chain '<name>'`, `either --tx-hash or --order-id is required` (unreachable via clap), BTC context errors, mismatch errors. Exit 1.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `wallet inscription status --chain bitcoin --order-id <id>` (SAFE); `wallet inscription status --chain bitcoin --tx-hash <h>` (SAFE);
  `wallet inscription status --chain bitcoin` (SAFE, clap error exit 2).

### `onchainos wallet utxo user-ignored` / `utxo unavailable` / `utxo available`  (hidden: no)
(Three leaves, identical flow, `utxo/query.rs:90 query_utxos`.)
- Handler: mod.rs:845-856 → utxo/query.rs:75 / :80 / :85.
- Options: `--chain <CHAIN>` (required).
- Auth: jwt-required.
- Steps:
  1. `ensure_bitcoin_command_chain(chain)` (mod.rs:587): `chain_profile::resolve`; not Bitcoin → `this UTXO command is only supported for Bitcoin`.
  2. `BtcContext::load(None)`.
  3. POST availability-details with queryType `USER_IGNORED_LIST` | `UNAVAILABLE_BREAKDOWN` | `AVAILABLE_UTXO_LIST`.
  4. outpoints = `collect_outpoints` of `/userIgnoredList` | `/unavailableBreakdown` | `/availableUtxoList` (whole snapshot if pointer missing).
  5. `brc20_utxo_asset_info(outpoints)` (batches of 10 in canonical-string order; none if empty).
  6. Annotate: every object in the snapshot with `txHash` (string) + `voutIndex` (u64 or string) whose key matches an asset record with a
     non-empty `assets` array gets `"assets": <that array>` (records keyed by `txHash:voutIndex` as given).
- Output: `{"accountId","address","<resultKey>":<annotated snapshot>,"message","outpointCount":n,"queryType"}` with
  resultKey/message: user-ignored → `userIgnored` / `Queried Bitcoin UTXOs whose asset occupancy was explicitly removed by the user.`;
  unavailable → `unavailable` / `Queried unavailable Bitcoin UTXO details and their current service reason categories.`;
  available → `available` / `Queried currently available Bitcoin UTXOs and their total spendable sats.`.
- Errors: chain error, BTC context errors, `CodedError` (mapped API), `BRC-20 UTXO asset details require Bitcoin chainIndex 0, got <x>`. Exit 1.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `wallet utxo available --chain bitcoin` (SAFE); `wallet utxo unavailable --chain btc` (SAFE); `wallet utxo user-ignored --chain bitcoin` (SAFE);
  `wallet utxo available --chain ethereum` (SAFE, local error).

### `onchainos wallet utxo brc20-transferable`  (hidden: no)
- Handler: mod.rs:857-864 → utxo/brc20.rs:245.
- Options: `--chain` (required); `--token-address <btc-brc20-…>` (required); `--readable-amount <A>` (optional).
- Auth: jwt-required.
- Steps: Bitcoin check; normalise token; `BtcContext::load(None)`; POST get-token-info → decimals; POST availability-details
  `BRC20_TRANSFERABLE_UTXO_LIST` + tokenAddress; parse UTXOs from `/brc20TransferableUtxoList/utxos` or `/utxos` (else none):
  per item i: `txHash` non-empty string, `voutIndex` (string/u64), valid outpoint, `utxoAmountRaw`, `valueRaw` (string/u64) — errors
  `transferable UTXO <i> is missing txHash|voutIndex|utxoAmountRaw|valueRaw`; `utxoId`/`inscriptionId` strings or "", `offset` string/u64 or null.
  choices (in snapshot order) = `{"inscriptionId","offset","selection":"<canonical>","tokenAddress","tokenAmount": minimal_to_readable(valueRaw, dec),"tokenAmountRaw","utxoAmountSats": utxoAmountRaw,"utxoId"}`;
  asset-info POSTs in transferable order (batches of 10); add `assets` to choices whose selection matches a record with non-empty assets.
  Selection plan (if `--readable-amount`): target = `readable_to_minimal(amount, dec)`; `find_exact_combination` (365): amounts =
  `parse_minimal(valueRaw, "transferable UTXO <i> valueRaw", false)` (zero → error); if any single UTXO equals target → up to 3 single-index
  combos (first 3 in order); else subset DP over a `BTreeMap<sum, Vec<combo>>` starting `{0:[[]]}`: for each index i (skip amounts > target),
  compute additions from the current states (ascending sum) with `next = sum+amount ≤ target`; for existing sums merge, sort by
  (len, lexicographic indexes), dedup, truncate to 3; for new sums, if states already hold 100000 entries → stop and return the
  combos at target if any else `SEARCH_LIMIT_EXCEEDED`; else insert. Result: combos at target → `EXACT_MATCH`, else `NO_EXACT_MATCH`.
- Output: `{"accountId","address","brc20Transferable":<snapshot>,"choices":[…],"count":n,"message":"Queried transferable BRC-20 inscription UTXOs. A transfer may use one or more returned selections whose token amounts exactly match the requested amount.","queryType":"BRC20_TRANSFERABLE_UTXO_LIST","selectionPlan":null|{"combinationCount","combinations":[{"selectedChoices":[choice…],"selectedCount","selectedOutpoints":[…]}],"maxCombinations":3,"requestedAmount":<raw arg>,"requestedAmountRaw","searchStateLimit":100000,"status":"EXACT_MATCH"|"NO_EXACT_MATCH"|"SEARCH_LIMIT_EXCEEDED"},"sumValue": readable|null,"sumValueRaw": string|null,"tokenAddress"}`.
  Oracles: two UTXOs 1e18 + 2e18 (18 dec): amount "3" → EXACT_MATCH, 1 combo of 2; "4" → NO_EXACT_MATCH `[]`; four UTXOs of 1 token with "1" → 3 single combos.
- Errors: as listed + amount conversion errors. Exit 1.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `wallet utxo brc20-transferable --chain bitcoin --token-address btc-brc20-ordi` (SAFE);
  `… --readable-amount 100` (SAFE); `… --token-address ordi` (SAFE, `BRC-20 token address must use btc-brc20-<ticker>`).

### `onchainos wallet utxo unlock`  (hidden: no)
- Handler: mod.rs:865-874 → utxo/manage.rs:19 → `manage("ignoreAsset","btc_utxo_unlock","UNAVAILABLE_BREAKDOWN",…)` (:63).
- Options: `--chain` (required); `--outpoint <txHash:vout>` (repeatable; clap: conflicts with `--all`, required unless `--all`);
  `--all` (bool, conflicts with `--outpoint`); `--operation-token <sha256:…>`; `--force`.
- Auth: jwt-required.
- Steps:
  1. Bitcoin check; `--all` xor outpoints else `use exactly one of --outpoint or --all`.
  2. `validate_manage_continuation`: `--force` without token → `confirmed UTXO protection changes require the preview continuation`;
     token without `--force` → `preview continuation parameters are only valid with --force`; malformed token → CodedError
     `INVALID_PREVIEW_CONTINUATION`, field `operationToken`, message `Invalid UTXO preview continuation: --operation-token must be the sha256 token returned by the preview`.
  3. `BtcContext::load(None)`; POST availability-details `UNAVAILABLE_BREAKDOWN`.
  4. Candidates: `--all` and `has_group_items(/unavailableBreakdown/assetUncertain)` (group `count` > 0 or any outpoint) → CodedError
     `INCOMPLETE_SNAPSHOT` `All protected UTXOs cannot be unlocked while assetUncertain contains unresolved outpoints` data `{"assetUncertain":<group|null>}`;
     locked = `collect_outpoints(/unavailableBreakdown/assetLocked)`; `--all` and locked empty but assetLocked has items → `INCOMPLETE_SNAPSHOT`
     `assetLocked reports protected UTXOs without complete outpoints` data `{"assetLocked":…}`.
  5. Targets: `--all` → locked (canonical-string order; empty → `no matching UTXOs were returned by the current service snapshot`);
     else parse each (`invalid outpoint '<s>': …`), dup → `duplicate --outpoint <c>`, missing → CodedError `STATE_CHANGED` field `outpoint`
     `The requested outpoint <c> is not present in the latest UTXO snapshot`; sorted by (txHash, vout numeric).
  6. preview `{"chainIndex","from":<own>,"message":"User confirmed removal of UTXO asset protection","network":"bitcoin","operationType":"UNLOCK_UTXO_PROTECTION","snapshot":<snapshot>,"targets":[canonical…]}`.
  7. token = `"sha256:" + hex(SHA-256(JCS({"accountId","chainIndex","from","network":"bitcoin","operationType","targets"})))` (manage.rs:295).
  8. next = `onchainos wallet utxo unlock --chain bitcoin --outpoint <t1> --outpoint <t2>… --operation-token <token> --force` (explicit outpoints even for `--all`).
  9. `--force`: token ≠ supplied → WalletPreviewConfirming (message `The supplied UTXO confirmation does not match the current account, operation, or target outpoints. Review the refreshed preview before confirming again.`, scene `btc_utxo_unlock`) exit 2.
     Else for each chunk of 50 targets (batch index k): POST `/priapi/v5/wallet/agentic/utxo/user-asset-manage`
     `{"action":"ignoreAsset","chainIndex","message":"User confirmed removal of UTXO asset protection","utxos":[{"txHash","voutIndex":"n"}]}` (no retry);
     normalise: data must be a 1-element array (`UTXO management response data must be an array` / `… must contain exactly one item`) with bool
     `result` (`UTXO management response item is missing boolean result`) → `{"batchIndex":k,"outpoints":[…],"reason": item.reason or item.resaon or null,"result":bool}`
     (normalisation errors abort immediately, exit 1); stop after the first `result:false` or API/transport error. Then always POST availability-details
     `UNAVAILABLE_BREAKDOWN` and `USER_IGNORED_LIST`. API error → its CodedError with `data = {"batchResults","serviceData"?: original data,"unavailable","userIgnored"}`;
     non-API error → CodedError `UTXO_MANAGE_RESULT_UNKNOWN` `UTXO management result is unknown: <outermost message>` with that data.
     Any `result:false` → CodedError `UTXO_MANAGE_PARTIAL_FAILURE` (if any batch succeeded) else `UTXO_MANAGE_REJECTED`, message
     `One or more UTXO protection changes were rejected`, data `{"batchResults","failed","unavailable","userIgnored"}`.
  10. Without `--force`: WalletPreviewConfirming scene `btc_utxo_unlock`, message `Review protection removal for <n> UTXO(s). Every target and the latest availability snapshot are included in preview. Confirm only if changing protection for these UTXOs is acceptable.` exit 2.
- Output (success): `{"batchResults":[…],"message":"UTXO asset protection was removed. The latest UTXO state is included.","targets":[…],"unavailable":<snapshot>,"userIgnored":<snapshot>}`.
- Errors: listed above; exit 1 / 2.
- Side effects: state-changing (server): `/utxo/user-asset-manage` (`--force` only). No funds.
- Nondeterminism: none (token deterministic for the same account/targets).
- Parity test cases: `wallet utxo unlock --chain bitcoin --all` (SAFE: preview only, exit 2); `wallet utxo unlock --chain bitcoin --outpoint <tx>:0` (SAFE, preview);
  `wallet utxo unlock --chain bitcoin --all --force` (SAFE, local error); `wallet utxo unlock --chain bitcoin --outpoint <tx>:0 --operation-token sha256:<t> --force` (UNSAFE: state change).

### `onchainos wallet utxo lock`  (hidden: no)
- Handler: mod.rs:875-884 → utxo/manage.rs:41 → `manage("cancelIgnore","btc_utxo_lock","USER_IGNORED_LIST",…)`.
- Options: same as unlock (`--chain` required, `--outpoint`/`--all` exactly one, `--operation-token`, `--force`).
- Auth: jwt-required.
- Steps: identical to unlock except: snapshot query `USER_IGNORED_LIST`; candidates = `collect_outpoints(/userIgnoredList or snapshot)` (no
  INCOMPLETE_SNAPSHOT checks); action `cancelIgnore`; message `User confirmed restoration of UTXO asset protection`; operationType
  `LOCK_UTXO_PROTECTION`; next `onchainos wallet utxo lock --chain bitcoin …`; scene `btc_utxo_lock`; preview confirmation message
  `Review protection restoration for <n> UTXO(s). …`; success message `UTXO asset protection was restored. The latest UTXO state is included.`
- Output / Errors: as unlock.
- Side effects: state-changing (server) with `--force`.
- Nondeterminism: none.
- Parity test cases: `wallet utxo lock --chain bitcoin --all` (SAFE preview); `wallet utxo lock --chain bitcoin --outpoint <tx>:1` (SAFE preview);
  `wallet utxo lock --chain bitcoin --all --operation-token sha256:<t> --force` (UNSAFE).

### `onchainos wallet utxo reclaim`  (hidden: no)
- Handler: mod.rs:885-892 → utxo/reclaim.rs:20.
- Options: `--chain` (required); `--tx-hash <H>` (required, repeatable); `--force`.
- Auth: jwt-required.
- Steps:
  1. Bitcoin check. Empty list → `at least one --tx-hash is required`. Normalise each `trim().to_ascii_lowercase()` into a sorted set;
     size differs → `duplicate --tx-hash values are not allowed`; each must parse as a Txid → `invalid --tx-hash '<h>': <bitcoin error>`.
  2. `BtcContext::load(None)`; POST availability-details `UNAVAILABLE_BREAKDOWN`; `mempoolRemoved = /unavailableBreakdown/mempoolRemovedSpending` or null;
     no outpoints → CodedError `NO_RECLAIMABLE_UTXO` `The latest UTXO snapshot has no mempool-removed spending occupancy to reclaim` data `{"mempoolRemovedSpending":…}`.
  3. For each hash (sorted): `BtcApi::order_detail(ctx, Some(hash), None)` (GET order/detail; unmapped errors).
  4. Without `--force`: WalletPreviewConfirming scene `btc_utxo_reclaim`, message `Review the original transaction hashes and the current mempool-removed occupancy snapshot. The service validates their reclaim relationship. Reclaim closes removed transactions; it does not broadcast a transaction or create an unconfirmed change output.`,
     next `onchainos wallet utxo reclaim --chain bitcoin --tx-hash <h1> --tx-hash <h2> --force`, preview
     `{"chainIndex","currentMempoolRemovedInputOutpoints":[canonical…],"effect":"Close the removed original transaction and release service-side spending occupancy for inputs that remain unspent on chain.","from","mempoolRemovedSpending","network":"bitcoin","operationType":"RECLAIM_MEMPOOL_REMOVED_UTXOS","transactionDetails":[detail…],"txHashList":[…]}` exit 2.
  5. `--force`: POST `/api/v5/wallet/pre-transaction/close-transaction` `{"chainIndex","txHashList":[sorted lowercase]}` (no retry; errors → `map_api_error`);
     validate: data array (`close-transaction response data must be an array`), each item non-empty `txHash` (`close-transaction item is missing txHash`),
     lowercased ∈ requested (`close-transaction returned an unexpected txHash <h>`), unique (`… duplicate txHash <h>`), bool `closed`
     (`close-transaction item is missing closed`), cover all (`close-transaction response does not cover every requested txHash`);
     POST availability-details `UNAVAILABLE_BREAKDOWN`; any `closed:false` → CodedError `RECLAIM_NOT_CLOSED` `One or more mempool-removed transactions were not closed`
     data `{"failedTxHashes","result","unavailable"}`.
- Output (success): `{"message":"The close-transaction request finished. Use each returned closed value and the latest unavailable UTXO snapshot as the authoritative result.","result":<data>,"unavailable":<snapshot>}`.
- Errors: listed; exit 1 / 2.
- Side effects: state-changing (server) with `--force` (`close-transaction`). No broadcast.
- Nondeterminism: none.
- Parity test cases: `wallet utxo reclaim --chain bitcoin --tx-hash <64hex>` (SAFE preview); `wallet utxo reclaim --chain bitcoin --tx-hash abc` (SAFE, local error);
  `wallet utxo reclaim --chain bitcoin --tx-hash <h> --tx-hash <H uppercase same>` (SAFE, duplicate error); `… --force` (UNSAFE, state).

### `onchainos wallet gas-station status`  (hidden: no)
- Handler: gas_station.rs:30 → `cmd_status` (:116).
- Options: `--chain <CHAIN>` (required); `--from <ADDR>` (optional).
- Auth: jwt-required (+ session.json for `sessionCert`).
- Steps:
  1. `build_gs_context(chain, from)` (:60): G5; `idx = chains::resolve_chain(chain)`; `get_chain_by_real_chain_index(idx)` else `unsupported chain: <chain>`;
     `chainName` (`chain entry missing chainName`); wallets (`not logged in`); `transfer::resolve_address(w, from, chainName)`; session.json
     (`not logged in`); `addr.chainIndex` must parse u64 (`chain id '<x>' is not a valid number`).
  2. Probe (:93): POST `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` body
     `{"amount":"0","chainIndex":<u64>,"chainPath":<addr.chainPath>,"fromAddr":<addr>,"inputData":"0x","sessionCert":<cert>,"toAddr":<addr>}`
     (no extra headers; errors `format_api_error`; `unsignedInfo: expected data to be an array` / `… data array is empty` / `… failed to parse response`).
  3. recommendation (:160): `hasPendingTx` → `HAS_PENDING_TX`; `insufficientAll` → `INSUFFICIENT_ALL`; else by `gasStationStatus`:
     `READY_TO_USE|NOT_APPLICABLE`→`READY`, `FIRST_TIME_PROMPT`→`ENABLE_GAS_STATION`, `PENDING_UPGRADE`→`PENDING_UPGRADE`,
     `REENABLE_ONLY`→`REENABLE_GAS_STATION`, `INSUFFICIENT_ALL`→`INSUFFICIENT_ALL`, `HAS_PENDING_TX`→`HAS_PENDING_TX`,
     `NOT_SUPPORT_INTENTION`→`NOT_SUPPORT_INTENTION`, other/empty → `ENABLE_GAS_STATION` if `gasStationUsed` else `READY`.
- Output: `{"chainId":<addr.chainIndex string>,"chainName","fromAddress","gasStationActivated": status==READY_TO_USE,"gasStationDefaultToken": defaultGasTokenAddress or null,"gasStationStatus":<raw string, "" if null>,"hasPendingTx","insufficientAll","recommendation","tokenList":[{"balance","feeTokenAddress","relayerId","serviceCharge","sufficient","symbol"}]}`
  (UnsignedInfoResponse nullable fields default to ""/false/[]).
- Errors: listed; `code=<c> msg=<m>`. Exit 1.
- Side effects: server-side unsignedInfo prepare only (state class, no broadcast, no funds).
- Nondeterminism: none.
- Parity test cases: `wallet gas-station status --chain ethereum` (SAFE: no funds); `wallet gas-station status --chain 42161 --from <evm>` (SAFE);
  `wallet gas-station status --chain nochain` (SAFE, `unsupported chain: nochain`).

### `onchainos wallet gas-station setup`  (hidden: no)
- Handler: gas_station.rs:31-36 → `cmd_setup` (:199).
- Options: `--chain` (required); `--gas-token-address` (required); `--relayer-id` (required); `--from` (optional).
- Auth: session-key signature (via transfer send path) / jwt-required.
- Steps:
  1. `build_gs_context`; probe (as status).
  2. status READY_TO_USE and non-empty default == `--gas-token-address` (ASCII case-insensitive) → output already-activated.
  3. status READY_TO_USE (different/empty default) → POST `/priapi/v5/wallet/agentic/gas-station/update-default-token`
     `{"chainIndex":<addr.chainIndex>,"fromAddr":<addr>,"gasTokenAddress":<arg>}` (errors `format_api_error`) → output switched.
  4. status not in {FIRST_TIME_PROMPT, PENDING_UPGRADE, REENABLE_ONLY, unknown/empty} → error
     `Cannot setup Gas Station: backend reports state '<raw status>' which is not first-time-eligible. Run \`wallet gas-station status --chain <chain>\` for diagnostics.`
  5. Else `transfer::cmd_send(amt "1", recipient = own address, chain = resolve_chain(chain), from, contract_token = gas token, force = true, gas_token_address, relayer_id, enable_gas_station = true)`
     — self-transfer of 1 minimal unit of the gas token with Gas Station activation (transfer-owned; prints its own output; may return
     `CliSetupRequired` exit 3 / confirming exit 2 per transfer rules).
- Output: already: `{"alreadyActivated":true,"chainId","chainName","defaultToken":{"feeTokenAddress":<probe default>},"gasStationActivated":true,"needs7702Upgrade":false,"summary":"Gas Station already enabled with the requested default token. No action taken.","txHash":null}`;
  switched: `{"alreadyActivated":true,"chainId","chainName","defaultToken":{"feeTokenAddress":<arg>,"relayerId":<arg>},"defaultTokenSwitched":true,"gasStationActivated":true,"needs7702Upgrade":false,"summary":"Gas Station was already enabled; only the default gas token was switched (server-side flag flip, no on-chain transaction).","txHash":null}`;
  first-time: transfer send output.
- Errors: listed + transfer errors.
- Side effects: **FUND-MOVING** in step 5 (`/pre-transaction/broadcast-transaction` via transfer send, pays GS service charge); state in step 3.
- Nondeterminism: transfer path (tx hash etc.).
- Parity test cases: `wallet gas-station setup --chain 42161 --gas-token-address <usdc> --relayer-id <id>` (UNSAFE);
  `wallet gas-station setup --chain 42161 --gas-token-address x` (SAFE, clap error: missing `--relayer-id`).

### `onchainos wallet gas-station update-default-token`  (hidden: no)
- Handler: gas_station.rs:12-19 → `fetch_update_default_token` (:304).
- Options: `--chain` (required); `--gas-token-address` (required).
- Auth: jwt-required (+ session.json presence).
- Steps: `build_gs_context(chain, None)`; POST `/priapi/v5/wallet/agentic/gas-station/update-default-token`
  `{"chainIndex":<resolve_chain(chain)>,"fromAddr":<selected account address for chainName>,"gasTokenAddress":<arg>}` (errors `format_api_error`).
- Output: if backend `data` is an object → data + `"message"`; otherwise `{"data":<data>,"message":<msg>}` where msg is always
  `Default Gas token on Solana updated. The chain will pay Gas with the selected stablecoin by default.` (hard-coded "Solana" for every chain).
- Errors: context errors, `code=<c> msg=<m>`. Exit 1.
- Side effects: state-changing (server).
- Nondeterminism: none.
- Parity test cases: `wallet gas-station update-default-token --chain solana --gas-token-address EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (UNSAFE: state);
  `wallet gas-station update-default-token --chain nochain --gas-token-address x` (SAFE, `unsupported chain: nochain`).

### `onchainos wallet gas-station enable` / `gas-station disable`  (hidden: no)
- Handler: gas_station.rs:20-29 → `fetch_update(chain, true|false)` (:324).
- Options: `--chain` (required).
- Auth: jwt-required (session.json not required).
- Steps: G5; `idx = resolve_chain(chain)`; `get_chain_by_real_chain_index(idx)` (`unsupported chain: <chain>`); chainName (`chain entry missing chainName`);
  wallets (`not logged in`); `transfer::resolve_address(w, None, chainName)`; POST `/priapi/v5/wallet/agentic/gas-station/update`
  `{"chainIndex":"<idx>","enabled":true|false,"fromAddr":<addr>}` (errors `format_api_error`).
- Output: data object + `message`, or `{"data","message"}`; enable → `Gas Station is now enabled on Solana. The chain will pay Gas with stablecoins.`;
  disable → `Gas Station is now disabled on Solana. The chain will pay Gas with SOL; you can re-enable any time.` (hard-coded).
- Errors: as listed. Exit 1.
- Side effects: state-changing (server; DB flag only).
- Nondeterminism: none.
- Parity test cases: `wallet gas-station enable --chain solana` (UNSAFE: state); `wallet gas-station disable --chain solana` (UNSAFE: state);
  `wallet gas-station enable --chain nochain` (SAFE, error).

### `onchainos wallet send`  (hidden: no) — dispatch-level only (handlers owned by transfer group)
- Handler: mod.rs:675-774.
- Options: `--amt <AMT>` (conflicts `--readable-amount`); `--readable-amount <A>`; `--recipient <ADDR>` (required); `--chain <CHAIN>` (required);
  `--from <ADDR>`; `--contract-token <TOKEN>`; `--brc20-outpoint <txHash:vout>` (repeatable, clap `requires = "contract_token"`);
  `--fee-rate <sat/vB>`; `--force`; `--gas-token-address`; `--relayer-id`; `--enable-gas-station`.
- Auth: session-key signature (transfer).
- Steps (dispatch): `chain_profile::resolve(chain)`:
  - Bitcoin: `--amt` → `Bitcoin transfers require --readable-amount`; any GS flag → `Gas Station is not supported for Bitcoin transfers`;
    → `transfer::bitcoin::cmd_send(readable?, recipient, from, contract_token, brc20_outpoints, fee_rate, force)`.
  - Sui: `--brc20-outpoint` → `--brc20-outpoint is only supported for Bitcoin BRC-20 transfers`; `--amt` → `SUI transfers require --readable-amount`;
    GS flag → `Gas Station is not supported for SUI transfers`; `--fee-rate` → `--fee-rate is only supported for Bitcoin transfers`;
    no readable → `--readable-amount is required`; → `transfer::sui::cmd_send(readable, recipient, from, contract_token, force)`.
  - Otherwise (LegacyAccount **and Unsupported** drivers): same `--brc20-outpoint` / `--fee-rate` errors; `chain := chains::resolve_chain(raw chain)`;
    `contract_token := token_alias::resolve_and_validate(chain, ct, "contract-token")`; `raw_amt = resolve_send_amount` (mod.rs:484):
    - `--amt`: trim; empty → `--amt must not be empty`; contains `.` → `--amt must be a whole number in minimal units (no decimals)`;
      non-digit → `--amt must be a whole number in minimal units, got "<v>"`; all zeros → `--amt must be greater than zero`;
      leading `0` → `--amt must not have leading zeros, got "<v>"`.
    - `--readable-amount`: trim; empty → `--readable-amount must not be empty`; native → decimals 9 for chain `501`/`784`, else 18;
      token → G5, `resolve_chain(chain)` must parse u64 (`chain id '<x>' is not a valid number for token-info lookup`), POST
      `token/get-token-info` `{"chainIndex":<u64>,"source":0,"tokenAddress":<ct>}` (error `Failed to fetch token decimals for <ct>: <outermost error>. Use --amt with raw minimal units instead.`);
      entry = `data[0]` or data; field `decimals` (if non-null) else `decimal`: string → u32 (`Invalid decimal value "<s>" for token <ct>`),
      number → `as_u64` truncated to u32 (`Invalid decimal value for token <ct>`), else `Token decimal not found for <ct>. Use --amt with raw minimal units instead.`;
      `readable_to_minimal_str(readable, decimals)`.
    - neither → `Either --amt or --readable-amount is required`.
    → `transfer::cmd_send_with_readable(raw_amt, readable?, recipient, chain, from, contract_token, force, gas_token, relayer, enable_gs)`.
- Output / later errors: transfer-owned.
- Side effects: **FUND-MOVING** (`/pre-transaction/broadcast-transaction`).
- Nondeterminism: transfer-owned.
- Parity test cases: `wallet send --chain 1 --recipient 0x1 --amt 1.5` (SAFE, local error); `wallet send --chain bitcoin --recipient bc1q… --amt 1` (SAFE, error);
  `wallet send --chain sui --recipient 0x1 --readable-amount 1 --fee-rate 2` (SAFE, error); `wallet send --chain 1 --recipient <addr> --readable-amount 0.001 --force` (UNSAFE).

### `onchainos wallet contract-call`  (hidden: no) — dispatch-level only (handlers owned by transfer group)
- Handler: mod.rs:918-1004.
- Options: `--to`, `--chain` (required), `--amt` (default `"0"`), `--input-data`, `--unsigned-tx` (conflicts `--sui-tx-bytes`),
  `--sui-tx-bytes` (conflicts `--input-data`, `--unsigned-tx`), `--gas-limit`, `--from`, `--aa-dex-token-addr`, `--aa-dex-token-amount`,
  `--mev-protection`, `--jito-unsigned-tx`, `--force`, `--gas-token-address`, `--relayer-id`, `--enable-gas-station`, `--biz-type`, `--strategy`.
- Auth: session-key signature.
- Steps (dispatch): `chain_profile::resolve(chain)`; `!contract_call` (Bitcoin, unknown) → `wallet contract-call is not supported for chain '<chainName>'`.
  Sui: `--input-data`/`--unsigned-tx` → `SUI contract calls require --sui-tx-bytes, not --input-data or --unsigned-tx`; missing
  `--sui-tx-bytes` → `--sui-tx-bytes is required for SUI contract calls`; any of gas-limit/aa-dex/mev/jito/GS flags →
  `EVM/Solana-only contract-call options are not supported with --sui-tx-bytes`; → `transfer::sui::cmd_contract_call(tx_bytes, to?, amt, from, force, biz_type, strategy)`.
  Else: `--sui-tx-bytes` → `--sui-tx-bytes is only supported for SUI contract calls`; `--to` missing → `--to is required for EVM and Solana contract calls`;
  → `transfer::cmd_contract_call(to, <raw chain>, …)`.
- Side effects: **FUND-MOVING**. Parity: `wallet contract-call --chain 1 --input-data 0x` (SAFE, `--to` error); `wallet contract-call --chain bitcoin --to x` (SAFE, not supported);
  `wallet contract-call --chain 1 --to <c> --input-data 0x… --force` (UNSAFE).

### `onchainos wallet login`  (hidden: no) — dispatch-level only
- Handler: mod.rs:597-610. Options: `--phase init|open|poll` (ValueEnum, default `init`), `--url`, `--session-id`.
  `--phase open` without `--url` → error ``\`--url\` is required for \`--phase open\``` (exit 1). Everything else auth-owned (auth/mod.rs:761/814/831).
- Auth: auth. Side effects: auth (login). Parity: `wallet login --phase open` (SAFE, local error).

### `onchainos wallet add` / `switch` / `status` / `addresses` / `logout`  (hidden: no) — dispatch-level only
- Handlers: `auth::cmd_add` (auth/mod.rs:1043), `account::cmd_switch` (account.rs:48, synchronous local wallets.json update →
  `{"ok":true}` via `success_empty`), `account::cmd_status` (account.rs:218; hidden `--include-subscriptions` accepted and ignored),
  `account::cmd_addresses(chain)` (account.rs:316), `auth::cmd_logout` (auth/mod.rs:1176). Behaviour documented by the auth/account partition.

### `onchainos wallet geoblock`  (hidden: no) — dispatch-level only (geoblock.rs, not in this partition)
- Handler: geoblock.rs:5. GET `/priapi/v5/wallet/agentic/geoblock/check` with **no request headers** (`get_no_okheaders`); prints raw
  `{"blocked":true|false}` (not the standard envelope) from `data[0].blocked`; else error `malformed response: missing data[0].blocked` (exit 1).
- Parity: `wallet geoblock` (SAFE).

### `onchainos wallet report-plugin-info`  (hidden: no) — dispatch-level only (plugin.rs, not in this partition)
- Handler: plugin.rs:9. `--plugin-parameter` (required); blank → `--plugin-parameter must not be empty`; G5; POST
  `/priapi/v5/wallet/agentic/pre-transaction/report-plugin-info` `{"pluginParameter":…}`; errors `format_api_error`; output data passthrough.
- Side effects: state (telemetry report). Parity: `wallet report-plugin-info --plugin-parameter " "` (SAFE, local error).

---

## Open questions
1. **Global `--chain` value propagation**: `onchainos --chain X wallet balance` — clap 4 propagates parent global values into child
   matches with the same id when the child did not set it; whether this makes it behave like `wallet balance --chain X` (and whether a
   required subcommand `--chain` is satisfied) was not verified against clap 4's exact version. Treat as untested edge.
2. **Rust float rounding**: `{:.2}`/`{:.6}` on f64 is assumed to round the exact binary value with ties-to-even (current Rust
   `core::fmt` behaviour); JS `toFixed` rounds ties up. Needs a runtime check with the release toolchain (stable 2026-03-27).
3. **`sort_token_assets` comparator** is not a strict weak order when two different chains have identical USD totals and a chain has
   several tokens; Rust ≥1.81 `sort_by` output is unspecified (may even panic). Upstream output for that case is undefined.
4. **rust-bitcoin 0.32.11 error texts** in `invalid outpoint '<s>': <err>` / `invalid --tx-hash '<h>': <err>` /
   `invalid wallet|from|recipient Bitcoin address: <err>` come from the crate's Display impls (e.g. `OutPoint not in <txid>:<vout> format`,
   `vout should be at most 10 digits`, `no leading zeroes or + allowed in vout part`, `error parsing TXID`); exact strings were not verified from crate source.
5. **serde_jcs 0.1.0 number formatting** for u64 > 2^53 inside `local_transaction_token` / manage tokens (integers vs ES6 doubles) not verified.
6. **unsignedInfo classification**: treated as `state` (server builds a pending pre-transaction; BTC/SUI send `idempotency-key`); if the
   harness considers it replay-safe, `gas-station status` and inscription previews can be treated as read-only.
7. `/chain/support/list` response shape: code accepts `data` array or `data.chainList`; if backend returns `[{chainList:[…]}]` the outer
   array is used as-is (upstream would then mis-parse) — actual backend shape not observed.
8. Commands `login`, `add`, `status`, `addresses`, `logout` are only mapped here (handler + dispatch checks); their HTTP endpoints are
   documented by the auth/account partition and intentionally left empty in this group's structured summary.
9. DoH user-agent / proxy base-URL selection (`DohManager`) is core-owned and not restated; it can change the effective host and
   the `User-Agent` header of every WalletApiClient request.
