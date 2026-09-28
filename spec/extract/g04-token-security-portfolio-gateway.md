# g04-token-security-portfolio-gateway — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: every leaf under `onchainos token …`, `onchainos security …`, `onchainos portfolio …`,
`onchainos gateway …`, plus the shared risk-classification module `commands/risk_classify.rs`
(also consumed by `swap quote` / `swap swap`, which belong to another group).
No command in this partition is hidden (`hide = true` does not occur in any of the five files).
The only hidden flag reachable from these commands is the top-level global `--dev` (core, see §C.1).

---

## Sources read

Partition files (read fully, including `#[cfg(test)]` modules):

| File | Lines |
|---|---|
| `cli/src/commands/token.rs` | 1197 |
| `cli/src/commands/security.rs` | 929 |
| `cli/src/commands/risk_classify.rs` | 535 |
| `cli/src/commands/portfolio.rs` | 200 |
| `cli/src/commands/gateway.rs` | 281 |

Supporting files consulted (only to summarise helpers owned elsewhere; ranges noted):

| File | Lines | Read |
|---|---|---|
| `cli/src/main.rs` | 316 | full (CLI struct, global args, dispatch, exit-code mapping) |
| `cli/src/commands/mod.rs` | 134 | full (`Context`) |
| `cli/src/client.rs` | 2469 | 1–1800 (ApiClient: auth, headers, GET/POST, envelope, payment hooks) |
| `cli/src/chains.rs` | 623 | full |
| `cli/src/commands/sink.rs` | 1022 | 1–375, 700–900 (CodedError, parse_max_results, auto_paginate + tests) |
| `cli/src/output.rs` | 450 | 1–170 (envelopes) |
| `cli/src/wallet_store.rs` | 848 | 1–400 (wallets.json, cache.json, chain_cache.json) |
| `cli/src/keyring_store.rs` | 404 | `read_blob`, `get`, `get_opt`, `store` |
| `cli/src/wallet_api.rs` | 2874 | 1–130, 640–1000, 1170–1440, 1535–1570 (WalletApiClient) |
| `cli/src/commands/agentic_wallet/chain.rs` | 175 | full |
| `cli/src/commands/agentic_wallet/account.rs` | 476 | `resolve_active_account_id` (403–416) |
| `cli/src/config.rs` | 66 | full |
| `cli/src/endpoints.rs` | 65 | full |
| `cli/build.rs` | 59 | 1–59 |
| `cli/src/audit.rs` | 1405 | redaction lists + command naming |
| `cli/src/doh/binary.rs` | — | CDN host list only |
| `cli/tests/cli_token.rs` | 1095 | full (oracle) |
| `cli/tests/cli_security.rs` | 291 | full (oracle) |
| `cli/tests/cli_portfolio.rs` | 180 | full (oracle) |
| `cli/tests/cli_gateway.rs` | 189 | full (oracle) |
| `cli/tests/common/mod.rs` | 328 | helpers (`assert_error_contains`, token constants) |

Empirical check: clap parse behaviour (global `--chain` propagation, clap error texts) was
verified offline against an installed `onchainos 4.4.10` binary (same `clap` major; parse errors
exit before any I/O). Nothing under `upstream/` was modified.

---

## Shared helpers (used across groups or from core)

### A. Cross-cutting behaviour that every command here depends on (needed for byte parity)

**A.1 JSON key ordering.** `serde_json` is built WITHOUT `preserve_order` (Cargo.lock: serde_json
1.0.149 deps = itoa, memchr, serde, serde_core, zmij — no indexmap). Every `serde_json::Value`
object is a `BTreeMap`, so:
- every request body built with `json!{…}` is serialised with keys sorted by byte order;
- every backend response that is passed through is re-serialised with keys sorted (backend key order is lost);
- every derived object (`token report`, classified `token-scan`, `--max-results` aggregate, coded errors) is key-sorted.
The only exception is the top-level success/error envelope, which is a Rust struct (field order `ok`, `data`, `error`, `notifications`).

**A.2 Output envelopes** (`output.rs`, core). Printed to **stdout** with `println!` (trailing `\n`), compact JSON
(pretty only when env `ONCHAINOS_PRETTY=1`, via `serde_json::to_string_pretty`).
- success: `{"ok":true,"data":<data>}`; `"notifications":[…]` appended only when payment events were queued (core `payment_notify::drain_events`). `data` = `null` is printed as `"data":null`.
- generic error (any `anyhow` error not downcast to a special type): `{"ok":false,"error":"<format!(\"{e:#}\")>"}` — `{e:#}` joins anyhow context chain as `outer: inner: …`. Exit code **1**.
- coded error (`sink::CodedError`): a `json!` Value, therefore key-sorted: `{"error":"<msg>","errorCode":"<code>","errorField":"<field>","ok":false}` (+`data`,`nextSteps`,`notifications` when present). Exit **1**.
- `CliConfirming` (payment first-charge prompt raised inside ApiClient, core): exit **2**; format owned by core.
- clap parse errors: printed to **stderr** by clap, exit **2** (see A.5).

**A.3 GET query building** (`ApiClient::build_get_url_and_request_path`, client.rs:413, core).
Pairs whose value is the empty string are **dropped**; remaining pairs keep the order given by the
caller; encoding is `application/x-www-form-urlencoded` (`url::form_urlencoded`): `A–Z a–z 0–9 * - . _`
literal, space → `+`, everything else `%XX` uppercase (so `,`→`%2C`, `:`→`%3A`, `+`→`%2B`, `狗`→`%E7%8B%97`).
`WalletApiClient` uses `build_query_string` (wallet_api.rs:106): same empty-value dropping and same value
encoding; keys are emitted raw.

**A.4 POST body.** `serde_json::to_string(body)` (compact, sorted keys per A.1), sent with header
`Content-Type: application/json`.

**A.5 clap behaviour relevant here** (verified on 4.4.10):
- Global option `--chain <CHAIN>` (`Cli.chain`, `global = true`, main.rs:47) is accepted at every level.
  When a leaf declares its own arg with id `chain` (e.g. `token info --chain`, `security approvals --chain`),
  the leaf arg **shadows** the global in `--help`, but values still propagate both ways:
  `onchainos --chain X token info …` fills the leaf's local `chain` with `X`, and `token info --chain X`
  also sets `Cli.chain` (→ `Context.chain_override`). Verified: `onchainos --chain "," security approvals --address 0xabc`
  → `{"ok":false,"error":"No supported chains found"}` (same as passing `--chain ","` on the leaf).
- A **required** leaf `--chain` (gateway *, security tx-scan/sig-scan) is NOT satisfied by a global
  `--chain` placed before the subcommand: `onchainos --chain ethereum gateway gas` → stderr
  `error: the following required arguments were not provided:\n  --chain <CHAIN>\n\nUsage: onchainos gateway gas --chain <CHAIN>\n\nFor more information, try '--help'.`, exit 2 (binary name in `Usage:` is argv[0]-derived, e.g. `onchainos.exe` on Windows).
- Leaves without their own `--chain` still accept the global `--chain` (listed in `--help`); for
  `portfolio *`, `gateway chains`, `token cluster-supported-chains`, `security dapp-scan` it is accepted and ignored.
- Hidden global `--dev` (bool flag, main.rs:43) → `endpoints::set_dev_mode(true)` → base URL `https://beta.okex.org`.
- Typed value errors (exact clap texts): `u8` → `error: invalid value '300' for '--tag-filter <TAG_FILTER>': 300 is not in 0..=255` / `…: invalid digit found in string`; `bool` (`Option<bool>`) → `error: invalid value 'yes' for '--exclude-risk <EXCLUDE_RISK>'\n  [possible values: true, false]`; missing value → `error: a value is required for '--query <QUERY>' but none was supplied`; conflicts → `error: the argument '--tokens <TOKENS>' cannot be used with '--address <ADDRESS>'`; a value starting with `-` on an option without `allow_hyphen_values` → `error: unexpected argument '-5' found` (the `--opt=-5` form is accepted). All exit 2, stderr, followed by `\n\nFor more information, try '--help'.` (with a `Usage:` block for missing/unexpected-argument/conflict errors).

### B. Core helpers used by this group (owned elsewhere — summary only)

