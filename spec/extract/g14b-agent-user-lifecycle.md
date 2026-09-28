# g14b-agent-user-lifecycle — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the **user-side (buyer) task lifecycle** of `onchainos agent …`: ASP matching / selection
(`asp-match`, `task-service-select`, `set-asp`, `reset-asp`, `user-reject`), review completion
(`complete`, disabled `reject`), the Refund V2 protocol (`refund-prepare`, `refund-execute`, disabled
`close`, disabled `claim-auto-refund`), subscription management (`subscribe-cancel`, `start-autorenew`,
disabled `subscribe-reject`, `subscribe-detail`, `subscribe-cost`, `my-subscriptions`,
`subscription-list`), and the **user-role branch of `agent next-action`** (the prompt/playbook generator
`task::user::flow::generate_next_action` plus `flow_lifecycle/*` and `v2/*` event handlers).

No command in this partition has `hide = true`. The only options not visible in the per-command clap
attributes are root globals (`--chain`, shown on every leaf in `cli-tree.json`, ignored by these
handlers; hidden root `--dev` switches the base URL, owned by core).

Command-line surface: the visible clap definitions live in `commands/agent_commerce/mod.rs`
(`AgentCommand`, lines 180–610, 981–992, 1273–1298); each variant is re-packed into the internal
`task::user::TaskCommand` (`user/mod.rs:88–403`, **not** a clap entry point) and dispatched by
`task::user::run_task` (`user/mod.rs:1826–2121`). Handlers in this partition are listed per command.

## Sources read

Partition files (all read fully, including `#[cfg(test)]` modules used as oracles):

| File (under `commands/agent_commerce/task/user/`) | Lines |
|---|---|
| `refund.rs` | 5054 |
| `claim_auto_refund.rs` | 17 |
| `close.rs` | 21 |
| `asp_ops.rs` | 1819 |
| `subscription_list.rs` | 828 |
| `subscription_ops.rs` | 2341 |
| `flow.rs` | 2326 |
| `flow_lifecycle/mod.rs` | 20 |
| `flow_lifecycle/core.rs` | 3007 |
| `flow_lifecycle/dispute.rs` | 268 |
| `flow_lifecycle/manage.rs` | 737 |
| `flow_lifecycle/subscription.rs` | 1308 |
| `flow_lifecycle/terminal.rs` | 599 |
| `v2/mod.rs` | 14 |
| `v2/complete.rs` | 103 |
| `v2/create_and_fund.rs` | 399 |
| `v2/create_subscription.rs` | 237 |
| `v2/job_completed.rs` | 313 |
| `v2/notification.rs` | 234 |
| `v2/reject.rs` | 363 |
| `v2/sub_complete_notify.rs` | 411 |
| **total** | **20419** |

Supporting files consulted (only the parts the partition calls into; behaviour owned elsewhere is
named/summarised only): `commands/agent_commerce/mod.rs` (AgentCommand defs 180–610, 975–995,
1265–1298; dispatch 1403–1420, 1551–1886, 2752–3050; next-action freshness helpers 3152–3161,
3876–4719), `user/mod.rs` (1–420, 1826–2121), `task/common/network/task_api_client.rs` (459, full),
`task/signing.rs` (627, full), `task/common/mod.rs` (60–800), `task/common/state_machine.rs`
(56–125, 330–735), `task/common/subscription_identity.rs` (41, full), `task/common/review_gate.rs`
(161, full), `task/common/deadline.rs` (1–200), `task/common/query.rs` (22–36, 372–431),
`task/common/util.rs` (88–120, 215–258, 433–489), `task/common/payment_mode.rs` (1–80),
`task/common/okx_a2a.rs` (560–1050), `task/common/onchainos_self.rs` (1–80),
`task/common/deliverables.rs` (10–20, 240–270), `task/common/pending_v2.rs` (2586–2616),
`task/common/config.rs` (76–82), `task/common/autotrade/tooling.rs` (646–667),
`user/create.rs` (236–276), `user/negotiate.rs` (130–266), `user/reject_apply.rs` (1–50),
`user/accept.rs` (grep only), `user/content.rs` (1–70 grep), `user/device_routing.rs` (325–396),
`identity/args.rs` (415–446), `wallet_api.rs` (1–130, 690–1331, 1428–1441),
`client.rs` (346–385), `output.rs` (1–80), `home.rs` (12–100, 210–275), `endpoints.rs` (1–60),
`agentic_wallet/sign.rs` (210–304), `agentic_wallet/transfer/mod.rs` (600–714),
`agentic_wallet/auth/mod.rs` (132–177), `payment/a2a_pay.rs` (636–700, 725–770),
`commands/token.rs` (648–653), `spec/cli-tree.json` (the 19 leaves below).

---

## Shared helpers (used across groups or from core)

### 0. Cross-cutting facts that affect byte parity

1. **JSON key order.** `serde_json` is built without `preserve_order` (see g08 §0.1). Every
   `serde_json::Value` object is a BTreeMap ⇒ every request body built with `json!` and every `data`
   payload printed by this partition has keys **sorted byte-wise at every level**. The only
   exceptions in this partition: (a) structs serialized directly (not via `Value`): the Refund V2
   journal file (`to_vec_pretty(&PendingRefundMutation)`, struct order) and the subscription-list
   cursor (`to_vec(&SubscriptionCursor)`, struct order); (b) plain-text outputs.
2. **Output envelope** (`output::success`, output.rs:44): one stdout line
   `{"ok":true,"data":<data>}` (+`"notifications":[…]` only when payment notices were queued — core).
   Compact unless `ONCHAINOS_PRETTY=1`. Many commands here instead print **plain text** with
   `println!` (noted per command). `agent next-action` prints the prompt string raw (`println!("{prompt}")`,
   trailing `\n`), never an envelope — even when the prompt is itself a JSON document.
3. **Error envelope** (main.rs, core): any `Err` → stdout `{"ok":false,"error":"<{e:#}>"}` exit 1
   (`{e:#}` = anyhow chain joined by `": "`, outermost first). clap usage errors → stderr, exit 2.
4. **`is_cli_mode()`** (`task/common/config.rs:76`, re-exported as `user::content::is_cli_mode`):
   true iff env `CLAUDECODE == "1"` or env `CODEX_THREAD_ID` is non-empty. Several outputs differ
   (set-asp, subscribe-cancel, flow playbooks, create_task playbook). Parity runs must pin both vars.
5. **Rust string-literal continuation.** Most long templates use `"…\n\` + newline + indentation:
   the `\`-newline eats the newline **and all leading whitespace of the next source line**; `\x20`
   escapes are literal spaces that survive. Port templates by applying exactly this rule.
6. **Timezone.** `deadline::format_local_timestamp_with_offset` / `format_local_deadline` use the
   process local TZ (`chrono::Local`); `format_utc_timestamp` is UTC. Parity runs must pin `TZ`.
7. **Audit log.** `audit::log(...)` appends to `ONCHAINOS_HOME/audit.jsonl` (core). Each
   `TaskApiClient` request logs `api/get|post|post_mutation` with `path=…`, `agentId=…`. Handler
   audit names are listed per command (not part of stdout).
8. **Agent preamble** (`agent_commerce::run`, mod.rs:1406–1418, owned elsewhere): every `agent …`
   invocation first runs best-effort autotrade workers (`executor::reconcile_terminal_journals(4,100ms)`,
   `executor::flush_all_due(1)`, `executor::cleanup_expired_tickets(8)`,
   `delivery_queue::flush_due(1,100ms)`); they only act on persisted local notices.
9. **`TaskApiClient::new()`** is constructed at the start of `run_task` for every command in this
   partition (even the disabled ones); it builds a `WalletApiClient` (DoH prepare; core) and panics
   with `failed to create WalletApiClient` if that fails.

### 1. `TaskApiClient` (task/common/network/task_api_client.rs, owned by core/common group)

Base URL = `endpoints::base_url()` (OKX API origin; `--dev` → `https://beta.okex.org`). All methods
take a path, fetch a JWT via `ensure_tokens_refreshed()` (see §4) and return envelope `data`.

| method | wire behaviour |
|---|---|
| `task_path(j)` | `/priapi/v1/aieco/task/{j}` |
| `endpoint(j,a)` | `/priapi/v1/aieco/task/{j}/{a}` |
| `subscribe_path(j)` | `/priapi/v1/aieco/task/subscribe/{j}` |
| `broadcast_path()` | `/priapi/v1/aieco/task/broadcast` |
| `get_with_identity(path, agent)` | GET; headers = jwt_headers + `agenticId: <agent>`; query `?sessionCert=<cert>` **only when** a local session with non-empty `sessionCert` exists (`wallet_store::load_session()`; value encoded with `application/x-www-form-urlencoded` rules, e.g. `+`→`%2B`, `/`→`%2F`, `=`→`%3D`, space→`+`); paths that already carry a query (`subscribe/my?page=…`) are only ever used with `get_with_agent_id`; retries once on DoH failover and once on server `10008` (force refresh) |
| `get_with_agent_id(path, agent)` | GET; same headers; **no** sessionCert query |
| `post_with_identity(path, body, agent)` | POST JSON; `sessionCert` injected into the body object if absent and a session cert exists; DoH + 10008 retries |
| `post_mutation_with_identity(path, body, agent)` | same body injection; **no retry**; connect/timeout → error with context `Network result is unknown for this state-changing request. Query authoritative state before retrying.` |
| `fetch_subscription(j, agent)` | trims agent; empty → `agenticId is required to fetch subscription detail`; else `get_with_identity(subscribe_path)` |

`jwt_headers` (client.rs:377): `Content-Type: application/json`, `ok-client-version: <CARGO_PKG_VERSION>`,
`Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <cached id>` (if any),
`device-name: <cached name>`, `Authorization: Bearer <jwt>`.

Envelope unwrap (`wallet_api::unwrap_wallet_envelope`): HTTP ≥ 500 → `Wallet API server error (HTTP {n}): {body}`;
non-JSON → `failed to parse wallet API response as JSON (HTTP {n}): {first 500 bytes}`;
`code` ≠ `0`/`"0"` → `ApiCodeError` Display `Wallet API error (code={code}): {msg}` (msg from
`msg|errorMessage|error_message|message|detailMsg`, else raw body ≤200 chars; `http_status` kept);
success → `data` verbatim.

### 2. Identity resolution (owned elsewhere; all use **self-exec subprocesses** of the running binary)

- `signing::resolve_agent_id_by_role(role)` (signing.rs:227) → `common::fetch_my_agents()` →
  subprocess `onchainos agent get-my-agents --owner-address <current account XLayer addr, lowercase> --page-size 100`;
  first entry with `role == role`; returns `""` on any failure (never errors).
- `create::resolve_user_agent()` (user/create.rs:236) → subprocess
  `onchainos agent get-my-agents --owner-address <addr> --role user --page-size 100` (strict: transport
  errors propagate; missing XLayer address → `no current XLayer address`); first `role==1`;
  none → `the current account has no user identity; run \`onchainos agent create --role user\` first`;
  missing id → `agent is missing the agentId field`. Returns `(agentId, ownerAddress)`.
- `signing::resolve_wallet_by_agent_id(id)` (signing.rs:58): empty → `agent_id must not be empty; pass the provider's own agentId`;
  subprocess `onchainos agent get-agents --agent-ids <id>` → `agentWalletAddress`; empty →
  `cannot resolve wallet for agentId={id}; agentWalletAddress not found in \`onchainos agent get-agents\``;
  then local `resolve_wallet(None, addr)` (wallet store, chain name `okb`; not logged in →
  `not logged in; run \`onchainos wallet auth\` first`). Returns `(accountId, address)`.
- `signing::resolve_wallet_and_agent_for_task(client, job, explicit)` (signing.rs:88): local id =
  explicit or first `role==1` from get-my-agents (or `""`); **GET** `/priapi/v1/aieco/task/{job}`
  (agenticId = local id) → requires `buyerAgentAddress` (else `task detail missing buyerAgentAddress field`);
  returns `(accountId, address, buyerAgentId-from-detail-or-"")` — i.e. the **returned agent id is the
  task's `buyerAgentId`, not the explicit flag**.
- `common::fetch_agent_profile(id)` (common/mod.rs:449): subprocess `agent get-agents --agent-ids <id>`;
  on any failure/no match returns fallback `name = "Agent {id}"`; on match `name` = row `name` (may be None).
- `common::find_service(provider, service)` (common/mod.rs:715): subprocess
  `onchainos agent service-list --agent-id <provider> --page 1 --page-size 100 --service-id <service>`;
  scans `data[*].list[*]` for `serviceId` or numeric `id` match; subprocess/parse failure → **Err**.
- `subscription_identity::select_subscription_agent_id(user, asp)`: first non-blank (trimmed) of the two,
  else `agenticId is required for subscription requests`.
- `common::query::resolve_agent_id(explicit, role)`: explicit if non-empty else `resolve_agent_id_by_role(role)` (may be `""`).

### 3. Signing / broadcast (task/signing.rs, owned elsewhere)

- `sign_typed_data(typed, from)` → `agentic_wallet::sign::eip712_sign_raw(typed, "196", from)`:
  POST `/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` `{"chainIndex":"196","payload":[{"message":typed,"msgType":"eip712"}]}`
  → `data[0].msgHash`; local Ed25519 sign with HPKE-decrypted session key; POST
  `/priapi/v5/wallet/agentic/pre-transaction/sign-msg`
  `{"chainIndex":"196","from":from,"payload":[{"message":typed,"sessionSignature":…,"signType":"eip712"}],"sessionCert":…}`
  → `data[0].signature`. (WalletApiClient.post_authed: JWT headers, no agenticId.)
- `sign_uop_and_broadcast_full(client, uopData, acct, addr, job, bizType, agent, extra)`: `uopData` null →
  `backend did not return uopData; cannot sign and broadcast`; parse → `failed to parse uopData: …`;
  `executeResult == false` → `backend transaction preflight failed: {executeErrorMsg|"no error detail returned"}`;
  local `transfer::build_broadcast_body` (session-key signing, **no HTTP**) →
  `{"accountId","address","chainIndex":"196","extraData":"<json string>"}` + `bizContext = {"bizType":bizType,"jobId":job, ...extra}`;
  **POST `/priapi/v1/aieco/task/broadcast`** via `post_mutation_with_identity` (sessionCert injected),
  error context `broadcast failed`; returns `data[0]` (or `null`).
- `sign_uop_and_broadcast(...)` = `_full` then `data[0].txHash` as string or `"pending"`.
- `extract_biz_type(resp)` = `resp.type` as i64 or 0.
- `task_dual_sign_and_broadcast(client, job, pre, main, extraMain, acct, addr, agent, bizExtra)`:
  `deadline = now_unix + 1800`; POST `endpoint(job, pre)` `{"deadline":deadline}` (post_with_identity; err →
  `{pre} request failed: {e}`); `typedData` null → `{pre} did not return typedData`; `nonce` = string or `""`;
  sign typedData; POST `endpoint(job, main)` `{"signatureData":{"deadline","nonce","signature"}, ...extraMain}`
  (err → `{main} request failed: {e}`); `sign_uop_and_broadcast(main.uopData, type)` → `{api_response, tx_hash}`.

### 4. Auth (core) — `agentic_wallet::auth::ensure_tokens_refreshed` (auth/mod.rs:132)

Session-key expiry (local) or missing refresh token → "session expired" error; access token from
keyring; refresh via POST `/priapi/v5/wallet/agentic/auth/refresh` `{"refreshToken":…}` when expired.
Every command here that touches the task API is therefore **jwt-required**; fund-moving ones additionally
require the local TEE session (`session.json` + keyring `session_key`) for session-key signatures.

### 5. Partition-owned helpers — Refund V2 core (`user/refund.rs`)

