# g09a-payment-core — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the `onchainos payment …` command enum + dispatcher, the x402 signing / two-phase pay flow, the MPP
(`WWW-Authenticate: Payment …`) charge + channel-session flows, the carrier-aware merchant replay, and the
local payment state files (`payments/*.json`, `sessions/*.json`, `payment_cache.json` default asset).
`payment quote`, `payment a2a-pay …`, `payment subscription …` are only *dispatched* here; their handlers
live in `quote.rs`, `a2a_pay.rs`, `subscription.rs` (other partitions).

All paths below are relative to `upstream/cli/src/`.

---

## Sources read

Owned (read fully, including tests):

| file | lines |
|---|---|
| `commands/payment/dispatcher.rs` | 3455 |
| `commands/payment/payment_flow.rs` | 3982 |
| `commands/payment/http_carrier.rs` | 379 |
| `commands/payment/state.rs` | 423 |
| `commands/payment/session_state.rs` | 146 |
| `commands/payment/decode_receipt.rs` | 176 |
| `commands/payment/addr.rs` | 266 |
| `commands/payment/mod.rs` | 25 |

Consulted for callees (not owned; only summarised): `main.rs` (316), `output.rs` (450), `payment_cache.rs` (280),
`payment_notify.rs` (TierState / drain_events), `wallet_api.rs` (post_public / post_authed / envelope unwrap),
`commands/agentic_wallet/chain.rs` (175), `commands/agentic_wallet/transfer/mod.rs` (resolve_address),
`commands/agentic_wallet/auth/mod.rs` (ensure_tokens_refreshed, format_api_error), `commands/agentic_wallet/common.rs`,
`crypto.rs` (hpke / ed25519 / eip3009_sign), `wallet_store.rs`, `home.rs`, `endpoints.rs`, `chains.rs`,
`payment/permit2/{rpc,sign}.rs`, `payment/subscription/{sign,facilitator}.rs`, `commands/payment/a2mcp.rs`
(intent state machine parts), `commands/payment/quote.rs` (run / state write parts), `mcp/mod.rs` (payment tools),
`audit.rs` (payment_sub), `Cargo.toml` / `Cargo.lock` (serde_json has **no** `preserve_order`).

---

## 0. Cross-cutting conventions (read first — they govern byte parity)

1. **JSON key order.** `serde_json` is built without `preserve_order` (Cargo.lock: serde_json deps = itoa, memchr,
   serde, serde_core, zmij — no indexmap). Every `serde_json::Value` object is a `BTreeMap`, so:
   - every `data` object printed by these commands has keys **sorted by byte order** (derived structs such as
     `PayResult`, `SessionData`, `DecodedReceipt` go through `serde_json::to_value` first, so they are sorted too);
   - every JSON request body sent by `reqwest .json(&Value)` (TEE `gen-msg-hash` / `sign-msg`, merchant replay body)
     is compact with keys sorted;
   - the base64 JSON inside `PAYMENT-SIGNATURE` has sorted keys, and **passthrough objects are re-sorted**
     (`resource`, the selected `accepts` entry echoed as `accepted`, merchant `result`);
   - numbers in passthrough JSON are parsed as u64/i64/f64 (integers > u64::MAX become f64 → precision loss).
   - Files written by serializing a *struct directly* (`to_string_pretty(&PaymentState)`, `ChannelState`,
     `PaymentCache`) keep **struct declaration order**; nested `Value`s inside them are sorted.
2. **Envelope** (`output.rs`): success `{"ok":true,"data":<data>}`; empty success `{"ok":true}`; error
   `{"ok":false,"error":"<msg>"}` (exit 1) where `<msg>` = `format!("{e:#}")` = anyhow context chain joined by
   `": "` (outer first). Confirming: `{"confirming":true,"message":"…","next":"…"}` (exit 2; `scene` omitted).
   Output is compact JSON + `\n` on stdout; `ONCHAINOS_PRETTY=1` → `serde_json::to_string_pretty` (2-space).
   Key `notifications` is appended only when `payment_notify` has queued events — only `ApiClient` (client.rs)
   pushes events and no command in this partition uses `ApiClient`, so `notifications` is always absent here.
   Non-ASCII is emitted as raw UTF-8 (e.g. the em dash in `reason_text`).
3. **Exit codes**: 0 success (including recorded `status:"failed"`/`"pending"` pay outcomes); 1 any `Err`;
   2 `CliConfirming` (two-phase pay without `--yes`) **and** clap usage errors (clap prints plain text to stderr).
4. **Global flags** (from `main.rs`): `--chain <CHAIN>` (global, accepted after any payment subcommand, **ignored**
   by every payment handler — `commands::payment::execute(command)` receives no `Context`); exception:
   `payment default set` declares its own required `--chain` (clap does not propagate the global arg into a
   subcommand that already has an arg with id `chain`, so the local one wins). Hidden global `--dev` switches the
   OKX base URL to `https://beta.okex.org` (`endpoints::DEV_BASE_URL`), affecting WalletApiClient calls.
5. **Error-text parity caveat**: several errors embed Rust library messages via `{:#}` (ParseIntError
   "invalid digit found in string", chrono RFC3339 errors, serde_json errors, io "No such file or directory
   (os error 2)", ruint U256 parse errors, reqwest transport errors). Prefixes are exact; suffixes are
   library-specific.
6. **Audit** (core, not owned): after every command `audit::log("cli", "payment <sub>", ok, …)` appends to
   `~/.onchainos/audit.jsonl`; sub names: `pay`, `quote`, `decode-receipt`, `pay-local`, `default-set`,
   `default-get`, `default-unset`, `charge`, `session open|voucher|topup|close`, `a2a-pay …`, `subscription …`.
7. **ONCHAINOS_HOME**: `home::onchainos_home()` = `$ONCHAINOS_HOME` if set and non-empty, else `~/.onchainos`.

### Login artefacts consumed by this partition (for reuse of the onchainos login flow)

| artefact | location | fields used here |
|---|---|---|
| wallets | `$HOME/wallets.json` (`wallet_store::load_wallets`) | `selected_account_id`, `accounts_map[acct].address_list[] {address, chainName}` |
| session | `$HOME/session.json` (`wallet_store::load_session`) | `session_cert`, `encrypted_session_sk`, `session_key_expire_at` |
| keyring blob | OS keyring / `keyring.enc` (`keyring_store`) | `access_token`, `refresh_token`, `session_key` (X25519 sk, base64) |
| chain cache | `$HOME/chain_cache.json` (TTL 600 s) | chain list entries `{chainIndex, realChainIndex, chainName, alias[]}` |

"not logged in" (`common::ERR_NOT_LOGGED_IN`) is the error text when wallets.json / session.json / keyring
`session_key` is missing at the point of use. `ensure_tokens_refreshed()` fails first with
`session expired, please login again: onchainos wallet login` when `session.json` is missing or
`session_key_expire_at` is past/empty, or tokens are missing / refresh token expired.

### TEE signing protocol (the "session-key signature" auth used by pay / charge / session)

Per signature: (1) `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` (JWT) → `data[0].msgHash`
(+ `data[0].domainHash` for EIP-3009); (2) locally `seed = HPKE-open(encrypted_session_sk, session_key)`
(DHKEM-X25519/HKDF-SHA256/AES-256-GCM, info `okx-tee-sign`, wire `enc(32)||ct`), `sessionSignature =
base64std(Ed25519(seed, hexdecode(msgHash)))`; (3) `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg`
(JWT) → `data[0].signature` (0x-hex secp256k1 from the TEE). Exact bodies per path are given in the helpers below.
`post_authed` adds JWT headers (`ApiClient::jwt_headers`: `Authorization: Bearer <token>` + anonymous
`ok-access-*`/device headers — core spec), 30 s timeout, DoH failover retry, and on backend `10008` does a forced
token refresh + one retry. Non-zero envelope `code` → `ApiCodeError`, rendered by `format_api_error` as
`code=<code> msg=<msg>`.

---

## Shared helpers (used across groups or from core)

### dispatcher.rs

- `fn dispatcher::execute` (dispatcher.rs:290) — match on `PaymentCommand`, routes to the handlers below;
  `A2aPay` → `a2a_pay::execute`, `Subscription` → `subscription::execute`, `Quote` → `quote::run`.
- `fn chain_id_to_caip2(input)` (426) — trim; empty → `--chain must not be empty`; parse `u64` (Rust rules:
  optional leading `+`, digits only) else error `--chain must be a numeric chain id (e.g. "1" for Ethereum, "196" for X Layer), got: {trimmed}`
  with ParseIntError cause (`: invalid digit found in string` / `: number too large to fit in target type`);
  `195|501|607|784` → `x402 payments are EVM-only; chain id {n} is not supported`; returns `eip155:{n}` (n
  re-formatted, e.g. `+196`→`eip155:196`).
- `fn caip2_to_chain_id(caip2)` (446) — strip `eip155:` prefix if present, else return as-is.
- `fn cmd_default(action)` (450) — see `payment default …` commands.
- `fn validate_payment_inputs` (527) — **dead code** (no callers). Not needed.
- `fn decode_pay_payload(payload)` (599) — `decode_payment_blob(payload)?`; `accepts` = decoded`.accepts`
  (any JSON type) else `--payload decoded to JSON without an 'accepts' field`; `resource` = decoded`.resource`
  (Option, verbatim Value).
- `fn select_accepts_index(accepts, i)` (614) — accepts must be array else
  `--selected-index requires the payload's 'accepts' to be an array`; out of range →
  `--selected-index {i} is out of range (accepts has {n} entr{y|ies})` (`y` when n==1); returns `[accepts[i]]`.
- `fn emit_pay_result(proof, entry, resource)` (633) — `resource` Some → `payment_flow::pay_with_header_json`;
  None → `proof.to_pay_json()`.
- `fn parse_www_authenticate(header)` (655) — RFC-7235-ish parser. Algorithm:
  1. `content = header.strip_prefix("Payment ")` (case-sensitive) else whole header.
  2. Loop over bytes: skip `' '`, `'\t'`, `','`; read key bytes until `=` or `,`; if end/`,` reached without `=`
     → skip (continue). `key = content[start..i].trim()`; consume `=`.
  3. Value: if next byte is `"` → quoted: `\` + next byte → push next byte **as a Latin-1 char** (`byte as char`);
     `"` closes; any other byte pushed **as `byte as char`** (so non-ASCII UTF-8 is mangled byte-wise; unterminated
     quote runs to end). Else token: slice (UTF-8 preserved) until `,`/space/tab.
  4. Non-empty keys inserted as JSON strings (later duplicates overwrite).
  5. Must contain keys `id`, `method`, `intent` else
     `invalid WWW-Authenticate header: missing required fields (id, method, intent)`; `method` must equal `evm`
     exactly else `unsupported payment challenge method "{method}"; this CLI only supports method="evm"`.
  Returns a JSON object of strings.
- `fn decode_challenge_request(challenge)` (733) — `challenge.request` string else `missing 'request' in challenge`;
  base64 decode with URL-safe **no-pad**, then URL-safe **padded** (base64 0.22 strict: canonical trailing bits;
  `+`/`/` rejected) else `invalid base64url in challenge request: <b64 err>`; JSON parse else
  `invalid JSON in challenge request: <serde err>`.
