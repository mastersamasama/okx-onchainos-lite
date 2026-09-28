# g11a-agent-dispatch — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the complete `onchainos agent …` command enum (`AgentCommand`, including hidden and debug-only variants)
and its dispatcher `agent_commerce::run`, the global behaviour applied to every `agent` invocation, the
**chat** handlers (`file-upload`, `file-download`, `sensitive-words`, `message-eligible`, `system-config`,
`heartbeat`, `wakeup-notify`), the **a2mcp-probe** command family (6 sub-commands), and every handler that is
implemented inline in `agent_commerce/mod.rs` (`next-action` + its freshness gate, `cache-notify`, `cache-rating`,
`task-deliverable-save/list` wrappers, `trade-kit-readiness`, `autotrade-*` wrappers).
All other `agent` sub-commands are only *dispatched* here; their behaviour is specified by the owning partitions
(identity, task/user, task/asp, task/evaluator, task/common, autotrade …). The dispatch table (§2) names the
handler for every one of them.

All paths below are relative to `upstream/cli/src/`.

---

## Sources read

Owned (read fully, including tests):

| file | lines |
|---|---|
| `commands/agent_commerce/mod.rs` | 5373 |
| `commands/agent_commerce/chat/mod.rs` | 405 |
| `commands/agent_commerce/a2mcp_probe/mod.rs` | 412 |
| `commands/agent_commerce/a2mcp_probe/contract.rs` | 464 |
| `commands/agent_commerce/a2mcp_probe/flow.rs` | 890 |
| `commands/agent_commerce/a2mcp_probe/method.rs` | 591 |
| `commands/agent_commerce/a2mcp_probe/free_result.rs` | 295 |
| `commands/agent_commerce/a2mcp_probe/probe.rs` | 68 |
| `commands/agent_commerce/a2mcp_probe/tests.rs` | 1407 |

Consulted for callees / global behaviour (not owned; only summarised): `main.rs` (316, full), `output.rs` (450, full),
`wallet_api.rs` (2874; envelope unwrap, `post_authed*`, `get_authed*`, `get_authed_bytes_with_headers`,
`post_authed_multipart_with_headers`, `force_refresh_access_token`, `auth_refresh`), `client.rs` (2469;
`anonymous_headers`, `jwt_headers`, `augment_auth_error_msg`, `CLIENT_VERSION`), `commands/agentic_wallet/auth/mod.rs`
(1827; `ensure_tokens_refreshed`, `report_post_login_device`), `commands/payment/a2mcp.rs` (1635),
`commands/payment/http_carrier.rs` (379), `commands/payment/state.rs` (423), `commands/payment/quote.rs` (1630;
`prepare_a2mcp_candidates`, `refresh_a2mcp_candidate_balances`, `preflight_balances`, `DecimalResolver`),
`commands/payment/payment_flow.rs` (`resolve_chain_and_payer`), `commands/payment/dispatcher.rs` (`decode_payment_blob`),
`funding.rs` (527), `home.rs` (500), `endpoints.rs` (65), `audit.rs` (1405; `agent_sub`), `doh/manager.rs` (UA string),
`task/common/network/task_api_client.rs` (459), `task/common/mod.rs` (1608), `task/common/state_machine.rs` (1241),
`task/common/prefilled_notify.rs` (71, full), `task/common/prefilled_rating.rs` (66, full), `task/common/util.rs`
(`validate_job_id`), `task/common/pending_v2.rs` (command enum), `task/asp/mod.rs` (command enums), `task/arbitration.rs`
(`blocked_result`, `progression`), `task/user/refund.rs` (`fetch_authoritative_refund_context*`),
`task/common/autotrade/{mod,trade_kit,grants,executor,guide}.rs` (signatures / constants / error strings),
`commands/portfolio.rs`, `commands/agentic_wallet/chain.rs`, `Cargo.toml` / `Cargo.lock`.

---

## 0. Cross-cutting conventions (govern byte parity for everything in this file)

1. **JSON key order.** `serde_json 1.0.149` is compiled **without** `preserve_order` (Cargo.lock: serde_json deps are
   itoa, memchr, serde, serde_core, zmij — no indexmap). Consequences:
   - every `serde_json::Value` object (anything built with `json!`, anything parsed from a backend/merchant response,
     anything passed through `serde_json::to_value`) serialises with keys **sorted by byte order**, recursively;
   - structs serialised *directly* (not via `Value`) keep declaration order. In this partition that is:
     the output envelope `JsonOutput{ok,data,error,notifications}`, `ProbeDecision{phase,decision,reason,nextAction,payload}`,
     `Action{id,actionLabel,recommend,params?}`, and files written with `to_vec_pretty(&struct)`.
   - `json!(vec_of_structs)` / `json!(struct)` goes through `to_value` → the struct's keys become **sorted**
     (e.g. `FieldConstraint` inside a probe payload is emitted as `carrier?,description?,name,required,type`).
   - backend `data` passthrough (chat commands) is therefore re-emitted with sorted keys, compact.
2. **Envelope** (`output.rs`): success `{"ok":true,"data":<data>}` (+ `"notifications":[…]` only when
   `payment_notify` queued events — never in this partition), error `{"ok":false,"error":"<msg>"}` where
   `<msg>` = `format!("{e:#}")` (anyhow chain, outer context first, joined by `": "`). One line of compact JSON + `\n`
   on stdout; `ONCHAINOS_PRETTY=1` → `to_string_pretty` (2-space indent). Non-ASCII emitted as raw UTF-8.
3. **Exit codes** (`main.rs:248-315`): 0 success; 1 any error (standard error envelope); 2 `CliConfirming` /
   `WalletPreviewConfirming` and clap usage errors (clap prints plain text on stderr); 3 `CliSetupRequired`;
   `CliBespokeExit(n)` → exit n **without** printing an envelope (handler already printed its bespoke JSON —
   only `autotrade-grant-check` uses it). `CliFundingBlocked` / `CliDuplicateSubscription` → `{"ok":false,"data":…}`
   exit 1; `sink::CodedError` → `{"ok":false,"error","errorCode",…}` exit 1; `InsufficientBalanceError` → special
   envelope exit 1 (not produced by handlers in this partition).
4. **Plain-text outputs.** `next-action` prints a *prompt string* with `println!` (no envelope); `cache-notify` /
   `cache-rating` print `OK`; `task-deliverable-list` handlers print their own output.
5. `DEBUG_LOG = cfg!(feature = "debug-log")` is **false** in release builds — all `if DEBUG_LOG { eprintln!… }`
   diagnostics are absent. Only the unconditional `eprintln!`s documented below reach stderr.

---

## 1. Global `agent` behaviour

### 1.1 Chain forced to X Layer (`main.rs:184-193`)
After `Cli::parse()`, if the top-level command is `Agent`, `cli.chain = Some("xlayer")` **unconditionally** —
any user-supplied global `--chain` is silently ignored (the flag is still accepted by clap and still shown in
`--help`). `Context::new(&cli)` therefore always carries `chain_override = "xlayer"`. Agent internals use
`XLAYER_CHAIN_INDEX = "196"` independently. Nothing in this partition reads `ctx`.

### 1.2 Other global flags
- `--dev` (global, **hidden**, bool) → `endpoints::set_dev_mode(true)` → base URL `https://beta.okex.org`
  instead of the compiled `ONCHAINOS_COMPILED_BASE_URL`; also disables DoH failover (`base_url_is_custom()`).
- `--chain <CHAIN>` (global) — accepted, ignored for `agent` (see 1.1).
- Before parsing: `home::self_heal_permissions()`; on error `eprintln!("Warning: {e}")` (core-owned).

### 1.3 Pre-dispatch maintenance (`agent_commerce/mod.rs:1403-1418`)
Every `agent` invocation (every sub-command, including `a2mcp-probe`, chat and `next-action`) first runs, ignoring
all results/errors:
1. `task::common::autotrade::executor::reconcile_terminal_journals(4, 100 ms)` (executor.rs:2326) — local-only:
   scans `$ONCHAINOS_HOME/autotrade/terminal-journal/*/*.json`, repairs outcome files; may `eprintln!`
   `[autotrade] unreadable terminal journal {path:?}: {error}`.
2. `executor::flush_all_due(1)` (executor.rs:2472) — retries at most 1 due pending result notice from
   `$ONCHAINOS_HOME/autotrade/pending-outcome-notifications/`; delivery goes through `okx_a2a::user_notify_scoped*`
   (spawns the local `okx-a2a` runtime; no OKX HTTP).
3. `executor::cleanup_expired_tickets(8)` (executor.rs:2430) — deletes expired one-time permits under
   `$ONCHAINOS_HOME/autotrade/one-time-permits/`.
4. `autotrade::delivery_queue::flush_due(1, 100 ms)` (delivery_queue.rs:619) — may dispatch one queued delivery via
   `okx_a2a::session_send*` (local runtime).
With an empty/fresh `ONCHAINOS_HOME` (directories absent) all four are no-ops (`Ok(0)`). A lite implementation
needs these only if it implements autotrade; otherwise they may be no-ops.

### 1.4 Audit log
`main.rs` calls `audit::log("cli", "agent <sub>", ok, elapsed, redacted_args, err)` after every command
(local file under `$ONCHAINOS_HOME`, core-owned). Sub label from `audit::agent_sub` (audit.rs:464): the kebab name,
`a2mcp-probe <sub>`, `asp status|list-tasks`, `dispute <discriminant>`, `common <discriminant>`,
`pending-decisions-v2`. `next-action` additionally logs `provider|user|evaluator/next_action_received`
(see §4.8). `TaskApiClient` logs `api/get` rows. Not part of stdout parity.

### 1.5 Auth mechanism used by this partition (core-owned; summarised for the lite re-implementation)
- `commands::agentic_wallet::auth::ensure_tokens_refreshed()` (auth/mod.rs:132) → returns a valid JWT access token:
  1. `wallet_store::load_session()` → `session_key_expire_at` (unix seconds string); empty/unparseable/`now >= exp`
     → `Err("session expired, please login again: onchainos wallet login")`.
  2. keyring blob `refresh_token` / `access_token` (either missing/empty → same error).
  3. refresh token JWT `exp` passed → stderr `Session expired. Please log in again: onchainos wallet login` + same error.
  4. if either token expires within 60 s (`TOKEN_EXPIRY_MARGIN_SECS`) → `POST /priapi/v5/wallet/agentic/auth/refresh`
     body `{"refreshToken":"<rt>"}` (anonymous headers) → store rotated tokens → return new access token.
  5. else return stored access token.
- `WalletApiClient` (wallet_api.rs): 30 s timeout; `User-Agent: OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`
  (Rust `std::env::consts::OS/ARCH`, e.g. `windows`/`x86_64`); headers from `ApiClient::jwt_headers(token)`:
  `Content-Type: application/json`, `ok-client-version: 4.6.3`, `Ok-Access-Client-type: agent-cli`,
  `platform: agent-cli`, `device-id: <cached id>` (if available), `device-name: <device name>`,
  `Authorization: Bearer <jwt>`; extra headers (`agenticId`) inserted after (silently skipped if not a valid header
  value). URL = `<base>` + path + query string built by `build_query_string` (pairs with **empty values dropped**;
  value form-urlencoded (`application/x-www-form-urlencoded` rules: space→`+`), key verbatim; `?k=v&k2=v2`).
  DoH failover (retry once on connect/timeout or `should_failover_on_response`) is core-owned.
- Response handling (`handle_response`): HTTP ≥ 500 → `Wallet API server error (HTTP {code}): {raw body}`;
  body not JSON → `failed to parse wallet API response as JSON (HTTP {code}): {first 500 bytes}`;
  `code` ≠ 0/"0" → `ApiCodeError{code,msg,http_status}` displayed as `Wallet API error (code={code}): {msg}`
  (msg = first of `msg`/`errorMessage`/`error_message`/`message`/`detailMsg`, else raw body ≤200 chars + `…`
  with stderr `[WalletAPI] no msg field in error response (HTTP {n}), raw body: {body}`; code `50114` gets
  `. You are not logged in, run \`wallet login\` to sign into OKX Agentic Wallet.` appended); else returns `data`.
- `get_authed*` / `post_authed*` retry **once** after `force_refresh_access_token()` when the error is an
  invalid-token error (codes `10001`, `10008`, `53017`, `130100031`, or text `invalid access token` /
  `access token invalid`). Multipart upload and byte download have **no** token retry.
- Login flow coupling: the wallet login (`auth/mod.rs:621 report_post_login_device`) calls this partition's
  `chat::fetch_heartbeat(client, token, 196)` with a 4 s timeout, non-fatal. A lite login must replicate that
  heartbeat to keep device registration parity.

---

## 2. Dispatch table (every `AgentCommand` variant, `agent_commerce/mod.rs:16-1401`, dispatcher `run` 1403-3132)

Legend: **H** = `hide = true` (not in `cli-tree.json`); **D** = compiled only with `debug_assertions` (absent from
release binaries); aliases are clap `visible_alias` unless noted. "inline" = handler body lives in `mod.rs` and is
specified in §4 of this file. Clients: `TAC` = `TaskApiClient::new()` created in the arm.

