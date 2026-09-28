# g01-core-runtime — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the cross-cutting runtime every other group sits on — process entry, global flags,
dispatch, exit codes, the stdout JSON envelopes (and the serde_json byte rules behind them),
the `ApiClient` HTTP layer (headers, envelope unwrap, JWT refresh-and-retry, x402 402 auto-pay,
payment-state header, payment notifications), DoH failover, device id/name headers, the audit
log, the home directory layout, the chain registry / chain cache, token aliases, validators,
asset classes, the funding-bundle helpers and the shared QR renderer.

This partition owns **no leaf command**. The root invocation (`onchainos` itself: global flags,
`--version`, `--help`, parse errors, dispatch) is documented in "Commands" as the entry-point
contract.

---

## Sources read

Partition files (all read fully, every line, including `#[cfg(test)]` modules):

| File | Lines |
|---|---|
| `cli/src/main.rs` | 316 |
| `cli/src/client.rs` | 2469 |
| `cli/src/endpoints.rs` | 65 |
| `cli/src/config.rs` | 66 |
| `cli/src/output.rs` | 450 |
| `cli/src/home.rs` | 500 |
| `cli/src/commands/mod.rs` | 134 |
| `cli/src/commands/common.rs` | 116 |
| `cli/src/commands/sink.rs` | 1022 |
| `cli/src/audit.rs` | 1405 |
| `cli/src/doh/mod.rs` | 6 |
| `cli/src/doh/types.rs` | 57 |
| `cli/src/doh/cache.rs` | 199 |
| `cli/src/doh/manager.rs` | 424 |
| `cli/src/doh/binary.rs` | 362 |
| `cli/src/device/mod.rs` | 12 |
| `cli/src/device/id.rs` | 319 |
| `cli/src/device/name.rs` | 151 |
| `cli/src/validators.rs` | 442 |
| `cli/src/asset_class.rs` | 115 |
| `cli/src/chains.rs` | 623 |
| `cli/src/token_alias.rs` | 536 |
| `cli/src/payment_notify.rs` | 1064 |
| `cli/src/payment_cache.rs` | 280 |
| `cli/src/funding.rs` | 527 |
| `cli/src/qr.rs` | 720 |

Supporting sources read (partially, to trace helpers the partition calls; behaviour owned elsewhere):

| File | Lines | What was read / why |
|---|---|---|
| `cli/build.rs` | 59 | full — compiled endpoint constants |
| `cli/.env` (present in this checkout) | 3 | `OKX_BASE_URL=http://127.0.0.1:18899`, `OKX_AGENTIC_WS_URL=ws://127.0.0.1:18899/ws/v5/private`, `ONCHAINOS_WS_URL=ws://127.0.0.1:18899/ws/v6/dex` (harness build) |
| `cli/Cargo.toml`, `cli/Cargo.lock` | — | serde_json 1.0.149 **without `preserve_order`** (no indexmap dep) ⇒ every `serde_json::Value` object serialises with **sorted keys**; clap 4.6.0; reqwest 0.12.28 (rustls, no gzip); qrcode 0.14.1; machine-uid 0.3.0; whoami 1.6.1; `panic = "abort"` in release |
| `cli/src/wallet_store.rs` | 848 | `SessionJson` (lines 122-148), path helpers (150-175), chain cache ops (344-387), session ops (389-419) |
| `cli/src/wallet_api.rs` | 2874 | `is_invalid_token_error` (644-667), `force_refresh_access_token` (679-700), `WalletApiClient::build` (720-750), `auth_refresh` (1429-1441), account list endpoints (1486-1520) |
| `cli/src/keyring_store.rs` | 404 | `read_blob` / `get_opt` / `store` signatures only |
| `cli/src/commands/agentic_wallet/chain.rs` | 175 | full — chain-cache TTL + fetch endpoint that populates `chain_cache.json` |
| `cli/src/commands/agentic_wallet/common.rs` | 209 | `WalletPreviewConfirming` (lines 1-18) |
| `cli/src/commands/agentic_wallet/auth/mod.rs` | — | `ensure_tokens_refreshed` head (132-175) |
| `cli/src/commands/agentic_wallet/balance/mod.rs` | — | `refresh_wallet_accounts_strict` (136-191) |
| `cli/src/commands/agent_commerce/task/common/autotrade/mod.rs` | 196 | `CliBespokeExit` (183-196) |
| `cli/src/commands/agent_commerce/task/common/deposit_qr.rs` | 427 | `InsufficientBalanceError` (52-101) |
| `cli/src/commands/agent_commerce/mod.rs`, `task/asp/mod.rs`, `task/common/mod.rs` | — | variant order of `DisputeCommand` / `CommonCommand` (audit label), dispatch line |
| `cli/src/commands/payment/payment_flow.rs` | 3982 | `PaymentTier` (27-54), `sign_payment_auto` (1090-1106), `build_payment_header` / `assemble_v2_payment_header` (1152-1238), `parse_eip155_chain_id` (1270-1283), `sign_payment_with_preference` head (552-640) |
| `cli/src/commands/upgrade.rs` | 82 | `execute` / `preflight` (31-46) |
| `cli/src/mcp/mod.rs` | 2980 | `serve` signature only (2975) |
| crate sources (cargo registry): `qrcode-0.14.1` (`render/unicode.rs`, `render/mod.rs`, `lib.rs`, `bits.rs::encode_auto`), `machine-uid-0.3.0/src/lib.rs`, `whoami-1.6.1` (`api.rs`, `os/windows.rs`, `os/unix.rs`), `serde_json-1.0.149/src/ser.rs` (float writer = `zmij`) | — | exact byte behaviour |
| `spec/cli-tree.json` | — | global/top-level options cross-check (22 top-level commands; root options `--chain`, `-h/--help`, `-V/--version`; `--dev` absent because hidden) |

Empirical checks (scratch Rust programs built offline against the exact locked crate versions, not part of upstream):
serde_json 1.0.149 float/key/escape output, clap 4.6.0 global `--chain` propagation and exit codes,
`url` 2.5.8 query encoding, chrono `{:+.1}` offset formatting, `Discriminant` Debug text. Results are quoted below.

---

## Shared helpers (used across groups or from core)

### 1. Process entry — `fn main::run` (main.rs:176)

`fn main` (main.rs:163) spawns a thread with an 8 MiB stack running `run` under `#[tokio::main]`
(multi-thread runtime) and joins it (`expect("main thread panicked")`; release profile is
`panic = "abort"`, so a panic aborts the process).

Exact order inside `run`:

1. `home::self_heal_permissions()` (home.rs:121). On `Err(e)` → stderr `Warning: {e}` (only
   possible error: `cannot determine home directory`). Unix only; no-op on Windows.
2. `Cli::parse()` (clap 4.6.0 derive). Clap failures never reach any other code:
   - `-h/--help` (any level) → help on **stdout**, exit **0**.
   - `-V/--version` (root only; subcommands have no version flag) → stdout `onchainos 4.6.3\n`, exit **0**.
   - unknown subcommand / bad flag / missing required arg / invalid UTF-8 argv → message on
     **stderr** (`error: …\n\nUsage: …\n\nFor more information, try '--help'.`), exit **2**, stdout empty.
   - group invoked without a subcommand (e.g. `onchainos market`) → that group's help on
     **stderr**, exit **2** (derive sets `arg_required_else_help`).
3. `endpoints::set_dev_mode(cli.dev)` (hidden global `--dev`).
4. If the command is `agent …` → `cli.chain = Some("xlayer")` unconditionally (whatever the user
   typed, or nothing). The raw argv used for the audit log is NOT changed.
5. If the command is `mcp` → `mcp::serve().await` (mcp/mod.rs:2975). `Err(e)` → `output::error(format!("{e:#}"))`
   + exit 1; `Ok` → return (exit 0). **No audit entry, no `Context`, no config load.**
6. `raw_args = std::env::args()` (full argv incl. argv[0] exactly as invoked);
   `redacted = audit::redact_args(&raw_args)`; `command_name = audit::cli_command_name(&cli.command)`;
   start a monotonic timer.
7. `ctx = commands::Context::new(&cli)` → `AppConfig::load().unwrap_or_default()` (config.json,
   including the cwd migration side effect, §11.2).
8. Dispatch (table in "Commands" below). Handlers print their own success output and return `Ok(())`.
9. `audit::log("cli", &command_name, result.is_ok(), elapsed, Some(redacted), err.map(|e| format!("{e:#}")))`
   — always, success or failure (§10).
10. Error mapping (below). Success → return → process exit 0.

#### 1.1 Error → output → exit code (ordered downcast chain, main.rs:248-315)

`anyhow::Error::downcast::<T>()` matches when `T` is the error itself **or** any `.context()` layer
wrapping it. Checked strictly in this order; first match wins:

| # | Error type (defined in) | stdout | exit |
|---|---|---|---|
| 1 | `commands::agentic_wallet::common::WalletPreviewConfirming {message,next,scene,preview}` (agentic_wallet/common.rs:5) | `output::agentic_wallet_confirming` | **2** |
| 2 | `output::CliConfirming {message,next,scene:Option}` (output.rs:281) | `output::confirming_scene` | **2** |
| 3 | `output::CliSetupRequired {error_code,message,data}` (output.rs:323) | `output::setup_required` | **3** |
| 4 | `…::autotrade::CliBespokeExit(i32)` (autotrade/mod.rs:188) | nothing (handler already printed `{"ok":…}`) | the wrapped `i32` |
| 5 | `output::CliFundingBlocked {data}` (output.rs:55) | `output::error_data(data)` | **1** |
| 6 | `output::CliDuplicateSubscription {data}` (output.rs:72) | `output::error_data(data)` | **1** |
| 7 | `commands::sink::CodedError {code,field,message,data,next_steps}` (sink.rs:29) | `output::error_coded_details` | **1** |
| 8 | `…::deposit_qr::InsufficientBalanceError` (deposit_qr.rs:57) | `output::error_insufficient_balance` | **1** |
| 9 | anything else | `output::error(format!("{e:#}"))` | **1** |

`format!("{e:#}")` = anyhow alternate Display: the outermost message followed by every source/context
layer joined with `": "` (e.g. `Network unavailable — check your connection and try again: error sending request for url (…): …`).

Display strings (these appear in the audit `error` field, and as the generic error if ever wrapped
under another type): `CliConfirming` → `confirming: {message}`; `WalletPreviewConfirming` →
`confirming: {message}`; `CliSetupRequired` → `setup-required: {message}`; `CliBespokeExit` →
`bespoke exit: {n}`; `CliFundingBlocked` → `insufficient balance`; `CliDuplicateSubscription` →
`duplicate subscription`; `CodedError` → `{message}`; `InsufficientBalanceError` → `{message}`;
`client::PaymentRequired` → `HTTP 402 Payment Required: {raw_body.error}` or `HTTP 402 Payment Required`.

Complete exit-code table: 0 success / help / version; 1 every error envelope and `mcp` failure;
2 confirming (both kinds) **and** clap usage errors (stderr only); 3 Gas-Station setup required;
N = `CliBespokeExit(N)` (autotrade-grant-check).

#### 1.2 Global flags (main.rs:41-52)

| Flag | Type | Visible | Behaviour |
|---|---|---|---|
| `--chain <CHAIN>` | `Option<String>`, `global = true` | yes (`Chain: ethereum, solana, base, bsc, polygon, arbitrum, sui, etc`) | Stored in `Context.chain_override`. Clap 4 global propagation (verified empirically): a leaf that declares its own `--chain` (same arg id `chain`) and the global share ONE value — typed at the root, the group or the leaf, both `cli.chain` and the leaf's local field receive it; typed twice, the last/deepest occurrence wins for both. Leaves without a local `--chain` accept and ignore it unless they call `Context::chain_index*`. Forced to `"xlayer"` for every `agent …` command. |
| `--dev` | `bool`, `global = true`, **`hide = true`** | no | `endpoints::set_dev_mode(true)`: base URL → `https://beta.okex.org`, `base_url_is_custom()` → true (DoH disabled). |
| `-h/--help` | clap | yes | help to stdout, exit 0 |
| `-V/--version` | clap, root only | yes | `onchainos 4.6.3` |

