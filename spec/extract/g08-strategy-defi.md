# g08-strategy-defi — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: `onchainos strategy …` (limit orders on Agentic Wallet, 4 leaves) and `onchainos defi …` (18 leaves).
No command or flag in this partition carries `hide = true`; the only hidden option reachable from these
commands is the root-level global `--dev` (owned by core, see "Global options").

## Sources read

Partition files (all read fully, including `#[cfg(test)]` modules used as oracles):

| File | Lines |
|---|---|
| `commands/agentic_wallet/strategy/mod.rs` | 36 |
| `commands/agentic_wallet/strategy/api.rs` | 200 |
| `commands/agentic_wallet/strategy/handlers.rs` | 1655 |
| `commands/agentic_wallet/strategy/session.rs` | 78 |
| `commands/agentic_wallet/strategy/status.rs` | 552 |
| `commands/agentic_wallet/strategy/supported_chains.rs` | 88 |
| `commands/agentic_wallet/strategy/trader_mode.rs` | 471 |
| `commands/agentic_wallet/strategy/types.rs` | 354 |
| `commands/defi/mod.rs` | 719 |
| `commands/defi/api.rs` | 321 |
| `commands/defi/helpers.rs` | 329 |
| `commands/defi/operations.rs` | 1089 |
| **total** | **5892** |

Supporting files consulted (only the parts the partition calls into; behaviour owned by other groups is only
named/summarised): `main.rs` (316, full), `commands/mod.rs` (134, full), `client.rs` (2469; lines 1-1260),
`output.rs` (450; 1-200), `chains.rs` (623; 1-280), `token_alias.rs` (536; 1-340), `validators.rs` (442; 1-140),
`commands/sink.rs` (1022; 1-110, 360-470), `crypto.rs` (810; 1-330), `wallet_store.rs` (848; 1-200, 385-410),
`keyring_store.rs` (404; 79-200), `commands/agentic_wallet/auth/mod.rs` (1-60, 100-347),
`commands/agentic_wallet/account.rs` (395-476), `commands/agentic_wallet/common.rs` (line 1),
`commands/market.rs` (215-260), `commands/token.rs` (640-710), `endpoints.rs` (1-60), `doh/manager.rs` (263-270),
`doh/binary.rs` (45-48), `home.rs` (1-30), `wallet_api.rs` (644-701, 1429-1441), `Cargo.toml`, `Cargo.lock` (serde_json entry),
`spec/cli-tree.json` (strategy + defi subtrees).

---

## Shared helpers (used across groups or from core)

### 0. Cross-cutting facts that affect byte-parity

1. **JSON key order.** `serde_json` is built WITHOUT `preserve_order` (Cargo.lock `serde_json 1.0.149` has no
   `indexmap` dependency). Every `serde_json::Value` object is a `BTreeMap`, so:
   - every JSON **request body** in this partition is serialised with keys sorted by byte-wise ascending order at every
     nesting level (strategy bodies are built with `serde_json::to_value(struct)` → `Value`; defi bodies are built with `json!`);
   - every `data` payload printed by these commands has sorted keys (passthrough responses are parsed into `Value` and
     re-serialised; handler-built objects use `json!`).
   - The outer envelope is a struct (`output::JsonOutput`) and keeps field order `ok`, `data`, `error`, `notifications`.
2. **Number round-trip.** Passthrough responses are parsed with plain serde_json (no `arbitrary_precision`): integers
   that fit u64/i64 re-print identically; floats re-print in shortest round-trip form (e.g. `1.50` → `1.5`, `1e5` →
   `100000.0`); integers above u64::MAX become f64.
3. **Output envelope** (`output::success`, output.rs:44): one line on stdout,
   `{"ok":true,"data":<data>}` plus `"notifications":[…]` only when payment notifications were queued (core,
   `payment_notify::drain_events`). Compact unless env `ONCHAINOS_PRETTY=1` (then `to_string_pretty`).
   `data` = `null` is printed as `"data":null`.
4. **Error envelope / exit codes** (main.rs:248-315, owned by core): any `Err` → stdout `{"ok":false,"error":"<{e:#}>"}`
   exit 1, where `{e:#}` is the anyhow chain joined with `": "` (outermost context first). A `CodedError`
   (only `strategy cancel --all --wait`) → `output::error_coded_details` → stdout JSON built with `json!`, so keys are
   sorted: `{"error":"<msg>","errorCode":"invalid_input","errorField":"wait","ok":false}` (+`notifications` if any),
   exit 1. clap usage errors (missing required flag, bad enum value, value-parser error, conflicts) → clap's own
   text on **stderr**, exit **2**, no JSON.
5. **Rust number parsing/formatting** that must be mimicked:
   - `str::parse::<f64>()`: no surrounding whitespace allowed; accepts `[+-]`digits with optional `.`/exponent,
     leading `.5`, trailing `5.`, `inf`/`infinity`/`nan` (case-insensitive); rejects hex, `_`, empty. Error Display:
     `invalid float literal`, or `cannot parse float from empty string`.
   - `parse::<u32>/<i32>/<i64>/<u128>`: optional leading `+` (and `-` for signed), digits only. Error Display:
     `invalid digit found in string`, `cannot parse integer from empty string`, `number too large to fit in target type`
     (`number too small to fit in target type` for negative overflow).
   - `format!("{}", f64)` never uses exponent notation (e.g. `1e-7` → `0.0000001`) and prints integral values without
     `.0` (`150.0` → `150`). JS `String(x)` differs below 1e-6 / at ≥1e21 → needs a custom formatter.
   - `format!("{:.N}", f64)` is exact-decimal rounding with ties-to-even on the exact binary value; JS `toFixed`
     picks the larger candidate on exact ties and switches to exponent at ≥1e21.
6. **Audit log**: main.rs appends one audit record per invocation (`audit::log("cli", "<command name>", ok, elapsed,
   redacted argv, err)`) under ONCHAINOS_HOME (core-owned; not part of stdout).

### 1. `ApiClient` (core, client.rs) — used by every command here

- `fn commands::Context::client_async` (commands/mod.rs:53) → `ApiClient::new_async` (client.rs:246). Auth
  resolution (`resolve_auth_async`, client.rs:268): keyring `access_token` absent/empty → Anonymous; JWT `exp` in the
  future → `Jwt`; expired + keyring `refresh_token` absent → Anonymous; refresh token expired → stderr
  `Session expired. Please log in again: onchainos wallet login` and Anonymous; otherwise
  `wallet_api::force_refresh_access_token` (POST `/priapi/v5/wallet/agentic/auth/refresh`, class auth, owned by auth
  group); on failure stderr `Failed to refresh session (<e>). Falling back to anonymous access.` and Anonymous.
  Client timeout 10 s; `User-Agent: OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`; DoH failover manager
  (`crate::doh`, core).
- Headers on every request (client.rs:346-385): `Content-Type: application/json`, `ok-client-version: 4.6.3`,
  `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <id>` (if available), `device-name: <name>`,
  and in JWT mode `Authorization: Bearer <access_token>`. Extra per-call headers are merged after these.
- GET query building (client.rs:413): pairs with **empty values are dropped**; remaining pairs appended in given order
  with `application/x-www-form-urlencoded` encoding (space → `+`). No `?` when no pairs survive.
- POST body: `serde_json::to_string(body)` (compact, sorted keys per §0.1).
- `get`/`post` (client.rs:442/590): payment pre-sign + 402 retry (core), **plus** a one-shot retry after
  `force_refresh_access_token` when in JWT mode and the error is an invalid-token error (codes
  `10001`,`10008`,`53017`,`130100031` or text `invalid access token`/`access token invalid`). Response goes through
  `unwrap_envelope` (client.rs:175): bare JSON array → returned as-is; `code` equal to string `"0"` or number `0` →
  returns `body["data"]` (missing → `null`); otherwise error `API error (code=<code>): <msg>` where `<msg>` is trimmed
  `msg` or `unknown error` if empty/missing, and code `50114` gets suffix
  `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` (`augment_auth_error_msg`, client.rs:153).
- `get_with_headers_raw`/`post_with_headers_raw` (client.rs:655/690): same transport + payment flow, **no invalid-token
  refresh retry**, and **no envelope unwrap** — full body returned. Used only by strategy.
- HTTP-level errors (both variants, client.rs:908-942): 429 → `Rate limited — retry with backoff`; ≥500 →
  `Server error (HTTP <n>)`; empty body → `Empty response body (HTTP <n>). The requested operation may not be supported for the given parameters.`;
  non-JSON body → `HTTP <n> <reason>: <trimmed text>`; transport connect/timeout after DoH exhaustion →
  `Network unavailable — check your connection and try again: <reqwest error>`; other transport → `request failed: <e>`.

### 2. Strategy-owned helpers

- `fn strategy::api::data_field` (strategy/api.rs:23) — object body → remove & return `data` (missing → `null`);
  non-object body → error `strategy endpoint returned a non-object body — got: <compact json>`.
- `STRATEGY_AUTH_HEADERS` (api.rs:19) — every strategy call adds header `X-Web3-Auth-Type: 1`.
- `fn strategy::status::check_response` (status.rs:204) — `code = body.code.as_i64()` (**only JSON numbers**; a
  missing or string-typed `code` is treated as `0` = success). `code == 0` → Ok. Otherwise
  `StrategyApiError{code, msg, kind}` whose Display is `BE strategy error code=<code>: <msg>`; `msg` = `body.msg` if it
  is a JSON string (even empty), else `StrategyError::user_message(kind)`; then `augment_auth_error_msg(code, msg)`
  (50114 suffix as above). `kind` = `StrategyError::from_code` table:

  | code | kind | fallback user_message (used only when `msg` is not a string) |
  |---|---|---|
  | 100 | RequestParam | `Request parameters are invalid.` |
  | 10019 | InsufficientNativeGas | ``Wallet's native token balance is too low to pay this chain's gas fees. Top up the native gas token (deposit, transfer from another account, or swap a stablecoin into native via `swap execute`) and retry.`` |
  | 10026 | JwtVerifyFailed | ``Session expired. Please run `onchainos wallet login` and retry.`` |
  | 10106 | ChainNotSupported | `This chain is not supported for limit orders.` |
  | 60002 | NoOrderFound | `No matching order was found.` |
  | 60003 | NoAuthority | `Limit-order permission missing. Trader Mode may not be activated yet.` |
  | 60006 | OutOfLimit | `Pending order count is at the limit. Cancel some orders before creating new ones.` |
  | 60009 | Illiquidity | `Insufficient liquidity to place this order.` |
  | 60014 | ExpiredCannotOperate | `Order has expired and cannot be modified.` |
  | 60015 | PendingCannotOperate | `Order is pending and cannot be modified.` |
  | 60017 | SuccessCannotOperate | `Order already completed and cannot be modified.` |
  | 60018 | UpgradeRequired | `Trader Mode SA needs to be re-activated; CLI will handle this transparently.` |
  | 60030 | QuotaExceeded | `Quota exceeded for this account.` |
  | 100007 | TeeSignFailure | `TEE signing failed. Try again shortly.` |
  | 100010 | OrderAmountTooSmall | `Order value is below the minimum of $1 USD. Increase --amount and retry.` |
  | 100012 | InsufficientBalance | `Insufficient balance to place this order.` |
  | other | Unknown(code) | `Unknown strategy error.` |

  Only `60018` (retry after SD-A) and `100010` (create-limit → `belowMinimum` success) are special-cased; the error is
  matched by type, never by string.
