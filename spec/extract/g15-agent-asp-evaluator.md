# g15-agent-asp-evaluator — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the ASP (provider) side of the task system (`task/asp/**`) and the evaluator / arbitration-juror +
staking side (`task/evaluator/**`). That is 32 visible `onchainos agent …` leaves (31 implemented here + `dispute upload`,
which is only routed here; no hidden leaf and no hidden flag is defined in this partition — the internal `ProviderCommand`
enum is not mounted directly, only through the `AgentCommand` variants listed below) plus the two role playbook generators (`asp::flow::generate_next_action`,
`evaluator::flow::generate_next_action`) consumed by `agent next-action` (dispatch/freshness owned by g11a/g12).
`agent dispute upload` is routed through this partition (`asp/mod.rs:429`) but its implementation lives in
`common/dispute_upload.rs` and is fully specified in g12; it is only cross-referenced here.

Conventions (inherited, see g11a §0 and g12 §0 — summarised here because they govern byte parity):
- Success JSON envelope `{"ok":true,"data":<data>}` single line (compact unless env `ONCHAINOS_PRETTY=1`). Any
  `serde_json::Value` (built with `json!` or parsed from the backend) serialises with **keys sorted by byte order**
  (serde_json without `preserve_order`); only `#[derive(Serialize)]` structs printed directly keep declaration order.
- Error → stdout `{"ok":false,"error":"<format!("{e:#}")>"}` (anyhow chain, outer context first, `": "`-joined), exit 1.
  `CliFundingBlocked` → `{"ok":false,"data":<data>}` exit 1. clap errors → usage text on stderr, exit 2.
- **Many commands in this partition print plain text (not JSON) on success**; each is called out below. Plain
  text is written with `println!` (each line + `\n`).
- The global `--chain` flag is accepted on every leaf but forced to `xlayer` for all `agent` commands and never
  read here. The hidden global `--dev` switches the base URL to `https://beta.okex.org`.
- Before any `agent` leaf runs, the pre-dispatch autotrade maintenance (g11a §1.3) executes (no stdout).
- `DEBUG_LOG` (`cfg!(feature="debug-log")`) is false in release: every `if DEBUG_LOG { eprintln!… }` is absent.
  `#[cfg(debug_assertions)]` code (the `ONCHAINOS_TEST_MOCK_SUBSCRIPTION` mocks in `deliver`/`subscribe-active`)
  is **compiled out of release builds** and must not be reproduced.
- Rust string-literal rules matter for verbatim text: a `\` at end of a source line removes the newline **and all
  leading whitespace of the next line**; `\x20` is a literal space that survives; inside `format!` `{{`/`}}` render as
  single `{`/`}`, while a `{name}` argument whose value contains `{{…}}` is inserted verbatim (double braces kept).

---

## Sources read

Partition files (every line read, tests included):

| File (under `cli/src/commands/agent_commerce/task/`) | Lines |
|---|---|
| `asp/mod.rs` | 449 |
| `asp/agreerefund.rs` | 54 |
| `asp/apply.rs` | 86 |
| `asp/asp_claim.rs` | 61 |
| `asp/asp_reject.rs` | 62 |
| `asp/content.rs` | 956 |
| `asp/deliver.rs` | 547 |
| `asp/dispute_confirm.rs` | 67 |
| `asp/dispute_raise.rs` | 293 |
| `asp/flow.rs` | 2786 |
| `asp/provider_decision.rs` | 391 |
| `asp/subscription.rs` | 668 |
| `asp/task_query.rs` | 840 |
| `asp/v2/mod.rs` | 3 |
| `asp/v2/job_completed.rs` | 277 |
| `asp/v2/notification.rs` | 558 |
| `asp/v2/sub_complete_notify.rs` | 56 |
| `evaluator/mod.rs` | 23 |
| `evaluator/claim.rs` | 34 |
| `evaluator/claimable.rs` | 41 |
| `evaluator/commit.rs` | 148 |
| `evaluator/decimal_str.rs` | 162 |
| `evaluator/dispute_status.rs` | 248 |
| `evaluator/flow.rs` | 611 |
| `evaluator/helpers.rs` | 16 |
| `evaluator/info.rs` | 122 |
| `evaluator/my_stake.rs` | 57 |
| `evaluator/reveal.rs` | 75 |
| `evaluator/stake.rs` | 182 |
| `evaluator/staking_config.rs` | 23 |
| `evaluator/staking_types.rs` | 196 |
| `evaluator/unstake.rs` | 256 |

Supporting sources (partial reads to trace callees; behaviour owned by other groups):

| File | Range | Why |
|---|---|---|
| `commands/agent_commerce/mod.rs` (5373) | 1–60, 595–705, 870–1000, 1085–1260, 1400–1440, 1955–2050, 2575–2760, 2900–3050 | clap definitions of every leaf in this group; dispatch arms; `next-action` role dispatch |
| `task/mod.rs` (13) | all | module tree |
| `task/signing.rs` (627) | 1–450 | `resolve_wallet*`, `sign_uop_and_broadcast*`, `merge_biz_context` |
| `task/common/claim.rs` (86) | all | `submit_claim_and_broadcast`, `fetch_and_print_claimable` |
| `task/common/network/task_api_client.rs` (459) | all | transport, path helpers, sessionCert injection, bytes GET |
| `task/common/okx_a2a.rs` (1259) | 19–320, 640–790, 905–1050 | readiness preflight, identity refresh, session send, xmtp-send, file upload/download, spawn timeout |
| `task/common/subscription_identity.rs` (41) | all | `select_subscription_agent_id` |
| `task/common/payment_mode.rs` (80) | all | `PaymentMode::from_int/as_str` |
| `task/common/mod.rs` | 40–100, 178–300, 369–420, 480–760 | constants, `PreFetchedTaskContext::from_api_response`, `fetch_agent_by_id`, `fetch_my_agents`, `find_service` |
| `task/common/query.rs` | 1–200, 354–413, 486–509 | `resolve_agent_id_or_error`, `status_name`, `task_status_label/description` |
| `task/common/state_machine.rs` (1241) | 24–702 | `Status`, `DisputeRoundStatus` (labels), `Event::parse/as_str`, `entry_event`, `parse_status_or_event` |
| `task/common/deadline.rs` | 15–30, 103–124 | timestamp normalisation / formatting |
| `task/common/util.rs` | 263–323, 474–489 | `ensure_sufficient_balance_at`, `short_job_id` |
| `task/common/deposit_qr.rs` | 57–82, 214–260 | `InsufficientBalanceError`, `enrich_blocking_at`, `balance_warning_base` |
| `task/common/funding_notice.rs` | 134–170 | `funding_blocked_envelope` |
| `task/common/template_vars.rs` | 50–86 | placeholder constants |
| `task/common/pending_v2.rs` | 2586–2650 | `request_command_block`, `encode_title_vars`, `encode_refund_decision_vars` |
| `task/common/deliverables.rs` | 100–240 | `SaveParams`, `handle_save` (move semantics) |
| `task/common/onchainos_self.rs` | 19–46 | `task_feedback_exists` |
| `task/common/dispute_upload.rs` | grep (44, 292) | handler location + upload endpoint (spec in g12) |
| `task/arbitration.rs` (1678) | 95–560, 700–860 | decision/progression helpers, `blocked_result`, `resolved_action`, provider arbitration list |
| `task/user/subscription_ops.rs` | 666–694 | subscription `status_label` / `status_description` |
| `task/user/refund.rs` | 1178–1191 | `validate_decimal`, `is_zero_decimal` |
| `task/user/attachments.rs` | 36–66 | `attachments_dir`, `dedup_dest` |
| `commands/agentic_wallet/transfer/mod.rs` | 82–112, 590–713 | `sign_and_build_extra_data`, `build_broadcast_body` |
| `commands/agentic_wallet/common.rs` | 1 | `ERR_NOT_LOGGED_IN = "not logged in"` |
| `wallet_api.rs` | 100–130, 721–763, 1170–1350 | `build_query_string`, `unwrap_wallet_envelope`, `handle_response`, `get_authed_with_headers` |
| `output.rs` | 1–125 | envelopes, `to_agent_json`, `CliFundingBlocked` |
| `home.rs` | 12–29 | `onchainos_home`, `task_state_dir` |
| `Cargo.toml` | grep | serde_json 1 (no `preserve_order`), version 4.6.3 |
| `spec/cli-tree.json` | agent subtree | flag cross-check (all 32 visible leaves listed below present; flags/defaults/required match source) |
| sibling specs g11a, g12 | helper sections | to reference rather than re-derive shared helpers |

---

## Shared helpers (used across groups or from core)

### A. Helpers owned by other groups (one-line summaries; see the owning spec)

- `TaskApiClient` (`task/common/network/task_api_client.rs:88`, g12 §1). Base URL `https://web3.okx.com` (prod) /
  `https://beta.okex.org` (`--dev`). Every call first runs `ensure_tokens_refreshed()` (JWT; may
  `POST /priapi/v5/wallet/agentic/auth/refresh`). Headers: `Content-Type: application/json`, `ok-client-version: 4.6.3`,
  `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id`, `device-name`, `Authorization: Bearer <jwt>`,
  `agenticId: <agentId as passed, untrimmed unless stated>`, `User-Agent: OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`.
  - `get_with_identity(path, agent)`: GET; appends `?sessionCert=<form-urlencoded cert>` when `session.json.sessionCert`
    is non-empty (**a path that already contains `?` gets a second `?`**). DoH retry + invalid-token retry.
  - `get_with_agent_id(path, agent)`: GET, no sessionCert query.
  - `get_bytes_with_identity(path, query, agent)`: plain reqwest (no DoH, no UA override, no retry), query via
    reqwest `.query()`; non-2xx → `evidence download failed ({status}): {url}; body={body}`; send error →
    `evidence download request failed: …`.
  - `post_with_identity(path, body, agent)`: POST JSON; `sessionCert` inserted into an object body when present and
    not already there; keys sorted. DoH retry + invalid-token retry.
  - `post_mutation_with_identity`: same body handling, **no retry**; connect/timeout →
    `Network result is unknown for this state-changing request. Query authoritative state before retrying.: <err>`.
  - Path helpers: `task_path(j)`=`/priapi/v1/aieco/task/{j}`, `endpoint(j,a)`=`/priapi/v1/aieco/task/{j}/{a}`,
    `subscribe_path(s)`=`/priapi/v1/aieco/task/subscribe/{s}`, `broadcast_path()`=`/priapi/v1/aieco/task/broadcast`,
    `dispute_list_path(p,s)`=`/priapi/v1/aieco/task/dispute/my?page={p}&pageSize={s}`. IDs are **not** percent-encoded.
  - `fetch_subscription(job, agent)`: trimmed agent empty → `agenticId is required to fetch subscription detail`;
    else `get_with_identity(subscribe_path(job), agent.trim())`.
  - Response unwrap: HTTP ≥500 `Wallet API server error (HTTP {n}): {raw}`; non-JSON
    `failed to parse wallet API response as JSON (HTTP {n}): …`; `code`≠0 → `Wallet API error (code={code}): {msg}`.
- `signing` (`task/signing.rs`, g12 §4):
  - `extract_biz_type(resp)` → `resp.type` as i64, default 0.
  - `resolve_wallet_by_agent_id(agent)` (:58): trims; empty → `agent_id must not be empty; pass the provider's own agentId`;
    self-subprocess `onchainos agent get-agents --agent-ids <id>` (→ `GET /priapi/v5/wallet/agentic/agent/batch-list`),
    takes `agentWalletAddress` of the entry whose `agentId`==id; missing →
    `cannot resolve wallet for agentId={id}; agentWalletAddress not found in \`onchainos agent get-agents\``; then
    `resolve_wallet(None, Some(addr))` = local `wallets` store lookup of that address on chain `okb`/X Layer
    (no wallets → `not logged in; run \`onchainos wallet auth\` first`). Returns `(accountId, address)`.
  - `resolve_wallet_and_agent_for_evaluator(agent)` (:173): trims; empty →
    `agent_id must not be empty (envelope top-level agentId required)`; same get-agents lookup; missing wallet →
    audit `evaluator/wallet_resolve_failed` + `cannot get wallet address for agentId={id}; verify the agentId exists in \`onchainos agent get-my-agents\``;
    local wallet miss → `agentId={id} wallet {owner} not found locally ({msg})`. Returns `(accountId, address, trimmedAgentId)`.
  - `sign_uop_and_broadcast_full(client, uopData, account, address, jobId, bizType, agent, extra?)` (:269):
    uopData null → `backend did not return uopData; cannot sign and broadcast`; parse `UnsignedInfoResponse` else
    `failed to parse uopData: {e}`; `executeResult === false` → `backend transaction preflight failed: {executeErrorMsg | "no error detail returned"}`;
    `build_broadcast_body(unsigned, account, address, "196", contractCall=true, mev=false, force=false)` (wallet group,
    g07: needs `session.json` + keyring `session_key`; decrypts the HPKE-wrapped session seed and Ed25519-signs the
    backend hashes; extraData = clone of `uopData.extraData` object + signing fields) → body
    `{"accountId","address","chainIndex":"196","extraData":"<json string>"}` (missing `session.json` or keyring `session_key` →
    error `not logged in`); `bizContext = merge_biz_context(jobId, bizType, extra)` = `{"bizType":…, "jobId":…, …extra keys (override)}`;
    `POST /priapi/v1/aieco/task/broadcast` via `post_mutation_with_identity` (body keys sorted:
    `accountId,address,bizContext,chainIndex,extraData,sessionCert`) — **FUND-MOVING**; error context `broadcast failed`.
    Returns `data[0]` (`{pkgId, orderId, orderType, txHash, bizUniqKey}`) or `null`.
  - `sign_uop_and_broadcast(...)` (:333) → `data[0].txHash` or the literal `pending`.
  - `sign_uop_and_broadcast_with_commit_meta(..., salt, vote, voteReport, voteReportSummary)` (:365): same checks;
    `bizContext = {"bizType","commitSalt","jobId","vote"(number),"voteReport","voteReportSummary"}`; broadcast error →
    `broadcast failed: {e}` (Display of the inner error only, not the chain).
- `common::claim` (`task/common/claim.rs`, g12 §5):
  - `submit_claim_and_broadcast(client, account, address, agent)`: `POST /priapi/v1/aieco/task/claim` body `{}`(+sessionCert)
    via `post_with_identity` → `sign_uop_and_broadcast(uopData, jobId="", bizType=resp.type, agent, None)` → txHash.
  - `fetch_and_print_claimable(client, agent)`: `GET /priapi/v1/aieco/task/claimable` (identity); prints
    `claimable rewards (account={data.account|""}, agentId={agent})` then per `data.rewards[]`
    `  {marker} {symbol:<8} {amount:>30}  (token={tokenAddress})` (marker `•` when `rawAmount` non-empty and ≠ `"0"`,
    else a space; defaults symbol `?`, amount `0`, token `""`, rawAmount `0`), or `  (no rewards)` when absent/empty.
    Returns whether any row was non-zero.
- `common::subscription_identity::select_subscription_agent_id(user, asp)` → first non-blank trimmed value, else
  `agenticId is required for subscription requests`.
- `common::okx_a2a` (g12 §10) — spawns the external `okx-a2a` binary from PATH (`Command::new("okx-a2a")`, no Windows
  `cmd /C` shim unless noted; on Windows a bare npm `.cmd` shim is therefore NOT resolved by `session_send`/`xmtp_send`/
  `file_upload`/`file_download` — only the readiness/refresh probes use the `cmd /C` shim):
  - `session_send(job, Some(to), content)`: `okx-a2a session send --job-id J --content C --json --to-agent-id T`, 5 s
    timeout (poll every 25 ms, kill on expiry); errors `session send failed: {io error}` /
    `session send failed: okx-a2a command timed out after 5s` / `okx-a2a session send exit {status}: {stderr}`. Stdout is ignored.
  - `xmtp_send(job, to, msg)`: `okx-a2a xmtp-send --job-id J --to-agent-id T --message M --json`; errors
    `spawn failed: {e}`, `okx-a2a xmtp-send exit {status}: {stderr}`, `okx-a2a xmtp-send stdout not valid JSON: {e}`,
    `okx-a2a xmtp-send returned an unsuccessful response: {json}` (stdout must be JSON with `"ok":true`).
  - `file_upload(path, agent, job, None, None)`: `okx-a2a file upload --file-path P --agent-id A --job-id J`; stdout JSON
    must carry string `fileKey,digest,salt,nonce,secret,filename` (`file upload response missing field: {key}`); other errors
    `spawn failed: …`, `okx-a2a file upload exit {status}: {stderr}`, `file upload stdout not valid JSON: {e}`.
  - `file_download(key, agent, digest, salt, nonce, secret, filename?)`: `okx-a2a file download --file-key K --agent-id A
    --digest D --salt S --nonce N --secret X [--filename F]`; returns stdout JSON `.path`, else the JSON text, else the trimmed stdout.
  - `ensure_communication_ready_preflight()`: env `ONCHAINOS_SKIP_A2A_PREFLIGHT=1` → ok. Else `okx-a2a --version` (npm shim);
    failure → Err `A2A communication is not ready, so this operation was not executed. {hint}`; stderr
    `[onchainos] checking A2A communication readiness (okx-a2a doctor)...`; `okx-a2a doctor --json` verdict `ready`|`ok`:
    true → stderr `[onchainos] A2A communication is ready`; false → stderr `[onchainos] A2A communication is NOT ready: {userMessage}` + Err;
    no usable verdict → stderr `[onchainos] {unverifiable note}` and continue (exact hint/note texts in g12 §10).
  - `refresh_agent_identities_silently()`: skip env honoured; stderr `[onchainos] refreshing A2A agent identities (okx-a2a agent refresh)...`,
    runs `okx-a2a agent refresh --json`, then stderr `[onchainos] A2A agent identities refreshed` or
    `[onchainos] A2A agent refresh did not complete (non-fatal); the daemon syncs periodically, or run \`okx-a2a agent refresh\` manually`. Never errors.
- `common::ensure_sufficient_balance_at(required_f64, symbol, address)` (g12 §6): self-subprocess
  `onchainos portfolio all-balances --address <addr> --chains 196` (→ `GET /api/v6/dex/balance/all-token-balances-by-address`);
  insufficient → `InsufficientBalanceError` (message with the four funding options and `{{DEPOSIT_QR}}` marker).
- `common::deposit_qr::enrich_blocking_at(err, address)` / `balance_warning_base(ib)` and
  `common::funding_notice::funding_blocked_envelope(warning, reason, action)` (g12 §12–13): build the
  `{"ok":false,"data":{blocked…}}` funding-block envelope; optional QR on stderr when stderr is a TTY.
- `common::find_service(agent, sid)` (g12 §2): self-subprocess `onchainos agent service-list --agent-id A --page 1
  --page-size 100 --service-id S` (→ `GET /priapi/v5/wallet/agentic/agent/services`); first `data[*].list[*]` entry whose
  `id`/`serviceId` equals `sid`; `Ok(None)` when no match.
- `common::onchainos_self::task_feedback_exists(agent, task)` (g12 §11): self-subprocess `onchainos agent task-feedback
  --agent-id A --task-id T` (→ `GET /priapi/v5/wallet/agentic/agent/task-feedback`); true iff `data` array non-empty.
