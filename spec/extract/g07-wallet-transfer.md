# g07-wallet-transfer — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: `onchainos wallet send` and `onchainos wallet contract-call` (all chain families: EVM / Solana / other
"legacy account" chains, Bitcoin + BRC-20, SUI), the Gas Station (GS) two-phase transfer flow, the
`--force` confirmation protocol, and every fund-moving helper that lives in `commands/agentic_wallet/transfer/`
(also used by `swap`, `cross-chain`, `wallet gas-station setup` and agent-commerce task signing).

All paths below are relative to `upstream/cli/src/` unless stated otherwise.

---

## Sources read

Partition (read fully, including tests):

| File | Lines |
|---|---|
| `commands/agentic_wallet/transfer/mod.rs` | 2545 |
| `commands/agentic_wallet/transfer/gas_station.rs` | 1001 |
| `commands/agentic_wallet/transfer/bitcoin.rs` | 332 |
| `commands/agentic_wallet/transfer/sui.rs` | 463 |

Supporting files consulted (owned by other groups; only the parts the handlers call into):

| File | Lines | Read |
|---|---|---|
| `commands/agentic_wallet/mod.rs` (clap defs + dispatch for Send / ContractCall, `resolve_send_amount`) | 1007 | full |
| `wallet_api.rs` (client, envelope, `UnsignedInfoResponse`, GS enums, unsignedInfo/broadcast/batch/token-info) | 2874 | 1–1871 |
| `output.rs` (envelopes, Confirming / SetupRequired / FundingBlocked) | 450 | full |
| `main.rs` (error → envelope + exit-code mapping) | 316 | full |
| `commands/agentic_wallet/common.rs` (`ERR_NOT_LOGGED_IN`, `WalletPreviewConfirming`, `handle_confirming_error`) | 209 | full |
| `commands/agentic_wallet/chain.rs` (chain list cache, `get_chain_by_real_chain_index`) | 175 | full |
| `commands/agentic_wallet/chain_profile.rs` (`resolve`, capability drivers) | 286 | full |
| `commands/agentic_wallet/auth/mod.rs` (`ensure_tokens_refreshed`, `format_api_error`) | 1827 | 100–345 |
| `commands/agentic_wallet/balance/mod.rs` (`ensure_wallet_accounts_fresh`, `query_token_readable`, `query_token_metadata`) | 2101 | 60–200, 960–1150, 265–400 |
| `commands/agentic_wallet/account.rs` (`resolve_active_account_id`) | 476 | 403–430 |
| `commands/agentic_wallet/gas_station.rs` (sibling mgmt cmds; `setup` calls `transfer::cmd_send`) | 441 | 265–300 |
| `commands/agentic_wallet/shared/adapters/bitcoin/api.rs` | 627 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/broadcast.rs` | 282 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/context.rs` | 123 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/error.rs` | 109 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/signing.rs` | 95 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/validation.rs` | 651 | full |
| `commands/agentic_wallet/shared/adapters/bitcoin/models.rs` | 235 | 1–140 |
| `commands/agentic_wallet/shared/adapters/sui/api.rs` | 168 | full |
| `commands/agentic_wallet/shared/adapters/sui/context.rs` | 122 | full |
| `commands/agentic_wallet/shared/adapters/sui/identifiers.rs` | 110 | full |
| `commands/agentic_wallet/shared/adapters/sui/signing.rs` | 135 | full |
| `commands/agentic_wallet/shared/common/unsigned_hash_list.rs` | 210 | full |
| `commands/agentic_wallet/shared/common/session.rs` | 47 | full |
| `commands/agentic_wallet/shared/common/context.rs` | 106 | full |
| `commands/agentic_wallet/shared/common/amount.rs` | 89 | full |
| `commands/agentic_wallet/shared/common/json.rs` | 48 | full |
| `commands/agentic_wallet/utxo/brc20.rs` (`select_brc20_transferable_utxos`, carrier parsing) | 798 | 200–540 |
| `chains.rs` (`resolve_chain`, `is_evm_chain`, display names, native symbols) | 623 | 1–360 |
| `token_alias.rs` (`resolve_and_validate`, `validate_address_for_chain`) | 536 | 1–340 |
| `validators.rs` (`validate_amount`, `validate_non_negative_integer`, `readable_to_minimal_str`) | 442 | 1–200 |
| `wallet_store.rs` (wallets/session/cache/chain_cache files) | 848 | 1–420 |
| `keyring_store.rs` | 404 | 1–260 |
| `crypto.rs` (HPKE, ed25519 signers) | 810 | 1–340 |
| `funding.rs` (Funding blocked contract) | 527 | 1–330 |
| `qr.rs` (`build_qr_output`) | 720 | 150–245 |
| `client.rs` (`anonymous_headers`, `jwt_headers`, `augment_auth_error_msg`) | 2469 | 140–175, 300–420 |
| `commands/sink.rs` (`CodedError`) | 1022 | 29–70 |
| `test_helpers.rs` | 46 | full |
| `endpoints.rs` | 65 | 1–47 |
| `doh/manager.rs`, `doh/binary.rs`, `audit.rs` | 424 / 362 / 1405 | skimmed (hosts, UA, audit file) |
| `commands/swap.rs`, `commands/cross_chain.rs`, `commands/agent_commerce/task/signing.rs` | 2446 / 2280 / 627 | call sites only |
| `../Cargo.toml` | 107 | full (serde_json has NO `preserve_order`; Cargo.lock confirms no `indexmap` dep of serde_json) |
| `spec/cli-tree.json` | — | `wallet send`, `wallet contract-call` nodes |

---

## Global conventions that matter for byte-level parity

1. **JSON key order.** `serde_json` is built without `preserve_order`, so every `serde_json::Value` object
   (everything built with `json!`, every server passthrough, every `to_value` of a struct) serializes with keys
   sorted by byte order, compact (no spaces). This applies to:
   request bodies, the `extraData` **string** inside broadcast bodies, the `data` payload of success envelopes,
   `preview`, and `CodedError`/`setup_required` envelopes (built with `json!`, hence `ok` is *last* there).
   Exceptions (struct field order): the success/error envelope `JsonOutput {ok, data?, error?, notifications?}`,
   `ConfirmingOutput {confirming, scene?, message?, next?, notifications?}`,
   `AgenticWalletConfirmingOutput {confirming, scene, message?, preview, next?, notifications?}`, and
   `token_list_json` (see GS helpers) which serializes `Vec<GasStationToken>` directly in struct order.
   Set `ONCHAINOS_PRETTY=1` → `to_string_pretty` (2-space indent) for stdout only.
2. **Numbers.** serde_json keeps u64/i64 exactly; f64 printed with shortest round-trip repr but *integer-valued
   floats keep `.0`* (e.g. user `--fee-rate 10.0` → JSON `10.0`). A JS port must preserve raw numeric text in
   these spots.
3. **Envelopes / exit codes** (`main.rs:248-315`):
   - success: `{"ok":true,"data":<value>}` + `notifications` array only if non-empty (`payment_notify::drain_events`, normally empty here). Exit 0.
   - `WalletPreviewConfirming` → `{"confirming":true,"scene":S,"message":M,"preview":P,"next":N}` exit **2**.
   - `CliConfirming` → `{"confirming":true[,"scene":S],"message":M,"next":N}` exit **2**.
   - `CliSetupRequired` → `{"data":D,"errorCode":C,"message":M,"ok":false}` exit **3** (no notifications).
   - `CliFundingBlocked` → `{"ok":false,"data":D}` exit 1.
   - `CodedError` → `{"data"?,"error":msg,"errorCode":code,"errorField"?,"nextSteps"?,"notifications"?,"ok":false}` exit 1.
   - any other error → `{"ok":false,"error":"<format!(\"{e:#}\")>"}` exit 1 (anyhow alternate format = context chain joined with `": "`).
   - clap parse errors → clap text on **stderr**, exit 2 (no JSON).
4. **HTTP client** (`WalletApiClient`, `wallet_api.rs:765+`): base URL = compiled `BASE_URL` (or `https://beta.okex.org`
   with hidden global `--dev`); 30 s timeout; UA `OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`;
   headers (lower-case on the wire): `content-type: application/json`, `ok-client-version: 4.6.3`,
   `ok-access-client-type: agent-cli`, `platform: agent-cli`, `device-id: <id>` (if available), `device-name: <name>`,
   `authorization: Bearer <accessToken>` (authed calls). Extra headers are inserted after (overwrite on clash).
   - `post_authed_with_headers` / `get_authed`: one DoH failover retry on connect/timeout; **plus one force-refresh
     + retry** when the error is an invalid-token error (codes `10001`,`10008`,`53017`,`130100031`, or msg contains
     `invalid access token` / `access token invalid`) → `POST /priapi/v5/wallet/agentic/auth/refresh`.
   - `post_authed_no_retry_with_headers` (broadcasts): no token retry, no replay; on connect/timeout the error is
     `"<unknown_result_message>: <reqwest error>"`.
   - Response handling: HTTP ≥ 500 → `Wallet API server error (HTTP <s>): <raw body>`; non-JSON →
     `failed to parse wallet API response as JSON (HTTP <s>): <first 500 chars>`; `code` (string `"0"` or number `0`)
     → returns `data`; otherwise `ApiCodeError{code,msg}` whose Display is `Wallet API error (code=<code>): <msg>`
     (msg from `msg`|`errorMessage`|`error_message`|`message`|`detailMsg`, else raw body ≤200 chars + `…` and a stderr
     line `[WalletAPI] no msg field in error response (HTTP <s>), raw body: <body>`; code `50114` gets
     `". You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet."` appended).
   - `format_api_error(e)` (auth/mod.rs:338) converts `ApiCodeError` → plain `code=<code> msg=<msg>`.
5. **Local state (ONCHAINOS_HOME, default `~/.onchainos`)**: `wallets.json` (WalletsJson, camelCase: `email, isNew,
   projectId, selectedAccountId, accountsMap{<id>:{addressList:[{accountId,address,chainIndex,chainName,addressType,chainPath}]}},
   accounts[], loginType`), `session.json` (`saTeeId, sessionCert, encryptedSessionSk, sessionKeyExpireAt, deviceId`),
   `cache.json` (`swapTraceId`, `login`), `chain_cache.json` (`{updated_at, chains:[...]}`, TTL 600 s), keyring blob
   (`onchainos`/`agentic-wallet` OS entry or `keyring.enc` file) holding `access_token`, `refresh_token`, `session_key`.
   `audit.jsonl` is appended by `main.rs` for every command (core-owned).