- `pub(crate) fn decode_payment_blob(input)` (753) — shared decoder (also used by quote.rs, a2mcp.rs,
  agent a2mcp probe, decode_receipt): `t = input.trim()`;
  1. if first 8 bytes equal `Payment ` case-insensitively → `parse_www_authenticate(t)` (note: prefix strip inside
     is case-sensitive, so `payment id=…` fails the required-fields check), then if `request` is a string replace it
     with `decode_challenge_request` result; return.
  2. try, in order, base64 STANDARD (padded, canonical), STANDARD_NO_PAD, URL_SAFE (padded), URL_SAFE_NO_PAD; the
     first variant that decodes **and** parses as JSON wins.
  3. plain JSON parse of `t`.
  4. else `could not decode payment blob: not a WWW-Authenticate challenge, base64-encoded JSON, or plain JSON`.
- `fn build_challenge_echo(challenge)` (802) — `{"id","realm","method","intent","request","expires"}` copied from the
  parsed challenge (missing → `null`; `request` is the raw base64url **string**).
- `fn base64url_encode_json(v)` (814) — `serde_jcs` (RFC 8785: keys sorted by UTF-16 code units, compact, ES6
  number/string rules) → base64url **no padding**. MPP header = `"Payment " + base64url_encode_json(credential)`.
- `fn parse_challenge_expires_unix(ch)` (821) — `expires` absent/non-string → None; `chrono::DateTime::parse_from_rfc3339`
  else `challenge.expires is not RFC3339: {s}` (+ chrono cause); negative → `challenge.expires is before Unix epoch: {s}`.
- `fn compute_valid_before(ch, now)` (840) — `from_now = now+300`; expires None → `from_now`; `exp < now` →
  `challenge.expires is already in the past`; else `max(from_now, exp+60)`. Decimal string. Oracles:
  (no expires, now 1000) → `"1300"`; (exp 600, now 0) → `"660"`; (exp 100, now 0) → `"300"`.
- `struct ParsedSplit {amount, canonical, display}` (857).
- `fn compute_primary_split_amounts(request, chain_id)` (880) — `request.amount` string else
  `missing 'amount' in challenge request`; U256 base-10 parse else
  `challenge amount '{a}' is not a base-10 integer: {e}`. `request.methodDetails.splits` not an array → return
  `(amount_str verbatim, [])`. Array: empty → `challenge methodDetails.splits is present but empty (spec requires >= 1 entry)`;
  len>10 → `challenge splits count {n} exceeds spec max of 10`; per entry i: `amount` string else
  `splits[{i}].amount missing or not a string`, `recipient` string else `splits[{i}].recipient missing or not a string`,
  U256 parse else `splits[{i}].amount '{a}' is not a base-10 integer: {e}`, zero → `splits[{i}].amount must be > 0`,
  overflow → `splits sum overflow at index {i}`, `parse_recipient_addr(recipient, chain_id)` with context
  `splits[{i}].recipient`. Then `sum >= amount` →
  `splits sum ({sum}) must be strictly less than challenge amount ({amount}) per spec §Constraints`.
  Returns `((amount-sum) as decimal, splits)`; split `amount` kept verbatim string. Oracles: 1000000 with
  [50000,10000] → `"940000"`; 100 with [30,20] → `"50"`.
- `fn compute_topup_nonce(payer, channel_id, additional, salt)` (956) — `keccak256(abi.encode(bytes32 channelId,
  uint128 additionalDeposit, address from, bytes32 topUpSalt))` (4 static words). Errors: `invalid payer address`,
  `channelId must be hex`, `channelId must be 32 bytes (64 hex chars)`, `additionalDeposit must be decimal uint128`,
  `topUpSalt must be hex`, `topUpSalt must be 32 bytes (64 hex chars)`. Hex inputs strip **all** leading `0x`
  repetitions (`trim_start_matches`). Output `0x`+lowercase hex.
- `fn parse_session_splits(request, chain_id)` (997) — absent/empty `methodDetails.splits` → `([],[])`; each:
  `recipient` string else `splits[{i}].recipient missing`; `bps` JSON unsigned int else
  `splits[{i}].bps missing or not integer`; `1..=9999` else `splits[{i}].bps out of range 1-9999: {b}`;
  recipient canonicalised via `parse_recipient_addr` (context `splits[{i}].recipient`).
- `fn compute_open_nonce(payer, payee, token, salt, authorizedSigner, recipients, bps)` (1033) —
  `keccak256(abi.encode(address,address,address,bytes32,address,address[],uint16[]))` (standard ABI head/tail:
  5 static words + 2 offsets `0xe0` and `0xe0+32+32·n`, then each array = length word + 32-byte left-padded
  elements). Errors: `invalid payer address` / `invalid payee address` / `invalid token address` /
  `invalid authorizedSigner address` / `salt must be hex` / `salt must be 32 bytes (64 hex chars)` /
  `invalid split recipient` (alloy `Address::from_str`: optional 0x, no checksum enforcement).
- `fn compute_channel_id(payer, payee, token, salt, authorizedSigner, escrow, chainId)` (1085) —
  `keccak256(abi.encode(address,address,address,bytes32,address,address,uint256))`. Oracle (test):
  payer `0x1111…11`, payee `0x2222…22`, token `0x3333…33`, salt `0x4444…44` (32 bytes), auth `0x1111…11`,
  escrow `0x5555…55`, chain 196 → `0xa38cd33d0b42b9654d5077dccc63849159206c9da56748d8d225a1c79100e2b2`.
  Extra error `invalid escrow address`.
- `enum Eip3009AuthType {Transfer, Receive}` (1138) — Receive adds `"eip3009ReceiveAuth"` as `msgType` (gen) /
  `signType` (sign).
- `async fn tee_sign_eip3009(auth_type, chainIndex, from, to, amount, validBefore, nonce, asset)` (1160) —
  1. `ensure_tokens_refreshed()`; `load_session()` else `not logged in`; keyring `session_key` else `not logged in`.
  2. `base = {chainIndex, from, to, value: amount, validAfter:"0", validBefore, nonce, verifyingContract: asset}`.
  3. `POST …/pre-transaction/gen-msg-hash` body = base (+`msgType:"eip3009ReceiveAuth"` for Receive); error
     context `eip3009 gen-msg-hash failed`; `data[0].msgHash` else `missing msgHash in gen-msg-hash response`;
     `data[0].domainHash` else `missing domainHash in gen-msg-hash response`.
  4. seed = HPKE-open; `sessionSignature = base64std(ed25519(seed, hex(msgHash without leading 0x)))`
     (`invalid msgHash hex`).
  5. `POST …/pre-transaction/sign-msg` body = base + `domainHash`, `sessionCert`, `sessionSignature`,
     `skipWarning:true` (+`signType:"eip3009ReceiveAuth"` for Receive; **no** `msgType`); context
     `eip3009 sign-msg failed`; `data[0].signature` else `missing signature in sign-msg response`.
  Returns `(signature, from)`.
- `fn build_voucher_typed_data(channelId, cum, escrow, chainId)` (1257) — EIP-712 JSON:
  `{"domain":{"name":"EVM Payment Channel","version":"1","chainId":<u64 number>,"verifyingContract":escrow},
  "types":{"EIP712Domain":[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],
  "Voucher":[{name:"channelId",type:"bytes32"},{name:"cumulativeAmount",type:"uint128"}]},
  "primaryType":"Voucher","message":{"channelId":channelId,"cumulativeAmount":cum}}` (strings verbatim; arrays keep order).
- `async fn tee_sign_voucher(chainIndex, payer, channelId, cum, escrow, chainId)` (1295) — ensure tokens; session +
  keyring as above; `POST gen-msg-hash` body `{"chainIndex", "payload":[{"msgType":"eip712","message":<typed data>}]}`
  (context `mpp voucher gen-msg-hash failed`; `data[0].msgHash` else `missing msgHash`); `sessionSignature =
  crypto::ed25519_sign_hex(msgHash, base64(seed))` (strips one `0x`; empty msgHash → empty string);
  `POST sign-msg` body `{"chainIndex","from":payer,"sessionCert","payload":[{"signType":"eip712","message":<typed data>,"sessionSignature"}],"skipWarning":true}`
  (context `mpp voucher sign-msg failed`; `data[0].signature` else `missing signature`).
- `async fn resolve_chain_and_payer(chain_id: u64, from)` (1381) — `chain::get_chain_by_real_chain_index(chain_id.to_string())`
  (matches `chainIndex` | `realChainIndex` | `chainName` (case-insens.) | `alias[]`) else
  `chain not found for chainId {id}`; `chainIndex` (string or u64) else `missing chainIndex`; `chainName` else
  `missing chainName`; `load_wallets()` None → `not logged in`; `transfer::resolve_address(wallets, from, chainName)`
  → returns `(chainIndex, address)`.
- `fn random_nonce_hex()` (1404) — 32 OS-random bytes → `0x`+64 lowercase hex.
- `fn normalize_bytes32_hex(v, label)` (1414) — strip all leading `0x`; byte length ≠64 →
  `{label} must be 32 bytes (0x + 64 hex chars), got {n} chars`; non-hex → `{label} contains non-hex characters`;
  returns `0x`+lowercase.
- `async fn emit_session(base, params)` (1608) — `payment_flow::fetch_session(params)`; on Ok merge every key into
  `base` (overwrite); print `output::success(base)` regardless (errors swallowed).
- `fn persist_channel_open(channelId, payer, deposit, initialCum)` (1622) — write `ChannelState{channel_id, owner_wallet: payer ADDRESS, deposit, cumulative: initialCum, created_at=updated_at=now}`; errors ignored.
- `fn session_open_params(channelId, deposit, initialCum)` (1637) — `SessionParams{action:"open", channel_id, cumulative_amount: initialCum, unit_amount:"0", deposit}`.
- `fn voucher_advances_cumulative(unit, new, deposit?)` (1908) — `unit>0 && (deposit None || new<=deposit)`.
  Oracles: (50,150,Some200)=true; (200,200,Some200)=true; (50,250,Some200)=false; (50,250,None)=true; (0,100,*)=false.

### payment_flow.rs

- `enum PaymentTier {Basic, Premium}` (29) — `as_key` → `"basic"`/`"premium"`; `from_server_str` case-insensitive.
- `pub(crate) fn read_private_key()` (63) — `std::env::var("EVM_PRIVATE_KEY")` (even empty string is returned) else read
  `$HOME/.env`: io error → `Wallet not logged in and no EVM_PRIVATE_KEY configured. Either run \`onchainos wallet login\`, or create {path} with a line \`EVM_PRIVATE_KEY=0x<hex_key>\`.`
  (+ io cause); first line whose `trim()` starts with `EVM_PRIVATE_KEY=` with non-empty remainder wins (no quote
  stripping); else `EVM_PRIVATE_KEY not found in {path}`.
- `enum PaymentProof` (109) + `to_pay_json` (157): Eip3009 → `{signature, authorization[, sessionCert]}`;
  Permit2 / Upto → `{signature, permit2Authorization}`; Subscription → `{terms, permitSingle, termsSignature, permitSingleSignature}`.
- `fn select_accept` (208) / `select_accept_with_preference(accepts, preferred)` (215) — empty → `accepts array is empty`;
  preferred → first entry with `asset == pref.asset && network == pref.network` (exact string compare); else first
  `scheme=="exact"`; else first `scheme=="aggr_deferred"`; else `accepts[0]`. Returns `(entry, scheme)`.
- `fn extract_amount` (263) / `resolve_amount(entry, tier)` (274) — `amount` object → needs tier else
  `accepts.amount is a tiered object ({basic, premium}) but no tier was specified`; key missing →
  `accepts.amount is missing '{key}' key`; non string/number → `accepts.amount.{key} must be a string or number`.
  Else `amount` string / u64 → `maxAmountRequired` string / u64 → `missing 'amount' or 'maxAmountRequired' in accepts entry`.
- `fn caip2_to_evm_chain_id(network)` (308) — `network '{n}' is not a CAIP-2 EVM identifier (eip155:<id>)` /
  `network '{n}' has non-numeric chain id` (+ParseIntError).
