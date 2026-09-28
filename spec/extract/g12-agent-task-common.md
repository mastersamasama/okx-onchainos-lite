# g12-agent-task-common — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the task-system root (`commands/agent_commerce/task/{mod,arbitration,refund_list,signing}.rs`) and
the whole `task/common/` infrastructure **except** `common/autotrade/**` (owned by another group). This
covers the Task API client, sign-and-broadcast helpers, the task/subscription state machine, the lifecycle
projector, the pending-decisions-v2 queue, claims, deliverables, evidence upload, deadlines,
prefilled-notification/rating caches, session cleanup, the `okx-a2a` process wrappers, template variables,
and every `onchainos agent …` leaf whose handler lives in these files (33 leaves, 2 of them hidden).

`agent next-action` is dispatched from `commands/agent_commerce/mod.rs` (not in this partition); its
dispatch/validation/freshness contract is documented here because it is the consumer of this partition's
`state_machine`, `review_gate`, `PreFetchedTaskContext` and `arbitration` helpers, but the per-role playbook
generators (`task::{user,asp,evaluator}::flow::generate_next_action`) are owned elsewhere.

---

## Sources read

Partition files (read fully, every line incl. tests):

| File (under `cli/src/commands/agent_commerce/task/`) | Lines |
|---|---|
| `mod.rs` | 12 |
| `arbitration.rs` | 1678 |
| `refund_list.rs` | 394 |
| `signing.rs` | 627 |
| `common/mod.rs` | 1608 |
| `common/a2a_binding.rs` | 147 |
| `common/claim.rs` | 86 |
| `common/config.rs` | 85 |
| `common/deadline.rs` | 317 |
| `common/deliverables.rs` | 433 |
| `common/deposit_qr.rs` | 427 |
| `common/dispute_upload.rs` | 362 |
| `common/funding_notice.rs` | 610 |
| `common/in_progress.rs` | 44 |
| `common/lifecycle.rs` | 3587 |
| `common/okx_a2a.rs` | 1259 |
| `common/onchainos_self.rs` | 95 |
| `common/payment_mode.rs` | 80 |
| `common/pending_v2.rs` | 3795 |
| `common/prefilled_notify.rs` | 71 |
| `common/prefilled_rating.rs` | 66 |
| `common/query.rs` | 1109 |
| `common/review_gate.rs` | 120 |
| `common/session_cleanup.rs` | 40 |
| `common/state_machine.rs` | 1241 |
| `common/subscription_identity.rs` | 41 |
| `common/template_vars.rs` | 599 |
| `common/user_lang.rs` | 190 |
| `common/util.rs` | 707 |
| `common/network/mod.rs` | 5 |
| `common/network/task_api_client.rs` | 459 |

Supporting sources read to trace callers/callees (partial reads, only the named ranges):

| File | Range read | Why |
|---|---|---|
| `commands/agent_commerce/mod.rs` (5373) | 1–3140, 3134–3411, 3876–4720 | clap definitions + dispatch of every leaf in this group; `next-action` dispatch, `check_status_freshness` |
| `task/asp/mod.rs` | 180–290, 395–460 | `DisputeCommand::Upload` clap + dispatch |
| `task/evaluator/dispute_status.rs` | 57–120 | `DisputeStatusResponse`, `get_dispute_status` |
| `task/user/refund.rs` | 238–253, 1178–1262, 2530–2610 | refund-list item builder, decimal validators, close receipt |
| `task/user/subscription_ops.rs` | 403–428, 721–723, 1333–1383 | subscription detail/list fetchers |
| `task/user/create.rs` | 454–514 | `validate_draft_fields` (prepare-create) |
| `task/user/negotiate.rs` | 138–160 | designated-provider file (next-action) |
| `task/common/autotrade/{mod,consent,consent_reply,card}.rs` | grep | retired-event constants, delivery-context path |
| `wallet_api.rs` (2874) | 21–27, 106–126, 644–1340 | WalletApiClient transport, envelope, retries |
| `client.rs` | 346–386 | `anonymous_headers` / `jwt_headers` |
| `output.rs` | 1–200 | envelopes |
| `main.rs` | 225–316 | error → exit-code mapping |
| `home.rs` | 1–72, 200–290 | `ONCHAINOS_HOME`, task dir, atomic writes |
| `wallet_store.rs` | grep | `session.json` (`sessionCert`) |
| `endpoints.rs` | grep | base URL |
| `commands/agentic_wallet/auth/mod.rs` | 132–177, 276–278 | `ensure_tokens_refreshed` |
| `commands/agentic_wallet/transfer/mod.rs` | 681–713 | `build_broadcast_body` |
| `commands/agentic_wallet/sign.rs` | grep | `eip712_sign_raw` endpoints |
| `commands/agent_commerce/identity/queries.rs` | grep | endpoints hit by the `get-agents` / `get-my-agents` / `service-list` subprocesses |
| `qr.rs` | grep | `build_qr_output`, display mode |
| `Cargo.toml` / `Cargo.lock` | serde_json entry | serde_json has **no** `preserve_order` feature (no indexmap dep) |
| `spec/cli-tree.json` | agent subtree | flag cross-check (all visible leaves below match source) |

---

## Shared helpers (used across groups or from core)

### 0. Runtime contract every command in this group inherits

- **Envelope / exit codes** (main.rs:248–314, output.rs):
  - success → `output::success(data)` prints ONE line `{"ok":true,"data":<data>}` (+`"notifications":[...]` only if core payment notifications were queued — never for this group). Compact unless env `ONCHAINOS_PRETTY=1`.
  - `commands::sink::CodedError` → `{"error":<msg>,"errorCode":<code>,"errorField":<field?>,"ok":false}` (keys sorted), exit 1.
  - `deposit_qr::InsufficientBalanceError` → `{"ok":false,"error":<message>}` or, when `deposit_address` is set, `{"currency","depositAddress","depositChain","error","ok":false,"shortfall"}` (sorted), exit 1.
  - any other `Err(e)` → `{"ok":false,"error":"<format!("{e:#}")>"}` (anyhow alternate form = context chain joined with `": "`), exit 1.
  - clap parse errors (missing required flag, bad enum value, conflicts) → clap's usage text on stderr, **exit 2**, no JSON.
  - Several commands in this group print **plain text** (not JSON) on success; noted per command.
- **JSON key order**: `serde_json` is built without `preserve_order` ⇒ every `serde_json::Value` object (anything built with `json!`, any passthrough backend `data`, `Map`) is serialised with **keys sorted by byte order**. Only `#[derive(Serialize)]` structs keep declaration order. This is called out per output below.
- **Global flag** `--chain <CHAIN>` exists on every leaf (global Cli flag); none of the handlers in this group read it.
- **Agent preamble** (`commands/agent_commerce/mod.rs:1403–1418`, owned by the autotrade group): before dispatching ANY `agent …` leaf the CLI best-effort runs `autotrade::executor::reconcile_terminal_journals(4, 100ms)`, `flush_all_due(1)`, `cleanup_expired_tickets(8)`, `autotrade::delivery_queue::flush_due(1, 100ms)` (local journal work; may spawn `okx-a2a user notify … --job-id … --idempotency-key …` for due notices). Errors ignored. A lite runtime that does not implement autotrade can skip this; it produces no stdout.
- **Audit**: after every command main.rs appends one line to `$ONCHAINOS_HOME/audit.jsonl`; `TaskApiClient` additionally appends one `api/<method>` line per HTTP call (see §1). Not part of stdout.
- **`DEBUG_LOG`** (`common/mod.rs:75`) = `cfg!(feature="debug-log")` — false in release; every `if DEBUG_LOG { eprintln!(...) }` in this group is dead in production builds and can be omitted.

### 1. `struct network::task_api_client::TaskApiClient` (task_api_client.rs:88) — the Task API transport

Constructed with `TaskApiClient::new()` (:95): `base_url = endpoints::base_url()` (compiled OKX base, `https://web3.okx.com` in prod; `--dev` → `https://beta.okex.org`), `wallet = WalletApiClient::new()` (DoH-enabled, 30 s timeout, UA from DoH manager), `raw_http = reqwest::Client::new()` (plain, no DoH, no UA override).

Auth: every request first calls `get_access_token()` = `agentic_wallet::auth::ensure_tokens_refreshed()` (auth/mod.rs:132, owned by the auth group) → JWT access token (refreshing via `POST /priapi/v5/wallet/agentic/auth/refresh` when needed). Not logged in / session key expired → error `session expired, please login again: onchainos wallet login` (exit 1). **All Task API calls are JWT-required.**

Headers on every request (`ApiClient::jwt_headers`, client.rs:346–385): `Content-Type: application/json` (also on GET), `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <cached device id>` (if any), `device-name: <device name>`, `Authorization: Bearer <jwt>`; plus the task identity header **`agenticId: <agentId>`** (inserted verbatim; if the value is not a valid header value it is silently dropped — an empty string is a valid value and IS sent as `agenticId: `).

`sessionCert` = `wallet_store::load_session()` → `$ONCHAINOS_HOME/session.json` field `sessionCert`, used only if non-empty.

Path helpers (`TASK_PREFIX = "/priapi/v1/aieco/task"`):
- `task_path(job)` → `/priapi/v1/aieco/task/{job}`
- `endpoint(job, action)` → `/priapi/v1/aieco/task/{job}/{action}`
- `dispute_list_path(page, size)` → `/priapi/v1/aieco/task/dispute/my?page={page}&pageSize={size}`
- `broadcast_path()` → `/priapi/v1/aieco/task/broadcast`
- `subscribe_path(sub)` → `/priapi/v1/aieco/task/subscribe/{sub}`
- (job/sub ids are interpolated raw — no percent-encoding.)

Request methods (all return the unwrapped `data` of the `{code,msg,data}` envelope):

| Method | HTTP | Query | Body | Retries |
|---|---|---|---|---|
| `get_with_agent_id(path, agent)` (:152) | GET | none | — | DoH failover retry once on connect/timeout; on invalid-token codes (`10001`,`10008`,`53017`,`130100031`) force-refresh JWT and resend once |
| `get_with_identity(path, agent)` (:182) | GET | `sessionCert=<cert>` if a cert exists | — | same |
| `get_bytes_with_identity(path, query, agent)` (:223) | GET via `raw_http` (no DoH, no UA) | caller `query` via reqwest `.query()` | — | none; non-2xx → `evidence download failed ({status}): {url}; body={body}`; send error → `evidence download request failed: …` |
| `post_with_identity(path, body, agent)` (:323) | POST JSON | none | `body` + `sessionCert` injected (only when body is an object without `sessionCert` and a cert exists) | DoH retry + invalid-token retry |
| `post_mutation_with_identity(path, body, agent)` (:361) | POST JSON | none | same injection | **no retry at all**; connect/timeout → `Network result is unknown for this state-changing request. Query authoritative state before retrying.: <reqwest err>` |
| `raw_post_with_identity(path, bytes, content_type, agent)` (:402) | POST raw | none | raw bytes (no cert injection); `Content-Type` replaced by `content_type`, explicit `Content-Length` | none; send error → `wallet API request failed: …` |
| `fetch_subscription(job, agent)` (:137) | = `get_with_identity(subscribe_path(job), agent.trim())` | | | empty/blank agent → `agenticId is required to fetch subscription detail` |

**URL construction quirk (must be reproduced):** `WalletApiClient` builds `url = base + path + build_query_string(query)` where `build_query_string` (wallet_api.rs:106) drops empty values, `form_urlencoded`-encodes values (space→`+`, non-`[A-Za-z0-9*-._]`→`%XX`), and **always prefixes `?`**. Paths that already contain a query (`/task/my?page=…`, `/task/dispute/my?…`, `/task/subscribe/my?…`) therefore become `…?page=1&page_size=20?sessionCert=<enc>` (a second `?`) when `get_with_identity` has a session cert. Without a cert nothing is appended.

Response handling (`WalletApiClient::handle_response`, wallet_api.rs:1165): HTTP ≥500 → `Wallet API server error (HTTP {n}): {raw}`; non-JSON → `failed to parse wallet API response as JSON (HTTP {n}): {first 500 chars}`; `code` not `"0"`/`0` → `ApiCodeError` displayed `Wallet API error (code={code}): {msg}` (msg from `msg`|`errorMessage`|`error_message`|`message`|`detailMsg`, else raw body ≤200 chars); success → `data` (missing → `null`).

Serialization of POST bodies: `reqwest .json(body)` → compact JSON, **keys sorted** (Value). Example `post_with_identity("/…/inProgress", {"agentIds":[…]})` sends `{"agentIds":["1001"],"sessionCert":"…"}`.

Audit (`log_api`, :24): after each call appends `audit::log("cli", "api/get"|"api/get_bytes"|"api/post"|"api/post_mutation"|"api/post_raw", ok, elapsed, ["path=<path>","agentId=<agent>", extra?], err)`; raw POST extra = `contentType=<ct>; contentLength=<n>`; bytes GET extra = `query=k=v&…`.

### 2. Identity lookups via self-subprocess (`common/mod.rs`)

These spawn the running binary (`std::env::current_exe()`), capture stdout, and parse the CLI's own JSON envelope. The child performs its own HTTP (owned by the identity group) and inherits env/`ONCHAINOS_HOME`.

- `async fn raw_query_by_ids(ids)` (:369) — argv `agent get-agents --agent-ids <ids>`; child hits `GET /priapi/v5/wallet/agentic/agent/batch-list` (read). Errors: `current_exe failed: {e}`, `spawn \`get-agents\` failed: {e}`, `parse \`get-agents\` stdout failed: {e}; raw={stdout}`, `` `get-agents` returned failure: {error|"(no error message)"} ``. Returns `flatten_agent_groups(data)`.
- `async fn raw_query_my_agents(role?)` (:400) — requires `current_account_xlayer_address()` else error `no current XLayer address`; argv `agent get-my-agents --owner-address <addr> [--role <role>] --page-size 100`; child hits `GET /priapi/v5/wallet/agentic/agent/agent-list`. Error strings as above with `get-my-agents` and `(no error)`.
- `fn current_account_xlayer_address()` (:512) — `wallet_store::load_wallets()` → active account (`agentic_wallet::account::resolve_active_account_id`) → its `addressList` entry with `chainIndex == "196"` → address **lowercased**; `None` on any miss.
- `async fn fetch_my_agents()` (:529) / `fetch_my_agents_by_role(role)` (:548) — as above, **any error → empty Vec** (silent). `fetch_my_agents_by_role_strict` (:572) propagates errors.
- `async fn fetch_agent_by_id(id)` (:578) — trimmed id; empty → `None`; `raw_query_by_ids(id)`; first entry whose `agentId` (string) == id; errors → `None`.
- `async fn query_agent_by_id_direct(id)` (:626) — trimmed; empty → `agent_id must not be empty`; not found → `agentId={id} not found in \`get-agents\` response`.
- `async fn fetch_agent_profile(id)` (:449) → `AgentProfile {agent_id,name,profile_description,agent_wallet_address,communication_address}`; on empty id / error / no match returns fallback `{name:"Agent {id}", profile_description:"(profile unavailable)", wallet/comm: None}`.
- `async fn spawn_service_list(id)` / `spawn_service_list_filtered(id, sid?)` (:653/:659) — argv `agent service-list --agent-id <id> --page 1 --page-size 100 [--service-id <sid>]`; child hits `GET /priapi/v5/wallet/agentic/agent/services`. Returns `data`. Errors `spawn \`agent service-list\` failed: …`, `parse \`agent service-list\` stdout failed: …; raw=…`, `` `agent service-list` returned failure: … ``.
- `async fn find_service(agent, sid)` (:715) — empty sid → `Ok(None)`; else filtered spawn and first `data[*].list[*]` entry whose `id` or `serviceId` (string or integer rendered) equals sid.
- `fn flatten_agent_groups(data)` (:1160) — (a) `data` is an array whose first element has `agentId` → returned as-is; (b) else take `data.list` or `data[0].list`; for each entry: if it has `agentList[]` → push each agent, adding `ownerAddress`/`accountName` from the group when missing; else if entry has `agentId` → push; (c) no list → `[]`.
- `fn has_same_agent_owner(task)` (:85) — trimmed, lowercased non-empty `buyerAgentAddress == providerAgentAddress`.
- `fn is_test_task(task)` (:63) — `testFlag` bool, default false.
- Constants: `XLAYER_CHAIN_ID=196`, `XLAYER_CHAIN_INDEX="196"`, `XLAYER_CHAIN_NAME="okb"`, `AGENT_ROLE_USER=1`, `AGENT_ROLE_ASP=2`, `AGENT_ROLE_EVALUATOR=3`, `TERMINAL_NOTIFICATION_MARKER="[onchainos:task-terminal]"`.

### 3. `struct PreFetchedTaskContext` (`common/mod.rs:178`) — built from task OR subscription detail

`from_api_response(v)` (:230), "string(keys)" = first key whose value is a non-blank trimmed string or an integer rendered as decimal; "integer(keys)" = first key parsable as i64 (number or numeric string):

| field | source |
|---|---|
| `title`, `description` | `v.title`/`v.description` string or `""` |
| `job_type` | `jobType` i64 or numeric string |
| `trial_type` | `trialType` i64 or numeric string |
| `token_symbol` | string(`tokenSymbol`,`paymentTokenSymbol`) else `"?"` |
| `token_amount` | string(`paymentTokenAmount`,`tokenAmount`) else `""` |
| `payment_mode` | `paymentMode` i64 or numeric string |
| `max_budget` | `paymentMostTokenAmount` string |
| `provider_agent_id` | string(`providerAgentId`,`aspAgentId`) |
| `provider_name` | string(`providerAgentName`,`aspAgentName`,`providerName`) |
| `user_agent_id` | string(`buyerAgentId`,`userAgentId`) |
| `status` | `subStatus` i64, else `status` i64, else string(`subStatus`,`status`) parsed |
| `service_id/service_name/service_token_address/service_token_amount` | string(`serviceId`/`serviceName`/`serviceTokenAddress`/`serviceTokenAmount`) |
| `service_params` | `serviceParams` string (raw, may be empty) |
| `refund_reason` | string(`refundReason`,`rejectReason`,`userReason`,`reason`) |
| `period_start_time`/`period_end_time` | integer(`subStartTime`,`periodStartTime`) / integer(`subEndTime`,`periodEndTime`) |
| `user_agent_address` | `buyerAgentAddress` string |
| `token_address` | string(`paymentTokenAddress`,`tokenAddress`) |
| `expire_time` | `deadline::first_timestamp(v, [rejectWindowEndsAt, responseDeadline, expireTime])` |
| `review_expire_time` | `deadline::review_deadline_from_detail(v)` |
| `test_flag` | `testFlag` bool else false |
| `deliverable`, `verified_transaction_hash` | None; `refund_request_provenance` false |

`format_inline()` (:303) renders (used by playbooks, owned elsewhere):
```
[Pre-fetched task context] (from status-check API — no need to call `common context` again unless a field below is missing)
  title: {title}
  description: {description}            ← line only when non-empty
  tokenSymbol: {sym} | tokenAmount: {amt} | paymentMode: {escrow (1)|x402 (3)|{v} (unknown)|unknown}
  maxBudget (paymentMostTokenAmount): {max|not set} | providerAgentId: {id|none} | buyerAgentId: {id|none}
  serviceParams: {sp}                    ← only when Some and non-empty
  deliverable: saved | path: {p} | type: {t} | name: {n}   ← only when deliverable Some
```
(each line ends with `\n`; lines are prefixed with two spaces.)

### 4. `signing.rs` — sign-and-broadcast helpers (fund-moving primitives used by other groups)