6. **Signing key material ("TEE session")**: `seed = HPKE-open(base64(session.json.encryptedSessionSk), X25519 sk =
   base64(keyring.session_key))`, suite DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM, info `"okx-tee-sign"`,
   empty AAD, wire = `enc(32) || ct`; plaintext must be 32 bytes (the ed25519 seed). All wallet signatures are
   deterministic Ed25519 (RFC 8032) → base64 (standard, padded).

---

## Shared helpers (used across groups or from core)

### Owned by this partition

- `fn transfer::resolve_address` (transfer/mod.rs:26) — `(wallets, from?, chainName) -> (accountId, AddressInfo)`.
  With `from`: iterate **all** `accountsMap` entries (HashMap → iteration order is random per process) and return the
  first address where `address.eq_ignore_ascii_case(from) && addr.chainName == chainName` (case-sensitive chainName);
  else `no address matches from=<from> chain=<chainName>`. Without `from`: `selectedAccountId` empty →
  `no currentAccountId`; missing entry → `not found currentAccountId`; first address with matching chainName, else
  `no address for chain=<chainName> in account=<id>`. No I/O. Used by payment, sign-message, gas-station, a2a, agent-commerce.
- `fn transfer::resolve_address_with_refresh` (mod.rs:155) — try `resolve_address`; on failure call the refresh closure
  once (in callers: `ensure_wallet_accounts_fresh(force=true)` → `POST /priapi/v5/wallet/agentic/account/list`
  `{"projectId"}` then `POST .../account/address/list` `{"accountIds":[...]}`, rewrites `wallets.json`; errors of
  those two calls are swallowed) and retry once; the retry's error is returned.
- `fn transfer::apply_broadcast_core` (mod.rs:65) — sets on extraData: `checkBalance = !extraData.freeGas`
  (`freeGas` must be JSON bool true to count), `uopHash`, `encoding`, `signType` (strings from unsignedInfo, `""` when
  null/missing), `msgForSign`.
- `fn transfer::sign_and_broadcast` (mod.rs:204) — **the fund-moving core** for EVM/Solana/legacy chains. Algorithm
  in the `contract-call` section ("Standard sign-and-broadcast"). Returns `BroadcastResponse{pkgId,orderId,orderType,txHash}`.
- `fn transfer::execute_contract_call` (mod.rs:1563) — validation + `sign_and_broadcast(is_contract_call=true)`.
  Also called by `swap` (`agent_biz_type="dex"`) and `cross-chain` (`tx_source="3"`, `agent_biz_type="cross-chain"`).
- `fn transfer::build_broadcast_body` (mod.rs:681) + private `sign_and_build_extra_data` (mod.rs:82) — used by
  agent-commerce task signing. Loads session + keyring `session_key` (`not logged in` on failure), signs and returns
  `{"accountId","address","chainIndex","extraData":"<json>"}`. **Differs from `sign_and_broadcast`:** does NOT sign
  `eip712MessageHash`, never adds `txSource/agentBizType/agentSkillName`, never adds GS fields.
- `fn transfer::batch_sign_and_broadcast` (mod.rs:822) — EVM-only batch used by `swap` (not reachable from the two
  commands here). `txs` 1..=5 else `batch_sign_and_broadcast: empty txs` / `batch_sign_and_broadcast: backend allows
  up to 5 elements, got <n>`. Same auth/chain/address/session/validation prologue as `sign_and_broadcast`, then
  `POST /priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo` with a JSON **array** of elements
  `{amount, chainIndex(number), chainPath, fromAddr, sessionCert, toAddr, contractAddr?, inputData?, gasLimit?,
  aaDexTokenAddr?, aaDexTokenAmount?}` (no trace headers); response array must be non-empty and ≤ request length
  (`batch unsignedInfo: empty response` / `... response length <a> exceeds request length <b>`).
  `validate_batch_unsigned_responses` (mod.rs:726): pass 1 any `executeResult==false` → `batch element <i>: <executeErrorMsg or "transaction simulation failed">`;
  pass 2 no signing material → `batch element <i>: backend returned empty signing materials` + **18 spaces** +
  `(gasStationStatus="<status>")` (Debug-quoted). Per element msgForSign = `build_batch_element_msg_for_sign`
  (mod.rs:778; same as standard minus jito), extraData = passthrough + core + `txType:2` (if !contract) + `isMEV` +
  `skipWarning` + `txSource` + `agentBizType` + `agentSkillName` + `extJson.batchBroadcastType=1` (merged into existing
  `extJson` object) + `from7702Address:false` + `walletMainSaveConfirming:true`. If response length == 1 → single
  `POST .../broadcast-transaction`; else `POST .../pre-transaction/batch-broadcast-transaction` with array of
  `{accountId,address,chainIndex,extraData}` (response length must equal request). Errors → `handle_confirming_error`.
- `fn transfer::cmd_send` (mod.rs:1244) — internal minimal-amount entry (`requested_readable=None`); used by
  `wallet gas-station setup` (sibling `gas_station.rs:278` calls it with amount `"1"`, recipient = own address,
  contract-token = gas token, `force=true`, gas token + relayer id, `enable_gas_station=true` → goes straight to
  `gas_station_send`).
- Funding scene helpers (mod.rs:1043-1236): `is_transfer_funding_covered_chain(ci) = chains::is_evm_chain(ci) || ci=="501"`;
  `try_transfer_insufficient_balance_scene`, `try_transfer_simulation_insufficient_balance_scene`,
  `has_confirmed_readable_shortfall(req,bal) = readable_shortfall(req,bal) ∉ {None,"0"}` — algorithm under `wallet send`.
- GS helpers in `transfer/gas_station.rs` — all documented under `wallet send` (GS section):
  `gas_station_send`(26), `gs_build_msg_for_sign`(196), `gs_apply_extra_data_fields`(270),
  `gs_apply_transfer_info`(322, dead code — never called), `gs_build_extra_data`(340),
  `gs_broadcast_with_7702_upgrade`(377) / `gs_broadcast_transaction`(402) (identical bodies), `gs_do_broadcast`(425),
  `gas_station_sign_and_broadcast`(453, routes on `needUpdate7702` but both routes are byte-identical),
  `emit_gs_pending_tx_state`(486), `emit_gs_insufficient_all_state`(498), `gs_not_supported_err`(513),
  `token_list_json`(523), `format_sufficient_tokens`(528), `build_gs_first_time_prompt`(543),
  `build_gs_reenable_prompt`(569), `force_setup_required_for_tx_params`(600), `force_setup_required_for_send`(629),
  `build_gs_setup_required`(659), `build_gs_token_selection_prompt`(727), `classify_gs_phase1`(771),
  `handle_gs_auto_sign_broadcast`(797).

### Owned elsewhere (named, one-line summaries)

- `fn auth::ensure_tokens_refreshed` (auth/mod.rs:132) — reads `session.json.sessionKeyExpireAt` (empty/unparsable/past
  → `session expired, please login again: onchainos wallet login`), keyring `refresh_token`/`access_token` (missing →
  same error); refresh JWT `exp` passed → stderr `Session expired. Please log in again: onchainos wallet login` + same
  error; if either JWT expires within 60 s → `POST /priapi/v5/wallet/agentic/auth/refresh` `{"refreshToken"}`
  (anonymous headers), stores new tokens, and if `chainUpdated` applies `allAccountAddressList` to wallets.json and
  force-refreshes the chain cache. Returns access token.
- `fn auth::format_api_error` (auth/mod.rs:338) — `ApiCodeError` → `code=<c> msg=<m>`.
- `fn chain::get_chain_by_real_chain_index` (chain.rs:85) — trims input; first chain entry whose `chainIndex`,
  `realChainIndex` or `chainName` equals input (case-insensitive for strings, numbers compared as decimal text) or
  any `alias[]` equals input case-insensitively. Chains come from `get_all_chains` = `chain_cache.json` if non-empty and
  `now-updated_at < 600`, else `POST /priapi/v5/wallet/agentic/chain/support/list` body `{}` (anonymous headers;
  `data` array or `data.chainList`) and rewrite `chain_cache.json`.
- `fn chain_profile::resolve` (chain_profile.rs:50) — the above, else name/alias match (+ `bitcoin`/`btc` synonym),
  else `unsupported chain: <input>`. Builds `{chainIndex, realChainIndex, chainName, nativeSymbol, nativeDecimals,
  capabilities}`: bitcoin/btc → Bitcoin driver (decimals 8, symbol server|`BTC`, contract_call=false); sui → Sui
  (9, `SUI`, contract_call=true); `isEvmChain==true` or solana/sol/tron/trx/ton → LegacyAccount (decimals **18**,
  contract_call=true); else Unsupported (contract_call=false). Missing ids → `chain profile: chain entry missing chainIndex` etc.
- `fn chains::resolve_chain` (chains.rs:129) — lower-cased; match `chain_cache.json` `chainName` (no TTL) → its
  chainIndex; else static alias table (`ethereum|eth→1, solana|sol→501, bitcoin|btc→0, bsc|bnb→56, polygon|matic→137,
  arbitrum|arb→42161, base→8453, xlayer|x layer|x-layer|okb→196, xlayer_test→1952, avalanche|avax→43114,
  optimism|op→10, fantom|ftm→250, sui→784, tron|trx→195, ton→607, linea→59144, scroll→534352, zksync→324,
  tempo→4217`); else input unchanged.
- `fn chains::is_evm_chain`, `chain_display_name`, `native_token_symbol` (chains.rs:91/291/318) — cache `isEvmChain`
  wins, else static list; display names (`1→Ethereum, 196→X Layer, 501→Solana, 42161→Arbitrum One, 56→BNB Chain, …`,
  unknown → the index itself); native symbols (`ETH/BNB/MATIC/TRX/OKB/FTM/AVAX/SOL/TON/SUI/BTC/USDC(5042)`, unknown →
  `native token`).
