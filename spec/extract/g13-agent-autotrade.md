# g13-agent-autotrade — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: the subscription auto-copy-trade ("autotrade") subsystem under
`commands/agent_commerce/task/common/autotrade/` and every `onchainos agent autotrade-*` command (visible and
hidden), plus the two visible commands whose behaviour is implemented almost entirely by this partition:
`agent trade-kit-readiness` and `agent subscription-execution-config-set` (the latter's handler lives in
`task/user/mod.rs`, but its storage/validation is `autotrade/subscription_config.rs`).

This partition is ~95 % **local-state** code: it reads/writes files under `ONCHAINOS_HOME/autotrade/…` and shells
out to two external local programs (`okx-a2a`, `okx`). It performs exactly **one** direct HTTP call
(`GET /priapi/v1/aieco/task/subscribe/{jobId}`) and triggers two more indirectly by spawning the onchainos binary
itself (`agent service-list`, `agent get-my-agents`). **No endpoint in this partition moves funds.** The one
funds-adjacent command (`autotrade-direct-claim`) is an idempotency/authorization latch taken immediately before an
*external*, model-selected tool performs the money-moving call; onchainos itself never executes that call.

---

## Sources read

Partition files — all read fully, including `#[cfg(test)]` modules (used below as oracles):

| File (under `cli/src/commands/agent_commerce/task/common/autotrade/`) | Lines |
|---|---|
| `mod.rs` | 196 |
| `amount.rs` | 300 |
| `card.rs` | 1361 |
| `consent.rs` | 3000 |
| `consent_reply.rs` | 620 |
| `continuation.rs` | 2164 |
| `delivery_queue.rs` | 952 |
| `executor.rs` | 3648 |
| `grants.rs` | 527 |
| `guide.rs` | 706 |
| `notify.rs` | 766 |
| `profile.rs` | 362 |
| `schema.rs` | 663 |
| `subscription.rs` | 157 |
| `subscription_config.rs` | 192 |
| `tooling.rs` | 1987 |
| `trade_kit.rs` | 1073 |
| **total** | **18674** |

Supporting files consulted (only the parts the partition calls into / the command wiring; behaviour owned
elsewhere is only named): `commands/agent_commerce/mod.rs` (clap defs 640-940, dispatch 1403-1418 and 1990-2580,
dead `#[cfg(any())]` blocks 3134-3150 and 3410-3460), `commands/agent_commerce/task/user/mod.rs` (370-440,
1820-1840, 2085-2100), `task/user/create.rs` (236-250), `task/common/mod.rs` (55, 400-445, 512-525, 572-574,
659-756), `task/common/okx_a2a.rs` (1-120, 340-860), `task/common/user_lang.rs` (20-127),
`task/common/network/task_api_client.rs` (48-218), `task/common/config.rs` (35-57),
`task/common/subscription_identity.rs` (9-20), `task/common/pending_v2.rs` (942-964, 1765-1780 grep),
`identity/queries.rs` (85-110, 380-410), `main.rs` (40-52, 163-316), `output.rs` (1-160), `home.rs` (12-19, 85-102,
259-285), `audit.rs` (1-13, 140-170, 540-560), `asset_class.rs` (1-60), `endpoints.rs` (24-45),
`wallet_api.rs` (1256-1315), `commands/upgrade.rs` (77-82), `Cargo.toml`, `Cargo.lock` (serde_json entry),
`spec/cli-tree.json` (the 5 visible nodes below).

---

## Shared helpers (used across groups or from core)

### 0. Cross-cutting facts that affect byte-parity

1. **JSON key order.** `serde_json 1.0.149` is built without `preserve_order` (no `indexmap` dep in Cargo.lock), so
   every `serde_json::Value` / `json!{}` object serialises with keys **sorted byte-wise ascending at every level**.
   Structs serialised directly (`#[derive(Serialize)]` passed to `output::success`) keep **field declaration order**.
   A struct embedded inside a `json!{…}` literal is first converted to `Value` → its keys become **sorted** (matters
   for `autotrade-consent-request`, whose `outcome` is sorted while `autotrade-delivery-report`'s identical object
   is in struct order).
2. **Envelope** (`output::success`, output.rs:44, core): stdout one line `{"ok":true,"data":<data>}` (+
   `"notifications":[…]` only when core payment events are queued — never by this partition). Compact unless env
   `ONCHAINOS_PRETTY=1`. `output::success_empty` prints `{"ok":true}`.
3. **Errors** (main.rs:248-315, core): any `Err` → stdout `{"ok":false,"error":"<{e:#}>"}` exit **1**; `{e:#}` is the
   anyhow chain joined with `": "` (outermost context first). Exception: `CliBespokeExit(code)` (mod.rs:188) → the
   handler has already printed its own JSON; process exits with `code` and prints nothing else
   (`autotrade-grant-check` only). clap usage errors (missing required flag, unknown subcommand) → clap's stderr text,
   exit **2** (core).
4. **Audit.** Every command appends one JSONL line to `ONCHAINOS_HOME/audit.jsonl` (core `audit::log`, main.rs:239)
   with the command name from `audit.rs:543-556` (e.g. `"autotrade-grant-check"`), `ok`, duration, redacted args,
   error text. Not part of stdout.
5. **Global flags** (core): `--chain` (visible, forced to `"xlayer"` for every `agent` command and otherwise ignored
   here) and hidden `--dev` (switches `endpoints::base_url()` to the dev origin).
6. **OS error strings leak into messages.** Several errors wrap `std::io::Error` (e.g. missing files). Rust renders
   these as `No such file or directory (os error 2)` on Unix and `The system cannot find the file specified. (os error
   2)` / `The system cannot find the path specified. (os error 3)` on Windows (os error 3 when the parent directory is
   absent). A parity harness must normalise or reproduce per-platform text.
7. **Time.** All `*At`/`*_at` second fields are Unix seconds (`SystemTime::now().as_secs()`); `*Ms` fields are Unix ms.
   `checkedAt` (trade-kit-readiness) is `chrono::Utc::now().to_rfc3339_opts(Millis, true)` → `YYYY-MM-DDTHH:MM:SS.mmmZ`.
8. **Hashes.** `sha256hex(x)` below = lowercase hex of SHA-256 over the UTF-8 bytes of `x`; `\0` means a NUL byte.

### 1. `fn agent_commerce::run` pre-dispatch maintenance (commands/agent_commerce/mod.rs:1403-1418)

Runs at the start of **every** `onchainos agent …` invocation (including the recursive
`onchainos agent service-list` / `get-my-agents` subprocesses spawned by helpers below), before the command handler,
all results ignored (`let _ =`), no stdout:

1. `executor::reconcile_terminal_journals(max_records=4, budget=100 ms)` (§6.12)
2. `executor::flush_all_due(max_records=1)` (§6.14)
3. `executor::cleanup_expired_tickets(limit=8)` (§6.15)
4. `delivery_queue::flush_due(limit=1, budget=100 ms)` (§7.10)

With an empty `ONCHAINOS_HOME/autotrade` these are pure directory-existence checks (no writes, no subprocesses).
When state exists they may spawn `okx-a2a` (notifications / session resume) and rewrite local files. A Node port must
run the same four steps in the same order before every `agent` command to be behaviour-identical.

### 2. Local paths & I/O primitives (core, named only)

- `crate::home::onchainos_home()` (home.rs:12) — `$ONCHAINOS_HOME` if set and non-empty, else `~/.onchainos`.
  Below, `A` = `<onchainos_home>/autotrade`.
- `crate::home::write_secure(path, bytes)` (home.rs:259) — `mkdir -p parent` (chmod 0700 on Unix), write
  `parent/.<fname>.<pid>.tmp` (mode 0600, truncate), then `rename` over `path` (atomic replace).
- `crate::home::ensure_dir_0700` (home.rs:85) — `mkdir -p` + chmod 0700 (Unix).
- `job_id_is_safe(s)` (grants.rs:110) — non-empty and every char in `[A-Za-z0-9_-]`. Used as the path-traversal
  guard for every per-job file below.
- "pretty JSON" = `serde_json::to_vec_pretty` (2-space indent, `": "` separators, no trailing newline).

### 3. Local file inventory under `A = ONCHAINOS_HOME/autotrade` (owned by this partition)

