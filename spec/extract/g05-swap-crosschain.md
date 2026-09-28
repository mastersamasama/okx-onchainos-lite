# g05-swap-crosschain — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: every `onchainos swap …` and `onchainos cross-chain …` leaf (14 leaves, none hidden), including the
fund-moving orchestration flows `swap execute` and `cross-chain execute` (quote → approve → unsigned tx →
sign → broadcast → poll). Behaviour owned by other groups (HTTP client core, wallet auth / TEE signing,
funding/QR, autotrade notify, payment) is named with a one-line summary only.

## Sources read

Partition files (read fully, including `#[cfg(test)]` modules used as oracles):

| File | Lines |
|---|---|
| `cli/src/commands/swap.rs` | 2446 |
| `cli/src/commands/cross_chain.rs` | 2280 |

Other files consulted only to follow calls out of the partition (read in the relevant parts):

| File | Lines | Why |
|---|---|---|
| `cli/src/main.rs` | 316 | subcommand registration, global flags, exit-code mapping |
| `cli/src/commands/mod.rs` | 134 | `Context`, `client_async` |
| `cli/src/client.rs` | 2469 | `ApiClient::new_async/get/get_with_headers/post`, query building, envelope unwrap, error strings |
| `cli/src/output.rs` | 450 | `success`, `error`, `error_data`, `confirming_scene`, envelope struct order |
| `cli/src/chains.rs` | 623 | `resolve_chain`, `ensure_supported_chain`, `chain_family`, `native_token_address`, `merges_batch_unsignedinfo` |
| `cli/src/token_alias.rs` | 536 | `TOKEN_MAP`, `resolve_token_address`, `validate_address_for_chain`, `resolve_and_validate` |
| `cli/src/validators.rs` | 442 | amount/slippage validators, `readable_to_minimal_str` |
| `cli/src/commands/common.rs` | 116 | `wait_tx_onchain`, `tx_confirmation_timeout` (read fully; only used by this partition) |
| `cli/src/commands/token.rs` | 1197 | `fetch_info` (basic-info) |
| `cli/src/commands/risk_classify.rs` | 535 | `classify_swap_route` |
| `cli/src/commands/portfolio.rs` | 200 | `fetch_all_balances` |
| `cli/src/funding.rs` | 527 | `build_funding_bundle`, `build_funding_blocked_result`, `readable_shortfall` |
| `cli/src/qr.rs` | 720 | `QrOutput` shape |
| `cli/src/wallet_store.rs` | 848 | `cache.json` swap trace id, `wallets.json`, `chain_cache.json`, `session.json` |
| `cli/src/wallet_api.rs` | 2874 | wallet endpoints used by execute flows |
| `cli/src/commands/agentic_wallet/transfer/mod.rs` | 2545 | `execute_contract_call`, `sign_and_broadcast`, `batch_sign_and_broadcast`, `BatchTxParams` |
| `cli/src/commands/agentic_wallet/auth/mod.rs` | 1827 | `ensure_tokens_refreshed`, `format_api_error` |
| `cli/src/commands/agentic_wallet/balance/mod.rs` | 2101 | `query_token_readable_balance`, `ensure_wallet_accounts_fresh` |
| `cli/src/commands/agentic_wallet/shared/common/amount.rs` | 89 | `minimal_to_readable`, `value_as_decimal_string` |
| `cli/src/commands/agentic_wallet/common.rs` | 209 | `handle_confirming_error` (81362), `ERR_NOT_LOGGED_IN` |
| `cli/src/commands/agentic_wallet/chain.rs` | 175 | `get_chain_by_real_chain_index` |
| `cli/src/commands/agent_commerce/task/common/autotrade/notify.rs` | 766 | `notify_swap_outcome` (for `--notify-job-id`) |
| `cli/src/commands/agent_commerce/task/common/okx_a2a.rs` | 1259 | `user_notify_scoped` (spawns `okx-a2a`) |
| `cli/src/endpoints.rs` | 65 | base URL / `--dev` |
| `cli/src/home.rs` | 500 | `ONCHAINOS_HOME` resolution |
| `cli/src/audit.rs` | 1405 | audit log written after every command |
| `cli/tests/cli_swap.rs` | 682 | integration oracles (walletBalance, funding scene, chain validation) |
| `cli/tests/cli_cross_chain.rs` | 193 | integration oracles (clap conflicts, local validation) |
| `cli/Cargo.toml` | 107 | `serde_json` has **no** `preserve_order` feature; `debug-log` feature off by default |

Cross-checked against `spec/cli-tree.json`: all 14 leaves and every flag match the source. Neither
partition file declares a hidden (`hide = true`) command or flag. The only hidden flag reaching these
commands is the root global `--dev` (see below).

---

## Global conventions that apply to every command in this group

1. **Root/global flags** (`main.rs:41-52`):
   - `--dev` (hidden, global, bool): switches the base URL to `https://beta.okex.org` (`endpoints::set_dev_mode`) and disables DoH failover.
   - `--chain <CHAIN>` (global, optional): stored in `Context.chain_override`. **No command in this group reads it.**
     Subcommands that declare their own `--chain` (`swap quote|swap|approve|check-approvals|liquidity|execute`) shadow it
     (clap does not propagate a global into a subcommand that defines the same arg id). For `swap chains` and every
     `cross-chain *` leaf the global `--chain` is accepted and ignored.
2. **Client creation**: every handler first calls `ctx.client_async()` → `ApiClient::new_async()` (`client.rs:246`). Auth mode:
   access token (keyring `access_token`) not expired → `Authorization: Bearer <jwt>`; expired + refresh token valid →
   `wallet_api::force_refresh_access_token()` (POST `/priapi/v5/wallet/agentic/auth/refresh`); refresh token expired →
   stderr `Session expired. Please log in again: onchainos wallet login` and anonymous; refresh failure → stderr
   `Failed to refresh session (<e>). Falling back to anonymous access.` and anonymous; no token → anonymous.
   Base headers on every OKX DEX request: `Content-Type: application/json`, `ok-client-version: 4.6.3`,
   `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id` (if cached), `device-name`. Timeout 10 s.
   (Core-owned; DoH failover, x402 payment pre-sign/402 retry, invalid-token force-refresh+retry are all inside `ApiClient`.)
3. **GET query building** (`client.rs:413`): params are emitted in the order the handler pushes them, **params whose value is
   the empty string are dropped**, encoding is `application/x-www-form-urlencoded` (url crate `query_pairs_mut`: space → `+`,
   everything except `A-Za-z0-9*-._` percent-encoded). Repeated keys are emitted repeatedly (`allowBridge=1&allowBridge=2`).
   Node `URLSearchParams` produces identical bytes.
4. **POST body**: `serde_json::to_string(body)` (compact). Because `serde_json` is built **without `preserve_order`**, every
   `json!{}` object serialises with **keys sorted by byte order** (e.g. check-approvals body is
   `{"address":…,"chainIndex":…,"spender":…,"tokens":[{"tokenContractAddress":…}]}`).
5. **Response envelope** (`client.rs:175 unwrap_envelope`, `handle_response` `:859`): HTTP 429 → error `Rate limited — retry with backoff`;
   HTTP ≥500 → `Server error (HTTP <n>)`; empty body → `Empty response body (HTTP <n>). The requested operation may not be supported for the given parameters.`;
   non-JSON → `HTTP <n> <reason>: <text>`; 402 → payment flow; bare JSON array → returned as data; `code` (string `"0"` or number `0`) → returns `data`;
   otherwise error `API error (code=<code>): <msg>` where empty/missing msg → `unknown error`, and code `50114` appends
   `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.`
6. **stdout JSON** (`output.rs`): compact unless env `ONCHAINOS_PRETTY=1` (then `to_string_pretty`).
   - success: `{"ok":true,"data":<data>}` (+ `"notifications":[…]` only if payment notifications were emitted — core).
   - error: `{"ok":false,"error":"<anyhow {:#} chain>"}`, exit 1.
   - funding blocked: `{"ok":false,"data":<scene>}`, exit 1.
   - confirming (81362 without `--force`, Gas-Station prompts): `{"confirming":true,"scene"?:…,"message":…,"next":…}`, exit 2.
   - setup required (Gas-Station `--force` first-time path, wallet-owned): exit 3.
   - clap parse errors: stderr, exit 2.
   The envelope struct's own field order is `ok, data, error, notifications`; **everything inside `data` has alphabetically sorted keys**
   (passthrough API payloads are re-serialised through `serde_json::Value`, so their keys are sorted too). Numbers are passed through
   serde_json (`u64`/`i64` exact, floats printed with ryu shortest form, e.g. `1e21` — JS prints `1e+21`).
7. **After every command** `audit::log` appends a line to `$ONCHAINOS_HOME/audit.jsonl` (core-owned).
8. `ONCHAINOS_HOME` = env `ONCHAINOS_HOME` if non-empty, else `~/.onchainos`.
9. All `cfg!(feature = "debug-log")` stderr traces are compiled out of release builds — no stderr by default.

---

## Shared helpers (used across groups or from core)

### Owned by this partition

- `fn swap::resolve_amount_arg` (`swap.rs:477`) — `(client, amount: Option, readable_amount: Option, from, chain_index) -> raw amount string`.
  Also used by `cross-chain quote|swap|execute` (with the **raw, unresolved** `--from` string) and MCP.
  Algorithm:
  1. If `--amount` given: `amt = amount.trim()`; `validators::validate_amount(amt)`; return `amt`.
  2. Else if `--readable-amount` given: `r = trim`; empty → error `--readable-amount must not be empty`.
     `resolved_from = resolve_token_address(chain_index, from)` (alias only, **no format validation**);
     `token::fetch_info(client, resolved_from, chain_index)` = **POST `/api/v6/dex/market/token/basic-info`** body
     `[{"chainIndex":"<ci>","tokenContractAddress":"<resolved_from>"}]`.
     HTTP/API error → `Failed to fetch token decimals for <resolved_from>: <e>. Use --amount with raw units instead.`
     Not an array or empty → `Token not found for address <resolved_from> on chain <ci>. Verify the address is correct. Use --amount with raw units instead.`
     `data[0].decimal`: string → parse u32 (fail → `Invalid decimal value "<s>" for token <resolved_from>`); number → `as_u64` (fail → `Invalid decimal value for token <resolved_from>`);
     other/missing → `Token decimal not found for <resolved_from>. Use --amount with raw units instead.`
     Return `validators::readable_to_minimal_str(r, decimal)`.
  3. Neither → `Either --amount or --readable-amount is required`.