**Constants**: `SCHEMA_VERSION = 2`, `JOURNAL_REVISION = 3`, legacy revision `2`, `MAX_REASON_CHARS = 2000`.

**`RefundOperation`** (clap `ValueEnum`, kebab): `close-zero`, `direct-refund`, `request-refund`,
`cancel-trial-conversion`, `close-created-subscription`.

**Scalar readers**: `scalar_string(v)` = trimmed non-empty string, else i64/u64 rendered decimal;
`scalar_i64(v)` = i64, else u64 fitting i64, else trimmed string parsed as i64; `first_string/first_i64`
scan `(object, keys[])` pairs in order and return the first hit.

**Decimal helpers** (exact, no float): `validate_decimal(s)` ⇔ at most one `.`, whole part non-empty
ASCII digits, fraction (if present) non-empty ASCII digits (so `"0e0"`, `"-0"`, `"."`, `"1."`, `".5"`, `""`
are invalid). `is_zero_decimal(s)` ⇔ valid and every byte is `0` or `.`. `canonical_decimal`: strip
leading zeros of whole (empty→`0`), trailing zeros of fraction, drop empty fraction.
`decimal_equal(a,b)` ⇔ both valid and canonical forms equal. `valid_tx_hash(s)` ⇔ `s.trim()` starts
with `0x` followed by exactly 64 ASCII hex digits.

**`RefundSnapshot::from_details(job, task, subscription?, expectedBuyer?)`** (refund.rs:1557) — every
field lookup scans the **subscription object first (if any), then the task object**, each with the key list:

| field | keys (in order) | notes |
|---|---|---|
| jobType | task.`jobType` only | missing → `task detail is missing jobType`; ∉{0,1} → `task detail returned unsupported jobType={n}` |
| status | `subStatus`, `status` | missing → `task detail is missing status` |
| buyerAgentId | `buyerAgentId`, `userAgentId` | missing → `task detail is missing buyerAgentId`; ≠ expected → `the selected task is not owned by the current User Agent` |
| originalAmount | `paymentTokenAmount`, `tokenAmount` | missing → `task detail is missing the original token amount`; invalid decimal → `task detail returned an invalid original token amount` |
| trialType (jobType 1 only) | `trialType` | missing → `subscription detail is missing trialType`; ∉{0,1} → `subscription detail returned unsupported trialType={n}` |
| tokenSymbol | `tokenSymbol`, `paymentTokenSymbol` | |
| tokenAddress | `paymentTokenAddress`, `tokenAddress` | if status≠8 and amount non-zero and missing → `task detail is missing the original token address` |
| periodIndex | `periodIndex` | |
| periodStartTime | `subStartTime`, `periodStartTime` | |
| periodEndTime | `subEndTime`, `periodEndTime` | active formal subscription (jobType1, status1, trial0) with periodIndex<0, start≤0, end≤0 or start≥end → `subscription detail returned an invalid billing period` |
| paymentMode | `paymentMode` | |
| title | `title`, `jobTitle` | default `""` |
| providerAgentId | `providerAgentId`, `aspAgentId` | |
| providerName | `providerAgentName`, `aspAgentName`, `providerName` | |
| serviceId / serviceName | `serviceId` / `serviceName` | |
| revision | `revision`, `updatedAt`, `updateTime` | string |
| autoRenew | `autoRenew` | |
| chainId | `chainId`, `chainIndex` | |
| responseDeadline | `rejectDeadline`, `rejectWindowEndsAt`, `responseDeadline`, `expireTime` | top-level only (never `expireConfig.*`) |
| requestedAt | `refundRequestedAt`, `rejectTime` | |
| recordedRefundReason | `refundReason`, `rejectReason`, `userReason` | |
| settlementTime | `refundTime`, `settledAt` | |
| disputeRound / Phase / PrepareEnd / RoundEnd | `currentRound` / `disputePhase` / `prepareEndTime` / `roundEndTime` | |

`settlement_confirmed` is set true iff: (status 8, amount non-zero, jobType 0 or (1 and trialType 0)) OR
(jobType 0, amount non-zero, status 9 or (status 7 and paymentMode 1)) OR (jobType 1, trialType 0,
status 9, amount non-zero). Raw `refundTxHash`-style hash fields are **ignored**.
`refund_reason(r)` = `r` only when (jobType0 ∧ status2) ∨ (jobType1 ∧ trialType≠1 ∧ status1), else None.

**`context_id(reason)`** = `"refundctx_" + hex(sha256(compact JSON))` where the JSON object is (keys sorted
on the wire): `autoRenew, buyerAgentId, chainId, jobId, jobType, originalAmount, paymentMode,
periodEndTime, periodIndex, periodStartTime, providerAgentId, revision, serviceId, status, tokenAddress,
tokenSymbol, trialType, userReason(=refund_reason(reason))`, absent values as `null`, numbers as integers,
strings unescaped non-ASCII. Computed example (derived from the algorithm, not an upstream oracle): the
test fixture `snapshot(jobType 0, status 0, "10")` (job-1/buyer-1/asp-1/svc-1/revision "42"/USDT/0xtoken/paymentMode 1)
serialises to `{"autoRenew":null,"buyerAgentId":"buyer-1","chainId":null,"jobId":"job-1","jobType":0,"originalAmount":"10","paymentMode":1,"periodEndTime":null,"periodIndex":null,"periodStartTime":null,"providerAgentId":"asp-1","revision":"42","serviceId":"svc-1","status":0,"tokenAddress":"0xtoken","tokenSymbol":"USDT","trialType":null,"userReason":null}`
→ `refundctx_0b8012f0ccd3ecb525c1f359a08aee202a7d1c3ed24d7e27c375c2219c740724`.

**`plan(reason)` decision table** (refund.rs:1823; first match wins). `blocked(r)` ≡ phase
`refund_eligibility`, decision `blocked`, no op/action, recommendStop false.

1. jobType1 ∧ status0: amount non-zero ∧ (providerAgentId absent ∨ tokenSymbol blank) → blocked `refund_task_details_incomplete`; else executable(`refund_confirmation`, `created_subscription_close_confirmation_required`, action `close_created_subscription`, op close-created-subscription).
2. trialType==1: status1∧autoRenew1 → executable(`refund_eligibility`, `trial_subscription_not_refundable`, `cancel_trial_conversion`, cancel-trial-conversion); status1∧autoRenew0 → blocked `trial_conversion_already_cancelled`; status1 otherwise → blocked `trial_conversion_state_unknown`; status7 → {phase `refund_resolution`, decision `ready`, reason `trial_subscription_closed_without_refund`, stop}; status8 → {`refund_resolution`,`ready`,`expired_without_refundable_payment`, stop}; else blocked `trial_subscription_not_refundable`.
3. jobType0 ∧ zero amount: status0 → executable(`refund_confirmation`,`zero_amount_close_confirmation_required`,`close_zero_price`, close-zero); status7 → ready `zero_amount_task_closed` (stop); status8 → ready `expired_without_refundable_payment` (stop); else blocked `zero_amount_close_contract_required`.
4. jobType1 ∧ zero amount: status8 → ready `expired_without_refundable_payment` (stop); else blocked `zero_amount_subscription_not_refundable`.
5. If (jobType0 ∧ status∈{0,2}) ∨ (jobType1 ∧ status1) and display details missing (providerAgentId absent or tokenSymbol blank) → blocked `refund_task_details_incomplete`.
6. By status: 0∧jobType0∧paymentMode1 → executable(`refund_confirmation`,`direct_refund_confirmation_required`,`execute_direct_refund`, direct-refund); 0∧jobType0 → blocked `direct_refund_funding_not_verified`; 0 → blocked `refund_not_available_for_status`; 1∧jobType0 → blocked `accepted_task_refund_contract_required`; (jobType1∧1) ∨ (jobType0∧2): jobType0∧paymentMode≠1 → blocked `refund_payment_not_verified`; jobType1 and start/end missing → blocked `subscription_period_contract_required`; reason None or blank → {phase `refund_reason_collection`, decision `requires_user_input`, reason `refund_reason_required`, action `provide_refund_reason`}; reason chars>2000 → same with reason `refund_reason_too_long`; else executable(`refund_confirmation`,`refund_request_confirmation_required`,`submit_refund_request`, request-refund); 3 → {`refund_provider_response`,`blocked`,`provider_response_pending`}; 4 → {`refund_arbitration`,`blocked`,`arbitration_in_progress`, action `view_arbitration`}; 8∧confirmed → ready `refund_confirmed` (stop); 8 → blocked `refund_settlement_details_incomplete`; 9∧confirmed → ready `refund_confirmed` (stop); 9 → {`refund_resolution`,`blocked`,`refund_settlement_details_incomplete`}; 6 → {`refund_resolution`,`blocked`,`refund_not_approved_or_task_completed`, stop}; 7∧jobType0∧paymentMode1∧confirmed → ready `refund_confirmed`; 7∧jobType1∧confirmed → ready `refund_confirmed`; 7∧jobType1∧zero → ready `zero_amount_subscription_closed`; 7∧jobType0 → {`refund_resolution`,`blocked`,`refund_settlement_details_incomplete`}; 7 → {`refund_resolution`,`blocked`,`task_closed_no_new_refund_action`, recommendStop false}; else blocked `refund_not_available_for_status`.

(All "executable" plans: decision `requires_user_input`, recommendStop false.)

**Derived states**: `refund_scope`: zero amount → `none`; jobType1 ∧ (status0 ∨ provenance op = close-created-subscription) → `full_subscription_payment`; trial → `none`; jobType1 → `current_subscription_period`; else `full_task_payment`.
`settlement_state`: 8 → confirmed?`confirmed`:`not_required`; 9 → `confirmed`/`details_incomplete`; 7 → confirmed→`confirmed`, zero→`not_required`, else `details_incomplete`; 6 → `not_refunded`; 3,4 → `pending`; else `not_started`.
`refund_state`: 0 `created`; 1,2 `active`; 3 `provider_pending`; 4 `arbitrating`; 8,6 `resolved`; 7∧zero `resolved`; 7/9 confirmed `resolved`; 7/9 `settlement_unverified`; else `unavailable`.
`settlement_confirmation_source`: not confirmed → null; provenance op close-created-subscription → `wallet_order_detail_with_backend_lifecycle`; status≠8 ∧ jobType1 ∧ requestProvenance → `backend_onchain_lifecycle_with_local_refund_request`; else `backend_onchain_lifecycle`.
`status_name`: jobType1 → `init/created/active/rejected/disputed/completed/closed/expired/failed` for −1,0,1,3,4,6,7,8,9 else `status_{n}`; jobType0 → `Status::from_int(n).as_str()` (`init, created, accepted, submitted, rejected, disputed, admin_stopped, completed, close, expired, failed`, else `status_{n}`).
`refund_status_label/description(jobType,status,planReason)` — reason overrides first:
`refund_confirmed`→`Refund completed`/`The refund completed successfully.`; `provider_response_pending`→`Awaiting ASP decision`/`The refund request is waiting for the ASP's decision.`; `arbitration_in_progress`→`Refund under evaluation`/`The refund result will be determined by the Evaluation.`; `refund_not_approved_or_task_completed`→`Refund not issued`/`The task completed without a refund.`; `trial_subscription_closed_without_refund`,`task_closed_no_new_refund_action`→`Closed without refund`/`The task is closed and no refund was issued.`; `expired_without_refundable_payment`,`zero_amount_task_closed`,`zero_amount_subscription_closed`,`zero_amount_subscription_not_refundable`→`No refund required`/`This task has no refundable payment.`; `refund_settlement_details_incomplete`→`Refund result unavailable`/`The current response does not contain a complete refund result.`. Otherwise jobType≠1 → `common::query::task_status_label/description(status)` (−1 `Initializing`/`The task is being initialized.`; 0 `Awaiting ASP acceptance`/`The task is waiting for an ASP to accept it.`; 1 `In progress`/`The ASP accepted the task and is working on it.`; 2 `Awaiting buyer review`/`The ASP submitted the deliverable and is waiting for buyer review.`; 3 `Awaiting refund decision`/`The buyer rejected the deliverable and the refund request awaits an ASP decision.`; 4 `Evaluation in progress`/`The refund request is in Evaluation.`; 5 `Stopped by platform`/`The platform stopped the task.`; 6 `Completed`/`The task completed and funds were released to the ASP.`; 7 `Closed`/`The task is closed.`; 8 `Expired`/`The task expired.`; 9 `Refund completed`/`The refund completed and the task is closed.`; else `Status unavailable`/`The task status is currently unavailable.`); jobType1 labels: −1 `Initializing`, 0 `Created`, 1 `Active`, 3 `Awaiting refund decision`, 4 `Evaluation in progress`, 6 `Completed`, 7 `Closed`, 8 `Expired`, 9 `Refund completed`, else `Status unavailable`; descriptions: 3 `The refund request is waiting for the ASP's decision.`, 4 `The refund request is in Evaluation.`, 6 `The subscription completed without a refund.`, 7 `The subscription is closed.`, 9 `The refund completed successfully.`, else `The refund status follows the current subscription state.`.

**`payload(reason, plan)`** (refund.rs:2196) — `refundFlowVerified` ⇔ plan.reason ∈ {direct_refund_confirmation_required, created_subscription_close_confirmation_required, refund_reason_required, refund_reason_too_long, refund_request_confirmation_required, provider_response_pending, arbitration_in_progress, refund_confirmed, refund_settlement_details_incomplete}; `providerDecisionFlow` ⇔ verified ∧ ((jobType0 ∧ status∈{2,3,4}) ∨ (jobType1 ∧ status∈{1,3,4})); `refundableAmount` = originalAmount if verified else `"0"`. Object (wire keys sorted):
```
{ schemaVersion: 2, refundContextId: context_id(reason),
  display: { serviceName: serviceName(non-blank) || title(non-blank) || null, jobId, serviceProviderName: providerName|null,
             agentId: providerAgentId|null, taskType: "Subscription"|"One-time",
             currentPeriod: jobType1 && start&&end ? "<localStart>–<localEnd>" : null   (format_local_timestamp_with_offset, EN DASH U+2013),
             refundAmount: zero(refundable)?"No refund required" : tokenSymbol(trim non-empty)? "<refundable> <sym>" : null,
             reasonForRefund: reason ?? recordedRefundReason ?? null,
             requestedAt: local(requestedAt)|null, resultDeadline: local(responseDeadline ?? (jobType1&&status1 ? periodEnd : null))|null,
             statusLabel, statusDescription, taskTypeLabel: "Subscription"|"One-time",
             serviceProviderLabel: name&&id ? "<name> (Agent ID : <id>)" : null,
             currentPeriodLabel: start&&end ? "<utcStart>–<utcEnd>" : null  (format_utc_timestamp),
             refundAmountLabel: zero(original)?"No refund required": sym(non-blank)?"<original> <sym>":null,
             responseDeadlineLabel: utc(responseDeadline)|null },
  job: { jobId, jobName: title, jobType: "subscription"|"one_time", rawJobType, refundState, rawStatus, statusName,
         statusLabel, statusDescription, buyerAgentId, providerAgentId, providerName, serviceId, serviceName, revision },
  subscription: jobType1 ? { kind: "trial"|"formal", trialType, periodIndex, periodStartTime, periodEndTime, autoRenew } : null,
  payment: { tokenAddress, tokenSymbol, chainId, paymentMode, originalAmount, refundableAmount, refundScope,
             partialRefundSupported: false, prorationSupported: false },
  input: { requiredParams: reason∈{refund_reason_required,refund_reason_too_long} ? ["reason"] : [], reasonMaxChars: 2000 },
  request: { userReason: refund_reason(reason), requestedAt, providerResponseDeadline: responseDeadline,
             providerNotification: { system: status==3?"unknown":"not_requested", email: same } },
  rules: { applies: verified, providerMayAgreeOrDispute: pdf, providerTimeoutRefundExpected: pdf, refundUsesOriginalToken: verified,
           fullRefundOnly: verified, partialRefundSupported: false, prorationSupported: false, onchainConfirmationRequired: verified },
  settlement: { state: settlement_state, cause: null,
                txHash: plan.reason∈{refund_settlement_details_incomplete, task_closed_no_new_refund_action} ? null : settlementTxHash,
                confirmationSource, provenance: plan.reason=="refund_confirmed" && provenance ? {source,operation,orderId,bizType,chainIndex,lifecycleStatus} : null,
                broadcastReceipt: null, confirmedAt: settlementTime, onchainConfirmationRequired: verified },
  arbitration: { phase: disputePhase, currentRound, prepareEndTime, roundEndTime, outcome: status==6?"not_refunded":null },
  capability: { clientOperation: plan.op kebab|null, usesExistingLifecycleEndpoint: op.is_some(),
                backendContractRequired: plan.reason ends with "contract_required" or "contract_ambiguous" } }
```
UTC format = `YYYY-MM-DD HH:MM (UTC+00:00)` (oracle: 1700000000 → `2023-11-14 22:13 (UTC+00:00)`); local
format = `YYYY-MM-DD HH:MM (UTC±HH:MM)`. Both accept ms timestamps (|v| ≥ 1e11 → /1000) and reject ≤0.

