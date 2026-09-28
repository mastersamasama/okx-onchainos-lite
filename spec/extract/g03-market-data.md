# g03-market-data — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: every leaf under `onchainos market`, `onchainos signal`, `onchainos social`,
`onchainos leaderboard`, `onchainos tracker`, `onchainos memepump` (30 leaves, none hidden).
All of them are thin, read-only wrappers: build one (or, for `social news-* --max-results`,
up to 10) HTTP request(s) against the OKX base URL through the core `ApiClient`, apply a
small local transform in a few cases, and print the unwrapped `data` in the standard
`{"ok":true,"data":...}` envelope.

## Sources read

Partition files (read fully, every line):

| File | Lines |
|---|---|
| `cli/src/commands/market.rs` | 563 |
| `cli/src/commands/signal.rs` | 221 |
| `cli/src/commands/social.rs` | 891 |
| `cli/src/commands/leaderboard.rs` | 213 |
| `cli/src/commands/tracker.rs` | 188 |
| `cli/src/commands/memepump.rs` | 1123 |

Supporting sources read to trace called helpers (read fully unless noted):

| File | Lines | Why |
|---|---|---|
| `cli/src/main.rs` | 316 | subcommand wiring, global flags, error → exit-code mapping |
| `cli/src/commands/mod.rs` | 134 | `Context`, `client_async`, `chain_index_or` |
| `cli/src/commands/sink.rs` | 1022 | `--since`, `--max-results`, `auto_paginate`, `CodedError` |
| `cli/src/client.rs` | 2469 (lines 1–1818 read) | `ApiClient` get/post, headers, envelope, payment, DoH retry |
| `cli/src/output.rs` | 450 | output envelopes |
| `cli/src/chains.rs` | 623 | `resolve_chain` |
| `cli/src/config.rs` | 66 | `AppConfig` (`default_chain`) |
| `cli/src/endpoints.rs` | 65 | base URL / `--dev` |
| `cli/build.rs` | 59 | compiled base URL defaults |
| `cli/Cargo.toml` / `Cargo.lock` (serde_json entry) | — | serde_json has NO `preserve_order` → sorted keys |
| `cli/src/wallet_store.rs` | 848 (chain_cache section) | `load_chain_cache` |
| `cli/src/wallet_api.rs` | 2874 (lines 630–740, 1420–1440) | `force_refresh_access_token`, `is_invalid_token_error`, refresh path |
| `cli/src/audit.rs` | 1405 (lines 1–200, 430–720) | audit log + command names |
| `cli/src/doh/manager.rs`, `cli/src/doh/binary.rs` | 424, 362 (grep/partial) | DoH UA, CDN hosts |
| `cli/tests/cli_market.rs` | 608 | oracle |
| `cli/tests/cli_signal.rs` | 318 | oracle (signal + tracker) |
| `cli/tests/cli_social.rs` | 505 | oracle |
| `cli/tests/cli_leaderboard.rs` | 144 | oracle |
| `cli/tests/cli_trenches.rs` | 652 | oracle (memepump) |
| `cli/tests/common/mod.rs` | 328 | oracle helpers |
| `spec/cli-tree.json` | — | flag cross-check (all 30 leaves match source; no hidden leaves in this group) |

## Shared helpers (used across groups or from core)

### 0. Runtime contract every g03 command inherits (core, summarised because it shapes every byte)

- **Process entry** `fn main::run` (main.rs:176): `home::self_heal_permissions()` (warning to stderr on failure) → `Cli::parse()` → `endpoints::set_dev_mode(cli.dev)` → `Context::new(&cli)` → dispatch (main.rs:212-217) → `audit::log("cli", "<group> <leaf>", ok, elapsed, redacted_args, err)` (appends a line to `$ONCHAINOS_HOME/audit.jsonl`) → error rendering:
  - `commands::sink::CodedError` → `output::error_coded_details` → stdout `{"error":<message>,"errorCode":<code>,"errorField":<field>,"ok":false}` (keys alphabetically sorted, see JSON note), **exit 1**.
  - `output::CliConfirming` (only produced by the core x402 first-charge path) → `{"confirming":true,"notifications":[...]}` (empty `message`/`next`/`scene` omitted), **exit 2**.
  - any other error → `output::error(format!("{e:#}"))` → stdout `{"ok":false,"error":"<msg>"}`, **exit 1**.
  - success → `output::success(data)` → stdout `{"ok":true,"data":<data>}` (+ `,"notifications":[...]` only when core payment notifications were queued), exit 0.
  - Output is `println!` → one line + `\n`. Compact JSON unless env `ONCHAINOS_PRETTY=1` (then serde_json pretty, 2-space indent).
- **Global flags** (main.rs:41-52): `--chain <CHAIN>` (global, optional) and hidden `--dev` (global bool; switches base URL to `https://beta.okex.org` and disables DoH). `-h/--help`; `-V/--version` top-level only.
  - clap global propagation (clap 4 `fill_in_global_values`): when a leaf defines its own `--chain`, a `--chain` typed at ANY level (top, group, leaf) ends up in both `cli.chain` and the leaf's local `chain` field; if typed at two levels the deepest one wins. Leaves without a local `--chain` still accept the global one but ignore it (except via `Context::chain_index*`, which none of those leaves call).
- **`Context`** (commands/mod.rs:31-86): `config = AppConfig::load().unwrap_or_default()` reads `$ONCHAINOS_HOME/config.json` (`{api_key, session_token, active_wallet, default_chain}`, all strings; may migrate `./.onchainos/config.json` and print a stderr notice). `chain_index_or(default)` = resolve(`cli.chain`) else resolve(`config.default_chain` if non-empty) else resolve(`default`).
- **`fn chains::resolve_chain`** (chains.rs:129) — `lower = name.to_lowercase()`; (1) scan `$ONCHAINOS_HOME/chain_cache.json` `chains[]`: first entry whose `chainName.to_lowercase() == lower` → its `chainIndex` (string, or integer rendered as string); (2) alias table: `ethereum|eth→1`, `solana|sol→501`, `bitcoin|btc→0`, `bsc|bnb→56`, `polygon|matic→137`, `arbitrum|arb→42161`, `base→8453`, `xlayer|x layer|x-layer|okb→196`, `xlayer_test→1952`, `avalanche|avax→43114`, `optimism|op→10`, `fantom|ftm→250`, `sui→784`, `tron|trx→195`, `ton→607`, `linea→59144`, `scroll→534352`, `zksync→324`, `tempo→4217`; (3) otherwise the ORIGINAL input string unchanged (case preserved, e.g. `"8453"`, `"Foo"`, `""`). Never errors.
- **`ApiClient`** (client.rs):
  - `ApiClient::new_async` (client.rs:246) — auth resolution (`resolve_auth_async`, :268): keyring `access_token` absent/empty → Anonymous; JWT `exp` (base64url payload, no sig check) in the future → `Authorization: Bearer <jwt>`; expired → keyring `refresh_token` absent → Anonymous; refresh token expired → stderr `Session expired. Please log in again: onchainos wallet login` + Anonymous; else `wallet_api::force_refresh_access_token` (wallet_api.rs:679 → `POST /priapi/v5/wallet/agentic/auth/refresh` body `{"refreshToken":...}`, stores rotated tokens) → Jwt, on failure stderr `Failed to refresh session (<e>). Falling back to anonymous access.` + Anonymous. Then `DohManager::prepare()` (may fail: `OKX_DOH_BINARY_PATH must resolve to a path under ...` → exit 1) and a reqwest client with 10 s timeout, `User-Agent: OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`.
  - Headers on every request (`anonymous_headers`, :346 / `jwt_headers`, :377): `Content-Type: application/json` (also on GET), `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <cached id>` (if available), `device-name: <host name>`, plus `Authorization: Bearer <jwt>` when logged in. Optional `PAYMENT-SIGNATURE` (x402, see below).
  - `ApiClient::get(path, query)` (:442) → URL = `<base><path>`; query pairs **with empty values dropped** (`build_get_url_and_request_path`, :413), kept in the given order, encoded with `application/x-www-form-urlencoded` rules (Rust `form_urlencoded`, identical to WHATWG `URLSearchParams`: `A-Za-z0-9*-._` literal, space→`+`, everything else `%XX` uppercase UTF-8, e.g. `,`→`%2C`, `:`→`%3A`, `~`→`%7E`). No `?` when no pair survives.
  - `ApiClient::post(path, body)` (:590) → body = `serde_json::to_string(body)` (compact; object keys alphabetically sorted); empty strings are NOT dropped from POST bodies.
  - Response handling (`handle_response`, :859): HTTP 429 → error `Rate limited — retry with backoff`; ≥500 → `Server error (HTTP <n>)`; empty body → `Empty response body (HTTP <n>). The requested operation may not be supported for the given parameters.` (402 empty → payment path); non-JSON → `HTTP <n> <reason>: <trimmed body>`; 402 → x402 retry; else `unwrap_envelope` (:175): bare JSON array → returned as-is; `code` == `"0"`/`0` → return `body.data` (missing → `null`); otherwise `API error (code=<code>): <msg>` (`msg` trimmed, empty → `unknown error`; code `50114` gets `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` appended).
  - Transport errors: connect/timeout → DoH failover retry loop (only when base URL is the compiled production one), else `Network unavailable — check your connection and try again: <reqwest error chain>`; other send errors → `request failed: <chain>`.
  - Invalid-token retry: when authenticated and the error contains `code=10001)`, `code=10008)`, `code=53017)`, `code=130100031)` or `invalid access token`/`access token invalid` → force refresh (`/priapi/v5/wallet/agentic/auth/refresh`) + resend once.
  - x402 auto-pay (core, `ensure_payment_config` :1257, `maybe_sign_payment` :1473): reads `$ONCHAINOS_HOME/payment_cache.json`; parses response header `ok-web3-openapi-pay: Basic=0|1;Premium=0|1;UserType=..`; when a tier is charging it lazily `GET /api/v6/dex/market/config` (endpoint→tier map + `accepts`); pre-signs `PAYMENT-SIGNATURE` for confirmed charging tiers, retries once on 402, and on a first-time flip returns `CliConfirming` (exit 2). Emits `MARKET_API_*` notifications into the output envelope. All g03 endpoints are `/api/v6/dex/...` and therefore subject to this (the only way a g03 command can authorise a payment).