- `fn commands::Context::new` (commands/mod.rs:37) — loads `AppConfig` from `$ONCHAINOS_HOME/config.json` (snake_case field `default_chain`; missing/invalid → default) and stores `chain_override = Cli.chain`.
- `fn Context::chain_index_or(default)` (commands/mod.rs:70) — `resolve_chain(chain_override ?? config.default_chain(if non-empty) ?? default)`.
- `fn Context::resolve_chains_or(explicit, default)` (commands/mod.rs:78) — `explicit` (raw, unresolved) ?? `resolve_chain(chain_override)` ?? `default` (literal). Ignores `config.default_chain`.
- `fn Context::client_async` (commands/mod.rs:53) → `ApiClient::new_async` (client.rs:246): reads keyring `access_token`; none/empty → Anonymous; JWT `exp` (base64url payload, no signature check) in future → `Authorization: Bearer <jwt>`; expired → if keyring `refresh_token` present and not expired → `wallet_api::force_refresh_access_token` (POST `/priapi/v5/wallet/agentic/auth/refresh`, stores rotated tokens) else Anonymous; stderr lines possible: `Session expired. Please log in again: onchainos wallet login` and `Failed to refresh session (<err>). Falling back to anonymous access.` Builds reqwest client (10 s timeout, DoH `DohManager::prepare`, UA from DoH manager).
- Base headers (`ApiClient::anonymous_headers`, client.rs:346): `Content-Type: application/json`, `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <id>` (when available), `device-name: <name>`; JWT mode adds `Authorization: Bearer <token>`.
- `fn ApiClient::get` / `post` (client.rs:442/590) — (1) `ensure_payment_config` (may GET `/api/v6/dex/market/config` only when a charging flag is set; reads/writes `$ONCHAINOS_HOME/payment_cache.json`); (2) pre-sign x402 payment header when the path is on a confirmed charging tier; (3) send with DoH failover loop on connect/timeout; (4) `handle_response`: 429 → `Rate limited — retry with backoff`; ≥500 → `Server error (HTTP <n>)`; empty body → `Empty response body (HTTP <n>). The requested operation may not be supported for the given parameters.`; non-JSON → `HTTP <n> <reason>: <trimmed text>`; 402 → payment retry flow (core); bare JSON array → returned as-is; `code` `"0"`/`0` → returns `data` (can be `null`); else `API error (code=<code>): <msg>` (msg trimmed, empty → `unknown error`; code `50114` appends `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.`); (5) in JWT mode, errors carrying codes `10001|10008|53017|130100031` (or text `invalid access token`/`access token invalid`) → force-refresh + retry once. Network failure after DoH exhaustion → `Network unavailable — check your connection and try again: <reqwest error>`.
- `fn ApiClient::post_no_retry_with_headers` (client.rs:725) — used only by `gateway broadcast`: NO `ensure_payment_config`, NO payment pre-sign, NO 402 retry, NO invalid-token retry, NO DoH retry; connect/timeout → DoH `handle_failure` then error `Network error during broadcast — transaction was NOT sent. Safe to retry the same command.: <reqwest error>`; other send errors → `request failed: <err>`; response handled by the same `handle_response`.
- `fn chains::resolve_chain(name)` (chains.rs:129) — `lower = name.to_lowercase()`; (1) if `$ONCHAINOS_HOME/chain_cache.json` parses, first entry whose `chainName.to_lowercase() == lower` → its `chainIndex` (string, or integer rendered as string); (2) alias table: `ethereum|eth→1`, `solana|sol→501`, `bitcoin|btc→0`, `bsc|bnb→56`, `polygon|matic→137`, `arbitrum|arb→42161`, `base→8453`, `xlayer|x layer|x-layer|okb→196`, `xlayer_test→1952`, `avalanche|avax→43114`, `optimism|op→10`, `fantom|ftm→250`, `sui→784`, `tron|trx→195`, `ton→607`, `linea→59144`, `scroll→534352`, `zksync→324`, `tempo→4217`; (3) otherwise the ORIGINAL input unchanged (not trimmed, not lowercased).
- `fn chains::resolve_chains(names)` (chains.rs:262) — `names.split(',')` → each `trim()` → `resolve_chain` → `join(",")` (an empty input yields `""`).
- `fn chains::chain_family(ci)` (chains.rs:272) — `"501"` → `"solana"`, anything else → `"evm"` (Tron/Sui/TON/Bitcoin included).
- `fn sink::parse_max_results(raw)` (sink.rs:201) — `None` → `None`; else `s.trim()` parsed as `u32`: parse failure → `CodedError{code:"invalid_input", field:"max-results", message:"--max-results must be an integer between 1 and 500, got '<trimmed>'"}`; outside `1..=500` → `CodedError{…, message:"--max-results must be between 1 and 500, got <n>"}`.
- `fn sink::auto_paginate` (sink.rs:251) — exact algorithm reproduced in §D.1 because it determines request count and output.
- `fn agentic_wallet::chain::get_all_chains` (agentic_wallet/chain.rs:31) — if `$ONCHAINOS_HOME/chain_cache.json` has non-empty `chains` and `now - updated_at < 600` s → cached list; else `WalletApiClient::post_public("/priapi/v5/wallet/agentic/chain/support/list", {})` (anonymous headers, body `{}`), list = `data` if array else `data.chainList` else `[]`; then `set_chain_cache` writes `{"updated_at":<unix s>,"chains":[…]}` (pretty JSON, tmp+rename) — a write failure is an error.
- `fn agentic_wallet::chain::get_real_chain_index(ci)` (agentic_wallet/chain.rs:56) — entry of `get_all_chains()` whose `chainIndex` (string or int) equals `ci`; none → `Chain index <ci> not found in supported chains`; `realChainIndex` string parsed as u64, or JSON u64; else `Cannot resolve realChainIndex for chain index <ci>`. Returns u64.
- `fn agentic_wallet::account::resolve_active_account_id(wallets)` (account.rs:403) — `selected_account_id` if non-empty → first `accounts[]` with `is_default` → first key of `accounts_map` (a `HashMap`: arbitrary when >1) → error `no wallet accounts found`.
- `fn wallet_store::load_wallets` (wallet_store.rs:179) — `$ONCHAINOS_HOME/wallets.json`; absent → `None`; unreadable → `failed to read wallets.json: …`; unparsable → `failed to parse wallets.json: …`.
- `fn wallet_store::get_swap_trace_id` (wallet_store.rs:252) — `$ONCHAINOS_HOME/cache.json` field `swapTraceId` (camelCase); written by the swap group.
- `fn keyring_store::get(key)` (keyring_store.rs:182) — OS keyring blob (file keyring on Linux / when forced); missing key → `keyring key '<key>' not found`.
- `fn WalletApiClient::get_authed` (wallet_api.rs:1242) — GET with base headers + `Authorization: Bearer <token>`, 30 s timeout, DoH failover; response: ≥500 → `Wallet API server error (HTTP <n>): <raw>`; non-JSON → `failed to parse wallet API response as JSON (HTTP <n>): <≤500-byte preview>: <serde err>`; code≠0 → `Wallet API error (code=<code>): <msg>` (msg from `msg|errorMessage|error_message|message|detailMsg`, else ≤200-char body preview plus an stderr line `[WalletAPI] no msg field in error response (HTTP <n>), raw body: <body>`); invalid-token codes → force-refresh + retry once.
- `fn audit::log` (audit.rs:140) — appends to `$ONCHAINOS_HOME/audit.jsonl` after every command with name `"<group> <leaf>"` and redacted argv (`--signed-tx`, `--data`, `--message` → `[REDACTED]`; `--from`, `--address` → first6+`***`+last4, or `[REDACTED]` if ≤10 chars).

### C. Helpers OWNED by this group (pub, reused by MCP / workflows / other groups)

C.1 `fn token::finalize_token_page(client, path, base, cursor, max_results)` (token.rs:571, private) — see §D.1.

C.2 `pub async fn token::fetch_search(client, query, chains, limit, cursor, max_results)` (token.rs:614) — `resolved = resolve_chains(chains)`; if `limit` is `Some(s)`: `s.parse::<u64>()` (no trim; Rust accepts a leading `+`) failing → `--limit must be a number between 1 and 100`; not in `1..=100` → `--limit must be between 1 and 100, got <n>`; base query `[("chains",resolved),("search",query as given — untrimmed),("limit", limit ?? "20" — original string)]`; → `finalize_token_page(GET /api/v6/dex/market/token/search)`. Also used by `wallet receive` (agentic_wallet/receive.rs:50), `workflow token-research` (limit "5"), MCP.

C.3 `pub async fn token::fetch_info(client, address, chain_index)` (token.rs:648) — `POST /api/v6/dex/market/token/basic-info`, body `[{"chainIndex":"<ci>","tokenContractAddress":"<address>"}]`. Used by swap, cross-chain, payment quote, strategy, agent task util, MCP.

C.4 `pub async fn token::fetch_holders(client, address, ci, tag_filter:Option<u8>, limit, cursor, max_results)` (token.rs:656) — same `--limit` validation as C.2; base `[chainIndex, tokenContractAddress, tagFilter (u8.to_string() or "" → dropped), limit (?? "20")]`; `finalize_token_page(GET /api/v6/dex/market/token/holder)`.

C.5 `pub async fn token::fetch_liquidity(client, address, ci)` (token.rs:692) — `GET /api/v6/dex/market/token/top-liquidity?chainIndex=<ci>&tokenContractAddress=<address>`.

C.6 `pub async fn token::fetch_price_info(client, address, ci)` (token.rs:709) — `POST /api/v6/dex/market/price-info`, body `[{"chainIndex":"<ci>","tokenContractAddress":"<address>"}]`.