- `fn strategy::api::create_order` (api.rs:36) — POST `/api/v6/dex/strategy/agentic/limitOrder/createOrder`, body =
  `CreateOrderReq`, → `check_response` → `data` deserialised as `OrderListResp` (error context
  `createOrder: data shape did not match OrderListResp`). Class **funds**.
- `fn strategy::api::cancel` (api.rs:54) — POST `/api/v6/dex/strategy/agentic/limitOrder/cancel`; `data: null` →
  `CancelResp{updateNum:0, estimatedWaitTime:None}`; else deserialise (context `cancel: data shape did not match CancelResp`). Class **state**.
- `fn strategy::api::get_open_order` (api.rs:72) — POST `/api/v6/dex/strategy/agentic/limitOrder/getOpenOrder`;
  `data: null` → empty list/`cursor: None`; else `ListOrdersResp` (context `getOpenOrder: response did not match ListOrdersResp`). Class **read**.
- `fn strategy::api::open_order_detail` (api.rs:93) — GET `/api/v6/dex/strategy/agentic/limitOrder/openOrderDetail`
  query in order `accountId`, `orderId`, `strategyMode` (decimal string); → `OrderListResp` (context
  `openOrderDetail: data shape did not match OrderListResp`). Class **read**.
- `fn strategy::api::reactivate` (api.rs:119) — POST `/api/v6/dex/strategy/agentic/limitOrder/reactivate`
  body `{"accountId","orderIds"}`. Response mapping: `data` is an object containing `successIds` or `failIds` →
  deserialise `ReactivateResp` (both default `[]`; elements must be JSON strings, context
  `reactivate: data shape did not match ReactivateResp`); else object with integer `updateNum` → `updateNum > 0` ?
  `{successIds: req.orderIds, failIds: []}` : `{successIds: [], failIds: req.orderIds}`; anything else (null, other) →
  both `[]`. Class **funds** (re-arms TEE auto-execution of previously signed orders; unsigned request).
- `fn strategy::api::request_attest_doc_hex_from_sa` (api.rs:161) — GET `/priapi/v5/wallet/agentic/strategy/getAttestDocHex`
  (no query) → `data` must be an array (`getAttestDocHex: response not an array — got: <json>`), first element must be
  a string (`getAttestDocHex: array is empty`). Class **read**.
- `fn strategy::api::register_tee_info` (api.rs:185) — POST `/priapi/v5/wallet/agentic/strategy/registerTeeInfo`,
  body sorted: `{"accountId","attestDocHex","expireTimestamp","sessionCert","sessionSig","timestamp"}`
  (timestamps are JSON integers, ms). Class **funds** (delegates auto-signing authority to the SA TEE for 30 days).
- `fn strategy::session::load` (session.rs:23) — local only, no HTTP:
  1. `wallet_store::load_session()` reads `$ONCHAINOS_HOME/session.json` (default `~/.onchainos`; camelCase:
     `saTeeId`, `sessionCert`, `encryptedSessionSk`, `sessionKeyExpireAt`, `deviceId`, all default `""`). Missing file
     → `not logged in`. Read/parse failure → `failed to read session.json: …` / `failed to parse session.json: …`.
  2. keyring `session_key` (`keyring_store::get`) missing → `not logged in`.
  3. `crypto::hpke_decrypt_session_sk(encryptedSessionSk, session_key)` (crypto.rs:39): RFC 9180 single-shot open,
     mode Base, KEM DHKEM(X25519, HKDF-SHA256), KDF HKDF-SHA256, AEAD AES-256-GCM, `info = "okx-tee-sign"`, empty AAD;
     input = base64(enc[32] ‖ ciphertext); key = base64 32-byte X25519 private key. Output 32-byte Ed25519 seed,
     re-encoded base64. Errors: `encrypted_session_sk is not valid base64: …`, `session_key is not valid base64: …`,
     `session_key must be 32 bytes, got <n>`, `encrypted_session_sk too short: <n> bytes (need > 32)`,
     `invalid X25519 private key: …`, `invalid HPKE encapped key: …`, `HPKE decryption failed: …`,
     `decrypted signing seed must be 32 bytes, got <n>`.
  4. `wallet_store::load_wallets()` reads `$ONCHAINOS_HOME/wallets.json` (missing → `not logged in`).
  5. `account::resolve_active_account_id` (account.rs:403): `selectedAccountId` if non-empty; else first
     `accounts[]` with `isDefault`; else the **first key of `accountsMap` in Rust HashMap iteration order (random per
     process)**; else `no wallet accounts found`.
  6. `accountsMap[accountId]` missing → `active account not found in wallets map`.
  7. `evm_address` = `address` of the FIRST `addressList[]` entry whose `chainIndex != "501"` (any non-Solana
     chain, not necessarily EVM) or `""`; `sol_address` = first entry with `chainIndex == "501"` or `""`.
  Returns `{account_id, session_cert, sa_tee_id, seed_b64, evm_address, sol_address}`.
  `wallet_address_for(chain)`: `"501"` or `"solana"` → sol_address, else evm_address (session.rs:72).
- `fn strategy::supported_chains::ensure_strategy_chain` (supported_chains.rs:26) — whitelist, in this order:
  `1 Ethereum`, `56 BSC`, `196 X Layer`, `501 Solana`, `8453 Base`, `42161 Arbitrum`. Error:
  `chain "<raw>" (resolved to chainIndex <idx>) is not supported for strategy orders. Phase 1 supports: Ethereum (1), BSC (56), X Layer (196), Solana (501), Base (8453), Arbitrum (42161)`.
- `fn strategy::trader_mode::build_intent` (trader_mode.rs:54) — exact bytes (LF, no trailing newline):
  ```
  You will place an order which will be verified and auto-signed by the trusted execution environment.

  Chain Index: <chainId as integer>
  Strategy Type: LimitOrderUbased
  Recipient: <user wallet address>
  Created At: <YYYY-MM-DDTHH:mm:ss.sssZ>
  Expired At: <YYYY-MM-DDTHH:mm:ss.sssZ>
  From Token: <resolved from-token>
  To Token: <resolved to-token>
  From Amount(precision adjusted): <raw integer string>
  Timestamp: <now ms>
  ```
  (test oracle trader_mode.rs:207-221.)
- `fn strategy::trader_mode::human_decimal_to_raw_integer` (trader_mode.rs:82) — `t = trim(amount)`; empty →
  `amount is empty`; any byte not `0-9`/`.` → ``amount must be a positive decimal number, got `<t>` ``; >1 dot →
  ``amount has multiple decimal points, got `<t>` ``; split at dot; `len(frac) > decimals` →
  ``amount `<t>` has <len(frac)> fractional digit(s), more than the token's <decimals> decimals``;
  `buf = int + frac + "0"*(decimals-len(frac))`; strip leading zeros; empty → ``amount must be > 0, got `<t>` ``.
  Oracles: `("0.01",6)→"10000"`, `("1.5",18)→"1500000000000000000"`, `(".5",6)→"500000"`, `("0.000001",6)→"1"`.
- `fn strategy::trader_mode::sign_intent` (trader_mode.rs:117) — chain `"501"`: Ed25519(seed) over the raw UTF-8
  bytes of the intent (implemented as hex-encode then `crypto::ed25519_sign_hex`, which hex-decodes back); other
  chains: `crypto::ed25519_sign_eip191(intent, seed, "utf8")` (crypto.rs:278) = Ed25519(seed) over
  `keccak256("\x19Ethereum Signed Message:\n" + <decimal byte length> + <utf8 bytes>)` (Keccak-256, NOT SHA3-256).
  Both return standard base64 (with padding) of the 64-byte signature. Deterministic for fixed inputs.