- **JSON re-serialisation** (Cargo.toml: `serde_json = "1"` without `preserve_order`/`arbitrary_precision`): every object that passes through the CLI — including untouched upstream `data` — is re-emitted with **keys sorted by byte order** (e.g. `c, confirm, h, l, o, ts, vol, volUsd`); integers that fit u64/i64 are exact; other numbers go through f64 and are re-printed by serde/ryu (`1.0` stays `1.0`, `1e21` → `1e21`, integers > u64 become floats); strings escape only `"`, `\`, and U+0000–U+001F (`\b \f \n \r \t`, else `\u00xx` lowercase). A lite implementation must reproduce this with a lossless JSON parser.
- **Audit** `fn audit::log` (audit.rs:140): appends `{"ts","source":"cli","command":"<group> <leaf>","ok",...}` to `$ONCHAINOS_HOME/audit.jsonl` after every command (not part of stdout).

### 1. `commands::sink` helpers (owned outside this partition; exact behaviour relied upon here)

- `struct sink::CodedError` (sink.rs:29) — `{code, field?, message, data?, next_steps?}`; `CodedError::invalid_input(field, msg)` (:59) = code `invalid_input`. Rendered by main.rs as `{"error":msg,"errorCode":"invalid_input","errorField":field,"ok":false}`, exit 1.
- `fn sink::parse_duration_ms(s, flag, allow_zero=false)` (sink.rs:86) — `t = s.trim()`; `t == "0"` → `invalid --{flag} '{s}'; duration must be positive`; strip ONE suffix in order `d`(86 400 000) / `h`(3 600 000) / `m`(60 000) / `s`(1 000), none → `invalid --{flag} '{s}'; use e.g. 300s, 30m, 24h, 7d`; numeric part parsed as Rust `u64` (accepts a leading `+`, rejects `-`, spaces, empty) else the same "use e.g." message; value 0 → `... duration must be positive`; `checked_mul` overflow → `--{flag} '{s}' overflows`. (`{s}` is the untrimmed input.)
- `fn sink::resolve_since_window(since, now_ms)` (:127) → `ResolvedWindow {begin: now_ms.saturating_sub(dur), end: now_ms}`, serialises as `{"begin":<u64>,"end":<u64>}`.
- `fn sink::now_ms()` (:137) — wall-clock ms.
- `fn sink::parse_max_results(raw)` (:201) — `None` → None; `s.trim()` parsed as `u32` else CodedError(`max-results`, `--max-results must be an integer between 1 and 500, got '{s}'`); outside 1..=500 → CodedError(`max-results`, `--max-results must be between 1 and 500, got {n}`).
- `fn sink::auto_paginate(start_cursor, max_results, shape, fetch_page)` (:251), `MAX_PAGES = 10` (:196). Algorithm (as used by `social`, PageLevel mode):
  ```
  items=[]; cursor=start_cursor; pages=0; last=None
  loop:
    if pages >= 10: break
    attempted = cursor
    page = fetch_page(cursor)            # error → return {items, nextCursor: attempted, fetchedCount: len(items), partial: true,
                                         #   error: {code:"upstream_error", message:"page <pages+1> request failed: <err:#>", nextCursor?: attempted}}
    pages += 1
    page_items = page[items_key] if array
                 else page if array
                 else first array-valued field of page in sorted-key order
                 else []
    cont = page[cursor_key] as non-empty string, or number rendered as string, else None
    if page_items empty and cont non-empty: break
    items += page_items; last = cont
    if len(items) >= max_results: break
    if cont non-empty:
        if attempted == cont: return {items, nextCursor: cont, fetchedCount, partial: true,
            error:{code:"cursor_not_advancing", message:"upstream returned the same cursor '<c>' it was queried with; stopping to avoid re-fetching the same page", nextCursor: cont}}
        cursor = cont
    else: break
  return {items, nextCursor: last (null when None), fetchedCount: len(items)}   # PageLevel: no truncation (may exceed N)
  ```
  `Aggregated` (:183) serialised keys (sorted after `to_value`): `error?`, `fetchedCount`, `items`, `nextCursor` (always present, `null` allowed), `partial?` (only when true). `PartialError` keys: `code`, `message`, `nextCursor?` (`field` never set here).

### 2. Helpers owned by this partition (re-used by MCP / workflows / strategy)

| Helper | Location | Contract | External users |
|---|---|---|---|
| `market::fetch_price(client, address, chain_index)` | market.rs:227 | `POST /api/v6/dex/market/price` body `[{"chainIndex":ci,"tokenContractAddress":addr}]` → data | mcp/mod.rs:1222; `agentic_wallet/strategy/handlers.rs:176` |
| `market::fetch_prices(client, tokens, default_ci)` | market.rs:237 | batch body, see `market prices` | mcp/mod.rs:1241 |
| `market::kline_to_named_objects(data)` (private) | market.rs:266 | array-of-arrays → array of objects keyed `ts,o,h,l,c,vol,volUsd,confirm` (index ≥ 8 → key `unknown`, later ones overwrite); non-array candle / non-array data passed through unchanged | — |
| `market::fetch_kline(client, address, ci, bar, limit:u32)` | market.rs:290 | `GET /api/v6/dex/market/candles` + transform | mcp/mod.rs:1263 |
| `market::fetch_index(client, address, ci)` | market.rs:313 | `POST /api/v6/dex/index/current-price` | mcp/mod.rs:1319 |
| `market::fetch_portfolio_supported_chains` | market.rs:323 | `GET /api/v6/dex/market/portfolio/supported/chain` | mcp/mod.rs:2062 |
| `market::fetch_portfolio_overview(client, ci, addr, tf)` | market.rs:336 | `GET .../portfolio/overview` | mcp:2078; workflows/portfolio.rs:37 (`tf="4"`), workflows/wallet_analysis.rs:26-27 (`"3"`,`"4"`) |
| `market::fetch_portfolio_dex_history(...)` | market.rs:373 | window validation + `GET .../portfolio/dex-history` + `resolvedWindow` | mcp:2100 |
| `market::fetch_portfolio_recent_pnl(...)` | market.rs:478 | `GET .../portfolio/recent-pnl` | mcp:2128; workflows/wallet_analysis.rs:36 |
| `market::fetch_portfolio_token_pnl(...)` | market.rs:514 | `GET .../portfolio/token/latest-pnl` | mcp:2151 |
| `signal::fetch_chains` / `signal::fetch_list` | signal.rs:100 / :108 | see `signal *` | mcp:1330/1345; workflows/smart_money.rs:25, workflows/token_research.rs:47 |
| `social::strip_tweet_bodies(&mut v)` (private) | social.rs:25 | recursively delete keys `text`, `content`, `translatedContent` from every object at any depth (arrays walked) | vibe fetchers only |
| `social::push_if_present` / `push_owned` (private) | social.rs:561 / :570 | append `(key,val)` only when `Some` and non-empty | — |
| `social::finalize_news(...)` (private) | social.rs:589 | shared `--since` / `--max-results` / `limit` / `cursor` logic for the 3 news list endpoints (see `social news-latest`) | — |
| `social::fetch_news_* / fetch_sentiment_* / fetch_vibe_*` + `Social*Params` structs | social.rs:46-187, 678-840 | as per commands | mcp/mod.rs:1531-1651 |
| `leaderboard::resolve_leaderboard_wallet_type(s)` | leaderboard.rs:107 | exact, case-sensitive: `smartMoney→1`, `influencer→2`, `sniper→3`, `dev→4`, `fresh→5`, `pump→6`, anything else unchanged | mcp:2226 |
| `leaderboard::fetch_chains` / `fetch_list` | leaderboard.rs:93 / :121 | see `leaderboard *` | mcp:2209/2227 |
| `tracker::resolve_tracker_type(s)` | tracker.rs:85 | exact: `smart_money→1`, `kol→2`, `multi_address→3`, else unchanged | mcp:2172 |
| `tracker::fetch_activities(...)` | tracker.rs:96 | `GET /api/v6/dex/market/address-tracker/trades` | mcp:2181; workflows/wallet_analysis.rs:41 |
| `memepump::fetch_chains/fetch_token_list/fetch_token_details/fetch_aped_wallet/fetch_by_address` + `MemepumpTokenListParams` | memepump.rs:551-807 | see `memepump *` | mcp:1373-1510; workflows/new_tokens.rs:65-71, smart_money.rs:73-79, token_research.rs:73-91 (`fetch_by_address`) |
| `memepump::now_ms()` (private) | memepump.rs:32 | wall-clock ms (u64; 0 on clock error) | — |
| `memepump::is_numeric_zero(v)` (private) | memepump.rs:46 | string → `trim()` then Rust `f64` parse (accepts `0`, `0.0`, `0.00`, `-0`, `+0`, `0e0`, `.0`, `0.`) and `== 0.0`; unparseable (incl. `""`, `"null"`) → false; JSON number → `as_f64() == 0.0`; null/other → false | — |
| `memepump::nullify_zero_tags_if_new(token, received_at_ms)` (private) | memepump.rs:70 | see algorithm below | — |
| `memepump::apply_nullify_to_response(data, received_at_ms)` (private) | memepump.rs:115 | see algorithm below | — |

`nullify_zero_tags_if_new` (exact):
```
if received_at == 0: return
created = token.createdTimestamp: string → parse as u64 (strict, no trim; failure → 0)
          | JSON non-negative integer → value | anything else → 0