| CLI path (`onchainos agent …`) | H | handler (fn path) | file:line |
|---|---|---|---|
| `a2mcp-probe probe\|confirm-free\|refresh-balance\|funding\|resume-after-funding\|prepare-payment` | | `a2mcp_probe::run` | agent_commerce/a2mcp_probe/mod.rs:390 |
| `asp status` / `asp list-tasks` | | `task::asp::run_provider(ProviderQueryCommand.into())` → `ProviderCommand::Status`/`List` | task/asp/mod.rs:272 |
| `create` | | `identity::create` | identity/mutations.rs:71 |
| `update` | | `identity::update` | identity/mutations.rs:81 |
| `get` | H | `identity::get` | identity/queries.rs:40 |
| `get-my-agents` | | `identity::get_my_agents` | identity/queries.rs:30 |
| `get-agents` | | `identity::get_agents` | identity/queries.rs:35 |
| `pre-check` | | `identity::precheck` | identity/mutations.rs:76 |
| `get-by-address` | H | `identity::get_by_address` | identity/queries.rs:65 |
| `activate` | | `identity::activate` | identity/mutations.rs:87 |
| `deactivate` | | `identity::deactivate` | identity/mutations.rs:93 |
| `upload` | | `identity::upload` | identity/mutations.rs:98 |
| `search` | | `identity::search` | identity/queries.rs:45 |
| `service-list` | | `identity::service_list` | identity/queries.rs:50 |
| `service-match` | | `identity::service_match` | identity/service_match.rs:24 |
| `feedback-submit` (alias `feedbacksubmit`) | | `identity::feedback_submit` | identity/mutations.rs:103 |
| `feedback-list` | | `identity::feedback_list` | identity/queries.rs:55 |
| `task-feedback` | | `identity::task_feedback` | identity/queries.rs:60 |
| `xmtp-sign` | H | `identity::xmtp_sign` | identity/mutations.rs:108 |
| `validate-listing` | H | `identity::validate_listing` | identity/validate.rs:24 |
| `create-task` | | `task::user::run_task(TaskCommand::Create{…})` | task/user/mod.rs:1826 |
| `create-subscribe` | | `run_task(T::CreateSubscribe{…})` | task/user/mod.rs:1826 |
| `service-param-update <JOB_ID>` | | `task::user::service_param_update::handle(&mut TAC, …)` | task/user/service_param_update.rs:135 |
| `subscribe-cancel <SUB_ID>` | | `run_task(T::SubscribeCancel)` | task/user/mod.rs:1826 |
| `start-autorenew <SUB_ID>` | | `run_task(T::StartAutorenew)` | task/user/mod.rs:1826 |
| `subscribe-reject <SUB_ID>` | | `run_task(T::SubscribeReject)` | task/user/mod.rs:1826 |
| `subscribe-detail <SUB_ID>` | | `run_task(T::SubscribeDetail)` | task/user/mod.rs:1826 |
| `subscribe-cost` | | `run_task(T::SubscribeCost)` | task/user/mod.rs:1826 |
| `subscribe-device-update` | | `run_task(T::SubscribeDeviceUpdate)` | task/user/mod.rs:1826 |
| `subscribe-offline-update` | | `run_task(T::SubscribeOfflineUpdate)` | task/user/mod.rs:1826 |
| `subscription-execution-config-set` | | `run_task(T::SubscriptionExecutionConfigSet)` | task/user/mod.rs:1826 |
| `device-list` | | `run_task(T::DeviceList)` | task/user/mod.rs:1826 |
| `asp-match` | | `run_task(T::AspMatch)` | task/user/mod.rs:1826 |
| `task-service-select` | | `run_task(T::TaskServiceSelect)` | task/user/mod.rs:1826 |
| `service-detail` | | `run_task(T::ServiceDetail)` | task/user/mod.rs:1826 |
| `task-create-prepare` | | `run_task(T::TaskCreatePrepare)` | task/user/mod.rs:1826 |
| `set-asp <JOB_ID>` | | `run_task(T::SetAsp)` | task/user/mod.rs:1826 |
| `reset-asp <JOB_ID>` | | `run_task(T::ResetAsp)` | task/user/mod.rs:1826 |
| `user-reject <JOB_ID>` | | `run_task(T::UserReject)` | task/user/mod.rs:1826 |
| `mark-failed <JOB_ID>` | | `run_task(T::MarkFailed)` | task/user/mod.rs:1826 |
| `status <JOB_ID>` | | `task::common::query::handle_status(&mut TAC, job, agent_id or "", AGENT_ROLE_USER=1)` | task/common/query.rs:184 |
| `lifecycle <JOB_ID>` | | `task::common::lifecycle::handle_lifecycle(&mut TAC, job, agent_id or "")` | task/common/lifecycle.rs:265 |
| `tasks` (alias `list`) | | `task::common::query::handle_list(&mut TAC, status, page, limit, agent_id or "", 1)` | task/common/query.rs:307 |
| `my-subscriptions` | | `run_task(T::MySubscriptions)` | task/user/mod.rs:1826 |
| `refund-list` | | `task::refund_list::handle_refund_list(&mut TAC, role, scope, page, page_size, agent_id or "")` | task/refund_list.rs:132 |
| `refund-detail <JOB_ID>` | | `task::refund_list::handle_refund_detail(&mut TAC, job, role, agent_id or "")` | task/refund_list.rs:202 |
| `my-tasks` | | `run_task(T::MyTasks)` | task/user/mod.rs:1826 |
| `subscription-list` | | `run_task(T::SubscriptionList)` | task/user/mod.rs:1826 |
| `task-visibility-update` | | `run_task(T::TaskVisibilityUpdate)` | task/user/mod.rs:1826 |
| `active-tasks` | | `task::common::query::handle_active_tasks(&mut TAC, role, include_terminal)` | task/common/query.rs:670 |
| `arbitration-list` | | `task::arbitration::handle_arbitration_list(&mut TAC, agent_id, page, page_size)` | task/arbitration.rs:739 |
| `arbitration-detail <JOB_ID>` | | `task::arbitration::handle_arbitration_detail(&mut TAC, job, agent_id)` | task/arbitration.rs:807 |
| `set-payment-mode <JOB_ID>` | | `run_task(T::SetPaymentMode)` | task/user/mod.rs:1826 |
| `confirm-accept <JOB_ID>` | | `run_task(T::ConfirmAccept)` | task/user/mod.rs:1826 |
| `designated-route` | | `task::common::handle_designated_route(provider, service_id)` | task/common/mod.rs:919 |
| `complete <JOB_ID>` | | `run_task(T::Complete)` | task/user/mod.rs:1826 |
| `reject <JOB_ID>` | | `run_task(T::Reject)` | task/user/mod.rs:1826 |
| `refund-prepare <JOB_ID>` | | `run_task(T::RefundPrepare)` | task/user/mod.rs:1826 |
| `refund-execute <JOB_ID>` | | `run_task(T::RefundExecute)` | task/user/mod.rs:1826 |
| `close <JOB_ID>` | | `run_task(T::Close)` | task/user/mod.rs:1826 |
| `payment <JOB_ID>` | | `run_task(T::Payment)` | task/user/mod.rs:1826 |
| `asp-claimable` | | `run_provider(ProviderCommand::Claimable)` | task/asp/mod.rs:272 |
| `asp-claim-rewards` | | `run_provider(ProviderCommand::ClaimRewards)` | task/asp/mod.rs:272 |
| `my-agents` | | `task::common::handle_my_agents(role)` | task/common/mod.rs:933 |
| `gate-check` | | `task::common::handle_preflight(role)` | task/common/mod.rs:1067 |
| `communication-check` | | `task::common::handle_communication_check()` | task/common/mod.rs:1076 |
| `prepare-create` | | `task::common::handle_prepare_create(…)` | task/common/mod.rs:1082 |
| `profile <AGENT_ID>` | | `task::common::handle_profile(agent_id)` | task/common/mod.rs:644 |
| `apply <JOB_ID>` | | `run_provider(ProviderCommand::Apply)` | task/asp/mod.rs:272 |
| `deliver <JOB_ID>` | | `run_provider(ProviderCommand::Deliver)` | task/asp/mod.rs:272 |
| `trade-kit-readiness` | | **inline** (§4.11) → `autotrade::trade_kit::probe_runtime` | mod.rs:2042 |
| `autotrade-grant-check` | | **inline** (§4.12) → `autotrade::grants::check_grant` | mod.rs:2060 |
| `autotrade-grant-write` | H,D | **inline** → `autotrade::grants::write_grant` | mod.rs:2089 |
| `autotrade-guide-consent-update` | | **inline** (§4.13) → `autotrade::guide::update_active_consent_values` | mod.rs:2251 |
| `autotrade-guide-consent-new` | | **inline** (§4.13) → `autotrade::guide::create_active_consent_from_guide` | mod.rs:2269 |
| `autotrade-consent-request` | H | **inline** (§4.14) → `executor::report_delivery` | mod.rs:2107 |
| `autotrade-once-authorize` | H | **inline** → `executor::authorize_one_time` | mod.rs:2180 |
| `autotrade-guide-prepare` | H | **inline** → `executor::prepare_guide_direct` | mod.rs:2149 |
| `autotrade-direct-claim` | H | **inline** → `executor::claim_guide_direct` | mod.rs:2139 |
| `autotrade-direct-finalize` | H | **inline** → `executor::finalize_direct` | mod.rs:2160 |
| `autotrade-outcome-flush` | H | **inline** → `executor::flush` | mod.rs:2193 |
| `autotrade-delivery-report` | H | **inline** → `executor::report_delivery` | mod.rs:2198 |
| `autotrade-cap-adjust-request` | H | **inline** (§4.15) | mod.rs:2213 |
| `agree-refund <JOB_ID>` | | `run_provider(ProviderCommand::AgreeRefund)` | task/asp/mod.rs:272 |
| `asp-reject <JOB_ID>` | | `run_provider(ProviderCommand::AspReject)` | task/asp/mod.rs:272 |
| `accept-job-by-provider <JOB_ID>` | | `run_provider(ProviderCommand::AcceptJobByProvider)` | task/asp/mod.rs:272 |
| `decline-job-by-provider <JOB_ID>` | | `run_provider(ProviderCommand::DeclineJobByProvider)` | task/asp/mod.rs:272 |
| `accept-subscription <JOB_ID>` | | `run_provider(ProviderCommand::AcceptSubscription)` | task/asp/mod.rs:272 |
| `decline-subscription <JOB_ID>` | | `run_provider(ProviderCommand::DeclineSubscription)` | task/asp/mod.rs:272 |
| `subscribe-active` | | `task::asp::subscription::handle_active(&mut TAC, agent_id)` | task/asp/subscription.rs:327 |
| `subscribe-agree-refund <JOB_ID>` | | `task::asp::subscription::handle_agree_refund` | task/asp/subscription.rs:397 |
| `subscribe-asp-claim <JOB_ID>` | | `task::asp::subscription::handle_asp_claim` | task/asp/subscription.rs:449 |
| `subscribe-dispute <JOB_ID>` | | `task::asp::subscription::handle_dispute` | task/asp/subscription.rs:505 |
| `claim-auto-refund <JOB_ID>` | | `run_task(T::ClaimAutoRefund)` | task/user/mod.rs:1826 |
| `reject-apply <JOB_ID>` | | `run_task(T::RejectApply)` | task/user/mod.rs:1826 |
| `user-notify` | | `task::common::okx_a2a::user_notify(&content, image_path, true)` | task/common/okx_a2a.rs:383 |
| `funding-notice` | | `task::common::funding_notice::execute(args)` (has hidden arg `--image-dir`) | task/common/funding_notice.rs:172 |
| `cache-notify` | H | **inline** (§4.9) → `prefilled_notify::save` | mod.rs:1895 |
| `cache-rating` | H | **inline** (§4.10) → `prefilled_rating::save` | mod.rs:1905 |
| `task-attach <JOB_ID>` | | `run_task(T::TaskAttach)` | task/user/mod.rs:1826 |
| `list-attachments <JOB_ID>` | | `run_task(T::ListAttachments)` | task/user/mod.rs:1826 |
| `task-deliverable-save` | | **inline wrapper** (§4.16) → `task::common::deliverables::handle_save` | mod.rs:1922 |
| `task-deliverable-list` | | **inline wrapper** (§4.16) → `deliverables::handle_list` / `handle_list_all` | mod.rs:1953 |
| `claim-auto-complete <JOB_ID>` | | `run_provider(ProviderCommand::ClaimAutoComplete)` | task/asp/mod.rs:272 |
| `dispute raise\|confirm\|upload` | | `task::asp::run_dispute(c)` | task/asp/mod.rs:411 |
| `pending-decisions-v2 request\|request-prompt\|resolve\|resolve-with-sessionkey\|resolve-prompt\|pick\|list\|cancel` | | `task::common::pending_v2::run(c)` | task/common/pending_v2.rs:759 |
| `evidence-info <JOB_ID>` | | `task::evaluator::info::handle_info(&mut TAC, job, agent_id, round_num)` | task/evaluator/info.rs:17 |
| `vote-commit <JOB_ID>` | | `task::evaluator::commit::handle_commit(&mut TAC, …)` | task/evaluator/commit.rs:39 |
| `vote-reveal <JOB_ID>` | | `task::evaluator::reveal::handle_reveal` | task/evaluator/reveal.rs:8 |
| `arbitration-claim` | | `task::evaluator::claim::handle_claim` | task/evaluator/claim.rs:10 |
| `arbitration-claimable` | | `task::evaluator::claimable::handle_claimable` | task/evaluator/claimable.rs:14 |
| `stake` | | `task::evaluator::stake::handle_stake` | task/evaluator/stake.rs:11 |
| `increase-stake` | | `task::evaluator::stake::handle_increase_stake` | task/evaluator/stake.rs:38 |
| `request-unstake` | | `task::evaluator::unstake::handle_request_unstake` | task/evaluator/unstake.rs:20 |
| `claim-unstake` | | `task::evaluator::unstake::handle_claim_unstake` | task/evaluator/unstake.rs:153 |
| `cancel-unstake` | | `task::evaluator::unstake::handle_cancel_unstake` | task/evaluator/unstake.rs:206 |
| `staking-config` (alias `stakingconfig`) | | `task::evaluator::staking_config::handle_staking_config` | task/evaluator/staking_config.rs:6 |
| `my-stake` (alias `mystake`) | | `task::evaluator::my_stake::handle_my_stake` | task/evaluator/my_stake.rs:19 |
| `common context <JOB_ID>` | | `task::common::run(c, ctx)` | task/common/mod.rs:1248 |
| `next-action` | | **inline** (§4.8) | mod.rs:2752 |
| `file-upload` | | `chat::run(ChatCommand::FileUpload)` → `cmd_upload` | chat/mod.rs:164 |
| `file-download` | | `chat::run(…FileDownload)` → `cmd_download` | chat/mod.rs:213 |
| `sensitive-words` | | `chat::run(…SensitiveWords)` → `fetch_sensitive_words` | chat/mod.rs:72/245 |
| `message-eligible` | | `chat::run(…MessageEligible)` → `fetch_message_eligible` | chat/mod.rs:78/266 |
| `system-config` | | `chat::run(…SystemConfig)` → `fetch_system_config` | chat/mod.rs:111/355 |
| `heartbeat` | | `chat::run(…Heartbeat)` → `fetch_heartbeat` | chat/mod.rs:117/370 |
| `wakeup-notify` | | `chat::run(…WakeupNotify)` → `fetch_wakeup_notify` | chat/mod.rs:123/392 |
| `session-cleanup` | | `task::common::session_cleanup::handle_session_cleanup(job_id, true)` | task/common/session_cleanup.rs:17 |
| `task-in-progress` | | `task::common::in_progress::handle_in_progress(&mut TAC, agent_ids)` | task/common/in_progress.rs:24 |