- `fn swap::fetch_quote` (`swap.rs:595`) — **GET `/api/v6/dex/aggregator/quote`**. Steps: if `swap_mode` non-empty → `validate_swap_mode`;
  `from = resolve_token_address(ci, from)`, `to = resolve_token_address(ci, to)`; `validate_swap_params(ci, from, to)`;
  `ts = Utc::now().timestamp_millis().to_string()`, `tid = from + ts`. Query order: `chainIndex, fromTokenAddress, toTokenAddress, amount, swapMode`
  (swapMode dropped when empty). Extra headers `ok-client-tid: <tid>`, `ok-client-timestamp: <ts>`. Returns `data` untouched. **Does not** cache the tid.
- `fn swap::fetch_swap` (`swap.rs:658`) — **GET `/api/v6/dex/aggregator/swap`**. Validation order (each only if applicable):
  `validate_swap_mode` (if non-empty) → `validate_gas_level` (if non-empty) → `validate_slippage(slippage)` → `validate_tips(tips)` →
  `validate_slippage(max_auto_slippage)` (same `--slippage …` wording) → `validate_address_for_chain(ci, wallet, "wallet")` → `validate_amount(amount)` →
  resolve from/to → `validate_swap_params`. Query order: `chainIndex, fromTokenAddress, toTokenAddress, amount, userWalletAddress, swapMode, gasLevel`, then
  `slippagePercent=<raw --slippage>` **or** (`autoSlippage=true`, `slippagePercent=0.5`), then (if tips) `tips=<raw>`, `computeUnitPrice=0`, then (if set)
  `maxAutoSlippagePercent=<raw>`. Raw values are sent **untrimmed and with any `%` intact** (`--slippage 1%` → `slippagePercent=1%25`).
  `ts`/`tid` as in fetch_quote; **writes `tid` to `$ONCHAINOS_HOME/cache.json` → `swapTraceId` (best effort, before the request)**; same two trace headers.
- `fn swap::fetch_approve` (`swap.rs:781`) — **GET `/api/v6/dex/aggregator/approve-transaction`**: `validate_approve_amount(amount)`; `token = resolve_token_address`;
  `validate_address_for_chain(ci, token, "token")`; query `chainIndex, tokenContractAddress, approveAmount=<amount as passed, untrimmed>`.
- `fn swap::fetch_check_approvals` (`swap.rs:821`) — **POST `/api/v6/dex/pre-transaction/check-approvals`**: validate `address` (label `address`), resolve+validate `token`
  (label `token`), validate `spender` if present (label `spender`); body `{"address","chainIndex","tokens":[{"tokenContractAddress"}],"spender"?}` (sorted keys on the wire).
- `fn swap::fetch_chains` (`swap.rs:859`) — **GET `/api/v6/dex/aggregator/supported/chain`**, no query.
- `fn swap::fetch_liquidity` (`swap.rs:873`) — **GET `/api/v6/dex/aggregator/get-liquidity?chainIndex=<ci>`**.
- `fn swap::classify_swap_response` (`swap.rs:469`, uses `swap_routes_mut` `:446`) — for each element of an array root (or the root itself if not an array):
  if it has an object `routerResult`, classify that, else the element; calls `risk_classify::classify_swap_route` (below). Shared with MCP.
- `fn swap::is_allowance_insufficient(spendable, amount)` (`swap.rs:1681`) — `spendable.len() > 38` → `false`; else `spendable.parse::<u128>()` (fail → 0) `<`
  `amount.parse::<u128>()` (fail → `u128::MAX`). Also used by the cross-chain balance gate (as `balance < amount`).
- `fn swap::classify_approve_action(ci, token, spendable, amount) -> (needs_approve, needs_revoke)` (`swap.rs:1667`) —
  `needs_approve = is_allowance_insufficient(spendable, amount)`; `needs_revoke = needs_approve && spendable != "0" && spendable != "" && token_requires_revoke(ci, token)`.
  `REVOKE_REQUIRED_TOKENS` (`:1636`): only chain `"1"`: `0xdac17f958d2ee523a2206206994597c13d831ec7`, `0x5a98fcbea516cf06857215779fd812ca3bef1b32`,
  `0x1776e1f26f98b1a5df9cd347953a26dd3cb46671`, `0xd3e4ba569045546d09cf021ecc5dfe42b1d7f6e4` (case-insensitive compare).
  Truth table (tests): spendable ≥ amount → (F,F); spendable 0 → (T,F); 0<s<amt non-listed → (T,F); 0<s<amt listed → (T,T); listed token on chain 56 → (T,F).
- `fn swap::extract_batch_hashes(hashes, needs_approve, needs_revoke)` (`swap.rs:1590`) — len 1 → `(None, hashes[0])`; else swap = last; approve = `hashes[needs_revoke?1:0]` iff `needs_approve`.
- `fn swap::attach_wallet_balance` (`swap.rs:1702`) — inserts `walletBalance` (string or JSON `null`) into every object element of an array root, or into an object root.
- `fn swap::next_steps_for_swap` / `history_status_cmd` (`swap.rs:958/983`) — builds `{"checkSwapStatus"?:…, "checkApproveStatus"?:…}`, each
  `onchainos wallet history --tx-hash <h> --chain <ci>` if hash non-empty, else `onchainos wallet history --order-id <oid> --chain <ci>` if order id non-empty, else key omitted.
- `fn swap::validate_swap_params` (`:545`) = `validate_address_for_chain(ci, from, "from")`, `(ci, to, "to")`, then `ensure_different_tokens` (`:533`, case-insensitive):
  `fromToken and toToken are the same address (<from>). Cannot swap a token to itself.`
- `validate_swap_mode` (`:553`): exact `exactIn`|`exactOut` else `--swap-mode must be "exactIn" or "exactOut", got "<v>"`.
- `validate_gas_level` (`:564`): exact `slow`|`average`|`fast` else `--gas-level must be "slow", "average", or "fast", got "<v>"`.
- `validate_tips` (`:575`): trim; empty → `--tips must not be empty`; Rust `f64::from_str` (accepts `+`, `.5`, `1.`, exponents, `inf`/`infinity`/`nan` case-insensitive; rejects whitespace/hex)
  fail → `--tips must be a number in SOL, got "<t>"`; `< 1e-10` → `--tips must be at least 0.0000000001 SOL, got "<t>"`; `> 2.0` → `--tips must be at most 2 SOL, got "<t>"`.
  (`NaN` passes because both comparisons are false.)
- `validate_approve_amount` (`:758`): on trimmed value: empty → `--amount must not be empty`; contains `.` → `--amount must be a whole number in minimal units (no decimals)`;
  non-digit → `--amount must be a whole number in minimal units, got "<a>". Infinity, NaN, negative numbers and non-numeric values are not accepted.`;
  `len>1 && starts '0'` → `--amount must not have leading zeros, got "<a>"`. `"0"` allowed.
- `fn cross_chain::fetch_supported_tokens` (`cross_chain.rs:37`) — **GET `/api/v6/dex/cross-chain/supported/tokens`** with optional `fromChainIndex`, `toChainIndex` (that order).
- `fn cross_chain::fetch_supported_bridges` (`:61`) — **GET `/api/v6/dex/cross-chain/supported/bridges`**, same params.
- `fn cross_chain::fetch_quote` (`:79`) — **GET `/api/v6/dex/cross-chain/quote`**. Query order: `fromChainIndex, toChainIndex, fromTokenAddress, toTokenAddress, amount, slippage(raw)`,
  then `userWalletAddress?`, `receiveAddress?`, `checkApprove=true` (only when true), `bridgeId?`, `sort?`, then each `allowBridge=<id>` (split on `,`, trimmed, empties dropped),
  then each `denyBridge=<id>`.
- `fn cross_chain::fetch_approve_tx` (`:446`) — **GET `/api/v6/dex/cross-chain/approve-tx`**: `chainIndex, tokenContractAddress, userWalletAddress, bridgeId, approveAmount`, `checkAllowance=true` only when requested.
- `fn cross_chain::fetch_swap` (`:469`) — **GET `/api/v6/dex/cross-chain/swap`**: `fromChainIndex, toChainIndex, fromTokenAddress, toTokenAddress, amount, slippage, userWalletAddress`,
  then `receiveAddress?`, `bridgeId?`, `sort?`, `allowBridge*`, `denyBridge*`. (No trace headers, no cache write.)
- `fn cross_chain::fetch_status` (`:517`) — **GET `/api/v6/dex/cross-chain/status`**: `hash`, `chainIndex?`, `bridgeId?`; then `annotate_bridge_id_mismatch` (`:539`):
  if requested bridge id given and response is an array, for every element whose `bridgeId` is a string or i64 that differs (string compare) from the requested one, insert
  `"_warning": "server-side bridgeId mismatch: requested <req>, response echoed <e>. Trust the bridgeName from your own quote/execute record."`.
- `fn cross_chain::resolve_order_id_to_tx_hash` (`:565`) — `ensure_tokens_refreshed()` (login required); `wallets.json` missing or `selectedAccountId` empty → `not logged in`;
  **GET `/priapi/v5/wallet/agentic/order/detail`** (`WalletApiClient::get_authed`, Bearer JWT) query `accountId, chainIndex, orderId`; returns `data[0].txHash` if non-empty
  else error `order-id <oid> not found on chain <ci> (no txHash in /order/detail)`. Shared with MCP.
- `fn cross_chain::validate_receive_address(addr, to_ci)` (`:1134`) — `looks_evm = starts "0x" && len==42`; `looks_sol = !starts "0x" && 32<=len<=44 && all chars Unicode-alphanumeric`.
  to-family `solana` (ci 501) && looks_evm → `receive-address looks like an EVM address, but destination chain is Solana. Please provide a Solana address.`;
  to-family `evm` (every other ci) && looks_sol → `receive-address looks like a Solana address, but destination chain is EVM. Please provide an EVM address (0x...).`