if created == 0 or created > received_at or received_at - created >= 2000: return
if token.tags is an object:
  for f in ["bundlersPercent","devHoldingsPercent","freshWalletsPercent",
            "insidersPercent","snipersPercent","suspectedPhishingWalletPercent"]:
     if f in tags and is_numeric_zero(tags[f]): tags[f] = null
```
`apply_nullify_to_response` (exact): if `data` is an array → apply to each element, stop. Else for key in `["list","data","items","signals"]`: if `data[key]` exists and is an array → apply to each element, stop; if it is an object → apply to it, stop; (other types → try next key). After the loop, if `data` is an object → apply to `data` itself. `received_at` = `memepump::now_ms()` captured once right after the HTTP response (after unwrap).

## Commands

Conventions used below:
- **STD-OK**: stdout `{"ok":true,"data":<D>}` + `\n`, exit 0 (optional trailing `"notifications":[...]` from core). `<D>` is the unwrapped upstream `data` with object keys re-sorted (see §0) unless a transform is stated.
- **STD-ERR(msg)**: stdout `{"ok":false,"error":"<msg>"}` + `\n`, exit 1.
- **CODED(field,msg)**: stdout `{"error":"<msg>","errorCode":"invalid_input","errorField":"<field>","ok":false}`, exit 1.
- **COMMON-ERRORS**: clap usage errors (missing required flag, unknown flag, bad `u32`) → clap message on **stderr**, exit 2, no HTTP; core client/transport/envelope errors listed in §0 → STD-ERR, exit 1; x402 first-charge → `{"confirming":true,...}` exit 2.
- **Auth** for every command in this group: **jwt-optional** — sends `Authorization: Bearer <access_token>` when a valid (or successfully refreshed) wallet-login JWT exists in the keyring, otherwise the same request anonymously. No session-key signature, no API key. (Relevant to the lite "same login flow" requirement: nothing in this group requires login; the only auth-coupled behaviours are the refresh call and the invalid-token retry in core.)
- **Side effects** for every command: read-only on the server. Local: reads `config.json`, `chain_cache.json` (when a chain is resolved), keyring tokens, `payment_cache.json`; core appends to `audit.jsonl` (and may write `payment_cache.json`, DoH cache, rotated keyring tokens). Caveat for all: if the account's market-API tier is charging and confirmed, core attaches an x402 `PAYMENT-SIGNATURE` (a payment authorisation) — that is the only fund-relevant path and is owned by core, not by these handlers.
- `<ci>` = chainIndex produced by `resolve_chain`. "empty dropped" = the core GET builder omits pairs whose value is `""`.

---

### `onchainos market price`  (hidden: no)
- Handler: market.rs:130-147 (`execute`, :127) → `fetch_price` market.rs:227.
- Options: `--address <ADDRESS>` String, required. `--chain <CHAIN>` Option<String> (local; also filled by the global `--chain`). Globals: `--dev` (hidden).
- Auth: jwt-optional.
- Steps:
  1. `ctx.client_async()` (auth resolution, DoH prepare) — happens BEFORE validation.
  2. `address = address.trim()`; if empty → error `Parameter --address cannot be empty` (no HTTP).
  3. `ci = resolve_chain(--chain)` if given, else `ctx.chain_index_or("ethereum")` (config `default_chain` → else `"1"`).
  4. `POST /api/v6/dex/market/price`, body exactly `[{"chainIndex":"<ci>","tokenContractAddress":"<trimmed address>"}]`.
  5. If the returned data is an empty JSON array → error `No price data found for address <trimmed address> on chain <ci>. Verify the token address is valid on this chain.`
- Output: STD-OK, `data` passthrough (normally an array of `{chainIndex, price, time, tokenContractAddress, ...}` — keys sorted). `null` data prints `"data":null`.
- Errors: exit 2 clap (`--address` missing); exit 1 `Parameter --address cannot be empty`; exit 1 `No price data found for address ... on chain ....`; COMMON-ERRORS.
- Side effects: read-only.
- Nondeterminism: none in the request (headers `device-id`/`device-name` per machine).
- Parity test cases:
  - SAFE `onchainos market price --address 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --chain ethereum` → body `[{"chainIndex":"1","tokenContractAddress":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}]`.
  - SAFE `onchainos --chain solana market price --address "  So11111111111111111111111111111111111111112 "` → body chainIndex `"501"`, address trimmed.
  - SAFE `onchainos market price --address "   "` → `{"ok":false,"error":"Parameter --address cannot be empty"}`, exit 1, no market request.
  - SAFE (mock returns `{"code":"0","data":[]}`) `onchainos market price --address 0xdead --chain 8453` → exit 1 `No price data found for address 0xdead on chain 8453. Verify the token address is valid on this chain.`
  - SAFE `onchainos market price --address 0xabc --chain Foo` → chainIndex `"Foo"` (passthrough, case kept).

### `onchainos market prices`  (hidden: no)
- Handler: market.rs:148-153 → `fetch_prices` market.rs:237.
- Options: `--tokens <TOKENS>` String, required ("comma-separated chainIndex:address pairs"). `--chain <CHAIN>` Option (default chain for pairs without a chain part).
- Auth: jwt-optional.
- Steps:
  1. `ctx.client_async()`.
  2. `default_ci = resolve_chain(--chain)` else `ctx.chain_index_or("ethereum")`.
  3. `tokens.split(',')` → for each piece `p = piece.trim()`: if `p` contains `:` → split at the FIRST `:` → `{"chainIndex": resolve_chain(left), "tokenContractAddress": right}` (left/right not re-trimmed); else `{"chainIndex": default_ci, "tokenContractAddress": p}`. Empty pieces (e.g. trailing comma) produce `{"chainIndex":default_ci,"tokenContractAddress":""}`.
  4. `POST /api/v6/dex/market/price` with that array (key order `chainIndex`, `tokenContractAddress`). No empty-result check.
- Output: STD-OK, passthrough.
- Errors: clap exit 2 when `--tokens` missing; COMMON-ERRORS.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos market prices --tokens 1:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee,501:So11111111111111111111111111111111111111112` → body `[{"chainIndex":"1",...},{"chainIndex":"501",...}]`.
  - SAFE `onchainos market prices --tokens "ethereum:0xA0b8, 0xC02a" --chain bsc` → `[{"chainIndex":"1","tokenContractAddress":"0xA0b8"},{"chainIndex":"56","tokenContractAddress":"0xC02a"}]`.
  - SAFE `onchainos market prices --tokens "0xabc,"` → second element has empty address.