**`base_decision(phase, decision, reason, nextAction, payload)`** → `{decision,nextAction,payload,phase,reason}` (oracle test: key order `["decision","nextAction","payload","phase","reason"]`).
`action(id, recommend, params?)` → `{"id","params"?,"recommend"}`.

**`plan_actions(snapshot, plan, reason)`**: op+action → `[{id:action, params:{expectedJobType, expectedOriginalAmount, expectedStatus, jobId, operation:"<kebab>", refundContextId, reason?(only request-refund, = refund_reason(reason))}, recommend:true}, {id:"stop",recommend:false}]`;
action only → `[{id:action,params:{jobId},recommend:true},{id:"stop",recommend:false}]`;
recommendStop → `[{id:"stop",recommend:true}]`; else `[{id: status==4?"view_arbitration":"view_refund_status", params:{jobId}, recommend:true}, {id:"watch_task",params:{jobId},recommend:false}]`.

**`reconcile_actions(job, op)`**: op==request-refund → `[{id:"view_refund_status",params:{jobId},recommend:false}]`; else `[{id:"view_refund_status",params:{jobId},recommend:true},{id:"watch_task",params:{jobId},recommend:false}]`.

**Journal (reconciliation state)** — `ONCHAINOS_HOME/refund-v2/<hex(sha256(userAgentId + "\0" + jobId))>.json`,
lock file same stem `.lock` (`fs2` exclusive blocking lock; dir created via `ensure_dir_0700`). Example:
`buyer-1`,`job-1` → `30b445852802fee0b0ec8228d8aaa2d0bd8cdbc533744593f909ce01be0e8c44.json` (derived).
Written with `home::atomic_write(path, to_vec_pretty(state), sensitive=true)` (0600) + fsync file (+dir fsync on unix).
Pretty JSON, struct field order, `null` for None:
`schemaVersion, journalRevision, jobId, userAgentId, snapshotId, operation, state, jobType, trialType,
periodIndex, periodStartTime, periodEndTime, pkgId, orderId, orderType, bizUniqKey, txHash, accountId,
address, chainIndex, bizType, originalAmount, tokenAddress, tokenSymbol, providerAgentId, serviceId,
serviceName, paymentMode, updatedAt` (updatedAt = unix seconds). Read accepts missing `journalRevision`
(→2) and missing optional fields. Read validation: `schemaVersion==2`, `journalRevision∈{2,3}`, same job and
user → else `Refund V2 reconciliation state does not match this task and identity`; parse error →
`parse Refund V2 reconciliation state <path>: …`. States: `unknown`, `broadcast_submitted`, `confirmed`,
`confirmed_without_hash`, `broadcast_failed`, `lifecycle_advanced_without_receipt`, `provenance_incomplete`,
`closed_without_payment`, `refund_request_applied`, `request_provenance_incomplete`.
`has_durable_broadcast_receipt` ⇔ pkgId, orderId, orderType, bizUniqKey all non-blank.

**`reconcile_pending_mutation_locked(snapshot)`** (refund.rs:794) → `Option<pending>` (Some ⇒ blocks):
1. Read journal; read error ∧ status 8 → delete journal, None; other error → Err. None file → None.
2. op close-created-subscription ∧ status∈{7,8}: zero amount → set state `closed_without_payment` (write if changed), None. Else clear snapshot settlement (confirmed=false, txHash=None, provenance=None); if state∈{confirmed,confirmed_without_hash} and provenance matches → apply (confirmed, txHash if valid, provenance{source:"wallet_order_detail",operation,orderId,bizType,chainIndex,lifecycleStatus:status}) → None; state∈{broadcast_failed, lifecycle_advanced_without_receipt, provenance_incomplete} → None; no durable receipt → write `lifecycle_advanced_without_receipt`, None; provenance mismatch → write `provenance_incomplete`, None; else query wallet order: Succeeded(h) → write `confirmed`(h)/`confirmed_without_hash`, apply (mismatch → Err `confirmed Refund V2 order no longer matches its Created subscription close provenance`), None; Failed → write `broadcast_failed`, None; Pending/Unknown/Err → **Some(state)**.
3. status 8 → delete journal, None.
4. `apply_confirmed_direct_refund` (state `confirmed` ∧ direct provenance ∧ valid txHash ∧ ids) → sets txHash + provenance, None.
5. op request-refund ∧ status∈{3,4,6,8,9}: legacy journal (rev 2) ∧ status∈{6,8,9} → matched = wallet order Succeeded ∧ legacy core provenance; else matched = request provenance (sets `refund_request_provenance`, and settlement confirmed when status 9). If matched ∧ rev<3 → upgrade journal (rev 3, copy jobType/trialType/period* from snapshot; only when jobType0, or jobType1 ∧ trial0 ∧ 0<start<end). next state `refund_request_applied` or `request_provenance_incomplete`; write if state or revision changed; None.
6. op direct-refund ∧ status 7: state∈{broadcast_failed, lifecycle_advanced_without_receipt, confirmed_without_hash} → None; no receipt → `lifecycle_advanced_without_receipt`; provenance mismatch → `provenance_incomplete`; query order: Succeeded → `confirmed`/`confirmed_without_hash` (hash present but apply fails → Err `confirmed Refund V2 order no longer matches its direct-refund provenance`); Failed → `broadcast_failed`; Pending/Unknown/Err → None (Closed(7) itself is settlement).
7. `pending_mutation_resolved`: direct-refund: status∈{1,2,3,4,6,8,9}; close-zero: {1,2,3,4,6,7,8,9}; request-refund: {3,4,6,7,8,9}; cancel-trial-conversion: status≠1 ∨ autoRenew==0; close-created-subscription: status∉{0,7,8} ∨ (status∈{7,8} ∧ zero); `finalize-expired-refund`: always; other: never → resolved ⇒ delete journal, None; else **Some(state)**.

Provenance predicates (exact): *direct*: op direct-refund, status7, jobType0, paymentMode1 (snapshot and journal), non-zero, durable receipt, bizType>0, non-blank accountId/address, chainIndex=="196", originalAmount decimal_equal, tokenAddress & tokenSymbol present in both and equal ignoring ASCII case, providerAgentId present in both and equal, service match (serviceId both present → equal; else serviceName both present and equal).
*created-subscription close*: op close-created-subscription, status∈{7,8}, jobType1, same jobId, non-zero, durable receipt, bizType>0, non-blank account/address, chainIndex "196", journal jobType==1, userAgentId==buyer, amount decimal_equal, tokenAddress present in both & equal (ci); tokenSymbol (ci), providerAgentId, service compared only when both sides present.
*request-refund core*: rev∈{2,3}; op request-refund; state∈{broadcast_submitted, refund_request_applied, request_provenance_incomplete}; same job & buyer; jobType check (0: journal jobType==0 or legacy-with-None, both paymentMode==1; 1: journal jobType==1 or legacy-None, snapshot trial0, journal trial0 or legacy-None, and (legacy or 0<start<end in journal)); journal providerAgentId, (serviceId or serviceName), tokenSymbol all non-blank; status∈{3,4,6,8,9}; durable receipt; bizType>0; non-blank account/address; chainIndex "196"; amount decimal_equal ∧ valid ∧ non-zero; tokenAddress both present equal (ci); optional (only when both present) tokenSymbol (ci), providerAgentId, service, periodIndex, periodStart, periodEnd, paymentMode. Non-legacy additionally none; *request_refund_provenance_matches* = core ∧ (rev≠2 ∨ status∈{3,4}).

**`query_refund_order_status(journal)`** → if account/address missing: `resolve_wallet_by_agent_id(userAgentId)`; missing → `Refund V2 journal is missing the broadcast account|address`; JWT; **GET `/priapi/v5/wallet/agentic/order/detail`** via `WalletApiClient.get_authed` (JWT headers, **no agenticId**) with query `accountId=…&chainIndex=<journal chainIndex or "196">&address=…&orderId=…` (or `&txHash=…` when no orderId; neither → Unknown without HTTP; empty values dropped; values form-urlencoded); error context `query Refund V2 broadcast order status`. Binding: single-item (array len 1, or object) `orderId`/`chainIndex` present and different → `wallet order detail returned a mismatched orderId|chainIndex`. `parse_refund_order_status`: `txStatus` (scalar, uppercased) `1|2|PENDING` → Pending; `3|6|ERROR|FAIL|FAILED|CANCELLED` → Failed; `4|SUCCESS` → observed hash (present & invalid → Unknown), submitted hash (non-blank & invalid → Unknown), both present and differ (ci) → Unknown, else Succeeded(observed or None); other/array len≠1 → Unknown.

**`strict_broadcast_receipt(r)`**: not object → `broadcast response did not contain a receipt object`; each of `pkgId, orderId, orderType, bizUniqKey` scalar-missing → `broadcast response is missing {field}`; `txHash` null/absent/blank → null; valid → trimmed; other string → `broadcast response returned an invalid transaction hash`; non-string → `broadcast response returned a non-string transaction hash`.
**`lifecycle_biz_type(resp)`**: `type` scalar_i64 > 0 else `lifecycle endpoint did not return a valid type`.
**`validate_lifecycle_preflight(uop)`**: only literal `executeResult:false` fails → `backend transaction preflight failed: {executeErrorMsg|"no error detail returned"}`.
**`sign_response(client, resp, acct, addr, snapshot, reason?, _)`**: `uopData` non-null else `lifecycle endpoint did not return uopData`; `jobId` scalar else `lifecycle endpoint did not return jobId`; ≠ snapshot job → `lifecycle endpoint returned a mismatched jobId`; preflight; bizType; `sign_uop_and_broadcast_full(uopData, bizType, agentic=buyer, extra = reason ? {"reason":reason} : None)`; `strict_broadcast_receipt` with context `broadcast receipt result is unknown`; `receipt.bizType = bizType`.

**Mutation error classification** (handle_execute): `definitive` ⇔ some cause is `ApiCodeError` with HTTP 2xx; `mayBeUnknown` ⇔ some cause's Display == `broadcast failed` or ends with `result is unknown`.

**Settlement helpers used by other groups**: `authoritative_refund_settlement_confirmed(ctx, expected)` (status must equal expected ∈{7,8,9}; 8: valid non-zero amount ∧ (jobType0 ∨ (jobType1∧trial0)); 9: valid non-zero ∧ (jobType0 ∨ (jobType1 ∧ trial≠1)); 7: jobType0 ∧ paymentMode1 ∧ valid non-zero); `refund_event_settlement_confirmed` = same (event ignored);
`verify_final_refund_event(message, ctx, expected, buyer)` → `RefundSettlementEvidence{provider_name, provider_agent_id, service_name, amount, token_symbol, tx_hash}` — message ignored when expected==8; errors (exact): `fresh authoritative task detail is missing`, `fresh task status does not match a refund-capable lifecycle state`, (7) `paid close is not proven to be the escrow direct-refund path` / `subscription Closed(7) lacks an authoritative refund-cause contract` / `fresh task detail returned unsupported jobType={n}` / `fresh task detail is missing jobType`, `fresh task detail is not owned by the current User Agent`, `fresh task detail does not confirm refund settlement`, message `code|txStatus` ∈{failed,failure,error} (ci) → `refund transaction-result notification reports failure`, `refund event provider does not match fresh task detail` (message `providerAgentId|aspAgentId`), `refund event service does not match fresh task detail` (`serviceId`), `refund event service name does not match fresh task detail`, `fresh task detail is missing a valid paid original amount`, amount (`refundAmount|paymentTokenAmount|tokenAmount`) not decimal_equal → `refund event amount is not the full original payment`, symbol mismatch → `refund event token does not match the original payment token`, (≠8 and no tokenAddress) `fresh task detail is missing the original token address`, address mismatch → `refund event token address does not match the original payment token`, buyer mismatch (`buyerAgentId|userAgentId`) → `refund event buyer does not match fresh task detail`. Fallbacks: provider id `unavailable`, name `name unavailable`, service `serviceName ?? serviceId ?? "service unavailable"`, symbol `token symbol unavailable` (when blank or `?`); tx_hash only from `ctx.verified_transaction_hash` (never from the event).
`fetch_authoritative_refund_context(client, job, buyer)` = `fetch_snapshot` + `reconcile_without_downgrading_confirmed_settlement` → `PreFetchedTaskContext` (title, description "", jobType, trialType, tokenSymbol (None→`?`), tokenAmount=original, paymentMode, providerAgentId/Name, userAgentId=buyer, status, serviceId/Name, refundReason=recorded, periodStart/End, tokenAddress, verified_transaction_hash=settlementTxHash, refund_request_provenance, expire_time=responseDeadline, others None/false). Used by `agent next-action` freshness (mod.rs:4347/4390/4430, retries after 250/750/1500 ms).
`fetch_authoritative_refund_context_for_provider(client, job, asp)` = snapshot without buyer check or enrichment/reconcile. `fetch_refund_list_item_for_identity` / `refund_list_item` (used by `task/refund_list.rs`, g-owner elsewhere): display = display_payload(None, original) + statusLabel/Description + `requestedRefund`=refundAmount, `buyerReason`=reasonForRefund, `responseDeadline`=resultDeadline; `refund_request_available` ⇔ plan(None).reason==`refund_reason_required`. `has_created_subscription_close_receipt(job, user)` (used by common/lifecycle.rs, common/query.rs): journal op close-created-subscription ∧ state∈{broadcast_submitted, confirmed, confirmed_without_hash, closed_without_payment} ∧ durable receipt.

**`fetch_snapshot(client, job, buyer)`**: GET task detail (`get_with_identity`, context `failed to fetch authoritative task detail`); `jobType` via scalar_i64 (missing → `task detail is missing jobType`); jobType1 → GET `/priapi/v1/aieco/task/subscribe/{job}` (context `failed to fetch authoritative subscription detail`); build snapshot with buyer check; if providerName None ∧ providerAgentId → `fetch_agent_profile` (subprocess; fallback name `Agent <id>`); if serviceName None ∧ provider ∧ serviceId → `find_service` (subprocess; **error propagates**) → trimmed `serviceName`.

**`current_user_agent_id(job)`**: `ensure_tokens_refreshed()` error → emits login block (success envelope) and returns None; `resolve_user_agent()` error containing `no user identity` → emits identity block, None; other error → Err `failed to resolve current User Agent: <e>`.
Login block data: `{"decision":"blocked","nextAction":[{"id":"login","params":{"jobId":job},"recommend":true}],"payload":{"schemaVersion":2},"phase":"login_validation","reason":"login_required"}`.
Identity block data: same with `phase:"identity_validation"`, `reason:"user_identity_required"`, action id `register_user_agent`.

