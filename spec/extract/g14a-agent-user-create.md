# g14a-agent-user-create — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: user-side (buyer) task commands whose handlers live under
`cli/src/commands/agent_commerce/task/user/` in the files of this partition:
one-time task creation (`create-task`), subscription creation (`create-subscribe`),
creation pre-checks (`service-detail`, `task-create-prepare`), provider clarification
(`service-param-update`), negotiation state (`mark-failed`), device routing
(`device-list`, `subscribe-device-update`), offline-receive flag
(`subscribe-offline-update`), subscription execution preference
(`subscription-execution-config-set`), acceptance/payment (`set-payment-mode`,
`confirm-accept`), `reject-apply`, `reject` (disabled stub), `task-visibility-update`,
`my-tasks`, `payment`, attachments (`task-attach`, `list-attachments`), plus the shared
helpers owned by these files (post-login device routing used by `wallet login`,
negotiate/playbook generators used by `next-action`, the `content.rs` template library).

All command paths are `onchainos agent <name>` (clap enum `AgentCommand` in
`commands/agent_commerce/mod.rs`, which re-packs the args into the internal
`task::user::TaskCommand` enum and calls `task::user::run_task`). `TaskCommand` itself is
never exposed as a CLI surface (some of its variants use positional args that the
public `AgentCommand` exposes as flags — the public `AgentCommand` definition is the
authoritative one). **No command in this partition is hidden** (`hide = true` is not set
on any of them).

---

## Sources read

Partition files (all read fully; line counts from `wc -l`):

| File | Lines |
|---|---|
| commands/agent_commerce/task/user/mod.rs | 2693 |
| commands/agent_commerce/task/user/create.rs | 592 |
| commands/agent_commerce/task/user/create_subscribe.rs | 945 |
| commands/agent_commerce/task/user/task_create_prepare.rs | 585 |
| commands/agent_commerce/task/user/service_detail.rs | 51 |
| commands/agent_commerce/task/user/service_param_update.rs | 291 |
| commands/agent_commerce/task/user/negotiate.rs | 291 |
| commands/agent_commerce/task/user/flow_negotiate/mod.rs | 8 |
| commands/agent_commerce/task/user/flow_negotiate/designated.rs | 117 |
| commands/agent_commerce/task/user/flow_negotiate/events.rs | 172 |
| commands/agent_commerce/task/user/flow_negotiate/match_provider.rs | 103 |
| commands/agent_commerce/task/user/device_routing.rs | 1166 |
| commands/agent_commerce/task/user/offline_receive.rs | 209 |
| commands/agent_commerce/task/user/accept.rs | 515 |
| commands/agent_commerce/task/user/reject_apply.rs | 50 |
| commands/agent_commerce/task/user/visibility.rs | 95 |
| commands/agent_commerce/task/user/my_tasks.rs | 560 |
| commands/agent_commerce/task/user/query.rs | 41 |
| commands/agent_commerce/task/user/attachments.rs | 218 |
| commands/agent_commerce/task/user/content.rs | 1876 |

Supporting files read (partially, only to trace calls out of the partition; behaviour
owned elsewhere is summarised in one line where referenced):
`commands/agent_commerce/mod.rs` (AgentCommand defs L16-1401, dispatch L1403-1960),
`task/common/network/task_api_client.rs` (full), `wallet_api.rs` (L100-126, L700-1340,
L1429-1441), `client.rs` (L300-411), `output.rs` (full), `main.rs` (L180-316),
`task/signing.rs` (full), `task/user/v2/mod.rs`, `v2/create_and_fund.rs` (full),
`v2/create_subscription.rs` (full), `task/common/mod.rs` (L369-445, L500-935),
`task/common/util.rs` (L33-51, L85-521), `task/common/query.rs` (L1-60, L350-420),
`task/common/subscription_identity.rs`, `task/common/payment_mode.rs`,
`task/common/state_machine.rs` (Status / SubStatus), `task/user/subscription_ops.rs`
(L395-760, L1013-1345), `task/user/asp_ops.rs` (L1-340), `task/common/autotrade/subscription_config.rs`
(full), `autotrade/guide.rs` (L1-300, L390-507), `autotrade/grants.rs` (job_id_is_safe),
`autotrade/tooling.rs` (detect), `autotrade/profile.rs` (save_from_description),
`funding.rs` (L60-320), `task/common/deposit_qr.rs` (L88-133, L266-282),
`task/common/funding_notice.rs` (funding_blocked_envelope), `task/common/okx_a2a.rs`
(L247-347, session helpers), `task/common/lifecycle.rs` (display builders),
`task/common/pending_v2.rs` (request_command_block), `task/common/config.rs` (is_cli_mode),
`task/user/refund.rs` (validate_decimal / is_zero_decimal), `home.rs`, `audit.rs`,
`device/id.rs`, `device/name.rs`, `endpoints.rs`, `payment/a2a_pay.rs` (sign_escrow),
`agentic_wallet/sign.rs` (eip712_sign_raw), `agentic_wallet/transfer/mod.rs`
(build_broadcast_body), `agentic_wallet/auth/mod.rs` (ensure_tokens_refreshed, post-login
hooks), `doh/manager.rs`, `cli/Cargo.toml` + `Cargo.lock` (serde_json features).

---

## Shared helpers (used across groups or from core)

### 0. Cross-cutting output / serialization rules (critical for byte parity)

* **JSON object key order is alphabetical.** `serde_json` is compiled WITHOUT the
  `preserve_order` feature (Cargo.lock: `serde_json 1.0.149` depends only on
  `itoa, memchr, serde, serde_core, zmij` — no `indexmap`). Every `serde_json::Value`
  object is a `BTreeMap`, so every `json!{...}` literal, every `serde_json::to_value(struct)`
  and every backend passthrough value is serialized with keys sorted by byte order.
  This applies to **stdout `data` payloads AND to HTTP request bodies** built with
  `json!` (reqwest `.json(&Value)`). Only typed structs serialized *directly*
  (the envelope `JsonOutput{ok,data,error,notifications}`, `ConfirmingOutput`, and
  files written with `to_string_pretty(&struct)`) keep declaration order.
  All `data` shapes in this document are written in the emitted (sorted) order.
* `crate::output::success(data)` (output.rs:44) prints one line
  `{"ok":true,"data":<data>}` (+ `"notifications":[...]` only when
  `payment_notify::drain_events()` is non-empty — never for commands here). Compact by
  default; `ONCHAINOS_PRETTY=1` switches to `serde_json::to_string_pretty` (2-space indent).
* `crate::output::confirming(message, next)` (output.rs:244) prints
  `{"confirming":true,"message":"…","next":"…"}` (typed struct; `scene` omitted when None).
  When called directly by a handler (set-payment-mode) the process still **exits 0**.
* Error mapping in `main.rs:248-316` (after every command):
  * `CliConfirming` → `confirming_scene` print, exit 2 (not produced in this partition).
  * `CliFundingBlocked{data}` → `output::error_data` → `{"ok":false,"data":<data>}`, exit 1.
  * `CliDuplicateSubscription{data}` → `{"ok":false,"data":<data>}`, exit 1.
  * `commands::sink::CodedError` → `output::error_coded_details` →
    `{"error":msg,"errorCode":code,["errorField":f],["data":d],["nextSteps":n],"ok":false}`
    (a `json!` Value, so keys are **sorted**: `error, errorCode, nextSteps, ok`), exit 1.
  * `InsufficientBalanceError` (uncaught) → `error_insufficient_balance`, exit 1.
  * anything else → `{"ok":false,"error":"<format!(\"{e:#}\")>"}`, exit 1. `{e:#}` is the
    anyhow alternate form: every context layer joined with `": "`
    (e.g. `createAndFundConfirmStatus failed: Wallet API error (code=51000): msg`).
  * Where a handler uses `anyhow!("…: {e}")` (Display, not `{e:#}`), only the
    **outermost** message of `e` is embedded.
* clap parse errors (missing required flag, bad enum/range) print clap usage to stderr
  and exit 2 (standard clap behaviour).
* Backend envelope errors surface as `ApiCodeError` Display:
  `Wallet API error (code={code}): {msg}` (code 50114 msg gets suffix
  `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.`).
  HTTP ≥500 → `Wallet API server error (HTTP {status}): {raw body}`; non-JSON body →
  `failed to parse wallet API response as JSON (HTTP {status}): {first 500 chars}`.
* Rust `f64` `Display` never uses exponent notation (`1e-7` → `0.0000001`, `10.0` → `10`);
  a Node port must reproduce this wherever an f64 is formatted into a string
  (InsufficientBalanceError fields, validate_draft_fields messages).
* Before every `agent …` command, `agent_commerce::run` (mod.rs:1409-1418) runs
  best-effort local maintenance: `autotrade::executor::reconcile_terminal_journals(4,100ms)`,
  `executor::flush_all_due(1)`, `executor::cleanup_expired_tickets(8)`,
  `autotrade::delivery_queue::flush_due(1,100ms)`; errors ignored (owned by the autotrade
  executor group). `main.rs:191` forces `--chain xlayer` for every agent command (the
  global `--chain` flag is accepted but ignored).

### 1. HTTP transport and the auth mechanism

`struct TaskApiClient` (task/common/network/task_api_client.rs) — all task API calls.
`TaskApiClient::new()` builds a `WalletApiClient` (DoH-aware, 30 s timeout,
base URL = `endpoints::base_url()`: compiled `ONCHAINOS_COMPILED_BASE_URL`, production
`https://web3.okx.com`; `--dev` → `https://beta.okex.org`). Methods take a **path**;
URL = `base_url + path`. All return the unwrapped `body.data` of `{code,msg,data}`
(`code` `"0"` or `0` = success; anything else → `ApiCodeError`).

Headers on every authed call (`ApiClient::jwt_headers`, client.rs:377):
`Content-Type: application/json`, `ok-client-version: <CLIENT_VERSION>`,
`Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id: <cached device id>`
(if available), `device-name: <OS device name>`, `Authorization: Bearer <accessToken>`,
plus the extra identity header **`agenticId: <agentId>`** (inserted even when the value is
the empty string).

| fn | Method / extras | Retry behaviour |
|---|---|---|
| `get_with_agent_id(path, agent_id)` (L152) | GET, JWT + `agenticId`, **no** sessionCert | DoH failover retry once; on `10008` force-refresh JWT + retry once |
| `get_with_identity(path, agent_id)` (L182) | GET, JWT + `agenticId`, appends query `?sessionCert=<url-encoded cert>` when the local session has a non-empty `session_cert` (query built by `build_query_string`; empty values dropped) | same as above |
| `post_with_identity(path, body, agent_id)` (L323) | POST JSON; if body is an object without `sessionCert`, inserts `"sessionCert": <cert>` (only when cert non-empty) | DoH failover retry + 10008 refresh retry |
| `post_mutation_with_identity(path, body, agent_id)` (L361) | POST JSON with sessionCert injection | **no retry**; connect/timeout → error context `Network result is unknown for this state-changing request. Query authoritative state before retrying.` |
| `raw_post_with_identity(path, bytes, content_type, agent_id)` (L402) | POST raw bytes, explicit `Content-Type` + `Content-Length`, JWT + `agenticId`; **no sessionCert injection** | no DoH/10008 retry |
| `task_path(job)` | `/priapi/v1/aieco/task/{job}` | — |
| `endpoint(job, action)` | `/priapi/v1/aieco/task/{job}/{action}` | — |
| `broadcast_path()` | `/priapi/v1/aieco/task/broadcast` | — |

Every call first runs `get_access_token()` = `ensure_tokens_refreshed()`
(`agentic_wallet/auth/mod.rs:132`, auth group): reads session (session_key expiry),
keychain tokens; bails `session expired, please login again: onchainos wallet login` when
the session key/tokens are missing/expired (refresh-token expiry also prints
`Session expired. Please log in again: onchainos wallet login` to stderr); when the access
token is expiring calls `POST /priapi/v5/wallet/agentic/auth/refresh` `{"refreshToken":…}`
(anonymous headers) and stores the new tokens. Each request is logged to
`<ONCHAINOS_HOME>/audit.jsonl` as command `api/get|post|post_mutation|post_raw` with args
`path=…`, `agentId=…` (audit group).

**Identity model** used by all commands here:
1. JWT (Bearer) identifies the logged-in wallet user.
2. `agenticId` header selects which of the user's agent identities acts (user role = 1).
3. `sessionCert` (from `wallet login`, stored in session.json) is injected into POST bodies
   / GET query for task endpoints that need proof of the session.
4. On-chain writes are signed locally with the session key (ed25519 over the backend's
   uop/"extraData", `agentic_wallet::transfer::build_broadcast_body`) or via the TEE
   signing endpoints `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` +
   `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` (EIP-712 / EIP-3009).

### 2. Identity resolution helpers

* `fn user::create::resolve_user_agent()` (create.rs:236) → `(agentId, ownerAddress)`.
  Calls `common::fetch_my_agents_by_role_strict("user")` → `raw_query_my_agents(Some("user"))`
  (common/mod.rs:400): requires `current_account_xlayer_address()` (local wallets.json,
  active account's chainIndex `196` address, lowercased; else error
  `no current XLayer address`), then **spawns a child process**
  `<current_exe> agent get-my-agents --owner-address <addr> --role user --page-size 100`
  and parses its stdout JSON; `ok!=true` → `` `get-my-agents` returned failure: {error} ``;
  unparsable → `` parse `get-my-agents` stdout failed: {e}; raw={stdout} ``; data flattened by
  `flatten_agent_groups`. Picks the first entry with `role == 1`; none →
  `` the current account has no user identity; run `onchainos agent create --role user` first ``;
  missing agentId → `agent is missing the agentId field`.
* `fn common::query::resolve_agent_id(agent_id, role)` (query.rs:22): returns `agent_id` if
  non-empty, else first agent of that role from `fetch_my_agents()` (= child process
  `agent get-my-agents --owner-address <addr> --page-size 100`, **no** `--role`; any failure
  → empty list) or `""`.
* `fn signing::resolve_wallet_and_agent_for_task(client, job_id, explicit)` (signing.rs:88):
  local id = explicit or first role-1 agent via `fetch_my_agents()` (or `""`);
  `GET /priapi/v1/aieco/task/{jobId}` via `get_with_identity`; requires string
  `buyerAgentAddress` (`task detail missing buyerAgentAddress field`); returns
  `(accountId, address)` from `resolve_wallet(None, Some(buyerAgentAddress))` (local
  wallets.json; `not logged in; run \`onchainos wallet auth\` first` when absent) and
  `buyerAgentId` (or `""`) — **the returned agentId is always the task's buyerAgentId, not
  the explicit one**.
* `fn signing::resolve_wallet_by_agent_id(agent_id)` (signing.rs:58): child process
  `<exe> agent get-agents --agent-ids <id>`, finds `agentWalletAddress`; missing →
  `` cannot resolve wallet for agentId={id}; agentWalletAddress not found in `onchainos agent get-agents` ``;
  then local `resolve_wallet`.
* `fn common::subscription_identity::select_subscription_agent_id(user, asp)`: first
  non-blank (trimmed) → `Ok`, else `agenticId is required for subscription requests`.
* `fn user::resolve_post_login_agentic_id()` (mod.rs:1655) = `resolve_user_agent().0`.

### 3. Balance / funding helpers (owned by core/funding groups — summary)

* `common::util::ensure_sufficient_balance(required: f64, currency)` (util.rs:129): child
  process `<exe> wallet balance --chain 196`; scans `data.details[*].tokenAssets|assets[*]`
  for `tokenSymbol|symbol` equal (after `₮→T` + uppercase) to currency or currency+`0`;
  balance `< required` → `InsufficientBalanceError` (fields `required/available/shortfall`
  are `format!("{f64}")`), not found → InsufficientBalanceError with available 0;
  child failure → `balance query failed (exit …), please check login status`.
* `deposit_qr::resolve_current_deposit_info(agent_id)` → `resolve_wallet_by_agent_id` →
  `DepositInfo{address, deposit_chain:"XLayer", chain_index:"196"}` or None.
* `funding::build_funding_bundle_for_address("", chainIndex, address, FundingBlockedInput{asset, token_address, required, balance, operation:"task_creation"})`
  → `{"decision":"blocked","nextAction":[],"payload":{"fundingNeed":{"asset","balance","required","shortfall"?,"tokenAddress"},"fundingTarget":{…accountName:""…},"operation":"task_creation","qr":{…}},"phase":"funding_required","reason":"insufficient_balance"}`
  (validation errors: `funding required amount must be greater than zero`,
  `funding bundle requires an actual balance shortfall`, …).