- `fn extract_biz_type(resp)` (:33) → `resp.type` as i64, default 0.
- `fn resolve_wallet(account_id?, address?)` (:43) → `wallet_store::load_wallets()` (None → `not logged in; run \`onchainos wallet auth\` first`) → `agentic_wallet::transfer::resolve_address(&wallets, address, "okb")` (wallet group) → `(account_id or resolved, address)`.
- `async fn resolve_wallet_by_agent_id(agent)` (:58) — trimmed empty → `agent_id must not be empty; pass the provider's own agentId`; `fetch_agent_by_id` → `agentWalletAddress`; empty → `cannot resolve wallet for agentId={id}; agentWalletAddress not found in \`onchainos agent get-agents\``; then `resolve_wallet(None, Some(addr))`.
- `async fn resolve_wallet_and_agent_for_task(client, job, explicit_agent?)` (:88) — agent = explicit or first local `role==1` agent (via `fetch_my_agents`, empty on miss); `GET task_path(job)` (identity); `buyerAgentAddress` missing → `task detail missing buyerAgentAddress field`; returns `(account, address, buyerAgentId|"")`.
- `async fn resolve_agent_by_role(code, label, wallet?)` (:129, private) — first agent in `fetch_my_agents()` with `role == code` (and `ownerAddress` eq_ignore_ascii_case wallet when given); missing `agentId` → `Agent missing agentId field`; none → `current wallet has no {label} identity (ownerAddress mismatch); switch wallet or register first` (wallet given) / `current account has no {label} identity; register first`.
- `async fn resolve_agent_id_by_role(code)` (:227) — label 1→user 2→asp 3→evaluator; **never errors**: returns `Ok("")` on miss.
- `async fn resolve_wallet_and_agent_for_evaluator(agent)` (:173) — trimmed empty → `agent_id must not be empty (envelope top-level agentId required)`; no wallet address → audit `evaluator/wallet_resolve_failed` + `cannot get wallet address for agentId={id}; verify the agentId exists in \`onchainos agent get-my-agents\``; local wallet miss → audit + `agentId={id} wallet {owner} not found locally ({msg})`.
- `fn merge_biz_context(job, biz_type, extra?)` (:243) → `{"jobId":job,"bizType":biz_type}` plus every key of `extra` (overwrite); serialised sorted.
- `async fn sign_uop_and_broadcast_full(client, uop_data, account, address, job, biz_type, agent, extra?)` (:269):
  1. `uop_data` null → `backend did not return uopData; cannot sign and broadcast`.
  2. deserialize into `wallet_api::UnsignedInfoResponse` (wallet group) else `failed to parse uopData: {e}`.
  3. `executeResult == false` (bool false only; null/other = ok) → `backend transaction preflight failed: {executeErrorMsg | "no error detail returned"}`.
  4. `agentic_wallet::transfer::build_broadcast_body(&unsigned, account, address, "196", is_contract_call=true, mev=false, force=false)` (wallet group; requires `session.json` + keyring `session_key`, else `not logged in`; decrypts the HPKE-wrapped session signing seed and Ed25519-signs the backend hashes into `extraData`) → `{"accountId","address","chainIndex":"196","extraData":"<json string>"}`.
  5. `body.bizContext = merge_biz_context(job, biz_type, extra)`.
  6. `POST /priapi/v1/aieco/task/broadcast` via `post_mutation_with_identity(…, agent)` (no retry; `sessionCert` injected) — **FUND-MOVING**. Body keys sorted: `accountId,address,bizContext,chainIndex,extraData,sessionCert`. Error → context `broadcast failed` (rendered `broadcast failed: <inner>`).
  7. returns `data[0]` (`{pkgId, orderId, orderType, txHash, bizUniqKey}`) or `null`.
- `async fn sign_uop_and_broadcast(...)` (:333) → `first.txHash` string or `"pending"`.
- `async fn sign_uop_and_broadcast_with_commit_meta(…, commit_salt, vote, vote_report, vote_report_summary)` (:365) — same steps but `bizContext = {"jobId","bizType","commitSalt","vote"(u8 number),"voteReport","voteReportSummary"}`; broadcast error → `broadcast failed: {e}` (Display, not chain). Returns `data[0].txHash` or `"pending"`.
- `async fn sign_uop_and_broadcast_with_payment(…, payment_verify)` (:432) — `bizContext = {"jobId","bizType","paymentVerify":<value>}`; otherwise identical to the commit variant.
- `fn sign_digest_with_session_key(digest)` (:491) — `session.json` + keyring `session_key` (else `not logged in; run \`onchainos wallet auth\` first`) → `crypto::hpke_decrypt_session_sk(encryptedSessionSk, session_key)` → base64 seed → `crypto::ed25519_sign_hex(digest, seed_b64)`. Local only.
- `async fn sign_typed_data(typed_data, from)` (:505) → `agentic_wallet::sign::eip712_sign_raw(typed_data, "196", from)` (wallet group: `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` → Ed25519 sign `msgHash` → `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg`) → ECDSA signature hex.
- `async fn task_dual_sign_and_broadcast(client, job, pre_action, main_action, extra_main?, account, address, agent, biz_extra?)` (:532):
  1. `deadline = Utc::now().timestamp() + 1800` (**nondeterministic**).
  2. `POST /priapi/v1/aieco/task/{job}/{pre_action}` body `{"deadline":<i64>}` (+`sessionCert`) via `post_with_identity`; error → `{pre_action} request failed: {e}`; `typedData` null → `{pre_action} did not return typedData`; `nonce` = string or `""`.
  3. `signature = sign_typed_data(typedData, address)`.
  4. `POST /priapi/v1/aieco/task/{job}/{main_action}` body `{"signatureData":{"deadline":…,"nonce":…,"signature":…}, …extra_main}` (+`sessionCert`); error → `{main_action} request failed: {e}`.
  5. `sign_uop_and_broadcast(client, main_resp.uopData, …, biz_type=main_resp.type, agent, biz_extra)`.
  6. returns `BroadcastResult {api_response: main_resp, tx_hash}`.

### 5. `claim.rs` — account-level reward claim (used by evaluator `arbitration-claim` / `arbitration-claimable`)

- `async fn submit_claim_and_broadcast(client, account, address, agent)` (:25) — `POST /priapi/v1/aieco/task/claim` body `{}` (+`sessionCert`) via `post_with_identity` → `sign_uop_and_broadcast(client, resp.uopData, account, address, job="", biz_type=resp.type, agent, None)` → txHash. **FUND-MOVING** (claims all pending rewards).
- `async fn fetch_and_print_claimable(client, agent)` (:53) — `GET /priapi/v1/aieco/task/claimable` (identity) then prints plain text:
  ```
  claimable rewards (account={resp.account|""}, agentId={agent})
    • {symbol:<8} {amount:>30}  (token={tokenAddress})     ← marker "•" when rawAmount != "0" and non-empty, else " "
    (no rewards)                                            ← when rewards missing/empty
  ```
  (`symbol` default `?`, `amount` default `0`, `rawAmount` default `0`). Returns whether any reward is non-zero.

### 6. `util.rs`

- `fn fmt_unix_secs(Option<i64>)` (:19) → `n>0` → `Utc.timestamp_opt(n,0).to_rfc3339()` (e.g. `2023-11-14T22:13:20+00:00`; unrepresentable → `n.to_string()`); else `—`.
- `fn json_str(obj,key)` → string or `response missing field: {key}`; `fn json_u64(obj,key)` → u64 or numeric string (`failed to parse {key} as u64: {s}`) or `response missing field: {key}`.
- `async fn resolve_payment_mode(client, flag?, job, agent)` (:56) — flag → `PaymentMode::from_str` (anything but `x402` → Escrow); else `GET task_path(job)` (identity) → `paymentMode` i64 (default 0) → `from_int`; `None` → Escrow.
- `async fn resolve_token_symbol_by_address(chain_index, contract)` (:88) — core `token::fetch_info` (DEX basic-info, owned by token group) → `data[0].tokenSymbol` non-empty else `token basic-info returned no symbol for chain={c} address={a}`.
- `fn normalize_token_symbol(s)` — map `₮`→`T`, uppercase.
- `async fn ensure_sufficient_balance(required: f64, currency)` (:129) — spawns `onchainos wallet balance --chain 196` (wallet group); non-zero exit → `balance query failed (exit {status}), please check login status`; parse → `failed to parse balance query result: {e}`; scan `data.details[*].tokenAssets|assets[*]` for symbol (`tokenSymbol`|`symbol`) whose normalized form == normalized currency or currency+`0`; `balance` string/number (default 0). If `balance < required` → `InsufficientBalanceError` with message:
  ```
  Insufficient {currency} balance on XLayer (current: {balance}, need: {required}, shortfall: {shortfall})

  Fund your wallet — pick one:
  1. Scan code and recharge directly for your wallet
  {{DEPOSIT_QR}}
  2. Swap on XLayer — "swap <token> to {shortfall} {currency} on xlayer"
  3. Bridge from another chain — "bridge {shortfall} {currency} from <chain> to xlayer"
  4. Send from OKX exchange — withdraw {currency} to your wallet address on XLayer network. The exchange may charge a withdrawal fee

  Note: on-chain gas on XLayer is free after the funds arrive.
  ```
  (f64 values rendered with Rust `{}` Display: `5`, `0.5`, `95`). Token not found → message starting `{currency} balance not found on XLayer (need {required} {currency})` with the same option list using `{required}` in options 2/3, available=0.
- `async fn ensure_sufficient_balance_at(required, currency, address)` (:263) / `query_xlayer_balance(address, currency)` (:215) — same, but spawn `onchainos portfolio all-balances --address <addr> --chains 196`, scan `data[*].tokenAssets[*]` (`symbol`|`tokenSymbol`); messages add `, address: {address}` inside the parentheses; errors `portfolio balance query failed: {e}`, `portfolio balance query failed (exit {status})[, address={address}]`, `failed to parse portfolio balance result: {e}`. `query_xlayer_balance` returns 0.0 when not found.
- `fn validate_job_id_path_component(s)` (:433) — rejects empty, >256 bytes, contains `/` or `\`, `.`/`..`, any control char, or not exactly one normal path component → `CodedError{code:"UNSAFE_JOB_PATH_COMPONENT", field:None, message:"jobId is not a safe path component"}`.
- `fn validate_job_id(id)` (:451) — OK if `id == "_"`, starts with `system_`, or (starts with `0x` and **byte** length 66; hex not checked). Else `Err("--jobid invalid (must be `0x` + 64 chars, got {len} chars). Re-read jobId from envelope (system event / user_decision_* → `message.jobId`; a2a-agent-chat → top-level `jobId`), then retry.")`.
- `fn short_job_id(id)` (:474) — ≤12 chars → as-is; else first 6 chars + `…` (U+2026) + last 4 chars (e.g. `0x1b76…1be1`).
- `fn sanitize_title_for_shell(t)` (:507) — `& | ;` → space; `` ` $ > < ( ) ! `` deleted; collapse whitespace runs to one space; trim.

### 7. `deadline.rs`

- `REVIEW_WINDOW_SECONDS = 259200` (3 days).
- `normalize_timestamp_seconds(v)` — `|v| >= 100_000_000_000` → `v/1000`; result must be > 0 else None.
- `parse_timestamp_seconds(s)` — trimmed i64 → normalize; else RFC3339 → normalize.
- `parse_timestamp_value(v)` — i64 / u64 (≤i64::MAX) / string.
- `first_timestamp(detail, keys)` — first key that parses.
- `review_deadline_from_detail(d)` — `first_timestamp(d,[reviewDeadlineAt, reviewWindowEndsAt, expireTime])` else `first_timestamp(d,[submittedAt, submitTime]) + 259200`.
- `days_left(expire, now)` — ≤0 remaining → 0; else ceil(remaining/86400).
- `format_local_deadline(t)` — local TZ `%m-%d %H:%M`.
- `format_local_timestamp_with_offset(t)` — local TZ `%Y-%m-%d %H:%M (UTC±HH:MM)` e.g. `2023-11-15 06:13 (UTC+08:00)` (**TZ-dependent**).
- `format_utc_timestamp(t)` — `%Y-%m-%d %H:%M (UTC+00:00)` (e.g. `format_utc_timestamp(1700000000) == "2023-11-14 22:13 (UTC+00:00)"`, ms tolerated).
- `deadline_reminder_line(expire?, now, kind)` — None/≤0/unrepresentable → None; else (`when` = `format_local_deadline`):
  - expired Review: `⏰ Review deadline has passed ({when}). The system may auto-accept at any time.`
  - expired Decision: `⏰ Decision deadline has passed ({when}). The system may auto-refund to the buyer at any time.`
  - active Review: `⏰ Review deadline: {days} day(s) (by {when}). If not reviewed in time, the system will auto-accept and release payment to the ASP — irreversible.`
  - active Decision: `⏰ Decision deadline: {days} day(s) (by {when}). If not decided in time, the system will auto-refund to the buyer — irreversible.`

### 8. `state_machine.rs` — enums (single source of truth for event/status strings)

- `Role::parse`: `user|asp|evaluator`.
- `Status` (task): int map `-1 init, 0 created, 1 accepted, 2 submitted, 3 rejected, 4 disputed, 5 admin_stopped, 6 completed, 7 close, 8 expired, 9 failed`, other n → `Other("status_{n}")`. `Status::parse` accepts those strings plus `adminstopped`, `complete`, `closed`; unknown → `Other(s)`. `is_terminal` = completed|close|expired|failed.
- `DisputeRoundStatus` 0..5 = init/commit_phase/reveal_phase/completed/rejected/invalidated (else `unknown`); labels `Evaluation round initializing`, `Vote commitment in progress`, `Vote reveal in progress`, `Evaluation round completed`, `Evaluation round rejected`, `Evaluation round invalidated`, `Round status unavailable`; descriptions: `The evaluation round is being initialized.`, `Selected evaluators are submitting encrypted votes.`, `Evaluators are revealing their previously committed votes.`, `This evaluation round has completed.`, `This evaluation round was rejected.`, `This round produced no valid result and awaits the next round.`, `The evaluation round status is currently unavailable.`
- `Event::parse` — the 57 recognised event names (exact strings): `job_created provider_applied job_provider_reject job_user_reject job_asp_selected job_accepted job_submitted job_completed job_rejected dispute_approved job_disputed job_refunded dispute_resolved job_expired job_asp_accept_expire job_asp_reject_closed job_asp_reject_expire job_closed job_payment_mode_changed evaluator_selected reveal_started vote_committed vote_revealed round_failed vote_commit_deadline_warn vote_reveal_deadline_warn staked unstake_requested unstake_claimed unstake_cancelled reward_claimed submit_expired reject_expired review_expired job_auto_refunded submit_deadline_warn review_deadline_warn stake_stopped cooldown_entered attachment_added user_attachment_received deliverable_received negotiate_reply wakeup_notify sub_open sub_created sub_asp_selected sub_cancel sub_user_reject sub_asp_agree sub_asp_dispute sub_trial_into_active sub_renew sub_expire_warn sub_complete_notify sub_close_notify sub_failed_notify sub_reject_refund_notify sub_asp_claim_notify`; else `Other(s)`.
- `Event::failure_label`: job_auto_refunded→`auto-refund failed`, job_closed→`close failed`, job_payment_mode_changed→`payment mode switch failed`, reward_claimed→`reward claim failed`, dispute_approved→`evaluation request failed`, job_provider_reject→`asp reject failed`, staked→`staking failed`, unstake_requested→`unstake failed`, unstake_claimed→`unstake claim failed`, unstake_cancelled→`unstake cancellation failed`, stake_stopped→`stop staking failed`, cooldown_entered→`cooldown entry failed`, sub_cancel→`cancel subscription failed`, sub_user_reject→`reject subscription delivery failed`, else `transaction failed`.
- `status_when_event(e)` — Created: job_created, provider_applied, job_asp_selected, job_provider_reject, job_user_reject, negotiate_reply, job_payment_mode_changed; Accepted: job_accepted, deliverable_received, submit_deadline_warn; Submitted: job_submitted, review_expired, review_deadline_warn; Rejected: job_rejected, reject_expired, dispute_approved; Expired: submit_expired, job_expired, job_asp_accept_expire; Disputed: job_disputed + all evaluator round events (evaluator_selected, vote_committed, reveal_started, vote_revealed, cooldown_entered, round_failed, vote_commit/reveal_deadline_warn); Completed: job_completed, dispute_resolved; Failed: job_refunded, job_auto_refunded, job_asp_reject_expire; Close: job_closed, job_asp_reject_closed; `Other("staking")`: staked, unstake_*, stake_stopped; `Other("reward_claimed")`; `Other("attachment")`: attachment_added, user_attachment_received; `Other("wakeup")`; `Other("subscription")`: every `sub_*` except `sub_asp_claim_notify`; `Other("notification")`: sub_asp_claim_notify; `Other("unknown")`: anything else.
- `entry_event(status)`: created→job_created, accepted→job_accepted, submitted→job_submitted, rejected→job_rejected, disputed→job_disputed, completed→job_completed, close→job_closed, expired→job_expired, failed→job_refunded, init/admin_stopped/other→None. `parse_status_or_event(s)` = `Event::parse(s)` unless `Other`, then `entry_event(Status::parse(s))` else `Other(s)`.
- `SubStatus` codes -1,0,1,3,4,6,7,8,9 ↔ `Init, Created, Active, Rejected, Disputed, Completed, Closed, Expired, Failed` (`as_str` capitalized; unknown code → Init). Transitions table (`valid_targets`) and `sub_status_after_event` as in source lines 787–840; `parse_sub_status` accepts numeric string or case-insensitive name, unknown → Init.

### 9. `payment_mode.rs`, `config.rs`, `subscription_identity.rs`

- `PaymentMode`: `from_str("escrow"|"x402"|other→Escrow)`, `parse_flag(None→0, Some("escrow")→1, other→Err("unsupported --payment-mode \"{other}\"; valid Task value: escrow"))`, `from_int(1→Escrow,3→X402,else None)`, `as_str` none/escrow/`legacy-x402-disabled`, `as_int` 0/1/3, `desc` `not set`/`escrow payment`/`legacy task payment disabled`.
- `config::keep_conversation_on_terminal()` — runtime env `ONCHAINOS_KEEP_SESSION` (`true` case-insensitive or `1` → true, anything else false) > compile-time env of same name > default **false**.
- `config::is_cli_mode()` — env `CLAUDECODE == "1"` OR env `CODEX_THREAD_ID` non-empty.
- `config::SubscriptionTradePath` enum (`agent_direct` default, `legacy_wrapper`).
- `subscription_identity::select_subscription_agent_id(user, asp)` — first non-blank trimmed of (user, asp) else `agenticId is required for subscription requests`.

### 10. `okx_a2a.rs` — wrappers around the external `okx-a2a` CLI (npm package `@okxweb3/a2a-node`)

All spawn the binary named `okx-a2a` from `PATH` with `std::process::Command` and capture stdout/stderr. On Windows only the helpers that use `npm_cli_command` go through `cmd /C okx-a2a …` (CREATE_NO_WINDOW); the others use `Command::new("okx-a2a")` directly (which on Windows only finds `okx-a2a.exe`). "exit {status}" uses Rust `ExitStatus` Display (`exit status: N` on Unix, `exit code: N` on Windows).

