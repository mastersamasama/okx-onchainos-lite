# g11b-agent-identity — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: every `onchainos agent <leaf>` whose handler lives in
`cli/src/commands/agent_commerce/identity/` — 18 leaves (14 visible, 4 hidden):
`create`, `update`, `get` (hidden), `get-my-agents`, `get-agents`, `pre-check`,
`get-by-address` (hidden), `activate`, `deactivate`, `upload`, `search`, `service-list`,
`service-match`, `feedback-submit` (visible alias `feedbacksubmit`), `feedback-list`,
`task-feedback`, `xmtp-sign` (hidden), `validate-listing` (hidden). There is **no**
`agent consent` command: `ConsentArgs` backs an internal helper that `pre-check` calls.

Relation to the user request ("no need to reuse login state, but keep the auth mechanism /
same login flow, and support muse"): nothing in this partition performs login. Every
networked leaf except fuzzy `service-match` and `validate-listing` needs the onchainos
Agentic-Wallet login artefacts (JWT pair + session cert + HPKE-wrapped Ed25519 signing
seed + XLayer address). §0.3 below lists exactly which artefacts each leaf touches, so a
lite skill can run its own login flow and feed these handlers the same material.

## Sources read

Partition files (read fully, every line, including tests used as oracles):

| File (under `cli/src/commands/agent_commerce/identity/`) | Lines |
|---|---|
| `mod.rs` | 61 |
| `args.rs` | 612 |
| `models.rs` | 116 |
| `utils.rs` | 1705 |
| `parts/precheck.rs` | 119 |
| `parts/rating.rs` | 106 |
| `signing.rs` | 176 |
| `socket.rs` | 286 |
| `queries.rs` | 777 |
| `mutations.rs` | 1038 |
| `service_match.rs` | 614 |
| `validate.rs` | 984 |
| `tests/mutations_tests.rs` | 179 |
| `tests/utils_tests.rs` | 2801 |
| `tests/validate_tests.rs` | 2142 |
| **total** | **11716** |

Supporting sources read (to trace helpers owned elsewhere; partial reads noted):

| File | Why |
|---|---|
| `commands/agent_commerce/mod.rs` (lines 1–100 enum, 1403–1441 `run`) | clap wiring, hide flags, alias, dispatch, per-invocation prelude |
| `main.rs` (160–316) | global flags, `chain` override for `agent`, error→exit-code mapping |
| `output.rs` (1–300) | `success` / `error` / `confirming_scene` envelopes, `ONCHAINOS_PRETTY` |
| `wallet_api.rs` (100–130, 600–1440, 1745–1780, 451–511) | `WalletApiClient` get/post/multipart/public, envelope unwrap, `ApiCodeError`, broadcast, `auth_refresh`, `UnsignedInfoResponse` |
| `client.rs` (145–175, 300–400) | `anonymous_headers` / `jwt_headers`, `augment_auth_error_msg` |
| `commands/agentic_wallet/auth/mod.rs` (125–345) | `ensure_tokens_refreshed`, `format_api_error` |
| `commands/agentic_wallet/broadcast.rs` (166, full) | `broadcast_unsigned` |
| `commands/agentic_wallet/common.rs` (60–85) | `handle_confirming_error` (81362) |
| `commands/agent_commerce/task/common/okx_a2a.rs` (1–245) | `ensure_communication_ready_preflight` |
| `commands/agent_commerce/task/common/autotrade/executor.rs` (2326–2500, grep) | `run()` prelude side effects |
| `endpoints.rs` (65, full), `build.rs` (59, full), `cli/.env`, `Cargo.toml`, `Cargo.lock` | compiled base / WS URLs; serde_json features |
| `crypto.rs` (39–116, 124–172, 278–303) | HPKE open, Ed25519 helpers |
| `wallet_store.rs`, `keyring_store.rs`, `home.rs` (grep/partial) | `wallets.json`, `session.json`, keyring blob, `ONCHAINOS_HOME` |
| `doh/manager.rs` (263–270), `doh/*.rs` (grep) | User-Agent, failover hosts |
| `spec/cli-tree.json` | flag cross-check: all 14 visible leaves match source; `get`, `get-by-address`, `xmtp-sign`, `validate-listing` are absent (hidden) and documented from source |

Empirical checks (scratch Rust program pinned to the upstream `serde_json 1.0.149` /
`zmij 1.0.21`, rustc 1.95): key sorting, float printing, serde error strings, `{:.2}`
rounding — results quoted where relevant.

## Shared helpers (used across groups or from core)

### 0. Runtime contract inherited by every leaf here (core-owned, summarised)

#### 0.1 Process / envelope / exit codes
- `fn main::run` (main.rs:176): `home::self_heal_permissions()` → `Cli::parse()` (clap) →
  `endpoints::set_dev_mode(cli.dev)` → **for any `agent …` command `cli.chain` is forced to
  `"xlayer"`** (main.rs:191-193, so the global `--chain` flag shown in `--help` is accepted
  and ignored) → `Context::new` (loads `$ONCHAINOS_HOME/config.json`, unused here) →
  `commands::agent_commerce::run` → `audit::log(...)` (appends to
  `$ONCHAINOS_HOME/audit.jsonl`) → error mapping.
- `fn agent_commerce::run` prelude (agent_commerce/mod.rs:1403-1418, task-group owned),
  executed before EVERY identity leaf, errors ignored, local files only:
  `autotrade::executor::reconcile_terminal_journals(4, 100ms)` (reads
  `$ONCHAINOS_HOME/autotrade/terminal-journal/*/*.json`),
  `autotrade::executor::flush_all_due(1)` (notice index dir),
  `autotrade::executor::cleanup_expired_tickets(8)`
  (`$ONCHAINOS_HOME/autotrade/one-time-permits/*/*.json`),
  `autotrade::delivery_queue::flush_due(1, 100ms)`. May write to stderr
  (`[autotrade] unreadable terminal journal ...`). A lite port can no-op these when the
  directories do not exist.
- Success: `output::success(v)` (output.rs:44) → stdout one line
  `{"ok":true,"data":<v>}` (+ `,"notifications":[…]` only if core payment notices were
  queued — never by identity code) + `\n`, exit 0. Compact unless env
  `ONCHAINOS_PRETTY=1` (serde pretty, 2-space indent). Struct field order `ok, data`.
- Error (any `anyhow::Error` not specially typed): stdout
  `{"ok":false,"error":"<format!("{e:#}")>"}` + `\n`, **exit 1**. `{e:#}` renders the
  anyhow context chain joined by `": "` (outermost first), e.g.
  `failed to parse --service as JSON array: missing field \`serviceDescription\` at line 1 column 40`.
- `output::CliConfirming` (only reachable here from broadcast code `81362`, see §0.5):
  stdout `{"confirming":true,"message":"<backend msg>","next":"If the user confirms, re-run the same command with --force flag appended to proceed."}`,
  **exit 2**.
- clap errors (unknown flag, missing `required = true` flag, non-integer `--limit`,
  value looking like a flag e.g. `--min-payment-token-amount -1`): clap's own usage text on
  stderr, **exit 2**, nothing on stdout. `--help` → exit 0.
- Global flags: `--chain <CHAIN>` (ignored for `agent`), hidden `--dev` (switches the HTTP
  base URL to `https://beta.okex.org`; the WS URL is NOT affected).
- `debug_log!` (identity/mod.rs:22) prints request/response traces to stderr **only when the
  crate is built with feature `debug-log`**; release builds are silent. Not part of the
  parity surface.

#### 0.2 JSON serialisation rules (critical for byte parity)
- `serde_json = "1"` with NO `preserve_order` (Cargo.lock: deps `itoa, memchr, serde,
  serde_core, zmij`, no `indexmap`) ⇒ every `serde_json::Value` object (all `json!{}`
  literals, all re-emitted backend `data`, all `to_value(struct)` results) serialises with
  **keys sorted by byte order** (uppercase before lowercase: `{"Y":2,"z":1}`). Only values
  serialised straight from a Rust struct keep declaration order: the `create` `cardJson`
  (`AgentCard`/`AgentService`/`SubscriptionTier`), the `validate-listing` output
  (`ValidationResult`/`Finding`), the envelope itself (`ok, data, error, notifications`),
  the confirming envelope (`confirming, scene, message, next, notifications`).
- Numbers: integer literals fitting u64 / i64 are kept exact (`9007199254740993` survives —
  a JS port needs a lossless JSON parser); anything else becomes f64. f64 printing (verified):
  integral values get `.0` (`5.0`, `100.0`), `0.00001`, `1.5e-7`, `1e+16`, `1e+21`,
  `1.8446744073709552e+19` (scientific from 1e16 upward, with `e+`; JS switches only at
  1e21). Floats parsed from JSON are re-printed in shortest form (`10.50` → `10.5`,
  `1E2` → `100.0`).
- Strings escape only `"`, `\`, U+0000–U+001F (`\b \f \n \r \t`, others `\u00xx` lowercase);
  non-ASCII and `/` are literal.
- Rust `format!("{:.2}", f64)` rounds the exact binary value, **ties to even** (verified:
  `4.625 → "4.62"`, `0.125 → "0.12"`, `0.375 → "0.38"`, `2.675 → "2.67"`); JS
  `toFixed(2)` rounds ties up (`4.625 → "4.63"`). Used by `format_search_rate` (§2.8).

#### 0.3 Auth material (core-owned) and which leaves touch it
- Keyring blob (`keyring_store`, service `onchainos`, entry `agentic-wallet`; OS keyring on
  macOS/Windows, `$ONCHAINOS_HOME/keyring.enc` file on Linux or with
  `ONCHAINOS_FORCE_FILE_KEYRING` / `ONCHAINOS_CREDENTIAL_STORE=file`) with string keys
  `access_token` (JWT), `refresh_token` (JWT), `session_key` (base64 32-byte X25519
  private key).
- `$ONCHAINOS_HOME/session.json` (`SessionJson`, camelCase): `sessionCert`,
  `encryptedSessionSk` (base64 `enc(32 B) || ciphertext`), `sessionKeyExpireAt`
  (unix seconds string), `saTeeId`, `deviceId`.
- `$ONCHAINOS_HOME/wallets.json` (`WalletsJson`): `selectedAccountId`,
  `accountsMap{<accountId>: {addressList:[{accountId,address,chainIndex,chainName,addressType,chainPath}]}}`, …
- `ONCHAINOS_HOME` = env `ONCHAINOS_HOME` (non-empty) else `~/.onchainos`.
- `fn agentic_wallet::auth::ensure_tokens_refreshed` (auth/mod.rs:132) → access token:
  `session.json` missing or `sessionKeyExpireAt` empty/unparsable/≤ now → error
  `session expired, please login again: onchainos wallet login`; keyring
  `refresh_token`/`access_token` missing → same error; refresh JWT expired → stderr
  `Session expired. Please log in again: onchainos wallet login` + same error; if either JWT
  is within the refresh margin → `POST /priapi/v5/wallet/agentic/auth/refresh`
  (`post_public`, body `{"refreshToken":…}`, errors mapped by `format_api_error`), store
  rotated tokens, maybe refresh chain cache; else return stored access token.
- `fn identity::signing::load_agent_signing_session` (signing.rs:90) — see §1.4:
  wallets.json → XLayer address; session.json + keyring `session_key` → HPKE-open →
  32-byte Ed25519 seed; plus `sessionCert`.
- Per leaf: JWT only — `get`, `get-my-agents`, `get-agents`, `search`, `service-list`,
  `feedback-list`, `task-feedback`, `get-by-address`, `activate`, `deactivate`, `upload`,
  precise `service-match`. JWT + full signing session — `create`, `update`,
  `feedback-submit`, `pre-check` (loads it only for the address). JWT + seed + cert (no
  wallets.json) — `xmtp-sign`. None — fuzzy `service-match`, `validate-listing`.

#### 0.4 HTTP client: `crate::wallet_api::WalletApiClient` (core-owned)
- Built by `identity::utils::wallet_client(_ctx)` (utils.rs:21) = `WalletApiClient::new()`:
  base URL = `endpoints::base_url()` (compiled `ONCHAINOS_COMPILED_BASE_URL`, default
  `https://web3.okx.com`; `https://beta.okex.org` with `--dev`), `DohManager::prepare()`
  (may read DoH cache; may fail → exit 1), reqwest timeout **30 s**, `User-Agent:
  OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)` (e.g. `(windows; x86_64)`).
- Headers (`ApiClient::anonymous_headers`, client.rs:346): `Content-Type: application/json`
  (also on GET), `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`,
  `platform: agent-cli`, `device-id: <cached id>` (if any), `device-name: <name>`;
  `jwt_headers` adds `Authorization: Bearer <access token>`.
- `get_authed(path, token, query)` (wallet_api.rs:1242): URL
  `<base><path><build_query_string(query)>`; `build_query_string` (:106) drops pairs with
  empty value, keeps order, key raw, value `application/x-www-form-urlencoded` (identical to
  WHATWG `URLSearchParams`: `A-Za-z0-9*-._` literal, space→`+`, else `%XX` uppercase —
  e.g. `,`→`%2C`); no `?` if nothing survives. Repeated keys allowed.
- `post_authed(path, token, body)` (:896) / `post_authed_with_headers(…, extra)` (:910):
  JSON body `serde_json::to_vec` (compact, sorted keys). Extra headers inserted after JWT
  headers (HTTP names case-insensitive; reqwest sends lowercase).
- `post_public(path, body)` (:815): anonymous headers, no `Authorization`.
- `post_authed_multipart(path, token, form)` (:1082): JWT headers minus `Content-Type`
  (reqwest sets `multipart/form-data; boundary=<random>`); **no DoH retry, no
  invalid-token retry**; send error context `wallet API request failed`.
- Retries for get/post authed & public: connect/timeout → DoH failover then resend (only
  when the compiled base URL is production and not `--dev`), else error
  `Network unavailable — check your connection and try again: <reqwest chain>`; other send
  errors `request failed: <chain>`. **Invalid-token retry** (authed get/post only): error
  with code `10001|10008|53017|130100031` or text `invalid access token`/`access token
  invalid` → `force_refresh_access_token()` (`POST /priapi/v5/wallet/agentic/auth/refresh`,
  stores tokens) → resend once with the new JWT.
- `handle_response` (:1173): HTTP ≥ 500 → `Wallet API server error (HTTP <n>): <raw body>`;
  body not JSON → `failed to parse wallet API response as JSON (HTTP <n>): <first 500 bytes>`;
  `unwrap_wallet_envelope` (:721): `code` `"0"`/`0` → return `data` (absent → `null`);
  else `ApiCodeError{code,msg}` whose Display is `Wallet API error (code=<code>): <msg>`
  (`msg` from `msg`|`errorMessage`|`error_message`|`message`|`detailMsg`, else the raw body
  ≤200 bytes + `…` and a stderr line `[WalletAPI] no msg field in error response (HTTP <n>), raw body: <body>`;
  code `50114` gets `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` appended).
- `fn agentic_wallet::auth::format_api_error(e)` (auth/mod.rs:338): `ApiCodeError` →
  plain error `code=<code> msg=<msg>`; other errors unchanged. Applied only where noted
  (pre-check, activate, deactivate, xmtp-sign); elsewhere the raw
  `Wallet API error (code=…): …` text is surfaced.

#### 0.5 Broadcast pipeline (wallet-group owned): `fn agentic_wallet::broadcast::broadcast_unsigned` (broadcast.rs:43)
Called via `identity::signing::sign_and_broadcast_agent_transaction` (§1.4) with
`is_contract_call=true, mev_protection=false, force=false, trace_headers=None`:
1. `unsigned.executeResult == false` → error `transaction simulation failed: <executeErrorMsg or "transaction simulation failed">`.
2. `msgForSign` map (each only if source non-empty): `signature` = ed25519-over-EIP-191(keccak) of hex `hash`; `authSignatureFor7702` = ed25519 over hex `authHashFor7702`; `unsignedTxHash` + `sessionSignature` = ed25519 over `unsignedTxHash` decoded per `encoding` (hex/base64/base58); `unsignedTx`; `jitoUnsignedTx` + `jitoSessionSignature`; `sessionCert`.
3. `extraData` = backend `extraData` object (or `{}`) + `checkBalance:true`, `uopHash`, `encoding`, `signType`, `msgForSign`, then overlay keys (identity: `erc8004Msg`) — serialised compact with sorted keys into a **string**.
4. `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` via
   `post_authed_no_retry_with_headers` (JWT, **no resend of any kind**; connect/timeout →
   `Broadcast result is unknown. Query transaction status before attempting another broadcast.: <chain>`),
   body `{"accountId":<wallets.json accountId>,"address":<xlayer address>,"chainIndex":<address chainIndex string, "196">,"extraData":"<json string>"}`;
   `data[0].txHash` returned (`broadcast: expected data to be an array` /
   `broadcast: data array is empty` / `broadcast: failed to parse response: …`).
   `ApiCodeError` code `81362` → `CliConfirming` (exit 2, §0.1) — note identity leaves
   have no `--force` flag, so the "re-run with --force" hint cannot be followed (see open
   questions).

#### 0.6 A2A readiness preflight (task-group owned): `fn task::common::okx_a2a::ensure_communication_ready_preflight` (okx_a2a.rs:200)
Runs **only** in `update` and `activate`, before any argument validation or HTTP. Env
`ONCHAINOS_SKIP_A2A_PREFLIGHT=1` → skip. Otherwise spawns `okx-a2a --version` (Windows via
`cmd /C`): non-zero/spawn error → error
`A2A communication is not ready, so this operation was not executed. okx-a2a may not be installed, or the active Node environment may differ from the one used to install it. Switch to the correct Node environment and retry. If it is not installed, run \`npm i -g @okxweb3/a2a-node\` in a compatible Node environment. Details: <stderr or stdout or spawn error>`.
Then stderr `[onchainos] checking A2A communication readiness (okx-a2a doctor)...`, spawns
`okx-a2a doctor --json`; JSON `ready` (or `ok`) true → stderr
`[onchainos] A2A communication is ready`, proceed; false → stderr
`[onchainos] A2A communication is NOT ready: <userMessage>` and error
`A2A communication is not ready, so this operation was not executed. <userMessage>\n- <why> (run: <command>)…\nRun \`okx-a2a doctor --fix\` to repair the local A2A environment, then retry.`;
no parsable verdict → stderr `[onchainos] <unverifiable note>` and proceed. Parity harness
should set `ONCHAINOS_SKIP_A2A_PREFLIGHT=1`.

### 1. Identity-owned helpers

#### 1.1 Constants / models (models.rs)
- `XLAYER_CHAIN_INDEX = "196"`, `XLAYER_CHAIN_INDEX_NUM = 196`, `XLAYER_CHAIN_NAME = "XLayer"`.
- `ServiceOperation` enum, wire lowercase `create|update|delete` (other strings → serde
  error `unknown variant \`foo\`, expected one of \`create\`, \`update\`, \`delete\``).
- `SubscriptionTier {interval: String (required), fee: String (required)}` — struct order `interval, fee`.
- `AgentService` (field order = serialisation order when serialised from the struct):
  `id: Option<Value>` (`"id"`, default, skipped when None; JSON null → None),
  `serviceName: String` (**required**), `serviceDescription: String` (**required**),
  `serviceGuide: String` (default `""`, skipped when empty; JSON null → type error),
  `fee: String` (default `""`, always serialised; a JSON number → `invalid type: integer \`10\`, expected a string`),
  `serviceType: String` (**required**),
  `subscription: Vec<SubscriptionTier>` (default `[]`, always serialised; null → type error),
  `freeTrial: Option<String>` (skipped when None), `operation: Option<ServiceOperation>`
  (skipped when None), `endpoint: Option<String>` (skipped when None).
- `AgentCard` struct order: `role`, `name`, `image` (profile_picture),
  `profileDescription`, `CommunicationAddress` (skipped when None — always None here),
  `services`.

#### 1.2 Query / arg helpers (utils.rs)
- `fn require_non_empty(value, flag)` (utils.rs:546) → trimmed value; None/blank →
  error `missing required parameter: <flag>` (flag string as passed, e.g. `--agent-id`).
- `fn trim_or_empty(v)` (:553) → trimmed or `""`.
- `fn push_optional_query(q, key, v)` (:72) → push `(key, trimmed)` if non-blank.
- `fn push_multi_query(q, key, values)` (:82) → push each non-blank trimmed value (repeated key).
- `fn parse_u32_arg(value, flag, default, min, max, clamp_max)` (:611): None → default;
  `value.trim().parse::<u32>()` (Rust: accepts leading `+`, rejects `-`, decimals,
  > 4294967295) else `invalid value for <flag>: expected integer`; `< min` →
  `invalid value for <flag>: must be >= <min>`; `> max` → clamp to max if `clamp_max` else
  `invalid value for <flag>: must be <= <max>`.
- `fn normalize_singleton_object(v)` (:92): a 1-element array whose element is an object →
  that object; everything else unchanged.
- `fn parse_agent_unsigned(data)` (:99): `data` must be an array with ≥1 element else
  `pre-transaction response is empty`; element → `UnsignedInfoResponse` (all fields
  default/nullable) else `failed to parse pre-transaction response: <serde>`.
- `fn normalize_role(role)` (:418): `trim().to_ascii_lowercase()` ∈ `user|asp|evaluator`
  else `invalid value for --role: <lowercased trimmed> (expected: user, asp, or evaluator)`.
  No aliases, no numbers.
- `fn normalize_role_code(role)` (:449): `user→"1"`, `asp→"2"`, `evaluator→"3"` (same errors).
- `fn role_to_wire(role)` (:464): `user→"requester"`, `asp→"provider"`, else `"evaluator"`.
- `fn role_token_from_value(v)` (:434): backend role **must be a JSON unsigned integer**
  `1→user, 2→asp, 3→evaluator`; strings/others → None.
- `fn normalize_bcp47(v)` (:494): None/blank → None; split on `-`/`_`, drop empty
  subtags; first subtag must be 2–8 ASCII letters else None; output: language lowercase;
  4-letter alpha subtag Title-case; 2-letter alpha or 3-digit subtag UPPERCASE; others
  lowercase; joined by `-`; then default-region completion only for a bare tag:
  `zh→zh-CN`, `en→en-US`, `ja→ja-JP` (e.g. `zh_CN→zh-CN`, `ZH-cn→zh-CN`,
  `zh-hant-tw→zh-Hant-TW`, `fr→fr`, `1-CN→None`, `z→None`).
- `fn ensure_asp_has_service(card)` (:557): role `asp` and no services →
  `ASP agents require at least one service; provide --service`.
- `fn ensure_asp_has_avatar(card)` (:569): role `asp` and blank picture →
  `ASP agents require an avatar; upload an image and provide --picture`.
- `fn detect_image_kind(bytes)` (:581): prefix `89 50 4E 47 0D 0A 1A 0A` → (`PNG`,
  `image/png`); `FF D8 FF` → (`JPEG`, `image/jpeg`); len ≥ 12 and `RIFF` at 0..4 and `WEBP`
  at 8..12 → (`WebP`, `image/webp`); else None.
- `fn validate_avatar_image(bytes)` (:602): None →
  `unsupported image type — only PNG, JPEG, and WebP are accepted; please convert the file to one of those and retry`.
- `fn identity_ws_url()` (:45) = compiled `endpoints::AGENT_IDENTITY_WS_URL` (build.rs default
  `wss://wsdex.okx.com:8443/ws/v5/private`; overridable only at build time via
  `OKX_AGENTIC_WS_URL` in `cli/.env` — the checked-in `.env` sets
  `ws://127.0.0.1:18899/ws/v5/private`, and `OKX_BASE_URL=http://127.0.0.1:18899`).
- `redact_token_for_debug`, `reconstruct_get_url_for_log`, `reconstruct_post_url_for_log`,
  `scrub_body_for_log` (mutations.rs:59) — debug-log only.

#### 1.3 Service parsing / normalisation (utils.rs)
- `fn parse_services(raw)` (utils.rs:110): None → `[]`;
  `serde_json::from_str::<Vec<AgentService>>(raw)` else error
  `failed to parse --service as JSON array: <serde msg>` (verified examples: `""` →
  `…: EOF while parsing a value at line 1 column 0`; `{…}` →
  `…: invalid type: map, expected a sequence at line 1 column 0`; missing field →
  `…: missing field \`serviceDescription\` at line 1 column 40`); then
  `normalize_service` each (first failing element aborts).
- `fn parse_service_deltas(raw)` (:136, update only): None → `[]`; parse as `Vec<Value>`
  (same `failed to parse --service as JSON array: …`); per entry: if
  `entry.operation == "delete"` (exact string) → id via `normalize_service_id(entry.id)`;
  None → `invalid --service: operation 'delete' requires an id`; emit exactly
  `{"id":<id>,"operation":"delete"}` (all other keys dropped, no further validation).
  Otherwise `from_value::<AgentService>` (error `failed to parse --service entry: <serde msg>`,
  e.g. `missing field \`serviceName\``), `normalize_service`, then `to_value` → object with
  **sorted keys** (`endpoint?, fee, freeTrial?, id?, operation?, serviceDescription,
  serviceGuide?, serviceName, serviceType, subscription` with tiers `{"fee","interval"}`).
- `fn normalize_service_id(id)` (:122): absent/null/blank string → None; string → trimmed
  string; JSON integer (i64/u64) → kept as number; anything else →
  `invalid --service: id must be a string or integer`.
- `fn normalize_service(s)` (:160) — in this order:
  1. `id` normalised (above); `serviceName`, `serviceDescription`, `serviceGuide`, `fee`
     trimmed; `serviceType` trimmed + ASCII-uppercased; `endpoint` trimmed, empty → None;
     `freeTrial` trimmed, empty → None.
  2. empty `serviceName` → `missing required field in --service: serviceName`.
  3. empty `serviceDescription` → `missing required field in --service: serviceDescription`.
  4. `operation != delete` and guide non-empty and `display_width(guide) > 10000` →
     `The service guide for [<serviceName>] exceeds the length limit. Shorten it to no more than 5,000 full-width Chinese/Japanese characters or 10,000 Latin characters, then resubmit.`
  5. tiers: `interval` trimmed + lowercased, `fee` trimmed; drop tiers where both empty.
  6. by `serviceType`:
     - `A2A`: `endpoint` forced to None. `has_single_fee = fee != ""`,
       `has_subscription = tiers non-empty`. Neither →
       `invalid --service for A2A: provide a single-purchase fee or a subscription (exactly one)`;
       both → `invalid --service for A2A: choose one billing model — a single-purchase fee OR a subscription, not both`.
       Per tier in order: `interval != "month"` →
       `invalid subscription interval in --service: <interval> (only 'month' is supported)`;
       `fee == ""` → `The price for "<serviceName>" cannot be empty. Please enter a price and try again.`;
       `!is_plain_number(fee,2)` →
       `invalid subscription fee in --service: must be a plain number with up to 2 decimal places (USDT is the default currency)`;
       `is_zero_value(fee)` →
       `The subscription price for "<serviceName>" must be greater than 0. Please update the price and try again.`
       Then single fee present and `!is_plain_number(fee,2)` →
       `invalid fee in --service for A2A: must be a plain number with up to 2 decimal places (USDT is the default currency)`.
       Then `freeTrial` present: no subscription →
       `invalid --service for A2A: freeTrial is only allowed on a subscription-priced service`;
       `!is_positive_integer` → `invalid freeTrial in --service: must be a positive integer number of hours`.
     - `A2MCP`: tiers non-empty → `invalid --service: A2MCP services do not support subscription pricing`;
       freeTrial present → `invalid --service: A2MCP services do not support freeTrial`;
       fee empty → `missing required field in --service for A2MCP: fee`;
       `!is_plain_number(fee,6)` →
       `invalid fee in --service for A2MCP: must be a plain number with up to 6 decimal places (USDT is the default currency)`;
       endpoint None → `missing required field in --service for A2MCP: endpoint`.
     - other → `invalid serviceType in --service: <UPPERCASED> (expected: A2A or A2MCP)`
       (empty type prints nothing after the colon: `invalid serviceType in --service:  (expected: A2A or A2MCP)`).
  7. operation × id: `create` with id → `invalid --service: operation 'create' must not carry an id`;
     `update` without id → `invalid --service: operation 'update' requires an id`;
     `delete` without id → `invalid --service: operation 'delete' requires an id`.
     (In `create`, `operation`/`id` are accepted and forwarded if consistent.)
- `fn is_plain_number(s, d)` (:335): no `.` → non-empty, all ASCII digits; with one `.` →
  non-empty all-digit integer part and 1..=d all-digit fraction digits (so `"00"`,
  `"007.5"` pass; `".5"`, `"5."`, `"1e2"`, `"+1"`, `"1,000"` fail).
- `fn is_zero_value(s)` (:356): non-empty and every byte is `0` or `.`.
- `fn is_positive_integer(s)` (:365): non-empty, all digits, at least one non-`0`.
- `fn display_width(s)` (:379): per Unicode scalar: 2 if code point in
  `[0x1100–0x115F, 0x2E80–0x303E, 0x3041–0x33FF, 0x3400–0x4DBF, 0x4E00–0x9FFF,
  0xA960–0xA97F, 0xAC00–0xD7AF, 0xD7B0–0xD7FF, 0xF900–0xFAFF, 0xFE10–0xFE6F,
  0xFF01–0xFF60, 0xFFE0–0xFFE6, 0x20000–0x2FA1F]` else 1. (Guide limit constant
  `SERVICE_GUIDE_MAX_DISPLAY_WIDTH = 10000`.)

#### 1.4 Signing (signing.rs)
- `fn resolve_xlayer_signing_account(None)` (signing.rs:20) → `resolve_current_xlayer_address`
  (:39): `wallet_store::load_wallets()` (missing file → None; unreadable/parse →
  `failed to read wallets.json: …` / `failed to parse wallets.json: …`); None, blank
  `selectedAccountId`, missing account entry, or no address with
  `chainIndex == "196"` or `chainName` eq-ignore-case `"XLayer"` (first match in
  `addressList` order) → `no XLayer address found in current account`. Returns
  `(accountId, AddressInfo)`.
- `fn load_agent_signing_session(None)` (:90): the above, then `load_session()` None →
  `session expired, please login again: onchainos wallet login`; keyring `session_key`
  missing → same message; `crypto::hpke_decrypt_session_sk(encryptedSessionSk,
  session_key)` = HPKE base mode, KEM X25519-HKDF-SHA256, KDF HKDF-SHA256, AEAD
  AES-256-GCM, info `okx-tee-sign`, AAD empty, `enc` = first 32 bytes of the base64-decoded
  blob, ciphertext = rest; plaintext must be 32 bytes (the Ed25519 seed). Errors surface
  verbatim (e.g. `HPKE decryption failed: …`). Returns `{account_id, addr_info,
  session_cert, signing_seed}`.
- `fn load_signing_seed()` (:64) / `fn load_session_cert()` (:72): same pieces without
  wallets.json (used by `xmtp-sign`).
- `fn sign_key_uuid(key_uuid, seed)` (:117): `base64_std(ed25519_sign(seed,
  key_uuid.as_bytes()))` — raw UTF-8 bytes, no prefix/hash; deterministic (RFC 8032).
- `fn build_erc8004_overlay(fields)` (:139): drop empty values; none left → None; else
  `{"erc8004Msg": {k: v…}}` (inner keys end up sorted in extraData).
- `fn sign_and_broadcast_agent_transaction(token, unsigned, overlay, session)` (:156) →
  `broadcast_unsigned` (§0.5) → txHash string.

#### 1.5 WebSocket push (socket.rs) — used by `create` / `update`
- `fn open_identity_subscription(wallet_address, ws_url)` (socket.rs:56): whole handshake
  bounded by **10 s** (else `ws subscription open timed out after 10s (url=<url>)`):
  `connect_async(url)` (tokio-tungstenite, rustls/webpki roots, no custom headers) →
  send text `{"args":[{"token":"<xlayer address>"}],"op":"login"}` (sorted keys) → read
  frames until a text frame with `event == "login"`: `code` absent/null/`"0"`/`0` → ok,
  other → `ws login rejected: code=<json> msg=<msg> raw=<text>`; `event == "error"` →
  `ws error during login: <msg|unknown> raw=<text>`; other frames skipped → send
  `{"args":[{"channel":"wallet-agentic-identity"}],"op":"subscribe"}` → wait
  `event == "subscribe"` the same way. Any failure is swallowed by the caller
  (subscription = None).
- `IdentitySubscription::wait_for_match(tx_hash, 30 s)` (:121): read frames; text (or UTF-8
  binary) frames parsed by `extract_payload` (:190): JSON with any `event` key → ignored;
  `data` array → first element; `data` object → it; else top-level object if it has both
  `txHash` and `agentId`. Match when `normalize_hash(payload.txHash) == normalize_hash(tx_hash)`
  (trim, strip `0x`/`0X`, ASCII-lowercase, non-empty). Close frame / read error / stream
  end → error; timeout → `Ok(None)`. Socket closed best-effort afterwards.
- `fn wait_for_identity_push` (mutations.rs:991): any error/timeout → None.
- `fn extract_agent_id_from_push` (mutations.rs:1027): `push.agentId` non-blank string
  (trimmed) or number (`to_string`) → Some.
- `fn assemble_identity_envelope(txHash, push, newAgentId)` (mutations.rs:1009) →
  `{"agent":<push>?,"newAgentId":<string|null>,"txHash":<string>}` (sorted; `agent` only
  when a push matched; `newAgentId` always present).

#### 1.6 Rating (parts/rating.rs)
- `fn parse_stars_arg(value, flag)` (rating.rs:29): trim; split on first `.`: fraction
  empty or > 2 chars → err; integer part empty/non-digit → err; fraction non-digit → err;
  `cents = int*100 + frac(1 digit ×10, 2 digits as-is)` (u32 checked, overflow → err);
  `cents > 500` → `invalid value for <flag>: must be between 0.00 and 5.00`; result
  `(cents + 2) / 5` (integer division = round-half-up of stars×20). Generic err text:
  `invalid value for <flag>: expected 0.00–5.00 (up to 2 decimal places)`. Oracles:
  `0→0, 1→20, 5→100, 4.5→90, 0.01→0, 0.03→1, 3.30/3.31/3.32→66, 3.33→67, 3.35→67,
  4.97→99, 4.98→100`; rejects `3.333, 3., -1, +5, 5e0, 6, 5.01, abc, "", "   "`.
- `fn score_to_stars(score)` (:71) = `min(score,100)*5 / 100.0` (f64).
- `fn convert_feedback_list_scores(v)` (:84): if `v` object: `average` that is a JSON
  unsigned integer → f64 stars; for arrays `items` and `list`: each object's `score` that is a
  JSON unsigned integer → f64 stars. (Printed as f64: `100 → 5.0`, `89 → 4.45`,
  `0 → 0.0`.)

#### 1.7 Display enrichment (utils.rs) — shared by `get`, `get-my-agents`, `get-agents`
- `fn for_each_agent_row(v, f)` (:709): for each element of `v.list` (array): if it has an
  `agentList` array → apply to each row, else apply to the element itself.
- `fn enrich_agent_get_rows(v)` (:794) = `for_each_agent_row(v, enrich_agent_row)`;
  `fn enrich_agent_detail_rows(v)` (:803) = `enrich_agent_row` on each element when `v`
  is an array (else no-op).
- `fn enrich_agent_row(row)` (:813), object rows only, unconditional inserts:
  - `roleLabel`: `role` u64 `1→"User"`, `2→"ASP"`, `3→"Evaluator"` (else omitted).
  - `statusLabel`: `status` u64 (to string) or trimmed string: `"1"`/`"active"→"active"`,
    `"2"→"not listed"`, `"3"|"4"|"5"→"unavailable"` (floats, others omitted).
  - `approvalLabel`: `approvalDisplayStatus` u64: `1→"Review not submitted"`,
    `2→"Listing under review"`, `4→"Listed — eligible for task recommendations"`,
    `5→"Listing rejected"`, `7→"This agent is currently unavailable"`.
  - `ratingStars`: `rating_stars(reputation)`: `reputation.count` u64 == 0 → omit;
    `reputation.score` must be u64 → `format_rating_stars(score)`: `h = min(score,100)*5`,
    `whole = h/100`, `frac = h%100`; `frac==0 → "<whole>"`, `frac%10==0 → "<whole>.<frac/10>"`,
    else `"<whole>.<frac 2 digits>"` (`92→"4.6"`, `89→"4.45"`, `100→"5"`, `0→"0"`).
  - `card`: `build_agent_card(row)` array (always non-empty for objects), rows
    `{"label":…,"value":…}` in order, omitting unavailable ones:
    1. `Agent ID` = `#<agentId>` (u64 or string, non-blank).
    2. `Name` = trimmed `name` (non-empty).
    3. `Role` = role label.
    4. `Status` = status label.
    5. `Approval status` = approval label; when code 5 and trimmed `approvalRemark`
       non-empty → `Listing rejected (reason: <remark>)`.
    6. `Address` = `short_address(first_str(["address","agentWalletAddress","ownerAddress"]))`
       where `short_address` trims, requires `0x`/`0X` + ≥8 hex chars → `0x<first4>…<last4>`
       (original case kept).
    7. `Description` = `first_str(["description","profileDescription"])` or `(not set)` (always emitted).
    8. `Profile photo` = `first_str(["picture","profilePicture"])` or `default` (always emitted).
    9. ASP only (role == 2): for each `services[]` element with a name →
       `Service <n>` (n counts only named services) = `format_service_value`.
    10. `Rating` = `★ <ratingStars> (<count> reviews)` (count u64, default 0), only when ratingStars exists.
    11. `txHash` = trimmed non-empty `txHash`.
  - `first_str(map, keys)` (:878): the FIRST key whose value is a JSON **string** wins,
    then trim; empty → None (an empty `description` hides `profileDescription`).
  - `first_fee(map, keys)` (:888): first key whose value is a non-blank string (trimmed) or
    a number (`Number::to_string`, e.g. `10.0`); empty strings fall through to the next key.
  - `format_subscription_tiers(map)` (:902): array from `subscription` (if key present) else
    `Subscription`; each object tier with `first_fee(["fee","Fee","feeAmount"])` →
    `"<fee> USDT / <period>"`, period = `month` if `first_str(["interval","Interval"])`
    (default `month`) eq-ignore-case `month`, else the raw interval.
  - `format_free_trial(map)` (:938): no tiers → None; `first_fee(["freeTrial"])` trimmed
    must be `is_positive_integer` and parse u64; `hours % 24 == 0` → `"<d> day"`/`"<d> days"`,
    else `"<h> hour"`/`"<h> hours"` (singular when 1).
  - `unpriced_fee_label(is_a2mcp)` (:964): `"—"` for A2MCP else `"free"`.
  - `format_service_value(svc)` (:979): name = `first_str(["serviceName","ServiceName","name"])`
    (None → skip row); raw type = `first_str(["serviceType","ServiceType","servicetype"])`
    uppercased: `A2MCP→"API service"`, `A2A→"agent-to-agent"`, `""→` no segment, other →
    the uppercased raw; fee segment = tiers joined `", "` if any, else `"<fee> USDT"`
    (`first_fee(["fee","Fee","feeAmount"])`) else unpriced label; then
    `"<trial> free trial"` if any; then endpoint (`first_str(["endpoint","Endpoint"])`)
    unless A2A → `"<name> — <segments joined ", ">"`.
    Oracle: `TVL Query — API service, 10 USDT, https://api.example.com/mcp`,
    `Yield Check — agent-to-agent, free`,
    `Loop Helper — agent-to-agent, 10 USDT / month, 3 days free trial`,
    `TVL Query — API service, —, https://api.example.com/mcp`.
- `fn add_agent_list_cells(v)` (:1251): `derive_has_more(v)` on the top-level object, then
  for each agent row (for_each_agent_row) insert `cells` = `build_agent_list_cells(row)`
  (:1180), always 6 cells in order:
  `Agent ID` (`#<id>` or `—`), `Name` (trimmed, `truncate_name(…,20)`, or `—`), `Role`
  (label or `—`), `Status` & `Approval status` (only when Role == `ASP`: status label or `—`;
  approval: code 5 → `Review failed (reason: <remark>)` / `Review failed`; other known →
  label; unknown → `—`; non-ASP → both `—`), `Rating` (`★ <stars> (<count>)` or
  `No rating yet`).
- `fn truncate_name(s, max)` (:1155): by Unicode scalars; longer than max → first `max`
  scalars + `…`.
- `fn derive_has_more(map)` (:1580): if `page`, `pageSize`, `total` all parse (JSON u64, or
  string trimmed → u64) → insert `hasMore = page*pageSize < total` (saturating),
  overwriting any backend value; otherwise untouched.

#### 1.8 Search / service-list / feedback display (utils.rs)
- `fn format_search_rate(r)` (:1343): `format!("{r:.2}")` (ties-to-even, §0.2), then strip
  trailing `0`s and a trailing `.` (`4.60→"4.6"`, `5.00→"5"`, `0.00→"0"`).
- `fn build_search_table(v)` (:1404) → exactly
  `{"page":v.page|null,"pageSize":v.pageSize|null,"table":{"columns":[{"key":"agentId","label":"Agent ID"},{"key":"name","label":"Name"},{"key":"soldCount","label":"Sold Count"},{"key":"rating","label":"Rating"},{"key":"minPrice","label":"Min price"},{"key":"recommendService","label":"Top service"}],"rows":[…]},"total":v.total|null}`
  (`page`/`pageSize`/`total` copied verbatim, any type); rows = each **object** in
  `v.list` → `build_search_table_row` (:1285):
  `{"agentId":"#<id>"|"—","minPrice":<serviceMinPrice Number→to_string, else "—">,"name":<trim, truncate 20, else "—">,"rating":<…>,"recommendService":<…>,"soldCount":<soldCount verbatim if present & non-null, else "—">}`;
  rating: `feedbackRate` number → `0` (as f64 == 0.0) → `No rating yet`, else
  `★ ` + `format_search_rate(rate/20.0)`; non-number/absent → `—`.
  recommendService = `format_top_service(services[0])` or `—`: name
  (`first_str(["serviceName","ServiceName","name"])`, required), type label as in
  `format_service_value`, fee segment: tiers → joined; else `first_fee(["feeAmount","fee","Fee"])`
  + optional `" " + first_str(["feeToken","FeeToken"])`; else unpriced label; no trial,
  no endpoint → `"<name> (<segments joined ", ">)"` → `truncate_name(…, 40)`.
  Oracles: `{"agentId":"#1128","minPrice":"10.0","name":"DeFi Analyzer","rating":"★ 4.75","recommendService":"TVL Query (API service, 10.0 USDT)","soldCount":10}`
  (for `serviceMinPrice: 10.0`, `feedbackRate: 95`, `feeAmount: 10.0`).
- `fn add_service_list_cells(v)` (:1518): `v` array → each wrapper; else `v` itself →
  `add_service_cells_to_node` (:1531): object only; `derive_has_more`; services array =
  `list` if array else `services` if array else stop; `index` 1-based over services that
  yield cells; for each service object with a name: if `serviceGuide` is a string with
  non-blank trim → insert `serviceGuideHash = "sha256:" + lowercase hex(SHA-256(raw
  untrimmed UTF-8 bytes))` (71 chars); insert `cells` = `build_service_cells(index, svc)`
  (:1447), 8 cells: `#` (index), `Name` (untruncated), `Type` (uppercased raw type:
  `A2MCP`/`A2A`/other, empty → `—`), `Fee` (tiers present → `—`; else
  `first_fee(["fee","Fee","feeAmount"])` → `<f> USDT`; else unpriced label), `Subscription`
  (joined tiers or `—`), `Free trial` (label or `—`), `Endpoint` (A2A → `—`; else
  `first_str(["endpoint","Endpoint"])` or `—`), `Description`
  (`first_str(["serviceDescription","ServiceDescription","servicedescription"])`, truncate 80, else `—`).
  Nameless services get nothing and do not consume an index.
- `fn add_feedback_list_cells(v)` (:1686): object only; `derive_has_more`; for arrays
  `items` then `list`: each object gets `cells` = `build_feedback_cells` (:1605):
  - `Score`: first of `valueString`, `value` that yields a number (string: trim, strip one
    trailing `/100`, Rust `parse::<f64>`; number: as f64) → `format_search_rate(x/20.0)`;
    else `score` as f64 → `format_search_rate(score)`; else `—`.
  - `Reviewer`: `first_str(["agentName"])`, else `creatorId` (u64 or string, trimmed,
    non-empty) → `#<id>`, else `—`.
  - `Date`: `time` (i64, or string trimmed → i64) as epoch **ms** → **local-timezone**
    `%Y-%m-%d`; else `createdAt` (string or u64) trimmed non-empty; else `—`.
  - `Comment`: `first_str(["content","description"])` else `(no comment)`.

#### 1.9 Pre-check verdict (parts/precheck.rs)
- `fn collect_owned_agents(list, signing_address)` (precheck.rs:30): walk `list.list[]`;
  wrapper with `agentList` array: include its rows only if wrapper `ownerAddress`
  (trimmed, lowercase) equals signing address (lowercase) or is absent; flat element:
  same owner test on the element. Row kept if `agentId` is a non-blank string (trimmed) or a
  number (`to_string`); tuple `(id, role_token_from_value(role), trimmed name or "")`.
- `fn build_precheck(list, addr, role_key)` (:81) →
  `{"aspCount":<owned rows with role asp>,"canCreate":<bool>,"existingSameRole":[{"agentId":…,"name":…,"roleLabel":…}],"ownerAddress":<addr trimmed>,"reason"?:…,"role":<role_key>,"roleLabel":<User|ASP|Evaluator>,"uniqueness":"single"|"multiple"}`;
  `uniqueness`/`canCreate`: `user`/`evaluator` → `single`, canCreate = no same-role row;
  `asp` → `multiple`, always true. `reason` (only when false):
  `A <label> is already registered under this wallet; each address can register only one <label>.`

### 2. Handler-local helpers referenced below
- `fn consent_impl(args, ctx)` (mutations.rs:235): `ensure_tokens_refreshed` →
  `wallet_client` → `load_agent_signing_session(None)` → `POST
  /priapi/v5/wallet/agentic/pre-transaction/agent-consent` (post_authed) body
  `{"agreed"?:<bool>,"chainIndex":"196","consentKey"?:<raw, untrimmed>,"fromAddr":<xlayer address>}`;
  errors via `format_api_error`; returns `{"consent":<data[0].consent if non-null else null>,"required":<bool>}`.
- `fn fetch_wallet_agents(ctx, role)` (mutations.rs:324): `ensure_tokens_refreshed` →
  `GET /priapi/v5/wallet/agentic/agent/agent-list?chainIndex=196[&role=<1|2|3>]` (no
  paging params) → `format_api_error` → `normalize_singleton_object`.
- `fn fetch_agent_info_by_id(id, ctx)` (mutations.rs:591): `ensure_tokens_refreshed` →
  `GET …/agent/agent-list?chainIndex=196&agentIdList=<id>` → `format_api_error` →
  normalise; `list` not an array → None; for each item: `parse_agent_info_row(item)`
  (:637; needs integer role 1/2/3) else each `item.agentList[]` row; first hit wins.
- `fn agent_status_impl(agent_id, status, ctx)` (mutations.rs:664):
  `ensure_tokens_refreshed` → `wallet_client` → `require_non_empty(agent_id,"--agent-id")` →
  `POST /priapi/v5/wallet/agentic/agent-status` body
  `{"agentId":<trimmed>,"chainIndex":"196","status":<1|2 number>}` → `format_api_error` → raw data.
- `fn submit_approval_impl(agent_id, lang, ctx)` (mutations.rs:702): `ensure_tokens_refreshed`
  → `wallet_client` → require id → `POST /priapi/v5/wallet/agentic/agent/submit-approval`
  body `{"agentId":…,"chainIndex":"196","preferredLanguage"?:<normalize_bcp47(lang)>}` →
  `format_api_error` → raw data.
- `fn service_match::build_request` (service_match.rs:216), `normalize_security_ratings`
  (:67), `add_flow_metadata` (:128), `active_subscription_payload` (:189),
  `service_is_offline` (:209), `extract_user_agent_id` (:103) — documented under
  `agent service-match`.
- `fn validate::run_validation` (validate.rs:236) — documented under `agent validate-listing`.

## Commands

Every command below first runs the §0.1 prelude; "Output" shows the `data` value inside
`{"ok":true,"data":…}` unless stated otherwise; all `Value` objects are key-sorted (§0.2).

### `onchainos agent create`  (hidden: no)
- Handler: `identity/mutations.rs:71` → `create_impl` (mutations.rs:115); args `CreateArgs` (args.rs:7).
- Options (all `Option<String>`, none clap-required, no defaults, no aliases, no env):
  `--name`, `--role`, `--description`, `--picture`, `--service` (JSON array string).
  Global `--chain` accepted and ignored.
- Auth: jwt-required + session-key signature (Ed25519 seed from HPKE-opened
  `encryptedSessionSk`, `sessionCert`), XLayer address from wallets.json.
- Steps:
  1. `ensure_tokens_refreshed()` (may `POST …/auth/refresh`).
  2. `wallet_client` (DoH prepare).
  3. `load_agent_signing_session(None)` (§1.4) → `fromAddr` = XLayer address.
  4. `keyUuid = uuid::Uuid::new_v4()` (lowercase hyphenated); `sessionSignature =
     sign_key_uuid(keyUuid, seed)`.
  5. `--role`: `require_non_empty` → `missing required parameter: --role`; `normalize_role`.
     **Note: argument validation happens only after steps 1–3**, so a logged-out user
     sees the session/wallet error first.
  6. `profileDescription`: role `asp` → `require_non_empty(--description)` (error
     `missing required parameter: --description`); others → trimmed or `""`.
  7. `name` = `require_non_empty(--name)` → `missing required parameter: --name`.
  8. `image` = trimmed `--picture` or `""`.
  9. `services = parse_services(--service)` (§1.3) — **for every role** (help text says
     ignored for user/evaluator, but it is parsed, validated and sent).
  10. `ensure_asp_has_service`, `ensure_asp_has_avatar` (§1.2).
  11. `card.role = role_to_wire(role)` (`requester` / `provider` / `evaluator`).
  12. `POST /priapi/v5/wallet/agentic/pre-transaction/create-agent` (`post_authed`, JWT,
      invalid-token retry) body (sorted):
      `{"cardJson":"<AgentCard JSON string>","chainIndex":196,"fromAddr":"<addr>","keyUuid":"<uuid>","sessionCert":"<cert>","sessionSignature":"<b64>"}`.
      `cardJson` is serialised from the struct (declaration order, not sorted):
      `{"role":"provider","name":"…","image":"…","profileDescription":"…","services":[{"id"?,"serviceName","serviceDescription","serviceGuide"?,"fee","serviceType","subscription":[{"interval":"month","fee":"10"}],"freeTrial"?,"operation"?,"endpoint"?}]}`
      (`services` always present, `[]` when none).
  13. `parse_agent_unsigned(data)`; `communicationAddress` = `unsigned.extraData.communicationAddress` string or `""`.
  14. overlay `erc8004Msg` = `{communicationAddress (if non-empty), role: <wire role>, keyUuid}`.
  15. `open_identity_subscription(fromAddr, identity_ws_url())` (§1.5, ≤10 s; failure → no push).
  16. broadcast (§0.5) → `txHash`.
  17. `wait_for_identity_push(sub, txHash)` (≤30 s) → push; `newAgentId` from push.
- Output: `{"agent"?:<push object verbatim>,"newAgentId":"<id>"|null,"txHash":"<hash>"}`.
- Errors (exit 1 unless noted): session/wallet errors (§0.3, §1.4); validation errors above;
  service errors (§1.3); `Wallet API error (code=…): …` from create-agent (not
  format-mapped); `pre-transaction response is empty`; `transaction simulation failed: …`;
  broadcast errors; code 81362 → confirming envelope exit 2.
- Side effects: **FUND-MOVING / on-chain** — signs and submits an ERC-8004 registration
  contract call via `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction`
  (create-agent itself = state).
- Nondeterminism: `keyUuid` (UUID v4), `sessionSignature` (depends on keyUuid), `txHash`,
  presence of `agent`/`newAgentId` (WS timing), token refresh.
- Parity test cases:
  1. `agent create --role user --name Alice` with empty `ONCHAINOS_HOME` → `{"ok":false,"error":"session expired, please login again: onchainos wallet login"}` exit 1 — SAFE.
  2. logged in: `agent create --role admin --name X` → `invalid value for --role: admin (expected: user, asp, or evaluator)` — SAFE (only possible auth refresh).
  3. logged in: `agent create --role asp --name "Price Bot" --description "Quotes prices" --service '[{"serviceName":"Quote","serviceDescription":"d","serviceType":"A2A","fee":"1"}]'` → `ASP agents require an avatar; upload an image and provide --picture` — SAFE.
  4. logged in: `agent create --role user --name "Buyer One"` → full flow — UNSAFE (on-chain).

### `onchainos agent update`  (hidden: no)
- Handler: `identity/mutations.rs:81` → `update_impl` (mutations.rs:405); args `UpdateArgs` (args.rs:134).
- Options: `--agent-id`, `--name`, `--description`, `--picture`, `--service` (all
  `Option<String>`, runtime-validated). No role flag.
- Auth: jwt-required + session-key signature (same material as create).
- Steps:
  1. **A2A preflight** (§0.6) — may error before anything else.
  2. `ensure_tokens_refreshed`; `wallet_client`.
  3. `--agent-id` → `require_non_empty` (`missing required parameter: --agent-id`).
  4. `load_agent_signing_session(None)`.
  5. `cardJson` object (sorted keys on the wire): `agentId` (trimmed string), `name` /
     `profileDescription` / `image` only when the trimmed flag value is non-empty (empty
     never clears), `services` only when `--service` was given at all
     (`parse_service_deltas`, §1.3; `--service ""` → parse error).
  6. `POST /priapi/v5/wallet/agentic/pre-transaction/update-agent` (post_authed) body
     `{"cardJson":"<sorted JSON string>","chainIndex":196,"sessionCert":"<cert>"}`.
     Example cardJson: `{"agentId":"42","name":"New","services":[{"fee":"10","operation":"create","serviceDescription":"d","serviceName":"Market Signals","serviceType":"A2A","subscription":[]},{"id":"9","operation":"delete"}]}`.
  7. `parse_agent_unsigned`; WS subscribe with signing address (§1.5); broadcast with **no
     overlay** (no `erc8004Msg`); wait push; envelope.
- Output: `{"agent"?:…,"newAgentId":…|null,"txHash":"…"}`.
- Errors: preflight error; validation / service-delta errors; `Wallet API error (code=…): …`;
  broadcast errors; 81362 → exit 2.
- Side effects: **FUND-MOVING / on-chain** (broadcast-transaction); update-agent = state.
- Nondeterminism: txHash, WS push timing.
- Parity test cases:
  1. `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent update` (logged in) → `missing required parameter: --agent-id` — SAFE.
  2. `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent update --agent-id 42 --service '[{"operation":"delete"}]'` → `invalid --service: operation 'delete' requires an id` — SAFE.
  3. `… --agent-id 42 --service '[{"operation":"create","id":"5","serviceName":"S","serviceDescription":"d","serviceType":"A2A","fee":"1"}]'` → `invalid --service: operation 'create' must not carry an id` — SAFE.
  4. `… --agent-id 42 --name "New Name"` → full flow — UNSAFE.

### `onchainos agent get`  (hidden: yes)
- Handler: `identity/queries.rs:40` → `get_impl` (queries.rs:158); args `GetArgs` (args.rs:235).
- Options: `--agent-ids` (comma string, forwarded as one value), `--page`, `--page-size` (strings).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; query in order
  `chainIndex=196`, `agentIdList=<trimmed, if non-blank>` (single value, comma → `%2C`),
  `page=<u32 ≥1>` only if `--page` given, `pageSize=<u32 ≥1, default 5>` (always sent);
  `GET /priapi/v5/wallet/agentic/agent/agent-list` (get_authed); `normalize_singleton_object`;
  `enrich_agent_get_rows` (§1.7); **if `--agent-ids` flag is absent** (None — even
  `--agent-ids ""` counts as present) → `add_agent_list_cells` (adds `hasMore` + `cells`).
- Output: backend object (e.g. `{"list":[{"accountName":…,"ownerAddress":…,"agentList":[row…]}],"page":…,"pageSize":…,"total":…}`)
  with each row gaining `approvalLabel?`, `card`, `ratingStars?`, `roleLabel?`,
  `statusLabel?`, and in list mode `cells` + top-level `hasMore`.
- Errors: session errors; `invalid value for --page: …`; `invalid value for --page-size: …`;
  `Wallet API error (code=…): …`.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent get` (SAFE); `agent get --page 2 --page-size 3` (SAFE);
  `agent get --agent-ids 13373,9967` (SAFE, no cells); `agent get --page 0` → `invalid value for --page: must be >= 1` (SAFE).

### `onchainos agent get-my-agents`  (hidden: no)
- Handler: `identity/queries.rs:30` → `get_my_agents_impl` (:72) →
  `get_my_agents_with_access_token` (:77, also called by precise `service-match`); args `GetMyAgentsArgs` (args.rs:206).
- Options: `--role` (user/asp/evaluator), `--owner-address`, `--agent-ids`, `--page`,
  `--page-size` (strings). Help claims ">50 clamped to 50" — **code does not clamp**.
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `build_get_my_agents_query` (:133):
  `chainIndex=196`; `role=<1|2|3>` if `--role` non-blank (`normalize_role_code`, errors as
  §1.2); `ownerAddress` (trimmed, if non-blank); `agentIdList` (trimmed raw string);
  `page` only if given (u32 ≥1); `pageSize` (u32 ≥1, default **10**, no max) → `GET
  /priapi/v5/wallet/agentic/agent/agent-list` → `normalize_singleton_object` →
  `enrich_agent_get_rows` → `add_agent_list_cells` (always).
- Output: as `agent get` list mode (rows with labels, `card`, `cells`; top-level `hasMore`
  when page/pageSize/total parse).
- Errors: session errors; role / page errors; `Wallet API error (code=…): …`.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent get-my-agents` → query `chainIndex=196&pageSize=10` (SAFE);
  `agent get-my-agents --role asp --page 1 --page-size 5` (SAFE);
  `agent get-my-agents --role user --agent-ids 13373,9967` → `…&role=1&agentIdList=13373%2C9967&pageSize=10` (SAFE);
  `agent get-my-agents --role buyer` → `invalid value for --role: buyer (expected: user, asp, or evaluator)` (SAFE).

### `onchainos agent get-agents`  (hidden: no)
- Handler: `identity/queries.rs:35` → `get_agents_impl` (:224); args `GetAgentsArgs` (args.rs:225).
- Options: `--agent-ids` (comma-separated string).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `require_non_empty(--agent-ids)`
  (`missing required parameter: --agent-ids`); split on `,`, trim, drop empties; none →
  `--agent-ids must contain at least one agent ID`; query = one `agentIdList=<id>` per id
  (repeated key, in order), then `needBlackStatus=false`, `needAgentService=false`; `GET
  /priapi/v5/wallet/agentic/agent/batch-list`; **no** singleton normalisation;
  `enrich_agent_detail_rows` (labels + `card` per element when data is an array; no
  `cells`, no `hasMore`).
- Output: backend array of agent objects, each enriched.
- Errors: as above + API errors. Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent get-agents --agent-ids "1791, ,1002"` → `agentIdList=1791&agentIdList=1002&needBlackStatus=false&needAgentService=false` (SAFE);
  `agent get-agents --agent-ids " , "` → `--agent-ids must contain at least one agent ID` (SAFE);
  `agent get-agents` → `missing required parameter: --agent-ids` (SAFE).

### `onchainos agent pre-check`  (hidden: no)
- Handler: `identity/mutations.rs:76` → `precheck_impl` (mutations.rs:347); args `PrecheckArgs` (args.rs:256).
- Options: `--role` (required at runtime), `--consent-key` (optional).
- Auth: jwt-required; loads the full signing session (only the address is used).
- Steps:
  1. `normalize_role(require_non_empty(--role))` — **before any auth/file access**.
  2. `load_agent_signing_session(None).addr_info.address` → `fromAddr` (wallets.json,
     session.json, keyring, HPKE; errors as §1.4).
  3. `--consent-key` non-blank → `consent_impl({consentKey: <raw value>, agreed: true})`
     (POST agent-consent; result ignored, errors propagate as `code=… msg=…`).
  4. `all = fetch_wallet_agents(None)` (GET agent-list `chainIndex=196`); `has_any =
     collect_owned_agents(all, fromAddr)` non-empty.
  5. No agents → `c = consent_impl({})` (POST agent-consent `{"chainIndex":"196","fromAddr":…}`):
     `c.required` true → return
     `{"canCreate":false,"consent":<c.consent>,"reason":"You must accept the legal terms before registering an Agent.","role":"<role>"}`;
     else return `build_precheck(all, fromAddr, role)`.
  6. Has agents → `fetch_wallet_agents(Some(role))` (GET `chainIndex=196&role=<code>`) →
     `build_precheck(roleSlice, fromAddr, role)` (so `aspCount` counts ASPs in the
     role-scoped slice only).
- Output: consent-block object (step 5) or `build_precheck` object (§1.9), e.g.
  `{"aspCount":2,"canCreate":true,"existingSameRole":[{"agentId":"11","name":"ASP One","roleLabel":"ASP"},…],"ownerAddress":"0x…","role":"asp","roleLabel":"ASP","uniqueness":"multiple"}`.
- Errors: `missing required parameter: --role`; role error; §1.4 errors; `code=<c> msg=<m>`
  (format-mapped) from consent / agent-list; session errors.
- Side effects: state (agent-consent POST issues a one-time consent key when the wallet
  has no agents; with `--consent-key` records agreement); otherwise read.
- Nondeterminism: `consent.consentKey` from backend.
- Parity test cases: `agent pre-check` → `missing required parameter: --role` (SAFE, no
  auth); `agent pre-check --role user` with empty home → `no XLayer address found in current account` (SAFE);
  logged in with existing agents `agent pre-check --role asp` (SAFE, reads only);
  `agent pre-check --role user --consent-key K` (UNSAFE, records consent).

### `onchainos agent get-by-address`  (hidden: yes)
- Handler: `identity/queries.rs:65` → `get_by_address_impl` (:554); args `GetByAddressArgs` (args.rs:514).
- Options: `--communication-address <String>` (**clap required** → exit 2 if missing),
  `--chain-index` (optional string, default `196` when absent/blank).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `require_non_empty(communication
  address)` (blank → `missing required parameter: --communication-address`); query
  `communicationAddress=<trimmed>`, `chainIndex=<trimmed or 196>`; `GET
  /priapi/v5/wallet/agentic/agent/by-communication-address`; `normalize_singleton_object`.
- Output: backend data (singleton array unwrapped).
- Errors: clap exit 2; session; API. Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent get-by-address --communication-address 0xabc` (SAFE);
  `agent get-by-address --communication-address 0xabc --chain-index 1` (SAFE);
  `agent get-by-address` → clap error exit 2 (SAFE).

### `onchainos agent activate`  (hidden: no)
- Handler: `identity/mutations.rs:87` → `activate_impl` (mutations.rs:525); args `ActivateArgs` (args.rs:284).
- Options: `--agent-id` (runtime-required), `--preferred-language` (**clap required**,
  `Option<String>`; normalised with `normalize_bcp47`, invalid → field omitted).
- Auth: jwt-required.
- Steps:
  1. A2A preflight (§0.6).
  2. `require_non_empty(--agent-id)` (no auth yet).
  3. `fetch_agent_info_by_id` (GET agent-list `chainIndex=196&agentIdList=<id>`,
     format-mapped errors); None → error `agent <id> not found or not accessible`.
  4. role ≠ asp → return
     `{"agentRole":"user|evaluator","blockType":1,"reason":"only ASP agents can be listed; user and evaluator roles are not supported."}`.
  5. `agent_status_impl(id, 1)` → `POST /priapi/v5/wallet/agentic/agent-status`
     `{"agentId":"<id>","chainIndex":"196","status":1}` → `normalize_singleton_object` → `activate`.
  6. `activate.approvalStatus` (u64 or numeric string) ∈ {1,5} → `submit_approval_impl` →
     `POST /priapi/v5/wallet/agentic/agent/submit-approval`
     `{"agentId":"<id>","chainIndex":"196","preferredLanguage":"<bcp47>"}` (raw data, not normalised).
- Output: `{"activate":<obj>}` or `{"activate":<obj>,"submitApproval":<raw data>}` or the
  block object.
- Errors: preflight; `missing required parameter: --agent-id`; `agent <id> not found or not accessible`;
  `code=<c> msg=<m>`; session errors.
- Side effects: state (agent-status, submit-approval).
- Nondeterminism: none (backend-driven).
- Parity test cases: `agent activate` → clap exit 2 (SAFE);
  `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent activate --preferred-language en` → `missing required parameter: --agent-id` (SAFE);
  `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent activate --agent-id <user-agent-id> --preferred-language zh` → block object (SAFE: read only);
  `… --agent-id <asp-id> --preferred-language zh_cn` → body `preferredLanguage:"zh-CN"` (UNSAFE).

### `onchainos agent deactivate`  (hidden: no)
- Handler: `identity/mutations.rs:93` → `deactivate_impl` (:658); args `AgentStatusArgs` (args.rs:273).
- Options: `--agent-id`.
- Auth: jwt-required. **No A2A preflight.**
- Steps: `agent_status_impl(--agent-id, 2)`: `ensure_tokens_refreshed` → `wallet_client` →
  require id → `POST /priapi/v5/wallet/agentic/agent-status`
  `{"agentId":"<id>","chainIndex":"196","status":2}` → `format_api_error` →
  `normalize_singleton_object`.
- Output: backend status object (e.g. with `approvalStatus`).
- Errors: session; `missing required parameter: --agent-id` (after token check); `code=… msg=…`.
- Side effects: state. Nondeterminism: none.
- Parity test cases: `agent deactivate` (logged in) → `missing required parameter: --agent-id` (SAFE);
  `agent deactivate --agent-id 42` (UNSAFE).

### `onchainos agent upload`  (hidden: no)
- Handler: `identity/mutations.rs:98` → `upload_impl` (:750); args `UploadArgs` (args.rs:296).
- Options: `--file` (local path).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `require_non_empty(--file)`;
  `fs::read(path)` → error `failed to read file: <path>: <OS error text> (os error <n>)`;
  `validate_avatar_image` (magic bytes, §1.2) **before** size check; `len > 1048576` →
  `file size <n> bytes exceeds the 1 MB limit — please downscale the image and retry`;
  filename = `Path::file_name` (UTF-8) else `upload.bin`; multipart form with one part
  `name="file"`, `filename="<basename>"`, `Content-Type: <image mime>`, body = bytes;
  `POST /priapi/v5/wallet/agentic/pre-transaction/upload-picture`
  (`post_authed_multipart`: no retries); URL extraction: `data.url` string, else
  `data[0].url` string, else `data[0]` string, else `upload response missing url`.
- Output: `{"url":"<cdn url>"}`.
- Errors: as listed; `wallet API request failed: …`; API errors (raw text).
- Side effects: state (stores an image on the backend/CDN).
- Nondeterminism: multipart boundary.
- Parity test cases: `agent upload --file missing.png` → `failed to read file: missing.png: …` (SAFE after token check);
  `agent upload --file doc.pdf` → unsupported image type (SAFE);
  `agent upload --file big.png` (>1 MiB PNG) → size error (SAFE);
  `agent upload --file avatar.png` (UNSAFE).

### `onchainos agent search`  (hidden: no)
- Handler: `identity/queries.rs:45` → `search_impl` (:292); args `SearchArgs` (args.rs:305).
- Options: `--query` (runtime-required); `--feedback`, `--agent-info`, `--status`,
  `--service` (`Vec<String>`, clap `value_delimiter=','`, repeatable); `--page`,
  `--page-size`. `--format` does not exist (clap error).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `require_non_empty(--query)`; query
  order: `query=<trimmed>`, `page` (if given, u32 ≥1), `pageSize` (default 5, min 1, max
  100 **clamped**), then repeated `feedback`, `agentInfo`, `status`, `service` (each value
  trimmed, blanks dropped); `GET /priapi/v5/wallet/agentic/search/agent-search`;
  `normalize_singleton_object`; `build_search_table` (§1.8) — raw backend fields are NOT
  returned.
- Output: `{"page":…,"pageSize":…,"table":{"columns":[6 fixed],"rows":[…]},"total":…}`.
- Errors: session; `missing required parameter: --query`; page errors; API.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent search --query "market analysis"` → `query=market+analysis&pageSize=5` (SAFE);
  `agent search --query dex --page-size 500 --status 1,2` → `pageSize=100&status=1&status=2` (SAFE);
  `agent search --query x --format table` → clap error exit 2 (SAFE).

### `onchainos agent service-list`  (hidden: no)
- Handler: `identity/queries.rs:50` → `service_list_impl` (:377); args `ServiceListArgs` (args.rs:363).
- Options: `--agent-id` (runtime-required), `--service-id` (optional), `--page`
  (clap default `"1"`), `--page-size` (clap default `"3"`).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; `require_non_empty(--agent-id)`;
  `build_service_list_query` (:356): `agentId=<trimmed>`, `page` (u32 ≥1),
  `pageSize` (u32 ≥1, no max), then `serviceId=<trimmed>` if given; given but blank →
  `invalid parameter: --service-id must not be blank`; `GET
  /priapi/v5/wallet/agentic/agent/services`; **no** singleton normalisation;
  `add_service_list_cells` (§1.8).
- Output: backend data (live shape: array of `{agentInfo, list:[service…], page, pageSize,
  total}`) with `hasMore` per wrapper and `cells` (+ `serviceGuideHash` when a guide
  exists) per named service. `serviceGuide` passes through untouched.
- Errors: session; id / page errors; API. Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent service-list --agent-id 1921` → `agentId=1921&page=1&pageSize=3` (SAFE);
  `agent service-list --agent-id 1921 --service-id 4a7f30a7-46fb-4695-80a1-25d160da33b3` (SAFE);
  `agent service-list --agent-id 42 --service-id "  "` → blank error (SAFE);
  `agent service-list --agent-id 42 --page abc` → `invalid value for --page: expected integer` (SAFE).

### `onchainos agent service-match`  (hidden: no)
- Handler: `identity/service_match.rs:24` `service_match`; args `ServiceMatchArgs`
  (args.rs:418; also flattened into a task-group command via `task/user/mod.rs:60`).
- Options: `--keywords <K>...` (`num_args = 1..`, repeatable, `Vec<String>`),
  `--asp-agent-id`, `--asp-name`, `--service-name`, `--sid` (field `service_id`),
  `--min-payment-token-amount`, `--max-payment-token-amount`, `--search-after`,
  `--limit <u64>` (default 3, no range). Removed flags `--agentic-id`, `--query-json` →
  clap error.
- Auth: **fuzzy** (neither `--sid` nor `--asp-agent-id` non-blank) → anonymous;
  **precise** → jwt-required + header `agenticId`.
- Steps:
  1. `build_request` (before any network): raw `keywords.len() > 10` →
     `service search accepts at most 10 keywords`; keywords trimmed, blanks dropped; other
     strings trimmed (blank → absent); amounts parsed with serde_json `Number::from_str`
     (JSON number grammar) → error `<flag> must be a valid decimal: <serde msg>` (verified:
     `abc` → `invalid number at line 1 column 1`, `05` → `… column 2`, `5.` →
     `EOF while parsing a value at line 1 column 2`, `1e400` → `number out of range at line 1 column 5`);
     negative / non-finite → `<flag> must be greater than or equal to 0` (`-0` accepted as
     `-0.0`); both present and `min > max` (as f64) →
     `minPaymentTokenAmount must be less than or equal to maxPaymentTokenAmount`;
     `--search-after` with any initial condition (non-empty keywords, asp id, asp name,
     service name, sid, min, max) → `--search-after cannot be combined with initial search conditions`.
     Body (sorted keys): continuation `{"limit":N,"searchAfter":"<cursor>"}`; initial
     `{"aspAgentId"?,"aspName"?,"keywords"?:[…],"limit":N,"maxPaymentTokenAmount"?:<number>,"minPaymentTokenAmount"?:<number>,"serviceName"?,"sid"?}`
     — amounts keep their parsed JSON form (`5` → `5`, `5.25` → `5.25`, `10.50` → `10.5`,
     `10.0` → `10.0`, `1e2` → `100.0`).
  2. `wallet_client`.
  3. Precise: `ensure_tokens_refreshed` → `get_my_agents_with_access_token(role=user,
     pageSize default 10)` = `GET /priapi/v5/wallet/agentic/agent/agent-list?chainIndex=196&role=1&pageSize=10`
     (+ enrichment, discarded) → first `agentId` (string trimmed non-empty or number) from
     `list[*].agentList[*]` / `list[*]` (or a bare array) → none →
     `no User identity found on this account; create a User identity before using precise service search`
     → `POST /priapi/v1/aieco/task/asp/service/search` (post_authed_with_headers, JWT +
     `agenticId: <id>`, invalid-token retry keeps the header).
     Fuzzy: `POST /priapi/v1/aieco/task/asp/service/search` via `post_public` (no JWT, no
     login-state read).
  4. `normalize_security_ratings`: for each `services[*].asp` object insert `rating`:
     `securityRate` number == 0 → `No rating yet`; other number → `★ ` +
     `format_search_rate(rate)` (no /20); else `—`.
  5. `add_flow_metadata` (object data only): remove `action`; `services` (missing →
     empty) decides: empty → tip `No matching services were found on OKX.AI. Try another keyword and search again.`;
     precise and any service offline (`asp.onlineStatus` not the integer 1) →
     `This Agent is offline and cannot provide the service right now. Search for another service.`;
     exactly 1 service: precise and `subscribedInfo.isActive === true` with non-blank
     string `jobId` → **duplicate block**: remove `tip`, set
     `phase:"subscription_validation"`, `decision:"blocked"`, `reason:"duplicate_subscription"`,
     `nextAction:[{"id":"restore_subscription","recommend":true}]`,
     `payload:{"active":true,"jobId":"<trimmed>","status"?:…,"title"?:…}`; otherwise tip
     `Reply to confirm that you want to use this service.`; ≥2 services: `hasMore === true`
     → `Tell me which service you want to use, or ask for more.`, else
     `There are no more matching services. Tell me which service you want to use.`. In the
     non-block case keys `phase, decision, reason, nextAction, payload` are removed.
- Output: backend `data` object (sorted) + the mutations above.
- Errors: validation errors (exit 1, before network); clap errors (exit 2); session errors
  (precise); `Wallet API error (code=…): …`.
- Side effects: read-only (POST query). Nondeterminism: backend cursor.
- Parity test cases: `agent service-match` → body `{"limit":3}` anonymous (SAFE);
  `agent service-match --keywords "smart contract" audit --min-payment-token-amount 5 --max-payment-token-amount 20` → `{"keywords":["smart contract","audit"],"limit":3,"maxPaymentTokenAmount":20,"minPaymentTokenAmount":5}` (SAFE);
  `agent service-match --search-after next --keywords a` → combine error (SAFE, no network);
  `agent service-match --min-payment-token-amount=-1` → `--min-payment-token-amount must be greater than or equal to 0` (SAFE);
  `agent service-match --sid svc-001` (logged in; SAFE read, precise path).

### `onchainos agent feedback-submit`  (hidden: no; visible alias `feedbacksubmit`)
- Handler: `identity/mutations.rs:103` → `feedback_submit_impl` (:825); args `FeedbackSubmitArgs` (args.rs:524).
- Options: `--agent-id`, `--creator-id`, `--score` (0.00–5.00 stars), `--description`
  (optional), `--task-id` (all strings, runtime-validated).
- Auth: jwt-required + session-key signature.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; in order `require_non_empty`
  `--agent-id`, `--creator-id`, `--score` then `parse_stars_arg` (§1.6) → wire score
  0–100; description trimmed or `""`; `--task-id` required; `load_agent_signing_session`;
  `comment` string = `{"agentid":"<agent-id>","comment":"<description>","value":"<score>"}`
  (sorted); `POST /priapi/v5/wallet/agentic/pre-transaction/create-comment` (post_authed)
  body `{"chainIndex":196,"comment":"<string>","feedBackAgentId":"<creator-id>","sessionCert":"<cert>","taskId":"<task-id>"}`;
  `parse_agent_unsigned`; overlay `erc8004Msg:{"feedBackAgentId":…,"taskId":…}`; broadcast
  (§0.5). No WS.
- Output: `{"txHash":"<hash>"}`.
- Errors: missing-parameter errors, score errors, §1.4, API (raw), broadcast, 81362 → exit 2.
- Side effects: **FUND-MOVING / on-chain** (broadcast-transaction); create-comment = state.
- Nondeterminism: txHash.
- Parity test cases: logged in `agent feedback-submit --agent-id 1 --creator-id 2 --score 5.01 --task-id 0xabc` → `invalid value for --score: must be between 0.00 and 5.00` (SAFE);
  `… --score 3.333 …` → `invalid value for --score: expected 0.00–5.00 (up to 2 decimal places)` (SAFE);
  `agent feedbacksubmit --agent-id 1 --creator-id 2 --score 4.5` → `missing required parameter: --task-id` (SAFE);
  `… --score 3.33 --task-id 0xabc` → wire value `"67"` (UNSAFE).

### `onchainos agent feedback-list`  (hidden: no)
- Handler: `identity/queries.rs:55` → `feedback_list_impl` (:441); args `FeedbackListArgs` (args.rs:543).
- Options: `--agent-id` (runtime-required), `--page`, `--page-size`.
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; require id; query
  `agentId=<trimmed>`, `pageNo=<u32 ≥1, default 1>`, `pageSize=<u32 ≥1, default 5, >50
  clamped to 50>` (always sent despite "backend default" help text); `GET
  /priapi/v5/wallet/agentic/agent/reviews`; `normalize_singleton_object`;
  `convert_feedback_list_scores` (§1.6); `add_feedback_list_cells` (§1.8).
- Output: backend object with `average`/`score` converted to f64 stars, `hasMore`, and
  per-entry `cells` `[Score, Reviewer, Date, Comment]`.
- Errors: session; id/page errors; API. Side effects: read-only.
- Nondeterminism: `Date` cell depends on local timezone.
- Parity test cases: `agent feedback-list --agent-id 42` → `agentId=42&pageNo=1&pageSize=5` (SAFE);
  `agent feedback-list --agent-id 42 --page 3 --page-size 51` → `pageNo=3&pageSize=50` (SAFE);
  `agent feedback-list --agent-id 42 --page-size 0` → `invalid value for --page-size: must be >= 1` (SAFE).

### `onchainos agent task-feedback`  (hidden: no)
- Handler: `identity/queries.rs:60` → `task_feedback_impl` (:497); args `TaskFeedbackArgs` (args.rs:563).
- Options: `--agent-id` (rater's id; help `Required. The rater's agent id.`), `--task-id`
  (help `Required. The task id being reviewed.`). No chain flag (always 196).
- Auth: jwt-required.
- Steps: `ensure_tokens_refreshed`; `wallet_client`; require `--agent-id`, `--task-id`;
  query `agentId`, `taskId`, `chainIndex=196`; `GET /priapi/v5/wallet/agentic/agent/task-feedback`.
- Output: backend `data` verbatim (array: `[]` or one row with `agentId`, `taskId`,
  `chainIndex`, `feedbackId`, `comment`).
- Errors: session; missing parameters; API. Side effects: read-only. Nondeterminism: none.
- Parity test cases: `agent task-feedback --agent-id 7 --task-id 0xabc` (SAFE);
  `agent task-feedback --agent-id 7` → `missing required parameter: --task-id` (SAFE).

### `onchainos agent xmtp-sign`  (hidden: yes)
- Handler: `identity/mutations.rs:108` → `xmtp_sign_impl` (:919); args `XmtpSignArgs` (args.rs:584).
- Options: `--key-uuid`, `--message` (both runtime-required; **both trimmed** — the help
  text says "forwarded verbatim").
- Auth: jwt-required + session-key signature (seed + cert; wallets.json not needed).
- Steps: `ensure_tokens_refreshed`; `wallet_client`; require `--key-uuid`, `--message`;
  `load_signing_seed`, `load_session_cert`; `sessionSignature = sign_key_uuid(keyUuid)`;
  `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` (post_authed) body
  `{"chainIndex":"196","keyUuid":"…","message":"…","sessionCert":"…","sessionSignature":"…","signType":"aiagentsign"}`;
  `format_api_error`; `data[0]` must exist (`xmtp-sign response is empty`) and have a
  non-empty string `signature` (`xmtp-sign response missing signature`).
- Output: `data[0]` object verbatim (sorted), e.g. `{"signature":"…",…}`.
- Errors: as listed; `code=<c> msg=<m>`. Side effects: server-side signature issuance
  (auth-like; no funds, no state change known).
- Nondeterminism: backend signature (deterministic sessionSignature).
- Parity test cases: `agent xmtp-sign --message hi` → `missing required parameter: --key-uuid` (SAFE after token check);
  `agent xmtp-sign --key-uuid <uuid> --message "hello"` (UNSAFE: signs).

### `onchainos agent validate-listing`  (hidden: yes)
- Handler: `identity/validate.rs:24` `validate_listing` → `run_validation` (:236); args `ValidateListingArgs` (args.rs:598).
- Options: `--role` (invalid or absent → silently `asp`), `--name`, `--description`,
  `--service` (JSON array string; only for asp).
- Auth: anonymous; **no HTTP, no files** (besides the §0.1 prelude).
- Output: NOT the envelope — `println!("{}", serde_json::to_string_pretty(&result))`
  (always pretty, 2-space indent, `ONCHAINOS_PRETTY` irrelevant), struct order:
  ```
  {
    "pass": <bool>,
    "findings": [
      {
        "field": "...",
        "code": "...",
        "severity": "block" | "suggest",
        "message": "..."
      }
    ]
  }
  ```
  (`"findings": []` when none). Exit 0 always (clap errors exit 2). `pass` = no `block`
  finding.
- Algorithm (findings appended in exactly this order):
  1. `name` = trimmed (absent → `""`), `description` = trimmed.
  2. Name (skipped when empty), field `name`, message FE03, codes:
     `U1` has_test_marker; `N1` length — if contains CJK (`U+4E00–9FFF, U+3400–4DBF,
     U+F900–FAFF, U+3000–303F`) and no ASCII letter → scalars ∉ [2,12], else ∉ [3,25];
     `N2` has_embedded_agent_id; `N3` has_ordinal_suffix; `N6` CJK + ASCII letter and not
     containing `" · "` (space U+00B7 space); `N8` has_decorative_symbols.
  3. Description (skipped when empty), field `description`, message FE05: `U1`
     has_test_marker (all roles); asp only: `D6` contains_url; `D8` scalars > 500.
  4. asp only, `--service` present and trimmed non-empty: `parse_services_lenient` =
     serde `Vec<AgentService>` (same schema as §1.1; any serde failure incl. missing
     `serviceName`/`serviceDescription`/`serviceType`, unknown `operation`, numeric `fee`)
     → single finding `{field:"service",code:"PARSE",FE13}`; else trim name, description,
     guide, fee, type, endpoint (blank stays `Some("")`), freeTrial. Unlike the strict
     path: the stored type is not uppercased (checks uppercase on the fly), tiers are not
     normalised and **blank tiers are NOT dropped** (`[{"interval":"","fee":""}]` counts as
     a subscription → `P4` + `PRICE_EMPTY`), and no operation×id check is made. For each
     service `i` run `check_service`, then `S2`, then `EP1`.
  5. `check_service(i)` (validate.rs:371), `stype` = uppercase(type):
     a. `T1` field `service[i].servicetype` FE10 if stype ∉ {A2A, A2MCP}.
     b. endpoint empty (None or blank): `T2` (`service[i].endpoint`, FE11) if A2MCP and
        empty; `T3` (FE11) if A2A and non-empty.
     c. `T4` (FE11), A2MCP with endpoint: not starting with `https://` (case-sensitive) →
        T4; else host = text after `https://` up to first `/`, then before first `:`,
        lowercased; private if `localhost`, `127.0.0.1`, `0.0.0.0`, starts `10.`,
        starts `192.168.`, ends `.local`, ends `.internal`, or `172.<n>.` with n in 16..=31.
     d. `U5` (FE10_U5) for A2A/A2MCP: field `service[i].name` then
        `service[i].servicedescription` if the text contains the OTHER type as a standalone
        word (A2A → `a2mcp`; A2MCP → `a2a`; case-insensitive; boundaries = non-ASCII-alnum).
     e. service name non-empty (field `service[i].name`, FE06): `S1` scalars ∉ [5,30];
        `S3` agent name non-empty and names equal ASCII-case-insensitively; `S4`
        contains_price_info; `S6` has_test_marker.
     f. pricing (`check_pricing`, validate.rs:562), fee field `service[i].fee`, sub field
        `service[i].subscription`, trial field `service[i].freeTrial`:
        - A2MCP: `P3` (sub, FE17) if tiers non-empty; `P7` (trial, FE20) if trial non-blank;
          fee empty → `U4` + `P1` (both fee, FE12); else `P1` (FE12) if
          `!is_plain_number(fee,6)`; stop.
        - A2A: `P2` (fee, FE17) if no fee and no tiers; `P6` (fee, FE17) if both; `P1`
          (fee, FE12_A2A) if fee present and `!is_plain_number(fee,2)`; per tier: `P4`
          (sub, FE18) if trimmed interval not eq-ignore-case `month`; then tier fee
          (trimmed): empty → `PRICE_EMPTY` (sub, `The price for "<name>" cannot be empty. Please enter a price and try again.`);
          else not plain(2) → `P5` (sub, FE19); else zero → `SUBSCRIPTION_PRICE_ZERO`
          (sub, `The subscription price for "<name>" must be greater than 0. Please update the price and try again.`);
          trial non-blank: `P7` (FE20) if no tiers; `P8` (FE20) if not positive integer.
        - other type: `P1` (FE12) if fee present and not plain(6).
     g. `G2` field `service[i].serviceGuide`, message
        `The service guide for [<name>] exceeds the length limit. Shorten it to no more than 5,000 full-width Chinese/Japanese characters or 10,000 Latin characters, then resubmit.`
        if operation ≠ delete and guide non-empty and display_width > 10000.
     h. description (`check_service_description`, field `service[i].servicedescription`):
        `has_url` = not A2MCP and contains_url; `has_marker` = has_test_marker; message
        `fe22(has_url, has_marker)`; `D6` if has_url, then `U1` if has_marker (same
        message); A2MCP stops here; description blank → `D1` (FE21_D1) stop;
        `display_width > 2000` → `D2` severity **suggest** (FE21_D2).
  6. `S2` (FE06, field `service[i].name`): for non-empty names, a later name equal
     (ASCII-case-insensitive) to an earlier one.
  7. `EP1` (field `service[i].endpoint`): skip delete-op services and blank endpoints; for
     each, conflict = an earlier recorded endpoint equal ignoring ASCII case, unless both
     carry the same non-empty id (string non-empty or number→string); conflict →
     message `The Endpoint for "<this name>" is already used by "<first claimant name>". Please use a different Endpoint and try again. If you have any questions, contact the OKX.AI team via customer support in the bottom-right corner of okx.ai.`;
     else record the endpoint only if not yet recorded.
- Predicates (validate.rs:748-978):
  - `has_test_marker(s)`: on ASCII-lowercased `s`: contains any of `(pre) (test) (dev)
    (beta) (alpha) (staging) (uat) (sandbox) [pre] [test] [dev] [beta] {pre} {test}`; or
    any `<delim><word>` followed by end or a non-ASCII-alnum char for
    `-pre -test -dev -beta -staging _pre _test _dev _beta _staging .pre .test`; or ends
    with ` pre`, ` test`, ` dev`, ` beta`, ` staging`.
  - `has_embedded_agent_id`: `#` or `_` immediately followed by an ASCII digit anywhere; or
    the text after the last space is non-empty all ASCII digits.
  - `has_ordinal_suffix`: `trim_end`, lowercase; ends with `)` and the text after the last
    `(` (before the final `)`) is non-empty digits; else take trailing ASCII digits (≥1);
    prefix ends with `#`, `_v`, `_`, `no.` or `no` → true (so `Casino7` is N3).
  - `has_decorative_symbols`: any of `! ? @ # $ % * ~ / \ | + =`; or contains `-` and
    (trimmed starts/ends with `-` or contains ` - `).
  - `contains_url`: lowercase contains `http://`, `https://` or `github.com`.
  - `contains_price_info`: standalone word `free` (ASCII-lowercase, non-alnum boundaries)
    or contains `免费`; or an occurrence of `usdt`/`usdg` whose preceding text,
    after trimming trailing whitespace, ends with an ASCII digit.
- Messages (exact; `–` U+2013, `·` U+00B7, `—` U+2014):
  - FE03 `The Agent name doesn't meet the naming rules: it may contain a test marker, an ordinal suffix, or special symbols, or its length or bilingual format is invalid. Use a clean brand name instead: 2–12 characters in Chinese or 3–25 in English, with no test markers, ordinals, or special symbols; for a bilingual name, use the "Chinese name · English name" format. Then resubmit.`
  - FE05 `The Agent description has an issue: it contains a URL or a test marker (e.g. "(test)", "-pre", or a trailing "beta"), exceeds 500 characters, or is empty. Remove any links and test markers, trim it to 500 characters or fewer, and make sure it's filled in. Then resubmit.`
  - FE06 `The service name doesn't meet the rules: its length is out of range, it duplicates the Agent name or another service name, or it contains pricing or a test marker. Keep every service name unique, 5–30 characters long, and different from the Agent name; move any pricing to the fee field, remove test markers, then resubmit.`
  - FE10 `The service type must be exactly A2A or A2MCP; the current value is invalid. Select A2A or A2MCP from the menu, then resubmit.`
  - FE10_U5 `The service name or description mentions a different service type than the one selected — an A2A service that says "A2MCP", or the reverse. Keep the service type you picked and delete that word from the name or description; only change the service type if you actually offer the other one. Then resubmit.`
  - FE11 `The endpoint configuration is invalid: A2MCP requires an endpoint while A2A must not have one, and it must be a publicly accessible HTTPS URL — not a private-network address or one starting with 0x. For A2MCP, enter a publicly accessible https URL; for A2A, remove the endpoint. Then resubmit.`
  - FE12 `The A2MCP fee must be a plain number (enter 0 for free), but the current value contains units, non-numeric text, or more than 6 decimal places. Enter the fee as a number only (e.g., 10; 0 for free) — it's denominated in USDT by default, with up to 6 decimal places and no symbols or extra text. Then resubmit.`
  - FE12_A2A `The A2A pay-per-use fee must be a plain number, but the current value contains units, non-numeric text, or more than 2 decimal places. Enter the fee as a number only (e.g., 10 or 0.25) — it's denominated in USDT by default, with up to 2 decimal places and no symbols or extra text. Then resubmit.`
  - FE13 `The service data isn't a valid JSON array, or the create/update/delete operations don't match the id rules. Follow the sample format — omit the id when creating, and include the id when updating or deleting — then resubmit.`
  - FE17 `The subscription billing setup is invalid: A2MCP doesn't support subscriptions, and an A2A service must use exactly one of pay-per-use or monthly subscription — you can't leave both empty or fill in both. Pick one billing mode for your A2A service: set a pay-per-use fee, or set a monthly subscription (leave fee as an empty string "" when using subscription); for A2MCP, remove the subscription field. Then resubmit.`
  - FE18 `Subscriptions currently support monthly billing only, but a different interval was provided. Set the subscription tier's interval to "month" (weekly, yearly, and other intervals aren't supported yet), then resubmit.`
  - FE19 `The A2A subscription price must be a plain number, but the current value contains units, symbols, non-numeric text, or more than 2 decimal places. Enter each tier's price as a number only (e.g., 10 or 0.25) — denominated in USDT by default, up to 2 decimal places, no symbols or extra text. Then resubmit.`
  - FE20 `The free-trial setup is invalid: freeTrial can only be configured on monthly-subscription A2A services and must be a positive integer number of hours; A2MCP and pay-per-use services can't offer a trial. Guided writes use "72" (3 days); preserve another positive integer only when writing back a legacy service. Otherwise omit freeTrial entirely (don't set "" or "0"). Then resubmit.`
  - FE21_D1 `The service description is empty. Fill in what the service does, then resubmit.`
  - FE21_D2 `The service description is longer than the recommended 1000 CJK characters (2000 half-width). Trimming it is recommended — this is a suggestion, so you can submit it as is.`
  - fe22: `The service description needs a change: remove the link. Then resubmit.` /
    `… remove the test marker. Then resubmit.` /
    `… remove the link and the test marker. Then resubmit.`
- Side effects: local-only (none). Nondeterminism: none.
- Parity test cases (all SAFE, no network):
  1. `agent validate-listing --name "Summarizer Bot" --description "A helpful agent." --service '[{"serviceName":"Document Summarizer","serviceDescription":"Summarizes text.","serviceType":"A2MCP","fee":"10","endpoint":"https://example.com/mcp"}]'` → `pass: true`, `findings: []`.
  2. `agent validate-listing --name "Bot#3"` → findings `N2`, `N3`, `N8` (FE03), `pass: false`.
  3. `agent validate-listing --role user --name "Buyer Bot" --service "not json"` → pass true (service ignored).
  4. `agent validate-listing --name "Agent Name" --service '[{"serviceName":"Pricing Service","serviceDescription":"Does a thing.","serviceType":"A2A","fee":"","subscription":[{"interval":"month","fee":"0"}]}]'` → `SUBSCRIPTION_PRICE_ZERO`.
  5. `agent validate-listing --name "Agent Name" --service '[{"serviceName":"Doc Summarizer","serviceDescription":"xxxx…(2001 x)","serviceType":"A2A","fee":"5"}]'` → single `D2` suggest, `pass: true`.

## Endpoint classification (this partition)

| Method | Path | Class | Used by |
|---|---|---|---|
| GET | `/priapi/v5/wallet/agentic/agent/agent-list` | read | get, get-my-agents, pre-check, activate, service-match (precise) |
| GET | `/priapi/v5/wallet/agentic/agent/batch-list` | read | get-agents |
| GET | `/priapi/v5/wallet/agentic/search/agent-search` | read | search |
| GET | `/priapi/v5/wallet/agentic/agent/services` | read | service-list |
| GET | `/priapi/v5/wallet/agentic/agent/reviews` | read | feedback-list |
| GET | `/priapi/v5/wallet/agentic/agent/task-feedback` | read | task-feedback |
| GET | `/priapi/v5/wallet/agentic/agent/by-communication-address` | read | get-by-address |
| POST | `/priapi/v1/aieco/task/asp/service/search` | read | service-match |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/create-agent` | state | create |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/update-agent` | state | update |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/create-comment` | state | feedback-submit |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` | funds | create, update, feedback-submit |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/agent-consent` | state | pre-check |
| POST | `/priapi/v5/wallet/agentic/agent-status` | state | activate, deactivate |
| POST | `/priapi/v5/wallet/agentic/agent/submit-approval` | state | activate |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/upload-picture` | state | upload |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/sign-msg` | auth | xmtp-sign |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | every JWT leaf (core `ensure_tokens_refreshed` / `force_refresh_access_token`) |
| WS | `<AGENT_IDENTITY_WS_URL>` (default `/ws/v5/private`), channel `wallet-agentic-identity` | read | create, update |

## External hosts
- `wss://wsdex.okx.com:8443/ws/v5/private` — compiled default identity push WebSocket
  (create/update), overridable only at build time (`OKX_AGENTIC_WS_URL`).
- `https://beta.okex.org` — HTTP base when hidden global `--dev` is set.
- DoH failover machinery inside `WalletApiClient` (core `doh/`): pilot binary CDNs
  `https://static.okx.com/upgradeapp/tools/pilot`, `https://static.coinall.ltd/…`,
  `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/…`, `https://static.jingyunyilian.com/…`
  and resolved proxy nodes — only on connect failures against the production base URL.
- Local process (not a host): `okx-a2a` CLI (`--version`, `doctor --json`) in the
  update/activate preflight.

## Open questions
1. Exact serde_json / OS error strings (`… at line L column C`, localized Windows
   `(os error 2)` texts) are embedded in error envelopes; should parity compare these
   byte-for-byte or only the prefix?
2. `format_search_rate` uses Rust ties-to-even rounding; JS `toFixed` rounds ties up —
   the port must implement exact-decimal half-even to match (affects rates like 92.5/20).
3. `sign-msg` (xmtp-sign) classified as `auth`; it is a server-side signing oracle keyed by
   `keyUuid` — confirm whether it should be treated as state/funds for replay safety.
4. Whether identity broadcasts (ERC-8004 register/update/feedback) actually consume the
   user's gas or are sponsored (AA `uopHash`); classified conservatively as funds.
5. Broadcast code 81362 returns a confirming envelope telling the user to re-run with
   `--force`, but none of these leaves accept `--force` (clap error) — replicate or fix?
6. Help-text vs code mismatches (code behaviour is specified above): get-my-agents claims a
   50 clamp (none); feedback-list/search/get claim "backend default" paging (defaults are
   sent); serviceGuide help says 2000 width (code limit 10000); create help says services
   ignored for user/evaluator (they are validated and sent); xmtp-sign says message
   verbatim (it is trimmed).
7. reqwest multipart details for `upload` (filename percent-encoding of non-ASCII/space,
   Content-Length vs chunked, boundary format) were not verified.
8. `feedback-list` `Date` cell uses the machine's local timezone; parity runs must pin TZ.
9. Which identity WS URL the lite runtime should use (compiled default vs the checked-in
   `cli/.env` value `ws://127.0.0.1:18899/ws/v5/private`).
10. Float re-serialisation: serde_json (no `float_roundtrip`) and its `1e+16`-style output
    differ from JS for some magnitudes; big integers beyond 2^53 require a lossless parser.
11. pre-check's agent-list scans send no paging params, so wallets with more agents than the
    backend default page may be mis-evaluated — faithful replication assumed.
12. The user request mentions supporting "the muse"; nothing in this partition refers to
    it, so its mapping onto identity commands is undetermined.