* `user::create::build_task_creation_funding_result(insufficient, deposit, token_address)`
  (create.rs:405) = the call above with `asset=insufficient.currency`,
  `required=insufficient.required`, `balance=insufficient.available`.
* `accept::print_payment_funding_block_from_error(err, agent_id, action)` (accept.rs:495):
  if `err` is InsufficientBalanceError → `deposit_qr::balance_warning_json` (may render a QR
  to **stderr** when stderr is a TTY) → returns `Err(CliFundingBlocked{data:
  funding_notice::funding_blocked_envelope(warning, "task-payment", action)})` → stdout
  `{"ok":false,"data":{"balanceWarning":…,"blocked":true,"blockedReason":"insufficient-balance","finalResponsePolicy":…,"forbidFundingSummary":true,"fundingDisplayMode":…,"fundingNoticeCommand":…,"guidance":"{action} was blocked by insufficient balance. …","mustRenderMarkdownImageBelowFirstOption":…,"mustRepeatInFinalResponse":true,"mustRunFundingNotice":…,"mustRunNotifyCommand":…,"platformPolicy":…,"resumeAction":…,"submitted":false}}`, exit 1.
  Other errors are returned unchanged.

### 4. Sign-and-broadcast helpers (signing.rs — summary)

* `sign_uop_and_broadcast_full(client, uopData, accountId, address, jobId, bizType, agentId, extra)`:
  `uopData` null → `backend did not return uopData; cannot sign and broadcast`;
  `uopData.executeResult == false` → `backend transaction preflight failed: {executeErrorMsg|"no error detail returned"}`;
  body = `build_broadcast_body` → `{"accountId","address","chainIndex":"196","extraData":<locally signed>}`
  plus `"bizContext":{"bizType":<i64>,"jobId":…,…extra}`; `POST /priapi/v1/aieco/task/broadcast`
  via `post_mutation_with_identity` (sessionCert injected), error context `broadcast failed`;
  returns `data[0]` (`{bizUniqKey, orderId, orderType, pkgId, txHash}` passthrough) or null.
* `sign_uop_and_broadcast(...)` → `data[0].txHash` or `"pending"`.
* `sign_uop_and_broadcast_with_payment(..., paymentVerify)` → same but
  `bizContext = {"bizType","jobId","paymentVerify":…}`; errors `broadcast failed: {e}`.
* `extract_biz_type(resp)` = `resp.type` as i64 or 0.
* `sign_typed_data(typedData, address)` → `agentic_wallet::sign::eip712_sign_raw` (gen-msg-hash
  + local ed25519 + sign-msg) → hex signature.
* `payment::a2a_pay::sign_escrow(SignEscrowParams)` (payment group): validates EVM addresses,
  `validAfter = 0`, `validBefore = unix(expired_at RFC3339)`, nonce =
  keccak of the escrow fields, TEE signs EIP-3009 `ReceiveWithAuthorization`; returns
  `{signature, authorization{from,to,value,validAfter,validBefore,nonce}}` (strings).

### 5. `fn user::attachments::*` (attachments.rs)

* `validate_attachment_sources(&[String])` (L14): for each path: `std::fs::metadata` error →
  `attachment file is not readable: {src}: {io error}`; not a regular file →
  `attachment path is not a regular file: {src}`; size > 104857600 →
  `attachment file too large: {src} ({size_mb:.1} MB, max 100 MB). Please compress or resize the file.`;
  no file name → `invalid attachment file path: {src}`.
* `attachments_dir(job_id)` (L36): `validate_job_id_path_component(job_id)` (util.rs:433;
  rejects empty, >256 bytes, `/` or `\`, `.`/`..`, control chars, non-single component →
  `CodedError{code:"UNSAFE_JOB_PATH_COMPONENT", message:"jobId is not a safe path component"}`)
  then `<ONCHAINOS_HOME>/task/{jobId}/attachments`. `ONCHAINOS_HOME` env (non-empty) else
  `~/.onchainos`.
* `dedup_dest(dir, name)` (L42): `dir/name` if free, else `{stem}_{i}{.ext}` for i=2..=999
  (Path::file_stem / extension semantics: `a.tar.gz` → stem `a.tar`, ext `.gz`; `.bashrc` →
  stem `.bashrc`, no ext; stem fallback `file`), else `{stem}_{%Y%m%d%H%M%S local}{ext}`.
* `list_attachment_paths(job_id)` (L127): invalid job id or missing dir → `[]`; else all
  regular files (non-recursive) as `path.display()` strings, sorted lexicographically.
* `copy_attachments_to_job_with_manifest(job_id, sources)` (L158): validates sources; empty →
  `[]`; creates dir; copies each with `dedup_dest`; manifest entries (sorted keys)
  `{"fileName":<lossy name>,"size":<u64 bytes>,"sourcePath":<as given>,"storedPath":<dest>}`.
  `copy_attachments_to_job` = same, result discarded.

### 6. `mod user::negotiate` (negotiate.rs) — local negotiation state

State dir `<ONCHAINOS_HOME>/task/{jobId}/` (`home::task_state_dir`; **no job-id sanitisation**).
* `negotiate-state.json` — `serde_json::to_string_pretty(NegotiateState)` (declaration order):
  `{"jobId","providers":[ProviderInfo…],"currentIndex","createdAt":<Utc::now().to_rfc3339()>,"page","failedProviders"?}`
  (`failedProviders` omitted when empty). `ProviderInfo` =
  `{providerAddress, providerAgentId, providerName(default ""), matchScore:f64, creditScore:i64, capabilitySummary, completedTaskCount:i64, services:[ServiceInfo]}`;
  `ServiceInfo` = `{serviceId, serviceName, serviceDescription(default ""), serviceType, sortOrder(default 0), feeAmount:Option<f64> (null when absent), feeTokenSymbol(default ""), feeToken(default "")}`.
* `save(job, providers, page)` — writes state with `currentIndex 0`, preserving existing
  `failedProviders`. `load(job)` — missing file →
  `` Negotiation state not found; run `onchainos agent asp-match --job-id {job_id}` first ``.
  `current(job)` / `next(job)` (increments `currentIndex` and rewrites). `load_failed(job)`.
* `designated-provider.json` — pretty `{"agentId": "<id>"}`. `save_designated_provider`
  (written by `next-action` / `set-asp`, other groups), `has_designated_provider`,
  `get_designated_provider` (empty string → None), `clear_designated_provider`.
* `mark_failed(job, provider)` — see command `agent mark-failed`.
* `cleanup(job)` — deletes every regular file directly in the task dir; removes the dir only
  if no `attachments/` sub-dir exists (ignores error). Called after `confirm-accept`
  success and by refund flows.

### 7. Device-routing helpers (device_routing.rs) — used by `wallet login`

* Constants: `DEVICE_LIST_PATH = /priapi/v5/wallet/agentic/agent/device-list`,
  `MAX_UPDATE_ITEMS = 100`, `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGES = 10000`,
  marker dir `subscription-device-routing-pending`, marker version `2`.
* `fetch_all_devices(client, agent_id, page, page_size)` (L325): `select_subscription_agent_id`;
  normalise `page<1→1`, `page_size<1→20` (>100 passed through; backend errors `81001`);
  loop `GET {DEVICE_LIST_PATH}?page={cur}&pageSize={size}` via `get_with_agent_id`
  (no sessionCert). `data` may be an object, a 1-element array (first element used), `[]`
  or null (→ empty page). Accumulate `list`; stop when `got==0 || got<size ||
  (total>0 && acc>=total) || cur-start>=10000`; `total = max(lastPageTotal, acc.len)`.
  Parse error → `failed to parse device page: {e}`.
* `fetch_device_list_snapshot(client, agent_id, page, page_size)` (L366) → Value
  (sorted keys): `{"list":[{"deviceId","deviceName","isThisDevice","lastOnlineLocal","lastOnlineTime"}],"page":<normalised>,"pageSize":<normalised>,"thisDeviceId":<cached device id|null>,"total"}`.
  `lastOnlineLocal = fmt_unix_millis(lastOnlineTime)`: `0 → "0"`; else
  `chrono::Local` `"%Y-%m-%d %H:%M:%S %Z"` (with chrono `Local`, `%Z` renders the numeric
  offset, e.g. `+08:00`); unrepresentable → `"{ms} (unparseable)"`.
  `isThisDevice = (deviceId == get_cached_device_id())`.
* Routing marker file: `<ONCHAINOS_HOME>/subscription-device-routing-pending/<hex>.pending`,
  `hex = sha256(scope ‖ 0x00 ‖ agentId ‖ 0x00 ‖ deviceId)` lowercase, where
  `scope = normalize_routing_scope(base_url)` (parse URL; must be http/https with host else
  `device-routing state requires an HTTP(S) API origin`; drop query/fragment; trim trailing
  `/` from path and from the final string → e.g. `https://web3.okx.com`). Content (compact,
  declaration order) `{"version":2,"phase":"detected"|"routing"|"completed","remainingJobIds":[…]}`,
  written via `home::atomic_write(path, bytes, sensitive=true)` (`<name>.tmp` + rename,
  dir 0700). Reading a different `version` → `unsupported device-routing state version …`.
  Helpers: `new_device_routing_is_pending` (phase detected|routing),
  `mark_new_device_routing_pending` (detected), `mark_new_device_routing_completed`,
  `clear_new_device_routing_state` (delete).
* `plan_new_device_updates(subscriptions, device_id)` (L498): for each row of
  `subscriptions.list` whose `deviceList` is a non-null array not containing `device_id`:
  item `{jobId, deviceList: existing ++ [device_id]}`. Rows with missing/null `deviceList`
  (default-all) are skipped. Errors: `cannot enable subscription delivery for an empty device id`,
  `subscription snapshot is missing its list`,
  `subscription snapshot contains a malformed deviceList`,
  `subscription requiring a device update is missing its jobId`,
  `subscription snapshot contains a non-string device id`.
* `add_new_device_to_all_subscriptions(client, base_url, agent_id, subs, device_id)` (L655):
  plan; marker must exist (`new-device routing state is missing`); select by phase
  (detected → all planned; routing → planned ∩ remainingJobIds; completed → error
  `new-device routing is already completed; refusing to rewrite subscriptions`); write marker
  (routing or completed if nothing left); for each chunk of ≤100: `post_update_items`, then
  rewrite marker with the remaining ids; finally `reflect_new_device_in_snapshot` (append the
  device to confirmed rows, set `thisDeviceReceives` on every row: null/missing → true,
  array → membership).
* `post_update_items(client, agent_id, items)` (L605): see `subscribe-device-update`.

### 8. Post-login subscription hooks (mod.rs) — called by `wallet login` (auth group)

* `prepare_post_login_subscriptions(agentic_id)` (mod.rs:1687) → `Option<Prep>` (any
  failure → None): `select_subscription_agent_id`; cached device id (None → None);
  `fetch_device_list_snapshot(agent,1,20)`; `was_registered` = list contains this device;
  `already_pending` = marker pending; `needs_default_routing = already_pending || !was_registered`;
  if `!was_registered && !already_pending` → write marker `detected`; else if
  `was_registered && !already_pending` → delete marker (ignore errors).
  (login wraps this in a timeout; the login flow then sends its heartbeat.)
* `finalize_post_login_subscriptions(prep, registration_ok)` (mod.rs:1731) → `Option<Value>`:
  `subscription_ops::fetch_my_subscriptions_snapshot_for_agent(Buyer, None, agent)`
  (subscription_ops group; `GET /priapi/v1/aieco/task/subscribe/my`) else None.
  Empty snapshot → if `needs && (was_registered || registration_ok)` mark marker `completed`
  then delete it; return None. If `needs && !was_registered && !registration_ok` → None.
  If `needs` → `add_new_device_to_all_subscriptions` (error → None), delete marker.
  Then `add_post_login_autotrade_prechecks` and `compose_post_login_subscriptions`.
* `add_post_login_autotrade_prechecks(client, subs, agent)` (mod.rs:876): for each row with
  `status == 1` (SubStatus::Active), `thisDeviceReceives == true`, non-empty `jobId`,
  `serviceId`, `providerAgentId`: resolve the service description (inline
  `serviceDescription`; else `GET /priapi/v1/aieco/task/subscribe/{jobId}` via
  `get_with_identity`; else `common::find_service` = child process
  `agent service-list --agent-id <provider> --page 1 --page-size 100 --service-id <sid>`),
  classify with `autotrade::tooling::classify_description` (fail-closed: no asset class → skip);
  write `autotrade::profile::save_from_description(jobId, serviceId, Some(provider), desc)`
  (local file under `<ONCHAINOS_HOME>/autotrade/profile/`; autotrade group). All errors ignored.
* `compose_post_login_subscriptions(subs)` → `Some({"activeSubscriptionCount": n})` where
  n = rows with `status == 1` or `statusName` equal (ASCII case-insensitive) to `ACTIVE`;
  `None` when n == 0.
* `fetch_post_login_subscriptions(agentic_id)` (mod.rs:1794) — same as finalize without
  device routing; **no caller in 4.6.3** (tests only).
* `scoped_watch_autotrade_precheck`, `scoped_watch_autotrade_precheck_for_review`,
  `bind_subscription_restore_consent_context`, `bind_pre_delivery_consent_context`,
  `compose_*_consent_review` (mod.rs:954-1653) — **unreachable in 4.6.3** (grep finds no
  caller outside mod.rs/tests). A port may omit them. (They combine the subscription
  snapshot, `autotrade::consent::consent_snapshot`, service-guide hash comparison
  `sha256:<hex>` and return `{jobId, agentId, applicable, watchAllowed, reason, …}` with
  reasons `not_subscription | subscription_not_active | not_receiving_on_this_device |
  non_executable_service | consent_active | configuration_required |
  execution_policy_not_configured | consent_unreadable`.)

### 9. Validation helpers (create.rs)

* Constants: `MAX_BUDGET = 10_000_000`, `MIN_DESCRIPTION_CHARS = 20`,
  `MAX_DESCRIPTION_CHARS = 2000`, `MAX_DESCRIPTION_SUMMARY_CHARS = 200`,
  `MAX_BUDGET_DECIMALS = 6`, `MAX_TITLE_CHARS = 30` (all counts are Unicode scalar counts).
* `normalize_currency(s)`: map `₮`→`T`, uppercase; `USDT|USDT0 → "USDT"`, `USDG → "USDG"`,
  else `unsupported token: {s}; only USDT (USD₮0) and USDG are supported`.
* `validate_decimal_amount(value, flag)`: trim; empty or starts with `-`/`+` →
  `--{flag} must be a non-negative decimal string`; must be `digits[.digits]` with 1–6
  fraction digits else `--{flag} must be a decimal string with at most 6 decimal places`.
* `validate_title(t)`: `t.trim()` empty → `title must not be empty`; chars > 30 →
  `title may not exceed 30 characters (currently {n})`.
* `validate_budget(f64)`: `<0` → `budget must be a non-negative amount`; `>1e7` →
  `per-task budget may not exceed 10000000 USDT/USDG`.
  `validate_budget_decimals(f64)`: fraction of `format!("{b}")` minus trailing zeros longer
  than 6 → `budget precision is limited to 6 decimal places, currently {n}`.
* `validate_draft_fields(description?, title?, budget?, max_budget?, currency?)` (L454; used by
  `agent prepare-create`, common group) → `{"checks":[…],"errors":[…],"ok":errors.is_empty()}`;
  checks in order description (`description is too short (minimum 20 chars, currently {n})` /
  `description may not exceed 2000 chars (currently {n})`), title, currency
  (`{"field":"currency","normalized":…,"ok":true}` on success), budget, max_budget; entries
  `{"field","ok":true}` or `{"error","field","ok":false}`; plus
  `max_budget ({max}) must be >= budget ({budget})` appended to `errors` only.