- `fn token_alias::resolve_and_validate` / `validate_address_for_chain` (token_alias.rs:277/206) — alias table
  (e.g. `1: usdc→0xa0b8…eb48`, `196: usdt→0x779d…3736`, `native`→`0xeeee…eeee` / SOL `1111…1111`), then format check:
  501 → no `0x`, 32–44 chars, base58 alphabet; 195/607/784 → no check; else must be `0x`+40 hex (and a base58-looking
  mixed-case 32–44 string gets a specific "looks like a Solana/base58 address" message). Messages start with `--<label>`.
- `fn validators::validate_amount` / `validate_non_negative_integer` / `readable_to_minimal_str` (validators.rs:11/97/139).
- `fn wallet_store::{load_wallets, load_session, get_swap_trace_id, clear_swap_trace_id}` (wallet_store.rs).
- `fn keyring_store::get("session_key")` (keyring_store.rs:182) — missing → mapped to `not logged in` by callers.
- `fn crypto::{hpke_decrypt_session_sk, ed25519_sign_eip191, ed25519_sign_hex, ed25519_sign_encoded, ed25519_sign}`
  (crypto.rs:39/278/170/124/106) — see "Signing primitives" below.
- `fn balance::ensure_wallet_accounts_fresh` (balance/mod.rs:82), `query_token_readable` (1126),
  `query_token_metadata` (998), `refresh_wallet_accounts_strict` (137).
- `fn funding::build_funding_bundle` / `build_funding_blocked_result` / `readable_shortfall` (funding.rs:199/94/278).
- `fn qr::build_qr_output` (qr.rs:185) — terminal-unicode QR or PNG under `ONCHAINOS_HOME/tmp/funding-qr/` (image-notify mode).
- BTC adapter: `BtcContext::load` (bitcoin/context.rs:20), `BtcApi::{brc20_transferable_utxos, token_metadata,
  prepare_transaction, prepare_selected_brc20_transfer, broadcast_transaction}` (bitcoin/api.rs),
  `broadcast::submit_direct_transaction` (bitcoin/broadcast.rs:14), `signing::sign_unsigned_hashes`,
  `validation::{validate_recipient, parse_fee_rate, normalize_brc20_token_address, preview_from_response,
  validate_wallet_address, same_address}`, `error::map_api_error`, `utxo::select_brc20_transferable_utxos` (utxo/brc20.rs:327).
- SUI adapter: `SuiContext::load` (sui/context.rs:19), `SuiApi::{token_metadata, prepare_transaction,
  prepare_contract_call, broadcast_transaction}` (sui/api.rs), `api::map_api_error` (→ `CodedError(code,msg)`),
  `identifiers::{normalize_address, normalize_coin_type, NATIVE_COIN_TYPE="0x2::sui::SUI"}`, `signing::sign_unsigned_hashes`.
- Shared common: `shared::common::context::load_chain_context` (context.rs:20), `session::{SigningSeed::load, session_cert}`,
  `unsigned_hash_list::{sign_unsigned_hashes, build_direct_extra_data}`, `amount::{readable_to_minimal,
  minimal_to_readable, parse_minimal, decimal_field, value_as_decimal_string}`, `json::{shell_arg, first_data_item,
  required_string}`.
- `fn common::handle_confirming_error` (common.rs:67) — `ApiCodeError` with code `81362` and `!force` →
  `CliConfirming{message: <backend msg>, next: "If the user confirms, re-run the same command with --force flag appended to proceed.", scene: None}`;
  any other `ApiCodeError` returned unchanged (Display `Wallet API error (code=<c>): <m>`); non-API errors unchanged.

### Signing primitives (exact)

- `ed25519_sign_eip191(msgHex, seed, "hex")`: if msg empty → `""`; `bytes = hexdecode(strip "0x")`;
  `m = "\x19Ethereum Signed Message:\n" + decimal(len(bytes)) + bytes`; `h = keccak256(m)`; sig = Ed25519(seed, h) → base64.
- `ed25519_sign_encoded(msg, base64(seed), enc)`: enc `hex` (strip `0x`; empty → returns `""` without signing),
  `base64`, `base58` (empty → `""`); any other enc (incl. empty string) → `unsupported encoding: <enc>, expected hex/base64/base58`.
  Signs the **decoded bytes directly**, returns base64.
- `ed25519_sign_hex(h, s)` = `ed25519_sign_encoded(h, s, "hex")`.
- `unsigned_hash_list::sign_unsigned_hashes(resp, seed, profile)` (BTC/SUI): requires `unsignedHashList` array
  (`signing response is missing unsignedHashList`; empty → `unsignedHashList must not be empty`), response `encoding`
  (`signing response is missing encoding`). Supported encodings: Bitcoin `eip2519|hex|base64|base58`, SUI `eip2519|base64`
  (else `unsupported transaction encoding: <e>`). Per item: `index` (u64 or numeric string; `unsignedHashList item is missing index`;
  duplicate → `unsignedHashList contains duplicate index <i>`), `unsignedHash` non-empty
  (`unsignedHashList[<i>] is missing unsignedHash`), Bitcoin additionally `unsignedHashSig` non-empty
  (`unsignedHashList[<i>] is missing unsignedHashSig`); Bitcoin item-level `encoding` overrides response encoding, SUI ignores it.
  Decode: value starts with `0x` or enc ∈ {eip2519,hex} → hex; else base64 / base58. SUI digest must be 32 bytes
  (`SUI unsignedHash must decode to 32 bytes, got <n>`). Output = each item cloned + `sessionSignature` = base64(Ed25519(seed, bytes)).
- `unsigned_hash_list::build_direct_extra_data(prepared, signed, cert, force, label)` (BTC/SUI broadcast): requires
  non-empty `signed` (`signed hash list must not be empty`), `prepared.unsignedTx`, `signType`, `encoding`
  (`unsignedInfo response is missing <key>`), non-null `txParam` (`unsignedInfo response is missing txParam`), every
  signed item has `unsignedHash` & `sessionSignature` (`signed hash item is missing <key>`).
  `msgForSign = {sessionCert, txParam, unsignedHashList: signed, unsignedTx, unsignedTxHash?(if non-empty string)}`;
  `extraData = prepared.extraData (if object) + {checkBalance:true, uopHash: prepared.uopHash (raw value) or "", encoding,
  signType, msgForSign}`, key `signTx` removed, `skipWarning:true` iff force; serialized (sorted) string.

---

## Commands

### `onchainos wallet send`  (hidden: no)

- Handler: dispatch `commands/agentic_wallet/mod.rs:675` →
  - Bitcoin driver: `transfer/bitcoin.rs:20 cmd_send`
  - SUI driver: `transfer/sui.rs:24 cmd_send`
  - everything else (LegacyAccount **and** Unsupported drivers): `mod.rs:484 resolve_send_amount` →
    `transfer/mod.rs:1273 cmd_send_with_readable` (→ `gas_station.rs:26 gas_station_send` / `mod.rs:204 sign_and_broadcast`)

- Options (clap, `mod.rs:135-173`; matches `cli-tree.json`):

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--amt <AMT>` | String | — | `conflicts_with = readable_amount` (clap error, exit 2) |
| `--readable-amount <READABLE_AMOUNT>` | String | — | `conflicts_with = amt` |
| `--recipient <RECIPIENT>` | String | **required** | may be `""` (then fails in handler) |
| `--chain <CHAIN>` | String | **required** | name / alias / chainIndex / realChainIndex. Shadows the global `--chain` |
| `--from <FROM>` | String | — | |
| `--contract-token <CONTRACT_TOKEN>` | String | — | ERC-20/SPL CA or alias, SUI coin type, `btc-brc20-<ticker>` |
| `--brc20-outpoint <BRC20_OUTPOINT>` | Vec<String> (repeatable, append) | [] | `requires = contract_token` (clap error, exit 2) |
| `--fee-rate <FEE_RATE>` | String | — | BTC only |
| `--force` | bool flag | false | |
| `--gas-token-address <GAS_TOKEN_ADDRESS>` | String | — | GS |
| `--relayer-id <RELAYER_ID>` | String | — | GS |
| `--enable-gas-station` | bool flag | false | GS |
| global `--dev` | bool, **hidden** | false | use `https://beta.okex.org`, disables DoH |
| global `--chain` | Option<String> | — | shadowed by the subcommand's own `--chain` |

No env fallbacks. No aliases.

- Auth: jwt-required (Bearer access token, auto-refresh) **+ session-key signature** (HPKE-decrypted Ed25519 TEE seed).
  Exception: pre-auth validation branches listed below fail before any auth.

#### Step 0 — driver dispatch (all variants)
1. `chain_profile::resolve(--chain)` (may `POST /priapi/v5/wallet/agentic/chain/support/list` `{}` anonymous, writes
   `chain_cache.json`). Failure → `unsupported chain: <chain>` (exit 1).
2. Transfer driver **Bitcoin**:
   - `--amt` given → `Bitcoin transfers require --readable-amount`
   - any of `--gas-token-address`, `--relayer-id`, `--enable-gas-station` → `Gas Station is not supported for Bitcoin transfers`
   - → Variant B.
3. Transfer driver **Sui**:
   - `--brc20-outpoint` non-empty (only possible with `--contract-token`) → `--brc20-outpoint is only supported for Bitcoin BRC-20 transfers`
   - `--amt` → `SUI transfers require --readable-amount`
   - GS flags → `Gas Station is not supported for SUI transfers`
   - `--fee-rate` → `--fee-rate is only supported for Bitcoin transfers`
   - no `--readable-amount` → `--readable-amount is required`
   - → Variant C.
4. Otherwise (LegacyAccount or Unsupported driver) → Variant A.

#### Variant A — EVM / Solana / other account chains (`cmd_send_with_readable`)

A1. `--brc20-outpoint` non-empty → `--brc20-outpoint is only supported for Bitcoin BRC-20 transfers`;
    `--fee-rate` → `--fee-rate is only supported for Bitcoin transfers`.
A2. `chain = chains::resolve_chain(--chain)` (chainIndex string, e.g. `"1"`).
A3. `--contract-token` → `token_alias::resolve_and_validate(chain, ct, "contract-token")` (alias → CA; format errors
    e.g. `--contract-token is not a valid EVM address: expected 0x + 40 hex digits, got "<x>"`).
