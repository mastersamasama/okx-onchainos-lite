# g09b-payment-schemes — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: `payment quote`, `payment a2a-pay {create,pay,status}`, `payment subscription {subscribe,access,change,cancel,
cancel-pending,my-subscriptions,allowance-status}`, plus the library modules they own: A2MCP prepared-payment /
intent state (`commands/payment/a2mcp.rs`), Permit2 exact/upto signing (`payment/permit2/`), and x402 `period`
subscription signing (`payment/subscription/`). There are **no hidden commands or hidden args** in this partition
(`grep hide` over all partition files: no hits). Hidden global `--dev` belongs to core (see g09a §0.4).

Cross-reference: `g09a-payment-core.md` §0 (JSON key order, envelope, exit codes, global `--chain`, login artefacts,
TEE protocol) applies verbatim here; the rules are restated below only where this partition differs.

## Sources read

Partition files (read fully, line counts from `wc -l`):

| file | lines |
|---|---|
| cli/src/commands/payment/a2a_pay.rs | 1188 |
| cli/src/commands/payment/a2mcp.rs | 1635 |
| cli/src/commands/payment/quote.rs | 1630 |
| cli/src/commands/payment/subscription.rs | 564 |
| cli/src/payment/permit2/mod.rs | 4 |
| cli/src/payment/permit2/types.rs | 204 |
| cli/src/payment/permit2/eip712.rs | 491 |
| cli/src/payment/permit2/rpc.rs | 217 |
| cli/src/payment/permit2/sign.rs | 310 |
| cli/src/payment/subscription/mod.rs | 5 |
| cli/src/payment/subscription/types.rs | 390 |
| cli/src/payment/subscription/eip712.rs | 625 |
| cli/src/payment/subscription/sign.rs | 798 |
| cli/src/payment/subscription/facilitator.rs | 115 |
| cli/src/payment/subscription/cache.rs | 252 |
| cli/src/payment/mod.rs | 2 |

Consulted for callee/caller behaviour (read in the relevant ranges, not owned): `main.rs` (316, full), `output.rs`
(450, full), `commands/payment/state.rs` (423, full), `commands/payment/dispatcher.rs` (lines 1–340, 753–800),
`commands/payment/payment_flow.rs` (200–820, 1265–1720), `commands/payment/http_carrier.rs` (1–130),
`commands/payment/a2mcp_tests.rs` (1–160), `commands/payment/mod.rs` (25), `mcp_client.rs` (1–460 of 732),
`wallet_api.rs` (100–131, 630–1330, 1487–1600), `client.rs` (180–640), `chains.rs` (1–330), `endpoints.rs`
(20–65), `commands/agentic_wallet/chain.rs` (175, full), `commands/agentic_wallet/auth/mod.rs` (120–380),
`commands/agentic_wallet/transfer/mod.rs` (15–60), `commands/agentic_wallet/balance/mod.rs` (136–200, 990–1140),
`commands/agentic_wallet/shared/common/amount.rs` (25–75), `funding.rs` (1–310), `crypto.rs` (39–314),
`home.rs` (1–240), `commands/portfolio.rs` (143–166), `commands/token.rs` (648–653), `mcp/mod.rs` (761–840,
1020–1120), `audit.rs` (805–850), `cli/Cargo.toml`, `cli/Cargo.lock` (serde_json entry),
`spec/cli-tree.json`.

Verification performed: a scratch Python re-implementation of the EIP-712 encodings described in §C/§G below
reproduces both upstream Permit2 golden digests byte-for-byte (`0x3ffe06bf…9155`, `0x796938f2…66c9`). Extra
vectors marked "derived" in this spec were computed with that same reference implementation (not asserted by
upstream tests; use them as secondary oracles).

---

## 0. Conventions specific to this partition

1. **Key order.** No `preserve_order` → every `serde_json::Value` object serializes with keys in byte-wise ascending
   order (uppercase before lowercase). Which outputs are sorted vs. declaration-order matters:
   - `payment quote` → `serde_json::to_value(QuoteData)` → **sorted at every level**.
   - `a2a-pay create` → struct `CreatePaymentOutput` printed directly → **declaration order** `payment_id`,
     `deliveries` (snake_case keys!); the `deliveries` passthrough Value is sorted.
   - `a2a-pay pay` → struct `PayOutput` printed directly → **declaration order** `payment_id`, `status`, `tx_hash`,
     `valid_after`, `valid_before`, `signature` (snake_case keys).
   - `a2a-pay status` → `to_value(A2aStatusData)` → sorted (`status`, `terminal`, `timed_out`).
   - every `payment subscription …` output is built with `json!` → sorted at every level.
   - every JSON request body built from `json!`/`to_value` is compact with sorted keys; typed-data `types` arrays
     keep array order.
2. **Envelope / exit codes** as g09a §0.2–0.3. Differences: `payment quote` uses `ApiClient` (token basic-info and
   DEX balances), whose x402 auto-pay layer may queue `payment_notify` events → the envelope **may** carry a trailing
   `"notifications":[…]` key for quote. The a2a funding scene uses `output::error_data` →
   `{"ok":false,"data":{…}}` exit 1.
3. **Global `--chain`**: accepted and ignored by `quote`, `a2a-pay *`, `subscription subscribe`, `subscription
   change`. `subscription access|cancel|cancel-pending|my-subscriptions|allowance-status` declare their own
   `--chain` (default `xlayer`), which shadows the global one (cli-tree shows a single `--chain … [default: xlayer]`).
4. **Error text**: `{"ok":false,"error": format!("{e:#}")}` — anyhow chain, outer context first, joined with `": "`.
   `.context("…/p/{id}…")` strings below are **string literals**: the text `{id}` appears literally in the error.
5. **Auth primitives needed by this partition** (for a lite re-implementation of the same login flow): JWT
   `access_token` + `refresh_token` (keyring), `session.json` (`session_cert`, `encrypted_session_sk`,
   `session_key_expire_at`), keyring `session_key` (X25519 secret, base64), `wallets.json` (selected account,
   per-chain addresses), `chain_cache.json` (TTL 600 s). TEE signing = gen-msg-hash → local Ed25519 session
   signature → sign-msg (g09a "TEE signing protocol"). `ensure_tokens_refreshed()` may `POST
   /priapi/v5/wallet/agentic/auth/refresh` when a token is within its refresh margin.

---

## Shared helpers (used across groups or from core)

### A. HTTP clients used (owned by core; one-line summaries)

- `WalletApiClient::new()` (wallet_api.rs:766) — base URL `endpoints::base_url()` (`https://web3.okx.com`, or
  `https://beta.okex.org` with `--dev`), 30 s timeout, DoH manager (may resolve/proxy the host; sets User-Agent),
  envelope unwrap `{code,msg,data}` → `data` (code `"0"`/`0`), non-zero → `ApiCodeError` Display
  `Wallet API error (code=<c>): <msg>`; HTTP ≥ 500 → `Wallet API server error (HTTP <n>): <body>`; non-JSON →
  `failed to parse wallet API response as JSON (HTTP <n>): <≤500 chars>`.
  - `post_authed(path, token, body)` / `get_authed(path, token, query)` — `ApiClient::jwt_headers`
    (`Content-Type: application/json`, `ok-client-version`, `Ok-Access-Client-type: agent-cli`, `platform:
    agent-cli`, `device-id`, `device-name`, `Authorization: Bearer <jwt>`); one forced refresh+retry on
    invalid-token codes 10001/10008/53017/130100031.
  - `get_public(path, query)` — `anonymous_headers` (same minus `Authorization`).
  - `get_no_okheaders(path)` — **no headers at all** (only reqwest defaults + DoH User-Agent); `path` already
    contains the raw query string.
  - `build_query_string` (wallet_api.rs:106): drops empty values, form-urlencodes values, keys raw.
- `format_api_error(e)` (agentic_wallet/auth/mod.rs:338) — `ApiCodeError` → `code=<code> msg=<msg>`; other errors
  unchanged.
- `ensure_tokens_refreshed()` (auth/mod.rs:132) — returns access token; failures:
  `session expired, please login again: onchainos wallet login` (session missing / `session_key_expire_at` empty or
  past / tokens missing / refresh token expired; the last also prints `Session expired. Please log in again:
  onchainos wallet login` to stderr). Refresh: `POST /priapi/v5/wallet/agentic/auth/refresh` (class auth).
- `ApiClient::new()` (client.rs:207) — JWT from keyring if non-empty (no expiry check) else anonymous; 10 s timeout;
  `get`/`post` wrap an x402 auto-payment layer (`ensure_payment_config`, pre-sign / 402 retry, may emit
  notifications). Error text `API error (code=<c>): <msg>`.
- `agentic_wallet::chain::get_all_chains()` (chain.rs:31) — `chain_cache.json` if younger than 600 s, else
  `POST /priapi/v5/wallet/agentic/chain/support/list` body `{}` (anonymous) → `data` array or `data.chainList`;
  cache rewritten. `get_chain_by_index(idx)` matches `chainIndex` (string or int);
  `get_chain_by_real_chain_index(input)` matches `chainIndex` | `realChainIndex` | `chainName` (ASCII
  case-insensitive) | any `alias[]`; `get_real_chain_index(idx)` → `realChainIndex` as u64, errors
  `Chain index {idx} not found in supported chains` / `Cannot resolve realChainIndex for chain index {idx}`.
- `transfer::resolve_address(wallets, from, chainName)` (transfer/mod.rs:26) — with `from`: first
  `(account, addr)` whose address equals `from` (ASCII case-insensitive) and `chain_name == chainName` (exact) else
  `no address matches from={from} chain={chainName}`; without: selected account (`no currentAccountId` /
  `not found currentAccountId`), first address with that chain name else
  `no address for chain={chainName} in account={acct}`.
- `chains::resolve_chain(name)` (chains.rs:129) — lowercase match against `chain_cache.json` `chainName`, then
  alias table (`xlayer|x layer|x-layer|okb`→`196`, `ethereum|eth`→`1`, `base`→`8453`, `bsc|bnb`→`56`, … ), else
  input unchanged. `chains::chain_display_name(idx)` (chains.rs:291) — `196`→`X Layer`, `1`→`Ethereum`,
  `8453`→`Base`, `42161`→`Arbitrum One`, `1952`→`X Layer Testnet`, … else the index itself.
  `chains::is_mainnet_chain(idx)` — chain cache classification, else `1952` testnet, else static allowlist, unknown
  → false. Constants: `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3`,
  `X402_EXACT_PERMIT2_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001`,
  `X402_UPTO_PERMIT2_PROXY = 0x4020e7393B728A3939659E5732F87fdd8e680002`; `rpc_url_for_chain("196") =
  https://rpc.xlayer.tech` (only chain wired).
- `dispatcher::decode_payment_blob(input)` (dispatcher.rs:753) — trims; `Payment ` prefix (case-insensitive) →
  MPP WWW-Authenticate parse (has no `accepts`); else first of base64 STANDARD / STANDARD_NO_PAD / URL_SAFE /
  URL_SAFE_NO_PAD whose bytes parse as JSON; else plain JSON; else error `could not decode payment blob: not a
  WWW-Authenticate challenge, base64-encoded JSON, or plain JSON`.
- `http_carrier::build_request(client, method, url, params, plan)` (http_carrier.rs:46) — carrier per plan else
  body for POST/PUT/PATCH/DELETE, query otherwise; path params percent-encoded (NON_ALPHANUMERIC) into `{k}`;
  JSON body only for body-bearing methods and only if non-empty; method `from_bytes(uppercase)` else GET.
- `payment_flow::extract_amount(entry)` (payment_flow.rs:263) — `amount` string | u64 → string; tiered object →
  error; else `maxAmountRequired` string | u64; else error `missing 'amount' or 'maxAmountRequired' in accepts
  entry`.
- `payment_flow::select_accept_with_preference(accepts, None)` (payment_flow.rs:215) — first `scheme=="exact"`, else
  first `aggr_deferred`, else `accepts[0]`; empty → `accepts array is empty`.
- `payment_flow::rank_candidates` (payment_flow.rs:1345; owned by g09a, algorithm restated in §L.8 because quote
  output depends on it).
- `payment_flow::resolve_chain_and_payer(accepted, from)` (payment_flow.rs:393) — `network` required (`missing
  'network' in accepts entry`), `eip155:<u64>` (`network '{n}' is not a CAIP-2 EVM identifier (eip155:<id>)`,
  `network '{n}' has non-numeric chain id: <ParseIntError>`), chain lookup via `get_chain_by_real_chain_index`
  (`chain not found for realChainIndex {id}`), `missing chainIndex in chain entry`, `missing chainName in chain
  entry`, wallets (`not logged in`), `resolve_address(wallets, from, chainName)` → `(chainIndex, realChainId,
  address)`.
- `payment_flow::resolve_chain_and_payer_by_chain(chain, from)` (payment_flow.rs:424) — `resolve_chain(chain)` →
  `get_chain_by_index` (`chain not found: {chain}`) → `get_real_chain_index` → wallets → `resolve_address`.