Compiled-out / dead code (not reachable in 4.6.3): the `AgentCommand::AutotradeConsentSet` match arm and
`auto_write_continuation_id` (mod.rs:2288-2579, 3134-3150) are guarded by `#[cfg(any())]` (always false) and the
variant is not declared in the enum → there is **no** `autotrade-consent-set` command. `autotrade-grant-write` exists
only in debug builds.

Hidden (not in cli-tree.json): `get`, `get-by-address`, `xmtp-sign`, `validate-listing`, `autotrade-grant-write` (debug
only), `autotrade-consent-request`, `autotrade-once-authorize`, `autotrade-guide-prepare`, `autotrade-direct-claim`,
`autotrade-direct-finalize`, `autotrade-outcome-flush`, `autotrade-delivery-report`, `autotrade-cap-adjust-request`,
`cache-notify`, `cache-rating`; hidden args: global `--dev`, `funding-notice --image-dir`, `next-action --agent-id`
(hidden alias of `--agentId`).

---

## Shared helpers (used across groups or from core)

Owned by this partition:

- `fn agent_commerce::chat::fetch_heartbeat(client:&mut WalletApiClient, access_token, chain_index:u64) -> Result<Value>`
  (chat/mod.rs:370) — `POST /priapi/v5/wallet/agentic/agent-heartbeat`, body `{"chainIndex":<chain_index as JSON number>}`,
  via `post_authed` (JWT headers, invalid-token retry, DoH retry). Returns backend `data` verbatim. **Also called by the
  wallet login flow** (`auth/mod.rs:621`, chain 196, 4 s timeout, non-fatal) for device registration.
- `fn agent_commerce::chat::fetch_upload(client:&WalletApiClient, token, file_name, data:Vec<u8>, agent_id, job_id)`
  (chat/mod.rs:141) — multipart POST (see §4.1). `pub`, no other callers in-tree.
- `fn agent_commerce::chat::fetch_download(client, token, file_key, agent_id) -> Result<Vec<u8>>` (chat/mod.rs:200).
- `fn agent_commerce::chat::fetch_sensitive_words / fetch_message_eligible / fetch_system_config / fetch_wakeup_notify`
  (chat/mod.rs:245/266/355/392) — see §4.
- `pub(crate) fn agent_commerce::escape_control_chars_in_strings(s:&str) -> String` (mod.rs:3172) — one-pass
  JSON repair. State: `in_string=false, escaped=false`. For each char: if `escaped` → emit char, `escaped=false`;
  else `\\` while in string → emit, `escaped=true`; `"` → toggle `in_string`, emit; LF/CR/TAB while in string →
  emit `\n`/`\r`/`\t` (two chars); anything else verbatim. (A `\` outside a string is emitted verbatim and does not set
  `escaped`.) Oracles: `{"text":"line1<LF>line2"}` → `{"text":"line1\nline2"}`; LF outside strings untouched;
  existing escapes untouched; CR/TAB handled.
- `fn agent_commerce::a2mcp_probe::run(command, ctx)` (a2mcp_probe/mod.rs:390) — entry for §3.

Called from this partition, owned elsewhere (one line each):

- `commands::agentic_wallet::auth::ensure_tokens_refreshed()` (agentic_wallet/auth/mod.rs:132) — JWT getter/refresher, §1.5.
- `wallet_api::WalletApiClient::{new, get_authed, get_authed_with_headers, get_authed_bytes_with_headers, post_authed,
  post_authed_with_headers, post_authed_multipart_with_headers}` (wallet_api.rs:766/1242/1256/1336/896/910/1093) — §1.5.
- `task::common::network::task_api_client::TaskApiClient::{new, task_path, subscribe_path, get_with_identity}`
  (task_api_client.rs:95/109/129/182) — `task_path(j)` = `/priapi/v1/aieco/task/{j}`; `subscribe_path(j)` =
  `/priapi/v1/aieco/task/subscribe/{j}`; `get_with_identity(path, agent_id)` = `ensure_tokens_refreshed` + GET
  `path?sessionCert=<session.session_cert>` (query omitted when no/empty cert) with header `agenticId: <agent_id>`
  via `WalletApiClient::get_authed_with_headers`; logs `api/get` audit row. `TaskApiClient::new()` panics
  (`failed to create WalletApiClient`) if the wallet client cannot be built.
- `task::common::query_agent_by_id_direct(agent_id)` (task/common/mod.rs:626) — spawns **the same executable**
  `<current_exe> agent get-agents --agent-ids <id>`, parses its stdout envelope, requires `ok:true`, flattens
  `list[].agentList[]`, returns the agent with matching `agentId` (errors: `agent_id must not be empty`,
  `spawn \`get-agents\` failed: …`, `parse \`get-agents\` stdout failed: …; raw=…`, `` `get-agents` returned failure: … ``,
  `agentId={id} not found in \`get-agents\` response`).
- `task::common::util::validate_job_id(job_id) -> Result<(), String>` (util.rs:451) — Ok for `"_"`, any `system_*`,
  or any 66-char string starting `0x` (no hex check); else
  ``--jobid invalid (must be `0x` + 64 chars, got {len} chars). Re-read jobId from envelope (system event / user_decision_* → `message.jobId`; a2a-agent-chat → top-level `jobId`), then retry.`` (`{len}` = byte length).
- `task::common::state_machine::{Event::parse, Event::failure_label, parse_status_or_event, status_when_event, Status::from_int, Status::as_str}`
  (state_machine.rs:561/590/695/98/78) — event→expected status mapping; unknown events map to `Status::Other("unknown")`,
  all `sub_*` lifecycle events to `Status::Other("subscription")`; `from_int(-1..9)` → `init, created, accepted,
  submitted, rejected, disputed, admin_stopped, completed, close, expired, failed`, other n → `status_{n}`;
  `failure_label` → `auto-refund failed`, `close failed`, `payment mode switch failed`, `reward claim failed`,
  `evaluation request failed`, `asp reject failed`, `staking failed`, `unstake failed`, `unstake claim failed`,
  `unstake cancellation failed`, `stop staking failed`, `cooldown entry failed`, `cancel subscription failed`,
  `reject subscription delivery failed`, default `transaction failed`.
- `task::common::PreFetchedTaskContext::from_api_response(&Value)` (task/common/mod.rs:230) — normalises task/subscription
  detail (`status` = `subStatus` ?? `status`, numeric or numeric string; `user_agent_id` = `buyerAgentId` ?? `userAgentId`;
  `provider_agent_id` = `providerAgentId` ?? `aspAgentId`; `job_type` = `jobType`; `token_amount` =
  `paymentTokenAmount` ?? `tokenAmount`; `payment_mode` = `paymentMode`; …).
- `task::user::refund::{fetch_authoritative_refund_context, fetch_authoritative_refund_context_for_provider,
  refund_event_settlement_confirmed, is_zero_decimal}` (refund.rs:2652/2666/1266/1189) — compose GET task detail +
  subscription detail for the caller identity (+ local Refund V2 reconciliation state); finality predicate.
- `task::arbitration::{blocked_result, scalar_string, JOB_REJECTED="job_rejected", SUB_USER_REJECT="sub_user_reject"}`
  (arbitration.rs:335/453/11/12) — `blocked_result(reason, job, details)` =
  compact `serde_json::to_string` of `{"decision":"blocked","nextAction":[],"payload":{"details":<details>,"jobId":<job>},"phase":"arbitration_decision","reason":<reason>}` (keys sorted).
- `task::user::negotiate::{save_designated_provider, has_designated_provider}` (negotiate.rs:138/148) — local file under
  `$ONCHAINOS_HOME/task/<jobId>/…`.
- `task::common::review_gate::{mark_pending, mark_approved}` (review_gate.rs:24/64) — local file flags.
- `task::user::flow_lifecycle::core::try_recover_from_temp_file` (core.rs:964), `task::common::deliverables::{read_manifest,
  deliverables_dir, handle_save, handle_list, handle_list_all}` (deliverables.rs:102/36/144/281/317) — local deliverable storage.
- `task::{asp,user,evaluator}::flow::generate_next_action` (asp/flow.rs:462, user/flow.rs:280, evaluator/flow.rs:6) — playbook text generators.
- `commands::payment::http_carrier::build_typed_request` (http_carrier.rs:101), `commands::payment::dispatcher::decode_payment_blob`
  (dispatcher.rs:753), `commands::payment::a2mcp::*` (a2mcp.rs), `commands::payment::payment_flow::resolve_chain_and_payer`
  (payment_flow.rs:393), `commands::payment::state::current_owner_id` (state.rs:265), `commands::payment::session_state::now_unix`
  (session_state.rs:86), `funding::build_funding_bundle_for_address` (funding.rs:234) — see §3.
- `home::onchainos_home()` (home.rs:12: `$ONCHAINOS_HOME` if non-empty else `~/.onchainos`), `home::atomic_write(path, bytes, sensitive)`
  (home.rs:210: ensure parent dir 0700, write `<file>.tmp`, chmod 0600 if sensitive (unix), rename).

---

## Commands

Sections 3 and 4 are the per-command specs owned by this partition (a2mcp-probe ×6, chat ×7, `next-action`, and every
inline handler in `mod.rs`). Delegated commands are listed with their handlers in §2 and specified by their owning partitions.

## 3. `a2mcp-probe` family (stateless OKX.AI A2MCP direct invocation)

Common to all six sub-commands (`a2mcp_probe/mod.rs:390`):
- Handler result is a `ProbeDecision`; printed via `output::success(decision)` →
  `{"ok":true,"data":{"phase":…,"decision":…,"reason":…,"nextAction":[…],"payload":{…}}}` (struct order for the
  five top keys; `payload` and every `params` object key-sorted).
- `Action` JSON: `{"id":…,"actionLabel":…,"recommend":bool[,"params":{…}]}` (`params` omitted when absent).
  Labels by id: `provide_a2mcp_params`→`Provide service parameters`, `select_a2mcp_token`→`Select payment option`,
  `fund_a2mcp_token`→`Fund this payment option`, `resume_a2mcp_after_funding`→`Continue after funding`,
  `confirm_a2mcp_free`→`Confirm service invocation`, `confirm_a2mcp_payment`→`Confirm payment`,
  `execute_a2mcp_payment`→`Execute payment`, `cancel_a2mcp`→`Cancel`, other→`Continue`.
- `ProbeDecision::blocked(reason, payload)` = phase `endpoint_probe`, decision `blocked`, nextAction
  `[{"id":"cancel_a2mcp","actionLabel":"Cancel","recommend":true}]`.
- **Invocation recovery normalisation** (`normalize_invocation_result`, mod.rs:344) — applied to every sub-command
  except `probe`. If the handler returns `Err(e)` and `m = e.to_string()` (outermost message):
  - starts with `a2mcp_prepared_expired_or_missing` → reason `a2mcp_prepared_expired_or_missing`
  - starts with `a2mcp_free_result_expired_or_missing` → `a2mcp_free_result_expired_or_missing`
  - starts with `a2mcp_invalid_payment_candidate`, or (starts with `a2mcp_invalid_payment_intent` **and** contains
    `unknown candidate`) → `a2mcp_candidate_invalid_or_missing`
  - starts with `a2mcp_funding_continuation_required` → `a2mcp_funding_continuation_required`
  → Ok decision `{"phase":"invocation_recovery","decision":"blocked","reason":<r>,"nextAction":[cancel_a2mcp recommend:true],"payload":{"message":<m>,"schemaVersion":1}}`.
  Any other error propagates → `{"ok":false,"error":"<e:#>"}` exit 1 (e.g. `wallet_login_required: no selected wallet`,
  `a2mcp_invalid_payment_intent: candidate set changed during balance refresh`, `cross_user_payment_id: <id>`).
- `confirmation_presentation(provider, service_name, endpoint, fee_display, typed_params)` (mod.rs:253) →
  `{"columns":[{"key":"field","label":"Field"},{"key":"value","label":"Value"}],"rows":[{"key":"serviceProvider","label":"Service Provider","value":P},{"key":"serviceName","label":"Service Name","value":N},{"key":"endpoint","label":"Endpoint","value":E},{"key":"fee","label":"Fee","value":F},{"key":"serviceParameters","label":"Service Parameters","value":S}],"type":"a2mcp_confirmation"}`
  where P = `Agent ID {id}` or `—` (U+2014), N = service name or `—`, S = compact JSON of typed params (sorted keys, `{}` when empty).
- `paid_fee_display(amount, symbol, semantics)` = (`Up to ` if semantics == `maximum`) + `{amount} {symbol}`;
  `amount_semantics(scheme)` = `maximum` if scheme eq-ignore-case `upto` else `exact`.
- `decimal_strings_equal(a,b)` (flow.rs:859): both trimmed, non-empty, no sign, ≤1 dot, digits only, whole part non-empty;
  compare (whole with leading zeros stripped → `0` if empty, fraction with trailing zeros stripped); any unparsable → false.