A4. `resolve_send_amount` (mod.rs:484) → `amt` (minimal units string):
    - `--amt`: trimmed; `""` → `--amt must not be empty`; contains `.` → `--amt must be a whole number in minimal units (no decimals)`;
      non-digit → `--amt must be a whole number in minimal units, got "<raw>"`; all zeros → `--amt must be greater than zero`;
      leading `0` → `--amt must not have leading zeros, got "<raw>"`.
    - `--readable-amount`: trimmed; `""` → `--readable-amount must not be empty`. Decimals: native → `501`→9, `784`→9,
      **every other chain 18** (incl. Tron 195, TON 607 — upstream quirk). Contract token → `ensure_tokens_refreshed`,
      `POST /priapi/v5/wallet/agentic/token/get-token-info` body `{"chainIndex":<u64 of resolve_chain(chain)>,"source":0,"tokenAddress":<CA>}`
      (non-numeric chain → `chain id '<c>' is not a valid number for token-info lookup`; API error →
      `Failed to fetch token decimals for <CA>: <err Display>. Use --amt with raw minimal units instead.`);
      `entry = data[0]` if array else `data`; value = `entry.decimals` if non-null else `entry.decimal`; string → parse u32
      (`Invalid decimal value "<s>" for token <CA>`), number → `as_u64` cast to u32 (`Invalid decimal value for token <CA>`),
      other → `Token decimal not found for <CA>. Use --amt with raw minimal units instead.`
      Then `readable_to_minimal_str(readable, decimals)`: split on first `.`, empty int → `0`; non-digits →
      `--readable-amount must be a positive number, got "<v>"`; fraction longer than decimals with non-zero excess →
      `--readable-amount "<v>" has more decimal places than this token supports (<d> decimals)` (zero excess is truncated);
      right-pad fraction, strip leading zeros; result `0` → `--readable-amount <v> is too small for this token (<d> decimals); results in zero minimal units`.
    - neither → `Either --amt or --readable-amount is required`.
A5. `validate_amount(amt)` (same checks, messages use `--amount …`), then `recipient==""||chain==""` →
    `recipient and chain are required`.
A6. **GS second phase short-circuit**: if `--gas-token-address` given **or** `--enable-gas-station` → `gas_station_send`
    (section GS-2). (`--relayer-id` alone does NOT trigger it; it is ignored in phase 1.)
A7. Phase 1:
    1. `access = ensure_tokens_refreshed()`.
    2. `wallets.json` missing → `not logged in`.
    3. `entry = get_chain_by_real_chain_index(chain)` → none: `unsupported chain: <chain>`; `entry.chainName` not a string → `missing chainName`.
    4. `resolve_address(wallets, --from, chainName)` (**no refresh fallback here**).
    5. `chainIndexNum = addr.chainIndex.parse::<u64>().unwrap_or(1)`.
    6. `session.json` missing → `not logged in`.
    7. **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` (retrying authed POST, no extra headers),
       body (sorted): `{"amount":amt,"chainIndex":<num>,"chainPath":addr.chainPath,["contractAddr":CA,]"fromAddr":addr.address,"sessionCert":session.sessionCert,"toAddr":recipient}`.
       **Recipient is not format-validated before this call.** Response: `data` must be an array
       (`unsignedInfo: expected data to be an array`), non-empty (`unsignedInfo: data array is empty`), `data[0]` parsed as
       `UnsignedInfoResponse` (`unsignedInfo: failed to parse response: <serde>`). Nullable string fields → `""`,
       nullable bools → false, `gasStationTokenList` null → [].
    8. On error: **10004 funding scene** (below); if it doesn't apply → `format_api_error(e)` (`code=<c> msg=<m>`).
    9. **Simulation-shortfall funding scene** (below) if `executeResult === false`.
    10. `gasStationStatus=="NOT_SUPPORT_INTENTION"` and no signing material (all of `hash`, `eip712MessageHash`,
        `unsignedTxHash`, `unsignedTx`, `authHashFor7702`, `jitoUnsignedTx` empty) → error
        `Gas Station does not support this transaction type — only transfers and swaps can pay gas with a stablecoin. Pay with native SOL instead, then retry. Top up SOL at: <fromAddr>`.
    11. `gasStationUsed == true` → GS-1 dispatch (below).
    12. Else → **Standard sign-and-broadcast** (`sign_and_broadcast`, see `contract-call`) with
        `TxParams{to=recipient, value=amt, contract=CA, everything else None, enable_gas_station=false}`,
        `is_contract_call=false`, `mev=false`, `force`, `tx_source=None`, `agent_biz_type="transfer"`, `agent_skill_name=None`.
        **This issues a second unsignedInfo request** (identical body) before broadcasting.
    13. Output `{"ok":true,"data":{"orderId":…,"txHash":…}}`.

**10004 funding scene** (`try_transfer_insufficient_balance_scene`, mod.rs:1109). Applies only when the raw error is an
`ApiCodeError` with code exactly `"10004"` and `chain` is covered (`is_evm_chain(chain)` or `chain=="501"`):
1. `token = CA or ""`. `query_token_readable(chain, token)`: `ensure_tokens_refreshed`; wallets (`not logged in`);
   `ensure_wallet_accounts_fresh(force=false)` (account/list + address/list only when `accounts` empty or an account lacks
   an `accountsMap` entry); `accountId = selectedAccountId || default account || first accountsMap key`;
   **HTTP** `GET /priapi/v5/wallet/agentic/asset/wallet-all-token-balances?accountId=<id>&chains=<chain>` (form-urlencoded
   values, empty values dropped); project token fields; match token where `chainIndex` (string or number text) == chain and
   `tokenAddress` equals token case-insensitively (`""` = native). Result: found → `(balance string|number text, symbol trimmed non-empty?, decimal u32?)`;
   not found → `balance "0"`, no symbol/decimals; request error → balance `null`.
2. Native (`token==""`): `asset = native_token_symbol(chain)`; if no decimals → `chain_profile::resolve(chain).nativeDecimals`
   (18 for all legacy chains incl. Solana).
   Contract: if decimals or symbol missing → `query_token_metadata` (`POST .../token/get-token-info`
   `{"chainIndex":<u64>,"source":0,"tokenAddress":CA}`; decimals from `decimals` then `decimal` (u64 or numeric string);
   symbol from `tokenSymbol` then `symbol`); fills only missing values; failure ignored.
3. `required = --readable-amount (raw, untrimmed)` if given, else `minimal_to_readable(amt, decimals)`; no decimals → scene aborted.
4. `funding::build_funding_bundle(chain, {asset: symbol or CA, tokenAddress: token, required, balance, operation:"transfer",
   errorCode:"10004", errorMessage:<backend msg>})`: validation (asset non-blank; `required` plain decimal > 0; if balance
   present it must show a positive shortfall — otherwise the scene is aborted and the original `code=10004 msg=…` error is
   returned); `ensure_tokens_refreshed`; `refresh_wallet_accounts_strict` (**POST account/list, POST account/address/list,
   rewrite wallets.json**, errors propagate → scene aborted); receive address = selected account address for chain;
   QR via `build_qr_output`.
5. Emits `CliFundingBlocked` → stdout `{"ok":false,"data":D}` exit 1, with D (sorted keys):
   ```json
   {"decision":"blocked","nextAction":[],
    "payload":{"error":{"code":"10004","message":"<msg>"},
               "fundingNeed":{"asset":"OKB","balance":"0.08504764"|null,"required":"10","shortfall":"9.91495236","tokenAddress":""},
               "fundingTarget":{"accountName":"<name or ''>","chainIndex":"196","chainName":"X Layer","gasFree":true,"receiveAddress":"0x…","sameNetworkRequired":true},
               "operation":"transfer",
               "qr":{"displayMode":"terminal-unicode","requestedFormat":"auto","resolvedFormat":"unicode","terminalQr":"<block>"}},
    "phase":"funding_required","reason":"insufficient_balance"}
   ```
   `shortfall` = `readable_shortfall(required, balance)` (exact BigUint decimal subtraction, trailing zeros trimmed) and is
   omitted when balance is null. `gasFree` = chainIndex=="196". In image-notify QR mode `qr` has
   `imagePath,markdownImage,mimeType:"image/png",notifyCommandArgs,resolvedFormat:"png"` instead of `terminalQr`.
   Test oracle (mod.rs:2353): OKB/196, balance `0.08504764`, required `10` → shortfall `9.91495236`.

**Simulation-shortfall funding scene** (`try_transfer_simulation_insufficient_balance_scene`, mod.rs:1178): only if
`executeResult` is JSON `false` and chain covered. `query_token_readable` must return a matched token (else skipped);
`requested = --readable-amount` or `minimal_to_readable(amt, matched.decimals)` (no decimals → skipped); only if
`readable_shortfall(requested, balance)` exists and != `"0"`. asset = native symbol or `matched.symbol` (may be absent →
`asset` = CA). `error` object contains only `message` = `executeErrorMsg` (if non-empty); **no `code`**.
Otherwise (not confirmed) execution continues (and for the non-GS path the 2nd unsignedInfo inside `sign_and_broadcast`
fails with `transaction simulation failed: <msg>`).

#### GS-1 — Gas Station dispatch on the phase-1 response (`gasStationUsed == true`)
1. `hasPendingTx` → success (exit 0) `{"ok":true,"data":{"gasStationUsed":true,"hasPendingTx":true,"scene":"gs_pending_tx"}}`.
2. `insufficientAll` → success `{"ok":true,"data":{"fromAddr":<addr>,"gasStationTokenList":[…],"gasStationUsed":true,"insufficientAll":true,"scene":"gs_insufficient_all"}}`
   (`gasStationTokenList` items always carry all 8 keys, sorted: `balance,context,feeCoinId(number),feeTokenAddress,relayerId,serviceCharge,sufficient,symbol`).
3. Any of `hash`, `eip712MessageHash`, `unsignedTxHash` non-empty (Phase-2 material already returned) →
   `handle_gs_auto_sign_broadcast`: GS sign + broadcast (GS-3) then success
   `{"autoSelectedToken":bool,"gasStationTokenList":[…],"gasStationUsed":true,"orderId":…,"serviceCharge":…,"serviceChargeSymbol":…,"txHash":…}`.
   (No `executeResult` check on this path.)
4. `classify_gs_phase1`:
   - `gasStationFirstTimePrompt==true` or status `FIRST_TIME_PROMPT` → **FirstTime**: `--force` → CliSetupRequired
     (`force_setup_required_for_send(is_reenable=false)`), else CliConfirming `build_gs_first_time_prompt`.
   - status `REENABLE_ONLY` → **Reenable**: `--force` → CliSetupRequired(`is_reenable=true`), else `build_gs_reenable_prompt`.
   - `auto_pick_gas_token`: if `defaultGasTokenAddress==""` → the token when **exactly one** list entry has
     `sufficient==true`; else the entry with `sufficient && feeTokenAddress.eq_ignore_ascii_case(default)`.
     Hit → **AutoPick** → `gas_station_send(amt, recipient, chain, from, CA, force, Some(feeTokenAddress), Some(relayerId),
     enable = (status == "PENDING_UPGRADE"))`.
   - miss → **NeedsUserPick** → CliConfirming `build_gs_token_selection_prompt`.

#### GS-2 — `gas_station_send` (gas_station.rs:26)
1. `ensure_tokens_refreshed`; wallets (`not logged in`); chain entry (`unsupported chain: <chain>` / `missing chainName`);
   `resolve_address` (no refresh); `chainIndexNum` (unwrap_or 1); session (`not logged in`).
2. **HTTP** `POST …/pre-transaction/unsignedInfo` body = phase-1 body plus `"enableGasStation":true` (only if enable flag),
   `"gasTokenAddress":<addr>` (if Some), `"relayerId":<id>` (if Some). Error → `code=<c> msg=<m>` (**no funding scene here**).
3. `NOT_SUPPORT_INTENTION` + no signing material → `gs_not_supported_err` (text above).
4. `!gasStationUsed` → `Gas Station not activated by backend for this transaction`.
5. `hasPendingTx` / `insufficientAll` → same success emitters as GS-1.
6. `executeResult===false` → `transaction simulation failed: <executeErrorMsg or "transaction simulation failed">`.
7. No material in {`unsignedTxHash`,`hash`,`eip712MessageHash`}:
   - gas token pinned → `Gas Station returned no signing material despite a pinned token (status: <gasStationStatus>). Activation did not complete; retry or pick another token.`
   - else classify: FirstTime → `build_gs_first_time_prompt` (CliConfirming even with `--force`); Reenable →
     `build_gs_reenable_prompt`; AutoPick → recursive `gas_station_send` with the picked token; NeedsUserPick → token-selection prompt.
8. GS-3 sign + broadcast, output `{"gasStationUsed":true,"orderId":…,"serviceCharge":…,"serviceChargeSymbol":…,"txHash":…}`.

#### GS-3 — GS sign + broadcast (`gas_station_sign_and_broadcast`)
- seed = HPKE(session.encryptedSessionSk, keyring `session_key` → `not logged in` if absent).
- `msgForSign` (`gs_build_msg_for_sign`), built in this order (later writes overwrite):
  1. `eip712MessageHash` non-empty → `sessionSignature = ed25519_sign_encoded(eip712MessageHash, seed, encoding)`
  2. else `hash` non-empty → `sessionSignature = ed25519_sign_encoded(hash, seed, encoding)` (**raw**, not EIP-191)
  3. `unsignedTxHash` non-empty → `unsignedTxHash` (echo) + `sessionSignature = ed25519_sign_encoded(unsignedTxHash, …)`
  4. `unsignedTx` non-empty → echo
  5. `authHashFor7702` non-empty → `authSignatureFor7702 = ed25519_sign_hex(authHashFor7702)`
  6. `sessionCert` non-empty → echo. (No `signature` key, no jito.)
- `extraData` (`gs_build_extra_data`): `unsigned.extraData` (if object, else `{}`) + `checkBalance:true` (always) +
  `uopHash`,`encoding`,`signType`,`msgForSign` + `skipWarning:true` iff `--force` + `gs_apply_extra_data_fields`:
  `paymentType:"token"`, `serviceCharge` (string, may be `""`), `feeTokenAddress:=serviceChargeFeeTokenAddress`,
  `contractNonce` (if non-empty), `relayerId`+`context` from the list entry whose `feeTokenAddress ==` (case-sensitive)
  `serviceChargeFeeTokenAddress` (if any), `user712Data` (if non-null, verbatim), and — only if `authHashFor7702` non-empty —
  `nonce:=eoaNonce` (if non-empty) and `user7702Data` (if non-null). **No `txType`, `agentBizType`, `isMEV`.**
- **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` (no-retry, no trace headers), body
  `{"accountId":<acct>,"address":<addr>,"chainIndex":<addr.chainIndex string>,"extraData":"<serialized>"}` →
  `handle_confirming_error(e, force)`. Response `data[0]` → `BroadcastResponse` (`broadcast: expected data to be an array` /
  `broadcast: data array is empty` / `broadcast: failed to parse response: …`).
  Unknown network outcome: `Broadcast result is unknown. Query transaction status before attempting another broadcast.: <reqwest error>`.