| fn | argv | spawn mode | notes / errors |
|---|---|---|---|
| `probe_communication_readiness()` (:99) | `okx-a2a --version` then `okx-a2a doctor --json` | npm shim, no timeout | env `ONCHAINOS_SKIP_A2A_PREFLIGHT=1` → Ready without spawning. version spawn error or non-zero → NotReady(hint). stderr `[onchainos] checking A2A communication readiness (okx-a2a doctor)...`. doctor stdout not JSON → Unverifiable. verdict = `ready` bool else `ok` bool: true → stderr `[onchainos] A2A communication is ready` → Ready; false → stderr `[onchainos] A2A communication is NOT ready: {userMessage}` → NotReady(build_not_ready_hint); neither → Unverifiable. |
| `version_probe_failure_hint(details)` | — | — | `okx-a2a may not be installed, or the active Node environment may differ from the one used to install it. Switch to the correct Node environment and retry. If it is not installed, run \`npm i -g @okxweb3/a2a-node\` in a compatible Node environment.` + (` Details: {trimmed stderr, or stdout if stderr blank, or spawn error}` when non-empty) |
| `build_not_ready_hint(msg, report)` | — | — | lines: `{userMessage or "A2A communication is not fully ready"}`, then for each non-optional `nextActions[]`: `- {why} (run: {command})` / `- {why}` / `- run: {command}`, then `Run \`okx-a2a doctor --fix\` to repair the local A2A environment, then retry.`; joined with `\n` |
| Unverifiable notes | — | — | no report: `A2A readiness could not be verified: okx-a2a doctor produced no usable report (the installed build may be outdated or broken). Continuing without the check — if communication fails, run \`okx-a2a doctor --fix\` (or reinstall with \`npm i -g @okxweb3/a2a-node@latest\`).`; no verdict: `A2A readiness could not be verified: okx-a2a doctor returned no readiness verdict. Continuing without the check — if communication fails, run \`okx-a2a doctor --fix\`.` |
| `communication_gate_json()` (:217) | (probe) | | Ready → `{"ok":true}`; NotReady → `{"hint":<hint>,"ok":false}`; Unverifiable → `{"note":<note>,"ok":true}` |
| `ensure_communication_ready_preflight()` (:200) | (probe) | | NotReady → error `A2A communication is not ready, so this operation was not executed. {hint}`; Unverifiable → stderr `[onchainos] {note}`, Ok |
| `refresh_agent_identities_silently()` (:232) | `okx-a2a agent refresh --json` | npm shim | skip env honoured; stderr progress lines; never errors |
| `probe_offline_replay_capability()` (:287) | `okx-a2a capabilities --json` | npm shim | reads `messageEligibleOfflineReplay.{ok,fixCommands}`; default fix `npm install -g @okxweb3/a2a-node@latest` |
| `compose_user_notify_content(content, image?)` (:365) | — | — | replace literal `\n` (2 chars) with newline; content containing `file://` or (`![` and `](`) → `local image links in --content are not supported; use --image-path <file>`; image path blank / contains CR/LF → `--image-path must be a non-empty single-line path`; with image → `{content}\n\nMEDIA:{path}` |
| `user_notify(content, image?, print)` (:383) | `okx-a2a user notify --content <c> --json` | direct | image path must exist (`--image-path file not found: {path}`); spawn error `spawn failed: {e}`; non-zero → `okx-a2a user notify exit {status}: {stderr}`; `print` → stdout `OK` |
| `user_notify_scoped(content, job, key)` (:414) | `okx-a2a user notify --content <c> --job-id <job> --idempotency-key <key> --json` | direct, 5 s timeout (kill) | errors `scoped user notify failed: okx-a2a command timed out after 5s` / `okx-a2a scoped user notify exit …` |
| `user_decision_request(user, llm, job?, key?)` (:462) | `okx-a2a user decision-request --user-content <u> --llm-content <l> [--job-id <job>] [--idempotency-key <k>] --json` (job/key only when non-blank) | direct | `spawn failed: …` / `okx-a2a user decision-request exit {status}: {stderr}` |
| `mark_retired_autotrade_{mode_,}decisions_handled(job)` (:568/:580) | `okx-a2a user outdated-list` then `okx-a2a user check --todo-ids <id,id> --json` | npm shim | selects pending `decision_request` items of this job whose `llmContent` contains `--source-event "<retired event>"` |
| `session_query_exists(job, my, to)` (:595) | `okx-a2a session query --job-id J --my-agent-id M --to-agent-id T --json` | direct | true iff `sessions[]` non-empty |
| `session_create(job, my, to)` (:632) | `okx-a2a session create … --json` | direct | returns `session.sessionKey` or top-level `sessionKey` |
| `session_send(job, to?, content)` (:673) | `okx-a2a session send --job-id J --content C --json [--to-agent-id T]` | direct, 5 s timeout | `session send failed: …` / `okx-a2a session send exit …` |
| `session_send_exact(key, content, msg_id)` (:779) | `okx-a2a session send --session-key K --content C --message-id ID --json` | direct, 5 s | |
| `trade_records_insert(input_array)` (:713) | `okx-a2a trade-records insert --input-json <json> --json` | npm shim, 5 s | |
| `xmtp_send(job, to, msg)` (:742) | `okx-a2a xmtp-send --job-id J --to-agent-id T --message M --json` | direct | stdout must be JSON with `ok:true` |
| `session_delete(job, to?)` (:820) | `okx-a2a session delete --job-id J --json [--to-agent-id T]` | direct | `okx-a2a session delete exit {status}: {stderr}` |
| `session_history(job, to)` (:851) | `okx-a2a session history --job-id J --to-agent-id T --json` | direct | returns raw stdout |
| `task_reject_by_job(job, content?)` (:881) | `okx-a2a task reject --job-id J [--content C] --json` | direct | |
| `file_upload(path, agent, job, name?, mime?)` (:931) | `okx-a2a file upload --file-path P --agent-id A --job-id J [--filename] [--mime-type]` | direct | needs `fileKey,digest,salt,nonce,secret,filename` |
| `file_download(key, agent, digest, salt, nonce, secret, name?)` (:995) | `okx-a2a file download …` | direct | stdout `{"path"}` or plain path |

### 11. `a2a_binding.rs`, `onchainos_self.rs`

- `bind_job_provider_to_current_runtime_required(job)` (:75) — trimmed job empty or `?` → `job-provider bind-current requires a valid jobId`; env `OKX_A2A_DISABLE_JOB_PROVIDER_BINDING` truthy (`1|true|yes|on`) → `job-provider binding is disabled by OKX_A2A_DISABLE_JOB_PROVIDER_BINDING`; `okx-a2a job-provider bind-current --job-id J --json` (tokio, stdin null, **3 s timeout**) → JSON `provider` (≠`unknown`) + `created` bool; stderr `[a2a-binding] job provider bind-current ok: jobId=… provider=… created=…`. Errors: `okx-a2a job-provider bind-current returned no provider for jobId={job}`, `okx-a2a job-provider bind-current failed: jobId=… exit=Some(n) stderr=… stdout=…`, `okx-a2a job-provider bind-current unavailable for jobId={job}: spawn \`okx-a2a\` failed: …` / `` `okx-a2a job-provider bind-current --job-id J --json` timed out``. Non-strict variant prints `[a2a-binding] WARN: {error}` and returns None. `rollback_if_created()` runs `okx-a2a job-provider unset --job-id J --provider P --json` when `created`.
- `onchainos_self::task_feedback_exists(agent, task)` — spawn `onchainos agent task-feedback --agent-id A --task-id T`; non-zero → `onchainos agent task-feedback exit {status}: {stderr}`; JSON `data` must be an array (`task-feedback response missing data array`); true iff non-empty.
- `onchainos_self::feedback_submit(provider, user, score, job, comment)` — spawn `onchainos agent feedback-submit --agent-id P --creator-id U --score S --task-id J --description C` (identity group; **state-changing**).

### 12. `deposit_qr.rs` — insufficient-balance enrichment

- constants: `SCAN_TO_DEPOSIT_OPTION = "Scan code and recharge directly for your wallet"`, `DEPOSIT_QR_MARKER = "{{DEPOSIT_QR}}"`, chain label `XLayer`, min QR columns 33.
- `InsufficientBalanceError::new(message, currency, required, available)` → `required/available/shortfall=max(required-available,0)` formatted with f64 Display, `chain_index = chains::resolve_chain("xlayer") = "196"`, `deposit_chain="XLayer"`, `deposit_address=None`. Display = message.
- `fill_qr_marker(msg, _)` → remove `{{DEPOSIT_QR}}\n` then any remaining `{{DEPOSIT_QR}}`.
- `resolve_current_deposit_info(agent)` → `signing::resolve_wallet_by_agent_id(agent)` → `{address, "XLayer", "196"}` or None.
- `maybe_render_qr_stderr(info, currency, shortfall)` — only if stderr is a TTY: if `$COLUMNS` parses and < 33 → stderr `Deposit {currency} to this XLayer address (short {shortfall}):\n{address}`; else stderr `1. Scan code and recharge directly for your wallet`, the Unicode QR (`qr::render_address_qr_unicode`, core), then the same address hint.
- `enrich_blocking(err, agent)` / `enrich_blocking_at(err, address)` — non-IB errors pass through; IB → message = `format!("{err:#}")` with marker stripped; attach `deposit_address`; QR to stderr.
- `balance_warning_base(err)` → `{"available","chain":"XLayer","chainIndex":"196","currency","required","shortfall","sufficient":false}` (sorted); `balance_warning_json(err, agent)` adds `depositAddress`,`depositChain` when resolved and returns the marker-stripped message.

### 13. `funding_notice.rs` helpers (used by other groups' blocked-funding outputs)

- `funding_display_mode()` → `qr::display_mode()` (core: `image-notify` when neither stdout nor stderr is a TTY — or per Codex session metadata —, else `terminal-unicode`).
- `funding_notice_command(warning, reason)` → `None` unless `currency`,`shortfall`,`depositAddress` strings exist; else space-joined `onchainos agent funding-notice --chain {chain|XLayer} --currency {c} --shortfall {s} --deposit-address {a}` + (` --available {v}`, ` --required {v}`, ` --deposit-chain {v}` for each non-empty) + ` --reason {reason} --format json` (no quoting).
- `funding_blocked_envelope(warning, reason, action)` → object (sorted on output): `blocked:true`, `blockedReason:"insufficient-balance"`, `submitted:false`, `balanceWarning:<warning>`, `mustRunFundingNotice:<cmd.is_some()>`, `fundingNoticeCommand:<cmd|null>`, `fundingDisplayMode:<mode>`, `mustRunNotifyCommand:<must && mode=="image-notify">`, `mustRenderMarkdownImageBelowFirstOption:<same>`, `mustRepeatInFinalResponse:true`, `forbidFundingSummary:true`, `finalResponsePolicy:"Final response must repeat the full localized funding notice with all four funding options; put markdownImage under option 1 when present; never summarize."`, `platformPolicy`: (no cmd) `Funding notice unavailable: show balanceWarning, explain deposit address is missing, then end turn.` / (image) `Non-TTY: run fundingNoticeCommand, then notifyCommandArgs for PNG QR, then put markdownImage under option 1 in final.` / (tty) `TTY: run fundingNoticeCommand, show terminalQr and full notice; do not claim PNG was sent.`, `resumeAction:"After the user says topped up, re-enter the owning Reference and run its fresh read-only balance or prepare check. Never rerun a saved write command directly."`, `guidance`: `{action} was blocked by insufficient balance. Save the current business context. Run fundingNoticeCommand, then follow its displayMode. End turn.` (cmd) / `{action} was blocked by insufficient balance. Save the current business context. Show balanceWarning and missing deposit address. End turn.`

### 14. `template_vars.rs`

- Whitelist keys: `__OKX_TASK_TITLE__`, `__OKX_TASK_LABEL_TITLE__`, `__OKX_REFUND_SERVICE_NAME__`, `__OKX_REFUND_JOB_ID__`, `__OKX_REFUND_TASK_TYPE__`, `__OKX_REFUND_CURRENT_PERIOD__`, `__OKX_REFUND_AMOUNT__`, `__OKX_REFUND_BUYER_REASON__`, `__OKX_REFUND_RESPONSE_DEADLINE__`. Placeholder = `{{KEY}}`.
- `decode_and_validate(b64)` — STANDARD base64 of `b64.trim()`; decoded ≤ 16384 bytes; UTF-8; JSON **object** without duplicate keys; every key whitelisted; every value a string ≤ 4096 bytes. Any failure → `TemplateVarError::Invalid` (`TEMPLATE_VARS_INVALID`, message `template variables payload is invalid`).
- `render_all(contents, vars)` — for every whitelisted key: var supplied but `{{KEY}}` in none of the contents → `PlaceholderMissing` (`TEMPLATE_PLACEHOLDER_MISSING`, `a supplied template variable has no matching placeholder`); placeholder present but no var → `ValueMissing` (`TEMPLATE_VALUE_MISSING`, `a declared placeholder has no matching template variable`). Then single left-to-right, non-recursive literal substitution per content (`{{…}}` whose inner text is not a supplied key is copied verbatim).
- `pending_v2::encode_title_vars(copy, label)` → STANDARD base64 of compact JSON `{"__OKX_TASK_LABEL_TITLE__":label,"__OKX_TASK_TITLE__":copy}` (sorted). `encode_refund_decision_vars(service, job, type, period?, amount, reason, deadline)` → base64 of sorted JSON of the refund keys (`__OKX_REFUND_CURRENT_PERIOD__` only when Some).

### 15. `user_lang.rs`

- `detect(text)` — any token containing U+4E00–U+9FFF or U+3400–U+4DBF → Zh; else tokens trimmed of ASCII punctuation, skipping those starting `0x` (case-insens.), containing `://` or `@`, or all-hex; count lowercase ASCII letters; ≥3 → En; else None.
- `record(job, lang)` — writes `zh`/`en` (no newline, `home::write_secure` atomic, 0600) to `$ONCHAINOS_HOME/autotrade/lang/<job>` (only if job matches `[A-Za-z0-9_-]+`) and always to `$ONCHAINOS_HOME/autotrade/lang/_default`. `record_from_user_text` = detect then record. `resolve(job)` per-job → `_default` → En.

### 16. Local caches / markers

- `review_gate` (`$ONCHAINOS_HOME/task/<job>/review-gate`, dir created): `mark_pending` writes `pending` unless file already trimmed-equals `pending`/`approved`; `mark_approved` requires `pending` → writes `approved`, else errors `review-gate state error: expected 'pending', got '{content}'. Please run next-action with \`event=job_submitted\` in --message first.` / `review-gate file does not exist (job_submitted flow was not executed). Please call next-action --role user with \`event=job_submitted\` in --message first.`; `check_and_consume` (used by `complete`, other group) requires `approved` (deletes file) else errors (text in review_gate.rs:101–117).
- `prefilled_notify` (`$ONCHAINOS_HOME/task/<job>/cache/prefilled-notify.json`): `save` = read existing JSON object (parse failure → empty), insert `event_key → content`, write `to_string_pretty` (sorted keys, 2-space indent, no trailing newline); `get(job,key)` returns non-empty string; `clear` deletes file.
- `prefilled_rating` (`$ONCHAINOS_HOME/task/<job>/cache/prefilled-rating.json`): `save` overwrites `{"score":…,"comment":…}` (struct order, pretty); `get` returns None when file missing or score empty; `clear` deletes.
- `deliverables` markers (under the resolved user deliverables dir): `review_awaiting_deliverable` (empty file) — `write_review_marker`/`has_review_marker`/`delete_review_marker`; `review_card_sent` (empty file) — `has_review_card_sent_marker`/`mark_review_card_sent`.

### 17. `deliverables.rs` storage model

- Root `$ONCHAINOS_HOME/deliverables/<role>/`.
- `sanitize_title(title, job)` — `title.trim()` keep only Unicode-alphanumeric chars, first 20 chars; empty → `job_` + first ≤10 **bytes** of job.
- `deliverables_dir(role, job)` — `validate_job_id_path_component(job)`; exact `<root>/<role>/<job>` if it exists; else first sub-directory (readdir order) whose name starts with `<job>_`; else the exact path.
- `Manifest` (`manifest.json`, pretty, struct order): `{"jobId","role","task":{"shortId","title","tokenSymbol"?,"tokenAmount"?,"counterpartyAgentId"?,"counterpartyName"?},"entries":[{"filename","originalName","deliverableType","fileKey"?,"savedAt","sizeBytes"}]}` (`?` = omitted when None).
- `read_manifest(role, job)` → None if absent; JSON errors propagate.

### 18. `arbitration.rs` pure helpers (used by asp/user flows and pending_v2)

- Constants `JOB_REJECTED="job_rejected"`, `SUB_USER_REJECT="sub_user_reject"`; `is_decision_source(e)` = one of them.
- `default_choices(source, job)` → `[{key:"A",actionId:<refund>,params:{jobId}},{key:"B",actionId:<arb>,params:{jobId}}]` with (`agree_refund`,`raise_arbitration`) for job_rejected and (`sub_agree_refund`,`raise_subscription_arbitration`) for sub_user_reject; other sources → `[]`. `DecisionChoice` serialises `{"key","actionId","params"?}` (params omitted when empty).
- `canonical_action_id`: `dispute_raise→raise_arbitration`, `sub_dispute→raise_subscription_arbitration`, `view_dispute→view_arbitration`.
- `parse_choices(raw?, source, job)` — parse JSON array of choices (`invalid --choices-json: {serde err}`) or defaults; canonicalize; `validate_choices`: for decision sources require exactly 2 choices, keys `A`,`B`, action ids == defaults, identical params maps, `params.jobId == job`, only keys `jobId|decisionBindingKey|decisionBindingValue`, binding key ∈ `periodIndex|subStartTime|subEndTime` with non-blank value (both or neither) — else `evaluation choices must map A/B to the source event's allowed actions`. Non-decision sources are not validated.
- `resolve_choice(source, choices, reply)` — non-decision source → `UnsupportedAction`; `deterministic_choice_key(reply.trim())`:
  - `lowered = to_ascii_lowercase`; `starts_x` = first char is x and next char is none/whitespace/`.`/`:`/`,`; `contains_marker(v,c)` = a token of exactly 1 char equal to c after splitting on non-ASCII-alphanumerics.
  - (`starts_a` && marker b) or (`starts_b` && marker a) → ambiguous.
  - A if `starts_a` or lowered starts with `agree refund`|`agree to refund`|`accept refund`|`accept full refund`|`approve refund`; B if `starts_b` or starts with `file dispute`|`raise dispute`|`file arbitration`|`raise arbitration`|`request evaluation`|`start evaluation`|`file for evaluation`; else ambiguous (`ChoiceError::Ambiguous`).
  - choice with key (case-insens.) else `UnsupportedAction`; canonical action must be allowed for the source.
  - key B → reason = text after the leading `b`/phrase, trim-start `[ws . : ,]`, strip a leading case-insensitive `reason` word (if followed by end/ws/`.`/`:`/`,`), trim-start `[ws :]`, trim; empty → `MissingReason`; inserted as `params.reason`.
  - reason codes: `ambiguous_choice`, `arbitration_reason_required`, `unsupported_action`.
- `resolved_action(source, action, job, params?)` — allowed-action check; `params.jobId` must equal job if present; sets `jobId`; raise actions need non-blank `reason`.
- `decision_id(source, job, message?)` → `{job}:{source}:{instance}` with instance = first scalar of `eventId`,`messageId`,`periodIndex`,`subStartTime` else `current`.
- `progression(phase, decision, reason, nextAction, payload)` → `{"decision","nextAction","payload","phase","reason"}` (sorted).
- `blocked_result(reason, job, details)` → compact JSON string of `progression("arbitration_decision","blocked",reason,[],{"details":details,"jobId":job})`.
- `build_decision_result(source, job, name?, amount?, symbol?, message?)` (:170) → blocked `missing_required_facts` (`payload {"jobId","missingFields":[…]}`) when name/amount/tokenSymbol blank, or when serviceName / buyerReason (`refundReason|rejectReason|userReason|reason`) / responseDeadline (`rejectWindowEndsAt|responseDeadline|expireTime`) / currentPeriod (subscription only) / refundDisplay is missing; else `progression("arbitration_decision","requires_user_input","delivery_rejected", [{key,id,recommend:false,params}×2], payload{jobId, decisionId, taskType("Subscription"|"One-time"), name, serviceName, amount, tokenSymbol, currentPeriod("{start}–{end}" local-offset or null), requestedRefund("No refund required" if amount all 0/. else "{amount} {symbol}"), buyerReason, refundReason, responseDeadline(local-offset string), responseDeadlineTimestamp, responseDeadlineLabel(UTC string), statusLabel:"Awaiting ASP decision", statusDescription:"The refund request is waiting for the ASP's decision.", refundDisplayB64, extraFields{periodIndex,subStartTime,subEndTime,rejectWindowEndsAt,expireTime when non-null}})`. For sub_user_reject each choice's params gain `decisionBindingKey`/`decisionBindingValue` from the first of `periodIndex|subStartTime|subEndTime` in the message.
- `RefundDisplayMetadata {serviceName, taskType("One-time"|"Subscription"), amount (validate_decimal: `\d+(\.\d+)?`), tokenSymbol, responseDeadline (>0, UTC-formattable)}`; `encode()` = URL_SAFE_NO_PAD base64 of compact JSON in struct order; `decode()` errors `invalid refund display metadata encoding: …`, `invalid refund display metadata payload: …`, `invalid refund display task type`, `refund display metadata is incomplete`; `refund_amount_label()` = `No refund required` for zero decimals else `{amount} {symbol}`.
- `build_list_result` / `build_detail_result` — see `arbitration-list` / `arbitration-detail` below.

### 19. `query.rs` shared helpers

- `resolve_agent_id(agent, role)` (:22) — explicit or `signing::resolve_agent_id_by_role(role)` (may be `""`).
- `resolve_agent_id_or_error(agent, role)` (:116) — R1 explicit trimmed non-empty → it; R2 `resolve_agent_id_by_role(role)` non-blank → it (1 subprocess `get-my-agents`); R3–R6 `fetch_my_agents()` again (2nd subprocess) → exactly one usable id → it; ≥2 → `This account has {n} identities: [agentId={id} role={user|asp|evaluator|unknown}], [agentId=… role=…]. Pass --agent-id to choose the identity to query.`; 0/malformed → `no agent identity found on this account. Register an identity (route to okx-ai) or pass --agent-id <id> to choose one.`
- `fetch_task_detail(client, job, agent)` → `GET /priapi/v1/aieco/task/{job}` (identity).
- Label tables: `status_name(code)` 0..9 = created/accepted/submitted/rejected/disputed/admin_stopped/complete/close/expired/failed else unknown. `task_status_label`: -1 Initializing, 0 Awaiting ASP acceptance, 1 In progress, 2 Awaiting buyer review, 3 Awaiting refund decision, 4 Evaluation in progress, 5 Stopped by platform, 6 Completed, 7 Closed, 8 Expired, 9 Refund completed, else Status unavailable. `task_status_description`: -1 `The task is being initialized.`, 0 `The task is waiting for an ASP to accept it.`, 1 `The ASP accepted the task and is working on it.`, 2 `The ASP submitted the deliverable and is waiting for buyer review.`, 3 `The buyer rejected the deliverable and the refund request awaits an ASP decision.`, 4 `The refund request is in Evaluation.`, 5 `The platform stopped the task.`, 6 `The task completed and funds were released to the ASP.`, 7 `The task is closed.`, 8 `The task expired.`, 9 `The refund completed and the task is closed.`, else `The task status is currently unavailable.` Subscription tables (query.rs:416–459): names -1 init,0 created,1 active,3 rejected,4 disputed,6 completed,7 closed,8 expired,9 failed; labels Initializing / Awaiting ASP acceptance / Active / Awaiting ASP decision / Evaluation in progress / Completed / Closed / Expired / `Subscription result needs reconciliation`; descriptions `The subscription is being initialized.` / `The subscription is waiting for an ASP to accept it.` / `The subscription is active.` / `The buyer rejected the current delivery and is waiting for the ASP's decision.` / `The subscription refund request is in Evaluation.` / `The subscription completed without a refund.` / `The subscription is closed.` / `The subscription expired.` / `The subscription result requires settlement reconciliation.` / `The subscription status is currently unavailable.`
- `status_copy_for_task_type(jobType, code, detail, user_close)` — jobType 0 → task tables; jobType 1 with code 8|9 → `lifecycle::subscription_status_copy(detail, user_close)` (returns `(status_label, status_label)` — label and description are the **same** string); jobType 1 otherwise → subscription tables; else `("Status unavailable","The task type is unknown, so its status cannot be interpreted safely.")`.