C.7 `pub async fn token::fetch_security(client, address, ci)` (token.rs:720) — `POST /api/v6/security/token-scan`, body `{"source":"onchain_os_cli","tokenList":[{"chainId":"<ci>","contractAddress":"<address>"}]}`. Used by `token report` and workflows (new_tokens, smart_money).

C.8 `pub struct token::HotTokensParams` (token.rs:734) + `pub async fn fetch_hot_tokens` (token.rs:831) — see `token hot-tokens`. MCP deserialises the same struct.

C.9 `pub async fn token::fetch_advanced_info` (token.rs:956) — `GET /api/v6/dex/market/token/advanced-info?chainIndex&tokenContractAddress`.

C.10 `pub async fn token::fetch_top_trader` (token.rs:973) — identical to C.4 but path `/api/v6/dex/market/token/top-trader`.

C.11 `pub async fn token::fetch_token_trades(client, address, ci, limit:u32, tag_filter, wallet_filter)` (token.rs:1009) — `GET /api/v6/dex/market/trades` query `[chainIndex, tokenContractAddress, limit=<u32>, tagFilter=<raw or "">, walletAddressFilter=<raw or "">]`.

C.12 `pub async fn token::fetch_cluster_supported_chains` (token.rs:1050) — `GET /api/v6/dex/market/token/cluster/supported/chain` (no query).

C.13 `pub async fn token::fetch_cluster_by_address(client, path, address, ci)` (token.rs:1063) — `GET <path>?chainIndex&tokenContractAddress` for `/api/v6/dex/market/token/cluster/overview` and `/api/v6/dex/market/token/cluster/list`.

C.14 `pub async fn token::fetch_cluster_top_holders(client, address, ci, range_filter)` (token.rs:1081) — `GET /api/v6/dex/market/token/cluster/top-holders?chainIndex&tokenContractAddress&rangeFilter`.

C.15 `pub async fn token::fetch_report(client, address, ci)` + `fn compose_report` (token.rs:1119/1163) — see `token report`. Used by `workflow token-research`.

C.16 `pub async fn portfolio::fetch_chains` / `fetch_total_value` / `fetch_all_balances` / `fetch_token_balances` (portfolio.rs:115/120/143/169) — see portfolio commands. `fetch_all_balances` is reused by cross-chain, payment quote, workflows (portfolio, wallet_analysis); `fetch_total_value` by workflow portfolio; all four by MCP.

C.17 `pub async fn gateway::fetch_gas` / `fetch_gas_limit` / `fetch_simulate` / `fetch_broadcast` / `fetch_orders` / `fetch_chains` (gateway.rs:159/169/192/213/261/277) — see gateway commands; all reused by MCP.

C.18 Security private helpers (security.rs): `token_scan_explicit` (236), `fetch_tokens_from_wallet` (280), `fetch_tokens_by_address` (306), `run_batch_scan` (331), `classify_tokens` (378), `emit_token_scan` (411), `extract_token_pairs` (425) — algorithms in `security token-scan`. `const BATCH_SIZE = 50` (security.rs:13).

C.19 Risk classification (`commands/risk_classify.rs`, `pub(crate)`):
- `enum TradeDirection {Buy, Sell}`; `as_str` → `"buy"`/`"sell"`.
- `fn parse_trade_direction_value(raw)` (172) — `raw.trim().to_ascii_lowercase()`; `"buy"`/`"sell"` ok; else `Err("invalid trade direction '<trimmed-lowercased>'; expected 'buy' or 'sell'")` (clap wraps it: `error: invalid value '<raw>' for '--trade-direction <TRADE_DIRECTION>': invalid trade direction 'sideways'; expected 'buy' or 'sell'`, exit 2).
- `fn normalize_risk_level(Option<&str>)` (184) — ASCII-uppercase; `CRITICAL|HIGH|MEDIUM|LOW` → that level; `None`, non-string, or unknown → `HIGH`. Wire forms `"CRITICAL"|"HIGH"|"MEDIUM"|"LOW"`.
- `fn resolve_action(risk, dir)` (195) — matrix: CRITICAL: buy→`block`, sell→`warn`; HIGH: buy→`pause`, sell→`warn`; MEDIUM: buy→`warn`, sell→`warn`; LOW: buy→`safe`, sell→`safe`.
- `fn token_is_native(token)` (163) — true iff neither `token["tokenContractAddress"]` nor `token["contractAddress"]` is a string whose `trim()` is non-empty (non-string/null/missing count as empty).
- `TokenResult::classify(token, dir)` (133) — `(normalize_risk_level(token["riskLevel"].as_str()), token_is_native, resolve_action)`.
- `fn combined_action(tokens)` (210) — max by severity (`block`3 > `pause`2 > `warn`1 > `safe`0) over NON-native tokens; none → `safe`.
- `fn normalize_tax_rate(_)` (222) — returns `NaN` (so any `> 10.0` test is false).
- `fn classify_swap_route(route: &mut Value)` (232) — used by the swap group: buy side = `route["toToken"]`, sell side = `route["fromToken"]` (via `.get`, missing → no signals). Per side: if `token["isHoneyPot"].as_bool() == Some(true)`: buy → action `block`, reason `to-token is a honeypot`; sell → action `warn`, reason `from-token is a honeypot; exit allowed`. Tax: if `token["taxRate"].as_f64()` is Some and `normalize_tax_rate(x) > 10.0` (never true) → `warn` + `to-token tax rate exceeds 10%` / `from-token tax rate exceeds 10%`. Route action = stricter of buy/sell (sell replaces buy only if strictly more severe; `block`2 > `warn`1 > `ok`0). Reasons = buy reasons then sell reasons, de-duplicated preserving first occurrence, joined with `;` (empty string when none). If `route` is an object, inserts/overwrites `"action"` (`"ok"|"warn"|"block"`) and `"reason"`; idempotent.

---

## D. Algorithms referenced by several commands

### D.1 `finalize_token_page` + `auto_paginate` (token.rs:571, sink.rs:251)

Inputs: `path`, `base` (ordered query pairs WITHOUT cursor), `cursor: Option<String>` (the `--cursor` value, may be `Some("")`), `max_results` raw string.

1. `n = parse_max_results(max_results)?` (CodedError on bad value; see B).
2. **Single-page mode** (`n` is None): query = `base` + `("cursor", c)` only if `c` non-empty; `GET path` via `ApiClient::get`; return `data` verbatim (passthrough).
3. **Auto-paginate mode** (`n` = N): shape `{items_key:"list", cursor_key:"cursor", mode: PerItem}`, `MAX_PAGES = 10`.
   ```
   items = []; cur = cursor; pages = 0; last_cont = None
   loop:
     if pages >= 10: break
     attempted = cur
     page = GET path with base + ("cursor", cur) if cur is Some   (empty value dropped by A.3)
       on Err(e): return {items, nextCursor: attempted, fetchedCount: len(items), partial: true,
                          error: {code:"upstream_error", message:"page <pages+1> request failed: <e:#>",
                                  nextCursor: attempted (omitted if None)}}
     pages += 1
     page_items = page["list"] if array
                  else page if array
                  else first array-valued field of the object in sorted-key order
                  else []
     cont = cursor_as_string(page_items.last()["cursor"])   # non-empty string → itself; number → to_string; else None
     if page_items is empty and cont is non-empty: break
     items += page_items; last_cont = cont
     if len(items) >= N: break
     if cont is non-empty:
        if attempted == cont: return {items, nextCursor: cont, fetchedCount: len(items), partial: true,
             error:{code:"cursor_not_advancing",
                    message:"upstream returned the same cursor '<cont>' it was queried with; stopping to avoid re-fetching the same page",
                    nextCursor: cont}}
        cur = cont
     else: break
   if len(items) > N: items = items[:N]; nextCursor = cursor_as_string(items.last()["cursor"])
   else nextCursor = last_cont
   return {items, nextCursor, fetchedCount: len(items)}           # partial/error omitted
   ```
   Serialised through `serde_json::to_value` → keys sorted: `error` (only when partial), `fetchedCount`, `items`, `nextCursor` (`null` when None — never omitted), `partial` (only when `true`). Inner error keys sorted: `code`, `message`, `nextCursor` (omitted when None); `field` is always omitted.
   Page failures (incl. API errors, 402/confirming errors) are **swallowed** into `partial` → the command still exits 0 with `ok:true`. Pages are fetched strictly sequentially; each page uses a fresh clone of the client (shared payment state).

### D.2 Chain defaulting used by token address commands
`ci = --chain.map(resolve_chain) ?? ctx.chain_index_or("ethereum")` i.e. `resolve_chain(--chain ?? $ONCHAINOS_HOME/config.json default_chain (if non-empty) ?? "ethereum")`. Because of A.5, a global `--chain` before the subcommand behaves identically to the leaf flag.

---

## Commands

Unless stated otherwise: success output is `{"ok":true,"data":<unwrapped backend data, passthrough, keys re-sorted>}`; generic errors are `{"ok":false,"error":"<msg>"}` on stdout with exit 1; clap errors on stderr with exit 2; auth is `jwt-optional` via `Context::client_async` (Bearer JWT when logged in, else anonymous; possible x402 payment header on paid tiers — core); every run appends one `audit.jsonl` line (core). "ApiClient errors" = the list in §B `ApiClient::get/post`.