#### GS prompt / setup-required payloads (exact)
`summary = join("\n", [ "<i>. <symbol> (balance: <balance>, fee: <serviceCharge>)" for sufficient tokens, i from 1 ])`;
`tokenJson = serde_json::to_string(gasStationTokenList)` in **struct order** per item:
`{"feeCoinId":<n>,"symbol":…,"feeTokenAddress":…,"serviceCharge":…,"balance":…,"sufficient":…,"relayerId":…,"context":…}`;
`display = chain_display_name(addr.chainIndex)`.

- `gs_first_time` (exit 2):
  message ``Gas Station first-time setup required on <display>. Render the user-facing prompt via the Scene A template in `skills/okx-agentic-wallet/references/gas-station.md` (do NOT paraphrase). Sufficient stablecoins now:\n<summary>``;
  next ``On user pick `1` (decline): do not re-run; the user must top up native token.\nOn user pick `N` (N >= 2, one per sufficient token above): re-run `wallet send --enable-gas-station --gas-token-address <addr> --relayer-id <id>` with the chosen token.\nToken list: <tokenJson>``.
- `gs_reenable` (exit 2):
  message ``Gas Station re-enable required on <display> — the user previously disabled it. Render the user-facing prompt via the Scene B' template in `skills/okx-agentic-wallet/references/gas-station.md` (do NOT paraphrase). Previous default gas token address: <default or "(none)">. Sufficient stablecoins now:\n<summary>``;
  next ``On user pick `1` (decline): do not re-run; the user must top up native token.\nOn user pick `N` (N >= 2, one per sufficient token above): re-run `wallet send --enable-gas-station --gas-token-address <addr> --relayer-id <id>` with the chosen token. Backend will overwrite the previous default with the picked token.\nToken list: <tokenJson>``.
- `gs_token_switch` (exit 2):
  message ``Gas Station needs a token pick on this chain (default is missing or insufficient). Render the user-facing prompt via the Scene C template in `skills/okx-agentic-wallet/references/gas-station.md` (do NOT paraphrase). Sufficient stablecoins now:\n<summary>``;
  next ``On user pick (this-time-only option): re-run with `--gas-token-address <addr> --relayer-id <id>`.\nOn user pick (set-as-new-default option): same re-run, then call `wallet gas-station update-default-token --chain <chain> --gas-token-address <addr>` after the tx completes.\nToken list: <tokenJson>``.
- `GAS_STATION_SETUP_REQUIRED` (exit 3): `{"data":D,"errorCode":"GAS_STATION_SETUP_REQUIRED","message":M,"ok":false}`,
  `scene = "B'"` if re-enable else `"A"`,
  M = ``Gas Station first-time setup required on <display>. Cannot proceed under `--force` because first-time activation needs explicit user consent. Run `onchainos wallet gas-station setup --chain <addr.chainIndex> --gas-token-address <picked> --relayer-id <picked>` first (after rendering Scene <scene> to the user), then re-invoke the same command.``
  (same wording for re-enable), D (sorted):
  `{"chainId":addr.chainIndex,"chainName":display,"defaultGasTokenAddress":…,"fromAddress":addr.address,"gasStationStatus":…,
  "originalRequest":{"args":A,"command":"wallet send"},"retryGuidance":[
  "1) Render Scene <scene> via `skills/okx-agentic-wallet/references/gas-station.md` using `data.tokenList`.",
  "2) On user pick, run `wallet gas-station setup --chain <chainId> --gas-token-address <picked.feeTokenAddress> --relayer-id <picked.relayerId>`.",
  "3) Re-invoke the original command verbatim (it will succeed because Gas Station is now active)."],
  "scene":…,"tokenList":[{"balance","feeTokenAddress","relayerId","serviceCharge","sufficient","symbol"}…]}`.
  Send-path A = `{"amount":amt,"chain":<resolved chainIndex>,"contractToken":CA|null,"force":true,"from":from|null,"recipient":…}`.

#### Variant B — Bitcoin / BRC-20 (`transfer/bitcoin.rs:20`)
1. `validate_recipient(recipient)` (rust-bitcoin parse, mainnet required): `invalid recipient Bitcoin address: <lib error>` /
   `recipient must be a Bitcoin mainnet address: <lib error>`.
2. `--fee-rate` → `parse_fee_rate`: trimmed; at most one `.`, non-empty fraction; integer part non-empty digits without
   leading zero (unless `"0"`); else `--fee-rate must be a decimal sat/vB value`; value×10 < 10^scale →
   `--fee-rate must be at least 0.1 sat/vB`; result = JSON number parsed from the trimmed text (u64 if integer text, else f64).
3. `--contract-token` → `normalize_brc20_token_address`: trimmed, case-insensitive prefix `btc-brc20-`, ticker 1..64 bytes
   (`BRC-20 token address must use btc-brc20-<ticker>`), no whitespace/control/`/` (`BRC-20 ticker contains unsupported characters`);
   result `btc-brc20-<ticker lower-cased ASCII>`.