### 20. `lifecycle.rs` shared helpers

- `subscription_status_copy(detail, user_close)` — builds the subscription snapshot (no events, history ok) and returns `(status_label, display.current_summary)`.
- `initial_creation_display()` — one-time `build_display(Initializing)` with timeline[0].detail = `Creation submitted; waiting for task confirmation` (used by `create-task`, other group).
- `parse_history(raw)` / `events_from_history(job, messages)` — see `agent lifecycle`.

### 21. `pending_v2.rs` shared helpers

- `has_pending_for_job(job, role)` — lock-free read of the queue; any entry with same job+role.
- `cancel_all_for_job(job)` — lock, read, invariant/evict, remove all entries with `job_id == job`; if any removed rewrite snapshot and queue; returns count.
- `push_decision_direct(job, role, agent, to?, user_content, label, source_event)` = `request_prompt_inner(…, metadata default, no template vars, print_ok=false)`.
- `request_command_block(job, role, agent, to?, user_content, label_full, source_event)` → text (content `\`→`\\`, `"`→`\"`; `to_flag` = ` --to-agent-id "<t>"` or empty):
  ~~~
  **Localize first** — translate the `--user-content` and `--list-label` values below to the user's language before running. Keep the bash structure / flags / source-event token unchanged.

  ```bash
  onchainos agent pending-decisions-v2 request \
    --job-id {job} --role {role} --agent-id {agent}{to_flag} \
    --user-content "{content}" \
    --list-label "{label}" \
    --source-event {source_event}
  ```
  ~~~
  (no trailing newline; `  ` = two literal spaces.)

### 22. `session_cleanup::handle_session_cleanup(job, print)` — see `agent session-cleanup`.

---

## Commands

Conventions used below: "identity GET" = `TaskApiClient::get_with_identity` (JWT + `agenticId` + `?sessionCert=` query); "agent GET" = `get_with_agent_id` (JWT + `agenticId`, no query); "sub-spawn X" = self-subprocess described in §2. Unless stated, output JSON is `{"ok":true,"data":…}` on one line with **sorted keys inside `data`**.

### `onchainos agent status <JOB_ID>`  (hidden: no)
- Handler: `common/query.rs:184` `handle_status` (dispatch mod.rs:1686, role = `AGENT_ROLE_USER`).
- Options: positional `JOB_ID` (String, required, not validated); `--agent-id <AGENT_ID>` (optional, default `""`).
- Auth: jwt-required.
- Steps:
  1. `agent = resolve_agent_id_or_error(--agent-id, 1)` (§19; up to two `get-my-agents` sub-spawns when omitted).
  2. identity GET `/priapi/v1/aieco/task/{JOB_ID}`.
     - On error: identity GET `/priapi/v1/aieco/task/{JOB_ID}/dispute/status` (`DisputeStatusResponse`: requires `jobId` string; `jobType`, `currentRound`, `selectedVoter`, `taskStatus`(default 0), `disputeRoundStatus`|`disputeStatus`, `prepareEndTime`, `roundEndTime`, `tokenAmount`, `tokenSymbol` optional). If that also fails → return the **original task-detail error**. If `jobType == 1` → `fetch_subscription` (identity GET `/priapi/v1/aieco/task/subscribe/{JOB_ID}`, errors → `{}`) else `{}`; print `build_detail_result(job, supplement, dispute, None, None)` (see arbitration-detail) and exit 0.
  3. `jobType` = integer(`jobType`). If 1 → `fetch_subscription` (errors → None).
  4. status code: jobType 0 → task `status`; jobType 1 → subscription `subStatus` else `status` (None if no sub detail); other → None.
  5. code 4 → identity GET `…/{job}/dispute/status` (error propagates, exit 1); code 6 or 9 → same GET, errors ignored.
  6. dispute obtained → print `build_detail_result(job, status_detail=sub detail or task detail, dispute, None, None)` JSON.
  7. else plain text (task fields from the TASK detail `t`):
     ```
     Task type: {one_time|subscription|unknown}
     Task status: {label}
     Status detail: {description}
       jobId:    {JOB_ID}
       title:    {t.title|?}
       description: {t.description|?}
       budget:   {t.tokenAmount|?} {t.tokenSymbol|?}
       user:    {t.buyerAgentId|?}
       asp: {t.providerAgentId}          ← only when it is a string
     ```
     label/description = `status_copy_for_task_type(jobType, code, status_detail, user_close)` where `user_close` = jobType 1 && `user::refund::has_created_subscription_close_receipt(job, agent)` (reads the refund pending-mutation file owned by the user group); code None → `Status unavailable` / `The task status is currently unavailable.`
- Output: text above, or the arbitration JSON.
- Errors: identity resolution errors (§19); task error when dispute fallback also fails (e.g. `Wallet API error (code=…): …`); dispute error when status 4; JWT error.
- Side effects: read-only (reads local refund receipt file).
- Nondeterminism: when JSON branch — `status`/`arbitrationPhase` depend on wall clock vs `prepareEndTime`; local-TZ timestamp strings.
- Parity test cases: SAFE `agent status 0x<64hex> --agent-id 1001`; SAFE `agent status 0x<64hex>` (no agent id → sub-spawn); SAFE `agent status not-a-job --agent-id 1001` (error path).

### `onchainos agent lifecycle <JOB_ID>`  (hidden: no)
- Handler: `common/lifecycle.rs:265` `handle_lifecycle`.
- Options: `JOB_ID` (required); `--agent-id` (optional, default `""`).
- Auth: jwt-required.
- Steps:
  1. `agents = fetch_my_agents_by_role("user")` (sub-spawn `agent get-my-agents --owner-address <addr> --role user --page-size 100`; empty on failure).
  2. `select_current_wallet_user_agent`: explicit id must match an agent with `agentId`==id and `role` 1 (number or numeric string) or `"user"` (case-insens.); no explicit → first such agent. None → print `unavailable_snapshot(job, "Current wallet identity could not be confirmed, so local task history was not read.")`, exit 0.
  3. identity GET `/priapi/v1/aieco/task/{job}`.
     - Error: `local = read_scoped_local_history(job, agent)`; events; try identity GET `/priapi/v1/aieco/task/subscribe/{job}` (via `subscription_ops::fetch_subscribe_detail_for_agent`); if OK and its `jobId` string == job → print subscription snapshot (with `user_close` receipt) and exit. Else `snapshot_from_local_fallback`, set `display.notice` = `Latest task details are unavailable; showing the latest verified local task record.` if history available else `Task details and verified local history are unavailable. Try again later.`; print.
  4. `projected = {jobType (int, numeric string, or "one_time"/"subscription"), status (Status::from_int of int/numeric string), providerAgentId|aspAgentId, amount from refundAmount|paymentTokenAmount|tokenAmount, symbol from refundTokenSymbol|paymentTokenSymbol|tokenSymbol}`.
  5. Local history = SQLite (below) + if provider known: `okx-a2a session history --job-id J --to-agent-id P --json` → `parse_history`; success sets `history_read_succeeded=true` and appends messages.
  6. jobType 1 → subscription detail GET; mismatch/err → unavailable snapshot (`The subscription type was confirmed, but its latest subscription detail is unavailable. Try again later.`, taskType `subscription`, aspAgentId=provider); else print subscription snapshot.
  7. `reconcile_current` — jobType = projected or last event's jobType; status = projected or last event-derived status (`status_from_local=true` when projected status missing).
  8. reconciled jobType None or 1 → try subscription GET; matching → subscription snapshot.
  9. reconciled jobType ≠ 0 → unavailable (`The task type could not be confirmed as a one-time task.`, taskType subscription/unsupported/unknown). Status None → unavailable (`The latest task details do not include a usable current status.`, taskType one_time).
  10. one-time snapshot: `build_snapshot_with_history_state(job, status, messages, read_ok)`; if from local → `statusSource="local_official_event"`, confidence `partial`; `aspAgentId`=provider; milestones filled from detail (`createdAt|createTime`, `acceptedAt|acceptTime`, `submittedAt|submitTime`, `completedAt|completeTime`, `rejectedAt|rejectTime`, `disputedAt|disputeTime`, `disputeResolvedAt|arbitrationCompletedAt`, `closedAt|closeTime`, `expiredAt`, `refundedAt|refundTime`, `failedAt|failureTime`; only fills empty slots; values are the raw scalar string); `reviewDeadlineAt` = first_timestamp(detail,[reviewDeadlineAt,reviewWindowEndsAt,expireTime]) else last `job_submitted` event deadline else submittedAt+259200 → **stringified integer seconds**; `display = build_display(phase, milestones, reviewDeadlineAt, amount, symbol, events, deliverable_available, notice)` where `deliverable_available` = local user manifest (job/role match) whose last entry filename is a single component and is a regular file; notice = `Some historical times are unavailable; the current stage comes from the latest task details.` when no events.
- **Local SQLite read** (`read_scoped_local_history`, :2451): only if job and agent match `[A-Za-z0-9_:-]{1,256}`; DB `~/.okx-agent-task/sqlite/command-store.sqlite` (**`dirs::home_dir()`, NOT `ONCHAINOS_HOME`**); root, `sqlite/` and db must not be symlinks, db must be a file under canonical root; open READ_ONLY|NO_MUTEX, busy_timeout 100 ms; `SELECT id, command_json, created_at_ms FROM command_queue WHERE type = 'ai-dispatch' AND length(command_json) <= 131072 AND instr(command_json, ?job) > 0 ORDER BY created_at_ms ASC LIMIT 512`; per row parse JSON `command`; `content` = `command.content` (object or JSON string); owner = `command.clientAgentId`|`content.clientAgentId` must equal agent, else `command.agentId`|`content.agentId`; envelope = `content.message` if object else content, must have `source` = `system` (case-insens.) and `jobId` == job; message `id` = `command.messageId` else row id; `sentAt` = `command.createdAt` scalar else `created_at_ms`; `deliveryStatus:"local"`. Any open/prepare/query failure → empty + `read_succeeded=false`.
- **Events** (`events_from_history`, :1252): dedupe by message id; envelope as above (object content or JSON string, `.message` if object) with `source=system` and `jobId` == job; `event` name → kind table (lifecycle.rs:1370–1406; unknown names ignored); `occurredAt` = first scalar of `occurredAt|eventTime|timestamp|createdAt` else message `sentAt`; `deadlineAt` = first of `reviewDeadlineAt|reviewWindowEndsAt|rejectWindowEndsAt|acceptDeadline|trialEndTime|trailEndTime|subBufferEndTime|expireTime`; dedupe by `eventId` else `{job}:{name}:{occurredAt}`; `jobType` from `jobType` or 1 for `sub_*`; `outcome` first of `renewResult|cancelResult|disputeResult|evaluationResult|winner|verdict|result`; `reason` first of `failReason|failReasopn|aspRejectReason|refundReason|rejectReason|reason`; `authoritativeStatus` first of `subStatus|jobStatus|taskStatus|status`; sort by (parsable timestamp asc, unparsable last by string), then messageId. Scalars: non-blank string kept as-is (untrimmed) or number `to_string`.
- **One-time projection**: phase from status (init→initializing, created→waiting_for_asp, accepted→asp_executing, submitted→waiting_for_user_review, rejected→rejected, disputed→disputed, completed→completed, close/admin_stopped→closed, expired→expired, failed→refunded, other→unknown). `statusLabel`: init `Task initializing`, created `Waiting for ASP acceptance`, accepted `ASP executing`, submitted `Waiting for user review`, rejected `Deliverable rejected`, disputed `Platform review in progress`, admin_stopped `Stopped by platform`, completed `Task completed`, close `Task closed`, expired `Task expired`, failed `Refund completed`, other `Status unavailable`. `responsibleParty`: initializing/disputed/unknown `official`; waiting_for_asp/asp_executing/free_trial/active_subscription/awaiting_asp_decision `asp`; renewal_grace_period/waiting_for_user_review/rejected `user`; terminal `none`. `nextAction` per lifecycle.rs:1599–1618. confidence: Other status → `unknown`; latest terminal event (completed/closed/expired/refunded/failed, or dispute_resolved with parsable status) disagrees with a non-terminal status, or differs from terminal status (AdminStopped vs Close tolerated) → `conflict`; no events → `partial`; else `confirmed`. `authoritativeStatus` = `Status::as_str`, `statusSource="task_api"`. Milestones folded from first event of each kind. `display` = `build_display` (lifecycle.rs:1893–2442): always 5 timeline nodes `{marker ✓|▶|○|—, key, title, detail?}` with keys `created, accepted, asp_execution, user_review, completed`, `progressTotal 5`, `followUp` nodes, `currentSummary`, `handledBy`, `next`, `reviewReady`; times via `format_local_timestamp_with_offset`, ranges `{a} - {b}`, `Time unavailable`, `Not started`/`Not completed`; port the full table verbatim from source.
- **Subscription projection** (`build_subscription_snapshot_with_user_close`, :465): status = `status`|`subStatus`; trialType, autoRenew, periodIndex; milestones (`createdAt|createTime`, `acceptDeadline|acceptExpireTime|expireTime`, `acceptedAt|acceptTime`, `trialStartTime|trailStartTime`, `trialEndTime|trailEndTime`, `subStartTime|periodStart`, `subEndTime|periodEnd`, `subBufferEndTime|graceEndsAt`, `nextChargeAt|nextChargeTime`, `rejectedAt|rejectTime`, `disputedAt|disputeTime`, `completedAt|completeTime`, `closedAt|closeTime`, `expiredAt`, `refundedAt|refundTime` + event fallbacks); `refund_proven` = trialType ≠ 1 && (`user::refund::authoritative_refund_settlement_confirmed(ctx with jobType=1,status,trialType, 9)` [status 9 and positive decimal `paymentTokenAmount|tokenAmount` and trialType≠1] or (`refundedAt` and `refundTxHash|refundTransactionHash`)); `in_grace` = status 1 ∧ autoRenew 1 ∧ now ≥ subEndTime ∧ now < subBufferEndTime; phase and **template number** 1–18 (lifecycle.rs:713–736) → `statusLabel` (`Sub-Status-N` labels lines 744–762), `responsibleParty`, `nextAction` (lines 863–918, times via local-offset formatting, amount = `serviceTokenAmount|tokenAmount|paymentTokenAmount|refundAmount` else `an unavailable amount`, token likewise else `an unavailable token`), display (4-node `created/accepted/service/ended` timeline, 3-node closed-before-service, or 5-node refund timeline), `templateId:"Sub-Status-N"`, choices `["Continue waiting for ASP acceptance","Close task"]` for template 2, notice `To rate this task, reply "Rate job".` for templates 3,4,5,13,17,18. Close-pending override (status 0 ∧ local close receipt): label `Subscription closure submitted`, party `platform`, next `Wait for the subscription lifecycle and wallet order to confirm the closure.`, choices cleared, notice `The close request is already submitted. Do not submit another close request while reconciliation is pending.`; `authoritativeStatus` = `SubStatus::as_str` (`Active`, …) or `unknown_{n}` / `unavailable`; `statusSource:"subscription_detail"`; confidence unknown/confirmed/partial.
- Output: `{"ok":true,"data":<snapshot>}` — **struct field order** (not sorted): one-time `jobId, taskType, phase, statusLabel, responsibleParty, nextAction, confidence, authoritativeStatus, statusSource, historyAvailable, historyReadSucceeded, historyEventCount, aspAgentId, reviewDeadlineAt, milestones{createdAt, acceptedAt, submittedAt, completedAt, rejectedAt, disputeRequestedAt, disputedAt, disputeResolvedAt, reviewExpiredAt, rejectExpiredAt, closedAt, expiredAt, refundedAt, failedAt}, events[{messageId, eventId, name, kind, occurredAt, deadlineAt, authoritativeStatus, jobType, outcome?, reason?, senderInboxId}], display{templateId?, progressStep, progressTotal, deliverableAvailable, reviewReady, timeline[{marker,key,title,detail?}], followUp?, choices?, currentSummary, handledBy, next, notice?}, syncedAt`; subscription adds `trialType, autoRenew, periodIndex, refundAmount, refundTokenSymbol, refundTxHash` after `reviewDeadlineAt` and uses the subscription milestone set (`createdAt, acceptDeadlineAt, acceptedAt, trialStartedAt, trialEndsAt, trialConvertedAt, currentPeriodStartedAt, currentPeriodEndsAt, gracePeriodEndsAt, nextChargeAt, lastRenewedAt, renewalWarningAt, cancellationRequestedAt, rejectedAt, disputedAt, completedAt, closedAt, expiredAt, refundedAt`). Enums snake_case (`waiting_for_asp`, `confirmed`, `subscription_created`, …). `unavailable_snapshot`: taskType `unknown`, phase `unknown`, statusLabel `Status unavailable`, authoritativeStatus `unavailable`, statusSource `unavailable`, confidence `unknown`, notice set.
- Errors: none beyond JWT/panics — all fetch failures degrade into snapshots (exit 0).
- Side effects: read-only (reads SQLite read-only, local manifests, spawns okx-a2a read).
- Nondeterminism: `syncedAt` = `Utc::now().to_rfc3339()`; grace-period and local-TZ formatting.
- Parity test cases: SAFE `agent lifecycle 0x<64hex>`; SAFE `agent lifecycle 0x<64hex> --agent-id <user-agent>`; SAFE `agent lifecycle 0x<64hex> --agent-id 999999` (not owned → unavailable snapshot).

### `onchainos agent tasks`  (visible alias `list`; hidden: no)
- Handler: `common/query.rs:307` `handle_list` (role 1).
- Options: `--status <STATUS>` (optional string), `--page <u32>` default `1`, `--limit <u32>` default `20`, `--agent-id` optional.
- Auth: jwt-required.
- Steps: 1) `agent = resolve_agent_id_or_error(--agent-id, 1)`. 2) `--status disputed` → `arbitration::handle_arbitration_list(client, agent, page, limit)` (identical to `agent arbitration-list`, including `--page-size` validation message for limit 0). 3) else identity GET `/priapi/v1/aieco/task/my?page={page}&page_size={limit}` + `&status={status}` (raw, not encoded) (+ `?sessionCert=` quirk).
- Output (plain text): `Task list ({data.total|0} total, page {page}):` then per `data.list[]`: `  [{task_status_label(status)|Status unavailable}] {jobId|?} — {tokenAmount|?} {tokenSymbol|?}` and `       {title|?}` (7 spaces).
- Errors: identity resolution; API errors.
- Side effects: read-only.
- Nondeterminism: none.
- Parity: SAFE `agent tasks --agent-id 1001`; SAFE `agent list --status accepted --page 2 --limit 5 --agent-id 1001`; SAFE `agent tasks --status disputed --agent-id 1001`.

### `onchainos agent refund-list`  (hidden: no)
- Handler: `refund_list.rs:132` `handle_refund_list`.
- Options: `--role <buyer|provider>` required (ValueEnum lower-case); `--scope <available|requested>` required; `--page <u32>` default 1; `--page-size <u32>` default 20; `--agent-id` optional.
- Auth: jwt-required.
- Steps:
  1. provider + scope ≠ requested → `provider refund-list supports only --scope requested`.
  2. `agent = resolve_agent_id_or_error(--agent-id, buyer→1 | provider→2)`.
  3. identity GET `/priapi/v1/aieco/task/my?page={page}&page_size={size}&status={submitted|rejected}` (available→submitted, requested→rejected).
  4. `subscription_ops::fetch_my_subscriptions_snapshot_for_agent_read_only(client, role, Some(1|3), agent)` (user group): agent GET `/priapi/v1/aieco/task/subscribe/my` (no query), client-side filter by role/status; errors `failed to fetch subscriptions: …` / `failed to parse subscription list: …`.
  5. candidates = one-time `list[]` then subscription `list[]`, dedupe by trimmed `jobId`, keep list-only `rejectDeadline` (int or numeric string).
  6. per candidate `user::refund::fetch_refund_list_item_for_identity(client, job, agent, buyer?)` (user group): identity GET task detail (`failed to fetch authoritative task detail`), `jobType` required (`task detail is missing jobType`), jobType 1 → identity GET subscribe detail (`failed to fetch authoritative subscription detail`); buyer ownership enforced for buyer role; missing provider name → sub-spawn `get-agents` for the provider. **Any error aborts the whole command.**
  7. keep item iff (available ∧ `refund_request_available`) or (requested ∧ `status == 3`).
  8. deadline for sorting: provider+requested → `rejectDeadline` else item deadline; if `rejectDeadline` present set `display.responseDeadlineTimestamp = rejectDeadline` and `display.responseDeadline = format_local_timestamp_with_offset(rejectDeadline)` or null.
  9. provider → stable sort ascending by deadline (missing last).