- `common::PreFetchedTaskContext::from_api_response` (g12 §3; `common/mod.rs:230`). Fields read by this partition
  ("str" = first key whose value is a trimmed non-empty string or an integer rendered as text):
  `title` = `title` string or `""`; `description` = `description` string or `""`; `job_type` / `trial_type` = integer or numeric string;
  `token_symbol` = str(`tokenSymbol`,`paymentTokenSymbol`) else **`"?"`**; `token_amount` = str(`paymentTokenAmount`,`tokenAmount`) else `""`;
  `payment_mode` = int/numeric string; `provider_agent_id` = str(`providerAgentId`,`aspAgentId`); `user_agent_id` = str(`buyerAgentId`,`userAgentId`);
  `status` = `subStatus` int, else `status` int, else str(`subStatus`,`status`) parsed; `service_id`/`service_name`/`service_token_address`/
  `service_token_amount` = str of the same-named key; `service_params` = `serviceParams` string (untrimmed, may be empty);
  `refund_reason` = str(`refundReason`,`rejectReason`,`userReason`,`reason`); `period_start_time`/`period_end_time` = int of
  (`subStartTime`,`periodStartTime`) / (`subEndTime`,`periodEndTime`); `expire_time` = first timestamp of (`rejectWindowEndsAt`,`responseDeadline`,`expireTime`).
- `common::has_same_agent_owner(detail)` = trimmed, lowercased `buyerAgentAddress` and `providerAgentAddress` both present and equal;
  `common::is_test_task(v)` = `v.testFlag` bool else false; `TERMINAL_NOTIFICATION_MARKER = "[onchainos:task-terminal]"`;
  `AGENT_ROLE_ASP = 2`; `XLAYER_CHAIN_INDEX = "196"`; `XLAYER_CHAIN_NAME = "okb"`.
- `common::util::short_job_id(j)` = `j` when ≤ 12 **chars**, else first 6 chars + `…` + last 4 chars.
- `common::query::resolve_agent_id_or_error(agent, role)` (g12 §19): explicit trimmed id, else self-subprocess
  `agent get-my-agents …` lookups; errors `This account has {n} identities: … Pass --agent-id to choose the identity to query.` /
  `no agent identity found on this account. Register an identity (route to okx-ai) or pass --agent-id <id> to choose one.`
- `common::query::status_name(code)` (g12 §19): 0 `created`, 1 `accepted`, 2 `submitted`, 3 `rejected`, 4 `disputed`,
  5 `admin_stopped`, 6 `complete`, 7 `close`, 8 `expired`, 9 `failed`, else `unknown`.
  `task_status_label(code)`: -1 `Initializing`, 0 `Awaiting ASP acceptance`, 1 `In progress`, 2 `Awaiting buyer review`,
  3 `Awaiting refund decision`, 4 `Evaluation in progress`, 5 `Stopped by platform`, 6 `Completed`, 7 `Closed`, 8 `Expired`,
  9 `Refund completed`, else `Status unavailable`. `task_status_description(code)`: -1 `The task is being initialized.`,
  0 `The task is waiting for an ASP to accept it.`, 1 `The ASP accepted the task and is working on it.`,
  2 `The ASP submitted the deliverable and is waiting for buyer review.`,
  3 `The buyer rejected the deliverable and the refund request awaits an ASP decision.`, 4 `The refund request is in Evaluation.`,
  5 `The platform stopped the task.`, 6 `The task completed and funds were released to the ASP.`, 7 `The task is closed.`,
  8 `The task expired.`, 9 `The refund completed and the task is closed.`, else `The task status is currently unavailable.`;
  `user::subscription_ops::status_label` (-1 `Initializing`, 0 `Awaiting ASP acceptance`, 1 `Active`, 3 `Awaiting ASP decision`,
  4 `Evaluation in progress`, 6 `Completed`, 7 `Closed`, 8 `Expired`, 9 `Refund completed`, else `Status unavailable`) and
  `status_description` (-1 `The subscription record was created and is awaiting on-chain confirmation.`, 0 `The subscription is waiting for an ASP to accept it.`,
  1 `The subscription is active.`, 3 `The buyer rejected the current delivery and is waiting for the ASP's decision.`,
  4 `The refund request is in Evaluation.`, 6 `The subscription completed without a refund.`, 7 `The subscription is closed.`,
  8 `The subscription expired.`, 9 `The refund completed successfully.`, else `The subscription status is currently unavailable.`).
- `common::deadline` (g12 §7): `normalize_timestamp_seconds` (|v|≥1e11 → v/1000; must be >0),
  `format_local_timestamp_with_offset(t)` → local `%Y-%m-%d %H:%M (UTC±HH:MM)`, `format_utc_timestamp`,
  `deadline_reminder_line`.
- `common::state_machine` (g12 §8): `Status::from_int` (-1..9; other → `Other("status_{n}")`), `Status::as_str`
  (`init created accepted submitted rejected disputed admin_stopped completed close expired failed`, Other → its string),
  `DisputeRoundStatus::from_int` (0..5, other → Other) / `as_str` (`init commit_phase reveal_phase completed rejected invalidated`, else `unknown`) /
  `display_label` (0 `Evaluation round initializing`, 1 `Vote commitment in progress`, 2 `Vote reveal in progress`,
  3 `Evaluation round completed`, 4 `Evaluation round rejected`, 5 `Evaluation round invalidated`, other `Round status unavailable`) /
  `display_description` (0 `The evaluation round is being initialized.`, 1 `Selected evaluators are submitting encrypted votes.`,
  2 `Evaluators are revealing their previously committed votes.`, 3 `This evaluation round has completed.`,
  4 `This evaluation round was rejected.`, 5 `This round produced no valid result and awaits the next round.`,
  other `The evaluation round status is currently unavailable.`), `Event::parse` / `Event::as_str` (identity mapping of the
  snake_case event names listed in the ASP playbook table; unknown → `Other(raw)`), and
  `parse_status_or_event(s)` = `Event::parse(s)` unless Other, else status name → canonical entry event:
  `created`→`job_created`, `accepted`→`job_accepted`, `submitted`→`job_submitted`, `rejected`→`job_rejected`,
  `disputed`→`job_disputed`, `completed|complete`→`job_completed`, `close|closed`→`job_closed`, `expired`→`job_expired`,
  `failed`→`job_refunded`; `init`, `admin_stopped|adminstopped` and anything else → `Other(raw)`.
- `task::arbitration` (g12 §18): `build_decision_result`, `build_selected_result`, `blocked_result`, `resolved_action`,
  `default_choices`, `is_decision_source` (`job_rejected`|`sub_user_reject`), `scalar_string`, `build_detail_result`,
  `handle_provider_arbitration_list` (= `arbitration-list` with `include_test_flag=true`, which adds `testFlag` to every item;
  validation `--agent-id must not be empty` / `--page must be greater than 0` / `--page-size must be greater than 0`; agent GET
  `/priapi/v1/aieco/task/dispute/my?page={p}&pageSize={s}` then, **sequentially**, agent GET `…/{jobId}/dispute/status` per row, errors ignored).
  Output shapes used verbatim by the ASP playbook (compact JSON, sorted keys):
  - `blocked_result(reason, job, details)` → `{"decision":"blocked","nextAction":[],"payload":{"details":<details>,"jobId":job},"phase":"arbitration_decision","reason":reason}`.
  - `build_selected_result(job, resolved)` → `{"decision":"ready","nextAction":[{"id":<actionId>,"params":<params incl. "jobId":job>,"recommend":true}],"payload":{"jobId":job},"phase":"arbitration_decision","reason":"user_choice_resolved"}`.
  - `resolved_action(source, action, job, params)`: canonicalises `dispute_raise`→`raise_arbitration`, `sub_dispute`→`raise_subscription_arbitration`;
    allowed pairs `job_rejected`:{`agree_refund`,`raise_arbitration`}, `sub_user_reject`:{`sub_agree_refund`,`raise_subscription_arbitration`}
    else `unsupported_action`; `params` object (non-object → `{}`) whose string `jobId` ≠ job → `unsupported_action`; sets `jobId`;
    raise actions need a non-blank string `reason` else `arbitration_reason_required`.
  - `default_choices(source, job)` → `[{"key":"A","actionId":refund,"params":{"jobId":job}},{"key":"B","actionId":raise,"params":{"jobId":job}}]`
    (struct order `key, actionId, params`).
- `common::pending_v2::{encode_refund_decision_vars, encode_title_vars, request_command_block}` and
  `common::template_vars` placeholders (`{{__OKX_TASK_TITLE__}}`, `{{__OKX_TASK_LABEL_TITLE__}}`,
  `{{__OKX_REFUND_SERVICE_NAME__}}`, `{{__OKX_REFUND_JOB_ID__}}`, `{{__OKX_REFUND_TASK_TYPE__}}`,
  `{{__OKX_REFUND_CURRENT_PERIOD__}}`, `{{__OKX_REFUND_AMOUNT__}}`, `{{__OKX_REFUND_BUYER_REASON__}}`,
  `{{__OKX_REFUND_RESPONSE_DEADLINE__}}`) (g12 §14, §21).
- `common::deliverables::handle_save(SaveParams)` (g12 `task-deliverable-save`): **moves** the given file into
  `$ONCHAINOS_HOME/deliverables/<role>/<jobId>_<sanitizedTitle>/<sanitized>_<YYYYmmdd_HHMMSS><ms><ext>` and appends a
  manifest entry (100 MB limit).
- `user::refund::is_zero_decimal(v)` = `validate_decimal(v)` (`\d+(\.\d+)?`) and every byte is `0` or `.`.
- `user::attachments::attachments_dir(job)` = validate job path component, then `$ONCHAINOS_HOME/task/<job>/attachments`;
  `dedup_dest(dir, name)` = `name`, else `{stem}_{2..=999}{.ext}`, else `{stem}_{YYYYmmddHHMMSS}{.ext}`.
- `audit::log(...)` — appends to `$ONCHAINOS_HOME/audit.jsonl` (core). Not stdout; event names are listed per command.

### B. Helpers owned by this partition

#### B1. `asp/subscription.rs` — subscription liveness model
- Constants: `JOB_TYPE_SUBSCRIBE = 1`; `BUFFER_WINDOW_SECS = 86400`; `SUBSCRIBE_MY_PATH = "/priapi/v1/aieco/task/subscribe/my"`.
- `enum SubStatus` (:46) — `from_int`: -1 Init, 0 Created, 1 Active, 3 Rejected, 4 Disputed, 6 Completed, 7 Closed,
  8 Expired, 9 Failed, other → `Unknown(n)`; `code()` is the inverse (Unknown keeps n). `is_active()` only for Active.
- `as_i64(v,key)` (:124) — JSON number (i64) or string trimmed parsed as i64. `as_string(v,key)` — string or i64 rendered.
- `SubscriptionDetail::from_json(v)` (:153): `job_type = as_i64(jobType)` default 0; status code =
  `as_i64(status)` else `as_i64(subStatus)` else **-2** (→ `Unknown(-2)`, never live); `sub_end_time = as_i64(subEndTime)`,
  `sub_buffer_end_time = as_i64(subBufferEndTime)`.
- `effective_buffer_end` = `subBufferEndTime` else `subEndTime + 86400` else none; `past_buffer(now)` = `now >= end` (false when none).
- `liveness(now)` (:192) → `Routing::Active` iff status Active and not past buffer; otherwise `Routing::Ended`.
- `fetch_detail(client, job, agent)` (:285) → `client.fetch_subscription(job, agent)` → `Some(from_json)`; any error → `None`.
- `sent_marker_path/is_already_sent/record_sent` (`$ONCHAINOS_HOME/autotrade/sent/<job>/<deliveryId>`): **dead code in 4.6.3**
  (no caller); a lite port may omit.