* `common::util::sanitize_title_for_shell(title)`: `& | ;` → space; delete
  `` ` $ > < ( ) ! ``; collapse whitespace runs to one space; trim.

### 10. Guide/Consent local contract (autotrade/guide.rs + subscription_config.rs — summary)

* `guide::parse_draft(guide?, hash?)`: None if no guide; guide blank or > 49152 chars →
  `--service-guide must be between 1 and 49152 characters`; hash (default = computed
  sha256 hex of the UTF-8 guide), optional `sha256:` prefix stripped, lowercased; not 64 hex
  → `--service-guide-hash must be a lowercase SHA-256 hex digest`; mismatch →
  `--service-guide-hash does not match --service-guide`.
* `guide::validate_consent_values(map)`: key whose alnum-lowercased form contains
  `password|passphrase|privatekey|secretkey|apikey|accesstoken|refreshtoken|credential|jwt` →
  `credentials must not be stored in Guide Consent: {key}`.
* Local files written during creation (job id must match `[A-Za-z0-9_-]+`, else `invalid job id`):
  * `<ONCHAINOS_HOME>/autotrade/guide/{jobId}.md` =
    `"<!-- onchainos-autotrade:guide\n" + pretty({"version":1,"jobId","serviceId","providerAgentId"?,"sourceHash","createdAt":<unix s>}) + "\n-->\n\n" + <guide text>`.
  * `<ONCHAINOS_HOME>/autotrade/consent/{jobId}.md` =
    `"<!-- onchainos-autotrade:consent\n" + pretty({"version":1,"jobId","guideHash","lifecycle":"prepared","values":{…},"createdAt","expiresAt":createdAt+31536000}) + "\n-->\n\n# Service Consent\n\nValues in this document are defined exclusively by the matching Service Guide.\n"`.
    `activate_prepared_consent` rewrites lifecycle `prepared → active`
    (errors `prepared Guide Consent is not available`, `Guide Consent is not prepared`);
    `abort_prepared_consent` rewrites `prepared → aborted` (best effort).
  Files are written with `home::write_secure` (tmp `.{name}.{pid}.tmp` + rename, 0600/0700 on unix).
* `subscription_config` (autotrade/subscription_config.rs): file
  `<ONCHAINOS_HOME>/autotrade/subscription-config/{agentId}/{serviceId}.json`
  (both ids must match `[A-Za-z0-9_-]+` else `invalid subscription AgentId or ServiceId`),
  pretty JSON in declaration order
  `{"version":1,"agentId","serviceId","executionMode":"signal_only"|"guide_direct","updatedAtMs":<ms>}`.
  `execution_mode(a,s)` → None when missing/incomplete; read error
  `subscription execution configuration is unreadable: {path}`; parse/identity/version
  mismatch → `subscription execution configuration is invalid`.

### 11. `content.rs` — user-side message template library (single source of truth)

Pure string builders used by the user flow playbooks (`next-action`, `watch`, flow_lifecycle,
v2 notifications — other groups). Strings below are exact; `\n` = newline, `{x}` =
interpolated argument, `<…>` = literal placeholder text left for the agent. `–` is U+2013.
**Read this table (and §12) as raw text:** in each cell the outermost `` `"…"` `` pair only
delimits the string; every backtick *inside* the quotes is a literal character of the output
(markdown renderers will mis-render those cells). `\"` is a literal double quote.
`is_cli_mode()` (common/config.rs:76) = env `CLAUDECODE == "1"` OR `CODEX_THREAD_ID`
non-empty. `fmt_epoch(ts: Option<i64>) -> Option<String>` (content.rs:486): None if absent or
≤0; if `ts >= 1_000_000_000_000` use `ts/1000`; format UTC `"%Y-%m-%d %H:%M UTC"`
(e.g. `1700000000 → "2023-11-14 22:13 UTC"`).

| fn | exact output |
|---|---|
| `scoped_watch_handoff(job)` | `"[Watch] 🛑 Mandatory continuous monitor. Do NOT end the turn merely because one watch call returned. Do NOT ask the user whether to watch — it is required to receive the next event.\n\n**Step 1 (MANDATORY GATE) — Enter through `skills/okx-ai/SKILL.md`, then follow its Runtime route to `skills/okx-ai/references/runtime/watch.md`.** If you have NOT read the Runtime Watch reference in this session, you cannot proceed to Step 2 — Step 2's invocation, dispatch rules, and re-arm semantics live ONLY in that file. Skipping this step is a protocol violation.\n\n**Step 2 — Execute the watch per `skills/okx-ai/references/runtime/watch.md` §Run watch, scoped to job-id `{job}`.** Then dispatch every returned item per §Dispatch by `kind` and re-enter the same scoped command per §Re-enter after processing. A notification, deliverable, or empty poll does not end this Watch generation. Keep the same `--job-id` on every re-entry; stop or pause only when `runtime/watch.md`'s literal §Stop condition applies or a `decision_request` requires the user's reply. (Do NOT guess the bash invocation — read the v2 Runtime Watch reference first.)\n\n⏭ Skip `detect_watch_support` — this `[Watch]` block is only emitted on supported platforms."` |
| `job_created_designated_user_notify()` | `"[Connecting ASP]【<title>】(<short_jobId>) — connecting to the designated ASP (<provider_agentId>)."` |
| `not_provider_user_prompt(job, short, dp)` | `"[Job {short} — you are the User Agent] The designated agent (agentId={dp}) for job `{job}` does not exist or is not registered as an ASP (Agent Service Provider). It cannot fulfil this job.\nPlease choose:\nA. Designate another ASP — provide the agentId\nB. Close the job"` |
| `provider_offline_user_prompt(job, short, dp)` | same frame with reason `is currently offline. Negotiation requires the ASP to be online.` |
| `job_accepted_escrow_user_notify(job, _title, amount)` | `"[Job Accepted] Job `{job}` has been accepted; execution begins.\nTitle: <title>\nDescription: <description>\nASP agentId: <providerAgentId>\nPayment: escrow\n{amountLine}{trailing}"`; amountLine = `Amount: Free` if `is_zero_decimal(amount.trim())` (digits[.digits] all zeros) else `Amount: <tokenAmount> <tokenSymbol>`; trailing = `""` in CLI mode else `"\n         Waiting for the ASP to execute and submit the deliverable."` (newline + **9 spaces**) |
| `job_rejected_user_notify(job, title)` | lead (CLI) `"[Rejection Confirmed] The deliverable for【{title}】(`{job}`) has been rejected."`, (non-CLI) `"… has been rejected; waiting for the ASP to respond."`; full `"{lead}\nThe ASP will choose: request evaluation or agree to a refund.\nIf the ASP takes no action, funds will be auto-refunded to your wallet."` |
| `job_completed_escrow_user_notify(job, title, amt, sym)` | `"[Job Completed] {title} (`{job}`) — approved by the User Agent; funds released to the ASP.\n- Spent: {amt} {sym}\n- Payment: escrow\n\nTo rate this job, reply \"Rate job\". Your rating for Job ID `{job}` replaces the AI-generated rating."` |
| `EVALUATION_REASONS_BLOCK` (const) | `"- Evaluation reasons:\n    Evaluator 1: <voterReportSummary from message.voteReportSummaries[0]>\n    Evaluator 2: <voterReportSummary from message.voteReportSummaries[1]>\n    ... (one line per entry; first skip entries whose voterReportSummary is missing / empty / whitespace, then number the kept entries consecutively starting at 1 in array order — do NOT preserve gaps from the original index; omit this whole `- Evaluation reasons:` section if voteReportSummaries is missing, not an array, empty, or every entry would be skipped — do NOT print a header with no body, do NOT fabricate filler text)"` |
| `refund_party(name?, id?)` (private) | both `"{name} ({id})"`; name `"{name}"`; id `"name unavailable ({id})"`; none `"not provided by the final event"` |
| `amount_and_token(amt?, sym?)` (private) | both `"{amt} {sym}"`; amt `"{amt} (token symbol unavailable)"`; else `"not provided by the final event"` |
| `dispute_won_user_notify(job,title,pname?,pid?,service?,amt?,sym?,refund_confirmed,tx?)` | `"[Evaluation Result] {title} (`{job}`) — evaluation completed; User Agent wins.\n- Refund ASP: {refund_party}\n- Service: {service or \"not provided by the final event\"}\n{settlement}\n- Evaluation status: Decided\n- Result: User Agent won; the refund completed\n{EVALUATION_REASONS_BLOCK}"`; settlement (confirmed) `"- Refund amount: {amount_and_token}\n- Tx Hash: {tx or \"unavailable\"}\n- Refund status: Settled; funds returned to the User Agent wallet."`, (not confirmed) `"- Refund amount: {amount_and_token} (approved; settlement verification pending)\n- Tx Hash: unavailable\nThe ruling favors the User Agent, but the available lifecycle facts do not yet verify the settlement result. Reconcile through Refund before reporting completion."` |
| `dispute_lost_user_notify(job,title,pname?,pid?,service?,amt?,sym?)` | `"[Evaluation Result] {title} (`{job}`) — the refund request was not approved; ASP wins.\n- Refund: Not issued\n- ASP: {refund_party}\n- Service: {service or \"not provided by the final event\"}\n- Original payment: {amount_and_token} (funds released to the ASP)\n- Evaluation status: Decided\n- Result: ASP won; task funds were released to the ASP\n{EVALUATION_REASONS_BLOCK}\nThis job is complete."` |
| `rating_submitted_user_notify(job, title)` | `"[📝 Rating Submitted] {title} (`{job}`) — rated.\nScore: <score> / 5.00\n💬 Comment: <description>"` |
| `job_refunded_user_notify(job)` | `"[Refund Settled] Job `{job}` — refund confirmed on-chain; funds returned to your wallet. This job is complete."` |
| `job_auto_refunded_user_notify(job, title)` | `"[Auto-Refund Settled] {title} (`{job}`) — escrowed funds returned to your wallet. This job is complete."` |
| `job_expired_user_notify(job)` | `"[Job Expired] Job `{job}` is in authoritative Expired(8) status after a deadline elapsed. Any applicable automatic refund has reached the buyer, and no buyer-side refund claim or finalization is required."` |
| `job_asp_accept_expire_user_notify(job, service, is_sub, pname, pid, amt, sym, is_paid, is_trial)` | `is_sub` → `subscription_job_asp_accept_expire_user_notify(service, job, amt, sym, pname, pid, is_trial)` else `regular_job_asp_accept_expire_user_notify(service, job, amt, sym, pname, pid, is_paid)` |
| `job_asp_reject_expire_user_notify(job, service, amt, sym, rw?, is_sub, is_paid)` | `is_sub` → `subscription_job_asp_reject_expire_user_notify(service, job, amt, sym, rw)` else `regular_job_asp_reject_expire_user_notify(service, job, amt, sym, rw, is_paid)` |
| `job_closed_user_notify(job, title)` | `"[Job Closed] {title} (`{job}`) has been closed; funds have been returned."` |
| `payment_mode_escrow_user_notify(job, title)` | `"[Payment Mode Set] {title} (`{job}`) — payment mode updated successfully; ASP <providerName> (<providerAgentId>) is accepting..."` |
| `close_user_notify(job)` | `"[Job Closed] Job `{job}` has been closed."` |
| `submit_expired_user_notify(job)` | `"[Submit Deadline Expired] Job `{job}` — the ASP did not submit the deliverable before the deadline. Authoritative Expired(8) confirms that the backend returned any refundable payment to your wallet. This notification did not send a refund transaction, and no buyer-side claim or finalization is required."` |
| `reject_expired_user_notify(job)` | CLI: `"Job `{job}` — the ASP did not request evaluation in time after you rejected the deliverable. An auto-refund is in progress; funds will return to your wallet and a final refund-settled notice will follow shortly."`; non-CLI: `"Job `{job}` — the ASP did not request evaluation in time after you rejected the deliverable. An auto-refund has been requested; funds will return to your wallet."` |
| `review_deadline_warn_user_prompt(job, short)` | `"[Job {short} — you are the User Agent] [⏰ Review Deadline Warning] Job {job} — the review deadline is approaching.\nAfter expiry, the ASP can auto-claim the funds.\nPlease decide soon:\nA. Approve the deliverable\nB. Reject the deliverable"` |
| `reward_claimed_user_notify(job, title)` | `"[Reward Claimed] {title} (`{job}`) — reward / refund successfully claimed to your wallet."` |
| `wakeup_resume_user_notify(job)` | `"[Resumed] Job `{job}` is back online. Please continue when ready."` |
| `attachment_sent_user_notify()` | `"[Job <short_jobId>] Attachment sent to the ASP."` |
| `escalation_protocol_misread_notify(job)` | `"[⚠️ Protocol Misalignment] Job `{job}` — the remote agent repeatedly sends messages that do not match the current flow. Replies have stopped. Please intervene manually to continue."` |
| `create_task_designated_user_notify()` | `"Job submitted; jobId: <jobId>; designated provider: <providerName> (agentId: <agentId>); awaiting on-chain confirmation (~seconds). Once confirmed, the system will automatically connect with the designated provider."` |
| `escalation_cli_failed_notify(job)` | `"[⚠️ Operation Failed] Job `{job}`\n- Action: <e.g. match ASPs / submit review / escrow payment>\n- Error: <one-sentence summary of stderr / error field>\n- Current status: <describe in plain language, e.g. waiting for provider / under review / payment pending>\n\nChoose how to proceed:\nA. Retry → reply 'A' or 'retry'\nB. Don't prompt again (you'll handle manually) → reply 'B' or 'dismiss'\nC. Provide a new instruction → describe what to change (e.g. 'change --token-symbol to USDT and retry')"` |
| `sub_open_user_notify(job, service, amt?, sym?)` | `"[Subscription Created] Job {job} (subscribing to {service}) is on-chain and waiting for the ASP to accept."` + (amt&sym `" {amt} {sym} has been funded for the subscription."` / amt only `" {amt} has been funded for the subscription."` / else nothing) |
| `sub_open_trial_user_notify(job, service, amt?, sym?)` | `"[Trial Subscription Created] Job {job} (subscribing to {service}) is on-chain and waiting for the ASP to accept. The free trial will begin after acceptance."` + (amt: sym ? `" If accepted, {amt} {sym} is the paid-period price after the trial."` : `" If accepted, {amt} is the paid-period price after the trial."`) |
| `sub_created_user_notify(job, service, amt?, sym?, ps?, pe?, auto_renew)` | `"[Subscribed] Job {job} (subscribing to {service}) is on-chain"` + (both fmt_epoch ok: `", current period {s}–{e}"`) + `"."` + (amt: sym ? `" First charge of {amt} {sym} completed."` : `" First charge of {amt} completed."`) + (auto_renew ? `" Auto-renew is on"` + (fmt(pe) ? `"; next charge date: {nc}"`) : `" Auto-renew is off"`) + `"."` + `"\n\nTo rate this job, reply \"Rate job\". Your rating for Job ID `{job}` replaces the AI-generated rating."` |
| `sub_created_trial_user_notify(job, amt?, sym?, ts?, te?)` | `"[Trial Started] Your free trial has started"` + (both: `" ({s}–{e})"`) + `"."` + (amt: (sym ? `" After it ends, {amt} {sym} will be auto-charged"` : `" After it ends, {amt} will be auto-charged"`) + (fmt(te) ? `" on {e}"`) + `" to convert to a paid subscription (attempted once, within the final hour before the trial ends — it will not retry if missed)."`) + `"\n\nTo rate this job, reply \"Rate job\". Your rating for Job ID `{job}` replaces the AI-generated rating."` |
| `sub_trial_into_active_user_notify(_job, service, amt?, sym?, ps?, pe?)` | `"[Trial Converted] Your free trial has ended;"` + (amt&sym `" the first charge of {amt} {sym} for \"{service}\" is complete"` / amt `" the first charge of {amt} for \"{service}\" is complete"` / else `" the first charge for \"{service}\" is complete"`) + (both: `", current period {s}–{e}"`) + `"."` + (fmt(pe): `" Next charge date: {nc}."`) |
| `sub_renew_user_notify(result?, reason?, service, _job, amt?, sym?, _ps?, pe?, grace?)` | result==`"fail"`: `"[⚠️ Renewal Failed] \"{service}\" — this cycle's charge failed"` + (reason: `": {reason}"`) + `". A grace period is in effect"` + (fmt(grace): `" (until {g})"`) + `"; service continues normally and the system will keep retrying. Please add funding / increase allowance as soon as possible."`; else `"[Renewed] \"{service}\" —"` + (amt&sym `" this cycle's renewal of {amt} {sym} is complete."` / amt `" this cycle's renewal of {amt} is complete."` / `" this cycle's renewal is complete."`) + (fmt(pe) ? `". Next charge date: {nc}."` : `"."`) — note the resulting **double period** (`complete..`) is byte-exact upstream behaviour |
| `sub_user_reject_user_notify(service, ps?, pe?, rw?, amt?, sym?)` | `"[Rejection Submitted] Your rejection for \"{service}\"'s current period"` + (both `" ({s}–{e})"`) + `" has been submitted. The ASP must respond"` + (fmt(rw) `" by {w}"`) + `", or a full refund"` + (amt&sym `" of {amt} {sym}"` / amt `" of {amt}"`) + `" will be issued automatically."` |
| `sub_asp_dispute_user_notify(service, job, ps?, pe?)` | `"[Evaluation Opened] The ASP requested evaluation of your rejection of \"{service}\""` + (both `"'s current period ({s}–{e})"`) + `". Evaluation is in progress for Job {job} (protocol status: Disputed)."` |
| `sub_cancel_user_notify(result?, reason?, trial_type?, service, job, sub_end?)` | result==`"fail"`: `"[Subscription Cancellation Failed] Your subscription could not be cancelled."` + (reason: `"\n         Reason: {reason}"` — newline + 9 spaces); trial_type==Some(1): `"[Cancelled] The free trial for \"{service}\" has been cancelled and access ends immediately. No conversion charge will occur."`; else `"[Auto-Renew Cancelled] Auto-renew for \"{service}\" has been cancelled. Current service continues"` + (fmt(sub_end) ? `" until {e}"` : `" for the remainder of the current period"`) + `"; job {job} will then move to Completed."` |
| `sub_asp_agree_user_notify(service, amt?, sym?, ps?, pe?)` | `"[Refund Complete] The ASP has acknowledged the issue with \"{service}\"'s current period"` + (both `" ({s}–{e})"`) + `". A full refund"` + (amt&sym `" of {amt} {sym}"` / amt `" of {amt}"`) + `" has been sent directly to your wallet, and auto-renew has been turned off."` |
| `sub_complete_notify_user_notify(service, job, pe?, include_rating)` | `"[Subscription Complete] \"{service}\" has completed all scheduled renewals. Job {job} status: Completed; service ends normally"` + (fmt(pe) `" at {e}"`) + `" with no further renewal."` + (include_rating: `"\n\nTo rate this job, reply \"Rate job\". Your rating for Job ID `{job}` replaces the AI-generated rating."`) |
| `sub_close_notify_user_notify(service, job, ps?, pe?, asp_reason?)` | non-blank reason: `"[Service Closed] The ASP declined \"{service}\" before activation. Job {job} status: Closed. ASP reason: {reason}. This closure notice does not by itself confirm that a refund settled."`; else `"[Service Closed] \"{service}\""` + (both `"'s current period ({s}–{e})"`) + `" has ended. Job {job} status: Closed."` |
| `sub_failed_notify_user_notify(service, trial_type?, reason?, job, grace?)` | trial_type==Some(1): `"[Trial Ended] \"{service}\" — the conversion charge could not be completed before the trial ended"` + (reason `" ({r})"`) + `"; conversion failed with no retry. Job {job} status: Closed. Subscribe again to continue."`; else `"[Subscription Ended] \"{service}\" — the charge still failed after the grace period"` + (fmt(grace) `"; the service ended at {g}"`) + `". Job {job} status: Closed. Subscribe again to continue."` |
| `sub_expire_warn_user_notify(job)` | `"[Renewal Reminder] Job `{job}` — your subscription's current period is ending soon. It will auto-renew on expiry. Cancel in advance via subscription management if you don't want this."` |
| `sub_expire_warn_no_autorenew_notify(job, ps: &str, pe: &str)` | `"[Subscription Ending Soon] Subscription job {job} (period {ps}–{pe}) will expire and close on {pe}. To continue using it, please enable auto-renew in time."` |
| `sub_reject_refund_notify_user(service, ps?, pe?, rw?, amt?, sym?)` | `"[Auto-Refund] Your rejection request for \"{service}\""` + (both `"'s period ({s}–{e})"`) + `" went unanswered past the ASP's response deadline"` + (fmt(rw) `" ({d})"`) + `"."` + (amt&sym `" The system has automatically issued a full refund of {amt} {sym} to your wallet."` / amt `" The system has automatically issued a full refund of {amt} to your wallet."` / `" The system has automatically issued a full refund to your wallet."`) |
| `subscription_job_asp_accept_expire_user_notify(service, job, amt, sym, pname, pid, is_trial)` | trial: `"[Job Expired] The ASP did not accept {service} within 3 hours, so the job expired. Neither the subscription nor the free trial began.\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nJob status: Expired\n\nYour free-trial eligibility remains unaffected."`; else `"[Job Expired] The ASP did not accept {service} within 3 hours, so the job expired. The subscription did not begin. The escrowed amount of {amt} {sym} will be returned to your wallet.\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nJob status: Expired"` |
| `regular_job_asp_accept_expire_user_notify(service, job, amt, sym, pname, pid, is_paid)` | `"[Job Expired] The ASP did not accept {service} within 3 hours, so the job expired.{payment}\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nJob status: Expired"`, payment = is_paid ? `" The escrowed amount of {amt} {sym} will be returned to your wallet."` : `""` |
| `subscription_job_asp_reject_closed_user_notify(service, job, amt, sym, pname, pid, reason, is_trial)` | trial: `"[ASP Declined] The ASP declined {service}.\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nReason: {reason}\n\nThe job is closed. Neither the subscription nor the free trial began, and your free-trial eligibility remains unaffected."`; else `"[ASP Declined] The ASP declined {service}. The escrowed amount of {amt} {sym} will be returned automatically to your wallet address. Please monitor your wallet balance.\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nReason: {reason}\n\nThe job is closed, and the subscription did not begin."` |
| `regular_job_asp_reject_closed_user_notify(service, job, amt, sym, pname, pid, reason, is_paid)` | `"[ASP Declined] The ASP declined {service}.{payment}\n\nJob ID: {job}\nASP: {pname} (Agent ID: {pid})\nReason: {reason}\nJob status: Closed"`, payment = is_paid ? `" The escrowed amount of {amt} {sym} will be returned automatically to your wallet address. Please monitor your wallet balance."` : `""` |
| `subscription_job_asp_reject_expire_user_notify(service, job, amt, sym, rw?)` | `"[Automatic Refund Processing] The ASP did not respond to the refund request for {service} by the deadline. {amt} {sym} will be returned to your wallet, subject to on-chain confirmation.\n\nJob ID: {job}\nResponse deadline: {deadline}\nJob status: Failed"`, deadline = fmt_epoch(rw) or `"Unavailable"` |
| `regular_job_asp_reject_expire_user_notify(service, job, amt, sym, rw?, is_paid)` | paid → identical to the subscription variant; unpaid → `"[Refund Request Processed] The ASP did not respond to the refund request for {service} by the deadline. No charges were incurred, so no refund is required.\n\nJob ID: {job}\nASP response deadline: {deadline}\nJob status: Failed"` |