- Output: `{"items":[<display objects, passthrough, sorted keys>],"role":"buyer|provider","scope":"available|requested","total":<items.len()>}`.
- Errors: as listed; validation message above (exit 1).
- Side effects: read-only.
- Nondeterminism: local-TZ strings.
- Parity: SAFE `agent refund-list --role buyer --scope available --agent-id 1001`; SAFE `agent refund-list --role provider --scope requested --agent-id 2002`; SAFE `agent refund-list --role provider --scope available` (validation error).

### `onchainos agent refund-detail <JOB_ID>`  (hidden: no)
- Handler: `refund_list.rs:202` `handle_refund_detail`.
- Options: `JOB_ID` required; `--role <buyer|provider>` required; `--agent-id` optional.
- Auth: jwt-required.
- Steps: 1) resolve agent (role-mapped). 2) `fetch_refund_list_item_for_identity` (as above). 3) buyer ∧ item.status == 6 ∧ `refund_request_provenance` → identity GET `/…/{job}/dispute/status`, kept only if `taskStatus == 6` (errors ignored).
- Output `data` (sorted): `{"decision": "requires_user_input" (provider ∧ status 3) | "ready", "nextAction": provider∧3 ? [{"id":<agree_refund|sub_agree_refund>,"params":{"jobId":job},"recommend":false},{"id":<raise_arbitration|raise_subscription_arbitration>,…}] (sub variants when jobType 1) : [], "payload":{"display":<item.display + when terminal evaluation: evaluationResult:"asp_won", evaluationResultLabel:"ASP won; refund not issued", evaluationResultDescription:"The Evaluation concluded in favor of the ASP. The task funds were released to the ASP and no refund was issued.", evaluationReason:"The Evaluation service did not return a specific evaluator rationale.">}, "phase": status==3 ? "refund_request_detail" : "refund_status_detail", "reason": item.reason}`.
- Side effects: read-only. Parity: SAFE `agent refund-detail 0x<64hex> --role buyer --agent-id 1001`; SAFE `… --role provider --agent-id 2002`.

### `onchainos agent active-tasks`  (hidden: no)
- Handler: `common/query.rs:670` `handle_active_tasks`.
- Options: `--role <user|asp|evaluator>` optional (case-insens., trimmed); `--include-terminal` bool flag.
- Auth: jwt-required.
- Steps: 1) `agents = fetch_my_agents()` (sub-spawn, empty on failure). 2) `--role` invalid → `unrecognized --role value: "{raw}" (expected user / asp / evaluator)` (Debug-quoted); filter by role number. 3) for each agent with non-empty agentId (in list order): if role 1|2: for statusType in `[1]` (or `[1,2]` with `--include-terminal`): identity GET `/priapi/v1/aieco/task/subscribe/my?page=1&pageSize=100&statusType={t}` (errors skip); rows from `data.list` or bare array → subscription rows. Then identity GET `/priapi/v1/aieco/task/my?page=1&page_size=100` (errors skip) → rows with jobType 0 or missing (jobType 1/other skipped). Evaluator agents only get the `/task/my` call.
  - row (`active_task_row`): status = one-time `status` / subscription `subStatus`|`status` (int or numeric string; missing → skip); non-terminal filter one-time 0..4, subscription -1,0,1,3,4 (unless include-terminal); jobId = `jobId`|`subId` (empty → skip); dedupe key `myAgentId\0jobId` (first wins; subscriptions inserted first).
- Output `data`: `{"tasks":[…],"totalAgents":<agents after filter>,"totalTasks":n}`; each task (sorted keys): `counterpartyAgentId` (role1 → `providerAgentId|aspAgentId`, role2 → `buyerAgentId|userAgentId`, else/empty → null), `counterpartyRole` (`asp`/`user`/null), `jobId`, `myAgentId`, `myRole` (user/asp/evaluator/unknown), `shortJobId` (byte-based: len<12 → as-is else first 6 bytes + `…` + last 4 bytes), `status` (task `status_name` / subscription name), `statusCode`, `statusDescription`, `statusLabel`, `taskType` (`one_time`|`subscription`), `title` (`title|jobName|serviceName` else ""), `tokenAmount` (`serviceTokenAmount|paymentTokenAmount|tokenAmount`), `tokenSymbol` (`serviceTokenSymbol|paymentTokenSymbol|tokenSymbol`). Subscription status label/description via `status_copy_for_task_type(Some(1),…)` with `user_close` receipt.
- Side effects: read-only. Parity: SAFE `agent active-tasks`; SAFE `agent active-tasks --role asp --include-terminal`; SAFE `agent active-tasks --role foo` (error).

### `onchainos agent arbitration-list`  (hidden: no)
- Handler: `arbitration.rs:739` `handle_arbitration_list` (include_test_flag=false).
- Options: `--agent-id <AGENT_ID>` required; `--page <u32>` default 1 range ≥1; `--page-size <u32>` default 20 range ≥1 (clap rejects 0).
- Auth: jwt-required.
- Steps: 1) trimmed agent empty → `--agent-id must not be empty`; page 0 → `--page must be greater than 0`; size 0 → `--page-size must be greater than 0`. 2) agent GET `/priapi/v1/aieco/task/dispute/my?page={page}&pageSize={size}`. 3) for each `list[]` item with non-blank `jobId`: agent GET `/priapi/v1/aieco/task/{jobId}/dispute/status` (parse → `DisputeStatusResponse`, errors → None).
- Output `data` = `progression("arbitration_list","ready", items empty?"no_arbitrations":"arbitrations_found", allowedJobIds.empty? [] : [{"id":"view_arbitration","params":{"allowedJobIds":[…],"confirmationRequired":false},"recommend":false}], {"items":[…],"page":page,"total":data.total|0})`. Item (sorted keys): `arbitrationPhase` (`resolved` for taskStatus 6|9; for 4: `evidence_preparation` if now ≤ prepareEndTime (ms compare if deadline ≥1e11) else `in_progress`; missing deadline/other → `unknown`), `arbitrationPhaseDescription`, `arbitrationPhaseLabel` (tables arbitration.rs:929–945), `description` (item `title`|null), `evaluationStarted` (local-offset string of `disputeTime|evaluationStartedAt|createdAt|createTime` or null), `evaluationStatus` (`evidence_preparation|evaluating|decided|unknown`), `jobId`, `keyTime` (Evidence preparation → prepareEndTime, Evaluating → roundEndTime, Decided → `resolvedAt|decisionTime|updatedAt|updateTime`, formatted local-offset, else null), `occurredAt` (raw `createTime`|null), `serviceName` (`serviceName|title|jobTitle`|null), `status` = `statusLabel` (`Evidence preparation`|`Evaluating`|`Decided`|`Status unavailable`), `statusDescription`, `taskStatus` (backend name) / `taskStatusCode` / `taskStatusLabel` / `taskStatusDescription` (arbitration.rs:860–909; null when unknown), `verdict` (`asp_won` for 6, `asp_lost_auto_refund` for 9, else null), `verdictDescription`, `verdictLabel`. taskStatus = dispute `taskStatus` if fetched else item `status`.
- Side effects: read-only. Nondeterminism: wall-clock phase; local TZ.
- Parity: SAFE `agent arbitration-list --agent-id 1001`; SAFE `agent arbitration-list --agent-id 1001 --page 2 --page-size 5`; SAFE `agent arbitration-list --agent-id "  "` (error).

### `onchainos agent arbitration-detail <JOB_ID>`  (hidden: no)
- Handler: `arbitration.rs:807` `handle_arbitration_detail`.
- Options: `JOB_ID` required; `--agent-id` required.
- Auth: jwt-required.
- Steps: 1) trim; `jobId must not be empty` / `--agent-id must not be empty`. 2) agent GET `/priapi/v1/aieco/task/{job}/dispute/status` (error propagates); parse (`failed to parse evaluation detail response: {serde}`). 3) jobType 1 → identity GET `/task/subscribe/{job}` else identity GET `/task/{job}` (errors → `{}`). 4) agent GET `/priapi/v1/aieco/task/{job}/evidence` (errors → None).
- Output `data` = `progression("arbitration_detail","ready","arbitration_found",[],payload)`; payload (sorted): `amount` (dispute `tokenAmount` else scalar `tokenAmount|serviceTokenAmount`), `arbitrationPhase*`, `buyerReason` (`evidence.client.reason`|null), `currentRound`, `deadline` (prepareEndTime in evidence_preparation, roundEndTime in in_progress, else null), `description` (`title|serviceName`), `disputeRoundStatus`, `evaluationStarted` (local-offset of status payload `disputeTime|createdAt|createTime` else supplement `disputeTime`), `evaluationStatus`, `fundDestination` (`fundDestination|fundsTo`), `jobId`, `jobType` (dispute), `occurredAt` (`disputeTime|updatedAt|updateTime|createdAt|createTime` raw), `prepareEndTime`, `refundAmount`, `requestedRefund` (display_amount), `roundEndTime`, `serviceName` (`serviceName|title|jobTitle`), `status`, `statusDescription`, `statusLabel`, `taskStatus*`, `tokenSymbol`, `verdict` (from status 6/9 else supplement `verdict|disputeResult`), `verdictDescription`, `verdictLabel`.
- Side effects: read-only. Parity: SAFE `agent arbitration-detail 0x<64hex> --agent-id 1001`; SAFE `agent arbitration-detail "" --agent-id 1001` (error).

### `onchainos agent designated-route`  (hidden: no)
- Handler: `common/mod.rs:919` `handle_designated_route` → `designated_route_inner` (:802).
- Options: `--provider <agentId>` required; `--service-id` optional.
- Auth: jwt-required (via subprocesses).
- Steps: trimmed provider empty → `--provider must not be empty`; concurrently `query_agent_by_id_direct(id)` (sub-spawn get-agents) and `spawn_service_list(id)` (sub-spawn service-list, **no** `--service-id`). Profile error → `{"errorType":"not_provider","route":"error"}`; `role != 2` → add `providerName`; service-list error → no services; selected = service whose `serviceId`|`id` scalar == `--service-id` (missing → `{"errorType":"service_not_found","onlineStatus","providerName","requestedServiceId","route":"error"}`) else first `data[*].list[*]`; selected `serviceType` == `A2MCP` (case-insens.) → `{"errorType":"a2mcp_direct_invoke_required","onlineStatus","providerName","route":"error"}`; `onlineStatus` (i64 default 1) == 2 → `{"errorType":"offline",…,"route":"error"}`; else `{"onlineStatus":n,"providerName":name,"route":"a2a"}`.
- Output: success envelope with the object above (all branches exit 0).
- Side effects: read-only. Parity: SAFE `agent designated-route --provider 2002`; SAFE `agent designated-route --provider 2002 --service-id <uuid>`.

### `onchainos agent my-agents`  (hidden: no)
- Handler: `common/mod.rs:933`.
- Options: `--role` optional (`user|asp|evaluator`, trimmed, case-insens.).
- Steps: invalid role → `unrecognized --role value: "{raw}" (expected user / asp / evaluator)`; `fetch_my_agents()` (sub-spawn; failure → `[]`); filter `role` == code.
- Output: `{"ok":true,"data":[<agent objects passthrough, sorted keys>]}`.
- Auth: jwt-required (child). Side effects: read-only. Parity: SAFE `agent my-agents`; SAFE `agent my-agents --role asp`.

### `onchainos agent gate-check`  (hidden: no)
- Handler: `common/mod.rs:1067` `handle_preflight` → `preflight_inner` (:953).
- Options: `--role` required.
- Steps: invalid role → same `unrecognized --role value` error. Wallet gate: `load_wallets()` Some + active account → `{"accountId","accountName"(from accounts list or ""),"email","ok":true}`; wallets but no active → `{"hint":"wallet loaded but no active account; run \`onchainos wallet login\`","ok":false}`; else `{"hint":"not logged in; run \`onchainos wallet login\`","ok":false}`. Identity gate: wallet not ok → `{"hint":"skipped — wallet not logged in","ok":false}`; else `fetch_my_agents()` filtered by role; none → `{"hint":"no {label} agent found; route to \`okx-ai\` with the intent \"Register a {label} identity\"","ok":false,"role":label}`; else first → `{"agentId","name","ok":true,"role","status":<raw or null>}`. Communication gate: skipped (`{"hint":"skipped — resolve the wallet / identity gate first","ok":false}`) unless both ok, else `communication_gate_json()` (spawns okx-a2a, stderr progress).
- Output: `{"communication":…,"identity":…,"ready":bool,"wallet":…}`.
- Auth: local wallet + jwt (child). Side effects: read-only. Parity: SAFE `agent gate-check --role user`; SAFE `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent gate-check --role asp`; SAFE `agent gate-check --role x`.

### `onchainos agent communication-check`  (hidden: no)
- Handler: `common/mod.rs:1076` → `okx_a2a::communication_gate_json()`.
- Options: none. Auth: anonymous (local). Output: `{"ok":true,"data":{"ok":true}}` / `{"ok":true,"data":{"hint":"…","ok":false}}` / `{"ok":true,"data":{"note":"…","ok":true}}`; always exit 0.
- Side effects: read-only (spawns `okx-a2a --version`, `okx-a2a doctor --json`). Parity: SAFE `ONCHAINOS_SKIP_A2A_PREFLIGHT=1 agent communication-check` → `{"ok":true,"data":{"ok":true}}`.

### `onchainos agent prepare-create`  (hidden: no)
- Handler: `common/mod.rs:1082` `handle_prepare_create`.
- Options: `--description`, `--title`, `--budget <f64>`, `--max-budget <f64>`, `--currency`, `--provider` (all optional).
- Steps: 1) `user::create::validate_draft_fields(description,title,budget,max_budget,currency)` (user group) → `{"checks":[{"field","ok",("error"|"normalized")?}],"errors":[…],"ok":bool}`; plus `max_budget ({mb}) must be >= budget ({b})`. Not ok → print `{"ok":false,"stage":"validation","validation":v}` **inside a success envelope** (`{"ok":true,"data":{…}}`), exit 0. 2) `preflight_inner("user")`; not ready → `{"ok":false,"preflight":p,"stage":"preflight","validation":v}`. 3) `--provider` non-empty → `designated_route_inner(provider, None)`; Err → `{"ok":false,"preflight","routing":{"error":"{e:#}"},"stage":"routing","validation"}`. 4) `{"ok":true,"preflight","routing"?,"validation"}`.
- Auth: jwt (child). Side effects: read-only. Parity: SAFE `agent prepare-create --title "t" --budget 1 --currency USDT`; SAFE `agent prepare-create --budget -1`.

### `onchainos agent profile <AGENT_ID>`  (hidden: no)
- Handler: `common/mod.rs:644` → `query_agent_by_id_direct`.
- Output: `{"ok":true,"data":<matched agent object>}`. Errors: `agent_id must not be empty`; `agentId={id} not found in \`get-agents\` response`; subprocess errors. Auth: jwt (child). Side effects: read-only. Parity: SAFE `agent profile 2002`; SAFE `agent profile 0` (not found).

### `onchainos agent user-notify`  (hidden: no)
- Handler: `common/okx_a2a.rs:383` `user_notify(content, image, true)`.
- Options: `--content <CONTENT>` required; `--image-path <PATH>` optional.
- Steps: image must exist; compose content (literal `\n`→newline; reject local image links; append `\n\nMEDIA:{path}`); spawn `okx-a2a user notify --content <c> --json` (direct Command) ; success → stdout `OK`.
- Output: plain `OK` (not JSON). Errors (exit 1 JSON error): `--image-path file not found: …`, `local image links in --content are not supported; use --image-path <file>`, `--image-path must be a non-empty single-line path`, `spawn failed: …`, `okx-a2a user notify exit {status}: {stderr}`.
- Auth: anonymous. Side effects: local-only (pushes a notification into the local okx-a2a runtime). Parity: UNSAFE-local `agent user-notify --content "hello"`; SAFE `agent user-notify --content "x" --image-path /nonexistent.png` (error).

### `onchainos agent funding-notice`  (hidden: no; hidden flag `--image-dir`)
- Handler: `common/funding_notice.rs:172` `execute`.
- Options: `--chain` req, `--currency` req, `--shortfall` req, `--deposit-address` req, `--required`, `--available`, `--deposit-chain` (optional strings), `--reason <task-payment|payment-402(alias payment402)|dispute-bond|subscription>` default `task-payment`, `--format <json>` default `json`, `--notify-user` bool, `--content` optional, `--image-dir <PATH>` (hidden, optional).
- Steps: 1) trim required strings; empty → `--chain must not be empty` (etc.); `--notify-user` with missing/blank `--content` → `--notify-user requires --content with already-localized text`; `--deposit-chain` given but blank → `--deposit-chain must not be empty`; default deposit chain = chain. `--required`/`--available` are NOT trimmed. 2) `qr = qr::build_qr_output(deposit_address, image_dir)` (core: detects display mode; image mode writes a PNG under `$ONCHAINOS_FUNDING_IMAGE_DIR` / legacy dir / OS temp as `onchainos-funding-qr-<pid>-<n>.png`; builds `markdownImage` `![QR Code](<path>)` and `notifyCommandArgs`; never fails). 3) build notice. 4) `--notify-user`: requires `image_path` (else `--notify-user requires an image-notify display path`) → `user_notify(content, Some(png), true)` → prints `OK`, done. 5) else print `serde_json::to_string_pretty(json!({"ok":true,"data":notice}))`.
- Output: **pretty-printed (2-space) JSON, keys sorted**, i.e. `{\n  "data": {…},\n  "ok": true\n}` (data before ok). `data` keys (sorted): `available`, `chain`, `contentCanonical`, `currency`, `depositAddress`, `depositChain`, `displayMode`, `displayPolicy`, `endTurn:true`, `fallbackContentCanonical`, `forbidFundingSummary:true`, `imagePath`, `markdownImage`, `mustLocalize:true`, `mustNotifyWithImagePath`, `mustRenderMarkdownImageBelowFirstOption`, `mustRepeatInFinalResponse:true`, `mustRunNotifyCommand`, `notifyCommand`, `notifyCommandArgs`, `reason`, `required`, `shortfall`, `terminalQr` (null when absent). `must*`/image fields true only when a PNG was written. `notifyCommand` = `onchainos agent user-notify --content "$ONCHAINOS_FUNDING_NOTICE_CONTENT" --image-path '<png with ' → '\''>'`. `displayPolicy`: image `Non-TTY: run notifyCommandArgs for PNG QR, put markdownImage under option 1, then repeat the full localized notice in final; never summarize.` / else `TTY: show terminalQr and the full localized notice; never summarize or claim PNG was sent.` `contentCanonical` (lines joined by `\n`):
  ```
  Insufficient {currency} balance on {chain}: shortfall {shortfall} {currency}.
  Available: {available} {currency}.          ← only with --available
  Required: {required} {currency}.            ← only with --required

  Deposit address: {deposit_address}
  Deposit network: {deposit_chain}

  Funding options:
  1. Scan and deposit — send {currency} directly to the address above on {deposit_chain}.
  2. Swap — swap <token> to {shortfall} {currency} on {chain}.
  3. Bridge — bridge {shortfall} {currency} from <chain> to {chain}.
  4. Withdraw from OKX — withdraw {currency} to the address above using the {deposit_chain} network. The exchange may charge a withdrawal fee.

  {gas line}

  After topping up, tell me "I topped up".
  ```
  gas line = `On-chain gas on X Layer is free after the funds arrive.` when chain or deposit chain normalises (ASCII alnum, lowercased) to `xlayer`, else `Ensure the wallet meets the network gas requirements.` `fallbackContentCanonical` = `QR image could not be attached. Deposit {currency} to {deposit_address} on {deposit_chain}. After topping up, tell me "I topped up".`
- Auth: anonymous. Side effects: local-only (PNG write in image mode; okx-a2a notify with `--notify-user`).
- Nondeterminism: PNG path (pid/sequence), display mode depends on TTY / Codex env.
- Parity: SAFE `agent funding-notice --chain XLayer --currency USDT --shortfall 0.5 --deposit-address 0x1234567890abcdef1234567890abcdef12345678 --available 0 --required 0.5` (piped stdout → image mode); SAFE `agent funding-notice --chain " " --currency USDT --shortfall 1 --deposit-address 0xabc`.