### 2. Output envelopes — `output.rs`

All output goes to **stdout** via `println!` (one line + `"\n"`, LF even on Windows). stderr is used
only for warnings/diagnostics. Serialisation: `fn output::to_agent_json` (output.rs:11) — compact
`serde_json::to_string`, or `to_string_pretty` (2-space indent, `": "`) iff env `ONCHAINOS_PRETTY`
equals exactly `"1"`.

| Function (line) | Exact shape (field order as emitted) |
|---|---|
| `success_empty()` (33) | `{"ok":true}` (+ `"notifications":[…]` when non-empty) |
| `success(data)` (44) | `{"ok":true,"data":<data>}` (+ `,"notifications":[…]`). `data` is always present even when it is JSON `null` (`{"ok":true,"data":null}`). |
| `error(msg)` (114) | `{"ok":false,"error":"<msg>"}` (+ `,"notifications":[…]`) |
| `error_data(data)` (84) | `{"ok":false,"data":<data>}` (+ notifications) |
| `error_coded(code, field, msg)` (133) → `error_coded_details` (138) | built with `json!` ⇒ **sorted keys**: `{"data"?:…,"error":"<msg>","errorCode":"<code>","errorField"?:"<field>","nextSteps"?:…,"notifications"?:[…],"ok":false}` |
| `setup_required(code,msg,data)` (309) | sorted: `{"data":<data>,"errorCode":"<code>","message":"<msg>","ok":false}` — does NOT drain notifications |
| `error_insufficient_balance(ib)` (193) | `deposit_address == None` → exactly `error(ib.message)`. Else sorted: `{"currency":…,"depositAddress":…,"depositChain":"XLayer","error":<message>,"notifications"?:[…],"ok":false,"shortfall":"<f64 Display>"}` |
| `confirming(msg,next)` (244) / `confirming_scene(msg,next,scene)` (250) | struct order: `{"confirming":true,"scene"?:…,"message"?:…,"next"?:…,"notifications"?:[…]}` — `message`/`next` omitted when empty string, `scene` when `None` |
| `agentic_wallet_confirming(msg,next,scene,preview)` (262) | `{"confirming":true,"scene":…,"message"?:…,"preview":<Value>,"next"?:…,"notifications"?:[…]}` |
| `bespoke_ok()` (103) | `{"ok":true}` — no notifications drain |
| `bespoke_deny(reason)` (109) | `{"ok":false,"reason":"<reason>"}` — no notifications drain |

`notifications` = `payment_notify::drain_events()` (global buffer, §7); every envelope except
`setup_required` / `bespoke_*` drains it; absent when empty.

#### 2.1 JSON byte rules (critical for stdout and request-body parity)

- **Structs** serialise in declaration order (envelopes above, `Aggregated`, `QrOutput`, etc.).
- **Every `serde_json::Value` object** (anything built with `json!`, parsed from a server response,
  or produced by `serde_json::to_value(struct)`) is a `BTreeMap` ⇒ keys are emitted **sorted by
  byte-wise string order**, recursively. Server passthrough data therefore does NOT keep the
  server's key order. Example (verified): input `{"zeta":1,"alpha":2.0,"Beta":3}` → `{"Beta":3,"alpha":2.0,"zeta":1}`.
- POST bodies (`serde_json::to_string(&Value)`) are therefore also compact with sorted keys.
- Numbers parsed from JSON: a literal without `.`/`e`/`E` that fits `u64` (non-negative) or `i64`
  (negative) stays an exact integer (e.g. `18446744073709551615`, `-9223372036854775808` round-trip
  exactly — a Node port must not route these through IEEE doubles). Anything else becomes `f64` and
  is re-emitted by `zmij` (shortest round-trip digits) with these rules (verified):
  `2.0→"2.0"`, `100.0→"100.0"`, `1E5→"100000.0"`, `12.0e0→"12.0"`, `-0.0→"-0.0"`,
  `0.00001→"0.00001"`, `0.000012345→"0.000012345"`, `1e-6→"1e-6"`, `-1.5e-7→"-1.5e-7"`,
  `9999999999999998.0→"9999999999999998.0"`, `1e15→"1000000000000000.0"`, `1e16→"1e+16"`,
  `99999999999999999999→"1e+20"`, `-9223372036854775809→"-9.223372036854776e+18"`,
  `1.7976931348623157e308→"1.7976931348623157e+308"`, `5e-324→"5e-324"`.
  Rule: fixed notation (always ≥1 fractional digit, `.0` for integral values) when
  `1e-5 ≤ |x| < 1e16`; otherwise `<mantissa>e<sign><exp>` with an explicit `+` for positive exponents.
  (JS `JSON.stringify` differs: `2`, `1e21` threshold, `1e+21`, no `.0`.)
- String escaping: `"`→`\"`, `\`→`\\`, `\b \t \n \f \r` short forms, other `U+0000–U+001F` as
  `\u00xx` (lowercase hex); `U+007F`, `/`, `<>&`, `U+2028`, all non-ASCII are emitted raw (UTF-8).
  Same as JS `JSON.stringify` for valid strings.
- Pretty mode: serde_json `PrettyFormatter` — 2 spaces, `"key": value`, empty `[]`/`{}` inline
  (matches `JSON.stringify(v, null, 2)` layout).
- Rust `f64` `Display` (`format!("{}")`, used by `InsufficientBalanceError` and several handlers)
  never uses exponents: `50.0→"50"`, `0.1+0.2→"0.30000000000000004"`, `1e21→"1000000000000000000000"`, `1e-7→"0.0000001"`.

### 3. `commands::Context` (commands/mod.rs:31)

`Context { config: AppConfig, chain_override: Option<String> }`.

- `Context::new(cli)` (37): `AppConfig::load().unwrap_or_default()`; `chain_override = cli.chain`.
- `client()` (47) → `ApiClient::new()` (sync auth: JWT if keyring `access_token` non-empty, no expiry check).
- `client_async()` (53) → `ApiClient::new_async()` (full JWT lifecycle, §4.3).
- `chain_index()` (58): `chain_override` else `config.default_chain` if non-empty else `None`;
  the chosen string goes through `chains::resolve_chain` (§12).
- `chain_index_or(default)` (70): `chain_index()` or `resolve_chain(default)`.
- `resolve_chains_or(explicit, default)` (78): `explicit` returned **verbatim (not resolved)** when
  `Some`; else `resolve_chain(chain_override)` (single-name resolver, NOT `resolve_chains`) when an
  override exists; else `default` verbatim. Ignores `config.default_chain`. Oracle: override
  `solana`, `(None,"1,501")` → `"501"`; `(Some("ethereum"),…)` → `"ethereum"`; no override → `"1,501"`.

### 4. HTTP client — `client::ApiClient` (client.rs:133)

#### 4.1 Construction — `ApiClient::build` (222), `new` (207), `new_async` (246)

1. `DohManager::new("web3.okx.com", endpoints::base_url(), endpoints::base_url_is_custom())` then
   `doh.prepare()?` (may fail: `OKX_DOH_BINARY_PATH must resolve to a path under <home>`).
2. reqwest client: **total timeout 10 s**; if DoH proxy mode with a resolved IP → pin
   `node.host → ip:443`; `User-Agent: OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)` where
   `<os>` ∈ `windows|macos|linux`, `<arch>` ∈ `x86_64|aarch64` (Rust `std::env::consts`). No gzip.
3. Fresh in-memory `PaymentState` (shared by clones via `Arc<Mutex>`); DoH state is per clone.

`base_url` stored = logical origin (compiled or dev). `effective_base_url()` (407) = `https://{doh_node.host}`
in DoH proxy mode, else `base_url`.

#### 4.2 Headers — `anonymous_headers()` (346), `jwt_headers(token)` (377)

Every request built by `ApiClient` (and by `WalletApiClient` / agent-commerce `task_api_client`,
which reuse these two functions):

| Header | Value |
|---|---|
| `Content-Type` | `application/json` (also on GET; removed for multipart) |
| `ok-client-version` | `4.6.3` |
| `Ok-Access-Client-type` | `agent-cli` |
| `platform` | `agent-cli` |
| `device-id` | device id (§9.1); omitted only if unavailable |
| `device-name` | device name raw UTF-8 bytes, not percent-encoded (§9.2); always present |
| `Authorization` | `Bearer <access_token>` — JWT mode only |

reqwest adds `user-agent` (above), `accept: */*`, `host`, `content-length` (bodies). Per-call
`extra_headers` are applied after the base map and **replace** same-named headers (invalid
names/values silently skipped). The x402 payment header is appended last as `PAYMENT-SIGNATURE: <base64>`.
Never sent: `ok-access-key`, `ok-access-sign`, `ok-access-passphrase`, `ok-access-timestamp`, `ok-access-token`.

#### 4.3 Auth resolution

- `resolve_auth()` (256, sync): keyring `access_token` (via `keyring_store::get_opt`, owned by the
  auth group) non-empty → `Jwt(token)`, else `Anonymous`. No expiry check.
- `resolve_auth_async()` (268):
  1. no/empty `access_token` → `Anonymous`.
  2. `!is_jwt_expired(access_token)` → `Jwt`.
  3. no/empty `refresh_token` → `Anonymous` (silent).
  4. `is_jwt_expired(refresh_token)` → stderr `Session expired. Please log in again: onchainos wallet login` → `Anonymous`.
  5. `wallet_api::force_refresh_access_token()` (wallet_api.rs:679: reads keyring blob `refresh_token`,
     `POST /priapi/v5/wallet/agentic/auth/refresh` body `{"refreshToken":…}` via `WalletApiClient`,
     stores rotated `access_token`/`refresh_token`) → `Jwt(new)`; on error stderr
     `Failed to refresh session ({e}). Falling back to anonymous access.` → `Anonymous`.
- `jwt_exp_timestamp` (314): split on `.`, must be exactly 3 parts, base64url-no-pad decode part 2,
  JSON, `exp` as i64. `is_jwt_expired` (327): `now_unix_secs >= exp`; **unparseable ⇒ expired**.

#### 4.4 URL building — `build_get_url_and_request_path` (413)

1. Drop every query pair whose value is the empty string.
2. `url = effective_base.trim_end_matches('/') + path`.
3. Append remaining pairs **in the given order** with `application/x-www-form-urlencoded`
   serialisation (`url` crate): unreserved = `A-Z a-z 0-9 * - . _`; space → `+`; everything else
   `%XX` uppercase (verified: `1,501`→`1%2C501`, `dog wif`→`dog+wif`, `~`→`%7E`, `狗`→`%E7%8B%97`,
   `x:y/z?&=+*-._~!'()`→`x%3Ay%2Fz%3F%26%3D%2B*-._%7E%21%27%28%29`). Same as WHATWG `URLSearchParams`.
4. No `?` when no pairs survive. Oracle: `/api/v6/dex/market/memepump/tokenList?chainIndex=501&keywordsInclude=dog+wif&keywordsExclude=%E7%8B%97`.

POST URL = `effective_base.trim_end_matches('/') + path`; body = compact `serde_json::to_string(body)`.

#### 4.5 Request method matrix

| Method (line) | DoH failover loop | x402 pre-sign + 402 retry | invalid-token refresh+retry | Returns | Timeout | Origin |
|---|---|---|---|---|---|---|
| `get(path, query)` (442) = `get_with_headers(…, None)` (453) | yes | yes | yes | unwrapped `data` | 10 s | effective |
| `post(path, body)` (590) = `post_with_headers` (597) | yes | yes | yes | unwrapped `data` | 10 s | effective |
| `get_with_headers_raw` (655) | yes | yes | **no** | full body (no envelope check) | 10 s | effective |
| `post_with_headers_raw` (690) | yes | yes | **no** | full body | 10 s | effective |
| `post_no_retry_with_headers` (725) (broadcast) | **no** (records failure only) | **no** | **no** | unwrapped `data` | 10 s | effective |
| `post_multipart` (761) | no | no (but `handle_response` still processes pay headers) | no | unwrapped `data` | 60 s | **`base_url` (never proxy)** |
| `post_multipart_raw` (802) | no | no | no | raw `reqwest::Response` | 60 s | `base_url` |
| `get_with_headers_response` (510) | no | no | no | raw `reqwest::Response` | 10 s | effective |
| `get_bytes` (529) | no | no | no | bytes | 60 s | effective |