- Local state files (all via `home::atomic_write(…, sensitive=true)`):
  - free result: `$ONCHAINOS_HOME/a2mcp/a2free_<32 lowercase hex>.json`, TTL 300 s (§3.1 step 9);
  - prepared payment: `$ONCHAINOS_HOME/payments/a2prep_<32 hex>.json` (owned by payment/a2mcp.rs:854-999):
    `{version:1, source:"okx_ai_a2mcp_prepared", preparedId, ownerAccountId, createdAt, expiresAt, prepared:{version:1,
    source:"okx_ai_a2mcp", frozenRequest{endpoint,method,typedParams,paramPlan,resource?}, confirmationContext{serviceId,
    serviceName?,providerAgentId?,aspAmount?,aspSymbol?}, candidates[…], challengeExpiresAt, walletError?, fundingCandidateId?}}`
    (pretty, struct order). `expiresAt = min(challengeExpiry≠0, createdAt+300)`; challenge expiry ≤ createdAt →
    `a2mcp_payment_intent_expired: challenge expired`. Load/claim errors: bad id format or missing/expired/invalid file →
    `a2mcp_prepared_expired_or_missing: <id>` (file deleted); owner mismatch → `cross_user_payment_id: <id>`.
    Claim = rename to `.a2prep_<id>.claim-<uuid>`; `replace` writes a **new** `a2prep_` id with the original
    createdAt/expiresAt and deletes the claim file; drop without commit renames back.
  - payment intent: `$ONCHAINOS_HOME/payments/pay_<first 24 hex of sha256("okx_ai_a2mcp" ‖ 0x00 ‖ preparedId ‖ 0x00 ‖ ownerAccountId)>.json`
    (owned by payment/a2mcp.rs:533).
- `current_owner_id()` = `wallets.json` `selected_account_id` (non-empty) — local login state only (no HTTP).

### 3.1 `onchainos agent a2mcp-probe probe`  (hidden: no)
- Handler: `a2mcp_probe/flow.rs:3 run_probe` (dispatched mod.rs:392; **not** wrapped by `normalize_invocation_result`).
- Options (`ProbeArgs`, mod.rs:47-63):
  - `--routing-json <ROUTING_JSON>` (String) and `--routing-base64 <ROUTING_BASE64>` (String): ArgGroup `routing_input`
    **required, exactly one** (both / neither → clap error exit 2).
  - `--params-json <PARAMS_JSON>` / `--params-base64 <PARAMS_BASE64>`: ArgGroup `params_input`, at most one; default params `"{}"`.
  - global `--chain` ignored.
- Auth: anonymous for the merchant probe (plain reqwest, no OKX headers); the paid (402) branch additionally uses
  `ApiClient` (jwt-optional) for token metadata/balances and requires a locally selected wallet (`current_owner_id`).
- Steps:
  1. **Decode** (`decode_probe_json_args`, mod.rs:65): routing = base64-STANDARD(padded, canonical)-decode of
     `--routing-base64` then UTF-8, else `--routing-json`; params likewise from `--params-base64`, else `--params-json`,
     else `"{}"`. Decode failure → Ok `blocked(code, {"message":M,"schemaVersion":1})` with code
     `invalid_a2mcp_routing` (routing) / `invalid_a2mcp_params` (params) and M = `base64 input is invalid: <base64 DecodeError>`
     or `base64 input is not UTF-8: <FromUtf8Error>`.
  2. **Parse** (`contract.rs:3 parse_probe_input`), errors in this order (all `ContractError{code,message}`):
     1. routing JSON → `RoutingPayload{schemaVersion:u64 (required), serviceSnapshot:Value (required), requestSpec?:{method?:String,
        fields?:[FieldConstraint], requiredAnyOf?:[String]}}` (unknown keys ignored; `FieldConstraint{name (required), type (default
        "string"), required (default true), carrier?, description?}`) — failure: `invalid_a2mcp_routing` /
        `routing JSON is invalid: <serde_json error>`.
     2. `schemaVersion != 1` → `invalid_a2mcp_routing` / `schemaVersion must be the integer 1`.
     3. `serviceSnapshot` not an object → `serviceSnapshot must be an object`.
     4. `serviceSnapshot.serviceType` not a string equal (ASCII case-insensitive) to `A2MCP` → `serviceSnapshot.serviceType must equal A2MCP`.
     5. `serviceSnapshot.endpoint` not a string → `serviceSnapshot.endpoint must be a URL string`.
     6. WHATWG URL parse failure → `serviceSnapshot.endpoint is invalid: <url ParseError>`.
     7. scheme ≠ `https` → `serviceSnapshot.endpoint must use HTTPS`.
     8. params JSON parse → `invalid_a2mcp_params` / `params JSON is invalid: <serde_json error>`; not an object →
        `invalid_a2mcp_params` / `params JSON must be an object`.
     9. param plan = `requestSpec.fields` if `requestSpec` present, else `parse_fields(serviceSnapshot.outputSchema.input)`;
        requiredAnyOf = `requestSpec.requiredAnyOf` if `requestSpec` present, else string items of
        `serviceSnapshot.outputSchema.requiredAnyOf`.
     10. `serviceId` = `serviceSnapshot.serviceId` as string or number-to-string, must be non-blank else
         `invalid_a2mcp_routing` / `serviceSnapshot.serviceId is required`.
     11. `validate_typed_params`: for each plan field in order: type ∉ {string,number,integer,boolean,object,array} →
         `invalid_a2mcp_routing` / ``requestSpec field `{name}` has unsupported type `{type}` ``; if the param is present and
         its JSON type mismatches (`integer` = i64/u64 representable) → `invalid_a2mcp_param_value` /
         ``parameter `{name}` must be {type}``.
     12. Method: `fallback` = `requestSpec.method` ?? `serviceSnapshot.method` (string) ?? `serviceSnapshot.outputSchema.method`
         (string); `desc` = `serviceSnapshot.serviceDescription` (string). `method_was_defaulted` =
         `fallback is None && (desc is None || (no curl example && no labelled method in desc))`.
         `method = resolve_request_method(desc, endpoint, fallback)` (method.rs:22):
         a. if desc has a curl example (`extract_curl_example`) → `method_from_curl`;
         b. else if desc has a labelled line `[Request Method]`/`[请求方式]`/`[请求方法]` → `method_from_declared_text`;
         c. else if fallback → `normalize_a2mcp_method(fallback)` (trim + uppercase; must be `GET`/`POST` else
            ``A2MCP request method `{M}` is unsupported; expected GET or POST``);
         d. else `GET`.
         All method errors use code `invalid_a2mcp_routing`.
     `parse_fields(v)`: array → items that are strings (`{name, type:"string", required:true}`) or objects with string
     `name` (type/required/carrier/description from the object, defaults string/true); object → one field per
     `(name, schema)` entry (sorted by name, BTreeMap); else empty.
     Snapshot fields kept: `service_name` = non-blank `serviceName`; `provider_agent_id` = non-blank scalar
     `asp.aspAgentId`; `asp_amount` = scalar `feeAmount` (number → Rust `f64/i64` Display, e.g. `0.05`);
     `asp_symbol` = `feeTokenSymbol` uppercased; `raw` = whole snapshot Value.
     On error: code `invalid_a2mcp_param_value` → **invalid-params decision** (below); any other code → Ok
     `blocked(code, {"message":msg,"schemaVersion":1})`.
  3. **Outstanding required input** (`outstanding_request_input`): fields = plan fields with `required && name ∉ requiredAnyOf && name ∉ params`;
     if any requiredAnyOf name is in params → requiredAnyOf cleared. If fields or requiredAnyOf non-empty →
     return **input-required decision** without any network call.
  4. **Initial probe** (`send_initial_probe`, flow.rs:131): `send_probe(input)`; if it returns `Err` and
     `method_was_defaulted && method == "GET"` → set method `POST`, `method_was_defaulted=false`, `send_probe` again.
     Err → `probe_error_decision`: reason `invalid_a2mcp_params` if message starts with `a2mcp_invalid_typed_params` or
     `invalid_a2mcp_params`, else `endpoint_failure`; payload `{"message":<e.to_string()>,"schemaVersion":1}`, phase endpoint_probe.
  5. **One unsigned method fallback**: MethodRequired{allow} → `fallback_method_for_405(method, allow)`; Failed{status,body} →
     `POST` if (defaulted GET) else `fallback_method_for_400(method,status,body,params,plan)`; other outcomes → none.
     If a fallback exists: set method, `method_was_defaulted=false`, `send_probe` again (Err → probe_error_decision).
  6. **POST verification of a defaulted-GET challenge**: if `method_was_defaulted && method=="GET"` and outcome is
     Challenge → send the same params with `POST` (`method_was_defaulted=false`). Send error → `method_verification_blocked()`.
     `post_verification_action`: Challenge/InputRequired/Free → adopt POST input+outcome; Failed 400 with
     `discover_endpoint_param_issues` hit → adopt POST; MethodRequired with Allow listing POST → block; MethodRequired
     otherwise → keep GET (clear defaulted flag); any other Failed → block. Block →
     `blocked("endpoint_failure", {"message":"The endpoint request method could not be verified before payment.","schemaVersion":1})`.
  7. **Final outcome**:
     - InputRequired(req): if `req.method` present → `normalize_a2mcp_method` → sets method (error → Ok `blocked("invalid_a2mcp_routing", {"message","schemaVersion":1})`); → input-required decision.
     - Free{status, body} → step 9.
     - MethodRequired{allow} → `blocked("request_method_required", {"allow":<Allow header string or null>,"schemaVersion":1})`.
     - Failed{400, body} with `discover_endpoint_param_issues(body, params, plan)` → input-required decision.
     - Failed{status, body} otherwise → `blocked("endpoint_failure", {"result":<body>,"schemaVersion":1,"statusCode":<status>})`.
     - Challenge{challenge, body} → step 10.
  8. **`send_probe`** (probe.rs:3) — the merchant HTTP request:
     - fresh `reqwest::Client` with **10 s** total timeout, no default OKX headers, no custom User-Agent.
     - plan = `to_payment_param_plan(param_plan, method)`: carrier = field.carrier ?? (`body` if method is POST else `query`);
       carrier ∉ {query, body, header, path} → Err ``invalid_a2mcp_params: unsupported carrier `{c}` ``.
     - `build_typed_request(client, method, endpoint.as_str(), typed_params, plan)` (http_carrier.rs:101): iterate params in
       **sorted key order**; carrier = plan entry for that name, else body (POST) / query (GET). Body on GET →
       `a2mcp_invalid_typed_params: body parameter '{key}' is invalid for {method}`; non-body value must be scalar
       (`null`→`null`, bool/number Display, string raw) else `a2mcp_invalid_typed_params: non-body parameter '{key}' must be scalar`;
       path → replace `{key}` in the URL string with the percent-encoded (every non-alphanumeric byte) value, missing
       placeholder → `a2mcp_invalid_typed_params: path placeholder '{key}' is missing` (**note**: the endpoint string comes
       from the parsed URL, which percent-encodes `{`/`}` to `%7B`/`%7D`, so path placeholders are never found → path carriers
       always fail); query → appended with form-urlencoding (reqwest `.query`, appended after any existing query);
       header → request header. POST always sends a JSON body (`{}` when no body params; `Content-Type: application/json`,
       compact, sorted keys).
     - send error → Err `endpoint_failure: endpoint request failed`; client build error → `endpoint_failure: failed to build endpoint client`.
     - read status, `Allow` header, challenge header = `PAYMENT-REQUIRED` else `WWW-Authenticate`; body text → JSON if
       parseable else JSON string of the text.
     - classification order: (a) 405 → MethodRequired{allow}; (b) `discover_input_required(body)` → `outstanding_input` non-empty →
       InputRequired; (c) 402 → raw = challenge header ?? `body.to_string()`; `decode_payment_blob(raw)` (Err →
       `unsupported_payment_scheme: malformed 402 challenge`); `discover_input_required(challenge)` outstanding →
       InputRequired; else Challenge{challenge, body}; (d) `discover_input_fallback_hint(body)` → InputRequired (applies to
       any non-405/non-402 status incl. 2xx); (e) 2xx → Free{status, body}; (f) Failed{status, body}.
     - `discover_input_required(v)` priority: `v.input_required` object with non-empty `fields`/`requiredAnyOf`
       (method = `input_required.method` ?? `v.outputSchema.method`); else `v.status == "input_required"` with
       `fields` ?? `requiredArgs` / `requiredAnyOf`; else required fields of `v.outputSchema.input` / `v.outputSchema.requiredAnyOf`;
       else names from `missingParams` (or `required` if missingParams empty) as string fields with
       `needs_description_fallback=true` (message = `v.message`, method = `v.outputSchema.method`).
     - `outstanding_input(req, params)`: drop fields that are not required, are in requiredAnyOf, or already in params;
       clear requiredAnyOf if any of its names is in params; if both empty → `Some(req)` only when `needs_description_fallback`.
     - `discover_input_fallback_hint(v)`: first of `error`/`message`/`detail` string whose normalised text (trim, strip trailing
       ASCII punctuation, lowercase) does **not** contain `payment required`/`authentication required`/`authorization required`
       and contains `missing required parameter`/`required parameter missing`/`missing required input`/`required input missing`/
       `missing required argument`/`required argument missing`, or is exactly three words `<ident> is required`
       (ident = `[A-Za-z0-9_-]+`) → InputRequired{fields:[], message, needs_description_fallback:true}.
     - `fallback_method_for_405(cur, allow)`: GET→POST; POST→GET only if Allow present; if Allow present the alternate must
       appear in it (comma list, trimmed, case-insensitive).
     - `fallback_method_for_400(cur, status, body, params, plan)`: only `status==400 && cur=="GET" && params non-empty`;
       `POST` if `body.expectedMethod=="POST"` or `body.code ∈ {request_body_required, body_required}`; else count `body.issues`
       with single-element string `path` naming a submitted non-null param whose issue reports a missing value
       (`message` contains `required` (case-insensitive) and `received` is null or `undefined`/`missing`); if any such field
       has an explicit non-`body` carrier in plan → none; ≥2 such distinct fields → `POST`.
     - `discover_endpoint_param_issues(body, params, plan)`: for each `issues[]` with single-segment path naming a field in
       params or plan (dedup; skip submitted-but-reported-missing) → field `{name, type: issue.expected (if supported) ?? plan type ??
       JSON type of submitted value ?? string, required:true, carrier: plan carrier, description}`; description =
       `The endpoint expects a {expected} value.` | (`code=="too_small"`) `The endpoint requires a value of at least {minimum}.`
       (numeric minimum only) or `The endpoint rejected this value because it is below the allowed minimum.` | default
       `The endpoint rejected this value. Provide a valid replacement.`; message = `"{name}: {description}"` joined by `; `.
       If no issue fields: `body.message` containing any of `must/required/invalid/expected/unsupported` (case-insensitive)
       and naming exactly one submitted param as a whole identifier → that single field with the default description.
  9. **Free result** (`free_result.rs:138 store_free_result`): confirmation id `a2free_` + UUIDv4 simple (32 lowercase hex);
     state `{version:1, source:"okx_ai_a2mcp_free_result", confirmationId, createdAt:now, expiresAt:now+300, serviceId,
     serviceName?, providerAgentId?, endpoint (URL string), method, typedParams, statusCode, result}` written pretty (struct
     order) to `$ONCHAINOS_HOME/a2mcp/<id>.json` (dir created). Write failure → CLI error exit 1. Output decision
     (`build_free_confirmation_decision`, flow.rs:181): phase `payment_confirmation`, decision `requires_user_input`, reason
     `free_confirmation_required`, nextAction `[confirm_a2mcp_free (recommend true, params {"confirmationId":id}), cancel_a2mcp (false)]`,
     payload `{"amountDisplay":"Free","confirmationEnabled":true,"confirmationId":id,"endpoint":E,"method":M,"presentation":<fee "Free">,
     "providerAgentId":P|null,"schemaVersion":1,"serviceId":S,"serviceName":N|null,"typedParams":{…}}`. The merchant result is **not** shown.
  10. **Paid (402) branch** (`flow.rs:695 build_payment_decision`):
      - response plan = merge(merge(snapshot plan, `merchant_body.outputSchema.input`), `challenge.outputSchema.input`)
        (`merge_field_constraints`: same name replaces in place, new names appended); `to_payment_param_plan(plan, method)?`
        (error propagates → exit 1).
      - `A2mcpFrozenRequestV1::new(endpoint, method, typedParams, plan, challenge.resource)?`.
      - `payment::a2mcp::prepare_a2mcp_payment_from_challenge` (a2mcp.rs:1021): decodes challenge, requires `accepts`,
        builds candidates via `quote::prepare_a2mcp_candidates` (HTTP: `POST /api/v6/dex/market/token/basic-info` per token
        for decimals/symbol; if a wallet is selected, `GET /api/v6/dex/balance/all-token-balances-by-address?address=…&chains=…`
        per candidate chain; walletError `login_required` / `balance_unavailable` otherwise), keeps only USDT/USDC/USDG with
        supported scheme/transfer (`exact`+eip3009, `exact`/`upto`+permit2, `aggr_deferred`+session), one per (network, asset)
        by scheme priority; candidate ids `candidate_<acceptsIndex>`. Error text containing `unsupported_payment_asset` →
        Ok `blocked("unsupported_payment_asset", {"schemaVersion":1,"serviceId":S})`; other errors → exit 1.
      - candidate view (per candidate, sorted keys): `{"amountAtomic","amountDisplay","amountMismatch","amountSemantics","availableDisplay","balanceStatus","candidateId","chainName","confirmationEnabled"(balanceStatus=="sufficient"),"depositAddress","network","requiredDisplay","shortfallDisplay","tokenSymbol"}`;
        `amountMismatch` = asp_amount present && !decimal_strings_equal(asp_amount, amountDisplay).
      - `current_owner_id()` else Err `wallet_login_required: no selected wallet` (exit 1); store prepared → `preparedId`.
      - single candidate: reason/nextAction from `ProbeDecision::payment_confirmation(preparedId, cid, enabled, false)`:
        enabled → reason `payment_confirmation_required`, `[confirm_a2mcp_payment(true,{"candidateId","preparedId"}), cancel_a2mcp(false)]`;
        not enabled → reason `insufficient_balance`, `[fund_a2mcp_token(true,{"candidateId","preparedId"}), cancel_a2mcp(false)]`;
        fee display = `paid_fee_display`. Multiple candidates: reason `token_selection_required`,
        `[select_a2mcp_token(true,{"preparedId"}), cancel_a2mcp(false)]`, fee `Select a payment option`.
      - output: phase `payment_confirmation`, decision `requires_user_input`, payload
        `{"amountMismatch":<bool if 1 candidate else null>,"aspPrice":{"amount":A|null,"symbol":SYM|null},"candidates":[…],"confirmationEnabled":bool,"endpoint":E,"method":M,"preparedId":ID,"presentation":{…},"providerAgentId":P|null,"schemaVersion":1,"selectedCandidateId":cid|null,"serviceId":S,"serviceName":N|null,"typedParams":{…},"walletError":W|null}`.