4. `BtcContext::load(--from)` (`load_chain_context("bitcoin", Bitcoin, "Bitcoin", …)`): `ensure_tokens_refreshed`;
   `chain_profile::resolve("bitcoin")` (non-bitcoin → `bitcoin profile resolved to a non-Bitcoin chain`); wallets
   (`not logged in`); `accountId = resolve_active_account_id`; select the **single** address of that account with
   `chainIndex == profile.chainIndex` (`current account '<id>' was not found` / `… has no Bitcoin address` /
   `… has multiple Bitcoin addresses`); if `--from` given, compare scriptPubKeys (invalid → `invalid from Bitcoin address: …`;
   mismatch → `--from must be the Bitcoin address of the current account`). On **any** selection failure: force refresh
   (account/list + address/list, rewrite wallets.json) and retry once. Then source must be mainnet P2TR
   (`current Agentic Wallet Bitcoin address must be Taproot (P2TR)`).
5. BRC-20 (`--contract-token`):
   - **HTTP** `POST /priapi/v5/wallet/agentic/utxo/availability-details` body
     `{"address":<from>,"chainIndex":"<profile.chainIndex>","queryType":"BRC20_TRANSFERABLE_UTXO_LIST","tokenAddress":<normalized>}`
     → `first_data_item`. API errors → BTC `CodedError` (see Errors).
   - if `--readable-amount`: **HTTP** `POST …/token/get-token-info` `{"chainIndex":<u64>,"source":0,"tokenAddress":<normalized>}`
     → `first_data_item` → decimals via `decimal_field` (first present key of `decimal`,`decimals`; string or u64)
     (`BRC-20 token metadata is missing decimal/decimals`) → `readable_to_minimal` (validators conversion + must be > 0).
   - select carriers: no outpoints → `BRC-20 transfers require at least one --brc20-outpoint selected from wallet utxo brc20-transferable`;
     snapshot items from `brc20TransferableUtxoList.utxos` or `utxos` (each needs `txHash`, `voutIndex`, `utxoAmountRaw`,
     `valueRaw`: `transferable UTXO <i> is missing <field>`); each selection parsed as `txid:vout`
     (`invalid outpoint '<v>': <lib error>`; canonical lower-case txid); duplicates → `BRC-20 UTXO <canon> was selected more than once`;
     not present → `selected BRC-20 UTXO is no longer transferable: <canon>`.
   - `amount = Σ valueRaw` (BigUint); if readable given and ≠ amount → `--readable-amount does not match the combined BRC-20 UTXO amount`.
   - `txParam = {"amount":amount,"inputs":[{"address":<from>,"amount":utxoAmountRaw,"txId":txHash,"vout":<u32 number>}…]}` (+ `"feeRate":<number>` if given).
   - **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` with header `idempotency-key: <uuid v4>` (retrying authed POST), body
     `{"amount":amount,"chainIndex":<u64>,"contractAddr":<token>,"fromAddr":<from>,"sessionCert":…,"signType":"transfer","toAddr":<recipient>,"txParam":{…}[,"walletType":"12"]}`;
     `walletType:"12"` only when `wallets.json.loginType` ∈ {`email`,`google`,`apple`}.
   Native BTC: (`--brc20-outpoint` without token is blocked by clap); no `--readable-amount` → `--readable-amount is required`;
   `amount = readable_to_minimal(readable, 8)`; **HTTP** unsignedInfo (idempotency-key) body
   `{"amount","chainIndex":<u64>,"fromAddr","sessionCert","toAddr"[,"txParam":{"feeRate":<number>}]}` (no signType/contractAddr/walletType).
   unsignedInfo errors mapped by `bitcoin::error::map_api_error`. Response → `first_data_item(data)`.
6. Seed (`SigningSeed::load`) + `sign_unsigned_hashes(Bitcoin)` — the transfer is **signed before** the confirmation step.
7. Without `--force`: `preview_from_response(prepared, op, chainIndex, from, recipient, token?, amount, readable, 8)` where
   `op = "BRC20_TRANSFER"` | `"BTC_TRANSFER"`, `readable = --readable-amount (raw) or amount`:
   requires `executeResult` bool (`INCOMPLETE_TRANSACTION_PREVIEW: missing executeResult`), false →
   `PRE_EXECUTION_FAILED: <executeErrorMsg or "Bitcoin transaction pre-execution failed">`; `txParam` object; `txParam.inputs`
   non-empty; `txParam.outputs` non-empty; `unsignedHashList` non-empty; `signType` == `"transfer"`
   (`PREVIEW_INTENT_MISMATCH: expected signType transfer, got <x>`); `encoding`. Preview (sorted keys):
   `{"asset":{"amount","readableAmount","symbol":<ticker after "btc-brc20-" or "BTC">,"tokenAddress":<token|null>},"chainIndex","changeAddress":txParam.changeAddress|null,
   "fee":txParam.fee|null,"feeRate":txParam.feeRate|null,"feeReadable":minimal_to_readable(fee,8)|null,"feeSymbol":"BTC",
   "from","inputs","network":"bitcoin","operationType":op,"outputs","preExecution":{"executeErrorMsg":…|null,"executeResult":true},
   "signing":{"encoding","signType","unsignedItemCount":n},"to","transaction":<txParam>,"warnings":resp.warnings|[]}`.
   Emits `WalletPreviewConfirming` exit **2**:
   `{"confirming":true,"scene":"btc_transfer"|"brc20_transfer","message":"The transfer has been signed and is ready to broadcast. Review the transfer and current network fee before confirming.","preview":{…},"next":N}`.
   N = `onchainos wallet send --chain bitcoin --recipient <q(recipient)> --readable-amount <q(readable)> --from <q(from)>`
   + ` --contract-token <q(token)>` (if BRC-20) + ` --brc20-outpoint <q(o)>` per selected canonical outpoint +
   ` --fee-rate <q(fr)>` where `fr` = **the response's** `txParam.feeRate` (number → its JSON text; string → only if it passes
   `parse_fee_rate`; otherwise omitted) + ` --force`. `q(v)` = `v` if every byte is `[A-Za-z0-9_\-.:/]`, else
   `'` + v with `'`→`'"'"'` + `'`. Oracle (bitcoin.rs:317):
   `onchainos wallet send --chain bitcoin --recipient bc1precipient --readable-amount 3 --from bc1pfrom --contract-token btc-brc20-pizza --brc20-outpoint tx-a:0 --brc20-outpoint tx-b:1 --fee-rate 12.5 --force`.