`post_no_retry_with_headers` on a connect/timeout error: `doh.handle_failure()` (result ignored),
rebuild client if now proxy, return error with context
`Network error during broadcast — transaction was NOT sent. Safe to retry the same command.`; other
send errors → context `request failed`.

`get_bytes`: status ≥ 400 → `download failed (HTTP {n})`; response `Content-Type` containing
`application/json` → parse (`failed to parse error response`), `code` not `"0"`/`0` →
`download failed (code={code}): {msg}` (msg = `msg` string or `unknown error`, untrimmed), code 0 → empty bytes;
otherwise raw bytes (`failed to read response bytes`).

`post_multipart*`: headers = jwt/anonymous map **minus `Content-Type`** (reqwest sets the multipart
boundary) plus extra headers.

#### 4.6 Send loop — `do_get_request` (1065), `do_post_request` (1109), `_raw` variants (1152, 1191)

```
loop {
  build request (URL §4.4, auth headers §4.2, extra headers, optional PAYMENT-SIGNATURE)
  send:
    connect error or timeout → if doh.handle_failure() { rebuild http client; continue }
                               else Err(e).context("Network unavailable — check your connection and try again")
    any other send error     → Err(e).context("request failed")
  if doh.should_failover_on_response(resp) && doh.handle_failure() { rebuild; continue }
  doh.cache_direct_if_needed()
  return handle_response(path, resp)      // or handle_response_raw
}
```
No retry on HTTP status codes (429/5xx are errors, §4.7). Loop termination is bounded only by DoH
(§8); with a custom base URL / `--dev` DoH is disabled and there is exactly one attempt.

#### 4.7 Response handling — `handle_response` (859) / `handle_response_raw` (977)

Exact order:
1. Clear `pending_over_quota_tiers`.
2. `update_payment_state_from_headers(headers)` (§6.2).
3. `header_accepts` = header `payment-required` → standard base64 (padded) decode → JSON → `.accepts` (any failure → none).
4. If `path != "/api/v6/dex/market/config"`: if `endpoints` map is empty and any tier is charging →
   `ensure_payment_config()` (may issue the config GET, §6.3); then `dispatch_notifications(path, header_accepts)` (§6.5).
5. HTTP 429 → error `Rate limited — retry with backoff`.
6. HTTP ≥ 500 → error `Server error (HTTP {n})` (body discarded).
7. Read body (`failed to read response body`).
8. Empty body: 402 → `PaymentRequired{accepts: header_accepts or null, raw_body: null}`; else
   `Empty response body (HTTP {n}). The requested operation may not be supported for the given parameters.`
9. Non-JSON body → `HTTP {n} {canonical reason or "Error"}: {body text trimmed}` (e.g. `HTTP 404 Not Found: <html>…`).
10. 402 → `PaymentRequired{accepts: header_accepts ?? body.accepts ?? null, raw_body: body}` (before envelope check, so an array-shaped 402 is not mistaken for success).
11. `handle_response` → `unwrap_envelope(body)`; `handle_response_raw` → `Ok(body)`.

#### 4.8 Envelope unwrap — `unwrap_envelope` (175), `extract_msg` (145), `augment_auth_error_msg` (153, pub)

- Body is a JSON array → returned as-is (bare-array endpoints).
- `code` is string `"0"` or number `0` → return `body["data"]` (`null` when absent).
- Otherwise error `API error (code={code}): {msg}`:
  - `{code}`: string verbatim; number via serde Display (`50114`, a float code would print `1.0`);
    missing → `null`; any other type → its compact JSON.
  - `{msg}`: `msg` string trimmed; missing / non-string / blank → `unknown error`.
  - code `"50114"` → msg becomes `{msg}. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.`
- Applies to any HTTP status that reached step 11 (2xx, 3xx, 4xx except 402/429). A 4xx JSON without `code` ⇒ `API error (code=null): …`.
- Rendered at top level as `{"ok":false,"error":"API error (code=51000): Parameter chainIndex error"}` (exit 1).

#### 4.9 Invalid-token refresh-and-retry (in `get_with_headers` 453 / `post_with_headers` 597 only)

On any error from the first attempt, **before** the 402 check: if auth mode is `Jwt` and
`wallet_api::is_invalid_token_error(e)` (wallet_api.rs:644: error string contains
`code=10001)`, `code=10008)`, `code=53017)` or `code=130100031)`, or (case-insensitive)
`invalid access token` / `access token invalid`, or a `WalletApiClient` `ApiCodeError` with one of
those codes) → `force_refresh_access_token().await?` (failure propagates as
`force-refresh failed: {e}` / `refresh_token missing — please run: onchainos wallet login`) →
replace auth with the new JWT → re-send once with the **same** payment header and return that
result directly (no 402 handling on the retry). Anonymous requests never do this.

#### 4.10 `handle_agent_commerce_response(resp)` (1696, `pub(crate)`) — used by agent-commerce callers of the `*_response`/`*_raw` methods

1. `is_gateway` = response `Server` header (lowercased) contains `openresty` or `nginx`.
2. Read body; parse JSON leniently (`None` if empty/invalid).
3. HTTP 2xx and `code` `"0"`/`0` → `Ok(body.data)`.
4. `is_gateway` → `Gateway error (HTTP {status}): {reason}` with reason 413 `payload too large`,
   429 `rate limited`, 502 `bad gateway (backend unreachable)`, 503 `service unavailable`,
   504 `gateway timeout`, else `gateway rejected request`.
5. Parsed JSON → `API error (HTTP {status}, backend_code={code}): {msg} — {detailMsg}` (the ` — {detailMsg}`
   part only when `detailMsg` is a non-empty string); code string/number or `null`; msg default `unknown error`.
6. Non-JSON: 429 → `Rate limited — retry with backoff (HTTP 429)`; ≥500 → `Server error (HTTP {n})`;
   empty → `Empty response body (HTTP {n})`; else `HTTP {n}: {first 500 chars of trimmed body}`.

### 5. Endpoint constants — `endpoints.rs` + `build.rs`

| Constant | Value |
|---|---|
| `BASE_URL` (endpoints.rs:11) | compile-time: `OKX_BASE_URL` from `cli/.env` if non-empty, else `https://web3.okx.com` (build.rs:4). Harness build: `http://127.0.0.1:18899`. No runtime env override. |
| `ONCHAINOS_COMPILED_BASE_URL_CUSTOM` | `"1"` iff `OKX_BASE_URL` was configured |
| `DEV_BASE_URL` (14) | `https://beta.okex.org` |
| `base_url()` (24) | dev ? DEV : BASE |
| `base_url_is_custom()` (33) | dev \|\| custom — true ⇒ DoH fully disabled |
| `API_HOST` (38) | `web3.okx.com` (DoH domain / cache key) |
| `AGENT_IDENTITY_WS_URL` (41) | `OKX_AGENTIC_WS_URL` else `wss://wsdex.okx.com:8443/ws/v5/private` |
| `WS_URL` (44) | `ONCHAINOS_WS_URL` else `wss://wsdex.okx.com/ws/v6/dex` |
| `XLAYER_RPC_URL` (47) | `https://rpc.xlayer.tech` |
| `client::CLIENT_VERSION` | `4.6.3` |

`build.rs` dotenv parser: trims lines, skips blank/`#`, splits on first `=`, trims key/value, strips surrounding `"`/`'`.

### 6. x402 auto-pay inside `ApiClient` (client.rs:1241-1686)

#### 6.1 State

`PaymentState`: `endpoints: HashMap<path, PaymentTier>`, `accepts: Option<Value>`, `basic_state`,
`premium_state` (`TierState`: `Free` → `ChargingUnconfirmed` → `ChargingConfirmed`),
`config_loaded`, `user_type: Option<UserType>`, `intro_shown`, `grace_shown`,
`pending_over_quota_tiers` (transient), `default_asset`, `local_signing_warned`.
`PaymentTier` (payment_flow.rs:29): serde lowercase `basic`/`premium`; `from_server_str` case-insensitive
`basic`/`premium` else `None`.

#### 6.2 Payment-state header — `update_payment_state_from_headers` (1381)

Header `ok-web3-openapi-pay` (e.g. `Basic=1;Premium=0;UserType=1`). Parse: split `;`, each part
trimmed, split on first `=`, key/value trimmed, key matched case-insensitively, first match wins.
`Basic`/`Premium`: `"1"`→charging, `"0"`→free, anything else ignored. `UserType`: trimmed `"1"`→`new`,
`"0"`→`old`, else ignored. Transition (`TierState::apply_header_flag`, payment_notify.rs:135):
`false` → `Free`; `true` from `Free` → `ChargingUnconfirmed`; `true` from charging → unchanged.
If any of basic/premium/user_type changed → `try_flush_payment_cache()` (§6.6). Header absent → nothing.

#### 6.3 Config — `ensure_payment_config` (1257), `restore_from_cache` (1323), `apply_config_response` (1352)

Called at the start of every `get/post_with_headers(_raw)` and inline from `handle_response` step 4.
1. `config_loaded` → return.
2. `PaymentCache::load()` (payment_cache.json). If present → `restore_from_cache`: always copy
   `basic_state`, `premium_state`, `user_type`, `intro_shown`, `grace_shown`, `default_asset`,
   `local_signing_warned`; if `now − updated_at > 3600` → not fresh; if `endpoints` empty or `accepts`
   is None/null/empty array → not fresh; else copy `endpoints` (dropping unknown tier strings) and
   `accepts`, set `config_loaded = true`, return (no fetch).
3. If no tier is charging → return (no fetch; `config_loaded` stays false).
4. `config_loaded = true`; `do_get_request("/api/v6/dex/market/config", [], None, None)` (normal
   auth headers, DoH loop, envelope unwrap; its own response skips notification dispatch).
   Ok → `apply_config_response(data)`: clear `endpoints`; for every `(path, tier)` in object
   `data.endpointList` with tier string `BASIC`/`PREMIUM` (case-insensitive) insert; replace `accepts`
   with `data.accepts` if present and non-null; then flush cache. Err → `config_loaded = false`,
   error swallowed (stderr only under `debug-log` feature).

#### 6.4 Signing and the 402 retry (inside `get_with_headers` / `post_with_headers` / `_raw`)

1. `resource = base_url.trim_end_matches('/') + path` (logical origin even under DoH proxy).
2. Pre-sign `maybe_sign_payment` (1473): only if `endpoints[path]` exists **and** that tier is
   `ChargingConfirmed` **and** `accepts` cached → `sign_header_from_accepts(accepts, resource, tier)`;
   any signing error ⇒ no header (request goes out naked).
3. `sign_header_from_accepts` (1505) = `payment_flow::sign_payment_auto(accepts, Some(tier))`
   (payment group: TEE signing through the Agentic Wallet when `wallets.json` exists, else local
   `EVM_PRIVATE_KEY` signing with a one-time stderr disclaimer) → `payment_flow::build_payment_header`
   → `("PAYMENT-SIGNATURE", base64(JSON{"accepted":<entry>,"payload":<proof>,"resource":{"mimeType":"application/json","url":<resource>},"x402Version":2}))` (keys sorted).