- **Input-required decision** (`input_required_decision`, flow.rs:261): phase `parameter_collection`, decision `requires_user_input`,
  reason `input_required`, nextAction `[provide_a2mcp_params(true), cancel_a2mcp(false)]` (no params), payload
  `{"autoProbeOnValid":true,"fields":F,"message":req.message|null,"needsDescriptionFallback":bool,"nextProbePayload":{"requestSpec":RS,"schemaVersion":1,"serviceSnapshot":<raw snapshot>},"requiredAnyOf":[…],"schemaVersion":1,"serviceId":S,"typedParams":{…}}`;
  F = `[{"name","required"}]` when needsDescriptionFallback else full field objects (`carrier?,description?,name,required,type`);
  RS = `{"fields"?,"method"?,"requiredAnyOf"?}` (empty arrays / defaulted method omitted) with fields = snapshot plan
  (fallback case) or merge(plan, req.fields + requiredAnyOf names not already present as `{name,type:"string",required:false}`).
- **Invalid-params decision** (`invalid_params_decision`, flow.rs:313): phase `parameter_collection`, decision
  `requires_user_input`, reason `invalid_a2mcp_params`, nextAction as above, payload
  `{"autoProbeOnValid":true,"fields":[mismatching plan fields],"message":<ContractError message>,"nextProbePayload":<entire routing JSON as Value>,"schemaVersion":1,"typedParams":{…}}`.
- Output: always `ok:true` except the propagating errors noted (store failures, param-plan errors in 402 branch,
  prepare errors, missing wallet in 402 branch).
- Errors: exit 0 for every decision; exit 1 for propagated errors; exit 2 for clap errors.
- Side effects: calls a **third-party merchant endpoint** (unsigned; for free services this *executes* the service);
  writes local state (`a2mcp/*.json` or `payments/a2prep_*.json`). No OKX state change, no funds.
- Nondeterminism: `confirmationId`/`preparedId` (UUIDv4), timestamps in state files, merchant responses, balances.
- Parity test cases:
  1. SAFE: `agent a2mcp-probe probe --routing-json '{"schemaVersion":2,"serviceSnapshot":{}}'` →
     `{"ok":true,"data":{"phase":"endpoint_probe","decision":"blocked","reason":"invalid_a2mcp_routing","nextAction":[{"id":"cancel_a2mcp","actionLabel":"Cancel","recommend":true}],"payload":{"message":"schemaVersion must be the integer 1","schemaVersion":1}}}`.
  2. SAFE (no network): `--routing-json '{"schemaVersion":1,"serviceSnapshot":{"serviceType":"A2MCP","serviceId":"s1","endpoint":"https://127.0.0.1:9/x"},"requestSpec":{"method":"POST","fields":[{"name":"brand","type":"string","required":true,"carrier":"body"}]}}' --params-json '{}'` → `parameter_collection`/`input_required`.
  3. SAFE (no network): same routing with `--params-json '{"brand":1}'` → reason `invalid_a2mcp_params`, payload.message ``parameter `brand` must be string``.
  4. SAFE: `--routing-base64 '!!!'` → blocked `invalid_a2mcp_routing`, message starting `base64 input is invalid:`.
  5. UNSAFE (third-party call): a real A2MCP service snapshot with valid params.

### 3.2 `onchainos agent a2mcp-probe confirm-free`  (hidden: no)
- Handler: `a2mcp_probe/flow.rs:222 run_confirm_free` (wrapped by `normalize_invocation_result`).
- Options: `--confirmation-id <CONFIRMATION_ID>` (String, required); `--yes` (bool flag).
- Auth: anonymous (local state only).
- Steps: `now = now_unix()`. Id must be `a2free_` + 32 ASCII hex (either case) else Err
  `a2mcp_free_result_expired_or_missing: <id>`; path `$ONCHAINOS_HOME/a2mcp/<id>.json` (dir created).
  Validation of a loaded state: version 1, source `okx_ai_a2mcp_free_result`, same id, `now < expiresAt`, non-blank serviceId,
  `createdAt < expiresAt`, endpoint parses with scheme https, method GET/POST — any failure / unreadable / unparsable →
  `a2mcp_free_result_expired_or_missing: <id>`.
  - without `--yes`: `load_free_result` (deletes the file when invalid/expired) → the same free-confirmation decision as §3.1 step 9
    (built from state; no `result`).
  - with `--yes`: `consume_free_result`: validate, rename to `.<id>.claim-<uuid>`, re-read (on failure rename back), delete claim
    file → decision phase `endpoint_result`, decision `ready`, reason `free_result`, nextAction `[]`, payload
    `{"amountDisplay":"Free","endpoint","method","providerAgentId","result":<merchant body>,"schemaVersion":1,"serviceId","serviceName","statusCode","typedParams"}`.
- Output / Errors: missing/expired/consumed → Ok invocation_recovery decision (reason `a2mcp_free_result_expired_or_missing`,
  payload.message `a2mcp_free_result_expired_or_missing: <id>`); I/O errors deleting the claim → exit 1 (`consume A2MCP free result state: …`).
- Side effects: local only (read, delete). Nondeterminism: none beyond stored content.
- Parity: SAFE `agent a2mcp-probe confirm-free --confirmation-id a2free_0123456789abcdef0123456789abcdef --yes` (fresh home) →
  invocation_recovery; SAFE `--confirmation-id bad` → same reason with message `a2mcp_free_result_expired_or_missing: bad`.

### 3.3 `onchainos agent a2mcp-probe refresh-balance`  (hidden: no)
- Handler: `flow.rs:376 run_refresh_balance` (normalised).
- Options: `--prepared-id <PREPARED_ID>` (required).
- Auth: local wallet selection required; balances via `ApiClient` (jwt-optional).
- Steps: owner = `current_owner_id()` else `wallet_login_required: no selected wallet` (exit 1). Load prepared (owner-bound).
  `refresh_a2mcp_prepared_payment` (a2mcp.rs:1077) re-queries balances only (`GET /api/v6/dex/balance/all-token-balances-by-address`
  per chain); candidate count must be unchanged. `replace_a2mcp_prepared_payment` → new `preparedId`. Build candidate views
  (same keys as §3.1 step 10 incl. `confirmationEnabled`) using the stored confirmation context's `aspAmount`;
  single candidate → `payment_confirmation(newId, cid, enabled, false)`; multiple → `token_selection_required`.
- Output: phase `payment_confirmation`, decision `requires_user_input`, payload
  `{"amountMismatch":bool|null,"aspPrice":{"amount","symbol"},"candidates":[…],"confirmationEnabled":bool,"endpoint":<frozen>,"method":<frozen>,"preparedId":<new id>,"presentation":{…},"providerAgentId","schemaVersion":1,"selectedCandidateId","serviceId","serviceName","typedParams":<frozen>,"walletError"}`.
- Errors: expired/missing prepared → invocation_recovery `a2mcp_prepared_expired_or_missing`; other → exit 1.
- Side effects: local state rotated (old id invalid). Nondeterminism: new preparedId, balances.
- Parity: SAFE `agent a2mcp-probe refresh-balance --prepared-id a2prep_0123456789abcdef0123456789abcdef` with a selected wallet and
  empty payments dir → invocation_recovery; without a selected wallet → `{"ok":false,"error":"wallet_login_required: no selected wallet"}` exit 1.

### 3.4 `onchainos agent a2mcp-probe funding`  (hidden: no)
- Handler: `flow.rs:540 run_funding` (normalised).
- Options: `--prepared-id` (required), `--candidate-id` (required).
- Auth: local wallet selection; no HTTP.
- Steps: owner; load prepared; find candidate else `a2mcp_invalid_payment_candidate: unknown candidate` (→ recovery
  `a2mcp_candidate_invalid_or_missing`); balanceStatus `sufficient` → Err `a2mcp_funding_not_required: selected candidate is sufficient`
  (exit 1). `funding::build_funding_bundle_for_address("", candidate.chainId, candidate.depositAddress,
  {asset: symbol, token_address: raw_accept.asset or "", required: requiredDisplay, balance: Some(availableDisplay),
  operation: Some("a2mcp"), error_code/message: None})` (validation errors e.g. `funding receive address must not be blank`,
  `funding balance must be a plain non-negative decimal`, `funding bundle requires an actual balance shortfall` → exit 1).
  `mark_funding_continuation(candidate)` then replace → `continuationId`.
- Output: `{"phase":"funding_required","decision":"blocked","reason":"insufficient_balance","nextAction":[{"id":"resume_a2mcp_after_funding","actionLabel":"Continue after funding","recommend":true,"params":{"candidateId":C,"preparedId":<continuationId>}}],"payload":<funding bundle payload: {"fundingNeed":{"asset","balance","required","shortfall"?,"tokenAddress"},"fundingTarget":{…},"operation":"a2mcp","qr":{…}}>}`.
- Side effects: local state rotated; QR rendering (core `build_qr_output`, no file dir given). Nondeterminism: new id.
- Parity: SAFE with missing prepared id → recovery decision.

### 3.5 `onchainos agent a2mcp-probe resume-after-funding`  (hidden: no)
- Handler: `flow.rs:481 run_resume_after_funding` (normalised).
- Options: `--prepared-id`, `--candidate-id` (required); `--yes` (flag).
- Auth: local wallet; balances via ApiClient; payer resolution may hit `POST /priapi/v5/wallet/agentic/chain/support/list`
  (chain list cache, wallet-owned).