- `crypto::hpke_decrypt_session_sk`, `ed25519_sign`, `ed25519_sign_hex` (hex-decode then sign, base64 result;
  empty hex → `""`), `ed25519_sign_eip191(msg, seed, "hex")` (Ed25519 over
  `keccak256("\x19Ethereum Signed Message:\n" + len + bytes)`, base64), `secp256k1_sign` (65 bytes, v∈{0,1}).
- `home::atomic_write(path, bytes, sensitive)` (home.rs:210) — parent dir 0700, write `<file>.tmp`, chmod
  0600 (sensitive) / 0644 (unix only), rename.
- `funding::build_funding_bundle(chainIndex, input)` (funding.rs:199) — ensure tokens, refresh accounts
  (`POST /priapi/v5/wallet/agentic/account/list` `{projectId}`, `POST …/account/address/list` `{accountIds}`,
  rewrites wallets.json), resolve receive address, build QR (`qr.rs`), return the standard blocked result
  (§K.6). `funding::readable_shortfall` exact decimal subtraction (`"10"`,`"0.08504764"` → `"9.91495236"`).
- `agentic_wallet::balance::query_token_readable(chainIndex, token)` (balance/mod.rs:1126) — ensure tokens, wallet
  freshness, `GET /priapi/v5/wallet/agentic/asset/wallet-all-token-balances?accountId=..&chains=..` (JWT), match
  `(tokenAddress case-insensitive, chainIndex)` → `{balance, symbol, decimals}` | None.
  `query_token_metadata` (balance/mod.rs:998) — `POST /priapi/v5/wallet/agentic/token/get-token-info`
  `{"chainIndex":<u64>,"source":0,"tokenAddress":..}` → `{symbol?, decimals}`.
  `shared::common::amount::minimal_to_readable(v, d)` — string shift, trailing fraction zeros trimmed.
- `mcp_client::McpClient` (mcp_client.rs) — see §L.3.

### B. `payment/permit2/types.rs` — Permit2 wire payloads

- `pub const CLOCK_SKEW_BACKDATE_SECS: u64 = 600` (types.rs:11).
- Serialized field order is declaration order (structs, camelCase) — but callers convert them with `to_value`, so
  on the wire they end up key-sorted anyway.
  - `Permit2Permitted {token, amount}`; `Permit2Witness {to, validAfter}`;
    `Permit2Authorization {from, permitted, spender, nonce, deadline, witness}`;
    `ExactPermit2Payload {signature, permit2Authorization}`.
  - `UptoPermit2Witness {to, facilitator, validAfter}`; `UptoPermit2Authorization {from, permitted, spender,
    nonce, deadline, witness}`; `UptoPermit2Payload {signature, permit2Authorization}`.
  - All numeric fields are decimal **strings**; `from` is outside the EIP-712 message (identifies the signer).
- Oracle (types.rs tests): exact wire `{"signature":"0xfa42c11c","permit2Authorization":{"from":"0xBuyer",
  "permitted":{"token":"0xToken","amount":"1234000"},"spender":"0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
  "nonce":"1027389","deadline":"1714813500","witness":{"to":"0xMerchant","validAfter":"1714812840"}}}` round-trips.

### C. `payment/permit2/eip712.rs` — Permit2 EIP-712 layouts

- Domain (both schemes) `permit2_domain(chainId)` (eip712.rs:75): `{name:"Permit2", chainId, verifyingContract:
  PERMIT2_ADDRESS}` — **no `version`, no `salt`**. Domain typehash string
  `EIP712Domain(string name,uint256 chainId,address verifyingContract)`.
- Exact struct types (sol_exact): `TokenPermissions(address token,uint256 amount)`,
  `Witness(address to,uint256 validAfter)`, root
  `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness
  witness)`. encodeType(root) = root + `TokenPermissions(...)` + `Witness(...)` (referenced types alphabetically).
- Upto (sol_upto): identical except `Witness(address to,address facilitator,uint256 validAfter)`.
- `build_exact_permit2_struct` / `build_upto_permit2_struct` (112/133) parse strings; errors `invalid token
  address`, `invalid amount uint256`, `invalid spender address`, `invalid nonce uint256`, `invalid deadline
  uint256`, `invalid witness.to address`, `invalid witness.facilitator address`, `invalid witness.validAfter
  uint256`.
- `build_exact_permit2_typed_data(input)` (160) — the JSON sent to the TEE (sorted on the wire):
  ```
  {"domain":{"chainId":<u64 number>,"name":"Permit2","verifyingContract":"0x000000000022D473030F116dDEE9F6B43aC78BA3"},
   "message":{"deadline":"<str>","nonce":"<str>","permitted":{"amount":"<str>","token":"<addr>"},
              "spender":"<addr>","witness":{"to":"<addr>","validAfter":"<str>"}},
   "primaryType":"PermitWitnessTransferFrom",
   "types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"chainId","type":"uint256"},
                            {"name":"verifyingContract","type":"address"}],
            "PermitWitnessTransferFrom":[{"name":"permitted","type":"TokenPermissions"},{"name":"spender","type":"address"},
                            {"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"},
                            {"name":"witness","type":"Witness"}],
            "TokenPermissions":[{"name":"token","type":"address"},{"name":"amount","type":"uint256"}],
            "Witness":[{"name":"to","type":"address"},{"name":"validAfter","type":"uint256"}]}}
  ```
  Values are the caller's strings verbatim (addresses not re-cased).
- `build_upto_permit2_typed_data` (207) — same, `Witness` = `[to:address, facilitator:address,
  validAfter:uint256]`, message witness adds `"facilitator"`.
- Golden vectors (upstream tests; reproduced): chainId 196, token `0x779ded0c9e1022225f8e0630b35a9b54be713736`,
  nonce `1027389`, deadline `1714813500`, witness.to `0x…beef`, validAfter `1714812840`:
  - exact, amount `1234000`, spender = exact proxy → digest
    `0x3ffe06bf5e4edd78f53b87e84d297128e164e5ce5a74aeaa5fd3a82498619155`
  - upto, amount `5000000`, spender `0x4020e7393B728A3939659E5732F87fdd8e680002`, facilitator `0x…cafe` → digest
    `0x796938f26e4b4fc3292117cd3f61578144a0c794bc03394cd1bb315a365b66c9`.

### D. `payment/permit2/sign.rs` — TEE / local signing (used by `payment pay`, `payment pay-local`, subscription)

1. `session_sign_msg_hash(msgHash)` (sign.rs:32) — load session (`not logged in`), keyring `session_key`
   (`not logged in`), HPKE-decrypt seed, `sessionSignature = ed25519_sign_hex(msgHash, base64(seed))` (base64
   Ed25519 over hex-decoded msgHash). Returns `(sessionSignature, session_cert)`.
2. `tee_gen_msg_hash(chainIndex, typedData)` (187) — `ensure_tokens_refreshed`; `POST
   /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` (JWT) body
   `{"chainIndex":"<chainIndex>","payload":[{"message":<typedData>,"msgType":"eip712"}]}` → `data[0].msgHash`.
   Errors: `permit2 gen-msg-hash failed: code=<c> msg=<m>`; `missing msgHash in gen-msg-hash response`.
3. `tee_sign_eip712(chainIndex, payer, typedData)` (223) — (2), then `ensure_tokens_refreshed` again, (1), then
   `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` (JWT) body
   `{"chainIndex":"<ci>","from":"<payer>","payload":[{"message":<typedData>,"sessionSignature":"<b64>",
   "signType":"eip712"}],"sessionCert":"<cert>","skipWarning":true}` → `data[0].signature` (0x 65-byte secp256k1).
   Errors: `permit2 sign-msg failed: …`; `missing signature in sign-msg response`.
4. `tee_sign_personal(chainIndex, from, valueHex)` (266) — tokens, session, key, seed;
   `sessionSignature = ed25519_sign_eip191(valueHex, seed, "hex")`; `POST …/sign-msg` body
   `{"chainIndex":..,"from":..,"payload":[{"message":{"value":"<0x+64hex>"},"sessionSignature":"<b64>",
   "signType":"personalSign"}],"sessionCert":..,"skipWarning":true}` → `data[0].signature`. Errors: `AccessProof
   personalSign failed: …`, `missing signature in personalSign response`. **No gen-msg-hash call.**
5. `sign_exact_permit2(chainIndex, payer, input)` / `sign_upto_permit2` (52/80) — typed data (§C) →
   `tee_sign_eip712` → `ExactPermit2Payload`/`UptoPermit2Payload` with `from = payer` and all input strings verbatim.
6. Local: `sign_exact_permit2_local` / `sign_upto_permit2_local` (119/150) — digest = alloy
   `eip712_signing_hash` (= `keccak256(0x1901 ‖ domainSep ‖ hashStruct)`), `secp256k1_sign(pk, digest)`, then
   `sig[64] += 27` (legacy v 27/28), `0x`+hex.

### E. `payment/permit2/rpc.rs` — Permit2 allowance pre-check (used by `payment pay` exact+permit2/upto)

- `fetch_permit2_allowance(chainIndex, token, owner)` (rpc.rs:45): `rpc_url_for_chain` else `no RPC endpoint
  configured for chain {ci} — Permit2 allowance pre-check unavailable`; parse token/owner (`invalid token address:
  {t}` / `invalid owner address: {o}`); calldata = `allowance(owner, PERMIT2)` selector `0xdd62ed3e` + two padded
  words; `POST https://rpc.xlayer.tech` (own reqwest client, 10 s) body
  `{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x<lowercase token>","data":"0x…"},"latest"],"id":1}`
  (struct order jsonrpc, method, params, id; inner object sorted `data`,`to`). Errors: `Permit2 allowance RPC POST
  to {url} failed`, `Permit2 allowance RPC returned HTTP {status} from {url}`, `Permit2 allowance RPC returned
  non-JSON body`, `Permit2 allowance RPC error (code {c}): {msg}`, `Permit2 allowance RPC response missing
  \`result\` field`, `Permit2 allowance RPC returned malformed uint256: {hex}`.
- `parse_uint256_hex` (127): strip `0x`; empty → error; > 64 chars → `uint256 hex too long: {n} chars (max 64)`;
  short/odd hex accepted (`0xf4240` = 1 000 000).
- External host: `https://rpc.xlayer.tech` (only via `payment pay`, g09a).

### F. `payment/subscription/types.rs` — period-scheme wire + cache types

- `SubscriptionTermsWire` (camelCase, declaration order): `payer, merchant, facilitator, token,
  amountPerPeriod(str), periodSec(u64), maxPeriods(u32), startAt(u64), initialChargePeriods(u32),
  initialChargeAmount(str), termsDeadline(u64), permitHash(0x32B), salt(0x32B), planId(str, NOT signed),
  planTier(u8), changeFromSubId(0x32B), changeEffectiveAt(u8), periodMode(u8)`.
- `PermitDetailsWire {token, amount(str), expiration(u64), nonce(u64)}`; `PermitSingleWire {details, spender,
  sigDeadline(str)}`; `SubscriptionPayload {terms, termsSignature, permit, permitSignature}`.
- `CancelAuth {action(u8), subId, initiator(u8), nonce, deadline(u64), signature}`;
  `PendingChangeCancelAuth {subId, newSubId, nonce, deadline(u64), signature}`.
- `SubscriptionCacheEntry {subId, resourceHost, merchant, planId, planTier, maxPeriods, state,
  changedToSubId (omitted when None)}`.
- `AllowanceStatus` (deserialize only, all `#[serde(default)]`): `approvedAmount` (flex_string),
  `expiration` (flex_u64), `nonce` (flex_u64), `reservedAmount` (flex_string), `reservedExpiration` (flex_u64),
  `tokenBalance`, `availableAmount`, `permit2Allowance` (flex_string), `subscriptionContract`, `permit2Contract`
  (plain string, default `""`).
- `BuyerSubscriptionItem` (camelCase): `chainIndex` (flex_u64), `subId` (**required string**), `state` (u8,
  default 0), `payer`, `token`, `amountPerPeriod` (flex_string), `periodSec` (flex_u64), `periodMode` (u8),
  `billingAnchorAt` (flex_u64), `maxPeriods` (u32), `startAt` (flex_u64), `initialChargePeriods` (u32),
  `initialChargeAmount` (flex_string), `lastChargedPeriod` (u32), `totalPulled` (flex_string), `planId`,
  `planTier` (u8), `changedToSubId` (Option<String>), `isActive`, `serviceEnded` (bool), `currentPeriod` (u32),
  `nextChargeableAt` (Option<u64>). **Unknown fields are dropped** on re-serialization. Non-flex integer fields must
  be JSON numbers (a string there fails parsing).
- `flex_string`: string → as-is; number → `n.to_string()`; null → `""`; else error `expected string or number, got
  …`. `flex_u64`: number (u64 else `number out of u64 range`), string trimmed (empty → 0, else parse, error `invalid
  u64 string "…": …`), null → 0.

### G. `payment/subscription/eip712.rs` — period-scheme EIP-712

Typestrings (exact bytes; typehash = keccak256 of these):
- `SubscriptionTerms(address payer,address merchant,address facilitator,address token,uint160 amountPerPeriod,uint64
  periodSec,uint32 maxPeriods,uint64 startAt,uint32 initialChargePeriods,uint160 initialChargeAmount,uint64
  termsDeadline,bytes32 permitHash,bytes32 salt,uint8 planTier,bytes32 changeFromSubId,uint8 changeEffectiveAt,uint8
  periodMode)` (single line, no spaces after commas).