### `onchainos market kline`  (hidden: no)
- Handler: market.rs:154-164 → `fetch_kline` market.rs:290 → `kline_to_named_objects` market.rs:266.
- Options: `--address <ADDRESS>` String required (not trimmed, not validated); `--bar <BAR>` String default `1H`; `--limit <LIMIT>` u32 default `100` (clap u32 parser: non-numeric / out of 0..=4294967295 → clap error exit 2; no max-299 enforcement client-side); `--chain` Option.
- Auth: jwt-optional.
- Steps: `ci` as in `market price` (default `ethereum`). `GET /api/v6/dex/market/candles?chainIndex=<ci>&tokenContractAddress=<address>&bar=<bar>&limit=<limit decimal>` (empty dropped). Transform: if data is an array, each element that is an array becomes an object `{ts:[0], o:[1], h:[2], l:[3], c:[4], vol:[5], volUsd:[6], confirm:[7]}` (values passthrough, index ≥ 8 → key `unknown`, last wins); non-array elements and non-array data unchanged.
- Output: STD-OK; each candle printed with sorted keys `{"c","confirm","h","l","o","ts","vol","volUsd"}` (e.g. `{"c":"1.5","confirm":"1","h":"2.0","l":"0.5","o":"1.0","ts":"1700000000000","vol":"10","volUsd":"15"}`).
- Errors: clap exit 2; COMMON-ERRORS.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos market kline --address So11111111111111111111111111111111111111112 --chain solana --bar 1H --limit 5` → `?chainIndex=501&tokenContractAddress=So111...112&bar=1H&limit=5`.
  - SAFE `onchainos market kline --address 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` → `bar=1H&limit=100`, chainIndex `1` (or config default).
  - SAFE (mock data `[["1700000000000","1.0","2.0","0.5","1.5","10","15","1"]]`) → data `[{"c":"1.5","confirm":"1","h":"2.0","l":"0.5","o":"1.0","ts":"1700000000000","vol":"10","volUsd":"15"}]`.
  - SAFE `onchainos market kline --address 0x1 --limit abc` → clap error exit 2, no HTTP.

### `onchainos market index`  (hidden: no)
- Handler: market.rs:165-170 → `fetch_index` market.rs:313.
- Options: `--address <ADDRESS>` required (empty string allowed = native token); `--chain` Option.
- Auth: jwt-optional.
- Steps: `ci` (default `ethereum`); `POST /api/v6/dex/index/current-price` body `[{"chainIndex":"<ci>","tokenContractAddress":"<address as given>"}]` (empty string kept in body). No empty-result check.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos market index --address 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --chain ethereum`.
  - SAFE `onchainos market index --address "" --chain solana` → body `[{"chainIndex":"501","tokenContractAddress":""}]`.

### `onchainos market portfolio-supported-chains`  (hidden: no)
- Handler: market.rs:171-173 → `portfolio_supported_chains` market.rs:329 → `fetch_portfolio_supported_chains` :323.
- Options: none (global `--chain` accepted and ignored).
- Auth: jwt-optional.
- Steps: `ctx.client_async()` is called twice (once in `execute`, once in the helper; only the second client sends). `GET /api/v6/dex/market/portfolio/supported/chain` (no query string).
- Output: STD-OK passthrough. Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos market portfolio-supported-chains`; SAFE `onchainos --chain solana market portfolio-supported-chains` (identical request).

### `onchainos market portfolio-overview`  (hidden: no)
- Handler: market.rs:174-180 → `portfolio_overview` :354 → `fetch_portfolio_overview` :336.
- Options: `--address <ADDRESS>` required; `--chain <CHAIN>` required (local); `--time-frame <TIME_FRAME>` String default `4` (1=1D,2=3D,3=7D,4=1M,5=3M; not validated).
- Auth: jwt-optional.
- Steps: double client construction; `ci = resolve_chain(--chain)`; `GET /api/v6/dex/market/portfolio/overview?chainIndex=<ci>&walletAddress=<address>&timeFrame=<tf>` (empty dropped).
- Output: STD-OK passthrough. Errors: clap exit 2 (missing `--address`/`--chain`); COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos market portfolio-overview --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum` → `timeFrame=4`.
  - SAFE `... --chain ethereum --time-frame 3`.
  - SAFE `onchainos market portfolio-overview --address 0xd8dA... --chain ethereum --time-frame ""` → no `timeFrame` pair.

### `onchainos market portfolio-dex-history`  (hidden: no)
- Handler: market.rs:181-205 → `portfolio_dex_history` :445 → `fetch_portfolio_dex_history` :373.
- Options: `--address` required; `--chain` required; `--begin` Option (ms); `--end` Option (ms); `--since` Option (`<int><s|m|h|d>`); `--limit` Option String (not validated); `--cursor` Option; `--token` Option; `--tx-type` Option (comma list, passthrough). No clap-level conflicts — enforced in code.
- Auth: jwt-optional.
- Steps:
  1. Double client construction; `ci = resolve_chain(--chain)`.
  2. `begin`/`end`/`since` are treated as absent when empty strings.
  3. If `since` present: if `begin` or `end` present → CODED(`since`, `--since is mutually exclusive with --begin/--end`). Else `now = sink::now_ms()`, `w = resolve_since_window(since, now)`; parse error → CODED(`since`, <parse message>, e.g. `invalid --since '10'; use e.g. 300s, 30m, 24h, 7d`); `begin=w.begin`, `end=w.end` (decimal strings).
  4. Else if both `begin` and `end` present → use them verbatim. Else → CODED(`since`, `supply --since <dur> OR --begin+--end`).
  5. `GET /api/v6/dex/market/portfolio/dex-history?chainIndex=<ci>&walletAddress=<address>&begin=<b>&end=<e>[&limit=][&cursor=][&tokenContractAddress=<--token>][&type=<--tx-type>]` (in this order; empty dropped).
  6. If `--since` was used and the returned data is a JSON object → insert `"resolvedWindow":{"begin":<u64>,"end":<u64>}` (numbers, not strings). Array/null data → nothing added.