- `fn strategy::trader_mode::activate` (trader_mode.rs:144) — "SD-A": (1) GET getAttestDocHex; (2)
  `sessionSig = crypto::ed25519_sign_hex(attestDocHex, seed)` = Ed25519 over hex-decoded bytes (optional `0x` prefix
  stripped; empty hex → `""` without signing; bad hex → `failed to decode hex message: <hex error>`), base64;
  (3) `now = current ms`; POST registerTeeInfo `{accountId, attestDocHex, expireTimestamp: now+2592000000,
  sessionCert, sessionSig, timestamp: now}`; (4) **prints `Trader Mode activated.` + newline to stdout** (plain text,
  before the command's JSON line). Any failure aborts the command (no retry).
- 60018 retry pattern (inline in handlers; spec fn `trader_mode::retry_on_upgrade`, trader_mode.rs:169): run op; if
  error is `UpgradeRequired` → `activate` (error → abort) → run the **identical** op once more (same request bytes,
  same signature/timestamps); second result returned as-is (a second 60018 is a plain error).
- `fn strategy::status::status_label` (status.rs:74): `-7 expired`, `-3 cancelling`, `-2 cancelled`, `-1 failed`,
  `0 processing`, `1 completed`, `2 creating`, `3 active`, `4 suspended`, other `unknown(<n>)` (e.g. `-4` →
  `unknown(-4)`). Terminal (settled) = `1, -2, -1, -7`.
- `EXECUTION_EVENT_CATALOG` / `execution_event_for` (status.rs:257/289) — code → (name, message, terminal):

  | code | name | message | terminal |
  |---|---|---|---|
  | 0 | tradeSuccessed | Trade successful | false |
  | 3005 | lessThanMinReceive | Quoted price is below the minimum amount to receive | false |
  | 3006 | preExecutionFailed | Pre-execution error. Try again | false |
  | 3007 | signFailed | Failed to verify signature | false |
  | 3008 | broadcastFailed | Broadcast failed | false |
  | 3010 | onchainFailed | The transaction broadcast was unsuccessful due to an onchain service error | true |
  | 3013 | insufficientBalance | Insufficient funds in wallet | false |
  | 3014 | insufficientLamports | Insufficient funds for network fee | false |
  | 3015 | exceedSlippage | Price exceeded slippage at trade | false |
  | 3016 | noLiquidty | No quote due to low liquidity | false |
  | 3017 | unableQuote | Unable to fetch a quote | false |
  | 3018 | mevFail | Anti-MEV provider error | false |
  | 3019 | riskToken | Failed to trade due to risky token | true |
  | 3020 | blackAddress | Failed to trade due to blocklisted address | true |
  | 3023 | orderExpired | Limit order expired | true |
  | 2001 | oldCreated | Order created | false |
  | 2002 | oldFailedToCreate | Failed to create order | false |
  | 2003 | oldEdited | Order modified | false |
  | 2004 | oldFailedToEdit | Failed to edit order | false |
  | 2005 | oldCanceled | Order canceled | false |
  | 2006 | oldFailedToCancel | Unable to cancel order | false |
  | 2007 | oldAutoCanceled | Order auto-canceled | false |
  | 2008 | oldFailedToAutoCancel | Unable to auto-cancel order | false |
  | 2009 | oldExpired | Order expired | false |
  | 2010 | oldExceedsSlippage | Price exceeded slippage at trade | false |
  | 2011 | oldNoQuoteLowLiquidity | No quote due to low liquidity | false |
  | 2012 | oldBroadcastFailed | Broadcast failed | false |
  | 2013 | oldSuccessful | Trade successful | false |

- `OrderListResp` (types.rs:148) — order DTO shared by createOrder / getOpenOrder / openOrderDetail. Typed fields
  (deserialisation fails with a serde message if the BE type differs): `orderId` String **required**, `status` i32
  **required**, `strategyId` String?, `userWalletAddress` String?, `strategyMode` i32?, `orderType` i32?,
  `strategyType` i32?, `exchangeDirection` i32?, `chainId` String?, `chainName` String?, `canResume` bool?,
  `fromToken` any?, `toToken` any?, `triggerInfo` any?, `createTime` String?, `expireTime` String?,
  `transactionInfo` any?, `executionHistoryList` any?, `orderStatusUpdateTime` String?, `estimatedWaitTime` i64?,
  `eventCursor` String?; every other key is kept verbatim (`#[serde(flatten)] extra`). JSON `null` ⇒ absent. On
  re-serialisation (`strategy list`) **all 21 modelled keys are emitted** (absent → `null`) plus the extra keys, sorted.
- `ListOrdersResp` (types.rs:195): `dataList` → list (default `[]`), `cursor` String? (other keys, e.g. `hasNext`, ignored).
- `fn handlers::merge_terminal_fields` (handlers.rs:575) + `build_wait_payload` (610) + `wait_over_ids` (652) —
  used by `--wait`: `settled = status ∈ {1,-2,-1,-7}`; overwrite `status`, `statusLabel`, set `settled`; if settled,
  copy (when present/non-null in the re-query) `transactionInfo`, `executionHistoryList` (raw, NOT enriched),
  `fromToken`, `toToken`, `orderStatusUpdateTime`. Multi-order payload `{"orders":[…],"settled":<AND of all>}`
  (empty list → `true`). `wait_over_ids`: sleep 3 s once, then sequential GET openOrderDetail
  (`strategyMode=7`) per id starting from `{"orderId": id}`; any re-query error aborts the command.

### 3. Other-group helpers called by strategy (named only)

- `fn chains::resolve_chain` (chains.rs:129): `$ONCHAINOS_HOME/chain_cache.json` entry whose `chainName` equals the
  input case-insensitively → its `chainIndex`; else alias table on the lowercased input (`ethereum|eth→1`,
  `solana|sol→501`, `bitcoin|btc→0`, `bsc|bnb→56`, `polygon|matic→137`, `arbitrum|arb→42161`, `base→8453`,
  `xlayer|x layer|x-layer|okb→196`, `xlayer_test→1952`, `avalanche|avax→43114`, `optimism|op→10`, `fantom|ftm→250`,
  `sui→784`, `tron|trx→195`, `ton→607`, `linea→59144`, `scroll→534352`, `zksync→324`, `tempo→4217`); else the
  ORIGINAL input unchanged (not trimmed/lowercased).
- `fn token_alias::resolve_and_validate(chain, raw, label)` (token_alias.rs:277): case-insensitive alias table per
  chain (e.g. `1: eth/native→0xeeee…eeee, usdc→0xa0b8…eb48, usdt, wbtc, dai, weth`; `501: sol/native→1111…1111 (32×"1"),
  usdc→EPjF…Dt1v, usdt, wSOL mint→native`; `56`, `196`, `8453`, `42161` … see token_alias.rs:24-171), then format
  check: `501` → no `0x` prefix, 32-44 chars, base58 alphabet; `195/607/784` → no check; else EVM `0x`+40 hex (and a
  base58-looking value gets the "looks like a Solana/base58 address" message). Messages quoted under create-limit.
- `fn validators::validate_slippage` (validators.rs:37), `fn validators::validate_order_id_numeric` (validators.rs:117).
- `fn commands::market::fetch_price` (market.rs:227): POST `/api/v6/dex/market/price` body
  `[{"chainIndex":<idx>,"tokenContractAddress":<addr>}]` via `client.post` (class read).
- `fn commands::token::fetch_info` (token.rs:648): POST `/api/v6/dex/market/token/basic-info` same array body (read).
- `fn commands::sink::CodedError::invalid_input` (sink.rs:59).

### 4. DeFi-owned helpers

- `fn defi::helpers::minimal_to_decimal_str(amount, p)` (helpers.rs:59) — pure string op, no validation:
  `p == 0` → `amount`; if `len(amount) <= p` left-pad with `'0'` to `p+1` chars; split at `len-p` into
  `int`,`frac`; strip trailing `'0'` from `frac`; return `frac == "" ? int : int + "." + frac`. Leading zeros of
  `int` are kept (`"00500000",6 → "00.5"`). Garbage passes through (`"abc",6 → "0.000abc"`). Oracles:
  `"500000",6→"0.5"`, `"1154528481238320444",18→"1.154528481238320444"`.
- `fn defi::helpers::decimal_to_minimal_str(amount, p)` (helpers.rs:84) — `p == 0` → substring before the first
  `.`; else split at first `.` (`int`, `dec` — `dec` may contain more dots); `dec` truncated to `p` chars (no rounding)
  or right-padded with `'0'` to `p`; `s = int + dec`; strip leading `'0'`; empty → `"0"`. Oracles: `"0.5",6→"500000"`,
  `"226.483834",6→"226483834"`, `"0.005",18→"5000000000000000"`.
- `fn defi::helpers::convert_minimal_to_decimal(items)` (helpers.rs:16) — for each element of the parsed
  `--user-input` array: `tokenPrecision` = string parseable as u32 or JSON unsigned integer, else error
  ``tokenPrecision is required in --user-input for each token. Get it from `defi prepare` -> investWithTokenList[].tokenPrecision``;
  if `coinAmount` is a JSON string: empty or all `'0'` → `coinAmount cannot be zero or empty. Got "<v>".`; contains
  `.` → `coinAmount must be an integer (minimal units), got "<v>". Convert: userAmount x 10^tokenPrecision. Example: 0.5 USDC (precision=6) -> coinAmount="500000"`;
  else replace with `minimal_to_decimal_str(v, precision)`. Non-string `coinAmount` is left untouched. Finally remove
  `tokenPrecision` from the element. Other keys are passed through.
- `fn defi::helpers::extract_expect_output(wallet, chain, platform_id, reward_type, investment_id?)` (helpers.rs:115)
  — calls `fetch_position_detail` (POST `/api/v6/defi/user/asset/platform/detail`); if `data` is not an array →
  `None`. For each `platform` → `walletIdPlatformDetailList[]` → `networkHoldVoList[]` (`net`), in this order:
  1. if `reward_type ∈ {REWARD_INVESTMENT, REWARD_OKX_BONUS, REWARD_MERKLE_BONUS}`: for each
     `net.investMarketTokenBalanceVoList[]` → sides `SUPPLY` then `BORROW` of `assetMap` → items (if
     `investment_id` given, skip items whose `investmentId` is not a JSON integer equal to it) →
     `rewardDefiTokenInfo[]` whose `rewardType == reward_type` → each `baseDefiTokenInfos[]` element `t` pushes
     `{"chainIndex": <chain arg>, "coinAmount": t.coinAmount (string) or "0", "tokenAddress": t.tokenAddress or ""}`;
  2. (all types) `net.investMarketTokenBalanceVoList[].marketRewards[]` with matching `rewardType` → push
     `baseDefiTokenInfos[]` as above (no investmentId filter);
  3. (all types) `net.investTokenBalanceVoList[]` (investmentId filter as in 1, integers only) →
     `rewardDefiTokenInfo[]` matching → push;
  4. if `reward_type != "REWARD_INVESTMENT"`: `net.availableRewards[]` matching → push.
  Dedupe keeping first occurrence by `"<chainIndex>:<tokenAddress>"`. Empty → `None`; else
  `Some(compact JSON string of the array)` (element keys sorted `chainIndex, coinAmount, tokenAddress`).
- `fn defi::operations::annotate_datalist_value_normalized` (operations.rs:162) — for each OBJECT element of
  `result.dataList[]` (no-op if missing / not an array): `sink::normalize_amount(value)` (sink.rs:392): `null`/missing,
  `""`, `"0"`, `"0x0"` → `"0"`; `0x…` string → exact arbitrary-length hex→decimal (invalid digit →
  error `invalid hex digit '<c>' in '<v>'`); all-digit string → leading zeros stripped; JSON u64 → its decimal; any
  other number → error `value must be a non-negative integer minimal unit, got '<n>'`; other string → error
  `unparseable value '<trimmed>'`; other JSON type → `unparseable value (unexpected JSON type)`. Success sets
  `valueNormalized`; error sets `valueNormalizeError` and `valueNormalized: "0"`. `value` untouched. Used by
  invest/withdraw/collect only (not deposit/redeem/claim).
- `fn defi::operations::find_matching_token`, `extract_token_info`, `find_token_precision`,
  `find_token_amount_in_calc_result`, `resolve_ticks`, `append_warnings`, `find_position_token`,
  `validate_amount`, `validate_amount_v3`, `is_investable` — documented inline under invest / withdraw / collect.
- `fn agentic_wallet::auth::ensure_tokens_refreshed` (auth/mod.rs:132, owned by auth group) — called by every defi
  command except `support-chains`/`support-platforms`, BEFORE the client is built: `session.json.sessionKeyExpireAt`
  empty/unparseable/≤ now (seconds) → error `session expired, please login again: onchainos wallet login`; keyring
  `refresh_token` or `access_token` missing → same error; refresh token JWT expired → stderr
  `Session expired. Please log in again: onchainos wallet login` + same error; either token expiring within 60 s →
  POST `/priapi/v5/wallet/agentic/auth/refresh` (WalletApiClient, class auth), store both tokens (may also update
  wallets/chain cache); failure → `code=<c> msg=<m>` or transport error.

### 5. Auth mechanism summary (for a lite re-implementation)

- **strategy** needs, locally: keyring `access_token` (JWT, sent as Bearer; refreshed via refresh endpoint only when
  already expired), keyring `session_key` (X25519 private key, base64), `session.json` `encryptedSessionSk`,
  `sessionCert`, `saTeeId`, and `wallets.json` (`selectedAccountId`, `accounts[].isDefault`, `accountsMap[..].addressList`).
  Every strategy call adds `X-Web3-Auth-Type: 1`. create-limit additionally produces an Ed25519 signature with the
  HPKE-decrypted session seed; SD-A signs the TEE attestation doc with the same seed.
- **defi** needs only a valid logged-in token set (session key not expired + access/refresh tokens in keyring); no
  local signing; the wallet `--address` is always passed explicitly by the caller.
- `defi support-chains` / `defi support-platforms` work anonymously (JWT attached if present).

### Global options (core)

Every command here also accepts the root globals: `--chain <CHAIN>` (help "Chain: ethereum, solana, base, bsc,
polygon, arbitrum, sui, etc"; **ignored** by all strategy handlers and by defi handlers that do not declare their
own `--chain`) and hidden `--dev` (switch base URL to `https://beta.okex.org`, disables DoH failover). The defi
leaves `search`, `redeem`, `claim`, `invest`, `withdraw`, `collect`, `position-detail` declare a LOCAL `--chain`
(clap skips propagating the global one to them), whose help/requiredness is given per command.

---

## Commands

### `onchainos strategy create-limit`  (hidden: no)
- Handler: `commands/agentic_wallet/strategy/handlers.rs:245` (`create_limit`), dispatched from `strategy/mod.rs:31`.
- Options:
  - `--chain-id <CHAIN_ID>` String, required. Chain id or alias.
  - `--from-token <FROM_TOKEN>` String, required. Alias or address.
  - `--to-token <TO_TOKEN>` String, required.
  - `--amount <AMOUNT>` String, required. Human-readable from-token amount ("[UNIT: readable]").
  - `--trigger-price <TRIGGER_PRICE>` String, required. USD trigger price.
  - `--slippage <SLIPPAGE>` String, optional; default `"15"` (percent) applied in code, not clap.
  - `--mev-protection <on|off|default>` ValueEnum (case-sensitive lowercase), default `default`.
  - `--direction <DIRECTION>` required; value parser `parse_direction_value`: ASCII-lowercased `buy` → 0, `sell` → 1;
    anything else → clap error (stderr, exit 2) with inner text ``unknown direction `<lowercased>` — expected `buy` or `sell` ``.
  - `--current-price <CURRENT_PRICE>` String, optional.
  - `--wait` bool flag (SetTrue), default false.
  - globals `--chain` (ignored), hidden `--dev`.
- Auth: jwt-required (Bearer from keyring via `client_async`; no pre-check — anonymous fallback just fails at BE) +
  session-key signature (Ed25519 over the intent) + header `X-Web3-Auth-Type: 1` on strategy endpoints.
- Steps:
  1. `client_async()` (may refresh JWT).
  2. `session::load()` (errors per §2).
  3. `sa_tee_id == ""` → error ``please re-login with `onchainos wallet login` before placing strategy orders``.
  4. `chain = resolve_chain(--chain-id)`; `ensure_strategy_chain(chain, raw)`.
  5. `wallet = session.wallet_address_for(chain)`; empty → error
     ``no wallet address for chain `<chain>` — login with the right chain enabled first``.
  6. `from = resolve_and_validate(chain, --from-token, "from-token")`, then `to = … "to-token"`. Messages
     (label substituted): `--<label> looks like an EVM address (0x…) but chain is Solana. Solana uses base58 addresses (e.g. EPjFWdd5...wyTDt1v). Did you mean to use a different chain?`;
     `--<label> is not a valid Solana address: expected 32-44 base58 characters, got <n> characters ("<v>")`;
     `--<label> is not a valid Solana address: contains characters outside base58 alphabet ("<v>")`;
     `--<label> looks like a Solana/base58 address but chain is EVM (chainIndex=<chain>). EVM addresses start with 0x (e.g. 0xa0b869...606eb48). Did you mean to use --chain solana?`;
     `--<label> is not a valid EVM address: expected 0x + 40 hex digits, got "<v>"`.
  7. `trigger = f64(--trigger-price)` → ``--trigger-price `<v>` is not a number: <ParseFloatError>``; `≤0` or
     non-finite → ``--trigger-price must be a positive finite number, got `<v>` ``.
  8. Comparison token: buy → `to`, sell → `from`. `current = f64(--current-price)` (errors
     ``--current-price `<s>` is not a number: <e>`` / ``--current-price must be a positive finite number, got `<s>` ``)
     or, if omitted, `fetch_token_price(comparisonToken, chain)` = **HTTP #1 POST `/api/v6/dex/market/price`**
     `[{"chainIndex":chain,"tokenContractAddress":token}]`; take `data[0].price` (JSON string) → f64. Errors wrapped
     as `fetch current price for <token> on chain <chain>: <inner>` where inner is one of
     `market price HTTP call failed: <client error>`, `market price response empty — got: <json>`,
     ``market price item missing `price` — got: <json>``, ``market price `<p>` is not a number: <e>``,
     ``market price for `<token>` on chain `<chain>` must be positive finite, got `<p>` ``.
  9. `strategyType`: buy: `trigger < current` → 2 (BUY_DIP) else 5 (CHASE_HIGH); sell: `trigger > current` → 3
     (TAKE_PROFIT) else 4 (STOP_LOSS). Equality → CHASE_HIGH / STOP_LOSS.
  10. **HTTP #2 POST `/api/v6/dex/market/token/basic-info`** `[{"chainIndex":chain,"tokenContractAddress":from}]`;
      `decimals = u32(data[0].decimal as JSON string)`, `symbol = data[0].tokenSymbol` (string) or `""`. Errors
      wrapped ``fetch info for fromToken `<from>` on chain `<chain>`: <inner>`` with inner
      `token info HTTP call failed: …`, `token info response empty — got: <json>`,
      ``token info item missing `decimal` — got: <json>``, ``token decimal `<d>` is not a u32: <e>``.
  11. `rawAmount = human_decimal_to_raw_integer(--amount, decimals)` (errors unwrapped, §2).
  12. `fromPrice`: sell → `current`; buy → **HTTP #3 POST `/api/v6/dex/market/price`** for `from` (always, even when
      `--current-price` was given), errors wrapped `fetch from-token price for <from> on chain <chain>: …`.
  13. Local $1 floor: `usd = f64(--amount untrimmed, NaN on parse failure) * fromPrice`; if `usd` finite and `< 1.0` →
      print success `{"belowMinimum":true,"fromSymbol":<symbol>,"minFromAmount":<m>}` and exit 0 (no order).
      `m = format_min_from_amount(fromPrice, decimals)`: `prec = min(decimals, 8)`;
      `ceil((1.0/fromPrice) * 10^prec) / 10^prec` formatted with exactly `prec` decimals (`{:.prec}`), then if it
      contains `.` strip trailing `0`s then a trailing `.`; empty → `"0"`; non-finite/≤0 price → `"0"`. Oracles:
      `(0.1,6)→"10"`, `(1.0,6)→"1"`, `(0.3,18)→"3.33333334"`, `(60000,8)→"0.00001667"`, `(1e-9,6)→"1000000000"`.
  14. `rule = {"fromAmount": --amount (raw string, untrimmed), "fromTokenAddress": from, "toTokenAddress": to, "triggerPrice": --trigger-price (raw string)}`.
  15. `validate_slippage(--slippage or "15")`: value = trim → strip all trailing `%` → trim; errors
      `--slippage must be a number between 0 (exclusive) and 100 (inclusive), got "<v>"`,
      `--slippage must be a finite number between 0 (exclusive) and 100 (inclusive), got "<v>"`,
      `--slippage must be greater than 0 and at most 100, got "<v>"`. (Runs AFTER HTTP #1-#3.)
  16. `preset`: `slippageValue = format!("{}", f64(cleaned)/100.0)` (Rust Display: `"15"→"0.15"`, `"20%"→"0.2"`,
      `" 25 % "→"0.25"`); `routerModeType` = default 1 / on 2 / off 3; key `sellPreset` for sell else `buyPreset`:
      `{"<buyPreset|sellPreset>":{"dynamicMaxSlippageValue":null,"limitOrderFeeLevel":2,"routerModeType":<1|2|3>,"slippageLevel":4,"slippageType":2,"slippageValue":"<dec>"},"presetType":1}`
      (no `limitOrderFeeValue`).
  17. Times: `now_ms`; `createdAt = ISO8601 ms UTC "Z"`; `expireMs = now_ms + 604800000` (7 days); `expiredAt` ISO.
  18. `chainIdLong = i64(chain)` (always numeric after whitelist).
  19. `signMsg = build_intent({chainIdLong, wallet, from, to, rawAmount, createdAt, expiredAt, now_ms})`;
      `signature = sign_intent(signMsg, chain, seed)` (§2).
  20. **HTTP #4 POST `/api/v6/dex/strategy/agentic/limitOrder/createOrder`** + `X-Web3-Auth-Type: 1`, body (sorted):
      ```json
      {"chainId":"<chain>","expireTime":"<expireMs>","preset":{…},"rule":{…},"sourceType":4,
       "strategyDirection":<0|1>,"strategyType":<2|3|4|5>,"userWalletAddress":"<wallet>",
       "verifySignInfo":{"accountId":"<acct>","address":"<wallet>","chainId":<chainIdLong number>,
        "sessionCert":"<cert>","signMsg":"<intent>","signature":"<b64>","teeId":"<saTeeId>"}}
      ```
      (`serviceFeeInfo`, `estimateGasFee`, `referrerAddress` omitted.)
  21. If error kind 60018 → SD-A `activate` (GET getAttestDocHex, POST registerTeeInfo, stdout line
      `Trader Mode activated.`) → resend the identical createOrder body once.
  22. If the (first or retried) result is error kind 100010 → print the same `belowMinimum` success as step 13 (using
      `fromPrice`) and exit 0. Other errors → exit 1.
  23. On success: `original = {"estimatedWaitTime":<i64|null>,"eventCursor":<str|null>,"orderId":"<id>","status":<n>,"statusLabel":"<label>"}`.
  24. Without `--wait` print `original`. With `--wait`: sleep 3 s, GET openOrderDetail
      (`accountId`,`orderId`,`strategyMode=7`), print `merge_terminal_fields(original, requeried)`.
- Output: `data` = belowMinimum object, or `original`, or merged object (keys sorted:
  `estimatedWaitTime, eventCursor, [executionHistoryList], [fromToken], orderId, [orderStatusUpdateTime], settled, status, statusLabel, [toToken], [transactionInfo]`).
  Possible plain stdout line `Trader Mode activated.` before the JSON. Possible stderr lines from `client_async`.
- Errors: all exit 1 with messages above; BE errors `BE strategy error code=<c>: <msg>`; serde failures
  `createOrder: data shape did not match OrderListResp: <serde msg>`; `strategy endpoint returned a non-object body — got: …`;
  SD-A errors from getAttestDocHex/registerTeeInfo; clap errors exit 2.
- Side effects: **FUND-MOVING** — createOrder (`POST /api/v6/dex/strategy/agentic/limitOrder/createOrder`) arms a
  TEE-auto-executed swap; registerTeeInfo delegates signing (only on 60018). Local files read: session.json,
  wallets.json, chain_cache.json, keyring.
- Nondeterminism: `Created At`/`Expired At`/`Timestamp` in `signMsg`, `expireTime`, `signature` (depends on time),
  registerTeeInfo `timestamp`/`expireTimestamp`; account choice if wallets.json has no selected/default account;
  BE `orderId`/`status`.
- Parity test cases:
  1. `strategy create-limit --chain-id polygon --from-token usdc --to-token 0x7ceb23fd6bc0add59e62ac25578270cff1b9f619 --amount 1 --trigger-price 1 --direction buy` — SAFE (whitelist error after session load; no HTTP beyond auth).
  2. `strategy create-limit --chain-id 1 --from-token usdc --to-token eth --amount 0.5 --trigger-price 1000 --direction buy` — SAFE ($0.5 < $1 → `belowMinimum` after market/price ×2 + basic-info; no order).
  3. `strategy create-limit --chain-id solana --from-token sol --to-token usdc --amount 0.001 --trigger-price 500 --direction sell --current-price 150` — SAFE (belowMinimum; only basic-info HTTP).
  4. `strategy create-limit --chain-id 1 --from-token usdc --to-token eth --amount 5 --trigger-price 100 --direction BUY --slippage 150` — SAFE (slippage error after 3 read calls).
  5. `strategy create-limit --chain-id base --from-token usdc --to-token eth --amount 5 --trigger-price 1 --direction buy --wait` — UNSAFE (creates a real limit order).

### `onchainos strategy cancel`  (hidden: no)
- Handler: `handlers.rs:689` (`cancel`).
- Options: `--order-id <ORDER_ID>` String (conflicts with `--order-ids`, `--all`); `--order-ids <ORDER_IDS>` CSV
  (conflicts with `--order-id`, `--all`); `--all` flag (conflicts with the other two); `--wait` flag; globals.
  Conflicts are clap errors (stderr, exit 2).
- Auth: jwt-required + `X-Web3-Auth-Type: 1` (no signature).
- Steps:
  1. `--all` together with `--wait` → CodedError (before any client/session work):
     stdout `{"error":"cancel --all combined with --wait is not supported; use --order-id or --order-ids with --wait, or omit --wait for bulk cancel","errorCode":"invalid_input","errorField":"wait","ok":false}`, exit 1.
  2. `client_async()`, `session::load()`.
  3. Build request (`build_cancel_request`, handlers.rs:715): `--all` → `{"accountId":acct,"cancelAll":true}`;
     `--order-ids` → split on `,`, trim, drop empties; none left → `--order-ids parsed into an empty list`; each
     `validate_order_id_numeric(id,"order-ids")` → `{"accountId","cancelAll":false,"orderIds":[…]}`; `--order-id` →
     `validate_order_id_numeric(id,"order-id")` (validation trims, but the UNTRIMMED value is sent) →
     `{"accountId","cancelAll":false,"orderIds":["<id>"]}`; none → `must pass exactly one of --order-id, --order-ids, or --all`.
     Validator messages: `--<label> must not be empty`, ``--<label> must be a numeric order id, got `<t>` ``,
     ``--<label> `<t>` does not fit in BE Long range (max 9223372036854775807)``.
  4. POST `/api/v6/dex/strategy/agentic/limitOrder/cancel` (body keys sorted `accountId, cancelAll, orderIds`).
  5. Without `--wait`: print `{"estimatedWaitTime":<i64|null>,"updateNum":<i64, default 0>}`.
     With `--wait`: `wait_over_ids(req.orderIds)` → print `{"orders":[…],"settled":bool}`.
- Output: as above.
- Errors: as above; BE errors `BE strategy error code=<c>: <msg>`; `cancel: data shape did not match CancelResp: …`.
- Side effects: state-changing (server) — cancels orders (`POST …/limitOrder/cancel`).
- Nondeterminism: BE `estimatedWaitTime`/`updateNum`; `--wait` statuses.
- Parity test cases:
  1. `strategy cancel --all --wait` — SAFE (CodedError, no HTTP).
  2. `strategy cancel` — SAFE (local error after session load).
  3. `strategy cancel --order-ids ",, ,"` — SAFE (empty-list error).
  4. `strategy cancel --order-id ord-1` — SAFE (numeric validation error).
  5. `strategy cancel --order-id 1 --wait` — UNSAFE-state (sends a cancel for id 1; harmless if not owned but still a state call).

### `onchainos strategy list`  (hidden: no)
- Handler: `handlers.rs:788` (`list`).
- Options: `--order-id <ORDER_ID>` String; `--status <STATUS>` CSV; `--chain-id <CHAIN_ID>` CSV; `--token <TOKEN>`
  String; `--limit <LIMIT>` i32 (clap value parser; non-integer → exit 2); `--cursor <CURSOR>` String;
  `--strategy-mode <STRATEGY_MODE>` i32 default 7; globals.
- Auth: jwt-required + `X-Web3-Auth-Type: 1`.
- Steps:
  1. `client_async()`, `session::load()`.
  2. If `--order-id` given (not validated): GET `/api/v6/dex/strategy/agentic/limitOrder/openOrderDetail?accountId=<acct>&orderId=<id>&strategyMode=<--strategy-mode>`
     → print `{"list":[<order>],"nextCursor":null}`. All other filters ignored.
  3. Else: `chainIdList` = CSV (trim, drop empties) → each `resolve_chain` + `ensure_strategy_chain` (first failure
     aborts); omitted/empty → field omitted.
  4. `--token`: trimmed; empty → omitted; contains `,` → ``--token accepts only a single address; run `list` once per token.``
     (not alias-resolved, not validated).
  5. `orderStatusList`: CSV parts (trimmed, non-empty); each: `i32` parse first (accepts `-2`, `+3`), else label
     lookup (lowercase, `-`→`_`) among `expired,cancelling,cancelled,failed,processing,completed,creating,active,suspended`
     (note `trading` is NOT a label); unknowns silently dropped; empty result/omitted → default `[-3,0,2,3,4]`.
     Oracle: `"active, 4, suspended,1"` → `[3,4,4,1]`.
  6. POST `/api/v6/dex/strategy/agentic/limitOrder/getOpenOrder` body (sorted; optional keys omitted when None):
     `{"accountId","chainIdList"?,"cursor"?,"limit"?,"orderStatusList","tokenAddress"?,"walletAddressList":[evm?,sol?]}`
     (`walletAddressList` = non-empty evm then sol address; may be `[]`; `--cursor ""` is sent as `""`).
  7. Print `{"list":[…],"nextCursor":<BE cursor or null>}`.
- Output: each order = full `OrderListResp` re-serialisation (all 21 modelled keys, nulls included, plus extra keys,
  sorted) + `statusLabel`; each `executionHistoryList[]` object whose `code` is a JSON integer in the catalog gets
  `name`, `message`, `terminal` added (unknown/string codes untouched).
- Errors: chain whitelist error; token CSV error; BE/serde errors
  (`getOpenOrder: response did not match ListOrdersResp: …`, `openOrderDetail: data shape did not match OrderListResp: …`).
- Side effects: read-only.
- Nondeterminism: server data only.
- Parity test cases:
  1. `strategy list` — SAFE.
  2. `strategy list --status active,suspended --chain-id 1,solana --limit 10` — SAFE.
  3. `strategy list --chain-id polygon` — SAFE (whitelist error, no strategy HTTP).
  4. `strategy list --token 0xa,0xb` — SAFE (local error).
  5. `strategy list --order-id 17296046425729984 --strategy-mode 7` — SAFE.

### `onchainos strategy resume`  (hidden: no)
- Handler: `handlers.rs:985` (`resume`).
- Options: `--order-ids <ORDER_IDS>` CSV optional; `--wait` flag; globals.
- Auth: jwt-required + `X-Web3-Auth-Type: 1`; SD-A signature only on 60018.
- Steps:
  1. `client_async()`, `session::load()`.
  2. `--order-ids` given → split `,`, trim, drop empties, each `validate_order_id_numeric(id,"order-ids")`.
     Omitted → discover: addresses `[evm?,sol?]` empty → `active account has no addresses to query`; POST getOpenOrder
     `{"accountId","limit":100,"orderStatusList":[4],"walletAddressList":[…]}`; keep `orderId` of orders with
     `canResume == true` (in BE order).
  3. No ids → print `{"failIds":[],"note":"no resumable orders found","successIds":[]}` exit 0.
  4. POST `/api/v6/dex/strategy/agentic/limitOrder/reactivate` `{"accountId","orderIds":[…]}`; on 60018 → SD-A
     (prints `Trader Mode activated.`) → resend once; other errors abort.
  5. Without `--wait` print `{"failIds":[…],"successIds":[…]}` (mapping in §2). With `--wait`: `wait_over_ids(all
     requested/discovered ids)` → `{"orders":[…],"settled":bool}`.
- Output: as above.
- Errors: validator messages; BE errors; `reactivate: data shape did not match ReactivateResp: …`.
- Side effects: **FUND-MOVING** (re-arms auto-execution) — `POST /api/v6/dex/strategy/agentic/limitOrder/reactivate`;
  optional registerTeeInfo.
- Nondeterminism: SD-A timestamps; BE results.
- Parity test cases:
  1. `strategy resume --order-ids ","` — SAFE (empty → note output, no strategy HTTP).
  2. `strategy resume --order-ids abc` — SAFE (validation error).
  3. `strategy resume` — SAFE only if the account has no SUSPENDED+canResume orders (then read-only); otherwise UNSAFE.
  4. `strategy resume --order-ids 17296046425729984 --wait` — UNSAFE.

### `onchainos defi support-chains`  (hidden: no)
- Handler: `commands/defi/mod.rs:336` → `api::fetch_chains` (defi/api.rs:9).
- Options: globals only (`--chain` ignored).
- Auth: jwt-optional (no `ensure_tokens_refreshed`).
- Steps: `client_async()`; GET `/api/v6/defi/product/supported-chains` (no query) via `client.get`.
- Output: `data` passthrough (sorted keys).
- Errors: client/envelope errors (`API error (code=…): …`), exit 1.
- Side effects: read-only. Nondeterminism: none local.
- Parity test cases: `defi support-chains` — SAFE; `defi support-chains --chain bsc` — SAFE (flag ignored).

### `onchainos defi support-platforms`  (hidden: no)
- Handler: `defi/mod.rs:339` → `fetch_protocols` (api.rs:16).
- Options: globals only. Auth: jwt-optional.
- Steps: GET `/api/v6/defi/product/supported-platforms`.
- Output: passthrough. Errors: client errors. Side effects: read-only.
- Parity test cases: `defi support-platforms` — SAFE.

### `onchainos defi list`  (hidden: no)
- Handler: `defi/mod.rs:342` → `fetch_search(None,None,None,None,page_num)` (api.rs:23).
- Options: `--page-num <PAGE_NUM>` u32 optional (clap parser); globals.
- Auth: jwt-required (`ensure_tokens_refreshed` first; logged-out → `session expired, please login again: onchainos wallet login`).
- Steps: POST `/api/v6/defi/product/search` body `{}` or `{"pageNum":<n>}`.
- Output: passthrough. Errors: session error, client errors. Side effects: read-only.
- Parity test cases: `defi list` — SAFE; `defi list --page-num 2` — SAFE.

### `onchainos defi search`  (hidden: no)
- Handler: `defi/mod.rs:345`.
- Options: `--token <TOKEN>` CSV; `--platform <PLATFORM>` CSV; `--chain <CHAIN>` (local); `--product-group
  <PRODUCT_GROUP>` String (not validated; help: SINGLE_EARN (default), DEX_POOL, LENDING); `--page-num` u32.
- Auth: jwt-required (ensure_tokens_refreshed).
- Steps: 1. session check; 2. `client_async`; 3. neither `--token` nor `--platform` → error
  `at least one of --token or --platform is required`; 4. POST `/api/v6/defi/product/search` body keys (sorted, each
  only if given): `chainIndex` (= `resolve_chain(--chain)` string), `pageNum` (number), `platformKeywordList`
  (split `,` and trim, empties KEPT), `productGroup`, `tokenKeywordList` (same split rule).
- Output: passthrough. Errors: as above. Side effects: read-only.
- Parity test cases: `defi search --token USDC --chain ethereum` — SAFE; `defi search --platform "Aave, Compound" --product-group LENDING --page-num 1` — SAFE; `defi search` — SAFE (local error after auth check).

### `onchainos defi detail`  (hidden: no)
- Handler: `defi/mod.rs:368` → `fetch_detail` (api.rs:53).
- Options: `--investment-id <INVESTMENT_ID>` required; globals.
- Auth: jwt-required.
- Steps: GET `/api/v6/defi/product/detail?investmentId=<id>` (param dropped if empty).
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi detail --investment-id 9502` — SAFE.

### `onchainos defi prepare`  (hidden: no)
- Handler: `defi/mod.rs:371` → `fetch_prepare` (api.rs:63).
- Options: `--investment-id` required. Auth: jwt-required.
- Steps: POST `/api/v6/defi/product/detail/prepare` `{"investmentId":"<id>"}` (string).
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi prepare --investment-id 9502` — SAFE.

### `onchainos defi deposit`  (hidden: no)
- Handler: `defi/mod.rs:374` → `fetch_enter` (api.rs:72).
- Options: `--investment-id` required; `--address` required; `--user-input <JSON array>` required; `--slippage`
  String default `"0.01"` (not validated); `--token-id` String; `--tick-lower` i64 (`allow_hyphen_values`);
  `--tick-upper` i64 (`allow_hyphen_values`); globals.
- Auth: jwt-required.
- Steps: 1. parse `--user-input` as JSON array → `failed to parse --user-input as JSON array: <serde error>`;
  2. `convert_minimal_to_decimal` (§4; coinAmount minimal→decimal, tokenPrecision required and removed);
  3. POST `/api/v6/defi/transaction/enter` body sorted `{"address","investmentId","slippage","tickLower"?,"tickUpper"?,"tokenId"?,"userInputList":[…]}`
  (ticks as JSON integers).
- Output: passthrough (no `valueNormalized` annotation).
- Errors: JSON parse, tokenPrecision/coinAmount errors, client errors.
- Side effects: read-only (returns unsigned calldata; funds only move if the caller later signs/broadcasts).
- Nondeterminism: none local.
- Parity test cases:
  1. `defi deposit --investment-id 9502 --address 0x0000000000000000000000000000000000000001 --user-input '[{"tokenAddress":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","chainIndex":"1","coinAmount":"500000","tokenPrecision":"6"}]'` — SAFE (calldata only).
  2. same with `"coinAmount":"0.5"` — SAFE (local error).
  3. same without `tokenPrecision` — SAFE (local error).

### `onchainos defi redeem`  (hidden: no)
- Handler: `defi/mod.rs:397` → `fetch_exit` (api.rs:111).
- Options: `--id` required; `--address` required; `--ratio` String; `--token-id` String; `--slippage` default
  `"0.01"`; `--chain` (local, optional); `--user-input` JSON array; `--token`; `--symbol`; `--amount`; `--precision` u32.
- Auth: jwt-required.
- Steps: `chainIndex = resolve_chain(--chain)` or `""`. Body starts `{"address","investmentId":<--id>,"slippage"}`;
  add `redeemPercent` (= `--ratio`), `tokenId`; if `--user-input` → parse (same error text as deposit) +
  `convert_minimal_to_decimal` → `userInputList`; else if both `--token` and `--amount` →
  `userInputList: [{"chainIndex":<chainIndex>,"coinAmount":<--amount raw, unconverted>,"tokenAddress":<--token>,"tokenPrecision"?:<--precision number>,"tokenSymbol"?:<--symbol>}]`;
  POST `/api/v6/defi/transaction/exit`.
- Output: passthrough (no annotation). Side effects: read-only (unsigned calldata).
- Parity test cases: `defi redeem --id 9502 --address 0x…01 --ratio 1` — SAFE; `defi redeem --id 9502 --address 0x…01 --chain bsc --token 0x55d398326f99059ff775485246999027b3197955 --amount 1.5 --symbol USDT --precision 18` — SAFE.

### `onchainos defi claim`  (hidden: no)
- Handler: `defi/mod.rs:432` → `extract_expect_output` (helpers.rs:115) + `fetch_claim` (api.rs:167).
- Options: `--address` required; `--chain` (local, optional); `--reward-type` required (not validated);
  `--id`; `--platform-id`; `--token-id`; `--principal-index`; `--expect-output` JSON array.
- Auth: jwt-required.
- Steps: 1. `chainIndex = resolve_chain(--chain)` or `""`. 2. If `--expect-output` absent and `--platform-id`
  present → `extract_expect_output(address, chainIndex, platformId, rewardType, --id)` (POST
  `/api/v6/defi/user/asset/platform/detail`); ANY error there is swallowed (→ none). 3. Body
  `{"address","rewardType"}` + `chainIndex` as a JSON **number** `i64(chainIndex)` (0 if unparseable) when chainIndex
  non-empty + `investmentId` (= `--id`) + `analysisPlatformId` (= `--platform-id`) + `tokenId` + `principalIndex` +
  `expectOutputList` (parsed from `--expect-output`, or from the auto string; error
  `failed to parse --expect-output as JSON array: <serde error>`). 4. POST `/api/v6/defi/transaction/claim`.
- Output: passthrough (no annotation). Side effects: read-only (unsigned calldata).
- Parity test cases: `defi claim --address 0x…01 --chain ethereum --reward-type REWARD_PLATFORM --platform-id 123` — SAFE (position-detail + claim); `defi claim --address 0x…01 --reward-type V3_FEE --id 1 --token-id 2` — SAFE; `defi claim --address 0x…01 --reward-type X --expect-output 'not json'` — SAFE (local error).

### `onchainos defi calculate-entry`  (hidden: no)
- Handler: `defi/mod.rs:481` → `fetch_calculate_entry` (api.rs:208) + `fetch_prepare`.
- Options: `--id` required; `--address` required; `--input-token` required; `--input-amount` required (minimal
  units); `--token-decimal` String required; `--tick-lower`/`--tick-upper` i64 (`allow_hyphen_values`); globals.
- Auth: jwt-required.
- Steps: 1. `--input-amount` contains `.` → error
  `input-amount must be an integer (minimal units), got "<v>". Convert: userAmount x 10^tokenDecimal. Example: 0.005 ETH (decimal=18) -> input-amount="5000000000000000"`.
  2. `u32(--token-decimal)` else `token-decimal must be a non-negative integer, got "<v>"`. 3. POST
  `/api/v6/defi/calculator/enter/info` `{"address","inputAmount":minimal_to_decimal_str(amount,dec),"inputTokenAddress","investmentId","tickLower"?,"tickUpper"?,"tokenDecimal":<raw string>}`.
  4. POST `/api/v6/defi/product/detail/prepare` `{"investmentId"}`. 5. Map lowercase(`tokenAddress`) → precision
  (string→u32 or JSON unsigned; default 18) from `prepare.investWithTokenList`. 6. For each object in
  `result.investWithTokenList[]` whose `coinAmount` is a string: `coinAmount = decimal_to_minimal_str(coinAmount, prec)`
  (prec from map by lowercase address, default 18) and `tokenPrecision = "<prec>"` (string).
- Output: calculator `data` with the transformation (sorted keys). Side effects: read-only.
- Parity test cases: `defi calculate-entry --id 9502 --address 0x…01 --input-token 0xeeee…eeee --input-amount 5000000000000000 --token-decimal 18 --tick-lower -887220 --tick-upper 887220` — SAFE; `… --input-amount 0.005 …` — SAFE (local error); `… --token-decimal x …` — SAFE.

### `onchainos defi rate-chart`  (hidden: no)
- Handler: `defi/mod.rs:595` → `fetch_rate_chart` (api.rs:237).
- Options: `--investment-id` required; `--time-range` String (DAY/WEEK/MONTH/SEASON/YEAR, not validated).
- Auth: jwt-required. Steps: GET `/api/v6/defi/product/rate/chart?investmentId=<id>[&timeRange=<tr>]`.
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi rate-chart --investment-id 9502` — SAFE; `defi rate-chart --investment-id 9502 --time-range MONTH` — SAFE.

### `onchainos defi tvl-chart`  (hidden: no)
- Handler: `defi/mod.rs:603` → `fetch_tvl_chart` (api.rs:250).
- Options/auth/steps as rate-chart with path GET `/api/v6/defi/product/tvl/chart`.
- Parity test cases: `defi tvl-chart --investment-id 9502 --time-range YEAR` — SAFE.

### `onchainos defi depth-price-chart`  (hidden: no)
- Handler: `defi/mod.rs:611` → `fetch_depth_price_chart` (api.rs:263).
- Options: `--investment-id` required; `--chart-type` (DEPTH/PRICE); `--time-range`.
- Auth: jwt-required. Steps: GET `/api/v6/defi/product/depth-price/chart?investmentId=<id>[&chartType=<ct>][&timeRange=<tr>]`.
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi depth-price-chart --investment-id 9502` — SAFE; `defi depth-price-chart --investment-id 9502 --chart-type PRICE --time-range WEEK` — SAFE.

### `onchainos defi invest`  (hidden: no)
- Handler: `defi/mod.rs:626` → `operations::cmd_invest` (operations.rs:22).
- Options: `--investment-id` required; `--address` required; `--token` required (symbol or address); `--amount`
  required (minimal units); `--token2`; `--amount2`; `--chain` (local, parsed but **ignored**); `--slippage` default
  `"0.01"`; `--token-id`; `--tick-lower`/`--tick-upper` i64 (`allow_hyphen_values`); `--range` f64.
- Auth: jwt-required.
- Steps:
  1. GET detail (`investmentId`). `isInvestable` must be `true` / `"true"` / `"1"` (missing → false) else
     `This product is not investable (isInvestable=false). Check detail for eligibility.`
  2. POST prepare; `investWithTokenList` array required else `investWithTokenList not found in prepare response`.
  3. `find_matching_token(list, --token)`: first entry whose lowercase `tokenSymbol` or `tokenAddress` equals
     lowercase input; else `Token '<token>' not found in investWithTokenList. Available: <symbols joined ", ">`.
     `extract_token_info`: `tokenAddress` non-empty string else `tokenAddress is empty for token '<token>'`;
     `chainIndex` non-empty string else `chainIndex is empty for token '<token>'`; `tokenPrecision` (string u32 or
     JSON unsigned) default 18; `tokenSymbol` default `UNKNOWN`.
     `validate_amount(--amount)`: contains `.` →
     `amount must be in minimal units (integer), got "<v>". Convert: userAmount × 10^tokenPrecision. Example: 0.1 USDC (precision=6) → amount="100000"`;
     empty or all `0` → `amount cannot be zero or empty. Got "<v>".`
  4. `investType` = detail.investType (unsigned int or numeric string; default 0). If `== 2` (V3):
     - secondary: `--token2` + `--amount2` → match + extract + `validate_amount_v3` (dot error as above; empty →
       `amount cannot be empty.`; `"0"` allowed); only `--amount2` → validate, auto-pick the first list entry whose
       lowercase address ≠ primary's (label `auto-detected`), none → no secondary; otherwise no secondary.
     - ticks: `--token-id` given → none; else `resolve_ticks`: both `--tick-lower` and `--tick-upper` → use them; else
       `--range r`: `r ≤ 0 || r > 100` → `--range must be between 0 and 100 (percent), got <r>`; `cur` =
       prepare.currentTick (numeric string or JSON int) else `currentTick not found in prepare response`; `sp` =
       prepare.tickSpacing likewise (`tickSpacing not found in prepare response`); `delta = trunc_to_i64(max(|cur| * r / 100.0, (sp*2) as f64))`;
       `lower = ((cur - delta) / sp) * sp`; `upper = ((cur + delta + sp - 1) / sp) * sp` — **integer division truncating toward zero**;
       neither → `V3 pool requires --range (e.g. --range 5 for ±5%) or --tick-lower/--tick-upper. Current tick: <currentTick if JSON string else "unknown">, tick spacing: <tickSpacing if JSON string else "unknown">.`
     - dual (secondary present): POST `/api/v6/defi/calculator/enter/info` for primary
       (`inputAmount = minimal_to_decimal_str(amount, p1)`, `tokenDecimal = "<p1>"`, resolved ticks); `need2 =
       decimal_to_minimal_str(calc1 coinAmount of token2 (case-insensitive address match, default "0"), p2)`
       (missing list → `calculate-entry response missing investWithTokenList`); `u128` parses default 0. If
       `need2 ≤ amount2`: final `(amount, need2)`, surplus token2 amount `minimal_to_decimal_str(amount2-need2, p2)`;
       else second calc POST with token2 (`inputAmount = minimal_to_decimal_str(amount2,p2)`), `need1` likewise,
       final `(need1, amount2)`, surplus token1 `minimal_to_decimal_str(saturating(amount-need1), p1)`. Surplus
       recorded only if ≠ `"0"`. userInput = `[{"chainIndex","coinAmount","tokenAddress","tokenPrecision":"<p>"} ×2]`.
     - single: POST calculator for primary; list = calc `investWithTokenList` (else
       `investWithTokenList not found in calculate-entry response`); each → `{"chainIndex": entry.chainIndex or primary chain, "coinAmount": decimal_to_minimal_str(entry.coinAmount or "0", prec from prepare list by address, default 18), "tokenAddress": entry.tokenAddress or "", "tokenPrecision": "<prec>"}`.
     Standard (investType ≠ 2): userInput = `[{"chainIndex":p1.chain,"coinAmount":--amount,"tokenAddress":p1.address,"tokenPrecision":"<p1>"}]`; ticks none.
  5. Slippage guard (after all HTTP above): `s = f64(--slippage)` (0.0 on parse failure); `s > 0.2` → error
     `Slippage <s*100 {:.1}>% exceeds maximum allowed 20%. Reduce --slippage and retry.`; `s > 0.1` → stderr
     `⚠️  WARNING: Slippage tolerance is <s*100 {:.1}>% (> 10%). High slippage may result in significant value loss.`
  6. `fetch_enter` (deposit path: re-parse, `convert_minimal_to_decimal` — zero coinAmount like `"0"` fails here) →
     POST `/api/v6/defi/transaction/enter` with `tokenId` = `--token-id`, `tickLower/Upper` = resolved ticks only.
  7. `append_warnings`: detail.rate (numeric string or JSON number) `> 0.5` → `highApyWarning: true`;
     detail.healthRate `< 1.5` → `liquidationWarning: true` (a `null` result becomes an object).
  8. Surplus → `rebalance: {"message":"<amt> <sym> not invested (returned to wallet)","surplusAmount":"<amt>","surplusToken":"<sym>","surplusTokenAddress":"<addr>"}`.
  9. `annotate_datalist_value_normalized`.
- Output: enter `data` + optional `highApyWarning`, `liquidationWarning`, `rebalance`, `dataList[].valueNormalized` /
  `valueNormalizeError`; sorted keys.
- Errors: as quoted; client errors.
- Side effects: read-only (unsigned calldata; up to 5 read calls: detail, prepare, ≤2 calculator, enter).
- Nondeterminism: none local.
- Parity test cases:
  1. `defi invest --investment-id 9502 --address 0x…01 --token USDC --amount 100000` — SAFE.
  2. `defi invest --investment-id 9502 --address 0x…01 --token USDC --amount 0.1` — SAFE (error after detail+prepare).
  3. `defi invest --investment-id 9502 --address 0x…01 --token USDC --amount 100000 --slippage 0.5` — SAFE (slippage error after reads).
  4. `defi invest --investment-id <v3-id> --address 0x…01 --token WETH --amount 5000000000000000 --range 5` — SAFE.

### `onchainos defi withdraw`  (hidden: no)
- Handler: `defi/mod.rs:657` → `operations::cmd_withdraw` (operations.rs:638).
- Options: `--investment-id` required; `--address` required; `--chain` (local) required; `--ratio`; `--token-id`;
  `--slippage` default `"0.01"`; `--amount` (help says human-readable, code requires minimal-unit integer);
  `--platform-id`.
- Auth: jwt-required.
- Steps:
  1. `chainIndex = resolve_chain(--chain)`. `s = f64(--slippage)` (0 on failure) `> 0.1` → stderr warning (same text
     as invest; no upper-bound error). (Before any HTTP.)
  2. GET detail; `isSupportRedeem`: JSON bool → itself; JSON string → `== "true" || == "1"`; missing or any other
     JSON type → true. False → `This product does not support redemption (isSupportRedeem=false).`
     (Contrast `isInvestable` in invest: same rule but missing/other type → false.)
  3. V3 (`--token-id` given): `--ratio` missing → `V3 Pool withdrawal requires --ratio (e.g. --ratio 1 for full exit).`;
     POST `/api/v6/defi/transaction/exit` `{"address","investmentId","redeemPercent":<ratio>,"slippage","tokenId"}`;
     annotate; done.
  4. Non-V3: neither ratio nor amount → `Must provide --ratio (e.g. --ratio 1 for full exit) or --amount for partial exit, or both.`;
     amount without platform-id → `--amount requires --platform-id to resolve token info from position-detail.`;
     `validate_amount(amount)` (invest wording).
  5. With `--platform-id`: POST `/api/v6/defi/user/asset/platform/detail`
     `{"platformList":[{"analysisPlatformId":pid,"chainIndex":ci}],"walletAddressList":[{"chainIndex":ci,"walletAddress":addr}]}`;
     `find_position_token` (operations.rs:788): `data` must be array (`position-detail response is not an array`);
     walk platforms → `walletIdPlatformDetailList[]` → `networkHoldVoList[]`; per network first
     `investTokenBalanceVoList[]` then `investMarketTokenBalanceVoList[].assetMap.{SUPPLY,BORROW}[]`; match
     `investmentId` (JSON integer or string) == `--investment-id`; take `assetsTokenList[0]` (entries without it are
     skipped); none → `No position found for investmentId <id> in position-detail`. Token = `{address: tokenAddress|"", chain: chainIndex|"", precision: tokenPrecision (u64 or numeric string) | 18, balance: coinAmount string | "0", symbol: tokenSymbol | "UNKNOWN"}`.
     `bal = decimal_to_minimal_str(balance, precision)`. With `--amount`: `u128(amount) > u128(bal)` (parse failures
     → 0) → `Requested amount <minimal_to_decimal_str(amount,prec)> exceeds current balance <balance> <symbol>. Reduce amount or use --ratio 1 for full exit.`;
     userInput `[{"chainIndex","coinAmount":--amount,"tokenAddress","tokenPrecision":"<prec>"}]`; without amount
     (full exit) `coinAmount = bal`.
  6. POST `/api/v6/defi/transaction/exit` `{"address","investmentId","redeemPercent"?,"slippage","userInputList"?}`
     (userInput converted by `convert_minimal_to_decimal`; zero balance → `coinAmount cannot be zero or empty. Got "0".`).
  7. annotate.
- Output: exit `data` + `dataList[]` annotations. Side effects: read-only (unsigned calldata).
- Parity test cases: `defi withdraw --investment-id 9502 --address 0x…01 --chain ethereum --ratio 1` — SAFE;
  `defi withdraw --investment-id 9502 --address 0x…01 --chain ethereum --amount 1000` — SAFE (local error after detail);
  `defi withdraw --investment-id 9502 --address 0x…01 --chain ethereum --amount 1000 --platform-id 10` — SAFE;
  `defi withdraw --investment-id 9502 --address 0x…01 --chain bsc --token-id 5` — SAFE (ratio error after detail).

### `onchainos defi collect`  (hidden: no)
- Handler: `defi/mod.rs:681` → `operations::cmd_collect` (operations.rs:930).
- Options: `--address` required; `--chain` (local) required; `--reward-type` required; `--investment-id`;
  `--platform-id`; `--token-id`; `--principal-index`.
- Auth: jwt-required.
- Steps:
  1. `chainIndex = resolve_chain(--chain)`.
  2. Validate (case-sensitive): `REWARD_PLATFORM` needs platform-id
     (`REWARD_PLATFORM requires --platform-id (analysisPlatformId from positions).`); `REWARD_INVESTMENT` /
     `REWARD_OKX_BONUS` / `REWARD_MERKLE_BONUS` need both (`<type> requires both --investment-id and --platform-id.`);
     `V3_FEE` needs investment-id + token-id (`V3_FEE requires both --investment-id and --token-id (NFT tokenId).`);
     `UNLOCKED_PRINCIPAL` needs investment-id + principal-index
     (`UNLOCKED_PRINCIPAL requires both --investment-id and --principal-index.`); other →
     `Unknown reward_type '<t>'. Must be one of: REWARD_PLATFORM, REWARD_INVESTMENT, V3_FEE, REWARD_OKX_BONUS, REWARD_MERKLE_BONUS, UNLOCKED_PRINCIPAL.`
  3. expectOutput: V3_FEE / UNLOCKED_PRINCIPAL → none. Otherwise `extract_expect_output` (position-detail POST);
     error → `Failed to fetch reward info from position-detail: <e (Display, outermost only)>`; `None` →
     `No reward tokens found for <type> in position-detail. Verify investment-id and platform-id.`; every
     `coinAmount` is `""`, `"0"` or only `0`/`.` chars → `No rewards available. All reward amounts are zero for <type>.`
     (`No rewards found for <type> in position-detail.` is unreachable).
  4. `analysisPlatformId` omitted whenever `--investment-id` is given.
  5. POST `/api/v6/defi/transaction/claim` `{"address","analysisPlatformId"?,"chainIndex":<i64 number, 0 if unparseable>,"expectOutputList"?,"investmentId"?,"principalIndex"?,"rewardType","tokenId"?}`.
  6. annotate.
- Output: claim `data` + annotations. Side effects: read-only (unsigned calldata).
- Parity test cases: `defi collect --address 0x…01 --chain ethereum --reward-type BAD` — SAFE (local error);
  `defi collect --address 0x…01 --chain ethereum --reward-type REWARD_PLATFORM --platform-id 10` — SAFE;
  `defi collect --address 0x…01 --chain ethereum --reward-type V3_FEE --investment-id 1 --token-id 2` — SAFE.

### `onchainos defi positions`  (hidden: no)
- Handler: `defi/mod.rs:703` → `fetch_positions` (api.rs:282).
- Options: `--address` required; `--chains` required CSV; globals (`--chain` ignored).
- Auth: jwt-required.
- Steps: split `--chains` on `,` (empties kept), each `resolve_chain(trim(part))`; POST
  `/api/v6/defi/user/asset/platform/list` `{"walletAddressList":[{"chainIndex":<idx>,"walletAddress":<address>},…]}`.
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi positions --address 0x…01 --chains ethereum,bsc` — SAFE; `defi positions --address <sol addr> --chains solana` — SAFE.

### `onchainos defi position-detail`  (hidden: no)
- Handler: `defi/mod.rs:707` → `fetch_position_detail` (api.rs:301).
- Options: `--address` required; `--chain` (local) required; `--platform-id` required.
- Auth: jwt-required.
- Steps: `ci = resolve_chain(--chain)`; POST `/api/v6/defi/user/asset/platform/detail`
  `{"platformList":[{"analysisPlatformId":<pid>,"chainIndex":ci}],"walletAddressList":[{"chainIndex":ci,"walletAddress":<address>}]}`.
- Output: passthrough. Side effects: read-only.
- Parity test cases: `defi position-detail --address 0x…01 --chain ethereum --platform-id 10` — SAFE.

---

## Endpoint classification (this partition)

| Method | Path | Class | Used by |
|---|---|---|---|
| POST | `/api/v6/dex/strategy/agentic/limitOrder/createOrder` | funds | strategy create-limit |
| POST | `/api/v6/dex/strategy/agentic/limitOrder/cancel` | state | strategy cancel |
| POST | `/api/v6/dex/strategy/agentic/limitOrder/getOpenOrder` | read | strategy list, strategy resume |
| GET | `/api/v6/dex/strategy/agentic/limitOrder/openOrderDetail` | read | strategy list, create-limit/cancel/resume `--wait` |
| POST | `/api/v6/dex/strategy/agentic/limitOrder/reactivate` | funds | strategy resume |
| GET | `/priapi/v5/wallet/agentic/strategy/getAttestDocHex` | read | create-limit, resume (60018 only) |
| POST | `/priapi/v5/wallet/agentic/strategy/registerTeeInfo` | funds | create-limit, resume (60018 only) |
| POST | `/api/v6/dex/market/price` | read | strategy create-limit |
| POST | `/api/v6/dex/market/token/basic-info` | read | strategy create-limit |
| GET | `/api/v6/defi/product/supported-chains` | read | defi support-chains |
| GET | `/api/v6/defi/product/supported-platforms` | read | defi support-platforms |
| POST | `/api/v6/defi/product/search` | read | defi list, defi search |
| GET | `/api/v6/defi/product/detail` | read | defi detail, invest, withdraw |
| POST | `/api/v6/defi/product/detail/prepare` | read | defi prepare, calculate-entry, invest |
| POST | `/api/v6/defi/transaction/enter` | read (unsigned calldata) | defi deposit, invest |
| POST | `/api/v6/defi/transaction/exit` | read (unsigned calldata) | defi redeem, withdraw |
| POST | `/api/v6/defi/transaction/claim` | read (unsigned calldata) | defi claim, collect |
| POST | `/api/v6/defi/calculator/enter/info` | read | defi calculate-entry, invest (V3) |
| GET | `/api/v6/defi/product/rate/chart` | read | defi rate-chart |
| GET | `/api/v6/defi/product/tvl/chart` | read | defi tvl-chart |
| GET | `/api/v6/defi/product/depth-price/chart` | read | defi depth-price-chart |
| POST | `/api/v6/defi/user/asset/platform/list` | read | defi positions |
| POST | `/api/v6/defi/user/asset/platform/detail` | read | defi position-detail, claim, withdraw, collect |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | all (via core token refresh; defi via ensure_tokens_refreshed) |
| GET | `/api/v6/dex/market/config` | read | all (core payment config, only when charging) |

## External hosts

None are contacted directly by partition code. Indirect (core-owned): the compiled base URL
(`ONCHAINOS_COMPILED_BASE_URL`, API host `web3.okx.com`); `https://beta.okex.org` with hidden `--dev`; DoH failover
binary download hosts `static.okx.com`, `static.coinall.ltd`, `okg-pub-hk.oss-cn-hongkong.aliyuncs.com`,
`static.jingyunyilian.com` (doh/binary.rs:45-48) and DoH proxy nodes (`https://<node.host>`, doh/manager.rs:192).

## Open questions

1. Strategy `check_response` reads `code` with `as_i64()`: a string-typed `code` (e.g. `"60018"`) is treated as
   success. Do the limitOrder/priapi strategy endpoints always return numeric `code`?
2. `OrderListResp` hard-types `chainId`, `createTime`, `expireTime`, `orderStatusUpdateTime` as strings and
   `estimatedWaitTime` as i64; if BE returns other types the command fails with a serde message
   (e.g. `invalid type: integer \`1\`, expected a string`). BE wire types are unverified; serde error texts (also for
   `--user-input`/`--expect-output` JSON parse errors, e.g. `expected value at line 1 column 1`) are hard to match
   byte-for-byte — the parity harness should probably normalise them.
3. Are `/api/v6/defi/transaction/{enter,exit,claim}` side-effect-free on the server (classified read here)?
4. Classification of `reactivate` and `registerTeeInfo` as funds (they re-arm / delegate auto-execution without a new
   order signature) is a judgement call.
5. Payment/x402 tier membership of market/price, basic-info and defi endpoints is server-driven (core
   `/api/v6/dex/market/config`); a free vs charging account can change the HTTP trace (extra config GET, 402 retry).
6. `defi withdraw --amount` help says "Human-readable" but code requires a minimal-unit integer; `defi invest --chain`
   is ignored; `defi deposit --user-input` help example uses `"coinAmount":"0.05"`, which the code rejects. Reproduce
   the code, not the help?
7. `resolve_active_account_id` falls back to the first key of a Rust `HashMap` (random order) — nondeterministic when
   wallets.json has multiple accounts but no `selectedAccountId`/default.
8. Float formatting differences Rust vs JS (`{:.1}` in slippage messages, `{:.N}` in `minFromAmount`,
   `format!("{}", f64)` in `slippageValue`) matter only at exact ties / tiny or huge magnitudes.
9. Panic paths (release profile is `panic = "abort"`, so the process aborts with no JSON): `defi invest` when the enter
   `data` is a JSON array/string/number and a warning must be inserted; `resolve_ticks` with `tickSpacing == 0`
   (integer division by zero); `minimal_to_decimal_str`/`decimal_to_minimal_str` on non-ASCII input (byte split inside a
   UTF-8 char). Should the lite version mimic (abort) or fail gracefully?
10. The SD-A `Trader Mode activated.` line is printed to stdout in front of the JSON — stdout is not pure JSON in that
    path; confirm the lite version must keep it.