- `fn cross_chain::discover_transit_fallback` (`:395`) + `build_transit_candidates` (`:210`), `probe_transit` (`:361`), `build_transit_option` (`:243`),
  `classify_dead_end` (`:337`), `is_no_route` (`:179`), `parse_api_error` (`:162`) — see `cross-chain quote` step 7.
- `fn commands::common::wait_tx_onchain(client, tx_hash, ci)` (`commands/common.rs:35`, only used by this group) — timeout 20 s for ci `1`/`59144`, else 10 s
  (`tx_confirmation_timeout` `:23`). Loop: **GET `/api/v6/dex/post-transaction/transaction-detail-by-txhash?chainIndex=<ci>&txHash=<h>`**
  (`ApiClient::get`); request errors ignored; `data` (first element if array) `.txStatus` case-insensitive `success` → Ok; `fail` → error
  `tx <h> failed on-chain (chain=<ci>)`; then if `now >= deadline` → error `tx <h> not confirmed on-chain within <N>s (chain=<ci>)`; else sleep 1 s and repeat
  (≈N+1 requests max). An empty `<h>` drops the `txHash` param (empty-param filtering).

### Owned elsewhere (named only)

- `fn chains::resolve_chain` (`chains.rs:129`) — case-insensitive `chainName` match in `$ONCHAINOS_HOME/chain_cache.json` (no TTL), else alias table
  (`ethereum|eth→1, solana|sol→501, bitcoin|btc→0, bsc|bnb→56, polygon|matic→137, arbitrum|arb→42161, base→8453, xlayer|x layer|x-layer|okb→196, xlayer_test→1952,
  avalanche|avax→43114, optimism|op→10, fantom|ftm→250, sui→784, tron|trx→195, ton→607, linea→59144, scroll→534352, zksync→324, tempo→4217`), else input unchanged.
- `fn chains::ensure_supported_chain(ci, raw)` (`chains.rs:67`) — ok if ci in chain_cache.json or in `1,10,56,137,195,196,250,324,501,534352,607,784,1952,8453,42161,43114,59144`; else
  `unsupported chain: "<raw>" (resolved to "<ci>"). Use \`onchainos swap chains\` to list supported chains.`
- `fn chains::chain_family` (`:272`) — `"501"` → `solana`, everything else → `evm` (incl. Tron/TON/Sui).
- `fn chains::native_token_address` (`:341`) — 501 `11111111111111111111111111111111`, 784 `0x2::sui::SUI`, 195 `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, 607 `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c`,
  5042 `0x3600000000000000000000000000000000000000`, 0/5 `""`, else `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`.
- `fn chains::merges_batch_unsignedinfo` (`:285`) — true for `196`, `1952`.
- `fn chains::resolve_chains` (`:262`) — comma-split `resolve_chain` join.
- `fn token_alias::resolve_token_address` (`token_alias.rs:188`) — lower-cased key lookup in per-chain `TOKEN_MAP` (e.g. chain 1 `usdc→0xa0b8…eb48`, `usdt→0xdac1…1ec7`, `dai→0x6b17…1d0f`,
  `eth|native→0xeeee…`; chain 42161 `usdc→0xaf88…5831`, `usdt→0xfd08…cbb9`; 501 `usdc→EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, wSOL mint `So111…112`→native); miss → input unchanged (case preserved).
- `fn token_alias::validate_address_for_chain(ci, token, label)` (`:206`) — 501: `0x`-prefixed → `--<label> looks like an EVM address (0x…) but chain is Solana. Solana uses base58 addresses (e.g. EPjFWdd5...wyTDt1v). Did you mean to use a different chain?`;
  byte len ∉ [32,44] → `--<label> is not a valid Solana address: expected 32-44 base58 characters, got <n> characters ("<t>")`; non-base58 → `--<label> is not a valid Solana address: contains characters outside base58 alphabet ("<t>")`.
  195/607/784: no check. Others: base58-looking (no 0x, 32–44 ASCII alnum, ≥1 uppercase) → `--<label> looks like a Solana/base58 address but chain is EVM (chainIndex=<ci>). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?`;
  not `0x|0X`+40 hex → `--<label> is not a valid EVM address: expected 0x + 40 hex digits, got "<t>"`.
- `fn token_alias::resolve_and_validate` (`:277`) — resolve then validate.
- `fn validators::validate_amount` (`validators.rs:11`) — trimmed: empty `--amount must not be empty`; `.` `--amount must be a whole number in minimal units (no decimals)`; non-digit
  `--amount must be a whole number in minimal units, got "<a>". Infinity, NaN, negative numbers and non-numeric values are not accepted.`; all zeros `--amount must be greater than zero`;
  leading 0 `--amount must not have leading zeros, got "<a>"`.
- `fn validators::validate_slippage` (`:37`, percent) — `trim().trim_end_matches('%').trim()`; parse fail `--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "<s>"`;
  NaN/inf `--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "<s>"`; `<=0 || >100` `--slippage must be greater than 0 and at most 100, got "<s>"`.
- `fn validators::validate_slippage_zero_to_one` (`:62`, decimal) — trimmed; ends with `%` → `--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got "<s>"`;
  parse fail `--slippage must be a decimal number between 0 (exclusive) and 1 (inclusive), got "<s>"`; NaN/inf `--slippage must be a finite decimal number between 0 (exclusive) and 1 (inclusive), got "<s>"`;
  range `--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got "<s>"`.
- `fn validators::validate_non_negative_integer(v, label)` (`:97`) — `--<label> must not be empty` / `--<label> must be a non-negative integer, got "<v>"` / `--<label> must not have leading zeros, got "<v>"`.
- `fn validators::readable_to_minimal_str(amount, decimal)` (`:139`) — string math: trim; split at first `.`; empty integer → `0`; non-digit integer or fraction →
  `--readable-amount must be a positive number, got "<a>"`; fraction longer than `decimal` with any non-zero excess → `--readable-amount "<a>" has more decimal places than this token supports (<d> decimals)`;
  pad/truncate fraction; strip leading zeros; result `0` → `--readable-amount <a> is too small for this token (<d> decimals); results in zero minimal units`.
- `fn risk_classify::classify_swap_route(route)` (`risk_classify.rs:232`) — buy side = `toToken`, sell side = `fromToken`; `isHoneyPot` must be JSON `true`:
  to-token → action `block`, reason `to-token is a honeypot`; from-token → `warn`, `from-token is a honeypot; exit allowed`; tax signal is disabled (`normalize_tax_rate` returns NaN).
  Action = stricter (block>warn>ok); reason = reasons (to-side first) de-duplicated joined with `;` (empty when ok). Inserts `action`, `reason` if route is an object.
- `fn token::fetch_info` (`commands/token.rs:648`) — POST `/api/v6/dex/market/token/basic-info` body `[{"chainIndex","tokenContractAddress"}]`.
- `fn portfolio::fetch_all_balances(client, address, chains, None, None)` (`commands/portfolio.rs:143`) — GET `/api/v6/dex/balance/all-token-balances-by-address?address=<a>&chains=<resolve_chains(chains)>`.
- `fn agentic_wallet::balance::query_token_readable_balance(ci, token_addr)` (`balance/mod.rs:1106`) — requires login: `ensure_tokens_refreshed`, load `wallets.json`,
  `ensure_wallet_accounts_fresh` (POST `/priapi/v5/wallet/agentic/account/list` + `/account/address/list` only if local account data incomplete; persists wallets.json),
  GET `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances?accountId=<selected>&chains=<ci>`; returns the readable `balance` of the token whose `tokenAddress`
  equals `token_addr` (case-insensitive; `""` = native) and whose chain index matches, `None` if absent.
- `fn agentic_wallet::shared::common::amount::minimal_to_readable` (`amount.rs:32`) — integer string → decimal with trailing zeros trimmed (`"80000000",6 → "80"`).
- `fn agentic_wallet::shared::common::amount::value_as_decimal_string` (`amount.rs:63`) — string or u64 → string.
- `fn funding::build_funding_bundle(ci, FundingBlockedInput)` (`funding.rs:199`) — validates input, `ensure_tokens_refreshed`, strict account refresh
  (POST `/priapi/v5/wallet/agentic/account/list` + `/account/address/list`), resolves the selected account's receive address for `ci`, builds QR via `qr::build_qr_output`
  (may write a PNG in image-notify mode), returns the funding-blocked scene JSON (shape in `swap quote` Output). Owner: funding group.