- Output: STD-OK; passthrough (+ `resolvedWindow` as above).
- Errors: clap exit 2 (`--address`, `--chain`); CODED errors above (exit 1, stdout, no HTTP); COMMON-ERRORS.
- Side effects: read-only.
- Nondeterminism: with `--since`, `begin`/`end` query values and `data.resolvedWindow` derive from the wall clock (`end = now_ms`, `begin = end - dur`).
- Parity test cases:
  - SAFE `onchainos market portfolio-dex-history --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum --begin 1700000000000 --end 1710000000000 --limit 5 --tx-type 1,2` → `...&begin=1700000000000&end=1710000000000&limit=5&type=1%2C2`.
  - SAFE `... --chain ethereum --since 24h` → `end-begin == 86400000`; `data.resolvedWindow` present (compare with tolerance).
  - SAFE `... --chain ethereum --since 24h --begin 1` → `{"error":"--since is mutually exclusive with --begin/--end","errorCode":"invalid_input","errorField":"since","ok":false}` exit 1.
  - SAFE `... --chain ethereum --begin 1700000000000` → `{"error":"supply --since <dur> OR --begin+--end","errorCode":"invalid_input","errorField":"since","ok":false}` exit 1.
  - SAFE `... --chain ethereum --since 0` → CODED(`since`, `invalid --since '0'; duration must be positive`).

### `onchainos market portfolio-recent-pnl`  (hidden: no)
- Handler: market.rs:206-214 → `portfolio_recent_pnl` :498 → `fetch_portfolio_recent_pnl` :478.
- Options: `--address` required; `--chain` required; `--limit` Option (not validated); `--cursor` Option.
- Auth: jwt-optional.
- Steps: double client; `GET /api/v6/dex/market/portfolio/recent-pnl?chainIndex=<ci>&walletAddress=<address>[&limit=][&cursor=]`.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos market portfolio-recent-pnl --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum`; SAFE `... --limit 5 --cursor abc`.

### `onchainos market portfolio-token-pnl`  (hidden: no)
- Handler: market.rs:215-221 → `portfolio_token_pnl` :532 → `fetch_portfolio_token_pnl` :514.
- Options: `--address` required; `--chain` required; `--token` required.
- Auth: jwt-optional.
- Steps: double client; `GET /api/v6/dex/market/portfolio/token/latest-pnl?chainIndex=<ci>&walletAddress=<address>&tokenContractAddress=<token>`.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos market portfolio-token-pnl --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; SAFE same with `--token 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`.

---

### `onchainos signal chains`  (hidden: no)
- Handler: signal.rs:60 → `signal_chains` :176 → `fetch_chains` :100.
- Options: none (global `--chain` ignored).
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/signal/supported/chain`.
- Output: STD-OK passthrough. Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos signal chains`.

### `onchainos signal list`  (hidden: no)
- Handler: signal.rs:61-93 → `signal_list` :183 → `fetch_list` :108.
- Options (all `Option<String>` except `--chain`): `--chain` required; `--wallet-type` ("1,2,3" etc.); `--min-amount-usd`; `--max-amount-usd`; `--min-address-count`; `--max-address-count`; `--token-address`; `--min-market-cap-usd`; `--max-market-cap-usd`; `--min-liquidity-usd`; `--max-liquidity-usd`; `--limit`; `--cursor`.
- Auth: jwt-optional.
- Steps:
  1. `ci = resolve_chain(--chain)`; `ctx.client_async()` (before validation).
  2. If `--limit` given: parse as Rust `u64` (no trim; leading `+` ok) else error `--limit must be a number between 1 and 100`; not in 1..=100 → error `--limit must be between 1 and 100, got <n>` (STD-ERR, exit 1, no HTTP).
  3. `POST /api/v6/dex/market/signal/list` with a JSON object; all values are JSON strings; present keys (empty strings are sent as `""`): `chainIndex`=ci, `limit`=`--limit` or `"20"`, then when given: `cursor`, `walletType`, `minAmountUsd`, `maxAmountUsd`, `minAddressCount`, `maxAddressCount`, `tokenAddress`, `minMarketCapUsd`, `maxMarketCapUsd`, `minLiquidityUsd`, `maxLiquidityUsd`. Serialised key order is alphabetical: `chainIndex, cursor, limit, maxAddressCount, maxAmountUsd, maxLiquidityUsd, maxMarketCapUsd, minAddressCount, minAmountUsd, minLiquidityUsd, minMarketCapUsd, tokenAddress, walletType`.
- Output: STD-OK passthrough (list items carry a per-item `cursor` used for the next page).
- Errors: clap exit 2 (`--chain` missing); the two `--limit` messages (exit 1); COMMON-ERRORS.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos signal list --chain ethereum` → body `{"chainIndex":"1","limit":"20"}`.
  - SAFE `onchainos signal list --chain solana --wallet-type 1,2 --limit 3 --cursor abc --min-amount-usd 0` → `{"chainIndex":"501","cursor":"abc","limit":"3","minAmountUsd":"0","walletType":"1,2"}`.
  - SAFE `onchainos signal list --chain ethereum --limit 0` → `{"ok":false,"error":"--limit must be between 1 and 100, got 0"}` exit 1.
  - SAFE `onchainos signal list --chain ethereum --limit x` → `{"ok":false,"error":"--limit must be a number between 1 and 100"}` exit 1.

---

### `onchainos social news-latest`  (hidden: no)
- Handler: social.rs:371-400 → `fetch_news_latest` :678 → `finalize_news` :589.
- Options (all `Option<String>`, no client defaults): `--token-symbols`, `--begin`, `--end`, `--importance`, `--platform`, `--limit`, `--cursor`, `--detail-level`, `--language`, `--since`, `--max-results`. (Global `--chain` accepted, ignored.)
- Auth: jwt-optional.
- Steps (`finalize_news`, shared by the three news list commands):
  1. `ctx.client_async()`.
  2. `base` pairs (non-empty only, this order): `tokenSymbols`, `importance`, `platform`, `detailLevel`, `language`.
  3. If `--since` is given (ANY value, including `""`): if non-empty `--begin` or `--end` → CODED(`since`, `--since is mutually exclusive with --begin/--end`); else `w = resolve_since_window(since, now_ms())` (error → CODED(`since`, msg); note `--since ""` is NOT treated as absent here, it fails with `invalid --since ''; use e.g. 300s, 30m, 24h, 7d`); append `begin=<w.begin>`, `end=<w.end>`. Otherwise append non-empty `begin`, `end`.
  4. `max = parse_max_results(--max-results)` (CODED(`max-results`, ...) on failure) — validated after the since logic, before any request.
  5. Without `--max-results`: append non-empty `limit`, `cursor`; `GET /api/v6/dex/market/social/news/latest?<pairs>`; if since used and data is an object → add `resolvedWindow`. Output data = upstream data (normally `{articles:[...], cursor, ...}`; `content` is NOT stripped).
  6. With `--max-results N`: `auto_paginate(start=--cursor, N, {items_key:"list", cursor_key:"cursor", PageLevel})`; page request = `GET` same path with `base` (+ begin/end) + `limit` (if non-empty) + `cursor` (if Some; empty dropped by core). At most 10 requests. Items come from `page.list`, else the page if it is an array, else the first array-valued field in sorted-key order (for the real news shape that is `articles`); continuation = top-level `page.cursor`. Result object (sorted keys): `{"error"?,"fetchedCount","items","nextCursor","partial"?,"resolvedWindow"?}`. A failing page (any error, including a core `CliConfirming`) does NOT fail the command: `ok:true` with `partial:true` and `error.code="upstream_error"`, `error.message="page <k> request failed: <err>"`.