### 6. Partition-owned helpers — subscriptions (`user/subscription_ops.rs`)

- `status_name(n)`: −1 `INIT`, 0 `CREATED`, 1 `ACTIVE`, 3 `REJECTED`, 4 `DISPUTED`, 6 `COMPLETED`, 7 `CLOSED`, 8 `EXPIRED`, 9 `FAILED`, else `UNKNOWN_{n}`.
  `status_label(n)`: −1 `Initializing`, 0 `Awaiting ASP acceptance`, 1 `Active`, 3 `Awaiting ASP decision`, 4 `Evaluation in progress`, 6 `Completed`, 7 `Closed`, 8 `Expired`, 9 `Refund completed`, else `Status unavailable`.
  `status_description(n)`: −1 `The subscription record was created and is awaiting on-chain confirmation.`, 0 `The subscription is waiting for an ASP to accept it.`, 1 `The subscription is active.`, 3 `The buyer rejected the current delivery and is waiting for the ASP's decision.`, 4 `The refund request is in Evaluation.`, 6 `The subscription completed without a refund.`, 7 `The subscription is closed.`, 8 `The subscription expired.`, 9 `The refund completed successfully.`, else `The subscription status is currently unavailable.`.
- `parse_status_filter(s)` (clap value parser for `--status`): `s.parse::<i32>()` passes through any integer; else upper-cased name INIT…FAILED; else `invalid status '{s}': expected a code (-1/0/1/3/4/6/7/8/9) or a name (INIT/CREATED/ACTIVE/REJECTED/DISPUTED/COMPLETED/CLOSED/EXPIRED/FAILED)` (clap error, exit 2).
- **`SubscriptionInfo`** (typed row, `serde(default, rename_all="camelCase")`): deserialised fields `jobId jobType status chainId title description descriptionSummary buyerAgentId buyerAgentAddress providerAgentId providerAgentAddress trialType trialStartTime(alias trailStartTime) trialEndTime(alias trailEndTime) subStartTime subEndTime subBufferEndTime autoRenew copyTrade periodIndex serviceId serviceDescription serviceParams serviceTokenAddress serviceTokenAmount paymentTokenAddress paymentTokenAmount paymentCurrencyAmount offlineReceiveFlag role hasFeedBack deviceList categoryCodes`; strings default `""`, ints `0`, bools `false`, Options `null`. A JSON `null` for a non-Option String/int field **fails** the parse (`failed to parse …: invalid type: null, expected …`). `deviceList`/`categoryCodes`: null/missing → None; array → strings kept, non-strings dropped; other shapes → `[]`. Serialised out (after `enrich_subscription_info`): all the above plus `statusName, statusLabel, statusDescription, thisDeviceReceives`; `serviceDescription` omitted when empty; `trialStartTime/trialEndTime` names only; `categoryCodes` always array; `deviceList` keeps null / [] / list.
- `device_receives(thisId, list, defaultAll)`: list None → defaultAll; else thisId ∈ list (thisId None → false).
- `enrich_buyer_subscription_page(data, agent)` (used by `my-tasks` and subscription-list): parse `{list,total,totalNoCondition?,page?,pageSize?}` (error `failed to parse subscription page: {e}`), keep rows with `buyerAgentId == agent`, enrich (defaultAll=true) → `{list, total, totalNoCondition?, page?, pageSize?, thisDeviceId: <cached device id|null>, thisDeviceName: <cached OS name>}`.
- `fetch_active_buyer_subscriptions_for_agent(client, buyer)` (used by task-service-select, create-subscribe, task-create-prepare): select id; **GET `/priapi/v1/aieco/task/subscribe/my`** (`get_with_agent_id`, no sessionCert) — errors `failed to check existing subscriptions: {e}` / `failed to parse existing subscriptions: {e}`; keep `buyerAgentId==buyer ∧ status==1`; map to `ExistingSubscriptionSummary{jobId, serviceId, providerAgentId, statusLabel, statusDescription, restoreListeningAvailable: status==1}` (serialised keys: `jobId, providerAgentId, restoreListeningAvailable, serviceId, statusDescription, statusLabel`; `statusName/title/status` skipped); sorted by jobId. `existing_subscription_for_service(list, sid)` = first with equal serviceId.
- `fetch_my_subscriptions_snapshot_for_agent[_read_only](client, role, status?, header)` (used by user/mod.rs login flows and task/refund_list.rs): select id; GET `/priapi/v1/aieco/task/subscribe/my` (get_with_agent_id) — errors `failed to fetch subscriptions: {e}` / `failed to parse subscription list: {e}`; filter by role (buyer: buyerAgentId==id; provider: providerAgentId==id) and optional `status == i64(status)`; enrich (defaultAll = buyer); if buyer and not read-only: for each status==1 row `ensure_subscription_session(jobId, id, providerAgentId)`; data `{list, thisDeviceId, thisDeviceName}`.
- `ensure_subscription_session(job, me, provider)`: skip if me/provider empty or provider `?`, or jobId not `[A-Za-z0-9_-]+`, or marker `ONCHAINOS_HOME/subscription/consent/<jobId>` exists; else `okx-a2a session create --job-id J --my-agent-id M --to-agent-id P --json`; on success `okx-a2a session send --job-id J --content "[SUB_CONSENT] subscription session established." --json --to-agent-id P` (5 s timeout, result ignored) and write marker `1` (`home::write_secure`). Never fails the caller.
- `fetch_subscribe_detail_for_agent(client, sub, agent)` (used by user/mod.rs, common/lifecycle.rs): GET `/priapi/v1/aieco/task/subscribe/{sub}` (get_with_identity), error `subscribe-detail failed: {e}`.
- `handle_subscribe_reject_inner` (dead code — only caller is the unreachable `v2::reject::handle`): select id, resolve wallet, POST `/subscribe/{sub}/reject` `{}`, broadcast with bizContext `reason`.
- `SUBSCRIBE_API_PREFIX` = `/priapi/v1/aieco/task/subscribe` (user/create_subscribe.rs, owned elsewhere).

### 7. Partition-owned helpers — ASP/service compaction (`user/asp_ops.rs`)

- `selected_subscription(svc)` = first `subscription[]` entry with `interval == "month"` (exact, case-sensitive) else first entry. `selected_subscription_fee` = its `fee` unless null or blank string.
- `build_subscription_info(svc)`: `svc.subscriptionInfo` object → returned verbatim; else if no selected entry and `supportSubscription != true` → null; else `{interval: entry.interval|null, feeAmount: fee|null, supportTrial: svc.supportTrial==true, freeTrial: svc.freeTrial ?? 0}`.
- `add_service_guide_hash`: non-blank `serviceGuide` → `serviceGuideHash = "sha256:" + hex(sha256(guide bytes))` (71 chars).
- `compact_task_service_for_ai(svc)` (also used by `task_create_prepare.rs`): `providerAgentId` = `asp.aspAgentId ?? providerAgentId ?? aspAgentId`; `providerAgentName` = `asp.aspName ?? providerAgentName ?? aspName`; `securityRate/feedbackRate/soldCount` from `asp.*` else top level; copy (if present, including null) `sid, serviceId, serviceName, serviceType, serviceDescription, serviceGuide, feeToken, feeTokenSymbol, endpoint`; `serviceGuideHash`; `feeAmount` only when no subscription info; `online` = `asp.onlineStatus == 1`; `supportSubscription`; `subscriptionInfo`.
- `compact_service_for_ai` (asp-match): same copy list without `sid`/asp fields/`online`.

### 8. Partition-owned helpers — v2 protocol (`user/v2/*`)