8. With `--force` (**no executeResult / preview checks at all**): `build_direct_extra_data(prepared, signed, sessionCert, true, "Bitcoin")`
   → **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` via `post_authed_mutation_no_retry`
   (no token retry; network error → `Network result is unknown for this state-changing request. Query authoritative state before retrying.: <err>`),
   body `{"accountId","address":<from>,"chainIndex":"<profile.chainIndex>","extraData":"<string>"}`; response must be non-empty
   array (`broadcast: expected a non-empty data array`). Errors: `handle_confirming_error(e, true)` then BTC `map_api_error`.
9. Output (sorted): `{"accountId","amount":<minimal>,"asset":<token or nativeSymbol>,"broadcasts":[{"orderId","txHash"}],"chainIndex","from",
   "message":"Bitcoin transaction submitted. The final result is pending network confirmation.","orderId","selectedBrc20Outpoints":[…],"state":"PENDING","to","txHash"}`.

#### Variant C — SUI native / `Coin<T>` (`transfer/sui.rs:24`)
1. `recipient = normalize_address` (trim, optional `0x`/`0X`, 1–64 hex → `0x` + lower-case left-padded to 64) else
   CodedError `LOCAL_PRECHECK_FAILED` `SUI address must contain 1 to 64 hexadecimal characters`.
2. `--contract-token` → `normalize_coin_type` (`<pkg>::<module>::<type>`; pkg normalized then leading zeros stripped →
   `0x<hex>`; module identifier `[A-Za-z_][A-Za-z0-9_]*`; type allows alnum `:,_<>` with balanced `<>`) else
   `LOCAL_PRECHECK_FAILED` `SUI Coin Type must be a complete <package>::<module>::<type> value`.
3. `SuiContext::load(--from)` (same as BTC context with `"sui"`, `"SUI"`, address check = `normalize_address`,
   `--from` compared after normalization: `--from must be the SUI address of the current account`).
4. Coin type given → **HTTP** `POST …/token/get-token-info` `{"chainIndex":<u64>,"source":0,"tokenAddress":<coinType>}`
   (errors → `CodedError(code,msg)`) → decimals via `decimal_field` else CodedError `INCOMPLETE_ASSET_METADATA`, field
   `contract-token`, `SUI token metadata is missing decimal`; symbol = non-empty `symbol` else the coin type.
   Native → decimals `nativeDecimals` (9), symbol `nativeSymbol`, effective coin type `0x2::sui::SUI`.
5. `amount = readable_to_minimal(readable, decimals)` → errors wrapped `LOCAL_PRECHECK_FAILED`.
6. **HTTP** `POST …/pre-transaction/unsignedInfo` with `idempotency-key: <uuid v4>`, body
   `{"amount","chainIndex":<u64>,["contractAddr":<coinType>,]"fromAddr","sessionCert","toAddr":<normalized>}`
   (`contractAddr` only when the user passed `--contract-token`). Errors → `CodedError(code,msg)`.
7. `executeResult===false` → `transaction simulation failed: <executeErrorMsg or "transaction simulation failed">` (plain error).
8. Seed + `sign_unsigned_hashes(Sui)`; failures → CodedError `LOCAL_SIGNING_FAILED` (message = error text).
9. Without `--force` → `WalletPreviewConfirming` exit 2, scene `sui_transfer`, same message as BTC, preview (sorted):
   `{"asset":{"amount","coinType","readableAmount":<raw input>,"symbol"},"chainIndex","fee","feeRate","feeReadable","feeSymbol":nativeSymbol,"from","network":"sui",
   "operationType":"SUI_TRANSFER","preExecution":{"executeErrorMsg","executeResult"},"signing":{"encoding","signType","unsignedItemCount"},"to","warnings"}`,
   `fee` = first non-null of `txParam.fee`, `txParam.gasFee`, `prepared.fee`, `prepared.gasFee` (else null);
   `feeRate` = `txParam.gasPrice` or `prepared.gasPrice` or null; `feeReadable = minimal_to_readable(fee, nativeDecimals)`;
   missing list/signType/encoding → `INCOMPLETE_TRANSACTION_PREVIEW: …`. Oracle: gasFee `1200000` → `0.0012`.
   next = `onchainos wallet send --chain sui --recipient <q(normalized)> --readable-amount <q(raw)> --from <q(from)>[ --contract-token <q(coinType)>] --force`.
10. `--force`: `build_direct_extra_data(…, force=true, "SUI")`, re-parsed (no agent fields for send), re-serialized →
    **HTTP** `POST …/broadcast-transaction` (WalletApiClient no-retry; body `{"accountId","address","chainIndex":"<profile idx>","extraData"}`),
    errors: `handle_confirming_error(e,true)` → `CodedError(code,msg)`.
11. Output (sorted): `{"amount","chainIndex","coinType","from","message":"SUI transaction submitted. The final result is pending network confirmation.","orderId","state":"PENDING","symbol","to","txHash"}`.

- Output summary (`wallet send`): see per-variant. All success shapes are `{"ok":true,"data":{…sorted…}}`.
- Errors: exit 1 `{"ok":false,"error":…}` for all bail!/validation errors listed above (texts quoted); `CodedError` for BTC/SUI
  API errors — BTC adds `data.state` + `nextSteps`: `44001` → `INSUFFICIENT_UTXO` + `{"queryUnavailableUtxos":"onchainos wallet utxo unavailable --chain bitcoin"}`;
  `44002` → `INSUFFICIENT_BTC_FOR_INSCRIPTION` + `{"refreshBtcBalance":"onchainos wallet balance --chain bitcoin --force","showBitcoinAddress":"onchainos wallet addresses --chain bitcoin"}`;
  `44003` → `NEED_INSCRIBE`; `82001` → `UTXO_PERMISSION_DENIED`; `82002` → `UTXO_NOT_FOUND` + queryUnavailableUtxos;
  `82003` → `INVALID_UTXO_REQUEST`; `82005` → `UTXO_ALREADY_SPENT` + queryUnavailableUtxos. Exit 2 for confirming
  (81362 on broadcast without `--force` in Variant A/GS; GS prompts; BTC/SUI previews) and clap errors; exit 3 for GS setup-required.
  Broadcast `81362` **with** `--force` (Variant A) → `{"ok":false,"error":"Wallet API error (code=81362): <msg>"}`; other broadcast
  codes likewise (e.g. `Wallet API error (code=81363): execution reverted`).
- Side effects: **FUND-MOVING** — `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction`. Local: may rewrite
  `chain_cache.json`, `wallets.json` (refresh fallbacks / funding scene), keyring (token refresh), QR PNG (funding scene,
  image-notify), `audit.jsonl`.
- Nondeterminism: `idempotency-key` UUIDv4 (BTC/SUI unsignedInfo); server `txHash`/`orderId`/hashes; token refresh timing;
  `accountsMap` HashMap iteration order when `--from` matches addresses in several accounts; QR PNG filename (pid + ns);
  `device-id`/`device-name` headers. Ed25519 signatures are deterministic given identical server hashes.
- Parity test cases:
  1. SAFE (no HTTP): `onchainos wallet send --chain 1 --recipient 0x000000000000000000000000000000000000dEaD --amt 1 --readable-amount 1` → clap conflict on stderr, exit 2.
  2. SAFE (chain list only): `onchainos wallet send --chain ethereum --recipient 0x000000000000000000000000000000000000dEaD --amt 007` → `{"ok":false,"error":"--amt must not have leading zeros, got \"007\""}` exit 1.
  3. SAFE (chain list only): `onchainos wallet send --chain bitcoin --recipient bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh --amt 1000` → `Bitcoin transfers require --readable-amount`.
  4. SAFE (chain list only): `onchainos wallet send --chain sui --recipient 0x1 --readable-amount 1 --fee-rate 2` → `--fee-rate is only supported for Bitcoin transfers`.
  5. SAFE (logged in; unsignedInfo, no broadcast): `onchainos wallet send --chain bitcoin --recipient bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh --readable-amount 0.00001` → `btc_transfer` preview, exit 2.
  6. UNSAFE: `onchainos wallet send --chain xlayer --recipient 0x<own address> --readable-amount 0.001 --contract-token usdt --force` → 2× unsignedInfo + broadcast.

---

### `onchainos wallet contract-call`  (hidden: no)

- Handler: dispatch `commands/agentic_wallet/mod.rs:918` → SUI: `transfer/sui.rs:223 cmd_contract_call`;
  otherwise `transfer/mod.rs:1516 cmd_contract_call` → `1563 execute_contract_call` → `204 sign_and_broadcast`.
- Options (clap, `mod.rs:245-301`; matches `cli-tree.json`):

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--to <TO>` | String | — | required in handler for EVM/Solana |
| `--chain <CHAIN>` | String | **required** | passed **raw** (not `resolve_chain`) |
| `--amt <AMT>` | String | `"0"` | |
| `--input-data <INPUT_DATA>` | String | — | may be combined with `--unsigned-tx` |
| `--unsigned-tx <UNSIGNED_TX>` | String | — | `conflicts_with = sui_tx_bytes` |
| `--sui-tx-bytes <SUI_TX_BYTES>` | String | — | `conflicts_with_all = [input_data, unsigned_tx]` |
| `--gas-limit <GAS_LIMIT>` | String | — | |
| `--from <FROM>` | String | — | |
| `--aa-dex-token-addr <…>` | String | — | |
| `--aa-dex-token-amount <…>` | String | — | |
| `--mev-protection` | bool flag | false | |
| `--jito-unsigned-tx <…>` | String | — | |
| `--force` | bool flag | false | |
| `--gas-token-address <…>` | String | — | |
| `--relayer-id <…>` | String | — | |
| `--enable-gas-station` | bool flag | false | |
| `--biz-type <BIZ_TYPE>` | String | — | → `agentBizType` |
| `--strategy <STRATEGY>` | String | — | → `agentSkillName` |
| global `--dev` (hidden), global `--chain` (shadowed) | | | as for send |

- Auth: jwt-required + session-key signature.

#### Dispatch
1. `chain_profile::resolve(--chain)` → `unsupported chain: <chain>`; `!capabilities.contract_call` →
   `wallet contract-call is not supported for chain '<profile.chainName>'` (Bitcoin, Unsupported-driver chains).
2. SUI driver: `--input-data`/`--unsigned-tx` → `SUI contract calls require --sui-tx-bytes, not --input-data or --unsigned-tx`;
   no `--sui-tx-bytes` → `--sui-tx-bytes is required for SUI contract calls`; any of gas-limit, aa-dex-token-addr,
   aa-dex-token-amount, mev-protection, jito-unsigned-tx, gas-token-address, relayer-id, enable-gas-station →
   `EVM/Solana-only contract-call options are not supported with --sui-tx-bytes` → Variant B.
3. Else: `--sui-tx-bytes` → `--sui-tx-bytes is only supported for SUI contract calls`; no `--to` →
   `--to is required for EVM and Solana contract calls` → Variant A.

#### Variant A — EVM / Solana (`execute_contract_call` + standard sign-and-broadcast)
1. `to==""||chain==""` → `to and chain are required`.
2. `validate_non_negative_integer(amt,"amt")`: trimmed; `""` → `--amt must not be empty`; non-digit →
   `--amt must be a non-negative integer, got "<v>"`; leading zero (len>1) → `--amt must not have leading zeros, got "<v>"`.