- Output: STD-OK as described.
- Errors: CODED (`since` / `max-results`) exit 1 no HTTP; COMMON-ERRORS (single-page mode only; paginated mode converts them to `partial`).
- Side effects: read-only (paginated mode performs up to 10 metered GETs).
- Nondeterminism: `--since` → clock-derived `begin`/`end`/`resolvedWindow`.
- Parity test cases:
  - SAFE `onchainos social news-latest --limit 5 --token-symbols BTC,ETH` → `?tokenSymbols=BTC%2CETH&limit=5`.
  - SAFE `onchainos social news-latest --since 0` → `{"error":"invalid --since '0'; duration must be positive","errorCode":"invalid_input","errorField":"since","ok":false}` exit 1.
  - SAFE `onchainos social news-latest --since 24h --begin 1000` → CODED(`since`, `--since is mutually exclusive with --begin/--end`).
  - SAFE `onchainos social news-latest --max-results 999` → CODED(`max-results`, `--max-results must be between 1 and 500, got 999`).
  - SAFE (mock: page1 `{articles:[a,b],cursor:"p2"}`, page2 `{articles:[c],cursor:""}`) `onchainos social news-latest --max-results 50 --limit 2` → 2 GETs (2nd with `&limit=2&cursor=p2`), data `{"fetchedCount":3,"items":[a,b,c],"nextCursor":null}`.

### `onchainos social news-by-symbol`  (hidden: no)
- Handler: social.rs:401-434 → `fetch_news_by_symbol` :700 → `finalize_news`.
- Options: `--token-symbols` String **required**; optional `--sort-by`, `--sentiment`, `--importance`, `--platform`, `--limit`, `--cursor`, `--detail-level`, `--begin`, `--end`, `--language`, `--since`, `--max-results`.
- Auth: jwt-optional.
- Steps: as `news-latest`, path `/api/v6/dex/market/social/news/by-symbol`, base pairs in order: `tokenSymbols` (always pushed; dropped by core only if `""`), `sortBy`, `sentiment`, `importance`, `platform`, `detailLevel`, `language`; then `begin`,`end`, then `limit`,`cursor`.
- Output / Errors / Side effects / Nondeterminism: as `news-latest`; clap exit 2 if `--token-symbols` missing.
- Parity test cases: SAFE `onchainos social news-by-symbol --token-symbols ETH --limit 5` → `?tokenSymbols=ETH&limit=5`; SAFE `onchainos social news-by-symbol --token-symbols BTC --sort-by 2 --sentiment 1 --begin 1721000000000 --end 1721086400000` → `?tokenSymbols=BTC&sortBy=2&sentiment=1&begin=1721000000000&end=1721086400000`.

### `onchainos social news-search`  (hidden: no)
- Handler: social.rs:435-470 → `fetch_news_search` :726 → `finalize_news`.
- Options: `--keyword` String **required**; optional `--sort-by`, `--sentiment`, `--importance`, `--platform`, `--token-symbols`, `--begin`, `--end`, `--detail-level`, `--limit`, `--cursor`, `--language`, `--since`, `--max-results`.
- Auth: jwt-optional.
- Steps: as `news-latest`, path `/api/v6/dex/market/social/news/search`, base order: `keyword`, `sortBy`, `sentiment`, `importance`, `platform`, `tokenSymbols`, `detailLevel`, `language`; then `begin`,`end`; then `limit`,`cursor`.
- Output / Errors / Side effects / Nondeterminism: as `news-latest`; clap exit 2 if `--keyword` missing.
- Parity test cases: SAFE `onchainos social news-search --keyword "ethereum upgrade" --limit 5` → `?keyword=ethereum+upgrade&limit=5`; SAFE `onchainos social news-search --keyword eth --since 7d --max-results 20`.

### `onchainos social news-detail`  (hidden: no)
- Handler: social.rs:471-482 → `fetch_news_detail` :752.
- Options: `--article-id` String required; `--language` Option.
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/social/news/detail?articleId=<id>[&language=<lang>]` (empty dropped).
- Output: STD-OK passthrough (full article `content` kept). Upstream returns `{articles:[...]}`; unknown id → empty `articles` with ok:true (test oracle).
- Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social news-detail --article-id BOGUS_DOES_NOT_EXIST_42`; SAFE `onchainos social news-detail --article-id 123 --language zh_CN`.

### `onchainos social news-platforms`  (hidden: no)
- Handler: social.rs:483-487 → `fetch_news_platforms` :762.
- Options: none. Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/social/news/platforms`.
- Output: STD-OK passthrough (`{platforms:[string,...]}`). Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social news-platforms`.

### `onchainos social sentiment-ranking`  (hidden: no)
- Handler: social.rs:488-501 → `fetch_sentiment_ranking` :769.
- Options: `--time-frame`, `--sort-by`, `--limit` (all optional strings, no defaults).
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/social/sentiment/ranking[?timeFrame=][&sortBy=][&limit=]` (non-empty only).
- Output: STD-OK passthrough (`{period, ts, details:[...]}` per oracle). Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social sentiment-ranking`; SAFE `onchainos social sentiment-ranking --time-frame 2 --sort-by 1 --limit 5`.

### `onchainos social sentiment-symbol`  (hidden: no)
- Handler: social.rs:502-515 → `fetch_sentiment_symbol` :783.
- Options: `--token-symbols` required; `--time-frame`, `--trend-points` optional.
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/social/sentiment/symbol?tokenSymbols=<s>[&timeFrame=][&trendPoints=]`.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social sentiment-symbol --token-symbols BTC,ETH --time-frame 1` → `?tokenSymbols=BTC%2CETH&timeFrame=1`; SAFE `onchainos social sentiment-symbol --token-symbols BTC --trend-points 8`.

### `onchainos social vibe-timeline`  (hidden: no)
- Handler: social.rs:516-533 → `fetch_vibe_timeline` :799 → `strip_tweet_bodies` :25.
- Options: `--chain` required (local); `--token-address` required; `--time-frame` optional.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain(--chain)`; `GET /api/v6/dex/market/social/vibe/timeline?chainIndex=<ci>&tokenAddress=<addr>[&timeFrame=]`; then recursively delete every `text`, `content`, `translatedContent` key at any depth.
- Output: STD-OK with stripped data.
- Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social vibe-timeline --chain solana --token-address So11111111111111111111111111111111111111112 --time-frame 1`; SAFE (mock data `{"summary":{"score":"78","text":"leak"},"kols":[{"handle":"a","content":"x","tweetUrl":"u"}]}`) → `{"kols":[{"handle":"a","tweetUrl":"u"}],"summary":{"score":"78"}}`.

### `onchainos social vibe-top-kols`  (hidden: no)
- Handler: social.rs:534-555 → `fetch_vibe_top_kols` :820 → `strip_tweet_bodies`.
- Options: `--chain` required; `--token-address` required; `--sort-by`, `--time-frame`, `--limit` optional.
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/social/vibe/top-kols?chainIndex=<ci>&tokenAddress=<addr>[&sortBy=][&timeFrame=][&limit=]`; strip as above.
- Output: STD-OK stripped. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos social vibe-top-kols --chain solana --token-address So11111111111111111111111111111111111111112 --time-frame 1 --limit 5`; SAFE `onchainos social vibe-top-kols --chain 1 --token-address 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --sort-by 2`.

---

### `onchainos memepump chains`  (hidden: no)
- Handler: memepump.rs:381 → `memepump_chains` :811 → `fetch_chains` :612.
- Options: none. Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/memepump/supported/chainsProtocol`.
- Output: STD-OK passthrough. Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos memepump chains`.