- `fn resolve_entry(entry, scheme, tier)` (317) — order: `missing 'network' in accepts entry`; resolve_amount;
  `missing 'payTo' in accepts entry`; caip2_to_evm_chain_id; `parse_recipient_addr(payTo, chainId)` with context
  `accepts.payTo` (payTo canonical 0x — XKO normalised); `missing 'asset' in accepts entry`;
  `maxTimeoutSeconds` u64 default **300**.
- `fn x402_pay_from_accepts` (368) — no callers (dead).
- `fn sign_payment(accepts, from, tier)` (376) — `sign_payment_with_preference` with the saved default asset.
- `pub(crate) async fn resolve_chain_and_payer(accepted, from)` (393) — used by subscription + agent a2mcp probe:
  network → chain id → chain entry (`chain not found for realChainIndex {id}`, `missing chainIndex in chain entry`,
  `missing chainName in chain entry`) → wallets (`not logged in`) → resolve_address → `(chainIndex, realChainId, address)`.
- `pub(crate) async fn resolve_chain_and_payer_by_chain(chain, from)` (424) — used by subscription: `chains::resolve_chain` →
  `get_chain_by_index` (`chain not found: {chain}`) → `get_real_chain_index` → wallets → resolve_address.
- `pub(crate) fn prepare_resolved_entry(accepts, tier, preferred)` (452) — array → select_accept_with_preference;
  object → used as-is (scheme from it); `resolve_entry`; if `entry.amount` is an object replace it with the resolved
  scalar string.
- `pub(crate) fn detect_permit2_route(entry, params)` (474) — `is_upto = scheme.lower=="upto"`;
  `is_exact_permit2 = scheme.lower=="exact" && extra.assetTransferMethod.lower=="permit2"`.
- `pub(crate) async fn preflight_permit2_allowance(chainIndex, asset, payer, required)` (491) — `required` U256 decimal
  parse else `invalid required amount (decimal uint256): {v}`; `payment::permit2::rpc::fetch_permit2_allowance`
  (eth_call `allowance(payer, 0x000000000022D473030F116dDEE9F6B43aC78BA3)` to `https://rpc.xlayer.tech`, only for
  chainIndex `196`, 10 s timeout); allowance < required → error
  `Permit2 allowance insufficient on token {asset} for chain {chainIndex}. Current allowance is {a}, but this payment needs {r}. The buyer must first call IERC20.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, MAX) once before any x402 Permit2 payment can be settled.`;
  probe error (incl. "no RPC endpoint configured for chain {c} — Permit2 allowance pre-check unavailable" for every
  non-196 chain) → **stderr** `Warning: Permit2 allowance pre-check unavailable on chain {chainIndex} ({e:#}); falling back to on-chain settle revert` and continue.
- `pub(crate) fn permit2_timing_and_nonce(maxTimeout)` (526) — `validAfter = now-600` (saturating,
  `CLOCK_SKEW_BACKDATE_SECS`), `deadline = now+maxTimeout`, `nonce = decimal(U256 from 32 random bytes BE)`.
- `pub async fn sign_payment_with_preference(accepts, from, tier, preferred)` (552) — the TEE x402 signer:
  1. `prepare_resolved_entry` (all payload validation happens **before** any auth/network).
  2. `ensure_tokens_refreshed()` (may `POST /priapi/v5/wallet/agentic/auth/refresh`).
  3. `parse_eip155_chain_id(network)`; chain entry via `get_chain_by_real_chain_index` (chain cache or
     `POST /priapi/v5/wallet/agentic/chain/support/list` `{}` anonymous) → `chainIndex`, `chainName`
     (errors as in `resolve_chain_and_payer` (393)).
  4. wallets (`not logged in`), `resolve_address(wallets, from, chainName)` → payer address.
  5. scheme `period` (case-insens.) → `payment::subscription::sign::sign_subscribe(chainIndex, chainId, payer, entry)`
     (other partition: GET `/api/v6/pay/x402/buyers/{payer}/allowance-status?token=..&chainIndex=..` anonymous, then
     two TEE EIP-712 signatures) → `PaymentProof::Subscription`.
  6. upto / exact+permit2 → `preflight_permit2_allowance`; timing/nonce; exact → `permit2::sign::sign_exact_permit2`
     (spender `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`), upto → requires `extra.facilitatorAddress` string else
     `upto scheme requires extra.facilitatorAddress in the accepts entry, but it is missing or not a string`, then
     `sign_upto_permit2` (spender `0x4020e7393B728A3939659E5732F87fdd8e680002`). Both = TEE EIP-712
     (`gen-msg-hash` `{chainIndex,payload:[{msgType:"eip712",message}]}` → `sign-msg`
     `{chainIndex,from,sessionCert,payload:[{signType:"eip712",message,sessionSignature}],skipWarning:true}`, contexts
     `permit2 gen-msg-hash failed` / `permit2 sign-msg failed`). → `PaymentProof::Permit2|Upto` with
     `permit2Authorization {from, permitted{token,amount}, spender, nonce, deadline, witness{to,[facilitator,]validAfter}}`.
  7. EIP-3009 / aggr_deferred: `validBefore` = aggr_deferred ? U256::MAX decimal
     (`115792089237316195423570985008687907853269984665640564039457584007913129639935`) : `now+maxTimeoutSeconds`
     (`timeout overflow`); `nonce = random_nonce_hex`; `base = {chainIndex, from: payer, to: payTo, value: amount,
     validAfter:"0", validBefore, nonce, verifyingContract: asset}`; `load_session` / keyring `session_key`
     (`not logged in`); `POST gen-msg-hash` body = base (**no msgType**; context `payment gen-msg-hash failed`;
     needs `msgHash` + `domainHash`); `sessionSignature = base64std(ed25519(seed, msgHashBytes))`;
     `authorization = {from, to, value, validAfter:"0", validBefore, nonce}`.
     - aggr_deferred → **no sign-msg**; proof `Eip3009{signature: sessionSignature, authorization, session_cert: Some(session.session_cert)}`.
     - otherwise → `POST sign-msg` body = base + `domainHash`, `sessionCert`, `sessionSignature` (**no skipWarning**);
       context `payment sign-msg failed`; `data[0].signature` → proof `Eip3009{signature, authorization, None}`.
     Returns `(proof, entry)`.
- `pub async fn sign_payment_local(accepts, tier)` (814) → `sign_payment_local_with_preference(…, None)` (833):
  1. `prepare_resolved_entry`; if picked scheme is aggr_deferred → re-run on accepts with all aggr_deferred entries
     removed (if any remain). Still aggr_deferred →
     `aggr_deferred requires a TEE session key — not supported in local-key mode. Run \`onchainos wallet login\` to enable TEE signing.`
  2. upto / exact+permit2 → `sign_permit2_local_inner` (980): key (below), `payer = lowercase 0x address`, chain entry
     lookup (network), `preflight_permit2_allowance`, timing/nonce, `sign_upto_permit2_local` / `sign_exact_permit2_local`
     (EIP-712 digest signed with secp256k1, v+27, `0x`+hex).
  3. EIP-3009: `extra.name` string else `missing 'extra.name' (EIP-712 domain name) in accepts entry`; version =
     `extra.version` or `"2"`; key = `read_private_key()` trimmed, optional `0x`; hex else
     `EVM_PRIVATE_KEY is not valid hex`; length ≠32 → `EVM_PRIVATE_KEY must be 32 bytes (64 hex chars), got {n}`;
     invalid scalar → `invalid secp256k1 private key: {e}`; `from = format!("{:#x}")` (lowercase);
     chainId from network; `validBefore = now+maxTimeoutSeconds`; 32 random nonce bytes; EIP-712
     `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`
     with domain `{name, version, chainId, verifyingContract: asset}` (errors `payTo is not a valid EVM address`,
     `amount not a valid integer: {e}`, `asset is not a valid EVM address`); secp256k1 sign, v∈{27,28};
     `signature = 0x + hex(r‖s‖v)`; `authorization = {from, to: payTo, value: amount, validAfter:"0", validBefore, nonce: 0x…}`.
- `pub async fn sign_payment_auto(accepts, tier)` (1090) — used by `ApiClient` auto-pay (client.rs:1512): loads saved
  default once; `wallets.json` exists → TEE path, else `warn_local_signing_once()` + local path.
  `warn_local_signing_once` (1123) prints once per process **and** once per cache lifetime (stderr
  `[onchainos] payment signed locally with EVM_PRIVATE_KEY (NOT protected by TEE); run \`onchainos wallet login\` for TEE signing.`)
  then sets `payment_cache.local_signing_warned=true` (re-load-then-save).
- `pub fn build_payment_header(proof, entry, url)` (1152) — `assemble_v2_payment_header` with resource
  `{"url":url,"mimeType":"application/json"}` (used by ApiClient auto-pay).
- `pub fn assemble_v2_payment_header(proof, entry, resource)` (1175) — `accepted = entry.clone()`; for Eip3009 with
  `session_cert` Some → insert `accepted.extra.sessionCert = cert` (creates `extra:{}` if absent; no-op if `extra`
  is non-object; other extra keys preserved). `body = {"x402Version":2,"resource":resource,"accepted":accepted,
  "payload":<inner>}` with inner = Eip3009 `{signature, authorization}` (sessionCert NOT in payload) / Permit2+Upto
  `{signature, permit2Authorization}` / Subscription `{terms, permitSingle, termsSignature, permitSingleSignature}`.
  Header value = base64 **STANDARD (padded)** of compact sorted JSON. Returns `("PAYMENT-SIGNATURE", value)`.
- `pub fn pay_with_header_json(proof, entry, resource)` (1249) — `{"authorization_header": value, "header_name":
  "PAYMENT-SIGNATURE", "scheme": entry.scheme or "", "wallet": to_pay_json().authorization.from ??
  permit2Authorization.from ?? null}` (Subscription → `wallet:null`).
- `pub(crate) fn parse_eip155_chain_id(network)` (1270) — `unsupported network format: expected 'eip155:<chainId>', got '{n}'` /
  `invalid chain ID '{id}': must be a valid unsigned integer`.
- `pub fn is_mainnet_chain` (1295) → `chains::is_mainnet_chain` (core).
- `fn scheme_rank` (1305): aggr_deferred 0, exact 1, upto 2, charge 3, other 4.
- `fn cmp_candidates` (1318): same `token_symbol` → smaller `amount` (u128, unparseable = MAX) first; then mainnet
  first; then scheme_rank.
- `pub fn rank_candidates(cands)` (1345) — used by quote.rs. Stable sort: `balance_status=="sufficient"` first, then
  cmp_candidates. `multi` = ≥2 distinct schemes among {exact, aggr_deferred, charge}. Not multi → winner =
  first, `recommended = Some(true)` iff sufficient else None; rest `Some(false)` → `([winner], rest)`. Multi and no
  sufficient → all `recommended=None`, `(all, [])`. Else winner Some(true), rest Some(false).
- `struct PayResult` (1414) — serialized (sorted) as
  `{"decodedReceipt","error","ok","paymentId","result","scheme","status","txHash"}`.
- `fn now_unix` (1431) — `chrono::Utc::now().timestamp().max(0)`.
- `fn parse_kv(params)` (1436) — split at first `=` else `invalid_input: --param must be key=value, got '{raw}'`;
  key trimmed, empty → `invalid_input: --param key must not be empty`; value verbatim.