- `CancelAuth(uint8 action,bytes32 subId,uint8 initiator,bytes32 nonce,uint64 deadline)`
- `PendingChangeCancelAuth(bytes32 subId,bytes32 newSubId,bytes32 nonce,uint64 deadline)`
- `PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)`
- `PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160
  amount,uint48 expiration,uint48 nonce)`
- Subscription domain `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with
  `name="A2APaySubscription"`, `version="1"`, `verifyingContract` = subscription contract.

Typed-data JSON builders (sent to TEE; objects key-sorted on the wire, arrays in the order shown):
- `build_subscription_terms_typed_data` (eip712.rs:90): `domain {name:"A2APaySubscription", version:"1",
  chainId:<u64>, verifyingContract}`; `types.EIP712Domain = [name:string, version:string, chainId:uint256,
  verifyingContract:address]`; `types.SubscriptionTerms` = the 17 fields in typestring order;
  `primaryType:"SubscriptionTerms"`; `message` = 17 fields: addresses/bytes32/uint160 amounts as **strings**,
  `periodSec, maxPeriods, startAt, initialChargePeriods, termsDeadline, planTier, changeEffectiveAt, periodMode` as
  **JSON numbers**. `planId` excluded.
- `build_permit_single_typed_data(token, amount, expiration, nonce, spender, sigDeadline, permit2Contract, chainId)`
  (154): `domain {name:"Permit2", chainId, verifyingContract: permit2Contract}` (no version);
  `types.EIP712Domain=[name,chainId,verifyingContract]`, `PermitSingle=[details:PermitDetails, spender:address,
  sigDeadline:uint256]`, `PermitDetails=[token:address, amount:uint160, expiration:uint48, nonce:uint48]`;
  `primaryType:"PermitSingle"`; `message {details:{token, amount:"<str>", expiration:<num>, nonce:<num>},
  spender, sigDeadline:"<str>"}`.
- `build_cancel_auth_typed_data(action, subId, initiator, nonce, deadline, domain)` (204): subscription domain;
  `CancelAuth=[action:uint8, subId:bytes32, initiator:uint8, nonce:bytes32, deadline:uint64]`; message `action`,
  `initiator`, `deadline` numbers; `subId`, `nonce` strings.
- `build_pending_change_cancel_auth_typed_data(subId, newSubId, nonce, deadline, domain)` (247):
  `PendingChangeCancelAuth=[subId:bytes32, newSubId:bytes32, nonce:bytes32, deadline:uint64]`.

Local hashes:
- `permit_single_struct_hash(token, amount, expiration, nonce, spender, sigDeadline)` (318):
  `detailsHash = keccak(keccak(PERMIT_DETAILS_TYPESTRING) ‖ word(token) ‖ word(amount dec) ‖ word(expiration) ‖
  word(nonce))`; `permitHash = keccak(keccak(PERMIT_SINGLE_TYPESTRING) ‖ detailsHash ‖ word(spender) ‖
  word(sigDeadline dec))`. **Struct hash, not the full digest.** Address words = 12 zero bytes + 20 bytes; decimal
  uints parsed by `U256::from_str` (errors `invalid address: {s}`, `invalid uint (decimal): {s}`, `invalid
  bytes32: {s}`).
- `subscription_terms_struct_hash(i)` (345): typehash ‖ 17 words in typestring order.
- `terms_digest(i)` (385) = `keccak(0x19 0x01 ‖ subDomainSeparator ‖ termsStructHash)` = **subId**, where
  `subDomainSeparator = keccak(keccak(EIP712Domain(string name,string version,uint256 chainId,address
  verifyingContract)) ‖ keccak("A2APaySubscription") ‖ keccak("1") ‖ word(chainId) ‖ word(verifyingContract))`.
- `access_proof_inner_hash(subId, payer, timestamp)` (406) = `keccak(subId 32B ‖ payer 20B raw ‖ timestamp as
  32-byte big-endian)` (`ACCESS_PROOF_TIMESTAMP_BYTES = 32`). Errors `invalid subId bytes32: {s}`, `invalid payer
  address: {s}`.
- `hex0x(bytes)` = `0x` + lowercase hex.
- Derived vectors (reference implementation; chainId 196, subscription contract
  `0x4020000000000000000000000000000000000003`, token `0x779ded0c…3736`):
  - `permit_single_struct_hash(token,"60000000",1782000000,7,SUB,"1750000000")` =
    `0xc29b4bc80555e586b648fc3f872cf472a149120edbbc92e0b4fc581ebebd24cf`
  - upstream `sample_terms()` (payer `0x…beef`, merchant `0x…cafe`, facilitator `0x…dead`, 5000000/2592000/12/0/1/
    5000000/1750000000, permitHash 0x00…, salt 0x11…11, planTier 2, changeFrom 0x00…, cea 0, periodMode 1):
    structHash `0xcde9728252332eb542256082ef4896bf8cae33eb18a8c015246b7be51f2d8e1c`, subId (terms_digest)
    `0x219121f39e1d0f4051451fd2c55d5a44d7ff03a0b9f73e67e5e18748995d814e`
  - `access_proof_inner_hash(0x11…11, 0x…beef, 1747200000)` =
    `0xf94ad6f188467c9ce8b0511dff676ec6cf26a37757b839d4dbddf64b727a8510`; the EIP-191 hash the session key signs =
    `0x91c3bf061cbdef1e42a2f6f59573da2a05247f99f94a57862d8565ceef8fd66b`.

### H. `payment/subscription/sign.rs` — signing orchestration

Constants: `ZERO_BYTES32 = 0x` + 64×`0`; `DEFAULT_TIMEOUT_SECS = 3600`; `PERMIT_EXPIRATION_BUFFER_SECS = 86400`;
`PERIOD_MODE_CALENDAR_MONTH = 1`.

1. `extract_terms_params(accepted)` (sign.rs:95), checks **in this order**:
   - `extra` missing → `accepts entry missing \`extra\` (subscription params)`
   - `extra.initialCharge` present & non-null → `periodCount` (u64 → u32, default 0), `totalAmount` (string,
     default `"0"`); otherwise `(0, "0")`.
   - `extra.plan` missing → `accepts entry \`extra\` missing \`plan\``; `plan.tier` not u64 → `` `extra.plan.tier`
     missing or not an integer `` (then `as u8`, truncating); `plan.id` string or `""`.
   - `extra.contracts` missing → `` accepts entry `extra` missing `contracts` ``; `contracts.subscription` →
     `` `extra.contracts.subscription` missing or not a string ``; `contracts.permit2` →
     `` `extra.contracts.permit2` missing or not a string ``.
   - `extra.periodSec` not u64 → `` `extra.periodSec` missing or not an integer ``.
   - `periodMode = extra.periodMode as u64 (default 0) as u8`; mode 0 & periodSec 0 → `fixed_seconds mode
     (periodMode=0) requires periodSec > 0`; mode 1 & periodSec ≠ 0 → `calendar_month mode (periodMode=1)
     requires periodSec == 0`; mode > 1 → `invalid periodMode {m} (expected 0 or 1)`.
   - `asset`, `payTo` (top level), `extra.facilitator`, `extra.amountPerPeriod` must be strings → ``missing/invalid
     string field `{key}` in accepts entry``; `extra.maxPeriods` u64 → `` `extra.maxPeriods` missing or not an
     integer `` (as u32); `extra.startAt` u64 default 0; `maxTimeoutSeconds` u64 default 3600.
2. `verify_contracts_against_authority(p, a)` (218) — `addr_eq(offer, authority)` = authority non-empty AND ASCII
   case-insensitive equal. Subscription first:
   ``subscription contract mismatch: offer=`{offer}`, authority=`{authority}` ``, then
   ``permit2 contract mismatch: offer=`{offer}`, authority=`{authority}` ``. No bypass.
3. `sign_double(chainIndex, chainId, payer, accepted, changeFromSubId, changeEffectiveAt)` (239):
   1. `p = extract_terms_params(accepted)`.
   2. `a = allowance_status(payer, p.token, chainIndex)` (§I; HTTP, no cache).
   3. verify contracts (2).
   4. `spender = a.subscriptionContract` (authoritative casing).
   5. `remaining = maxPeriods − initialChargePeriods` (u64; negative → `initialChargePeriods exceeds maxPeriods`).
   6. `newCommit = U256(initialChargeAmount) + U256(amountPerPeriod) × remaining` where `u256(s)` accepts decimal
      or `0x`-hex (error `invalid uint256: {s}`).
   7. `reserved = a.reservedAmount.trim()=="" ? 0 : u256(a.reservedAmount)`; `amount = reserved + newCommit`.
   8. Layer-1 check: if `a.permit2Allowance` non-empty and parses and `< amount` → error
      `Layer-1 Permit2 allowance insufficient on token {p.token} (chain {chainIndex}). ERC20.allowance(buyer,
      Permit2) is {layer1}, but this subscription needs {amount}. Approve once first: IERC20.approve({a.permit2Contract},
      MAX) — e.g. via an on-chain contract call — then retry the subscription.` (numbers in decimal).
   9. `effectiveStart = p.startAt == 0 ? now : p.startAt`.
   10. `newSubEnd`: calendar mode → `addCalendarMonths(effectiveStart, maxPeriods + (cea==2 ? 1 : 0)) + 86400`;
       fixed mode → `effectiveStart + (cea==2 ? periodSec : 0) + maxPeriods×periodSec + 86400` (saturating).
       `add_calendar_months(t, m)` = chrono `checked_add_months` in UTC (day clamped to month end, e.g.
       2023-01-31 + 1 → 2023-02-28 00:00:00), fallback `t + m×31×86400`.
   11. `expiration = max(a.reservedExpiration, newSubEnd)`; `nonce = a.nonce` (verbatim, not +1).
   12. `now2 = now()` (fresh read); `sigDeadline = (now2 + timeout).to_string()`; `termsDeadline = now2 + timeout`.
   13. PermitSingle typed data (`token=p.token`, `amount`, `expiration`, `nonce`, `spender`, `sigDeadline`,
       `verifyingContract = a.permit2Contract`, `chainId`); `permitHash = hex0x(permit_single_struct_hash(...))`;
       `permitSignature = tee_sign_eip712(chainIndex, payer, permitTypedData)` (2 HTTP calls).
   14. `salt = 0x` + 32 random bytes (OsRng) hex.
   15. Terms typed data with `payer, merchant=p.payTo, facilitator, token, amountPerPeriod, periodSec, maxPeriods,
       startAt = p.startAt (raw, 0 allowed), initialChargePeriods, initialChargeAmount, termsDeadline, permitHash,
       salt, planTier, changeFromSubId, changeEffectiveAt, periodMode`, domain `{chainId, verifyingContract:
       spender}`; `termsSignature = tee_sign_eip712(...)` (2 HTTP calls).
   16. `subId = hex0x(terms_digest(termsInput))` (local).
   17. Returns `SignedSubscription {payload: {terms (with planId), termsSignature, permit {details {token, amount,
       expiration, nonce}, spender, sigDeadline}, permitSignature}, sub_id, chain_index, plan_id}`.
4. `sign_subscribe` (436) = `sign_double(..., ZERO_BYTES32, 0)`.
5. `sign_change(chainIndex, chainId, payer, oldSubId, accepted)` (448): `changeFrom = accepted.extra.changeFrom`;
   `fromSubId = oldSubId` if non-empty else `changeFrom.fromSubId` string else error `change requires --sub-id or
   extra.changeFrom.fromSubId`; then `change_effective_at_from(changeFrom)`: None → `change offer missing
   extra.changeFrom` (**required even when --sub-id is given**); `effectiveAt` string: `immediate`→1,
   `period_end`→2, other → `unknown changeFrom.effectiveAt: {v}`; else `direction`: `upgrade`→1, `downgrade`→2,
   other → `unknown changeFrom.direction: {v}`, absent → `changeFrom missing both effectiveAt and direction`.
6. `sign_cancel(chainIndex, chainId, payer, subId, verifyingContract)` (498): `nonce = random bytes32 hex`,
   `deadline = now + 3600`, typed data `CancelAuth(action 0, subId, initiator 0, nonce, deadline)`,
   `tee_sign_eip712`. Returns `CancelAuth`.
7. `sign_cancel_pending_change(...)` (525): same with `PendingChangeCancelAuth(subId, newSubId, nonce, deadline)`.
8. `build_access_proof(chainIndex, payer, subId)` (558): `timestamp = now`; `inner = access_proof_inner_hash`;
   `signature = tee_sign_personal(chainIndex, payer, hex0x(inner))`; header value =
   `base64std(compact JSON {"kind":"subscription-id","payer":..,"signature":..,"subId":..,"timestamp":<num>})`
   (sorted keys); header name `APP-Access`.

### I. `payment/subscription/facilitator.rs` — buyer-direct reads (anonymous, no OK headers)