### `onchainos memepump tokens`  (hidden: no)
- Handler: memepump.rs:382-506 → `fetch_token_list` :619 → `apply_nullify_to_response` :115.
- Options: `--chain` required; `--stage` String default `NEW` (passed verbatim, not upper-cased); 54 optional string filters (below). No value validation.
- Auth: jwt-optional.
- Steps:
  1. `ctx.client_async()`; `ci = resolve_chain(--chain)`.
  2. `GET /api/v6/dex/market/memepump/tokenList` with pairs in this exact order (empty/absent dropped):
     `chainIndex`←`--chain`(resolved), `stage`←`--stage`, `walletAddress`←`--wallet-address`, `protocolIdList`←`--protocol-id-list`, `quoteTokenAddressList`←`--quote-token-address-list`, `minTop10HoldingsPercent`←`--min-top10-holdings-percent`, `maxTop10HoldingsPercent`←`--max-top10-holdings-percent`, `minDevHoldingsPercent`←`--min-dev-holdings-percent`, `maxDevHoldingsPercent`←`--max-dev-holdings-percent`, `minInsidersPercent`←`--min-insiders-percent`, `maxInsidersPercent`←`--max-insiders-percent`, `minBundlersPercent`←`--min-bundlers-percent`, `maxBundlersPercent`←`--max-bundlers-percent`, `minSnipersPercent`←`--min-snipers-percent`, `maxSnipersPercent`←`--max-snipers-percent`, `minFreshWalletsPercent`←`--min-fresh-wallets-percent`, `maxFreshWalletsPercent`←`--max-fresh-wallets-percent`, `minSuspectedPhishingWalletPercent`←`--min-suspected-phishing-wallet-percent`, `maxSuspectedPhishingWalletPercent`←`--max-suspected-phishing-wallet-percent`, `minBotTraders`←`--min-bot-traders`, `maxBotTraders`←`--max-bot-traders`, `minDevMigrated`←`--min-dev-migrated`, `maxDevMigrated`←`--max-dev-migrated`, `minMarketCapUsd`←`--min-market-cap`, `maxMarketCapUsd`←`--max-market-cap`, `minVolumeUsd`←`--min-volume`, `maxVolumeUsd`←`--max-volume`, `minTxCount`←`--min-tx-count`, `maxTxCount`←`--max-tx-count`, `minBondingPercent`←`--min-bonding-percent`, `maxBondingPercent`←`--max-bonding-percent`, `minHolders`←`--min-holders`, `maxHolders`←`--max-holders`, `minTokenAge`←`--min-token-age`, `maxTokenAge`←`--max-token-age`, `minBuyTxCount`←`--min-buy-tx-count`, `maxBuyTxCount`←`--max-buy-tx-count`, `minSellTxCount`←`--min-sell-tx-count`, `maxSellTxCount`←`--max-sell-tx-count`, `minTokenSymbolLength`←`--min-token-symbol-length`, `maxTokenSymbolLength`←`--max-token-symbol-length`, `hasAtLeastOneSocialLink`←`--has-at-least-one-social-link`, `hasX`←`--has-x`, `hasTelegram`←`--has-telegram`, `hasWebsite`←`--has-website`, `websiteTypeList`←`--website-type-list`, `dexScreenerPaid`←`--dex-screener-paid`, `liveOnPumpFun`←`--live-on-pump-fun`, `devSellAll`←`--dev-sell-all`, `devStillHolding`←`--dev-still-holding`, `communityTakeover`←`--community-takeover`, `bagsFeeClaimed`←`--bags-fee-claimed`, `minFeesNative`←`--min-fees-native`, `maxFeesNative`←`--max-fees-native`, `keywordsInclude`←`--keywords-include`, `keywordsExclude`←`--keywords-exclude`. (56 pairs max; note the four renamed ones: market-cap → `*MarketCapUsd`, volume → `*VolumeUsd`.)
  3. `received_at = now_ms()`; `apply_nullify_to_response(data, received_at)` (§2).
- Output: STD-OK; passthrough except the six tag fields of tokens created < 2000 ms before `received_at` whose value is numeric zero become `null`.
- Errors: clap exit 2 (`--chain` missing); COMMON-ERRORS.
- Side effects: read-only.
- Nondeterminism: nullification depends on local wall clock vs `createdTimestamp` (only tokens < 2 s old).
- Parity test cases:
  - SAFE `onchainos memepump tokens --chain solana` → `?chainIndex=501&stage=NEW`.
  - SAFE `onchainos memepump tokens --chain solana --stage MIGRATED --has-x true --min-market-cap 1000 --keywords-include "dog wif" --keywords-exclude 狗` → `?chainIndex=501&stage=MIGRATED&minMarketCapUsd=1000&hasX=true&keywordsInclude=dog+wif&keywordsExclude=%E7%8B%97`.
  - SAFE `onchainos memepump tokens --chain bsc --stage ""` → `?chainIndex=56` (empty stage dropped).
  - SAFE (mock returns `[{"createdTimestamp":"1","tags":{"snipersPercent":"0"}}]`) → unchanged output (old token).

### `onchainos memepump token-details`  (hidden: no)
- Handler: memepump.rs:507-511 → `memepump_token_details` :817 → `fetch_token_details` :749.
- Options: `--address` required; `--chain` Option; `--wallet` Option.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain(--chain)` else `ctx.chain_index_or("solana")` (config `default_chain`, else `"501"`); `ctx.client_async()`; `GET /api/v6/dex/market/memepump/tokenDetails?chainIndex=<ci>&tokenContractAddress=<address>[&walletAddress=<wallet>]`; `apply_nullify_to_response`.
- Output: STD-OK (nullify applied: object data → itself or `data/list/items/signals` wrapper).
- Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: clock-dependent nullify.
- Parity test cases: SAFE `onchainos memepump token-details --address <mint>` → chainIndex `501`; SAFE `onchainos memepump token-details --address <mint> --chain solana --wallet <addr>`.

### `onchainos memepump token-dev-info`  (hidden: no)
- Handler: memepump.rs:512-520 → `memepump_by_address` :849 → `fetch_by_address` :792.
- Options: `--address` required; `--chain` Option (default via `chain_index_or("solana")`).
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/memepump/tokenDevInfo?chainIndex=<ci>&tokenContractAddress=<address>`.
- Output: STD-OK passthrough (no nullify). Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos memepump token-dev-info --address <mint> --chain solana`; SAFE `onchainos --chain bsc memepump token-dev-info --address 0xabc` → chainIndex `56`.

### `onchainos memepump similar-tokens`  (hidden: no)
- Handler: memepump.rs:521-529 → `memepump_by_address` → `fetch_by_address`.
- Options/Auth/Steps: as `token-dev-info` with path `/api/v6/dex/market/memepump/similarToken`. No nullify.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos memepump similar-tokens --address <mint>`.

### `onchainos memepump token-bundle-info`  (hidden: no)
- Handler: memepump.rs:530-538 → `memepump_by_address` → `fetch_by_address`.
- Options/Auth/Steps: as `token-dev-info` with path `/api/v6/dex/market/memepump/tokenBundleInfo`. No nullify.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos memepump token-bundle-info --address <mint> --chain solana`.

### `onchainos memepump aped-wallet`  (hidden: no)
- Handler: memepump.rs:539-543 → `memepump_aped_wallet` :834 → `fetch_aped_wallet` :773.
- Options: `--address` required; `--chain` Option (default `solana` chain); `--wallet` Option.
- Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/memepump/apedWallet?chainIndex=<ci>&tokenContractAddress=<address>[&walletAddress=<wallet>]`. No nullify.
- Output: STD-OK passthrough. Errors: clap / COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos memepump aped-wallet --address <mint>`; SAFE `... --wallet <addr>`.

---

### `onchainos leaderboard supported-chains`  (hidden: no)
- Handler: leaderboard.rs:57 → `supported_chains` :99 → `fetch_chains` :93.
- Options: none. Auth: jwt-optional.
- Steps: `GET /api/v6/dex/market/leaderboard/supported/chain`.
- Output: STD-OK passthrough. Errors: COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos leaderboard supported-chains`.