### `onchainos token search`  (hidden: no)
- Handler: commands/token.rs:314 → `fetch_search` token.rs:614 → `finalize_token_page` token.rs:571
- Options:
  - `--query <QUERY>` String, required.
  - `--chains <CHAINS>` Option<String>; comma list of names/ids. Default: `resolve_chain(global --chain)` if given, else literal `"1,501"` (config `default_chain` ignored).
  - `--limit <LIMIT>` Option<String> (validated in code, not by clap); default `"20"`.
  - `--cursor <CURSOR>` Option<String>.
  - `--max-results <MAX_RESULTS>` Option<String>; 1..=500.
  - global `--chain <CHAIN>` (no leaf-local chain); hidden global `--dev`.
- Auth: jwt-optional
- Steps:
  1. `ctx.client_async()` (may refresh JWT / print stderr notices, core).
  2. If `query.trim()` is empty → error `Parameter --query cannot be empty`.
  3. `chains = --chains ?? resolve_chain(global --chain) ?? "1,501"`; then inside `fetch_search`: `resolve_chains(chains)` (split `,`, trim, resolve each, join `,`).
  4. `--limit` validation (C.2). 
  5. `GET /api/v6/dex/market/token/search` query order `chains`, `search` (= `--query` untrimmed), `limit`, [`cursor`] — via D.1 (single page or auto-paginate). Example: `?chains=1%2C501&search=USDC&limit=20`; `--query "dog wif"` → `search=dog+wif`.
- Output: single page → backend `data` (an array of tokens; each carries a `cursor`) passthrough; with `--max-results` → aggregate object (D.1).
- Errors: `Parameter --query cannot be empty`; `--limit must be a number between 1 and 100`; `--limit must be between 1 and 100, got <n>`; coded `--max-results must be an integer between 1 and 500, got '<s>'` / `--max-results must be between 1 and 500, got <n>` (`errorCode:"invalid_input"`, `errorField:"max-results"`); ApiClient errors (single-page mode only). Validation order: client creation → query → limit → max-results → HTTP.
- Side effects: read-only
- Nondeterminism: backend data (prices, `cursor` values); none added by CLI.
- Parity test cases:
  - `onchainos token search --query USDC` — SAFE (`chains=1%2C501&search=USDC&limit=20`)
  - `onchainos token search --query "dog wif" --chains solana --limit 5` — SAFE
  - `onchainos --chain solana token search --query BONK` — SAFE (`chains=501`)
  - `onchainos token search --query USDC --limit 2 --max-results 5` — SAFE (≤3 GETs, cursor chaining)
  - `onchainos token search --query btc --max-results 999` — SAFE (offline coded error, exit 1)

### `onchainos token info`  (hidden: no)
- Handler: commands/token.rs:337 → `fetch_info` token.rs:648
- Options: `--address <ADDRESS>` String required; `--chain <CHAIN>` Option<String> (leaf-local, shares id with global); `--dev` hidden global.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `POST /api/v6/dex/market/token/basic-info` body `[{"chainIndex":"<ci>","tokenContractAddress":"<address>"}]` (address verbatim).
- Output: backend `data` (array; element has e.g. `tokenSymbol`) passthrough.
- Errors: ApiClient errors; clap missing `--address`.
- Side effects: read-only
- Nondeterminism: none added.
- Parity test cases:
  - `onchainos token info --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token info --address So11111111111111111111111111111111111111112 --chain solana` — SAFE
  - `onchainos token info --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — SAFE (chain from config default or `1`)

### `onchainos token holders`  (hidden: no)
- Handler: commands/token.rs:343 → `fetch_holders` token.rs:656 → D.1
- Options: `--address` String required; `--chain` Option<String>; `--tag-filter <TAG_FILTER>` Option<u8> (clap `0..=255`; documented values 1=KOL … 9=Bundler); `--limit` Option<String> default `"20"`; `--cursor` Option<String>; `--max-results` Option<String>.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `--limit` validation (same messages as search). 4. D.1 with `GET /api/v6/dex/market/token/holder`, base order `chainIndex`, `tokenContractAddress`, `tagFilter` (omitted when absent; `0` is sent), `limit`, [`cursor`].
- Output: passthrough page, or D.1 aggregate.
- Errors: as search (minus the query check); clap u8 errors.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token holders --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token holders --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum --tag-filter 4 --limit 3` — SAFE
  - `onchainos token holders --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum --limit 50 --max-results 120` — SAFE (≤3 pages)
  - `onchainos token holders --address x --tag-filter 300` — SAFE (clap exit 2)

### `onchainos token price-info`  (hidden: no)
- Handler: commands/token.rs:367 → `fetch_price_info` token.rs:709
- Options: `--address` String required; `--chain` Option<String>.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `POST /api/v6/dex/market/price-info` body `[{"chainIndex":"<ci>","tokenContractAddress":"<address>"}]`.
- Output: backend `data` array passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: live prices.
- Parity test cases:
  - `onchainos token price-info --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token price-info --address So11111111111111111111111111111111111111112 --chain sol` — SAFE

### `onchainos token liquidity`  (hidden: no)
- Handler: commands/token.rs:373 → `fetch_liquidity` token.rs:692
- Options: `--address` String required; `--chain` Option<String>.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `GET /api/v6/dex/market/token/top-liquidity?chainIndex=<ci>&tokenContractAddress=<address>`.
- Output: passthrough (top-5 pools).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token liquidity --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token liquidity --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — SAFE

### `onchainos token hot-tokens`  (hidden: no)
- Handler: commands/token.rs:379 → `fetch_hot_tokens` token.rs:831 → D.1
- Options (all `Option<String>` unless noted, raw passthrough, no validation except `--limit`/`--max-results`):
  `--ranking-type` String default `"4"` (4=Trending, 5=Xmentioned); `--chain`; `--rank-by`; `--time-frame`; `--risk-filter`; `--stable-token-filter`; `--project-id`; `--price-change-min` and `--price-change-max` (both `allow_hyphen_values = true`, so `-5` works); `--volume-min/max`; `--market-cap-min/max`; `--liquidity-min/max`; `--transaction-min/max`; `--txs-min/max`; `--unique-trader-min/max`; `--holders-min/max`; `--inflow-min/max`; `--fdv-min/max`; `--mentioned-count-min/max`; `--social-score-min/max`; `--top10-hold-percent-min/max`; `--dev-hold-percent-min/max`; `--bundle-hold-percent-min/max`; `--suspicious-hold-percent-min/max`; `--is-lp-burnt`; `--is-mint`; `--is-freeze`; `--limit` (default `"20"`); `--cursor`; `--max-results`. Negative values on options other than price-change must use `--opt=-5` (A.5).
- Auth: jwt-optional
- Steps:
  1. client_async.
  2. `--limit` validation (same messages as search).
  3. `chainIndex = --chain.map(resolve_chain) ?? ""` (no config/ethereum fallback; global `--chain` propagates per A.5).
  4. D.1 on `GET /api/v6/dex/market/token/hot-token`; base query order (flag → param): `rankingType`←`--ranking-type`, `chainIndex`, `rankBy`←`--rank-by`, `rankingTimeFrame`←`--time-frame`, `riskFilter`←`--risk-filter`, `stableTokenFilter`←`--stable-token-filter`, `protocolId`←`--project-id`, `priceChangePercentMin`, `priceChangePercentMax`, `volumeMin`, `volumeMax`, `tradeAmountMin`←`--transaction-min`, `tradeAmountMax`←`--transaction-max`, `txsMin`, `txsMax`, `uniqueTraderMin`, `uniqueTraderMax`, `marketCapMin`, `marketCapMax`, `liquidityMin`, `liquidityMax`, `holdersMin`, `holdersMax`, `inflowUsdMin`←`--inflow-min`, `inflowUsdMax`←`--inflow-max`, `fdvMin`, `fdvMax`, `mentionedCountMin`, `mentionedCountMax`, `socialScoreMin`, `socialScoreMax`, `top10HoldPercentMin`, `top10HoldPercentMax`, `devHoldPercentMin`, `devHoldPercentMax`, `bundleHoldPercentMin`, `bundleHoldPercentMax`, `suspiciousHoldPercentMin`, `suspiciousHoldPercentMax`, `isLpBurnt`, `isMint`, `isFreeze`, `limit`, [`cursor`]. Absent/empty values are dropped (A.3). Note the market-cap/liquidity pairs come AFTER unique-trader in the query even though they appear earlier in `--help`.
- Output: passthrough page, or D.1 aggregate.
- Errors: limit / max-results errors; ApiClient errors.
- Side effects: read-only
- Nondeterminism: live rankings.
- Parity test cases:
  - `onchainos token hot-tokens` — SAFE (`?rankingType=4&limit=20`)
  - `onchainos token hot-tokens --chain solana --rank-by 5 --time-frame 4 --limit 3` — SAFE
  - `onchainos token hot-tokens --price-change-min -100 --price-change-max -5` — SAFE
  - `onchainos token hot-tokens --ranking-type 5 --mentioned-count-min 1 --social-score-max 1000 --max-results 30` — SAFE
  - `onchainos token hot-tokens --limit 101` — SAFE (offline error)