#### B2. `asp/dispute_raise.rs` — evaluation reason handoff + SA batch flag
- `build_reason_handoff_for(job, providerAgentId, reason, flow)` (:26) → text
  `"[ARBITRATION_REASON_CONTEXT]\n" + <compact sorted JSON> + "\n" + <instruction>` where JSON =
  `{"intent":"arbitration_reason_context","jobId":job,"providerAgentId":…,"reason":reason,"reasonB64":<URL_SAFE_NO_PAD base64 of reason UTF-8>,"resumeEvent":…,"taskType":…,"version":1}`
  (keys sorted as shown). OneTime: `taskType "one_time"`, `resumeEvent "job_disputed"`, instruction
  `Keep this exact reason in the current task conversation and end this turn. When the matching job_disputed event arrives, include it as the ASP's evaluation reason in the evidence upload.`
  Subscription: `taskType "subscription"`, `resumeEvent "sub_asp_dispute"`, same instruction with `sub_asp_dispute`.
  JSON string escaping follows serde_json (non-ASCII raw UTF-8; `"`/`\`/control chars escaped).
- `with_sa_batch_tx_flag(uopData)` (:75): clone; `uopData.extraData` must be a JSON object, else error
  `approveAndCreateDispute response missing object uopData.extraData`; inserts `"isSaBatchTx": true` (only for one-time `dispute raise`).
- `print_dispute_funding_block_from_error(err)` (:201): if `err` downcasts to `InsufficientBalanceError` →
  warning = `balance_warning_base(ib)` (`{"available","chain":"XLayer","chainIndex":"196","currency","required","shortfall","sufficient":false}`,
  numbers as f64-Display strings) + `depositAddress`/`depositChain` when the error carries an address →
  `Err(CliFundingBlocked{data: funding_blocked_envelope(warning, "dispute-bond", "Evaluation bond")})` → stdout
  `{"ok":false,"data":{…sorted…}}`, exit 1. Other errors pass through.

#### B3. `asp/content.rs` — ASP copy templates (verbatim, `⏎` = newline)
Used by commands:
- `build_text_deliver_message(job, text)` = `jobId: {job}⏎deliverableType: text⏎- - -⏎{text}⏎- - -⏎[intent:deliver]`
- `build_file_deliver_message(job, up)` = `jobId: {job}⏎deliverableType: file⏎fileKey: {fileKey}⏎digest: {digest}⏎salt: {salt}⏎nonce: {nonce}⏎secret: {secret}⏎filename: {filename}⏎[intent:deliver]`

Used by the ASP playbook (§ Playbooks):
- `provider_applied_user_notify(job, agent)` = `[Apply Submitted] Job {job} — your apply has been recorded on-chain.⏎  - ASP agentId: {agent}⏎  Awaiting the User Agent's confirm-accept to fund escrow.`
- `job_user_reject_notify(job)` = `[User Agent Declined Payment] Job {job} — the User Agent refused to fund / confirm-accept after your apply.⏎  This designation is over; no further action is needed on this side.`
- `L10N_DISPATCH_SHORT` = `🌐🛑 **MUST translate** the content below to the user's language before passing to \`onchainos agent user-notify\` (rule 5: non-English → faithful translation; rule 4: English → verbatim). Sending English content to a Chinese user is a violation.`
- `job_accepted_user_notify(job, agent)` = 4-space-indented lines: `    [Job Accepted] Job {job} has been accepted.⏎    - Title: <title>⏎    - Description: <description>⏎    - Negotiated price: <tokenAmount> <tokenSymbol>⏎    - Payment: <escrow>⏎    - ASP: {agent}⏎    Funds are now escrowed; the ASP has started execution.`
- `asp_refund_decision_source_template(isSub)` (:142) = `### Buyer Refund Request⏎⏎- Service Name: {{__OKX_REFUND_SERVICE_NAME__}}⏎- Job ID: {{__OKX_REFUND_JOB_ID__}}⏎- Task Type: {{__OKX_REFUND_TASK_TYPE__}}⏎` + (sub only `- Current Period: {{__OKX_REFUND_CURRENT_PERIOD__}}⏎`) + `- Requested Refund: {{__OKX_REFUND_AMOUNT__}}⏎- Buyer’s Reason: {{__OKX_REFUND_BUYER_REASON__}}⏎- Response Deadline: {{__OKX_REFUND_RESPONSE_DEADLINE__}}⏎- Refund Status: Awaiting ASP decision⏎- Status Description: The refund request is waiting for the ASP's decision.⏎⏎Please respond by the deadline. Otherwise, a full refund will be issued automatically.⏎⏎To refund the buyer, reply “Approve refund”. To request platform evaluation, reply “Request evaluation” and include your evaluation reason.` (typographic `’ “ ”`; placeholders keep double braces).
- `sub_user_reject_asp_decision_copy(name, start?, end?, windowEnd?, amount?, symbol?)` (:193): `[Action Needed: User Rejection] The user has rejected "{name}"'s current period` + (both epochs → ` ({start}–{end})`) + `.` + (windowEnd → ` Please confirm the refund or request evaluation by {deadline}` | ` Please confirm the refund or request evaluation within about 1 day`) + ` — otherwise a full refund` + (` of {amount} {symbol}` | ` of {amount}` | nothing) + ` will be issued to the user automatically.⏎  To refund the buyer, reply 'Approve refund'.⏎  To request platform evaluation, reply 'Request evaluation' and include your evaluation reason.` — epochs via `fmt_epoch`.
- `job_submitted_user_notify(job)` = `[Deliverable Submitted] Job {job} — your deliverable is on-chain (submit tx confirmed).⏎  Waiting for the User Agent's review (approve or reject).`
- `EVALUATION_REASONS_BLOCK` (:242) and `dispute_won_with_claim_user_notify`, `dispute_won_no_claim_user_notify`, `dispute_lost_user_notify` (:249–347): verbatim multi-line cards, port from source (4-space / 6-space / 10-space `\x20` indentation).
- `reward_claim_failed_user_notify(job)` = `[Reward Claim Failed] Job {job} — the reward-claim transaction failed. Please review and retry manually; the agent will not auto-retry.`
- `reward_claimed_user_notify(job)` = `[Reward Claimed] Job {job} — reward successfully claimed to your wallet.`
- `submit_deadline_warn_user_prompt(short)` = `    [⏰ Deadline Warning — Job {short}, you are the ASP] The submit deadline is approaching.⏎    If the deliverable is ready, reply 'submit now' and I will run the delivery flow immediately.⏎    If it is not ready, you may stay silent — after expiry the backend automatically returns any escrowed funds to the User Agent and this job is void. No client-side refund claim is required.`
- `rating_submitted_user_notify(job)` = `    [📝 Rating Submitted] Job <title> (\`{job}\`) — rated.⏎    Score: <score> / 5.00⏎    💬 Comment: <description>`
- `user_attachment_received_user_notify(job)` = ``[Job `{job}`] The User Agent sent an attachment (reference material for this task). File downloaded and saved locally.``
- `fmt_epoch(ts?)` (:430): `ts>0`; `ts ≥ 1e12` → `ts/1000`; UTC `%Y-%m-%d %H:%M UTC` (e.g. `1700000000` → `2023-11-14 22:13 UTC`).
- `service_name_clause(prep, name?)` → `{prep} "{name}"` when non-empty, else `""`.
- `sub_asp_selected_asp_notify(name?, buyer?, job, amt?, sym?, start?, end?)`: `[New Subscription] You have a new subscriber{ for "name"}.` + (` Buyer: {buyer}.`) + ` Job {job}` + (`, current period {s}–{e}`) + (`, payment received: {amt} {sym}` | `, payment received: {amt}`) + `.` + ` Please begin delivering the service.`
- `sub_asp_selected_trial_asp_notify(…, trialStart?, trialEnd?)`: `[New Trial Subscriber] You have a new subscriber{ for "name"} on a free trial` + (` ({s}–{e})`) + `.` + (` Buyer: {buyer}.`) + ` Job {job}. No payment during the trial` + (if amt: `; {amt} {sym} will be charged on conversion` | `; {amt} will be charged on conversion`, then ` at {trialEnd}` when formattable) + `.` + ` Please begin delivering the service.`
- `sub_complete_notify_asp_notify(name?, job, end?)`: `[Subscription Complete] The user's subscription{ to "name"} has completed all scheduled renewals. Job {job} status: Completed; service ends normally` + (` at {end}`) + ` — no further delivery is required.`
- `sub_close_notify_asp_notify(name?, job, rejectReason?)`: non-blank reason → `[Assignment Closed] You declined the user's subscription{ to "name"} before activation. Reason: {reason}. Job {job} status: Closed — do not start or continue delivery. This notice does not confirm refund settlement and authorizes no funds action.`; else `[Subscription Ended] The user's subscription{ to "name"} has ended because the renewal charge failed during the grace period. Job {job} status: Closed — please stop delivering the service.`
- Job-notification copies (verified by `content.rs` tests, which are the oracle):
  - `subscription_job_asp_accept_expire_asp_notify(name, job, amt, sym, trial, paid)`: trial → `[Job Expired] You did not process {name} within 3 hours, so the job expired.⏎⏎Job ID: {job}⏎Job status: Expired⏎⏎Neither the subscription nor the free trial began. No further action is required.`; else `…Job status: Expired⏎⏎The subscription did not begin.{ The escrowed amount of {amt} {sym} will be returned to the User Agent’s wallet. (paid only)} No further action is required.`
  - `regular_job_asp_accept_expire_asp_notify(name, job)` = `[Job Expired] You did not process {name} within 3 hours, so the job expired.⏎⏎Job ID: {job}⏎Job status: Expired`
  - `job_delivery_expire_asp_notify(jobName, job, taskType, amt, sym, trial, paid)` = `[Delivery Expired] The deliverable for {jobName} was not submitted before the deadline.⏎Job ID: {job}⏎Task type: {taskType}⏎Job status: Expired (8)⏎{payment}⏎No further delivery, refund claim, or finalization action is required.` with payment = trial `No refundable funds were collected during the trial, so no refund action is required.` | paid `Escrowed amount: {amt} {sym}⏎Authoritative Expired(8) confirms that the backend completed the full refund and the funds have reached the Buyer.` | `No refundable funds were collected, so no refund action is required.`
  - `subscription_job_asp_reject_closed_asp_notify` = `[Task Declined] You have declined {name}.⏎Job ID: {job}⏎Reason: {reason}`; `regular_job_asp_reject_closed_asp_notify` = `[Job Declined] You have declined {name}.⏎⏎Job ID: {job}⏎Reason: {reason}⏎Job status: Closed`
  - `subscription_job_asp_reject_expire_asp_notify(name, job, amt, sym, window?)` = `[Automatic Refund Processing] You did not respond to the refund request for {name} by the deadline. {amt} {sym} will be returned to the User Agent’s wallet.⏎⏎Job ID: {job}⏎Response deadline: {fmt_epoch(window) | "Unavailable"}⏎Job status: Failed⏎No further service delivery is required.`
  - `regular_job_asp_reject_expire_asp_notify(…, paid)`: paid → same first paragraph without the last line (`…⏎Job status: Failed`); unpaid → `[Refund Response Timed Out] You did not respond to the refund request for {name} by the deadline. No charges were incurred, so no refund is required.⏎⏎Job ID: {job}⏎Response deadline: {…}⏎Job status: Failed`
  - `sub_asp_claim_notify_asp_notify(jobName, job, amt, sym, tx)` = `[Income Collected] The system has automatically collected subscription income of {amt} {sym} for {jobName}. Please monitor your wallet balance.⏎⏎Job ID: {job}⏎Transaction: {tx}`
- Dead in 4.6.3 (no production caller): `job_asp_selected_no_service_notify`, `job_asp_selected_missing_terms_notify`,
  `job_asp_selected_apply_failed_notify`, `job_asp_selected_rejected_notify`, `escalation_protocol_misread_notify`,
  `escalation_cli_failed_notify`, `deliver_text_to_user`, `deliver_file_to_user`, `sub_failed_notify_asp_notify`;
  `job_rejected_user_decision_prompt` and `sub_user_reject_asp_decision_copy` (plus `pending_v2::encode_title_vars` /
  `TITLE_PLACEHOLDER` / `LABEL_TITLE_PLACEHOLDER` usage in flow.rs) are only reachable from the shadowed second-pass
  `job_rejected` / `sub_user_reject` arms (see Playbooks) — they never influence output in 4.6.3 and a port may omit them.

#### B4. `asp/task_query.rs` — provider list/detail normaliser
- `scalar_string(v)`: trimmed non-empty string, or i64/u64 rendered. `string_from_keys(v, keys)` first match.
  `integer_from_keys`: i64 / u64≤i64::MAX / trimmed numeric string. `bool_from_keys`: bool / i64≠0 / trimmed
  case-insensitive `true|1|false|0`.
- `is_zero_amount(a)`: trim, strip leading `+`s, non-empty and every char `0` or `.`.
- `task_status(v)` = `integer_from_keys(subStatus, status)` else **-1**.
- `status_fields(kind, code)`: OneTime → (`query::status_name(code)`, `task_status_label`, `task_status_description`);
  Subscription → (`INIT`(-1) `CREATED` `ACTIVE` `REJECTED`(3) `DISPUTED` `COMPLETED`(6) `CLOSED` `EXPIRED` `FAILED`(9) else `UNKNOWN`,
  `subscription_ops::status_label`, `status_description`).
- `normalize_item(v, kind)` (:211) → JSON object (keys sorted on output):
  `autoRenewLabel` (sub only: `Enabled`/`Disabled` from `bool_from_keys(autoRenew)`, else null),
  `billingCycleLabel` (sub `Monthly`, else null),
  `billingPeriodLabel` (sub: trialType==1 → `Trial Period`; periodIndex>0 → `Billing Period {n}`; else null),
  `createdAt` (`format_local_timestamp_with_offset` of `createTime|createdAt|subCreateTime`, else null),
  `currentPeriod` (sub, trialType≠1, periodIndex>0: `{d1}–{d2}` (U+2013) where d = first 10 chars of the local-offset string of
  `periodStartTime|subStartTime` / `periodEndTime|subEndTime`; else null),
  `detailFeeLabel` (like feeLabel but one-time suffix is empty), `feeLabel` (amount keys one-time `tokenAmount,paymentTokenAmount`,
  sub `serviceTokenAmount,paymentTokenAmount,tokenAmount`; symbol keys one-time `tokenSymbol,paymentTokenSymbol`, sub
  `serviceTokenSymbol,paymentTokenSymbol,tokenSymbol`; no amount → null; zero → `Free`; no symbol → null; else
  `{amount} {symbol} / month` (sub) or `{amount} {symbol} / task`),
  `jobId` (`jobId|subId`), `jobName` (`title|jobName|serviceName`), `nextChargeAt` (sub ∧ code 1 ∧ autoRenew true →
  local-offset of `nextChargeTime|subEndTime`, else null), `status`, `statusCode`, `statusDescription`, `statusLabel`,
  `taskType` (`subscription`|`one_time`), `taskTypeLabel` (`Subscription Task`|`One-time Task`), `testFlag` (bool `testFlag`, default false),
  `userAgentId` (`buyerAgentId|userAgentId`), `userName` (`buyerAgentName|userAgentName|buyerName|userName`). Missing strings → `null`.
- `page_items(v)` = `v.list` array else `[]`; `page_total(v)` = `v.total` as u64 else `page_items.len()`;
  `page_has_more(v, page, size)` = `page*size < total` (saturating u64).
- `subscription_status_code(s)`: trimmed i64, else lowercase names `init`→-1, `created`→0, `accepted|active`→1, `rejected`→3,
  `disputed`→4, `complete|completed`→6, `close|closed`→7, `expired`→8, `failed`→9, else None.
- `subscription_list_path(page, size, status?)` = `/priapi/v1/aieco/task/subscribe/my?page={page}&pageSize={size}&statusType=0`
  + `&statusList={code}` when a non-blank status is given; **None** when the status does not map (then no request is sent).
- `one_time_list_path(backendPage, status?)` = `/priapi/v1/aieco/task/my?page={bp}&page_size=20` + `&status={trimmed status}` (raw, unencoded).

#### B5. `asp/v2/notification.rs` / `v2/job_completed.rs` / `v2/sub_complete_notify.rs` — structured playbook JSON
All return a **string** containing compact JSON with sorted keys (printed by next-action).
- `notification_result(job, event, content)` = `{"decision":"ready","nextAction":[{"id":"notify_user","params":{"event":event,"jobId":job},"recommend":true}],"payload":{"event":event,"jobId":job,"notification":{"content":content,"localize":true},"rating":{"required":false},"role":"asp"},"phase":"notification","reason":"notification_required"}`.
- `terminal_notification_result(job, event, content)` = same but `nextAction:[{"id":"notify_and_cleanup_subscription","params":{"jobId":job},"recommend":true}]` and `payload.cleanup = {"jobId":job}`.
- `authoritative_context_required(job, event, missing[])` = `{"decision":"blocked","nextAction":[],"payload":{"error":{"code":"authoritative_task_context_required","missingFields":[…]},"event":event,"jobId":job,"rating":{"required":false},"role":"asp"},"phase":"notification","reason":"authoritative_task_context_required"}`.
- Field helpers: `display_field(msg,key)` = non-empty string or number text; `display_i64` = i64 or numeric string;
  `authoritative_field(s)` = trimmed, non-empty and ≠ `?`; `authoritative_task_kind(task)` = jobType 0 → one-time, 1 → subscription, else None;
  `payment_is_paid(amount)` = None unless `\d+(\.\d+)?`; Some(any byte other than `0`/`.`);
  `service_name(task,msg)` = task.serviceName (authoritative) | msg.serviceName | task.title (authoritative) | `Service unavailable`.
- `free_job_rejected_failed(job, task, msg)`: reason = task.refund_reason (authoritative) | msg `reason` | `rejectReason` | `refundReason` | `Not provided`;
  content `[onchainos:task-terminal] [Job Failed] Job {job} ({serviceName}) — the buyer rejected the deliverable.⏎- Status: Failed⏎- Rejection reason: {reason}⏎⏎This free one-time task has ended. No refund or platform evaluation is required.`;
  `terminal_notification_result(job,"job_rejected",content)` + `payload.statusLabel="Failed"`, `payload.statusDescription="The buyer rejected the free task deliverable; the task is terminal."`.
- `job_asp_accept_expire(job, task, msg)`: task.status≠8 → blocked `["status"]`; kind None → `["jobType"]`; sub: trialType 0/1 else `["trialType"]`;
  amount = authoritative tokenAmount or `""`; non-trial: `payment_is_paid` None → `["tokenAmount"]`; symbol = authoritative or `payment token`;
  terminal result with the subscription/regular accept-expire copy.
- `job_delivery_expired(job, task, event)` (events `job_expired`/`submit_expired`): status≠8 → `["status"]`; jobName = authoritative title or
  `Task title unavailable`; kind → `Subscription (1)` (trialType 0/1 else `["trialType"]`) or `One-time task (0)`; paid check as above;
  terminal result with `job_delivery_expire_asp_notify`.
- `job_asp_reject_closed(job, task, msg)`: kind required; reason = msg `aspRejectReason` | `reason` | `No reason provided`;
  **non-terminal** `notification_result` with the subscription/regular declined copy.
- `job_asp_reject_expire(job, task, msg)`: status≠9 → `["status"]`; kind required; tokenAmount authoritative required (`["tokenAmount"]`);
  paid = `payment_is_paid(amount)` or false; symbol authoritative or `""`; (sub or paid) with empty symbol → `["tokenSymbol"]`;
  deadline = `display_i64(msg, "rejectWindowEndsAt")`; `notification_result`.
- `sub_asp_claim_notify(job, msg)`: jobName = msg `jobTitle|jobName` or `job`; amount = msg `tokenAmount` or `0`; symbol or `""`;
  tx = msg `txHash` or `Not provided`; `notification_result`.
- `sub_complete_notify::handle(job, title?, end?)` = `{"decision":"ready","nextAction":[{"id":"notify_and_cleanup_subscription","params":{"jobId":job},"recommend":true}],"payload":{"cleanup":{"jobId":job},"jobId":job,"notification":{"content":<sub_complete_notify_asp_notify>,"localize":true},"rating":{"required":false},"role":"asp"},"phase":"subscription_completion","reason":"notification_required"}`.
- `job_completed::handle(job, agent)` (async, **does HTTP**): identity `GET /priapi/v1/aieco/task/{job}` with header `agenticId: {agent}`;
  error → blocked `task_detail_unavailable`; `data.jobId` string ≠ job → `task_detail_job_id_mismatch`; `data.status` (number) ≠ 6 →
  `stale_task_status`; blocked shape `{"decision":"blocked","nextAction":[{"id":"stop"}],"payload":{"jobId":job},"phase":"task_completion","reason":…}`.
  Else `ratingRequired = !has_same_agent_owner(detail)`; ctx = PreFetchedTaskContext; `user_agent_id` empty → blocked
  `task_detail_unavailable`; result `{"decision":"ready","nextAction":[{"id":"finalize_asp_task","recommend":true}],"payload":{"jobId","notification":{"content":C,"localize":true},"rating":{"creatorAgentId":agent,"required":ratingRequired,"targetAgentId":userAgentId,"taskDescription":ctx.description,"taskParameters":serviceParams non-empty|null},"ratingResultNotification":R},"phase":"task_completion","reason":"notification_and_rating_required"|"notification_required"}`
  with C = `[onchainos:task-terminal] [💰 Job Completed] Job {job} ({title|"Task"}) — approved by the User Agent; funds received.\n      - Income: {tokenAmount} {tokenSymbol}\n      - User Agent: {userAgentId}\n    \n    This job is complete.` (+ when rating required `\n\n    To rate the User Agent, reply "Rate User Agent". Your rating for Job ID \`{job}\` replaces the AI-generated rating.`)
  (tokenAmount/tokenSymbol are the PreFetchedTaskContext values: `paymentTokenAmount|tokenAmount` or `""`, `tokenSymbol|paymentTokenSymbol` or `?`;
  `taskDescription` = `description` string or `""`)
  and R = `rating_submitted_user_notify(job)` with `<title>` replaced by the title. If ratingRequired, spawns
  `task_feedback_exists(agent, job)`; Ok(true) or Err → `reason="notification_required"`, `rating.required=false`, remove `ratingResultNotification`.

#### B6. `evaluator/decimal_str.rs` — exact decimal math (used by staking preflights)
- `split(s)`: trim; empty → `decimal string is empty`; `split_once('.')`; empty integer part → `"0"`; non-digit in integer part →
  `invalid decimal (non-digit in integer part): "{s}"`; in fractional part → `invalid decimal (non-digit in fractional part): "{s}"`
  (so `1.2.3` fails in the fractional part; `-1` fails in the integer part).
- `align(a,b)`: `prec = max(frac lengths)`; each value = integer of `{int}{frac right-padded with 0 to prec}` (leading zeros stripped,
  `"0"` if empty) parsed as u128 (`decimal exceeds u128 range: "{original}": {e}`).
- `format_at(v, prec)`: prec 0 → `v`; else `int.frac` with frac zero-padded to prec then trailing zeros trimmed; whole numbers have no point.
- `cmp(a,b)`, `sub(a,b)` (`decimal subtraction underflow: "{a}" - "{b}"`), `add(a,b)` (`decimal addition overflow: …`).
  Oracles: `sub("0.0012","0.0002")="0.001"`, `cmp("0.001","0.0010")=Equal`, `sub("10.5","0.0001")="10.4999"`, `add("0.5","0.5")="1"`.

#### B7. `evaluator/staking_types.rs`
- `StakingConfig` (all fields **required**; strings): `minCumulativeStakeOkb`, `partialUnstakeMinRetainOkb`, `arbitrationFeeBps`,
  `slashMinorityBps`, `slashTimeoutBps`; `unstakeCooldownSeconds`, `commitPhaseSeconds`, `revealPhaseSeconds`,
  `slashedCooldownSeconds` must be **JSON strings** parseable as u64 (`expected u64 string, got "{raw}": {e}`; a JSON number fails with serde's
  `invalid type: integer …, expected a string`).
- `format_fractional_unit(sec, unit)`: 0 → `0`; exact multiple → integer; else `format!("{:.2}", sec/unit)` with trailing `0`s then `.`
  trimmed; if that is `0` → same with 4 decimals. Used as `unstake_cooldown_days` (unit 86400), `commit_phase_hours`,
  `reveal_phase_hours`, `slashed_cooldown_hours` (unit 3600).
- `MyStake`: required strings `voterAddress`, `agentId`, `activeStake`, `pendingUnstake`, `validStake`, `activeDisputes`;
  `cooldownEndsAt`, `unstakeAvailableAt` i64 default 0; `registered` bool default false.
- `get_staking_config(client, agent)` → identity `GET /priapi/v1/aieco/task/staking/config`, parse error context
  `failed to parse staking config response`. `get_my_stake(client, agent)` → identity `GET /priapi/v1/aieco/task/staking/myStake`,
  context `failed to parse myStake response`. `agent` is used **as passed** (no trim/validation).

#### B8. `evaluator/dispute_status.rs`
- `DisputeStatusResponse` (camelCase): `jobId` **required** string; `jobType` i32?, `currentRound` i64?, `selectedVoter` (presence
  only; `null` = absent), `taskStatus` i32 (default 0), `disputeRoundStatus` i32? (alias `disputeStatus`), `prepareEndTime` i64?,
  `roundEndTime` i64?, `tokenAmount` string?, `tokenSymbol` string?.
- `get_dispute_status(client, job, agent)` → identity `GET /priapi/v1/aieco/task/{job}/dispute/status`; context
  `failed to parse dispute/status response` (serde messages, e.g. `missing field \`jobId\``; note `taskStatus: null` also fails —
  `#[serde(default)]` only covers an absent key — with `invalid type: null, expected i32`). Unknown extra keys are ignored.
- `precheck_round_gate(client, job, agent, roundNum)` (:104) — prints (plain text):
  ```
  evaluation status (jobId={resp.jobId})
    currentRound : {currentRound|null}
    Task status: {query::task_status_label(taskStatus)}
    Status description: {query::task_status_description(taskStatus)}
    Evaluation round status: {DisputeRoundStatus.display_label | "Round status unavailable"}
    Evaluation round description: {display_description | "The evaluation round status is currently unavailable."}
    selectedVoter: {present (this account is selected as juror for current round) | null (not selected for current round / notification expired / no active evaluation)}
  ```
  Gate (first failing reason wins): taskStatus ∈ {6,7,8,9} → `taskStatus={n} ({Status::as_str}) is terminal — task finished, evaluation window closed`;
  `roundNum.parse::<i64>()` fails → `--round-num cannot be parsed as integer: {roundNum:?} ({ParseIntError})` (Rust Debug quoting, e.g.
  `"abc" (invalid digit found in string)`); currentRound null → `currentRound=null — no active evaluation (task is not under evaluation / already ended / backend has not advanced round)`;
  req ≠ current → `round mismatch: envelope round_num={req} != on-chain currentRound={cur} (stale envelope)`; disputeRoundStatus null →
  `disputeStatus=null — evaluation sub-state-machine not started / already settled (commit window guaranteed closed)`; ≠ 1 →
  `disputeStatus={n} ({as_str}) is not commit_phase — commit window not open / already closed`; selectedVoter null →
  `selectedVoter=null — this account is not the selected juror for the current round`.
  Pass → prints `\nselected: yes` (blank line + line) and returns true; fail → prints `\nreason: {r}` then `selected: no`, returns false.

#### B9. `evaluator/helpers.rs`, `evaluator/commit.rs::unescape_reason`, `evaluator/flow.rs` helpers
- `evidence_dir(job, agent)` = `$ONCHAINOS_HOME/task/{job}/dispute/{agent}` (no path validation of `job`/`agent`).
- `unescape_reason(raw)`: `\n`→LF, `\t`→TAB, `\r`→CR, `\\`→`\`, `\"`→`"`, other `\x` kept as `\x`, trailing lone `\` kept.
- `evaluator/flow.rs`: `notify_block(content)` = ``Run `onchainos agent user-notify` to push the notification to the user. Translate the content below into the user's language first, then run:⏎⏎```bash⏎onchainos agent user-notify --content "<localized content>"⏎```⏎⏎Canonical English content:⏎    {content}⏎``;
  `notify_block_lines(lines)` = same with the last part `Canonical English content:⏎{each line prefixed by 4 spaces, joined by ⏎}⏎`;
  `terminal_session_hint(job)` = ``⏎**Terminal wrap-up — run the cleanup command:**⏎```bash⏎onchainos agent session-cleanup --job-id {job}⏎```⏎Then end this turn.⏎``;
  `fmt_local_time(ts)` = ts≤0 → None else local `%Y-%m-%d %H:%M:%S %Z` (chrono `%Z` on `Local` renders the offset, e.g. `+08:00`);
  `hours_left_text(d)` = d≤now → None; `(d-now)/3600 ≥ 1` → `{h} hours` else `less than 1 hour`;
  `minutes_left_text(d)` → `{m} minutes remaining` / `less than 1 minute remaining`;
  `str_field` = non-empty string; `i64_field` = number (i64) or string parsed; `display_field` = non-empty string or number text;
  `fetch_my_stake(agent)` = new `TaskApiClient` + `get_my_stake`, errors → None.
- `evaluator_selected_post_evidence_steps(job, agent)` (:580): static Step 3/Step 4 instructions (rubric read, flatten verdict, vote-commit
  command template `onchainos agent vote-commit {job} --vote <0|1> --reason "…" --reason-summary "<≤30-char one-sentence summary>" --agent-id {agent}`),
  port verbatim from flow.rs:582–609 (note `\\n` renders as the two characters `\n`, `\\\"` as `\"`, ``\\` `` as ``\` ``, `\\$` as `\$`). Ends with `\n`.

---

## Commands

Auth legend: **jwt** = `TaskApiClient` JWT (onchainos wallet login session: `session.json` + keyring tokens; auto-refresh);
**sig** = additionally the session signing key (keyring `session_key` + `session.json.encryptedSessionSk`) to Ed25519-sign the
backend-prepared transaction hashes, plus a local wallet account owning the agent's `agentWalletAddress`.

### `onchainos agent apply <JOB_ID>`  (hidden: no)
- Handler: `agent_commerce/mod.rs:2006` → `asp::run_provider(ProviderCommand::Apply)` → `asp/apply.rs:16` `handle_apply`.
- Options (clap `mod.rs:674`): `JOB_ID` positional required; `--token-amount <String>` **required** (no default at this level;
  the internal `ProviderCommand::Apply` default `"0"` is unreachable); `--token-symbol <String>` required; `--agent-id <String>` required.
- Auth: jwt + sig.
- Steps:
  1. `agent_id == ""` (not trimmed) → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`.
  2. `amt = token_amount.trim()`; if empty or not `f64`-parseable or `< 0` (Rust `f64::from_str`: accepts `1e3`, `+1`, `.5`, `inf`; `NaN` fails
     the `>= 0` test) → ``--token-amount must be a non-negative number; got `{token_amount}`. Read the locked `tokenAmount` from the task fields (set at accept time) — for a designated assignment use the `tokenAmount` carried by the `JobAspSelected` envelope. Empty / negative = malformed apply, refusing to broadcast.``
     (0 is accepted despite the help text).
  3. `token_symbol.trim()` empty → ``--token-symbol must not be empty; got `{token_symbol}`. Read the locked `tokenSymbol` from the task fields (set at accept time) — for a designated assignment use the `tokenSymbol` carried by the `JobAspSelected` envelope. Do NOT assume USDT.``
  4. `resolve_wallet_by_agent_id(agent)` (self-subprocess `agent get-agents`).
  5. `POST /priapi/v1/aieco/task/{JOB_ID}/apply` via `post_with_identity`, body `{"sessionCert":…,"tokenAmount":<raw arg>,"tokenSymbol":<raw arg>}`, header `agenticId: {agent}`.
  6. `sign_uop_and_broadcast(resp.uopData, account, address, JOB_ID, resp.type, agent, None)` → broadcast bizContext `{"bizType":type,"jobId":JOB_ID}`.
  7. audit `ASP/apply_submitted` [`jobId=`,`agentId=`,`tokenSymbol=`,`tokenAmount=`,`txHash=`].
- Output (plain text, exit 0):
  ```
  ✓ Application submitted (apply), waiting for on-chain confirmation (provider_applied)
    Quote: {token_amount} {token_symbol}
    txHash: {txHash|pending}

  ⚠️  Next steps are driven by system notifications — do not proactively message the User Agent:
      - You will receive a `provider_applied` system notification after on-chain confirmation
  ```
- Errors: above validation (exit 1); wallet resolution; API errors; `backend did not return uopData; cannot sign and broadcast`;
  `backend transaction preflight failed: …`; `broadcast failed: …`; clap missing flags (exit 2).
- Side effects: FUND-MOVING (`POST /priapi/v1/aieco/task/broadcast`; apply prep endpoint is state).
- Nondeterminism: txHash; signatures.
- Parity: SAFE `agent apply 0xabc --token-amount -1 --token-symbol USDT --agent-id 7` (validation, no HTTP);
  SAFE `agent apply 0xabc --token-amount 1 --token-symbol "  " --agent-id 7`; SAFE `agent apply 0xabc --token-amount 1 --token-symbol USDT --agent-id ""`;
  UNSAFE `agent apply 0x<64hex> --token-amount 5 --token-symbol USDT --agent-id <aspId>`.

### `onchainos agent deliver <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2024` → `asp/deliver.rs:288` `handle_deliver`.
- Options (`mod.rs:687`): `JOB_ID` required; `--file <String>` default `""`; `--deliverable-text <String>` default `""`; `--agent-id` required.
- Auth: jwt (+ sig for one-time tasks); requires the local `okx-a2a` runtime.
- Steps:
  1. `agent_id == ""` → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`.
  2. `file.is_empty() == deliverable_text.is_empty()` (raw, untrimmed) → `Provide exactly one of --file or --deliverable-text`.
  3. `now = Local::now().timestamp()`. **Precondition** (`resolve_precondition`, :145):
     - identity `GET /priapi/v1/aieco/task/{JOB_ID}` (header `agenticId`).
     - **OK** (one-time path): `status` must be a JSON integer fitting i32 else `Task detail missing status field, cannot determine delivery eligibility`;
       status ≠ 1 → audit `ASP/deliver_blocked_wrong_status` + error
       ``Deliver rejected: current task status = {n} ({Status::as_str}), must be accepted (1) before delivery.⏎If you just applied, wait for the User Agent to confirm-accept on-chain and receive the `job_accepted` system notification before delivering.⏎Do NOT call `okx-a2a session send` to rush the User Agent — confirm-accept is a user decision driven by the User Agent's session.``
       `paymentMode` (integer, default 1) → `PaymentMode::from_int` ≠ Escrow → audit `ASP/deliver_blocked_wrong_payment_mode` + error
       `Deliver rejected: paymentMode = {n} ({none|legacy-x402-disabled}) — deliver/submit is only supported for escrow (1).⏎x402 tasks skip the submit step; the User Agent obtains the deliverable by replaying the ASP's endpoint and calls /direct/complete.`
       `jobType` (int or numeric string, default 0) == 1 → `subscription::fetch_detail` (identity `GET /priapi/v1/aieco/task/subscribe/{JOB_ID}`, agent trimmed; failure → routing Active, subStatus 0) → `liveness(now)`; else routing `NotSubscription`.
       buyer = `buyerAgentId` string or `""`; title = `title` or `(untitled)`; tokenSymbol/tokenAmount = string fields or none.
     - **Err whose Display contains `task not found` or `code=1001`** (subscription path): identity `GET /priapi/v1/aieco/task/subscribe/{JOB_ID}`; error →
       `job {JOB_ID} is not a one-shot task, and its subscription detail lookup failed: {e}`; routing = `SubscriptionDetail::from_json(raw).liveness(now)`;
       buyer = `buyerAgentId` (string or int) or `""`; title = `title` or `(untitled)`; tokenSymbol = `tokenSymbol`; tokenAmount = `serviceTokenAmount` | `paymentTokenAmount`.
     - any other error → propagated.
  4. `short_id` = JOB_ID when byte length ≤ 12 else first 8 **bytes** + `…` (used only in the manifest `task.shortId`; a
     non-ASCII jobId whose byte 8 is not a char boundary would panic → abort, practically unreachable for `0x…` ids).
  5. Routing `Ended` → audit `ASP/deliver_subscription_expired`; print raw JSON (see Output) and exit 0 (no send, no submit).
  6. buyer empty → `Deliver rejected: task detail is missing buyerAgentId; A2A delivery cannot be addressed and on-chain submit was not attempted`.
  7. Prepare + send (A2A over XMTP):
     - `--file`: `Path::exists` false → `file not found: {file}`; `okx_a2a::file_upload(file, agent, JOB_ID)` (errors abort, exit 1);
       message = `build_file_deliver_message`; `okx_a2a::xmtp_send(JOB_ID, buyer, msg)` (error captured as `send_error`).
     - `--deliverable-text` with > 500 Unicode chars: write `<OS temp dir>/deliverable_{JOB_ID}.md`, `file_upload` it, xmtp-send the file message
       (send error captured). If the write or upload fails (audit `ASP/deliver_long_text_fallback`) → xmtp-send `build_text_deliver_message`
       and write the text to `<temp>/deliverable_{Local %Y%m%d%H%M%S}.txt` (write errors ignored).
     - short text (≤ 500 chars): xmtp-send `build_text_deliver_message(JOB_ID, text)`; write `<temp>/deliverable_{Local %Y%m%d%H%M%S}.txt`.
     - Audit rows `ASP/deliver_file_upload`, `ASP/deliver_file_uploaded`, `ASP/deliver_text_prepare`, `ASP/deliver_long_text_uploaded`,
       `ASP/deliver_a2a_sent`/`ASP/deliver_a2a_failed` (`type=file|file_from_long_text|text_fallback|text`).
  8. `send_error` set: routing Active → audit `ASP/deliver_subscription_send_failed`, print `sendFailed` JSON, exit 0; otherwise audit
     `ASP/deliver_send_failed_submit_blocked` + error `A2A delivery failed; on-chain submit was not attempted: {msg}`.
  9. One-time only (`NotSubscription`): `resolve_wallet_by_agent_id`; `POST /priapi/v1/aieco/task/{JOB_ID}/submit` via
     `post_mutation_with_identity` (no retry) body `{"evidenceHash":"","sessionCert":…}`; `sign_uop_and_broadcast(uopData, …, JOB_ID, resp.type, agent, None)`;
     audit `ASP/deliver_submitted`. Subscription (Active): audit `ASP/deliver_subscription_continued`, no submit.
  10. Local save (errors ignored): if the prepared local file still exists → `deliverables::handle_save({jobId, role:"asp", file_path,
      deliverableType:"file"|"text", title, shortId, fileKey (file only), tokenSymbol, tokenAmount, counterpartyAgentId: buyer, counterpartyName: None})`
      — this **moves** the file (including a user-supplied `--file`) into `$ONCHAINOS_HOME/deliverables/asp/…`.
- Output:
  - Subscription (not an envelope; `output::to_agent_json` of a `Value`, sorted keys, compact unless `ONCHAINOS_PRETTY=1`), exit 0:
    - delivered: `{"delivered":true,"jobId":"<JOB_ID>","ok":true}` (a `deliveryId` key is never produced in 4.6.3)
    - ended: `{"backendCode":"subStatus=<code>","jobId":"<JOB_ID>","ok":false,"reason":"subscriptionExpired"}`
    - send failed: `{"message":"<error>","ok":false,"reason":"sendFailed"}`
  - One-time (plain text):
    ```
    ✓ Deliverable submitted; backend confirmation will open the Buyer review
      txHash: {txHash|pending}

    ⚠️  Next steps are driven by system notifications — do not proactively message the User Agent:
        - Wait for `job_completed` or `job_rejected`; ASP-side `job_submitted` is optional and not required for progress
    ```
- Errors: as listed (exit 1); upload/spawn errors; broadcast errors.
- Side effects: FUND-MOVING for one-time (`POST /priapi/v1/aieco/task/broadcast` after `…/submit`); peer message via `okx-a2a xmtp-send`;
  local files (temp files, deliverables dir; source file moved).
- Nondeterminism: temp file names (local timestamp), deliverable filenames/`savedAt`, fileKey/crypto metadata from okx-a2a, txHash.
- Parity: SAFE `agent deliver 0xabc --agent-id 7` (neither input → `Provide exactly one…`, no HTTP);
  SAFE `agent deliver 0xabc --file a --deliverable-text b --agent-id 7`; SAFE (read-only then error) `agent deliver 0x<64hex of a created task> --deliverable-text hi --agent-id <asp>` → `Deliver rejected: current task status = 0 (created)…`;
  UNSAFE `agent deliver 0x<accepted job> --deliverable-text "report" --agent-id <asp>`.

### `onchainos agent agree-refund <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2580` → `asp/agreerefund.rs:16`.
- Options (`mod.rs:878`): `JOB_ID`; `--agent-id` required.
- Auth: jwt + sig.
- Steps: `agent_id == ""` → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`;
  `resolve_wallet_by_agent_id`; `POST /priapi/v1/aieco/task/{JOB_ID}/agreeRefund` (post_with_identity, body `{}`+sessionCert);
  `sign_uop_and_broadcast(…, JOB_ID, resp.type, agent, None)`; audit `ASP/agree_refund_submitted`.
- Output (plain text):
  ```
  ✓ Full refund submitted
    Progress will update in this task.
    Ask me to view this task's details for the refund result.
  ```
- Errors: wallet/API/broadcast errors, exit 1.
- Side effects: FUND-MOVING (refunds escrow to the buyer; broadcast endpoint).
- Nondeterminism: none printed (txHash only audited).
- Parity: SAFE `agent agree-refund 0xabc --agent-id ""`; UNSAFE `agent agree-refund 0x<rejected job> --agent-id <asp>`.

### `onchainos agent asp-reject <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2588` → `asp/asp_reject.rs:17`.
- Options (`mod.rs:888`): `JOB_ID`; `--agent-id` required; `--reason <String>` default `""`.
- Auth: jwt.
- Steps: empty agent → same `--agent-id is required …` message; body `{}` when reason is `""` else `{"reason":reason}` (untrimmed);
  `POST /priapi/v1/aieco/task/{JOB_ID}/asp/reject` via `post_with_identity` (+sessionCert); audit `ASP/asp_reject_submitted` [`jobId`,`agentId`,`reason=`].
- Output (plain text; the two backend lines only when `data.code` is an integer / `data.msg` a string):
  ```
  ✓ Designation declined for jobId={JOB_ID}
    backend code: {code}
    backend msg:  {msg}

  ⚠️  This is an off-chain decline. Next steps:
      - Do NOT call `apply`. Do NOT proceed to the JobCreated playbook.
      - The User Agent is now free to designate a different ASP or fall back to public.
      - No further system events are expected for this jobId on your side.
  ```
- Errors: API errors exit 1. Side effects: state-changing (server, off-chain). Nondeterminism: none.
- Parity: SAFE `agent asp-reject 0xabc --agent-id ""`; UNSAFE `agent asp-reject 0x<job> --agent-id <asp> --reason "capacity"`.

### `onchainos agent accept-job-by-provider <JOB_ID>` / `decline-job-by-provider` / `accept-subscription` / `decline-subscription`  (hidden: no)
- Handlers: `mod.rs:2604/2612/2628/2636` → `asp/provider_decision.rs:243/251/267/282` → `execute` (:155).
- Options (`mod.rs:900–932`): `JOB_ID`; `--agent-id` required; decline variants also `--reason <String>` required.
- Auth: jwt + sig; additionally requires a non-empty `sessionCert` in `session.json`.
- Kind table: accept-job `acceptJobByProvider` bizType **203**; decline-job `declineJobByProvider` **202**; accept-subscription
  `acceptSubscription` **205**; decline-subscription `declineSubscription` **206**.
- Steps:
  1. `JOB_ID.trim()` empty → `jobId is required`; `agent.trim()` empty → `--agent-id is required`; decline: `reason.trim()` empty →
     `--reason is required for provider decline`; > 512 chars → `--reason exceeds 512 Unicode characters`.
  2. `wallet_store::load_session()` (I/O error propagates); no session or blank `sessionCert` → ``current login has no sessionCert; run `onchainos wallet login` again``.
  3. identity `GET /priapi/v1/aieco/task/{JOB_ID}` (task kinds) or `GET /priapi/v1/aieco/task/subscribe/{JOB_ID}` (subscription kinds); error →
     `cannot fetch latest detail before {action}; no mutation was attempted: {inner}`.
  4. status = task: `status` (JSON integer); subscription: `subStatus` else `status` (integers). 0 → continue; **1 → print the
     `already_accepted` result (also for decline kinds) and exit 0**; other → `latest status is {n}, not CREATED(0); no mutation was attempted`;
     none → `latest detail has no status; no mutation was attempted`.
  5. `resolve_wallet_by_agent_id(agent)`.
  6. `POST /priapi/v1/aieco/task/{JOB_ID}/{action}` (task kinds) or `POST /priapi/v1/aieco/task/subscribe/{JOB_ID}/{action}` (subscription kinds) via
     `post_mutation_with_identity` (no retry), body `{"sessionCert":…}`; error → `{action} failed or returned an unknown network result: {inner}`.
  7. Validate response: `data.jobId` trimmed non-empty string (`{action} response missing jobId`) equal to the raw `JOB_ID`
     (`{action} returned jobId {x}, expected {JOB_ID}`); `uopData` present and non-null (`{action} response missing uopData`);
     `type` == kind bizType (`{action} returned bizType {t}, expected {n}`).
  8. `sign_uop_and_broadcast_full(uopData, account, address, JOB_ID, kindBizType, agent, extra)` with extra = decline `{"reason":<trimmed reason>}` /
     accept none → bizContext `{"bizType","jobId"[,"reason"]}`; error → `{action} broadcast failed or returned an unknown result: {inner}`;
     `data[0]` null → `{action} broadcast returned no receipt`.
  9. audit `ASP/{action}_submitted` [`jobId`,`agentId`,`bizType=`].
- Output (`{"ok":true,"data":…}`, sorted keys):
  - success: `{"decision":"ready","nextAction":[],"payload":{"bizType":N,"broadcast":<data[0] passthrough>,"jobId":J,"providerDecision":"accept"|"decline","status":"broadcast_submitted","taskType":"single"|"subscription","type":N},"phase":"provider_decision","reason":"broadcast_submitted"}`
  - already accepted: `{"decision":"ready","nextAction":[],"payload":{"broadcast":null,"jobId":J,"providerDecision":"already_accepted","status":1,"taskType":"single"|"subscription"},"phase":"provider_decision","reason":"already_accepted"}`
- Errors: as listed, exit 1.
- Side effects: FUND-MOVING (accept locks the funded escrow to the provider; decline triggers refund) via `POST /priapi/v1/aieco/task/broadcast`.
- Nondeterminism: broadcast receipt fields.
- Parity: SAFE `agent decline-job-by-provider 0xabc --agent-id 7 --reason "  "` (validation); SAFE `agent accept-job-by-provider " " --agent-id 7`;
  SAFE-ish (read-only, then idempotent) `agent accept-job-by-provider 0x<already accepted job> --agent-id <asp>` → already_accepted;
  UNSAFE `agent accept-subscription 0x<created sub> --agent-id <asp>`.

### `onchainos agent claim-auto-complete <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:1962` → `asp/asp_claim.rs:21`.
- Options (`mod.rs:1093`): `JOB_ID`; `--agent-id` required.
- Auth: jwt + sig.
- Steps: empty agent → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`;
  `resolve_wallet_by_agent_id`; `POST /priapi/v1/aieco/task/{JOB_ID}/claimAutoComplete` (post_with_identity, `{}`+cert); broadcast; audit `ASP/claim_auto_complete_submitted`.
- Output (plain text):
  ```
  ✓ Timeout claim submitted (claimAutoComplete), waiting for on-chain confirmation (job_completed)
    txHash: {txHash|pending}

  ⚠️  Next steps are driven by system notifications:
      - You will receive a `job_completed` system notification after on-chain confirmation (funds released to you)
  ```
- Side effects: FUND-MOVING (releases escrow to the ASP). Nondeterminism: txHash.
- Parity: SAFE `agent claim-auto-complete 0xabc --agent-id ""`; UNSAFE `agent claim-auto-complete 0x<review_expired job> --agent-id <asp>`.

### `onchainos agent asp-claimable`  (hidden: no)
- Handler: `mod.rs:1970` → `asp/mod.rs:356` (inline).
- Options (`mod.rs:601`): `--agent-id` required.
- Auth: jwt.
- Steps: `agent == ""` → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`;
  `fetch_and_print_claimable(client, agent)` (identity `GET /priapi/v1/aieco/task/claimable`); audit `ASP/arbitration_claimable_checked`.
- Output (plain text): the claimable table (helper A), then either
  `⏎next: Claimable rewards available — run \`onchainos agent asp-claim-rewards --agent-id {agent}\` to withdraw all at once.` or
  `⏎(No pending rewards at this time)` (each preceded by an empty line).
- Side effects: read-only. Nondeterminism: none.
- Parity: SAFE `agent asp-claimable --agent-id <asp>`; SAFE `agent asp-claimable --agent-id ""`.

### `onchainos agent asp-claim-rewards`  (hidden: no)
- Handler: `mod.rs:1974` → `asp/mod.rs:380`.
- Options: `--agent-id` required. Auth: jwt + sig.
- Steps: empty check (same message); `resolve_wallet_by_agent_id`; `submit_claim_and_broadcast` (`POST /priapi/v1/aieco/task/claim` `{}` → broadcast with
  bizContext `{"bizType":type,"jobId":""}`); audit `ASP/arbitration_claimed` [`agentId`,`account=`,`txHash=`].
- Output (plain text; txHash is **not** printed):
  ```
  ✓ reward claim submitted (account={address})
  note: All settled evaluation rewards are claimed in one go; the credited amount will be notified after on-chain confirmation.
  ```
- Side effects: FUND-MOVING. Parity: SAFE `agent asp-claim-rewards --agent-id ""`; UNSAFE `agent asp-claim-rewards --agent-id <asp>`.

### `onchainos agent asp status <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:1422` → `run_provider(ProviderQueryCommand::Status.into())` → `asp/task_query.rs:520` `handle_detail(client, job, agent_id or "")`.
- Options (`asp/mod.rs:161`): `JOB_ID`; `--agent-id` optional.
- Auth: jwt.
- Steps:
  1. `job = JOB_ID.trim()`; empty → `jobId must not be empty`.
  2. `agent = resolve_agent_id_or_error(--agent-id, 2)` (may spawn `agent get-my-agents` up to twice).
  3. identity `GET /priapi/v1/aieco/task/{job}`:
     - OK with `jobType` == 1 → `fetch_subscription(job, agent)`; on error keep the task detail; kind Subscription.
     - OK otherwise → kind OneTime.
     - Err → `fetch_subscription` OK → kind Subscription; else `get_dispute_status(job, agent)` (identity `GET …/{job}/dispute/status`);
       if that fails → return the **original task error**; else detail = `{"jobId":job,"jobType":d.jobType,"status":d.taskStatus,"tokenAmount":…,"tokenSymbol":…}`,
       kind by `jobType==1`, print the arbitration variant (below) and exit 0.
  4. `task_status(detail)` (subStatus|status): 4 → `get_dispute_status` (error propagates); 6 or 9 → same, errors ignored; else none.
  5. Print.
- Output (`{"ok":true,"data":…}`, sorted):
  - `{"decision":"ready","nextAction":[],"payload":{"agentId":agent,"task":<normalize_item>},"phase":"provider_task_detail","reason":"task_found"}`
  - with dispute: `payload.arbitration` = `arbitration::build_detail_result(detail.jobId|dispute.jobId, detail, Some(dispute), None, None).payload`
    and `nextAction` = its `nextAction` (always `[]`).
- Errors: identity resolution, API errors. Side effects: read-only. Nondeterminism: local-TZ strings; `arbitrationPhase` uses wall clock.
- Parity: SAFE `agent asp status 0x<64hex> --agent-id <asp>`; SAFE `agent asp status "  " --agent-id 7`; SAFE `agent asp status 0x<sub id> --agent-id <asp>`.

### `onchainos agent asp list-tasks`  (hidden: no)
- Handler: `run_provider(ProviderCommand::List)` → `asp/task_query.rs:405` `handle_list(client, status, page, limit, agent or "")`.
- Options (`asp/mod.rs:167`): `--status <String>` optional; `--page <u32>` default 1; `--limit <u32>` default 20; `--agent-id` optional.
- Auth: jwt.
- Steps:
  1. page 0 or limit 0 → `page and page size must be greater than 0`.
  2. `agent = resolve_agent_id_or_error(--agent-id, 2)`.
  3. status trimmed equals `disputed` (case-insensitive) → `arbitration::handle_provider_arbitration_list(client, agent, page, limit)`
     (= `agent arbitration-list` behaviour, g12, plus `testFlag` per item; agent GET `/priapi/v1/aieco/task/dispute/my?page=&pageSize=` then agent GET
     `…/{jobId}/dispute/status` per item) and exit.
  4. `ensure_tokens_refreshed()` once, then **concurrently** (tokio `try_join!`, request order nondeterministic):
     - one-time: `start=(page-1)*limit`, `end=start+limit`, backend pages `start/20+1 ..= (end-1)/20+1`; for each: identity GET
       `/priapi/v1/aieco/task/my?page={bp}&page_size=20[&status={trimmed status}]` (+`?sessionCert=…` double-`?` quirk); `total = page_total(resp)`;
       append `list`; stop when `bp*20 >= total`. Then skip `start % 20`, take `limit` → `{"list","page","pageSize","total"}`.
     - subscription: `subscription_list_path(page, limit, status)`; Some → agent GET (no sessionCert); None → synthetic `{"list":[],"page","pageSize","total":0}`.
     First failing request aborts the command (error).
  5. `build_list_result` (:345): subscription rows kept when (`providerAgentId|aspAgentId` absent or == agent) and (no status, or
     `subscription_status_code(status)` == row status); items = normalized subscription rows then normalized one-time rows (one-time rows are not re-filtered).
- Output (`{"ok":true,"data":…}`, sorted):
  `{"decision":"ready","nextAction":[{"actionLabel":"View task details","id":"view_provider_task","params":{"allowedJobIds":[<item jobIds, strings only, in order>],"confirmationRequired":false},"recommend":false}],"payload":{"agentId","hasMore":subHasMore||oneHasMore,"hasSubscriptionTasks","items":[…],"oneTimeHasMore","oneTimeTotal","page","pageSize","paginationScope":"per_task_type","subscriptionHasMore","subscriptionTotal","total":oneTimeTotal+subscriptionTotal},"phase":"provider_task_list","reason":"tasks_found"|"no_tasks"}`
  (`subscriptionTotal` is the backend total even when rows were filtered client-side).
- Errors: validation, identity resolution, API errors. Side effects: read-only. Nondeterminism: local-TZ strings; concurrent request order.
- Parity: SAFE `agent asp list-tasks --agent-id <asp>`; SAFE `agent asp list-tasks --status active --page 2 --limit 3 --agent-id <asp>`;
  SAFE `agent asp list-tasks --status submitted --agent-id <asp>` (no subscription request); SAFE `agent asp list-tasks --page 0 --agent-id 7`;
  SAFE `agent asp list-tasks --status disputed --agent-id <asp>`.

### `onchainos agent subscribe-active`  (hidden: no)
- Handler: `mod.rs:2652` → `asp/subscription.rs:327` `handle_active`.
- Options (`mod.rs:937`): `--agent-id` required. Auth: jwt.
- Steps: `agent = select_subscription_agent_id("", --agent-id)` (trimmed; blank → `agenticId is required for subscription requests`);
  `now = Local::now().timestamp()`; identity `GET /priapi/v1/aieco/task/subscribe/my` (+`?sessionCert=`); items = `data.list` array or `data` itself when an
  array else `[]`; keep items whose `providerAgentId` (string or int) is absent or == agent, whose `SubscriptionDetail::liveness(now)` is Active, and that have a
  `jobId` (string or int).
- Output (`{"ok":true,"data":[…]}`, **struct order**): `[{"jobId":…,"subEndTime":n?,"subBufferEndTime":n?,"status":1}]` (optional keys omitted when absent).
- Side effects: read-only. Nondeterminism: wall-clock liveness.
- Parity: SAFE `agent subscribe-active --agent-id <asp>`; SAFE `agent subscribe-active --agent-id "  "` (error, no HTTP).

### `onchainos agent subscribe-agree-refund <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2656` → `asp/subscription.rs:397`.
- Options: `JOB_ID`; `--agent-id` required. Auth: jwt + sig.
- Steps: `select_subscription_agent_id` (trimmed agent used afterwards); `resolve_wallet_by_agent_id`;
  `POST /priapi/v1/aieco/task/subscribe/{JOB_ID}/agreeRefund` (post_with_identity, `{}`+cert); `sign_uop_and_broadcast(…, JOB_ID, resp.type, agent, None)`;
  audit `ASP/subscribe_agree_refund_submitted`.
- Output (plain text):
  ```
  ✓ Full refund for this subscription period submitted
    Progress will update in this task.
    Ask me to view this task's details for the refund result.
  ```
- Side effects: FUND-MOVING. Parity: SAFE `agent subscribe-agree-refund 0xabc --agent-id " "`; UNSAFE `agent subscribe-agree-refund 0x<rejected sub> --agent-id <asp>`.

### `onchainos agent subscribe-asp-claim <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2660` → `asp/subscription.rs:449`.
- Options: `JOB_ID`; `--agent-id` required. Auth: jwt + sig.
- Steps: as above with `POST /priapi/v1/aieco/task/subscribe/{JOB_ID}/aspClaim` (backend bizType 107); audit `ASP/subscribe_asp_claim_submitted`.
- Output (plain text):
  ```
  ✓ Claim submitted for accrued subscription income, waiting for on-chain confirmation
    txHash: {txHash|pending}

  ⚠️  This claims your own funds only — no buyer action is involved; do not message the buyer.
  ```
- Side effects: FUND-MOVING (claims ASP income). Parity: SAFE `agent subscribe-asp-claim 0xabc --agent-id ""`; UNSAFE `agent subscribe-asp-claim 0x<sub> --agent-id <asp>`.

### `onchainos agent subscribe-dispute <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2664` → `asp/subscription.rs:505` `handle_dispute`.
- Options (`mod.rs:970`): `JOB_ID`; `--reason <String>` required; `--agent-id` required. Auth: jwt + sig; needs `okx-a2a`.
- Steps:
  1. `select_subscription_agent_id` → trimmed agent.
  2. `reason.trim()` empty → `Evaluation reason is required. Pass the provided evaluation reason with --reason.`; `reason.chars().count() > 2000` →
     `Evaluation reason exceeds 2000 characters. Please shorten it and try again.`
  3. `resolve_wallet_by_agent_id(agent)`.
  4. `fetch_subscription(JOB_ID, agent)` (identity `GET /priapi/v1/aieco/task/subscribe/{JOB_ID}`) → error
     `subscribe-dispute: failed to fetch subscription detail for reason handoff: {inner}`; buyer = `buyerAgentId` | `userAgentId` (non-blank string) else
     `subscribe-dispute: subscription detail missing buyerAgentId for reason handoff`.
  5. `POST /priapi/v1/aieco/task/{JOB_ID}/dispute/approveAndCreateDispute` (post_with_identity, `{}`+cert) — note the `/task/{id}` path, not `/subscribe/`.
  6. `okx_a2a::session_send(JOB_ID, Some(buyer), build_subscription_reason_handoff(JOB_ID, agent, reason))` → error
     `subscribe-dispute: failed to hand off the evaluation reason to the task session; combined dispute transaction was not broadcast: {inner}`.
  7. `sign_uop_and_broadcast(uopData **unmodified**, …, JOB_ID, resp.type, agent, Some({"reason":reason}))` → bizContext `{"bizType","jobId","reason"}` (raw, untrimmed reason).
  8. audit `ASP/subscribe_dispute_submitted`.
- Output (plain text):
  ```
  ✓ Evaluation request submitted
    Progress will update in this task.
    Ask me to view this task's details for the evaluation result.
  ```
- Side effects: FUND-MOVING (approves the evaluation bond + creates the dispute). No balance precheck on this path.
- Nondeterminism: none printed.
- Parity: SAFE `agent subscribe-dispute 0xabc --reason " " --agent-id 7`; UNSAFE `agent subscribe-dispute 0x<rejected sub> --reason "met spec" --agent-id <asp>`.

### `onchainos agent dispute raise <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2674` → `asp/mod.rs:414` → `asp/dispute_raise.rs:98` `handle_dispute_raise`.
- Options (`asp/mod.rs:205`): `JOB_ID`; `--reason` required; `--agent-id` required. Auth: jwt + sig; needs `okx-a2a`.
- Steps:
  1. `agent == ""` → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`;
     reason blank → `Evaluation reason is required. Pass the provided evaluation reason with --reason.`; > 2000 chars →
     `Evaluation reason exceeds 2000 characters. Please shorten it and try again.`
  2. `resolve_wallet_by_agent_id(agent)`.
  3. identity `GET /priapi/v1/aieco/task/{JOB_ID}` → error `dispute raise: failed to fetch task details (deposit precheck): {inner}`.
  4. Deposit precheck: `amount = data.tokenAmount` (string only) parsed f64 (default 0); `symbol = data.tokenSymbol` or `?`; if amount > 0:
     `required = amount * 0.05` (f64, Rust shortest round-trip Display, e.g. `1`→`0.05`, `0.1`→`0.005000000000000001`); `ensure_sufficient_balance_at(required, symbol, address)` (spawns `onchainos portfolio all-balances --address {address} --chains 196`).
     Failure → wrap with context `Requesting evaluation requires a deposit >= 5% of the task amount ({required} {symbol}; task amount {amount} {symbol})`
     (f64 Display, e.g. `0.05`), `enrich_blocking_at(e, address)`, then `print_dispute_funding_block_from_error` → insufficient balance: stdout
     `{"ok":false,"data":<funding_blocked_envelope(warning,"dispute-bond","Evaluation bond")>}` exit 1 (QR/hint on stderr only if stderr is a TTY);
     other errors (e.g. `portfolio balance query failed …`) → normal error envelope `Requesting evaluation requires …: <inner>`.
  5. `POST /priapi/v1/aieco/task/{JOB_ID}/dispute/approveAndCreateDispute` (post_with_identity, `{}`+cert) → error
     `dispute raise: approveAndCreateDispute API request failed: {inner}`.
  6. `with_sa_batch_tx_flag(resp.uopData)` (adds `extraData.isSaBatchTx = true`; missing object → error).
  7. buyer = task `buyerAgentId` | `userAgentId` (non-blank string) else `dispute raise: task detail missing buyerAgentId for reason handoff`.
  8. `session_send(JOB_ID, Some(buyer), build_reason_handoff(JOB_ID, agent, reason))` (5 s timeout) → error
     `dispute raise: failed to hand off the evaluation reason to the task session; combined transaction was not broadcast: {inner}`.
  9. `sign_uop_and_broadcast(flaggedUopData, account, address, JOB_ID, resp.type, agent, Some({"reason":reason}))` → error
     `dispute raise: approveAndCreateDispute on-chain broadcast failed: {inner}`.
  10. audit `ASP/evaluation_requested` [`jobId`,`agentId`,`reasonLen=`,`txHash=`].
- Output (plain text): same three lines as `subscribe-dispute` (`✓ Evaluation request submitted` …).
- Side effects: FUND-MOVING (bond approval + dispute creation via broadcast); A2A session message.
- Nondeterminism: none printed; funding-block `fundingDisplayMode` depends on TTY detection.
- Parity: SAFE `agent dispute raise 0xabc --reason "" --agent-id 7`; SAFE `agent dispute raise 0xabc --reason "$(python -c 'print("x"*2001)')" --agent-id 7`;
  UNSAFE `agent dispute raise 0x<rejected job> --reason "delivery met the brief" --agent-id <asp>`.

### `onchainos agent dispute confirm <JOB_ID>`  (hidden: no — retired, always fails)
- Handler: `asp/mod.rs:419` → `dispute_confirm::decode_reason_input` (:14) → `handle_dispute_confirm` (:31).
- Options (`asp/mod.rs:214`): `JOB_ID`; `--reason <String>` (required unless `--reason-b64`, conflicts with it); `--reason-b64 <String>` (required unless
  `--reason`, conflicts); `--agent-id` required. Neither/both → clap error, exit 2.
- Auth: anonymous (no network, no file access).
- Steps (all end in an error, exit 1):
  1. `--reason-b64`: URL-safe **no-padding** base64 decode (base64 0.22 `URL_SAFE_NO_PAD`; `=` padding is rejected) → error
     `--reason-b64 is not valid URL-safe base64: {DecodeError}`; invalid UTF-8 → `--reason-b64 does not contain UTF-8 text: {FromUtf8Error}`.
  2. `agent == ""` → `--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)`.
  3. reason blank → `Evaluation reason is required. Pass the original evaluation reason with --reason or --reason-b64.`; > 2000 chars →
     `Evaluation reason exceeds 2000 characters. Please shorten it and try again.`
  4. Always: ``dispute confirm has been retired. Use `onchainos agent dispute raise <jobId> --reason <reason> --agent-id <aspAgentId>`; it completes approve and evaluation creation in one transaction``.
- Side effects: none. Parity: SAFE `agent dispute confirm 0xabc --reason ok --agent-id 7`; SAFE `agent dispute confirm 0xabc --reason-b64 '%%%' --agent-id 7`;
  SAFE `agent dispute confirm 0xabc --agent-id 7` (clap exit 2).

### `onchainos agent dispute upload <JOB_ID>`  (hidden: no; "[Internal]")
- Handler: `asp/mod.rs:429` → `common/dispute_upload.rs:44` `handle_upload_evidence` — **specified in g12** (options `--agent-id`, `--role`, `--text`,
  repeatable `--file`, `--max-files`; `POST /priapi/v1/aieco/task/{job}/evidence/upload` multipart; state-changing).

### `onchainos agent evidence-info <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2683` → `evaluator/info.rs:17` `handle_info`.
- Options (`mod.rs:1126`): `JOB_ID`; `--agent-id` required; `--round-num <String>` required.
- Auth: jwt. `--agent-id` is used **raw** (not trimmed, not validated).
- Steps:
  1. `precheck_round_gate(client, JOB_ID, agent, round_num)` (B8): identity `GET /priapi/v1/aieco/task/{JOB_ID}/dispute/status`; prints the status block;
     gate fails → prints `reason`/`selected: no`, exit 0 (no evidence download).
  2. identity `GET /priapi/v1/aieco/task/{JOB_ID}/evidence` → `data`.
  3. `mkdir -p $ONCHAINOS_HOME/task/{JOB_ID}/dispute/{agent}` (error → exit 1 after the gate text was printed).
  4. For side in `provider`, `client`: for each string item of `data[side].files[]` (non-strings left untouched): GET
     `{base}/priapi/v1/aieco/task/{JOB_ID}/evidence/download?fileKey={urlencoded}` via `get_bytes_with_identity` (plain reqwest, headers = jwt headers +
     `agenticId`, no retry, no DoH); write to `<dir>/{fileKey after the first '/', with remaining '/' → '_'}` (no '/' → whole key), **no extension**.
     Replace the item with `{"fileKey":k,"localPath":"<path>"}` or, on any download/write error, `{"downloadError":"<err Display>","fileKey":k}`
     (+ audit `evaluator/evidence_download_failed`).
  5. Print `serde_json::to_string_pretty(data)` (sorted keys, 2-space indent), then an empty line, `---`, an empty line, then
     `evaluator_selected_post_evidence_steps(JOB_ID, agent)` (B9; `print!`, the text ends with `\n`).
- Output (plain text): status block + `⏎selected: yes` + evidence JSON + `⏎---⏎⏎` + steps; or status block + `⏎reason: …⏎selected: no`.
- Errors: dispute-status API/parse errors (`failed to parse dispute/status response: …`), evidence API errors, mkdir errors.
- Side effects: read-only on server; writes evidence files locally.
- Nondeterminism: evidence file keys; local paths (depend on `ONCHAINOS_HOME`).
- Parity: SAFE `agent evidence-info 0x<64hex> --agent-id <evaluator> --round-num 1`; SAFE `agent evidence-info 0x<64hex> --agent-id <evaluator> --round-num abc`
  (gate reason after HTTP); SAFE on a completed task (terminal reason).

### `onchainos agent vote-commit <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2691` → `evaluator/commit.rs:39` `handle_commit`.
- Options (`mod.rs:1139`): `JOB_ID`; `--vote <u8>` required (clap rejects non-integers / >255, exit 2); `--reason <String>` required;
  `--reason-summary <String>` required; `--agent-id` required.
- Auth: jwt + sig.
- Steps:
  1. vote ∉ {0,1} → `--vote must be 0 (Approve, Client wins) or 1 (Reject, Provider wins)`.
  2. `reason = unescape_reason(reason.trim())`; blank → `--reason must not be empty`.
  3. `summary = reason_summary.trim()`; empty → `--reason-summary must not be empty`; > 30 chars →
     `--reason-summary must be ≤30 characters (got {n}); compress the verdict further`.
  4. `resolve_wallet_and_agent_for_evaluator(agent)` → trimmed agent used afterwards.
  5. `POST /priapi/v1/aieco/task/{JOB_ID}/vote/commit` (post_with_identity) body `{"sessionCert":…,"vote":0|1}`.
  6. `salt = data.salt` string non-empty else `backend did not return salt, cannot broadcast vote/commit`; `commitHash = data.commitHash` or `""`.
  7. `sign_uop_and_broadcast_with_commit_meta(uopData, …, JOB_ID, resp.type, agent, salt, vote, reason, summary)` → bizContext
     `{"bizType","commitSalt","jobId","vote","voteReport","voteReportSummary"}`.
  8. audit `evaluator/vote_committed` [`jobId`,`agentId`,`vote=`,`reasonLen=`,`reasonSummaryLen=`,`commitHash=`,`txHash=`].
- Output (plain text; label `Approve (Client wins)` for 0, `Reject (Provider wins)` for 1; commitHash line only when non-empty):
  ```
  vote committed (jobId={JOB_ID})
    vote:       {vote} ({label})
    voter:      {address}
    commitHash: {commitHash}
    txHash:     {txHash|pending}
  ```
- Side effects: FUND-MOVING/state (on-chain vote commit via broadcast; server stores vote+salt at `/vote/commit`).
- Nondeterminism: salt, commitHash, txHash.
- Parity: SAFE `agent vote-commit 0xabc --vote 2 --reason r --reason-summary s --agent-id 9`; SAFE `… --vote 1 --reason r --reason-summary "<31 chars>" …`;
  SAFE `… --vote 256 …` (clap exit 2); UNSAFE `agent vote-commit 0x<disputed job> --vote 1 --reason "Verdict\n…" --reason-summary "ASP delivered as specified" --agent-id <evaluator>`.

### `onchainos agent vote-reveal <JOB_ID>`  (hidden: no)
- Handler: `mod.rs:2709` → `evaluator/reveal.rs:8`.
- Options (`mod.rs:1166`): `JOB_ID`; `--agent-id` required. Auth: jwt + sig.
- Steps: `resolve_wallet_and_agent_for_evaluator`; identity `GET /priapi/v1/aieco/task/{JOB_ID}/vote/canReveal`; `canReveal` false → audit
  `evaluator/vote_reveal_skipped` + error `backend canReveal=false (jobId={JOB_ID}): reveal window not yet open / current round already settled / no commit submitted.`;
  not a bool → `canReveal response missing boolean field, backend may have returned malformed data: {data compact sorted JSON}`;
  `POST /priapi/v1/aieco/task/{JOB_ID}/vote/reveal` body `{}`(+cert); `sign_uop_and_broadcast(…, JOB_ID, resp.type, agent, None)`; audit `evaluator/vote_revealed`.
- Output (plain text):
  ```
  vote revealed (jobId={JOB_ID})
    txHash:       {txHash|pending}
  ```
- Side effects: FUND-MOVING/state (on-chain reveal). Parity: SAFE `agent vote-reveal 0xabc --agent-id " "` (resolver error);
  SAFE-ish `agent vote-reveal 0x<job not in reveal> --agent-id <evaluator>` (canReveal=false error); UNSAFE in reveal phase.

### `onchainos agent arbitration-claim`  (hidden: no)
- Handler: `mod.rs:2713` → `evaluator/claim.rs:10`.
- Options: `--agent-id` required. Auth: jwt + sig.
- Steps: `resolve_wallet_and_agent_for_evaluator`; `submit_claim_and_broadcast` (`POST /priapi/v1/aieco/task/claim` `{}` → broadcast, `jobId:""`);
  audit `evaluator/arbitration_claimed`.
- Output (plain text):
  ```
  reward claim submitted (account={address})
    txHash:   {txHash|pending}
  note: claims all rewards from settled evaluations at once; settled amount will be notified after on-chain confirmation.
  ```
- Side effects: FUND-MOVING. Parity: SAFE `agent arbitration-claim --agent-id ""`; UNSAFE `agent arbitration-claim --agent-id <evaluator>`.

### `onchainos agent arbitration-claimable`  (hidden: no)
- Handler: `mod.rs:2717` → `evaluator/claimable.rs:14`.
- Options: `--agent-id` required (clap), **no emptiness validation** (an empty value is sent as `agenticId: `). Auth: jwt.
- Steps: `fetch_and_print_claimable(client, agent)`; audit `evaluator/arbitration_claimable_checked`.
- Output (plain text): claimable table, then either
  `⏎next: rewards available — say 'claim rewards' to withdraw all at once; settles after on-chain confirm.⏎hasClaimable: yes` or
  `⏎(no claimable rewards)⏎hasClaimable: no` (the last line is the stable marker the playbook relies on).
- Side effects: read-only. Parity: SAFE `agent arbitration-claimable --agent-id <evaluator>`; SAFE `agent arbitration-claimable --agent-id ""`.

### `onchainos agent stake` / `onchainos agent increase-stake`  (hidden: no)
- Handlers: `mod.rs:2721/2725` → `evaluator/stake.rs:11` `handle_stake` / `:38` `handle_increase_stake` → `run` (:62).
- Options (`mod.rs:1193/1203`): `--amount <String>` required; `--agent-id` required. Auth: jwt + sig.
- Steps:
  1. `stake` only: `ensure_communication_ready_preflight()` (spawns `okx-a2a --version`, `okx-a2a doctor --json`; skip with `ONCHAINOS_SKIP_A2A_PREFLIGHT=1`).
  2. `validate_amount`: trimmed empty → `--amount must not be empty (OKB amount in UI units)`; any char other than ASCII digit or `.` →
     `--amount must be numeric (OKB amount in UI units); use \`.\` for decimal point and no thousands separators, got: {trimmed}` (so `0`, `.`, `1.2.3` pass here).
  3. `resolve_wallet_and_agent_for_evaluator(agent)`.
  4. `get_my_stake` → error `failed to fetch my-stake, cannot route stake vs increase-stake: {e}` (`{e}` = outermost message only);
     `get_staking_config` → error `failed to fetch staking-config, cannot validate cumulative stake threshold: {e}`.
  5. Threshold (skipped silently when `decimal_str::add(amount, activeStake)` or `cmp` fails): if `amount + activeStake < minCumulativeStakeOkb` →
     `cumulative stake too low: this {amount} OKB + current activeStake {active} OKB < platform minimum {min} OKB (minCumulativeStakeOkb). increase --amount by at least {min - active (decimal_str::sub, fallback min)} OKB.`
  6. endpoint = `increaseStake` if `myStake.registered` else `stake` (**both commands route by `registered`**, not by the command used).
  7. `POST /priapi/v1/aieco/task/staking/{endpoint}` (post_with_identity) body `{"amount":"<trimmed>","sessionCert":…}`;
     `sign_uop_and_broadcast(uopData, …, jobId="", resp.type, agent, None)`.
  8. audit `evaluator/stake_increased` (endpoint increaseStake) or `evaluator/staked` [`agentId`,`amount=`,`endpoint=`,`txHash=`].
  9. `stake` only, after printing: `refresh_agent_identities_silently()` (stderr lines, spawns `okx-a2a agent refresh --json`).