- Steps: 1) no `--yes` → Err `a2mcp_payment_confirmation_required: funding completion must be explicit` (exit 1, before any
  state access). 2) owner; `claim_a2mcp_prepared_payment`. 3) `fundingCandidateId != --candidate-id` → Err
  `a2mcp_funding_continuation_required: enter Funding before resuming` (claim restored; → recovery decision). 4) refresh
  balances; candidate missing → `a2mcp_invalid_payment_candidate: unknown candidate`. 5) sufficient → `select` →
  `resolve_chain_and_payer(raw accept, None)` → `create_a2mcp_payment_intent{probe_id: preparedId, owner, payer, frozen,
  selected, created_at: now, expires_at: challengeExpiresAt, user_confirmed: true}` → commit claim → **payment-ready decision**.
  6) else clear continuation, replace → new id → `run_prepare_payment(newId, candidate, yes=false)` (§3.6 preview).
- Payment-ready decision (`payment_ready_decision`, flow.rs:684): `{"phase":"payment_ready","decision":"ready","reason":"payment_ready","nextAction":[{"id":"execute_a2mcp_payment","actionLabel":"Execute payment","recommend":true,"params":{"paymentId":P}}],"payload":{"paymentId":P,"schemaVersion":1}}`.
- Side effects: local state (intent file created, prepared consumed). **Authorises** a later payment but does not move funds
  (execution happens in `onchainos payment …`, payment partition). Nondeterminism: none in ids (paymentId deterministic), balances.
- Parity: SAFE `… resume-after-funding --prepared-id x --candidate-id y` (no `--yes`) → exit 1 error above.

### 3.6 `onchainos agent a2mcp-probe prepare-payment`  (hidden: no)
- Handler: `flow.rs:596 run_prepare_payment` (normalised).
- Options: `--prepared-id` (required), `--candidate-id` (required, `#[arg(long)]`), `--yes` (flag).
- Auth: local wallet; with `--yes` payer resolution (chain list).
- Steps: owner; load prepared; find candidate else Err `a2mcp_invalid_payment_intent: unknown candidate` (→ recovery
  `a2mcp_candidate_invalid_or_missing`).
  - without `--yes`: decision = `payment_confirmation(preparedId, cid, enabled=balance sufficient, can_select_other = candidates>1)`
    (not enabled → `[fund_a2mcp_token, select_a2mcp_token(params {"preparedId"}) if >1, cancel_a2mcp]`), payload
    `{"amountMismatch":bool,"aspPrice":{…},"candidate":{"amountAtomic","amountDisplay","amountMismatch","amountSemantics","availableDisplay","balanceStatus","candidateId","chainName","depositAddress","network","requiredDisplay","shortfallDisplay","tokenSymbol"},"confirmationEnabled":bool,"endpoint","method","preparedId":<same id>,"presentation":{fee = paid_fee_display},"providerAgentId","schemaVersion":1,"selectedCandidateId","serviceId","serviceName","typedParams","walletError"}`. No state change.
  - with `--yes`: `select` → `resolve_chain_and_payer` → claim → select again → `create_a2mcp_payment_intent(user_confirmed:true)`
    (errors: `a2mcp_insufficient_balance: selected token balance is not sufficient`, `a2mcp_payment_intent_already_created: <preparedId>`,
    `a2mcp_payment_intent_expired: challenge expired` → exit 1) → commit → payment-ready decision.
- Side effects: `--yes` creates the payment intent (authorisation of a future payment; no funds moved here).
- Parity: SAFE missing prepared → recovery decision.

---

## 4. Chat commands and inline handlers

### 4.1 `onchainos agent file-upload`  (hidden: no)
- Handler: `chat/mod.rs:164 cmd_upload` (+ `fetch_upload` 141).
- Options: `--file <FILE>`, `--agent-id <AGENT_ID>`, `--job-id <JOB_ID>` (all required Strings).
- Auth: jwt-required (`ensure_tokens_refreshed`).
- Steps: 1) `fs::metadata(file)` error → `file not found: {file}: <io error>`; not a regular file → `not a file: {file}`.
  2) read bytes (`failed to read file: {file}: <io>`); `file_name` = last path component (UTF-8) else `upload`.
  3) token; `POST /priapi/v1/aieco/im/attachments/xmtp/encrypted/upload` multipart/form-data: part `file` (bytes, filename =
  file_name, `Content-Type: application/octet-stream`) then text part `jobId` = `--job-id`; headers = jwt headers minus
  Content-Type (reqwest sets multipart boundary) + `agenticId: <agent-id>`. Single attempt (no DoH/token retry); send error →
  `wallet API request failed: <reqwest error>`.
- Output: `{"ok":true,"data":<backend data, sorted keys (expected fileKey, fileSize)>}`.
- Errors: exit 1 with messages above / wallet envelope errors (§1.5).
- Side effects: state-changing (stores an encrypted attachment server-side).
- Nondeterminism: multipart boundary; fileKey.
- Parity: SAFE `agent file-upload --file does-not-exist --agent-id 1 --job-id 0x…` → exit 1 `file not found: does-not-exist: …` (no HTTP);
  UNSAFE real upload.

### 4.2 `onchainos agent file-download`  (hidden: no)
- Handler: `chat/mod.rs:213 cmd_download` (+ `fetch_download` 200).
- Options: `--file-key <FILE_KEY>`, `--agent-id <AGENT_ID>`, `--output <OUTPUT>` (required).
- Auth: jwt-required.
- Steps: token → `GET /priapi/v1/aieco/im/attachments/xmtp/encrypted/download?fileKey=<form-encoded>` (key omitted if empty),
  jwt headers + `agenticId`; DoH retry on connect/timeout only; no token retry. Response: if `Content-Type` contains
  `application/json` → parse (`failed to parse wallet API response as JSON`) → code ≠ 0 → Err
  `download failed (code={code}): {msg or "unknown error"}`; code 0 → **empty byte vector**. Else HTTP ≥ 400 →
  `download failed (HTTP {status}): {trimmed body, first 500 chars}`. Else raw bytes.
  Write bytes to `--output` (`failed to write file: {output}: <io>`; parent dir not created).
- Output: `{"ok":true,"data":{"fileKey":K,"fileSize":<byte count>,"outputPath":<as given>}}`.
- Side effects: read-only server; writes local file.
- Parity: SAFE (read) with a known fileKey.

### 4.3 `onchainos agent sensitive-words`  (hidden: no)
- Handler: `chat/mod.rs:72` → `fetch_sensitive_words` (245). No options.
- Auth: jwt-required. Steps: `GET /priapi/v1/aieco/im/risk/a2a/sensitive/word/list` (no query, no agenticId) via `get_authed`.
- Output: `{"ok":true,"data":<backend data>}`. Side effects: read-only. Parity: SAFE `agent sensitive-words`.

### 4.4 `onchainos agent message-eligible`  (hidden: no)
- Handler: `chat/mod.rs:78` → `fetch_message_eligible` (266).
- Options (all `--kebab`): `--agent-id`, `--client-agent-id`, `--provider-agent-id`, `--job-id`, `--group-id`, `--direction`,
  `--client-communication-address`, `--provider-communication-address` (required Strings); `--provider-security-rate` (optional);
  `--is-offline-replay <BOOL>` (optional, `BoolishValueParser`: true = `y|yes|t|true|on|1`, false = `n|no|f|false|off|0`, case-insensitive; value required when flag given).
- Auth: jwt-required.
- Steps: `GET /priapi/v1/aieco/im/message/eligible` with query in this order: `clientAgentId`, `providerAgentId`, `jobId`,
  `groupId`, `direction`, `clientCommunicationAddress`, `providerCommunicationAddress`, then `providerSecurityRate` (if given),
  then `isOfflineReplay=true|false` (if given); empty values dropped by `build_query_string`; header `agenticId: <agent-id>`.
  Error mapping: if the error is an `ApiCodeError` with HTTP 2xx and code ≠ `50114` → **Ok** `{"eligible":false,"reason":<msg>}`;
  every other error (auth 50114, non-2xx, 5xx, transport, force-refresh failure) → exit 1.
- Output: `{"ok":true,"data":<backend data>}` or `{"ok":true,"data":{"eligible":false,"reason":"…"}}`.
- Side effects: read-only. Parity: SAFE with real ids.

### 4.5 `onchainos agent system-config`  (hidden: no)
- Handler: `chat/mod.rs:111` → `fetch_system_config` (355). No options. Auth: jwt-required.
- Steps: `GET /priapi/v1/aieco/im/xmtp/system-config` via `get_authed` (no agenticId). Output: backend data. Read-only. Parity: SAFE.

### 4.6 `onchainos agent heartbeat`  (hidden: no)
- Handler: `chat/mod.rs:117` → `fetch_heartbeat` (370).
- Options: `--chain-index <CHAIN_INDEX>` (u64, required; non-u64 → clap error exit 2).
- Auth: jwt-required. Steps: `POST /priapi/v5/wallet/agentic/agent-heartbeat` body `{"chainIndex":<n>}` via `post_authed`.
- Output: backend data. Side effects: state (backend updates lastOnlineTime / device registration for all agents of the user).
- Parity: UNSAFE (state, no funds) `agent heartbeat --chain-index 196`.

### 4.7 `onchainos agent wakeup-notify`  (hidden: no)
- Handler: `chat/mod.rs:123` → `fetch_wakeup_notify` (392).
- Options: `--agent-ids <AGENT_IDS>` (Vec<String>, `value_delimiter=','`, repeatable, optional).
- Auth: jwt-required.
- Steps: empty list → Err `--agent-ids must contain at least one agent ID` (before auth, exit 1). Token →
  `POST /priapi/v1/aieco/task/wakeupNotify` body `{"agentIds":[…in given order…]}`, header `agenticId: <first id>`, via
  `post_authed_with_headers`.
- Output: backend data (in-flight jobs list). Side effects: state (backend emits system notifications).
- Parity: SAFE `agent wakeup-notify` → `{"ok":false,"error":"--agent-ids must contain at least one agent ID"}`; UNSAFE with ids.

### 4.8 `onchainos agent next-action`  (hidden: no)
- Handler: inline `agent_commerce/mod.rs:2752-3050` (+ helpers 3152-4719).
- Options: `--agentId <AGENT_ID>` (required; hidden alias `--agent-id`); `--role <ROLE>` (required String, not validated by clap);
  `--message <MESSAGE>` (required JSON string); `--a2a-file <A2A_FILE>` (optional path).
- Auth: jwt-optional — task-detail reads use `TaskApiClient::get_with_identity` (JWT + `agenticId` + `sessionCert` query);
  most read failures degrade (see freshness); `--role auto` spawns `agent get-agents`.
- Steps:
  1. Parse `--message` strictly as JSON (any JSON value). On failure, `escape_control_chars_in_strings` and retry; success →
     stderr `[next-action] --message had raw control chars inside string values; auto-repaired and parsed. Strict parse error was: {strict_err}`;
     failure → Err `--message must be a valid JSON object: {strict_err}` (serde_json Display, e.g. `… at line 1 column 15`).
  2. If `--a2a-file`: `validate_a2a_file_arg(path, message.jobId (string) or "", agentId)` (mod.rs:3331) and set
     `message["a2aFile"] = <spool path>`:
     - path must be non-empty and, after `canonicalize`, lie under canonical `std::env::temp_dir()` (or `/tmp` on unix) else
       `--a2a-file must point to a file under the OS temp directory` (also when the file does not exist);
     - `symlink_metadata` error → `--a2a-file metadata read failed: {e}`; not a regular file →
       `--a2a-file must be a regular file, not a symlink or directory`; unix mode ≠ 0600 → `--a2a-file must have mode 0600; run chmod 600`;
     - read (`--a2a-file read failed: {e}`), trim; empty → `--a2a-file payload is empty`; strict JSON (no repair) else
       `--a2a-file payload is not valid JSON: {e}`;
     - `msgType` string required (`--a2a-file payload.msgType is required`) and == `a2a-agent-chat`
       (`--a2a-file payload.msgType must be a2a-agent-chat`);
     - `jobId` string required (`--a2a-file payload.jobId is required`) and == message jobId
       (`--a2a-file payload jobId {pj} does not match --message jobId {mj}`);
     - `receiverAgentId` string required (`--a2a-file payload.receiverAgentId is required`) and == `--agentId`
       (`--a2a-file receiverAgentId {r} does not match --agentId {a}`);
     - `content` string required (`--a2a-file payload.content is required`); last non-blank line trimmed must be
       `[intent:deliver]` (`--a2a-file content must end with [intent:deliver]`); first line whose trim starts with `jobId:` gives
       the embedded id (trimmed) (`--a2a-file content.jobId is required`), must equal payload jobId
       (`--a2a-file content jobId {e} does not match payload jobId {pj}`);
     - spool: jobId must be `[A-Za-z0-9_-]+` (`--a2a-file: invalid jobId for the spool filename`); write compact sorted-key JSON of the
       payload to `<temp_dir>/a2a_deliver_{jobId}_{unix_nanos}_{pid}_{seq}.json` (`_{n}` suffix before `.json` for collisions, up to 20,
       else `--a2a-file: could not allocate a unique spool filename`) via temp `.{fname}.{pid}.{nanos}.{n}.tmp` (create_new, 0600,
       fsync, rename; failure `--a2a-file secure spool write failed: {e}`). The original file is not modified.
  3. `event` = `message.event` string else Err `--message.event is required`. `jobId` = `message.jobId` string; missing is allowed
     (→ `""`) only for events `reward_claimed` and `create_task`, else Err `--message.jobId is required`.
     `code` = `message.code` if a JSON integer fitting i32 else 0; `jobTitle`, `provider`, `data` = string fields (non-strings → None).
  4. Non-empty jobId → `validate_job_id` (message above) else Err.
  5. `provider` present → `negotiate::save_designated_provider(jobId, provider)` (local file; errors ignored).
  6. If `code != 0` and event ∉ {`job_expired`,`submit_expired`,`job_asp_accept_expire`}: print on stdout (plain text,
     `println!` adds the final newline) the following, where `⏎` marks a newline character:
     ````text
     【交易失败】{label}（code={code}）⏎⏎运行 `onchainos agent user-notify` 通知用户：⏎```bash⏎onchainos agent user-notify --content '[{label}]{title_part}（{jobId}）交易执行失败（code={code}）。'⏎```⏎→ 结束 turn。
     ````
     label = `Event::parse(event).failure_label()`, title_part = ` **{jobTitle}**` (leading space) or a single space
     when `jobTitle` is absent; the brackets/parentheses are full-width `（` `）` / `：` exactly as shown. Exit 0.
     This happens **before** role resolution and before any HTTP.
  7. Role: `--role auto` → `query_agent_by_id_direct(agentId)` (subprocess `get-agents`); `role` 1→`user`, 2→`asp`, 3→`evaluator`;
     other → Err `agentId={agentId} has unsupported role={:?}; pass --role explicitly` (`Some(4)`/`None`); lookup error →
     Err `could not resolve role for agentId={agentId}: {e}; pass --role explicitly`. Otherwise role verbatim.
  8. `user` + event `job_created` + no provider + no local designated-provider file → `GET /priapi/v1/aieco/task/{jobId}` (identity);
     non-empty `providerAgentId` string is persisted; all errors ignored.
  9. `user`: event `job_submitted` → `review_gate::mark_pending(jobId)`; `approve_review` → `mark_approved(jobId)` (errors ignored).
  10. Freshness gate: skipped (no prefetch) when `(role ∈ {user, asp} && event == job_completed) || (role == user && event == sub_complete_notify)`;
      otherwise `check_status_freshness` (below). A returned warning is printed verbatim (+`\n`) and the command exits 0.
  11. Dispatch on resolved role (paymentMode = prefetched.paymentMode):
      - `asp`: audit `provider/next_action_received` (args `jobId=…`,`agentId=…`,`event=…`,`code=…`,`paymentMode={:?}`); if
        paymentMode == Some(3) and event ∉ {`sub_complete_notify`,`job_completed`} → text
        `legacy_a2mcp_flow_removed: task-based A2MCP processing is disabled for job {jobId}. Stop; do not deliver, complete, sign, or pay.`;
        else `task::asp::flow::generate_next_action(job, event, agentId, jobTitle, data, prefetched, message)`.
      - `user`: audit `user/next_action_received`; `task::user::flow::generate_next_action(job, event, agentId, jobTitle, data, paymentMode, prefetched, message)`.
      - `evaluator`: audit `evaluator/next_action_received`; `task::evaluator::flow::generate_next_action(job, event, agentId, message)`.
      - other → Err `--role 必须是 asp/user/evaluator，当前: {role}` (after the freshness gate has already run).
      Print the prompt + `\n`; exit 0.