### `onchainos token advanced-info`  (hidden: no)
- Handler: commands/token.rs:480 → `fetch_advanced_info` token.rs:956
- Options: `--address` required; `--chain` Option<String>.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `GET /api/v6/dex/market/token/advanced-info?chainIndex=<ci>&tokenContractAddress=<address>`.
- Output: passthrough (object).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token advanced-info --address So11111111111111111111111111111111111111112 --chain solana` — SAFE
  - `onchainos token advanced-info --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain 1` — SAFE

### `onchainos token top-trader`  (hidden: no)
- Handler: commands/token.rs:486 → `fetch_top_trader` token.rs:973 → D.1
- Options: identical to `token holders` (`--tag-filter` u8).
- Auth: jwt-optional
- Steps: as `token holders` but path `GET /api/v6/dex/market/token/top-trader`.
- Output: passthrough page or D.1 aggregate.
- Errors: as holders.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token top-trader --address So11111111111111111111111111111111111111112 --chain solana` — SAFE
  - `onchainos token top-trader --address So11111111111111111111111111111111111111112 --chain solana --tag-filter 3 --limit 3` — SAFE
  - `onchainos token top-trader --address So11111111111111111111111111111111111111112 --chain solana --max-results 40` — SAFE

### `onchainos token trades`  (hidden: no)
- Handler: commands/token.rs:510 → `fetch_token_trades` token.rs:1009
- Options: `--address` required; `--chain` Option<String>; `--limit <LIMIT>` u32 default `100` (help says max 500 — NOT enforced; clap range 0..=4294967295); `--tag-filter` Option<String> (raw, not u8); `--wallet-filter` Option<String> (raw comma list).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `ci` per D.2. 3. `GET /api/v6/dex/market/trades` query `chainIndex`, `tokenContractAddress`, `limit` (decimal u32, always present), `tagFilter`, `walletAddressFilter` (latter two dropped when absent).
- Output: passthrough.
- Errors: ApiClient errors; clap u32 errors.
- Side effects: read-only
- Nondeterminism: live trades.
- Parity test cases:
  - `onchainos token trades --address So11111111111111111111111111111111111111112 --chain solana --limit 5` — SAFE
  - `onchainos token trades --address So11111111111111111111111111111111111111112 --chain solana --limit 5 --tag-filter 1` — SAFE
  - `onchainos token trades --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — SAFE (`limit=100`)

### `onchainos token cluster-overview`  (hidden: no)
- Handler: commands/token.rs:532 → `cluster_by_address` token.rs:1035 → `fetch_cluster_by_address` token.rs:1063
- Options: `--address` required; `--chain` Option<String>.
- Auth: jwt-optional
- Steps: 1. `ctx.client_async()` in `execute` (unused) AND a second `ctx.client_async()` inside `cluster_by_address` (so JWT-refresh stderr notices can appear twice). 2. `ci` per D.2. 3. `GET /api/v6/dex/market/token/cluster/overview?chainIndex=<ci>&tokenContractAddress=<address>`.
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token cluster-overview --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token cluster-overview --address So11111111111111111111111111111111111111112 --chain solana` — SAFE

### `onchainos token cluster-top-holders`  (hidden: no)
- Handler: commands/token.rs:541 → `cluster_top_holders` token.rs:1099 → `fetch_cluster_top_holders` token.rs:1081
- Options: `--address` required; `--chain` Option<String>; `--range-filter <RANGE_FILTER>` String required (1=top10, 2=top50, 3=top100; not validated).
- Auth: jwt-optional
- Steps: 1. client_async twice (as cluster-overview). 2. `ci` per D.2. 3. `GET /api/v6/dex/market/token/cluster/top-holders?chainIndex&tokenContractAddress&rangeFilter` (empty `--range-filter ""` is dropped from the query).
- Output: passthrough.
- Errors: ApiClient errors; clap missing `--range-filter`.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token cluster-top-holders --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum --range-filter 1` — SAFE
  - `onchainos token cluster-top-holders --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum --range-filter 3` — SAFE

### `onchainos token cluster-list`  (hidden: no)
- Handler: commands/token.rs:546 → `cluster_by_address` token.rs:1035
- Options: `--address` required; `--chain` Option<String>.
- Auth: jwt-optional
- Steps: as cluster-overview with path `GET /api/v6/dex/market/token/cluster/list`.
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: backend only.
- Parity test cases:
  - `onchainos token cluster-list --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE
  - `onchainos token cluster-list --address So11111111111111111111111111111111111111112 --chain solana` — SAFE

### `onchainos token cluster-supported-chains`  (hidden: no)
- Handler: commands/token.rs:555 → `cluster_supported_chains` token.rs:1056 → `fetch_cluster_supported_chains` token.rs:1050
- Options: none of its own (global `--chain` accepted and ignored).
- Auth: jwt-optional
- Steps: 1. client_async twice. 2. `GET /api/v6/dex/market/token/cluster/supported/chain` (no query).
- Output: passthrough (array of `{chainIndex, chainName, …}`).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: none.
- Parity test cases:
  - `onchainos token cluster-supported-chains` — SAFE
  - `onchainos token cluster-supported-chains --chain solana` — SAFE (flag ignored)

### `onchainos token report`  (hidden: no)
- Handler: commands/token.rs:556 → `fetch_report` token.rs:1119 → `compose_report` token.rs:1163
- Options: `--address` required; `--chain` Option<String> (default per D.2).
- Auth: jwt-optional
- Steps:
  1. client_async; `ci` per D.2.
  2. Concurrently (`tokio::join!`, 4 client clones sharing payment state):
     a. `POST /api/v6/dex/market/token/basic-info` body `[{"chainIndex":"<ci>","tokenContractAddress":"<address>"}]`
     b. `POST /api/v6/dex/market/price-info` same body
     c. `GET /api/v6/dex/market/token/advanced-info?chainIndex=<ci>&tokenContractAddress=<address>`
     d. `POST /api/v6/security/token-scan` body `{"source":"onchain_os_cli","tokenList":[{"chainId":"<ci>","contractAddress":"<address>"}]}`
  3. Each result: `Ok(v)` → `v` (may be `null`), `Err` → `null`, error discarded silently (no stderr).
  4. If all four failed → error `token report: all sub-calls failed for address <address> on chain <ci>`.