- Output (plain text): label `stake`/`increase-stake`, amount prefix `""`/`+`:
  ```
  {label} submitted (agentId={agent}, via={endpoint})
    amount:  {prefix}{amount} OKB
    voter:   {address}
    txHash:  {txHash|pending}
  next: {hint}
  ```
  hint (stake) `stake transaction submitted; waiting for on-chain confirmation. Once confirmed, you become an active evaluator candidate and may be drawn into a jury panel.`;
  (increase-stake) `increase-stake submitted; waiting for on-chain confirmation.`
- Side effects: FUND-MOVING (locks OKB in the staking contract). Nondeterminism: txHash; stderr readiness lines.
- Parity: SAFE `agent increase-stake --amount abc --agent-id 9`; SAFE `agent increase-stake --amount "" --agent-id 9`; SAFE (with `ONCHAINOS_SKIP_A2A_PREFLIGHT=1`)
  `agent stake --amount 1,000 --agent-id 9`; UNSAFE `agent stake --amount 0.001 --agent-id <evaluator>`.

### `onchainos agent request-unstake`  (hidden: no)
- Handler: `mod.rs:2729` → `evaluator/unstake.rs:20`.
- Options (`mod.rs:1213`): `--amount` required; `--agent-id` required. Auth: jwt + sig.
- Steps:
  1. trimmed empty → `--amount must not be empty (OKB amount in UI units, e.g. 50)`; non digit/`.` → `--amount must be numeric (OKB amount in UI units, no precision suffix), got: {t}`;
     `decimal_str::cmp(t,"0")` error → `--amount parse failed (invalid format), got: {t}: {e}`; not > 0 → `--amount must be > 0, got: {t}`.
  2. `resolve_wallet_and_agent_for_evaluator`.
  3. `get_my_stake` (error → `failed to fetch my-stake, cannot validate request-unstake preconditions: {e}`); `activeDisputes` parsed u64 (default 0) > 0 →
     `{n} evaluation(s) are in progress; unstake becomes available after they are settled.`; `cmp(amount, activeStake)` error →
     `activeStake parse failed ({active}): {e}`; amount > active → `--amount {t} OKB exceeds current activeStake {active} OKB; max unstake is {active} OKB (full redemption).`
  4. `get_staking_config` (error → `failed to fetch staking-config, cannot validate partial-unstake min retain: {e}`); `remaining = sub(active, amount)` (error →
     `unstake pre-check: activeStake {active} - amount {t} computation failed: {e}`); remaining ≠ 0 and `< partialUnstakeMinRetainOkb` →
     `partial unstake would leave {remaining} OKB, below min retain {retain} OKB (partialUnstakeMinRetainOkb). switch to full redemption (amount = {active} OKB), or reduce --amount so remaining >= {retain} OKB.`
     (cmp error → `partialUnstakeMinRetainOkb parse failed ({retain}): {e}`).
  5. `POST /priapi/v1/aieco/task/staking/requestUnstake` body `{"amount":t,"sessionCert":…}`; broadcast (`jobId:""`); audit `evaluator/unstake_requested`.