### `onchainos agent cache-notify`  (hidden: yes)
- Handler: mod.rs:1895 → `prefilled_notify::save(job, event_key, content)`.
- Options: `--job-id` req, `--event-key` req, `--content` req. job id NOT validated (joined into `$ONCHAINOS_HOME/task/<job>/cache/`).
- Output: stdout `OK`. Errors: fs errors (exit 1). Side effects: local-only (writes `prefilled-notify.json`, sorted pretty). Auth: anonymous. Parity: SAFE-local `agent cache-notify --job-id 0x<64hex> --event-key job_completed_escrow --content "Done"`.

### `onchainos agent cache-rating`  (hidden: yes)
- Handler: mod.rs:1905 → `prefilled_rating::save(job, score, comment)` (no validation of score format/length).
- Options: `--job-id`, `--score`, `--comment` (all required). Output `OK`. Writes `$ONCHAINOS_HOME/task/<job>/cache/prefilled-rating.json` = pretty `{"score":…,"comment":…}`. Auth: anonymous. Side effects: local-only. Parity: SAFE-local `agent cache-rating --job-id 0x<64hex> --score 4.50 --comment ok`.

### `onchainos agent task-deliverable-save`  (hidden: no)
- Handler: `common/deliverables.rs:144` `handle_save`.
- Options: `--job-id` req, `--role` req, `--file` req, `--deliverable-type` default `file`, `--title` req, `--short-id` req, `--file-key`, `--token-symbol`, `--token-amount`, `--counterparty-agent-id`, `--counterparty-name` (optional).
- Steps: role ∉ {user,asp} → `--role must be 'user' or 'asp', got '{role}'`; file missing → `file not found: {path}`; size > 104857600 → `file too large: {mb:.1} MB (max 100 MB). Please compress or resize the file before saving.`; original name = file name or `deliverable`; `sanitized = sanitize_title(title, job)`; `timestamp = Local::now().format("%Y%m%d_%H%M%S") + millis(3 digits)`; ext = `.{ext}` or `.txt`; dest name `{sanitized}_{timestamp}{ext}`; target dir `<root>/<role>/{job}_{sanitized}`; existing dir (`deliverables_dir`, validates job → CodedError `UNSAFE_JOB_PATH_COMPONENT`) renamed to target if different; create dir; **move** file (rename, fallback copy + delete source); manifest: existing or new (task context only on creation), push entry `{filename, originalName, deliverableType, fileKey?, savedAt: Local::now().to_rfc3339(), sizeBytes}`, write pretty.
- Output: `{"ok":true,"data":{"jobId","role","path","totalEntries"}}` (**struct order**).
- Auth: anonymous. Side effects: local-only (moves the source file!). Nondeterminism: timestamps in filename/savedAt.
- Parity: SAFE-local `agent task-deliverable-save --job-id 0x<64hex> --role user --file ./a.txt --title "Report" --short-id 0x1234`; SAFE `… --role x` (error).

### `onchainos agent task-deliverable-list`  (hidden: no)
- Handler: `common/deliverables.rs:281` `handle_list` (with `--job-id`) / `:317` `handle_list_all`.
- Options: `--job-id` optional, `--role` default `user`, `--search` optional (only without job id).
- Steps: role validation (same message). With job: manifest absent → `{"deliverables":[]}`; else `{"counterpartyAgentId","counterpartyName","deliverables":[{"deliverableType","originalName","path":<dir/filename>,"savedAt","sizeBytes"}],"jobId","shortId","title","tokenAmount","tokenSymbol"}` (missing options → null). Without job: role dir missing → `{"results":[]}`; for each sub-directory (readdir order) with a manifest (manifest parse errors abort), case-insensitive substring filter on title; row = same fields + `deliverableCount`; `{"results":[…]}`.
- Auth: anonymous. Side effects: local-only read. Parity: SAFE `agent task-deliverable-list`; SAFE `agent task-deliverable-list --job-id 0x<64hex> --role asp`; SAFE `agent task-deliverable-list --search report`.

### `onchainos agent dispute upload <JOB_ID>`  (hidden: no; marked "[Internal]" in help)
- Handler: `common/dispute_upload.rs:44` `handle_upload_evidence` (dispatch asp/mod.rs:429).
- Options: `JOB_ID` req; `--agent-id` req; `--role` req; `--text` optional; `--file <PATH>` repeatable (Vec); `--max-files <usize>` optional.
- Auth: jwt-required.
- Steps:
  1. role ∉ {user,asp} (exact, lowercase) → `--role must be 'user' or 'asp', got '{role}'`.
  2. `text_clean` = trimmed non-empty; > 16384 bytes → `--text too long: {n} bytes, limit is 16384 bytes`.
  3. files = explicit `--file`s (in order) then manifest entries of `deliverables/<role>/<job>` (manifest read error ignored; `deliverables_dir` validation error propagates); `--max-files` keeps only the last N entries (stderr `[dispute_upload] manifest has {total} entries; capping to most recent {max} (--max-files)`).
  4. no text and no files → `no evidence to upload: --text is blank, no --file was given, and no local deliverables were found at ~/.onchainos/deliverables/{role}/{job}/`.
  5. For each path: metadata error → explicit: `evidence file not found / unreadable: {path} ({e})`, manifest: skip; size > 100 MiB → explicit: `evidence file too large: {path} ({mb:.1} MB, limit 100 MB). Compress / split before uploading.`, manifest: skip; read error → explicit `failed to read {path}: {e}`, manifest skip. filename = file name if ASCII else `evidence_{idx}[.{ext-lowercase}]`; MIME by lowercase ext: jpg/jpeg image/jpeg, png image/png, gif image/gif, webp image/webp, pdf application/pdf, txt/log/md text/plain, json application/json, csv text/csv, html/htm text/html, zip application/zip, tar application/x-tar, gz application/gzip, mp4 video/mp4, mov video/quicktime, mp3 audio/mpeg, wav audio/wav, else application/octet-stream.
  6. no text and no readable parts → `no evidence to upload: --text is blank, no --file was given, and every manifest entry under ~/.onchainos/deliverables/{role}/{job}/ was missing or unreadable ({n} skipped)`.
  7. boundary `----onchainos-{:016x}` of `(subsec_nanos * 0x9e3779b97f4a7c15 + pid) mod 2^64` (**nondeterministic**). Body: text part `--B\r\nContent-Disposition: form-data; name="text"\r\n\r\n"<text with \ → \\ and " → \">"\r\n` (value wrapped in literal double quotes, no Content-Type), then per file `--B\r\nContent-Disposition: form-data; name="files"; filename="<name>"\r\nContent-Type: <mime>\r\n\r\n<bytes>\r\n`, then `--B--\r\n`.
  8. `POST /priapi/v1/aieco/task/{job}/evidence/upload` via `raw_post_with_identity` with `Content-Type: multipart/form-data; boundary=B`, explicit `Content-Length`, `agenticId`.
- Output (plain text):
  ```
  ✓ Evidence uploaded (off-chain, effective within 1h preparation window)
    jobId:    {job}
    role:     {role}
    text:     {bytes} bytes ({chars} chars)                    ← if text
    --file:   {n} explicit attachment(s)                        ← if any explicit
    manifest: {n} local deliverable(s) auto-attached            ← if manifest_count - skipped > 0
    skipped:  {n} manifest entry/entries missing or unreadable on disk   ← if skipped > 0
  ```
- Side effects: state-changing (server; off-chain evidence). Nondeterminism: multipart boundary.
- Parity: UNSAFE `agent dispute upload 0x<64hex> --agent-id 1001 --role user --text "evidence"`; SAFE `agent dispute upload 0x<64hex> --agent-id 1001 --role ASP` (role validation error — note `ASP` is rejected despite the help text); SAFE `agent dispute upload 0x<64hex> --agent-id 1001 --role user` with no manifest (no-evidence error, no HTTP).

### `onchainos agent pending-decisions-v2 …` — queue model (applies to all 8 subcommands)

Files under `$ONCHAINOS_HOME/task/` (dir auto-created):
- `pending-decisions-new.json` — `to_string_pretty(Queue)`: `{"entries":[PendingEntry…]}`; `PendingEntry` keys are **snake_case, struct order**: `job_id, role, agent_id, to_agent_id?, user_content, list_label, llm_content_override?, source_event?, decision_id?, choices?(omitted when empty; each {key, actionId, params?}), expires_at?, refund_display?({serviceName,taskType,amount,tokenSymbol,responseDeadline}), status ("active"|"queued"), created_at, updated_at` (chrono RFC3339 `…Z` with auto sub-second digits). Written atomically via tempfile in the same dir + rename.
- `pending-decisions-new.lock` — exclusive `flock` (fs2), try every 10 ms for 5 s → `pending-decisions lock timed out after 5s`; other lock error → `acquire flock failed: {e}`.
- `last-display.json` — `{"displayed_at":<RFC3339 Z>|null,"items":[{"index","job_id","role","agent_id","to_agent_id"?,"list_label"}]}` pretty.
- Queue read: missing/blank → empty; **unparsable → silently empty**; entries whose `source_event` ∈ {`autotrade_consent`,`autotrade_config_required`} are dropped on read.
- `ensure_invariant_and_evict` (every locked op except request): demote all but the oldest `active` to `queued`; evict entries with age ≥ TTL (`ONCHAINOS_PENDING_DECISIONS_TTL_DAYS` u64, default 7 days); sort active first then `created_at` desc; if something was evicted and no active remains, promote newest queued.
- Trace log: best-effort append `[<RFC3339>] <line>` to the hard-coded path `/tmp/onchainos-cli-mode.log` (on Windows resolves to `\tmp\…` of the current drive; failures ignored).
- Primary key `(job_id, role, agent_id, to_agent_id)`; `decision_id` narrows it when provided.
- `sanitize_to_agent(to, agent)`: `to == agent` → None with stderr `[pending-v2] --to-agent-id {t} equals --agent-id (self-addressed) — ignored; routing to the job's backup session instead`.
- Retired autotrade sources (`autotrade_consent`, `autotrade_config_required`) are no-ops for request (print `OK`).
- Auth for all: anonymous (local files + `okx-a2a`); no Task-API HTTP.

### `onchainos agent pending-decisions-v2 request`  (hidden: no)
- Handler: `pending_v2.rs:761` → `handle_request` → `request_prompt_inner(…, template_vars=None, print_ok=true)`.
- Options: `--job-id` req, `--role` req, `--agent-id` req, `--to-agent-id`, `--user-content` (required unless `--user-content-file`; conflicts), `--user-content-file`, `--list-label` req, `--llm-content`, `--source-event`, `--decision-id`, `--choices-json`, `--expires-at <i64>`.
- Steps: 1) content = `--user-content` or file text (`failed to read --user-content-file {path}: {e}`). 2) `decision_metadata(job, source, decision_id, choices_json, expires_at, None)` (arbitration §18: choices parse/validate; decision sources default `decision_id = {job}:{source}:current`; `expires_at` kept only when > 0). 3) retired source → `OK`. 4) sanitize target; replace literal `\n` in content with newline. 5) template render with empty vars (content/label containing a whitelisted `{{KEY}}` → CodedError `TEMPLATE_VALUE_MISSING` field `template-vars-b64`). 6) **CLI mode** (`is_cli_mode()`): buyer review (role `user` ∧ source `job_submitted`) takes the lock and, if the `review_card_sent` marker exists, prints `OK` and returns; build entry (status active); `llm = resolve_llm_content_cli(entry)`; `okx-a2a user decision-request --user-content <c> --llm-content <llm> [--job-id J --idempotency-key buyer-review:J:job_submitted] --json` (job/key only for buyer review); buyer review → write marker; print `OK`. **Queue mode**: lock; buyer-review marker check (→ `OK`); read queue; `created_at` preserved from a matching entry (else now); remove matches; push new entry (status `queued`, `updated_at` now); write queue; `llm = resolve_llm_content_prompt_user(entry)`; decision-request (same args); marker; `OK`.
- llmContent generators (rendered after Rust string-continuation; `{to_header}` = `[to: <id>]` or `[to: backup]`; `{to_flag}` = ` --to-agent-id "<id>"` or empty; `{decision_flag}` = ` --decision-id "<id>"` or empty; `{defer}` = `等会儿 / 等等 / 等一下 / 稍后 / 晚点 / 先放着 / 先不管 / 回头再看 / skip / later / wait / hold on / not now / defer`; autotrade candidate guidance/flag are always empty in 4.6.3 because the candidate sources equal the retired sources):
  - CLI mode, role `user` and source `job_submitted`|`review_deadline_warn` → `buyer_review_llm_content_cli` (pending_v2.rs:2728–2754), rendered:
    ~~~
    [USER_DECISION_REQUEST][job: {job}][role: {role}][agent: {agent}]{to_header}

    Step 1 — Card was just delivered. **END THE TURN NOW** and wait for the user's next message.
    Step 2 — Handle that reply in this current conversation. Enter through `skills/okx-ai/SKILL.md`, then apply `skills/okx-ai/references/runtime/watch.md` §Handling the user reply: cancel the wake when applicable, and for a non-defer reply claim the decision with `okx-a2a user check --todo-ids <todo_id> --json`. Continue on `handled`.
    Step 3 — Interpret the choice and complete the selected review action here:
    - A or an unambiguous approval: run `onchainos agent next-action --role user --agentId {agent} --message '{"event":"approve_review","jobId":"{job}"}'`. For `reason=completion_submitted`, give one localized friendly confirmation equivalent to: "Deliverable approved. The on-chain completion transaction has been submitted." For any other result, present its returned status and actions.
    - B or an unambiguous rejection: preserve any rejection wording from the reply in `message.data`, then run `onchainos agent next-action --role user --agentId {agent} --message '{"event":"reject_review","jobId":"{job}","data":"<verbatim rejection reason when present>"}'`. If a submitted zero-price one-time task has no reason, the result is `request_rejection_reason`: create the returned durable rejection-reason decision and wait; do not call any reject endpoint yet. After a non-blank reason is supplied, the existing `/pre-reject` + `/reject` lifecycle runs and the task becomes Failed; for `reason=free_rejection_submitted`, confirm that the rejection transaction was submitted. For every other eligible task, follow the returned Refund V2 compatibility guidance: run its read-only `refund-prepare` command, render the complete Template 6.1 Confirm Refund Request from `payload.display` as a single-record `- Label: value` field list, and ask for `Submit refund request` plus a reason. For paid tasks, B opens the confirmation only; B never counts as submission intent for a refund and never arms a reason-only continuation.
    - After the card, analyze the reply for both the submission intent and a refund reason. If it contains clear `Submit refund request` intent and a non-blank reason, preserve the reason verbatim and continue immediately. If the intent is clear but the reason is missing, ask only for the refund reason and keep the Job ID, latest Refund V2 context, and explicit submission intent active. Only during that explicitly armed follow-up may the next non-blank reply be treated as the verbatim reason. A reason without current submission intent must be previewed by rerunning `refund-prepare` with that reason and re-rendering Template 6.1; it does not authorize a write.
    - After both submission intent and the reason are present: run `onchainos agent refund-prepare {job} --reason "<verbatim reason>"`. Continue only when it returns `payload.schemaVersion=2`, `phase=refund_confirmation`, `decision=ready`, `reason=refund_request_confirmation_required`, and `nextAction[id=submit_refund_request]`; immediately run `onchainos agent refund-execute <params.jobId> --operation <params.operation> --refund-context-id <params.refundContextId> --reason "<params.reason verbatim>" --confirm` with every parameter copied from that fresh action. For `reason=refund_request_broadcast_submitted`, give one concise localized confirmation that the request was submitted and progress will update in this task. For any other result, present its returned status and actions.
    - Ambiguous or unrelated text: show the same A/B choice and wait.

    The current conversation owns choice parsing, action execution, and result feedback. For `refund_request_broadcast_submitted`, end the turn after the pending confirmation and friendly later-query guidance without displaying a CLI command; do not resume the originating watch. The User may later ask to view the task details for the refund result. Other decisions resume the exact originating watch only when the watch-core rules require it.
    ~~~
  - role `asp` and decision source → `asp_arbitration_llm_content(entry, queue_mode)` (pending_v2.rs:2756–2807), rendered with `{resolver}` = queue: ``onchainos agent pending-decisions-v2 resolve-prompt --user-reply "<user's verbatim wording>" --job-id "{job}" --role "{role}" --agent-id "{agent}" --source-event "{src}"{decision_flag}``; CLI: ``onchainos agent pending-decisions-v2 resolve-with-sessionkey --user-reply "<user's verbatim wording>" --job-id "{job}" --role "{role}" --agent-id "{agent}" --source-event "{src}"{decision_flag} --choices-json '{choices JSON, ' → '"'"'}'{ --expires-at N}``:
    ~~~
    [USER_DECISION_REQUEST][job: {job}][role: {role}][agent: {agent}]

    Step 1 — The card was just delivered. End this turn and wait for the user's next message.
    Step 2 — Handle the next reply in this current conversation. Enter through `skills/okx-ai/SKILL.md`, then apply `skills/okx-ai/references/runtime/watch.md` §Handling the user reply: cancel the wake when applicable, and claim a non-defer reply with `okx-a2a user check --todo-ids <todo_id> --json`. Continue on `handled`.
    Step 3 — Analyze the reply for both the decision intent and any evaluation reason. Resolve `Approve refund`, or `Request evaluation` with a non-blank reason, by running this pre-filled command once:
    `{resolver}`
    The resolver preserves the card's `decisionId`, choices, deadline, and job binding. When a reply contains the `Request evaluation` intent and a non-blank reason, preserve that reason verbatim and pass the canonical `--user-reply "Request evaluation: <verbatim reason>"`. If the intent is clear but the reason is missing, show the complete Seller Refund Rejection field-list card, then ask for the evaluation reason and keep this card context and explicit evaluation intent active. Only during that explicitly armed follow-up may the next non-blank reply be treated as the reason, preserved verbatim, and resolved once with the same canonical form. A reason without current `Request evaluation` intent does not authorize Evaluation: show the same complete Template 6.4 field-list card and wait. For `ambiguous_choice`, show the same card.

    Step 4 — For `phase=arbitration_decision`, `decision=ready`, and `reason=user_choice_resolved`, execute the sole returned action directly in this current conversation.
    - `agree_refund`: run `onchainos agent agree-refund <params.jobId> --agent-id {agent}` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query.
    - `raise_arbitration`: run `onchainos agent dispute raise <params.jobId> --reason "<params.reason verbatim>" --agent-id {agent}` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query. The later `job_disputed` event starts automatic evidence submission in the task session.
    - `sub_agree_refund`: run `onchainos agent subscribe-agree-refund <params.jobId> --agent-id {agent}` in this current conversation, then give one concise localized result with the outcome and relevant returned fields.
    - `raise_subscription_arbitration`: run `onchainos agent subscribe-dispute <params.jobId> --reason "<params.reason verbatim>" --agent-id {agent}` in this current conversation, then give one concise localized result with the outcome, relevant returned fields, and next available query.

    The current conversation owns choice resolution, freshness validation, returned action execution, concise result feedback, and resuming the exact originating watch when one exists.
    ~~~
  - else `--llm-content` override verbatim if given.
  - else CLI default (`resolve_llm_content_cli`, :2849), with `{arb_flags}` = for decision sources ` --choices-json '<json>'` + ` --expires-at N`:
    ~~~
    [USER_DECISION_REQUEST][job: {job}][role: {role}][agent: {agent}]{to_header}

    Step 1 — Card was just delivered. **END THE TURN NOW** and wait for the user to reply. Do NOT call any tool. Stale user messages in context are NOT replies to this card.
    Step 2 — When the user actually replies (next turn):
        - defer keyword ({defer}) or any defer value defined in runtime/watch.md → do NOT claim or resolve; if this card came from a currently active watch, re-enter that exact originating watch command, otherwise END TURN
        - else → enter through `skills/okx-ai/SKILL.md`, then follow `skills/okx-ai/references/runtime/watch.md` §kind == decision_request "Handling the user reply": **first claim the todo** per Runtime Watch step 2: `okx-a2a user check --todo-ids <todo_id> --json` (read `<todo_id>` from this item's `id` field in the original watch / outdated-list JSON output). **Then** on `handled` run `onchainos agent pending-decisions-v2 resolve-with-sessionkey --user-reply "<user's verbatim wording — no interpretation, no translation>" --job-id "{job}" --role "{role}" --agent-id "{agent}"{to_flag} --source-event "{src}"{decision_flag}{arb_flags}` exactly once, then follow the relay playbook it returns. Only a card surfaced by a currently active watch resumes that exact originating watch; an independently opened card never starts watch. Never infer watch origin from A/B/C, an amount, a cap, or any other reply text. Skipping the `check` leaves a ghost todo in the outstanding-decisions queue.
    ~~~
    (no trailing newline; the two bullet lines start with 4 spaces.)
  - else queue default (`resolve_llm_content_prompt_user`, :2900):
    ~~~
    [USER_DECISION_REQUEST]
    [job: {job}][role: {role}][agent: {agent}]{to_header}
    (Anything above this marker is stale — NOT a reply to this card.)

    Step 1 — Card was already delivered to the user. You MUST NOT re-render it, paraphrase it, summarize it, translate it again, or compose your own "please choose A/B/..." prompt — the user already has the exact text. Stale user messages in context are NOT replies to this card.
    Step 2 — Scan your current context for OTHER [USER_DECISION_REQUEST] blocks. If you find any, render the warning below to the user as your assistant response (in user's language), e.g.:
      `⚠️ You have multiple decisions pending — please prefix your reply with the jobId short hash, e.g. \`0x7091: approve\`, so it routes correctly.`
    If no other blocks → skip this step.

    Step 3 — **END THE TURN NOW with NO assistant text output** (unless Step 2 fired its multi-card warning, which is the ONLY allowed text this turn). No confirmation, no recap, no fabricated option list. Just stop. Wait for the user to reply in a future turn.

    🛑 **The block below runs ONLY in a future turn**, AFTER the user has actually replied. Do NOT run anything in the current turn.
    On the user's next reply, re-scan your context for [USER_DECISION_REQUEST] blocks (the count may have changed since Step 2), then walk this decision tree:
      - defer keyword ({defer}) or any defer value defined in runtime/watch.md → do NOT claim or resolve; if this card came from a currently active watch, re-enter that exact originating watch command, otherwise END TURN.
      · Reply starts with `0x...:` prefix → strip the prefix + colon, use the prefix to match each block's `[job: 0x...]` header, locate THAT block, then run THAT block's command template with `--user-reply` set to the stripped wording (without the prefix).
      · No prefix + only THIS block in context (single) → run THIS block's command template with the full reply.
      · 🔁 No prefix + **multiple** [USER_DECISION_REQUEST] blocks in context → user forgot to add the jobId prefix. Ask them which jobId they're answering (number the candidates `1. Job 0x...`, `2. Job 0x...`, one per line — short_jobId only), **END THE TURN**, wait for the pick (hex prefix `0x7091` or list number `1`); locate THAT block via `[job: 0x...]` header (or list order), then run THAT block's command template. Never guess, never collapse.

    **Command template** (pre-filled for THIS block; only run AFTER the user has replied):
      `onchainos agent pending-decisions-v2 resolve-prompt --user-reply "<user wording, without any jobId prefix>" --job-id "{job}" --role "{role}" --agent-id "{agent}"{to_flag} --source-event "{src}"{decision_flag}`

    After running, follow the relay playbook the command returns.
    ~~~
- Output: stdout `OK` (plain). Errors (exit 1): content file, choices/decision metadata errors, template CodedErrors, lock errors, `spawn failed: …`, `okx-a2a user decision-request exit …`, `UNSAFE_JOB_PATH_COMPONENT` (buyer-review marker path).
- Side effects: local-only (queue file, marker, okx-a2a card push). Nondeterminism: timestamps.
- Parity: UNSAFE-local `agent pending-decisions-v2 request --job-id 0x<64hex> --role user --agent-id 1001 --user-content "Approve?" --list-label "[Decision 0x12…34] Report acceptance decision" --source-event job_submitted`; SAFE `agent pending-decisions-v2 request --job-id J --role asp --agent-id 1 --list-label L --user-content c --source-event job_rejected --choices-json '[]'` (choices validation error).

### `onchainos agent pending-decisions-v2 request-prompt`  (hidden: no)
- Handler: `pending_v2.rs:802` → `handle_request_prompt` → `request_prompt_inner(…, print_ok=true)`.
- Options: same as `request` plus `--template-vars-b64` and `--refund-display-b64`.
- Steps: identical to `request`, except (a) `decision_metadata` decodes `--refund-display-b64` (errors per §18; also `refund display metadata requires a refund decision source event`, `refund display task type does not match the source event`), (b) template vars decoded/validated and rendered into user-content and list-label before any side effect (`CodedError{code: TEMPLATE_*, field:"template-vars-b64"}` → `{"error":…,"errorCode":…,"errorField":"template-vars-b64","ok":false}`, exit 1).
- Output: `OK`. Side effects: local-only. Parity: UNSAFE-local `… request-prompt … --user-content "Body {{__OKX_TASK_TITLE__}}" --list-label "[Decision] {{__OKX_TASK_LABEL_TITLE__}}" --template-vars-b64 $(printf '{"__OKX_TASK_LABEL_TITLE__":"L","__OKX_TASK_TITLE__":"T"}' | base64)`; SAFE `… --user-content "Body {{__OKX_TASK_TITLE__}}"` without the flag → `TEMPLATE_VALUE_MISSING`.

### `onchainos agent pending-decisions-v2 resolve`  (hidden: no)
- Handler: `pending_v2.rs:1862` `handle_resolve`.
- Options: `--user-reply` required.
- Steps: 1) lock, read, invariant/evict. 2) no active: queued entries exist → rebuild snapshot, write it, print `playbook_stale_relist(snap, "queue is in selection mode — please pick a number first, then re-send your decision")`; else print `playbook_error_no_active()`; exit 0 (queue not rewritten). 3) active decision source with missing decision_id or choices → remove, re-evict, write queue, print blocked `decision_metadata_missing`. 4) `expires_at ≤ now` → remove, write, blocked `decision_expired`. 5) arbitration choice (`resolve_arbitration_choice`: empty choices → defaults; validate; resolve) error → write queue (sorted/evicted), blocked `{reason_code}`, entry stays. 6) remove active; `relay_delivery_id` = for `autotrade_*` sources the persisted `$ONCHAINOS_HOME/autotrade/pending/<job>.json` `deliveryId` (autotrade group); `user_lang::record_from_user_text(job, reply)`. 7) relay event `user_decision_{source}` or `user_decision`; description = arbitration relay description (`sub session`) or the sub-session text (below); envelope `{"agentId":…,"message":{"code":0,"data":<reply>,"decisionId":<id|null>,"deliveryId":<id|null>,"description":…,"event":…,"jobId":…,"params":<map|null>,"role":…,"selectedActionId":<id|null>,"source":"system","timestamp":<unix s>}}` compact. 8) if no queued remain: send relay (`send_decision_relay`: `autotrade_*` source with a persisted `originSessionKey` → `okx-a2a session send --session-key K --content C --message-id autotrade-relay:<hex sha256(job\0source\0content)> --json` (5 s); else `okx-a2a session send --job-id J --content C --json [--to-agent-id T]` (5 s)); for `autotrade_*` clear the pending signal; write queue; print `🛑 User reply relayed and consumed — do NOT reuse it for future cards; wait for a fresh user message, then end the turn.` Else promote newest queued to active, re-evict/sort, send relay (error → exit 1, queue NOT written), clear signal, write snapshot + queue, print `playbook_advance_only(q)`.
- Texts: sub-session description: ``User-decision relay envelope (sub session). Call `onchainos agent next-action --role {role} --agentId {agent} --message '{"event":"{evt}","jobId":"{jid}","data":"<message.data verbatim>"{,"deliveryId":"…"}}'` to fetch the routing playbook; follow it. ❌ Do NOT call `pending-decisions-v2 resolve` / `pick` / `cancel` — those are user-session-only; the user-session already called `resolve` to produce this envelope. The sub session has no queue file; calling resolve here = wasted turn + flow stall.``; arbitration description (mode ∈ `sub session`, `CLI mode`, `queue-backed prompt mode`): ``User-decision relay envelope ({mode}). Run `onchainos agent next-action --role auto --agentId {agent_id} --message '<complete current message object as JSON>'`. Preserve every field from the current `message` object, including `decisionId`, `selectedActionId`, `params`, `data`, and `jobId` when present. Decision resolution is complete in the user session; continue with the returned progression result.``; blocked JSON (compact, sorted) `{"decision":"blocked","nextAction":[],"payload":{"details":{"sourceEvent":"<src>"},"jobId":"<job>"},"phase":"arbitration_decision","reason":"<code>"}`; `playbook_error_no_active`: `The pending-decisions queue is empty — there is no decision to resolve. The user's reply is just a normal chat message; handle it as such.\nDo NOT call any \`okx-a2a\` user / session command. End the turn now.\n`; `playbook_stale_relist` / `playbook_advance_only` / list view in the `list` section.
- Output: plain text (above). Side effects: local-only (queue, okx-a2a session send, lang markers). Nondeterminism: `timestamp`, sha digest input.
- Parity: SAFE-local `agent pending-decisions-v2 resolve --user-reply A` with an empty queue → exact no-active text.