- `fn agentic_wallet::transfer::execute_contract_call(to, chain, amt, input_data, unsigned_tx, gas_limit, from, aa_addr, aa_amount, mev, jito_unsigned_tx, force, tx_source, gas_token_address, relayer_id, enable_gas_station, agent_biz_type, agent_skill_name)` (`transfer/mod.rs:1563`) —
  `to` or `chain` empty → `to and chain are required`; `validate_non_negative_integer(amt, "amt")`; neither input nor unsigned tx → `either --input-data (EVM) or --unsigned-tx (SOL) is required`;
  then `sign_and_broadcast` (`:204`) with `contract_addr = to`, `is_contract_call = true`. Owner: wallet group. Summary of `sign_and_broadcast`:
  `ensure_tokens_refreshed` (error `session expired, please login again: onchainos wallet login`) → chain entry via `agentic_wallet::chain::get_chain_by_real_chain_index`
  (`chain_cache.json` TTL 600 s, else POST `/priapi/v5/wallet/agentic/chain/support/list` `{}`; miss → `unsupported chain: <chain>`) → signer address = `from` (address match) or,
  when `from=None`, the **selected account's** address for that chain (refresh via account/list + address/list once on miss) → loads `session.json` + keyring `session_key`
  (`not logged in`) → validates `to`/`contract-token`/`aa-dex-token-addr`/`gas-limit`/`aa-dex-token-amount` → reads `cache.json.swapTraceId` → **POST
  `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo`** (headers `ok-client-tid`=cached tid, `ok-client-timestamp`=now-ms when a tid is cached; body keys
  `amount, chainIndex(number), chainPath, contractAddr, fromAddr, sessionCert, toAddr` + optional `inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, jitoUnsignedTx, enableGasStation(true), gasTokenAddress, relayerId`)
  → `executeResult == false` → `transaction simulation failed: <executeErrorMsg|transaction simulation failed>` → Gas-Station phase handling (prompts exit 2 / setup exit 3) →
  HPKE-decrypt session key, ed25519 signatures into `msgForSign` → `extraData` = server `extraData` + `checkBalance, uopHash, encoding, signType, msgForSign` + `isMEV:true`(mev) + `skipWarning:true`(force)
  + `txSource`(if given) + `agentBizType` + `agentSkillName` + GS fields → **POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction`** (no retry; body
  `{"accountId","address","chainIndex","extraData":"<json string>"}`, same trace headers) → error code `81362` without force → `CliConfirming{message: <msg>, next: "If the user confirms, re-run the same command with --force flag appended to proceed."}` (exit 2)
  → on success clears `cache.json.swapTraceId` → returns `{txHash, orderId, …}` (strings, default `""`).
- `fn agentic_wallet::transfer::batch_sign_and_broadcast(chain, from, txs, is_contract_call, mev, force, tx_source, agent_biz_type, agent_skill_name)` (`transfer/mod.rs:822`) —
  1–5 elements; same login/chain/address/session resolution (with `from = Some(--wallet)`); validates each element; **POST `/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo`**
  (array body, no trace headers); response len 1..=request len; any `executeResult:false` → `batch element <i>: <msg>`; missing sign data → `batch element <i>: backend returned empty signing materials …`;
  per element `extraData` as above plus `extJson.batchBroadcastType=1`, `from7702Address=false`, `walletMainSaveConfirming=true`; response len 1 → **POST `/pre-transaction/broadcast-transaction`**,
  else **POST `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction`** (array body; response must equal request length). Does **not** read or clear `swapTraceId`. Owner: wallet group.
- `fn wallet_api::WalletApiClient::batch_support_chain_index_list` (`wallet_api.rs:1716`) — **POST `/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList`** body `{}` (Bearer JWT); `data` must be an array of strings or ints.
- `fn agentic_wallet::auth::ensure_tokens_refreshed` (`auth/mod.rs:132`) — session-key expiry guard (`session.json.sessionKeyExpireAt`), keyring tokens, refresh via POST `/priapi/v5/wallet/agentic/auth/refresh` when expiring.
- `fn agentic_wallet::common::handle_confirming_error` (`common.rs:67`) — 81362 → CliConfirming unless `--force`.
- `fn autotrade::notify::notify_swap_outcome(job, chain, display_amount, from, to, outcome)` (`notify.rs:272`) — builds an en/zh message and runs
  `okx-a2a user notify --content <msg> --job-id <job> --idempotency-key autotrade-swap:<sha256hex(job\0msg)> --json` (subprocess, 5 s timeout); failure → stderr
  `[autotrade] outcome notification failed (non-fatal): <e>`; never changes the command result. Owner: agent-commerce group.
- `wallet_store::set_swap_trace_id / get_swap_trace_id / clear_swap_trace_id` (`wallet_store.rs:245/252/258`) — read-modify-write `$ONCHAINOS_HOME/cache.json`
  (`{"login"?:{…},"swapTraceId"?:"…"}` pretty-printed, written via `cache.json.tmp` + rename).

---

## Commands

### `onchainos swap quote`  (hidden: no)
- Handler: `swap.rs:175-273`
- Options:
  - `--from <FROM>` String, required. Token address or alias (resolved per chain; not format-checked before the readable-amount lookup).
  - `--to <TO>` String, required.
  - `--amount <AMOUNT>` Option<String>, conflicts with `--readable-amount` (clap exit 2 `cannot be used with`).
  - `--readable-amount <READABLE_AMOUNT>` Option<String>, conflicts with `--amount`.
  - `--chain <CHAIN>` String, required (subcommand-local; shadows global).
  - `--swap-mode <SWAP_MODE>` String, default `exactIn` (validated at runtime, not by clap).
  - globals: `--dev` (hidden).
- Auth: jwt-optional (JWT attached when logged in; the balance context needs a logged-in session but degrades to `null`).
- Steps:
  1. `ci = resolve_chain(--chain)`; `ensure_supported_chain(ci, --chain)`.
  2. `raw = resolve_amount_arg(--amount, --readable-amount, --from, ci)` (may POST `/api/v6/dex/market/token/basic-info`; note for `exactOut` the readable amount is still converted with the **from-token** decimals).
  3. `quote = swap::fetch_quote(ci, --from, --to, raw, --swap-mode)` → GET `/api/v6/dex/aggregator/quote?chainIndex=<ci>&fromTokenAddress=<rf>&toTokenAddress=<rt>&amount=<raw>&swapMode=<mode>`, headers `ok-client-tid: <rf><ms>`, `ok-client-timestamp: <ms>`.
     (Validation inside: swap-mode, address formats `--from`/`--to`, same-token.)
  4. `classify_swap_response(&mut quote)` → each route gains `action`, `reason`.
  5. Balance context: `resolved_from = resolve_token_address(ci, --from)`; `balance_token = ""` if `resolved_from` equals native address (case-insensitive) else `resolved_from`;
     `wallet_balance = query_token_readable_balance(ci, balance_token).ok().flatten()` (any failure incl. not logged in → `None`; HTTP: wallet-all-token-balances, maybe auth/refresh, account/list, account/address/list).
  6. Insufficient-balance scene (all must hold, otherwise skip silently):
     - `wallet_balance = Some(balance)`;
     - `(symbol, Some(decimals))` from first route (`quote[0]` if array, else object) `.fromToken.tokenSymbol` and `.fromToken.decimal` (string→u32 or number);
     - `required = raw` if `--swap-mode != "exactOut"`, else `quote[0].fromTokenAmount` (string or u64) — missing → skip;
     - `balance_minimal = readable_to_minimal_str(balance, decimals)` — Err (incl. balance `"0"`, which is rejected as "too small") → **not insufficient**;
     - `is_allowance_insufficient(balance_minimal, required)` true;
     - `requested = minimal_to_readable(required, decimals)` Ok.
     Then `build_funding_bundle(ci, {asset: symbol if non-empty else resolved_from, tokenAddress: resolved_from, required: requested, balance: Some(balance), operation: "swap"})`
     (errors propagate as normal error exit 1) → return `CliFundingBlocked` → stdout `{"ok":false,"data":<scene>}`, **exit 1**.
  7. Else `attach_wallet_balance(&mut quote, wallet_balance)`; `output::success(quote)`.
- Output (success): `data` = aggregator quote `data` passthrough (array of route objects, keys sorted) with per route: `action` (`ok|warn|block`), `reason` (string), `walletBalance` (readable decimal string or `null`).
  Funding scene `data` (sorted keys):
  `{"decision":"blocked","nextAction":[],"payload":{"fundingNeed":{"asset","balance","required","shortfall"?,"tokenAddress"},"fundingTarget":{"accountName","chainIndex","chainName","gasFree","receiveAddress","sameNetworkRequired":true},"operation":"swap","qr":{"displayMode","imagePath"?,"markdownImage"?,"mimeType"?,"notifyCommandArgs"?,"requestedFormat":"auto","resolvedFormat"?,"terminalQr"?}},"phase":"funding_required","reason":"insufficient_balance"}`
  (`shortfall` = `required − balance` as trimmed decimal; `gasFree` true only for ci 196; `chainName` from `chains::chain_display_name`).
- Errors: validation strings above (exit 1); API errors `API error (code=…): …` (exit 1); clap errors (exit 2).
- Side effects: read-only (server). Local: may update `wallets.json` via account refresh; may write a QR PNG in funding scene (funding/qr group); audit log.
- Nondeterminism: `ok-client-tid`/`ok-client-timestamp` headers; quote payload; `walletBalance`; QR block/image path.
- Parity test cases:
  - SAFE `onchainos swap quote --from eth --to usdc --chain ethereum --amount 10000000000000000`
  - SAFE `onchainos swap quote --from eth --to usdc --chain ethereum --readable-amount 0.01 --swap-mode exactIn`
  - SAFE (no HTTP) `onchainos swap quote --from eth --to 0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE --chain ethereum --amount 1` → `fromToken and toToken are the same address (0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee). Cannot swap a token to itself.`
  - SAFE (no HTTP) `onchainos swap quote --from eth --to usdc --chain ethereum --amount 1 --swap-mode exactin` → `--swap-mode must be "exactIn" or "exactOut", got "exactin"`
  - SAFE (no HTTP) `onchainos swap quote --from eth --to usdc --chain 9999 --amount 1` → `unsupported chain: "9999" (resolved to "9999"). Use \`onchainos swap chains\` to list supported chains.`

### `onchainos swap swap`  (hidden: no)
- Handler: `swap.rs:274-314`
- Options: `--from` (req), `--to` (req), `--amount` ⟂ `--readable-amount`, `--chain` (req), `--slippage` Option (percent; omitted ⇒ auto slippage), `--wallet` (req),
  `--gas-level` default `average`, `--swap-mode` default `exactIn`, `--tips` Option (SOL), `--max-auto-slippage` Option (percent). All strings.