- `BASE = /api/v6/pay/x402`. `unwrap_first(data)`: non-empty array → first element, else unchanged.
- `allowance_status(buyer, token, chainIndex)` (facilitator.rs:32): `GET
  /api/v6/pay/x402/buyers/{buyer}/allowance-status?token={token}&chainIndex={chainIndex}` via `get_no_okheaders`
  (values inserted raw, not encoded). Error context `allowance-status query failed`; parse
  `parse allowance-status response`.
- `my_subscriptions(buyer, limit, offset)` (51): `limit = clamp(limit, 1, 100)`; `GET
  /api/v6/pay/x402/buyers/{buyer}/subscriptions?limit={limit}&offset={offset}`; context `my-subscriptions query
  failed`. `parse_subscription_list(data)`: array whose first element lacks `subscriptions` → bare item array
  (`parse subscriptions array`); else `unwrap_first` → `{subscriptions:[…]}` (`parse my-subscriptions response`).

### J. `payment/subscription/cache.rs` — `$ONCHAINOS_HOME/subscriptions.json`

- File: pretty JSON (2-space) of `{"by_host": {"<host>": SubscriptionCacheEntry, …}}` — `by_host` is a Rust
  `HashMap` ⇒ **host key order is nondeterministic**. Write = `ensure_onchainos_home` (0700) → `subscriptions.json.tmp`
  → rename (no chmod). Load: missing/corrupt → empty cache. `delete()` on `wallet logout` (auth/mod.rs:1211).
- `host_of(url)`: strip `scheme://`, cut at first `/`, `?`, `#`, drop `userinfo@` (last `@`), ASCII lowercase
  (`http://user:pass@host.io:8443/x` → `host.io:8443`).
- `put(entry)` keyed by `entry.resourceHost`; `resolve(url)` → entry for `host_of(url)` only if `state=="active"`.
- `mark_changed(old, new)`: every entry with `subId==old` → `state:"changed"`, `changedToSubId:new.subId`; then
  `put(new)`.
- `reconcile_from(items)`: for each cached entry whose `subId` is in the listing: `state = label(item.state)`
  (`0 pending, 1 active, 2 completed, 3 canceled, 4 changed, else inactive`), copy `planTier, maxPeriods,
  changedToSubId, planId`; if `item.state==4` and its `changedToSubId` is also in the listing → replace
  `subId/state/planTier/maxPeriods/planId/changedToSubId` with the successor's (one hop). Entries not listed are
  untouched; listing items not cached are **not** added.

### K. `commands/payment/a2a_pay.rs` library functions

1. `validate_positive_decimal_amount(s)` (a2a_pay.rs:945): split at first `.`; both parts empty → `amount must not be
   empty`; any non-ASCII-digit in either part → `amount must be a non-negative decimal number, got: {s}`; all zeros →
   `amount must be greater than zero`. Accepts `50`, `0.01`, `.5`, `1.`; rejects ``, `.`, `0`, `0.0`, `-1`, `+1`,
   `1e2`, `1.2.3`, ` 1`, `abc`.
2. `is_valid_evm_address(a)` = starts with `0x`, length 42, rest hex; `require_evm_address(a, label)` → `--{label}
   is not a valid EVM address: {a}`.
3. `parse_bytes32_hex(s, label)`: strip optional `0x`, len ≠ 64 → `{label} must be 32 bytes (64 hex chars), got
   {n}`; bad hex → `{label} is not valid hex`.
4. `resolve_buyer_wallet(chainId)` (820): `get_chain_by_real_chain_index(chainId)` else `chain (chainId={id}) not
   found in chain registry`; `chainIndex` string or u64; `chainName`; wallets (`not logged in`); `resolve_address(
   wallets, None, chainName)` → `(chainIndex, address)` (selected account; no `--from`).
5. `tee_sign_eip3009(client, token, chainIndex, from, to, value, validAfter, validBefore, nonceHex,
   verifyingContract, signType?, msgType?)` (725):
   - session (`not logged in`), keyring `session_key` (`not logged in`).
   - `base = {chainIndex, from, to, value, validAfter:"<dec>", validBefore:"<dec>", nonce, verifyingContract}` +
     `signType` if given.
   - `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` body = base + `msgType` if given. Wire (charge
     pay): `{"chainIndex","from","msgType":"eip3009Auth","nonce","to","validAfter","validBefore","value",
     "verifyingContract"}`. Response `data[0].msgHash`, `data[0].domainHash` (errors `a2a-pay: gen-msg-hash failed:
     …`, `missing 'msgHash' in gen-msg-hash response`, `missing 'domainHash' in gen-msg-hash response`).
   - `sessionSignature = base64std(Ed25519(seed, hexdecode(msgHash)))` (`invalid msgHash hex`).
   - `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` body = base + `domainHash` + `sessionCert` +
     `sessionSignature` (no `msgType`). Wire (charge): `{"chainIndex","domainHash","from","nonce","sessionCert",
     "sessionSignature","to","validAfter","validBefore","value","verifyingContract"}`; escrow adds
     `"signType":"eip3009ReceiveAuth"` to both bodies and `"msgType":"eip3009ReceiveAuth"` to gen-msg-hash.
     Response `data[0].signature` (`a2a-pay: sign-msg failed: …`, `missing 'signature' in sign-msg response`).
6. Funding scene for `insufficient_balance` — `build_a2a_insufficient_balance_scene(chainIndex, currency, amount)`
   (534): `query_token_readable` → Ok(Some) `(balance, decimals, symbol)`, Ok(None) `("0", None, None)`, Err
   `(None, None, None)`; if decimals or symbol missing → `query_token_metadata` (fill missing only); `required =
   minimal_to_readable(amount, decimals)` (None decimals or error → return None); `asset = symbol ?? currency`;
   `build_funding_bundle(chainIndex, {asset, token_address: currency, required, balance, operation:"a2a_payment"})`
   → Value or None on error. Result (sorted keys):
   ```
   {"decision":"blocked","nextAction":[],
    "payload":{"fundingNeed":{"asset":..,"balance":"<str>"|null,"required":..,"shortfall":..(only if computable),
                              "tokenAddress":<currency>},
               "fundingTarget":{"accountName":..,"chainIndex":..,"chainName":"X Layer",..,"gasFree":bool,
                                "receiveAddress":..,"sameNetworkRequired":true},
               "operation":"a2a_payment","qr":{…qr.rs QrOutput camelCase…}},
    "phase":"funding_required","reason":"insufficient_balance"}
   ```
   (oracle: required `10`, balance `0.08504764` → shortfall `9.91495236`).
7. `compute_escrow_nonce(fields)` (234) = `keccak256(abi.encode(from, provider, receiver, arbitrator, currency,
   uint256 amount, uint64 submitWindow, uint64 disputeWindow, uint64 arbitrationWindow, uint64 terminationWindow,
   hook, bytes32 keccak256(hookData), bytes32 salt, uint256 chainId, escrowAddress))` — 15 static 32-byte words.
   Derived vector for the upstream test fixture (from 0x66…, provider 0x11…, receiver 0x22…, arbitrator 0x33…,
   currency 0x44…, amount 50000000, windows 86400/86400/172800/86400, hook 0x55…, hookData `deadbeef`, salt
   `0x…07`, chainId 196, escrow 0x77…) = `0x399f15b551085a8865b6678094cedac4decad70073a931b153721b25e9f87165`.
8. `sign_escrow(SignEscrowParams)` (636) — library only (callers: `agent_commerce/task/user/accept.rs:403`,
   `agent_commerce/task/user/v2/create_and_fund.rs:226`; not a CLI command of this partition): validates provider,
   receiver, arbitrator, currency, escrow_contract, hook as EVM addresses (labels exactly those); `WalletApiClient`,
   tokens, `resolve_buyer_wallet(chainId)`; `validBefore = RFC3339(expired_at)` seconds (`expired_at '{s}' is not
   RFC 3339`, `expired_at predates unix epoch`); `amount` u128 (`amount must be a non-negative integer in minimal
   units`); hook_data hex (`hook_data is not valid hex`); salt bytes32; nonce = escrow nonce; `tee_sign_eip3009(...,
   to = escrow_contract, value = amount, validAfter 0, validBefore, nonce, verifyingContract = currency,
   signType/msgType "eip3009ReceiveAuth")`. Returns `{type:"transaction", signature, authorization:{type:
   "ReceiveWithAuthorization", from, to, value, validAfter:"0", validBefore:"<dec>", nonce}}`.
9. `is_terminal_status(s)` = `completed|failed|expired|cancelled`. `status(paymentId)` / `fetch_status(paymentId,
   wait)` — see command `a2a-pay status`. `fetch_status` is also the MCP tool `payment_a2a_status`
   (`{payment_id, wait=false}`).

### L. `commands/payment/quote.rs` internals

1. `parse_params(param)` (quote.rs:365): each `k=v` split at first `=`; no `=` → `invalid_input: --param must be
   key=value, got '{raw}'`; key trimmed, empty → `invalid_input: --param key must not be empty`; value kept verbatim
   (not trimmed); inserted into a sorted map (later duplicates overwrite).