- Output: `data` = `{"address":"<address as given>","advancedInfo":<c|null>,"chain":"<ci>","info":<a|null>,"priceInfo":<b|null>,"security":<d|null>}` (keys sorted; sub-results verbatim, including any nested `requestTime`).
- Errors: only the all-failed message (exit 1).
- Side effects: read-only
- Nondeterminism: order of the 4 HTTP requests on the wire; live prices.
- Parity test cases:
  - `onchainos token report --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` — SAFE (compare request set, not order)
  - `onchainos token report --address So11111111111111111111111111111111111111112 --chain solana` — SAFE
  - `onchainos --chain base token report --address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — SAFE

### `onchainos security token-scan`  (hidden: no)
- Handler: commands/security.rs:129 → `token_scan` security.rs:197
- Options:
  - `--tokens <TOKENS>` Option<String>, `conflicts_with = "address"`; `chainId:contractAddress,…` (help text says "up to 10", code enforces 50).
  - `--address <ADDRESS>` Option<String>, `conflicts_with = "tokens"`.
  - `--chain <CHAIN>` Option<String> (leaf-local; used only in address/wallet modes; a single chain — `resolve_chain`, not `resolve_chains`).
  - `--trade-direction <TRADE_DIRECTION>` Option<TradeDirection>, value_parser `parse_trade_direction_value` (`buy`/`sell`, case-insensitive, trimmed).
- Auth: jwt-optional for `--tokens` and `--address`; **jwt-required** (keyring `access_token` + `wallets.json`) for no-flag wallet mode.
- Steps — mode selection: `--tokens` present → Mode T; else `--address` → Mode A; else Mode W.
  - **Mode T** (`token_scan_explicit`, security.rs:236):
    1. `ctx.client_async()` (before any validation).
    2. `tokens.split(',')`; each item `trim()`; `splitn(2, ':')`; if not exactly 2 parts → error `Invalid token format '<trimmed item>'. Expected chainId:contractAddress (e.g. 1:0xdAC1...)` (first failing item; `--tokens ""` and trailing commas hit this). Else `{"chainId": resolve_chain(part0.trim()) (string), "contractAddress": part1.trim()}` (colons after the first are kept in the address; `1:` gives empty address).
    3. (unreachable) empty list → `--tokens must contain at least one chainId:contractAddress pair`.
    4. > 50 items → `--tokens supports at most 50 items per request`.
    5. `POST /api/v6/security/token-scan` body `{"source":"onchain_os_cli","tokenList":[…in input order…]}`.
    6. If `data` is a JSON array → `emit_token_scan(array, dir)`; otherwise → `output::success(data)` raw (NO classification even with `--trade-direction`).
  - **Mode A** (`fetch_tokens_by_address`, security.rs:306 → `run_batch_scan`):
    1. `ctx.client_async()`.
    2. `GET /api/v6/dex/balance/all-token-balances-by-address` query order `address=<address>`, `filter=1`, `chains=<resolve_chain(--chain)>` (only when `--chain` given and non-empty).
    3. `extract_token_pairs(data)` (below) → pairs → `run_batch_scan`.
  - **Mode W** (security.rs:215 → `fetch_tokens_from_wallet` security.rs:280 → `run_batch_scan`):
    1. `load_wallets()`; `None` → error `Not logged in and no --address provided.\nProvide --address <wallet_addr> or login with \`onchainos wallet login\`.` (contains a literal newline).
    2. `account_id = resolve_active_account_id(wallets)` (error `no wallet accounts found`).
    3. `access_token = keyring_store::get("access_token")`, error → `Session expired or not logged in (<inner>). Run \`onchainos wallet login\`.` (inner e.g. `keyring key 'access_token' not found`). The token is used as-is (no local `exp` check here).
    4. `WalletApiClient::get_authed("/priapi/v5/wallet/agentic/asset/wallet-all-token-balances", token, [("accountId",id), ("chains", resolve_chain(--chain)) if non-empty])` → Bearer JWT; on invalid-token codes force-refresh + retry once (core).
    5. `extract_token_pairs(data)` → `run_batch_scan`.
  - `extract_token_pairs(data)` (security.rs:425): `null` → `[]`; `items` = `data` if array, else `data["tokenAssets"]` if array, else error `Unexpected portfolio response format — expected array or {tokenAssets:[...]} but got: <first 200 chars of compact data JSON><"…" if its byte length > 200>`. Pairs = for each item in order: both `item["chainIndex"]` and `item["tokenContractAddress"]` must be JSON strings, and address non-empty (native skipped) → `(chainIndex, address)`. NOTE: items are read at the top level only — a response shaped `[{"tokenAssets":[…]}]` (the shape the portfolio tests and wallet balance code document) yields ZERO pairs (see openQuestions).
  - `run_batch_scan(pairs, dir)` (security.rs:331): if no pairs → `emit_token_scan([], dir)` with NO further HTTP. Else `ctx.client_async()` (another client), chunk pairs into groups of 50 in order; one `POST /api/v6/security/token-scan` per chunk with body `{"source":"onchain_os_cli","tokenList":[{"chainId":"<ci>","contractAddress":"<addr>"},…]}`; tasks spawned concurrently but share one `tokio::Mutex<ApiClient>` held for the whole request → requests are serialised. Results merged in completion order: array → elements appended; non-array (incl. `null`) → pushed as one element. First error aborts → that error.
  - `emit_token_scan(results, dir)`: `dir` None → `data` = the merged array; `dir` Some → `classify_tokens`: for each element compute `TokenResult::classify` (C.19); if element is an object insert `normalizedRiskLevel` (`CRITICAL|HIGH|MEDIUM|LOW`), `action` (`block|pause|warn|safe`), `isNative` (bool) — overwriting same-named keys; non-objects left untouched (but still counted: a non-object is native).
- Output:
  - no `--trade-direction`: `{"ok":true,"data":[<backend scan objects…>]}` (raw).
  - with `--trade-direction`: `{"ok":true,"data":{"combinedAction":"<strictest non-native action or safe>","tokens":[<objects + 3 keys, key-sorted>],"tradeDirection":"buy|sell"}}`.
  - Mode T with non-array backend data: raw passthrough.
- Errors: clap conflict (exit 2); clap invalid trade direction (exit 2, `error: invalid value '<raw>' for '--trade-direction <TRADE_DIRECTION>': invalid trade direction '<lowercased>'; expected 'buy' or 'sell'`); the messages above (exit 1); ApiClient / WalletApiClient errors; `wallets.json` read/parse errors.
- Side effects: read-only (server). Mode W may rotate keyring tokens via force-refresh (core).
- Nondeterminism: element order across multiple 50-token batches (completion order); `resolve_active_account_id` fallback on HashMap key order when no selected/default account.
- Parity test cases:
  - `onchainos security token-scan --tokens 1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — SAFE (raw array)
  - `onchainos security token-scan --tokens 1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --trade-direction buy` — SAFE
  - `onchainos security token-scan --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum --trade-direction sell` — SAFE
  - `onchainos security token-scan --tokens 1_0xabc` — SAFE (offline error after client creation)
  - `onchainos security token-scan` with empty `$ONCHAINOS_HOME` — SAFE (not-logged-in error, no HTTP)

### `onchainos security dapp-scan`  (hidden: no)
- Handler: commands/security.rs:150 → `dapp_scan` security.rs:467
- Options: `--domain <DOMAIN>` String required (global `--chain` accepted, ignored).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `POST /api/v6/security/dapp-scan` body `{"source":"onchain_os_cli","url":"<domain.trim()>"}`.
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: none.
- Parity test cases:
  - `onchainos security dapp-scan --domain https://app.uniswap.org` — SAFE
  - `onchainos security dapp-scan --domain "  okx.com  "` — SAFE (`url` trimmed)

### `onchainos security tx-scan`  (hidden: no)
- Handler: commands/security.rs:151 → `tx_scan` security.rs:480
- Options: `--from` String required; `--to` Option<String>; `--chain` String required; `--data` Option<String>; `--value` Option<String>; `--gas` Option<u64>; `--gas-price` Option<u64>; `--encoding` Option<String>; `--transactions` Option<String>.
- Auth: jwt-optional (+ anonymous chain-list call on EVM path)
- Steps:
  1. `ci = resolve_chain(--chain)`; `family = chain_family(ci)`.
  2. `ctx.client_async()`.
  3. family `solana` (ci == "501"): `--encoding` missing → `--encoding is required for Solana`; `--transactions` missing → `--transactions is required for Solana`; `txs = transactions.split(',').map(trim)` (empty entries kept); `POST /api/v6/security/transaction-scan/sol` body `{"chainId":"501","encoding":"<enc>","from":"<from>","source":"onchain_os_cli","transactions":[…]}`. `--to/--data/--value/--gas/--gas-price` ignored.
  4. family `evm` (everything else): `real = get_real_chain_index(ci)` FIRST (may `POST /priapi/v5/wallet/agentic/chain/support/list` and write `chain_cache.json`); then `--data` missing → `--data is required for EVM tx-scan`; body `{"chainId":<real as JSON number>,"data":"<data>","from":"<from>","source":"onchain_os_cli"}` + `"to"` if given + `"value"` if given + `"gas"` (JSON number) + `"gasPrice"` (JSON number); `value` conversion: starts with `0x`/`0X` → unchanged; else parses as u128 (Rust: optional leading `+`, digits) → `format!("0x{:x}")` lowercase (e.g. `1000` → `0x3e8`, `0` → `0x0`); else unchanged. `POST /api/v6/security/transaction-scan/evm`. `--encoding/--transactions` ignored.
  5. The `_ =>` branch (`Chain '<chain>' (family: <family>) is not supported for security tx-scan. Only EVM and Solana chains are supported.`) is unreachable.
- Output: passthrough.
- Errors: listed above + `Chain index <ci> not found in supported chains` / `Cannot resolve realChainIndex for chain index <ci>` / chain-list network errors / ApiClient errors.
- Side effects: read-only (may write `chain_cache.json`).
- Nondeterminism: none.
- Parity test cases:
  - `onchainos security tx-scan --chain ethereum --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --to 0x000000000000000000000000000000000000dEaD --data 0x --value 1000` — SAFE (`value":"0x3e8"`)
  - `onchainos security tx-scan --chain solana --from EeBCkp5j17U5Fg4bEiboHvRrUvQ4LP9AdioQwPg5wF43` — SAFE (offline `--encoding is required for Solana`)
  - `onchainos security tx-scan --chain ethereum --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` — SAFE (chain list lookup then `--data is required for EVM tx-scan`)
  - `onchainos security tx-scan --chain base --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --data 0x --gas 21000 --gas-price 1000000000` — SAFE

### `onchainos security approvals`  (hidden: no)
- Handler: commands/security.rs:144 → `approvals` security.rs:569
- Options: `--address` String required; `--chain` Option<String> (comma list); `--limit` u32 default `20`; `--cursor` Option<u64>.
- Auth: jwt-optional (+ anonymous chain-list call when `--chain` absent)
- Steps:
  1. With `--chain`: split `,` → trim → drop empties → each `{"address":"<address>","chainIndex":"<resolve_chain(c)>"}` (chainIndex is a JSON **string**).
     Without `--chain`: `get_all_chains()` (error wrapped `Failed to load supported chain list: <inner>`); for each entry in list order, `chainIndex` as i64 (or string parsed to i64; unparsable skipped); keep if `chain_family(ci.to_string()) == "evm"` (i.e. everything except 501); `{"address":"<address>","chainIndex":<ci>}` (JSON **number**).
  2. Empty list → `No supported chains found`.
  3. `ctx.client_async()`.
  4. `POST /api/v6/security/approval-mng` body `{"addressList":[…],"cursor":<u64, only if given>,"limit":<u32>,"nested":false}`; error wrapped `Failed to fetch approvals: <inner>`.