4. First attempt fails with `PaymentRequired` (after the invalid-token check, §4.9):
   a. `consume_pending_confirmation(path)` (1675): if the path's tier is known → remove it from
      `pending_over_quota_tiers` and block iff it was there; if unknown and the pending set is
      non-empty → clear it and block. Block ⇒ return `CliConfirming{message:"",next:"",scene:None}`
      ⇒ stdout `{"confirming":true,"notifications":[<OVER_QUOTA event>…]}`, **exit 2**. Nothing is paid.
   b. Else `accepts = pr.accepts` if non-null, else cached config accepts, else error
      `HTTP 402 but no payment requirements available — response had no accepts and no cached config. Retry after /api/v6/dex/market/config becomes reachable.`
      (402 accepts are never cached).
   c. `tier = endpoints[path]` or `Basic`; sign (errors propagate) and re-send once with the header;
      that result is final (a second 402 surfaces as `HTTP 402 Payment Required[: {error}]`).
   The retried request **authorises a payment** (FUND-MOVING: x402 settlement against the paid endpoint).
5. A tier reaches `ChargingConfirmed` only through `payment default set` (payment group) writing the
   cache; the client itself never advances `Unconfirmed → Confirmed`.

#### 6.5 Notification dispatch — `dispatch_notifications(_at)` (1597, 1605)

If `user_type` is unset → nothing. Else build `NotifyInput{user_type, grace_expires_at=2026-05-30T00:00:00Z,
now, basic_state, premium_state, intro_shown, grace_shown, accepts = header_accepts ?? cached accepts,
path_tier = endpoints[path], preferred_asset = default_asset.(asset, network)}` → `payment_notify::compute_events`
(§7). For each event: push to the global buffer; `Grace` → `grace_shown = true`; `Intro` →
`intro_shown = true`; `BasicOver`/`PremiumOver` → add tier to `pending_over_quota_tiers`. If any
event fired → flush cache. OVER_QUOTA events are NOT deduplicated: they re-fire on every response
while a tier is `ChargingUnconfirmed` and the path matches (a path absent from `endpoints` matches
every unconfirmed tier, so even successful free calls get the notification attached).

#### 6.6 Cache flush — `flush_payment_cache` (1563)

Re-read `payment_cache.json` for `default_asset`/`local_signing_warned` (sibling-process writes win,
mirrored back into memory), then write the full `PaymentCache` with `updated_at = now` (§6.7).
Errors swallowed.

#### 6.7 `payment_cache.json` — `payment_cache::PaymentCache` (payment_cache.rs:44)

Path `$ONCHAINOS_HOME/payment_cache.json`. `save` (97): `ensure_onchainos_home`, write compact JSON to
`payment_cache.json.tmp`, rename. `load` (86): missing/unparseable → `None`. `is_expired(ttl)`: `now − updated_at > ttl`.
`delete` (115): remove file (logout). Struct order:
```json
{"endpoints":{"/api/v6/dex/market/price":"basic"},"accepts":[…sorted-key objects…],
 "basic_state":"free|charging_unconfirmed|charging_confirmed","premium_state":"free",
 "updated_at":1759046400,"user_type":"new|old|null","intro_shown":false,"grace_shown":false,
 "default_asset":{"asset":"0x…","network":"eip155:196","name":"USDG"} | null,
 "local_signing_warned":false}
```
(`endpoints` is a HashMap — key order arbitrary; `name` omitted when None; every field `#[serde(default)]`.)
`payment_cache::now_secs()` (124) = unix seconds.

### 7. Payment notifications — `payment_notify.rs`

Global buffer `PENDING` (61); `push_event` (66) stores `serde_json::to_value(event)` (⇒ sorted keys);
`drain_events` (74) takes all. Constants: `BASIC_FREE_QUOTA = 1000000`, `PREMIUM_FREE_QUOTA = 100000`,
`DOC_URL = "https://web3.okx.com/onchainos/dev-docs/market/market-api-fee"`,
`new_user_intro_start_at() = 2026-04-30T00:00:00Z`, `grace_expires_at() = 2026-05-30T00:00:00Z`,
`grace_days() = 30`, `DISPLAY_DECIMALS = 6`.

`compute_events(input)` (276) — returns `(Event, Flag)` in this order:
1. `user_type` None → `[]`.
2. `in_grace = Old && basic==Free && premium==Free && now < grace_expires_at`. If `in_grace`:
   `[OldUserGrace]` unless `grace_shown`; return.
3. If `!intro_shown`: New with `now < 2026-04-30T00:00:00Z` → nothing; New → `NewUserIntro`; Old → `OldUserPostGraceIntro`.
4. If `basic_state == ChargingUnconfirmed` and (`path_tier` None or Basic) → OVER_QUOTA(basic).
5. If `premium_state == ChargingUnconfirmed` and (`path_tier` None or Premium) → OVER_QUOTA(premium).
OVER_QUOTA variant = `NewUserOverQuota` for New, `OldUserPostGraceOverQuota` for Old.

Event JSON (adjacently tagged, sorted keys):
```json
{"code":"MARKET_API_NEW_USER_INTRO","data":{"basicFreeQuota":1000000,"docUrl":"https://web3.okx.com/onchainos/dev-docs/market/market-api-fee","premiumFreeQuota":100000}}
{"code":"MARKET_API_OLD_USER_GRACE","data":{"basicFreeQuota":1000000,"docUrl":"…","graceDays":30,"graceExpiresAt":"2026-05-30T00:00:00+00:00","premiumFreeQuota":100000}}
{"code":"MARKET_API_OLD_USER_POST_GRACE_INTRO","data":{"basicFreeQuota":1000000,"docUrl":"…","graceDays":30,"premiumFreeQuota":100000}}
{"code":"MARKET_API_NEW_USER_OVER_QUOTA","data":{"payment":[…],"tier":"basic"}}
{"code":"MARKET_API_OLD_USER_POST_GRACE_OVER_QUOTA","data":{"payment":[…],"tier":"premium"}}
```
`payment` omitted when empty. Each entry (`transform_payment_entry`, 393), from each `accepts[]` object:
`amount` = string `amount`, or `amount[<tier key>]` string when `amount` is an object (entry dropped
if missing/not string or not all digits) rendered by `amount_minimal_to_display` (445): 6 implied
decimals, trailing zeros trimmed (`"100"→"0.0001"`, `"500"→"0.0005"`, `"1500000"→"1.5"`, `"1000000"→"1"`,
`"0"→"0"`, `"123456789"→"123.456789"`); `name` = `extra.name` or `""`; `symbol` = `extra.symbol` or `""`;
`network` = showName of the chain whose `realChainIndex` equals the CAIP-2 id (read from
`chain_cache.json`, no TTL/no network), else raw network string, `""` when absent; `chainId` =
u64 from `eip155:<id>` or `null`; `asset`/`payTo` passthrough (null if absent); `isDefault` =
`asset` and `network` equal the saved default. Emitted sorted:
`{"amount","asset","chainId","isDefault","name","network","payTo","symbol"}`.

### 8. DoH failover — `doh/`

Active only when `base_url_is_custom()` is false (production compiled URL, no `--dev`).
Domain key `web3.okx.com`.

- `DohManager::prepare` (manager.rs:61): skip if custom or already resolved. `binary::binary_path()?`
  (validates `OKX_DOH_BINARY_PATH`). Read `doh-cache.json` entry; set mode/node; resolve `node.ip`
  (literal IP, else blocking DNS `ip:443`; failure → stderr
  `[doh] proxy node {ip} unavailable, falling back to direct connection`, no pinned IP).
- `proxy_base_url` (189): mode Proxy + node → `https://{node.host}`. `resolve_override` (198): also needs the resolved IP.
- `should_failover_on_response` (228): proxy mode and response `Content-Type` does not contain `application/json`.
- `cache_direct_if_needed` (209): not custom and mode is None → write entry
  `{"mode":"direct","node":null,"failed_nodes":[],"updated_at":<ms>}` (happens after **every**
  successful send while in-memory mode stays None, i.e. on a cold cache).
- `handle_failure` (84): return false if custom or `retried`. Exclude list = cached `failed_nodes` IPs
  (+ current node IP, which is persisted as `{ip, failed_at: now_ms}`). If the binary is missing →
  `download_binary()`; failure → `retried = true`, return false. Run
  `<bin> --domain web3.okx.com [--exclude ip1,ip2] --user-agent "<UA>"` (30 s timeout); expects stdout
  `{"code":0,"data":{"ip","host","ttl"}}` (non-zero exit / bad JSON / code≠0 / empty ip ⇒ None).
  - node ip or host equals the domain → cache Direct (keep failed nodes), mode Direct, `retried=false`, return true.
  - proxy node → cache Proxy; resolve IP; resolution failure → `retried=true`, mode/node None, return true; else mode Proxy, `retried=false`, return true.
  - None (pool exhausted) → `retried=true`, clear mode/node/IP, return true (one last direct try; cache not written).
- `doh_user_agent` (263): `OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`.
- `doh-cache.json` (cache.rs): `$ONCHAINOS_HOME/doh-cache.json`, pretty JSON map
  `domain → {"mode":"proxy"|"direct","node":{"ip","host","ttl"}|null,"failed_nodes":[{"ip","failed_at"}],"updated_at":<ms>}`;
  written read-merge-write via `doh-cache.tmp` + rename (errors ignored); failed nodes older than
  3 600 000 ms dropped on read.
- Binary (binary.rs): path `$ONCHAINOS_HOME/bin/okx-pilot` (`okx-pilot.exe` on Windows), or
  `OKX_DOH_BINARY_PATH` which must lexically (after `.`/`..` normalisation) start with `onchainos_home()`
  else `OKX_DOH_BINARY_PATH must resolve to a path under {home}`. Download (`download_binary`, 116):
  platform `darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64` (else `unsupported platform for doh binary`);
  for each CDN base in order `https://static.okx.com/upgradeapp/tools/pilot`,
  `https://static.coinall.ltd/upgradeapp/tools/pilot`,
  `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`,
  `https://static.jingyunyilian.com/upgradeapp/tools/pilot`: stderr `[doh] fetching checksum {base}/{platform}/checksum.json ...`,
  GET it (`{"sha256":…}`), stderr `[doh] downloading {base}/{platform}/{file} ...`, GET binary,
  compare lowercase sha256, write `<dest>.tmp` (extension replaced), chmod 0755 (unix), rename.
  30 s timeout, no custom UA. All fail → `all CDN sources failed, last error: {…}`.
- Quirk: if the binary keeps answering "direct" while the network is down, `handle_failure` keeps
  returning true with `retried=false` — the send loop has no iteration cap.

### 9. Device headers — `device/`

#### 9.1 `device::id::get_cached_device_id()` (id.rs:56) → `Option<&'static str>`

Memoised once per process (`OnceLock`). Pipeline `ensure_device_id` (66):
1. `wallet_store::load_session()` → `session.json` field `deviceId`; if non-empty and valid (byte length
   64 or 36, all ASCII alphanumeric or `-`) → use it.
2. Else `generate_device_id` (122): `machine_uid::get()` → `hex_lower(sha256(utf8(machine_id) ‖ b"onchainos"))`
   (64 chars; oracle: `test-machine-id` → `d0f3de61e3704af433758f3ea65c56723b37354844eceaffdd6a229dd76f2289`);
   on error → random UUIDv4 (36 chars, lowercase, hyphenated).
   machine_id sources (machine-uid 0.3.0): Windows registry `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
   (trimmed); Linux `/var/lib/dbus/machine-id` else `/etc/machine-id` (trimmed); macOS
   `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` value (quotes/space trimmed); BSD `/etc/hostid` else `kenv -q smbios.system.uuid`.
3. Persist (best effort): load session (or default when missing **or unparseable**), set `deviceId`,
   `save_session` → pretty JSON to `session.json.tmp` then rename:
   `{"saTeeId":"","sessionCert":"","encryptedSessionSk":"","sessionKeyExpireAt":"","deviceId":"<id>"}` (pretty-printed).
First triggered by the first request built (`anonymous_headers`), i.e. any network command on a fresh home creates `session.json`.

#### 9.2 `device::name::get_cached_device_name()` (name.rs:18) → `&'static str`