### `onchainos leaderboard list`  (hidden: no)
- Handler: leaderboard.rs:58-88 → `leaderboard_list` :174 → `fetch_list` :121.
- Options: `--chain` required; `--time-frame` String required (1..5, not validated); `--sort-by` String required (1..5, not validated); optional `--wallet-type`, `--min-realized-pnl-usd`, `--max-realized-pnl-usd`, `--min-win-rate-percent`, `--max-win-rate-percent`, `--min-txs`, `--max-txs`, `--min-tx-volume`, `--max-tx-volume`.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain(--chain)`; client; `walletType = resolve_leaderboard_wallet_type(--wallet-type)`; `GET /api/v6/dex/market/leaderboard/list?chainIndex=<ci>&timeFrame=<tf>&sortBy=<sb>[&walletType=][&minRealizedPnlUsd=][&maxRealizedPnlUsd=][&minWinRatePercent=][&maxWinRatePercent=][&minTxs=][&maxTxs=][&minTxVolume=][&maxTxVolume=]`.
- Output: STD-OK passthrough. Errors: clap exit 2 (any of the 3 required missing); COMMON-ERRORS. Side effects: read-only. Nondeterminism: none.
- Parity test cases: SAFE `onchainos leaderboard list --chain ethereum --time-frame 3 --sort-by 1`; SAFE `... --wallet-type smartMoney` → `walletType=1`; SAFE `... --wallet-type SmartMoney` → `walletType=SmartMoney` (case-sensitive passthrough); SAFE `onchainos leaderboard list --chain ethereum --sort-by 1` → clap exit 2.

---

### `onchainos tracker activities`  (hidden: no)
- Handler: tracker.rs:51-79 → `tracker_activities` :150 → `fetch_activities` :96.
- Options: `--tracker-type` String required (`smart_money|1`, `kol|2`, `multi_address|3`, anything else passthrough); optional `--wallet-address`, `--trade-type`, `--chain`, `--min-volume`, `--max-volume`, `--min-holders`, `--min-market-cap`, `--max-market-cap`, `--min-liquidity`, `--max-liquidity`.
- Auth: jwt-optional.
- Steps:
  1. `resolved = resolve_tracker_type(--tracker-type)`; if `resolved == "3"` and `--wallet-address` was not given (absent; `""` counts as given) → error `--wallet-address is required when --tracker-type is multi_address` (before client creation, no HTTP).
  2. `chainIndex = resolve_chain(--chain)` only when `--chain` present (no config/default fallback).
  3. Client; `GET /api/v6/dex/market/address-tracker/trades?trackerType=<resolved>[&walletAddress=][&tradeType=][&chainIndex=][&minVolume=][&maxVolume=][&minHolders=][&minMarketCap=][&maxMarketCap=][&minLiquidity=][&maxLiquidity=]`.
- Output: STD-OK passthrough (array or `{trades:[...]}` per oracle).
- Errors: clap exit 2 (`--tracker-type` missing); exit 1 multi_address message; COMMON-ERRORS.
- Side effects: read-only. Nondeterminism: none.
- Parity test cases:
  - SAFE `onchainos tracker activities --tracker-type smart_money` → `?trackerType=1`.
  - SAFE `onchainos tracker activities --tracker-type kol --chain solana --trade-type 1 --min-volume 1000` → `?trackerType=2&tradeType=1&chainIndex=501&minVolume=1000`.
  - SAFE `onchainos tracker activities --tracker-type multi_address --wallet-address 0xd8da6bf26964af9d7eed9e03e53415d37aa96045,0xab5801a7d398351b8be11c439e05c5b3259aec9b` → `trackerType=3&walletAddress=0xd8da...%2C0xab58...`.
  - SAFE `onchainos tracker activities --tracker-type 3` → `{"ok":false,"error":"--wallet-address is required when --tracker-type is multi_address"}` exit 1.

## Endpoint classification (this group)

| Method | Path | Class | Used by |
|---|---|---|---|
| POST | `/api/v6/dex/market/price` | read | market price, market prices |
| GET | `/api/v6/dex/market/candles` | read | market kline |
| POST | `/api/v6/dex/index/current-price` | read | market index |
| GET | `/api/v6/dex/market/portfolio/supported/chain` | read | market portfolio-supported-chains |
| GET | `/api/v6/dex/market/portfolio/overview` | read | market portfolio-overview |
| GET | `/api/v6/dex/market/portfolio/dex-history` | read | market portfolio-dex-history |
| GET | `/api/v6/dex/market/portfolio/recent-pnl` | read | market portfolio-recent-pnl |
| GET | `/api/v6/dex/market/portfolio/token/latest-pnl` | read | market portfolio-token-pnl |
| GET | `/api/v6/dex/market/signal/supported/chain` | read | signal chains |
| POST | `/api/v6/dex/market/signal/list` | read | signal list |
| GET | `/api/v6/dex/market/social/news/latest` | read | social news-latest |
| GET | `/api/v6/dex/market/social/news/by-symbol` | read | social news-by-symbol |
| GET | `/api/v6/dex/market/social/news/search` | read | social news-search |
| GET | `/api/v6/dex/market/social/news/detail` | read | social news-detail |
| GET | `/api/v6/dex/market/social/news/platforms` | read | social news-platforms |
| GET | `/api/v6/dex/market/social/sentiment/ranking` | read | social sentiment-ranking |
| GET | `/api/v6/dex/market/social/sentiment/symbol` | read | social sentiment-symbol |
| GET | `/api/v6/dex/market/social/vibe/timeline` | read | social vibe-timeline |
| GET | `/api/v6/dex/market/social/vibe/top-kols` | read | social vibe-top-kols |
| GET | `/api/v6/dex/market/memepump/supported/chainsProtocol` | read | memepump chains |
| GET | `/api/v6/dex/market/memepump/tokenList` | read | memepump tokens |
| GET | `/api/v6/dex/market/memepump/tokenDetails` | read | memepump token-details |
| GET | `/api/v6/dex/market/memepump/tokenDevInfo` | read | memepump token-dev-info |
| GET | `/api/v6/dex/market/memepump/similarToken` | read | memepump similar-tokens |
| GET | `/api/v6/dex/market/memepump/tokenBundleInfo` | read | memepump token-bundle-info |
| GET | `/api/v6/dex/market/memepump/apedWallet` | read | memepump aped-wallet |
| GET | `/api/v6/dex/market/leaderboard/supported/chain` | read | leaderboard supported-chains |
| GET | `/api/v6/dex/market/leaderboard/list` | read | leaderboard list |
| GET | `/api/v6/dex/market/address-tracker/trades` | read | tracker activities |
| GET | `/api/v6/dex/market/config` | read | core `ApiClient::ensure_payment_config` — any g03 command, only when a pay tier is charging and the cache is stale |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | core `ApiClient::new_async` / invalid-token retry — any g03 command, only with an expired or server-invalidated JWT |

## External hosts

None are contacted by code in this partition. Indirectly via core `ApiClient`: `https://beta.okex.org` (hidden `--dev`); DoH failover (`doh/binary.rs:45-48`) may download the `okx-pilot` helper from `https://static.okx.com/upgradeapp/tools/pilot`, `https://static.coinall.ltd/upgradeapp/tools/pilot`, `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`, `https://static.jingyunyilian.com/upgradeapp/tools/pilot`, and then route requests through dynamically resolved proxy node hosts (`https://<node.host>`). Production base URL is `https://web3.okx.com` (compiled default; this checkout's `cli/.env` points `OKX_BASE_URL` at the mock `http://127.0.0.1:18899`, which also disables DoH).

## Open questions

1. clap 4: does a `--chain` given only at the top level (`onchainos --chain ethereum signal list`) satisfy a leaf's *required* local `--chain` (signal list, leaderboard list, memepump tokens, market portfolio-*, social vibe-*)? Reading clap's order (leaf required-validation before global propagation) suggests it does NOT (clap usage error, exit 2). Check against the real binary.
2. Stale oracle: `tests/cli_market.rs` `market_portfolio_dex_history_missing_begin_fails` / `_missing_end_fails` expect stderr containing `required`, but the source returns the coded stdout error `supply --since <dur> OR --begin+--end` (exit 1). This spec follows the source.
3. `social news-*` `--max-results`: `PageShape.items_key` is `"list"` while the live payload uses `articles`; aggregation relies on the "first array field in sorted-key order" fallback. If the upstream payload ever gains an array key that sorts before `articles`, upstream would aggregate that key instead; the lite port must copy the fallback exactly.
4. In `--max-results` mode a core x402 first-charge `CliConfirming` (normally exit 2) is swallowed into `partial:true` with `error.message` `page 1 request failed: confirming: `. Probably unintended upstream; replicate for parity?
5. `market portfolio-*` build the `ApiClient` twice, so with an expired JWT whose refresh fails, the refresh POST and the stderr warning happen twice. Replicate the duplication?
6. The exact text after `Network unavailable — check your connection and try again: ` / `request failed: ` is reqwest's error chain; a Node port can't match it byte-for-byte. The harness should compare only the prefix.
7. The relayed user request mentions supporting "the muse"; nothing in this partition references it. The only login-related behaviour here is jwt-optional auth (Bearer JWT when logged in, with refresh and invalid-token retry; anonymous otherwise).