- Output: passthrough.
- Errors: as above + ApiClient errors (prefixed).
- Side effects: read-only (may write `chain_cache.json`).
- Nondeterminism: none (chain order = cache/API order).
- Parity test cases:
  - `onchainos security approvals --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum,base` — SAFE
  - `onchainos security approvals --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` — SAFE (numeric chainIndex list)
  - `onchainos security approvals --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain 1 --limit 5 --cursor 1` — SAFE
  - `onchainos security approvals --address 0xabc --chain ","` — SAFE (offline `No supported chains found`)

### `onchainos security sig-scan`  (hidden: no)
- Handler: commands/security.rs:176 → `sig_scan` security.rs:634
- Options: `--from` String required; `--chain` String required; `--sig-method` String required; `--message` String required.
- Auth: jwt-optional (+ anonymous chain-list call)
- Steps:
  1. `ci = resolve_chain(--chain)`; `real = get_real_chain_index(ci)` (network/cache FIRST, before method validation).
  2. `--sig-method` must be exactly (case-sensitive) one of `personal_sign`, `eth_sign`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`; else `Invalid --sig-method '<m>'. Must be one of: personal_sign, eth_sign, eth_signTypedData, eth_signTypedData_v3, eth_signTypedData_v4`.
  3. `message_value = serde_json::from_str(--message)` if it parses as ANY JSON value (object, array, number, `true`, quoted string…), else the raw string.
  4. `ctx.client_async()`; `POST /api/v6/security/sign-message-check` body `{"chainId":<real u64 number>,"from":"<from>","message":<message_value>,"signType":"<method>","source":"onchain_os_cli"}` (typed-data objects are re-serialised with sorted keys).
- Output: passthrough.
- Errors: chain lookup errors; invalid method; ApiClient errors.
- Side effects: read-only (may write `chain_cache.json`).
- Nondeterminism: none.
- Parity test cases:
  - `onchainos security sig-scan --chain ethereum --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --sig-method personal_sign --message hello` — SAFE
  - `onchainos security sig-scan --chain 56 --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --sig-method eth_signTypedData_v4 --message '{"types":{},"primaryType":"Permit","domain":{},"message":{}}'` — SAFE
  - `onchainos security sig-scan --chain ethereum --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --sig-method invalid_method --message hello` — SAFE (error after chain lookup)
  - `onchainos security sig-scan --chain 1 --from 0xabc --sig-method personal_sign --message 123` — SAFE (`"message":123`)

### `onchainos portfolio chains`  (hidden: no)
- Handler: commands/portfolio.rs:62 → `fetch_chains` portfolio.rs:115
- Options: none (global `--chain` ignored).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/balance/supported/chain`.
- Output: passthrough array (`chainIndex`, …).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: none.
- Parity test cases:
  - `onchainos portfolio chains` — SAFE
  - `onchainos portfolio chains --chain solana` — SAFE (ignored)

### `onchainos portfolio total-value`  (hidden: no)
- Handler: commands/portfolio.rs:65 → `fetch_total_value` portfolio.rs:120
- Options: `--address` String required; `--chains` String required; `--asset-type` Option<String> (0/1/2, raw); `--exclude-risk` Option<bool> (clap: only `true`/`false`).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/balance/total-value-by-address` query `address`, `chains=<resolve_chains(--chains)>`, `assetType` (if given), `excludeRiskToken` (`"true"`/`"false"` if given).
- Output: passthrough (array; element has `totalValue`).
- Errors: ApiClient errors; clap bool error.
- Side effects: read-only
- Nondeterminism: live valuations.
- Parity test cases:
  - `onchainos portfolio total-value --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chains ethereum` — SAFE
  - `onchainos portfolio total-value --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chains "ethereum, base" --asset-type 1 --exclude-risk false` — SAFE (`chains=1%2C8453`)
  - `onchainos portfolio total-value --address 0x1 --chains 1 --exclude-risk yes` — SAFE (clap exit 2)

### `onchainos portfolio all-balances`  (hidden: no)
- Handler: commands/portfolio.rs:83 → `fetch_all_balances` portfolio.rs:143
- Options: `--address` required; `--chains` required; `--exclude-risk` Option<String> (raw, `0`/`1`); `--filter` Option<String> (raw, `0`/`1`).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/balance/all-token-balances-by-address` query `address`, `chains=<resolve_chains>`, `excludeRiskToken`, `filter` (each only if given).
- Output: passthrough (array of `{tokenAssets:[…]}`).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: live balances/prices.
- Parity test cases:
  - `onchainos portfolio all-balances --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chains ethereum` — SAFE
  - `onchainos portfolio all-balances --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chains ethereum --exclude-risk 0 --filter 1` — SAFE

### `onchainos portfolio token-balances`  (hidden: no)
- Handler: commands/portfolio.rs:100 → `fetch_token_balances` portfolio.rs:169
- Options: `--address` required; `--tokens` String required (`chainIndex:tokenAddress,…`, empty address = native); `--exclude-risk` Option<String> (raw).
- Auth: jwt-optional
- Steps:
  1. client_async.
  2. `tokens.split(',')` (NO trim) → each `splitn(2, ':')`: chain part = part0, address = part1 or `""` when no colon; `chainIndex = resolve_chain(part0)` (untrimmed).
  3. `POST /api/v6/dex/balance/token-balances-by-address` body `{"address":"<address>","excludeRiskToken":"<raw string, only if given>","tokenContractAddresses":[{"chainIndex":"<ci>","tokenContractAddress":"<addr>"},…]}`.
- Output: passthrough (array of `{tokenAssets:[…]}`).
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: live balances.
- Parity test cases:
  - `onchainos portfolio token-balances --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --tokens 1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,1:` — SAFE
  - `onchainos portfolio token-balances --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --tokens ethereum: --exclude-risk 1` — SAFE

### `onchainos gateway gas`  (hidden: no)
- Handler: commands/gateway.rs:87 → `fetch_gas` gateway.rs:159
- Options: `--chain` String required (leaf-level only; see A.5).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/pre-transaction/gas-price?chainIndex=<resolve_chain(--chain)>`.
- Output: passthrough array.
- Errors: ApiClient errors; clap missing `--chain`.
- Side effects: read-only
- Nondeterminism: live gas.
- Parity test cases:
  - `onchainos gateway gas --chain ethereum` — SAFE
  - `onchainos gateway gas --chain solana` — SAFE
  - `onchainos --chain ethereum gateway gas` — SAFE (clap exit 2)

### `onchainos gateway gas-limit`  (hidden: no)
- Handler: commands/gateway.rs:91 → `fetch_gas_limit` gateway.rs:169
- Options: `--from` required; `--to` required; `--amount` String default `"0"`; `--data` Option<String>; `--chain` required.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `POST /api/v6/dex/pre-transaction/gas-limit` body `{"chainIndex":"<ci>","extJson":{"inputData":"<data>"} (only if --data),"fromAddress":"<from>","toAddress":"<to>","txAmount":"<amount>"}`.
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: live estimate.
- Parity test cases:
  - `onchainos gateway gas-limit --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --to 0x000000000000000000000000000000000000dEaD --amount 1000000000000 --chain ethereum` — SAFE
  - `onchainos gateway gas-limit --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --to 0x000000000000000000000000000000000000dEaD --data 0x --chain ethereum` — SAFE

### `onchainos gateway simulate`  (hidden: no)
- Handler: commands/gateway.rs:111 → `fetch_simulate` gateway.rs:192
- Options: `--from` required; `--to` required; `--amount` default `"0"`; `--data` String required; `--chain` required.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `POST /api/v6/dex/pre-transaction/simulate` body `{"chainIndex":"<ci>","extJson":{"inputData":"<data>"},"fromAddress":"<from>","toAddress":"<to>","txAmount":"<amount>"}`.
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only (dry run)
- Nondeterminism: chain state.
- Parity test cases:
  - `onchainos gateway simulate --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --to 0x000000000000000000000000000000000000dEaD --amount 0 --data 0x --chain ethereum` — SAFE
  - `onchainos gateway simulate --from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --to 0x000000000000000000000000000000000000dEaD` — SAFE (clap exit 2)

### `onchainos gateway broadcast`  (hidden: no)
- Handler: commands/gateway.rs:123 → `fetch_broadcast` gateway.rs:213
- Options: `--signed-tx` String required; `--address` String required; `--chain` String required; `--mev-protection` bool flag (SetTrue, default false).
- Auth: jwt-optional (no CLI-side signing; the caller supplies a signed tx)
- Steps:
  1. client_async.
  2. Body `{"address":"<address>","chainIndex":"<ci>","extraData":"{\"enableMevProtection\":true}" (only with --mev-protection; value is a JSON-encoded STRING),"signedTx":"<signed_tx>"}`.
  3. `tid = wallet_store::get_swap_trace_id()` (`$ONCHAINOS_HOME/cache.json` `swapTraceId`; read errors ignored). If present, extra headers `ok-client-tid: <tid>` and `ok-client-timestamp: <current Unix ms>`; the trace id is NOT cleared.
  4. `POST /api/v6/dex/pre-transaction/broadcast-transaction` via `post_no_retry_with_headers` (single attempt; no payment pre-sign/402 retry/token retry/DoH retry).
  5. No confirmation protocol (`--force` does not exist); the request is sent immediately.
- Output: passthrough (e.g. `orderId`, `txHash`).
- Errors: `Network error during broadcast — transaction was NOT sent. Safe to retry the same command.: <err>`; `request failed: <err>`; ApiClient `handle_response` errors.
- Side effects: **FUND-MOVING** — `POST /api/v6/dex/pre-transaction/broadcast-transaction` submits a signed transaction on-chain.
- Nondeterminism: `ok-client-timestamp` header (ms clock), only when a swap trace id is cached.
- Parity test cases:
  - `onchainos gateway broadcast --signed-tx 0xdeadbeef --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum` — UNSAFE (invalid tx, expect backend rejection; hits broadcast endpoint)
  - `onchainos gateway broadcast --signed-tx 0xdeadbeef --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain base --mev-protection` — UNSAFE
  - `onchainos gateway broadcast` — SAFE (clap exit 2, no HTTP)

### `onchainos gateway orders`  (hidden: no)
- Handler: commands/gateway.rs:141 → `fetch_orders` gateway.rs:261
- Options: `--address` required; `--chain` required; `--order-id` Option<String>.
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/post-transaction/orders` query `address`, `chainIndex`, `orderId` (if given).
- Output: passthrough.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: order status.
- Parity test cases:
  - `onchainos gateway orders --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum` — SAFE
  - `onchainos gateway orders --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum --order-id dummy-order-id` — SAFE