`whoami::devicename()` (Windows `GetComputerNameExW(ComputerNameDnsHostname)`; macOS
`SCDynamicStoreCopyComputerName`; Linux `PRETTY_HOSTNAME` from `/etc/machine-info` with `\\ \t \r \n \' \"`
unescaping; fallback hostname; final fallback `LocalHost`) → `normalize_device_name` (47): trim,
remove every Unicode `Cc` char (C0, DEL, C1), empty → `unknown-device`, truncate to ≤128 bytes on a
UTF-8 boundary. Never persisted. Oracle: `"host\r\n\tX-Injected:\u{7f} evil"` → `hostX-Injected: evil`.

### 10. Audit log — `audit.rs`

`audit::log(source, command, ok, duration, args, error)` (140) — never fails (all errors ignored):
1. `home = onchainos_home()`; create it (`create_dir_all`) if missing.
2. `rotate_if_needed(<home>/audit.jsonl)` (223): if the file has more than 10 000 lines → rewrite
   (plain `fs::write`) as the device header line (if line 1 starts with `{"type":"device"`) + the last
   5 000 other lines, each `\n`-terminated.
3. `needs_header` = file missing or empty.
4. Open append (create; mode 0600 on unix). If `needs_header` → write
   `{"type":"device","os":"<os>","arch":"<arch>","version":"4.6.3"}\n`.
5. Append the entry line (compact, struct order, `\n`):
   `{"ts":"<ts>","source":"cli","command":"<label>","ok":<bool>,"duration_ms":<u64 ms>,"args":[…],"error":"<msg>"}`
   (`args` omitted when None, `error` omitted when None).
   - `ts` = local time `format!("{} {:+.1} {}", "%Y-%m-%d", utc_offset_hours_f32, "%H:%M:%S%.3f")`,
     e.g. `2026-09-28 +8.0 17:46:41.262`, `+0.0`, `-3.5`, `+5.8` (for +5:45; round-half-even), `+13.0`.
   - `error` truncated to 512 bytes on a char boundary + `…` when longer.
Written for every non-`mcp` CLI invocation that parsed successfully (after the handler, before the
error envelope). Other groups also call `audit::log` directly with custom labels (e.g. `login_account_switch`,
`ASP/deliver_*`, MCP tools with `source:"mcp"` and `args` None).

`binary_identity()` (33, writes `binary_identity.json` via `write_secure`) and `BinaryIdentity::audit_args` (88) are dead code (no callers).

#### 10.1 Argument redaction — `redact_args(raw)` (320)

- Positional: for pattern `["wallet","verify"]` — over args (lowercased) that do not start with `-`,
  find the first window equal to the pattern; the arg immediately after the window's last element
  (original index + 1) is replaced by `[REDACTED]` if it exists and does not start with `-`.
- `--flag=value` (any arg containing `=`; flag = text before the first `=`, compared
  case-insensitively): FULL → `--flag=[REDACTED]`; ADDR → `--flag=<mask(value)>`.
- `--flag value`: flag kept, next arg redacted.
- FULL list: `--otp --signed-tx --unsigned-tx --sui-tx-bytes --jito-unsigned-tx --input-data --data --message --autotrade --secret --payload --param --body --routing-json --routing-base64 --params-json --params-base64 --prepared-id --items --template-vars-b64` → `[REDACTED]`.
- ADDR list: `--from --wallet --email --address --sub-id --new-sub-id --job-id --tx-hash` →
  `mask_addr` (423): ≤10 chars → `[REDACTED]`; else first 6 chars + `***` + last 4 chars
  (`0x1234567890abcdef1234567890abcdef12345678` → `0x1234***5678`, `alice@example.com` → `alice@***.com`).
- Everything else verbatim (e.g. `--amount`, `--device-list`, `--chain`).

#### 10.2 Command label — `cli_command_name` (436)

`"<group> <sub>"` with these exceptions: `mcp` → `mcp`; `upgrade`, `preflight` → bare; `cross-chain` →
`cross-chain` (no sub); `payment`: `pay`, `quote`, `decode-receipt`, `pay-local` (Eip3009Sign),
`default-set|default-get|default-unset`, `a2a-pay create|pay|status`, `charge` (MppCharge),
`session open|voucher|topup|close`, `subscription subscribe|access|change|cancel|cancel-pending|my-subscriptions|allowance-status`;
`agent dispute Discriminant(N)` / `agent common Discriminant(N)` (literal Rust Debug of
`std::mem::discriminant`, N = variant index: dispute `Raise`=0, `Confirm`=1, `Upload`=2; common `Context`=0);
`agent a2mcp-probe probe|confirm-free|refresh-balance|funding|resume-after-funding|prepare-payment`;
`agent asp status|list-tasks`. Other sub labels:
- market: price, prices, kline, index, portfolio-supported-chains, portfolio-overview, portfolio-dex-history, portfolio-recent-pnl, portfolio-token-pnl
- signal: chains, list · social: news-latest, news-by-symbol, news-search, news-detail, news-platforms, sentiment-ranking, sentiment-symbol, vibe-timeline, vibe-top-kols
- memepump: chains, tokens, token-details, token-dev-info, similar-tokens, token-bundle-info, aped-wallet
- token: search, info, holders, price-info, liquidity, hot-tokens, advanced-info, top-trader, trades, cluster-overview, cluster-top-holders, cluster-list, cluster-supported-chains, report
- swap: quote, swap, approve, check-approvals, chains, liquidity, execute · gateway: gas, gas-limit, simulate, broadcast, orders, chains
- portfolio: chains, total-value, all-balances, token-balances · leaderboard: supported-chains, list · tracker: activities
- wallet: login, add, switch, status, addresses, receive, logout, chains, geoblock, balance, funding-check, send, history, inscription, utxo, contract-call, sign-message, gas-station, report-plugin-info
- security: token-scan, dapp-scan, tx-scan, approvals, sig-scan · strategy: create-limit, cancel, list, resume
- ws: channels, channel-info, start, poll, stop, list, run-daemon · workflow: token-research, smart-money, new-tokens, wallet-analysis, portfolio
- defi: support-chains, support-platforms, list, search, detail, prepare, deposit, redeem, claim, calculate-entry, rate-chart, tvl-chart, depth-price-chart, invest, withdraw, collect, positions, position-detail
- agent (flat): create, update, get, get-my-agents, get-agents, pre-check, get-by-address, activate, deactivate, upload, search, service-list, feedback-submit, feedback-list, task-feedback, xmtp-sign, validate-listing, create-task, status, lifecycle, tasks, set-payment-mode, confirm-accept, designated-route, complete, reject, refund-prepare, refund-execute, close, payment, claim-auto-refund, reject-apply, user-notify, funding-notice, cache-notify, cache-rating, task-attach, list-attachments, my-subscriptions, refund-list, refund-detail, my-tasks, subscription-list, task-visibility-update, subscribe-detail, claim-auto-complete, asp-claimable, asp-claim-rewards, apply, deliver, trade-kit-readiness, autotrade-grant-check, autotrade-grant-write (debug builds only), autotrade-guide-consent-new, autotrade-guide-consent-update, autotrade-consent-request, autotrade-guide-prepare, autotrade-direct-claim, autotrade-direct-finalize, autotrade-once-authorize, autotrade-outcome-flush, autotrade-delivery-report, autotrade-cap-adjust-request, agree-refund, asp-reject, subscribe-active, subscribe-agree-refund, subscribe-asp-claim, subscribe-dispute, evidence-info, vote-commit, vote-reveal, arbitration-claim, arbitration-claimable, stake, increase-stake, request-unstake, claim-unstake, cancel-unstake, staking-config, my-stake, next-action, file-upload, file-download, sensitive-words, message-eligible, system-config, heartbeat, wakeup-notify, mark-failed, my-agents, gate-check, communication-check, prepare-create, active-tasks, arbitration-list, arbitration-detail, profile, pending-decisions-v2, task-deliverable-save, task-deliverable-list, session-cleanup, task-in-progress, create-subscribe, service-param-update, subscribe-cancel, start-autorenew, subscribe-reject, subscribe-cost, subscribe-device-update, subscribe-offline-update, subscription-execution-config-set, device-list, asp-match, service-match, service-detail, task-service-select, task-create-prepare, set-asp, reset-asp, user-reject, accept-job-by-provider, decline-job-by-provider, accept-subscription, decline-subscription

(These labels are audit strings only; they are not guaranteed to equal the clap command names.)

### 11. Home directory — `home.rs`, `config.rs`

#### 11.1 `home.rs`

- `onchainos_home()` (12): env `ONCHAINOS_HOME` if set and non-empty (used verbatim), else
  `dirs::home_dir()/.onchainos` (Windows `%USERPROFILE%\.onchainos`); else error `cannot determine home directory`.
- `task_state_root()` (22) = `<home>/task`; `task_state_dir(job_id)` (27) = `<home>/task/<job_id>`.
- `ensure_task_state_writable()` (34): `ensure_dir_0700(<home>/task)` (context `failed to prepare task state directory`);
  create-new probe `<home>/task/.write-probe-<pid>-<unix_nanos>` (0600) containing `ok`, flush, delete.
  Errors: `task state directory is not writable: <dir>`, `failed to remove task state write probe <path>`. Returns the dir.
- `ensure_dir_0700(path)` (85): create_dir_all if missing (`failed to create directory <p>`); unix: chmod 0700 if different.
- `ensure_onchainos_home()` (105): `ensure_dir_0700(home)` (context `failed to prepare ~/.onchainos`).
- `self_heal_permissions()` (121): unix only; if home exists, chmod 0600 any of `session.json`,
  `wallets.json`, `keyring.enc`, `machine-identity`, `audit.jsonl`, `watch/*/daemon.log` whose mode ≠ 0600;
  stderr `Warning: cannot fix permissions on <path>: <err> — file may have been created by a different user`
  or `Warning: cannot read metadata for <path>: <err>`; never aborts.
- `atomic_write(path, bytes, sensitive)` (210): ensure parent (`ensure_onchainos_home` if parent is the
  home root, else `ensure_dir_0700`); write `<filename>.tmp` (full name + `.tmp`); unix chmod 0600
  (sensitive) / 0644; rename. Errors `failed to write temp file …`, `failed to set …`, `failed to rename … to …`,
  `path … has no parent directory`, `path … has no file name`.
- `write_secure(path, contents)` (259): create parent (unix chmod 0700, ignored errors); temp
  `<parent>/.<fname>.<pid>.tmp` opened 0600 (unix) truncate; write+flush; rename (temp removed on rename error).

#### 11.2 `config.json` — `config::AppConfig` (config.rs:7)

`{"api_key":"","session_token":"","active_wallet":"","default_chain":""}` (snake_case, all
`#[serde(default)]`). `load()` (20): if `<home>/config.json` is missing but `<cwd>/.onchainos/config.json`
exists → copy bytes with `atomic_write(…, sensitive=false)` (result ignored) and print to stderr
`Migrated config from <cwd>/.onchainos/config.json to <home>/config.json. You can safely delete the stale .onchainos directory at <cwd>/.onchainos.`
(printed even if the copy failed). Missing → default; unreadable/unparseable → error (which
`Context::new` swallows into the default). `save()` (51): pretty JSON to `config.json.tmp`, rename (no callers in the partition).
Only `default_chain` is consumed (Context §3).

#### 11.3 Files under `$ONCHAINOS_HOME` (all groups; owner in brackets)