- Output (plain text):
  ```
  request-unstake submitted (agentId={agent})
    amount:  -{t} OKB (pending)
    voter:   {address}
    txHash:  {txHash|pending}
  next: request submitted, awaiting on-chain confirmation; after confirm, enters {unstake_cooldown_days}-day cooldown — claimable on expiry, cancellable during cooldown.
    config: partial-unstake min retain {partialUnstakeMinRetainOkb} OKB (below this, only full redemption is allowed)
  ```
- Side effects: FUND-MOVING/state (starts unbonding). Parity: SAFE `agent request-unstake --amount 0 --agent-id 9`; SAFE `agent request-unstake --amount 1.2.3 --agent-id 9`;
  UNSAFE `agent request-unstake --amount 0.0002 --agent-id <evaluator>`.

### `onchainos agent claim-unstake` / `onchainos agent cancel-unstake`  (hidden: no)
- Handlers: `mod.rs:2733/2737` → `evaluator/unstake.rs:153` / `:206`.
- Options: `--agent-id` required. Auth: jwt + sig.
- Steps: `resolve_wallet_and_agent_for_evaluator`; best-effort `get_my_stake` (errors skip the precheck):
  - claim: `unstakeAvailableAt == 0` → `no pending unstake request to claim. Submit an unstake request first.`; `now_utc < at` →
    `unstake cooldown not finished (unlocks at {at} (local time {%Y-%m-%d %H:%M:%S %Z})); claim after expiry.`
  - cancel: `at == 0` → `no pending unstake request to cancel.`; `now_utc >= at` →
    `unstake cooldown has finished and the request is already claimable; cancel is no longer valid. Use claim-unstake instead.`
  Then `POST /priapi/v1/aieco/task/staking/claimUnstake` | `…/cancelUnstake` body `{}`(+cert); broadcast (`jobId:""`); audit `evaluator/unstake_claimed` | `evaluator/unstake_cancelled`.