2. `probe_endpoint(url, knownParams, method)` (403): new reqwest client, **10 s timeout**, no OKX headers;
   params = all string values; `http_carrier::build_request(client, method, url, params, [])` (GET → query string,
   form-encoded, appended to the URL's own query; POST/PUT/PATCH/DELETE → compact JSON body of string values).
   Transport error → `endpoint_unreachable: {reqwest error}`. Challenge header = response `PAYMENT-REQUIRED` else
   `WWW-Authenticate`. Classification (in order): 402 → Challenge(header or, if absent, the body text); else
   `probe_signals_mcp(contentType, body)` → MaybeMcp; else 2xx → NoCharge(body); else error: 401/403 →
   `auth_required`, 5xx → `endpoint_server_error`, other → `endpoint_unreachable`; message `{token}: unexpected
   HTTP {code} (expected 402 or 200)`, or for 405: `{token}: endpoint returned HTTP 405 to the {method} probe — if
   this is an A2MCP endpoint, retry with --tool <name> (MCP transport) or --method POST (REST)`.
3. MCP transport (`mcp_client.rs`, owned by quote path): `url_looks_like_mcp(url)` = lowercase, strip scheme,
   cut `?#`, strip trailing `/`, ends with `/mcp` or `/sse`. `probe_signals_mcp(ct, body)` = ct contains
   `text/event-stream` OR trimmed body starts with `{`/`data:` and contains `"jsonrpc"`. `McpClient::new(url)`
   (30 s timeout). Each RPC: `POST <url>` headers `Content-Type: application/json`, `Accept: application/json,
   text/event-stream`, `Mcp-Session-Id` if captured; body compact sorted JSON `{"id":N,"jsonrpc":"2.0","method":..,
   "params":..}`. Sequence: `initialize` id 1 params `{"capabilities":{},"clientInfo":{"name":"onchainos",
   "version":"4.6.3"},"protocolVersion":"2025-06-18"}`; capture `Mcp-Session-Id`; non-2xx →
   `endpoint_unreachable: initialize returned HTTP {s}[: {≤500 chars body}[…]]`; body parsed as JSON or first SSE
   `data:` line with `result`/`error` (`endpoint_unreachable: no JSON-RPC result/error in MCP response`); JSON-RPC
   error → `endpoint_unreachable: JSON-RPC error {code}: {message}`. Then notification
   `{"jsonrpc":"2.0","method":"notifications/initialized"}` (no id/params; errors ignored). `tools/list` id 2 params
   `{}` → `result.tools[]` (entries that fail to parse are skipped; missing name → `""`). `tools/call` id 3 params
   `{"arguments":{…},"name":"<tool>"}`: 402 → Paid(header `PAYMENT-REQUIRED`|`WWW-Authenticate`|body, body);
   other non-2xx → `endpoint_unreachable: tools/call returned HTTP …`; 2xx → Free(result).
   `coerce_arguments(params, inputSchema)`: per key, `inputSchema.properties[k].type`: `integer|number` → JSON
   number if parseable, `boolean` → `true`/`false` literal only, `object|array` → parsed JSON, else string.
4. `DecimalResolver` (595): `ApiClient::new().ok()`; per `(chainId = network without "eip155:", asset)` (asset
   non-empty) at most one `POST /api/v6/dex/market/token/basic-info` body
   `[{"chainIndex":"<chainId>","tokenContractAddress":"<asset>"}]` (memoized, including failures). `decimal`
   (string → u32) else numeric `decimals`; symbol = `symbol` else `tokenSymbol` (non-empty). `resolve(entry)`:
   declared `extra.decimals` then top-level `decimals` (u64 or numeric string) — **no lookup when declared** —
   else lookup decimals, else `6`.
5. `build_accepts(accepts)` → `AcceptEntry {index, scheme (or ""), amount (extract_amount or ""), asset (or ""),
   network (or "")}` for every entry.
6. `build_decoded_challenge(accepts, resolver)` (648): best = `select_accept_with_preference(accepts, None)`;
   `amount = extract_amount(best)` or `""`; `decimals = resolver.resolve(best)`; `recipient = best.payTo` or `""`;
   `expires` = first entry whose `expires` is a JSON u64 (strings ignored), else 0; `supported` = any entry scheme ∈
   `{exact, aggr_deferred, charge, upto, period}`; `unsupported_reason` = null or `"no supported payment scheme in
   accepts[]"`; `amountHuman = human_amount(amount, decimals)`.
7. `build_candidates` (689): for each accepts entry in index order: `chainId = network` without `eip155:`;
   `chainName = chain_display_name(chainId)`; `isMainnet = chains::is_mainnet_chain(chainId)`; `tokenSymbol =
   basic-info symbol` → `extra.name` → asset address; `decimals = resolver.resolve(entry)`;
   `Candidate {scheme, acceptsIndex, chainId, chainName, isMainnet, tokenSymbol, amount, amountHuman, decimals,
   hasBalance:false, balanceStatus:"unavailable", availableAmount:"", requiredAmount: amountHuman, shortfall:"",
   depositAddress:"", recommended:null}`. Lookup order per entry: `resolve_symbol` (lookup if asset present and not
   memoized) then `resolve` (no second lookup).
8. `rank_candidates(cands)` (payment_flow.rs:1345): stable sort with key: `balanceStatus=="sufficient"` first, then
   comparator: same `tokenSymbol` → smaller `amount` (u128, unparsable = max) first; then mainnet before testnet;
   then scheme rank `aggr_deferred 0, exact 1, upto 2, charge 3, other 4`. `multi` = number of distinct schemes among
   `{exact, aggr_deferred, charge}` ≥ 2. Not multi → `candidates=[best]` with `recommended = true` iff
   sufficient else `null`; all others → `alternatives` with `recommended:false`. Multi & no sufficient → all in
   `candidates` with `recommended:null`, `alternatives=[]`. Multi & some sufficient → winner `true`, rest `false` in
   `alternatives`.
9. `preflight_balances(cands, accepts)` (760): wallets missing / selected id empty / selected account absent →
   `walletError:"login_required"` (no HTTP); `ApiClient::new()` failure → `"balance_unavailable"`. For each distinct
   `chainId` (ascending string order): address = selected account's `address_list` entry with `chain_index ==
   chainId` (none → error flag, candidates stay unavailable, `depositAddress` stays `""`); set `depositAddress` for
   all candidates of that chain; `GET /api/v6/dex/balance/all-token-balances-by-address?address=<addr>&chains=
   <resolve_chains(chainId)>` (ApiClient; failure → flag). Per candidate: `candidate_balance_atomic(balances,
   tokenSymbol, asset, decimals)`:
   - `byAddress` = asset non-empty AND any object anywhere in the response has `tokenContractAddress` |
     `tokenAddress` | `contractAddress`;
   - find first object (depth-first; arrays in order, object values in sorted-key order, object itself tested
     before its children) matching address (case-insensitive) or, if not byAddress, `symbol` (case-insensitive);
   - none → balance 0; found → `rawBalance` | `balanceRawAmount` (decimal string) else `balance` via
     `human_to_atomic(balance, decimals)` (rejects `-`, `e/E`, non-digits, fraction longer than decimals) else
     None → `balanceStatus:"unavailable"` + flag.
   With available `A`: `required = U256(amount)` (parse failure → unavailable + flag); `hasBalance = A > 0`;
   `availableAmount = human_amount(A)`; `requiredAmount = amountHuman`; `A ≥ required` → `sufficient`, shortfall
   `"0"`; else `insufficient`, `shortfall = human_amount(required − A)`. Any flag → `walletError:
   "balance_unavailable"`, else none.
10. `human_amount(atomic, d)` (1198): keep ASCII digits only (none → `"0"`); d = 0 → strip leading zeros (`"0"` if
    empty); else left-pad to d+1 digits, split, int part leading zeros stripped (`"0"`), fraction trailing zeros
    stripped; `int` or `int.frac`. (`10000,6`→`0.01`; `1000000,6`→`1`; `1234567,6`→`1.234567`; `500,0`→`500`.)
11. `find_output_schema(decoded, body)`: `decoded.outputSchema` (non-null) else `JSON(body).outputSchema`
    (non-null). `parse_param_plan(schema.input)`: object form → `ParamSpec` per key (sorted key order); array form
    → items with string `name`; `carrier` `body|header|path` (case-insensitive) else query; `required` bool
    default false; `type` string default `""`. Paid method = `schema.method` string else the probe method as typed
    by the user (not uppercased).
12. `missing_params(body, known, plan)`: required plan params not in known (plan order), then
    `JSON(body).missingParams` (else `.required`) string entries not in known; de-duplicated.
13. `new_payment_id(url, createdAt)` (1183): `"pay_" + hex(sha256(url bytes ‖ createdAt u64 LE ‖ nanosSinceEpoch
    i64 LE)[0..12])` — 24 hex chars; nondeterministic.
14. `build_summary(candidates, _, challenge)`: pick = `recommended==true` else first candidate: `"{verb}
    {amountHuman} {tokenSymbol} ({scheme}, {chainName})"` with verb `Will pay up to` when scheme is `upto`
    (case-insensitive) else `Will pay`; no candidates → `Will pay {challenge.amountHuman}`.
15. `free_challenge()` = `{amount:"0", amountHuman:"0", decimals:0, recipient:"", expires:0, supported:true,
    unsupported_reason:null}`.
16. `prepare_a2mcp_candidates(accepts)` (850) = build_accepts + build_candidates + preflight_balances (no ranking,
    no state file) → `(candidates, walletError)`; `refresh_a2mcp_candidate_balances(cands, accepts)` (863) =
    preflight only.

### M. `commands/payment/a2mcp.rs` — OKX.AI A2MCP prepared payment + intent state (library)

Callers (not in this partition): `agent a2mcp-probe {probe,confirm-free,refresh-balance,funding,
resume-after-funding,prepare-payment}` (`commands/agent_commerce/a2mcp_probe/flow.rs`) and `payment pay
--payment-id` (`payment_flow::fetch_pay`, g09a).

Constants: `A2MCP_INTENT_VERSION = 1`; `A2MCP_SOURCE = "okx_ai_a2mcp"`; prepared source
`"okx_ai_a2mcp_prepared"`; prepared id prefix `"a2prep_"`. Error prefixes: `a2mcp_payment_confirmation_required`,
`a2mcp_insufficient_balance`, `a2mcp_payment_intent_already_created`, `a2mcp_payment_already_executed`,
`a2mcp_payment_intent_expired`, `a2mcp_invalid_payment_intent`, `a2mcp_invalid_typed_params`,
`a2mcp_payment_overrides_forbidden`, `a2mcp_prepared_expired_or_missing`; also `a2mcp_unsupported_payment_asset`,
`a2mcp_funding_not_required`, `wallet_login_required`.

1. `A2mcpFrozenRequestV1::new(endpoint, method, typedParams, paramPlan, resource)` (a2mcp.rs:52): blank endpoint
   or method → `a2mcp_invalid_typed_params: endpoint and method are required`; method = trim+uppercase ∈
   {GET, POST} else `…: A2MCP request method must be GET or POST`; `Url::parse(endpoint)` else `…: invalid Endpoint
   URL: {err}`; scheme must be `https` (`…: Endpoint must use HTTPS`); header-carrier param names (case-insensitive)
   `payment-signature, payment-required, www-authenticate, authorization, proxy-authorization, host,
   content-length, transfer-encoding, connection` → `…: reserved header parameter '{name}'`; a planned non-body param
   present in typedParams whose value is array/object → `…: non-body parameter '{name}' must be scalar`.
   Serialized camelCase: `endpoint, method, typedParams, paramPlan, resource?`.
2. `classify_authorization(raw)` (1215): scheme lowercase + `extra.assetTransferMethod` lowercase (default ""):
   `exact` + `""|eip3009|eip-3009` → `eip3009`; `exact|upto` + `permit2` → `permit2`; `aggr_deferred` +
   `""|session` → `session`; else None. `scheme_priority`: exact/eip3009 0, exact/permit2 1, upto/permit2 2,
   aggr_deferred/session 3, else 255.
3. `A2mcpSelectedAcceptV1::try_from_prepared_candidate(c)` (266): symbol uppercase ∈ {USDT, USDC, USDG} else
   `a2mcp_invalid_payment_intent: unsupported payment asset`; raw `scheme` non-empty string (`…: missing scheme`);
   `classify_authorization(raw)` must exist (`…: unsupported scheme/authorization`) and equal
   lowercase(c.authorizationType) (`…: authorization disagrees with raw entry`); combo must be one of the 4 above;
   raw `network`, `asset` non-empty (`…: missing {key}`); `extract_amount(raw)` non-empty (`…: missing amount`);
   `payTo` non-empty. Fields `raw, network, asset, symbol, decimals, scheme, authorizationType, amount, payTo,
   balanceStatus` (camelCase, declaration order in files).
4. `brand_candidates(prepared, rawAccepts)` (1163): per quote candidate, `raw = rawAccepts[acceptsIndex]` (out of
   range → `…: candidate index out of range`); skip if `classify_authorization` None; `candidateId =
   "candidate_{acceptsIndex}"`; `symbol` uppercase; skip unless USDT/USDC/USDG; key `(network, asset lowercase)`;
   keep the lower `scheme_priority` (ties keep the earlier). Result ordered by key (BTreeMap).
5. `prepare_a2mcp_payment_from_challenge({challenge, frozenRequest, confirmationContext})` (1021):
   `decode_payment_blob`; `accepts` array else `a2mcp_unsupported_payment_asset: challenge has no accepts`;
   `prepare_a2mcp_candidates` (HTTP: basic-info, balances — §L); brand; empty → `a2mcp_unsupported_payment_asset: no
   supported token/scheme candidate`; `frozenRequest.resource = decoded.resource` (caller value discarded);
   `candidateExpiry = min(raw.expires | raw.validBefore as u64 or numeric string)` over candidates (0 if none);
   `challengeExpiry` = decoded `expires`: absent/null → 0, u64 / numeric string / RFC3339 → seconds, else
   `a2mcp_invalid_payment_intent: invalid challenge expiry`; `challengeExpiresAt` = the non-zero one or the min.
6. `compute_expires_at(challengeExp, createdAt)` (566): `challengeExp != 0 && ≤ createdAt` →
   `a2mcp_payment_intent_expired: challenge expired`; `local = createdAt + 300`; result `challengeExp==0 ? local :
   min(challengeExp, local)`.
7. Prepared-state file `$HOME/payments/a2prep_<uuidv4 simple, 32 hex>.json` (atomic_write, 0600; payments dir
   0700), pretty JSON, declaration order:
   `{"version":1,"source":"okx_ai_a2mcp_prepared","preparedId","ownerAccountId","createdAt","expiresAt",
   "prepared":{"version":1,"source":"okx_ai_a2mcp","frozenRequest":{…},"confirmationContext":{"serviceId",
   "serviceName"?, "providerAgentId"?, "aspAmount"?, "aspSymbol"?},"candidates":[{"candidateId","rawAccept",
   "symbol","network","chainId","chainName","isMainnet","scheme","amountAtomic","amountDisplay","decimals",
   "authorizationType","balanceStatus","availableAmount","requiredAmount","shortfall","depositAddress"}],
   "challengeExpiresAt","walletError"?,"fundingCandidateId"?}}`.
   - `store_a2mcp_prepared_payment(prepared, owner, createdAt)`: owner empty → `wallet_login_required: no selected
     wallet`; validate; `expiresAt = compute_expires_at(prepared.challengeExpiresAt, createdAt)`.
   - `validate_prepared_id`: `a2prep_` + exactly 32 hex chars, else `a2mcp_prepared_expired_or_missing: {id}`.
   - Read/validate: io/parse error, version/source/id mismatch, `now ≥ expiresAt` →
     `a2mcp_prepared_expired_or_missing: {id}` (file deleted when the error has that prefix); owner mismatch →
     `cross_user_payment_id: {id}` (file kept); then `prepared.validate()` (version/source, frozen request
     re-validated and must be identical, ≥1 candidate, fundingCandidateId must exist, each candidate id non-empty,
     balanceStatus ∈ sufficient|insufficient|unavailable, selected fields must agree with raw).
   - `claim_a2mcp_prepared_payment`: validate in place, then rename to `.{preparedId}.claim-{uuid simple}` in the
     same dir (rename failure → `a2mcp_prepared_expired_or_missing: {id}`), re-read claim; dropping an uncommitted
     claim renames it back; `commit()` deletes the claim; `replace(prepared)` writes a **new** `a2prep_…` file with
     the original `createdAt/expiresAt` and deletes the claim. `consume_…` = claim + commit.
     `replace_a2mcp_prepared_payment(id, prepared, owner, now)` = validate + claim + replace.
   - `mark_funding_continuation(candidateId)`: unknown → `a2mcp_invalid_payment_intent: unknown candidate`;
     sufficient → `a2mcp_funding_not_required: selected candidate is sufficient`.
   - `refresh_a2mcp_prepared_payment(prepared)`: re-runs balance preflight only (candidates re-indexed by position,
     raw accepts = candidates' raw), copies `balanceStatus, availableAmount, requiredAmount, shortfall,
     depositAddress`, replaces `walletError`, keeps metadata; count mismatch → `…: candidate set changed during
     balance refresh`.
8. Intent file `$HOME/payments/{paymentId}.json` (atomic_write 0600), `paymentId = "pay_" + first 24 hex of
   sha256("okx_ai_a2mcp" ‖ 0x00 ‖ probeId ‖ 0x00 ‖ ownerAccountId)` (derived vector: probe `probe_1`, owner
   `account_1` → `pay_645ff957de035f18b7bb9351`). Pretty JSON, declaration order: `{"version":1,
   "source":"okx_ai_a2mcp","paymentId","probeId","ownerAccountId","payerAddress","frozenRequest",
   "selectedAccept","execution":{"state":"prepared","signatureAttempts":0},"createdAt","expiresAt"}`.
   - `create_a2mcp_payment_intent(input)`: `!userConfirmed` → `a2mcp_payment_confirmation_required: explicit
     confirmation is required`; `selectedAccept.balanceStatus != "sufficient"` → `a2mcp_insufficient_balance:
     selected token balance is not sufficient`; `compute_expires_at(input.expiresAt, createdAt)`; file exists →
     `a2mcp_payment_intent_already_created: {probeId}`; validate + write.
   - Every write re-validates: version/source (`…: unsupported source or version`), non-empty ids (`…: missing
     identity field`), `createdAt < expiresAt` and attempts ≤ 3 (`…: invalid lifetime or signature attempts`),
     frozen request identical when rebuilt (`…: frozen request is inconsistent`), selected accept identical when
     rebuilt from raw (`…: selected accept fields disagree with raw entry`).
   - State machine (`execution.state` snake_case): `prepared → signing` (`begin_signing`: now ≥ expiresAt → write
     `expired` + `a2mcp_payment_intent_expired: {id}`; not prepared → `a2mcp_payment_already_executed: {id}`);
     `record_signature_attempt` (must be signing and attempts < 3, else `…already_executed: invalid signature
     attempt state`); `signing → proof_generated`; `proof_generated → replaying`; terminal `success |
     pending_terminal | failed_terminal` only from signing/proof_generated/replaying.
   - `inspect_payment_source(id)`: `validate_payment_id` (non-empty, ≤128, `[A-Za-z0-9_-]`, else
     `a2mcp_invalid_payment_intent: invalid payment id`); read + JSON parse failure → `quote_expired_or_missing:
     {id}: <io/serde error>`; no `source` → generic quote; `okx_ai_a2mcp` → A2MCP; other →
     `a2mcp_invalid_payment_intent: unknown payment source`.
   - `read_a2mcp_payment_intent(id, owner, now)`: not A2MCP → `…: payment state is not an A2MCP intent`; parse →
     `…: malformed intent`; validate; owner mismatch → `cross_user_payment_id: {id}`; `now ≥ expiresAt` → write
     `expired`, `a2mcp_payment_intent_expired: {id}`.

---

## Commands

### `onchainos payment quote <URL>`  (hidden: no)

- Handler: `quote::run` (quote.rs:76) → `fetch_quote` (quote.rs:89); dispatched from dispatcher.rs:309. Same data
  path is the MCP tool `payment_quote` (mcp/mod.rs:1033; params `url`, `param[]`, `method` default `GET`; no
  `tool` → the MCP-transport branch is only entered via URL heuristics / probe signal).
- Options: `<URL>` positional String (required); `--param <PARAM>` repeatable (Vec<String>, `k=v`); `--method
  <METHOD>` String default `GET` (free text; any value); `--tool <TOOL>` optional String (forces MCP); global
  `--chain` accepted/ignored. No env fallbacks.
- Auth: jwt-optional (no login needed; with a logged-in wallet the balance preflight runs; `ApiClient` sends JWT if
  a keyring access token exists).
- Steps:
  1. `known = parse_params(--param)` (§L.1) — errors before any network.
  2. If `--tool` given OR `url_looks_like_mcp(url)` → MCP branch (step 6).
  3. REST probe (§L.2): `<METHOD> <URL>` with known params (GET: `?k=v&…` sorted by key; body methods: JSON body).
  4. Outcome NoCharge (any 2xx without MCP signal) → return free quote (no state, no further HTTP):
     `needsConfirm:false`, `summary:"Endpoint returned 200 — no payment required"`, `nextStep:""`, `accepts:[]`,
     `knownParams: known`, `merchantBody: <response body>`, `missingParams:[]`, `paramPlan:[]`, `candidates:[]`,
     `alternatives:[]`, `decodedChallenge: free_challenge()`; `paymentId`, `walletError`, `mcpTools`, `result`
     omitted.
  5. Outcome MaybeMcp → MCP branch (step 6) (the probe response is discarded). Outcome Challenge → step 7 with
     `method = --method`, `mcpTool = None`.
  6. MCP branch: `initialize` → `notifications/initialized` → `tools/list` (§L.3).
     - No `--tool` (discovery): `summary = "MCP server exposes {n} tool(s): {name1, name2}"`, `nextStep =
       "onchainos payment quote {url} --tool <name> [--param k=v] — pick a tool to trigger its 402"`,
       `needsConfirm:false`, `mcpTools = tools` (each `{description?, inputSchema?, name}`), `knownParams = known`,
       `merchantBody:""`, empties as in step 4, `decodedChallenge = free_challenge()`.
     - `--tool name` not in catalog → error `invalid_input: tool '{name}' not found; available tools: [{a, b}]`.
     - `args = coerce_arguments(known, tool.inputSchema)`; `tools/call` id 3. Free → `summary = "MCP tool '{name}'
       returned a result — no payment required"`, `result = <tool result>`, `knownParams = known` (uncoerced),
       `needsConfirm:false`. Paid → step 7 with `known = args` (coerced), `method = "POST"`, `mcpTool = name`,
       `merchantBody = tools/call HTTP body`.
  7. Challenge pipeline (`build_quote_from_challenge`, quote.rs:248):
     1. `decoded = decode_payment_blob(header)` else `unsupported: could not decode 402 challenge: {err}`;
        `decoded.accepts` array else `unsupported: 402 challenge has no accepts[] array` (this is what an MPP
        `Payment …` WWW-Authenticate challenge yields); empty → `unsupported: 402 challenge accepts[] is empty`.
     2. `accepts = build_accepts` (§L.5); resolver; `decodedChallenge` (§L.6); not supported →
        `unsupported: no supported payment scheme in accepts[]`.
     3. `outputSchema` / `paramPlan` / paid method (§L.11).
     4. `candidates = build_candidates` (§L.7, basic-info POSTs); `walletError = preflight_balances` (§L.9, DEX
        balance GETs); `(candidates, alternatives) = rank_candidates` (§L.8).
     5. `createdAt = now (UTC secs)`; `owner = current_owner_id() ?? ""`; `paymentId = new_payment_id(url,
        createdAt)` (§L.13); `expiresAt = state::compute_expires_at(decodedChallenge.expires, createdAt)` (min with
        +300 s); `missingParams` (§L.12).
     6. Write `$ONCHAINOS_HOME/payments/{paymentId}.json` (`PaymentState`, schema in g09a "state.rs"; fields:
        `candidates = candidates ++ alternatives`, `known_params`, `merchant_body`, `endpoint_url = url`,
        `raw_accepts = accepts verbatim`, `resource = decoded.resource` (omitted only when the key is absent; a
        JSON null is written as `null`), `method = paid method`, `param_plan`, `mcpTool`). Plain `fs::write` of
        `{id}.json.tmp` + rename (no chmod).
     7. `summary = build_summary` (§L.14); `nextStep = "onchainos payment pay --payment-id {paymentId}
        --selected-index <n> --yes"`; `needsConfirm:true`.
- Output (`data`, keys sorted; optional keys omitted as noted):
  ```
  {"accepts":[{"amount","asset","index","network","scheme"}],
   "alternatives":[Candidate],
   "candidates":[Candidate],
   "decodedChallenge":{"amount","amountHuman","decimals","expires","recipient","supported","unsupported_reason"},
   "knownParams":{…},
   "mcpTools":[…]            // only when non-empty (discovery)
   "merchantBody":"<raw body>",
   "missingParams":[…],
   "needsConfirm":bool,
   "nextStep":"…",
   "paramPlan":[{"carrier":"query|body|header|path","name","required","type"?}],
   "paymentId":"pay_…",      // only when non-empty (paid challenge)
   "result":…,               // only for a free MCP tool
   "summary":"…",
   "walletError":"login_required"|"balance_unavailable"   // only when Some
  }
  Candidate (sorted): {"acceptsIndex","amount","amountHuman","availableAmount","balanceStatus","chainId",
   "chainName","decimals","depositAddress","hasBalance","isMainnet","recommended":true|false|null,
   "requiredAmount","scheme","shortfall","tokenSymbol"}
  ```
  Passthrough: `merchantBody`, `knownParams` values, `result`, `mcpTools[].inputSchema`; derived: everything else.
  Envelope may include `notifications` (ApiClient auto-pay events).
- Errors (exit 1, `{"ok":false,"error":…}`): all messages above; `walletError` and zero balances are **not**
  errors (exit 0). clap usage errors exit 2.
- Side effects: read-only on OKX; probes an arbitrary merchant URL (GET by default; POST if `--method POST` or MCP);
  writes `$ONCHAINOS_HOME/payments/{paymentId}.json` only for paid challenges (`state_path` also creates the
  `payments/` dir). `is_mainnet_chain` only reads `chain_cache.json` (never fetches).
- Nondeterminism: `paymentId`, state file `created_at/expires_at`, balances, merchant body; MCP session id.
- Parity test cases:
  1. `onchainos payment quote https://example.com/x --param noequals` → `invalid_input: --param must be key=value,
     got 'noequals'`, no HTTP. SAFE.
  2. Local mock `http://127.0.0.1:18402/free` returning 200 `{"ok":1}` → free quote, `merchantBody:"{\"ok\":1}"`.
     SAFE.
  3. Local mock `/paid` returning 402 + `PAYMENT-REQUIRED: base64({"x402Version":2,"resource":{"url":…},
     "accepts":[{"scheme":"exact","network":"eip155:196","amount":"10000","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736",
     "payTo":"0x…","maxTimeoutSeconds":300,"extra":{"name":"USD₮0","version":"1","decimals":6}}]})`, logged out →
     `walletError:"login_required"`, `summary:"Will pay 0.01 USDT (exact, X Layer)"` (symbol from basic-info),
     paymentId present, basic-info POST observed. SAFE (local write only).
  4. `onchainos payment quote http://127.0.0.1:18402/mcp` against a mock MCP server → discovery output. SAFE.
  5. Mock returning 405 to GET → `endpoint_unreachable: endpoint returned HTTP 405 to the GET probe — …`. SAFE.

### `onchainos payment a2a-pay create`  (hidden: no)

- Handler: `a2a_pay::execute` (a2a_pay.rs:101) → `ChargeParams::try_from` (151) → `create_payment_charge` (178).
- Options: `--type <TYPE>` String required (only `charge` accepted); `--amount <AMOUNT>` String required (decimal
  token units); `--symbol <SYMBOL>` String required; `--recipient <RECIPIENT>` Option (required for charge at
  runtime); `--description <DESCRIPTION>` Option; `--realm <REALM>` Option; `--external-id <EXTERNAL_ID>` Option;
  `--expires-in <EXPIRES_IN>` Option<u64> (clap parse error on non-integer → exit 2; the "Default 1800" in help is
  informational — the field is omitted when not given); global `--chain` ignored.
- Auth: jwt-required.
- Steps:
  1. `--type` ≠ `charge` → `unknown --type '{t}', expected 'charge'`.
  2. `--recipient` absent → `--recipient is required for --type charge`.
  3. `validate_positive_decimal_amount(amount)` (§K.1); `require_evm_address(recipient, "recipient")` →
     `--recipient is not a valid EVM address: {addr}`.
  4. `WalletApiClient::new()`; `ensure_tokens_refreshed()` (may POST auth/refresh).
  5. `POST /api/v6/pay/a2a/payment/create` (JWT) body (sorted, optional keys only when given):
     `{"amount":"<as typed>","deliveries":{"includeUrl":true},"description"?,"expiresIn"?:<u64>,"externalId"?,
     "realm"?,"recipient":"<addr>","symbol":"<as typed>","type":"charge"}`. Error:
     `Smart-Account /payment/create failed: code=<c> msg=<m>` (or transport/5xx text).
  6. `paymentId = data.paymentId` string else `missing 'paymentId' in /payment/create response`;
     `deliveries = data.deliveries` (cloned; absent → null).
- Output (declaration order, snake_case): `{"payment_id":"<id>","deliveries":<Value|null>}`.
- Errors: exit 1 for all above; clap exit 2.
- Side effects: state-changing (server creates a payment link). No funds.
- Nondeterminism: server-generated `payment_id`, delivery URLs.
- Parity test cases:
  1. `onchainos payment a2a-pay create --type escrow --amount 1 --symbol USDT --recipient 0x1d4eAbb31AfEd5Aa70E1cCEEf73DEbF4dB164aB7`
     → `unknown --type 'escrow', expected 'charge'` (no HTTP). SAFE.
  2. `… --type charge --amount 0 --symbol USDT --recipient 0x1d4e…aB7` → `amount must be greater than zero`. SAFE.
  3. `… --type charge --amount 1 --symbol USDT --recipient 0x123` → `--recipient is not a valid EVM address: 0x123`.
     SAFE.
  4. `… --type charge --amount 0.01 --symbol USDT --recipient <own addr> --expires-in 600 --external-id t1`
     → creates a link. UNSAFE (state-changing, no funds).

### `onchainos payment a2a-pay pay`  (hidden: no)

- Handler: `a2a_pay::execute` → `pay` (a2a_pay.rs:280).
- Options (all required Strings): `--payment-id`, `--amount` (expected **minimal-unit** amount, compared
  byte-for-byte), `--currency` (expected token contract, case-insensitive), `--recipient-address` (expected payee,
  case-insensitive); global `--chain` ignored.
- Auth: jwt-required + session-key signature (TEE).
- Steps:
  1. `WalletApiClient::new()`; `ensure_tokens_refreshed()`.
  2. `GET /api/v6/pay/a2a/p/{paymentId}` via `get_public` (anonymous headers, no Authorization, no query). Error
     (not passed through format_api_error): `Smart-Account GET /p/{id} failed: Wallet API error (code=<c>): <m>`.
  3. `data.errorMessage` non-empty → `payment {id} unavailable (status={data.status|unknown}): {errorMessage}`.
  4. `challenge = data.challenge` else (if `data.type` exists) `data` itself else `GET /payment/{id} response
     missing 'challenge'`. Then in order: `challenge.data` (`challenge.data missing`), `data.intent` string
     (`challenge.data.intent missing`), intent ≠ `charge` → `pay() supports only 'charge' intent; got '{intent}' —
     use sign_escrow() for escrow`, `data.expires` string (`challenge.data.expires missing`), RFC3339 parse
     (`challenge.data.expires '{s}' is not RFC3339: <chrono error>`), `expires ≤ now` → `challenge expired at {s}`,
     `data.request` (`challenge.data.request missing`), `request.amount` string, `request.currency` string,
     `request.recipient` string (`challenge.data.request.{field} missing`), `request.methodDetails`
     (`challenge.data.request.methodDetails missing`), `methodDetails.chainId` u64 (`methodDetails.chainId
     missing`), `methodDetails.authorizationType` string (`methodDetails.authorizationType missing`).
  5. Guards: `--amount != request.amount` → `amount mismatch: expected {arg}, challenge has {amount}`; currency
     (case-insensitive) → `currency mismatch: expected {arg}, challenge has {currency}`; recipient →
     `recipient address mismatch: expected {arg}, challenge has {recipient}`.
  6. `(chainIndex, from) = resolve_buyer_wallet(chainId)` (§K.4; chain list cache/POST).
  7. `validAfter = 0`; `validBefore = now + 3600`; `nonce = 0x` + 32 random bytes hex.
  8. `signature = tee_sign_eip3009(…, to = request.recipient, value = request.amount, validAfter, validBefore,
     nonce, verifyingContract = request.currency, signType None, msgType "eip3009Auth")` (§K.5: gen-msg-hash +
     sign-msg).
  9. `POST /api/v6/pay/a2a/p/{paymentId}/credential` (JWT) body (sorted):
     `{"payload":{"authorization":{"from":"<from>","nonce":"<0x…>","to":"<recipient>","type":"<authorizationType>",
     "validAfter":"0","validBefore":"<dec>","value":"<amount>"},"signature":"<0x…>","type":"transaction"}}`. Error:
     `Smart-Account /p/{id}/credential failed: code=<c> msg=<m>`.
  10. If `data.success == false`: `reason = data.errorReason ?? "unknown"`; if `insufficient_balance` → build the
      funding scene (§K.6; extra HTTP: wallet balances, maybe token info, account refresh) → on success print
      `{"ok":false,"data":<scene>}` exit 1; otherwise (or scene build failed) error
      `payment {id} rejected (reason={reason})`.
- Output (declaration order): `{"payment_id":"<id>","status":"<data.status|unknown>","tx_hash":"<data.txHash>"|null,
  "valid_after":0,"valid_before":<u64>,"signature":"<0x…>"}`.
- Errors: exit 1 for all branches (funding scene also exit 1 but with `data` instead of `error`).
- Side effects: FUND-MOVING — `POST /api/v6/pay/a2a/p/{id}/credential` submits a signed EIP-3009 authorization
  that the server settles; `sign-msg` produces the fund-authorizing signature.
- Nondeterminism: `nonce`, `valid_before`, `signature`, `tx_hash`, `status`.
- Parity test cases:
  1. With a mocked base URL returning a challenge whose `request.amount` is `10000`, run
     `… a2a-pay pay --payment-id p1 --amount 9999 --currency 0x… --recipient-address 0x…` → `amount mismatch:
     expected 9999, challenge has 10000` (only auth refresh + GET observed; no signing). SAFE.
  2. Mock challenge with `intent:"escrow"` → `pay() supports only 'charge' intent; got 'escrow' — use
     sign_escrow() for escrow`. SAFE.
  3. Mock `data.errorMessage:"expired"` → `payment p1 unavailable (status=…): expired`. SAFE.
  4. Real link from `create` paid with matching args. UNSAFE (moves funds).

### `onchainos payment a2a-pay status`  (hidden: no)

- Handler: `a2a_pay::execute` → `fetch_status(paymentId, wait)` (a2a_pay.rs:901) → `status()` (855). Also MCP tool
  `payment_a2a_status`.
- Options: `--payment-id <PAYMENT_ID>` String required; `--wait` bool flag (default false); global `--chain`
  ignored.
- Auth: jwt-required.
- Steps:
  1. Each `status()` call: `WalletApiClient::new()`, `ensure_tokens_refreshed()`, `GET
     /api/v6/pay/a2a/p/{paymentId}/status` (JWT, no query). Error `Smart-Account /p/{id}/status failed:
     code=<c> msg=<m>`. `status = data.status` string else `"unknown"` (other fields — `executed.txHash`,
     `executed.blockNumber`, `executed.blockTimestamp`, `fee.amount`, `fee.bps` — are parsed but not output).
  2. `!wait` or terminal → return `{status, terminal: is_terminal_status(status), timed_out:false}`.
  3. `--wait` loop: `start = now` (after first call); loop { if elapsed ≥ 60 s → return `{status: last,
     terminal:false, timed_out:true}`; sleep 3 s; call status; if terminal → return `{status, terminal:true,
     timed_out:false}` }. ≈ 1 + 20 GETs worst case. Any call error aborts with the error.
- Output (sorted): `{"status":"<s>","terminal":bool,"timed_out":bool}`.
- Errors: exit 1.
- Side effects: read-only. `longRunning` with `--wait` (≤ ~60 s + request latency).
- Nondeterminism: server status; number of polls.
- Parity test cases:
  1. `onchainos payment a2a-pay status --payment-id <existing>` → one GET. SAFE.
  2. `… --payment-id <completed id> --wait` → one GET, `terminal:true`. SAFE.
  3. Logged-out → `session expired, please login again: onchainos wallet login`, no HTTP. SAFE.

### `onchainos payment subscription subscribe`  (hidden: no)

- Handler: `subscription::execute` (subscription.rs:141) → `cmd_subscribe` (311).
- Options: `--accepts <ACCEPTS>` String required (JSON array or single object); `--from <FROM>` Option (payer
  address); `--url <URL>` Option (resource URL + cache key); global `--chain` ignored.
- Auth: jwt-required + session-key signature (two TEE EIP-712 signatures).
- Steps:
  1. Parse `--accepts` JSON (`parse --accepts JSON: <serde error>`).
  2. `select_subscription_entry`: array → first element with `scheme == "period"` (exact, case-sensitive) else
     `no period entry in accepts[]`; non-array → the value itself (no scheme check).
  3. `(chainIndex, chainId, payer) = resolve_chain_and_payer(accepted, --from)` (§A).
  4. `signed = sign_subscribe(chainIndex, chainId, payer, accepted)` (§H.3/4). HTTP: `GET
     /api/v6/pay/x402/buyers/{payer}/allowance-status?token={asset}&chainIndex={ci}` (no headers) → gen-msg-hash +
     sign-msg (PermitSingle) → gen-msg-hash + sign-msg (SubscriptionTerms).
  5. Header: `PAYMENT-SIGNATURE` = base64std(compact sorted JSON
     `{"accepted":<selected entry>,"payload":{"permitSingle":{"details":{"amount","expiration","nonce","token"},
     "sigDeadline","spender"},"permitSingleSignature":"0x…","terms":{…18 keys incl. planId…},"termsSignature":"0x…"},
     "resource":{"mimeType":"application/json","url":"<--url or \"\">"},"x402Version":2}`).
  6. Cache (`cache_subscription`): no `--url` → stderr `Warning: subscription NOT cached (no --url). Subsequent
     \`payment subscription access\` can't find this subId — pass --url to subscribe.` and no file write; else load
     cache, `entry = {subId: local subId, resourceHost: host_of(url), merchant: terms.merchant, planId:
     extra.plan.id, planTier, maxPeriods, state:"active"}`, `put(entry)`, save (failure → stderr `Warning: failed to
     update subscription cache: {e:#}`, not fatal).
- Output (sorted): `{"chainIndex":"<ci>","payload":{"permit":{"details":{"amount":"<str>","expiration":<u64>,
  "nonce":<u64>,"token"},"sigDeadline":"<str>","spender"},"permitSignature":"0x…","terms":{"amountPerPeriod",
  "changeEffectiveAt":0,"changeFromSubId":"0x00…","facilitator","initialChargeAmount","initialChargePeriods",
  "maxPeriods","merchant","payer","periodMode","periodSec","permitHash","planId","planTier","salt","startAt",
  "termsDeadline","token"},"termsSignature":"0x…"},"paymentHeaderName":"PAYMENT-SIGNATURE",
  "paymentHeaderValue":"<base64>","subId":"0x<64 hex>"}` (subId is the local terms digest).
- Errors: all of §H.1–H.3 plus resolution errors; exit 1.
- Side effects: FUND-AUTHORIZING (signs a Permit2 PermitSingle allowance + subscription terms; the CLI does not
  submit — the caller relays the header to the Seller, who charges). Writes `subscriptions.json`.
- Nondeterminism: `salt`, `sigDeadline/termsDeadline`, `expiration` (when startAt 0), signatures, `subId`,
  header value.
- Parity test cases:
  1. `onchainos payment subscription subscribe --accepts '[{"scheme":"exact"}]'` → `no period entry in
     accepts[]` (no HTTP). SAFE.
  2. `--accepts '{"scheme":"period","network":"base"}'` → `network 'base' is not a CAIP-2 EVM identifier
     (eip155:<id>)`. SAFE.
  3. `--accepts '{"scheme":"period","network":"eip155:196","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736",
     "payTo":"0x…","extra":{"plan":{"tier":1}}}'` (logged in) → `accepts entry \`extra\` missing \`contracts\``
     after chain resolution. SAFE.
  4. Valid period offer with tampered `extra.contracts.subscription` → allowance GET then `subscription contract
     mismatch: offer=…`. SAFE (no signing).
  5. Valid offer → two TEE signatures. UNSAFE.

### `onchainos payment subscription change`  (hidden: no)

- Handler: `cmd_change` (subscription.rs:331).
- Options: `--accepts <ACCEPTS>` required; `--sub-id <SUB_ID>` Option (overrides `extra.changeFrom.fromSubId`);
  `--from <FROM>` Option; `--url <URL>` Option; global `--chain` ignored.
- Auth: jwt-required + session-key signature.
- Steps: as subscribe, but `sign_change(chainIndex, chainId, payer, --sub-id or "", accepted)` (§H.5) —
  `changeFromSubId` = old subId, `changeEffectiveAt` 1 (upgrade/immediate) or 2 (downgrade/period_end; permit
  window shifted by one period / one month). Cache: `is_change` = changeFromSubId without `0x` and without `0`
  characters is non-empty. If `changeEffectiveAt == 2` → stderr `Note: downgrade scheduled — current plan stays
  active until period end. Run \`payment subscription my-subscriptions\` after it activates to switch.` and the cache
  is saved unchanged (file is still (re)written); else `mark_changed(old, entry)` then save. No `--url` → same
  warning as subscribe.
- Output: identical shape to subscribe (`terms.changeFromSubId` = old subId, `terms.changeEffectiveAt` 1|2).
- Errors: subscribe's plus `change requires --sub-id or extra.changeFrom.fromSubId`, `change offer missing
  extra.changeFrom`, `unknown changeFrom.effectiveAt: …`, `unknown changeFrom.direction: …`, `changeFrom missing
  both effectiveAt and direction`.
- Side effects: FUND-AUTHORIZING (new PermitSingle + terms), local cache write.
- Nondeterminism: as subscribe.
- Parity test cases:
  1. Valid period entry without `extra.changeFrom` and `--sub-id 0xabc…` → `change offer missing extra.changeFrom`
     (after chain resolution; no allowance call). SAFE.
  2. `extra.changeFrom:{"direction":"sideways"}` → `unknown changeFrom.direction: sideways`. SAFE.
  3. Valid upgrade offer → signs. UNSAFE.

### `onchainos payment subscription access`  (hidden: no)

- Handler: `cmd_access` (subscription.rs:363); `--chain` pre-resolved with `chains::resolve_chain`.
- Options: `--url <URL>` required; `--sub-id <SUB_ID>` Option; `--from <FROM>` Option; `--chain <CHAIN>` default
  `xlayer` (local arg, shadows global).
- Auth: jwt-required + session-key signature (TEE personalSign; non-fund).
- Steps:
  1. subId: `--sub-id` → `(value, "override")`; else `SubscriptionCache::load().resolve(url)` (active entry for
     `host_of(url)`) → `(entry.subId, "cache")`, else error `no active subscription cached for host {host}. Run
     \`payment subscription my-subscriptions\` to reconcile, or pass --sub-id.`
  2. `(chainIndex, _, payer) = resolve_chain_and_payer_by_chain(chain, --from)`.
  3. `build_access_proof(chainIndex, payer, subId)` (§H.8): local inner hash (errors `invalid subId bytes32: …` /
     `invalid payer address: …`), `ensure_tokens_refreshed`, `POST …/sign-msg` (personalSign; no gen-msg-hash).
- Output (sorted): `{"accessHeaderName":"APP-Access","accessHeaderValue":"<base64 of {\"kind\":\"subscription-id\",
  \"payer\",\"signature\",\"subId\",\"timestamp\":<u64>}>","host":"<host_of(url)>","source":"override"|"cache",
  "subId":"<subId>"}`.
- Errors: exit 1.
- Side effects: read-only (produces an access credential; no server state, no funds).
- Nondeterminism: `timestamp`, `signature`, header value.
- Parity test cases:
  1. Empty cache: `onchainos payment subscription access --url https://api.example.com/data` → `no active
     subscription cached for host api.example.com. …` (no HTTP). SAFE.
  2. `… --url https://api.example.com/data --sub-id not-hex` (logged in) → chain resolution then `invalid subId
     bytes32: not-hex`. SAFE.
  3. `… --sub-id 0x11…11` → one sign-msg call; `source:"override"`. SAFE (non-fund signature).

### `onchainos payment subscription cancel`  (hidden: no)

- Handler: `cmd_cancel(subId, None, contract, token, chain, from, pending=false)` (subscription.rs:420).
- Options: `--sub-id <SUB_ID>` required; `--contract <CONTRACT>` Option (subscription contract; used verbatim, not
  validated); `--token <TOKEN>` Option (lookup key when no `--contract`); `--chain` default `xlayer`; `--from`
  Option.
- Auth: jwt-required + session-key signature.
- Steps:
  1. `(chainIndex, chainId, payer) = resolve_chain_and_payer_by_chain(chain, from)`.
  2. `resolve_contract`: `--contract` → it; else `--token` required (`cancel requires --contract (subscription
     contract) or --token (to look it up)`) → `allowance_status(payer, token, chainIndex)` → `subscriptionContract`
     (empty → `allowance-status returned no subscriptionContract for token {token}`).
  3. `sign_cancel` (§H.6): random nonce, `deadline = now + 3600`, gen-msg-hash + sign-msg. Cache untouched.
- Output (sorted): `{"cancelAuth":{"action":0,"deadline":<u64>,"initiator":0,"nonce":"0x…","signature":"0x…",
  "subId":"<as given>"},"chainIndex":"<ci>"}`.
- Errors: exit 1.
- Side effects: state-authorizing (signed CancelAuth for the Seller to submit; no funds; CLI submits nothing).
- Nondeterminism: nonce, deadline, signature.
- Parity test cases:
  1. `onchainos payment subscription cancel --sub-id 0x11…11` (logged in, no `--contract/--token`) → `cancel
     requires --contract (subscription contract) or --token (to look it up)`. SAFE.
  2. `… --token 0x779ded0c9e1022225f8e0630b35a9b54be713736` → allowance GET, then signs. UNSAFE-ish (signed
     cancel authorization).

### `onchainos payment subscription cancel-pending`  (hidden: no)

- Handler: `cmd_cancel(subId, Some(newSubId), …, pending=true)`.
- Options: `--sub-id` required; `--new-sub-id <NEW_SUB_ID>` required; `--contract`, `--token` Option; `--chain`
  default `xlayer`; `--from` Option.
- Auth: jwt-required + session-key signature.
- Steps: as cancel, but `sign_cancel_pending_change` (§H.7) — typed data `PendingChangeCancelAuth(subId, newSubId,
  nonce, deadline)`.
- Output (sorted): `{"chainIndex":"<ci>","pendingChangeCancelAuth":{"deadline":<u64>,"newSubId","nonce",
  "signature","subId"}}`.
- Errors: as cancel (the `cancel-pending requires --new-sub-id …` branch is unreachable via clap).
- Side effects: state-authorizing (no funds).
- Nondeterminism: nonce, deadline, signature.
- Parity test cases:
  1. `… cancel-pending --sub-id 0x11…11` (missing `--new-sub-id`) → clap error, exit 2. SAFE.
  2. `… cancel-pending --sub-id 0x… --new-sub-id 0x…` (no contract/token) → `cancel requires --contract …`. SAFE.

### `onchainos payment subscription my-subscriptions`  (hidden: no)

- Handler: `cmd_my_subscriptions` (subscription.rs:460).
- Options: `--chain` default `xlayer`; `--from` Option; `--limit <LIMIT>` u32 default 50 (clamped 1..=100 on the
  wire); `--offset <OFFSET>` u32 default 0.
- Auth: anonymous HTTP (no OKX headers), but needs local wallets.json (+ chain list) to resolve the payer.
- Steps: resolve payer → `GET /api/v6/pay/x402/buyers/{payer}/subscriptions?limit={clamped}&offset={offset}` →
  `parse_subscription_list` → `SubscriptionCache::load().reconcile_from(items)` → `save()` (always rewrites
  `subscriptions.json`; failure → stderr `Warning: failed to reconcile subscription cache: {e:#}`).
- Output (sorted): `{"subscriptions":[{"amountPerPeriod":"<str>","billingAnchorAt":<u64>,"chainIndex":<u64>,
  "changedToSubId":"…"|null,"currentPeriod":<u32>,"initialChargeAmount":"<str>","initialChargePeriods":<u32>,
  "isActive":bool,"lastChargedPeriod":<u32>,"maxPeriods":<u32>,"nextChargeableAt":<u64>|null,"payer","periodMode",
  "periodSec":<u64>,"planId","planTier","serviceEnded":bool,"startAt":<u64>,"state":<u8>,"subId","token",
  "totalPulled":"<str>"}]}` — **remapped** (numbers normalized by flex deserializers, unknown server fields such as a
  `pendingPlanChange` object dropped, missing fields defaulted).
- Errors: `my-subscriptions query failed: …`, `parse my-subscriptions response: …`, `parse subscriptions array: …`,
  resolution errors; exit 1.
- Side effects: read-only (server); writes local `subscriptions.json`.
- Nondeterminism: server data; `subscriptions.json` host order.
- Parity test cases:
  1. `onchainos payment subscription my-subscriptions` (logged in) → one GET `…?limit=50&offset=0`. SAFE.
  2. `… --limit 500 --offset 3` → wire `limit=100&offset=3`. SAFE.
  3. `… --limit 0` → wire `limit=1`. SAFE.

### `onchainos payment subscription allowance-status`  (hidden: no)

- Handler: `cmd_allowance_status` (subscription.rs:485).
- Options: `--token <TOKEN>` required; `--chain` default `xlayer`; `--from` Option.
- Auth: anonymous HTTP; needs local wallets.json for the payer.
- Steps: resolve payer → `allowance_status(payer, token, chainIndex)` (§I).
- Output (sorted): `{"approvedAmount":"<str>","availableAmount":"<str>","expiration":<u64>,"nonce":<u64>,
  "permit2Allowance":"<str>","permit2Contract":"<str>","reservedAmount":"<str>","reservedExpiration":<u64>,
  "subscriptionContract":"<str>","tokenBalance":"<str>"}` (missing → `""` / `0`; numeric amounts stringified).
- Errors: `allowance-status query failed: …`, `parse allowance-status response: …`, resolution errors; exit 1.
- Side effects: read-only.
- Nondeterminism: on-chain values.
- Parity test cases:
  1. `onchainos payment subscription allowance-status --token 0x779ded0c9e1022225f8e0630b35a9b54be713736` → one GET
     `/api/v6/pay/x402/buyers/{addr}/allowance-status?token=0x779d…&chainIndex=196`. SAFE.
  2. Same with `--chain 8453` → `chainIndex=8453` (payer = Base address). SAFE.
  3. Logged out → `not logged in` (after the chain list lookup). SAFE.

---

## Endpoint classification (this partition, including helper calls)

| method | path | class | used by |
|---|---|---|---|
| POST | /api/v6/pay/a2a/payment/create | state | a2a-pay create |
| GET | /api/v6/pay/a2a/p/{id} | read | a2a-pay pay |
| POST | /api/v6/pay/a2a/p/{id}/credential | funds | a2a-pay pay |
| GET | /api/v6/pay/a2a/p/{id}/status | read | a2a-pay status (+ MCP payment_a2a_status) |
| POST | /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash | read (pure hash computation, JWT) | a2a-pay pay, subscribe, change, cancel, cancel-pending, sign_escrow, permit2 signing |
| POST | /priapi/v5/wallet/agentic/pre-transaction/sign-msg | funds (TEE signature authorizing transfers; the personalSign use in `access` is non-fund) | a2a-pay pay, subscribe, change, cancel, cancel-pending, access |
| GET | /api/v6/pay/x402/buyers/{buyer}/allowance-status | read | subscribe, change, cancel/cancel-pending (--token), allowance-status |
| GET | /api/v6/pay/x402/buyers/{buyer}/subscriptions | read | my-subscriptions |
| POST | /api/v6/dex/market/token/basic-info | read | quote |
| GET | /api/v6/dex/balance/all-token-balances-by-address | read | quote |
| POST | /priapi/v5/wallet/agentic/chain/support/list | read | chain-cache miss (a2a pay, all subscription cmds) |
| POST | /priapi/v5/wallet/agentic/auth/refresh | auth | any jwt-required cmd when token near expiry |
| GET | /priapi/v5/wallet/agentic/asset/wallet-all-token-balances | read | a2a pay funding scene |
| POST | /priapi/v5/wallet/agentic/token/get-token-info | read | a2a pay funding scene |
| POST | /priapi/v5/wallet/agentic/account/list | read | a2a pay funding scene |
| POST | /priapi/v5/wallet/agentic/account/address/list | read | a2a pay funding scene |

## External hosts (non-OKX)

- Arbitrary merchant endpoint (`payment quote <URL>`): REST probe (GET/POST/…), 10 s timeout, own reqwest client,
  no OKX headers.
- Arbitrary MCP endpoint (`payment quote` MCP branch): JSON-RPC POSTs (`initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`), 30 s timeout.
- `https://rpc.xlayer.tech` — `eth_call allowance(owner, PERMIT2)` in `permit2::rpc` (used by `payment pay`
  exact+permit2/upto, g09a; not by this partition's commands).
- DoH resolvers (core `doh/`) used transparently by WalletApiClient/ApiClient.

## Open questions

1. `my-subscriptions` output drops every server field not in `BuyerSubscriptionItem` — including
   `pendingPlanChange`, which the `cancel-pending --new-sub-id` help text tells users to read from
   `my-subscriptions`. Parity reimplementation should reproduce the dropping; confirm whether that is intended.
2. `subscriptions.json` is a serialized `HashMap` → host key order is nondeterministic; byte-level file parity is
   impossible (compare parsed JSON instead).
3. U256 arithmetic in `sign_double` (`reserved + initial + perPeriod×remaining`) uses ruint operators; overflow
   behaviour (panic vs wrap) was not verified. Irrelevant for realistic amounts.
4. `payment quote` for an MPP (`WWW-Authenticate: Payment …`) 402 always fails with `unsupported: 402 challenge has
   no accepts[] array` (decode_payment_blob returns an MPP challenge object). Confirm this is expected upstream
   behaviour rather than a gap.
5. `decodedChallenge.expires` only honours numeric JSON `expires` on accepts entries (strings ignored) whereas the
   A2MCP path accepts numeric strings / RFC3339 — reproduce as-is.
6. The exact response shape of `gen-msg-hash` / `sign-msg` (`data` is an array; fields read at `data[0]`) is
   inferred from the client code; server-side error codes for TEE rejections are not visible in this partition.
7. `payment quote` sends params through `reqwest`'s form encoding (spaces as `+`) for GET; `get_no_okheaders` inserts
   `buyer`/`token` raw — non-ASCII or reserved characters would be percent-encoded by the URL parser; exact encoding
   of odd inputs not verified.
8. Whether the OKX `ApiClient` auto-pay layer (client.rs `ensure_payment_config`) issues an extra config HTTP call
   during `payment quote` is owned by core; the harness should expect possible extra OKX traffic there.
9. `a2a-pay create --expires-in` help says "Default 1800" but the CLI omits the field when absent (server-side
   default assumed).