Test oracles (content.rs tests): `subscription_job_asp_reject_expire_user_notify("BTC Signals","job-1","12.34","USDT",Some(1_700_000_000))` →
`"[Automatic Refund Processing] The ASP did not respond to the refund request for BTC Signals by the deadline. 12.34 USDT will be returned to your wallet, subject to on-chain confirmation.\n\nJob ID: job-1\nResponse deadline: 2023-11-14 22:13 UTC\nJob status: Failed"`;
`fmt_epoch(1_790_000_000_000)` renders a 2026 date (ms tolerance).

### 12. `flow_negotiate` playbook generators (user-side `next-action` events)

Called from `user::flow` (flow.rs:391-425, other group) when `onchainos agent next-action`
dispatches a user event; the returned String becomes part of the next-action output. Each
takes `FlowContext{job_id, agent_id, short_id, title_display, payment_mode, prefetched…}`.
`pending_v2::request_command_block(job, role, agent, to?, user_content, label, source_event)`
(pending_v2.rs:2586, other group) renders:
`"**Localize first** — translate the `--user-content` and `--list-label` values below to the user's language before running. Keep the bash structure / flags / source-event token unchanged.\n\n```bash\nonchainos agent pending-decisions-v2 request \\\n  --job-id {job} --role {role} --agent-id {agent}{ --to-agent-id \"{to}\"} \\\n  --user-content \"{content with \\ and \" escaped}\" \\\n  --list-label \"{label}\" \\\n  --source-event {source_event}\n```"`.

* `match_provider::job_created(ctx)` (Event `job_created`):
  * no local `designated-provider.json` → `"[Trigger] job_created (on-chain, no designated provider recorded locally)\n[Role] User (User)\n\n🛑 Notify the user the job 「{title}」 ({short}) is confirmed on-chain, then end the turn. Designate a provider with `onchainos agent set-asp` if one is not already attached.\n\n**Action — Notify the user.** **Localize first** — rewrite the content below in the user's language before sending.\n```bash\nonchainos agent user-notify --content \"<localized content>\"\n```\nContent: [Job Created]「{title}」({short}) confirmed on-chain.\n\n🛑 End the turn after notifying.\n"`.
  * designated provider `dp`: `notify_filled = job_created_designated_user_notify()` with
    `<title>`, `<short_jobId>`, `<provider_agentId>` replaced; `notify_body =
    "**Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\nContent:\n  {notify_filled}\n```bash\nonchainos agent user-notify --content \"<localized content shown below>\"\n```\n\n"`.
    Then `common::designated_route_inner(dp, prefetched.service_id)` (common/mod.rs:802 —
    child processes `agent get-agents --agent-ids <dp>` + `agent service-list --agent-id <dp> --page 1 --page-size 100`;
    returns `{"route":"a2a","onlineStatus","providerName"}` or
    `{"route":"error","errorType":"not_provider"|"service_not_found"|"a2mcp_direct_invoke_required"|"offline",…}`);
    error → `"[job_created_cli] ERROR: designated-route failed: {e}\n"`. route `a2a` →
    `branch_a2a_cli`, `error` → `branch_error`, other →
    `"[job_created_cli] ERROR: unknown route value '{route}' in designated-route response: {route_json compact}\n"`.
    Result: branch playbook `p` → `"**Action 0 — Notify the user the job is on-chain.** {notify_body}After Action 0 completes, follow the branch-specific playbook below:\n\n---\n\n{p}"`; branch returned None → `notify_body`.
* `designated::branch_a2a_cli(job, agent, dp)` → `Option<String>`; side effects via local
  `okx-a2a` CLI (not HTTP): `okx-a2a session query --job-id … --my-agent-id … --to-agent-id … --json`
  (exists → `"[Designated ASP route: A2A] ASP {dp}\n\n🛑 Sub session already exists for this job; the first inquiry has already been sent in a prior turn. End this turn immediately — do not create a group, do not send any message, do not run `okx-a2a session status` / `okx-a2a session create` / `okx-a2a session send`.\n"`;
  error → `"[branch_a2a_cli] ERROR: okx-a2a session query failed: {e}\n"`), then
  `okx-a2a session create …` (error → `"[branch_a2a_cli] ERROR: okx-a2a session create failed: {e}\n"`), then
  `okx-a2a session send --job-id {job} --content <PREFETCH> --json --to-agent-id {dp}` with
  PREFETCH = `[SKILL_PREFETCH] Read the okx-ai skill through skills/okx-ai/SKILL.md. Pre-load A2A context. This prefetch message itself requires no action — but when the NEXT inbound message arrives (same turn or later turn), you MUST re-enter through that SKILL.md and follow its Top-level routing for the exact envelope shape. Do NOT carry over "no action" to business messages.`
  (error → `"[branch_a2a_cli] ERROR: okx-a2a session send (SKILL_PREFETCH) failed: {e}\n"`), then
  best-effort `flow_lifecycle::upload_and_forward_all_attachments(job, agent, dp)`; returns None.
* `designated::branch_error(job, agent, short, dp)` → `"[Designated ASP route: error] ASP {dp} encountered a routing error.\n[Role] User (User)\n\n**Branch by `errorType` from the `designated-route` response above (earlier in this turn):**\n\n- **`errorType == \"service_not_found\"`** -> the selected registered service is no longer available.\n  {block_service}\n  -> **end this turn** and wait for the user's reply.\n\n- **`errorType == \"not_provider\"`** -> the designated agent does not exist or is not registered as an ASP.\n  {block_not_provider}\n  -> **end this turn** and wait for the user's reply.\n\n- **`errorType == \"offline\"`** -> the ASP is offline and cannot negotiate.\n  {block_offline}\n  -> **end this turn** and wait for the user's reply.\n\n"`
  where blocks = `request_command_block(job,"user",agent,Some(dp), content, label, source)`:
  service: content `"[Job {short} — you are the User Agent] The previously selected registered service of ASP (agentId={dp}) is no longer usable. Choose next step:\nA. Specify another ASP — provide the agentId\nB. Make the job public — let more ASPs discover it\nC. Close the job"`, label `[Service gone {short}] next-step decision`, source `service_not_found`;
  not-provider: `not_provider_user_prompt(job,short,dp)`, `[Not ASP {short}] next-step decision`, `not_provider`;
  offline: `provider_offline_user_prompt(job,short,dp)`, `[Offline {short}] next-step decision`, `provider_offline`.
* `events::job_payment_mode_changed(ctx)`: `payment_mode == Some(3)` →
  `"[Legacy A2MCP Task payment] This path was removed. Do not sign, replay, or continue this Task flow; restart from an upstream invoke_a2mcp event.\n"`;
  else `"[Current state] job_payment_mode_changed (A2A escrow is on-chain)\n[Role] User Agent\n\nNotify the user via `onchainos agent user-notify`, using this localized template:\n{payment_mode_escrow_user_notify(job,title)}\n\nEnd this turn and wait for provider_applied.\n"`.
* `events::negotiate_reply(ctx)`: no prefetched context →
  `"[negotiate_reply] ❌ no prefetched task context for job {job}; cannot resolve providerAgentId.\n\nPush a `cli_failed` decision to the user via `pending-decisions-v2 request` (enter through `skills/okx-ai/SKILL.md`, then see `skills/okx-ai/references/runtime/recovery.md` §2). Do NOT retry blindly.\n"`;
  empty providerAgentId → `"[negotiate_reply] ❌ prefetched task context has no providerAgentId for job {job}; cannot send a reply.\n\nPush a `cli_failed` decision to the user via `pending-decisions-v2 request` (enter through `skills/okx-ai/SKILL.md`, then see `skills/okx-ai/references/runtime/recovery.md` §2). Do NOT retry blindly.\n"`;
  else (desc = description or `(missing)`, P = providerAgentId):
  ~~~text
  "**Task fields (already fetched — do NOT call `common context`):**\n  • Title: {title}\n  • Description: {desc}\n🛑 **Price is locked**: do NOT discuss tokenAmount / tokenSymbol / paymentMode / budget with the ASP. Price was determined by the service listing at creation time and is locked at accept.\n\n[Negotiation] negotiate_reply (ASP sent a natural-language message)\n[Role] User (User)\n\n**2-round limit**: count how many user replies (your `okx-a2a session send` calls) have already been sent in this sub session's conversation history.\n- Rounds sent < 2 → reply normally (see below).\n- Rounds sent ≥ 2 → negotiation exceeded the 2-round limit. **Do NOT reply.** Jump to **[Over-limit]** below.\n\n**Reply about**: scope, requirements, deliverable format, timeline, clarifying questions.\n\n🚫 **Forbidden in this event:**\n  ❌ `onchainos agent user-notify` / `pending-decisions-v2 request` to ask the user about the ASP's message — negotiation is autonomous in this sub session.\n  ❌ `set-payment-mode` / `confirm-accept` / `reject-apply` / `apply` — no on-chain action belongs in this event.\n\n[Normal reply — single CLI call, then end the turn]\n\n```bash\nokx-a2a session send \\\n  --job-id {job} \\\n  --to-agent-id {P} \\\n  --content '<natural-language reply, task details only — no price talk>' \\\n  --json\n```\n\n⏱ 5-minute timeout: if the ASP does not reply within 5 minutes, treat as over-limit (see below).\n\n━━━━━━━━━ [Over-limit] 2-round limit exceeded or timeout ━━━━━━━━━\n\n**Step 1** — mark this ASP as failed:\n```bash\nonchainos agent mark-failed {job} --provider {P}\n```\n\n**Step 2** — push a decision card to the user:\n**Localize first** — translate the `--user-content` and `--list-label` values below into the user's language before running.\n```bash\nonchainos agent pending-decisions-v2 request --job-id {job} --role user --agent-id {agent} --user-content \"<compose from template below>\" --list-label \"[No ASP] negotiate timeout — next-step decision\" --source-event no_asp_found\n```\n`--user-content` template:\nNegotiation with ASP {P} did not reach agreement within 2 rounds.\n\nWhat would you like to do next?\nA. Browse the ASP list\nB. Designate a specific ASP by agentId\nC. Close the task\n\n→ **End this turn.**\n"
  ~~~
  (`\\` = one backslash.)
* `events::provider_reject(ctx)` (Event `job_provider_reject`): **HTTP** `POST
  /priapi/v1/aieco/task/{jobId}/reset/asp` body `{}` (+ injected `sessionCert`) via
  `post_with_identity`, header `agenticId: ctx.agent_id` (state-changing). Error →
  `"[job_provider_reject] ❌ POST reset/asp failed: {e}\n\nEnter through `skills/okx-ai/SKILL.md`, then see `skills/okx-ai/references/runtime/recovery.md` §2 — push `cli_failed` decision.\n"`.
  Success → `"[job_provider_reject] ✅ ASP binding reset (reset/asp) completed in-process.\n\n**Localize first** — translate the `--user-content` value below into the user's language before executing. Keep `[Job {short}]` prefix and `A.` / `B.` / `C.` option letters unchanged.\n\n🛑 Push the next-step decision card via `pending-decisions-v2 request`, then end turn.\n\n{request_command_block(job,\"user\",agent,None, \"[Job {short} — you are the User Agent] ASP declined to take this task. What would you like to do next?\\n\\nA. Browse the ASP list\\nB. Designate a specific ASP by agentId\\nC. Close the task\", \"[Reject {short}] next-step decision\", \"job_provider_reject\")}\n"`.

### 13. Misc small helpers

* `fn user::mod::parse_bool_or_int(s, flag)` (mod.rs:407): exactly `"0"|"false"` → 0,
  `"1"|"true"` → 1 (case-sensitive), else `--{flag} must be 0, 1, true, or false; got "{s}"`.
* `fn service_detail::scalar_string` / `task_create_prepare::scalar_string`: trimmed non-empty
  string, or i64/u64 rendered as decimal.
* `common::PaymentMode` (payment_mode.rs): `from_str("escrow"|anything-else) = Escrow`,
  `"x402" = X402`; `from_int(1)=Escrow, 3=X402, other=None`; `as_str` `none|escrow|legacy-x402-disabled`;
  `as_int` 0/1/3.
* `state_machine::Status::from_int`: `-1 init, 0 created, 1 accepted, 2 submitted,
  3 rejected, 4 disputed, 5 admin_stopped, 6 completed, 7 close, 8 expired, 9 failed`,
  other → `Other("status_{n}")`; Debug form (used in an error message) is the variant name
  (`Init`, `Accepted`, `Other("status_17")`, …).
* `common::query::status_name(code)`: `0 created, 1 accepted, 2 submitted, 3 rejected,
  4 disputed, 5 admin_stopped, 6 complete, 7 close, 8 expired, 9 failed, else unknown`.
  `task_status_label(code)`: `-1 Initializing, 0 Awaiting ASP acceptance, 1 In progress,
  2 Awaiting buyer review, 3 Awaiting refund decision, 4 Evaluation in progress,
  5 Stopped by platform, 6 Completed, 7 Closed, 8 Expired, 9 Refund completed,
  else Status unavailable`. `task_status_description(code)`: `-1 The task is being initialized.`,
  `0 The task is waiting for an ASP to accept it.`, `1 The ASP accepted the task and is working on it.`,
  `2 The ASP submitted the deliverable and is waiting for buyer review.`,
  `3 The buyer rejected the deliverable and the refund request awaits an ASP decision.`,
  `4 The refund request is in Evaluation.`, `5 The platform stopped the task.`,
  `6 The task completed and funds were released to the ASP.`, `7 The task is closed.`,
  `8 The task expired.`, `9 The refund completed and the task is closed.`,
  else `The task status is currently unavailable.`
* `okx_a2a::probe_offline_replay_capability()` (okx_a2a.rs:287): env
  `ONCHAINOS_SKIP_A2A_PREFLIGHT=1` → supported. Else runs local `okx-a2a capabilities --json`;
  supported iff stdout JSON `.messageEligibleOfflineReplay.ok == true`; `fixCommands` =
  string entries of `.messageEligibleOfflineReplay.fixCommands`; any failure → unsupported.
  `fix_commands_or_default()` = fixCommands or `["npm install -g @okxweb3/a2a-node@latest"]`.
* `lifecycle::initial_creation_display()` (lifecycle.rs:1874) serialises (sorted keys) to:
  `{"currentSummary":"Creating task","deliverableAvailable":false,"handledBy":"Platform","next":"Wait for task creation","progressStep":1,"progressTotal":5,"reviewReady":false,"timeline":[{"detail":"Creation submitted; waiting for task confirmation","key":"created","marker":"▶","title":"Creating task"},{"detail":"Not started","key":"accepted","marker":"○","title":"ASP acceptance"},{"detail":"Not started","key":"asp_execution","marker":"○","title":"ASP execution"},{"detail":"Not started","key":"user_review","marker":"○","title":"Deliverable review"},{"detail":"Not completed","key":"completed","marker":"○","title":"Task completion"}]}`.
* `asp_ops::compact_task_service_for_ai(service)` (asp_ops.rs:217, other group) — used by
  task-create-prepare: builds `{providerAgentId (asp.aspAgentId|providerAgentId|aspAgentId),
  providerAgentName (asp.aspName|providerAgentName|aspName), securityRate, feedbackRate,
  soldCount (asp.X|X), sid, serviceId, serviceName, serviceType, serviceDescription,
  serviceGuide, feeToken, feeTokenSymbol, endpoint (copied only when present),
  serviceGuideHash ("sha256:"+hex(sha256(serviceGuide)) when guide non-blank),
  feeAmount (only when not a subscription), online (asp.onlineStatus == 1),
  supportSubscription, subscriptionInfo}`; `subscriptionInfo` = service.subscriptionInfo if
  object, else from `subscription[]` (entry with `interval=="month"` else first):
  `{"feeAmount":entry.fee|null,"freeTrial":service.freeTrial|0,"interval":entry.interval|null,"supportTrial":service.supportTrial|false}`,
  or `null` when no subscription entry and `supportSubscription != true`.

---

## Commands

Conventions for every command below: "auth jwt-required" means every HTTP call goes through
`ensure_tokens_refreshed()` (may call `POST /priapi/v5/wallet/agentic/auth/refresh`) and
sends `Authorization: Bearer` + `agenticId`. "Child process" means the CLI re-invokes its
own executable (`std::env::current_exe()`) and parses the child's stdout JSON; a Node port
may call the equivalent in-process function but must produce the same HTTP traffic.

### `onchainos agent create-task`  (hidden: no)
- Handler: `AgentCommand::CreateTask` (agent_commerce/mod.rs:104, dispatch 1444) →
  `run_task(TaskCommand::Create)` (task/user/mod.rs:1840) → `create::handle_create` (create.rs:252).
- Options (all `--long`):
  | flag | type | required / default | notes |
  |---|---|---|---|
  | `--title` | String | required | ≤30 chars; sanitised before sending |
  | `--description` | String | required | non-blank, ≤2000 chars |
  | `--description-summary` | String | optional | ≤200 chars |
  | `--provider-agent-id` | String | required | non-blank |
  | `--payment-token-symbol` | String | required | USDT/USDT0/USD₮0/USDG (case-insens.) |
  | `--payment-token-amount` | String | required | decimal ≤6 dp |
  | `--file` | Vec<String> (repeatable, one value each) | optional | attachments |
  | `--service-id` | String | required | non-blank |
  | `--service-params` | String | default `{}` | must be valid JSON; sent as the raw string |
  | `--service-token-address` | String | required | non-blank |
  | `--service-token-amount` | String | required | decimal ≤6 dp |
  | `--category-code` | String | optional | |
  | `--min-credit-score` | f64 | optional | 0..=1 (clap parses f64) |
  | `--visibility` | String | default `private`, possible `private`,`public` | wire private=1, public=0 |
  | `--chain-id` | u64 | default `196` | must be 196 |
  | `--service-guide` | String | optional | |
  | `--service-guide-hash` | String | optional | |
  | `--guide-consent-json` | String | optional | JSON object |
  Global `--chain` accepted and ignored.
- Auth: jwt-required + session-key signing (EIP-3009 via TEE sign-msg, uop via local
  session key); requires a non-empty `sessionCert`.
- Steps:
  1. Local validation `CreateTaskParams::validate` (in this order):
     `validate_title` (`title must not be empty` / `title may not exceed 30 characters (currently {n})`);
     `--description must not be empty` (trim); `--description may not exceed 2000 characters (currently {n})`;
     `--description-summary may not exceed 200 characters`;
     `--provider-agent-id is required; use the confirmed Service result unchanged`;
     `--service-id is required; use the confirmed Service result unchanged`;
     `--service-token-address must not be empty`;
     service params JSON → `--service-params must be valid JSON: {serde error}`;
     `normalize_currency` (error `unsupported token: {raw}; only USDT (USD₮0) and USDG are supported`);
     `validate_decimal_amount(payment-token-amount)`, `validate_decimal_amount(service-token-amount)`;
     chain id → `--chain-id currently supports X Layer (196) only`;
     `--min-credit-score must be between 0 and 1` (also NaN);
     visibility (`--visibility must be private or public`, unreachable via clap);
     `validate_attachment_sources(--file…)`;
     title := `sanitize_title_for_shell(title)`;
     Guide/Consent: no guide but hash or consent given → `Guide Consent requires --service-guide`;
     `parse_draft` errors; guide without consent json →
     `--guide-consent-json is required with --service-guide, including {} when the Guide declares no consent fields`;
     consent JSON not an object → `--guide-consent-json must be a JSON object: {serde error}`;
     `validate_consent_values`.
  2. `home::ensure_task_state_writable()` — create `<HOME>/task` (0700) and write+delete probe
     `.write-probe-{pid}-{nanos}`; error context
     `task state storage is not writable; set ONCHAINOS_HOME to a writable directory`.
  3. `ensure_tokens_refreshed()`; error → `` session has expired; run `onchainos wallet login` first: {e} ``.
  4. `wallet_store::load_session()` must have non-blank `session_cert`, else
     `current login has no sessionCert; run `onchainos wallet login` again before create-task`.
  5. `resolve_user_agent()` (child `agent get-my-agents --owner-address … --role user --page-size 100`).
  6. `required = payment_token_amount.parse::<f64>()` (untrimmed!) — failure →
     `--payment-token-amount is outside the supported numeric range: {parse error}`.
  7. `ensure_sufficient_balance(required, normalizedSymbol)` (child `wallet balance --chain 196`;
     called even when required is 0). If it fails with InsufficientBalanceError:
     `resolve_current_deposit_info(userAgentId)` (child `agent get-agents --agent-ids …`) → None →
     error `failed to resolve the funding address`; else print
     `success(build_task_creation_funding_result(insufficient, deposit, --service-token-address))`
     and **return (exit 0, nothing created)**. Any other balance error is **ignored** and
     creation continues.
  8. `resolve_wallet_by_agent_id(userAgentId)` → `(accountId, address)`.
  9. `v2::create_and_fund::execute` (v2/create_and_fund.rs:191):
     a. `POST /priapi/v1/aieco/task/createAndFundConfirmStatus` (`post_with_identity`, header
        `agenticId: userAgentId`) body (sorted):
        `{"amount":<--payment-token-amount raw>,"chainId":196,"providerAgentId","serviceId","sessionCert","tokenSymbol":<normalized>}`;
        error context `createAndFundConfirmStatus failed`.
     b. Parse confirmation: strings (trimmed non-empty) `jobId, taskSalt, provider, receiver,
        evaluator, currency, recipient, amount, hook, hookData, salt` →
        `createAndFundConfirmStatus response missing {name}`; u64 (number or numeric string)
        `submitWindow, disputeWindow, evaluateWindow, completedWindow` →
        `createAndFundConfirmStatus response missing or invalid {name}`; `expiredAt` i64/u64/
        numeric string → RFC3339 (`chrono to_rfc3339`, e.g. `2026-08-03T17:32:48+00:00`),
        or an RFC3339 string passthrough, else
        `createAndFundConfirmStatus response missing or invalid expiredAt`
        (`invalid expiredAt: {ts}` for out-of-range ints).
     c. audit `user/task_create_and_fund_confirmed` (`jobId=…`, `agentId=…`, `providerAgentId=…`, `serviceId=…`).
     d. `sign_escrow{chain_id:196, provider: <hook> (hook address deliberately placed in the provider slot),
        receiver, arbitrator: evaluator, currency, escrow_contract: recipient, amount (minimal units),
        submit_window, dispute_window, arbitration_window: evaluateWindow,
        termination_window: completedWindow, hook, hook_data, salt, expired_at}` →
        TEE calls `POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash` and
        `POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg` (payment group);
        error context `EIP-3009 create-and-fund signing failed`.
     e. `POST /priapi/v1/aieco/task/createAndFund` (`post_mutation_with_identity`, no retry) body (sorted):
        `{"categoryCode"?,"chainId":196,"description","descriptionSummary"?,"jobId","minCreditScore"?,"paymentTokenAmount","paymentTokenSymbol","providerAgentId","serviceId","serviceParams":<raw string>,"serviceTokenAddress","serviceTokenAmount","sessionCert","signature","taskSalt","title":<sanitised>,"validAfter":<u64>,"validBefore":<u64>,"visibility":1|0}`
        (`invalid signed validAfter`/`invalid signed validBefore` if the signer output is not u64);
        error context `createAndFund failed or returned an unknown network result for jobId={jobId}`.
     f. Response must have `jobId == confirmation.jobId` (`createAndFund response missing jobId` /
        `createAndFund returned jobId {x}, expected {y}`), non-null `uopData`
        (`createAndFund response missing uopData`), `type == 201`
        (`unexpected bizType {t}; expected 201`).
     g. Copy `--file` attachments → `<HOME>/task/{jobId}/attachments/` (manifest).
     h. Guide/Consent (only if `--service-guide`): write guide + prepared consent files;
        failure context `task local Guide/Consent configuration could not be persisted`.
     i. `a2a_binding::bind_job_provider_to_current_runtime_required(jobId)` (local `okx-a2a`
        binding, other group); failure → abort consent, error
        `cannot bind task to the current AI runtime; creation was not broadcast: …`.
     j. `sign_uop_and_broadcast_full(uopData, …, bizType 201)` → `POST /priapi/v1/aieco/task/broadcast`
        body `{"accountId","address","bizContext":{"bizType":201,"jobId"},"chainIndex":"196","extraData","sessionCert"}`.
        Failure → rollback binding, abort consent, error
        `broadcast failed or returned an unknown result for jobId={jobId}: broadcast failed: …`;
        null receipt → `broadcast returned no receipt`.
  10. If guide given: `activate_prepared_consent(jobId)`; failure prints to stderr
      `[guide-execution] task created, but Guide Consent could not be activated: {err}` and
      statuses become `none`.
  11. audit `user/task_create_and_fund_submitted` (args `jobId=…`, `agentId=…`,
      `paymentTokenSymbol=…`, `paymentTokenAmount=…`, `designatedProvider=…`, `bizType=201`,
      `guideStatus=active|none`, `consentStatus=active|none`, `txHash=<broadcast.txHash|pending>`).
- Output (`data`, sorted):
  ```json
  {"decision":"ready",
   "nextAction":[{"id":"watch_task","params":{"jobId":"<jobId>"},"recommend":true}],
   "payload":{"attachments":[<manifest entries>],"bizType":201,"broadcast":<data[0] passthrough>,
     "consentStatus":"active|none","guideStatus":"active|none",
     "initialLifecycle":{"display":<initial_creation_display>,"taskType":"one_time"},
     "jobId":"<jobId>","paymentTokenAmount":"<flag raw>","paymentTokenSymbol":"USDT|USDG",
     "providerAgentId":"<flag>","runtimeBound":true,"status":"broadcast_submitted","type":201},
   "phase":"creation","reason":"broadcast_submitted"}
  ```
  Funding-blocked variant (exit 0): the `funding_required` object from shared helper §3.
- Errors: all exit 1 via `{"ok":false,"error":…}` (messages above); coded
  `UNSAFE_JOB_PATH_COMPONENT` if the backend jobId is unsafe for the attachments dir.
- Side effects: **FUND-MOVING** — `POST /priapi/v1/aieco/task/createAndFund` (signed EIP-3009
  escrow authorization) + `POST /priapi/v1/aieco/task/broadcast`. Local writes: task dir,
  attachments, guide/consent, audit.
- Nondeterminism: `jobId`, `taskSalt`, signatures, `validBefore`, broadcast receipt (`txHash`,
  `orderId`, `pkgId`, `bizUniqKey`), probe file name, file timestamps.
- Parity test cases:
  1. `onchainos agent create-task --title "" --description d --provider-agent-id 1 --payment-token-symbol USDT --payment-token-amount 1 --service-id s --service-token-address 0x1 --service-token-amount 1` → `{"ok":false,"error":"title must not be empty"}` exit 1 — SAFE (no HTTP).
  2. `… --payment-token-symbol BTC …` → `unsupported token: BTC; only USDT (USD₮0) and USDG are supported` — SAFE.
  3. `… --payment-token-amount 0.0000001 …` → `--payment-token-amount must be a decimal string with at most 6 decimal places` — SAFE.
  4. `… --chain-id 1 …` → `--chain-id currently supports X Layer (196) only` — SAFE.
  5. Full valid invocation with funded wallet — UNSAFE (moves funds).

### `onchainos agent create-subscribe`  (hidden: no)
- Handler: `AgentCommand::CreateSubscribe` (agent_commerce/mod.rs:149, dispatch 1490) →
  `run_task(TaskCommand::CreateSubscribe)` (mod.rs:1885: `parse_bool_or_int(auto_renew,"auto-renew")`)
  → `create_subscribe::handle_create_subscribe` (create_subscribe.rs:185).
- Options:
  | flag | type | required / default | notes |
  |---|---|---|---|
  | `--service-id` | String | required | non-empty |
  | `--use-trial` | bool, `ArgAction::Set`, `BoolishValueParser` | default `false` | **takes a value**: `true/false` (clap Boolish also accepts `yes/no/on/off/1/0/t/f/y/n`, case-insensitive); help lists `[possible values: true, false]` |
  | `--service-params` | String | default `""` | not validated; sent verbatim |
  | `--service-token-amount` | String | required | non-empty |
  | `--service-token-address` | String | required | non-empty |
  | `--auto-renew` | String | required | `0|1|true|false` exactly |
  | `--title` | String | required | 1..=30 chars |
  | `--description` | String | required | 1..=4096 chars |
  | `--file` | Vec<String> repeatable | optional | |
  | `--provider-agent-id` | String | required | non-blank |
  | `--service-guide` / `--service-guide-hash` / `--guide-consent-json` | String | optional | |
  | `--service-interval` | String | default `month` | passthrough |
  | `--format` | String | default `""` | accepted, ignored |
  (The internal `TaskCommand` variant declares `--use-trial` as a bare flag; the public CLI
  uses the value-taking `AgentCommand` form above.)
- Auth: jwt-required + EIP-712 terms signature (TEE) + session-key uop signing; requires sessionCert.
- Steps:
  1. `--auto-renew` → `parse_bool_or_int` (`--auto-renew must be 0, 1, true, or false; got "{s}"`).
  2. `CreateSubscribeParams::validate` in order: `--service-id is required`,
     `--service-token-amount is required`, `--service-token-address is required` (all
     `is_empty`, not trimmed), `--auto-renew must be 0 (off) or 1 (on), got {n}` (unreachable),
     `--provider-agent-id is required; use the confirmed Service result unchanged` (trimmed),
     `--title is required`, `--title exceeds 30 characters`, `--description is required`,
     `--description exceeds 4096 characters`, attachments, guide/consent:
     `guide-driven signal execution requires --service-guide`,
     `parse_draft` errors,
     `guide-driven signal execution requires --guide-consent-json, including {} when the Guide declares no consent fields`,
     `--guide-consent-json must be a JSON object: …`, credential key check.
  3. `ensure_tokens_refreshed` (wrapped `` session has expired; run `onchainos wallet login` first: {e} ``);
     sessionCert check `current login has no sessionCert; run `onchainos wallet login` again before create-subscribe`.
  4. `resolve_user_agent` then `select_subscription_agent_id`.
  5. `subscription_config::execution_mode(userAgentId, serviceId)` must exist, else
     `subscription execution configuration is required; based on the Service Guide, save signal_only for pure signals or guide_direct for automatic copy-trading before create-subscribe`.
     Mode `guide_direct` without guide consent →
     `automatic copy-trading requires --service-guide and --guide-consent-json before create-subscribe`.
  6. Duplicate check: `GET /priapi/v1/aieco/task/subscribe/my` (`get_with_agent_id`; error
     `failed to check existing subscriptions: {e}`; parse error `failed to parse existing subscriptions: {e}`);
     rows with `buyerAgentId == userAgentId && status == 1`, sorted by jobId; first row whose
     `serviceId == --service-id` → `CliDuplicateSubscription` → stdout
     `{"ok":false,"data":{"blockedReason":"duplicate-subscription","existingSubscription":{"jobId","providerAgentId","restoreListeningAvailable":true,"serviceId","statusDescription":"The subscription is active.","statusLabel":"Active"},"nextAfterUserChoice":["restore-listening"],"userFacingPrompt":"Service {serviceId} already has a subscription task, jobId: {jobId}. It cannot be created again. Would you like to restore listening?"}}`, exit 1.
  7. Balance: `required = --service-token-amount.parse::<f64>()` (failure → 0); if `> 0`:
     resolve symbol via `POST /api/v6/dex/market/token/basic-info` body
     `[{"chainIndex":"196","tokenContractAddress":<--service-token-address>}]` (core ApiClient,
     `data[0].tokenSymbol`); failure → skip the balance check silently. Then
     `ensure_sufficient_balance(required, symbol)`; InsufficientBalanceError → deposit info
     (`failed to resolve the funding address` if None) → print funding result
     (`operation:"task_creation"`, token address = `--service-token-address`) and **exit 0**;
     other errors propagate (exit 1).
  8. `resolve_wallet_by_agent_id(userAgentId)`.
  9. `v2::create_subscription::execute` (v2/create_subscription.rs:109):
     a. `POST /priapi/v1/aieco/task/subscribe/providerConfirmStatus` (`post_with_identity`) body
        `{"autoRenew":0|1,"providerAgentId","serviceId","sessionCert","subId":0,"useTrial":bool}`;
        context `providerConfirmStatus failed`.
     b. empty/non-object data → `providerConfirmStatus returned empty terms; the service may not support subscription`;
        missing/empty `typedData` object → `providerConfirmStatus response missing typedData`;
        `terms` = response minus `typedData`; `effectiveUseTrial = response.useTrial` (bool) else requested.
     c. `sign_typed_data(typedData, address)` (gen-msg-hash + sign-msg); context `EIP-712 subscription terms signing failed`.
     d. `POST /priapi/v1/aieco/task/subscribe/createSubscription` (`post_mutation_with_identity`) body
        `{"autoRenew","description","deviceList":null,"providerAgentId","serviceId","serviceInterval","serviceParams","serviceTokenAddress","serviceTokenAmount","sessionCert","terms":{…},"termsSig","title","useTrial":<effective>}`;
        context `createSubscription failed or returned an unknown network result`.
     e. Validate: trimmed `jobId` (`createSubscription response missing jobId`), `uopData`
        (`createSubscription response missing uopData`), `type == 204` (`unexpected bizType {t}; expected 204`).
     f. Copy attachments; write prepared Guide/Consent (context
        `subscription local execution configuration could not be persisted`).
     g. `bind_job_provider_to_current_runtime(jobId)` best-effort (no failure).
     h. Broadcast (`bizType 204`); null → rollback/abort + `broadcast returned no receipt for jobId={jobId}`;
        error → rollback/abort + `broadcast failed or returned an unknown result for jobId={jobId}: …`.
  10. `probe_offline_replay_capability()` (local `okx-a2a capabilities --json`).
  11. Activate consent if guide (stderr `[guide-execution] subscription created, but Guide Consent could not be activated: {err}` on failure).
  12. audit `user/create_subscribe` (`jobId, agentId, serviceId, useTrial, autoRenew, bizType=204, guideStatus, consentStatus, txHash`).
- Output (`data`, sorted):
  ```json
  {"decision":"ready","nextAction":[{"id":"watch_task","params":{"jobId":"<jobId>"},"recommend":true}],
   "payload":{"attachments":[…],"autoRenew":0|1,"bizType":204,"broadcast":<data[0]>,
     "consentStatus":"active|none","executionProfileSaved":<bool = guide&consent active>,
     "guideStatus":"active|none","jobId":"<jobId>",
     "offlineReplayFixCommands":[…]  /* only when offlineReplaySupported=false */,
     "offlineReplaySupported":<bool>,"providerAgentId":"<flag>","runtimeBound":true,
     "serviceId":"<flag>","status":"broadcast_submitted","type":204,"useTrial":<effective>},
   "phase":"creation","reason":"broadcast_submitted"}
  ```
- Errors: exit 1 (messages above); duplicate → `{"ok":false,"data":…}` exit 1; clap errors exit 2.
- Side effects: **FUND-MOVING** — `POST /priapi/v1/aieco/task/subscribe/createSubscription`
  (signed subscription terms authorising recurring charges) + `POST /priapi/v1/aieco/task/broadcast`.
- Nondeterminism: jobId, signatures, broadcast receipt, `offlineReplaySupported` (depends on
  local okx-a2a install / `ONCHAINOS_SKIP_A2A_PREFLIGHT`).
- Parity test cases:
  1. `onchainos agent create-subscribe --service-id s --service-token-amount 1 --service-token-address 0xA --auto-renew yes --title t --description d --provider-agent-id 1` → `--auto-renew must be 0, 1, true, or false; got "yes"` exit 1 — SAFE.
  2. `… --auto-renew 1 --title 0123456789012345678901234567890 …` (31 chars) → `--title exceeds 30 characters` — SAFE.
  3. `… --auto-renew 1 --guide-consent-json {} …` (no guide) → `guide-driven signal execution requires --service-guide` — SAFE.
  4. Valid, logged in, no saved execution config → `subscription execution configuration is required; …` (after token refresh + get-my-agents) — SAFE (read-only).
  5. Full valid run — UNSAFE.

### `onchainos agent service-detail`  (hidden: no)
- Handler: `AgentCommand::ServiceDetail(ServiceDetailArgs)` → `service_detail::handle_service_detail` (service_detail.rs:21).
- Options: `--sid <SID>` String required; `--agentic-id <AGENT_ID>` String required.
- Auth: jwt-required (`agenticId` = `--agentic-id`); no sessionCert.
- Steps:
  1. `sid.trim()` empty → `--sid must not be blank`; `agentic_id.trim()` empty → `--agentic-id must not be blank`.
  2. `POST /priapi/v1/aieco/task/asp/service/search` via `raw_post_with_identity`, bytes
     `{"limit":1,"sid":"<trimmed sid>"}` (sid as JSON **string**), `Content-Type: application/json`,
     explicit `Content-Length`, header `agenticId: <trimmed>`; no DoH/token retry.
  3. `data.services` must be an array (`service detail response is missing services`); pick first
     element whose `sid` (string trimmed, or integer) equals the sid, else
     `` service detail returned no Service matching sid `{sid}` ``.
- Output: `data` = the matched service object verbatim (keys sorted).
- Errors: exit 1.
- Side effects: read-only.
- Nondeterminism: none beyond backend data.
- Parity test cases: `onchainos agent service-detail --sid " " --agentic-id 1` → `--sid must not be blank` (SAFE); `onchainos agent service-detail --sid 33803 --agentic-id <userAgentId>` (SAFE).

### `onchainos agent task-create-prepare`  (hidden: no)
- Handler: `AgentCommand::TaskCreatePrepare` → `task_create_prepare::handle_task_create_prepare` (task_create_prepare.rs:243).
- Options: `--sid <SID>` String required.
- Auth: jwt-optional in the sense that a missing login is reported as a success decision;
  subsequent calls are jwt-required.
- Steps:
  1. If `current_account_xlayer_address()` is None OR `ensure_tokens_refreshed()` errors →
     success `{"decision":"blocked","nextAction":[{"id":"login","recommend":true}],"payload":{},"phase":"login_validation","reason":"login_required"}`, exit 0.
  2. `resolve_user_agent()` error (any) → success
     `{"decision":"blocked","nextAction":[{"id":"register_user_agent","recommend":true}],"payload":{},"phase":"identity_validation","reason":"user_identity_required"}`.
  3. `sid.trim()` empty → error `--sid must not be blank`.
  4. Child process `<exe> agent service-detail --sid <sid> --agentic-id <userAgentId>`
     (→ the HTTP call of `service-detail`); spawn failure `failed to invoke service-detail: …`;
     non-zero exit → `service-detail failed: {child stderr trimmed}` (child errors are on stdout,
     so usually `service-detail failed: `); stdout not JSON → `failed to parse service-detail JSON output: …`;
     `ok != true` → `service-detail returned a non-success response`; no `data` →
     `service-detail response is missing data`; not an object →
     `service-detail response data must be a Service object`.
  5. `serviceId` and `serviceType` required (scalar_string) →
     `` selected Service is missing required field `serviceId` `` / `serviceType`.
  6. `serviceType` equals `A2MCP` (ASCII case-insensitive) → success
     `{"decision":"ready","nextAction":[{"id":"invoke_a2mcp","recommend":true}],"payload":{"schemaVersion":1,"serviceSnapshot":<raw service>},"phase":"service_routing","reason":"a2mcp_service_confirmed"}`.
  7. Not `A2A` → success `{"decision":"blocked","nextAction":[{"id":"stop","recommend":true}],"payload":<compact service>,"phase":"service_validation","reason":"unsupported_service_type"}`.
  8. `normalize_service` = `compact_task_service_for_ai` (the computed `autoTradePreflight`
     is added first but then **dropped** by the compaction; its only effect is a local
     filesystem probe of tool plugins).
  9. If compact `supportSubscription == true`: `GET /priapi/v1/aieco/task/subscribe/my`
     (duplicate check as in create-subscribe, errors `failed to check existing subscriptions: …`);
     match on serviceId → require non-blank `jobId`/`title` (`` blocking buyer subscription is missing required field `jobId` `` / `title`) →
     success `{"decision":"blocked","nextAction":[{"id":"restore_subscription","recommend":true},{"id":"stop","recommend":false}],"payload":{"jobId","restoreListeningAvailable":true,"title"},"phase":"subscription_validation","reason":"duplicate_subscription"}`
     (if restoreListeningAvailable were false: nextAction `[{"id":"stop","recommend":true}]`).
  10. `required = effective_fee`: subscription → `subscriptionInfo.feeAmount` (number or numeric
      string, finite ≥ 0) else `selected subscription Service has no subscription fee`;
      otherwise `feeAmount` else `selected Service has no feeAmount`; bad values
      `` selected Service field `{field}` must be a number `` / `must be a non-negative number`.
  11. If trial available (`subscriptionInfo.supportTrial == true` and `freeTrial > 0`) or
      `required == 0` → success `{"decision":"ready","nextAction":[{"id":"open_create_playbook","recommend":true}],"payload":<compact service>,"phase":"creation","reason":"all_checks_passed"}`.
  12. `feeTokenSymbol` required; `ensure_sufficient_balance(required, feeTokenSymbol)` (child
      `wallet balance --chain 196`): Ok → same `all_checks_passed` output; InsufficientBalance →
      deposit info (`failed to resolve the funding address`), `feeToken` required, output the
      `funding_required` bundle (operation `task_creation`, tokenAddress = feeToken), exit 0;
      other error → `failed to check the selected Service balance: {e}`.
- Output: one of the decision objects above in `data`.
- Errors: exit 1 for hard errors listed.
- Side effects: read-only (child processes, local probe only).
- Nondeterminism: none (backend data only).
- Parity test cases: logged-out environment → `login_required` decision (SAFE);
  `onchainos agent task-create-prepare --sid 33803` logged in (SAFE); `--sid " "` → `--sid must not be blank` after identity checks (SAFE).

### `onchainos agent service-param-update`  (hidden: no)
- Handler: `AgentCommand::ServiceParamUpdate` (agent_commerce/mod.rs:188, dispatch 1530 — calls
  directly, not via run_task) → `service_param_update::handle` (service_param_update.rs:135).
- Options: `<JOB_ID>` positional required; `--agent-id` String required; `--task-type`
  value_enum required, only `single`; `--request-id` String required; `--round` u8 with clap
  range 1..=3 (out of range → clap error exit 2); `--service-params` String required.
- Auth: jwt-required (`agenticId` = `--agent-id` raw), sessionCert injected.
- Steps:
  1. `validate_inputs`: `jobId is required`, `--agent-id is required`, `--request-id is required`
     (trim-empty checks), `--round must be between 1 and 3`,
     `--service-params must contain the complete updated parameters` (trim-empty),
     JSON parse → `--service-params must be one complete JSON value: {serde error}`.
  2. State root: env `OKX_AGENT_TASK_HOME` → `<it>/task-params`, else
     `~/.okx-agent-task/task-params` (**not** ONCHAINOS_HOME); `create_dir_all`
     (`create task-params state directory {path}`).
  3. State file `<root>/<lowercase hex of jobId UTF-8 bytes>.json`; lock `<hex>.lock`
     (created, `fs2` exclusive blocking lock held until exit; errors `open task-params lock {path}`,
     `lock task-params round state`).
  4. Read state (missing → empty; `read task-params state {path}` / `parse task-params state {path}`).
  5. `validate_round` (request id trimmed): existing entry with same requestId → if round or
     parsed params differ → `requestId was already used with different round or serviceParams`;
     else **duplicate** → success (no HTTP):
     `{"decision":"ready","nextAction":[{"id":"send_task_params_response","params":{"jobId","requestId","round","serviceParams":<parsed>,"taskType":"single"},"recommend":true}],"payload":{"backendUpdated":true,"duplicate":true,"jobId","requestId","round","successfulRounds":<n>},"phase":"task_params_update","reason":"duplicate_request_already_confirmed"}`.
     Else ≥3 successes → `three successful task-parameter updates already completed; provider must accept or decline`;
     `round != n+1` → `--round must be the next successful round ({n+1})`.
  6. `POST /priapi/v1/aieco/task/{jobId}/serviceParam` (`post_mutation_with_identity`) body
     `{"serviceParams":<compact re-serialisation of the parsed JSON (keys sorted)>,"sessionCert"}`;
     error context `serviceParam update failed or returned an unknown network result; do not send task_params_response`.
     Non-null `data` → `serviceParam update returned unexpected data; do not send task_params_response: {data}`.
  7. Append `{requestId, round, serviceParams}` and write
     `to_vec_pretty({"successfulUpdates":[{"requestId","round","serviceParams"}]})` to `<hex>.json.tmp` then rename.
- Output: `{"decision":"ready","nextAction":[{"id":"send_task_params_response","params":{"jobId","requestId","round","serviceParams","taskType":"single"},"recommend":true}],"payload":{"backendUpdated":true,"duplicate":false,"jobId","requestId","round","serviceParams","successfulRounds":<n>,"taskType":"single"},"phase":"task_params_update","reason":"backend_update_confirmed"}`.
- Errors: exit 1; clap exit 2.
- Side effects: state-changing (server) + local state file.
- Nondeterminism: none.
- Parity test cases: `onchainos agent service-param-update job-1 --agent-id 1 --task-type single --request-id r --round 1 --service-params "plain"` → `--service-params must be one complete JSON value: expected value at line 1 column 1` (SAFE); `--round 4` → clap error exit 2 (SAFE); valid call — UNSAFE.

### `onchainos agent subscription-execution-config-set`  (hidden: no)
- Handler: `AgentCommand::SubscriptionExecutionConfigSet` → `run_task` short-circuit (mod.rs:1829,
  before `TaskApiClient::new()`) → `handle_subscription_execution_config_set` (mod.rs:415).
- Options: `--service-id` String required; `--execution-mode` String required;
  `--replace` bool flag (SetTrue).
- Auth: jwt-required (only through the child `get-my-agents` process).
- Steps: `resolve_user_agent`; `select_subscription_agent_id`; parse mode (trim; `signal_only` |
  `guide_direct`, else `--execution-mode must be signal_only or guide_direct`);
  `subscription_config::save_execution_mode(agent, service, mode, replace)`: path validation
  (`invalid subscription AgentId or ServiceId`), load existing (read/parse errors), outcome
  `created` (no file) / `repaired` (file without executionMode) / `replaced` (`--replace`) / error
  `subscription automatic-copy preference is already {mode}; use --replace only after a new user confirmation`;
  write pretty file (`failed to persist subscription execution configuration at {path}: {err}`).
- Output: `{"agentId","executionMode":"signal_only|guide_direct","outcome":"created|repaired|replaced","serviceId","storage":"local"}`.
- Errors: exit 1.
- Side effects: local-only (`<HOME>/autotrade/subscription-config/{agentId}/{serviceId}.json`).
- Nondeterminism: `updatedAtMs` in the file.
- Parity test cases: `… --service-id svc-1 --execution-mode bogus` → `--execution-mode must be signal_only or guide_direct` (after identity lookup; SAFE); same with `signal_only` twice (second → "already signal_only" error) — SAFE (local).

### `onchainos agent subscribe-device-update`  (hidden: no)
- Handler: `AgentCommand::SubscribeDeviceUpdate` → `device_routing::handle_subscribe_device_update` (device_routing.rs:721).
- Options: `--job-id` Option<String>; `--device-list` Option<String> (CSV); `--items`
  Option<String> (JSON array) with clap `conflicts_with_all = ["job_id","device_list"]`.
- Auth: jwt-required, sessionCert injected.
- Steps:
  1. `normalize_items`: `--items` present → parse `Vec<{jobId, deviceList?}>` (error
     `--items must be a JSON array of {jobId, deviceList} objects: {serde error}`; any empty jobId →
     `--items entries must each carry a non-empty jobId`); else `--job-id` required
     (`either --job-id (form A) or --items (form B) is required`; empty →
     `--job-id must not be empty`), deviceList = CSV split on `,`, trimmed, blanks dropped
     (omitted/empty → `[]` = clear).
  2. `validate_items_len`: 0 → `no subscriptions to update: provide --job-id or a non-empty --items array`;
     >100 → `too many items ({n}); at most 100 subscriptions per batch`.
  3. `ensure_tokens_refreshed` (`` session has expired; run `onchainos wallet login` first: {e} ``); `resolve_user_agent`.
  4. `POST /priapi/v1/aieco/task/subscribe/device/batchUpdate` (`post_with_identity`, header
     `agenticId: userAgentId`) body `{"items":[{"deviceList":[…],"jobId":"…"}],"sessionCert":"…"}`;
     transport/backend error → `subscribe-device-update failed: {e}`; `data !== true` →
     `subscribe-device-update failed: backend did not confirm the update (data != true): {compact data}`.
- Output: `{"updated":[{"deviceList":[…],"jobId":"…"}]}` (echo of what was written).
- Errors: exit 1; clap conflict exit 2.
- Side effects: state-changing (server).
- Nondeterminism: none.
- Parity test cases: `onchainos agent subscribe-device-update` (no args) → `either --job-id (form A) or --items (form B) is required` (SAFE); `--items '[]'` → `no subscriptions to update: …` (SAFE); `--job-id 0xA --items '[…]'` → clap error exit 2 (SAFE); `--job-id <sub> --device-list d1,d2` — UNSAFE.

### `onchainos agent subscribe-offline-update`  (hidden: no)
- Handler: `AgentCommand::SubscribeOfflineUpdate` → `offline_receive::handle_subscribe_offline_update` (offline_receive.rs:89).
- Options: `--job-id` String required; `--flag` String required.
- Auth: jwt-required, sessionCert injected.
- Steps: flag exactly `"0"`/`"1"` else
  `--flag must be 0 (keep offline backlog) or 1 (discard offline backlog); got "{raw}"`;
  `--job-id must not be empty`; `ensure_tokens_refreshed` (wrapped); `resolve_user_agent`;
  `select_subscription_agent_id`; `POST /priapi/v1/aieco/task/subscribe/{jobId}/setOfflineReceiveFlag`
  (`post_with_identity`) body `{"offlineReceiveFlag":0|1,"sessionCert"}`; error
  `subscribe-offline-update failed: {e}`; success iff `data` is null or `true`, else
  `subscribe-offline-update failed: backend did not confirm the update: {compact data}`;
  then `probe_offline_replay_capability()`.
- Output: `{"jobId","offlineReceiveFlag":0|1,"offlineReplayFixCommands":[…] /*only if unsupported*/,"offlineReplaySupported":bool}`.
- Errors: exit 1.
- Side effects: state-changing (server).
- Nondeterminism: `offlineReplaySupported` depends on local okx-a2a.
- Parity test cases: `--job-id 0xS --flag 2` → flag error (SAFE); `--job-id "" --flag 1` → `--job-id must not be empty` (SAFE); valid → UNSAFE.

### `onchainos agent device-list`  (hidden: no)
- Handler: `AgentCommand::DeviceList` → `device_routing::handle_device_list` (device_routing.rs:402).
- Options: `--page` i64 default `1`; `--page-size` i64 default `20`.
- Auth: jwt-required (JWT + agenticId, **no sessionCert**).
- Steps: `ensure_tokens_refreshed` (wrapped message); `resolve_user_agent`;
  `fetch_device_list_snapshot(client, agent, page, page_size)` (shared §7; paginates to completion).
- Output: `{"list":[{"deviceId","deviceName","isThisDevice","lastOnlineLocal","lastOnlineTime"}],"page","pageSize","thisDeviceId","total"}`.
- Errors: exit 1 (transport, `81001` for pageSize > 100 surfaced as `Wallet API error (code=81001): …`).
- Side effects: read-only.
- Nondeterminism: `lastOnlineLocal` depends on the machine timezone; `thisDeviceId`.
- Parity test cases: `onchainos agent device-list` (SAFE); `--page 0 --page-size 0` → normalised to 1/20 in request and echo (SAFE); `--page-size 500` → backend error (SAFE).

### `onchainos agent mark-failed`  (hidden: no)
- Handler: `AgentCommand::MarkFailed` → `negotiate::mark_failed` (negotiate.rs:190).
- Options: `<JOB_ID>` positional required; `--provider <PROVIDER_AGENT_ID>` required.
- Auth: anonymous (no HTTP).
- Steps: load `negotiate-state.json` (on any error — missing or unparsable — start a fresh state
  `{jobId, providers:[], currentIndex:0, createdAt:now, page:0}` and create the dir); append the
  provider to `failedProviders` if absent; write pretty JSON; audit
  `user/provider_marked_failed` (`jobId=…`, `provider=…`); print; if
  `designated-provider.json` agentId equals the provider → delete it.
- Output (plain text, stdout, one line): `✓ Marked provider {provider} as failed negotiation (job={jobId})`.
- Errors: exit 1 only on filesystem errors (`{"ok":false,"error":"<io error>"}`).
- Side effects: local-only (`<HOME>/task/{jobId}/negotiate-state.json`, designated-provider.json).
- Nondeterminism: `createdAt` for new state.
- Parity test cases: `onchainos agent mark-failed job-x --provider 42` (SAFE, local); run twice → no duplicate entry (SAFE).

### `onchainos agent set-payment-mode`  (hidden: no)
- Handler: `AgentCommand::SetPaymentMode` → `accept::handle_set_payment_mode` (accept.rs:61).
- Options: `<JOB_ID>` required; `--payment-mode` Option<String>; `--token-symbol` Option<String>;
  `--token-amount` Option<String>.
- Auth: jwt-required + session-key uop signing.
- Steps:
  1. `resolve_wallet_and_agent_for_task(job, None)` (GET #1 `/priapi/v1/aieco/task/{jobId}`, `get_with_identity`).
  2. GET #2 same path with `agenticId = buyerAgentId`; `Status::from_int(status or -1)` must be
     `Created`, else `current task status is {Debug}; setting the payment mode is only allowed in `created` status`.
  3. Mode: flag → `PaymentMode::from_str` (unknown → escrow); absent → task `paymentMode`
     (0/unknown → escrow). `x402` → `legacy task-based A2MCP/x402 payment was removed; use the invoke_a2mcp direct-invocation flow`.
     `already_set = flag given && current == target && current != None`.
  4. `--token-symbol`/`--token-amount` required here: `set-payment-mode requires --token-symbol` /
     `set-payment-mode requires --token-amount`.
  5. amount (f64, parse failure → 0) > 0 → `ensure_sufficient_balance(amt, sym)`; InsufficientBalance →
     funding-blocked envelope (action `Payment mode update`) → `{"ok":false,"data":…}` exit 1.
  6. If not already set: `POST /priapi/v1/aieco/task/{jobId}/setPaymentMode` (`post_with_identity`) body
     `{"paymentMode":1,"sessionCert"}` → `sign_uop_and_broadcast(resp.uopData, bizType=resp.type)` →
     `POST /priapi/v1/aieco/task/broadcast`; audit `user/payment_mode_set` (`jobId, agentId, paymentMode, txHash`).
     Else audit `user/payment_mode_already_set`.
- Output:
  * not already set: stdout line `✓ Payment mode set to escrow; awaiting on-chain confirmation...`
    followed by `{"confirming":true,"message":"setPaymentMode(escrow) complete.","next":"Wait for the on-chain confirmation, then the system will proceed automatically."}` — **exit 0**.
  * already set: line `✓ Payment mode is already escrow; skipping on-chain call.` then
    `{"ok":true,"data":{"alreadySet":true,"next":"Payment mode already on-chain. Call next-action with `event=job_payment_mode_changed` in --message to get the script; then wait for the provider to submit their apply on-chain before confirm-accept.","paymentMode":"escrow"}}`.
- Errors: exit 1.
- Side effects: state-changing on-chain (task payment mode) via `POST …/setPaymentMode` + broadcast.
- Nondeterminism: txHash.
- Parity test cases: job not in `created` → status error (SAFE, 2 GETs); missing `--token-amount` → error after GETs (SAFE); valid → UNSAFE.

### `onchainos agent confirm-accept`  (hidden: no)
- Handler: `AgentCommand::ConfirmAccept` → `accept::handle_confirm_accept(client, job, None)` (accept.rs:201).
- Options: `<JOB_ID>` required.
- Auth: jwt-required + EIP-3009 TEE signature + session-key uop signing.
- Steps:
  1. `resolve_wallet_and_agent_for_task` (GET #1 task detail).
  2. GET #2 task detail (`get_with_identity`, buyerAgentId): non-empty strings
     `providerAgentId` (`task {job} has no providerAgentId; cannot confirm-accept`),
     `tokenSymbol` (`task {job} has no tokenSymbol`), `tokenAmount` (`task {job} has no tokenAmount`);
     `paymentMode`; `tokenAddress`.
  3. paymentMode None → `task has no payment mode set yet (paymentMode=0); first run:\n  onchainos agent set-payment-mode {job} --payment-mode escrow --token-symbol <sym> --token-amount <amt>\nthen wait for the job_payment_mode_changed system notification and re-run confirm-accept`;
     not escrow → `confirm-accept only supports A2A escrow; legacy task-based A2MCP/x402 payment was removed`.
  4. amount > 0 → balance check; InsufficientBalance → funding-blocked (action `Task payment`), exit 1.
  5. `GET /priapi/v1/aieco/task/{jobId}/providerConfirmStatus?providerAgentId={p}&tokenSymbol={sym}&amount={amt}`
     (values **not URL-encoded**; `get_with_agent_id`) — error `providerConfirmStatus query failed: {e}`;
     required `amount` (`` providerConfirmStatus response missing `amount` ``), `currency`
     (`` providerConfirmStatus response missing `currency` ``).
  6. GET #3 task detail; `tokenAddress` lowercased non-empty and ≠ lowercased currency →
     `token mismatch: providerConfirmStatus returned currency={currency} but task tokenAddress={addr}. Please check that the negotiated token matches the task's published token (--token-symbol).`
  7. `escrow.*`: strings `escrowContract, provider, arbitrator, receiver, expiredAt, hook, hookData, salt`
     (`response missing field: {key}`), u64 `submitWindow, disputeWindow, arbitrationWindow,
     terminationWindow` (`failed to parse {key} as u64: {s}`); `expiredAt` numeric string → RFC3339.
  8. `sign_escrow{…provider: escrow.provider…}` (gen-msg-hash + sign-msg).
  9. `POST /priapi/v1/aieco/task/{jobId}/accept` (`post_with_identity`) body
     `{"providerAddress","providerAgentId","sessionCert","signatureData":{"signature","validAfter","validBefore"},"tokenAmount","tokenSymbol"}`.
  10. `sign_uop_and_broadcast_with_payment` → `POST /priapi/v1/aieco/task/broadcast` with
      `bizContext:{"bizType","jobId","paymentVerify":{"authorizationType":"receive","chainIndex":196,"from","nonce","signature","to","tokenAddress":<currency>,"validAfter","validBefore","value"}}`.
  11. audit `user/confirm_accept_completed`; `negotiate::cleanup(job)` (errors ignored).
- Output: **nothing on stdout** on success (exit 0).
- Errors: exit 1 (`{"ok":false,"error":…}`) / funding-blocked `{"ok":false,"data":…}`.
- Side effects: **FUND-MOVING** — `POST /priapi/v1/aieco/task/{jobId}/accept` + broadcast.
- Nondeterminism: signature, nonce, txHash.
- Parity test cases: job with paymentMode 0 → set-payment-mode hint error (SAFE); valid → UNSAFE.

### `onchainos agent reject-apply`  (hidden: no)
- Handler: `AgentCommand::RejectApply` → `reject_apply::handle_reject_apply` (reject_apply.rs:19).
- Options: `<JOB_ID>` required; `--agent-id` Option<String>.
- Auth: jwt-required, sessionCert.
- Steps: `resolve_wallet_and_agent_for_task(job, --agent-id)` (GET task with the explicit or
  looked-up id; requires local wallet for `buyerAgentAddress`); `POST /priapi/v1/aieco/task/{jobId}/user/reject`
  body `{"sessionCert"}` (object `{}` + injection) with `agenticId: buyerAgentId`; response ignored;
  audit `user/reject_apply_submitted`.
- Output (plain text): `✓ Reject-apply submitted; task remains in `created` state.` and
  `  agentId: {buyerAgentId}`.
- Errors: exit 1.
- Side effects: state-changing (server).
- Parity test cases: unknown job → backend error (SAFE-ish, request fails); valid → UNSAFE.

### `onchainos agent reject`  (hidden: no)
- Handler: `AgentCommand::Reject` → `run_task(TaskCommand::Reject)` → inline bail (mod.rs:2017).
- Options: `<JOB_ID>` required; `--reason` String required (ignored).
- Auth: none (no HTTP).
- Output/Errors: always `{"ok":false,"error":"direct reject is disabled by Refund; run `onchainos agent refund-prepare {job} --reason <user-authored-reason>` and execute only the returned confirmed action"}`, exit 1.
- Side effects: none. Parity: `onchainos agent reject 0xabc --reason x` (SAFE).

### `onchainos agent task-visibility-update`  (hidden: no)
- Handler: `AgentCommand::TaskVisibilityUpdate` → `visibility::handle_task_visibility_update` (visibility.rs:46).
- Options: `--job-id` String required; `--visibility` value_enum `public|private` required.
- Auth: jwt-required, sessionCert.
- Steps: `--job-id must not be empty` (trim); `resolve_user_agent`;
  `POST /priapi/v1/aieco/task/{jobId}/setVisibility` (`post_mutation_with_identity`) body
  `{"sessionCert","visibility":1|0}` (**public=1, private=0** — inverse of create-task);
  error `task-visibility-update failed: {e}`; success iff data null or `true`, else
  `task-visibility-update failed: backend did not confirm the update: {compact}`.
- Output: `{"payload":{"jobId","targetVisibility":"public|private","targetVisibilityValue":1|0},"updated":true}`.
- Side effects: state-changing (server). Parity: `--job-id " " --visibility public` → error (SAFE); valid → UNSAFE.

### `onchainos agent my-tasks`  (hidden: no)
- Handler: `AgentCommand::MyTasks` → `my_tasks::handle_my_tasks` (my_tasks.rs:297).
- Options: `--task-type` enum `all|subscription|one-time` default `all`; `--status-type` u8
  range 0..=2 default 0; `--page` u32 ≥1 default 1; `--page-size` u32 1..=100 default 10.
- Auth: jwt-required (JWT + agenticId, no sessionCert).
- Steps:
  1. agent = `resolve_agent_id("", 1)` (child `get-my-agents` without role); blank → CodedError
     → stdout `{"error":"no User identity found on this account; register a User identity before listing tasks","errorCode":"user_identity_required","nextSteps":[{"action":"register_user_identity","label":"Register a User identity"}],"ok":false}`, exit 1.
  2. backend statusType = `status_type == 0 ? 1 : status_type`.
  3. Subscriptions (if all|subscription), then one-time (if all|one-time), sequentially:
     `GET /priapi/v1/aieco/task/subscribe/my?page={p}&pageSize={ps}&statusType={bst}` and
     `GET /priapi/v1/aieco/task/my?page={p}&pageSize={ps}&statusType={bst}` (`get_with_agent_id`);
     errors `failed to fetch subscription tasks: {e}` / `failed to fetch one-time tasks: {e}`.
  4. Subscription page → `subscription_ops::enrich_buyer_subscription_page` (keeps rows with
     `buyerAgentId == agent`, re-serialises each row as `SubscriptionInfo` — unknown backend
     fields dropped, defaults filled — adding `statusName` (INIT/CREATED/ACTIVE/REJECTED/DISPUTED/
     COMPLETED/CLOSED/EXPIRED/FAILED/UNKNOWN_n), `statusLabel`, `statusDescription`,
     `deviceList` (null = default-all), `categoryCodes`, `thisDeviceReceives`; page gets local
     `thisDeviceId`/`thisDeviceName`; parse error `failed to parse subscription page: {e}`).
     One-time rows with integer `status` get `statusName` (`Status::from_int(..).as_str()`,
     e.g. `init`, `completed`, `failed`, `status_17`), `statusLabel`, `statusDescription`
     (other fields preserved).
  5. Page validation (label `subscription`/`one-time`): `{label} task page must be a JSON object`,
     `{label} task page is missing numeric total|totalNoCondition|page|pageSize`,
     `{label} task page is missing list array`.
  6. Summary per type: status 0 → `{"active":total,"all":totalNoCondition}`, 1 → `{"active":total}`,
     2 → `{"ended":total}`.
- Output: `{"oneTimeTasks"?:{"hasNext":page*pageSize<total,"list":[…],"page","pageSize","statusType":1|2,"total","totalNoCondition"},"query":{"page","pageSize","statusType","taskType":"all|subscription|one-time"},"subscriptions"?:{same + "thisDeviceId","thisDeviceName"},"summary":{"oneTime"?:…,"subscription"?:…}}`
  (page/pageSize in sections come from the backend; in `query` from the flags; section
  `statusType` is 1 for 0/1 and 2 for 2).
- Side effects: read-only. Nondeterminism: thisDeviceId/Name.
- Parity test cases: `onchainos agent my-tasks` (SAFE); `--task-type one-time --status-type 2 --page 2 --page-size 5` (SAFE); `--status-type 3` → clap error (SAFE).

### `onchainos agent payment`  (hidden: no)
- Handler: `AgentCommand::Payment` → `query::handle_payment` (query.rs:13).
- Options: `<JOB_ID>` required; `--agent-id` Option<String>.
- Auth: jwt-required (sessionCert as query param).
- Steps: agent = `--agent-id` or first role-1 agent (child process) or `""`;
  `GET /priapi/v1/aieco/task/{jobId}` (`get_with_identity`).
- Output (plain text, 7 lines):
  ```
  Payment invoice
    jobId:        {jobId}
    Amount:       {tokenAmount|?} {tokenSymbol|?}
    Token:        {tokenSymbol|?} (XLayer)
    Recipient:    {providerAgentAddress|?}
    Payment mode: {none|escrow|legacy-x402-disabled}
    Chain:        xlayer (chainId=196)
  ```
  (`?` when the field is missing or not a JSON string.)
- Side effects: read-only. Parity: `onchainos agent payment <jobId>` (SAFE).

### `onchainos agent task-attach`  (hidden: no)
- Handler: `AgentCommand::TaskAttach` → `run_task` loop (mod.rs:2051) → `attachments::handle_task_attach` per file (attachments.rs:68).
- Options: `<JOB_ID>` required; `--file <FILE_PATHS>` repeatable, `required = true`.
- Auth: jwt-required (JWT + agenticId, no sessionCert).
- Steps (per `--file`, in order; stops at first error, earlier files remain copied):
  `resolve_agent_id("",1)`; `GET /priapi/v1/aieco/task/{jobId}` (`get_with_agent_id`);
  `status >= 2` → `task status is "{status_name}" (status={n}); attachments can only be added when the task is in created or accepted state`
  (missing status → -1 passes); `file not found: {path}`; size > 100 MiB →
  `file too large: {x.x} MB (max 100 MB). Please compress or resize the file before adding it as an attachment.`;
  `invalid file path: {path}`; `attachments_dir` (coded `UNSAFE_JOB_PATH_COMPONENT`); mkdir; `dedup_dest`; copy.
- Output (plain text per file):
  ```
  ✓ Attachment saved
    jobId: {jobId}
    file:  {dest}

  🛑 NEXT STEP (MUST NOT SKIP): the file is saved LOCALLY only — it has NOT been sent to the provider yet.
     If a sub session exists for this job (task already has a matched provider),
     you MUST run `okx-a2a session send` to notify the sub session:

     okx-a2a session send --job-id {jobId} --to-agent-id <peer agentId from sub session> --content "[ATTACHMENT_ADDED] {dest}" --json  ← exact prefix, do NOT change

     If NO sub session exists yet (task not matched with a provider), skip the dispatch —
     the sub session will pick up the file automatically via list-attachments when it starts.
  ```
- Side effects: local-only file copy (read-only HTTP).
- Parity test cases: `onchainos agent task-attach <createdJob> --file ./a.txt` (SAFE); missing file → `file not found: ./nope` (SAFE, after GET).

### `onchainos agent list-attachments`  (hidden: no)
- Handler: `AgentCommand::ListAttachments` → `attachments::handle_task_attachments` (attachments.rs:147).
- Options: `<JOB_ID>` required.
- Auth: anonymous (no HTTP).
- Output: `serde_json::to_string_pretty(&Vec<String>)` printed raw (**no envelope**): `[]` or
  `[\n  "<path1>",\n  "<path2>"\n]`; unsafe job id also yields `[]`.
- Side effects: read-only local. Parity: `onchainos agent list-attachments 0xabc` → `[]` (SAFE); `onchainos agent list-attachments ../x` → `[]` (SAFE).

### Dispatch-only notes (handlers owned by other groups)
`run_task` (mod.rs:1826) also dispatches `asp-match`, `task-service-select`, `set-asp`, `reset-asp`,
`user-reject` (asp_ops.rs), `complete` (v2/complete.rs; `run_task` prints `success(result)`),
`refund-prepare`/`refund-execute` (refund.rs), `close` (close.rs), `claim-auto-refund`,
`subscribe-cancel`/`start-autorenew`/`subscribe-reject`/`subscribe-detail`/`subscribe-cost`/
`my-subscriptions` (subscription_ops.rs), `subscription-list` (subscription_list.rs). Their
arg structs `TaskServiceSelectArgs{service_match: ServiceMatchArgs (flatten), --agentic-id Option, --format default "json"}`
are declared in mod.rs:57 but behaviour is documented by those groups.

---

## Endpoints (classification)

| Method path | class | used by |
|---|---|---|
| POST /priapi/v1/aieco/task/createAndFundConfirmStatus | state (backend allocates jobId/taskSalt) | create-task |
| POST /priapi/v1/aieco/task/createAndFund | funds | create-task |
| POST /priapi/v1/aieco/task/broadcast | funds | create-task, create-subscribe, set-payment-mode, confirm-accept |
| POST /priapi/v1/aieco/task/subscribe/providerConfirmStatus | read (terms quote) | create-subscribe |
| POST /priapi/v1/aieco/task/subscribe/createSubscription | funds | create-subscribe |
| GET /priapi/v1/aieco/task/subscribe/my | read | create-subscribe, task-create-prepare, post-login finalize |
| GET /priapi/v1/aieco/task/subscribe/my?page&pageSize&statusType | read | my-tasks |
| GET /priapi/v1/aieco/task/my?page&pageSize&statusType | read | my-tasks |
| GET /priapi/v1/aieco/task/subscribe/{jobId} | read | post-login autotrade precheck |
| POST /priapi/v1/aieco/task/asp/service/search | read | service-detail (and task-create-prepare via child) |
| POST /priapi/v1/aieco/task/{jobId}/serviceParam | state | service-param-update |
| GET /priapi/v5/wallet/agentic/agent/device-list?page&pageSize | read | device-list, post-login prepare |
| POST /priapi/v1/aieco/task/subscribe/device/batchUpdate | state | subscribe-device-update, post-login finalize |
| POST /priapi/v1/aieco/task/subscribe/{jobId}/setOfflineReceiveFlag | state | subscribe-offline-update |
| GET /priapi/v1/aieco/task/{jobId} | read | set-payment-mode, confirm-accept, reject-apply, payment, task-attach |
| GET /priapi/v1/aieco/task/{jobId}/providerConfirmStatus?providerAgentId&tokenSymbol&amount | read | confirm-accept |
| POST /priapi/v1/aieco/task/{jobId}/setPaymentMode | state | set-payment-mode |
| POST /priapi/v1/aieco/task/{jobId}/accept | funds | confirm-accept |
| POST /priapi/v1/aieco/task/{jobId}/user/reject | state | reject-apply |
| POST /priapi/v1/aieco/task/{jobId}/setVisibility | state | task-visibility-update |
| POST /priapi/v1/aieco/task/{jobId}/reset/asp | state | flow_negotiate::provider_reject (next-action) |
| POST /api/v6/dex/market/token/basic-info | read | create-subscribe (symbol lookup) |
| POST /priapi/v5/wallet/agentic/pre-transaction/gen-msg-hash | read | create-task, create-subscribe, confirm-accept (signing helpers) |
| POST /priapi/v5/wallet/agentic/pre-transaction/sign-msg | funds (TEE signature authorising transfer/terms) | create-task, create-subscribe, confirm-accept |
| POST /priapi/v5/wallet/agentic/auth/refresh | auth | every jwt-required command (via ensure_tokens_refreshed) |

Child processes (their HTTP is owned by other groups): `agent get-my-agents`, `agent get-agents`,
`wallet balance --chain 196`, `agent service-detail`, `agent service-list`; local binaries:
`okx-a2a` (`capabilities --json`, `session query|create|send`, runtime binding).

## External hosts
No host other than the OKX base URL is contacted directly by this partition. Shared transport
(core group) may, on network failure, use DoH failover whose "pilot" binary is fetched from
`https://static.okx.com/upgradeapp/tools/pilot`, `https://static.coinall.ltd/upgradeapp/tools/pilot`,
`https://okg-pub-hk.oss-cn-hongkong.aliyuncs.com/upgradeapp/tools/pilot`,
`https://static.jingyunyilian.com/upgradeapp/tools/pilot` (doh/binary.rs). `--dev` base URL
`https://beta.okex.org`.

## Open questions
1. Whether `POST /priapi/v1/aieco/task/createAndFundConfirmStatus` persists a job record server-side (classified `state` conservatively) and whether `subscribe/providerConfirmStatus` is side-effect free (classified `read`).
2. `set-payment-mode` prints a `confirming` JSON but exits 0 (the doc comment claims exit 2) — preserved as observed.
3. `confirm-accept` prints nothing on success — confirm this is intended before reproducing.
4. create-task silently continues when the balance child process fails for a reason other than insufficient balance, and calls the balance check even for a 0 amount (a missing token row with required 0 makes `build_funding_bundle_for_address` fail with `funding required amount must be greater than zero`).
5. `scoped_watch_autotrade_precheck*`, `bind_*_consent_context`, `fetch_post_login_subscriptions` have no caller in 4.6.3; assumed dead code.
6. `%Z` rendering of `chrono::Local` in `lastOnlineLocal` (offset like `+08:00`) is platform-dependent; parity tests should pin TZ.
7. `mark-failed` / negotiate state paths do not sanitise jobId (path traversal possible upstream); a port may choose to keep or harden this.