- `check_status_freshness(job, event, agentId, role, message)` (mod.rs:4231) → `(warning?, prefetched?)`:
  - PREFETCH_ONLY = {`deliverable_received`,`job_provider_reject`,`attachment_added`,`provider_conversation`,`sub_open`,`sub_created`,
    `sub_cancel`,`sub_user_reject`,`sub_asp_agree`,`sub_asp_dispute`,`sub_trial_into_active`,`sub_renew`,`sub_expire_warn`,
    `sub_complete_notify`,`sub_close_notify`,`sub_failed_notify`,`sub_reject_refund_notify`,`sub_asp_selected`}.
  - SKIP_ALL = {`create_task`,`approve_review`,`reject_review`,`user_attachment_received`,`job_user_reject`,`raise_arbitration`,
    `dispute_raise`,`agree_refund`,`raise_subscription_arbitration`,`sub_dispute`,`sub_agree_refund`,`staked`,`unstake_requested`,
    `unstake_claimed`,`unstake_cancelled`,`stake_stopped`,`evaluator_selected`,`vote_committed`,`reveal_started`,`vote_revealed`,
    `vote_commit_deadline_warn`,`vote_reveal_deadline_warn`,`cooldown_entered`,`round_failed`,`reward_claimed`,`wakeup_notify`,
    `sub_asp_claim_notify`} → `(None, None)` immediately.
  - arbitration source: `job_rejected`/`user_decision_job_rejected` → `job_rejected`; `sub_user_reject`/`user_decision_sub_user_reject`
    → `sub_user_reject`; relay = event starts with `user_decision_` and has a source.
  - expected = `status_when_event(parse_status_or_event(event))`; if not prefetch-only, not relay and expected is `Other("unknown")` → `(None,None)`.
  - Retry loops (4 attempts, sleeps 250/750/1500 ms between attempts, break when ready):
    a. role `user`, event `dispute_resolved`: `fetch_authoritative_refund_context`; ready = `dispute_result_context_block_reason` is None.
       No context → `[next-action blocked] Cannot fetch composed buyer-owned evaluation detail for dispute_resolved: {diag}. Do not announce a verdict, rate, notify, or clean up.`
       (diag = last error `{:#}` or `authoritative evaluation detail unavailable`); else block reason or pass.
    b. role `user`, event `sub_failed_notify`: same with `subscription_failed_context_block_reason`; no context →
       `[next-action blocked] Cannot fetch composed buyer-owned subscription detail for sub_failed_notify: {diag}. Do not notify or clean up.`
       (default diag `authoritative subscription detail unavailable`).
    c. role `user` and `refund_event_status_policy(event)` = (expected, needsFinal): ready = `buyer_refund_freshness_ready`. No context →
       ``[next-action blocked] Cannot fetch the Refund authoritative detail for {event}: {diag}. Run `onchainos agent refund-prepare {job}` before processing this refund lifecycle notice.``
       (default `authoritative refund detail unavailable`); status ≠ expected or buyer ≠ agentId →
       ``[next-action blocked] The {event} event does not match fresh buyer-owned Refund status {status:?}; expected {expected}. Run `onchainos agent refund-prepare {job}` to reconcile and do not report completion.``; else pass with context.
    d. role `asp` with a refund policy event: `fetch_authoritative_refund_context_for_provider`; ready = status==expected && provider==agentId.
       No context → `[next-action blocked] Cannot fetch composed task/subscription detail for {event}: {diag}. Do not notify or clean up an ASP session from caller-supplied event data.`
       (default `authoritative provider detail unavailable`); then `asp_refund_context_block_reason`.
  - Otherwise single read: path = `/priapi/v1/aieco/task/subscribe/{job}` if event starts with `sub_` or is `user_decision_sub_user_reject`,
    else `/priapi/v1/aieco/task/{job}`; `get_with_identity`. On error: arbitration source → warning
    `blocked_result("status_unavailable", job, {"error":<e.to_string()>,"sourceEvent":event})`; event ∈ {`job_accepted`,`sub_open`,
    `sub_created`,`sub_asp_selected`} or (asp && refund policy) or (user|asp && subscription side-effect policy) →
    `[next-action blocked] Cannot fetch latest task detail for {event}: {e:#}. Do not process this lifecycle notice from stale or incomplete event data.`;
    else `(None, None)`.
  - `sub_open` requires subscription status 0 (`CREATED`), `sub_created`/`sub_asp_selected` status 1 (`ACTIVE`) (status = `subStatus` ?? `status`, int or numeric string):
    `[next-action blocked] Latest subscription status is {s}, not {NAME}({n}). Do not execute the {event} flow.` or
    `[next-action blocked] Latest subscription detail has no valid subStatus/status. Do not execute the {event} flow.` (no prefetch).
  - ctx = `PreFetchedTaskContext::from_api_response(detail)`; `subscription_side_effect_context_block_reason` (policy: `sub_user_reject`→3,
    `sub_asp_dispute`→4, `sub_complete_notify`→6, `sub_close_notify`→7, `sub_failed_notify`→9; owner = user_agent_id for `user`,
    provider_agent_id for `asp`, other roles → `[next-action blocked] Role {role} cannot process subscription lifecycle event {event}.`;
    owner mismatch → `[next-action blocked] Fresh subscription detail does not bind {event} to {role} Agent {agentId}. Do not run notification, evidence-upload, decision, or cleanup side effects from caller-supplied event data.`;
    status mismatch → `[next-action blocked] Fresh subscription status {status:?} does not match {event} expected status {n}. Do not run lifecycle side effects from stale event data.`).
  - asp → `asp_refund_context_block_reason` (refund events only; unreachable after (d)).
  - arbitration source → stale if `arbitration_context_is_stale` → warning `blocked_result("stale_event", job, {"sourceEvent":event})` (with ctx), else pass.
    Stale rules: `job_rejected` needs detail `status` scalar == `"3"`; `sub_user_reject` needs (`subStatus` ?? `status`) == `"3"` and period match
    (relay `params.decisionBindingKey/Value` → detail[key] == value; else each of `periodIndex`,`subStartTime`,`subEndTime` present in the message
    must equal the detail's). Exception: asp + event `job_rejected` + provider==agentId + jobType 0 + status 9 + zero token amount → not stale.
  - `job_submitted`: attach deliverable to ctx from the A2A spool (`try_recover_from_temp_file`, short id = first 10 chars of jobId) else the newest
    manifest entry under `deliverables/user/<job>/` (text content read for `text` type) — local only.
  - prefetch-only or subscription events → pass with ctx.
  - actual = `Status::from_int(detail.status)` (int or numeric string); missing → pass. Match if actual == expected, or event `dispute_resolved`
    and actual ∈ {completed, failed} → pass. Else warning:
    ```
    🛑 **Stale state — playbook blocked** (next-action's event arg is inconsistent with the task's real status; not emitting steps to prevent on-chain action on a stale event).\n\n- You passed event = `{event}` (expected task status = `{expected}`)\n- But task {job} real statusStr = `{actual}`\n\n**MUST do** (pick one):\n1. If the current inbound is a **P2P message** (a2a-agent-chat) → you likely picked the wrong event. Re-match the pseudo-event from the message content (e.g. `[intent:deliver]` → `deliverable_received`; a natural-language quote → `negotiate_reply`). Pseudo-events are not freshness-gated.\n2. If the current inbound is a **system event** → re-run next-action with the `event` field in the `--message` JSON changed to `{actual}` (fetch the playbook matching the real status), or just ignore this stale notification and end the turn waiting for the next real chain event.\n\n**MUST NOT**: do NOT guess the next step; do NOT call any task CLI before getting a fresh playbook; do NOT push this warning to the user via `onchainos agent user-notify`.\n
    ```
    (`\n` = newline; printed with an extra trailing newline by `println!`).
  - Policy tables (mod.rs): `refund_event_status_policy` — `job_closed`,`job_asp_reject_closed` → (7, final); `job_refunded`,`job_auto_refunded`,
    `sub_asp_agree`,`sub_reject_refund_notify` → (9, final); `job_expired`,`submit_expired`,`job_asp_accept_expire` → (8, not final);
    `job_asp_reject_expire` → (9, final). `buyer_refund_event_status_policy` applies it only for role `user`.
    `buyer_refund_freshness_ready` = status & buyer match, and (not final, or `job_asp_reject_closed` with jobType 1, or `refund_final_context_ready`).
    `refund_final_context_ready` = status & buyer match and (closed(7) one-time zero-amount | `job_asp_reject_expire` one-time zero-amount |
    `refund_event_settlement_confirmed(ctx, expected, event)`). `dispute_result_context_block_reason`: jobType ∉ {0,1} →
    `[next-action blocked] Fresh evaluation detail is missing a supported jobType. Do not announce a verdict, rate, notify, or clean up from caller-supplied event data.`;
    buyer mismatch → `[next-action blocked] Fresh evaluation detail does not bind dispute_resolved to User Agent {id}. Do not announce a verdict, rate, notify, or clean up from caller-supplied event data.`;
    no provenance → `[next-action blocked] Fresh terminal status has no durable local refund-request provenance. Do not treat an ordinary completion/failure as an evaluation verdict or run rating/cleanup side effects.`;
    status 6 ok; status 9 ok iff settlement confirmed else `[next-action blocked] Fresh subscription Failed(9) is ambiguous and has no durable local refund-request provenance. Do not announce an evaluation refund or clean up; reconcile with refund-prepare.`;
    other → `[next-action blocked] Fresh evaluation status {status:?} is not Completed(6) or a confirmed user-refund Failed(9). Do not announce a verdict, rate, notify, or clean up.`
    `subscription_failed_context_block_reason`: jobType ≠ 1 → `[next-action blocked] Fresh detail does not identify a subscription for sub_failed_notify. Do not notify or clean up from a task-type-mismatched event.`;
    buyer mismatch → `[next-action blocked] Fresh subscription detail does not bind sub_failed_notify to User Agent {id}. Do not notify or clean up from caller-supplied event data.`;
    status ≠ 9 → `[next-action blocked] Fresh subscription status {status:?} is not Failed(9). Do not notify or clean up from a stale sub_failed_notify event.`
    `asp_refund_context_block_reason`: provider ≠ agentId → `[next-action blocked] Fresh task detail does not bind {event} to ASP {id}. Do not notify or clean up a provider session from caller-supplied event data.`;
    status mismatch → `[next-action blocked] Fresh task detail status {status:?} does not match {event} expected status {n}. Do not notify or clean up a provider session from stale event data.`
    (`{status:?}` renders `Some(7)` / `None`).
- Output: plain text (prompt, failure notice, or blocked warning) on stdout, exit 0; errors → envelope exit 1.
- Side effects: local files (designated provider, review gate, a2a spool, deliverables); reads task detail; downstream playbook generators may
  have their own side effects (owned elsewhere).
- Nondeterminism: spool path (nanos/pid/seq), backend state, retry timing.
- Parity test cases:
  1. SAFE: `agent next-action --agentId 1 --role user --message 'not json'` → exit 1 `--message must be a valid JSON object: <serde_json error>`
     (serde_json Display, expected `expected ident at line 1 column 2`).
  2. SAFE: `--message '{"jobId":"0x1"}'` → exit 1 `--message.event is required`.
  3. SAFE: `--message '{"event":"job_accepted","jobId":"0x12"}'` → exit 1 validate_job_id message (`got 4 chars`).
  4. SAFE (no HTTP): `--role user --message '{"event":"job_created","jobId":"0x' + 64×'a' + '","code":1,"jobTitle":"T"}'` → failure text with label `transaction failed`, title ` **T**`.
  5. `--role user --message '{"event":"create_task"}'` → jobId `""` allowed, no validation, freshness SKIP_ALL (no task-detail HTTP);
     the printed prompt comes from `task::user::flow::generate_next_action` (owned elsewhere — classify SAFE/UNSAFE per that spec).

### 4.9 `onchainos agent cache-notify`  (hidden: yes)
- Handler: inline mod.rs:1895 → `task::common::prefilled_notify::save` (prefilled_notify.rs:33).
- Options: `--job-id`, `--event-key`, `--content` (required Strings). Auth: anonymous.
- Steps: `mkdir -p $ONCHAINOS_HOME/task/<job-id>/cache`; read `prefilled-notify.json` if present (unparsable → `{}`), set
  `map[event-key] = content`, write `to_string_pretty` (sorted keys, 2-space) via plain `fs::write` (no atomic rename). jobId not validated.
- Output: stdout `OK\n` (no JSON). Errors: I/O → envelope exit 1. Side effects: local-only. Parity: SAFE.

### 4.10 `onchainos agent cache-rating`  (hidden: yes)
- Handler: inline mod.rs:1905 → `prefilled_rating::save` (prefilled_rating.rs:35).
- Options: `--job-id`, `--score`, `--comment` (required; no format validation). Auth: anonymous.
- Steps: `mkdir -p …/task/<job-id>/cache`; write `prefilled-rating.json` = `{\n  "score": "<score>",\n  "comment": "<comment>"\n}` (struct order).
- Output: `OK\n`. Side effects: local-only. Parity: SAFE.

### 4.11 `onchainos agent trade-kit-readiness`  (hidden: no)
- Handler: inline mod.rs:2042.
- Options: `--asset-class <ASSET_CLASS>` (required, repeatable/Append), `--environment <ENV>` (default `configured`).
- Auth: anonymous (local capability probe).
- Steps: `parse_runtime_asset_classes` — each must be exactly `spot|perp|prediction|option` else Err
  `asset class must be spot, perp, prediction, or option` (dedup, order kept); `TradeEnvironment::parse` —
  `configured|live|demo` else Err `environment must be configured, live, or demo`; `probe_runtime(classes, env)` (trade_kit.rs:481,
  spawns the local Trade Kit CLI; owned by autotrade) → `output::success(result)`.
- Output: `{"ok":true,"data":<RuntimeReadiness>}`. Side effects: local subprocess only. Parity: SAFE `--asset-class foo` → exit 1.

### 4.12 `onchainos agent autotrade-grant-check`  (hidden: no) — bespoke contract
- Handler: inline mod.rs:2060.
- Options: `--job-id`, `--venue`, `--action`, `--amount`, `--format` (all required).
- Steps: `--format` ≠ `json` → print `{"ok":false,"reason":"invalid format"}` and exit **1** (no envelope). Else
  `grants::check_grant(job, venue, action, amount)` (grants.rs:142; local grant file) → allow: print `{"ok":true}` exit 0;
  deny: `{"ok":false,"reason":"<deny reason>"}` exit 1. Deny reasons: `invalid job id`, `invalid venue`, `invalid action`,
  `invalid amount`, `no grant file`, `grant file unreadable`, `grant version too new`, `grant job mismatch`, `grant expired`,
  `venue not authorized`, `no cap for action`, `per-trade cap exceeded`. Output is always compact (ignores `ONCHAINOS_PRETTY`).
- Side effects: local read-only. Parity: SAFE `--format text` → `{"ok":false,"reason":"invalid format"}` exit 1.

### 4.13 `autotrade-guide-consent-update` / `autotrade-guide-consent-new`  (hidden: no)
- Handlers: inline mod.rs:2251 / 2269.
- Options: `--job-id`, `--values-json` (required); `new` adds `--ttl-sec` (u64, default 31536000).
- Steps: parse `--values-json` into a JSON object (`BTreeMap`) else Err `--values-json must be a JSON object: {serde error}`;
  update → `guide::update_active_consent_values` (errors e.g. `active Guide Consent is not available locally`); new →
  `guide::create_active_consent_from_guide` (`--ttl-sec must be > 0`, `active Guide Consent already exists; use autotrade-guide-consent-update to replace values`).
- Output: update `{"ok":true,"data":{"consentStatus":"active","guideHash":H,"jobId":J,"updated":true}}`;
  new `{"ok":true,"data":{"consentStatus":"active","created":true,"guideHash":H,"jobId":J}}`. Local-only.

### 4.14 `onchainos agent autotrade-consent-request`  (hidden: yes)
- Handler: inline mod.rs:2107. Options: `--job-id`, `--agent-id` (ignored), `--delivery-id`, `--signal-type` (ignored).
- Steps: `executor::report_delivery(job, delivery, "skipped", "guide_execution_unavailable")?` (needs trusted local delivery context,
  else Err `trusted delivery context is unavailable: …`); `okx_a2a::mark_retired_autotrade_mode_decisions_handled(job)` (ignored).
- Output: `{"ok":true,"data":{"decision":false,"decisionPushed":false,"deliveryId":D,"guidance":"The Signal remains saved for receive/display only. This retired Consent flow cannot authorize Guide-driven execution; do not create another execution decision.","jobId":J,"outcome":<ExecutionOutcome>,"reason":"guide_execution_unavailable","status":"skipped","terminal":true}}`.

### 4.15 `onchainos agent autotrade-cap-adjust-request`  (hidden: yes)
- Handler: inline mod.rs:2213. Options: `--job-id`, `--agent-id`.
- Steps: `consent::load_consent(job)?` none → Err `no live auto-trade consent`; mode ≠ Auto → Err `cap adjustment is only valid for auto consent`;
  amount = `trade_amount_u` or `""`, cap = `cap_u` or `""`; `Decimal::parse(amount)?`; if `evaluate_consent(job, amount)` == AutoOverCap →
  `card::make_cap_adjust_decision("trade", job, agent, amount, cap)`, target = pending delivery context provider; `pending_v2::push_decision_direct(job,"user",agent,target,content,label,sourceEvent)`
  Ok → `{"decision":true,"decisionPushed":true,"sourceEvent":…}`; Err → data = the decision struct itself; else `{"capAlreadySufficient":true}`.
- Side effects: local + `okx-a2a` decision push (local runtime).

### 4.16 Other inline wrappers
- `autotrade-direct-claim` / `autotrade-guide-prepare` (hidden): options `--job-id`, `--delivery-id` →
  `executor::claim_guide_direct` / `prepare_guide_direct` (async; executor.rs:1762/1726) → `output::success(result)`. Both re-verify the
  subscription through `hydrate_subscription_contract` (executor.rs:1686: `TaskApiClient` +
  `autotrade::subscription::determine_active_delivery`, i.e. an authenticated subscription-detail read; errors
  `subscription is no longer Active`, `Active subscription no longer matches this delivery`).
- `autotrade-direct-finalize` (hidden): options `--job-id`, `--delivery-id`, `--status` (`submitted|failed_before_submit|unknown_after_submit`),
  `--tool-id`, `--receipt-id?`, `--reason?` → `executor::finalize_direct` → success(outcome).
- `autotrade-once-authorize` (hidden): `--job-id`, `--delivery-id`, `--amount` → `executor::authorize_one_time` → success(permit).
- `autotrade-outcome-flush` (hidden): `--job-id` → `executor::flush(job)` → success(Vec<outcome>).
- `autotrade-delivery-report` (hidden): `--job-id`, `--delivery-id`, `--status` (`skipped|failed_before_execution`), `--reason` → `executor::report_delivery` → success(outcome).
- `autotrade-grant-write` (hidden, debug only): `--job-id`, `--venue`, `--max-buy?`, `--max-sell?`, `--ttl-sec` (u64 required) → `grants::write_grant` → `{"ok":true}`.
- `task-deliverable-save`: `--job-id`, `--role`, `--file`, `--deliverable-type` (default `file`), `--title`, `--short-id` (required
  except type), `--file-key?`, `--token-symbol?`, `--token-amount?`, `--counterparty-agent-id?`, `--counterparty-name?` →
  `deliverables::handle_save(&SaveParams{…})?` → `output::success(result)` (local-only).
- `task-deliverable-list`: `--job-id?`, `--role` (default `user`), `--search?` → with job id `handle_list(job, role)`, else
  `handle_list_all(role, search)` (handlers print; local-only).
All of these are local-only (plus `okx-a2a` runtime notifications where the executor does so) except the guide-direct pair above,
which performs a read of subscription detail; their business logic is owned by the autotrade / deliverables partitions.

---

## 5. HTTP endpoints (classification)

| method | path | class | used by |
|---|---|---|---|
| POST | `/priapi/v1/aieco/im/attachments/xmtp/encrypted/upload` | state | file-upload |
| GET | `/priapi/v1/aieco/im/attachments/xmtp/encrypted/download` | read | file-download |
| GET | `/priapi/v1/aieco/im/risk/a2a/sensitive/word/list` | read | sensitive-words |
| GET | `/priapi/v1/aieco/im/message/eligible` | read | message-eligible |
| GET | `/priapi/v1/aieco/im/xmtp/system-config` | read | system-config |
| POST | `/priapi/v5/wallet/agentic/agent-heartbeat` | state | heartbeat (+ wallet login) |
| POST | `/priapi/v1/aieco/task/wakeupNotify` | state | wakeup-notify |
| GET | `/priapi/v1/aieco/task/{jobId}` (`?sessionCert=`) | read | next-action (freshness, job_created fallback, refund composition) |
| GET | `/priapi/v1/aieco/task/subscribe/{jobId}` (`?sessionCert=`) | read | next-action (sub_* freshness, refund composition); autotrade-guide-prepare / autotrade-direct-claim (`TaskApiClient::fetch_subscription`) |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | every jwt command (via ensure_tokens_refreshed / force refresh) |
| POST | `/api/v6/dex/market/token/basic-info` | read | a2mcp-probe probe (402 branch; via payment/quote.rs) |
| GET | `/api/v6/dex/balance/all-token-balances-by-address` | read | a2mcp-probe probe (402), refresh-balance, resume-after-funding |
| POST | `/priapi/v5/wallet/agentic/chain/support/list` | read | a2mcp-probe prepare-payment `--yes`, resume-after-funding (payer resolution, cached) |

No endpoint in this partition moves funds. `a2mcp-probe prepare-payment --yes` / `resume-after-funding --yes` create a local payment
intent that authorises a later `onchainos payment` execution (payment partition).

## 6. External hosts

- **Merchant A2MCP endpoint** (`serviceSnapshot.endpoint`, any HTTPS host) — `a2mcp-probe probe` (`send_probe`), unsigned GET/POST, 10 s timeout.
- `https://beta.okex.org` when hidden `--dev` is set (all OKX calls).
- DoH resolvers / DoH helper binary used by `WalletApiClient` failover (core `doh` module) — every OKX call in this partition.
- Local subprocesses (not hosts): `<current_exe> agent get-agents` (next-action `--role auto`), `okx-a2a` runtime (autotrade notices /
  decisions), Trade Kit CLI (`trade-kit-readiness`).

## 7. Notes for the lite re-implementation (from the relayed user request)
- Do not reuse onchainos login state, but implement the same login flow: JWT access/refresh tokens + session key expiry +
  refresh via `/priapi/v5/wallet/agentic/auth/refresh`, the header set in §1.5, and the post-login heartbeat
  (`fetch_heartbeat`, chainIndex 196, 4 s timeout, non-fatal).
- Free A2MCP probes need no login at all; paid probes need a selected wallet (`wallets.json selected_account_id`) and wallet
  balances; chat commands need the JWT.

## 8. Open questions

1. Exact Rust error `Display` strings that surface in probe payloads / CLI errors must be reproduced verbatim by a Node port:
   base64 0.22 `DecodeError` (believed: `Invalid symbol {byte}, offset {idx}.`, `Invalid input length: {n}`,
   `Invalid last symbol {byte}, offset {idx}.`, `Invalid padding`), `FromUtf8Error`, `url::ParseError`
   (`relative URL without a base`, `empty host`, …) and `serde_json::Error` (`… at line L column C`). These were not verified
   against crate sources (no local cargo registry).
2. Path-carrier quirk in `a2mcp-probe probe`: the endpoint is serialised from a parsed URL, so `{name}` placeholders become
   `%7Bname%7D` and `build_typed_request` always fails with `a2mcp_invalid_typed_params: path placeholder '{name}' is missing`
   → reason `invalid_a2mcp_params`. Preserve for parity or fix?
3. Key ordering: every `serde_json::Value` is emitted with recursively sorted keys (no `preserve_order`), while struct-typed
   envelopes (`JsonOutput`, `ProbeDecision`, `Action`, pretty state files) keep declaration order. Float formatting of
   passthrough numbers (e.g. `feeAmount` → `asp_amount` string via Rust `f64` Display) may differ from JS `String(n)` for
   exponents / large values.
4. Merchant-probe wire details: reqwest sends `accept: */*` and no `User-Agent`; Node fetch adds its own UA / `accept-encoding`.
   Multipart upload (`file-upload`) boundary and part-header layout are reqwest-generated — the parity harness must normalise them.
5. The relayed user request mentions supporting "the muse"; nothing named "muse" exists in this partition's sources, so the
   intended scope is unclear.
6. `next-action --role auto` spawns the running executable (`<current_exe> agent get-agents --agent-ids <id>`); a Node port must decide
   whether to spawn itself or call the handler in-process (same HTTP traffic either way).
7. Output shapes of the autotrade executor results (`ExecutionOutcome`, `OneTimePermit`, guide-direct prepare/claim results,
   `RuntimeReadiness`) and deliverables `SaveResult` are defined outside this partition; the owning group must be confirmed.
8. On Windows the `--a2a-file` 0600 mode check is skipped and `std::env::temp_dir()` is `%TMP%`/`%TEMP%` (canonicalised with `\?\`
   prefixes); the lite port should mirror platform-specific behaviour or document the difference.