- Output (plain text) — claim-unstake:
  ```
  claim-unstake submitted (agentId={agent})
    voter:   {address}
    txHash:  {txHash|pending}
  next: claim tx submitted, awaiting on-chain confirmation and settlement.
  ```
  cancel-unstake:
  ```
  cancel-unstake submitted (agentId={agent})
    voter:   {address}
    txHash:  {txHash|pending}
  next: cancel tx submitted, awaiting on-chain confirmation; stake will be restored after confirm.
  ```
- Side effects: FUND-MOVING (claim returns OKB to wallet; cancel restakes). Nondeterminism: wall clock vs `unstakeAvailableAt`; local TZ.
- Parity: SAFE-ish `agent claim-unstake --agent-id <evaluator with no pending unstake>` (precheck error after read); UNSAFE when claimable.

### `onchainos agent staking-config`  (visible alias `stakingconfig`; hidden: no)
- Handler: `mod.rs:2741` → `evaluator/staking_config.rs:6`.
- Options (`mod.rs:1238`): `--agent-id` required (used raw). Auth: jwt.
- Steps: `get_staking_config(client, agent)`.
- Output (plain text):
  ```
  staking & evaluation config
    minCumulativeStakeOkb       : {v} OKB
    partialUnstakeMinRetainOkb  : {v} OKB
    unstakeCooldownDays         : {format_fractional_unit(unstakeCooldownSeconds,86400)}
    arbitrationFeeBps           : {v}
    commitPhaseHours            : {…/3600}
    revealPhaseHours            : {…/3600}
    slashMinorityBps            : {v}
    slashTimeoutBps             : {v}
    slashedCooldownHours        : {…/3600}
  ```
  (oracle from the doc sample: `604800`→`7`, `64800`→`18`, `21600`→`6`, `86400`→`24`).
- Errors: API errors; `failed to parse staking config response: <serde error>`. Side effects: read-only.
- Parity: SAFE `agent staking-config --agent-id <evaluator>`; SAFE `agent stakingconfig --agent-id <evaluator>`.

### `onchainos agent my-stake`  (visible alias `mystake`; hidden: no)
- Handler: `mod.rs:2745` → `evaluator/my_stake.rs:19`.
- Options: `--agent-id` required (raw). Auth: jwt.
- Output (plain text; `fmt(ts)` = `0 ({none_label})` when 0, else `{ts} ({local %Y-%m-%d %H:%M:%S %Z})`, or `{ts} (unparseable)`):
  ```
  my stake (on-chain staking state)
    voter address      : {voterAddress}
    agentId            : {agentId} (registered={true|false})
    activeStake        : {activeStake} OKB  # currently staked (net of slashing)
    pendingUnstake     : {pendingUnstake} OKB  # in cooldown, awaiting unlock
    validStake         : {validStake} OKB  # weight-eligible = activeStake - pendingUnstake
    activeDisputes     : {activeDisputes}  # evaluations in progress (unstake available when 0)
    unstakeAvailableAt : {fmt(unstakeAvailableAt) with label "no pending unstake"}
    cooldownEndsAt     : {fmt(cooldownEndsAt) with label "not in slashing cooldown"}
  ```