- `fn pay_confirming(st, selected_index)` (1463) — message:
  - candidate = (index given) first `candidates[].acceptsIndex == i`; (no index) first `recommended==true` else
    `candidates[0]` → `"{verb} {amountHuman} {tokenSymbol} ({scheme}, {chainName}) to {decoded_challenge.recipient} - confirm to proceed"`;
  - else (index given, `st.accepts[i]` exists) → `"{verb} {a.amount} {a.asset} ({a.scheme}) to {recipient} - confirm to proceed"`;
  - else `"Will pay {decoded_challenge.amountHuman} to {recipient} - confirm to proceed"`.
  `verb` = `Will pay up to` when scheme eq-ignore-case `upto`, else `Will pay`.
  next = `onchainos payment pay --payment-id {id}` + (` --selected-index {i}` if given) + ` --yes`.
- `pub async fn fetch_pay(payment_id, selected_index, params, yes)` (1522) — CLI + MCP `payment_pay` entry; see command.
- `async fn pay_a2mcp_intent(id, owner)` (1576) — A2MCP intent execution (state machine owned by a2mcp.rs):
  `read_a2mcp_payment_intent` (validates; owner ≠ `owner_account_id` → `cross_user_payment_id: {id}`;
  `now >= expires_at` → persist `expired` + `a2mcp_payment_intent_expired: {id}`) → `begin_signing(now)` (must be
  `prepared` else `a2mcp_payment_already_executed: {id}`; persisted) → loop: `record_signature_attempt()` (persisted,
  max 3) → `sign_payment_with_preference([selected_accept.raw], Some(payer_address), None, None)`; on error retry only
  if attempts<3 and lower-cased `{e:#}` contains one of `payment gen-msg-hash failed`, `payment sign-msg failed`,
  `permit2 gen-msg-hash failed`, `permit2 sign-msg failed`, `missing signature in sign-msg response`,
  `missing msghash in gen-msg-hash response`; else `mark_failed_terminal` + Err → `mark_proof_generated` → header
  (resource Some → v2 header; None → base64(to_pay_json)); header error → failed_terminal + Err → `mark_replaying`
  → exactly one `replay_a2mcp_merchant` → `success`/`pending_terminal`/`failed_terminal` persisted →
  `PayResult{scheme: selected_accept.scheme}`. Intent file is never deleted.
- `fn is_retryable_a2mcp_signing_authorization_error` (1648) — see above.
- `async fn replay_a2mcp_merchant(url, method, plan, typed_params, hname, hval)` (1750) — reqwest client 30 s timeout,
  **redirects disabled**; `http_carrier::build_typed_request` (error → failed) + signed header; send error → failed;
  `map_http_replay_response`.
- `fn failed_replay(err)` (1782) → `("failed", None, null, Some(err), None)`.
- `async fn map_http_replay_response` (1787) / `fn map_replay_parts(code, paymentResponse, result)` (1802) — body text →
  JSON if parseable else JSON string; `PAYMENT-RESPONSE` header → `decode_receipt::decode_receipt(Some(h), None)`
  (errors ignored) → `decodedReceipt` (sorted `{amount,chainId,payer,status,transaction}`), `txHash` =
  receipt.transaction if non-empty. 2xx → `success`, error null; 402 → `pending`, error
  `facilitator non-terminal: HTTP 402`; other → `failed`, error `merchant returned HTTP {code}`.
- `async fn pay_from_state(st, idx, biz)` (1683) — generic two-phase pay (see command).
- `async fn replay_merchant(url, method, plan, hname, hval, biz, …)` (1847) — reqwest client 30 s timeout, **default
  redirect policy (follows up to 10)**; `http_carrier::build_request(client, method, url, biz, plan)` + signed header;
  transport error → `("failed", None, null, Some(e.to_string()), None)`; else same mapping as `map_replay_parts`
  (402 error text `facilitator non-terminal: HTTP 402`).
- `async fn replay_mcp(st, tool, hname, sig, biz)` (1949) — `mcp_client::McpClient::new(endpoint_url)` →
  `initialize()` (JSON-RPC `initialize` + `notifications/initialized`, captures `Mcp-Session-Id`) → args =
  `merge_mcp_replay_args` → `call_tool_signed(McpReplay{session_id:None, tool, arguments}, hname, sig)` →
  `(status, PAYMENT-RESPONSE, result)`; any client error → failed with `e.to_string()`; mapping identical to REST.
  (mcp_client.rs is owned by another partition.)
- `async fn merge_mcp_replay_args` (2048) — no pay-time params → persisted `known_params`; else `tools/list` (best
  effort) to find the tool's `inputSchema` → `apply_param_overrides` (2072): persisted map, overlay pay-time values
  coerced by `mcp_client::coerce_arguments` (strings when no schema). Pay-time wins. Oracle: known {q:"hello",keep:"x"},
  biz [(q,"world"),(n,"5")], schema n:integer → `{keep:"x", n:5, q:"world"}`.
- `struct SessionParams` (2092) `{action, channel_id?, challenge?, unit_amount?, cumulative_amount?, escrow?, chain_id?, deposit?, from?, reuse_signature?, server_cumulative?}`
  (MCP `payment_session` tool maps 1:1; `challenge/escrow/chain_id/from` are unused by `fetch_session`).
- `struct SessionData` (2115) → `{strategy, cumulative_amount, needsTopUp, sessionSnapshot, refund?, recovery?, reason_text?}` (Nones omitted).
- `fn needs_top_up(cur, unit, dep)` (2131) = `cur+unit > dep` (saturating); `compute_refund(dep, final)` (2136) =
  `dep - final` saturating; `classify_recovery(cur, unit, dep)` (2142): `cur+unit>dep` → `amount_exceeds_deposit`;
  else `unit==0` → `delta_too_small`; else None.
- `pub async fn fetch_session(p)` (2166) — pure decision layer (no I/O):
  ```
  cur = u128(p.cumulative_amount) or 0; unit = u128(p.unit_amount) or 0
  dep = u128(p.deposit) or 0; has_dep = p.deposit.is_some()
  drift = u128(p.server_cumulative) if parseable and != cur
  base = drift ?? cur; new = base + unit (saturating)
  needs = has_dep && base+unit > dep
  recovery = has_dep ? classify_recovery(base, unit, dep) : None
  strategy = needs ? "topup" : drift ? "sign" : (p.reuse_signature && !recovery) ? "reuse" : "sign"
  reason_text = recovery: "amount_exceeds_deposit" → "voucher cumulative exceeds the channel deposit"
                          "delta_too_small"        → "voucher delta is zero — nothing to authorize"
                (if none and drift) → "voucher cumulative drifted (70015): server cumulative {base}, recomputed to {new} and resigned"
  refund = (p.action=="close" && has_dep) ? dep - new (saturating) : None
  sessionSnapshot = {"channelId": p.channel_id|null, "deposit": p.deposit|null, "cumulative": new}
  ```
  Oracles: close dep 100000 cum 40000 unit 0 → refund `"60000"`, cumulative_amount `"40000"`; voucher reuse cum 100
  unit 50 dep 1000 → `reuse`, `"150"`, needsTopUp false; cum 40 unit 20 dep 50 → `topup`, needsTopUp true, recovery
  `amount_exceeds_deposit`; drift server 130 vs 100 unit 20 → `sign`, `"150"`, reason contains `70015`.

### http_carrier.rs

- `fn is_body_bearing(m)` (17) — upper(m) ∈ {POST, PUT, PATCH, DELETE}.
- `fn carrier_for(name, plan, body_bearing)` (26) — plan entry with `name` → its carrier; else Body if body-bearing
  else Query.
- `pub fn build_request(client, method, url, params:[(k,v)], plan)` (46) — for each param in order:
  Path → `url.replace("{k}", pct(v))` where `pct` = `utf8_percent_encode(v, NON_ALPHANUMERIC)` (**every byte except
  `[A-Za-z0-9]` → `%XX` uppercase**, e.g. `a b/c?d#e&f` → `a%20b%2Fc%3Fd%23e%26f`; `-._~` are encoded too);
  Query → appended via `reqwest .query()` (form-urlencoded: space→`+`, keep `[A-Za-z0-9*-._]`, appended with `&` to
  any existing query); Body → `body[k] = v` (JSON string); Header → header `k: v`. Method =
  `Method::from_bytes(upper(method))` or GET on failure. JSON body (`content-type: application/json`, compact,
  sorted keys) only when body-bearing **and** non-empty. Unmatched `{x}` placeholders stay in the URL.
- `pub fn build_typed_request(client, method, url, params:Map, plan)` (101) — A2MCP only. Method parsed as-is (no
  upper-casing) else `a2mcp_invalid_typed_params: invalid HTTP method`. Body carrier on non-body method →
  `a2mcp_invalid_typed_params: body parameter '{key}' is invalid for {method}`; body keeps JSON types. Non-body carriers
  need scalars (`null`→"null", bool, number, string) else
  `a2mcp_invalid_typed_params: non-body parameter '{key}' must be scalar`; Path requires placeholder else
  `a2mcp_invalid_typed_params: path placeholder '{k}' is missing`. JSON body sent when body-bearing and (non-empty or
  method eq-ignore-case POST) → empty POST sends `{}` with `content-type: application/json`.

### state.rs (quote → pay state)

- Tokens: `TOKEN_QUOTE_EXPIRED_OR_MISSING = "quote_expired_or_missing"`, `TOKEN_CROSS_USER = "cross_user_payment_id"`;
  `MAX_QUOTE_TTL_SECS = 300`.
- `fn compute_expires_at(challengeExp, created)` (199) — `challengeExp==0 ? created+300 : min(challengeExp, created+300)`.
- `fn payments_dir()` (209) — `$HOME/payments/` `create_dir_all` (default permissions; context
  `failed to create ~/.onchainos/payments`). `state_path(id)` (216) = `payments/{id}.json` (**created as a side effect
  of any lookup**).
- `PaymentState::write` (224) — `to_string_pretty` → `{id}.json.tmp` → rename.
- `fn read(id, owner, now)` (240) — read/parse failure → `quote_expired_or_missing: {id}` (no cause); owner mismatch →
  `cross_user_payment_id: {id}` (checked before TTL); `now > expires_at` → delete file + `quote_expired_or_missing: {id}`.
- `fn cleanup(id)` (257) — best-effort delete.
- `fn current_owner_id()` (265) — `wallets.json.selected_account_id` if non-empty, else None.
- **File schema** `$HOME/payments/{paymentId}.json` (pretty JSON, struct order):
  ```
  { "payment_id": str, "owner_wallet": str (selected account id, "" if not logged in),
    "created_at": u64, "expires_at": u64,
    "accepts": [ {"index":usize,"scheme":str,"amount":str,"asset":str,"network":str} ],
    "decoded_challenge": {"amount":str,"amountHuman":str,"decimals":u32,"recipient":str,"expires":u64,
                          "supported":bool,"unsupported_reason":str|null},
    "candidates": [ {"scheme","acceptsIndex","chainId","chainName","isMainnet","tokenSymbol","amount","amountHuman",
                     "decimals"(default 0),"hasBalance","balanceStatus"(default "unavailable"),"availableAmount"(""),
                     "requiredAmount"(""),"shortfall"(""),"depositAddress"(""),"recommended": bool|null} ],
    "known_params": {..sorted..}, "merchant_body": str, "endpoint_url": str,
    "raw_accepts": [Value] (default []), "resource": Value (omitted when None),
    "method": str (default "GET"), "param_plan": [ {"name","carrier":"query|body|header|path"(default query),
    "required": bool(default false), "type": str (omitted when empty)} ], "mcpTool": str (omitted when None) }
  ```
  The same directory also holds A2MCP intents (`source:"okx_ai_a2mcp"`, camelCase, written by a2mcp.rs via
  `home::atomic_write` with 0600/0700) — discriminated by the presence of `source`.