### `onchainos agent pending-decisions-v2 resolve-with-sessionkey`  (hidden: no)
- Handler: `pending_v2.rs:1391` `handle_resolve_with_sessionkey` (does NOT read the queue).
- Options: `--user-reply` req, `--job-id` req, `--role` req, `--agent-id` req, `--to-agent-id`, `--source-event` req, `--decision-id`, `--choices-json`, `--expires-at <i64>`, `--autotrade-candidate-json`.
- Steps: 1) target: for `autotrade_*` sources replaced by the persisted delivery-context provider (≠agent) or None; else sanitized supplied. 2) record language. 3) decision source (`job_rejected`/`sub_user_reject`): `decision_id` must start with `{job}:{source}:` and be longer, and `--choices-json` present, else blocked `decision_metadata_missing`; `expires_at ≤ now` → blocked `decision_expired`; parse_choices error → blocked `decision_metadata_missing`. 4) resolve choice (errors → blocked `{reason_code}`). 5) arbitration selection: role ≠ `asp` → blocked `unsupported_action`; else print (compact, sorted) `{"decision":"ready","nextAction":[{"id":<action>,"params":<params>,"recommend":true}],"payload":{"decisionId":<id|null>,"executionOwner":"current_conversation","jobId":…,"params":…,"selectedActionId":…},"phase":"arbitration_decision","reason":"user_choice_resolved"}` and exit (no relay). 6) otherwise `prepare_foreground_autotrade` (candidate JSON only valid for autotrade candidate sources: else `--autotrade-candidate-json is only valid for auto-trade consent decisions`; application owned by the autotrade group, may print outcome JSON + `The auto-trade draft was processed synchronously. A follow-up decision is already available; end this turn and wait for the user's reply.` and stop). 7) build relay envelope (CLI-mode description: ``User-decision relay envelope (CLI mode). Call `onchainos agent next-action --role {role} --agentId {agent} --message '{"event":"{evt}","jobId":"{jid}","data":"<message.data verbatim>"{delivery}}'` to fetch the routing playbook; follow it. ❌ Do NOT call `pending-decisions-v2 resolve` / `pick` / `cancel` — those are user-session-only; the user-session already issued this relay envelope.``), send relay, (autotrade outcome printing), then print `decision_relay_post_action()`: `Decision relayed. If this card was surfaced by a currently active \`okx-a2a user watch\`, immediately re-enter that exact originating watch command per \`skills/okx-ai/references/runtime/watch.md\` (re-enter through \`skills/okx-ai/SKILL.md\` and preserve global vs sticky \`--job-id\`). If it was opened independently through a decision list / outdated-list, do not start watch; end the turn normally. Never infer watch origin from the user's reply text.\n`.
- Output: plain text / JSON line. Side effects: local-only. Parity: SAFE-local `… resolve-with-sessionkey --user-reply "B reason: late" --job-id J --role asp --agent-id 2002 --source-event job_rejected --decision-id "J:job_rejected:e1" --choices-json '[{"key":"A","actionId":"agree_refund","params":{"jobId":"J"}},{"key":"B","actionId":"raise_arbitration","params":{"jobId":"J"}}]'` → ready JSON with `params.reason:"late"`; SAFE-local same without `--decision-id` → `decision_metadata_missing`.

### `onchainos agent pending-decisions-v2 resolve-prompt`  (hidden: no)
- Handler: `pending_v2.rs:1555` `handle_resolve_prompt`.
- Options: `--user-reply`, `--job-id`, `--role`, `--agent-id`, `--source-event` (req); `--to-agent-id`, `--decision-id`, `--autotrade-candidate-json`.
- Steps: as resolve-with-sessionkey, but the choices/expiry come from the stored queue entry (`load_prompt_entry`: lock + read, match by key incl. decision_id): decision source without a valid prefixed decision id → blocked; decision source with no stored entry → blocked `decision_metadata_missing`; stored `expires_at ≤ now` → remove entry (best-effort) + blocked `decision_expired`; decision source entry missing decision_id/choices → remove + blocked; choice error → blocked (entry kept); otherwise the entry is removed BEFORE relay; arbitration selection → same local JSON (role≠asp → blocked `unsupported_action`); else relay with description ``User-decision relay envelope (queue-backed prompt mode). Call `onchainos agent next-action --role {role} --agentId {agent} --message '{"event":"{evt}","jobId":"{jid}","data":"<message.data verbatim>"{delivery}}'` to fetch the routing playbook; follow it. ❌ Do NOT call `pending-decisions-v2 resolve` / `resolve-with-sessionkey` / `resolve-prompt` / `pick` / `cancel` — those are user-session-only; the user-session already issued this relay envelope.`` then post-action text.
- Side effects: local-only. Parity: SAFE-local `… resolve-prompt --user-reply A --job-id J --role asp --agent-id 2002 --source-event job_rejected` (no decision id → blocked JSON).

### `onchainos agent pending-decisions-v2 pick`  (hidden: no)
- Handler: `pending_v2.rs:2066` `handle_pick`.
- Options: `--index <usize>` / `--job-id` (exactly one; clap required_unless/conflicts).
- Steps: lock, read, evict; snapshot = `last-display.json`; index 0 or > items → write fresh snapshot, print stale relist (`selection index out of range`); job id: matches in snapshot ≠ 1 → stale relist (`selection Job ID was not in the displayed list` / `selection Job ID is ambiguous in the displayed list`); target entry missing → stale relist `selected entry no longer exists (auto-cleaned or resolved)`; entry `updated_at > displayed_at` → stale relist `selected entry's content was updated since display`; else print `playbook_render(entry)` (no mutation, queue not rewritten):
  ~~~
  Render the selected decision card to the user as your assistant response (text rendering only — do NOT call any tool). End the turn after rendering.

  **User-visible text** (render this verbatim as your assistant response; translate per [Localization] rules if the user's language is not English; keep `jobId` / data values intact):
  """
  {user_content}"""

  **LLM context** (this is for YOUR own routing reasoning — **do NOT show / paraphrase / leak this block to the user**):
  """
  {resolve_llm_content_prompt_user(entry)}
  """

  On the user's next reply, follow the LLM context above (decision tree + pre-filled `resolve-prompt` command).
  ~~~
  `playbook_stale_relist(snap, reason)` = `The previous selection is stale. **Translate the content below into the user's language**, then render as your assistant response:\n\n"""\n{list}"""\n\nAfter rendering, end the turn. Do NOT call any tool.\n` with `{list}` = `Queue is empty, no selection needed.\n` or `Your previous selection is stale ({reason}). Current list:\n\n` + `{index}. {list_label}\n`×n + `\nReply with a number 1-{n} to re-select.\n` (full, unstripped labels).
- Side effects: local-only. Parity: SAFE-local `agent pending-decisions-v2 pick --index 1` on empty snapshot → stale text with `Queue is empty, no selection needed.`

### `onchainos agent pending-decisions-v2 list`  (hidden: no)
- Handler: `pending_v2.rs:2316` `handle_list`.
- Options: `--format <markdown|json>` default markdown; `--scope <all|refund>` default all.
- Steps: lock, read, `evicted = ensure_invariant_and_evict`; display queue = all or `refund_queue` (role `asp`, decision source, not expired; any such entry lacking refund_display → error `pending refund decision metadata is incomplete; refresh the affected rejection event`; keep `responseDeadline > now`; sort by responseDeadline asc); write snapshot of the DISPLAYED queue and the (evicted) queue.
- Output:
  - refund json (pretty, sorted): `{"items":[{"amount","index","jobId","refundAmount","responseDeadline","responseDeadlineLabel","serviceName","taskType","tokenSymbol"}],"pendingCount":n}`.
  - refund markdown: `You have {n} refund requests awaiting a decision:\n\n| # | Service name | Job ID | Task Type | Refund Amount | Response Deadline |\n|---|---|---|---|---|---|\n` + `| {i} | {service} | {job} | {type} | {refundAmountLabel} | {UTC label or —} |\n` per row + (`\nReply with the number or Job ID to view and process a request.\n` when n>0).
  - all json (pretty, sorted): `{"entries":[{"agent_id","created_at"(to_rfc3339 +00:00),"index","job_id","list_label","role","status","to_agent_id","updated_at"}],"evicted_since_last_call":n}`.
  - all markdown: when evicted>0 first `ℹ️ Since last check, {n} decision(s) older than {ttl_days} days were auto-cleaned.\n\n`; empty → `(no pending decisions)\n\nRender the line above to the user as your assistant response.\n`; else `3 steps (Steps 1-2 in this turn, Step 3 in the future turn):\n\n**Step 1** — Translate the [Source content] below to the user's language per [Translation rules].\n\n**Step 2** — Render Step 1's output to the user as your assistant response.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n` + `render_list_markdown(q)`.
  - `render_list_markdown` = `[Source content to render to user]:\n\n` + body + `\n` + translation rules + routing, where (label = list_label with a leading `[...]` block stripped + trim-start; job = pending_v2 `short_job_id`: ≤12 bytes as-is else first 6 bytes + `...` + last 4 bytes):
    - active body: `🟢 Decision 1 — {label} (Job {job})\n\n{user_content}\n\n` then if others: `─────────────────\nRemaining ({m}):\n` + `{k}. {label} (Job {job})\n`… + `\n` + `Reply per the options shown in the active card to handle this decision; reply "switch N" to jump to remaining item N; reply "later" to defer.\n`; else `Reply per the options shown in the active card to handle this decision; reply "later" to defer.\n`.
    - selection body: `Please pick one to activate:\n\n` + `{i}. {label} (Job {job})\n`… + `\nReply with a number 1-{n} to activate that decision, or "later" to defer.\n`.
    - translation rules: `[Translation rules] — **translate every English word to the user's language**, including quoted user-facing keywords. Only these are kept verbatim:\n  - Hex jobIds (\`0x...\`).\n  - Sub-provided \`<title>\` fields (already in user's language).\n  - Structural delimiters (\`🟢\`, \`─────────────────\`, numbered list markers).\nEverything else — \`Decision\`, the \`<type>\` token (\`acceptance\` / \`dispute\` / \`submit\` / \`ASP-pick\` / \`ASP-contact\` / \`next-step\` / \`price\` / \`budget\` / \`error\`), \`decision\`, all surrounding prose, AND quoted user-facing keywords like \`"switch N"\` / \`"later"\` — gets translated. Footer: preserve every \`;\`-separated clause (do NOT drop or merge). No mixed-language content.\n\n`
    - routing header `[Future-turn user-reply routing] (when the user replies, match semantics — localized equivalents count):\n`; active: `  - Reply matches the active card's option set (\`A\` / \`B\` / \`A\`/\`B\`/\`C\` / numeric \`1\`/\`2\`/\`3\` / free-form like \`retry\` / \`dismiss\` / \`重试\` / \`同意\` / \`拒绝\` / \`通过\` / \`第一个\` / etc.) → \`onchainos agent pending-decisions-v2 resolve --user-reply "<user's verbatim wording>"\`\n    ⚠️ Disambiguation: if the active card uses numeric options (e.g. "1. Alpha / 2. Beta"), a bare \`1\` / \`2\` is the active answer → use \`resolve\`, NOT \`pick\`. \`pick\` requires explicit \`switch\` / \`切换\` / \`跳到\` keyword.\n` + (m>0: `  - \`switch N\` / \`切换 N\` / \`跳到 N\` / \`go to N\` / \`change to N\` (1 ≤ N ≤ {m}) → \`onchainos agent pending-decisions-v2 pick --index (N+1)\` (e.g. \`switch 2\` → \`--index 3\`).\n`) + `  - \`later\` / \`稍后\` / \`defer\` → end the turn.\n  - User asks to see the list again → \`onchainos agent pending-decisions-v2 list --format markdown\`.\n  - Else → ordinary chat; do NOT call \`pick\` / \`resolve\` / \`cancel\`.\n`; selection: `  - A number K (1 ≤ K ≤ {n}) / \`第 K 个\` / \`选 K\` / \`the Kth\` → \`onchainos agent pending-decisions-v2 pick --index K\`.\n  - \`later\` / \`稍后\` / \`defer\` → end the turn.\n  - User asks to see the list again → \`onchainos agent pending-decisions-v2 list --format markdown\`.\n  - Else → ordinary chat. No active entry to resolve.\n`.
  - `playbook_advance_only(q)` (used by resolve): `✓ Previous decision already relayed in-process — the user's reply is consumed; do NOT relay it again.\n\n3 steps (Steps 1-2 in this turn, Step 3 in the future turn).\n🛑 **STRICTLY ORDERED — execute Step 1 → 2 sequentially in this turn; do NOT skip any step.**\n\n**Step 1** — Translate the [Source content] below to the user's language per [Translation rules]. Prepend a transition line \`✓ Previous decision handled. Here's the next pending one:\` (also translated) to the top of the translated output.\n\n**Step 2** — Render Step 1's output to the user as your assistant response. The user's reply just relayed is **already consumed** — it is NOT the answer to the next card.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n` + list view.
- Side effects: local-only (rewrites queue + snapshot). Nondeterminism: `displayed_at`, eviction by wall clock.
- Parity: SAFE-local `agent pending-decisions-v2 list` (empty → `(no pending decisions)…`); SAFE-local `agent pending-decisions-v2 list --format json` → `{\n  "entries": [],\n  "evicted_since_last_call": 0\n}`; SAFE-local `agent pending-decisions-v2 list --scope refund --format json` → `{\n  "items": [],\n  "pendingCount": 0\n}`.

### `onchainos agent pending-decisions-v2 cancel`  (hidden: no)
- Handler: `pending_v2.rs:2154` `handle_cancel`.
- Options: `--index <usize>` required.
- Steps: lock, read, evict; snapshot index 0/out of range → write fresh snapshot + stale relist `cancel index out of range`; target not in queue → print `Cannot proceed: no pending decision found for index {i} (jobId={j} role={r} agentId={a} toAgentId={:?})\nDo NOT call any \`okx-a2a\` user / session command. End the turn.\n`; remove; if it was active and entries remain → promote newest queued; write snapshot + queue; print `playbook_cancel`: `Cancelled pending decision: job={j}, role={r}, agent={a}, to_agent={None|Some("x")}, status_before={active|queued}. Sub session is NOT notified (silent cancel); it will TTL-evict eventually or be retriggered by a new system event.\n\n` + (`Queue is now empty. End the turn.\n` | active: `3 steps (Steps 1-2 in this turn, Step 3 in the future turn):\n\n**Step 1** — Translate the [Source content] below to the user's language per [Translation rules]. Prepend a transition line \`✓ Previous decision cancelled. Here's the next pending one:\` (also translated) to the top of the translated output.\n\n**Step 2** — Render Step 1's output to the user as your assistant response.\n\n**Step 3** — (Future turn) Apply [Future-turn user-reply routing] below when the user replies.\n\n` + list view | queued: `Active entry was NOT affected (the cancelled entry was queued, not active). End the turn.\n`).
- Side effects: local-only (no notification to the sub). Parity: SAFE-local `agent pending-decisions-v2 cancel --index 1` on empty queue → stale relist text.

### `onchainos agent common context <JOB_ID>`  (hidden: no)
- Handler: `common/mod.rs:1258` `run_context`.
- Options: `JOB_ID` req; `--role` default `user`; `--agent-id` required.
- Auth: jwt-required.
- Steps: 1) `validate_job_id` (error message §6). 2) role ∉ {user,asp,evaluator} → `--role must be user / asp / evaluator`. 3) empty agent → `--agent-id is required (beta backend requires non-empty agenticId header)` (unreachable via clap except `--agent-id ""`). 4) identity GET `/priapi/v1/aieco/task/{job}` → error `failed to get task detail: {e}` (top-level Display only). 5) deserialize `TaskDetail` (camelCase; REQUIRED string fields `jobId`,`title`,`description`; optional `taskId`(i64), `contentHash`, `tokenAddress`, `tokenSymbol`, `tokenAmount`(string), `paymentMode`(i32), `status`(i32), `sensitiveStatus`, `categoryCodes`([string]), `chainId`(i32), `minCreditScore`(f64), `userAgentAddress`, `userAgentId`, `providerAgentAddress`, `providerAgentId`, `groupId`, `expireConfig`, `expireTime`(i64), `paymentMostTokenAmount`(string), `createTime`(i64)) → type mismatch/missing → `failed to parse response: {serde err}`. 6) `fetch_agent_profile(agent)` (sub-spawn get-agents; fallback profile on failure). 7) print text.
- Output (plain text, `role_cn` = `User Agent` / `Agent Service Provider (ASP)` / `Evaluator Agent`; one trailing extra newline from `println!`):
  ```
  You are the {role_cn} in the task system.

  [Your Identity]
  - Role: {role_cn}
  - AgentID: {agent}
  - Wallet address: {agentWalletAddress}          ← if present
  - Communication address: {communicationAddress} ← if present
  - Name: {name}                                   ← if present
  - Description: {profileDescription}              ← if present

  [Task Details]
  - Job ID: {jobId}
  - Internal ID: {taskId}                          ← if present
  - Title: {title}
  - Description: {description}
  - Budget: {tokenAmount|not set} {tokenSymbol|UNKNOWN} (token: {tokenAddress|""})
  - 🔒 INTERNAL max budget (paymentMostTokenAmount): {max} {symbol} ← for internal decisions only; NEVER include in any message sent to the ASP   ← if present
  - Payment mode (paymentType={pm|0}): {not set|escrow payment|legacy task payment disabled}
  - Chain: chainId={chainId}                       ← if present
  - Min credit score: {score}                      ← if present (f64 Display)
  - Expiry: acceptance window {openExpireSec/3600}h, delivery window {acceptedExpireSec/3600}h   ← if expireConfig has both as u64
  - Created: {fmt_unix_secs(createTime)}

  [Current Status]
  - {status_str} — {status_desc}

  [User Agent Info]
  - AgentID: {userAgentId}
  - Communication address: {userAgentAddress}     (or only AgentID line; or "- Unknown")

  [ASP Info]
  - AgentID: {providerAgentId}
  - Communication address: {providerAgentAddress} (or only AgentID; or "- No ASP matched yet")
  [⚠️ Must Execute Immediately]
  The role is already bound. Read skills/okx-ai/references/a2a/{user|provider|evaluator}/router.md directly; do not re-enter the A2A parent router. It contains the complete role-scoped rules.
  ```
  `status_str` = `Status::from_int(status).as_str()` (None → `unknown`, unknown n → `status_{n}`); `status_desc`: init `Initializing (awaiting on-chain confirmation)`, created `Awaiting acceptance (Created)`, accepted `Accepted; ASP executing (Accepted)`, submitted `ASP submitted deliverable; awaiting User Agent review (Submitted)`, rejected `User Agent rejected deliverable; evaluation possible within freeze period (Rejected)`, disputed `Evaluation in progress (Disputed)`, admin_stopped `Admin stopped the task (AdminStopped)`, completed `Task completed; funds released (Complete)`, failed `Refund completed; task closed (backend Failed)`, close `User Agent closed the task (Close)`, expired `Task expired (Expired)`, else `Unknown status`. Note: there is NO blank line between the `[ASP Info]` block and `[⚠️ Must Execute Immediately]`. The User-Agent block reads `userAgentId`/`userAgentAddress` (not `buyerAgentId`).