- Errors: API errors; `failed to parse myStake response: <serde error>` (e.g. when `activeDisputes` is a JSON number). Side effects: read-only.
- Nondeterminism: local TZ. Parity: SAFE `agent my-stake --agent-id <evaluator>`; SAFE `agent mystake --agent-id <evaluator>`.

---

### Playbook generators invoked by `onchainos agent next-action` (role `asp` / `evaluator`)

`next-action` (g11a §4.8) validates the envelope, runs the freshness gate, then calls these functions and prints the returned
string + `\n` (exit 0). Inputs: `job` (= `message.jobId`), `event` (= `message.event`, raw), `agent` (= `--agentId`, raw),
`job_title` (= `message.jobTitle` string, may be `Some("")`), `data` (= `message.data` string), `prefetched` (PreFetchedTaskContext
or None), `message` (parsed JSON). Output is plain text or compact sorted JSON (text-embedded), never an envelope.

#### `asp::flow::generate_next_action` (`asp/flow.rs:462`)
`short_id = util::short_job_id(job)` (≤12 chars as-is, else first 6 chars + `…` + last 4); `title_display = job_title or "<title>"`;
`event = parse_status_or_event(event_str)` (status names map to entry events, e.g. `accepted`→`job_accepted`).
Helper texts (verbatim; `⏎` = LF):
- `terminal_session_hint` (flow.rs:610–615, no trailing LF):
  ``ℹ️ Task is in terminal state — run the cleanup command (handles pending-decision cancellation automatically):⏎```bash⏎onchainos agent session-cleanup --job-id {job}⏎```⏎Then follow the command's output to close conversations (if applicable).``
- `execute_task` (:595–605, no trailing LF):
  ``Reuse the designated registered Service's existing AI/Skill workflow. Feed it the authoritative description, complete serviceParams, and forwarded attachments from the Task fields/session; do not substitute an unrelated workflow and do not re-run provider acceptance.⏎⏎⚠️ If a new question about task details / acceptance criteria is still required, use the existing A2A session (resolve `<buyerAgentId>` from the Task fields above):⏎    ```bash⏎    okx-a2a xmtp-send \⏎      --job-id {job} \⏎      --to-agent-id <buyerAgentId> \⏎      --message "<plain natural-language question to the User Agent>" --json⏎    ```⏎End this turn after sending, wait for the reply; once you have the answer, start the work. Do not guess and produce a deliverable that misses the mark.``
- `inline_task_fields(fields)` (:497–580): when prefetched exists and at least one requested field renders →
  `**Task fields** (pre-fetched; use directly — skip the \`common context\` call unless a value below is empty / null):⏎` followed, in the
  requested order, by `  - {key}: {value}⏎` for each field that has a value: `title`/`description`/`tokenAmount` when non-empty; `tokenSymbol`
  when non-empty and ≠ `?`; `buyerAgentId` (= `user_agent_id`), `providerAgentId`, `serviceId`, `serviceTokenAddress`, `serviceTokenAmount`,
  `serviceParams` when non-empty; `paymentMode` when present as `  - paymentMode: {n} ({1→escrow | 3→x402 | else unknown})⏎`.
  Otherwise (no prefetch or nothing rendered): ``**Load task context first**:⏎```bash⏎onchainos agent common context {job} --role asp --agent-id {agent}⏎```⏎Extract {fields joined by " + "} (needed below).⏎``.
  The block always ends with `⏎`; call sites then add their own `⏎`.

First-pass routing (returns early):
| Event | Result |
|---|---|
| `job_rejected` with prefetched `providerAgentId==agent`, `jobType==0`, `status==9`, `is_zero_decimal(tokenAmount)` | `v2::notification::free_job_rejected_failed` JSON |
| `job_rejected` (otherwise) | `arbitration_decision_playbook("job_rejected")` |
| `sub_user_reject` | `arbitration_decision_playbook("sub_user_reject")` |
| `user_decision_job_rejected` / `user_decision_sub_user_reject` | bound relay: `message.decisionId` must be a string starting with `{job}:{source}:` and longer, and `message.selectedActionId` a string, else `blocked_result("decision_metadata_missing", job, {"sourceEvent":source})`; then `resolved_action(source, action, job, message.params)` → Ok `build_selected_result` JSON `{"decision":"ready","nextAction":[{"id":action,"params":{…params,"jobId":job},"recommend":true}],"payload":{"jobId":job},"phase":"arbitration_decision","reason":"user_choice_resolved"}`; Err → `blocked_result(ambiguous_choice|arbitration_reason_required|unsupported_action, job, {"sourceEvent":source})` |

`arbitration_decision_playbook(source, …)` (:339): `result = arbitration_decision_result` (:230 — name = message `jobTitle|title|serviceName` scalar,
else `job_title` (non-empty), else prefetched `serviceName`/`title`; amount = message `tokenAmount|serviceTokenAmount`, else prefetched
`serviceTokenAmount`/`tokenAmount`; symbol = message `tokenSymbol|paymentTokenSymbol`, else prefetched `tokenSymbol` (≠`?`); decision context =
message (or `{}`) with `expireTime`, `serviceName`, `refundReason`, `subStartTime`, `subEndTime` filled from prefetched when missing; then
`arbitration::build_decision_result`). If `result.decision ≠ "requires_user_input"` → print `result` as compact JSON (e.g. blocked
`missing_required_facts`). Else require string payload fields `serviceName, taskType, requestedRefund, buyerReason, responseDeadline, decisionId, refundDisplayB64`
(else `blocked_result("missing_required_facts", job, {"sourceEvent":source})`), sub requires `currentPeriod` (else details add `"missingFields":["currentPeriod"]`),
`responseDeadlineTimestamp` integer (else `"missingFields":["responseDeadline"]`). Then the text of flow.rs:423–444 with:
`to_flag` = ` --to-agent-id {prefetched.userAgentId}` or empty; `--list-label "[Decision {short_id}] {{__OKX_REFUND_SERVICE_NAME__}} — refund or evaluation"`;
`--decision-id "{decisionId}"`; `--choices-json '{json}'` where json = `serde_json::to_string(default_choices(source, job))` in struct order
`[{"key":"A","actionId":"agree_refund"|"sub_agree_refund","params":{"jobId":job}},{"key":"B","actionId":"raise_arbitration"|"raise_subscription_arbitration","params":{"jobId":job}}]`
with every `'` replaced by `'"'"'`; `--expires-at {responseDeadlineTimestamp}`; `--refund-display-b64 "{refundDisplayB64}"`;
`--template-vars-b64 "{pending_v2::encode_refund_decision_vars(serviceName, job, taskType, currentPeriod?, requestedRefund, buyerReason, responseDeadline)}"`;
the embedded `=== BEGIN TEMPLATE 6.4 SOURCE ===` block = `asp_refund_decision_source_template(source=="sub_user_reject")`. Note the literal
text `Preserve every reserved \`{__OKX_...__}\` placeholder` renders with **single** braces (format escape).

Second-pass routing (`match event`; `job_rejected` / `sub_user_reject` / decision relays never reach it):
| Event | Output (verbatim source range; interpolations) | Extra side effects |
|---|---|---|
| `provider_applied` | flow.rs:705–719 (`provider_applied_user_notify(job, agent)`) | — |
| `job_accepted` | :727–765 (`inline_task_fields([title,description,tokenAmount,tokenSymbol,serviceId,serviceParams,buyerAgentId])`, `job_accepted_user_notify`, `execute_task`) | — |
| `job_submitted` | :774–790 (`job_submitted_user_notify`) | — |
| `raise_arbitration`, `dispute_raise`, `agree_refund` (pseudo) | `blocked_result("decision_metadata_missing", job, {"receivedEvent":e,"sourceEvent":"job_rejected"})` | — |
| `dispute_approved` | `[Current state] dispute_approved (compatibility receipt)⏎[Role] ASP⏎⏎Evaluation creation is already submitted by \`approveAndCreateDispute\`. End this turn and continue when the matching evaluation event or fresh status arrives.⏎jobId={job}⏎` | — |
| `raise_subscription_arbitration`, `sub_dispute`, `sub_agree_refund` | `blocked_result("decision_metadata_missing", job, {"receivedEvent":e,"sourceEvent":"sub_user_reject"})` | — |
| `job_completed` | `v2::job_completed::handle(job, agent)` JSON (B5) | identity GET `/task/{job}`; may spawn `agent task-feedback` |
| `dispute_resolved` | :955–1038 (`inline_task_fields([title,tokenAmount,tokenSymbol,buyerAgentId])`, won/lost/rating copies, `terminal_session_hint`) | — |
| `job_refunded` | :1044–1049 | — |
| `job_disputed` | :1056–1097 (`inline_task_fields([buyerAgentId])`) | — |
| `job_created` | `[System notification] job_created (task is on-chain; no ASP-side action)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn.⏎Designated tasks arrive via a \`job_asp_selected\` event when the User Agent designates this ASP.⏎` | — |
| `job_asp_selected` / `sub_open` | `provider_assignment_playbook(Single / Subscription)` (below) | may spawn `agent service-list` |
| `job_asp_accept_expire`, `job_asp_reject_closed`, `job_asp_reject_expire` | B5 builders with prefetched; no prefetch → `authoritative_context_required(job, event, ["taskDetail"])` | — |
| `job_expired`, `submit_expired` | `job_delivery_expired(job, prefetched, event)`; no prefetch → `…["taskDetail"]` | — |
| `sub_asp_claim_notify` | `sub_asp_claim_notify(job, message)` JSON | — |
| `job_closed`, `job_payment_mode_changed` | `[System notification] {event} (User Agent-side tx receipt; not the ASP's concern)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn. ⏎` (note the space before the final newline) | — |
| `reject_expired`, `review_deadline_warn` | `[System notification] {event} (User Agent-side timeout event; not the ASP's concern)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn.⏎` | — |
| `review_expired` | :1177–1192 (claim-auto-complete instructions) | — |
| `submit_deadline_warn` | :1208–1214 with `request_block = pending_v2::request_command_block(job,"asp",agent,prefetched.userAgentId?, submit_deadline_warn_user_prompt(short_id), "[Decision {short_id}] {title_display} submit decision", "submit_deadline_warn")` | — |
| `evaluator_selected`, `reveal_started`, `vote_committed`, `vote_revealed`, `round_failed`, `vote_commit_deadline_warn`, `vote_reveal_deadline_warn` | `[System notification] {event} (evaluation-internal event; handled by the evaluator)⏎[Role] ASP (Agent Service ASP)⏎⏎[Recommendation] Observe silently. After the \`dispute_resolved\` notification arrives, call next-action to wrap up.⏎` | — |
| `user_attachment_received` | `user_attachment_received_cli` (below) | spawns `okx-a2a file download`; moves the file |
| `staked`, `unstake_requested`, `unstake_claimed`, `unstake_cancelled`, `stake_stopped`, `cooldown_entered` | `[System notification] {event} (evaluator staking lifecycle tx receipt; not the ASP's concern)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn.⏎` | — |
| `reward_claimed` | :1255–1266 (`reward_claim_failed_user_notify`, `reward_claimed_user_notify` inlined in `--content "…"`) | — |
| `job_auto_refunded` | `[System notification] job_auto_refunded (buyer/backend Refund V2 settlement receipt; not the ASP's concern)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn.⏎` | — |
| `wakeup_notify` | :1277–1290 | — |
| `negotiate_reply` | `[System notification] negotiate_reply (User Agent-side negotiation relay event; not the ASP's concern)⏎[Recommendation] Ignore; no action needed.⏎` | — |
| `attachment_added`, `deliverable_received` | `[System notification] User Agent-side event; not the ASP's concern.⏎[Recommendation] Ignore; no action needed.⏎` | — |
| other `user_decision_{source}` | `reply = data.trim()`; source `submit_deadline_warn` → :1312–1316; `cli_failed` → :1319–1325; else `[User decision relay] source_event=\`{source}\` (no specific routing rule defined for this scene), user's verbatim reply: \`{reply}\`⏎` | — |
| `job_provider_reject` | `[System notification] job_provider_reject (your decline was registered; no further action).⏎{terminal_session_hint}⏎` | — |
| `job_user_reject` | :1343–1352 (`job_user_reject_notify`, `L10N_DISPATCH_SHORT`, hint) | — |
| `sub_asp_selected` | `sub_asp_accepted_start("sub_asp_selected (subscription acceptance confirmed)", content, inline_task_fields([title,description,serviceParams,buyerAgentId,serviceId]), job, agent)` (:1588–1600); content = trial (`message.trialType` i64 == 1) → `sub_asp_selected_trial_asp_notify(title, buyer, job, amt, sym, trialStartTime|trailStartTime, trialEndTime|trailEndTime)` else `sub_asp_selected_asp_notify(…, subStartTime, subEndTime)`; title = msg `jobTitle`|`title`|prefetched title; buyer = msg `buyerAgentId`|prefetched; amt = msg `tokenAmount`|prefetched; sym = msg `tokenSymbol`|prefetched (≠`?`); epochs are integers only | — |
| `sub_complete_notify` | `v2::sub_complete_notify::handle(job, msg.jobTitle (non-empty) | prefetched title, msg.subEndTime i64)` JSON | — |
| `sub_close_notify` | `display_notify("sub_close_notify (subscription closed)", sub_close_notify_asp_notify(title, job, aspRejectReason), Some(terminal_session_hint))`; title = `message.jobTitle` if the key exists else `message.title` (first present key; must be a non-empty string) | — |
| `sub_failed_notify` | `display_notify("sub_failed_notify (result cause unverified)", "[Subscription Result Needs Reconciliation] {prefetched title trimmed | \"Subscription title unavailable\"} (\`{job}\`) is in fresh Failed(9) status, but the authoritative backend detail does not expose whether this was a refund or a charge/conversion failure. The caller-provided \`sub_failed_notify\` title and reason fields are not trusted result evidence. Do not report either outcome, take a settlement action, or close the ASP session from this event. Wait for an authoritative lifecycle result or inspect the latest subscription status read-only.", None)` | — |
| `sub_asp_dispute` | :1466–1507 (`inline_task_fields([buyerAgentId])`, `--max-files 20`) | — |
| `sub_renew` | :1518–1526 (`subscribe-asp-claim` instructions; `{{subId}}` renders `{subId}`) | — |
| `sub_created`, `sub_cancel`, `sub_trial_into_active`, `sub_expire_warn`, `sub_reject_refund_notify`, `sub_asp_agree` | `[System notification] {event} (obsolete or not handled on the ASP side in this slice)⏎[Role] ASP (Agent Service ASP)⏎⏎Silently ignore; end this turn.⏎` | — |
| anything else | `[Unknown state] {raw}⏎` | — |

`display_notify(header, content, hint?)` (:1561) = `[System notification] {header}⏎[Role] ASP (Agent Service ASP)⏎⏎**Notify the user, then end the turn** (🌐 **Localize first** — rewrite the content below in the user's language before sending; do NOT pass the English template verbatim to a non-English user. If the content still contains \`<...>\` placeholders such as \`<title>\`, fill them from the task context — \`onchainos agent common context\` — before sending; never send a literal placeholder):⏎```bash⏎onchainos agent user-notify --content "<localized content shown below>"⏎```⏎content:⏎{content}⏎` + (`⏎{hint}⏎` when present).

`provider_assignment_playbook(type, …)` (:83) — `event_name` `job_asp_selected`/`sub_open`; accept command `accept-job-by-provider`/`accept-subscription`
(bizType 203/205); decline command `decline-job-by-provider`/`decline-subscription`; `task_type` `single`/`subscription`:
1. No prefetch → `[Current state] {event_name}⏎[Role] ASP⏎⏎Latest task detail could not be fetched. Stop with an error; do NOT accept, decline, or send task_params_request.⏎jobId={job}⏎`.
2. prefetched status 1 → `…⏎⏎Latest backend status is ACCEPTED/ACTIVE. This is a duplicate trigger: end idempotently.⏎Do NOT repeat the mutation or broadcast. jobId={job}⏎`;
   other n → `…⏎⏎Latest backend status is {n}, not CREATED(0). End idempotently; do NOT mutate or broadcast.⏎jobId={job}⏎`;
   none → `…⏎⏎Latest backend detail has no status. Stop with an error; do NOT accept or decline.⏎jobId={job}⏎` (all prefixed `[Current state] {event_name}⏎[Role] ASP`).
3. serviceId = `message.serviceId` (non-empty string) else prefetched `serviceId`; empty → ``…⏎⏎No serviceId is present. Run the v2 decline command (reason is required, ≤512 Unicode characters):⏎```bash⏎onchainos agent {decline} {job} --agent-id {agent} --reason "designated serviceId is missing"⏎```⏎``.
4. `find_service(agent, serviceId)` (spawn `onchainos agent service-list --agent-id {agent} --page 1 --page-size 100 --service-id {sid}`):
   None → ``…⏎⏎`onchainos agent service-list --agent-id {agent} --service-id {sid}` completed but returned no matching service.⏎Run exactly:⏎```bash⏎onchainos agent {decline} {job} --agent-id {agent} --reason "designated service is not registered"⏎```⏎``;
   Err → `…⏎⏎Service lookup failed: {e:#}⏎Stop with an error. Do NOT decline: a timeout, malformed response, or temporary service-list failure is not a capability rejection.⏎jobId={job}⏎`.
5. Main text flow.rs:210–227 with `PROVIDER_ASSIGNMENT_OWNERSHIP_RULE` (:17), evaluation inputs (:65–79; single shows `serviceParams: {prefetched.serviceParams or "{}"}`),
   decision rule / missing-input rule (:25–53; single includes `task_params_request_command(job, buyer or "<buyerAgentId>", "single")` and the buyer-side
   `service-param-update` / `okx-a2a session send` block with literal `\n` and `\"` sequences), `serviceName`/`serviceDescription` from the service entry (`""` if absent).

`user_attachment_received_cli(job, agent, short, msg)` (:1603): requires non-empty string `fileKey, digest, salt, nonce, secret` in `message`
(missing → ERROR text listing `missing: a, b` in that order, :1651–1660); `okx_a2a::file_download(…, filename?)` (error → stderr
`[user_attachment_received_cli] download failed: {e}` + ERROR text :1669–1677); then move the file into `attachments_dir(job)` using `dedup_dest`
(rename, else copy+delete; any failure → stderr `[user_attachment_received_cli] save-to-job-dir failed: {e}` and keep the downloaded path);
output :1707–1717 with `Canonical content:⏎  {user_attachment_received_user_notify(job)}`.

Unreachable arms in 4.6.3 (shadowed by earlier arms; do not affect output): the second-pass `job_rejected` (:795–825, which would use
`job_rejected_user_decision_prompt`), `agree_refund` text (:856–866), and `sub_user_reject` (:873–927).

Test-oracle caveat: `flow.rs` tests at 1956–2102 assert copy such as `[Assignment Expired]`, `[Refund Result Unverified]`,
`[Refund Response Expired]` that the current `content.rs`/`v2/notification.rs` never produce; the implementation (and the `content.rs`
tests) are authoritative — see Open questions.