3. no `--input-data` and no `--unsigned-tx` → `either --input-data (EVM) or --unsigned-tx (SOL) is required`.
4. **Standard sign-and-broadcast** `sign_and_broadcast(chain_raw, from, TxParams{to, value=amt, contract_addr=Some(to),
   input_data, unsigned_tx, gas_limit, aa_dex_token_addr, aa_dex_token_amount, jito_unsigned_tx, gas_token_address,
   relayer_id, enable_gas_station}, is_contract_call=true, mev, force, tx_source=None, agent_biz_type=--biz-type,
   agent_skill_name=--strategy)`:
   1. `access = ensure_tokens_refreshed()`.
   2. `entry = get_chain_by_real_chain_index(chain)` → `unsupported chain: <chain>`; no chainName → `chain entry missing chainName for chain <chain>`.
   3. wallets (`not logged in`); `resolve_address_with_refresh(wallets, from, chainName)` (refresh = account/list +
      account/address/list, rewrite wallets.json).
   4. session.json (`not logged in`); keyring `session_key` (`not logged in`).
   5. `chainIndexNum = addr.chainIndex.parse::<u64>()` else `chain id '<ci>' is not a valid number`.
   6. Validation against `addr.chainIndex`: `validate_address_for_chain(ci, to, "to")`; `contract_addr` with label
      `contract-token` (same value as `to` here); `aa-dex-token-addr`; `validate_non_negative_integer(gas_limit,"gas-limit")`;
      `validate_non_negative_integer(aa_amount,"aa-dex-token-amount")`.
   7. Trace headers (contract calls only): `tid = cache.json.swapTraceId` (read errors ignored); if present, headers
      `ok-client-tid: <tid>`, `ok-client-timestamp: <now ms>`.
   8. **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` (retrying authed POST + trace headers), body (sorted):
      `{["aaDexTokenAddr",]["aaDexTokenAmount",]"amount":amt,"chainIndex":<num>,"chainPath","contractAddr":to,["enableGasStation":true,]"fromAddr",
      ["gasLimit",]["gasTokenAddress",]["inputData",]["jitoUnsignedTx",]["relayerId",]"sessionCert",["unsignedTx",]"toAddr":to}`.
      Errors → `code=<c> msg=<m>`.
   9. `executeResult === false` → `transaction simulation failed: <executeErrorMsg or "transaction simulation failed">`
      (non-bool / null count as success).
   10. `NOT_SUPPORT_INTENTION` without signing material → `gs_not_supported_err`.
   11. If `gasStationUsed`: `hasPendingTx` → `Gas Station has a pending transaction. Wait for it to complete, or run \`wallet gas-station disable --chain <chain>\` to use native token path.`;
       `insufficientAll` → `Gas Station cannot proceed — all supported tokens (USDT/USDC/USDG) are below the service charge. Top up at: <addr>`;
       if `hash`, `eip712MessageHash`, `unsignedTxHash` all empty → classify: FirstTime/Reenable → with `--force`
       CliSetupRequired (`force_setup_required_for_tx_params`, command `"wallet contract-call"`, args
       `{"chain":<raw>,"contractAddr":to,"force":true,"from":…|null,"inputData":…|null,"toAddr":to,"value":amt}`), else
       gs_first_time / gs_reenable CliConfirming (texts above — they say `wallet send` in `next`); AutoPick →
       **re-issue unsignedInfo** (same body + `gasTokenAddress`, `relayerId`, `enableGasStation:true` iff PENDING_UPGRADE,
       same trace headers/timestamp) and replace the response (no re-check of executeResult/pending/insufficient);
       NeedsUserPick → gs_token_switch CliConfirming.
   12. Signing-material guard: if all of `hash`, `eip712MessageHash`, `unsignedTxHash`, `unsignedTx`, `authHashFor7702`,
       `jitoUnsignedTx` empty, by status: FIRST_TIME_PROMPT/REENABLE_ONLY →
       ``Gas Station activation required (status: <s>), but backend did not return a token list. Re-run with `--enable-gas-station --gas-token-address <addr> --relayer-id <id>` after picking a token, or first activate Gas Station via a small `wallet send` ERC-20 transfer.``;
       PENDING_UPGRADE → `Gas Station activation is pending on-chain. Wait ~30s and retry. If this persists, the account may be stuck — contact support to reset.`;
       INSUFFICIENT_ALL → `Insufficient balance across native token and all Gas Station stablecoins (USDT / USDC / USDG). Top up at: <addr>`;
       HAS_PENDING_TX → ``A pending Gas Station transaction is blocking this request. Wait for it to complete, or run `wallet gas-station disable --chain <chain>` to bypass.``;
       NOT_SUPPORT_INTENTION → gs_not_supported_err; else → `Backend returned empty signing materials with gasStationStatus="<s>". This is unexpected — likely a backend/environment issue.`
   13. seed = HPKE decrypt. `msgForSign` (in order, later overwrite):
       `hash` → `signature = ed25519_sign_eip191(hash, seed, "hex")`; `authHashFor7702` → `authSignatureFor7702 = ed25519_sign_hex`;
       `unsignedTxHash` → echo + `sessionSignature = ed25519_sign_encoded(unsignedTxHash, encoding)`;
       `eip712MessageHash` → `sessionSignature = ed25519_sign_encoded(eip712MessageHash, encoding)` (overwrites);
       `unsignedTx` → echo; `jitoUnsignedTx` → echo + `jitoSessionSignature = ed25519_sign_encoded(jitoUnsignedTx, encoding)`;
       `sessionCert` (non-empty) → echo.
   14. `extraData` = `unsigned.extraData` (object) or `{}` + `apply_broadcast_core` (`checkBalance = !freeGas`) +
       `txType:2` **only for send** (not contract-call) + `isMEV:true` (if `--mev-protection`) + `skipWarning:true` (if `--force`)
       + `txSource` (if Some; `"3"` from cross-chain) + `agentBizType` + `agentSkillName` + (if `gasStationUsed`)
       `gs_apply_extra_data_fields` (see GS-3). Serialized compact, sorted.
   15. Broadcast trace headers: same tid, **new** `ok-client-timestamp`.
   16. **HTTP** `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` (no-retry) body
       `{"accountId","address","chainIndex":"<addr.chainIndex>","extraData":"<string>"}` → `handle_confirming_error(e, force)`.
   17. contract calls: `clear_swap_trace_id()` → rewrites `cache.json` without `swapTraceId` (creates `{}` if absent; errors ignored).
5. Output `{"ok":true,"data":{"orderId":…,"txHash":…}}`.

#### Variant B — SUI PTB (`transfer/sui.rs:223`)
1. `validate_tx_bytes`: trimmed empty → `--sui-tx-bytes must not be empty`; base64 (standard, padded) decode failure →
   `--sui-tx-bytes must be valid base64`; decodes to empty → `--sui-tx-bytes must decode to non-empty TransactionData`;
   all wrapped as CodedError `LOCAL_PRECHECK_FAILED` (message = outermost error text). **No HTTP before this.**
2. `validate_non_negative_integer(--amt,"amt")` → `LOCAL_PRECHECK_FAILED`.
3. `--to` (optional) → `normalize_address` → `LOCAL_PRECHECK_FAILED`.
4. `SuiContext::load(--from)`.
5. **HTTP** `POST …/pre-transaction/unsignedInfo` with `idempotency-key: <uuid v4>`, body
   `{"amount":<amt raw>,"chainIndex":<u64>,"contractAddr":"0x0","fromAddr","sessionCert","toAddr":<normalized to or "0x">,"txParam":{"txBytes":<trimmed>}}`.
   Errors → `CodedError(code,msg)`.
6. `executeResult===false` → `transaction simulation failed: …`.
7. seed + sign (Sui profile) → `LOCAL_SIGNING_FAILED` on failure.
8. **No preview/confirmation regardless of `--force`.** `build_direct_extra_data(…, force, "SUI")` then add
   `agentBizType`/`agentSkillName` → **HTTP** `POST …/broadcast-transaction` (no-retry). Errors: `handle_confirming_error(e, force)`:
   81362 without `--force` → CliConfirming exit 2 (passes through SUI `map_api_error`); otherwise `CodedError(code,msg)`.
9. Output (sorted): `{"chainIndex","message":"SUI contract transaction submitted. The final result is pending network confirmation.","orderId","state":"PENDING","txHash"}`.

- Output: as above.
- Errors: as enumerated; exit 1 (plain / CodedError), exit 2 (clap, 81362 confirming, GS prompts), exit 3 (GS setup-required with `--force`).
- Side effects: **FUND-MOVING** — `POST /priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction`. Local: `cache.json`
  rewrite (EVM/Solana success), possible `wallets.json`, `chain_cache.json`, keyring, `audit.jsonl`.
- Nondeterminism: `ok-client-timestamp` (only when a swap trace id is cached), `idempotency-key` (SUI), server ids.
- Parity test cases:
  1. SAFE (chain list only): `onchainos wallet contract-call --chain 1 --to 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` → `{"ok":false,"error":"either --input-data (EVM) or --unsigned-tx (SOL) is required"}` exit 1.
  2. SAFE (chain list only): `onchainos wallet contract-call --chain bitcoin --to x --input-data 0x` → `wallet contract-call is not supported for chain '<chainName from list>'`.
  3. SAFE (chain list only): `onchainos wallet contract-call --chain sui --sui-tx-bytes not-base64` → `{"error":"--sui-tx-bytes must be valid base64","errorCode":"LOCAL_PRECHECK_FAILED","ok":false}` exit 1.
  4. SAFE (no HTTP): `onchainos wallet contract-call --chain sui --sui-tx-bytes AAECAwQ= --input-data 0x` → clap conflict, exit 2.
  5. UNSAFE: `onchainos wallet contract-call --chain base --to 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 --input-data 0x095ea7b3<spender32><amount32> --force`.

---

## Endpoint classification

| Method | Path | Class | Used by |
|---|---|---|---|
| POST | `/priapi/v5/wallet/agentic/chain/support/list` | read | send, contract-call (chain cache) |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | send, contract-call (token refresh / invalid-token retry) |
| POST | `/priapi/v5/wallet/agentic/token/get-token-info` | read | send (readable amount, BRC-20 decimals, SUI coin metadata, funding scene) |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/unsignedInfo` | read (simulation; see open questions re `enableGasStation`/idempotency) | send, contract-call |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/broadcast-transaction` | **funds** | send, contract-call |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/batch/unsignedInfo` | read | `batch_sign_and_broadcast` (swap) |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/batch-broadcast-transaction` | **funds** | `batch_sign_and_broadcast` (swap) |
| POST | `/priapi/v5/wallet/agentic/account/list` | read | refresh fallbacks, funding scene |
| POST | `/priapi/v5/wallet/agentic/account/address/list` | read | refresh fallbacks, funding scene |
| GET | `/priapi/v5/wallet/agentic/asset/wallet-all-token-balances` | read | send funding scenes |
| POST | `/priapi/v5/wallet/agentic/utxo/availability-details` | read | send (BRC-20) |

## External hosts

None contacted directly by this partition. Indirect (core-owned, via `WalletApiClient`): DoH failover node selection
(`doh/manager.rs`) and the DoH helper binary CDNs `https://static.okx.com/upgradeapp/tools/pilot`,
`https://static.coinall.ltd/upgradeapp/tools/pilot`, `https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`,
`https://static.jingyunyilian.com/upgradeapp/tools/pilot` (only when not `--dev` / not custom base URL). Hidden `--dev`
switches the API origin to `https://beta.okex.org`.

## Open questions

1. `unsignedInfo` with `enableGasStation:true` is documented as "sets gasTokenAddress as default"; whether the backend
   persists state on that call (vs. only on broadcast) is not visible in the CLI — treat as potentially state-changing for replay.
2. BTC/SUI unsignedInfo carry an `idempotency-key` UUID; whether the backend reserves UTXOs per key is unknown.
3. Native `--readable-amount` on Tron (195) / TON (607) / other non-EVM legacy chains uses 18 decimals (upstream quirk; TRX is 6) — reproduce or fix?
4. BRC-20 send without `--readable-amount`: the preview `next` command puts the *minimal* amount into `--readable-amount`,
   which on re-run is re-scaled and fails the equality check — upstream bug; reproduce as-is?
5. BTC `--force` path skips all `executeResult` / preview validation; GS phase-2-first-response path (`handle_gs_auto_sign_broadcast`)
   skips `executeResult` — confirm intended.
6. `gas_station_send` ignores `--force` for FirstTime/Reenable (always CliConfirming, never setup-required) — intended?
7. `get_chain_by_real_chain_index` matches `chainIndex` OR `realChainIndex` OR name — ambiguous if one chain's
   realChainIndex equals another's chainIndex (first list entry wins).
8. rust-bitcoin address/outpoint parse error texts (embedded in BTC error messages) are library-specific and hard to
   reproduce byte-for-byte in Node.