- Auth: jwt-optional.
- Steps:
  1. `ci = resolve_chain`; `ensure_supported_chain`.
  2. `raw = resolve_amount_arg(…)` (maybe basic-info POST).
  3. `swap::fetch_swap(ci, --from, --to, raw, --slippage, --wallet, --swap-mode, --gas-level, --tips, --max-auto-slippage)` — validation order and query as in Shared helpers;
     writes `cache.json.swapTraceId = <rf><ms>`; GET `/api/v6/dex/aggregator/swap` with trace headers.
  4. `classify_swap_response` (descends into each element's `routerResult`).
  5. `output::success(swap)`.
- Output: aggregator `/swap` `data` passthrough (array of `{routerResult:{…,action,reason}, tx:{…}}`), keys sorted. Does NOT sign or broadcast.
- Errors: validators (`--swap-mode…`, `--gas-level…`, `--slippage…`, `--tips…`, `--wallet …`, `--amount…`, `--from/--to …`, same-token), API errors; exit 1.
- Side effects: read-only on server; **local write** `$ONCHAINOS_HOME/cache.json` (`swapTraceId`), which a later `wallet contract-call` / `swap execute` / `cross-chain execute` broadcast will send as `ok-client-tid` and then clear.
- Nondeterminism: trace headers, tid in cache.json, calldata/quote.
- Parity test cases:
  - SAFE `onchainos swap swap --from eth --to usdc --chain ethereum --amount 10000000000000000 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
  - SAFE `onchainos swap swap --from eth --to usdc --chain ethereum --amount 10000000000000000 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --slippage 1 --gas-level fast`
  - SAFE (no HTTP) `… --gas-level turbo` → `--gas-level must be "slow", "average", or "fast", got "turbo"`
  - SAFE (no HTTP) `onchainos swap swap --from sol --to usdc --chain solana --amount 1000000 --wallet 5EDUCQDeVmaGohSAJYQ8mwe4hZMXgDzS4X2Si3Zh3cL5 --tips 3` → `--tips must be at most 2 SOL, got "3"`

### `onchainos swap approve`  (hidden: no)
- Handler: `swap.rs:315-323`
- Options: `--token <TOKEN>` req, `--amount <AMOUNT>` req (minimal units, `0` = revoke), `--chain <CHAIN>` req.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain`; `ensure_supported_chain`; `fetch_approve(ci, --token, --amount)`: `validate_approve_amount` (on trimmed copy), resolve token alias,
  `validate_address_for_chain(ci, token, "token")`, GET `/api/v6/dex/aggregator/approve-transaction?chainIndex=<ci>&tokenContractAddress=<t>&approveAmount=<--amount verbatim>`.
- Output: passthrough `data` (typically `[{"data":"0x095ea7b3…","dexContractAddress":…,"gasLimit":…,"gasPrice":…}]`, sorted keys).
- Errors: validate_approve_amount strings, token address errors, API errors; exit 1.
- Side effects: read-only (returns calldata only).
- Nondeterminism: gas fields.
- Parity test cases:
  - SAFE `onchainos swap approve --token usdc --amount 1000000 --chain ethereum`
  - SAFE `onchainos swap approve --token 0xdac17f958d2ee523a2206206994597c13d831ec7 --amount 0 --chain ethereum`
  - SAFE (no HTTP) `onchainos swap approve --token usdc --amount 1.5 --chain ethereum` → `--amount must be a whole number in minimal units (no decimals)`
  - SAFE (no HTTP) `onchainos swap approve --token usdc --amount 007 --chain ethereum` → `--amount must not have leading zeros, got "007"`

### `onchainos swap check-approvals`  (hidden: no)
- Handler: `swap.rs:324-341`
- Options: `--chain` req, `--address` req (owner), `--token` req, `--spender` Option.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain(--chain)` (**no `ensure_supported_chain`**); `fetch_check_approvals(ci, --address, --token, --spender)`:
  validate `--address` (label `address`, not alias-resolved), resolve+validate `--token`, validate `--spender`;
  POST `/api/v6/dex/pre-transaction/check-approvals` body `{"address":"<a>","chainIndex":"<ci>","spender"?:"<s>","tokens":[{"tokenContractAddress":"<t>"}]}`.
- Output: passthrough `data` (e.g. `[{"tokens":[{"spendable":"…",…}],…}]`).
- Errors: address validation, API errors; exit 1.
- Side effects: read-only.
- Nondeterminism: on-chain allowance values.
- Parity test cases:
  - SAFE `onchainos swap check-approvals --chain ethereum --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --token usdc`
  - SAFE `onchainos swap check-approvals --chain ethereum --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --token usdt --spender 0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f`
  - SAFE (no HTTP) `onchainos swap check-approvals --chain ethereum --address 0x123 --token usdc` → `--address is not a valid EVM address: expected 0x + 40 hex digits, got "0x123"`

### `onchainos swap chains`  (hidden: no)
- Handler: `swap.rs:342-344`
- Options: none of its own; global `--chain` accepted and ignored; `--dev` hidden.
- Auth: jwt-optional.
- Steps: GET `/api/v6/dex/aggregator/supported/chain` (no query); `output::success(data)`.
- Output: passthrough array of chain objects (sorted keys).
- Errors: API/network errors exit 1.
- Side effects: read-only.
- Nondeterminism: none beyond server data.
- Parity test cases: SAFE `onchainos swap chains`; SAFE `onchainos swap chains --chain solana` (identical request).

### `onchainos swap liquidity`  (hidden: no)
- Handler: `swap.rs:345-349`
- Options: `--chain` req.
- Auth: jwt-optional.
- Steps: `ci = resolve_chain`; `ensure_supported_chain`; GET `/api/v6/dex/aggregator/get-liquidity?chainIndex=<ci>`; success passthrough.
- Output: passthrough array of DEX sources.
- Errors: unsupported chain (no HTTP), API errors; exit 1.
- Side effects: read-only.
- Nondeterminism: none.
- Parity test cases: SAFE `onchainos swap liquidity --chain ethereum`; SAFE `onchainos swap liquidity --chain xlayer_test`; SAFE (no HTTP) `onchainos swap liquidity --chain 9999` (exit 1, `unsupported chain`).

### `onchainos swap execute`  (hidden: no)
- Handler: `swap.rs:350-429` → `cmd_execute` `:1000` (single-tx) / `cmd_execute_batch` `:1357` (batch).
- Options:
  - `--from` req, `--to` req, `--amount` ⟂ `--readable-amount`, `--chain` req, `--wallet` req, `--slippage` Option (percent), `--gas-level` default `average`,
    `--swap-mode` default `exactIn`, `--tips` Option, `--max-auto-slippage` Option,
  - `--mev-protection` bool flag (default false),
  - `--gas-token-address` Option, `--relayer-id` Option (doc says "must be paired" — **not enforced**), `--enable-gas-station` bool flag,
  - `--force` bool flag (sets `skipWarning:true` on broadcast; suppresses 81362 confirmation),
  - `--notify-job-id <NOTIFY_JOB_ID>` Option (visible in help; intended for autotrade cards).
- Auth: session-key signature (JWT + TEE session key; `--wallet` is only used for DEX API params in the single-tx path — signer = **selected account**; batch path signs with the account owning `--wallet`).
- Steps:
  1. `ci = resolve_chain(--chain)` (outside the notify wrapper). Everything below runs inside `run`:
  2. `ensure_supported_chain(ci, --chain)`.
  3. `raw = resolve_amount_arg(…)`.
  4. `cmd_execute`: `family = chain_family(ci)`; `native = native_token_address(ci)`; `from = resolve_token_address(ci, --from)`, `to = …`; `validate_swap_params`; `is_from_native = from ≈ native`.
  5. Routing: `batch = !is_from_native && !--enable-gas-station && --gas-token-address absent && --relayer-id absent && is_chain_batch_supported(ci)`, where
     `is_chain_batch_supported` = `ensure_tokens_refreshed()` then POST `/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList` `{}` and `ci ∈ list`; any error → false
     (only evaluated when the earlier conditions hold).
  **Batch path (`cmd_execute_batch`)**:
  B1. GET approve-transaction (`approveAmount=<raw>`); `approve_obj = data[0]` (or object); `data` string required (`missing 'data' field in approve response`); `dexContractAddress` optional.
  B2. POST check-approvals with `address=--wallet` (validated with label `address`), `token=from`, `spender=dexContractAddress` (if any).
  B3. `spendable = approvals[0].tokens[0].spendable` (string) else `"0"`; `(needs_approve, needs_revoke) = classify_approve_action(ci, from, spendable, raw)`.
  B4. `fetch_swap(…)` (all swap validations; caches tid; GET `/api/v6/dex/aggregator/swap`). `swap_result = data[0]` → null → `swap API returned empty result`.
      `tx.to` required (`missing tx.to in swap response`), `tx.data` required (`missing tx.data in swap response`), `tx.value` string else `"0"`, `tx.gas` string optional.
      AA params only when `ci == "196"`: `aaDexTokenAddr = from`, `aaDexTokenAmount = routerResult.fromTokenAmount (string) else raw`.
  B5. If `!needs_approve && !needs_revoke`: single broadcast via `execute_contract_call(tx.to, ci, value, Some(data), None, gas, aa…, --mev-protection, None, --force, tx_source None, no GS, agent_biz_type "dex", skill None)`
      (reads+clears cached tid). Output (below) with `approveTxHash: null`, `nextSteps` from swap hash only; done.
  B6. Else elements: `[revoke?]` (GET approve-transaction `approveAmount=0` → calldata; `{to_addr: from, value:"0", contract_addr: from, input_data}`), approve (`{from, "0", from, approve calldata}`),
      swap (`{tx.to, value, contract_addr: tx.to, input_data: tx.data, gas_limit: tx.gas, aa…}`).
  B7. `batch_sign_and_broadcast(ci, Some(--wallet), elems, true, --mev-protection, --force, None, Some("dex"), Some("okx-dex-swap-batch"))` (batch unsignedInfo + batch/single broadcast — FUNDS).
  B8. Length check: merging chain (196/1952) → len ∈ {1, request len}; else len == request len; otherwise error
      `batch broadcast on chain <ci>: response length <n> not in expected set (request length <m>, merging chain=<bool>)`.
  B9. `(approveTxHash, swapTxHash) = extract_batch_hashes(hashes, needs_approve, needs_revoke)`; output. The cached `swapTraceId` is left in cache.json.
  **Single-tx path (`cmd_execute`)**:
  S1. `gs_enable_remaining = --enable-gas-station` (true only for the first broadcast in this run, then false). `--gas-token-address`/`--relayer-id` are passed on every broadcast.
  S2. If `family == "evm" && !is_from_native`:
      - GET approve-transaction (`approveAmount=<raw>`) → calldata (required), `dexContractAddress` (optional);
      - POST check-approvals (`address=--wallet`, spender = dexContractAddress);
      - `spendable`, `(needs_approve, needs_revoke)` as B3;
      - if needs_approve: if needs_revoke → GET approve-transaction `approveAmount=0` → calldata → `execute_contract_call(from, ci, "0", Some(revoke calldata), None, None, None, None, mev=false, None, --force, None, gas_token, relayer, gs_enable, "dex", None)` (FUNDS/approval) →
        `wait_tx_onchain(revoke_hash, ci)`; then approve broadcast with the first approve calldata (same argument pattern) → `(approve_hash, approve_order_id)` → `wait_tx_onchain(approve_hash, ci)`.
  S3. `fetch_swap(…)` (validations for swap-mode/gas-level/slippage/tips/wallet happen **here**, i.e. after any approve broadcast); `swap_result = data[0]`; null → `swap API returned empty result`; `tx = swap_result.tx`.
  S4. Solana (`ci == "501"`): `tx.data` required (`missing tx.data (unsigned tx) in swap response`); `to = tx.to` else `""`; `jito = tx.signatureData[0]` (string) parsed as JSON → `.jitoCalldata` string;
      `mev = jito.is_some() || --mev-protection`; `execute_contract_call(to, ci, "0", None, Some(tx.data), None, None, None, mev, jito, --force, None, gas_token, relayer, gs_enable, "dex", None)`
      (`to == ""` → `to and chain are required`).
      EVM family: `tx.to` required (`missing tx.to in swap response`), `tx.data` required (`missing tx.data in swap response`), `value = tx.value` string else `"0"`, `gas = tx.gas` string opt;
      AA params when `ci ∈ {"196","1952"}` (`aaDexTokenAddr=from`, `aaDexTokenAmount=routerResult.fromTokenAmount` else raw);
      `execute_contract_call(tx.to, ci, value, Some(tx.data), None, gas, aa…, --mev-protection, None, --force, None, gas_token, relayer, gs_enable, "dex", None)` — **FUNDS**.
  S5. Output via `output::success(&out)` inside `cmd_execute`.
  6. `--notify-job-id` present: `display_amount = --readable-amount ?? --amount ?? "?"`; after `run` completes, `notify_swap_outcome(job, --chain (raw), display_amount, --from (raw), --to (raw), Ok(out)|Err(e))`
     (spawns `okx-a2a user notify …`, 5 s timeout, stderr on failure); on Err the original error is then returned (normal error/confirming output).
- Output `data` (sorted keys), both paths:
  `{"approveOrderId"?:string, "approveTxHash":string|null, "fromAmount":routerResult.fromTokenAmount, "fromToken":routerResult.fromToken, "gasUsed":routerResult.estimateGasFee, "nextSteps":{"checkApproveStatus"?:…, "checkSwapStatus"?:…}, "priceImpact":routerResult.priceImpactPercent, "swapOrderId"?:string, "swapTxHash":string, "toAmount":routerResult.toTokenAmount, "toToken":routerResult.toToken}`.
  `approveOrderId` / `swapOrderId` only when non-empty (Gas Station; single-tx path only). Missing routerResult fields → `null`. `nextSteps` strings e.g. `onchainos wallet history --tx-hash 0xabc --chain 1`.
- Errors (exit 1 unless noted): all validator strings; `missing 'data' field in approve response`; `swap API returned empty result`; `missing tx.to in swap response`; `missing tx.data in swap response`;
  `missing tx.data (unsigned tx) in swap response`; `missing txHash in contract-call output` (practically unreachable); `tx <h> failed on-chain (chain=<ci>)`; `tx <h> not confirmed on-chain within <N>s (chain=<ci>)`;
  batch length error; wallet-side errors (`session expired, please login again: onchainos wallet login`, `not logged in`, `unsupported chain: <ci>`, `transaction simulation failed: …`, `code=<c> msg=<m>` from `format_api_error`,
  `batch element <i>: …`); 81362 without `--force` → confirming JSON exit 2; Gas-Station prompts exit 2 / setup-required exit 3.
- Side effects: **FUND-MOVING** — POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` (revoke, approve, swap) and POST `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction`;
  state: unsignedInfo / batch unsignedInfo. Local: cache.json swapTraceId write/clear; wallets.json/chain_cache.json refresh (wallet group); audit log; optional `okx-a2a` subprocess.
- Nondeterminism: trace ids/timestamps, tx hashes, order ids, signatures, polling count/duration.
- Long-running: up to 20 s per `wait_tx_onchain` (×2 with revoke) plus network time.
- Parity test cases:
  - SAFE (no HTTP to DEX API) `onchainos swap execute --from usdc --to usdc --chain ethereum --amount 1000000 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` → same-token error.
  - SAFE (no HTTP) `onchainos swap execute --from eth --to usdc --chain ethereum --amount 0 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` → `--amount must be greater than zero`.
  - SAFE (clap, exit 2) `onchainos swap execute --from eth --to usdc --chain ethereum --amount 1 --readable-amount 1 --wallet 0xd8dA…6045`.
  - UNSAFE `onchainos swap execute --from eth --to usdc --chain base --readable-amount 0.0001 --wallet <own addr>` (native → no approve; single broadcast).
  - UNSAFE `onchainos swap execute --from usdc --to eth --chain base --readable-amount 0.1 --wallet <own addr> --force` (ERC-20 → approve/batch path).

### `onchainos cross-chain bridges`  (hidden: no)
- Handler: `cross_chain.rs:858-876`
- Options: `--from-chain` Option, `--to-chain` Option (both name or chainIndex); global `--chain` ignored.
- Auth: jwt-optional.
- Steps: each provided chain → `resolve_chain` (**no `ensure_supported_chain`**; unknown names pass through raw); GET `/api/v6/dex/cross-chain/supported/bridges[?fromChainIndex=…][&toChainIndex=…]`; success passthrough.
- Output: passthrough (sorted keys).
- Errors: API/network, exit 1.
- Side effects: read-only.
- Nondeterminism: none.
- Parity test cases: SAFE `onchainos cross-chain bridges`; SAFE `onchainos cross-chain bridges --from-chain ethereum --to-chain arbitrum`; SAFE `onchainos cross-chain bridges --to-chain base`.

### `onchainos cross-chain tokens`  (hidden: no)
- Handler: `cross_chain.rs:878-896`
- Options/Auth/Steps: identical to `bridges` but GET `/api/v6/dex/cross-chain/supported/tokens`.
- Output: passthrough array of `{chainIndex, tokenContractAddress, …}`.
- Errors: API/network, exit 1.
- Side effects: read-only.
- Nondeterminism: none.
- Parity test cases: SAFE `onchainos cross-chain tokens --from-chain ethereum`; SAFE `onchainos cross-chain tokens --from-chain ethereum --to-chain arbitrum`.

### `onchainos cross-chain quote`  (hidden: no)
- Handler: `cross_chain.rs:898-966`
- Options: `--from` req, `--to` req, `--from-chain` req, `--to-chain` req, `--readable-amount` ⟂ `--amount`, `--slippage` default `0.01` (decimal (0,1]),
  `--wallet` Option (help says required with `--check-approve`; **not enforced**), `--check-approve` flag, `--bridge-id` Option, `--sort` Option with clap PossibleValues `0|1|2`
  (else clap exit 2 `invalid value`), `--allow-bridges` Option (comma list), `--deny-bridges` Option, `--receive-address` Option.
- Auth: jwt-optional (see openQuestions re HTTP 402 when anonymous).
- Steps:
  1. `from_idx`, `to_idx` = resolve; `ensure_supported_chain` both (from first).
  2. `--receive-address` → `validate_receive_address(addr, to_idx)`.
  3. `from_token = resolve_and_validate(from_idx, --from, "from")`; `to_token = resolve_and_validate(to_idx, --to, "to")`.
  4. `validate_slippage_zero_to_one(--slippage)`.
  5. `raw = swap::resolve_amount_arg(--amount, --readable-amount, --from(raw), from_idx)`.
  6. `quote_res = cross_chain::fetch_quote(from_idx, to_idx, from_token, to_token, raw, --slippage(raw), --wallet, --check-approve, --bridge-id, --sort, --allow-bridges, --deny-bridges, --receive-address)`.
  7. `is_no_route(quote_res)`: Ok → `(data[0] or data).routerList` not an array or empty; Err → message parses as `…code=<c>)…` with `c ∈ {82000, 82104}`. If no route → transit fallback:
     a. GET `/api/v6/dex/cross-chain/supported/tokens?fromChainIndex=<from_idx>&toChainIndex=<to_idx>` (error → empty set); `bridgeable` = lower-cased `tokenContractAddress` of entries whose
        `chainIndex` **string** equals `from_idx`.
     b. candidates: for `usdc`, `usdt`, `dai` (in order) keep `{symbol: upper, address: resolve_and_validate(from_idx, sym), dest: resolve_and_validate(to_idx, sym)}` when both succeed; then
        `{NATIVE, native(from_idx), native(to_idx)}`; de-dup by lower-cased source address (first wins); keep if `bridgeable` empty or contains lower-cased source address.
     c. none → `{"message":"No common transit token (USDC / USDT / DAI / native) is bridgeable from this source chain.","outcome":"no_path","transitOptions":[]}`.
     d. Sequentially per candidate: `transit_amount = raw` if `from_token ≈ cand.address`, else `swap::fetch_quote(from_idx, from_token, cand.address, raw, "")` (GET `/api/v6/dex/aggregator/quote`,
        no `swapMode`, trace headers) → `data[0].toTokenAmount` string (missing → error msg `source→transit swap returned no amount`); then `cross_chain::fetch_quote(from_idx, to_idx, cand.address, cand.dest, transit_amount, --slippage, None, false, None…)`;
        option = `{bridgeId, bridgeName, crossChainFee, crossChainFeeTokenAddress, estimateTime, minimumReceived, otherNativeFee, toTokenAmount (all from routerList[0], null if missing), toTokenDecimals: data[0].toToken.decimals, transitToken: symbol}`;
        empty routerList → msg `transit bridge quote returned no route`; API errors → their `msg` part (`api_error_msg`).
     e. No options → `classify_dead_end(errors)`: all msgs empty/`unknown error` → `{"message":"Bridge service appears unavailable for this chain pair on this environment — the pair is in the routing config but quote returns no reason across the direct route and every transit token. Typically a server-side / adapter issue, not your token or amount. Retry later or escalate to OKX support.","outcome":"env_unavailable","transitOptions":[]}`;
        else `{"message":<first informative msg>,"outcome":"no_path","transitOptions":[]}`. Options → `{"outcome":"transit_available","transitOptions":[…]}`.
     f. `output::success([{"fallback":<obj>,"routerList":[]}])`, exit 0.
     Otherwise `output::success(quote_res?)` (other errors propagate, exit 1).
- Output: passthrough cross-chain quote `data` (array; `routerList[]` with `bridgeId`, `bridgeName`, `needApprove`, `needCancelApprove`, `toTokenAmount`, `minimumReceived`, `crossChainFee`, `estimateTime`, …) or the fallback wrapper.
- Errors: chain/address/receive/slippage/amount validation; API errors other than 82000/82104; exit 1.
- Side effects: read-only.
- Nondeterminism: fallback path aggregator trace headers; quote values.
- Parity test cases:
  - SAFE `onchainos cross-chain quote --from usdc --to usdc --from-chain ethereum --to-chain arbitrum --readable-amount 10`
  - SAFE `onchainos cross-chain quote --from usdc --to usdc --from-chain base --to-chain arbitrum --amount 10000000 --sort 1 --allow-bridges 636,52 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --check-approve`
  - SAFE (no HTTP) `… --slippage 0.5%` → `--slippage is decimal here (e.g. 0.01 for 1%, 0.005 for 0.5%); the '%' suffix only applies to swap/strategy (percent mode). Drop the '%' and divide by 100, got "0.5%"`
  - SAFE (no HTTP) `onchainos cross-chain quote --from usdc --to usdc --from-chain ethereum --to-chain solana --amount 1 --receive-address 0x896f4edd6601eda7d12f077a35e1cdf2898282ce` → receive-address EVM-on-Solana error.

### `onchainos cross-chain approve`  (hidden: no)
- Handler: `cross_chain.rs:968-1001`
- Options: `--chain` req, `--token` req, `--wallet` req (not validated), `--bridge-id` req (raw string), `--amount` ⟂ `--readable-amount` (one required at runtime), `--check-allowance` flag.
- Auth: jwt-optional.
- Steps:
  1. `ci = resolve_chain`; `ensure_supported_chain`; `token = resolve_and_validate(ci, --token, "token")`.
  2. `raw = resolve_approve_amount` (`:1175`): `--amount` → trim → `validate_non_negative_integer(raw, "amount")` (allows `0`); `--readable-amount` → trim; empty → `--readable-amount must not be empty`;
     canonical zero (`"0"` or `"0."` followed by ≥1 zeros only) → `"0"` with no HTTP; else POST basic-info for the **resolved** token (errors: `Failed to fetch token decimals for <token>: <e>. Use --amount with raw units instead.`,
     `Token not found for address <token> on chain <ci>. Verify the address is correct. Use --amount with raw units instead.`, `Invalid decimal value "<s>" for token <token>`, `Invalid decimal value for token <token>`,
     `Token decimal not found for <token>. Use --amount with raw units instead.`) → `readable_to_minimal_str`; neither → `either --amount or --readable-amount is required`.
  3. GET `/api/v6/dex/cross-chain/approve-tx?chainIndex&tokenContractAddress&userWalletAddress&bridgeId&approveAmount[&checkAllowance=true]`; success passthrough.
- Output: passthrough (e.g. `[{"tx":{"data":…,"gasLimit":…,…},…}]`).
- Errors: as listed; exit 1.
- Side effects: read-only (returns calldata).
- Nondeterminism: gas fields.
- Parity test cases:
  - SAFE `onchainos cross-chain approve --chain ethereum --token usdc --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --bridge-id 636 --amount 500000`
  - SAFE (no basic-info) `onchainos cross-chain approve --chain ethereum --token usdt --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --bridge-id 636 --readable-amount 0.000`
  - SAFE (no HTTP) `… --amount -1` → `--amount must be a non-negative integer, got "-1"`
  - SAFE (no HTTP) `onchainos cross-chain approve --chain ethereum --token usdc --wallet 0xd8dA…6045 --bridge-id 636` → `either --amount or --readable-amount is required`

### `onchainos cross-chain swap`  (hidden: no)
- Handler: `cross_chain.rs:1003-1055`
- Options: `--from`, `--to`, `--from-chain`, `--to-chain` (req), `--readable-amount` ⟂ `--amount`, `--slippage` default `0.01`, `--wallet` req, `--receive-address` Option,
  `--bridge-id` Option, `--sort` (0|1|2), `--allow-bridges`, `--deny-bridges`.
- Auth: jwt-optional.
- Steps: resolve+ensure both chains → resolve_and_validate from/to → `validate_address_for_chain(from_idx, --wallet, "wallet")` → `validate_receive_address` (if given) →
  `validate_slippage_zero_to_one` → `resolve_amount_arg(… --from raw, from_idx)` → GET `/api/v6/dex/cross-chain/swap` (param order in Shared helpers) → success passthrough.
- Output: passthrough (`[{"fromTokenAmount","toTokenAmount","minimumReceived","router":{…},"tx":{"to","data","value","gasLimit",…},…}]`).
- Errors: validation/API; exit 1.
- Side effects: read-only (unsigned calldata, no broadcast, no cache write).
- Nondeterminism: calldata.
- Parity test cases:
  - SAFE `onchainos cross-chain swap --from usdc --to usdc --from-chain base --to-chain arbitrum --amount 10000000 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
  - SAFE (no HTTP) `… --wallet 5EDUCQDeVmaGohSAJYQ8mwe4hZMXgDzS4X2Si3Zh3cL5` (EVM from-chain) → `--wallet looks like a Solana/base58 address but chain is EVM (chainIndex=8453). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?`

### `onchainos cross-chain execute`  (hidden: no)
- Handler: `cross_chain.rs:1057-1099` → `cmd_execute` `:1229-1608`.
- Options: `--from`, `--to`, `--from-chain`, `--to-chain`, `--wallet` (req); `--readable-amount` ⟂ `--amount`; `--slippage` default `0.01`; `--receive-address` Option;
  `--bridge-id` Option ⟂ `--route-index` (usize; bad value → clap exit 2); `--sort` (0|1|2); `--allow-bridges`; `--deny-bridges`; `--mev-protection` flag;
  `--confirm-approve` flag ⟂ `--skip-approve` flag (clap exit 2 `cannot be used with`); `--force` flag.
- Auth: session-key signature (signer = selected account via `execute_contract_call(from=None)`; `--wallet` used for API params and the balance gate).
- Steps:
  1. resolve+ensure `from_idx`, `to_idx`; `from_token`, `to_token` via resolve_and_validate; `validate_address_for_chain(from_idx, --wallet, "wallet")`; receive-address check;
     `validate_slippage_zero_to_one`; `raw = resolve_amount_arg(… --from raw, from_idx)`.
  2. `family = chain_family(from_idx)`, `native = native_token_address(from_idx)`, `is_from_native = from_token ≈ native`.
  3. **Balance gate** (`execute_balance_block`): GET `/api/v6/dex/balance/all-token-balances-by-address?address=<--wallet>&chains=<from_idx>`; any error or `data[0].tokenAssets` not an array → proceed.
     `token_raw = rawBalance` of the asset whose `tokenContractAddress ≈ from_token` (default `"0"`); `is_allowance_insufficient(token_raw, raw)` → block `insufficient_balance` /
     `Source token balance is less than the amount you want to bridge.`; if not native: `native_raw = rawBalance(native)` or, if `"0"`, `rawBalance("")`; `"0"`/empty → block `insufficient_gas` /
     `Source-chain native (gas) balance is zero — deposit native token for gas before bridging.`. Blocked → `output::success({"action":"blocked","block":<code>,"message":<msg>})`, **exit 0**.
  4. Quote: `cross_chain::fetch_quote(…, Some(--wallet), checkApprove=true, --bridge-id, --sort, allow, deny, --receive-address)`.
     No route (as in quote) → transit fallback (same algorithm) → `output::success({"action":"fallback","fallback":<obj>,"routerList":[]})`, exit 0. Other errors → exit 1.
  5. `router_list = (data[0] or data).routerList` non-empty (else `/quote returned empty routerList — no available route`); `i = --route-index ?? 0`; `i >= len` →
     `--route-index <i> out of bounds: routerList has <len> entries`; `route = router_list[i]`; `bridge_id = route.bridgeId` (i64 → string, or string; else `quote.routerList[0].bridgeId missing or wrong type`);
     `need_approve = route.needApprove == true`; `need_cancel = route.needCancelApprove == true`.
  6. `approve_branch = family == "evm" && !is_from_native && need_approve && !--skip-approve`.
  7. Default mode (`approve_branch && !--confirm-approve`):
     - if `need_cancel`: GET approve-tx (`approveAmount=0`, no checkAllowance); if `(data[0]).tx` is an object: `tx.data` required (`missing tx.data in revoke approve-tx`), `tx.gasLimit` opt →
       `wallet_contract_call(from_token, from_idx, "0", data, gasLimit, mev=false, --force)` → `wait_tx_onchain(hash, from_idx)`; non-object tx → silently skip.
     - GET approve-tx (`approveAmount=<raw>`); `tx` object required (`/approve-tx returned null tx — sanity check failed`); `tx.data` required (`missing tx.data in approve-tx response`); broadcast as above →
       `(approve_hash, approve_order_id)` → `wait_tx_onchain(approve_hash, from_idx)`; continue to swap.
  8. `--confirm-approve` mode (`approve_branch && --confirm-approve`): same revoke (no wait, hash discarded) and approve broadcasts **without waiting**; output
     `{"action":"approved","approveAmount":<raw>,"approveOrderId"?:…,"approveTxHash":<hash>,"bridgeId":<bridge_id string>,"bridgeName":route.bridgeName,"readableAmount":<--readable-amount or "">,"tokenAddress":from_token,"tokenSymbol":route.fromToken.tokenSymbol}`; exit 0, no swap.
     (If `--confirm-approve` is given but `approve_branch` is false, execution falls through to the swap broadcast.)
  9. Swap: GET `/api/v6/dex/cross-chain/swap` with `userWalletAddress=--wallet`, `receiveAddress?`, `bridgeId=<bridge_id>`, `sort?`, allow/deny; `swap_obj = data[0]`;
     `tx.to` required (`missing tx.to in swap response`), `tx.data` required (`missing tx.data in swap response`), `value = tx.value` string else `"0"`, `gasLimit = tx.gasLimit` string opt.
  10. `mev = --mev-protection || route.bridgeName` (lower-cased) contains `relay`|`mayan`|`butterswap`.
  11. `wallet_contract_call(tx.to, from_idx, value, data, gasLimit, mev, --force)`: for from-family `solana` → `execute_contract_call(to, ci, "0", input None, unsigned_tx=data, gas None, …)`; else
      `(to, ci, value, input=data, None, gasLimit, …)`; always `aa None, jito None, tx_source Some("3"), no Gas Station, agent_biz_type "cross-chain", skill None`. **FUNDS**.
  12. Output:
     - `!--skip-approve`: `{"action":"execute","approveOrderId"?,"approveTxHash"?,"bridgeId":<bridge_id string>,"bridgeName":route.bridgeName,"crossChainFee":route.crossChainFee,"estimateTime":route.estimateTime,"fromChainIndex":<from_idx>,"fromTxHash":<hash>,"minimumReceived":route.minimumReceived,"nextSteps":{"checkBridgeStatus":"onchainos cross-chain status --tx-hash <hash> --bridge-id <bridge_id> --from-chain <from_idx>"},"swapOrderId"?,"toTokenAmount":route.toTokenAmount}`
       (route fields come from the **quote** route; approve keys only when an approval ran / order id non-empty; `swapOrderId` only when non-empty).
     - `--skip-approve`: `{"action":"execute","approveTxHash":null,"bridgeId":swap.router.bridgeId (raw type),"crossChainFee":swap.router.crossChainFee,"estimateTime":swap.router.estimateTime,"fromAmount":swap.fromTokenAmount,"fromTxHash":<hash>,"minimumReceived":swap.minimumReceived,"selectedRoute":swap.router.bridgeName,"swapOrderId"?,"toAmount":swap.toTokenAmount}`.
- Errors: validation strings; `--route-index … out of bounds …`; approve-tx/swap shape errors listed; wait errors; wallet-side errors as in swap execute; 81362 without `--force` → confirming exit 2.
- Side effects: **FUND-MOVING** — POST `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` (revoke, approve, bridge tx). State: unsignedInfo. Local: consumes/clears any stale
  `cache.json.swapTraceId` (sent as `ok-client-tid`), wallet-group caches, audit log.
- Nondeterminism: tx hashes, order ids, signatures, polling.
- Long-running: up to 2×(10–20 s) confirmation waits in default mode.
- Parity test cases:
  - SAFE (no HTTP) `onchainos cross-chain execute --from usdc --to usdc --from-chain ethereum --to-chain arbitrum --readable-amount 10 --slippage 2 --wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` → `--slippage must be greater than 0 and at most 1 (decimal form, e.g. 0.01 = 1%), got "2"`
  - SAFE (no HTTP) `… --readable-amount "" …` → `--readable-amount must not be empty`
  - SAFE (clap exit 2) `… --confirm-approve --skip-approve`; `… --bridge-id 123 --route-index 0`; `… --sort 9`
  - UNSAFE (expected to stop at the balance gate with `{"action":"blocked","block":"insufficient_balance",…}`, exit 0, but if the balance lookup fails the flow continues to quote → approve/bridge broadcasts signed by the **selected account**, so never run it against a funded session) `onchainos cross-chain execute --from usdc --to usdc --from-chain base --to-chain arbitrum --amount 100000000000000 --wallet 0x0000000000000000000000000000000000000001`
  - UNSAFE `onchainos cross-chain execute --from usdc --to usdc --from-chain base --to-chain arbitrum --readable-amount 1 --wallet <own addr>`

### `onchainos cross-chain status`  (hidden: no)
- Handler: `cross_chain.rs:1101-1122`
- Options: `--tx-hash` Option (`required_unless_present = "order_id"`, `conflicts_with = "order_id"`), `--order-id` Option (mirror), `--bridge-id` String req, `--from-chain` String req.
  Missing both → clap exit 2 (`the following required arguments were not provided`); both → clap exit 2 (`cannot be used with`).
- Auth: jwt-optional with `--tx-hash`; jwt-required with `--order-id`.
- Steps: `ci = resolve_chain(--from-chain)` (no ensure); hash = `--tx-hash` verbatim, or `resolve_order_id_to_tx_hash(--order-id, ci)` (GET `/priapi/v5/wallet/agentic/order/detail`);
  GET `/api/v6/dex/cross-chain/status?hash=<h>&chainIndex=<ci>&bridgeId=<id>`; `annotate_bridge_id_mismatch`; success.
- Output: passthrough array; mismatching rows gain `"_warning"` (sorted: `_warning` precedes lower-case keys).
- Errors: `not logged in`, `session expired, please login again: onchainos wallet login`, `order-id <oid> not found on chain <ci> (no txHash in /order/detail)`, API errors; exit 1.
- Side effects: read-only.
- Nondeterminism: bridge progress.
- Parity test cases:
  - SAFE `onchainos cross-chain status --tx-hash 0x0000000000000000000000000000000000000000000000000000000000000000 --bridge-id 636 --from-chain base`
  - SAFE (clap exit 2) `onchainos cross-chain status --bridge-id 636 --from-chain base`
  - SAFE (needs login) `onchainos cross-chain status --order-id 1659439748798636032 --bridge-id 636 --from-chain base`

---

## Endpoint classification (this group)

| Method | Path | Class | Used by |
|---|---|---|---|
| GET | `/api/v6/dex/aggregator/quote` | read | swap quote; cross-chain quote/execute (transit leg 1) |
| GET | `/api/v6/dex/aggregator/swap` | read | swap swap, swap execute |
| GET | `/api/v6/dex/aggregator/approve-transaction` | read | swap approve, swap execute |
| POST | `/api/v6/dex/pre-transaction/check-approvals` | read | swap check-approvals, swap execute |
| GET | `/api/v6/dex/aggregator/supported/chain` | read | swap chains |
| GET | `/api/v6/dex/aggregator/get-liquidity` | read | swap liquidity |
| POST | `/api/v6/dex/market/token/basic-info` | read | every `--readable-amount` path |
| GET | `/api/v6/dex/post-transaction/transaction-detail-by-txhash` | read | swap execute, cross-chain execute (wait) |
| GET | `/api/v6/dex/balance/all-token-balances-by-address` | read | cross-chain execute (balance gate) |
| GET | `/api/v6/dex/cross-chain/supported/tokens` | read | cross-chain tokens; quote/execute fallback |
| GET | `/api/v6/dex/cross-chain/supported/bridges` | read | cross-chain bridges |
| GET | `/api/v6/dex/cross-chain/quote` | read | cross-chain quote, execute |
| GET | `/api/v6/dex/cross-chain/approve-tx` | read | cross-chain approve, execute |
| GET | `/api/v6/dex/cross-chain/swap` | read | cross-chain swap, execute |
| GET | `/api/v6/dex/cross-chain/status` | read | cross-chain status |
| GET | `/priapi/v5/wallet/agentic/order/detail` | read | cross-chain status `--order-id` |
| GET | `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances` | read | swap quote (walletBalance) |
| POST | `/priapi/v5/wallet/agentic/account/list` | read | swap quote (balance/funding), execute address refresh |
| POST | `/priapi/v5/wallet/agentic/account/address/list` | read | same |
| POST | `/priapi/v5/wallet/agentic/chain/support/list` | read | execute flows (chain entry lookup, 600 s cache) |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/batch/supportChainIndexList` | read | swap execute routing |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | any command when JWT expired |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` | state | swap execute, cross-chain execute |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo` | state | swap execute (batch) |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` | funds | swap execute, cross-chain execute |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction` | funds | swap execute (batch) |

## External hosts / processes

- Base URL: compiled `ONCHAINOS_COMPILED_BASE_URL` (prod `https://web3.okx.com`); `--dev` → `https://beta.okex.org`.
- DoH failover (core, inside `ApiClient`/`WalletApiClient`): pilot binary hosts `static.okx.com`, `static.coinall.ltd`, `okg-pub-hk.oss-cn-hongkong.aliyuncs.com`, `static.jingyunyilian.com`.
- Local subprocess `okx-a2a user notify …` (swap execute `--notify-job-id` only).

## Auth dependencies (for re-implementing the same login flow)

Read-only commands work anonymously; they attach `Authorization: Bearer <access_token>` when a session exists. `swap execute`/`cross-chain execute` (and `status --order-id`,
the `swap quote` balance/funding extras) need the full `wallet login` state: keyring `access_token`/`refresh_token`/`session_key`, `session.json`
(`sessionCert`, `encryptedSessionSk`, `sessionKeyExpireAt`), `wallets.json` (`selectedAccountId`, `accountsMap[].addressList[]` with `chainName`/`chainPath`), and `chain_cache.json`.
The signing path is TEE session-key based (HPKE-decrypt `encryptedSessionSk` with `session_key`, ed25519 signatures) and is owned by the wallet/auth group.

## Behavioural quirks to reproduce (or consciously deviate from)

1. `swap swap` writes `swapTraceId` into cache.json; any later contract-call broadcast (incl. cross-chain execute and the approve/revoke legs of swap execute) sends that stale id as `ok-client-tid` and clears it; the batch path leaves the fresh id behind.
2. `swap execute` single-tx path validates swap-mode/gas-level/slippage/tips/`--wallet` format only inside `fetch_swap`, i.e. **after** approve/revoke broadcasts. The approve legs validate `--wallet` with the label `address`.
3. `swap quote --swap-mode exactOut --readable-amount X` converts X with the from-token decimals.
4. `swap quote` never enters the funding scene when the held balance is `"0"` (readable→minimal rejects zero).
5. Batch AA params only for chain 196; single-tx path for 196 and 1952.
6. `cross-chain execute --confirm-approve` falls through to the swap broadcast when no approval is needed.
7. `cross-chain execute` balance gate looks up a native from-token by the `0xeeee…` placeholder only (no `""` fallback for the from-token check).
8. `validate_receive_address` rejects 32–44-char alphanumeric (e.g. Tron `T…`) receive addresses for any non-Solana destination.
9. Raw flag strings (slippage with `%`, tips, approve amount) are sent untrimmed/unstripped even though validation trims.
10. `wait_tx_onchain` with an empty hash (Gas-Station async order) drops `txHash` and ends in the timeout error.
11. `cross_chain::build_approve_calldata` / `decimal_to_hex64` (`:1641-1687`) are dead code (never called).