### session_state.rs (MPP channel state)

- `ChannelState` (25) — file `$HOME/sessions/{sanitize(channelId)}.json`, pretty JSON:
  `{"channel_id","owner_wallet","deposit","cumulative","created_at","updated_at"}` (strings except the two u64).
  `sanitize` keeps only `[0-9A-Za-z_-]` (e.g. `../../etc/passwd` → `etcpasswd`). Dir created with default perms
  (context `failed to create ~/.onchainos/sessions`). `write` = tmp (`.json.tmp`) + rename; `read` = best-effort
  (None on missing/corrupt); `cleanup` best-effort delete; `now_unix` = SystemTime secs.
  No owner check is ever applied on read.

### decode_receipt.rs

- `pub fn decode_receipt(header, receipt)` (29) — header trimmed non-empty → `decode_payment_blob`; else receipt
  trimmed non-empty → JSON parse; else/any failure → `invalid_input: could not decode receipt`. Header wins when both.
- `fn pick(v, keys)` (53) — first key whose value is a non-empty string (verbatim) or a number (`to_string`).
- `fn normalize(v)` (69) → `{status: pick(status) ?? (success==true ? "success" : success==false ? "failed" : "unknown"),
  transaction: pick(transaction, txHash, transactionHash) ?? "", amount: pick(amount, value) ?? "",
  payer: pick(payer, from) ?? "", chainId: pick(chainId, network, chain_id) ?? ""}`.
- `pub fn fetch_decode_receipt` (46) — serialized (sorted) `{"amount","chainId","payer","status","transaction"}`;
  MCP `payment_decode_receipt` uses it too.

### addr.rs

- `pub(crate) fn is_valid_evm_address(a)` (17) — `0x` + 40 hex; if the 40 chars contain both lower- and upper-case
  letters, EIP-55 must match (keccak of lowercase hex; nibble ≥8 ⇒ uppercase). Oracles: `0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`
  valid; `0x5AAeb6…` invalid; all-lower / all-upper valid.
- `require_evm_address(a, label)` (33) — `{label} is not a valid EVM address: {a}` (used by a2a_pay).
- `XKO_PREFIX = "XKO"` (63); X Layer chain id 196.
- `pub(crate) fn parse_recipient_addr(input, chainId)` (73) → `(canonical0x, display)`: `XKO…` (case-sensitive
  prefix) off chain 196 → `XKO-prefixed addresses are only supported on X Layer (chainId 196), got {id}`; body invalid
  → `XKO address body must be 40 hex chars (EIP-55 checksummed if mixed case): {input}`; `XKO<body>` → (`0x<body>`,
  input). Valid `0x` → (input, input). Else `not a valid EVM address (expected \`0x...\` or XLayer \`XKO...\`): {input}`.
- `require_recipient_format(input, label)` (101) — format-only variant (used by a2a_pay).

### External helpers (owned elsewhere; one-line summaries)

- `commands::agentic_wallet::auth::ensure_tokens_refreshed` (auth/mod.rs:132) — returns a valid access token, refreshing via `POST /priapi/v5/wallet/agentic/auth/refresh` `{refreshToken}` when near expiry.
- `commands::agentic_wallet::auth::format_api_error` (auth/mod.rs:338) — `ApiCodeError` → `code={code} msg={msg}`.
- `commands::agentic_wallet::chain::get_chain_by_real_chain_index` (chain.rs:85) — chain list (cache TTL 600 s else `POST /priapi/v5/wallet/agentic/chain/support/list` `{}` via `post_public`), match by chainIndex/realChainIndex/chainName/alias.
- `commands::agentic_wallet::transfer::resolve_address` (transfer/mod.rs:26) — `from` Some → scan all accounts for (address eq-ignore-case, chainName) else `no address matches from={from} chain={chain}`; None → selected account: `no currentAccountId` / `not found currentAccountId` / `no address for chain={chain} in account={acct}`.
- `wallet_api::WalletApiClient::{post_public, post_authed}` (wallet_api.rs:815/896) — base URL + path, anonymous/JWT headers, 30 s, DoH failover, `{code,msg,data}` unwrap.
- `crypto::{hpke_decrypt_session_sk, ed25519_sign, ed25519_sign_hex, eip3009_sign}` (crypto.rs:39/106/170/248).
- `payment::permit2::rpc::fetch_permit2_allowance` (payment/permit2/rpc.rs:45) — eth_call to `https://rpc.xlayer.tech` (chain 196 only).
- `payment::permit2::sign::{sign_exact_permit2, sign_upto_permit2, *_local}` (payment/permit2/sign.rs:52/80/119/150).
- `payment::subscription::sign::sign_subscribe` (payment/subscription/sign.rs:436) — `period` scheme double-sign.
- `commands::payment::a2mcp::{inspect_payment_source, read_a2mcp_payment_intent, A2mcpPaymentIntentV1::*}` (a2mcp.rs:589/603/373).
- `commands::payment::quote::{run, fetch_quote}` (quote.rs:76/89) — `payment quote` handler.
- `mcp_client::{McpClient, coerce_arguments}` (mcp_client.rs) — MCP streamable-HTTP client.
- `payment_cache::PaymentCache::{load, save}` (payment_cache.rs:86/97) — `$HOME/payment_cache.json`, compact struct JSON, tmp+rename; load returns None on missing/corrupt.

---

## Commands

### `onchainos payment pay`  (hidden: no) — mode A: legacy sign-only (`--payload`)

- Handler: `dispatcher::execute` (dispatcher.rs:292) → `cmd_pay` (dispatcher.rs:551).
- Options:
  - `--payload <PAYLOAD>` String; `required_unless_present = "payment_id"`, `conflicts_with = "payment_id"`.
  - `--payment-id <PAYMENT_ID>` String (selects mode B).
  - `--selected-index <SELECTED_INDEX>` usize, optional (non-numeric/negative → clap error exit 2).
  - `--param <PARAM>` Vec<String>, repeatable — **ignored in mode A**.
  - `--yes` bool flag, visible alias `--force` — **ignored in mode A**.
  - global `--chain` accepted and ignored.
- Auth: jwt-required + session-key signature (TEE). (`period` scheme additionally anonymous allowance-status read.)
- Steps:
  1. `decode_pay_payload(payload)` (errors: `could not decode payment blob: …`, `--payload decoded to JSON without an 'accepts' field`).
  2. If `--selected-index i`: `accepts = select_accepts_index(accepts, i)` (errors above).
  3. `sign_payment_with_preference(accepts, from=None, tier=None, preferred=None)` — the saved default asset is **not**
     consulted; auto-select exact > aggr_deferred > first. Full sequence in helper (payment_flow.rs:552):
     `[auth/refresh]` → `[chain/support/list]` → (EIP-3009) `gen-msg-hash` → (`exact`/other non-deferred) `sign-msg`;
     (permit2/upto) `[eth_call rpc.xlayer.tech]` + EIP-712 `gen-msg-hash` + `sign-msg`; (period) allowance-status + 2×EIP-712.
  4. `emit_pay_result(proof, entry, decoded.resource)`.
- Output (`data`, keys sorted):
  - payload has `resource` (x402 v2): `{"authorization_header":"<base64 PAYMENT-SIGNATURE JSON>","header_name":"PAYMENT-SIGNATURE","scheme":"<entry.scheme or \"\">","wallet":"<payer>"|null}`.
    Decoded header JSON: `{"accepted":<selected entry, sorted; +extra.sessionCert for aggr_deferred>,"payload":{"authorization":{"from","nonce","to","validAfter":"0","validBefore","value"},"signature":"…"},"resource":<payload.resource verbatim (sorted)>,"x402Version":2}`.
  - no `resource` (v1): raw proof, e.g. `{"authorization":{…},"signature":"0x…"}` (+`"sessionCert"` for aggr_deferred),
    or `{"permit2Authorization":{…},"signature":"0x…"}`, or subscription 4-key form.
  - `signature`: exact = TEE `sign-msg` value; aggr_deferred = base64 Ed25519 session signature.
- Errors (exit 1): payload decode errors; `resolve_entry` errors (`missing 'network' in accepts entry`, `accepts.payTo: …`, …);
  `session expired, please login again: onchainos wallet login`; `chain not found for realChainIndex {id}`; `not logged in`;
  `no address for chain=… in account=…`; `payment gen-msg-hash failed: code=… msg=…`; `payment sign-msg failed: …`;
  `missing msgHash in gen-msg-hash response`; `missing domainHash in gen-msg-hash response`;
  `missing signature in sign-msg response`; Permit2 allowance insufficient; upto facilitator missing.
  Clap: missing both `--payload` and `--payment-id`, or both given → exit 2.
- Side effects: FUND-MOVING authorisation (TEE `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` produces a
  settle-able EIP-3009/Permit2 authorisation; nothing broadcast). May refresh tokens (keyring) and chain cache.
- Nondeterminism: `nonce` (random 32 bytes), `validBefore` (now + maxTimeoutSeconds), Permit2 `nonce`/`deadline`/`validAfter`,
  TEE signature; aggr_deferred session signature varies with nonce.
- Parity test cases:
  1. `onchainos payment pay` → clap error exit 2 (SAFE).
  2. `onchainos payment pay --payload '@@@'` → `{"ok":false,"error":"could not decode payment blob: not a WWW-Authenticate challenge, base64-encoded JSON, or plain JSON"}` exit 1 (SAFE).
  3. `onchainos payment pay --payload eyJ4NDAyVmVyc2lvbiI6Mn0` (`{"x402Version":2}`) → `--payload decoded to JSON without an 'accepts' field` (SAFE).
  4. `onchainos payment pay --payload <PAYLOAD below> --selected-index 5` → `--selected-index 5 is out of range (accepts has 1 entry)` (SAFE).
  5. Logged-out `onchainos payment pay --payload <PAYLOAD>` → `session expired, please login again: onchainos wallet login` (SAFE); logged-in same → UNSAFE (TEE sign-msg).
  PAYLOAD = `eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRzIjpbeyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6MTk2IiwiYW1vdW50IjoiMTAwMDAwMCIsInBheVRvIjoiMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIiwiYXNzZXQiOiIweDIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNERyIsInZlcnNpb24iOiIxIn19XX0=`
  (one `exact` entry on eip155:196, amount 1000000, payTo 0x1111…, asset 0x2222…, extra {name USDG, version 1}).

### `onchainos payment pay --payment-id <ID>`  (hidden: no) — mode B: two-phase complete

- Handler: `dispatcher::cmd_pay_two_phase` (dispatcher.rs:572) → `payment_flow::fetch_pay` (payment_flow.rs:1522).
  Same function backs MCP tool `payment_pay`.
- Options: `--payment-id` (required for this mode), `--selected-index` (index into **raw accepts[]** order, not
  candidate order), `--param k=v` (repeatable), `--yes`/`--force`. `--payload` conflicts.