- Side effects: read-only. Parity: SAFE `agent common context 0x<64hex> --agent-id 1001`; SAFE `agent common context 0x<64hex> --role asp --agent-id 2002`; SAFE `agent common context task-001 --agent-id 1` (jobId validation error).

### `onchainos agent next-action`  (hidden: no) — dispatch owned by `commands/agent_commerce/mod.rs:2752`
- Options: `--agentId <ID>` (alias `--agent-id`) required; `--role <user|asp|evaluator|auto>` required; `--message <JSON>` required; `--a2a-file <PATH>` optional.
- Auth: jwt-required (for freshness reads; `auto` role spawns get-agents).
- Steps:
  1. Parse `--message` as JSON; on failure escape raw LF/CR/TAB inside string literals (`escape_control_chars_in_strings`) and retry; success → stderr `[next-action] --message had raw control chars inside string values; auto-repaired and parsed. Strict parse error was: {err}`; failure → `--message must be a valid JSON object: {strict_err}`.
  2. `--a2a-file` → `validate_a2a_file_arg(path, message.jobId, agent)`: path must canonicalize under the OS temp dir (or `/tmp` on Unix) (`--a2a-file must point to a file under the OS temp directory`); regular file (`--a2a-file must be a regular file, not a symlink or directory`); Unix mode 0600 (`--a2a-file must have mode 0600; run chmod 600`); non-empty (`--a2a-file payload is empty`); JSON (`--a2a-file payload is not valid JSON: …`); `msgType == "a2a-agent-chat"`; `jobId` == message jobId; `receiverAgentId` == agent; `content` last non-blank line == `[intent:deliver]`; a content line `jobId: X` with X == jobId; then re-serialised compact JSON is written 0600 atomically to `<tmp>/a2a_deliver_{jobId}_{nanos}_{pid}_{seq}[_{n}].json` (jobId must be `[A-Za-z0-9_-]+`) and `message.a2aFile` = that path.
  3. `event` = string `message.event` (else `--message.event is required`); `jobId` string (missing allowed only for `reward_claimed`/`create_task`, else `--message.jobId is required`); `code` i64→i32 default 0; `jobTitle`, `provider`, `data` strings. Non-empty jobId → `validate_job_id`.
  4. `provider` present → write `$ONCHAINOS_HOME/task/<job>/designated-provider.json` = pretty `{"agentId":provider}` (errors ignored).
  5. `code != 0` and event ∉ {job_expired, submit_expired, job_asp_accept_expire} → print (stdout) and exit 0:
     ```
     【交易失败】{failure_label}（code={code}）

     运行 `onchainos agent user-notify` 通知用户：
     ```bash
     onchainos agent user-notify --content '[{failure_label}]{title_part}（{jobId}）交易执行失败（code={code}）。'
     ```
     → 结束 turn。
     ```
     where `title_part` = ` **{jobTitle}**` or a single space.
  6. role `auto` → `query_agent_by_id_direct(agent)` role 1/2/3 → user/asp/evaluator; other → `agentId={a} has unsupported role={Some(n)|None}; pass --role explicitly`; lookup error → `could not resolve role for agentId={a}: {e}; pass --role explicitly`.
  7. user ∧ `job_created` ∧ no provider ∧ no designated-provider file → identity GET `/task/{job}`; non-empty `providerAgentId` → save designated provider.
  8. user ∧ `job_submitted` → `review_gate::mark_pending`; user ∧ `approve_review` → `mark_approved` (errors ignored).
  9. Freshness (`check_status_freshness`, skipped when (user|asp ∧ `job_completed`) or (user ∧ `sub_complete_notify`)): SKIP_ALL events (create_task, approve_review, reject_review, user_attachment_received, job_user_reject, raise_arbitration, dispute_raise, agree_refund, raise_subscription_arbitration, sub_dispute, sub_agree_refund, staked, unstake_*, stake_stopped, evaluator_selected, vote_committed, reveal_started, vote_revealed, vote_*_deadline_warn, cooldown_entered, round_failed, reward_claimed, wakeup_notify, sub_asp_claim_notify) → no reads. Unknown events (status `Other("unknown")`, not prefetch/arbitration-relay) → no reads. user ∧ `dispute_resolved` / `sub_failed_notify` / buyer refund events (job_closed, job_asp_reject_closed →7; job_refunded, job_auto_refunded, sub_asp_agree, sub_reject_refund_notify, job_asp_reject_expire →9; job_expired, submit_expired, job_asp_accept_expire →8) → `user::refund::fetch_authoritative_refund_context` (task + subscription composition, user group) with up to 4 attempts and sleeps 250/750/1500 ms until ready; asp ∧ refund events → provider variant. Other events → identity GET `/task/subscribe/{job}` (events starting `sub_` or `user_decision_sub_user_reject`) else `/task/{job}`; blocked messages (`[next-action blocked] …`, see mod.rs:3913–4158, 4365–4565) or the stale-state text (mod.rs:4709–4716) are printed instead of a playbook (exit 0). Arbitration relays / `job_rejected`/`sub_user_reject` are checked for staleness (status 3 and period binding) and print `blocked_result("stale_event"|"status_unavailable", …)`.
  10. audit `provider|user|evaluator/next_action_received`; asp with paymentMode 3 and event ∉ {sub_complete_notify, job_completed} → `legacy_a2mcp_flow_removed: task-based A2MCP processing is disabled for job {job}. Stop; do not deliver, complete, sign, or pay.`; else delegate to `task::{asp,user,evaluator}::flow::generate_next_action(...)` (owned elsewhere) and `println!` its prompt. Other role → `--role 必须是 asp/user/evaluator，当前: {role}`.
- Output: plain-text playbook. Side effects: **FUND-MOVING possible** — the delegated flow handlers run in-process actions for some events (e.g. user `approve_review` submits the on-chain completion; see buyer-review llmContent `reason=completion_submitted`). Nondeterminism: retries/sleeps, spool filenames.
- Parity: SAFE `agent next-action --agentId 1001 --role user --message '{"event":"job_closed","jobId":"0x<64hex>","code":7}'` → Chinese failure text, no HTTP; SAFE `agent next-action --agentId 1 --role user --message 'not json'` → error; SAFE `agent next-action --agentId 1 --role x --message '{"event":"reward_claimed"}'` → role error after (no) freshness reads.

### `onchainos agent session-cleanup`  (hidden: no)
- Handler: `common/session_cleanup.rs:17` `handle_session_cleanup(job, true)`.
- Options: `--job-id` required (not validated).
- Steps: `pending_v2::cancel_all_for_job(job)` (errors → 0); `prefilled_notify::clear`, `prefilled_rating::clear` (errors ignored); if `keep_conversation_on_terminal()` → text `ℹ️ KEEP_SESSION=true — conversation history retained. No further action needed.\n`; else `okx-a2a session delete --job-id J --json` → `OK` (no newline) or `⚠️ sub session delete failed: {e}\n`; `print!` the text.
- Output: `OK` without trailing newline (or the other texts). Always exit 0.
- Auth: anonymous. Side effects: local-only (queue, cache files, okx-a2a session deletion). Parity: SAFE-local `ONCHAINOS_KEEP_SESSION=true agent session-cleanup --job-id 0x<64hex>` → KEEP_SESSION text.

### `onchainos agent task-in-progress`  (hidden: no)
- Handler: `common/in_progress.rs:24` `handle_in_progress`.
- Options: `--agent-ids <ID>` repeatable and comma-delimited (Vec; default empty).
- Auth: jwt-required.
- Steps: empty → `at least one --agent-ids value is required`; >20 → `at most 20 agent IDs allowed per request (got {n})`; `POST /priapi/v1/aieco/task/inProgress` via `post_with_identity`, body `{"agentIds":[…],"sessionCert":…}` (sorted), header `agenticId: <first id>`.
- Output: `{"ok":true,"data":<passthrough data, sorted keys>}` (backend returns `buyerTasks`, `evaluatorDisputes`, `providerTasks`).
- Side effects: read-only (POST query). Parity: SAFE `agent task-in-progress --agent-ids 1001`; SAFE `agent task-in-progress --agent-ids 1001,2002 --agent-ids 3003`; SAFE `agent task-in-progress` (error, no HTTP).

---

## Endpoint classification (this partition)

| Endpoint | Class | Used by |
|---|---|---|
| `GET /priapi/v1/aieco/task/{jobId}` | read | status, lifecycle, common context, arbitration-detail, refund-list/detail (via refund helper), next-action, `resolve_payment_mode`, `resolve_wallet_and_agent_for_task` |
| `GET /priapi/v1/aieco/task/subscribe/{jobId}` | read | status, lifecycle, arbitration-detail, refund-list/detail, next-action |
| `GET /priapi/v1/aieco/task/{jobId}/dispute/status` | read | status, arbitration-list, arbitration-detail, refund-detail |
| `GET /priapi/v1/aieco/task/{jobId}/evidence` | read | arbitration-detail |
| `GET /priapi/v1/aieco/task/dispute/my?page=&pageSize=` | read | arbitration-list, tasks --status disputed |
| `GET /priapi/v1/aieco/task/my?page=&page_size=[&status=]` | read | tasks, refund-list, active-tasks |
| `GET /priapi/v1/aieco/task/subscribe/my?page=1&pageSize=100&statusType=` | read | active-tasks |
| `GET /priapi/v1/aieco/task/subscribe/my` | read | refund-list (via subscription_ops) |
| `POST /priapi/v1/aieco/task/inProgress` | read | task-in-progress |
| `POST /priapi/v1/aieco/task/{jobId}/evidence/upload` | state | dispute upload |
| `GET /priapi/v1/aieco/task/claimable` | read | `claim::fetch_and_print_claimable` (evaluator group) |
| `POST /priapi/v1/aieco/task/claim` | funds | `claim::submit_claim_and_broadcast` (evaluator group) |
| `POST /priapi/v1/aieco/task/broadcast` | funds | all `signing::sign_uop_and_broadcast*` callers |
| `POST /priapi/v1/aieco/task/{jobId}/{pre_action}` | state | `task_dual_sign_and_broadcast` (complete/reject flows, other groups) |
| `POST /priapi/v1/aieco/task/{jobId}/{main_action}` | funds | `task_dual_sign_and_broadcast` (submits EIP-712 authorisation, returns uopData) |
| `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` | read | `signing::sign_typed_data` (wallet group impl) |
| `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` | funds | `signing::sign_typed_data` (produces the authorising signature) |
| `GET /priapi/v5/wallet/agentic/agent/batch-list` | read | sub-spawn `get-agents`: profile, designated-route, common context, next-action auto, refund-list, deposit address |
| `GET /priapi/v5/wallet/agentic/agent/agent-list` | read | sub-spawn `get-my-agents`: my-agents, gate-check, active-tasks, lifecycle, agent-id resolution |
| `GET /priapi/v5/wallet/agentic/agent/services` | read | sub-spawn `service-list`: designated-route, `find_service` |
| `POST /priapi/v5/wallet/agentic/auth/refresh` | auth | `ensure_tokens_refreshed` / invalid-token retry (core) |

## External hosts / processes

- No HTTP host other than the OKX base URL is contacted by this partition (DoH resolvers are used by the core `WalletApiClient`, owned elsewhere).
- External binary `okx-a2a` (npm `@okxweb3/a2a-node`): user-notify, funding-notice `--notify-user`, gate-check/communication-check (`--version`, `doctor --json`), pending-decisions-v2 (`user decision-request`, `session send`), session-cleanup (`session delete`), lifecycle (`session history`), a2a binding helpers.
- Self-subprocess `onchainos` (current exe): `agent get-agents`, `agent get-my-agents`, `agent service-list`, `agent task-feedback`, `agent feedback-submit`, `wallet balance --chain 196`, `portfolio all-balances --address … --chains 196`.
- Local files outside `ONCHAINOS_HOME`: `~/.okx-agent-task/sqlite/command-store.sqlite` (read-only, lifecycle), `/tmp/onchainos-cli-mode.log` (append, pending-v2 trace), OS temp dir (`a2a_deliver_*.json` spool, funding QR PNGs).

## Open questions

1. `get_with_identity` on paths that already contain `?` appends a second `?sessionCert=…` (e.g. `/task/my?page=1&page_size=20?sessionCert=…`). Reproduced as-is here; unclear whether the backend tolerates it or silently ignores `sessionCert`/`page_size`.
2. `agent dispute upload --role` help says `user` or `ASP`, but the code accepts only lowercase `user|asp`.
3. `agent common context` reads `userAgentId`/`userAgentAddress`, while every other reader in this partition uses `buyerAgentId`/`buyerAgentAddress`; on current backends the User-Agent block likely prints `- Unknown`. Also `createTime` in ms would render a far-future RFC3339 year.
4. `agent next-action` dispatch and `check_status_freshness` live in `commands/agent_commerce/mod.rs`; ownership overlaps with the agent-root group. The per-role flow playbooks (and any fund-moving in-process actions they trigger) are not specified here.
5. `pending_v2` autotrade candidate guidance/flags (`--autotrade-candidate-json`) are dead in 4.6.3 because the candidate source set equals the retired source set; `resolve-with-sessionkey` still accepts the flag for those sources and hands it to `autotrade::consent_reply::apply_candidate_json` (autotrade group) — behaviour for retired sources not traced.
6. `lifecycle` reads the SQLite store from `dirs::home_dir()` (ignores `ONCHAINOS_HOME`); a parity harness with an isolated `ONCHAINOS_HOME` will still read the real user's `~/.okx-agent-task`.
7. Several `okx_a2a` wrappers use `Command::new("okx-a2a")` without the Windows `cmd /C` shim (user notify, decision-request, session send/delete/history); on Windows with an npm `.cmd` shim these fail with `spawn failed: program not found`. Whether the lite runtime should replicate that failure is a product decision.
8. `pending_v2` trace log path `/tmp/onchainos-cli-mode.log` is hard-coded (non-portable); whether to keep it.
9. The funding-notice PNG location and `qr::display_mode` detection are owned by the core `qr` module; exact PNG naming/dir order was only grepped.
10. The multipart boundary for evidence upload is derived from wall-clock nanos and pid — not reproducible byte-for-byte; the harness must normalise it.