Parity (via `next-action`, all SAFE — no fund movement): `agent next-action --agentId 864 --role asp --message '{"event":"agree_refund","jobId":"0x<64 a>"}'`
(no HTTP; blocked JSON); `--message '{"event":"wakeup_notify","jobId":"0x<64>"}'` (no HTTP); `--message '{"event":"dispute_approved","jobId":"0x<64>"}'`
(freshness GET then text); `--message '{"event":"user_decision_job_rejected","jobId":"0x<64>","decisionId":"0x<64>:job_rejected:e1","selectedActionId":"raise_arbitration","params":{"reason":"ok"}}'`.

#### `evaluator::flow::generate_next_action` (`evaluator/flow.rs:6`)
Match on the raw event string (no normalisation). Order: staking events, dispute events, else
`[unknown event={event} at jobId={job} ignored.⏎Do not pull context; do not guess other notifications.⏎` (unbalanced `[` verbatim).
- `staked` → `[Current Event] staked⏎⏎` + `notify_block(c)`; c = (GET myStake OK) `Your stake is now active on-chain. Current activeStake is {activeStake} OKB.` else `Your stake is now active on-chain.`
- `unstake_requested` → `[Current Event] unstake_requested⏎⏎` + notify_block of: myStake OK with `fmt_local_time(unstakeAvailableAt)` →
  `The unstake request has been recorded on-chain. Current cumulative pending unstake is {pendingUnstake} OKB; the last claimable time is {local}. You can cancel the unstake mid-way.`;
  myStake OK without time → `The unstake request has been recorded on-chain. Current cumulative pending unstake is {pendingUnstake} OKB. You can cancel the unstake before the cooldown ends.`;
  no myStake → `The unstake request has been recorded on-chain. You can cancel the unstake before the cooldown ends.`
- `unstake_claimed` → `[Current Status] unstake_claimed⏎⏎` + notify_block(`Your unstake has been claimed; OKB has been credited to your wallet.`)
- `unstake_cancelled` → `[Current Status] unstake_cancelled⏎⏎` + notify_block(`Your unstake has been cancelled; the pending OKB is back in staked state.`)
- `stake_stopped` → `[Current Status] stake_stopped⏎⏎` + notify_block(`You have exited the voter pool and will no longer be selected as a juror.`)
- `evaluator_selected`: fields `jobTitle` (default `""`), `agentName`, `budget` (display), `tokenSymbol`, `commitDeadline` (i64), `roundNum` (i64).
  lines: `【Your Agent {agentName} has been selected as juror for task [{title}]】` or `You have been selected as juror for task [{title}]`;
  `Task title: {title}`; `Task ID: #{job}`; (`Task Amount: {budget} {symbol}` when both); (deadline in future: `⏰ Key deadline`, `Your Agent must vote within {hours_left_text}`).
  Output `[Current Status] evaluator_selected⏎⏎**Step 1 — Notify the user that you've been selected as a juror:**⏎⏎{notify_block_lines}⏎→ **Once Step 1 has attempted the \`onchainos agent user-notify\` call (whether it succeeds or errors), continue with Step 2 in this same turn.** Step 1 is a user-facing notification, not a precondition for Step 2.⏎⏎{step2}`;
  step2 with roundNum = flow.rs:239–248 (`onchainos agent evidence-info {job} --agent-id {agent} --round-num {n}` …); without =
  `**Step 2 aborted** — message envelope is missing \`roundNum\`; cannot fetch evidence. End this turn and wait for a fresh notification.⏎`.
- `vote_committed`: lines `【Evaluation vote committed for task [{title}] · waiting for Reveal】`, `Task title: {title}`, `Task ID: #{job}`,
  (`🗳️ Your Agent supports: {User if vote==0 else ASP}`) → `[Current Status] vote_committed⏎⏎{notify_block_lines}`.
- `vote_commit_deadline_warn` / `vote_reveal_deadline_warn`: lines `【⏰ URGENT: Evaluation vote|reveal for task [{title}] is about to close】`, `Task title: …`, `Task ID: #…`,
  (`Commit deadline: {local} ({minutes_left_text})` / `Reveal deadline: …` when `commitDeadline`/`revealDeadline` is in the future),
  `Current Status: Agent has not committed yet` / `…revealed yet`, `🚨 Timeout consequences:`, (`• Stake slashed {slashTimeoutBps}`),
  (`• Enter a {slashedCooldownSeconds/3600}h cooldown during which you cannot be selected`), `• Miss the base validation fee`,
  `⚡ Have the Agent vote immediately` / `⚡ Have the Agent reveal immediately` → `[Current Status] {event}⏎⏎{notify_block_lines}`.
- `reveal_started` → flow.rs:353–366 (`onchainos agent vote-reveal {job} --agent-id {agent}`, error mapping) + notify_block(`Your agent has submitted the reveal transaction for Job jobId={job}. Waiting for chain confirmation — no action needed from you.`).
- `vote_revealed` → `[Current Status] vote_revealed⏎⏎` + notify_block(`Your agent has revealed its vote on-chain for Job jobId={job}. Waiting for the evaluation result — no action needed from you.`).
- `dispute_resolved`: `hasCommit`/`hasReveal` (i64, default 1); branch MissedCommit (hasCommit 0) / MissedReveal (hasReveal 0) / Won (vote label
  == winner: `jobStatus` `complete`→`ASP`, `failed`→`User`) / Lost (else, incl. missing). Missed: lines `【⚖️ Your Agent {name} missed [{Commit|Reveal}] for task [{title}] evaluation — penalty incoming】`
  (or `⚖️ You missed [{phase}] for task [{title}] evaluation — penalty incoming`), `Task title`, `Task ID: #{job}`, `You did not participate in [{phase}]`,
  (`🚫 Penalty applied`, `• Stake slashed {slashTimeoutBps}`) → `[Current Status] dispute_resolved⏎⏎{nbl}⏎Missed-{commit|reveal} branch ends this turn; do not call \`arbitration-claim\`.⏎{terminal_session_hint}`.
  Won: lines `【🎉 Evaluation result for task [{title}]: your vote aligned with the majority — reward eligible】`, title, id, (`Your vote: backed {y} ✓ aligned with majority`) →
  flow.rs:441–454 (arbitration-claimable → `hasClaimable` marker → arbitration-claim). Lost: lines `【⚠️ Evaluation result for task [{title}]: your vote disagreed with the majority — slash penalty incoming】`,
  title, id, (`Your vote: backed {y} ✗ opposed majority`), (`🚫 Penalty applied`, `• Stake slashed {slashMinorityBps}`) →
  `[Current Status] dispute_resolved⏎⏎{nbl}⏎Lost branch ends this turn; do not call \`arbitration-claim\` (nothing to claim). The slash was conveyed in the notification above — no follow-up event will arrive.⏎{terminal_session_hint}`.
- `cooldown_entered` → `[Current Status] cooldown_entered⏎⏎` + notify_block(`You've entered the absence cooldown period; you won't be selected as a juror before {local cooldownEndsAt}.` | `You've entered the absence cooldown period and won't be selected as a juror during this period.`) (GET myStake).
- `round_failed`: Missed branches as in dispute_resolved (header `[Current Status] round_failed`, trailer `Missed-{phase} branch ends this turn.`); Invalidated:
  lines `【⚖️ Task [{title}] evaluation round invalidated】`, title, id, `Tally: no side reached ≥ 50%`, (when `abstainCount`,`totalSlashed`,`slashTimeoutBps`,`revealCount` all present:
  `💰 Abstain-slash pool distribution`, `• Source: {a} abstainers × {b} = {t} OKB total`, `• Split evenly among {r} revealers`) →
  `[Current Status] round_failed⏎⏎{nbl}⏎{terminal_session_hint}`.
- `reward_claimed` → `[Current Status] reward_claimed⏎⏎{notify_block("Your evaluation reward has been credited.")}⏎{terminal_session_hint}`.
- HTTP: only `staked`, `unstake_requested`, `cooldown_entered` call identity `GET /priapi/v1/aieco/task/staking/myStake` (new client, header = raw `--agentId`; errors → fallback copy).
- Nondeterminism: `hours_left_text` / `minutes_left_text` (wall clock), local TZ.
- Parity (SAFE, no HTTP): `agent next-action --agentId 9 --role evaluator --message '{"event":"vote_revealed","jobId":"0x<64>"}'`;
  `--message '{"event":"evaluator_selected","jobId":"0x<64>","jobTitle":"T","roundNum":1}'`; `--message '{"event":"dispute_resolved","jobId":"0x<64>","hasCommit":0}'`
  (note: `dispute_resolved` is not freshness-exempt → one task-detail GET); `--message '{"event":"reward_claimed"}'` (jobId may be omitted).

---

## Endpoint classification

| Method | Path | Class | Used by |
|---|---|---|---|
| GET | `/priapi/v1/aieco/task/{jobId}` | read | deliver, dispute raise, asp status, provider decisions (task), next-action asp `job_completed` |
| GET | `/priapi/v1/aieco/task/subscribe/{jobId}` | read | deliver, asp status, provider decisions (subscription), subscribe-dispute |
| GET | `/priapi/v1/aieco/task/subscribe/my` | read | subscribe-active |
| GET | `/priapi/v1/aieco/task/subscribe/my?page=&pageSize=&statusType=0[&statusList=]` | read | asp list-tasks |
| GET | `/priapi/v1/aieco/task/my?page=&page_size=20[&status=]` | read | asp list-tasks |
| GET | `/priapi/v1/aieco/task/dispute/my?page=&pageSize=` | read | asp list-tasks --status disputed |
| GET | `/priapi/v1/aieco/task/{jobId}/dispute/status` | read | evidence-info, asp status, asp list-tasks --status disputed |
| GET | `/priapi/v1/aieco/task/{jobId}/evidence` | read | evidence-info |
| GET | `/priapi/v1/aieco/task/{jobId}/evidence/download?fileKey=` | read | evidence-info |
| GET | `/priapi/v1/aieco/task/{jobId}/vote/canReveal` | read | vote-reveal |
| GET | `/priapi/v1/aieco/task/claimable` | read | asp-claimable, arbitration-claimable |
| GET | `/priapi/v1/aieco/task/staking/config` | read | staking-config, stake, increase-stake, request-unstake |
| GET | `/priapi/v1/aieco/task/staking/myStake` | read | my-stake, stake, increase-stake, request/claim/cancel-unstake, next-action evaluator |
| POST | `/priapi/v1/aieco/task/{jobId}/apply` | state | apply |
| POST | `/priapi/v1/aieco/task/{jobId}/submit` | state | deliver (one-time) |
| POST | `/priapi/v1/aieco/task/{jobId}/agreeRefund` | state | agree-refund |
| POST | `/priapi/v1/aieco/task/{jobId}/asp/reject` | state | asp-reject |
| POST | `/priapi/v1/aieco/task/{jobId}/acceptJobByProvider` | state | accept-job-by-provider |
| POST | `/priapi/v1/aieco/task/{jobId}/declineJobByProvider` | state | decline-job-by-provider |
| POST | `/priapi/v1/aieco/task/subscribe/{jobId}/acceptSubscription` | state | accept-subscription |
| POST | `/priapi/v1/aieco/task/subscribe/{jobId}/declineSubscription` | state | decline-subscription |
| POST | `/priapi/v1/aieco/task/subscribe/{jobId}/agreeRefund` | state | subscribe-agree-refund |
| POST | `/priapi/v1/aieco/task/subscribe/{jobId}/aspClaim` | state | subscribe-asp-claim |
| POST | `/priapi/v1/aieco/task/{jobId}/dispute/approveAndCreateDispute` | state | dispute raise, subscribe-dispute |
| POST | `/priapi/v1/aieco/task/{jobId}/claimAutoComplete` | state | claim-auto-complete |
| POST | `/priapi/v1/aieco/task/claim` | state | asp-claim-rewards, arbitration-claim |
| POST | `/priapi/v1/aieco/task/{jobId}/vote/commit` | state | vote-commit |
| POST | `/priapi/v1/aieco/task/{jobId}/vote/reveal` | state | vote-reveal |
| POST | `/priapi/v1/aieco/task/staking/stake` | state | stake / increase-stake (unregistered) |
| POST | `/priapi/v1/aieco/task/staking/increaseStake` | state | stake / increase-stake (registered) |
| POST | `/priapi/v1/aieco/task/staking/requestUnstake` | state | request-unstake |
| POST | `/priapi/v1/aieco/task/staking/claimUnstake` | state | claim-unstake |
| POST | `/priapi/v1/aieco/task/staking/cancelUnstake` | state | cancel-unstake |
| POST | `/priapi/v1/aieco/task/broadcast` | funds | every sign-and-broadcast command above |
| POST | `/priapi/v1/aieco/task/{jobId}/evidence/upload` | state | dispute upload (g12) |
| POST | `/priapi/v5/wallet/agentic/auth/refresh` | auth | every command (core token refresh) |
| GET | `/priapi/v5/wallet/agentic/agent/batch-list` | read | self-subprocess `agent get-agents` (wallet resolution) |
| GET | `/priapi/v5/wallet/agentic/agent/agent-list` | read | self-subprocess `agent get-my-agents` (asp status/list-tasks without --agent-id) |
| GET | `/priapi/v5/wallet/agentic/agent/services` | read | self-subprocess `agent service-list` (next-action asp job_asp_selected/sub_open) |
| GET | `/priapi/v5/wallet/agentic/agent/task-feedback` | read | self-subprocess `agent task-feedback` (next-action asp job_completed) |
| GET | `/api/v6/dex/balance/all-token-balances-by-address` | read | self-subprocess `portfolio all-balances` (dispute raise bond precheck) |

The prepare endpoints are classed `state` because the funds only move when the returned `uopData` is signed and posted to
`/task/broadcast`; the combined `approveAndCreateDispute` transaction approves the evaluation bond token spend.

## External hosts / processes

- No HTTP host other than the OKX base URL (`https://web3.okx.com`, or `https://beta.okex.org` with `--dev`) is contacted directly by this
  partition. DoH resolution/failover is performed by the core `WalletApiClient` (owned elsewhere); `evidence/download` bypasses DoH.
- External binary `okx-a2a` (npm `@okxweb3/a2a-node`): `xmtp-send`, `file upload` (deliver), `session send` (dispute raise, subscribe-dispute),
  `--version` / `doctor --json` / `agent refresh --json` (stake), `file download` (next-action asp `user_attachment_received`).
- Self-subprocess `onchainos` (current exe): `agent get-agents`, `agent get-my-agents`, `agent service-list`, `agent task-feedback`,
  `portfolio all-balances --address … --chains 196`.
- Local files: OS temp dir (`deliverable_{jobId}.md`, `deliverable_{ts}.txt`), `$ONCHAINOS_HOME/deliverables/asp/…`,
  `$ONCHAINOS_HOME/task/{jobId}/dispute/{agentId}/…` (evidence), `$ONCHAINOS_HOME/task/{jobId}/attachments/…`, `$ONCHAINOS_HOME/audit.jsonl`.

## Notes for the lite re-implementation (from the relayed user request)

- Login state need not be carried over, but every command here depends on the onchainos login artefacts: a JWT access/refresh token
  pair (refreshed through `POST /priapi/v5/wallet/agentic/auth/refresh`), `session.json` (`sessionCert`, `encryptedSessionSk`,
  `sessionKeyExpireAt`), the keyring `session_key` (to HPKE-decrypt the Ed25519 session seed that signs broadcast hashes), and the wallets
  store (account ↔ X Layer address). A lite skill that supports "the same login flow as onchainos" must produce these same artefacts
  (flow owned by the auth/wallet groups, g02/g06) so the provider/evaluator sign-and-broadcast path works unchanged.
- Read-only commands in this group (`asp status`, `asp list-tasks`, `subscribe-active`, `asp-claimable`, `arbitration-claimable`,
  `staking-config`, `my-stake`, `evidence-info`) need only the JWT (+ `sessionCert` query) and the `agenticId` header.

## Open questions

1. `asp/flow.rs` tests (lines 1956–2102) expect copy (`[Assignment Expired] You did not accept …`, `[Refund Result Unverified]`,
   `[Refund Response Expired]`, `No client-side claim is required`, `Job status: Failed (9)`) that the current `content.rs` /
   `v2/notification.rs` never emit, while `content.rs` tests assert the emitted copy. The spec follows the implementation; the flow tests
   appear stale (would fail) — confirm which copy the backend/product expects.
2. `agent apply --token-amount` help says "must be > 0 … 0 = apply for free … CLI rejects", but the code accepts `0` (and `inf`).
3. `stake` and `increase-stake` both route by `myStake.registered`; the command name only affects the printed label. Intentional?
4. `stake`/`increase-stake` amount validation accepts `.` or `1.2.3`; the decimal threshold check is then skipped silently and the raw
   string is POSTed.
5. `accept/decline-*` with fresh status 1 print `already_accepted` even for the decline commands (no error).
6. `deliver --file` moves the caller's source file into the deliverables directory (via `handle_save`); the long-text `.md` temp file name
   `deliverable_{jobId}.md` is shared across runs.
7. `evidence-info`, `staking-config`, `my-stake`, `arbitration-claimable` and the evaluator next-action myStake reads send `agenticId`
   exactly as given (untrimmed, possibly empty); `evidence-info` joins the raw jobId/agentId into a local path without validation.
8. `evidence-info`'s playbook text says downloads are retried 3 times, but `get_bytes_with_identity` performs a single attempt.
9. `format_fractional_unit` uses Rust `{:.2}`/`{:.4}` float formatting; JS `toFixed` rounding differs on exact binary ties — a port should
   round on the exact binary value (ties are practically unreachable for `seconds/3600`).
10. base64 0.22 `DecodeError` Display strings (`Invalid symbol {b}, offset {i}.`, `Invalid input length: {n}`, `Invalid last symbol …`,
    `Invalid padding`) were not re-verified against the vendored crate source; confirm before asserting byte parity on `dispute confirm
    --reason-b64` errors.
11. `asp list-tasks` sends the one-time and subscription requests concurrently; a parity harness comparing HTTP traffic order must
    normalise ordering. The one-time path also inherits the double-`?` `sessionCert` quirk (g12 OQ1).
12. The relayed request mentions supporting "the muse"; its meaning for this partition is unclear (no code references) — needs product input.
13. On Windows, `okx-a2a session send` / `xmtp-send` / `file upload` / `file download` are spawned with `Command::new("okx-a2a")` (no `cmd /C`
    shim), so an npm-installed `okx-a2a.cmd` is not found there (`spawn failed: …` / `session send failed: …`), while the readiness probe
    (`stake`) does use the shim. A Node port resolving the shim would diverge from upstream error behaviour on Windows — decide which to mirror.
14. `dispute raise` computes the 5 % bond with f64 (`amount * 0.05`), so the printed `required` can carry binary artefacts
    (e.g. `0.1` → `0.005000000000000001`); a JS port reproduces this naturally only if it also uses IEEE-754 doubles and shortest
    round-trip formatting (JS `String(x)` matches Rust `{}` for finite doubles except exponent notation thresholds — Rust never uses
    exponent notation for `{}`, JS does below 1e-6 / ≥ 1e21).
15. `asp status` on a Completed(6)/Failed(9) task silently switches to the arbitration-enriched shape whenever `dispute/status` succeeds,
    even when the task never had an evaluation (depends on the backend returning an error or not for undisputed jobs).