- Auth: jwt-required + session-key signature; merchant replay is unauthenticated except the `PAYMENT-SIGNATURE` header.
- Steps:
  1. `owner = current_owner_id() ?? ""`.
  2. `a2mcp::inspect_payment_source(id)`: id must match `^[A-Za-z0-9_-]{1,128}$` else
     `a2mcp_invalid_payment_intent: invalid payment id`; read `$HOME/payments/{id}.json` (creates `payments/` dir) else
     `quote_expired_or_missing: {id}: <io error>`; JSON parse else `quote_expired_or_missing: {id}: <serde error>`;
     `source` absent → generic; `"okx_ai_a2mcp"` → A2MCP; other → `a2mcp_invalid_payment_intent: unknown payment source`.
  3. **A2MCP branch**: `--selected-index` or any `--param` → `a2mcp_payment_overrides_forbidden: A2MCP payment intent does not accept pay-time overrides`;
     no `--yes` → `a2mcp_payment_confirmation_required: payment pay requires --yes` (plain error exit 1 — **no** confirming card);
     else `pay_a2mcp_intent` (helper above) → output PayResult.
  4. **Generic branch**: `state::read(id, owner, now)` (errors: `quote_expired_or_missing: {id}` for unparseable-as-PaymentState,
     `cross_user_payment_id: {id}`, expired → file deleted + `quote_expired_or_missing: {id}`; expiry test `now > expires_at`).
  5. `--selected-index i` with `i >= raw_accepts.len()` → `invalid_input: --selected-index {i} is out of range (accepts has {n} entr{y|ies})`.
  6. `parse_kv(--param)` (errors above).
  7. Not `--yes` → confirming (exit 2), **no network, no signing**:
     `{"confirming":true,"message":"<pay_confirming message>","next":"onchainos payment pay --payment-id <id>[ --selected-index <i>] --yes"}`.
  8. `pay_from_state`: `accepts = [raw_accepts[i]]` or all `raw_accepts`; `sign_payment_with_preference(accepts, None, None, None)`;
     header = `assemble_v2_payment_header(proof, entry, st.resource)` when `resource` present, else
     `("PAYMENT-SIGNATURE", base64std(json(to_pay_json)))`.
  9. Replay: `mcpTool` set → `replay_mcp` (persisted `known_params` merged with pay-time params); else
     `replay_merchant(endpoint_url, method, param_plan, header, pay-time params only)` —
     **the quote-time `known_params` are NOT re-sent on the REST replay** (only `--param` supplied to `pay`).
     REST request: `<METHOD> <endpoint_url with path substitutions>[?query]`, headers `payment-signature: <value>` +
     header-carrier params (+ reqwest default `accept: */*`; `content-type: application/json` when a JSON body is sent),
     30 s timeout, redirects followed.
  10. `status=="success"` → delete `payments/{id}.json`; pending/failed keep it.
- Output (`data`, exit 0 for all three statuses):
  `{"decodedReceipt":{"amount","chainId","payer","status","transaction"}|null,"error":null|"facilitator non-terminal: HTTP 402"|"merchant returned HTTP <n>"|"<transport error>","ok":<status=="success">,"paymentId":"<id>","result":<merchant JSON or string or null>,"scheme":"<signed entry scheme>","status":"success"|"pending"|"failed","txHash":"<receipt.transaction>"|null}`.
  (Envelope `ok` is always `true` on this path; `data.ok` mirrors status.)
- Errors: steps 2–6 (exit 1); step 7 (exit 2 confirming); signing errors from step 8 (exit 1; state kept).
- Side effects: FUND-MOVING — TEE `POST …/pre-transaction/sign-msg` + merchant replay (settlement by merchant/facilitator).
  Local: deletes quote state on success / on expiry; A2MCP intent execution state transitions persisted.
- Nondeterminism: signature/nonce/validBefore inside the header; merchant response.
- Parity test cases:
  1. `onchainos payment pay --payment-id 'bad id!'` → `{"ok":false,"error":"a2mcp_invalid_payment_intent: invalid payment id"}` (SAFE).
  2. `onchainos payment pay --payment-id pay_doesnotexist0000000000 --yes` → `quote_expired_or_missing: pay_doesnotexist0000000000: <os error>` exit 1 (SAFE; compare prefix).
  3. Seeded state file (generic, `expires_at` far future, `owner_wallet` = current account) + `onchainos payment pay --payment-id <id> --selected-index 0` → confirming JSON exit 2 (SAFE).
  4. Same seeded state + `--param novalue` → `invalid_input: --param must be key=value, got 'novalue'` (SAFE).
  5. Seeded state + `--yes` against a local mock merchant → UNSAFE (real TEE signature).

### `onchainos payment quote <URL>`  (hidden: no) — dispatch only

- Handler: `dispatcher::execute` (dispatcher.rs:309) → `quote::run(url, param, method, tool)` (quote.rs:76; other partition).
- Options (declared here): positional `<URL>` (required String); `--param <k=v>` repeatable; `--method <METHOD>`
  default `"GET"`; `--tool <TOOL>` optional (forces MCP branch).
- Auth: jwt-optional (owned by quote partition; uses `current_owner_id` and ApiClient balance preflight).
- Steps: see quote spec. Relevant to this partition: on a paid challenge quote writes `payments/{paymentId}.json`
  (schema above) with `paymentId = "pay_" + first 12 bytes hex of sha256(url ‖ created_at LE ‖ nanos LE)`,
  `expires_at = compute_expires_at(challenge.expires, created_at)`, `candidates = winner ++ alternatives`
  (`rank_candidates`), `next_step = "onchainos payment pay --payment-id {id} --selected-index <n> --yes"`.
- Output / errors / parity: see quote spec.
- Side effects: read (merchant probe) + local state write.

### `onchainos payment decode-receipt`  (hidden: no)

- Handler: `dispatcher::cmd_decode_receipt` (dispatcher.rs:586) → `decode_receipt::fetch_decode_receipt` (decode_receipt.rs:46).
- Options: `--header <HEADER>` (`required_unless_present = "receipt"`, `conflicts_with = "receipt"`); `--receipt <RECEIPT>`.
- Auth: anonymous.
- Steps: `decode_receipt(header, receipt)` → `normalize` (helper). No I/O.
- Output: `{"amount":"…","chainId":"…","payer":"…","status":"…","transaction":"…"}` (missing → `""`; status default `"unknown"`).
- Errors: `invalid_input: could not decode receipt` (exit 1); clap exit 2 when neither or both flags.
- Side effects: read-only (no network, no files).
- Nondeterminism: none.
- Parity test cases (all SAFE):
  1. `onchainos payment decode-receipt --receipt '{"status":"success","txHash":"0xdef456","amount":"10000","from":"0xfrom","chainId":"196"}'` →
     `{"ok":true,"data":{"amount":"10000","chainId":"196","payer":"0xfrom","status":"success","transaction":"0xdef456"}}`.
  2. `onchainos payment decode-receipt --header eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4YWJjMTIzIiwibmV0d29yayI6Ijg0NTMiLCJwYXllciI6IjB4cGF5ZXIifQ==` →
     `{"ok":true,"data":{"amount":"","chainId":"8453","payer":"0xpayer","status":"success","transaction":"0xabc123"}}`.
  3. `onchainos payment decode-receipt --receipt '{bad json'` → `{"ok":false,"error":"invalid_input: could not decode receipt"}` exit 1.
  4. `onchainos payment decode-receipt --receipt '{"success":false,"transaction":"0x0"}'` → status `failed`.
  5. `onchainos payment decode-receipt --receipt '{"status":"success","transactionHash":"0xaaa","value":"42","from":"0xf","chainId":8453}'` → `chainId:"8453"`, `amount:"42"`.

### `onchainos payment pay-local`  (hidden: no)

- Handler: `dispatcher::execute` (dispatcher.rs:318) → `payment_flow::sign_payment_local` (payment_flow.rs:814).
- Options: `--payload <PAYLOAD>` required String. Env: `EVM_PRIVATE_KEY` (fallback `$HOME/.env`).
- Auth: anonymous (local private key; no wallet session). Permit2/upto path calls the anonymous chain-list endpoint + RPC.
- Steps: `decode_pay_payload` → `sign_payment_local(accepts, None)` (no default-asset preference, no `--selected-index`,
  aggr_deferred filtered out if something else is signable) → `emit_pay_result(proof, entry, resource)`. No stderr
  "signed locally" warning (that is only emitted by the auto-pay path).
- Output: same shapes as `payment pay` mode A; `wallet` = lowercase address derived from the key; EIP-3009 signature
  `0x`+130 hex (v=27/28).
- Errors: payload errors; `missing 'extra.name' (EIP-712 domain name) in accepts entry`; `aggr_deferred requires a TEE session key — …`;
  key errors (`Wallet not logged in and no EVM_PRIVATE_KEY configured. …: <io>`, `EVM_PRIVATE_KEY not found in {path}`,
  `EVM_PRIVATE_KEY is not valid hex: …`, `EVM_PRIVATE_KEY must be 32 bytes (64 hex chars), got {n}`); `amount not a valid integer: …`.