| Path | Format | Written by |
|---|---|---|
| `config.json` | pretty JSON (§11.2) | cwd migration [core] |
| `audit.jsonl` | JSONL (§10) | every CLI run [core] + direct `audit::log` callers |
| `session.json` | pretty camelCase `SessionJson` | device id persist [core]; login/session [auth] |
| `payment_cache.json` | compact JSON (§6.7) | ApiClient header/config/notification flushes [core]; `payment default set/unset`, local-sign warning [payment]; deleted on logout |
| `doh-cache.json` | pretty JSON (§8) | DoH [core] (production builds only) |
| `bin/okx-pilot[.exe]` | downloaded executable | DoH [core] |
| `chain_cache.json` | pretty `{"updated_at":<unix s>,"chains":[…]}` via `chain_cache.json.tmp` | `agentic_wallet::chain` (TTL 600 s) — read by `chains.rs` with **no TTL** |
| `wallets.json`, `keyring.enc`, `machine-identity`, `cache.json`, `balance_cache.json` | — | auth / wallet groups |
| `task/<job_id>/…`, `task/.write-probe-*` | — | agent-commerce [core helper `ensure_task_state_writable`] |
| `tmp/funding-qr/onchainos-funding-qr-<pid>-<nanos>.png` | PNG | QR image mode (§19) |
| `watch/<id>/daemon.log` | text | watch daemon |
| `.env` (`EVM_PRIVATE_KEY=…`) | dotenv | user-provided; read by payment local signing |
| `binary_identity.json` | JSON | dead code |

### 12. Chain registry — `chains.rs`

- Constants: `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3`,
  `X402_EXACT_PERMIT2_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001`,
  `X402_UPTO_PERMIT2_PROXY = 0x4020e7393B728A3939659E5732F87fdd8e680002`.
- `rpc_url_for_chain(ci)` (46): `"196"` → `https://rpc.xlayer.tech`; else None.
- `SUPPORTED_CHAIN_INDICES` (55): `1 10 56 137 195 196 250 324 501 534352 607 784 1952 8453 42161 43114 59144`.
- `resolve_chain(name)` (129): `lower = name.to_lowercase()`; (1) read `chain_cache.json` (no TTL; read/parse
  errors ignored) — first entry whose `chainName.to_lowercase() == lower` → its `chainIndex` (string, or i64 rendered);
  (2) alias table: `ethereum|eth→1`, `solana|sol→501`, `bitcoin|btc→0`, `bsc|bnb→56`, `polygon|matic→137`,
  `arbitrum|arb→42161`, `base→8453`, `xlayer|x layer|x-layer|okb→196`, `xlayer_test→1952`, `avalanche|avax→43114`,
  `optimism|op→10`, `fantom|ftm→250`, `sui→784`, `tron|trx→195`, `ton→607`, `linea→59144`, `scroll→534352`,
  `zksync→324`, `tempo→4217`; (3) otherwise the **original** input unchanged (numeric ids and unknown names pass through).
- `resolve_chains(names)` (262): split `,`, trim each, `resolve_chain`, join `,`.
- `ensure_supported_chain(ci, raw)` (67): ok if any `chain_cache.json` entry has that `chainIndex`, or ci
  ∈ `SUPPORTED_CHAIN_INDICES`; else error
  `unsupported chain: "{raw}" (resolved to "{ci}"). Use \`onchainos swap chains\` to list supported chains.`
- `is_evm_chain(ci)` (91): cache entry's boolean `isEvmChain` wins; else ci ∈ {1,10,56,137,196,250,324,1952,8453,42161,43114,59144,534352}.
- `is_mainnet_chain(ci)` (228): cache entry → explicit bool `isTestnet` or `testnet` (negated), else
  `!chainName.lower().contains("test")`; no entry → false for `1952`, true iff in `SUPPORTED_CHAIN_INDICES`, else false.
- `chain_name_for_index(ci)` (176): 1 ethereum, 0 bitcoin, 10 optimism, 56 bsc, 137 polygon, 195 tron, 196 xlayer,
  250 fantom, 324 zksync, 501 solana, 534352 scroll, 607 ton, 784 sui, 1952 xlayer_test, 8453 base, 42161 arbitrum,
  43114 avalanche, 59144 linea; else None.
- `chain_family(ci)` (272): `501`→`solana`, else `evm`. `merges_batch_unsignedinfo(ci)` (285): ci ∈ {196, 1952}.
- `chain_display_name(ci)` (291): 0|5 Bitcoin, 1 Ethereum, 10 Optimism, 56 BNB Chain, 137 Polygon, 195 Tron,
  196 X Layer, 1952 X Layer Testnet, 250 Fantom, 324 zkSync, 501 Solana, 534352 Scroll, 607 TON, 784 Sui,
  8453 Base, 42161 Arbitrum One, 43114 Avalanche, 59144 Linea, 5042 Arc; else the raw ci.
- `native_token_symbol(ci)` (318): 0|5 BTC; 1,10,324,534352,8453,42161,59144 ETH; 56 BNB; 137 MATIC; 195 TRX;
  196|1952 OKB; 250 FTM; 43114 AVAX; 501 SOL; 607 TON; 784 SUI; 5042 USDC; else `native token`.
- `native_token_address(ci)` (341): 0|5 `""`; 501 `11111111111111111111111111111111`; 784 `0x2::sui::SUI`;
  195 `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`; 607 `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c`;
  5042 `0x3600000000000000000000000000000000000000`; else `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`.
- The cache is populated by `commands::agentic_wallet::chain::get_all_chains` (TTL 600 s,
  `POST /priapi/v5/wallet/agentic/chain/support/list` body `{}` via `WalletApiClient::post_public`;
  `data` array or `data.chainList`) — owned by the wallet group.

### 13. Token aliases — `token_alias.rs`

`TOKEN_MAP` (24), keys matched with `to_ascii_lowercase()`:

| chain | alias → address |
|---|---|
| 501 | sol, native → `11111111111111111111111111111111`; usdc → `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; usdt → `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`; `so11111111111111111111111111111111111111112`, `so11111111111111111111111111111111111111111` → `11111111111111111111111111111111` |
| 1 | eth, native → `0xeeee…eeee`; usdc `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`; usdt `0xdac17f958d2ee523a2206206994597c13d831ec7`; wbtc `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599`; dai `0x6b175474e89094c44da98b954eedeac495271d0f`; weth `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` |
| 8453 | eth, native → `0xeeee…`; usdc `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`; weth `0x4200000000000000000000000000000000000006`; usdbc `0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca` |
| 56 | bnb, native → `0xeeee…`; usdt `0x55d398326f99059ff775485246999027b3197955`; usdc `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`; wbnb `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c`; weth `0x2170ed0880ac9a755fd29b2688956bd959f933f8`; btcb `0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c` |
| 42161 | eth, native → `0xeeee…`; usdc `0xaf88d065e77c8cc2239327c5edb3a432268e5831`; usdt `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9`; weth `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` |
| 137 | matic, pol, native → `0xeeee…`; usdc `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`; usdt0 `0xc2132d05d31c914a87c6611c10748aeb04b58e8f`; weth `0x7ceb23fd6bc0add59e62ac25578270cff1b9f619`; wmatic, wpol `0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270` |
| 10 | eth, native → `0xeeee…`; usdc `0x0b2c639c533813f4aa9d7837caf62653d097ff85`; usdt `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58`; weth `0x4200000000000000000000000000000000000006`; op `0x4200000000000000000000000000000000000042` |
| 43114 | avax, native → `0xeeee…`; usdc `0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e`; usdt `0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7`; wavax `0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7`; weth.e `0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab` |
| 196 | okb, native → `0xeeee…`; usdc `0x74b7f16337b8972027f6196a17a631ac6de26d22`; xlayer_usdt `0x1e4a5963abfd975d8c9021ce480b42188849d41d`; usdt0, usdt `0x779ded0c9e1022225f8e0630b35a9b54be713736`; weth `0x5a77f1443d16ee5761d310e38b62f77f726bc71c`; wokb `0xe538905cf8410324e03a5a23c1c177a474d59b2b` |
| 1952 | okb, native → `0xeeee…`; usdc `0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d`; usdt `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c`; usdg `0xa78e2baabaf5c4f36b7fc394725deb68d332eec1` |
| 59144 | eth, native → `0xeeee…`; usdc `0x176211869ca2b568f2a7d4ee941e073a821ee1ff`; usdt `0xa219439258ca9da29e9cc4ce5596924745e12b93`; weth `0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f` |
| 534352 | eth, native → `0xeeee…`; usdc `0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4`; usdt `0xf55bec9cafdbe8730f096aa55dad6d22d44099df`; weth `0x5300000000000000000000000000000000000004` |
| 324 | eth, native → `0xeeee…`; weth `0x5aea5775959fbc2557cc8789bc1bf90a239d9a91`; usdt `0x493257fd37edb34451f62edf8d2a0c418852ba4c` |
| 250 | ftm, native → `0xeeee…`; wftm `0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83` |
| 195 | trx, native → `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`; usdt `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`; wtrx `TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR`; eth `THb4CqiFdwNHsWsQCs4JhzwjMWys4aqCbF` |
| 784 | sui, native → `0x2::sui::SUI`; wusdc `0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN`; wusdt `0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN` |
| 5042 | usdc, native → `0x3600000000000000000000000000000000000000` |

(`0xeeee…` = `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`.)

- `has_alias(ci, alias)` (178), `resolve_token_address(ci, token)` (188): mapped value or the input unchanged.
- `validate_address_for_chain(ci, token, label)` (206):
  - `501`: starts `0x`/`0X` → `--{label} looks like an EVM address (0x…) but chain is Solana. Solana uses base58 addresses (e.g. EPjFWdd5...wyTDt1v). Did you mean to use a different chain?`;
    byte length ∉ [32,44] → `--{label} is not a valid Solana address: expected 32-44 base58 characters, got {len} characters ("{token}")`;
    any char not ASCII alphanumeric or one of `0 O I l` → `--{label} is not a valid Solana address: contains characters outside base58 alphabet ("{token}")`.
  - `195`, `607`, `784`: no check.
  - else (EVM): if not `0x`/`0X`-prefixed, length 32–44, all ASCII alphanumeric and at least one uppercase →
    `--{label} looks like a Solana/base58 address but chain is EVM (chainIndex={ci}). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?`;
    then must be `0x`/`0X` + exactly 40 hex digits (length 42) else `--{label} is not a valid EVM address: expected 0x + 40 hex digits, got "{token}"`.
- `resolve_and_validate(ci, raw, label)` (277): resolve then validate; returns resolved address.

### 14. Validators — `validators.rs`

- `validate_amount(a)` (11), after trim: empty → `--amount must not be empty`; contains `.` →
  `--amount must be a whole number in minimal units (no decimals)`; non-digit →
  `--amount must be a whole number in minimal units, got "{a}". Infinity, NaN, negative numbers and non-numeric values are not accepted.`;
  all zeros → `--amount must be greater than zero`; leading `0` → `--amount must not have leading zeros, got "{a}"`.
- `validate_slippage(s)` (37): trim, strip trailing `%`s, trim; parse f64 (Rust grammar: accepts `inf`, `NaN`, `1e2`)
  failure → `--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "{s}"`; NaN/inf →
  `--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "{s}"`; `≤0` or `>100` →
  `--slippage must be greater than 0 and at most 100, got "{s}"`.
- `validate_slippage_zero_to_one(s)` (62): trim; ends with `%` →
  `--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got "{s}"`;
  parse fail → `--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got "{s}"`; NaN/inf →
  `--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got "{s}"`; `≤0` or `>1` →
  `--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got "{s}"`.
- `validate_non_negative_integer(v, label)` (97): trim; empty → `--{label} must not be empty`; non-digit →
  `--{label} must be a non-negative integer, got "{v}"`; len>1 and leading 0 → `--{label} must not have leading zeros, got "{v}"`.
- `validate_order_id_numeric(id, label)` (117): trim; empty → `--{label} must not be empty`; non-digit →
  ``--{label} must be a numeric order id, got `{id}` ``; > i64 max → ``--{label} `{id}` does not fit in BE Long range (max 9223372036854775807)``.
- `readable_to_minimal_str(amount, decimals)` (139): trim; split at first `.`; empty integer part → `0`;
  non-digit parts → `--readable-amount must be a positive number, got "{amount}"`; fraction longer than
  decimals with any non-zero excess digit →
  `--readable-amount "{amount}" has more decimal places than this token supports ({decimals} decimals)`;
  pad/truncate fraction to `decimals`, concatenate, strip leading zeros; result `0` →
  `--readable-amount {amount} is too small for this token ({decimals} decimals); results in zero minimal units`.
  Oracles: `("0.1",6)→"100000"`, `("1.5",18)→"1500000000000000000"`, `(".5",6)→"500000"`, `("1.000",2)→"100"`.

### 15. Asset classes — `asset_class.rs`

`AssetClass` (13): serde lowercase `spot|perp|prediction|option|defi`. `from_str` (24), ASCII case-insensitive:
`spot`; `perp|futures`→perp; `prediction`; `option|options`→option; `defi`; else
`asset class must be spot, perp, prediction, option, or defi`. `ORDER` (41) = spot, perp, prediction, option, defi. `as_str` (51).

### 16. `commands/common.rs`

- `tx_confirmation_timeout(ci)` (23): `1`/`59144` → 20 s; else 10 s.
- `wait_tx_onchain(client, tx_hash, ci)` (35): loop: `client.get("/api/v6/dex/post-transaction/transaction-detail-by-txhash", [("chainIndex",ci),("txHash",tx_hash)])`
  (full `get` semantics); on Ok take first element if array; `txStatus` case-insensitive `success` → Ok;
  `fail` → error `tx {hash} failed on-chain (chain={ci})`; request errors ignored; after each attempt if
  deadline passed → `tx {hash} not confirmed on-chain within {secs}s (chain={ci})`; sleep 1 s. Read-only.

### 17. `commands/sink.rs` (shared deterministic helpers)

- `CodedError::{new, with_data, with_next_steps, invalid_input(field,msg)}` (29-62) → rendered by main (§1.1 #7).
- `parse_duration_ms(s, flag, allow_zero)` (86): `t = s.trim()`; `t=="0"` → 0 if allowed else
  `invalid --{flag} '{s}'; duration must be positive`; suffix `d`=86 400 000, `h`=3 600 000, `m`=60 000, `s`=1 000
  (checked in that order); no suffix or non-u64 number (Rust `u64::from_str`, accepts a leading `+`) →
  `invalid --{flag} '{s}'; use e.g. 300s, 30m, 24h, 7d`; zero number → 0 or the "positive" error; overflow → `--{flag} '{s}' overflows`. (`{s}` is the untrimmed input.)
- `resolve_since_window(since, now_ms)` (127) → `{"begin": now−dur (saturating), "end": now}` (struct `ResolvedWindow`). `now_ms()` (137).
- `parse_max_results(raw)` (201): None → None; trim; non-u32 → CodedError(`invalid_input`,`max-results`,
  `--max-results must be an integer between 1 and 500, got '{s}'`); outside 1..=500 →
  `--max-results must be between 1 and 500, got {n}`.
- `auto_paginate(start_cursor, max, shape, fetch)` (251): `MAX_PAGES = 10`; per page: fetch error →
  return partial `{items, nextCursor: attempted cursor, fetchedCount, partial:true, error:{code:"upstream_error", message:"page {n} request failed: {e:#}", nextCursor}}`;
  items = `page[items_key]` array, else page-as-array, else first array-valued field (BTreeMap order), else [];
  continuation = PerItem: last item's `[cursor_key]`, PageLevel: `page[cursor_key]` (non-empty string or number → string);
  empty page with non-empty cursor → stop; extend; `len ≥ max` → stop; continuation equal to the cursor just
  queried → partial with `error.code = "cursor_not_advancing"`, message
  `upstream returned the same cursor '{c}' it was queried with; stopping to avoid re-fetching the same page`;
  empty/absent continuation → stop. Final: PerItem and `len > max` → truncate to `max`, `nextCursor` = last kept
  item's cursor; else `nextCursor` = last continuation. JSON (struct order):
  `{"items":[…],"nextCursor":<string|null>,"fetchedCount":n,"partial":true?,"error":{"code","field"?,"message","nextCursor"?}?}`.
- `normalize_amount(raw)` (392): null/`""`/`"0"`/`"0x0"`(ci) → `"0"`; `0x`/`0X` → exact hex→decimal; all digits →
  leading zeros stripped; JSON number that is a u64 → its text; other numbers → error
  `value must be a non-negative integer minimal unit, got '{n}'`; other strings → `unparseable value '{t}'`;
  other JSON types → `unparseable value (unexpected JSON type)`.
- `hex_to_decimal_string(hex)` (430): arbitrary precision; empty → `0`; bad digit → `invalid hex digit '{c}' in '{hex}'`.
- `sum_prize_pool(distributions)` (485): None when empty; group by `rewardUnit` (first-seen order), exact decimal
  add of `totalReward` (string trimmed or number text); missing/invalid → skip + `partial=true`;
  `display` = entries joined by ` + `, each `format_thousands(amount)` + (` {unit}` when unit non-empty).
  JSON `{"amountByUnit":[{"amount","rewardUnit"}],"display","partial"?}`.
- `add_decimal_strings(a,b)` (572): exact; trailing fractional zeros trimmed (`"1.5"+"2.75"="4.25"`, `"0.1"+"0.2"="0.3"`);
  signs / multiple dots / non-digits → `unparseable decimal '{s}'`, empty → `empty decimal string '{s}'`.
- `format_thousands(d)` (616): commas every 3 integer digits, fraction preserved (`40000.5→40,000.5`).

### 18. Funding helpers — `funding.rs`

- `readable_shortfall(required, available)` (278, pub): both must be plain non-negative decimals (trim;
  ≤1 dot; not both parts empty; digits only) else None; exact BigUint arithmetic; `required ≤ available` → `"0"`;
  else difference rendered with trailing fractional zeros (and a dangling `.`) trimmed.
  Oracles: `("10","0.08504764")→"9.91495236"`, `("1.20","0.2")→"1"`, `("1","2")→"0"`, `("1e3","1")→None`.
- `validate_funding_blocked_input` (250): `funding asset must not be blank`; `funding operation must not be blank when provided`;
  `funding required amount must be a plain non-negative decimal`; `funding required amount must be greater than zero`;
  `funding balance must be a plain non-negative decimal`; `funding bundle requires an actual balance shortfall`.
- `resolve_funding_target(wallets, ci)` (147): `receiveAddress` from `agentic_wallet::account::resolve_account_address_for_chain`
  (errors propagate), `accountName` of the selected account (`""` if unresolvable), `chainName = chain_display_name(ci)`,
  `gasFree = ci == "196"`, `sameNetworkRequired = true`.
- `build_funding_bundle(ci, input)` (199, async): validate → `agentic_wallet::auth::ensure_tokens_refreshed()`
  (may `POST /priapi/v5/wallet/agentic/auth/refresh`) → `wallets.json` (missing → `ERR_NOT_LOGGED_IN`) →
  `refresh_wallet_accounts_strict` (`POST /priapi/v5/wallet/agentic/account/list`,
  `POST /priapi/v5/wallet/agentic/account/address/list`, rewrites `wallets.json`) → target + `qr::build_qr_output(address, None)` → blocked result.
- `build_funding_bundle_for_address(account_name, ci, address, input)` (234): validate; blank ci/address →
  `funding chain index must not be blank` / `funding receive address must not be blank`; no I/O except QR.
- `build_funding_blocked_result(bundle, input)` (94) — built with `json!` ⇒ sorted keys:
```json
{"decision":"blocked","nextAction":[],
 "payload":{"error":{"code":"…","message":"…"},
            "fundingNeed":{"asset":"USDT","balance":"1"|null,"required":"10","shortfall":"9","tokenAddress":"0x…"},
            "fundingTarget":{"accountName":"…","chainIndex":"196","chainName":"X Layer","gasFree":true,"receiveAddress":"0x…","sameNetworkRequired":true},
            "operation":"transfer|swap|a2a_payment|task_creation",
            "qr":{…QrOutput, sorted…}},
 "phase":"funding_required","reason":"insufficient_balance"}