### `onchainos gateway chains`  (hidden: no)
- Handler: commands/gateway.rs:151 → `fetch_chains` gateway.rs:277
- Options: none (global `--chain` ignored).
- Auth: jwt-optional
- Steps: 1. client_async. 2. `GET /api/v6/dex/pre-transaction/supported/chain`.
- Output: passthrough array.
- Errors: ApiClient errors.
- Side effects: read-only
- Nondeterminism: none.
- Parity test cases:
  - `onchainos gateway chains` — SAFE

---

## Endpoint classification (all endpoints touched by this group)

| Method | Path | Class | Used by |
|---|---|---|---|
| GET | /api/v6/dex/market/token/search | read | token search |
| POST | /api/v6/dex/market/token/basic-info | read | token info, token report |
| GET | /api/v6/dex/market/token/holder | read | token holders |
| POST | /api/v6/dex/market/price-info | read | token price-info, token report |
| GET | /api/v6/dex/market/token/top-liquidity | read | token liquidity |
| GET | /api/v6/dex/market/token/hot-token | read | token hot-tokens |
| GET | /api/v6/dex/market/token/advanced-info | read | token advanced-info, token report |
| GET | /api/v6/dex/market/token/top-trader | read | token top-trader |
| GET | /api/v6/dex/market/trades | read | token trades |
| GET | /api/v6/dex/market/token/cluster/overview | read | token cluster-overview |
| GET | /api/v6/dex/market/token/cluster/top-holders | read | token cluster-top-holders |
| GET | /api/v6/dex/market/token/cluster/list | read | token cluster-list |
| GET | /api/v6/dex/market/token/cluster/supported/chain | read | token cluster-supported-chains |
| POST | /api/v6/security/token-scan | read | security token-scan, token report |
| POST | /api/v6/security/dapp-scan | read | security dapp-scan |
| POST | /api/v6/security/transaction-scan/sol | read | security tx-scan |
| POST | /api/v6/security/transaction-scan/evm | read | security tx-scan |
| POST | /api/v6/security/approval-mng | read | security approvals |
| POST | /api/v6/security/sign-message-check | read | security sig-scan |
| GET | /api/v6/dex/balance/all-token-balances-by-address | read | portfolio all-balances, security token-scan (--address) |
| GET | /priapi/v5/wallet/agentic/asset/wallet-all-token-balances | read | security token-scan (wallet mode, JWT) |
| POST | /priapi/v5/wallet/agentic/chain/support/list | read | security tx-scan (EVM), security sig-scan, security approvals (no --chain) — via get_all_chains |
| GET | /api/v6/dex/balance/supported/chain | read | portfolio chains |
| GET | /api/v6/dex/balance/total-value-by-address | read | portfolio total-value |
| POST | /api/v6/dex/balance/token-balances-by-address | read | portfolio token-balances |
| GET | /api/v6/dex/pre-transaction/gas-price | read | gateway gas |
| POST | /api/v6/dex/pre-transaction/gas-limit | read | gateway gas-limit |
| POST | /api/v6/dex/pre-transaction/simulate | read | gateway simulate |
| POST | /api/v6/dex/pre-transaction/broadcast-transaction | funds | gateway broadcast |
| GET | /api/v6/dex/post-transaction/orders | read | gateway orders |
| GET | /api/v6/dex/pre-transaction/supported/chain | read | gateway chains |
| GET | /api/v6/dex/market/config | read | (core) payment config, any ApiClient call when a charging flag is set |
| POST | /priapi/v5/wallet/agentic/auth/refresh | auth | (core) JWT refresh in `client_async` / invalid-token retry |

## External hosts (other than the OKX base URL `https://web3.okx.com`)

- `https://beta.okex.org` — base URL when the hidden global `--dev` flag is passed (endpoints.rs:14); applies to every request of this group.
- DoH failover (core `DohManager`, transitively for every ApiClient/WalletApiClient request when the base URL is not custom): downloads the `okx-pilot` helper binary from `https://static.okx.com/upgradeapp/tools/pilot`, `https://static.coinall.ltd/upgradeapp/tools/pilot`, `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`, `https://static.jingyunyilian.com/upgradeapp/tools/pilot` (doh/binary.rs:45–48) and may route through a proxy base URL. Not owned by g04.
- No RPC nodes, sentry, or other hosts are contacted by code in this partition.

## Local files under `$ONCHAINOS_HOME` touched by this group

- `config.json` (read, `default_chain`) — D.2 chain default for token address commands.
- `chain_cache.json` (read by `resolve_chain` without TTL on every chain resolution; read+rewritten by `get_all_chains` with 600 s TTL in tx-scan EVM / sig-scan / approvals-without-chain).
- `wallets.json` (read) — security token-scan wallet mode.
- OS keyring / file keyring `access_token`, `refresh_token` (read; rotated by core refresh).
- `cache.json` (read `swapTraceId`) — gateway broadcast.
- Core side files: `payment_cache.json`, `audit.jsonl`.

## Open questions

1. `extract_token_pairs` only reads top-level `chainIndex`/`tokenContractAddress`, but the balance endpoints return `[{"tokenAssets":[…]}]` (per `tests/cli_portfolio.rs` and `agentic_wallet/balance/mod.rs`). Upstream `security token-scan --address …` and wallet mode therefore appear to always scan zero tokens and print `[]` (1 HTTP call, no token-scan POST). Reimplement the exact algorithm for parity, and confirm against live traffic.
2. `security token-scan --address` without `--chain` omits `chains`; whether the balance API accepts that (vs. an API error) is backend behaviour.
3. `tests/cli_security.rs` expects stdout containing `not supported` for `tx-scan --chain sui` and `sig-scan --chain solana`, but the CLI's own "not supported" branch is unreachable (`chain_family` returns only solana|evm). The text must come from the backend or the chain list; exact message unknown offline.
4. Batch result order for >50 tokens in `run_batch_scan` is completion order under a shared FIFO mutex (normally chunk order, not guaranteed). A reimplementation issuing chunks sequentially matches the common case.
5. Clap global-`--chain` propagation was verified with the installed 4.4.10 binary (clap_builder 4.x); assumed identical in 4.6.3 (clap_builder 4.6.0).
6. Help text for `security token-scan --tokens` says "up to 10"; code enforces 50 (`--tokens supports at most 50 items per request`). Help text is reproduced verbatim in the CLI tree.
7. Wallet-mode token-scan uses the keyring `access_token` without an `exp` check; if the backend's expired-token code is not one of `10001|10008|53017|130100031`, no refresh happens and the error surfaces as `Wallet API error (code=…): …`.
8. x402/paid-tier behaviour (pre-signed payment headers, 402 retry, `notifications`, `CliConfirming` exit 2) for these market/security endpoints is owned by core; which of these paths are on paid tiers comes from `/api/v6/dex/market/config` at runtime.
9. The relayed user request mentions supporting "the muse"; its meaning for this group is unclear and is not reflected in this extract.