- Side effects: FUND-MOVING authorisation produced locally (EIP-3009/Permit2 signature for the key's wallet); no network
  on the EIP-3009 path.
- Nondeterminism: nonce, validBefore, signature (Permit2: nonce/deadline/validAfter).
- Parity test cases:
  1. `EVM_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 onchainos payment pay-local --payload <PAYLOAD>` →
     data `{"authorization_header":"…","header_name":"PAYMENT-SIGNATURE","scheme":"exact","wallet":"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"}` (SAFE with this throwaway key; compare modulo nonce/validBefore/signature; verify signature recovers to wallet).
  2. `onchainos payment pay-local` → clap exit 2 (SAFE).
  3. Payload with only an `aggr_deferred` entry → `aggr_deferred requires a TEE session key — not supported in local-key mode. Run \`onchainos wallet login\` to enable TEE signing.` (SAFE).
  4. Unset `EVM_PRIVATE_KEY`, empty `ONCHAINOS_HOME` dir → `Wallet not logged in and no EVM_PRIVATE_KEY configured. …` (SAFE).

### `onchainos payment default set`  (hidden: no)

- Handler: `dispatcher::cmd_default` (dispatcher.rs:456).
- Options: `--asset <ASSET>` required; `--chain <CHAIN>` required (local arg, numeric EVM chain id); `--name <NAME>` optional;
  `--tier <TIER>` optional (`basic`|`premium`, case-insensitive).
- Auth: anonymous (local-only).
- Steps: 1. `asset.trim()`; `is_valid_evm_address` else `--asset must be a valid EVM address (0x + 40 hex chars)`.
  2. `chain.trim()` → `chain_id_to_caip2` (errors in helper). 3. `name` trimmed, empty → None. 4. `tier` trimmed,
  empty → None, else `from_server_str` else `--tier must be \`basic\` or \`premium\``. 5. `cache = PaymentCache::load() ?? default`
  (a corrupt file is silently replaced by defaults). 6. `cache.default_asset = {asset, network: "eip155:<n>", name}`.
  7. tier given and that tier's state is `charging_unconfirmed` → `charging_confirmed` (other tier untouched).
  8. `cache.save()` (`$HOME/payment_cache.json`; context `failed to save payment cache`).
- Output: `{"asset":"<trimmed>","chain":"<trimmed input as given>","name":"<name>"|null}`.
- Errors: validation messages above (exit 1).
- Side effects: local file `payment_cache.json` (fields `endpoints{}`, `accepts`, `basic_state`, `premium_state`
  (`free|charging_unconfirmed|charging_confirmed`), `updated_at`, `user_type`, `intro_shown`, `grace_shown`,
  `default_asset{asset,network,name?}`, `local_signing_warned`; compact struct order).
- Nondeterminism: none in output.
- Parity test cases (SAFE, temp `ONCHAINOS_HOME`):
  1. `onchainos payment default set --asset 0x1234567890123456789012345678901234567890 --chain 196 --name USDG` →
     `{"ok":true,"data":{"asset":"0x1234567890123456789012345678901234567890","chain":"196","name":"USDG"}}`.
  2. `… --chain xlayer` → `--chain must be a numeric chain id (e.g. "1" for Ethereum, "196" for X Layer), got: xlayer: invalid digit found in string`.
  3. `… --chain 501` → `x402 payments are EVM-only; chain id 501 is not supported`.
  4. `… --tier gold` → ``--tier must be `basic` or `premium` ``.
  5. `--asset 0x123` → `--asset must be a valid EVM address (0x + 40 hex chars)`.

### `onchainos payment default get`  (hidden: no)

- Handler: `dispatcher::cmd_default` (dispatcher.rs:503). Options: none. Auth: anonymous.
- Steps: `PaymentCache::load() ?? default`; `default_asset` Some → print; None → `output::success_empty()`.
- Output: `{"asset","chain": caip2_to_chain_id(network),"name": name|null}` or envelope `{"ok":true}` (no `data`).
- Errors: none. Side effects: read-only (local). Nondeterminism: none.
- Parity: `onchainos payment default get` on empty home → `{"ok":true}`; after set case 1 → `{"ok":true,"data":{"asset":"0x1234567890123456789012345678901234567890","chain":"196","name":"USDG"}}` (SAFE).

### `onchainos payment default unset`  (hidden: no)

- Handler: `dispatcher::cmd_default` (dispatcher.rs:515). Options: none. Auth: anonymous.
- Steps: load (or default), `default_asset = None`, `save()` (always writes the file, even if absent before).
- Output: `{"ok":true}`. Errors: `failed to save payment cache: …`. Side effects: local file write.
- Parity: `onchainos payment default unset` → `{"ok":true}` and `payment_cache.json` exists without `default_asset` value (SAFE).

### `onchainos payment charge`  (hidden: no)

- Handler: `dispatcher::cmd_mpp_charge` (dispatcher.rs:1431).
- Options: `--challenge <CHALLENGE>` required (full `WWW-Authenticate` value); `--from <FROM>` optional; `--tx-hash <TX_HASH>` optional.
- Auth: transaction mode jwt-required + session-key signature; hash mode needs only `wallets.json` (payer address)
  + anonymous chain list.
- Steps:
  1. `parse_www_authenticate`; `decode_challenge_request`.
  2. `request.recipient` string else `missing 'recipient' in challenge request`; `request.amount` string else
     `missing 'amount' in challenge request`; `request.currency` string else `missing 'currency' in challenge request`;
     `request.methodDetails.chainId` JSON unsigned int else `missing 'methodDetails.chainId'`;
     `feePayer = methodDetails.feePayer` bool, default **true**.
  3. `parse_recipient_addr(recipient, chainId)` with context `challenge.request.recipient`.
  4. `resolve_chain_and_payer(chainId, --from)`.
  5. **Hash mode** (`feePayer == false`): `--tx-hash` required else
     `challenge.methodDetails.feePayer=false requires --tx-hash (broadcast transferWithAuthorization yourself first)`;
     must start `0x`, length 66, hex else `--tx-hash must be 0x + 64 hex chars`; credential
     `{"challenge":echo,"source":"did:pkh:eip155:{chainId}:{payer}","payload":{"type":"hash","hash":<tx-hash as given>}}`.
  6. **Transaction mode**: `--tx-hash` present → `--tx-hash is only valid when challenge.methodDetails.feePayer=false`;
     `compute_primary_split_amounts`; `validBefore = compute_valid_before(challenge, now)`; `nonce = random`;
     `tee_sign_eip3009(Transfer, chainIndex, payer, recipient canonical, primary, validBefore, nonce, currency)`;
     `authorization = {"type":"eip-3009","from":payer,"to":recipient DISPLAY,"value":primary,"validAfter":"0","validBefore","nonce","signature"}`;
     for each split i (in order): new random nonce, `tee_sign_eip3009(Transfer, …, split.canonical, split.amount, same validBefore, …)`
     (context `splits[{i}] TEE sign failed`) → `{"from","to":split.display,"value":split.amount,"validAfter":"0","validBefore","nonce","signature"}`
     (no `type`); `authorization.splits = [...]` when any. Credential
     `{"challenge":echo,"source":"did:pkh:eip155:{chainId}:{payer}","payload":{"type":"transaction","authorization":…}}`.
  7. `authorization_header = "Payment " + base64url(JCS(credential))`.
- Output: `{"authorization_header":"Payment …","challenge":{"id":…,"realm":…|null},"intent":"charge","method":"evm","mode":"hash"|"transaction","protocol":"mpp","wallet":"<payer>"}`.
- Errors: parser errors; request field errors; recipient errors; chain/wallet errors; split errors; expires errors;
  `eip3009 gen-msg-hash failed: …` / `eip3009 sign-msg failed: …` (+ `splits[i] TEE sign failed: ` prefix for splits).
- Side effects: transaction mode FUND-MOVING authorisation (`POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg`,
  1 + #splits times); hash mode read-only.
- Nondeterminism: nonces, validBefore, signatures (transaction mode). Hash mode deterministic given wallet.
- Parity test cases:
  1. `onchainos payment charge --challenge 'Payment id="a", realm="r", method="tempo", intent="charge", request="e30"'` →
     `unsupported payment challenge method "tempo"; this CLI only supports method="evm"` (SAFE).
  2. `… --challenge 'Payment realm="x"'` → `invalid WWW-Authenticate header: missing required fields (id, method, intent)` (SAFE).
  3. `… --challenge 'Payment id="1", realm="r", method="evm", intent="charge", request="e30"'` → `missing 'recipient' in challenge request` (SAFE).
  4. Logged-in, hash mode: `onchainos payment charge --challenge 'Payment id="1", realm="r", method="evm", intent="charge", request="eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiIweDIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIiLCJyZWNpcGllbnQiOiIweDExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCJtZXRob2REZXRhaWxzIjp7ImNoYWluSWQiOjE5NiwiZmVlUGF5ZXIiOmZhbHNlfX0"' --tx-hash 0x1111111111111111111111111111111111111111111111111111111111111111` →
     `mode:"hash"`, deterministic header (SAFE: no signing).
  5. Same challenge with feePayer true (omit field) and no `--tx-hash` → UNSAFE (TEE sign-msg).

### `onchainos payment session open`  (hidden: no)

- Handler: `dispatcher::cmd_mpp_session_open` (dispatcher.rs:1658).
- Options: `--challenge` required; `--deposit <DEPOSIT>` required (atomic units, **not validated locally**); `--from`;
  `--tx-hash`; `--salt`; `--initial-cum <INITIAL_CUM>`; `--prepay-first` (bool, default false).
- Auth: jwt-required + session-key signature (the initial voucher is always TEE-signed, even in hash mode).
- Steps:
  1. parse challenge + request; `recipient` else `missing 'recipient'`; `currency` else `missing 'currency'`;
     `methodDetails.chainId` else `missing 'methodDetails.chainId'`; `methodDetails.escrowContract` string else
     `missing 'methodDetails.escrowContract'`; feePayer default true.
  2. `parse_recipient_addr` (context `challenge.request.recipient`) → canonical recipient.
  3. `resolve_chain_and_payer(chainId, --from)`.
  4. Salt: hash mode + `--salt` → `normalize_bytes32_hex(salt, "--salt")`; hash mode w/o salt →
     `hash mode (feePayer=false) requires --salt: the same bytes32 you passed to your on-chain \`escrow.open(...)\` call (0x + 64 hex chars)`;
     tx mode + `--salt` → `--salt is only valid when challenge.methodDetails.feePayer=false (hash mode); transaction mode generates its own salt during \`escrow.openWithAuthorization(...)\`. Drop --salt or switch modes.`;
     tx mode → random 32 bytes.
  5. tx mode + `--tx-hash` → `--tx-hash is only valid when challenge.methodDetails.feePayer=false`.
  6. `channelId = compute_channel_id(payer, recipient, currency, salt, 0x0000000000000000000000000000000000000000, escrow, chainId)`.
  7. `initial_cum` = `--initial-cum` verbatim, else (`--prepay-first`) `request.amount` if non-empty and ≠ `"0"`, else `"0"`.
  8. `voucherSig = tee_sign_voucher(chainIndex, payer, channelId, initial_cum, escrow, chainId)` (2 TEE calls).
  9. **Hash mode**: `--tx-hash` else `hash mode (feePayer=false) requires --tx-hash (broadcast \`escrow.open(...)\` yourself first)`
     (checked **after** the voucher was signed); `normalize_bytes32_hex(tx, "--tx-hash")`; credential payload
     `{"action":"open","type":"hash","channelId","salt","hash","cumulativeAmount":initial_cum,"signature":voucherSig}` (+`source`).
  10. **Tx mode**: `validBefore = compute_valid_before`; `parse_session_splits`; `nonce = compute_open_nonce(payer, recipient, currency, salt, 0x0, recipients, bps)`;
      `eip3009Sig = tee_sign_eip3009(Receive, chainIndex, payer, escrow, deposit, validBefore, nonce, currency)`;
      payload `{"action":"open","type":"transaction","channelId","salt","authorization":{"type":"eip-3009","from":payer,"to":escrow,"value":deposit,"validAfter":"0","validBefore","nonce"},"signature":eip3009Sig,"cumulativeAmount":initial_cum,"voucherSignature":voucherSig}`.
  11. Credential `{"challenge":echo,"source":"did:pkh:eip155:{chainId}:{payer}","payload":…}` → `Payment <b64url(JCS)>`.
  12. `persist_channel_open` → `sessions/{channelId}.json` `{channel_id, owner_wallet: payer, deposit, cumulative: initial_cum, created_at, updated_at}`.
  13. `emit_session(base, session_open_params)`.
- Output: `{"action":"session_open","authorization_header","chain_id":<number>,"channel_id","cumulative_amount","deposit","escrow","mode":"hash"|"transaction","needsTopUp":bool,"protocol":"mpp","reason_text"?,"recovery"?,"sessionSnapshot":{"channelId","cumulative","deposit"},"strategy","wallet"}`.
  Because `unit_amount="0"`: normally `strategy:"sign"`, `recovery:"delta_too_small"`, `reason_text:"voucher delta is zero — nothing to authorize"`,
  `needsTopUp:false`, `cumulative_amount = initial_cum` (u128-normalised; non-numeric → "0"); if `initial_cum > deposit`:
  `strategy:"topup"`, `needsTopUp:true`, `recovery:"amount_exceeds_deposit"`.
- Errors: as listed; TEE errors `mpp voucher gen-msg-hash failed: …`, `mpp voucher sign-msg failed: …`,
  `missing msgHash`, `missing signature`, `eip3009 …`; hash errors `--tx-hash must be 32 bytes (0x + 64 hex chars), got N chars`,
  `--tx-hash contains non-hex characters`; address errors `invalid token address: …`, `invalid escrow address: …`.
- Side effects: FUND-MOVING authorisations (voucher + EIP-3009 receiveWithAuthorization deposit via `sign-msg`); local
  session state file written.
- Nondeterminism: salt (tx mode), channelId (derived from salt), nonce, validBefore, signatures.
- Parity test cases:
  1. `onchainos payment session open --challenge 'Payment id="1", realm="r", method="evm", intent="session", request="e30"' --deposit 1000000` → `missing 'recipient'` (SAFE).
  2. Missing `--deposit` → clap exit 2 (SAFE).
  3. Valid challenge with feePayer false and no `--salt` (logged in) → salt error (SAFE; chain list read only).
  4. Valid tx-mode challenge + `--salt 0x…` → `--salt is only valid …` (SAFE).
  5. Valid tx-mode challenge → UNSAFE.

### `onchainos payment session voucher`  (hidden: no)

- Handler: `dispatcher::cmd_mpp_session_voucher` (dispatcher.rs:1915).
- Options: `--challenge` required; `--channel-id` required; `--cumulative-amount` required (absolute new cumulative);
  `--escrow` optional (required in sign mode); `--chain-id <u64>` optional (required in sign mode); `--from`;
  `--reuse-signature <hex>`.
- Auth: reuse mode anonymous/offline; sign mode jwt-required + session-key signature.
- Steps:
  1. `parse_www_authenticate(challenge)` (request not decoded).
  2. Reuse: `sig.trim()`, strip one `0x`, must be 130 hex chars else
     `--reuse-signature must be a 0x-prefixed 65-byte hex string (130 hex chars)`; canonical = trimmed value if it
     starts with `0x` else `0x`+value (case preserved); `mode="reuse"`. `--escrow/--chain-id/--from` ignored.
     Sign: `--escrow` else `--escrow is required when not using --reuse-signature`; `--chain-id` else
     `--chain-id is required when not using --reuse-signature`; `resolve_chain_and_payer`; `tee_sign_voucher(…, channel_id, cumulative_amount, escrow, chain_id)`; `mode="sign"`.
  3. Credential `{"challenge":echo,"payload":{"action":"voucher","channelId","cumulativeAmount","signature"}}` (**no `source`**).
  4. `prior = session_state::read(channel_id)`; `prior_cum = prior.cumulative ?? "0"`; `deposit = prior.deposit`;
     `unit = u128(new) − u128(prior_cum)` (saturating; unparseable → 0).
  5. If `voucher_advances_cumulative(unit, new, deposit)` and prior exists → rewrite state with `cumulative = --cumulative-amount` (verbatim), `updated_at = now`.
  6. `emit_session(base, {action:"voucher", channel_id, cumulative_amount: prior_cum, unit_amount: unit, deposit, reuse_signature})`.
- Output: `{"action":"voucher","authorization_header","channel_id","cumulative_amount","mode":"reuse"|"sign","needsTopUp","protocol":"mpp","reason_text"?,"recovery"?,"sessionSnapshot":{…},"signature","strategy"}`.
- Errors: parser errors; reuse-signature format; missing escrow/chain-id; chain/wallet; TEE errors.
- Side effects: sign mode FUND-MOVING authorisation (`sign-msg` voucher); reuse mode none (local state update only).
- Nondeterminism: sign mode signature. Reuse mode fully deterministic.
- Parity test cases:
  1. (SAFE, empty home) `onchainos payment session voucher --challenge 'Payment id="1", realm="r", method="evm", intent="session", request="e30"' --channel-id 0xabc --cumulative-amount 100 --reuse-signature 0x1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111` →
     `{"ok":true,"data":{"action":"voucher","authorization_header":"Payment eyJjaGFsbGVuZ2UiOnsiZXhwaXJlcyI6bnVsbCwiaWQiOiIxIiwiaW50ZW50Ijoic2Vzc2lvbiIsIm1ldGhvZCI6ImV2bSIsInJlYWxtIjoiciIsInJlcXVlc3QiOiJlMzAifSwicGF5bG9hZCI6eyJhY3Rpb24iOiJ2b3VjaGVyIiwiY2hhbm5lbElkIjoiMHhhYmMiLCJjdW11bGF0aXZlQW1vdW50IjoiMTAwIiwic2lnbmF0dXJlIjoiMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExIn19","channel_id":"0xabc","cumulative_amount":"100","mode":"reuse","needsTopUp":false,"protocol":"mpp","sessionSnapshot":{"channelId":"0xabc","cumulative":"100","deposit":null},"signature":"<the full --reuse-signature value, 0x + 130×'1'>","strategy":"reuse"}}`
     (fully deterministic; the only side effect is creation of `$ONCHAINOS_HOME/sessions/`; no state file written because no prior state exists).
  2. Same with `--reuse-signature 0x12` → reuse-signature format error (SAFE).
  3. Without `--reuse-signature` and without `--escrow` → `--escrow is required when not using --reuse-signature` (SAFE).
  4. Missing `--challenge` → clap exit 2 (SAFE).
  5. Sign mode with escrow + chain-id → UNSAFE.

### `onchainos payment session topup`  (hidden: no)

- Handler: `dispatcher::cmd_mpp_session_topup` (dispatcher.rs:2036).
- Options: `--challenge`, `--channel-id`, `--additional-deposit`, `--escrow`, `--chain-id <u64>` all required;
  `--currency` optional (required in tx mode); `--from`; `--tx-hash`.
- Auth: tx mode jwt-required + session-key signature; hash mode wallets.json + anonymous chain list.
- Steps:
  1. parse challenge; `resolve_chain_and_payer(chain_id, from)` (both modes).
  2. Hash mode (`--tx-hash` given): strict `0x`+64 hex else `--tx-hash must be 0x + 64 hex chars`; payload
     `{"action":"topUp","type":"hash","channelId","hash","additionalDeposit"}`.
  3. Tx mode: `--currency` else `--currency is required in transaction mode (omit --tx-hash for hash mode)`;
     `validBefore`; `topUpSalt` = random 32 bytes; `nonce = compute_topup_nonce(payer, channelId, additional, topUpSalt)`;
     `tee_sign_eip3009(Receive, chainIndex, payer, escrow, additional, validBefore, nonce, currency)`; payload
     `{"action":"topUp","type":"transaction","channelId","topUpSalt","authorization":{"type":"eip-3009","from","to":escrow,"value":additional,"validAfter":"0","validBefore","nonce"},"signature","additionalDeposit"}`.
  4. Credential `{"challenge":echo,"source":"did:pkh:eip155:{chainId}:{payer}","payload":…}`.
  5. State: `new_deposit = prior ? (u128(prior.deposit)+u128(additional)) : additional (verbatim)`; write
     `{channel_id, owner_wallet: payer, deposit: new_deposit, cumulative: prior_cum ?? "0", created_at: prior.created_at ?? now, updated_at: now}` (always written).
  6. `emit_session(base, {action:"topup", channel_id, cumulative_amount: prior_cum, unit_amount:"0", deposit: new_deposit})`.
- Output: `{"action":"session_topup","additional_deposit","authorization_header","channel_id","cumulative_amount","mode","needsTopUp","protocol":"mpp","reason_text"?,"recovery"?,"sessionSnapshot","strategy","wallet"}`
  (typically `strategy:"sign"`, `recovery:"delta_too_small"`).
- Errors: listed; nonce errors (`channelId must be 32 bytes (64 hex chars)`, `additionalDeposit must be decimal uint128: …`).
- Side effects: tx mode FUND-MOVING (`sign-msg` receiveWithAuthorization to escrow); local session state write (both modes).
- Nondeterminism: topUpSalt, nonce, validBefore, signature.
- Parity test cases:
  1. Missing `--channel-id` → clap exit 2 (SAFE).
  2. Logged in, `--tx-hash 0x3333…33` (hash mode) → deterministic output (SAFE).
  3. Logged in, no `--tx-hash`, no `--currency` → currency error (SAFE).
  4. Tx mode with 32-byte channel id → UNSAFE.

### `onchainos payment session close`  (hidden: no)

- Handler: `dispatcher::cmd_mpp_session_close` (dispatcher.rs:2180).
- Options: `--channel-id`, `--cumulative-amount`, `--escrow`, `--chain-id <u64>`, `--challenge` all required; `--from`.
- Auth: jwt-required + session-key signature.
- Steps: parse challenge → `resolve_chain_and_payer` → `tee_sign_voucher(chainIndex, payer, channelId, cumulative, escrow, chainId)` →
  credential `{"challenge":echo,"payload":{"action":"close","channelId","cumulativeAmount","signature"}}` (no `source`) →
  `prior = read(channelId)`; `unit = u128(final) − u128(prior_cum)` → `emit_session(base, {action:"close", channel_id, cumulative_amount: prior_cum, unit_amount: unit, deposit: prior.deposit})`
  → `session_state::cleanup(channelId)` (always).
- Output: `{"action":"session_close","authorization_header","channel_id","cumulative_amount","needsTopUp","protocol":"mpp","reason_text"?,"recovery"?,"refund"?,"sessionSnapshot","strategy"}`;
  `refund = deposit − (prior_cum + unit)` only when a persisted deposit exists.
- Errors: parser, chain/wallet, TEE errors.
- Side effects: FUND-MOVING authorisation (final voucher via `sign-msg`); deletes local session state.
- Nondeterminism: signature.
- Parity test cases: 1. missing `--escrow` → clap exit 2 (SAFE); 2. non-evm challenge → method error (SAFE);
  3. logged-out valid call → `session expired, please login again: onchainos wallet login` or `not logged in` (SAFE);
  4. logged-in → UNSAFE.

### `onchainos payment a2a-pay …` / `onchainos payment subscription …`  (hidden: no) — dispatch only

- Handlers: `a2a_pay::execute(command)` (dispatcher.rs:327) and `subscription::execute(command)` (dispatcher.rs:328);
  documented by the owning partition. Subcommands (from cli-tree): a2a-pay `create|pay|status`; subscription
  `subscribe|access|change|cancel|cancel-pending|my-subscriptions|allowance-status`.

---

## Endpoint classification (this partition)

| method | path / host | class | used by |
|---|---|---|---|
| POST | `/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` | read (pure digest computation, JWT) | pay, pay --payment-id, charge (tx), session open/voucher(sign)/topup(tx)/close |
| POST | `/priapi/v5/wallet/agentic/pre-transaction/sign-msg` | funds | same as above |
| POST | `/priapi/v5/wallet/agentic/chain/support/list` | read (anonymous; skipped when chain_cache fresh) | pay, pay-local (permit2/upto), charge, session * (except voucher reuse) |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth (via ensure_tokens_refreshed) | every TEE path |
| GET | `/api/v6/pay/x402/buyers/{buyer}/allowance-status?token=..&chainIndex=..` | read (anonymous; subscription partition) | pay (scheme `period`) |
| POST | `https://rpc.xlayer.tech` JSON-RPC `eth_call` allowance | read (external) | pay / pay-local permit2+upto on chain 196 |
| any | merchant `endpoint_url` (user supplied) | funds (external) | pay --payment-id (REST replay) |
| POST | MCP endpoint (user supplied) JSON-RPC initialize / tools/list / tools/call | funds (external) | pay --payment-id (MCP replay) |

External hosts: `https://rpc.xlayer.tech` (Permit2 allowance pre-check), arbitrary merchant / MCP endpoints (two-phase
replay), `https://beta.okex.org` (hidden `--dev`), DoH resolvers used by WalletApiClient failover (core spec).

---

## Open questions / reproduce-as-is notes

1. REST replay in `pay --payment-id` sends only pay-time `--param` values; quote-time `known_params` persisted in the
   state file are not re-sent (MCP replay does merge them). Reproduce as-is?
2. `session open` always emits `recovery:"delta_too_small"` + reason text because `unit_amount="0"`; `topup` likewise.
3. Session state `owner_wallet` stores the payer **address** (doc says account id) and is never checked on read.
4. Hash-mode `session open` burns a TEE voucher signature before validating `--tx-hash` presence.
5. `parse_www_authenticate` decodes quoted-string bytes as Latin-1 (`byte as char`) — non-ASCII values get mangled.
6. `decode_payment_blob` detects `Payment ` case-insensitively but `parse_www_authenticate` strips it case-sensitively.
7. `payments/` and `sessions/` directories are created with default permissions (comments claim 0700).
8. Error suffixes from Rust libraries (io, serde, chrono, ruint, reqwest) cannot be reproduced byte-exact; harness should
   compare error prefixes.
9. `gen-msg-hash` classified as read; server-side logging/side effects unknown.
10. `transfer::resolve_address` with `--from` iterates a HashMap (account order random) — only matters if one address
    appears under two accounts.
11. `validate_payment_inputs` (dispatcher.rs:527) and `x402_pay_from_accepts` (payment_flow.rs:368) are dead code.