- `v2::create_and_fund::execute(client, input, acct, addr, buyer, readiness)` (called by `agent create-task`, user/create.rs — command owned elsewhere): POST `/priapi/v1/aieco/task/createAndFundConfirmStatus` `{amount, chainId, providerAgentId, serviceId, tokenSymbol}` (post_with_identity; context `createAndFundConfirmStatus failed`); required strings `jobId taskSalt provider receiver evaluator currency recipient amount hook hookData salt` (`createAndFundConfirmStatus response missing {name}`), u64 (number or numeric string) `submitWindow disputeWindow evaluateWindow completedWindow` (`… missing or invalid {name}`), `expiredAt` (int seconds → RFC3339 via chrono `to_rfc3339`, or RFC3339 string; else `… missing or invalid expiredAt`); audit `user/task_create_and_fund_confirmed`; `a2a_pay::sign_escrow{chain_id, provider: **hook** (nonce compatibility), receiver, arbitrator: evaluator, currency, escrow_contract: recipient, amount, windows, hook, hook_data, salt, expired_at}` (payment group: EIP-3009 TEE sign via gen-msg-hash/sign-msg; context `EIP-3009 create-and-fund signing failed`); POST (no retry) `/priapi/v1/aieco/task/createAndFund` `{chainId, description, jobId, paymentTokenAmount, paymentTokenSymbol, providerAgentId, serviceId, serviceParams, serviceTokenAddress, serviceTokenAmount, signature, taskSalt, title, validAfter:u64, validBefore:u64, visibility, descriptionSummary?, categoryCode?, minCreditScore?(f64)}` (context `createAndFund failed or returned an unknown network result for jobId={id}`); response must echo jobId (`createAndFund response missing jobId` / `createAndFund returned jobId {a}, expected {b}`), have `uopData` (`createAndFund response missing uopData`), `type == 201` (`unexpected bizType {n}; expected 201`); copy attachments + readiness callback; bind A2A runtime (required; failure → abort consent, context `cannot bind task to the current AI runtime; creation was not broadcast`); `sign_uop_and_broadcast_full(bizType 201)` (failure → rollback bind + abort consent, context `broadcast failed or returned an unknown result for jobId={id}`; null → `broadcast returned no receipt`). **FUNDS.**
- `v2::create_subscription::execute(...)` (called by `agent create-subscribe`): POST `/subscribe/providerConfirmStatus` `{autoRenew:i32, providerAgentId, serviceId, subId:0, useTrial:bool}` (context `providerConfirmStatus failed`); empty object → `providerConfirmStatus returned empty terms; the service may not support subscription`; `typedData` non-empty object else `providerConfirmStatus response missing typedData`; terms = response minus `typedData`; effectiveUseTrial = response `useTrial` bool ?? requested; sign typedData (context `EIP-712 subscription terms signing failed`); POST (no retry) `/subscribe/createSubscription` `{autoRenew, description, deviceList:null, providerAgentId, serviceId, serviceInterval, serviceParams, serviceTokenAddress, serviceTokenAmount, terms, termsSig, title, useTrial}` (context `createSubscription failed or returned an unknown network result`); response `jobId` (trimmed) else `createSubscription response missing jobId`, `uopData` else `createSubscription response missing uopData`, `type == 204` else `unexpected bizType {n}; expected 204`; attachments/readiness; best-effort bind; broadcast (null → `broadcast returned no receipt for jobId={id}`; error context `broadcast failed or returned an unknown result for jobId={id}`). **FUNDS.**
- `v2::complete::handle` — see `agent complete`.
- `v2::reject::try_handle_free_review(client, job, reason?)` (used by next-action `reject_review`): `resolve_user_agent()`; GET task detail; not (jobType==0 ∧ zero `paymentTokenAmount|tokenAmount`) → Ok(None); status≠2 → Err `free review rejection requires Submitted(2), current status is {:?}` (Rust Debug of Option<i64>, e.g. `Some(1)`/`None`); blank reason → Ok(Some(reason_required_result)) = `{"decision":"requires_user_input","nextAction":[{"id":"request_rejection_reason","params":{"agentId":<local user>,"jobId":job,"shortJobId":short_job_id(job)},"recommend":true}],"payload":{"requiredParams":["reason"]},"phase":"deliverable_review","reason":"rejection_reason_required"}`; >2000 chars → `Reject reason exceeds 2000 characters`; else `resolve_wallet_and_agent_for_task` + `task_dual_sign_and_broadcast("pre-reject","reject", extraMain None, bizExtra {"reason":trimmed})`; audit `user/free_reject_submitted`; → `{"decision":"ready","nextAction":[{"id":"stop"}],"payload":{"expectedRawStatus":9,"expectedStatus":"failed","jobId","txHash"},"phase":"deliverable_review","reason":"free_rejection_submitted"}`. **FUNDS/state (reject lifecycle).** `v2::reject::handle` + `validate_rejection_reason` are unreachable dead code (`--reason is required for reject`).
- `v2::job_completed::handle(job, agent)` (next-action `job_completed`): GET task detail (errors → blocked `task_detail_unavailable`); `jobId` ≠ job → `task_detail_job_id_mismatch`; `status` (i64) ≠ 6 → `stale_task_status`; rating required ⇔ not same owner (`buyerAgentAddress` and `providerAgentAddress` both non-blank and equal ci); provider id missing → `task_detail_unavailable`. Ready result `{"decision":"ready","nextAction":[{"id":"finalize_user_task","recommend":true}],"payload":{"jobId","notification":{"content":…,"localize":true},"rating":{"creatorAgentId":agent,"deliverables":[{"name","path","type"}…],"required":bool,"targetAgentId":provider,"taskAttachments":[paths],"taskDescription":description,"taskParameters":serviceParams(non-empty)|null},"ratingResultNotification":content::rating_submitted_user_notify(job, title||"Task")},"phase":"task_completion","reason":"notification_and_rating_required"|"notification_required"}`; notification content = `"[onchainos:task-terminal] " + ("[x402 Job Completed] {title} (`{job}`) — all steps complete.\n- Spent: {amt} {sym}\n- Payment: x402"` if paymentMode 3 else `"[Job Completed] {title} (`{job}`) — approved by the User Agent; funds released to the ASP.\n- Spent: {amt} {sym}\n- Payment: escrow"`) + (rating ? `"\n\nTo rate this job, reply \"Rate job\". Your rating for Job ID `{job}` replaces the AI-generated rating."` : "")`. If rating required: subprocess `onchainos agent task-feedback --agent-id A --task-id J` → data non-empty OR lookup error ⇒ reason `notification_required`, `rating.required=false`, drop `ratingResultNotification`. Blocked: `{"decision":"blocked","nextAction":[{"id":"stop"}],"payload":{"jobId"},"phase":"task_completion","reason":…}`.
- `v2::sub_complete_notify::handle(agent, message)`: `message.jobId` (non-empty string) else blocked `job_id_required` (payload `{}`); `validate_job_id` fail → blocked `invalid_job_id` (+`error`); GET task detail (failure → `session_cleanup::handle_session_cleanup(job,false)` + blocked `task_detail_unavailable` with error text); jobId mismatch → cleanup + blocked `task_detail_job_id_mismatch` (error `response jobId does not match message.jobId`). Rating allowed ⇔ not same owner ∧ provider id; rating payload `{creatorAgentId, deliverables:"<sample text>", providerAgentId, required:true, taskDescription, taskParameters}` unless feedback exists/lookup fails → `{required:false}`. Success `{"decision":"ready","nextAction":[{"id":"finalize_user_subscription","recommend":true}],"payload":{"jobId","notification":{"content": content::sub_complete_notify_user_notify(title||"subscription", job, None, ratingAllowed),"localize":true},"rating":…,"ratingResultNotification"?},"phase":"subscription_completion","reason":"notification_required"}`; blocked: phase `subscription_completion`, `nextAction:[{"id":"stop"}]`, payload `{jobId?, error?}`. Deliverable sample: manifest missing/empty → `Deliverables: none found.\n`; dir error → `Deliverables: directory unavailable.\n`; else up to 5 entries picked by `pick_sample_indices` (FNV-1a 64 seed of jobId, LCG `x = x*6364136223846793005+1`, `j = i + (x>>33) % (total-i)`, swap, sort) formatted `"{n}. {original_name} (type: {type}, path: {path})"` + for text `"\n   Preview: {first 500 chars}{"...(truncated)" if longer}"`, joined `\n`, wrapped `"Deliverables ({total} total, sampled {k}):\n{…}\n"`.
- `v2::notification::sub_asp_claim_notify(job)` → `{"decision":"ready","nextAction":[{"id":"stop"}],"payload":{"event":"sub_asp_claim_notify","jobId":job,"role":"user"},"phase":"notification","reason":"notification_not_required"}`. (`job_asp_accept_expire/job_asp_reject_closed/job_asp_reject_expire` in this file are unreachable — the ASP flow uses `task/asp/v2/notification.rs`.)

### 9. Partition-owned helpers — flow plumbing (`user/flow.rs`, `flow_lifecycle/*`)

- `notify_and_end(c)` = `"**Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n```bash\nonchainos agent user-notify --content \"<localized content shown below>\"\n```\nContent: {c}\n\nEnd turn after the call.\n"`.
- `notify_and_end_terminal(c, hint)` = `"**Localize first** — rewrite only the human-readable content below in the user's language. Preserve the exact `[onchainos:task-terminal]` prefix; do not translate, remove, or move it.\n```bash\nonchainos agent user-notify --content \"[onchainos:task-terminal] <localized content shown below>\"\n```\nContent after the marker: {c}\n\n{hint}\n"`.
- `notify_and_end_with_deposit(c, addr)` (flow.rs:169; uses `crate::qr::build_qr_output(addr, None)` JSON) — verbatim template flow.rs:176–184.
- terminal hint (`ctx.terminal_session_hint`, flow.rs:324–329) = `"Task is at a terminal state — run the cleanup command (handles pending-decision cancellation automatically):\n```bash\nonchainos agent session-cleanup --job-id {job}\n```\nThen follow the command's output to close conversations (if applicable)."` (the two-space indentation visible in the source is consumed by the `\`-newline continuation rule of §0.5).
- `staked_and_unknown(evt, job)` = `"[Unknown Status] {evt}\n[Advice]\n1. Call `onchainos agent common context {job} --role user` to view full context\n2. If this status is not part of the expected flow, wait for user instructions\n3. Do not predict / assume other notifications\n"`.
- `try_recover_from_temp_file(job, agent, short, title, sym, amt, provider?)` (re-exported; used by next-action freshness for `job_submitted`, mod.rs:4630): spool dir = `std::env::temp_dir()`; candidates `a2a_deliver_{job}_*.json` (the fixed name `a2a_deliver_{job}.json` is ignored), oldest mtime first; each is parsed (safe path under temp dir or `/tmp`; envelope must have `msgType:"a2a-agent-chat"`, `jobId==job`, `receiverAgentId==agent`, content first `jobId:` line == job, last non-blank line `[intent:deliver]`); file → `okx-a2a file download --file-key … --agent-id … --digest … --salt … --nonce … --secret … [--filename …]`; text → temp file `ONCHAINOS_HOME/tmp/deliverables/onchainos-deliverable-text-*.txt`; then `deliverables::handle_save(role "user")`; success deletes the spool; failure renames to `<path>.failed` and tries the next; rename failure stops.
- `available_actions(status, job)` (flow.rs:205) — public but unused anywhere (dead).
- `route_subscription_delivery_to_skill`, `resume_queued_subscription_delivery` — see next-action `deliverable_received` / `autotrade_queued_resume`.

---

## Commands

### `onchainos agent asp-match`  (hidden: no)
- Handler: `asp_ops::handle_asp_match` (asp_ops.rs:566) via `run_task` (user/mod.rs:1925).
- Options: `--job-id <JOB_ID>` (String, **required**); `--provider-agent-id <ID>` (Option<String>); `--payment-token-amount <F64>` (Option<f64>; clap f64 parser — invalid → clap error exit 2); `--page <usize>` default `1`; `--agent-id <ID>` (Option); `--format <S>` default `""`. Root global `--chain` ignored.
- Auth: jwt-required (+ agent id header).
- Steps:
  1. `job_id.trim()` empty → Err `--job-id cannot be empty`.
  2. `json_mode = format.eq_ignore_ascii_case("json")`.
  3. agent = `--agent-id` or `resolve_agent_id_by_role(1)` (subprocess get-my-agents; may be `""`).
  4. POST `/priapi/v1/aieco/task/asp/match` (`post_with_identity`, header `agenticId: <agent>`), body (sorted) `{"jobId":job,"page":page,"paymentTokenAmount"?:<f64 JSON number, e.g. 0.7 / 5.0>,"providerAgentId"?:…, "sessionCert"?:…}`.
  5. For every `recommendations[].services[]`: if a subscription fee is selectable set `feeAmount = fee` (value copied verbatim, may be number or string).
  6. audit `user/asp_match` (`agentId=`, `jobId=`, `page=`, `results=<n>`).
  7. JSON mode → `output::success({"nextPage"?: resp.nextPage (only if key present), "recommendations":[{feedbackRate?,providerAgentId?,providerAgentName?,securityRate?,services:[compact_service_for_ai…],soldCount?,supportA2MCP?}]})` (other fields dropped; missing `recommendations` → `[]`).
  8. Text mode: no recs → `No matching ASPs found for this task.`; else `Matched ASPs (page {page}, {n} results):` + blank line; per rec i: `━━━ {i+1}. {Agent pid(pname) | Agent pid} ━━━`, `  security: {sec:.2} | feedback: {fb:.2} | sold: {sold} | A2MCP: {bool}` (missing numbers → 0 / `?` pid); per service: `  Service: {sid}` + (` — {name}` if non-empty) + ` [{type}]`, then `    {desc}` if non-empty, `    Fee: {amt} {sym}` (amt = trimmed non-empty string or JSON number text) else `    Fee: (no price — negotiation required)`, per subscription entry `    Subscription: {fee|"?"} {sym}/{interval|"month"}` + ` (trial available)` when `supportTrial==true`; blank line after each rec; finally `Next page: {n}` when `nextPage` is u64.
- Output: JSON envelope (json mode) or plain text.
- Errors: exit 1 with API/auth errors (`{e:#}`).
- Side effects: read-only (backend query).
- Nondeterminism: none beyond backend data.
- Parity test cases: `agent asp-match --job-id 0x<64hex> --format json` (SAFE); `agent asp-match --job-id 0x<64hex> --page 2 --payment-token-amount 5` (SAFE, text); `agent asp-match --job-id " "` (SAFE, error).

### `onchainos agent task-service-select`  (hidden: no)
- Handler: `asp_ops::handle_task_service_select` (asp_ops.rs:445).
- Options: flattened `ServiceMatchArgs` — `--keywords <K>...` (num_args 1..; Vec), `--asp-agent-id`, `--asp-name`, `--service-name`, `--sid` (→ service_id), `--min-payment-token-amount`, `--max-payment-token-amount` (strings), `--search-after`, `--limit <u64>` default `3`; plus `--agentic-id <ID>` (Option), `--format <S>` default `json`.
- Auth: jwt-required (subprocess + subscribe/my).
- Steps:
  1. Spawn `<current_exe> agent service-match` with args in this order: `--keywords k1 k2 …` (only non-blank keywords; omitted if none), `--asp-agent-id V`, `--asp-name V`, `--service-name V`, `--sid V`, `--min-payment-token-amount V`, `--max-payment-token-amount V`, `--search-after V` (each only when non-empty), always `--limit N`. (The child's HTTP traffic is owned by the identity group.)
  2. Child exit ≠ 0 → Err `service-match failed: {stderr trimmed}` (the child writes its error JSON to stdout, so stderr is usually empty).
  3. Parse stdout JSON (serde error text on failure); if `ok==true` or `code==0` → `data` (or null) else whole value.
  4. Compute `autoTradePreflight` for each service (local filesystem probing only; the field is later **dropped** by compaction — no observable effect).
  5. Compact: `services` = those with `asp.onlineStatus==1` or offline x402 (`serviceType` == `A2MCP` ci and non-blank `endpoint`); if none eligible keep all; each → `compact_task_service_for_ai`. `matchStatus` = `no_match` (no services) | `no_online_service` (none eligible) | `matched`. Copy `searchAfter`, `hasMore`, `unmatchReason` when present.
  6. If any compact service has `supportSubscription==true`: `--agentic-id` blank → Err `--agentic-id is required to check existing subscriptions before selecting a subscription service`; `fetch_active_buyer_subscriptions_for_agent` (GET `/priapi/v1/aieco/task/subscribe/my`); for each subscription service set `existingSubscription` = matching summary or null; add `subscriptionCheck:{"blockingServiceCount":n,"status":"checked"}`; if `services[0].existingSubscription` non-null add `duplicateSubscription:{"userFacingPrompt": "Service \"{serviceName||serviceId}\" already has a subscription task, jobId: {jobId}. It cannot be created again." + (restore ? " Would you like to restore listening?" : ""), "nextAfterUserChoice"?:["restore-listening"] (restore only)}` and minimise `services[0]` to keys `existingSubscription, providerAgentId, serviceId, serviceName, serviceType, supportSubscription`.
  7. `--format` empty or `json` (ci) → `output::success(compact)`; else prints `matchStatus` string (default `no_match`).
- Output keys (sorted): `duplicateSubscription?, hasMore?, matchStatus, searchAfter?, services, subscriptionCheck?, unmatchReason?`.
- Errors: as above; subscribe/my errors `failed to check existing subscriptions: …`.
- Side effects: read-only.
- Nondeterminism: backend ranking.
- Parity test cases: `agent task-service-select --keywords audit --limit 1 --format json` (SAFE); `agent task-service-select --search-after cursor-1 --limit 3 --agentic-id 1695` (SAFE); `agent task-service-select --keywords x --format text` (SAFE).

### `onchainos agent set-asp`  (hidden: no)
- Handler: `asp_ops::handle_set_asp` (asp_ops.rs:725).
- Options: `<JOB_ID>` (positional, required); `--provider-agent-id`, `--service-id`, `--service-type`, `--service-params`, `--service-token-address`, `--service-token-amount` (all required Strings); `--payment-token-symbol`, `--agent-id` (optional). Unknown flags such as `--payment-token-amount` → clap error (exit 2).
- Auth: jwt-required + session-key signature (conditional).
- Steps:
  1. `--service-type` upper-cased: `A2A` → escrow(1), `A2MCP` → x402(3); else Err `unsupported --service-type "{v}"; valid values: A2A, A2MCP`.
  2. `resolve_wallet_and_agent_for_task(job, --agent-id)` → (acct, addr, agent=buyerAgentId of task) [1 task GET].
  3. GET `/priapi/v1/aieco/task/{job}` again (agenticId=agent) → current mode = `paymentMode` (missing → 0 = none).
  4. If current ≠ desired: POST `/priapi/v1/aieco/task/{job}/setPaymentMode` `{"paymentMode":1|3,"sessionCert"?}`; `sign_uop_and_broadcast(resp.uopData, resp.type)` → POST `/priapi/v1/aieco/task/broadcast`; audit `user/set_asp_payment_mode_sync`; print `✓ Payment mode synced on-chain: {from} → {to} (txHash {tx})` (`none|escrow|legacy-x402-disabled`).
  5. POST `/priapi/v1/aieco/task/{job}/set/asp` `{paymentTokenSymbol?, providerAgentId, serviceId, serviceParams, serviceTokenAddress, serviceTokenAmount, serviceType (verbatim flag), sessionCert?}`.
  6. Old designated provider = `ONCHAINOS_HOME/task/{job}/designated-provider.json` `.agentId`; if present and ≠ new: `okx-a2a session delete --job-id J --json --to-agent-id OLD` → print `✓ Old job session deleted (provider {old}).` or stderr `⚠ Old job session delete failed (provider {old}): {e}`.
  7. Write designated-provider.json = pretty `{"agentId": "<provider>"}` (error propagates).
  8. audit `user/set_asp`; print `✓ ASP and service updated (off-chain).` + (` Waiting for job_created event.` unless cli-mode), then `  providerAgentId: {p}`, `  serviceId: {s}`, `  serviceType: {t}`, `  serviceTokenAmount: {a}`.
- Output: plain text lines (no JSON envelope).
- Errors: API/wallet errors exit 1.
- Side effects: state-changing (server) — **FUNDS-class broadcast** when payment mode needs syncing (`/priapi/v1/aieco/task/broadcast`); local file write.
- Nondeterminism: txHash.
- Parity test cases: `agent set-asp 0x… --provider-agent-id 1 --service-id s --service-type FOO --service-params x --service-token-address 0xa --service-token-amount 1` (SAFE: fails before HTTP); `agent set-asp 0x… … --service-type A2A …` (UNSAFE).

### `onchainos agent reset-asp`  (hidden: no)
- Handler: `asp_ops::handle_reset_asp` (asp_ops.rs:854).
- Options: `<JOB_ID>` required; `--agent-id` optional.
- Auth: jwt-required.
- Steps: agent = `--agent-id` or (`resolve_wallet_and_agent_for_task(job, None)`.agent — requires local wallet match, 1 task GET); POST `/priapi/v1/aieco/task/{job}/reset/asp` `{"sessionCert"?}`; audit `user/reset_asp`; print `✓ ASP and service fields cleared (off-chain).`
- Output: plain text. Errors: exit 1. Side effects: state-changing (server). Parity: `agent reset-asp 0x… --agent-id 426` (UNSAFE).

### `onchainos agent user-reject`  (hidden: no)
- Handler: `asp_ops::handle_user_reject` (asp_ops.rs:888).
- Options/Auth/agent resolution: as reset-asp.
- Steps: POST `/priapi/v1/aieco/task/{job}/user/reject` `{"sessionCert"?}`; audit `user/user_reject`; print `✓ Current ASP rejected (off-chain). ASP and service fields cleared.` and `  Backend will trigger job_user_reject notification.`
- Output: plain text. Side effects: state-changing (server). Parity: `agent user-reject 0x… --agent-id 426` (UNSAFE).

### `onchainos agent complete`  (hidden: no)
- Handler: `v2::complete::handle` (v2/complete.rs:10) via user/mod.rs:2012 (wraps result in `output::success`).
- Options: `<JOB_ID>` required.
- Auth: jwt-required + session-key signature.
- Steps:
  1. `resolve_wallet_and_agent_for_task(job, None)` (local user id from get-my-agents; task GET) → (acct, addr, agent=buyerAgentId).
  2. GET task detail (agenticId=agent) → `paymentMode`; ≠1 → return `{"decision":"blocked","nextAction":[{"id":"stop"}],"payload":{"jobId":job},"phase":"deliverable_review","reason":"legacy_a2mcp_flow_removed"}` (exit 0).
  3. `review_gate::check_and_consume(job)`: file `ONCHAINOS_HOME/task/{job}/review-gate` (dir created). `approved` → delete and continue; `pending` → Err (text review_gate.rs:142–148, starts `User has not made a review decision yet (review-gate = pending).`); other → `review-gate state error: '{content}'`; missing → `review-gate file does not exist. In escrow mode you must run the next-action job_submitted review flow first (event=job_submitted in --message). Direct calls to complete are not allowed.`
  4. `task_dual_sign_and_broadcast(job, "pre-complete", "complete", None, …, agent, None)`: POST `/{job}/pre-complete` `{"deadline":now+1800}`; sign (gen-msg-hash, sign-msg); POST `/{job}/complete` `{"signatureData":{"deadline","nonce","signature"}}`; broadcast POST `/priapi/v1/aieco/task/broadcast` with bizContext `{"bizType":<type>,"jobId":job}`.
  5. audit `user/complete_submitted` (`paymentMode=1`, `txHash=`).
  6. Output data `{"decision":"ready","nextAction":[{"id":"stop"}],"payload":{"jobId":job,"txHash":tx},"phase":"deliverable_review","reason":"completion_submitted"}` (tx = broadcast `txHash` or `pending`).
- Errors (exit 1): review-gate messages; `pre-complete request failed: …`; `pre-complete did not return typedData`; `complete request failed: …`; signing/broadcast errors (`broadcast failed: …`).
- Side effects: **FUNDS-MOVING** — `/priapi/v1/aieco/task/{job}/complete` + `/priapi/v1/aieco/task/broadcast` (escrow release to ASP).
- Nondeterminism: deadline (now+1800), signatures, txHash.
- Parity test cases: `agent complete 0x…` without an approved gate (SAFE up to the gate: 2 task GETs then error); with gate (UNSAFE).

### `onchainos agent reject`  (hidden: no)
- Handler: inline in `run_task` (user/mod.rs:2017) — disabled.
- Options: `<JOB_ID>` required; `--reason <R>` **required** (value ignored).
- Auth: none (no HTTP; TaskApiClient still constructed).
- Steps: Err `direct reject is disabled by Refund; run \`onchainos agent refund-prepare {job_id} --reason <user-authored-reason>\` and execute only the returned confirmed action`.
- Output: error envelope exit 1. Side effects: local-only. Parity: `agent reject 0xabc --reason bad` (SAFE); `agent reject 0xabc` (SAFE, clap exit 2).

### `onchainos agent refund-prepare`  (hidden: no)
- Handler: `refund::handle_prepare` (refund.rs:2676).
- Options: `<JOB_ID>` required; `--reason <R>` optional (user-authored).
- Auth: jwt-optional in effect (missing/expired login yields a structured `login_required` decision, exit 0); agent lookup via subprocess.
- Steps:
  1. `job_id.trim()` empty → success data `{"decision":"requires_user_input","nextAction":[{"id":"resolve_refund_target","recommend":true}],"payload":{"schemaVersion":2},"phase":"refund_eligibility","reason":"refund_target_required"}`.
  2. `current_user_agent_id` (§5) → possibly login/identity block (exit 0) or error.
  3. `fetch_snapshot` (task GET, subscription GET when jobType 1, optional get-agents / service-list subprocesses).
  4. Acquire lock (creates `ONCHAINOS_HOME/refund-v2/` and `<hash>.lock`), `reconcile_pending_mutation_locked` (may GET wallet order detail and rewrite/delete the journal); on error, if snapshot already confirmed ⇒ ignore.
  5. `plan(reason)`.
  6. Pending journal (Some) → decision (`refund_reconciliation`, `blocked`, `refund_operation_pending_reconciliation`, `reconcile_actions(job, op)` where op = request-refund if journal op is request-refund else plan.op, payload = `payload(reason, plan)` with `capability.clientOperation=null`, `settlement.state=<journal state>`, `settlement.txHash=null`, `settlement.broadcastReceipt={bizType,bizUniqKey,orderId,orderType,pkgId,txHash}` (journal values), `settlement.retrySafe=false`, `settlement.diagnostic="query_authoritative_state_before_retry"`).
  7. Else decision (plan.phase, plan.decision, plan.reason, `plan_actions`, `payload`).
- Output: `{"ok":true,"data":{"decision","nextAction","payload","phase","reason"}}`.
- Errors: snapshot/journal/lock errors exit 1 (see §5 messages).
- Side effects: read-only server-side; local lock file + journal rewrite/delete.
- Nondeterminism: `display.currentPeriod/requestedAt/resultDeadline` depend on local TZ.
- Parity test cases: `agent refund-prepare 0x<64hex>` (SAFE); `agent refund-prepare 0x<64hex> --reason "not delivered"` (SAFE); `agent refund-prepare ""` (SAFE, target-required decision).

### `onchainos agent refund-execute`  (hidden: no)
- Handler: `refund::handle_execute` (refund.rs:2953).
- Options: `<JOB_ID>` required; `--operation <close-zero|direct-refund|request-refund|cancel-trial-conversion|close-created-subscription>` required (clap ValueEnum; invalid → exit 2); `--refund-context-id <ID>` required; `--reason <R>` optional; `--confirm` bool flag default false.
- Auth: jwt-required + session-key signature.
- Steps:
  1. `current_user_agent_id` (login/identity blocks as in prepare; no empty-job check).
  2. `fetch_snapshot` + `reconcile_without_downgrading_confirmed_settlement` (locked) → pending; `plan(reason)`.
  3. `context_id(reason) != --refund-context-id` → decision (`refund_eligibility`,`blocked`,`refund_context_stale`, `[{id:"prepare_refund",params:{jobId},recommend:true}]`, payload).
  4. `plan.op != --operation` → (`refund_eligibility`,`blocked`,`refund_operation_not_available`, plan_actions, payload).
  5. pending → (`refund_reconciliation`,`blocked`,`refund_operation_pending_reconciliation`, reconcile_actions(job, --operation), pending payload).
  6. `!--confirm` → (`refund_confirmation`,`requires_user_input`,`refund_execution_confirmation_required`, plan_actions, payload). **(Read-only exit point.)**
  7. `resolve_wallet_by_agent_id(user)` failure → audit `user/refund_v2_wallet_preflight_failed`; decision (`refund_execution`,`blocked`,`refund_wallet_preflight_failed`, `[{id:"stop",recommend:true}]`, payload with `capability.clientOperation=null`, `capability.diagnostic=<error Display>`).
  8. Acquire lock (failure → `refund_reconciliation_guard_unavailable`, same shape).
  9. Re-fetch snapshot; `reconcile_pending_mutation_locked` (error ignored only if confirmed); re-plan; context/op mismatch → `refund_context_stale`; pending → `refund_operation_pending_reconciliation`.
  10. Write journal `{schemaVersion 2, journalRevision 3, jobId, userAgentId, snapshotId: context_id(None), operation, state:"unknown", jobType, trialType, periodIndex/Start/End, pkgId..txHash null, accountId, address, chainIndex:"196", bizType null, originalAmount, tokenAddress, tokenSymbol, providerAgentId, serviceId, serviceName, paymentMode, updatedAt: now}`; failure → `refund_reconciliation_guard_unavailable` (diagnostic).
  11. `execute_operation`:
      - close-zero / direct-refund: POST (no retry) `/priapi/v1/aieco/task/{job}/close` `{}` (context `close result is unknown`) → `sign_response(reason None)`.
      - cancel-trial-conversion: POST (no retry) `/priapi/v1/aieco/task/subscribe/{job}/cancel` `{}` (context `trial conversion cancellation result is unknown`) → sign_response.
      - close-created-subscription: same endpoint, context `Created subscription close result is unknown`.
      - request-refund: reason required (`refund reason is required`); subscription → POST (no retry) `/subscribe/{job}/reject` `{}` (context `subscription refund request result is unknown`) → sign_response(reason); one-time → POST (no retry) `/{job}/pre-reject` `{"deadline":now+1800}` (context `pre-reject result is unknown`) → `typedData` (else `pre-reject did not return typedData`), `nonce` non-blank string (else `pre-reject did not return nonce`) → sign typedData → POST (no retry) `/{job}/reject` `{"signatureData":{"deadline","nonce","signature"}}` (context `reject result is unknown`) → sign_response(reason).
      (all bodies get `sessionCert` injected; agenticId = buyer.)
  12. Error: definitive ∨ !mayBeUnknown → delete journal (delete failure → rewrite `unknown`, decision `refund_operation_pending_reconciliation` with `capability.diagnostic="backend rejected the write, but the local reconciliation guard could not be cleared: {e}"`); else decision (`refund_execution`,`blocked`, `refund_write_rejected` if definitive else `refund_prebroadcast_failed`, `[{id:"prepare_refund",params:{jobId},recommend:true}]`, payload with clientOperation null + diagnostic). Unknown → rewrite journal `unknown`, audit `user/refund_v2_outcome_unknown`, decision (`refund_settlement`,`blocked`,`refund_outcome_unknown`, reconcile_actions, pending payload + `settlement.error=<error Display>`).
  13. Success: journal → `broadcast_submitted` with pkgId/orderId/orderType/bizUniqKey/txHash/bizType from receipt; persist failure → audit `user/refund_v2_receipt_persist_failed`, decision (`refund_reconciliation`,`blocked`,`refund_outcome_unknown`, …, broadcastReceipt=receipt, diagnostic).
  14. Local cleanup: close-zero/direct-refund → `negotiate::cleanup(job)` (delete regular files in `ONCHAINOS_HOME/task/{job}/`, remove dir if no `attachments/`); cancel-trial-conversion/close-created-subscription → `okx-a2a user outdated-list` + `okx-a2a user check --todo-ids … --json` (retired autotrade decisions), and close-created-subscription also `negotiate::cleanup`.
  15. audit `user/refund_v2_broadcast_submitted` (`jobId, agentId, operation, reasonLen=<bytes>, txHash=`).
  16. Decision (`refund_settlement`,`ready`, reason by op: `zero_amount_close_broadcast_submitted` | `refund_broadcast_submitted` | `refund_request_broadcast_submitted` | `trial_conversion_cancel_broadcast_submitted` | `created_subscription_close_broadcast_submitted`, `reconcile_actions(job, op)`, payload with `settlement.state="broadcast_submitted"`, `settlement.txHash=null`, `settlement.broadcastReceipt=<receipt incl. bizType>`, and for request-refund `request.providerNotification.{system,email}="unknown"`).
- Output: success envelope with decision object in all handled branches (exit 0); only snapshot/journal-read errors exit 1.
- Side effects: **FUNDS-MOVING** — `/priapi/v1/aieco/task/{job}/close`, `/{job}/reject`, `/subscribe/{job}/cancel`, `/subscribe/{job}/reject`, then `/priapi/v1/aieco/task/broadcast`. Local journal/lock files.
- Nondeterminism: `updatedAt`, deadline, signatures, receipt ids, txHash, local-TZ display strings.
- Parity test cases: `agent refund-execute 0x… --operation direct-refund --refund-context-id refundctx_bogus` (SAFE → `refund_context_stale`); `agent refund-execute 0x… --operation direct-refund --refund-context-id <fresh id>` without `--confirm` (SAFE → confirmation required); same with `--confirm` (UNSAFE).

### `onchainos agent close`  (hidden: no)
- Handler: `close::handle_close` (close.rs:29) — disabled.
- Options: `<JOB_ID>` required; `--agent-id` optional (ignored).
- Auth: none. Steps: Err `direct close is disabled for V2 tasks; run \`onchainos agent refund-prepare {job_id}\` and execute only the returned confirmed action`.
- Output: error envelope exit 1. Side effects: local-only. Parity: `agent close 0xabc` (SAFE).

### `onchainos agent claim-auto-refund`  (hidden: no)
- Handler: `claim_auto_refund::handle_claim_auto_refund` (claim_auto_refund.rs:12) — disabled.
- Options: `<JOB_ID>` required.
- Steps: Err `direct claim-auto-refund is disabled by Refund because timeout refunds are backend-owned; use \`onchainos agent refund-prepare {job_id}\` only to read the authoritative current state. Expired(8) is terminal and confirms any applicable automatic refund`.
- Output: error envelope exit 1. Side effects: local-only. Parity: `agent claim-auto-refund 0xabc` (SAFE).

### `onchainos agent subscribe-cancel`  (hidden: no)
- Handler: `subscription_ops::handle_subscribe_cancel` (subscription_ops.rs:111).
- Options: `<SUB_ID>` required.
- Auth: jwt-required + session-key signature.
- Steps: `ensure_tokens_refreshed()?`; `resolve_user_agent()?`; `select_subscription_agent_id`; `resolve_wallet_by_agent_id`; POST `/priapi/v1/aieco/task/subscribe/{sub}/cancel` `{"sessionCert"?}` (post_with_identity; err `subscribe-cancel failed: {e}`); `sign_uop_and_broadcast(uopData, type)` → broadcast; audit `user/subscribe_cancel` (`subId=`, `txHash=`); print `✓ Subscription cancel in progress (transaction broadcast)`, `  subId:  {sub}`, `  txHash: {tx}`; best-effort `okx-a2a user outdated-list`/`user check` cleanup; if cli-mode print blank line + `content::scoped_watch_handoff(sub)` (user/content.rs:42–52, starts `[Watch] 🛑 Mandatory continuous monitor.`).
- Output: plain text. Errors: exit 1. Side effects: **FUNDS-class broadcast** (`/priapi/v1/aieco/task/broadcast`; trial cancel / auto-renew off). Nondeterminism: txHash.
- Parity: `agent subscribe-cancel 0x…` (UNSAFE).

### `onchainos agent start-autorenew`  (hidden: no)
- Handler: `subscription_ops::handle_start_autorenew` (subscription_ops.rs:167).
- Options: `<SUB_ID>` required.
- Auth: jwt-required + session-key signature.
- Steps: token refresh; resolve user agent; select id; resolve wallet; POST `/subscribe/providerConfirmStatus` `{"autoRenew":1,"sessionCert"?,"subId":sub}` (err `providerConfirmStatus failed: {e}`); null/empty object → `providerConfirmStatus returned empty terms`; `typedData` missing/empty → `providerConfirmStatus response missing typedData`; sign typedData; POST `/subscribe/{sub}/startAutoRenew` `{"sessionCert"?,"terms":<confirm data minus typedData>,"termsSig":sig}` (err `start-autorenew failed: {e}`); broadcast; audit `user/start_autorenew`; print `✓ Auto-renew enable in progress (transaction broadcast)`, `  subId:  {sub}`, `  txHash: {tx}`.
- Output: plain text. Side effects: **FUNDS-MOVING** (authorises recurring charges; `/startAutoRenew` + `/broadcast`). Parity: (UNSAFE).

### `onchainos agent subscribe-reject`  (hidden: no)
- Handler: `subscription_ops::handle_subscribe_reject` (subscription_ops.rs:289) — disabled (called with reason `""`).
- Options: `<SUB_ID>` required; `--reason` **required** (ignored).
- Steps: Err `direct subscribe-reject is disabled by Refund; run \`onchainos agent refund-prepare {sub_id} --reason <user-authored-reason>\` and execute only the returned confirmed action`.
- Output: error envelope exit 1. Side effects: local-only. Parity: `agent subscribe-reject 0xabc --reason x` (SAFE).

### `onchainos agent subscribe-detail`  (hidden: no)
- Handler: `subscription_ops::handle_subscribe_detail` (subscription_ops.rs:302).
- Options: `<SUB_ID>` required; `--format <S>` default `""` (`json` ci ⇒ JSON).
- Auth: jwt-required.
- Steps:
  1. `ensure_tokens_refreshed()?`.
  2. agent = `resolve_agent_id_by_role(1)` or, if empty, `resolve_agent_id_by_role(2)`; `select_subscription_agent_id` (error `agenticId is required for subscription requests`).
  3. GET `/priapi/v1/aieco/task/subscribe/{sub}` (get_with_identity) — err `subscribe-detail failed: {e}`.
  4. `is_buyer` = non-empty agent == `buyerAgentId`; if buyer ∧ `status==1` → `ensure_subscription_session(sub, agent, providerAgentId)`.
  5. JSON mode: display facts — provider id/service id (display_string: trimmed string or integer); `find_service` subprocess when both present (**error propagates**); providerName = first of detail `providerAgentName|aspAgentName|providerName`, else catalog `providerAgentName`, else `fetch_agent_profile(id).name`; tokenSymbol = first of `serviceTokenSymbol|tokenSymbol|paymentTokenSymbol`, else `serviceTokenAddress` → POST `/api/v6/dex/market/token/basic-info` `[{"chainIndex":"196","tokenContractAddress":addr}]` (ApiClient; `data[0].tokenSymbol`; empty → Err `token basic-info returned no symbol for chain=196 address={addr}`; **error propagates**); supportsTrial = detail `supportTrial` bool ?? catalog (`supportTrial` ?? `subscriptionInfo.supportTrial` ?? (positive trial hours exist)) ?? (trialType==1 ⇒ true); trialHours = positive detail `freeTrial` ?? catalog `freeTrial` ?? `subscriptionInfo.freeTrial` (int or numeric string > 0). Then `enrich_subscription_detail(resp, cachedDeviceId, defaultAll=is_buyer, facts)` adds: `statusName`, `statusLabel`, `statusDescription`, `deviceList` (null/[]/list), `categoryCodes` ([] default), `thisDeviceReceives`, `thisDeviceId` (null if unknown), `thisDeviceName`, `autoRenewLabel` (`Enabled`/`Disabled`/`—`), `billingPeriodLabel` (`Trial Period` if trialType 1; `Billing Period {n}` if periodIndex>0; else `—`), `currentPeriodLabel` (first complete pair of (`periodStartTime`,`periodEndTime`) then (`subStartTime`,`subEndTime`), both UTC-formatted, joined by `–`; else null), `offlineMessageHandlingLabel` (1 `Clear`, 0 `Resume delivery when back online`, else `—`), `receiveOnThisDeviceLabel` (`Receive`/`Do not receive`), `providerName`, `serviceProviderLabel` (`{name} ({id})` / `Agent ID {id}` / `{name}` / null), `feeTokenSymbol`, `feeLabel` (zero amount → `Free`; `{amount} {symbol} / month`; else null), `freeTrialLabel` (trialType1: hours = facts.trialHours ?? (trialEnd−trialStart)/3600 when positive; needs first-charge UTC time, `serviceTokenAmount` string and symbol → `"{N-day|N-hour} free trial. The first subscription fee of {amount} {symbol} will be charged at {utc}."` (days when hours%24==0); trialType0 ∧ supportsTrial==true → `You have already used the free trial for this service. The subscription fee is charged directly.`; ∧ ==false → `Free trial is not supported.`; else null), `displayReady` (= non-empty `jobId`), `displayMissingFields` (subset of `Job ID, Job Name, Job Description, Service Provider, Free Trial, Fee, Current Period` in that order, for keys `jobId,title,description,serviceProviderLabel,freeTrialLabel,feeLabel,currentPeriodLabel` whose display_string is empty) → `output::success(enriched)` (all backend fields passthrough + the above; keys sorted).
  6. Text mode: prints `Subscription Detail: {title|"?"}`, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, `  subId:     {jobId|sub}`, `  buyer:     #{buyer|"?"}`, `  provider:  #{provider|"?"}`, `  fee:       {serviceTokenAmount|"?"}/month`, `  period:    {periodIndex u64|0}`, `  autoRenew: {autoRenew|0}`, `  current:   {subStart} ~ {subEnd}` (only if both i64), `  trial:     {start} ~ {end}` (trialType 1; `trialStartTime`→`trailStartTime`→0), `  offline:   {1 (discard) | 0 (keep — default) | n (keep — default) | missing (keep — default)}`, `  devices:   {all (default — deviceList is not explicitly configured) | none (no device receives this subscription) | comma-joined first-8-chars ids with "(this device)" suffix}`.
- Output: JSON envelope or plain text. Side effects: read-only (may create an okx-a2a session + local consent marker). Nondeterminism: device id/name.
- Parity: `agent subscribe-detail 0x… --format json` (SAFE); `agent subscribe-detail 0x…` (SAFE).

### `onchainos agent subscribe-cost`  (hidden: no)
- Handler: `subscription_ops::handle_subscribe_cost` (subscription_ops.rs:433).
- Options: none.
- Auth: jwt-required.
- Steps: token refresh; `resolve_user_agent()?`; select id; GET `/priapi/v1/aieco/task/subscribe/cost/active` (get_with_identity; err `subscribe-cost failed: {e}`); audit `user/subscribe_cost`; `output::success(data)` passthrough (keys re-sorted).
- Side effects: read-only. Parity: `agent subscribe-cost` (SAFE).

### `onchainos agent my-subscriptions`  (hidden: no)
- Handler: `subscription_ops::handle_my_subscriptions` (subscription_ops.rs:1401).
- Options: `--role <buyer|provider>` default `buyer` (ValueEnum lowercase); `--status <S>` optional (`parse_status_filter`).
- Auth: jwt-required.
- Steps: header = `resolve_agent_id("", 1|2)` (get-my-agents subprocess); `fetch_my_subscriptions_snapshot_for_agent` (§6; GET `/priapi/v1/aieco/task/subscribe/my`, filter, enrich, buyer sessions) → `output::success({list, thisDeviceId, thisDeviceName})`.
- Errors: `agenticId is required for subscription requests`; fetch/parse errors.
- Side effects: read-only (may create okx-a2a sessions + consent markers for active buyer rows).
- Parity: `agent my-subscriptions` (SAFE); `agent my-subscriptions --role provider --status ACTIVE` (SAFE); `agent my-subscriptions --status ACTIV` (SAFE, exit 2).

### `onchainos agent subscription-list`  (hidden: no)
- Handler: `subscription_list::handle_subscription_list` (subscription_list.rs:596).
- Options: `--cursor <C>` optional; `--page-size <u32>` default 10, range 1..=100 (clap).
- Auth: jwt-required.
- Steps:
  1. agent = `resolve_agent_id("", 1)`; blank → `output::success({"decision":"blocked","nextAction":[{"id":"register_user_identity","params":{"role":"user"},"recommend":true}],"payload":{},"phase":"identity","reason":"user_identity_required"})`.
  2. Cursor = base64url-no-pad of compact struct-order JSON `{"version":1,"stage":"active"|"ended","page":u32,"offset":usize,"page_size":u32,"active_count":u64,"ended_count":u64}` (derived example for `{ended,2,3,10,11,12}`: `eyJ2ZXJzaW9uIjoxLCJzdGFnZSI6ImVuZGVkIiwicGFnZSI6Miwib2Zmc2V0IjozLCJwYWdlX3NpemUiOjEwLCJhY3RpdmVfY291bnQiOjExLCJlbmRlZF9jb3VudCI6MTJ9`). Decode failure, version≠1, page 0, page_size 0 → Err `invalid subscription cursor`; cursor page_size ≠ `--page-size` → Err `--page-size must match the subscription cursor page size`.
  3. `fetch_page(stage, page, size)`: GET `/priapi/v1/aieco/task/subscribe/my?page={p}&pageSize={s}&statusType={1 active|2 ended}` (get_with_agent_id; err `failed to fetch subscription tasks: {e}`) → `enrich_buyer_subscription_page` → `parse_page` (needs numeric `total`, `page`, `pageSize` and `list` array: errors `subscription page must be a JSON object`, `subscription page is missing numeric total|page|pageSize`, `subscription page is missing list array`); each item gets `listStatus` (`active`/`ended`), `feeLabel:null`, `autoRenewLabel`, `billingPeriodLabel` (same rules as detail), `nextChargeAt`/`nextChargeLabel` (active ∧ autoRenew 1 ∧ status≠0 → UTC(`subEndTime`, 0 ⇒ none); label falls back to `Pending acceptance` when status 0 else `—`), `hasNoReceivingDevices` (deviceList is an empty array); `has_next = page*pageSize < total`.
  4. Initial page (no cursor): active page 1 and ended page 1 fetched **concurrently** (`tokio::try_join!`); items = active (truncated to size); if active.has_next → cursor {active, page+1, 0}; else append ended items up to size, cursor = `next_from_ended` (remaining items → {ended, same page, offset=consumed}; else ended.has_next → {ended, page+1, 0}; else none).
  5. Continuation: fetch cursor stage/page; skip `offset`, truncate; active ∧ has_next → {active, page+1}; active ∧ last page → fetch ended page 1 and append/compute as above; ended → `next_from_ended(page, offset+len)`. Counts carried from the cursor.
  6. Output skeleton `{"decision":"ready","nextAction":[…],"payload":{"items","nextCursor":str|null,"pageSize","summary":{"activeCount","endedCount"}},"phase":"subscription_browsing","reason":"subscription_list_loaded"}`; actions in order: `manage_subscription_devices` (active jobIds non-empty; label `Adjust receiving devices`, recommend true, params `{allowedJobIds:[active]}`), `view_subscription_detail` (any jobIds; `View subscription details`; recommend = no previous action; `{allowedJobIds:[all]}`), `cancel_subscription` (active; `Cancel subscription`; false; active ids), `next_subscription_page` (cursor; `View next page`; recommend = no previous action; `{cursor, pageSize}`); each action `{actionLabel,id,params,recommend}`.
  7. `attach_fee_labels`: per item without inline `serviceTokenSymbol|tokenSymbol|paymentTokenSymbol`, resolve distinct non-blank `serviceTokenAddress` via token basic-info (errors → no symbol); set `feeTokenSymbol`, `feeLabel` (`{serviceTokenAmount} {sym} / month` when both), `feeDisplayReady`; payload `displayReady` (all ready) and `displayMissingFeeJobIds`.
  8. Device snapshot: `device_routing::fetch_device_list_snapshot(agent, 1, 100)` → GET `/priapi/v5/wallet/agentic/agent/device-list?page=N&pageSize=100` until complete (owned by device_routing.rs); failure → `payload.deviceDataAvailable=false`; success → `deviceDataAvailable:true`, `devices` (snapshot `list`: `{deviceId,deviceName,isThisDevice,lastOnlineLocal,lastOnlineTime}`), `deviceColumns:[{key:deviceId,label: name||id + (" (This Device)" if isThisDevice)}]`, per item `deviceReceipts:[{deviceId,deviceName|null,isThisDevice,receives,receivesLabel:"✅"|"❌"}]` and `deviceReceiptCells:{<deviceId>:"✅"|"❌"}` (receives = deviceList null/missing ⇒ all; array ⇒ membership).
  9. `output::success(output)`.
- Side effects: read-only. Nondeterminism: request order of the two initial GETs; device id/name; `lastOnlineLocal` (local TZ).
- Parity: `agent subscription-list` (SAFE); `agent subscription-list --page-size 5` (SAFE); `agent subscription-list --cursor not-a-cursor` (SAFE, error); `agent subscription-list --page-size 0` (SAFE, exit 2).

### `onchainos agent next-action --role user`  (hidden: no; user-role branch only)
- Handler: dispatcher `AgentCommand::NextAction` (agent_commerce/mod.rs:2752–3050, owned elsewhere) → `task::user::flow::generate_next_action(job, event, agent, jobTitle, data, paymentMode, prefetched, message)` (flow.rs:280).
- Options (from dispatcher): `--agentId <ID>` (alias `--agent-id`, required), `--role <user|asp|evaluator|auto>` (required), `--message <JSON>` (required), `--a2a-file <PATH>` (optional; validated and injected as `message.a2aFile`).
- Auth: jwt-required for the events that fetch/mutate; pure-text events need none.
- Dispatcher steps (summary, owned elsewhere): parse `--message` (repair raw control chars inside strings); `event` required (`--message.event is required`); `jobId` required except `reward_claimed`/`create_task`; `validate_job_id` (`0x`+64 chars, `_`, or `system_*`); optional `provider` → write designated-provider.json; non-zero `code` (except `job_expired|submit_expired|job_asp_accept_expire`) → Chinese tx-failure prompt; `--role auto` → agent registry lookup; user `job_created` without local designated provider → task GET to persist `providerAgentId`; user `job_submitted` → `review_gate::mark_pending`, `approve_review` → `review_gate::mark_approved` (errors swallowed); freshness/prefetch via `check_status_freshness` unless `job_completed`/`sub_complete_notify` (buyer refund events use `refund::fetch_authoritative_refund_context` with retries 250/750/1500 ms; stale → prints a blocked message instead of calling the flow); audit `user/next_action_received`; print the returned prompt with `println!`.
- `generate_next_action` steps:
  1. `short_id = short_job_id(job)` (≤12 chars unchanged, else first 6 + `…` + last 4); `title_display = jobTitle ?? "<title>"`; `title_query_hint` = "" when jobTitle given else `"When notifying the user, use the \`<title> ({job})\` format. Fetch the title from context; if you don't remember it, first run \`onchainos agent common context {job} --role user --agent-id {agent}\` to query.\n\n"`; `title_in_extract` = "" or `"title, "`; terminal hint (§9).
  2. `event = parse_status_or_event(event_str)` (event names; otherwise status names `init, created, accepted, submitted, rejected, disputed, admin_stopped|adminstopped, completed|complete, close|closed, expired, failed` → canonical entry event; e.g. `close` → `job_closed`, `completed` → `job_completed`, `failed` → `job_refunded`, `submitted` → `job_submitted`).
  3. Route (table below).
  4. Final prompt = body if raw `event_str` ∈ {job_created, negotiate_reply, provider_applied, job_accepted, deliverable_received, approve_review, reject_review, job_completed, job_expired, job_asp_accept_expire, job_asp_reject_closed, job_asp_reject_expire, job_auto_refunded, submit_expired, reject_expired, close, sub_open, sub_created, sub_asp_selected, sub_cancel, sub_user_reject, sub_asp_agree, sub_asp_dispute, sub_trial_into_active, sub_renew, sub_expire_warn, sub_complete_notify, sub_close_notify, sub_failed_notify, sub_reject_refund_notify, sub_asp_claim_notify} or `create_task`; otherwise `preamble + prefetched.format_inline() + body` where preamble = `"**Core rules:**\n- Rule 1: Follow steps literally; do NOT skip / reorder / batch.\n- Rule 2: CLI error → do NOT retry; push \`cli_failed\` decision.\n- Rule 3: Sub/backup text is invisible to user → use \`user notify\` or \`pending-decisions-v2 request\`.\n- Rule 4: ≥1 tool_use block, ≤2 lines text per response.\n\n"` and format_inline = `"[Pre-fetched task context] (from status-check API — no need to call \`common context\` again unless a field below is missing)\n  title: {title}\n{"  description: {d}\n" if non-empty}  tokenSymbol: {sym} | tokenAmount: {amt} | paymentMode: {escrow (1)|x402 (3)|{v} (unknown)|unknown}\n  maxBudget (paymentMostTokenAmount): {max|"not set"} | providerAgentId: {p|"none"} | buyerAgentId: {u|"none"}\n{"  serviceParams: {sp}\n" if non-empty}{"  deliverable: saved | path: {p} | type: {t} | name: {n}\n" if any}"` (empty when no prefetch).
- Event routing (user role):

| event (parsed) | handler (file:line) | in-process side effects | output |
|---|---|---|---|
| job_created, job_payment_mode_changed, negotiate_reply, job_provider_reject | `flow_negotiate::*` (owned by another group) | see that group | text |
| `designated_a2a` / `designated_error` (Other) | inline flow.rs:392–413 | reads `ONCHAINOS_HOME/task/{job}/designated-provider.json` | no provider → `[Error] designated_* pseudo-event requires \`provider\` field. Call: onchainos agent next-action --role user --agentId {agent} --message '{"event":"{s}","jobId":"{job}","provider":"<ASP agentId>"}'\n`; `designated_a2a` → `flow_negotiate::designated::branch_a2a_cli(job, agent, dp)` or fallback `[Designated ASP route: A2A] Setup done. **End this turn.**\n`; `designated_error` → `flow_negotiate::designated::branch_error(job, agent, short, dp)` (owned elsewhere) |
| provider_applied | `flow_lifecycle::core::provider_applied` (core.rs:1034) | `message.overMostBudget` bool (default **true**): true → `reject_apply::handle_reject_apply(job, agent)` (task GET + POST `/{job}/user/reject`, prints `✓ Reject-apply submitted; task remains in \`created\` state.` / `  agentId: …` to stdout first) then returns `"Push the next-step decision card via \`pending-decisions-v2 request\`, then end turn.\n\n{request_block}\n"` (user_content core.rs:1054–1060, label `[Over budget {short}] next-step decision`, source `apply_over_budget`); failure → `[provider_applied/over_budget] reject-apply failed in-process: {e}\n\nEnter through …recovery.md §2 — push \`cli_failed\` decision.\n`. false → `accept::handle_confirm_accept(job, prefetched)` (**FUNDS**, owned elsewhere) then `okx-a2a task reject --job-id J --content "[user_rejected]:Job {job} is no longer available. It was accepted by another ASP before your request was processed." --json`; returns `**End this turn** and wait for the \`job_accepted\` system notification.` or `[provider_applied/confirm_accept] confirm-accept failed in-process: {e}…` | text |
| job_accepted | `core::job_accepted` (core.rs:1101) | — | paymentMode 3 → `legacy_a2mcp_flow_removed: …`; else template core.rs:1138–1152 (`Amount: Free` when zero decimal) |
| deliverable_received | `core::deliverable_received_cli` (core.rs:1181) | requires `message.a2aFile` (else intake-failed prompt core.rs:1155–1166); parse envelope; file → `okx-a2a file download`; text → private temp file; `deliverables::handle_save`; retire spool (delete or rename `.consumed`); route by prefetched jobType (None ⇒ subscription): subscription → `route_subscription_delivery_to_skill` (subscription/config lookups, `find_service` subprocess, local delivery context; returns signal-only / direct-claim prompts core.rs:316–357, 440–634); one-time → optional backup-session prefetch (`okx-a2a session send --job-id J --content <PREFETCH batch core.rs:1544–1575> --json`) then, if status 2 or review marker, `job_submitted_escrow`, else notify template core.rs:1657–1673 | text |
| job_submitted | `core::job_submitted` → `job_submitted_escrow` (core.rs:1700) | review-card-sent marker → stop text; needs prefetched + providerAgentId; finds deliverable (prefetched file / manifest / spool recovery) else writes review marker and returns waiting text (core.rs:1688–1693); `review_gate::mark_pending`; returns review card playbook core.rs:1882–1912 with `request_command_block(source job_submitted, label "[Decision {short}] {title} acceptance decision")` and optional `⏰ Review deadline…` line (deadline.rs:128) | text |
| approve_review | `core::approve_review` (core.rs:1916) | `v2::complete::handle` (**FUNDS**) | compact JSON of the complete result, or `{"decision":"blocked","nextAction":[{"id":"stop"}],"payload":{"error":e,"jobId"},"phase":"deliverable_review","reason":"completion_failed"}` |
| reject_review | `core::reject_review` (core.rs:1943) | reason = trimmed `data`; unless prefetched proves non-free (never in practice: no prefetch) → `v2::reject::try_handle_free_review` (**FUNDS/state**); Some → its JSON; Err → `{…"reason":"free_rejection_failed","payload":{"error","jobId"}…}`; None → Refund guidance text (core.rs:1976–1979; ` --reason "<json-escaped>"` appended to the refund-prepare command when reason present) | JSON or text |
| job_rejected / job_disputed / dispute_resolved | `dispute.rs:16/21/91` | job_disputed: `okx-a2a session history --job-id J --to-agent-id P --json` (inlined); dispute_resolved: validation chain (dispute.rs:104–162) then verdict playbook (dispute.rs:233–267) using `content::dispute_won/lost_user_notify`, `rating_submitted_user_notify`, `verify_final_refund_event(…,9,…)` | text |
| job_completed | `v2::job_completed::handle` | task GET, task-feedback subprocess | compact JSON |
| job_refunded / job_auto_refunded | `terminal.rs:145/150` | — | `final_refund_notice(expected 9)`: heading `[Refund Settled]` / `[Auto-Refund Settled]` / `[Refund Settlement Detail Incomplete]`, lines `- Refund ASP:`, `- Service:`, `- Refund amount:`, `- Tx Hash:` + status sentence (terminal.rs:109–134); complete → terminal notify, else notify_and_end |
| job_expired / submit_expired | `terminal.rs:217/499` → `expired_terminal_result` | — | cause `A task deadline elapsed` / `The ASP did not submit the deliverable before the deadline`; `[Expired Task Detail Incomplete]` variants (terminal.rs:159–193); trial/zero → `[Job Expired] … The task is complete and no buyer-side refund action is required.` (terminal); paid → final_refund_notice(8) + `\n- Timeout result: {cause}` |
| job_asp_accept_expire | `terminal.rs:221` | — | `[ASP Acceptance Timeout Detail Incomplete]` variants or `content::job_asp_accept_expire_user_notify(...)` terminal |
| job_asp_reject_expire | `terminal.rs:309` | — | free one-time Failed(9) → `[Task Failed] …` (terminal.rs:328–334) terminal; no buyer-owned Failed(9)+provenance → `[Automatic Refund Detail Incomplete] …`; else `content::job_asp_reject_expire_user_notify` terminal |
| job_asp_reject_closed | `terminal.rs:376` | — | `[Job Close Detail Incomplete] …` variants or regular/subscription reject-closed notify (terminal) |
| job_closed (incl. raw `close`/`closed`) | `terminal.rs:461` | — | not buyer-owned Closed(7) → `[Job Close Detail Incomplete] {title} (\`{job}\`): fresh authoritative detail does not prove Closed(7) ownership by the current User Agent. Do not report closure or refund completion; run \`onchainos agent refund-prepare {job}\`.`; zero one-time → `[Job Closed] {title} (\`{job}\`) has been closed. The task price was 0, so no refund was required.` (terminal); else final_refund_notice(7) |
| reject_expired | `terminal.rs:506` | — | notify `content::reject_expired_user_notify(job)` |
| review_deadline_warn | `terminal.rs:513` | — | playbook terminal.rs:530–539 with request block (source `review_deadline_warn`) |
| reward_claimed | `terminal.rs:554` | — | notify `content::reward_claimed_user_notify` |
| wakeup_notify | `terminal.rs:559` | — | playbook terminal.rs:564–585 |
| `create_task` (Other) | `manage::create_task` (manage.rs:5) | — | `message.branch`: `subscription` → manage.rs:166–306, `regular` → manage.rs:309–378, else common manage.rs:17–97 (attachments section depends on cli-mode) |
| `close` (Other) | `terminal::close_task` | — | **unreachable** (raw `close` parses to job_closed) |
| attachment_added | `manage::attachment_added_cli` (manage.rs:452) | `okx-a2a file upload --file-path P --agent-id A --job-id J` + `okx-a2a session send … --to-agent-id <provider>` with the `[intent:attachment]` frame (manage.rs:396–406) | text (manage.rs:465–512) |
| `autotrade_queued_resume` | `core::resume_queued_subscription_delivery` (core.rs:663) | delivery-queue ack, subscription re-validation, config lookups | text (core.rs:684–816) |
| sub_open / sub_created / sub_asp_selected / sub_cancel / sub_user_reject / sub_asp_agree / sub_asp_dispute / sub_trial_into_active / sub_renew / sub_expire_warn / sub_close_notify / sub_failed_notify / sub_reject_refund_notify | `flow_lifecycle/subscription.rs:139…664` | sub_open: `okx-a2a session query/create/send` + attachment forwarding; sub_asp_dispute: `okx-a2a session history`; sub_renew (`renewResult=="fail"` ∧ `tokenSymbol` ∧ `tokenAmount` parses as f64 > 0): `resolve_wallet_by_agent_id(agent)` + subprocess `onchainos portfolio all-balances --address A --chains 196` (symbol match after `₮→T` + uppercase, also `<SYM>0`) → `notify_and_end_with_deposit` when balance < required **or the balance query fails**; job_disputed / sub_asp_dispute need prefetched providerAgentId (else `cli_failed` text); sub_expire_warn: GET `/subscribe/{job}` | notify templates (subscription.rs; `content::sub_*`); terminal context blocks (subscription.rs:109–137) |
| sub_complete_notify | `v2::sub_complete_notify::handle` | task GET, task-feedback subprocess, session cleanup on failure | compact JSON |
| sub_asp_claim_notify | `v2::notification::sub_asp_claim_notify` | — | compact JSON |
| staked, unstake_*, stake_stopped, cooldown_entered, and any other unknown | `terminal::staked_and_unknown` | — | text |
| `user_decision_<source>` | inline flow.rs:533–875 | for `autotrade_*` sources: load persisted delivery context (`consent::load_delivery_context` / pending) | `ud_guard + body + retained_context`: sources `reject_reason_required`, `job_submitted`/`review_deadline_warn`, `cli_failed`, `autotrade_consent`/`autotrade_config_required`, `autotrade_manual_signal`, `autotrade_over_cap`, `autotrade_tool_select` (direct/legacy), `autotrade_cap_adjust`, `autotrade_plugin_install` (direct/legacy), `asp_match_pick`, `not_provider`/`no_asp_found`/`provider_offline`/`over_budget`, `negotiate_over_budget`, `apply_over_budget`/`job_provider_reject` (with `switch_asp_routing` flow.rs:56–129), `set_asp_params`, default. `ud_guard` = `"Execute in place — do NOT forward via \`okx-a2a session send\` (infinite loop) or call \`pending-decisions-v2 resolve/pick/cancel/list\` (user-session-only).\n\n"` |

- Output: plain text (or compact JSON text for v2 handlers), always followed by `\n`; no `{ok}` envelope.
- Errors: dispatcher errors (invalid message JSON, missing event/jobId, invalid jobId) exit 1 JSON; handler-level failures are rendered into the prompt text.
- Side effects: varies — **FUNDS-MOVING** for `approve_review` (`/{job}/complete` + broadcast), `provider_applied` with `overMostBudget:false` (confirm-accept escrow funding), `reject_review` on a free submitted one-time task (`/{job}/reject` + broadcast); state-changing for `provider_applied` over budget (`/{job}/user/reject`); local files (deliverables, spool, markers, review gate) and okx-a2a subprocesses for delivery/attachment/subscription events.
- Nondeterminism: `receivedAtMs`, delivery ids (sha256 of transport identity), temp-file names, review deadline day counts (wall clock + local TZ), txHash.
- Parity test cases: `agent next-action --role user --agentId 864 --message '{"event":"create_task","branch":"regular"}'` (SAFE, pure text); `agent next-action --role user --agentId 864 --message '{"event":"user_decision_cli_failed","jobId":"0x<64hex>","data":"A"}'` (SAFE, freshness skipped as unknown status); `agent next-action --role user --agentId 864 --message '{"event":"sub_asp_claim_notify","jobId":"0x<64hex>"}'` (SAFE, JSON text); `agent next-action --role user --agentId 864 --message '{"event":"approve_review","jobId":"0x<64hex>"}'` (UNSAFE).

---

## HTTP endpoint inventory (this partition's direct calls)

| class | method + path | used by |
|---|---|---|
| read | GET `/priapi/v1/aieco/task/{jobId}` | refund-prepare/execute, set-asp, reset-asp, user-reject, complete, next-action (free reject, job_completed, sub_complete_notify) |
| read | GET `/priapi/v1/aieco/task/subscribe/{jobId}` | refund-prepare/execute (jobType 1), subscribe-detail, next-action sub_expire_warn |
| read | GET `/priapi/v1/aieco/task/subscribe/my` (and `?page=&pageSize=&statusType=`) | my-subscriptions, task-service-select, subscription-list |
| read | GET `/priapi/v1/aieco/task/subscribe/cost/active` | subscribe-cost |
| read | POST `/priapi/v1/aieco/task/asp/match` | asp-match |
| read | POST `/priapi/v1/aieco/task/subscribe/providerConfirmStatus` | start-autorenew, create-subscribe helper |
| state | POST `/priapi/v1/aieco/task/{jobId}/setPaymentMode` | set-asp |
| state | POST `/priapi/v1/aieco/task/{jobId}/set/asp` | set-asp |
| state | POST `/priapi/v1/aieco/task/{jobId}/reset/asp` | reset-asp |
| state | POST `/priapi/v1/aieco/task/{jobId}/user/reject` | user-reject, next-action provider_applied |
| state | POST `/priapi/v1/aieco/task/{jobId}/pre-complete` | complete |
| funds | POST `/priapi/v1/aieco/task/{jobId}/complete` | complete, next-action approve_review |
| state | POST `/priapi/v1/aieco/task/{jobId}/pre-reject` | refund-execute (one-time request-refund), next-action free reject |
| funds | POST `/priapi/v1/aieco/task/{jobId}/reject` | refund-execute, next-action free reject |
| funds | POST `/priapi/v1/aieco/task/{jobId}/close` | refund-execute close-zero/direct-refund |
| funds | POST `/priapi/v1/aieco/task/subscribe/{jobId}/cancel` | refund-execute, subscribe-cancel |
| funds | POST `/priapi/v1/aieco/task/subscribe/{jobId}/reject` | refund-execute (subscription request-refund) |
| funds | POST `/priapi/v1/aieco/task/subscribe/{subId}/startAutoRenew` | start-autorenew |
| state | POST `/priapi/v1/aieco/task/createAndFundConfirmStatus` | v2 create-and-fund helper |
| funds | POST `/priapi/v1/aieco/task/createAndFund` | v2 create-and-fund helper |
| funds | POST `/priapi/v1/aieco/task/subscribe/createSubscription` | v2 create-subscription helper |
| funds | POST `/priapi/v1/aieco/task/broadcast` | every signed lifecycle write |
| read | GET `/priapi/v5/wallet/agentic/order/detail` | refund reconciliation |
| read | POST `/priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` | EIP-712 signing (wallet group) |
| funds | POST `/priapi/v5/wallet/agentic/pre-transaction/sign-msg` | EIP-712 signing (wallet group) |
| read | GET `/priapi/v5/wallet/agentic/agent/device-list` | subscription-list |
| read | POST `/api/v6/dex/market/token/basic-info` | subscription-list, subscribe-detail --format json |
| auth | POST `/priapi/v5/wallet/agentic/auth/refresh` | ensure_tokens_refreshed (core) |

Self-exec subprocesses (their HTTP is owned by other groups): `agent get-my-agents`, `agent get-agents`,
`agent service-list`, `agent service-match`, `agent task-feedback`, `portfolio all-balances`.
External local CLI: `okx-a2a` (`session create|send|delete|history|query`, `file upload|download`,
`task reject`, `user outdated-list|check`).

## Open questions / anomalies

1. `flow.rs` test `reject_without_reason_opens_refund_confirmation` asserts the substring
   `Never replace it with only a reason question`, but the source emits
   `Never replace a paid Refund confirmation with only a reason question.` — the upstream test suite
   appears inconsistent at this commit; the source text is what ships.
2. `Event::Other("close")` → `close_task` is unreachable (raw `close` parses to `job_closed`).
3. `v2::reject::handle`, `validate_rejection_reason`, `subscription_ops::handle_subscribe_reject_inner`,
   `flow_lifecycle::subscription::build_auto_rating_block`, `user::flow::available_actions` and the
   `job_asp_*` functions in `user/v2/notification.rs` have no callers.
4. `reject_review` always calls `try_handle_free_review` because the dispatcher never prefetches for it.
5. `providerConfirmStatus` / `createAndFundConfirmStatus` side-effects (whether they reserve server state) are not provable from the client source; classified read/state respectively.
6. `set-asp`/`reset-asp`/`user-reject` use the task's `buyerAgentId` (not `--agent-id`) as `agenticId` after wallet resolution (set-asp), but `--agent-id` directly for reset/user-reject — the asymmetry is upstream behaviour.