| Path | Format | Writer(s) in release binary | Schema (field order as written) |
|---|---|---|---|
| `A/grants/<jobId>.json` | pretty JSON | none (legacy only; writers are dead/debug code) | `{version:1, jobId, grants:{<venue>:{maxBuy:str\|null, maxSell:str\|null}}, createdAt, expiresAt}`; `deny_unknown_fields` on file and venue objects |
| `A/guide/<jobId>.md` | markdown doc kind `guide` | `guide::write_guide` (create-subscribe flows, guide-prepare/direct-claim restore) | metadata `GuideFile{version:1, jobId, serviceId, providerAgentId?, sourceHash, createdAt}` (`deny_unknown_fields`); body = verbatim Guide text |
| `A/consent/<jobId>.md` | markdown doc kind `consent` | Guide Consent: guide-consent-new/update, create flows, migration | `GuideConsentFile{version:1, jobId, guideHash, lifecycle:"prepared"\|"active"\|"aborted", values:{…}, createdAt, expiresAt}` (`deny_unknown_fields`); body `# Service Consent\n\nValues in this document are defined exclusively by the matching Service Guide.\n` |
| `A/consent/<jobId>.md` (legacy variant) / `A/consent/<jobId>.json` | markdown kind `consent` / raw JSON | none in release (legacy `ConsentFile`, v≤6) | `{version, jobId, mode:"auto"\|"manual"\|"decline", capU?, tradeAmountU?, quoteToken?, tradeEnvironment?, marginMode?, orderPolicy?, authMode?, guideHash?, lifecycle, <flattened dynamic settings>, createdAt, expiresAt}` |
| `A/subscription-config/<agentId>/<serviceId>.json` | pretty JSON | `subscription-execution-config-set`, guide migration, other create/flow code | `{version:1, agentId, serviceId, executionMode:"signal_only"\|"guide_direct"\|null, updatedAtMs}` |
| `A/delivery-context/<jobId>/<deliveryId>.json` | pretty JSON | flow_lifecycle (other group) | `DeliveryContext{version:2, jobId, agentId, providerAgentId, originSessionKey?, deliveryId, savedPath, deliverableType, receivedAtMs, executionPath:"agent_direct"\|"legacy_wrapper"}` (`deny_unknown_fields`; missing `executionPath` ⇒ `legacy_wrapper`) |
| `A/pending/<jobId>.json` | pretty JSON | pending_v2 / queue code (other groups) | same `DeliveryContext` object (the "delivery awaiting a user decision" pointer) |
| `A/delivery-queue/<jobId>.json` + `<jobId>.lock` | pretty JSON + empty lock file (flock) | delivery_queue | `{version:1, jobId, entries:[{deliveryId, state, enqueuedAtMs, nextResumeAttemptAt, resumeAttempts, resumeSentAt, processingStartedAt, processingAttempt, resumeProtocolVersion}]}`; `state` ∈ `processing\|awaiting_decision\|waiting\|resume_pending\|resume_sent`; file removed when `entries` is empty |
| `A/execution-latch/<jobId>/<deliveryId>` (no extension) | pretty JSON, created with O_EXCL (0600) | report-delivery, direct-claim | `{version:2, jobId, deliveryId, phase:"reserved"\|"prepared"\|"spawned", updatedAt, directAmount?, directExecutionMode?:"auto"\|"manual"\|"one_time"}` |
| `A/outcomes/<jobId>/<deliveryId>.json` | pretty JSON | executor | `ExecutionOutcome` (see §6.1) — permanent idempotency tombstone |
| `A/terminal-journal/<jobId>/<deliveryId>.json` | pretty JSON | executor | `{version:1, outcome:<ExecutionOutcome>}` — deleted once reconciliation completes |
| `A/pending-outcome-notifications/<sha256hex(jobId+"\0"+deliveryId)>.json` | pretty JSON | executor | `{version:1, jobId, deliveryId, nextAttemptAt}`; exists iff outcome `notificationPending` |
| `…/pending-outcome-notifications/<hash>.lease-<pid>` | same | executor (transient) | lease during flush |
| `A/notification-outbox/<jobId>/<sha256hex(idempotencyKey)>.json` (+`.lease-<pid>`) | pretty JSON | notify (degrade notices) | `{version:1, jobId, idempotencyKey, content, attempts, nextAttemptAt, createdAt, updatedAt}` |
| `A/one-time-permits/<jobId>/<deliveryId>.json` | pretty JSON, O_EXCL | `autotrade-once-authorize` | `{version:1, jobId, deliveryId, amount, createdAt, expiresAt}` (TTL 900 s) |
| `A/lang/<jobId>`, `A/lang/_default` | plain text `zh`/`en` | user_lang (other group) | read by `user_lang::resolve` |
| `A/profile/<jobId>.json` | **compact** JSON | task/user/mod.rs (other group) | `{version:3, jobId, serviceId, providerAgentId?, assetClasses[], explicitTools[], descriptionHash, serviceDescription?, venuePreferences?, modelRoutes?}` |
| `A/consent-continuation/<jobId>.json` | pretty JSON | none in release (only cfg'd-out code/tests) | `ConsentContinuation` v6 (read by task/user/mod.rs:1605) |
| `A/pending-config/<jobId>.json` | pretty JSON | none reachable (see §9) | draft `PendingConfig` v1 |
| `A/plugin-approved/<jobId>/<plugin>` | bytes `1` | none in release | marker |

**Markdown document container** (`guide::render_markdown`, guide.rs:159 / `parse_markdown_document`, :170):
render = `"<!-- onchainos-autotrade:" + kind + "\n" + prettyJSON(metadata) + "\n-->\n\n" + body`.
parse = strip exact prefix `"<!-- onchainos-autotrade:<kind>\n"` (else error `local autotrade document header is
invalid`); split at the first `"\n-->\n"` (else `local autotrade document metadata is invalid`); strip one leading
`"\n"` from the body; `serde_json::from_str(metadata)` (error context `local autotrade document metadata is invalid`
+ serde cause).

### 4. Small pure helpers

- **`amount::Decimal::parse(s)`** (amount.rs:44): `""` → Empty (`empty amount`); only chars `0-9` and at most one `.`;
  any other char (sign, exponent, space, 2nd dot) → Invalid (`invalid decimal string`); lone `.` → Invalid; digits
  concatenated parsed as u128 (overflow ≥ 40 nines → Overflow `amount arithmetic overflow`); normalised (strip
  trailing fractional zeros; zero → scale 0). Accepts `".5"`, `"1."`, `"007"`. `to_plain_string()` renders without
  trailing zeros/exponent (`1.50`→`1.5`, `.5`→`0.5`, `0.0`→`0`). `le()` exact compare. `pct_to_ratio(p)` = p/100.
  `pct_to_absolute(h,p)` = h·p/100 floored to 8 dp; `ratio_to_absolute(h,r)` = h·r floored to 8 dp.
  Oracles: `400.8×25%`→`100.2`; `1×33.333333333%`→`0.33333333`; `12.5%`→`0.125`.
- **`safe_text(v)`** (executor.rs:1493): collapse all whitespace runs to single spaces (trim ends); empty →
  `unspecified terminal reason`; if > 240 chars → first 240 chars + `…`.
- **`safe_child_text(v)`** (executor.rs:1232): control chars → space; split on whitespace; walk tokens with a
  `redact_next` counter: if `redact_next>0` emit `[REDACTED]` and decrement; else if token equals `bearer`
  (ASCII-case-insensitive) emit `Bearer` and set `redact_next=1`; else if `looks_like_jwt` emit `[REDACTED]`; else find
  the first `=` or `:` whose prefix `label` is a *sensitive label* → emit `label + sep + "[REDACTED]"` and, if nothing
  follows the separator, set `redact_next = 2` when label equals `authorization` (case-insensitive) else `1`; else if the
  token itself is a sensitive label emit it and set `redact_next=1`; else emit token. Join with spaces, then `safe_text`.
  *Sensitive label*: keep only ASCII alphanumerics, lowercase; true if equal to or ends with any of `apikey, secret,
  secretkey, passphrase, password, authorization, accesstoken, refreshtoken, token, cookie, signature, privatekey,
  mnemonic, seed`. `looks_like_jwt`: trim `" ' , ; ( ) [ ]` from both ends; length ≥ 40, exactly two `.`, all chars
  `[A-Za-z0-9._-]`.
- **`safe_metadata_token(v, max)`** (executor.rs:1507): 1..=max chars, each `[A-Za-z0-9-_.:/]`.
- **`short_id(s)`** (notify.rs:530): if > 16 chars → first 6 chars + `…` + last 4 chars, else unchanged.
- **`flatten_reason(s)`** (notify.rs:542): collapse whitespace; > 300 chars → first 300 + `…`.
- **Delivery-id charsets**: delivery-context/pending: 1..=96 bytes `[A-Za-z0-9_:-]` (`invalid delivery id`); executor
  (outcomes/latch/journal/permit): 1..=128 bytes `[A-Za-z0-9_:.-]` (`invalid job or delivery id`).

### 5. `okx-a2a` subprocess bridge (task/common/okx_a2a.rs, owned by the A2A group — exact argv reproduced because
this partition's observable behaviour depends on it)

All are blocking `std::process::Command` spawns of the external npm CLI `okx-a2a` (package `@okxweb3/a2a-node`);
stdout/stderr captured and discarded unless noted. Timed variants poll `try_wait` every 25 ms and kill the child on
deadline (`okx-a2a command timed out after {secs}s`, secs = integer seconds, so a 100 ms budget prints `0s`).

| fn | argv | spawn style | timeout |
|---|---|---|---|
| `user_notify_scoped[_with_timeout](content, job, key[, t])` | `okx-a2a user notify --content <c> --job-id <job> --idempotency-key <key> --json` | `Command::new("okx-a2a")` (**no** `cmd /C` on Windows ⇒ fails when only `okx-a2a.cmd` shim exists) | default 5 s |
| `session_send_with_timeout(job, to, content, t)` | `okx-a2a session send --job-id <job> --content <c> --json [--to-agent-id <to>]` | `Command::new` | t |
| `session_send_exact_with_timeout(key, content, msgId, t)` | `okx-a2a session send --session-key <key> --content <c> --message-id <msgId> --json` | `Command::new` | t |
| `trade_records_insert(json_array)` | `okx-a2a trade-records insert --input-json <compact JSON> --json` | `npm_cli_command` (Windows: `cmd /C okx-a2a …`, CREATE_NO_WINDOW) | 5 s |
| `mark_retired_autotrade_mode_decisions_handled(job)` | `okx-a2a user outdated-list` → parse JSON items (from `.items`, `.data[]`, or `.data.items`) with `jobId==job`, `kind=="decision_request"`, `status=="pending"`, and `llmContent` containing `--source-event "autotrade_consent"` or `"autotrade_config_required"` → `okx-a2a user check --todo-ids <id1,id2,…> --json` (skipped if none) | `npm_cli_command` | none |

`compose_user_notify_content` first replaces literal `\n` two-char sequences with real newlines and rejects content
containing `file://` or a markdown image (`![` + `](`). Non-zero exit → error `okx-a2a scoped user notify exit
{status}: {stderr}` etc. These are local IPC, not HTTP.

`pending_v2::push_decision_direct(job, role, agent, to, userContent, listLabel, sourceEvent)` (pending_v2.rs:942,
owned by the pending-decisions group) — pushes a user decision card via the okx-a2a decision queue; named only.

`user_lang::resolve(job)` (user_lang.rs:112): reads `A/lang/<job>` (only if `job` passes `[A-Za-z0-9_-]`) then
`A/lang/_default`; content trimmed `zh`→Zh, `en`→En; default **En**.

### 6. executor.rs (delivery outcome coordinator)

#### 6.1 `ExecutionOutcome` (executor.rs:137) — struct field order
`version`(1), `jobId`, `deliveryId`, `venue`, `action`, `amount`, `executionMode` (`auto`\|`manual`\|`one_time`,
default `auto`), `status` (`submitted`\|`failed_before_submit`\|`unknown_after_submit`\|`skipped`\|
`failed_before_execution`), `receipt` (omitted when None), `reason` (omitted when None), `failureCategory`
(`authentication_required`, omitted when None), `notificationPending`, `notificationAttempts`,
`nextNotificationAttemptAt`, `createdAt`, `updatedAt`. `read_outcome` rejects `version != 1`
(`unsupported automatic execution outcome version`).

#### 6.2 `write_outcome(path, o)` (executor.rs:472)
`write_secure(path, pretty(o))`, then `sync_notice_ref(o)`: if `o.notificationPending` write
`A/pending-outcome-notifications/<sha256hex(job+"\0"+delivery)>.json` = pretty `{version:1, jobId, deliveryId,
nextAttemptAt:o.nextNotificationAttemptAt}`, else delete that file. Index failure only prints stderr
`[autotrade] pending-notification index update failed: {error}`.

#### 6.3 `notification(o)` (executor.rs:1997) — user-visible text (lang = `user_lang::resolve(o.jobId)`)
`label` = `[Auto Copy-Trade]`/`[自动跟单]` for `auto`, `[Manual Copy-Trade]`/`[手动跟单]` otherwise.
`receipt` = first string-valued entry of `o.receipt` rendered `"{key}: {value}"` (BTreeMap order ⇒ alphabetical).
`authEn` = ` Reply “Connect Trade Kit” to start authorization. This trade will not be retried automatically after
authorization.` / `authZh` = ` 请回复“连接 Trade Kit”以启动授权；授权完成后，本次交易不会自动重试。` only when
`failureCategory == authentication_required`, else empty.

| status | En | Zh |
|---|---|---|
| submitted | `{label} Trade submitted. Venue: {venue}, action: {action}, amount: {amount}. {receipt or "Check the venue history for details"}` | `{label} 交易已提交。类型: {venue},方向: {action},金额: {amount}。{receipt or "可在对应交易记录中查看详情"}` |
| failed_before_submit | `{label} Trade execution failed; submission was not confirmed. Venue: {v}, action: {a}, amount: {m}. Reason: {reason or "execution command failed"}. No automatic retry will occur.{authEn}` | `{label} 交易执行失败，未确认提交。类型: {v},方向: {a},金额: {m}。原因: {reason or "执行命令失败"}。系统不会自动重试。{authZh}` |
| unknown_after_submit | `{label} Trade submission status is unknown. Venue: {v}, action: {a}, amount: {m}. Reason: {reason or "no verifiable transaction receipt was returned"}. Check order/transaction history first; no automatic retry will occur.` | `{label} 交易提交状态未知。类型: {v},方向: {a},金额: {m}。原因: {reason or "未获得可验证的交易回执"}。请先查询订单/交易记录，系统不会自动重试。` |
| skipped, reason=`guide_execution_unavailable` | `{label} The Signal was saved for receiving/display only: this subscription has no valid local Service Guide + active Guide Consent execution contract. No order was submitted and legacy execution Consent does not apply.` | `{label} 本次 Signal 已保存，仅接收和展示：该订阅没有有效的本地 Service Guide 与 Guide Consent 执行合约。不会提交订单，旧 execution Consent 不会生效。` |
| skipped, reason=`execution_policy_not_configured` | `{label} The deliverable was saved and skipped: the fixed-field legacy execution policy is retired and cannot create or restore execution configuration.` | `{label} 本次交付物已保存并跳过：固定字段的旧执行策略已退役，不会创建或恢复执行配置。` |
| skipped, other | `{label} No trade was executed for this delivery. Reason: {reason or "the signal was not eligible for execution"}.` | `{label} 本次交付物未执行交易。原因: {reason or "信号不满足执行条件"}。` |
| failed_before_execution | `{label} Delivery processing failed before a trade was started. Reason: {reason or "pre-trade processing could not be completed"}. No automatic order retry will occur.` | `{label} 交付物处理失败，未启动交易。原因: {reason (trailing 。 trimmed) or "无法完成交易前处理"}。系统不会自动下单重试。` |

(Commas in the Zh rows are ASCII `,` exactly as in source; the Chinese full stops/colons are as shown.)

#### 6.4 `notify_and_persist(path, o, force, timeout)` (executor.rs:2120)
1. Return immediately if `!o.notificationPending` or (`!force` and `o.nextNotificationAttemptAt > now`).
2. `key = "autotrade-outcome:" + sha256hex(job + "\0" + delivery + "\0" + DebugName(status))` where DebugName is the
   Rust variant name: `Submitted`, `FailedBeforeSubmit`, `UnknownAfterSubmit`, `Skipped`, `FailedBeforeExecution`.
3. Up to `force ? 3 : 1` attempts of `user_notify_scoped[_with_timeout](notification(o), job, key[, timeout])`
   (timeout `None` ⇒ default 5 s); sleep 50 ms then 100 ms between forced attempts.
4. Success → `notificationPending=false`, `nextNotificationAttemptAt=0`, `updatedAt=now`, `write_outcome` (errors
   ignored), return.
5. All failed → `notificationAttempts += attempts_made`, `updatedAt=now`; if `notificationAttempts ≥ 10` →
   `notificationPending=false`, `next=0` (give up); else `next = updatedAt + min(30·2^min(notificationAttempts,5), 900)`
   seconds. `write_outcome` (errors ignored).

#### 6.5 `persist_and_notify(path, o)` (executor.rs:1911) — the terminal transition
1. `write_terminal_journal(o)` → `A/terminal-journal/<job>/<delivery>.json` = pretty `{version:1,outcome:o}`; failure
   → stderr `[autotrade] terminal journal write failed: {error}` (continue).
2. `write_outcome(path, o)?` (§6.2).
3. If `o.executionMode == one_time` delete `A/one-time-permits/<job>/<delivery>.json`.
4. `consent::clear_pending_delivery(job, delivery)` — delete `A/pending/<job>.json` iff it parses and its
   `deliveryId == delivery`.
5. `notify_and_persist(path, o, force=false, timeout=5 s)`.
6. `delivery_queue::complete_and_advance(job, delivery)` (§7.8); error → stderr
   `[autotrade] queued-delivery resume failed (persisted for retry): {error}`.
7. `terminal_reconciliation_complete(o)` = `sync_notice_ref(o)` ok **and** `delivery_queue::contains_delivery(job,
   delivery)` is `Ok(false)` (note: this takes the queue lock and therefore creates `A/delivery-queue/<job>.lock`)
   **and** `sync_a2a_trade_record(o)` ok. If complete, delete the journal file.
8. Return the (possibly notification-mutated) `o`.

`sync_a2a_trade_record(o)` = `load_delivery_context(job, delivery)` (context `trusted delivery context is
unavailable for trade record`) then `record_signal_status(job, delivery, <status wire string>, reason or "",
context.savedPath)`.

#### 6.6 `record_signal_status(job, delivery, status, reason, savedPath)` (executor.rs:536)
Read `savedPath` as UTF-8 (context `saved subscription Signal is unavailable for trade record`); `extra` = the file
parsed as JSON, or `{"content": <raw text>}` if not JSON. Call `okx_a2a::trade_records_insert([{…}])` with the
object built by `json!` ⇒ sorted keys: `[{"deliveryId","extra","jobId","reason","status"}]`.

#### 6.7 `report_delivery(job, delivery, status, reason)` (executor.rs:2182) — see command `autotrade-delivery-report`.
#### 6.8 `recover_incomplete(job, delivery)` (executor.rs:2274)
`recovery_state`: outcome file exists → `TerminalOutcome`; no latch → `NoExecution`; latch phase
`reserved|prepared` → `PreSubmitInterrupted`; phase `spawned` or unreadable latch → `SubmissionUnknown`.
`NoExecution` → `false`. `TerminalOutcome` → rewrite outcome (refreshes index), `clear_pending_delivery`,
`delivery_queue::reconcile_terminal`, return `true`. Otherwise `persist_and_notify` a fresh outcome
(`venue/action/amount=""`, `executionMode:auto`, status/reason:
`failed_before_submit` + `execution was interrupted before the transaction command started; no order was submitted
and no automatic retry will occur`, or `unknown_after_submit` + `execution was interrupted after the transaction
command may have started; submission state is unknown and no automatic retry will occur`), return `true`.
**Never re-runs a trade.**

#### 6.9 `restore_subscription_local_contract(job, agent, provider, serviceId, hint)` (executor.rs:1653)
1. If `A/guide/<job>.md` is not a file: `service = hint` or `find_service(provider, serviceId)` (§6.10) → `None`
   ⇒ `service is not available to restore its Guide`; `source = service.serviceGuide` (string) else `service has no
   Guide to restore`; `hash = service.serviceGuideHash` (string, optional); `guide::parse_draft(source, hash)` (§8.2);
   write `GuideFile{version:1, jobId:job, serviceId, providerAgentId:provider, sourceHash, createdAt:now}` via
   `guide::write_guide`.
2. `guide::migrate_legacy_json_consent_if_needed(job, agent, serviceId)` (§8.6).
3. Return `subscription_config::execution_mode(agent, serviceId)` (§10).

#### 6.10 `find_service(agentId, serviceId)` (task/common/mod.rs:715, owned elsewhere)
`serviceId==""` → `Ok(None)`. Else spawns **the onchainos binary itself**:
`<current_exe> agent service-list --agent-id <agentId> --page 1 --page-size 100 --service-id <serviceId>`, requires
stdout JSON with `ok:true` (else `` `agent service-list` returned failure: {error} `` / parse error), then returns the
first `data[*].list[*]` entry whose `id` or `serviceId` (string or integer rendered) equals `serviceId`. The child
performs `GET /priapi/v5/wallet/agentic/agent/services` (JWT; owned by identity group) and also runs §1.

#### 6.11 `hydrate_subscription_contract` / `require_guide_direct_subscription` (executor.rs:1686-1721)
1. `TaskApiClient::new()`; `subscription::determine_active_delivery(client, job, context.agentId)`:
   - `agentId.trim()==""` → error (never sent);
   - `ensure_tokens_refreshed()` (core auth; may refresh the JWT) then
     **`GET {base}/priapi/v1/aieco/task/subscribe/{jobId}`** with query `sessionCert=<session cert>` only if the local
     session has a non-empty sessionCert, headers = core JWT headers (`ApiClient::jwt_headers`, Authorization Bearer
     …) + `agenticId: <context.agentId>`; core retries once on invalid-token after a forced refresh and does DoH
     failover on connect/timeout. Returns the response `data`.
   - Any error (incl. HTTP 404, not logged in) → degrade `lookup_off`; `data.status` (JSON number or trimmed numeric
     string) `!= 1` → `subscription_not_active`. `providerAgentId`/`serviceId` read as string or integer, default `""`.
   - Either degrade → error **`subscription is no longer Active`** (cause discarded).
2. `active.providerAgentId != context.providerAgentId` → `Active subscription no longer matches this delivery`.
3. `restore_subscription_local_contract(job, context.agentId, context.providerAgentId, active.serviceId, None)?`.
4. (`require_…` only) `subscription_config::execution_mode(context.agentId, active.serviceId)? != guide_direct` →
   `automatic copy-trading is not enabled for this subscription`.

#### 6.12 `reconcile_terminal_journals(max, budget)` (executor.rs:2326)
If `A/terminal-journal` is a dir: for each job dir, for each entry (stop when `repaired ≥ max` or deadline): skip
non-`.json`; unreadable journal → stderr `[autotrade] unreadable terminal journal "<path>": {error}` (Debug-quoted
path) and continue; `outcome = existing outcome file or journal.outcome`; `write_outcome`; delete one-time permit if
`one_time`; `clear_pending_delivery`; `delivery_queue::reconcile_terminal`; delete journal if
`terminal_reconciliation_complete` (§6.5-7, may spawn `okx-a2a trade-records insert`); `repaired += 1`.
Errors from `outcome_path/read_outcome/write_outcome` abort the scan (caller ignores).

#### 6.13 `flush(job)` = `flush_with_policy(job, force=true, max=32)` (executor.rs:2382)
`!job_id_is_safe` → `invalid job id`. If `A/outcomes/<job>` missing → `[]`. Iterate `read_dir(...).take(32)`
(**the 32 cap is applied before filtering**, filesystem order), skip non-`.json`, `read_outcome(path)?` (errors
propagate), if pending `notify_and_persist(path, o, force=true, None)`; collect `o`. Then
`notify::flush_pending(job, force=true)` (§11.3, errors ignored). Return the list.

#### 6.14 `flush_all_due(max)` (executor.rs:2472)
If `A/pending-outcome-notifications` is a dir: (a) for every entry whose extension starts with `lease-`: if its mtime
age ≥ 30 s, delete it when `<same stem>.json` exists else rename it back to `.json`; (b) collect parseable `.json`
refs with `version==1`; sort by `nextAttemptAt` ascending; take `max(max,1)`; for each: stop if `nextAttemptAt > now`;
rename index → `<stem>.lease-<pid>` (skip on failure); if the ref's ids are invalid delete lease; if the outcome
exists and is pending → `notify_and_persist(path, o, false, 5 s)`; otherwise delete the (already renamed) index path;
finally delete the lease. Then `notify::flush_all_pending_bounded(max, 5 s)` (§11.4). Returns degrade notices
delivered.

#### 6.15 `cleanup_expired_tickets(limit)` (executor.rs:2430)
Scan `A/one-time-permits/*/*.json`, inspecting at most `limit` json files; delete those that parse with
`version==1 && expiresAt ≤ now`. Outcomes/latches are never deleted.

#### 6.16 Dead code (no production caller; `#![allow(dead_code)]` crate-wide)
`claim_direct`, `authorize_direct`, `validate_percentage_policy_amount`, `authorize`, `parse_command`,
`normalize_trade_kit_dash_values`, `apply_trade_kit_auth_environment`, `validate_bound_intent`,
`trade_kit_execution_context`, `validate_trade_kit_execution_settings`, `classify_nonzero`, `classify_success`,
`receipt_from_stdout`, `structured_failure*`, `text_failure_detail`, `update_execution_phase`, `safe_reason`,
`reserve_direct_execution`, `flush_due(job)`. They describe a retired "execution bridge" that spawned
`onchainos swap execute`, `okx`, `polymarket-plugin`, `hyperliquid-plugin`. Not reachable from any command; a port
may omit them. `failure_category_for` and `trade_kit_authentication_error` **are** live (used by
`autotrade-direct-finalize`): `failureCategory=authentication_required` iff `tool_id=="trade_kit"`, status
`failed_before_submit`, and the lower-cased reason contains any of: `failed to spawn okx-auth`, `no credentials
found`, `not logged in`, `not authenticated`, `requires_auth`, `session expired`, `401 unauthorized`, `http 401`,
`token refresh failed`, `token expired`, `token not found`, `storagenotfounderror`, `no config found`,
``run `okx auth login` ``, `run okx auth login`, ``run `okx config init` ``, `run okx config init`,
`re-run: okx config init`, `api key doesn't exist`, `api key does not exist`, `invalid api-key`, `invalid api key`,
`invalid ok-access-key`, `invalid sign`, `passphrase is incorrect`, `50100`, `50110`, `50111`, `50112`, `50113`.

### 7. delivery_queue.rs (per-job FIFO of decision-requiring deliveries)

Constants: queue v1, resume envelope v2, `RETRY_DELAY_SEC=30`, `RESUME_ACK_TIMEOUT_SEC=30`,
`PROCESSING_WATCHDOG_SEC=900`. Every mutation holds an exclusive `fs2` flock on `A/delivery-queue/<job>.lock`
(created 0600, dir 0700). `read_queue` of a missing file = empty queue; `version!=1 || jobId!=job` →
`delivery queue mismatch`. `write_queue` deletes the file when `entries` is empty.

1. **`enqueue(job, delivery)`**: requires `load_delivery_context`. If queue empty and a pending pointer exists for a
   *different* delivery, first push `{that delivery, awaiting_decision, enqueuedAtMs: pending.receivedAtMs}`. If the
   delivery is already present: at index 0 → if `state==processing && processingAttempt>0` (claimed resume) set
   `processingAttempt=0, processingStartedAt=now`, write, return `Active{already_present:false}`; else
   `Active{already_present:true}`; at index>0 → `Queued{active: entries[0], position:index+1}`. Otherwise append
   (`processing` + `processingStartedAt=now` if queue was empty, else `waiting`), `enqueuedAtMs=now_ms`.
2. **`contains_delivery`** (lock + read).
3. **`mark_awaiting_decision(job, d)`**: head must be `d` (`delivery queue is empty` / `delivery is not the queue
   head`); `state=awaiting_decision`, zero `nextResumeAttemptAt, resumeSentAt, processingStartedAt,
   processingAttempt`.
4. **`acknowledge_resume(job, d, envVersion?, attempt?)`**: head≠d → `NotQueueHead`; head in
   `resume_pending|resume_sent` accepts iff (`envVersion==2 && head.resumeProtocolVersion==2 && attempt>0 &&
   attempt==head.resumeAttempts`) or (`envVersion==None && head.resumeProtocolVersion==0` and attempt either equal
   `resumeAttempts`>0 or absent) → `processing`, `processingStartedAt=now`, `processingAttempt=attempt`,
   `resumeSentAt=0`, `nextResumeAttemptAt=0` → `Accepted`; everything else `DuplicateOrStale`.
5. **`resume_envelope(ctx, attempt)`** = compact JSON (sorted keys):
   `{"agentId":<ctx.agentId>,"message":{"code":0,"data":"resume_queued_delivery","deliveryId":…,"description":"A
   previously queued Active-subscription delivery is now at the head of its FIFO. Call onchainos agent next-action
   with this envelope and follow the returned playbook. Re-read and re-validate the saved artifact; do not reuse prior
   dynamic trade fields.","event":"autotrade_queued_resume","jobId":…,"resumeAttempt":<n>,"resumeEnvelopeVersion":2,
   "role":"user","source":"system","timestamp":<now secs>}}`.
6. **`send_resume`**: `messageId = "autotrade-queue-resume:" + sha256hex(job+"\0"+delivery+"\0"+attempt)`; if
   `ctx.originSessionKey` non-empty → `okx-a2a session send --session-key … --content <env> --message-id <id> --json`;
   else `okx-a2a session send --job-id <job> --content <env> --json --to-agent-id <ctx.providerAgentId>`.
7. **`dispatch_front(job, timeout)`**: under lock, only when head is `resume_pending` with `nextResumeAttemptAt≤now`,
   or `resume_sent` with `resumeSentAt==0 || resumeSentAt+30≤now`: set `resume_pending`,
   `nextResumeAttemptAt=now+30`, `resumeAttempts+=1`, `resumeProtocolVersion=2`, zero sent/processing fields, write.
   Unlock, `send_resume(ctx, attempt, timeout)?`; relock; if head still that delivery in `resume_pending` →
   `resume_sent`, `resumeSentAt=now`, `nextResumeAttemptAt=now+30`, write. Returns `true` if dispatched.
8. **`complete_and_advance(job, d)`** / **`release_unpresented`**: remove `d`; if it was the head and entries remain,
   the new head becomes `resume_pending` with zeroed timers; write; if so `dispatch_front(job, 1 s)`.
   **`reconcile_terminal`** = the removal step only (no dispatch).
9. **`schedule_retry(job, d)`**: head `d` → `resume_pending`, `nextResumeAttemptAt=now+30`, zero others.
10. **`flush_due(limit, budget)`** (pre-dispatch §1): if `A/delivery-queue` is a dir, iterate entries (filesystem
    order) until `dispatched ≥ limit` or deadline: for each `<job>.json`: `reconcile_terminal_head(job)` (head has an
    outcome ⇒ `recover_incomplete`), `migrate_legacy_processing(job)` (head `processing` with
    `processingStartedAt==0`: latch/outcome present ⇒ `recover_incomplete`; pending pointer = head ⇒
    `awaiting_decision`; else `resume_pending` + `resumeProtocolVersion=0`), `recover_stalled_processing(job)` (head
    `processing` for ≥ 900 s: no latch ⇒ `resume_pending`; otherwise `recover_incomplete`), then if ≥ 25 ms remain
    `dispatch_front(job, remaining)`. All per-job errors ignored.

### 8. guide.rs (Service Guide + Guide Consent)

1. Constants: `GUIDE_VERSION=1`, `GUIDE_CONSENT_VERSION=1`, `MAX_GUIDE_CHARS=49152`.
   `MISSING_CONSENT_RECOVERY_MESSAGE` = `The consent file is missing. Ask the user for the configuration parameters
   based on the Guide file, then call autotrade-guide-consent-new to generate a new consent.`
2. **`parse_draft(source?, hash?)`**: `None` → `None`; `source.trim()==""` or char count > 49152 →
   `--service-guide must be between 1 and 49152 characters`; `computed = sha256hex(source)`; `h = (hash or
   computed).trim()`, strip a leading `sha256:`, ASCII-lowercase; not 64 hex → `--service-guide-hash must be a
   lowercase SHA-256 hex digest`; `h != computed` → `--service-guide-hash does not match --service-guide`.
3. **`write_guide(file, source)`**: `validate_file` (`version>1 || !job_id_is_safe || serviceId.trim()==""` →
   `service guide metadata is invalid`; sourceHash not 64-hex → `service guide hash is invalid`);
   `sha256hex(source) != sourceHash` → `service guide content does not match its hash`; write markdown kind `guide`.
4. **`load_guide(job)`**: path (`invalid job id`), `read_to_string` (context `service guide is not available
   locally`), parse kind `guide`, `validate_file`, `jobId` mismatch → `service guide job id mismatch`. The body is
   **not** re-hashed.
5. **`read_guide_consent(job)`**: missing `A/consent/<job>.md` → `None`; read (context `Guide Consent is not
   readable`); parse kind `consent` as `GuideConsentFile` (deny unknown fields — a legacy fixed-field consent document
   fails here); `version!=1 || jobId!=job || guideHash not 64-hex` → `Guide Consent metadata is invalid`.
   `load_active_consent` = that, filtered to `lifecycle==active && expiresAt>now`.
6. **`migrate_legacy_json_consent_if_needed(job, agent, service)`**: pick `A/consent/<job>.md`, else
   `A/consent/<job>.json`, else return. Read (context `local Consent is not readable`). If it starts with the consent
   marker → `read_guide_consent(job)?` and return. Else parse as legacy `ConsentFile` JSON (context `local Consent is
   neither current Guide Consent nor legacy JSON`); `version>6 || jobId≠job` → `legacy Consent metadata is invalid`;
   not `active` or expired → return. `load_guide(job)?`; `values` = legacy object minus keys `version, jobId, mode,
   requiredFields, serviceGuideHash, guideHash, lifecycle, createdAt, expiresAt`; reject credential-like keys; if no
   subscription-config mode exists for (agent, service) save `guide_direct` (legacy `auto`) or `signal_only`
   (`manual`/`decline`) with `replace=false`; write an **active** GuideConsent `{guideHash: guide.sourceHash, values,
   createdAt/expiresAt copied}`. The legacy `.json` file is left in place.
7. **`has_active_execution_contract(job)`** = `load_guide(job)` ok **and** an active, unexpired Guide Consent exists.
   The consent `guideHash` is **not** compared with the guide's `sourceHash`.
8. **`field_key_is_sensitive(k)`**: keep ASCII alphanumerics, lowercase; true if it *contains* any of `password,
   passphrase, privatekey, secretkey, apikey, accesstoken, refreshtoken, credential, jwt`.
9. Other writers (called by create flows owned elsewhere): `write_prepared_consent` (lifecycle `prepared`,
   `expiresAt=now+ttl` saturating), `activate_prepared_consent` (`prepared Guide Consent is not available` / `Guide
   Consent is not prepared`), `abort_prepared_consent`. `consent_snapshot(job)` → `{status:"active"|"unavailable",
   guideHash?}`.

### 9. consent.rs / consent_reply.rs / continuation.rs / card.rs / profile.rs / schema.rs / tooling.rs (library code)

These modules are mostly consumed by *other* groups' flows (next-action playbooks, pending-decisions relay, asp-match)
or are retained compatibility code. Facts a port needs:

- **Legacy fixed-field consent (`consent.rs`)**: `load_consent(job)` reads `A/consent/<job>.md` (or legacy `.json`);
  a marker-prefixed file is parsed with `guide::parse_markdown("consent")` **as `ConsentFile`** (requires `mode`), so a
  current Guide Consent document yields `ConsentError("consent_unreadable")`. Rejections: unparsable →
  `consent_unreadable`; `version>6` → `consent_version_too_new`; `jobId` mismatch → `consent_job_mismatch`; invalid
  dynamic settings / null values / incomplete `requiredFields` / non-explicit `tradeEnvironment` → `consent_unreadable`.
  Lifecycle ≠ `active` (default active) or `expiresAt≤now` → `None`. `evaluate_consent(job, buy?)`: none →
  FirstTime; decline → Declined; manual → Manual; auto: `buy=None` → AutoAllow; buy ≤ parseable `capU` → AutoAllow,
  else AutoOverCap. `quote_token(job)` = consent `quoteToken` if in `{usdc,usdt}` else `usdt`.
  **In the release binary no command writes this format** (`autotrade-consent-set` is compiled out, §Commands 15).
- **`consent_reply::apply_candidate_json`** (used by `pending-decisions-v2 … --autotrade-candidate-json`, other group):
  source event must be `autotrade_consent` or `autotrade_config_required` (else `auto-trade candidate JSON is not
  valid for this decision type`); **both are "retired" events**, so it always deletes `A/pending-config/<job>.json`
  and returns `FallbackRelay` *before parsing the JSON*. All draft/persist logic after that line is unreachable.
- **`continuation.rs`**: no production writer (only `#[cfg(all(test, any()))]` tests call `start_or_update`);
  `load_live_for_job` is read by task/user/mod.rs:1605 (file `A/consent-continuation/<job>.json`, v6, TTL 1800 s,
  expired files are deleted on read, `version<6` Auto subscription-restore records are migrated to require draft
  review). Its `consentCommand` strings reference the non-existent `autotrade-consent-set`.
- **`card.rs`** live uses: `make_cap_adjust_decision` + `decision_list_label` (cap-adjust command) and
  `make_notify_only` (flow_lifecycle). `DecisionRequest` struct order: `autoTrade`(true), `executed`(false),
  `decision`(true), `deliveryId`, `signalType`, `jobId`, `sourceEvent`, `userContent`, `command`, `guidance`,
  `requiresPlugin` (omitted when None). `NotifyOnly` order: `autoTrade`, `executed`, `savedPath`, `reason`,
  `notificationTemplate` (omitted if empty), `notificationPushed` (omitted if false), `guidance` (omitted if empty).
  Recipe assembly (`assemble_command`, `dex_command`, `polymarket_command`, execution cards) is dead code.
- **`make_decision` summary prefix** (card.rs:625 + consent.rs:757): `summary` = delivery-context summary of
  `delivery-context/<job>/<deliveryId>.json` if loadable, else of the pending pointer `pending/<job>.json`, else none;
  when present `userContent = summary + "\n\n" + content`. Summary lines joined by `\n`: header
  `[Deliverable for this decision]` / `[对应交付物]`, then `"<label>: <value>"` for: `Delivery ID`/`交付 ID`
  (always), `Signal ID`/`信号 ID` (`/signalId`), `Signal type`/`信号类型` (`/signalType` else context
  `deliverableType`), `Side`/`方向` (`/params/side`), `Signal amount`/`信号金额` (`/params/amount` + optional
  `/params/amountUnit` + optional `/params/quoteCurrency`, space-joined), `Chain`/`链` (`/params/chainIndex`),
  `Token`/`Token` (`/params/tokenAddress`), and `File`/`文件` (saved file name, ≤96 chars) only when no JSON signal
  was found. The signal JSON = first JSON value starting at the first `{` after the first `[ACTIONABLE_TRADING_SIGNAL]`
  marker (or anywhere if no marker) within the first 65536 chars of the saved file; each value (string or number,
  trimmed, non-empty) is shortened to 128 chars (+`…`) with control chars removed.
- **`profile.rs`**: writers used by task/user/mod.rs; file compact JSON, `PROFILE_VERSION=3`,
  `serviceDescription` truncated to 4096 chars, `descriptionHash = sha256hex(description)`.
- **`schema.rs`**: retired structured-signal schema; no command reaches it.
- **`tooling.rs`**: `build_preflight` / `ToolInventory::detect` used by `asp-match` and `task-create-prepare` (other
  groups). `candidate_tools`: spot→[onchainos, trade_kit], perp→[hyperliquid_plugin, trade_kit],
  prediction→[polymarket_plugin, trade_kit], option→[trade_kit], defi→[onchainos]. Classifier is pure/local.
- **`subscription.rs`** is used by §6.11 (and by flow_lifecycle).

### 10. subscription_config.rs (per-device copy-trading preference)

- Path `A/subscription-config/<agentId>/<serviceId>.json`; both ids must pass `[A-Za-z0-9_-]` else `invalid
  subscription AgentId or ServiceId`.
- `load_config`: missing → None; read error → `subscription execution configuration is unreadable: <path>` + io cause;
  JSON error → `subscription execution configuration is invalid` + serde cause; `version>1 || agentId≠ ||
  serviceId≠` → `subscription execution configuration is invalid`.
- `execution_mode(agent, service)` = `load_config()?.executionMode` (null → None).
- `save_execution_mode(agent, service, mode, replace)`: existing with null mode → `repaired`; none → `created`;
  existing mode + `replace` → `replaced`; existing mode without replace → error `subscription automatic-copy
  preference is already {signal_only|guide_direct}; use --replace only after a new user confirmation`. Writes pretty
  `{version:1, agentId, serviceId, executionMode, updatedAtMs:<now ms>}`; failure → `failed to persist subscription
  execution configuration at <path>: <io error>`.
- `ExecutionMode::from_str(v)`: `v.trim()` ∈ {`signal_only`, `guide_direct`} else `--execution-mode must be
  signal_only or guide_direct`.

### 11. notify.rs (CLI-pushed user notices)

1. **`notify_swap_outcome(job, chain, displayAmount, fromArg, toArg, outcome)`** — called by `swap execute
   --notify-job-id <job>` (swap group). `lang=resolve(job)`. Success: `from = out.fromToken.tokenSymbol` (non-empty)
   else `short_id(fromArg)`; `to` likewise; `tx = out.swapTxHash`, `order = out.swapOrderId` (strings or `""`);
   legacy consent (`consent::load_consent`) `auto_mode = mode==auto`; `cap` = `"{capU} {FROMARG_UPPERCASE}"` only if
   auto_mode and `fromArg.lower()` ∈ {usdc,usdt} and capU present. Message:
   - En: `[Auto Copy-Trade] Job {short_id(job)}: {exec} — swap {amount} {from} → {to} on {chain}. {result}` where
     `exec` = `dex signal auto-executed` (auto) / `dex signal executed (per your confirmation)`; `result` =
     `Tx: {tx}` / `Order: {order}` / `submitted — check wallet history for the tx id`; plus, if cap:
     `\nWithin your {cap} per-trade auto limit. Reply "Pause auto copy-trading" to turn it off anytime.`
   - Zh: `[自动跟单] 任务 {job}:{exec} — {chain} 链 swap {amount} {from} → {to}。{result}` with `exec` =
     `dex 信号已自动执行` / `dex 信号已执行(经你确认)`, `result` = `交易哈希: {tx}` / `订单号: {order}` /
     `已提交,交易 ID 可稍后在交易历史中查询`; cap line `\n本次在你的每笔 {cap} 自动限额内。回复「暂停自动跟单」可随时关闭。`
   - Failure (uses short ids): En `[Auto Copy-Trade] Job {job}: auto-execution FAILED — swap {amount} {from} → {to}
     on {chain} did not complete. Reason: {flatten_reason(e:#)}\nYou can run this trade manually; auto copy-trade will
     not retry it.`; Zh `[自动跟单] 任务 {job}:自动执行失败 — {chain} 链 swap {amount} {from} → {to} 未完成。原因:
     {reason}\n可手动补做,系统不会自动重试。`
   - key `autotrade-swap:` + sha256hex(job+"\0"+msg); one `user_notify_scoped` (5 s); failure → stderr
     `[autotrade] outcome notification failed (non-fatal): {e}`. Never changes the swap result.
2. **`push_degrade_notice(n, job)`** (flow_lifecycle caller): reason `replay_skip` → no push, `notificationPushed=true`,
   template `""`, guidance `Duplicate of an already-executed signal — deliberately absorbed. Do NOT notify the user;
   just end the turn.` Otherwise message = `degrade_message(job, reason, lang)`:
   En `[Auto Copy-Trade] The provider's signal for job {short_id(job)} was not executed ({reason}). The deliverable is
   saved for manual review.` / Zh `[自动跟单] 任务 {job}:服务商信号未执行(原因: {reason})。交付物已保存,可手动查看处理。`
   (reason `multiple_take_profit_unsupported` has its own fixed En/Zh sentences, notify.rs:500-509). key
   `autotrade-degrade:` + sha256hex(job+"\0"+reason); up to 3 immediate `user_notify_scoped` attempts; success → delete
   outbox file for that key, `notificationPushed=true`, template `""`, guidance `The CLI already delivered this degrade
   notice to the user — do NOT run `onchainos agent user-notify` again; just end the turn.`; failure →
   `persist_failed_notice(job, key, msg, 2)` (attempts=3, next=now+240 s) + stderr `[autotrade] degrade notification
   failed (non-fatal, persisted={bool}): {err}` and guidance (persisted / not persisted variants, notify.rs:486-491).
3. **`flush_pending(job, force)`**: `A/notification-outbox/<job>/*.json` with matching jobId, sort by
   `nextAttemptAt`, take 4, `deliver_pending` each (5 s).
4. **`flush_all_pending_bounded(limit, budget)`**: all job dirs; stale `lease-*` (≥30 s) repair; sort; take
   `max(limit,1)`; per notice rename to `.lease-<pid>`, `deliver_pending(lease, n, false, remaining)`, then move the
   lease back to `.json` if it still exists (or delete it if `.json` reappeared).
5. **`deliver_pending(path, n, force, t)`**: `version≠1` or bad job → error; `!force && next>now` → not sent; send;
   success → delete file; failure → `attempts+=1`, `attempts≥10` → delete; else `next = now + min(30·2^min(attempts,5),
   900)`, rewrite.

### 12. trade_kit.rs (local Trade Kit discovery) — used by `agent trade-kit-readiness`

- `probe_local()`: `cli_path` = first existing file among, for each dir of `PATH` (skip empty entries), the names
  `okx.exe, okx.cmd, okx.bat, okx` (Windows) or `okx` (others); else the same names under `~/.npm-global/bin`,
  `~/.npm/bin`, `~/.local/bin`, `~/.yarn/bin`, `~/.config/yarn/global/node_modules/.bin`. (`skill_installed` is
  computed via `commands::upgrade::is_skill_installed_in(home,"okx-cex-trade")` but never affects output.)
- `run_bounded(exe, ["list-tools","--json"], 5 s, stdoutCap 1 MiB)`: `.cmd`/`.bat` on Windows run as
  `cmd /C <exe> list-tools --json`; env `OKX_UPDATE_CHECK=false`; stdin null; stderr capped 64 KiB; kill + 1 s reap on
  timeout. Spawn error → Unavailable.
- `CapabilitySnapshot::from_list_tools_json`: requires non-empty string `version` and array `modules`, each module
  an array `commands`; collects non-empty `commands[].toolName`.
- `version_at_least(cur, "1.3.2")`: trim, strip leading `v`s, drop `+build`, split first `-` (prerelease flag), exactly
  `major.minor.patch` u64; `cur>min` or (`equal` and (`cur` not prerelease or `min` prerelease)); unparsable → false.
  Oracles: `1.3.1`✗ `1.3.2-beta.7`✗ `1.3.2`✓ `v1.3.2+build.9`✓ `1.4.3-beta.2`✓ `not-a-version`✗.
- Required tool names per class: spot `market_get_ticker, spot_place_order`; perp `market_get_ticker,
  market_get_instruments, account_get_config, swap_get_leverage, swap_set_leverage, swap_place_order,
  swap_close_position, futures_get_leverage, futures_set_leverage, futures_place_order, futures_close_position`;
  prediction `event_browse, event_get_series, event_get_events, event_get_markets, event_place_order`; option
  `option_get_instruments, option_get_greeks, option_place_order`.
- Install/upgrade command string: `npm install -g @okx_ai/okx-trade-cli@latest`.

---

## Commands

### `onchainos agent trade-kit-readiness`  (hidden: no)
- Handler: commands/agent_commerce/mod.rs:2042 → `trade_kit::parse_runtime_asset_classes`,
  `TradeEnvironment::parse`, `trade_kit::probe_runtime` (trade_kit.rs:481).
- Options: `--asset-class <S>` required, repeatable (`ArgAction::Append`), values validated in handler (not clap):
  exactly `spot|perp|prediction|option` (case-sensitive; `defi`, `futures`, `options`, `SPOT` rejected), duplicates
  removed preserving first-seen order. `--environment <S>` default `configured`; `configured|live|demo`. Global
  `--chain` (ignored).
- Auth: anonymous (no network; local process only).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. Parse classes → error `asset class must be spot, perp, prediction, or option` (exit 1). Parse environment →
     `environment must be configured, live, or demo` (exit 1).
  3. `probe_local()`; no CLI → every class `missing`/`cli_missing`, `version:null`, remediation
     `{"install":"npm install -g @okx_ai/okx-trade-cli@latest"}`.
  4. Else spawn `okx list-tools --json` (≤5 s). Timeout → all `verification_unknown`/`discovery_timeout`; spawn
     failure / non-zero exit / stdout > 1 MiB / non-UTF-8 / invalid envelope → all
     `verification_unknown`/`discovery_failed`; both with `version:null`, `remediation:null`.
  5. `version < 1.3.2` → all `incompatible`/`upgrade_required`, `version:"<v>"`, remediation
     `{"upgrade":"npm install -g @okx_ai/okx-trade-cli@latest"}`.
  6. Else per class: all required tool names present → `ready`/`ready`; else `incompatible`/`capability_missing` with
     `missingCapabilities` in required-list order.
  7. Aggregate readiness/reason = the asset check with the highest priority (`missing`3 > `incompatible`2 >
     `verification_unknown`1 > `ready`0); **on ties the last such check wins** (Rust `max_by_key`). Top-level
     `missingCapabilities` = de-duplicated union in asset order. `remediation`: `ready`/`discovery_*` → null;
     `cli_missing` → install; `upgrade_required`/`capability_missing` → upgrade.
- Output (`data`, struct order): `{"schemaVersion":3,"tool":"trade_kit","scope":"local_compatibility",
  "authenticationChecked":false,"assetClasses":[…],"environment":"configured|live|demo","readiness":"…","ready":bool,
  "reason":"ready|cli_missing|discovery_timeout|discovery_failed|upgrade_required|capability_missing",
  "checkedAt":"<RFC3339 ms Z>","version":<str|null>,"missingCapabilities":[…],"remediation":<{install}|{upgrade}|null>,
  "assetChecks":[{"assetClass","readiness","ready","reason","missingCapabilities"}]}`. Exit 0 regardless of readiness.
- Errors: parse errors above (exit 1); missing `--asset-class` → clap (exit 2).
- Side effects: local-only (spawns local `okx` binary read-only).
- Nondeterminism: `checkedAt`; depends on PATH/home contents and installed `okx` version.
- Parity test cases:
  - SAFE `onchainos agent trade-kit-readiness --asset-class spot` with PATH lacking `okx` → `cli_missing` shape.
  - SAFE `onchainos agent trade-kit-readiness --asset-class spot --asset-class perp --asset-class spot --environment demo`.
  - SAFE `onchainos agent trade-kit-readiness --asset-class futures` → `{"ok":false,"error":"asset class must be spot, perp, prediction, or option"}` exit 1.
  - SAFE `onchainos agent trade-kit-readiness --asset-class spot --environment prod` → `environment must be configured, live, or demo`.

### `onchainos agent autotrade-grant-check`  (hidden: no)
- Handler: commands/agent_commerce/mod.rs:2060 → `grants::check_grant` (grants.rs:142).
- Options (all required strings, no clap value parser): `--job-id`, `--venue`, `--action`, `--amount`, `--format`.
  Global `--chain` ignored.
- Auth: anonymous (local file only).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `--format` must equal `json` exactly, else print `{"ok":false,"reason":"invalid format"}` → exit 1.
  3. Validation chain, first failure wins (reason strings verbatim):
     1. `job_id_is_safe` else `invalid job id` (checked before any filesystem use);
     2. venue canonicalisation: `hyperliquid`→`dex`; accepted `dex|defi|polymarket|trade_kit` else `invalid venue`;
     3. action ∈ `buy|sell` else `invalid action`;
     4. `Decimal::parse(amount)` ok and non-zero else `invalid amount`;
     5. `onchainos_home()` failure → `grant file unreadable`; `A/grants/<job>.json` missing → `no grant file`;
     6. read/parse (`deny_unknown_fields`; required `version, jobId, grants, createdAt, expiresAt`; venue objects allow
        only optional `maxBuy`,`maxSell`) failure → `grant file unreadable`;
     7. `version > 1` → `grant version too new`;
     8. `jobId` ≠ input → `grant job mismatch`;
     9. `expiresAt ≤ now` → `grant expired`;
     10. `grants[canonicalVenue]` absent → `venue not authorized`.
     The amount is **not** compared with `maxBuy/maxSell` (reasons `no cap for action`/`per-trade cap exceeded` are
     never produced).
  4. Allow → print `{"ok":true}` exit 0. Deny → print `{"ok":false,"reason":"<reason>"}` exit 1.
- Output: bespoke top-level JSON (no `data` envelope, no `notifications`, always compact — `ONCHAINOS_PRETTY` ignored),
  keys in order `ok`,`reason`. Nothing on stderr. Audit logged for both allow and deny.
- Errors: as above; clap errors exit 2.
- Side effects: read-only (local). Note: in the release binary nothing creates grant files any more (writers are
  debug-only or dead), so on a fresh home every well-formed call returns `no grant file`.
- Nondeterminism: expiry comparison against wall clock.
- Parity test cases:
  - SAFE `onchainos agent autotrade-grant-check --job-id job1 --venue dex --action buy --amount 1 --format json` → `{"ok":false,"reason":"no grant file"}` exit 1.
  - SAFE `… --format yaml` → `{"ok":false,"reason":"invalid format"}` exit 1.
  - SAFE `--job-id ../../etc/passwd …` → `invalid job id`; `--venue nasdaq` → `invalid venue`; `--action hodl` → `invalid action`; `--amount 0` / `--amount -1` / `--amount 1e3` → `invalid amount`.
  - SAFE with a pre-seeded valid grant file (e.g. `{"version":1,"jobId":"job1","grants":{"dex":{"maxBuy":"100","maxSell":null}},"createdAt":1,"expiresAt":4102444800}`) and `--venue hyperliquid --action sell --amount 999` → `{"ok":true}` exit 0.

### `onchainos agent autotrade-guide-consent-update`  (hidden: no)
- Handler: commands/agent_commerce/mod.rs:2251 → `guide::update_active_consent_values` (guide.rs:245).
- Options: `--job-id <S>` required; `--values-json <S>` required ("Complete JSON object of Guide-defined Consent
  values").
- Auth: anonymous (local).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `serde_json::from_str::<BTreeMap<String,Value>>(values_json)` else `--values-json must be a JSON object: <serde
     error>` (duplicate keys: last wins; values kept verbatim, nested objects re-sorted).
  3. Any key whose normalised form contains a credential word (§8.8) → `credentials must not be stored in Guide
     Consent: <key>`.
  4. `read_guide_consent(job)` (§8.5): `invalid job id`; file missing → `The consent file is missing. Ask the user
     for the configuration parameters based on the Guide file, then call autotrade-guide-consent-new to generate a new
     consent.`; unreadable/parse errors as in §8.5.
  5. `lifecycle≠active || expiresAt≤now` → `active Guide Consent is not available locally`.
  6. Replace `values` wholesale (no merge); keep version/jobId/guideHash/lifecycle/createdAt/expiresAt; write
     `A/consent/<job>.md` (§3 container; metadata pretty `{version,jobId,guideHash,lifecycle,values,createdAt,
     expiresAt}`). Invalid metadata on write → `Guide Consent metadata is invalid`.
- Output: `data` (json!, sorted): `{"consentStatus":"active","guideHash":"<hash>","jobId":"<job>","updated":true}`.
- Errors: all above → `{"ok":false,"error":…}` exit 1.
- Side effects: local-only (rewrites consent file). Does not touch the Guide.
- Nondeterminism: none (timestamps preserved).
- Parity test cases:
  - SAFE `onchainos agent autotrade-guide-consent-update --job-id job1 --values-json '{}'` on empty home → missing-consent message, exit 1.
  - SAFE `--values-json '[]'` → `--values-json must be a JSON object: invalid type: sequence, expected a map at line 1 column 1` (see openQuestions).
  - SAFE `--values-json '{"apiKey":"x"}'` → `credentials must not be stored in Guide Consent: apiKey`.
  - SAFE with seeded guide+active consent: `--values-json '{"tradeAmount":"20","marginMode":"cross"}'` → updated:true and file values replaced.

### `onchainos agent autotrade-guide-consent-new`  (hidden: no)
- Handler: commands/agent_commerce/mod.rs:2269 → `guide::create_active_consent_from_guide` (guide.rs:261).
- Options: `--job-id <S>` required; `--values-json <S>` required; `--ttl-sec <u64>` default `31536000`
  (`DEFAULT_AUTOTRADE_TTL_SEC`; clap u64 parser — negative/non-numeric → clap error exit 2).
- Auth: anonymous (local).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. Parse `--values-json` exactly as in update (same error).
  3. `ttl_sec == 0` → `--ttl-sec must be > 0`.
  4. Credential-key check (same message as update).
  5. `load_active_consent(job)?` — read errors propagate (e.g. a legacy fixed-field `.md` consent →
     `local autotrade document metadata is invalid: <serde cause>`); an active unexpired consent exists →
     `active Guide Consent already exists; use autotrade-guide-consent-update to replace values`. (Prepared, aborted or
     expired consent is overwritten.)
  6. `load_guide(job)?` (§8.4) → e.g. `service guide is not available locally: <os error>`.
  7. Write active consent `{version:1, jobId, guideHash: guide.sourceHash, lifecycle:"active", values, createdAt:now,
     expiresAt: now+ttl (saturating)}`.
- Output: `data` (sorted): `{"consentStatus":"active","created":true,"guideHash":"<hash>","jobId":"<job>"}`.
- Errors: exit 1 for all above.
- Side effects: local-only.
- Nondeterminism: `createdAt/expiresAt` in the written file (not in stdout).
- Parity test cases:
  - SAFE `onchainos agent autotrade-guide-consent-new --job-id job1 --values-json '{}'` on empty home → `service guide is not available locally: No such file or directory (os error 2)` (platform text varies).
  - SAFE `… --ttl-sec 0` → `--ttl-sec must be > 0`.
  - SAFE with a seeded `A/guide/job1.md` → created:true; a second identical call → `active Guide Consent already exists; …`.

### `onchainos agent subscription-execution-config-set`  (hidden: no)
- Handler: task/user/mod.rs:415 `handle_subscription_execution_config_set` (dispatched first thing in `run_task`,
  mod.rs:1829, before any `TaskApiClient` is built); storage in subscription_config.rs (§10).
- Options: `--service-id <S>` required; `--execution-mode <S>` required (validated in handler); `--replace` bool flag.
- Auth: jwt-required (indirect: needs a logged-in wallet session for the spawned `get-my-agents`).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `create::resolve_user_agent()` (task/user/create.rs:236, owned by user group): `current_account_xlayer_address()`
     from local wallet store (else `no current XLayer address`) → spawn `<current_exe> agent get-my-agents
     --owner-address <addr> --role user --page-size 100` (child does `GET /priapi/v5/wallet/agentic/agent/agent-list`
     with JWT and runs §1 itself) → first agent with `role == 1` → `agentId` string. Errors: `the current account has no
     user identity; run `onchainos agent create --role user` first`, `agent is missing the agentId field`,
     `` `get-my-agents` returned failure: … ``.
  3. `select_subscription_agent_id(agentId, "")` → trimmed non-empty else `agenticId is required for subscription
     requests`.
  4. Parse `--execution-mode` (§10) — note this happens **after** the network lookup.
  5. `save_execution_mode(agentId, serviceId, mode, replace)` (§10).
- Output: `data` (sorted): `{"agentId":"…","executionMode":"signal_only|guide_direct","outcome":"created|repaired|replaced","serviceId":"…","storage":"local"}`.
- Errors: exit 1 (messages above / §10).
- Side effects: read (server GET via the spawned subprocess) + local write of the preference file.
- Nondeterminism: `updatedAtMs` in file.
- Parity test cases:
  - SAFE (logged in) `onchainos agent subscription-execution-config-set --service-id svc-1 --execution-mode signal_only` → created; rerun → `subscription automatic-copy preference is already signal_only; use --replace only after a new user confirmation`.
  - SAFE rerun with `--execution-mode guide_direct --replace` → replaced.
  - SAFE `--execution-mode auto` (logged in) → `--execution-mode must be signal_only or guide_direct`.
  - SAFE `--service-id ../x` → `invalid subscription AgentId or ServiceId`.

### `onchainos agent autotrade-consent-request`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2107.
- Options (all required strings): `--job-id`, `--agent-id` (ignored), `--delivery-id`, `--signal-type` (ignored).
- Auth: anonymous (local + okx-a2a IPC).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `executor::report_delivery(job, delivery, "skipped", "guide_execution_unavailable")?` (full algorithm under
     `autotrade-delivery-report`).
  3. `okx_a2a::mark_retired_autotrade_mode_decisions_handled(job)` (§5; result ignored).
- Output: `data` built with `json!` ⇒ **all keys sorted, including inside `outcome`**:
  `{"decision":false,"decisionPushed":false,"deliveryId":"<d>","guidance":"The Signal remains saved for receive/display
  only. This retired Consent flow cannot authorize Guide-driven execution; do not create another execution
  decision.","jobId":"<j>","outcome":{"action":"","amount":"","createdAt":…,"deliveryId":…,"executionMode":"auto",
  "jobId":…,"nextNotificationAttemptAt":…,"notificationAttempts":…,"notificationPending":…,"reason":…,"status":…,
  "updatedAt":…,"venue":"","version":1},"reason":"guide_execution_unavailable","status":"skipped","terminal":true}`
  (`outcome` may instead be a pre-existing outcome with other fields, e.g. `receipt`, `failureCategory`).
- Errors: those of `report_delivery` (exit 1).
- Side effects: local state (latch, outcome, journal, notice index, queue) + okx-a2a notify/trade-record/todo-check.
- Nondeterminism: timestamps; notification success depends on local okx-a2a.
- Parity test cases:
  - SAFE `onchainos agent autotrade-consent-request --job-id job1 --agent-id 7 --delivery-id d1 --signal-type trade` on empty home → `{"ok":false,"error":"trusted delivery context is unavailable: <os error>"}` exit 1.
  - SAFE with a seeded delivery-context (`executionPath:"agent_direct"`, no guide) → skipped outcome as above.

### `onchainos agent autotrade-delivery-report`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2198 → `executor::report_delivery` (executor.rs:2182).
- Options (all required strings): `--job-id`, `--delivery-id`, `--status` (`skipped|failed_before_execution`),
  `--reason` ("Concise user-safe reason; command output and credentials are forbidden").
- Auth: anonymous.
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `load_delivery_context(job, delivery)`; every failure is wrapped by the context
     `trusted delivery context is unavailable`, giving e.g. `trusted delivery context is unavailable: invalid job id`,
     `…: invalid delivery id` (delivery id must be 1..=96 bytes `[A-Za-z0-9_:-]`), `…: <io error>` (missing file),
     `…: <serde error>` (bad JSON / unknown field), `…: delivery context mismatch` (`version∉1..=2` or ids differ).
     The same wrapping applies to guide-prepare, direct-claim, direct-finalize and once-authorize.
  3. Status: `skipped` / `failed_before_execution`, else `delivery report status must be skipped or
     failed_before_execution`.
  4. `contract_unavailable = context.executionPath=="agent_direct" && !guide::has_active_execution_contract(job)`.
     If `contract_unavailable` or the reason (lower-cased) contains `active execution consent`, `automatic execution
     consent`, `copy-trade consent` or `auto-trade consent` → status := `skipped`, reason :=
     `guide_execution_unavailable`; else reason := `safe_text(reason)` (§4).
  5. `outcome_path` → `invalid job or delivery id` (1..=128 `[A-Za-z0-9_:.-]`).
  6. `reserve_execution`: create `A/execution-latch/<job>/<delivery>` with O_EXCL: `{version:2,jobId,deliveryId,
     phase:"reserved",updatedAt}` (fsync).
     - Already existed: if an outcome exists → if its reason is a retired consent reason, or (`contract_unavailable` and
       its status is `failed_before_execution`) rewrite it as `skipped`/`guide_execution_unavailable` with
       `notificationPending=true`, attempts 0, next 0, `updatedAt=now`; if pending → `notify_and_persist(…,false,5 s)`;
       return it (idempotent). No outcome → `delivery already reserved without a terminal outcome`.
  7. New: `persist_and_notify` (§6.5) with `{version:1, jobId, deliveryId, venue:"", action:"", amount:"",
     executionMode:"auto", status, reason, notificationPending:true, notificationAttempts:0,
     nextNotificationAttemptAt:0, createdAt:now, updatedAt:now}`.
- Output: `data` = `ExecutionOutcome` in **struct order** (§6.1), e.g. `{"version":1,"jobId":"j","deliveryId":"d",
  "venue":"","action":"","amount":"","executionMode":"auto","status":"skipped","reason":"…",
  "notificationPending":false,"notificationAttempts":0,"nextNotificationAttemptAt":0,"createdAt":…,"updatedAt":…}`
  (after a successful notify `notificationPending:false`; after a failed first attempt
  `notificationPending:true,notificationAttempts:1,nextNotificationAttemptAt:now+60`).
- Errors: exit 1 as above. stderr may carry `[autotrade] …` diagnostics (§6.5).
- Side effects: local state + okx-a2a `user notify` (key `autotrade-outcome:…`), `trade-records insert`, possible
  `session send` resume of the next queued delivery.
- Nondeterminism: timestamps, notification outcome.
- Parity test cases:
  - SAFE `onchainos agent autotrade-delivery-report --job-id job1 --delivery-id d1 --status skipped --reason test` on empty home → context-unavailable error.
  - SAFE `… --status done …` with seeded context → `delivery report status must be skipped or failed_before_execution`.
  - SAFE seeded legacy_wrapper context: `--status failed_before_execution --reason "  a   b "` → reason `a b`; second identical call returns the same stored outcome.

### `onchainos agent autotrade-guide-prepare`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2149 → `executor::prepare_guide_direct` (executor.rs:1726).
- Options: `--job-id`, `--delivery-id` (required strings).
- Auth: jwt-required for a `ready` result (soft: auth/network failures become `ready:false`).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `load_delivery_context` (context `trusted delivery context is unavailable`) — hard error.
  3. `executionPath != agent_direct` → `delivery is pinned to the legacy execution wrapper` (hard).
  4. `savedPath` not a regular file → `saved subscription Signal is not available` (hard).
  5. `require_guide_direct_subscription(job, ctx)` (§6.11: GET subscribe, provider match, Guide restore via
     service-list subprocess if missing, legacy consent migration, subscription-config check). Any error →
     `reason = error.to_string()` (**outermost message only**, no cause chain).
  6. If step 5 ok and `has_active_execution_contract(job)` → ready; if ok but no contract → reason `active local
     Service Guide and Guide Consent are required`.
- Output (struct order): `{"ready":bool,"status":"ready"|"not_ready","jobId","deliveryId","reason"?}`.
- Errors: steps 2-4 exit 1; everything else is data.
- Side effects: read (HTTP GET) + local writes (guide file, migrated consent, subscription-config). Never creates a
  latch.
- Nondeterminism: server subscription state.
- Parity test cases:
  - SAFE empty home → context error.
  - SAFE seeded agent_direct context + existing saved file, not logged in → `{"ready":false,"status":"not_ready",…,"reason":"subscription is no longer Active"}`.
  - SAFE (logged in, active subscription, mode signal_only) → reason `automatic copy-trading is not enabled for this subscription`.

### `onchainos agent autotrade-direct-claim`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2139 → `executor::claim_guide_direct` (executor.rs:1762).
- Options: `--job-id`, `--delivery-id` (required).
- Auth: jwt-required.
- Steps:
  1. §1 pre-dispatch maintenance.
  2-4. As guide-prepare steps 2-4 (hard errors).
  5. `require_guide_direct_subscription(job, ctx)?` — errors are **fatal** here (full `{e:#}` chain, e.g.
     `subscription is no longer Active`, `service guide is not available locally: …`).
  6. `!has_active_execution_contract(job)` → `active local Service Guide and Guide Consent are required`.
  7. Outcome exists → `{allowed:false,status:"terminal",…,reason:"delivery already has a terminal outcome"}`.
  8. Create latch with O_EXCL: `{version:2,jobId,deliveryId,phase:"spawned",updatedAt,directExecutionMode:"auto"}`;
     exists → `{allowed:false,status:"already_claimed",…,reason:"an earlier Guide-driven execution may have started;
     do not retry"}`.
  9. Success → `record_signal_status(job, delivery, "claimed", "", savedPath)` (okx-a2a trade-records insert, errors
     ignored) and return `{allowed:true,status:"claimed",jobId,deliveryId}`.
- Output (struct order): `{"allowed":bool,"status":"claimed|terminal|already_claimed","jobId","deliveryId","reason"?}`
  (`amount` is always omitted for Guide-direct claims).
- Errors: exit 1 for steps 2-6.
- Side effects: read (HTTP GET subscribe) + local latch (the exactly-once gate). **Not fund-moving itself**, but it is
  the authorization immediately preceding an external fund-moving tool call made by the agent; a claimed latch is
  permanent (a crash after claim is reported later as `unknown_after_submit`).
- Nondeterminism: server state, timestamps.
- Parity test cases:
  - SAFE empty home → context error.
  - UNSAFE (prepares a real trade) logged-in active guide_direct subscription with seeded guide+consent → claimed; repeat → already_claimed.

### `onchainos agent autotrade-direct-finalize`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2160 → `executor::finalize_direct` (executor.rs:1819).
- Options: `--job-id`, `--delivery-id`, `--status` (`submitted|failed_before_submit|unknown_after_submit`),
  `--tool-id` (all required); `--receipt-id` optional (required for `submitted`); `--reason` optional.
- Auth: anonymous.
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `load_delivery_context` (context `trusted delivery context is unavailable`).
  3. Not `agent_direct` → `delivery is pinned to the legacy execution wrapper`.
  4. `!safe_metadata_token(tool_id,128)` → `direct execution tool id is invalid`.
  5. Outcome exists → if pending `notify_and_persist(…,false,5 s)`; return existing (idempotent; new args ignored).
  6. Latch missing → `direct execution was not claimed`; latch parse / version∉1..=2 / id mismatch → error
     (`execution latch mismatch` or serde text).
  7. `amount = latch.directAmount or ""`; `executionMode = latch.directExecutionMode` else `direct execution claim mode
     is unavailable`.
  8. Status: `submitted` → receipt required (`submitted direct execution requires a receipt id`), must pass
     `safe_metadata_token(…,256)` (`direct execution receipt id is invalid`), `receipt={"receiptId":…}`, reason
     omitted (`--reason` ignored); `failed_before_submit` → reason `safe_child_text(reason or "selected tool rejected the
     trade before submission")`; `unknown_after_submit` → `safe_child_text(reason or "selected tool returned an unknown
     submission state")`; other → `direct execution status must be submitted, failed_before_submit, or
     unknown_after_submit`.
  9. `failureCategory` per §6.16 (only for `tool_id=="trade_kit"`).
  10. `persist_and_notify` with `venue="agent_direct/<tool_id>"`, `action="execute"`.
- Output: `ExecutionOutcome` (struct order).
- Errors: exit 1.
- Side effects: local state + okx-a2a notify / trade-record / queue advance. Records (does not perform) a trade result.
- Nondeterminism: timestamps, notification.
- Parity test cases:
  - SAFE empty home → context error.
  - SAFE seeded agent_direct context + guide-direct latch: `--status submitted --tool-id okx-cex-trade --receipt-id order:123` → `venue:"agent_direct/okx-cex-trade"`, `receipt:{"receiptId":"order:123"}`, `amount:""`; replay with `failed_before_submit` returns the submitted outcome.
  - SAFE `--status failed_before_submit --tool-id trade_kit --reason "Error: Failed to spawn okx-auth"` → `failureCategory:"authentication_required"`.
  - SAFE `--reason "apiKey=abc token: x Bearer eyJ…"` → redaction per §4.

### `onchainos agent autotrade-once-authorize`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2180 → `executor::authorize_one_time` (executor.rs:672).
- Options: `--job-id`, `--delivery-id`, `--amount` (required strings).
- Auth: anonymous.
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `load_delivery_context` (context `trusted delivery context is unavailable`).
  3. `load_pending_delivery_context(job)?` None → `no delivery is awaiting a one-time execution decision`; must be
     exactly equal (all fields) to the context and match the delivery id → else `one-time authorization does not match
     the pending delivery`.
  4. Latch exists → `delivery already has a terminal execution outcome`.
  5. Amount: `Decimal::parse` (context `invalid one-time execution amount`) → plain string; `"0"` → `one-time execution
     amount must be positive`.
  6. Legacy consent `load_consent(job)` → ConsentError code as message (e.g. `consent_unreadable` — which is what a
     current Guide Consent file yields); none → `auto-trade consent is missing or expired`; mode≠auto →
     `one-time over-cap authorization requires an active auto policy`; no capU → `auto-trade cap is missing`;
     `amount ≤ cap` → `one-time authorization is only valid for an amount above the current cap`.
  7. Existing permit: same live one → return it; different live → `a different live one-time permit already exists for
     this delivery`; expired → delete. Create O_EXCL (dir 0700, file 0600; failure → `one-time permit was concurrently
     replaced`) pretty `{version:1,jobId,deliveryId,amount,createdAt:now,expiresAt:now+900}`.
- Output (struct order): `{"version":1,"jobId","deliveryId","amount","createdAt","expiresAt"}`.
- Errors: exit 1. In practice unreachable success in the current release (no legacy consent writer).
- Side effects: local-only.
- Nondeterminism: timestamps.
- Parity test cases: SAFE empty home → context error; SAFE seeded context without pending pointer → `no delivery is awaiting a one-time execution decision`.

### `onchainos agent autotrade-outcome-flush`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2193 → `executor::flush` (§6.13).
- Options: `--job-id` required.
- Auth: anonymous.
- Steps: §1; `invalid job id`; iterate `A/outcomes/<job>/` (≤32 entries, filesystem order) forcing pending
  notifications (3 attempts each); then flush the job's degrade-notice outbox (force).
- Output: `data` = array of `ExecutionOutcome` (struct order) — `[]` when the directory is absent.
- Errors: exit 1 (`invalid job id`, unreadable/unsupported outcome files).
- Side effects: local state + okx-a2a notify. Never retries a trade.
- Nondeterminism: array order = directory order; notification results.
- Parity test cases: SAFE `onchainos agent autotrade-outcome-flush --job-id job1` on empty home → `{"ok":true,"data":[]}`; SAFE `--job-id a/b` → `invalid job id`.

### `onchainos agent autotrade-cap-adjust-request`  (hidden: yes)
- Handler: commands/agent_commerce/mod.rs:2213.
- Options: `--job-id`, `--agent-id` (required).
- Auth: anonymous (local + okx-a2a).
- Steps:
  1. §1 pre-dispatch maintenance.
  2. `consent::load_consent(job)?` (legacy fixed-field consent, §9) — ConsentError text (`consent_unreadable`,
     `consent_version_too_new`, `consent_job_mismatch`); none → `no live auto-trade consent`.
  3. mode≠auto → `cap adjustment is only valid for auto consent`.
  4. `amount = tradeAmountU or ""`, `cap = capU or ""`; `Decimal::parse(amount)?` (`empty amount` / `invalid decimal
     string` / `amount arithmetic overflow`).
  5. If `evaluate_consent(job, Some(amount)) == AutoOverCap` (amount > cap or cap missing/unparseable):
     `d = make_cap_adjust_decision("trade", job, agent, amount, cap)` — `deliveryId:"cap_adjust"`, `signalType:"trade"`,
     `sourceEvent:"autotrade_cap_adjust"`, `userContent` = optional summary (§9) + En `[Decision] This {amount} U trade
     succeeded. Raise the future per-trade limit from {cap} U to {amount} U?\n  A. Raise it\n  B. Keep the current limit`
     / Zh `[请确认] 本次 {amount} U 交易已成功。是否把后续每笔上限从 {cap} U 调整为 {amount} U?\n  A. 调高\n  B. 保持原上限`;
     `command` = `onchainos agent pending-decisions-v2 request --job-id {job} --role user --agent-id {agent}
     --source-event autotrade_cap_adjust --list-label "[Auto Copy-Trade cap] trade" --user-content "<userContent
     verbatim — already in the user's language>"`; `guidance` = `Do NOT execute any trade and do NOT read the
     deliverable. 🌐 `userContent` is already rendered in the user's language (per-job language marker) — put it into
     the command's --user-content verbatim; do NOT re-translate or reword it, and never change the option letters or any
     number. Then run the command to push the decision. Act on the trade only after the user answers.`
     Then `pending_v2::push_decision_direct(job,"user",agent, pendingPointer?.providerAgentId, userContent,
     "[Auto Copy-Trade cap] trade","autotrade_cap_adjust")`.
- Output: push ok → `{"decision":true,"decisionPushed":true,"sourceEvent":"autotrade_cap_adjust"}`; push failed →
  the full `DecisionRequest` (struct order, §9); not over cap → `{"capAlreadySufficient":true}`.
- Errors: exit 1 as above.
- Side effects: local-only + okx-a2a decision push.
- Nondeterminism: language marker; pending pointer contents.
- Parity test cases: SAFE empty home → `{"ok":false,"error":"no live auto-trade consent"}`; SAFE with a Guide
  Consent `.md` present → `{"ok":false,"error":"consent_unreadable"}`.

### `onchainos agent autotrade-grant-write`  (hidden: yes — **debug builds only**)
- Handler: commands/agent_commerce/mod.rs:2089 (`#[cfg(debug_assertions)]`) → `grants::write_grant` (grants.rs:197).
- Present only in debug builds; the release binary rejects it as an unrecognized subcommand (clap, exit 2).
- Options: `--job-id`, `--venue`, `--ttl-sec <u64>` required; `--max-buy`, `--max-sell` optional.
- Auth: anonymous.
- Steps: §1; `invalid job id`; venue canonical (`invalid venue (must be dex|hyperliquid|defi|polymarket|trade_kit)`);
  `--ttl-sec must be > 0`; `at least one of --max-buy / --max-sell is required`; caps must parse (`--max-buy is not a
  valid decimal` / `--max-sell is not a valid decimal`); write pretty grant file with a single venue entry
  `{maxBuy, maxSell}` (unset side = `null`), `createdAt=now`, `expiresAt=now+ttl`.
- Output: `{"ok":true}` (`success_empty`).
- Side effects: local-only. Parity: release binary → clap error.

### `onchainos agent autotrade-consent-set`  (hidden: n/a — **not compiled**)
- Its clap variant does not exist; the handler (mod.rs:2288-2579) and `auto_write_continuation_id` (mod.rs:3134) are
  under `#[cfg(any())]`, i.e. removed at compile time. The binary answers `onchainos agent autotrade-consent-set …`
  with clap's "unrecognized subcommand" error (exit 2). Strings elsewhere (continuation `consentCommand`, flow
  playbooks, user/mod.rs:1148) still mention it; a port must **not** implement it for parity.
- For reference only (dead): modes `pause | environment-set | settings-update | plugin-ready-check | plugin-approved |
  cap-adjust | auto | notify_only(=manual|decline)`; `auto` required a live continuation permit and wrote consent +
  `write_auto_grant` (all four venues with null caps).

---

## Endpoint classification

| Method + path | Class | Used by |
|---|---|---|
| `GET /priapi/v1/aieco/task/subscribe/{jobId}` (query `sessionCert` if present; headers JWT + `agenticId`) | read | autotrade-guide-prepare, autotrade-direct-claim (also flow_lifecycle, other group) |
| `GET /priapi/v5/wallet/agentic/agent/services` (indirect: spawned `onchainos agent service-list`) | read | autotrade-guide-prepare, autotrade-direct-claim (only when the local Guide is missing) |
| `GET /priapi/v5/wallet/agentic/agent/agent-list` (indirect: spawned `onchainos agent get-my-agents`) | read | subscription-execution-config-set |
| core token refresh inside `ensure_tokens_refreshed` (owned by auth group) | auth | any JWT call above |

No state-changing or fund-moving HTTP endpoint is called by this partition.

## External hosts / programs

- No HTTP host other than the OKX base URL (`endpoints::base_url()`, prod host `web3.okx.com`; core DoH failover
  applies to the subscribe GET).
- Local programs (not network hosts): `okx-a2a` (npm `@okxweb3/a2a-node`; notify / session send / trade-records /
  outdated-list / check), `okx` (npm `@okx_ai/okx-trade-cli`; only `list-tools --json`), and the onchainos binary
  itself (`agent service-list`, `agent get-my-agents`).

## Open questions

1. Several error messages embed serde_json error text verbatim (e.g. `--values-json must be a JSON object: invalid
   type: sequence, expected a map at line 1 column 1`, latch/context/outcome parse failures). A Node port must
   reproduce serde_json's wording and line/column conventions or the harness must normalise them.
2. `std::io::Error` text differs per OS (`No such file or directory (os error 2)` vs. Windows `(os error 2)` /
   `(os error 3)` wording) in `trusted delivery context is unavailable: …`, `service guide is not available locally:
   …`, etc.
3. Ordering that depends on `std::fs::read_dir` (filesystem order): the `autotrade-outcome-flush` array order, the
   32-entry cap (applied before the `.json` filter), and which job/notice the pre-dispatch maintenance processes first.
   Node's `readdir` ordering may differ.
4. `okx_a2a::user_notify_scoped*` and `session_send*` spawn bare `okx-a2a` via `Command::new` (no `cmd /C`), so on
   Windows with only an npm `.cmd` shim they fail and notices stay pending; `trade_records_insert` and the
   outdated-list/check helpers use `cmd /C`. Should the port reproduce this platform asymmetry?
5. `executor::flush_all_due` deletes the lease of an index entry whose outcome is still pending but not yet due
   (its own `nextNotificationAttemptAt` in the future) without recreating the index, so that notice is only retried by
   an explicit `autotrade-outcome-flush`. Reproduce as-is?
6. Two on-disk formats share `A/consent/<jobId>.md` with the same `<!-- onchainos-autotrade:consent` marker (legacy
   fixed-field `ConsentFile` vs. `GuideConsentFile`). With a Guide Consent present, `autotrade-cap-adjust-request` and
   `autotrade-once-authorize` fail with `consent_unreadable`; with no legacy writer in the release binary they can
   essentially never succeed. Confirm the lite should keep this (dead-end) behaviour.
7. `autotrade-grant-write` (debug-only) and `autotrade-consent-set` (`#[cfg(any())]`) do not exist in the release
   binary; strings in other playbooks still reference `autotrade-consent-set`. Parity implies both must be absent.
8. The subscribe GET's envelope handling (non-zero `code`, HTTP 404, invalid-token retry, DoH failover) is owned by
   core `WalletApiClient`; this partition collapses every failure to `subscription is no longer Active`.
9. Aggregate readiness in `trade-kit-readiness` uses Rust `max_by_key`, which returns the **last** maximal element on
   ties (affects `reason` when two classes share the same state with different reasons, e.g. none today, but
   `incompatible` can be `upgrade_required` vs `capability_missing` only in separate code paths).

## Notes for the Node lite port (auth / login)

- Only `autotrade-guide-prepare`, `autotrade-direct-claim` and `subscription-execution-config-set` need the onchainos
  login (JWT + optional sessionCert + agent identity). They should reuse the same login flow/session store as the
  main onchainos wallet login; all other commands in this group work on local state alone.