```
  `error` only when code/message non-blank; `operation` only when provided; `shortfall` only when balance given
  and parseable. Callers wrap it in `CliFundingBlocked` ⇒ `{"ok":false,"data":{…}}`, exit 1.

### 19. QR — `qr.rs`

- `render_address_qr_unicode(text)` (27): `QrCode::new(text bytes)` (qrcode 0.14.1: EC level **M**; segments from
  `optimize::Parser` + `Optimizer` evaluated against versions 9, 26, 40 in turn; the first bracket whose capacity fits
  is used and the final version is the smallest Normal version fitting the encoded length; mask = lowest ISO
  penalty via `apply_best_mask`) rendered `Dense1x2` **inverted** (`dark_color(Light)`, `light_color(Dark)`),
  quiet zone 4 modules. Pixel value = 1 for light modules / quiet zone, 0 for dark modules; each pair of module
  rows (top,bottom) → char `[" ", "▄", "▀", "█"][top*2+bottom]` (U+2584, U+2580, U+2588); an odd final row uses
  `top*2`; rows joined with `\n`, no trailing newline.
- `render_address_qr_png(text)` (42): same matrix; 8 px per module, 4-module quiet zone; 8-bit grayscale
  (dark 0, light 255); each row prefixed with filter byte 0; PNG = signature + IHDR(w,h,8,0,0,0,0) + IDAT(zlib:
  `78 01`, stored blocks of ≤65535 bytes (BFINAL on the last), LEN/NLEN LE, adler32 BE) + IEND; CRC32 (poly 0xEDB88320).
- `build_qr_output(address, image_dir)` (185) never fails. `QrOutput` (153, camelCase, struct order):
  `{"requestedFormat":"auto","resolvedFormat"?:"unicode"|"png","displayMode":"terminal-unicode"|"image-notify","terminalQr"?,"imagePath"?,"mimeType"?:"image/png","markdownImage"?,"notifyCommandArgs"?}`.
  - terminal-unicode: `resolvedFormat:"unicode"`, `terminalQr`.
  - image-notify: write PNG `onchainos-funding-qr-<pid>-<unix_nanos>.png` to the first writable dir of
    [`image_dir`, `$ONCHAINOS_FUNDING_IMAGE_DIR`, `<home>/tmp/funding-qr`, `<cwd>/.onchainos/tmp/funding-qr`, OS temp dir]
    (each via `ensure_dir_0700`); sets `resolvedFormat:"png"`, `imagePath`, `mimeType`,
    `markdownImage = "![QR Code](<{p}>)"` (p = `./<path relative to cwd>` using OS separators when under cwd, else the
    absolute path; `>` → `%3E`), `notifyCommandArgs = ["onchainos","agent","user-notify","--content","<localized content>","--image-path","<path>"]`.
  - encode/write failure → only `requestedFormat` + `displayMode`.
- Display mode `detect_display_mode` (340) / `display_mode()` (192): if env `CODEX_THREAD_ID` (trimmed, non-empty):
  scan `$CODEX_HOME/sessions` then `~/.codex/sessions` (DFS, ≤5000 dirs) for `*.jsonl|*.json` files whose name
  contains the id; first line JSON → `session_meta` or `payload` or root; recursive search for `originator`/`source`
  (lowercased, trimmed): originator `codex-tui`/`codex_exec` → terminal; `codex desktop` → image; else source
  `cli`/`exec` → terminal, `vscode`/`appserver` → image. Otherwise: terminal if stdout **or** stderr is a TTY, else image-notify.

---

## Commands

This partition owns **no leaf command** (all 290 visible leaves and every hidden leaf belong to other
groups). The root invocation contract is documented here because every command inherits it.

### `onchainos` (root: global flags, `--version`, `--help`, dispatch)  (hidden: no; flag `--dev` hidden)

- Handler: `main::run` (main.rs:176), dispatch table main.rs:211-236.
- Options: `--chain <CHAIN>` (global, optional string, no default, no value parser — resolution happens in
  handlers/`Context`); `--dev` (global bool, **hidden**); `-h/--help`; `-V/--version` (root only). No env fallbacks.
  `ONCHAINOS_PRETTY=1` (output), `ONCHAINOS_HOME` (state dir), `OKX_DOH_BINARY_PATH`,
  `ONCHAINOS_FUNDING_IMAGE_DIR`, `CODEX_THREAD_ID`/`CODEX_HOME` (QR mode), `EVM_PRIVATE_KEY` (payment local signing)
  are the runtime env inputs of the core.
- Auth: n/a (per command).
- Steps: §1 (startup), dispatch:

| Top-level (clap name) | Handler | Receives `Context` | Audit label |
|---|---|---|---|
| `market` | `commands::market::execute` (commands/market.rs:127) | yes | `market <sub>` |
| `signal` | `commands::signal::execute` (commands/signal.rs:58) | yes | `signal <sub>` |
| `social` | `commands::social::execute` (commands/social.rs:369) | yes | `social <sub>` |
| `memepump` | `commands::memepump::execute` (commands/memepump.rs:379) | yes | `memepump <sub>` |
| `leaderboard` | `commands::leaderboard::execute` (commands/leaderboard.rs:55) | yes | `leaderboard <sub>` |
| `token` | `commands::token::execute` (commands/token.rs:311) | yes | `token <sub>` |
| `swap` | `commands::swap::execute` (commands/swap.rs:172) | yes | `swap <sub>` |
| `cross-chain` | `commands::cross_chain::execute` (commands/cross_chain.rs:855) | yes | `cross-chain` |
| `gateway` | `commands::gateway::execute` (commands/gateway.rs:84) | yes | `gateway <sub>` |
| `portfolio` | `commands::portfolio::execute` (commands/portfolio.rs:59) | yes | `portfolio <sub>` |
| `mcp` | `mcp::serve` (mcp/mod.rs:2975) | no (short-circuit before Context) | none |
| `wallet` | `commands::agentic_wallet::execute` (commands/agentic_wallet/mod.rs:595) | no | `wallet <sub>` |
| `security` | `commands::security::execute` (commands/security.rs:127) | yes | `security <sub>` |
| `payment` | `commands::payment::execute` (commands/payment/dispatcher.rs:290) | no | `payment <label>` |
| `tracker` | `commands::tracker::execute` (commands/tracker.rs:49) | yes | `tracker <sub>` |
| `ws` | `commands::ws::execute` (commands/ws.rs:125) | no | `ws <sub>` |
| `defi` | `commands::defi::execute` (commands/defi/mod.rs:324) | yes | `defi <sub>` |
| `strategy` | `commands::agentic_wallet::strategy::execute` (commands/agentic_wallet/strategy/mod.rs:29) | yes | `strategy <sub>` |
| `workflow` | `commands::workflows::execute` (commands/workflows/mod.rs:69) | yes | `workflow <sub>` |
| `upgrade` | `commands::upgrade::execute` (commands/upgrade.rs:31) | no | `upgrade` |
| `preflight` | `commands::upgrade::preflight` (commands/upgrade.rs:44) | no | `preflight` |
| `agent` | `commands::agent_commerce::run` (commands/agent_commerce/mod.rs:1403) | yes (`chain_override = "xlayer"`) | `agent <label>` |

  (`--help` lists them in exactly this order.) For reference only (owned elsewhere): `upgrade` runs
  `npx -y @okxweb3/onchainos-installer install` with inherited stdio and prints no envelope on success;
  errors ``failed to start `npx -y @okxweb3/onchainos-installer install`: {io}`` / ``npx -y @okxweb3/onchainos-installer install` exited with {status}``.
  `preflight` always fails with ``onchainos preflight` is deprecated; use `npx -y @okxweb3/onchainos-installer install` ``
  (i.e. stdout ``{"ok":false,"error":"`onchainos preflight` is deprecated; use `npx -y @okxweb3/onchainos-installer install`"}``, exit 1).
- Output: per command; envelopes §2.
- Errors: §1.1 table; clap errors exit 2 on stderr.
- Side effects: local-only for the root itself: `audit.jsonl` append (every parsed non-`mcp` run),
  possible `config.json` migration, `session.json` creation on first HTTP request (device id),
  `payment_cache.json` / `doh-cache.json` updates from the HTTP layer.
- Nondeterminism: audit `ts`/`duration_ms`; `device-id`/`device-name` header values (machine-specific);
  User-Agent os/arch; payment `notifications` (depend on `payment_cache.json` state, the server's
  `ok-web3-openapi-pay` header and wall-clock vs 2026-04-30/2026-05-30); QR `displayMode` (TTY/Codex env)
  and `imagePath` (pid + nanos); `updated_at` timestamps in caches; UUIDv4 device id when no machine id.
- Parity test cases:
  1. `onchainos --version` → stdout `onchainos 4.6.3\n`, exit 0, no HTTP. **SAFE**
  2. `onchainos preflight` → stdout ``{"ok":false,"error":"`onchainos preflight` is deprecated; use `npx -y @okxweb3/onchainos-installer install`"}``, exit 1, no HTTP, one audit line `command:"preflight"`. **SAFE**
  3. `ONCHAINOS_PRETTY=1 onchainos preflight` → same object pretty-printed (`{\n  "ok": false,\n  "error": "…"\n}`), exit 1. **SAFE**
  4. `onchainos bogus` → stdout empty, stderr `error: unrecognized subcommand 'bogus'…`, exit 2; `onchainos market` → group help on stderr, exit 2. **SAFE**
  5. `onchainos --chain solana signal chains` (any read-only leaf) against the recording proxy → request carries exactly
     `content-type: application/json`, `ok-client-version: 4.6.3`, `ok-access-client-type: agent-cli`, `platform: agent-cli`,
     `device-id`, `device-name` (+ `authorization` only when logged in); a server reply `{"code":"51000","msg":"x"}` renders
     `{"ok":false,"error":"API error (code=51000): x"}` exit 1; a reply `{"code":"0","data":{"b":1,"a":2.0}}` renders `{"ok":true,"data":{"a":2.0,"b":1}}`. **SAFE**

---

## Endpoint classification (partition-owned call sites)

| Method | Path | Class | Used by |
|---|---|---|---|
| GET | `/api/v6/dex/market/config` | read | `ApiClient::ensure_payment_config` — any `ApiClient` get/post once a tier is charging |
| GET | `/api/v6/dex/post-transaction/transaction-detail-by-txhash` | read | `commands::common::wait_tx_onchain` (swap / cross-chain approve→wait) |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | `ApiClient::resolve_auth_async` and the invalid-token retry, via `wallet_api::force_refresh_access_token`; `funding::build_funding_bundle` via `ensure_tokens_refreshed` |
| POST | `/priapi/v5/wallet/agentic/account/list` | read | `funding::build_funding_bundle` → `refresh_wallet_accounts_strict` |
| POST | `/priapi/v5/wallet/agentic/account/address/list` | read | same |
| POST | `/priapi/v5/wallet/agentic/chain/support/list` | read | not called by the partition; populates `chain_cache.json` consumed by `chains.rs` / `payment_notify` (owner `agentic_wallet::chain`) |
| ANY | any x402-gated path re-sent with `PAYMENT-SIGNATURE` (pre-signed when tier confirmed, or after a 402) | funds | `ApiClient::get_with_headers` / `post_with_headers` / `_raw` 402 auto-pay |

## External hosts (non-OKX-API)

- `https://web3.okx.com` — default compiled base URL (and DoH domain `web3.okx.com`); harness build uses `http://127.0.0.1:18899`.
- `https://beta.okex.org` — hidden `--dev` base URL.
- `wss://wsdex.okx.com:8443/ws/v5/private` (agent identity push), `wss://wsdex.okx.com/ws/v6/dex` (DEX ws) — compiled defaults (`endpoints.rs`), used by ws/agent groups.
- `https://rpc.xlayer.tech` — `chains::rpc_url_for_chain("196")` (Permit2 allowance pre-check in the payment group).
- DoH CDNs: `https://static.okx.com/upgradeapp/tools/pilot`, `https://static.coinall.ltd/upgradeapp/tools/pilot`, `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`, `https://static.jingyunyilian.com/upgradeapp/tools/pilot` (`/{platform}/checksum.json`, `/{platform}/okx-pilot[.exe]`).
- `https://<node.host>` — dynamic DoH proxy node returned by `okx-pilot`; the `okx-pilot` process itself resolves over its own (unknown) DoH servers.
- `https://web3.okx.com/onchainos/dev-docs/market/market-api-fee` — string in notifications only (never fetched).
- npm registry — via `npx` spawned by `upgrade` (dispatched from main, owned elsewhere).

## Porting notes for the Node runtime (parity hazards)

1. Emit `serde_json::Value`-derived objects with recursively sorted keys; keep struct field order for the
   envelope/struct types listed above.
2. Parse server JSON losslessly for integers (u64/i64 range) and re-emit floats with the zmij rules of §2.1.
3. `println!` ⇒ exactly one `\n` after the JSON; nothing else on stdout for error paths.
4. Query encoding = WHATWG urlencoded (`URLSearchParams`), empty values dropped, order preserved.
5. `Content-Type: application/json` also on GETs; header names as listed (servers see them lowercased under HTTP/1.1 case-insensitivity).
6. The x402 first-charge block returns `{"confirming":true,"notifications":[…]}` with exit 2 — reproduce the
   payment state machine, `payment_cache.json` schema and notification dedupe exactly or outputs diverge on the
   first run against a server that sends `ok-web3-openapi-pay`.
7. DoH is inactive whenever the base URL is custom (the parity harness build), so dropping it is observable only
   against production (`doh-cache.json` is never written in the harness build).

---

## Open questions

1. Upstream selects the API origin only at compile time (`cli/.env` → `OKX_BASE_URL`; custom ⇒ DoH off). The lite runtime needs a runtime override for the harness (DESIGN proposes `OCL_BASE_URL`); confirm lite must also treat any overridden base URL as "custom" (no DoH, and `resource` URL in x402 headers = that origin).
2. reqwest transport error texts (e.g. `error sending request for url (…): client error (Connect): tcp connect error: … (os error 10061)`) inside `Network unavailable — check your connection and try again: …` cannot be reproduced byte-for-byte in Node; parity policy for transport-failure messages is undecided.
3. `device-id` / `device-name` header values are compared verbatim by `test/parity/canon.mjs` (not in `MASK_HEADERS`); lite derives the same id only if it reads the same machine id and uses the same `session.json` field — confirm whether the harness should mask them, given lite uses `~/.onchainos-lite`.
4. QR output in parity runs is environment-dependent (piped stdio ⇒ `image-notify` with a pid/nanos PNG path under `$ONCHAINOS_HOME/tmp/funding-qr`); the harness needs a masking rule for `imagePath`/`markdownImage`/`notifyCommandArgs`, and a Node port must reproduce qrcode 0.14.1's segment optimiser and mask choice to match `terminalQr`/PNG bytes.
5. Audit labels for `agent dispute …` / `agent common …` are Rust-Debug artefacts (`Discriminant(N)`); confirm lite should emit the literal strings `agent dispute Discriminant(0|1|2)` / `agent common Discriminant(0)`.
6. `autotrade-grant-write` exists only in debug builds (`#[cfg(debug_assertions)]`); the release binary (and cli-tree.json) lacks it — confirm lite omits it.
7. Ownership of `mcp`, `upgrade`, `preflight` is not assigned to g01 ("commands owned: none"); confirm another group specifies them.
8. The keyring read path used by `ApiClient` auth (`keyring_store::get_opt("access_token")`, OS keyring vs `keyring.enc`) is owned by the auth group; lite always uses the file keyring — confirm no observable difference for `Context::client()` (sync, no expiry check) vs `client_async()`.
9. Upstream DoH has an unbounded failover loop when the pilot binary keeps returning "direct" during an outage; irrelevant if lite drops DoH, but record as intentional divergence in `docs/PARITY.md`.
10. OVER_QUOTA notifications are attached to successful responses of paths absent from the tier map while any tier is `ChargingUnconfirmed` (path_tier None ⇒ matches all tiers). This looks unintended upstream but is the observable behaviour; confirm lite should replicate it.
