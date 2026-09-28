# g10-ws-watch-mcp-workflow — upstream behaviour spec (onchainos 4.6.3, commit 9de8161)

Scope: `onchainos ws *` (incl. hidden `ws run-daemon`), the watch daemon/store (`src/watch/`), the MCP **server** (`onchainos mcp`, `src/mcp/mod.rs`), the MCP **client** transport used by payment (`src/mcp_client.rs`), `onchainos workflow *`, `onchainos upgrade`, `onchainos preflight`.

## Sources read

Partition files (all read fully, including in-file `#[cfg(test)]` modules):

| file | lines |
|---|---|
| `cli/src/commands/ws.rs` | 751 |
| `cli/src/watch/mod.rs` | 3 |
| `cli/src/watch/daemon.rs` | 459 |
| `cli/src/watch/store.rs` | 387 |
| `cli/src/watch/types.rs` | 246 |
| `cli/src/mcp/mod.rs` | 2980 |
| `cli/src/mcp_client.rs` | 732 |
| `cli/src/commands/workflows/mod.rs` | 151 |
| `cli/src/commands/workflows/token_research.rs` | 514 |
| `cli/src/commands/workflows/smart_money.rs` | 463 |
| `cli/src/commands/workflows/new_tokens.rs` | 434 |
| `cli/src/commands/workflows/wallet_analysis.rs` | 230 |
| `cli/src/commands/workflows/portfolio.rs` | 177 |
| `cli/src/commands/upgrade.rs` | 82 |

Supporting files read (only the parts the partition calls into; behaviour owned elsewhere is only named):
`cli/src/main.rs` (316, full), `cli/src/commands/mod.rs` (134, full — `Context`), `cli/src/endpoints.rs` (65, full), `cli/src/output.rs` (450, full), `cli/build.rs` (full), `cli/.env` (3 lines), `cli/Cargo.toml` (full), `cli/Cargo.lock` (serde_json / rmcp entries), `cli/src/config.rs` (1-70), `cli/src/home.rs` (`onchainos_home`), `cli/src/commands/sink.rs` (86-143 `parse_duration_ms`), `cli/src/chains.rs` (`resolve_chain`, `resolve_chains`), `cli/src/client.rs` (150-610: envelope, auth resolution, headers, GET/POST), `cli/src/commands/token.rs` (565-1180), `cli/src/commands/signal.rs` (`fetch_list`), `cli/src/commands/memepump.rs` (`fetch_by_address`, `MemepumpTokenListParams`), `cli/src/commands/market.rs`, `cli/src/commands/portfolio.rs`, `cli/src/commands/tracker.rs` (fetch fns), `cli/src/commands/social.rs` (param structs), `cli/src/commands/cross_chain.rs` (paths, `resolve_order_id_to_tx_hash`), `cli/src/commands/agentic_wallet/gas_station.rs` (295-355), `cli/src/wallet_api.rs` (gas-station paths), `cli/src/audit.rs` (`log`, `cli_command_name`, `ws_sub`, `workflow_sub`), `cli/src/commands/payment/quote.rs` (85-260), `cli/src/commands/payment/payment_flow.rs` (1945-2110).
Test oracles read: `cli/tests/cli_ws.rs` (180), `cli/tests/mcp_server.rs` (969), `cli/tests/cli_workflows.rs` (426), `cli/tests/cli_upgrade.rs` (25), `cli/tests/cli_preflight.rs` (27), `cli/tests/common/mod.rs` (token constants).
External reference checked (rmcp 1.3.0 is the locked version, Cargo.toml asks `1.1.1`): docs.rs sources for `rmcp::model` (ProtocolVersion, InitializeResult, Implementation, Tool, ServerCapabilities), `handler/server.rs`, `handler/server/tool.rs`, `handler/server/router/tool.rs`, `handler/server/common.rs`, `service/server.rs`.

---

## Global output rules that apply to every command in this partition (owned by core, summarised because byte-parity depends on them)

1. **Envelope** (`output::success`, output.rs:44): `println!` of struct `JsonOutput{ok, data?, error?, notifications?}` → field order is `ok`, `data`, (`error`), (`notifications` only when non-empty). One line, terminated by `\n`. Compact (`serde_json::to_string`) unless env `ONCHAINOS_PRETTY=1` → `to_string_pretty` (2-space indent).
2. **Object key order inside `data` is alphabetical (byte order).** `serde_json` in the lockfile has no `indexmap` dependency → feature `preserve_order` is OFF → every `serde_json::Value`/`json!{}` object is a `BTreeMap`. This applies to (a) all `json!` literals built in this partition, (b) all passthrough API data (server objects are re-ordered alphabetically), (c) JSON bodies POSTed to the API (e.g. signal list body is `{"chainIndex":..,"limit":..,"tokenAddress":..}`), (d) WebSocket frames sent by the daemon, (e) events persisted to `events.*.jsonl`. Structs serialize in declaration order (WatchConfig, rmcp protocol structs).
3. Numbers from passthrough data are re-serialized by serde_json: integers kept exactly (i64/u64), floats as f64 printed with shortest round-trip repr (e.g. `1.0` stays `1.0`, `1e-7` → `1e-7`, `1.5e20` → `1.5e20`). A JS reimplementation must preserve raw number text to match (JSON.stringify would print `1`, `150000000000000000000`).
4. **Errors**: any `Err` from a handler reaches `main.rs` (316 lines) → `output::error(format!("{e:#}"))` → stdout `{"ok":false,"error":"<anyhow chain joined by ': '>"}` and **exit code 1**. (Special error types `CliConfirming`→exit 2, `CliSetupRequired`→exit 3, `CodedError`, etc. are never produced by this partition's own code.) Clap parse errors (unknown flag, missing required flag, bad number) → clap's own usage text on stderr, exit 2.
5. **Audit**: after every non-`mcp` command `audit::log("cli", <name>, ok, elapsed, redacted_args, err)` appends to `<ONCHAINOS_HOME>/audit.jsonl` (0600). Names: `ws channels|channel-info|start|poll|stop|list|run-daemon`, `workflow token-research|smart-money|new-tokens|wallet-analysis|portfolio`, `upgrade`, `preflight`. `mcp` skips audit entirely.
6. Every invocation (except `mcp`) runs `home::self_heal_permissions()` (unix chmod of sensitive files) and `Context::new` → `AppConfig::load()` (reads `<ONCHAINOS_HOME>/config.json`, migrating a stale `./.onchainos/config.json` from cwd with a stderr notice). `ONCHAINOS_HOME` env (non-empty) overrides `~/.onchainos`.

## Auth mechanisms used in this partition (for the lite "same login flow" requirement)

- **WebSocket (`ws start` / `ws run-daemon`)**: *not* the wallet login. Uses OKX API-key credentials from process env: `OKX_PROD_API_KEY`, `OKX_PROD_SECRET_KEY`, `OKX_PROD_PASSPHRASE` (for `--env prod`) or `OKX_PRE_API_KEY`, `OKX_PRE_SECRET_KEY`, `OKX_PRE_PASSPHRASE` (for `--env pre`). Login frame signed with HMAC-SHA256 (details under `ws run-daemon`). The same WS URL is used for both envs (only the credential set differs).
- **Workflows**: `Context::client_async()` → `ApiClient::new_async()` (client.rs:246): JWT-optional. Access token from keyring key `access_token`; if expired and `refresh_token` valid → `wallet_api::force_refresh_access_token()` (auth endpoint, owned by wallet group); refresh token expired → stderr `Session expired. Please log in again: onchainos wallet login` and anonymous; refresh failure → stderr `Failed to refresh session (<e>). Falling back to anonymous access.` Headers: `Content-Type: application/json`, `ok-client-version`, `Ok-Access-Client-type: agent-cli`, `platform: agent-cli`, `device-id` (if available), `device-name`, plus `Authorization: Bearer <jwt>` when logged in. On an invalid-token error with JWT, force-refresh + retry once. x402 auto-pay (402 → sign → retry) lives in ApiClient (core/payment group).
- **MCP server**: `ApiClient::new()` (sync, client.rs:207) created once at startup: JWT from keyring if non-empty (no expiry check), else anonymous; shared across all tool calls behind a tokio `Mutex` (calls serialize). Some tools build their own `WalletApiClient` (payment_*, gas_station_*, `cross_chain_status` with `order_id`) which require wallet login.
- **MCP client (`mcp_client.rs`)**: no auth of its own; only the x402 payment header on the signed replay.

---

## Shared helpers (used across groups or from core)

### Watch store (`src/watch/store.rs`) — on-disk layout under `<ONCHAINOS_HOME>/watch/<id>/`

| file | writer | format |
|---|---|---|
| `config.json` | `ws start` (`init_watch_dir`) | `serde_json::to_string_pretty(WatchConfig)` — 2-space indent, no trailing newline, written to `.config.json.tmp` then renamed |
| `pid` | `ws start` (child pid) and daemon at boot (own pid) | decimal pid, no newline |
| `status` | daemon, `ws stop` | `"<state>|<unix_ms>"` or `"<state>|<unix_ms>|<reason>"`, no newline, via `.status.tmp` + rename |
| `cursor.<channel>` | `ws poll`, `ws stop --flush` | `"<file_no>|<byte_offset>"`, via `.cursor.<channel>.tmp` + rename |
| `events.<channel>.<N>.jsonl` | daemon | one compact JSON object per line + `\n`; N ∈ {0,1,2}; 0 = current |
| `daemon.log` | daemon stderr | plain text, append mode, created 0600 on unix |

- `fn watch::store::watch_root` (store.rs:16) → `onchainos_home()/watch`. `watch_dir(id)` (store.rs:21) → `watch_root()/id` (id is NOT sanitised).
- `fn watch::store::init_watch_dir(id, config)` (store.rs:47): `create_dir_all(dir)`; write pretty config to `.config.json.tmp`; rename to `config.json`. Returns dir.
- `fn watch::store::write_pid(dir, pid)` (store.rs:61) / `read_pid(id)` (store.rs:66: read, trim, parse u32).
- `fn watch::store::write_status(dir, state, reason)` (store.rs:74): line = `state|now_ms` or `state|now_ms|reason`; atomic tmp+rename.
- `fn watch::store::read_daemon_state(id)` (store.rs:87): no `status` file → `Crashed`; else `DaemonState::from_status_line(content, now_ms())`.
- `fn watch::types::DaemonState::from_status_line(line, now)` (types.rs:213): `parts = line.trim().splitn(3,'|')`; `<2 parts` → Crashed; `parts[0]=="stopped"` → Stopped (no staleness check, reason dropped); ts = parts[1] parsed u64 (fail→0); `now - ts > 60000` → Crashed; `running`→Running, `disconnected`→Disconnected(parts[2] or `"unknown"`), `reconnecting`→Reconnecting, anything else (e.g. `config_corrupt`) → Crashed. `as_str`: `running|disconnected|reconnecting|stopped|crashed`. Rendered status string everywhere = `disconnected:<reason>` for Disconnected, else `as_str()`.
- `fn watch::store::read_config(id)` (store.rs:99): read + `serde_json::from_str::<WatchConfig>`; errors propagate (io error text e.g. `No such file or directory (os error 2)` / Windows `The system cannot find the file specified. (os error 2)`).
- `fn watch::store::read_cursor(dir, ch)` (store.rs:114): missing/unreadable → `{0,0}`; `trim().splitn(2,'|')`; 2 parts → each parsed (fail → 0); otherwise `{0,0}`.
- `fn watch::store::write_cursor(dir, ch, file_no, offset)` (store.rs:134): writes `file_no|offset` atomically. NOTE: writing a cursor updates its mtime, which is the daemon's "last poll" signal for idle timeout.
- `fn watch::store::append_events(dir, channel, events)` (store.rs:144): no-op if empty. If `events.<ch>.0.jsonl` exists and size ≥ 33554432 (32 MiB) → `rotate_files`: delete `events.<ch>.2.jsonl` if present, rename `.1`→`.2`, `.0`→`.1`. Then open `.0` create+append and write each event as `serde_json::to_string(event)` + `\n` (keys alphabetical). `channel` comes from the server push (`arg.channel`) and is not sanitised.
- `fn watch::store::read_events_from_cursor(dir, ch, limit)` (store.rs:198) → `PollResult{events, per_event_cursors, new_cursor}`. Algorithm:
  1. `cursor = read_cursor`; `path = events.<ch>.<cursor.file_no>.jsonl`.
  2. `rotated = !path.exists() || size(path) < cursor.offset`.
  3. If rotated: if `events.<ch>.<file_no+1>.jsonl` exists → `drain_file(that, cursor.offset, limit, events, None)` (tail of rotated file, no per-event cursors). Then `cursor = {file_no, 0}`.
  4. If `path` exists: `new_offset = drain_file(path, cursor.offset, limit - events.len(), events, Some(pec))`; if some events came from the rotated file, left-pad `pec` with `{file_no,0}` so indices align; `cursor.offset = new_offset`.
  5. `new_cursor = cursor`.
  - `drain_file` (store.rs:268): seek to offset; loop while `events.len() < limit`: `read_line` (bytes incl. `\n`); stop on EOF or a line not ending in `\n` (partial line left unread); `offset += n`; skip blank lines; `serde_json::from_str` — invalid JSON lines are skipped but still consumed; each parsed event pushes `{file_no parsed from path stem, offset-after-line}` into `pec`. Returns final offset. Note: the `limit` test counts all events in the vector (incl. rotated tail).
  - Quirk: file_no written back to cursor is always the `.0` file's number (0) in practice; if `.0` grows past the old offset before a poll after rotation, rotation is not detected and reading resumes mid-line in the new file (first partial line is consumed and dropped as invalid JSON).
- `fn watch::store::list_watches()` (store.rs:326): if root missing → `[]`; every entry of `watch/` whose name starts with `ws_` or `watch_` → `{id, state: read_daemon_state (error→Crashed), pid: read_pid.ok(), config: read_config.ok()}`; sorted by id (byte order).
- `fn watch::store::remove_watch_dir(id)` (store.rs:353): `remove_dir_all` if exists.
- `fn watch::store::now_ms()` (store.rs:363): unix ms (0 on clock error).
- `fn watch::store::last_poll_time(dir)` (store.rs:372): max mtime (unix ms) over entries whose name starts with `cursor.`; `None` if none.

### Watch types (`src/watch/types.rs`)

- `fn channel_pattern(ch)` (types.rs:19): `address-tracker-activity` → PerWallet; `price` | `price-info` | `trades` | any name starting with `dex-token-candle` → PerToken; `dex-market-new-signal-openapi` | `dex-market-memepump-new-token-openapi` | `dex-market-memepump-update-metrics-openapi` → PerChain; **anything else → Global** (unknown channel names are accepted and treated as Global).
- `fn is_tracker_channel(ch)` (types.rs:32): `kol_smartmoney-tracker-activity` or `address-tracker-activity`.
- `ALL_CHANNELS` (types.rs:47) — 9 entries in this order (name / group / pattern / description / params_hint / example):
  1. `kol_smartmoney-tracker-activity` / `signal` / Global / `KOL and smart money aggregated trade feed` / `(none)` / `onchainos ws start --channel kol_smartmoney-tracker-activity`
  2. `address-tracker-activity` / `signal` / PerWallet / `Trade feed for custom wallet addresses (up to 200)` / `--wallet-addresses addr1,addr2,...` / `onchainos ws start --channel address-tracker-activity --wallet-addresses 0xAAA,0xBBB`
  3. `dex-market-new-signal-openapi` / `signal` / PerChain / `Aggregated buy signal alerts from smart money/KOL/whale` / `--chain-index 1,501` / `onchainos ws start --channel dex-market-new-signal-openapi --chain-index 1,501`
  4. `price` / `market` / PerToken / `Real-time token price updates` / `--token-pair chainIndex:tokenAddress` / `onchainos ws start --channel price --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7`
  5. `dex-token-candle{period}` / `market` / PerToken / `Candlestick/K-line data (replace {period} with 1s,1m,5m,15m,1H,4H,1D, etc.)` / `--token-pair chainIndex:tokenAddress` / `onchainos ws start --channel dex-token-candle1m --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7`
  6. `price-info` / `token` / PerToken / `Detailed price with market cap, volume, liquidity, holders` / `--token-pair chainIndex:tokenAddress` / `onchainos ws start --channel price-info --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7`
  7. `trades` / `token` / PerToken / `Real-time trade feed for a token (every buy/sell)` / `--token-pair chainIndex:tokenAddress` / `onchainos ws start --channel trades --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7`
  8. `dex-market-memepump-new-token-openapi` / `trenches` / PerChain / `New meme token launches` / `--chain-index 501` / `onchainos ws start --channel dex-market-memepump-new-token-openapi --chain-index 501`
  9. `dex-market-memepump-update-metrics-openapi` / `trenches` / PerChain / `Meme token metric updates (market cap, volume, bonding curve)` / `--chain-index 501` / `onchainos ws start --channel dex-market-memepump-update-metrics-openapi --chain-index 501`
- Pattern rendering: `format!("{:?}", pattern).to_lowercase()` → `global`, `perwallet`, `pertoken`, `perchain`.
- `DEFAULT_CHANNELS` (types.rs:168) = `["kol_smartmoney-tracker-activity"]` (the `--channel` help text claims "Defaults to all known channels" — it does not).
- `struct TokenPair { chain_index: String, token_contract_address: String }` — serialized with snake_case keys in config.json; derives Ord (compare chain_index then address, byte order).
- `struct TradeEvent` (types.rs:139, camelCase): required strings `walletAddress`, `quoteTokenSymbol`, `quoteTokenAmount`, `tokenSymbol`, `tokenContractAddress`, `chainIndex`, `tokenPrice`, `marketCap`, `realizedPnlUsd`, `tradeType`, `tradeTime`; optional `trackerType: [u8]` (default None), optional `txHash: string`. Used only to *filter*; the raw event Value is what is returned.
- `struct WatchConfig` (types.rs:172), serialized field order: `channels: [string]`, `wallet_addresses: [string]` (default []), `token_pairs: [{chain_index, token_contract_address}]` (default []), `chain_indexes: [string]` (default []), `env: "pre"|"prod"`, `created_at: u64 ms`, `idle_timeout_ms: u64` (default 1800000 when missing on read).
  Example `config.json`:
  ```
  {
    "channels": [
      "kol_smartmoney-tracker-activity"
    ],
    "wallet_addresses": [],
    "token_pairs": [],
    "chain_indexes": [],
    "env": "prod",
    "created_at": 1727500000000,
    "idle_timeout_ms": 1800000
  }
  ```

### Watch daemon helpers (`src/watch/daemon.rs`)

- Constants: `HEARTBEAT_SECS=25`, `PONG_TIMEOUT_SECS=10`, `RECONNECT_DELAY_SECS=3`, `MAX_RECONNECT_ATTEMPTS=20`; login and subscribe-ack waits 10 s each; status heartbeat task every 10 s.
- `fn Credentials::from_watch_env(env)` (daemon.rs:31): reads env vars in order api key → secret → passphrase; first missing → error `"<VAR> is not set"` (e.g. `OKX_PROD_API_KEY is not set`). Empty-string values are accepted.
- `fn Credentials::sign(ts)` (daemon.rs:52): `base64_std( HMAC_SHA256(key = secret_key bytes, msg = ts + "GET" + "/users/self/verify") )`.
- `fn Credentials::login_msg()` (daemon.rs:60): `ts = unix seconds as decimal string`; returns compact JSON (keys alphabetical): `{"args":[{"apiKey":K,"passphrase":P,"sign":S,"timestamp":TS}],"op":"login"}`.
  Test vector: key `test-key`, secret `test-secret`, pass `test-pass`, ts `1700000000` → sign `0uAi5j594sWw9rkXI4knzlNhWDTrHUJBZExNMGGD2gs=` → `{"args":[{"apiKey":"test-key","passphrase":"test-pass","sign":"0uAi5j594sWw9rkXI4knzlNhWDTrHUJBZExNMGGD2gs=","timestamp":"1700000000"}],"op":"login"}`.
- `fn load_daemon_config(dir)` (daemon.rs:87): read error → `failed to read watch config: <path>: <io err>`; parse error → first writes status `config_corrupt|<ms>|config_corrupt`, then error `watch config is corrupt (<path>): <serde err>`.
- `fn run_daemon` / `connect_and_stream` / `wait_for_login_ack` / `wait_for_subscribe_acks` / `recv_pong` / `check_notice` — specified under `ws run-daemon`.
- `WS_URL` (`endpoints.rs:44`) = compile-time `ONCHAINOS_COMPILED_WS_URL` from `cli/.env` key `ONCHAINOS_WS_URL`, default `wss://wsdex.okx.com/ws/v6/dex` (build.rs:6). The current checkout's `cli/.env` sets `ONCHAINOS_WS_URL=ws://127.0.0.1:18899/ws/v6/dex` (local mock). Not affected by `--dev`; runtime env cannot override.

### Duration parser (owned by sink, used here)
- `fn commands::sink::parse_duration_ms(s, flag, allow_zero)` (sink.rs:86): `t = s.trim()`; `t=="0"` → 0 (allow_zero) ; suffix `d`→86400000, `h`→3600000, `m`→60000, `s`→1000 (checked in that order, lowercase only); no suffix → `invalid --<flag> '<s>'; use e.g. 300s, 30m, 24h, 7d`; number parsed as Rust `u64` (accepts leading `+`, no whitespace/sign `-`) else same message; n==0 → 0 when allow_zero else `invalid --<flag> '<s>'; duration must be positive`; overflow of n*mult → `--<flag> '<s>' overflows`. `<s>` is the original untrimmed input. `ws` uses flag `idle-timeout`, allow_zero=true.

### Workflow helpers
- `fn workflows::ok_or_null(r)` (workflows/mod.rs:89): `Ok(v)` → v; `Err` → JSON `null` (error swallowed silently, nothing on stderr).
- `fn workflows::token_research::is_launchpad_token(advanced)` (token_research.rs:260): true iff `advanced["protocolId"]` is a JSON **string** and non-empty (numbers, null, missing → false).
- `fn workflows::token_research::all_null(values)` (token_research.rs:268).
- `fn workflows::token_research::search_and_select(client, query, chain_index)` (token_research.rs:125) and `fetch_and_assemble(client, address, chain_index)` (token_research.rs:21) — shared by CLI and MCP; see command spec.
- `fn workflows::smart_money::extract_top_tokens(signals, n)` (smart_money.rs:172): input array, or object with `data` array, else `[]`. For each item: `addr = item.tokenContractAddress (string) || item.address (string)`; skip if absent/empty. `count = item.walletCount.as_u64() || item.addressCount.as_u64() || 0` (only JSON non-negative integers count; numeric **strings** give 0). Dedupe by addr: keep the row with strictly greater count (ties keep the first seen). Sort by count desc, then addr asc (byte order). Take n. Returns `[(addr, item)]`.
- `fn workflows::new_tokens::extract_top_tokens(list, n)` (new_tokens.rs:174): same array/`data` unwrapping and address rule; keeps API order; dedupe keeps first occurrence; stops at n.
- `fn workflows::*::assemble*` — pure JSON builders (shapes in command specs).

### MCP result wrappers (`src/mcp/mod.rs`)
- `fn mcp::ok(data)` (mod.rs:869): `events = payment_notify::drain_events()`; payload = `data` if no events else `{"data":data,"notifications":events}`; returns `Ok(output::to_agent_json(payload))` (compact unless `ONCHAINOS_PRETTY=1`). **Note: MCP success text is the bare `data` value, not the `{ok,data}` envelope.**
- `fn mcp::err(e)` (mod.rs:880): always drains notifications, then:
  - `WalletPreviewConfirming` → `{"confirming":true,"preview":..,"scene":..,["message"],["next"],["notifications"]}` (alphabetical in output).
  - `output::CliConfirming` → `{"confirming":true,["message"],["scene"],["next"],["notifications"]}` (empty message/next omitted).
  - `output::CliDuplicateSubscription` → `{"ok":false,"data":..,["notifications"]}`.
  - `sink::CodedError` → `{"ok":false,"error":msg,"errorCode":code,["errorField"],["data"],["nextSteps"],["notifications"]}`.
  - otherwise → text `format!("{e:#}")`, or `{"error":text,"notifications":[..]}` if events.
  All of these are returned as `Err(String)` → tool result with `isError: true`.

### MCP client transport (`src/mcp_client.rs`) — used by `payment quote` / `payment pay` (payment group owns the flows)
- `MCP_PROTOCOL_VERSION = "2025-06-18"`; error token prefix `endpoint_unreachable`; per-request timeout 30 s (own `reqwest::Client`, no OKX headers, no DoH).
- `fn url_looks_like_mcp(url)` (mcp_client.rs:72): lowercase; strip `scheme://`; cut at first `?`/`#`; trim trailing `/`s; true iff path ends with `/mcp` or `/sse` (test oracle: `/mcphammer` false, `HTTPS://API.EXAMPLE.COM/MCP` true, `/api/sse?token=x` true).
- `fn probe_signals_mcp(content_type, body)` (mcp_client.rs:90): true if content-type (lowercased) contains `text/event-stream`; else if body (left-trimmed) starts with `{` or `data:` → true iff it contains `"jsonrpc"`; else false.
- `fn coerce_arguments(params, input_schema)` (mcp_client.rs:111): for each `k: v` — non-string v passes through; string v coerced by `inputSchema.properties[k].type`: `integer`|`number` → JSON number via serde_json Number parse (failure → keep string; e.g. `"01234"` for type string stays string, `"5"` → 5), `boolean` → only exact `true`/`false` else string, `object`|`array` → JSON parse else string, other/none → string.
- `fn parse_streamable_body(body)` (mcp_client.rs:153): if left-trimmed body starts with `{` and parses to an object having `result` or `error` → it. Else scan lines: `line.trim()` starting with `data:` → rest trimmed, skip empty/unparseable, first JSON with `result` or `error` wins. Else error `endpoint_unreachable: no JSON-RPC result/error in MCP response`.
- `fn jsonrpc_result(env)` (mcp_client.rs:186): `error` present → `endpoint_unreachable: JSON-RPC error <code>: <message>` (code i64) or `endpoint_unreachable: JSON-RPC error: <message>` (message default `unknown JSON-RPC error`); else `result` or `endpoint_unreachable: JSON-RPC response missing result`.
- `fn http_error(stage, status, body)` (mcp_client.rs:216): body trimmed, first 500 chars; message `endpoint_unreachable: <stage> returned HTTP <status>` + (`: <body>` | `: <first500>…` when truncated | nothing when empty).
- `McpClient::send_rpc(id?, method, params)` (mcp_client.rs:273): `POST <url>`, headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Mcp-Session-Id: <sid>` if captured. Body built as `json!({"jsonrpc":"2.0","method":..})` + `id` (if Some) + `params` (if not null) → serialized alphabetically: `{"id":1,"jsonrpc":"2.0","method":"initialize","params":{...}}`. Transport error → `endpoint_unreachable: <reqwest err>`.
- `initialize()` (mcp_client.rs:307): id 1, params `{"capabilities":{},"clientInfo":{"name":"onchainos","version":"4.6.3"},"protocolVersion":"2025-06-18"}`; capture `Mcp-Session-Id` response header; non-2xx → `http_error("initialize",..)`; parse + unwrap result; then best-effort notification `{"jsonrpc":"2.0","method":"notifications/initialized"}` (no id, no params, response ignored).
- `list_tools()` (mcp_client.rs:331): id 2, `params:{}`; `result.tools[]` each deserialized to `{name (default ""), description?, inputSchema?}`; non-object entries skipped.
- `call_tool(tool, args)` (mcp_client.rs:360): id 3, `params {"arguments":args,"name":tool}`; challenge header = `PAYMENT-REQUIRED` else `WWW-Authenticate`; HTTP 402 → `Paid{header: header or whole body, body}`; other non-2xx → `http_error("tools/call",..)`; 2xx → `Free(result)`.
- `call_tool_signed(replay, header_name, signature)` (mcp_client.rs:392): id 4, same body shape, extra header `<header_name>: <signature>` (normally `PAYMENT-SIGNATURE`) plus session id; returns `(status, PAYMENT-RESPONSE header?, result)` where result = JSON-RPC result if parseable, else raw JSON, else raw text string. Never errors on non-2xx (caller maps 2xx→success, 402→pending, else failed).
- Session id is process-local; `payment quote` and `payment pay` each re-handshake.

### Upgrade helpers (`src/commands/upgrade.rs`)
- `fn discover_skill_paths_in(home)` (upgrade.rs:48): existing paths among `home/{.codex,.openclaw,.cursor,.config/opencode,.claude}/onchainos-skills` (in that order) followed by every sub-directory of existing dirs `home/{.agents/skills,.claude/skills,.codex/skills,.openclaw/skills,.cursor/skills}`; de-duplicated by canonical path.
- `pub(crate) fn is_skill_installed_in(home, skill_id)` (upgrade.rs:77): any discovered path whose final component == `skill_id` and that contains a regular file `SKILL.md`. Used by agent_commerce autotrade (other group).

### Core helpers named only (owned elsewhere)
- `ApiClient::get/post` (client.rs:442/590): GET query pairs with empty values are **dropped**, remaining pairs form-urlencoded in given order; POST body = the Value (alphabetical keys); response envelope `{code,msg,data}` → `data` when code is `"0"`/`0`, bare arrays pass through, else error `API error (code=<c>): <msg>` (code 50114 gets login hint). 10 s timeout, DoH failover, x402 auto-pay.
- `chains::resolve_chain(name)` (chains.rs:129): chain-cache (`chain_cache.json`) name match, then aliases (ethereum/eth→1, solana/sol→501, bitcoin/btc→0, bsc/bnb→56, polygon/matic→137, arbitrum/arb→42161, base→8453, xlayer/x layer/x-layer/okb→196, xlayer_test→1952, avalanche/avax→43114, optimism/op→10, fantom/ftm→250, sui→784, tron/trx→195, ton→607, linea→59144, scroll→534352, zksync→324, tempo→4217), else input unchanged. `resolve_chains` splits on `,`, trims each, resolves, joins with `,`.
- `Context::chain_index_or(default)` (commands/mod.rs:70): global `--chain` → else `config.default_chain` (if non-empty) → else `default`; resolved via `resolve_chain`. `Context::resolve_chains_or(explicit, default)` (commands/mod.rs:78): explicit value **verbatim (unresolved)** → else resolved global `--chain` → else `default` (ignores `default_chain`).
- `token::fetch_report`, `token::fetch_search/holders/top_trader/price_info/advanced_info/security/cluster_by_address/info`, `signal::fetch_list`, `memepump::fetch_by_address`, `market::fetch_portfolio_overview/recent_pnl`, `portfolio::fetch_all_balances/total_value`, `tracker::fetch_activities` — exact requests are listed inline in the workflow steps below.
- `payment_notify::drain_events()` (payment_notify.rs:74): takes pending payment notifications (x402 auto-pay events) — empty unless a charged endpoint was hit.

---

## Commands

### `onchainos ws channels`  (hidden: no)
- Handler: `commands/ws.rs:209` `ws_channels`
- Options: none of its own (global `--chain` accepted and ignored; hidden global `--dev` ignored).
- Auth: anonymous (no network).
- Steps: 1. Map `ALL_CHANNELS` (in registry order) to `{"channel","description","group","pattern"}`. 2. `output::success(array)`.
- Output (exact, compact, one line):
  `{"ok":true,"data":[{"channel":"kol_smartmoney-tracker-activity","description":"KOL and smart money aggregated trade feed","group":"signal","pattern":"global"},{"channel":"address-tracker-activity","description":"Trade feed for custom wallet addresses (up to 200)","group":"signal","pattern":"perwallet"},{"channel":"dex-market-new-signal-openapi","description":"Aggregated buy signal alerts from smart money/KOL/whale","group":"signal","pattern":"perchain"},{"channel":"price","description":"Real-time token price updates","group":"market","pattern":"pertoken"},{"channel":"dex-token-candle{period}","description":"Candlestick/K-line data (replace {period} with 1s,1m,5m,15m,1H,4H,1D, etc.)","group":"market","pattern":"pertoken"},{"channel":"price-info","description":"Detailed price with market cap, volume, liquidity, holders","group":"token","pattern":"pertoken"},{"channel":"trades","description":"Real-time trade feed for a token (every buy/sell)","group":"token","pattern":"pertoken"},{"channel":"dex-market-memepump-new-token-openapi","description":"New meme token launches","group":"trenches","pattern":"perchain"},{"channel":"dex-market-memepump-update-metrics-openapi","description":"Meme token metric updates (market cap, volume, bonding curve)","group":"trenches","pattern":"perchain"}]}`
- Errors: none (exit 0).
- Side effects: local-only (audit.jsonl append).
- Nondeterminism: none.
- Parity test cases: `ws channels` (SAFE); `ONCHAINOS_PRETTY=1 ws channels` (SAFE).

### `onchainos ws channel-info`  (hidden: no)
- Handler: `commands/ws.rs:225` `ws_channel_info`
- Options: `--channel <CHANNEL>` String, required.
- Auth: anonymous.
- Steps: 1. `find` first entry in `ALL_CHANNELS` order where `ch.name == name` OR (`ch.name == "dex-token-candle{period}"` AND `name.starts_with("dex-token-candle")`) — so `dex-token-candle`, `dex-token-candle1m`, `dex-token-candleXYZ` all match the template. 2. Output `channel` = the user-supplied `name` for the template entry, else registry name.
- Output: `{"ok":true,"data":{"channel":..,"description":..,"example":..,"group":..,"params":<params_hint>,"pattern":..}}`. E.g. `--channel price` → `{"ok":true,"data":{"channel":"price","description":"Real-time token price updates","example":"onchainos ws start --channel price --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7","group":"market","params":"--token-pair chainIndex:tokenAddress","pattern":"pertoken"}}`. `--channel dex-token-candle5m` → channel `dex-token-candle5m`, example stays the registry text with `candle1m`.
- Errors: no match → `unknown channel '<name>'; use 'onchainos ws channels' to list all` (exit 1).
- Side effects: local-only. Nondeterminism: none.
- Parity test cases: `ws channel-info --channel price` (SAFE); `ws channel-info --channel dex-token-candle5m` (SAFE); `ws channel-info --channel kol_smartmoney-tracker-activity` (SAFE); `ws channel-info --channel nope` → error (SAFE).

### `onchainos ws start`  (hidden: no)
- Handler: `commands/ws.rs:129` (arg parsing in `execute`) → `ws_start` (ws.rs:254)
- Options:
  - `--channel <CHANNEL>`: `Vec<String>`, repeatable (`--channel a --channel b`), no comma splitting, optional; empty → `DEFAULT_CHANNELS`.
  - `--wallet-addresses <WALLET_ADDRESSES>`: String, optional; split on `,`, each trimmed, empties dropped.
  - `--chain-index <CHAIN_INDEX>`: String, optional; split on `,`, trimmed, empties dropped; values not validated.
  - `--token-pair <TOKEN_PAIR>`: String, optional; split on `,`; each item trimmed then `split_once(':')`; items without `:` or with empty side are **silently dropped**; `chain_index` = left, `token_contract_address` = right (may itself contain `:`); sides not individually trimmed.
  - `--env <ENV>`: String, default `prod`.
  - `--idle-timeout <IDLE_TIMEOUT>`: String, default `30m`; parsed with `parse_duration_ms(.., "idle-timeout", allow_zero=true)`.
- Auth: api-key (env credentials checked here; used by the daemon).
- Steps (exact order):
  1. Parse lists (above); parse idle timeout → errors `invalid --idle-timeout '<s>'; use e.g. 300s, 30m, 24h, 7d` / `--idle-timeout '<s>' overflows`.
  2. `--env`: `pre`→Pre, `prod`→Prod, else error `unknown --env '<env>'; use pre or prod` (case-sensitive).
  3. channels = given or `["kol_smartmoney-tracker-activity"]`; sort (byte order) + dedup.
  4. For each channel in sorted order: PerWallet → if no addresses: `--wallet-addresses is required for channel '<ch>'`; if more than 200 (counted before dedup): `--wallet-addresses exceeds maximum of 200 (got <n>)`. PerToken → if no pairs: `--token-pair is required for channel '<ch>' (format: chainIndex:tokenAddress)`. PerChain → if no chain indexes: `--chain-index is required for channel '<ch>'`. Global → nothing.
  5. Sort+dedup wallet_addresses, token_pairs (by chain_index then address), chain_indexes.
  6. `store::list_watches()`; for each entry with a readable config: if sorted config lists equal the new lists (channels, wallet_addresses, token_pairs, chain_indexes), same env, and state is Running or Reconnecting → print `{"ok":true,"data":{"channels":[..],"env":"<env>","id":"<existing id>","status":"already_running"}}` and return (exit 0, nothing spawned).
  7. `id = "ws_" + first 6 chars of a random UUIDv4 string` (lowercase hex, e.g. `ws_3f9a1c`).
  8. Build `WatchConfig{channels, wallet_addresses, token_pairs, chain_indexes, env, created_at: now_ms, idle_timeout_ms}`.
  9. Pre-flight `Credentials::from_watch_env(env)` → error `OKX_PROD_API_KEY is not set` / `OKX_PROD_SECRET_KEY is not set` / `OKX_PROD_PASSPHRASE is not set` (or `OKX_PRE_*`). Nothing written yet.
  10. `init_watch_dir(id, config)` → `<HOME>/watch/<id>/config.json`.
  11. Spawn `std::env::current_exe()` with args `ws run-daemon --id <id>`; stdin null, stdout null, stderr → `<dir>/daemon.log` (create+append, 0600 unix); on Windows `creation_flags(0x00000008)` (DETACHED_PROCESS). Environment inherited (credentials, `ONCHAINOS_HOME`). Global flags (`--chain`, `--dev`) are not forwarded. The child is not waited on.
  12. `write_pid(dir, child_pid)`.
- Output: `{"ok":true,"data":{"channels":[..sorted..],"dir":"<dir path, lossy string; backslashes on Windows>","env":"prod","id":"ws_xxxxxx","pid":<u32>,"status":"starting"}}`.
- Errors: all messages above → exit 1; spawn / fs errors → io error text, exit 1.
- Side effects: local-only (creates session dir, spawns a detached background process which opens a WebSocket).
- Nondeterminism: `id`, `pid`, `dir` (contains id), `created_at` in config.json.
- Parity test cases: with no `OKX_PROD_*` env: `ws start` → `{"ok":false,"error":"OKX_PROD_API_KEY is not set"}` (SAFE); `ws start --env staging` → `unknown --env 'staging'; use pre or prod` (SAFE); `ws start --channel address-tracker-activity` → `--wallet-addresses is required for channel 'address-tracker-activity'` (SAFE); `ws start --channel price --token-pair bad` → `--token-pair is required for channel 'price' (format: chainIndex:tokenAddress)` (SAFE); `ws start --idle-timeout 30x` → `invalid --idle-timeout '30x'; use e.g. 300s, 30m, 24h, 7d` (SAFE). With valid creds against a mock WS: `ws start --channel price --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7` (SAFE, read-only stream, but spawns a daemon — stop it afterwards).

### `onchainos ws run-daemon`  (hidden: yes — `#[command(hide = true)]`)
- Handler: `commands/ws.rs:725` `run_daemon_entry` → `watch/daemon.rs:108` `run_daemon`
- Options: `--id <ID>` String, required.
- Auth: api-key (HMAC-signed WS login frame).
- Steps:
  1. `dir = watch_dir(id)`; missing → error `session dir for '<id>' does not exist` (exit 1, JSON on stdout — stdout is /dev/null when spawned by `ws start`).
  2. `write_pid(dir, own pid)`; `write_status(dir, "running", None)`.
  3. `load_daemon_config(dir)` (errors above; corrupt config → status `config_corrupt|<ms>|config_corrupt`, exit 1 — test oracle `ws_run_daemon_it_103_corrupt_config_errors`).
  4. Spawn heartbeat task: `tokio::time::interval(10s)` (first tick immediate). Each tick: if `heartbeat_active` → `write_status("running")`. If `idle_timeout_ms > 0`: `last = last_poll_time(dir) or config.created_at`; if `now_ms - last > idle_timeout_ms` → `write_status("stopped", "idle_timeout")`, set `idle_expired`, end task.
  5. Credentials from env; failure → stderr `[watch daemon] credentials error: <e>`, status `stopped|<ms>|credentials:<e>`, exit 1.
  6. Reconnect loop (`attempts = 0`):
     a. `heartbeat_active = true`; `connect_and_stream(...)`:
        - `connect_async(WS_URL)` (plain RFC6455 handshake, no custom headers).
        - Send text frame = `login_msg()`.
        - `wait_for_login_ack` (≤10 s): read frames; ignore non-text and non-JSON; on JSON with `event == "login"`: `code` read **as string**, missing/non-string → `"-1"`; `"0"` → ok, else error `login error: <msg or "unknown">`. Stream error → that error; stream end → `connection closed during login`; timeout → `login ack timeout`. (An `{"event":"error",..}` frame is ignored here → ends in timeout.)
        - Build subscribe args by iterating `config.channels` (sorted) and pattern: Global → `{"channel":ch}`; PerWallet → one per address `{"channel":ch,"walletAddress":addr}`; PerToken → one per pair `{"chainIndex":ci,"channel":ch,"tokenContractAddress":addr}`; PerChain → one per chain index `{"chainIndex":ci,"channel":ch}` (keys alphabetical). Send `{"args":[...],"op":"subscribe"}`.
        - `wait_for_subscribe_acks(count = args.len())` (≤10 s total): count frames with `event=="subscribe"` until count reached; `event=="error"` → `subscribe error: <msg or "unknown">`; stream end → `connection closed during subscribe`; timeout → `subscribe ack timeout`. Push frames received before all acks are discarded.
        - `write_status("running")`.
        - Loop with `interval(25s)` (first tick consumed immediately) and `select!`:
          - tick: if `idle_expired` → return Ok(`"idle_timeout"`). Send text `ping`. Within 10 s read frames until a text frame whose trim is `pong`; other text frames that parse as push (`{"arg":{"channel":..},"data":[..]}`) are appended via `append_events`; any failure/timeout → Err(`ping_timeout`).
          - frame: none → Err(`connection_closed`); error → that error; text `pong` (trimmed) → ignore; JSON with `event=="notice"` → return Ok(`"service_upgrade"`); JSON matching push shape → `append_events(dir, arg.channel, data)`; Close frame → Err(`server_closed`); other frames ignored (tungstenite auto-answers WS ping frames).
     b. On `Ok(reason)`: `heartbeat_active=false`, `attempts=0`, stderr `[watch daemon] disconnected: <reason>`; reason `stopped`/`idle_timeout` → status `stopped|<ms>|<reason>` and exit 0; otherwise status `disconnected|<ms>|<reason>` (i.e. `service_upgrade`).
        On `Err(e)`: `heartbeat_active=false`, stderr `[watch daemon] error: <e>`, status `disconnected|<ms>|error:<e>` (top-level message only).
     c. If `idle_expired` → stderr `[watch daemon] idle timeout reached, shutting down`, exit 0 (note: status may remain `disconnected|...` → later reads as `crashed`).
     d. `attempts += 1`; if `attempts >= 20` → status `stopped|<ms>|max_reconnect_reached`, exit 0.
     e. status `reconnecting|<ms>`; sleep 3 s; loop.
  7. On clean exit nothing is printed (stdout is null anyway); audit entry `ws run-daemon` is written.
- Output: none on success; `{"ok":false,"error":..}` on failure.
- Errors: see above; exit 1 for dir missing / config errors / credentials.
- Side effects: read (market data stream); writes status/pid/events/log files. WebSocket endpoint class: login = auth, subscribe = read.
- Nondeterminism: timestamps in status, HMAC timestamp/sign, event contents, pid.
- Parity test cases: `ws run-daemon --id nope` → `{"ok":false,"error":"session dir for 'nope' does not exist"}` (SAFE); corrupt config dir → exit 1 + status `config_corrupt|…` (SAFE); mock-WS run comparing the exact login/subscribe frames (SAFE).

### `onchainos ws poll`  (hidden: no)
- Handler: `commands/ws.rs:415` `ws_poll`
- Options: `--id <ID>` String required; `--channel <CHANNEL>` optional (default = first entry of session `config.channels`, i.e. alphabetically first); `--limit <LIMIT>` usize default 20; tracker-only filters: `--min-quote-amount <f64>`, `--min-market-cap <f64>`, `--min-pnl <f64>`, `--trader <String>`, `--tag <String>`, `--since <u64>`, `--trade-type <String>` (clap value parsers: f64/u64; invalid → clap error exit 2).
- Auth: anonymous (local files only).
- Steps:
  1. `dir` missing → `session '<id>' not found`.
  2. `daemon_state = read_daemon_state(id)`; `status_str` = `disconnected:<reason>` or `running|reconnecting|stopped|crashed`.
  3. Channel = `--channel` or `read_config(id).channels[0]` (config read error propagates; empty → `session has no channels configured`).
  4. `is_tracker = is_tracker_channel(channel)`; `has_filters = is_tracker && any filter flag given` (filters on non-tracker channels are silently ignored).
  5. `fetch_limit = has_filters ? limit*4 : limit`; `result = read_events_from_cursor(dir, channel, fetch_limit)`.
  6. If `has_filters`:
     - `--tag`: `smart_money`|`sm`|`1` → 1, `kol`|`2` → 2, other → error `unknown --tag value '<v>'; use smart_money or kol` (cursor untouched).
     - `--trade-type`: lowercase match `all`/`0`→`0`, `buy`/`1`→`1`, `sell`/`2`→`2`, else the original string.
     - Keep an event iff it deserializes as `TradeEvent` AND: `quoteTokenAmount` as f64 (Rust `f64::from_str` semantics — accepts `1e5`, `inf`, `NaN`, leading `+`; rejects whitespace, `,`, empty → 0.0) `>= --min-quote-amount`; `marketCap` f64 (fail 0.0) `>= --min-market-cap`; `realizedPnlUsd` f64 (fail −∞) `>= --min-pnl`; `walletAddress.starts_with(--trader)` (case-sensitive); `trackerType` array contains tag (missing → drop); `tradeTime` as u64 (fail 0) `>= --since`; trade type: if resolved value non-empty and ≠ `0` then `tradeType == value`. (NaN comparisons keep the event.)
     - Take first `limit` matches. If ≥1 match: write cursor = `per_event_cursors[index of last match]` (fallback `new_cursor`). If 0 matches: **cursor not written** (events are re-scanned next poll; idle timer not refreshed).
     - Output `{"ok":true,"data":{"daemon_status":..,"new_count":n,"trades":[raw events]}}`.
  7. Else: events = up to `limit`; **always** write cursor = `new_cursor` (creates `cursor.<channel>` even when empty); output key `trades` if tracker channel else `events`: `{"ok":true,"data":{"daemon_status":..,"events":[..],"new_count":n}}` or `{"ok":true,"data":{"daemon_status":..,"new_count":n,"trades":[..]}}`.
- Errors: exit 1 with messages above.
- Side effects: local-only (cursor file write).
- Nondeterminism: `daemon_status` depends on wall clock vs status timestamp (60 s staleness).
- Parity test cases: `ws poll --id ws_nope` → `session 'ws_nope' not found` (SAFE); fixture session dir with `config.json`, `status` (`stopped|0`), `events.price.0.jsonl` → `ws poll --id ws_fixture --channel price --limit 2` (SAFE, deterministic: status `stopped`); fixture tracker events + `--tag kol --min-pnl 0` (SAFE); `--tag foo` → error (SAFE).

### `onchainos ws stop`  (hidden: no)
- Handler: `commands/ws.rs:198` → `ws_stop` (ws.rs:617) / `ws_stop_all` (ws.rs:628); `stop_one` (ws.rs:589); `kill_daemon` (ws.rs:645)
- Options: `--id <ID>` optional (omit = all sessions); `--flush` bool flag.
- Auth: anonymous.
- Steps (`stop_one`): 1. dir missing → `session '<id>' not found`. 2. If `--flush`: `read_config` (error aborts before killing); for each config channel (config order): `read_events_from_cursor(dir, ch, 1000)`, `write_cursor(new_cursor)`, collect events. 3. `kill_daemon` (errors ignored): read pid; unix: pid must be >0 and fit i32, `kill(pid, SIGTERM)`, then up to 30× (every 100 ms) `kill(pid,0)` until it fails, then `kill(pid, SIGKILL)`; Windows: run `taskkill /PID <pid> /F` (output captured, ignored). 4. `write_status("stopped")` (ignored). 5. `remove_watch_dir(id)` (error propagates).
  - Single: output `{"ok":true,"data":{"flushed_count":n,"flushed_events":[..],"id":"<id>","status":"stopped"}}` (flushed_events `[]` without `--flush`).
  - All: `list_watches()`; none → `{"ok":true,"data":{"message":"no active sessions","stopped":[]}}`; else `stop_one` each (id order), failures → stderr `[warn] failed to stop <id>: <e>`; output `{"ok":true,"data":{"stopped":[ids]}}` (flushed events are discarded in stop-all).
- Errors: single-id failures exit 1.
- Side effects: local-only (kills local process, deletes session dir).
- Nondeterminism: none beyond ids.
- Parity test cases: `ws stop` with empty home → `{"ok":true,"data":{"message":"no active sessions","stopped":[]}}` (SAFE); `ws stop --id ws_nope` → error (SAFE); fixture dir (pid of a non-existent process) `ws stop --id ws_fixture --flush` (SAFE).

### `onchainos ws list`  (hidden: no)
- Handler: `commands/ws.rs:685` `ws_list`
- Options: none.
- Auth: anonymous.
- Steps: `list_watches()` → for each: `{"channels": config.channels or [], "created_at": config.created_at as **string** or "", "env": "pre"/"prod" or "", "id", "pid": number or null, "status": status_str}`.
- Output: `{"ok":true,"data":[{"channels":[..],"created_at":"1727500000000","env":"prod","id":"ws_ab12cd","pid":1234,"status":"running"}]}`; empty → `{"ok":true,"data":[]}`.
- Errors: fs errors reading `watch/` → exit 1.
- Side effects: local-only. Nondeterminism: status (clock-dependent).
- Parity test cases: `ws list` on empty home → `{"ok":true,"data":[]}` (SAFE); fixture dir with `status` `stopped|0`, no pid → `pid:null`, `status:"stopped"` (SAFE).

### `onchainos mcp`  (hidden: no)
- Handler: `main.rs:196` → `mcp::serve()` (mcp/mod.rs:2975). Runs before `Context`/audit; no audit entries.
- Options: none (global `--chain` accepted and ignored).
- Auth: jwt-optional (shared `ApiClient::new()`), plus wallet-login-required tools (payment_*, gas_station_*, `cross_chain_status` with `order_id`).
- Transport/protocol (rmcp 1.3.0, `transport-io` stdio): newline-delimited JSON-RPC 2.0 on stdin/stdout, one compact JSON message per line. Server must receive `initialize` first (pings allowed before it); then waits for `notifications/initialized`.
  - `initialize` result (struct order): `{"protocolVersion":V,"capabilities":{"tools":{}},"serverInfo":{"name":"onchainos","version":"4.6.3"}}` (no `instructions`). V negotiation: server version `2025-06-18`; if the client's requested `protocolVersion` string compares **lexicographically less** than `2025-06-18` the client's string is echoed (e.g. `2024-11-05` → `2024-11-05`, test oracle), otherwise `2025-06-18`.
  - `tools/list` → `{"tools":[...]}` sorted by tool name (rmcp `ToolRouter::list_all` sorts), each `{"name","description","inputSchema"}` (title/outputSchema/annotations omitted). `inputSchema` = schemars 1.x draft-2020-12 schema of the params struct; tools without params get `{"type":"object","properties":{}}`.
  - `tools/call`: unknown tool → JSON-RPC error code -32602 message `tool not found`; argument deserialization failure (missing required field, wrong type) → JSON-RPC error -32602 `failed to deserialize parameters: <serde msg>`; handler `Ok(text)` → `CallToolResult{content:[{"type":"text","text":text}], isError:false}`; handler `Err(text)` → same with `isError:true`.
  - On `mcp::serve` failure (e.g. ApiClient build/DoH prepare) → stdout `{"ok":false,"error":..}`, exit 1.
- Tool → behaviour mapping (all tools except payment/gas-station lock the shared client; `resolve_chain` used for chain names). Default chain notes: token_*/market_* default `resolve_chain("ethereum")`=`1`; memepump_* default `"501"`; workflow_* default `resolve_chain("solana")`=`501` (config `default_chain` is **not** consulted in MCP).

| tool | required params | notable defaults / pre-processing | handler (owner) | HTTP | class |
|---|---|---|---|---|---|
| payment_quote | url | param=[], method="GET" | `payment::fetch_quote(url,param,method,None)` | probe merchant URL (REST or MCP via mcp_client) | read |
| payment_pay | payment_id | param=[], yes=false | `payment::fetch_pay` | TEE sign + merchant replay (payment group) | funds |
| payment_decode_receipt | – | header/receipt | `payment::fetch_decode_receipt` | none | local-only |
| payment_session | action | chain_id u64 | `payment::fetch_session` | payment group | funds |
| payment_a2a_status | payment_id | wait=false | `payment::a2a_pay::fetch_status` | payment group | read |
| token_search | query | chains default `"1,501"` | `token::fetch_search` | GET /api/v6/dex/market/token/search | read |
| token_info | address | chain→1 | `token::fetch_info` | POST /api/v6/dex/market/token/basic-info | read |
| token_holders | address | tag_filter u8 | `token::fetch_holders` | GET /api/v6/dex/market/token/holder | read |
| token_price_info | address | | `token::fetch_price_info` | POST /api/v6/dex/market/price-info | read |
| market_price | address | | `market::fetch_price` | POST /api/v6/dex/market/price | read |
| market_prices | tokens | default chain 1 | `market::fetch_prices` | POST /api/v6/dex/market/price | read |
| market_kline | address | bar `1H`, limit 100 | `market::fetch_kline` | GET /api/v6/dex/market/candles | read |
| token_trades | address | limit 100 | `token::fetch_token_trades` | GET /api/v6/dex/market/trades | read |
| market_index | address | | `market::fetch_index` | POST /api/v6/dex/index/current-price | read |
| signal_chains | – | | `signal::fetch_chains` | GET /api/v6/dex/market/signal/supported/chain | read |
| signal_list | chain | | `signal::fetch_list` | POST /api/v6/dex/market/signal/list | read |
| memepump_chains | – | | `memepump::fetch_chains` | GET /api/v6/dex/market/memepump/supported/chainsProtocol | read |
| memepump_tokens | chain | `MemepumpTokenListParams` | `memepump::fetch_token_list` | GET /api/v6/dex/market/memepump/tokenList | read |
| memepump_token_details | address | chain→501, wallet_address→"" | `memepump::fetch_token_details` | GET /api/v6/dex/market/memepump/tokenDetails | read |
| memepump_token_dev_info | address | chain→501 | `memepump::fetch_by_address` | GET /api/v6/dex/market/memepump/tokenDevInfo | read |
| memepump_similar_tokens | address | chain→501 | `memepump::fetch_by_address` | GET /api/v6/dex/market/memepump/similarToken | read |
| memepump_token_bundle_info | address | chain→501 | `memepump::fetch_by_address` | GET /api/v6/dex/market/memepump/tokenBundleInfo | read |
| memepump_aped_wallet | address | chain→501, wallet_address→"" | `memepump::fetch_aped_wallet` | GET /api/v6/dex/market/memepump/apedWallet | read |
| social_news_latest | – | | `social::fetch_news_latest` | GET /api/v6/dex/market/social/news/latest | read |
| social_news_by_symbol | token_symbols | | `social::fetch_news_by_symbol` | GET /api/v6/dex/market/social/news/by-symbol | read |
| social_news_search | keyword | | `social::fetch_news_search` | GET /api/v6/dex/market/social/news/search | read |
| social_news_detail | article_id | | `social::fetch_news_detail` | GET /api/v6/dex/market/social/news/detail | read |
| social_news_platforms | – | | `social::fetch_news_platforms` | GET /api/v6/dex/market/social/news/platforms | read |
| social_sentiment_ranking | – | | `social::fetch_sentiment_ranking` | GET /api/v6/dex/market/social/sentiment/ranking | read |
| social_sentiment_symbol | token_symbols | | `social::fetch_sentiment_symbol` | GET /api/v6/dex/market/social/sentiment/symbol | read |
| social_vibe_timeline | chain, token_address | | `social::fetch_vibe_timeline` | GET /api/v6/dex/market/social/vibe/timeline | read |
| social_vibe_top_kols | chain, token_address | | `social::fetch_vibe_top_kols` | GET /api/v6/dex/market/social/vibe/top-kols | read |
| swap_chains | – | | `swap::fetch_chains` | GET /api/v6/dex/aggregator/supported/chain | read |
| swap_quote | from,to,amount,chain | swap_mode `exactIn`; then `swap::classify_swap_response` | `swap::fetch_quote` | GET /api/v6/dex/aggregator/quote | read |
| swap_swap | from,to,amount,chain,wallet | swap_mode `exactIn`, gas_level `average`; classify | `swap::fetch_swap` | GET /api/v6/dex/aggregator/swap | read (unsigned tx) |
| swap_approve | token,amount,chain | | `swap::fetch_approve` | GET /api/v6/dex/aggregator/approve-transaction | read (unsigned tx) |
| swap_liquidity | chain | | `swap::fetch_liquidity` | GET /api/v6/dex/aggregator/get-liquidity | read |
| portfolio_chains | – | | `portfolio::fetch_chains` | GET /api/v6/dex/balance/supported/chain | read |
| portfolio_total_value | address,chains | | `portfolio::fetch_total_value` | GET /api/v6/dex/balance/total-value-by-address | read |
| portfolio_all_balances | address,chains | | `portfolio::fetch_all_balances` | GET /api/v6/dex/balance/all-token-balances-by-address | read |
| portfolio_token_balances | address,tokens | | `portfolio::fetch_token_balances` | POST /api/v6/dex/balance/token-balances-by-address | read |
| gateway_chains | – | | `gateway::fetch_chains` | GET /api/v6/dex/pre-transaction/supported/chain | read |
| gateway_gas | chain | | `gateway::fetch_gas` | GET /api/v6/dex/pre-transaction/gas-price | read |
| gateway_gas_limit | from,to,chain | amount `"0"` | `gateway::fetch_gas_limit` | POST /api/v6/dex/pre-transaction/gas-limit | read |
| gateway_simulate | from,to,data,chain | amount `"0"` | `gateway::fetch_simulate` | POST /api/v6/dex/pre-transaction/simulate | read |
| gateway_broadcast | signed_tx,address,chain | mev_protection=false | `gateway::fetch_broadcast` | POST /api/v6/dex/pre-transaction/broadcast-transaction | **funds** |
| gateway_orders | address,chain | | `gateway::fetch_orders` | GET /api/v6/dex/post-transaction/orders | read |
| token_liquidity | address | | `token::fetch_liquidity` | GET /api/v6/dex/market/token/top-liquidity | read |
| token_hot_tokens | ranking_type | `token::HotTokensParams` | `token::fetch_hot_tokens` | GET /api/v6/dex/market/token/hot-token | read |
| token_advanced_info | address | | `token::fetch_advanced_info` | GET /api/v6/dex/market/token/advanced-info | read |
| token_top_trader | address | | `token::fetch_top_trader` | GET /api/v6/dex/market/token/top-trader | read |
| market_portfolio_supported_chains | – | | `market::fetch_portfolio_supported_chains` | GET /api/v6/dex/market/portfolio/supported/chain | read |
| market_portfolio_overview | address,chain | time_frame `"4"` | `market::fetch_portfolio_overview` | GET /api/v6/dex/market/portfolio/overview | read |
| market_portfolio_dex_history | address,chain | | `market::fetch_portfolio_dex_history` | GET /api/v6/dex/market/portfolio/dex-history | read |
| market_portfolio_recent_pnl | address,chain | | `market::fetch_portfolio_recent_pnl` | GET /api/v6/dex/market/portfolio/recent-pnl | read |
| market_portfolio_token_pnl | address,chain,token | | `market::fetch_portfolio_token_pnl` | GET /api/v6/dex/market/portfolio/token/latest-pnl | read |
| tracker_activities | tracker_type | if (resolved type `3` or `multi_address`) and no wallet_address → Err `wallet_address is required when tracker_type is multi_address` | `tracker::fetch_activities` | GET /api/v6/dex/market/address-tracker/trades | read |
| leaderboard_chains | – | | `leaderboard::fetch_chains` | GET /api/v6/dex/market/leaderboard/supported/chain | read |
| leaderboard_list | chain,time_frame,sort_by | wallet_type via `leaderboard::resolve_leaderboard_wallet_type` | `leaderboard::fetch_list` | GET /api/v6/dex/market/leaderboard/list | read |
| token_cluster_supported_chains | – | | `token::fetch_cluster_supported_chains` | GET /api/v6/dex/market/token/cluster/supported/chain | read |
| token_cluster_overview | address | | `token::fetch_cluster_by_address` | GET /api/v6/dex/market/token/cluster/overview | read |
| token_cluster_top_holders | address,range_filter | | `token::fetch_cluster_top_holders` | GET /api/v6/dex/market/token/cluster/top-holders | read |
| token_cluster_list | address | | `token::fetch_cluster_by_address` | GET /api/v6/dex/market/token/cluster/list | read |
| cross_chain_tokens | – | | `cross_chain::fetch_supported_tokens` | GET /api/v6/dex/cross-chain/supported/tokens | read |
| cross_chain_bridges | – | | `cross_chain::fetch_supported_bridges` | GET /api/v6/dex/cross-chain/supported/bridges | read |
| cross_chain_quote | from,to,from_chain,to_chain,readable_amount | `validate_receive_address`, `token_alias::resolve_and_validate` ("from"/"to"), `swap::resolve_amount_arg(None, readable)`, slippage `"0.01"` | `cross_chain::fetch_quote` | GET /api/v6/dex/cross-chain/quote (+ decimals lookup inside resolve_amount_arg) | read |
| cross_chain_status | bridge_id, from_chain | exactly one of tx_hash / order_id else Err `provide tx_hash OR order_id, not both` / `one of tx_hash or order_id is required`; order_id → `resolve_order_id_to_tx_hash` | `cross_chain::fetch_status` | GET /priapi/v5/wallet/agentic/order/detail (JWT) ; GET /api/v6/dex/cross-chain/status | read |
| defi_support_chains | – | | `defi::fetch_chains` | GET /api/v6/defi/product/supported-chains | read |
| defi_support_platforms | – | | `defi::fetch_protocols` | GET /api/v6/defi/product/supported-platforms | read |
| defi_list | – | all filters None | `defi::fetch_search` | POST /api/v6/defi/product/search | read |
| defi_search | – | chain resolved | `defi::fetch_search` | POST /api/v6/defi/product/search | read |
| defi_detail | investment_id | | `defi::fetch_detail` | GET /api/v6/defi/product/detail | read |
| defi_rate_chart | investment_id | | `defi::fetch_rate_chart` | GET /api/v6/defi/product/rate/chart | read |
| defi_tvl_chart | investment_id | | `defi::fetch_tvl_chart` | GET /api/v6/defi/product/tvl/chart | read |
| defi_depth_price_chart | investment_id | | `defi::fetch_depth_price_chart` | GET /api/v6/defi/product/depth-price/chart | read |
| defi_positions | address,chains | | `defi::fetch_positions` | POST /api/v6/defi/user/asset/platform/list | read |
| defi_position_detail | address,chain,platform_id | | `defi::fetch_position_detail` | POST /api/v6/defi/user/asset/platform/detail | read |
| defi_invest | investment_id,address,token,amount | slippage `"0.01"`; **`chain` param accepted but ignored** | `defi::cmd_invest` | multi-call per tool description (detail check, prepare, V3 calculate-entry, calldata via POST /api/v6/defi/transaction/enter); exact sequence owned by defi group | read (returns calldata) |
| defi_withdraw | investment_id,address,chain | slippage `"0.01"` | `defi::cmd_withdraw` | multi-call (position-detail lookup, POST /api/v6/defi/transaction/exit); owned by defi group | read (returns calldata) |
| defi_collect | address,chain,reward_type | | `defi::cmd_collect` | multi-call (position-detail lookup, POST /api/v6/defi/transaction/claim); owned by defi group | read (returns calldata) |
| gas_station_update_default_token | chain,gas_token_address | own WalletApiClient | `gas_station::fetch_update_default_token` | POST /priapi/v5/wallet/agentic/gas-station/update-default-token | state |
| gas_station_enable | chain | | `gas_station::fetch_update(chain,true)` | POST /priapi/v5/wallet/agentic/gas-station/update | state |
| gas_station_disable | chain | | `gas_station::fetch_update(chain,false)` | POST /priapi/v5/wallet/agentic/gas-station/update | state |
| workflow_token_research | – | chain→501; no address and no query → Err `Either 'address' or 'query' is required`; no address → `search_and_select`; else `fetch_and_assemble` | workflows (this group) | see `workflow token-research` | read |
| workflow_smart_money | – | chain→501 | `smart_money::fetch_and_assemble` | see `workflow smart-money` | read |
| workflow_new_tokens | – | chain→501, stage `"MIGRATED"` | `new_tokens::fetch_and_assemble` | see `workflow new-tokens` | read |
| workflow_wallet_analysis | address | chain→501 | `wallet_analysis::fetch_and_assemble` | see `workflow wallet-analysis` | read |
| workflow_portfolio | address | `chains_str = resolve_chains(chains or "1,501")` (indexed form in output) | `portfolio::fetch_and_assemble` | see `workflow portfolio` | read |

  Unused param structs (declared, no tool): `DefiPrepareParams`, `DefiEnterParams`, `DefiExitParams`, `DefiClaimParams`, `DefiCalculateEntryParams`.
- Output: each tool's text = `mcp::ok`/`mcp::err` (shared helpers). Example workflow success text = the bare `data` object (e.g. `{"address":..,"chain":"501","core":{..},"launchpad":null,"structure":{..},"workflow":"token-research"}`).
- Errors: see protocol notes; server process ends when stdin closes (exit 0).
- Side effects: FUND-MOVING via `gateway_broadcast` (POST /api/v6/dex/pre-transaction/broadcast-transaction), `payment_pay`, `payment_session`; state-changing via `gas_station_*`.
- Nondeterminism: passthrough data; notifications.
- Parity test cases: handshake with `protocolVersion:"2024-11-05"` → result echoes `2024-11-05`, serverInfo `{"name":"onchainos","version":"4.6.3"}` (SAFE); handshake with `2025-06-18` (SAFE); `tools/list` → 88 names in alphabetical order (SAFE); `tools/call` `nonexistent_tool_xyz` → JSON-RPC error (SAFE); `tools/call workflow_token_research {"chain":"solana"}` → isError `Either 'address' or 'query' is required` (SAFE); `tools/call leaderboard_list {"time_frame":"3","sort_by":"1"}` → JSON-RPC error (missing `chain`) (SAFE). `gateway_broadcast` (UNSAFE).

#### MCP tool catalogue (generated from `mcp/mod.rs`; order = registration order in source, `tools/list` returns them sorted by name)

| # | tool name | handler fn (mcp/mod.rs line) | params struct |
|---|---|---|---|
| 1 | `payment_quote` | `payment_quote` (L1033) | `PaymentQuoteParams` |
| 2 | `payment_pay` | `payment_pay` (L1047) | `PaymentPayParams` |
| 3 | `payment_decode_receipt` | `payment_decode_receipt` (L1061) | `PaymentDecodeReceiptParams` |
| 4 | `payment_session` | `payment_session` (L1075) | `PaymentSessionParams` |
| 5 | `payment_a2a_status` | `payment_a2a_status` (L1102) | `PaymentA2aStatusParams` |
| 6 | `token_search` | `token_search` (L1116) | `TokenSearchParams` |
| 7 | `token_info` | `token_info` (L1140) | `TokenAddressParams` |
| 8 | `token_holders` | `token_holders` (L1159) | `TokenTagAddressParams` |
| 9 | `token_price_info` | `token_price_info` (L1188) | `TokenAddressParams` |
| 10 | `market_price` | `market_price` (L1209) | `MarketTokenParams` |
| 11 | `market_prices` | `market_prices` (L1228) | `MarketPricesParams` |
| 12 | `market_kline` | `market_kline` (L1248) | `MarketKlineParams` |
| 13 | `token_trades` | `token_trades` (L1277) | `TokenTradesParams` |
| 14 | `market_index` | `market_index` (L1306) | `MarketTokenParams` |
| 15 | `signal_chains` | `signal_chains` (L1325) | (none — empty object schema) |
| 16 | `signal_list` | `signal_list` (L1336) | `MarketSignalListParams` |
| 17 | `memepump_chains` | `memepump_chains` (L1368) | (none — empty object schema) |
| 18 | `memepump_tokens` | `memepump_tokens` (L1379) | `memepump::MemepumpTokenListParams` |
| 19 | `memepump_token_details` | `memepump_token_details` (L1393) | `MemepumpWalletParams` |
| 20 | `memepump_token_dev_info` | `memepump_token_dev_info` (L1419) | `MarketTokenParams` |
| 21 | `memepump_similar_tokens` | `memepump_similar_tokens` (L1445) | `MarketTokenParams` |
| 22 | `memepump_token_bundle_info` | `memepump_token_bundle_info` (L1471) | `MarketTokenParams` |
| 23 | `memepump_aped_wallet` | `memepump_aped_wallet` (L1497) | `MemepumpWalletParams` |
| 24 | `social_news_latest` | `social_news_latest` (L1525) | `social::SocialNewsLatestParams` |
| 25 | `social_news_by_symbol` | `social_news_by_symbol` (L1539) | `social::SocialNewsBySymbolParams` |
| 26 | `social_news_search` | `social_news_search` (L1553) | `social::SocialNewsSearchParams` |
| 27 | `social_news_detail` | `social_news_detail` (L1567) | `social::SocialNewsDetailParams` |
| 28 | `social_news_platforms` | `social_news_platforms` (L1581) | (none — empty object schema) |
| 29 | `social_sentiment_ranking` | `social_sentiment_ranking` (L1592) | `social::SocialSentimentRankingParams` |
| 30 | `social_sentiment_symbol` | `social_sentiment_symbol` (L1606) | `social::SocialSentimentSymbolParams` |
| 31 | `social_vibe_timeline` | `social_vibe_timeline` (L1620) | `social::SocialVibeTimelineParams` |
| 32 | `social_vibe_top_kols` | `social_vibe_top_kols` (L1642) | `social::SocialVibeTopKolsParams` |
| 33 | `swap_chains` | `swap_chains` (L1666) | (none — empty object schema) |
| 34 | `swap_quote` | `swap_quote` (L1677) | `SwapQuoteParams` |
| 35 | `swap_swap` | `swap_swap` (L1707) | `SwapSwapParams` |
| 36 | `swap_approve` | `swap_approve` (L1740) | `SwapApproveParams` |
| 37 | `swap_liquidity` | `swap_liquidity` (L1762) | `ChainParam` |
| 38 | `portfolio_chains` | `portfolio_chains` (L1777) | (none — empty object schema) |
| 39 | `portfolio_total_value` | `portfolio_total_value` (L1788) | `PortfolioTotalValueParams` |
| 40 | `portfolio_all_balances` | `portfolio_all_balances` (L1810) | `PortfolioAllBalancesParams` |
| 41 | `portfolio_token_balances` | `portfolio_token_balances` (L1832) | `PortfolioTokenBalancesParams` |
| 42 | `gateway_chains` | `gateway_chains` (L1853) | (none — empty object schema) |
| 43 | `gateway_gas` | `gateway_gas` (L1864) | `ChainParam` |
| 44 | `gateway_gas_limit` | `gateway_gas_limit` (L1876) | `GatewayGasLimitParams` |
| 45 | `gateway_simulate` | `gateway_simulate` (L1901) | `GatewaySimulateParams` |
| 46 | `gateway_broadcast` | `gateway_broadcast` (L1926) | `GatewayBroadcastParams` |
| 47 | `gateway_orders` | `gateway_orders` (L1949) | `GatewayOrdersParams` |
| 48 | `token_liquidity` | `token_liquidity` (L1971) | `TokenAddressParams` |
| 49 | `token_hot_tokens` | `token_hot_tokens` (L1991) | `token::HotTokensParams` |
| 50 | `token_advanced_info` | `token_advanced_info` (L2005) | `TokenAddressParams` |
| 51 | `token_top_trader` | `token_top_trader` (L2026) | `TokenTagAddressParams` |
| 52 | `market_portfolio_supported_chains` | `market_portfolio_supported_chains` (L2057) | (none — empty object schema) |
| 53 | `market_portfolio_overview` | `market_portfolio_overview` (L2068) | `PortfolioPnlOverviewParams` |
| 54 | `market_portfolio_dex_history` | `market_portfolio_dex_history` (L2091) | `PortfolioPnlDexHistoryParams` |
| 55 | `market_portfolio_recent_pnl` | `market_portfolio_recent_pnl` (L2119) | `PortfolioPnlRecentPnlParams` |
| 56 | `market_portfolio_token_pnl` | `market_portfolio_token_pnl` (L2142) | `PortfolioPnlTokenPnlParams` |
| 57 | `tracker_activities` | `tracker_activities` (L2164) | `AddressTrackerActivitiesParams` |
| 58 | `leaderboard_chains` | `leaderboard_chains` (L2204) | (none — empty object schema) |
| 59 | `leaderboard_list` | `leaderboard_list` (L2215) | `LeaderboardListParams` |
| 60 | `token_cluster_supported_chains` | `token_cluster_supported_chains` (L2251) | (none — empty object schema) |
| 61 | `token_cluster_overview` | `token_cluster_overview` (L2262) | `ClusterAddressParams` |
| 62 | `token_cluster_top_holders` | `token_cluster_top_holders` (L2288) | `ClusterTopHoldersParams` |
| 63 | `token_cluster_list` | `token_cluster_list` (L2314) | `ClusterAddressParams` |
| 64 | `cross_chain_tokens` | `cross_chain_tokens` (L2344) | `CrossChainBridgesParams` |
| 65 | `cross_chain_bridges` | `cross_chain_bridges` (L2366) | `CrossChainBridgesParams` |
| 66 | `cross_chain_quote` | `cross_chain_quote` (L2388) | `CrossChainQuoteParams` |
| 67 | `cross_chain_status` | `cross_chain_status` (L2452) | `CrossChainStatusParams` |
| 68 | `defi_support_chains` | `defi_support_chains` (L2491) | (none — empty object schema) |
| 69 | `defi_support_platforms` | `defi_support_platforms` (L2502) | (none — empty object schema) |
| 70 | `defi_list` | `defi_list` (L2515) | `DefiListParams` |
| 71 | `defi_search` | `defi_search` (L2535) | `DefiSearchParams` |
| 72 | `defi_detail` | `defi_detail` (L2559) | `DefiDetailParams` |
| 73 | `defi_rate_chart` | `defi_rate_chart` (L2575) | `DefiRateChartParams` |
| 74 | `defi_tvl_chart` | `defi_tvl_chart` (L2595) | `DefiTvlChartParams` |
| 75 | `defi_depth_price_chart` | `defi_depth_price_chart` (L2615) | `DefiDepthPriceChartParams` |
| 76 | `defi_positions` | `defi_positions` (L2638) | `DefiPositionsParams` |
| 77 | `defi_position_detail` | `defi_position_detail` (L2652) | `DefiPositionDetailParams` |
| 78 | `defi_invest` | `defi_invest` (L2676) | `DefiInvestParams` |
| 79 | `defi_withdraw` | `defi_withdraw` (L2705) | `DefiWithdrawParams` |
| 80 | `defi_collect` | `defi_collect` (L2731) | `DefiCollectParams` |
| 81 | `gas_station_update_default_token` | `gas_station_update_default_token` (L2758) | `GasStationUpdateDefaultTokenParams` |
| 82 | `gas_station_enable` | `gas_station_enable` (L2773) | `GasStationDisableParams` |
| 83 | `gas_station_disable` | `gas_station_disable` (L2788) | `GasStationDisableParams` |
| 84 | `workflow_token_research` | `workflow_token_research` (L2805) | `WorkflowTokenResearchParams` |
| 85 | `workflow_smart_money` | `workflow_smart_money` (L2861) | `WorkflowSmartMoneyParams` |
| 86 | `workflow_new_tokens` | `workflow_new_tokens` (L2888) | `WorkflowNewTokensParams` |
| 87 | `workflow_wallet_analysis` | `workflow_wallet_analysis` (L2917) | `WorkflowWalletAnalysisParams` |
| 88 | `workflow_portfolio` | `workflow_portfolio` (L2945) | `WorkflowPortfolioParams` |

##### Exact tool descriptions (as registered; Rust `\`-line-continuations collapsed)

- `payment_quote`: "Probe an HTTP 402 / A2MCP endpoint, parse the challenge, preflight balance, rank candidates, and return a paymentId to confirm before paying. Read-only; never signs."
- `payment_pay`: "Complete a previously-quoted payment by paymentId: sign via TEE, replay to the merchant, and return the receipt. Fund-moving; returns a confirming prompt unless yes=true."
- `payment_decode_receipt`: "Decode an x402 PAYMENT-RESPONSE header or a charge receipt into a normalized {status, transaction, amount, payer, chainId}. No auth, no funds."
- `payment_session`: "Run an MPP channel-session op (open/voucher/topup/close); the CLI decides reuse-vs-sign, cumulative amount, top-up need, and refund."
- `payment_a2a_status`: "Query an a2a-pay payment's status; with wait=true, poll internally (3s/60s) until terminal or timeout."
- `token_search`: "Search tokens by name/symbol/address across chains. Default limit is 20 to prevent token overflow. Use cursor for pagination, or pass max_results (1-500) to auto-paginate up to N results in one call — the response then becomes {items, nextCursor, fetchedCount} (items is the aggregated list; nextCursor continues beyond N; fetchedCount is how many were pulled)."
- `token_info`: "Get token metadata: name, symbol, decimals, logo"
- `token_holders`: "Get token holder distribution. Default limit is 20 to prevent token overflow. Use cursor for pagination, or pass max_results (1-500) to auto-paginate up to N holders in one call — the response then becomes {items, nextCursor, fetchedCount}."
- `token_price_info`: "Get token price info: market cap, liquidity, 24h change, volume"
- `market_price`: "Get current price for a token by contract address"
- `market_prices`: "Batch price query for multiple tokens"
- `market_kline`: "Get candlestick / K-line data for a token"
- `token_trades`: "Get token trade history on DEX, with optional tag and wallet filters"
- `market_index`: "Get aggregated index price for a token"
- `signal_chains`: "Get chains supported for smart money / KOL / whale signals"
- `signal_list`: "Get smart money / KOL / whale signal list for a chain. Default limit is 20 to prevent token overflow. Use cursor for pagination."
- `memepump_chains`: "Get supported chains and protocols for Meme Pump"
- `memepump_tokens`: "Get filtered Meme Pump token list"
- `memepump_token_details`: "Get Meme Pump token details"
- `memepump_token_dev_info`: "Get Meme Pump token developer info and reputation"
- `memepump_similar_tokens`: "Get similar tokens for a Meme Pump token"
- `memepump_token_bundle_info`: "Get Meme Pump token bundle/sniper info for rug detection"
- `memepump_aped_wallet`: "Get co-invested wallet data for a Meme Pump token"
- `social_news_latest`: "Latest crypto news feed (across all coins by default). Optional filters: token_symbols (comma-separated, max 20), begin/end (Unix ms; begin defaults to now − 72h, max 180d lookback), since (relative window <int><s|m|h|d> e.g. 24h/7d, mutually exclusive with begin/end), importance ('1'=High/'2'=Medium/'3'=Low), platform, language ('en_US' default / 'zh_CN'). Pagination via limit range [1, 50] + cursor, OR pass max_results (1-500) to auto-paginate up to N articles in one call — the response then becomes {items, nextCursor, fetchedCount}. detail_level='2' includes full article body."
- `social_news_by_symbol`: "News filtered by coin symbol(s). token_symbols required (comma-separated, max 20). sort_by: '1'=Latest (default), '2'=Hot. sentiment: '1'=Bullish/'2'=Bearish/'3'=Neutral. importance: '1'=High/'2'=Medium/'3'=Low. begin/end (Unix ms; begin defaults to now − 72h, max 180d lookback), OR since (relative window <int><s|m|h|d> e.g. 24h/7d, mutually exclusive with begin/end). limit range [1, 50], OR pass max_results (1-500) to auto-paginate up to N articles in one call — the response then becomes {items, nextCursor, fetchedCount}."
- `social_news_search`: "Full-text crypto news search. keyword required. Optional sort_by ('1'=Latest/'2'=Hot), sentiment, importance, platform, token_symbols (additional filter, max 20), begin/end (Unix ms; begin defaults to now − 72h, max 180d lookback) OR since (relative window <int><s|m|h|d> e.g. 24h/7d, mutually exclusive with begin/end), detail_level, limit range [1, 50], cursor, OR pass max_results (1-500) to auto-paginate up to N articles in one call — the response then becomes {items, nextCursor, fetchedCount}. language."
- `social_news_detail`: "Get the full body of a single news article by id. article_id is required and comes from the `articles[].id` field of any news listing endpoint. Use this when a list call returned only summaries (detail_level='1')."
- `social_news_platforms`: "List available news source platforms. Use the returned identifiers as the `platform` filter on social_news_latest / social_news_by_symbol / social_news_search."
- `social_sentiment_ranking`: "Top coins ranked by social activity (mention count) over a window. time_frame: '1'=1h (default), '2'=4h, '3'=24h. sort_by: '1'=Hot (only value supported). limit range [1, 50], default '10'."
- `social_sentiment_symbol`: "Aggregated social sentiment for one or more coins. token_symbols required (comma-separated, max 20). time_frame: '1'=1h (default) / '2'=4h / '3'=24h. Snapshot mode by default; pass trend_points (1–50) to switch to time-bucketed trend mode."
- `social_vibe_timeline`: "Token vibe (hotness) summary + time-bucketed timeline + sample KOLs per bucket. Keyed by chain + token_address (NOT symbol — resolve to a contract address first). time_frame: '1'=24h (default) / '2'=72h / '3'=7d / '4'=30d. Tweet bodies are stripped from the response (compliance red line)."
- `social_vibe_top_kols`: "Top KOLs discussing a token (capped at upstream TOP50). sort_by: '1'=Engagement (default) / '2'=Mentions / '3'=Impressions. time_frame: '1'/'2'/'3'/'4'. Keyed by chain + token_address. Tweet bodies stripped (compliance); tweet URLs and KOL identity fields pass through."
- `swap_chains`: "Get supported chains for DEX aggregator swaps"
- `swap_quote`: "Get swap quote (price estimate, no transaction)"
- `swap_swap`: "Get swap transaction data (unsigned tx for signing + broadcasting)"
- `swap_approve`: "Get ERC-20 approval transaction data"
- `swap_liquidity`: "Get available liquidity sources on a chain"
- `portfolio_chains`: "Get supported chains for wallet balance queries"
- `portfolio_total_value`: "Get total portfolio value for a wallet address"
- `portfolio_all_balances`: "Get all token balances for a wallet address"
- `portfolio_token_balances`: "Get specific token balances for a wallet address"
- `gateway_chains`: "Get supported chains for the on-chain gateway"
- `gateway_gas`: "Get current gas prices for a chain"
- `gateway_gas_limit`: "Estimate gas limit for a transaction"
- `gateway_simulate`: "Simulate a transaction (dry-run, no state change)"
- `gateway_broadcast`: "Broadcast a signed transaction on-chain"
- `gateway_orders`: "Track broadcast order status"
- `token_liquidity`: "Get top 5 liquidity pools for a token"
- `token_hot_tokens`: "Get hot token list ranked by trending score or X mentions, with extensive filtering. Default limit is 20 to prevent token overflow. Use cursor for pagination."
- `token_advanced_info`: "Get advanced token info: risk level, creator, dev stats, holder concentration"
- `token_top_trader`: "Get top traders (profit addresses) for a token. Default limit is 20 to prevent token overflow. Use cursor for pagination."
- `market_portfolio_supported_chains`: "Get supported chains for wallet portfolio PnL analysis"
- `market_portfolio_overview`: "Get wallet portfolio overview: realized/unrealized PnL, win rate, trading stats"
- `market_portfolio_dex_history`: "Get wallet DEX transaction history (paginated)"
- `market_portfolio_recent_pnl`: "Get recent token PnL records for a wallet (paginated)"
- `market_portfolio_token_pnl`: "Get latest PnL snapshot for a specific token in a wallet"
- `tracker_activities`: "Get latest DEX activities for tracked addresses. trackerType: smart_money (or 1) = platform smart money, kol (or 2) = platform Top 100 KOL addresses, multi_address (or 3) = custom addresses (requires wallet_address)"
- `leaderboard_chains`: "Get supported chains for the leaderboard (top traders ranking)"
- `leaderboard_list`: "Get top trader leaderboard ranked by PnL, win rate, volume, or ROI (max 20 per request)"
- `token_cluster_supported_chains`: "Get supported chains for token holder cluster analysis"
- `token_cluster_overview`: "Get token holder cluster concentration overview (cluster level, rug pull %, new address %)"
- `token_cluster_top_holders`: "Get token holder cluster analysis for top holder groups (range_filter: 1 = top 10, 2 = top 50, 3 = top 100)"
- `token_cluster_list`: "Get holder cluster list with address details for top 300 holders of a token"
- `cross_chain_tokens`: "List bridgeable tokens (/supported/tokens). Both from_chain and to_chain are independently optional: omit both for the full catalog, pass from_chain only for tokens on that source chain, pass to_chain only for tokens that can reach that destination, pass both for tokens on the specific from→to route. Returns chainIndex / tokenContractAddress / tokenSymbol / decimals."
- `cross_chain_bridges`: "List bridge protocols (/supported/bridges). Both from_chain and to_chain are independently optional: omit both for the full catalog, pass from_chain only for bridges on that source chain, pass to_chain only for bridges able to reach that destination, pass both for bridges that connect the specific chain pair. Returns bridgeId / bridgeName / supportedChains[]."
- `cross_chain_quote`: "Get cross-chain bridge quote (/quote). Returns routerList[] with bridgeId, needApprove, minimumReceived, estimateTime, crossChainFee."
- `cross_chain_status`: "Query cross-chain status by source chain transaction hash (/status). `bridge_id` is REQUIRED — server returns 50014 without it. Returns SUCCESS / PENDING / NOT_FOUND."
- `defi_support_chains`: "Get supported chains for DeFi operations"
- `defi_support_platforms`: "Get supported platforms for DeFi operations (e.g. Aave, Lido, Compound, PancakeSwap)"
- `defi_list`: "List top DeFi products by APY across all chains (no filters, paginated)"
- `defi_search`: "Search DeFi investment products (earn, liquidity pools, lending)"
- `defi_detail`: "Get full DeFi product details (APY, TVL, fee rate, isInvestable)"
- `defi_rate_chart`: "Get historical APY chart data for a DeFi product. Returns timestamped APY data points for trend visualization. Time ranges: WEEK (default), MONTH, SEASON, YEAR. DAY is V3 Pool only."
- `defi_tvl_chart`: "Get historical TVL chart data for a DeFi product. Returns timestamped TVL data points for trend visualization. Time ranges: WEEK (default), MONTH, SEASON, YEAR. DAY is V3 Pool only."
- `defi_depth_price_chart`: "Get V3 Pool liquidity depth distribution or price history chart. V3 Pool only. Chart types: DEPTH (default, shows liquidity per tick), PRICE (shows historical token0/token1 prices). Time range only applies to PRICE mode: DAY (default), WEEK."
- `defi_positions`: "Get user DeFi holdings overview across all protocols and chains. DISPLAY RULE: render ALL platforms in a markdown table with columns: # | Platform | analysisPlatformId | Chain | Positions | Value(USD). analysisPlatformId is MANDATORY."
- `defi_position_detail`: "Get detailed DeFi holdings for a specific protocol. Requires analysisPlatformId from defi_positions."
- `defi_invest`: "One-step DeFi deposit. Internally handles: detail check, prepare, precision conversion, V3 calculate-entry, calldata generation. Amount must be in minimal units (integer). For V3 pools pass range (e.g. 5 for ±5%). Returns calldata for signing: each dataList[] step carries a valueNormalized field (minimal-unit decimal integer) — pass it verbatim as wallet contract-call --amt; do NOT re-convert or divide by decimals. If a step could not be normalized it also carries valueNormalizeError and valueNormalized='0' — surface that instead of guessing."
- `defi_withdraw`: "One-step DeFi withdrawal. Internally handles: position-detail lookup, parameter construction, calldata generation. For full exit use ratio='1'. For V3 pools pass token_id + ratio. Returns calldata for signing: each dataList[] step carries a valueNormalized field (minimal-unit decimal integer) — pass it verbatim as wallet contract-call --amt; do NOT re-convert or divide by decimals. A step that could not be normalized also carries valueNormalizeError and valueNormalized='0'."
- `defi_collect`: "One-step DeFi reward claim. Internally handles: position-detail lookup, reward check, expectOutputList construction, calldata generation. Skips if no rewards available. Returns calldata for signing: each dataList[] step carries a valueNormalized field (minimal-unit decimal integer) — pass it verbatim as wallet contract-call --amt; do NOT re-convert or divide by decimals. A step that could not be normalized also carries valueNormalizeError and valueNormalized='0'."
- `gas_station_update_default_token`: "Update the default Gas Token for Gas Station on a specific chain. Gas Station allows paying gas fees with stablecoins (USDT/USDC/USDG) via a third-party Relayer."
- `gas_station_enable`: "Enable Gas Station for a specific chain (DB flag only, no on-chain action). Requires that 7702 delegation already exists on-chain (set earlier via the first-time Gas Station flow). If the chain was never delegated, backend returns a msg in the response body explaining that a first-time enable via wallet send is required."
- `gas_station_disable`: "Disable Gas Station for a specific chain (DB flag only, no on-chain action). The 7702 delegation on-chain is preserved, so re-enabling later does not require a new upgrade. To switch default gas token, use gas_station_update_default_token instead."
- `workflow_token_research`: "Full token due diligence in one call: price, contract, security scan, holder distribution, cluster overview, top traders, smart money signals. Accepts either 'address' (contract address) or 'query' (symbol/name). When 'query' is used without 'address', returns top 5 search results — present them to the user and call again with the chosen address. Step 3 adds launchpad enrichment automatically when protocolId is non-empty. Returns structured JSON with core / structure / launchpad blocks. Error if all Step 1 sub-calls fail."
- `workflow_smart_money`: "Smart money signals aggregated and enriched in one call. Fetches the signal list, groups by token, takes the top 5 by SM wallet count, then runs per-token due diligence (price, security, contract, optional launchpad). Signal API failure returns gracefully with empty topTokens."
- `workflow_new_tokens`: "Launchpad new token screening in one call. Fetches MIGRATED (default) or MIGRATING tokens, then enriches the top 10 with security scan, contract info, dev history, and bundle rate in parallel. Token list API failure returns gracefully with empty enriched list."
- `workflow_wallet_analysis`: "Wallet performance, behaviour, and recent activity in one call. Fetches 7d and 30d portfolio overview, all token balances, recent per-token PnL, and latest on-chain activity via the address tracker. Partial failures return null for that field; no all-fail error rule."
- `workflow_portfolio`: "Wallet portfolio snapshot in one call: all token balances, total value, and 30d PnL overview. Partial failures return null for that field."

##### Parameter structs declared in mcp/mod.rs (field: rust type — doc comment that schemars turns into the property `description`; multi-line doc comments are shown joined by a single space here — see openQuestions on exact joining). `String`/`bool`/`Vec` without `Option` and without `#[serde(default)]` = required.

- `DefiListParams`: `page_num`: `Option<u32>` — "Page number (min 1, page size fixed at 20)"
- `DefiSearchParams`: `token`: `Option<String>` — "Comma-separated token keywords (e.g. \"USDC,ETH\"). At least one of token or platform is required"; `platform`: `Option<String>` — "Comma-separated platform keywords (e.g. \"Aave,Compound\")"; `chain`: `Option<String>` — "Chain name (e.g. \"ethereum\", \"avalanche\")"; `product_group`: `Option<String>` — "Product group: SINGLE_EARN (default), DEX_POOL, LENDING"; `page_num`: `Option<u32>` — "Page number (min 1)"
- `DefiDetailParams`: `investment_id`: `String` — "Investment ID from search results"
- `DefiPrepareParams`: `investment_id`: `String` — "Investment ID from search results"
- `DefiRateChartParams`: `investment_id`: `String` — "Investment ID"; `time_range`: `Option<String>` — "Time range: DAY (V3 only), WEEK (default), MONTH, SEASON, YEAR"
- `DefiTvlChartParams`: `investment_id`: `String` — "Investment ID"; `time_range`: `Option<String>` — "Time range: DAY (V3 only), WEEK (default), MONTH, SEASON, YEAR"
- `DefiDepthPriceChartParams`: `investment_id`: `String` — "Investment ID (V3 Pool only)"; `chart_type`: `Option<String>` — "Chart type: DEPTH (default) or PRICE"; `time_range`: `Option<String>` — "Time range (only for PRICE mode): DAY (default), WEEK. Ignored in DEPTH mode"
- `DefiEnterParams`: `investment_id`: `String` — "Investment ID from search results"; `address`: `String` — "User wallet address"; `user_input`: `String` — "User input tokens as JSON array. coinAmount MUST be minimal units (integer), tokenPrecision REQUIRED. Convert: userAmount × 10^tokenPrecision (e.g. 0.1 USDT with precision=6 → coinAmount=\"100000\"). Get tokenPrecision from defi_prepare → investWithTokenList[].tokenPrecision. Example: '[{\"tokenAddress\":\"0x...\",\"chainIndex\":\"1\",\"coinAmount\":\"100000\",\"tokenPrecision\":\"6\"}]'"; `slippage`: `Option<String>` — "Slippage tolerance (default \"0.01\" = 1%)"; `token_id`: `Option<String>` — "Token ID for V3 Pool positions (required for V3 add liquidity to existing position)"; `tick_lower`: `Option<i64>` — "Lower tick for V3 Pool new position"; `tick_upper`: `Option<i64>` — "Upper tick for V3 Pool new position"
- `DefiExitParams`: `product_id`: `String` — "Investment product ID (investmentId from defi_position_detail)"; `chain`: `String` — "Chain name (e.g. \"ethereum\", \"bsc\", \"solana\", \"avax\")"; `address`: `String` — "User wallet address"; `redeem_ratio`: `Option<String>` — "Redemption ratio: \"1\"=full exit (100%), \"0.5\"=50%. Required for V3 Pool exits."; `token_id`: `Option<String>` — "V3 Pool NFT tokenId (required ONLY for V3 Pool exits)"; `slippage`: `Option<String>` — "Slippage tolerance (default \"0.01\" = 1%)"; `user_input`: `Option<String>` — "User input tokens as JSON array. coinAmount MUST be minimal units (integer), tokenPrecision REQUIRED. Convert: userAmount × 10^tokenPrecision. Get tokenPrecision from defi_position_detail → assetsTokenList[].tokenPrecision. Example: '[{\"tokenAddress\":\"<underlying>\",\"chainIndex\":\"<id>\",\"coinAmount\":\"100000\",\"tokenPrecision\":\"6\"}]' tokenAddress: underlying token (NOT aToken/receipt token). Always pass user_input when token info is available — do not default to redeem_ratio."; `token_address`: `Option<String>` — "Single-token shorthand: LP token address (alternative to user_input)"; `token_symbol`: `Option<String>` — "LP token symbol (used with token_address)"; `amount`: `Option<String>` — "Amount to redeem (used with token_address)"; `token_precision`: `Option<u32>` — "LP token decimals (used with token_address)"
- `DefiClaimParams`: `address`: `String` — "User wallet address"; `chain`: `String` — "Chain name (e.g. \"ethereum\", \"avalanche\")"; `reward_type`: `String` — "Reward type — must be one of: REWARD_PLATFORM, REWARD_INVESTMENT, REWARD_OKX_BONUS, REWARD_MERKLE_BONUS, V3_FEE, UNLOCKED_PRINCIPAL"; `product_id`: `Option<String>` — "Product ID / investmentId"; `platform_id`: `Option<String>` — "Protocol platform ID / analysisPlatformId"; `token_id`: `Option<String>` — "V3 Pool NFT tokenId (required for V3_FEE)"; `principal_index`: `Option<String>` — "Principal order index (for UNLOCKED_PRINCIPAL)"; `expect_output_list`: `Option<String>` — "Expected output token list as JSON array"
- `DefiPositionsParams`: `address`: `String` — "User wallet address"; `chains`: `String` — "Chains to query, comma-separated (e.g. \"ethereum,bsc,solana\")"
- `DefiPositionDetailParams`: `address`: `String` — "User wallet address"; `chain`: `String` — "Chain name (e.g. \"ethereum\", \"avalanche\")"; `platform_id`: `String` — "Protocol platform ID (analysisPlatformId from positions results)"
- `DefiCalculateEntryParams`: `id`: `String` — "Investment ID from search results"; `address`: `String` — "User wallet address"; `input_token`: `String` — "Input token contract address"; `input_amount`: `String` — "Input amount (human-readable, e.g. \"100\")"; `token_decimal`: `String` — "Token decimals"; `tick_lower`: `Option<i64>` — "Lower tick for V3 Pool position"; `tick_upper`: `Option<i64>` — "Upper tick for V3 Pool position"
- `DefiInvestParams`: `investment_id`: `String` — "Investment ID from defi_search or defi_detail"; `address`: `String` — "User wallet address"; `token`: `String` — "Token symbol or contract address (e.g. \"USDC\" or \"0xa0b8...\")"; `amount`: `String` — "Amount in minimal units (integer). Convert: userAmount × 10^tokenPrecision. Example: 0.1 USDC (precision=6) → \"100000\""; `token2`: `Option<String>` — "Second token symbol or address (V3 dual-token entry). Auto-detected from pool if only amount2 is provided."; `amount2`: `Option<String>` — "Second token amount in minimal units (V3 dual-token entry). CLI rebalances to pool ratio and returns surplus info."; `chain`: `Option<String>` — "Chain name (optional, auto-resolved from product detail if omitted)"; `slippage`: `Option<String>` — "Slippage tolerance (default \"0.01\" = 1%)"; `token_id`: `Option<String>` — "V3 Pool: NFT tokenId for adding to existing position (no tick/range needed)"; `tick_lower`: `Option<i64>` — "V3 Pool: lower tick for new position (alternative to range)"; `tick_upper`: `Option<i64>` — "V3 Pool: upper tick for new position (alternative to range)"; `range`: `Option<f64>` — "V3 Pool: price range percentage (e.g. 5 for ±5%). Required for V3 new position if tick_lower/tick_upper not provided."
- `DefiWithdrawParams`: `investment_id`: `String` — "Investment product ID"; `address`: `String` — "User wallet address"; `chain`: `String` — "Chain name (e.g. \"ethereum\", \"polygon\")"; `ratio`: `Option<String>` — "Redemption ratio: \"1\"=100% full exit, \"0.5\"=50%"; `token_id`: `Option<String>` — "V3 Pool NFT tokenId"; `slippage`: `Option<String>` — "Slippage tolerance (default \"0.01\")"; `amount`: `Option<String>` — "Partial exit amount in minimal units (integer). Convert: userAmount × 10^tokenPrecision. Get tokenPrecision from defi_position_detail."; `platform_id`: `Option<String>` — "Platform ID (analysisPlatformId) for auto-fetching position info"
- `DefiCollectParams`: `address`: `String` — "User wallet address"; `chain`: `String` — "Chain name"; `reward_type`: `String` — "Reward type: REWARD_PLATFORM, REWARD_INVESTMENT, V3_FEE, REWARD_OKX_BONUS, REWARD_MERKLE_BONUS, UNLOCKED_PRINCIPAL"; `investment_id`: `Option<String>` — "Investment product ID"; `platform_id`: `Option<String>` — "Platform ID (analysisPlatformId)"; `token_id`: `Option<String>` — "V3 Pool NFT tokenId (for V3_FEE)"; `principal_index`: `Option<String>` — "Principal order index (for UNLOCKED_PRINCIPAL)"
- `GasStationUpdateDefaultTokenParams`: `chain`: `String` — "Chain name or ID (e.g. \"ethereum\", \"1\")"; `gas_token_address`: `String` — "Gas token contract address to set as default (e.g. USDT/USDC/USDG address)"
- `GasStationDisableParams`: `chain`: `String` — "Chain name or ID (e.g. \"ethereum\", \"1\")"
- `TokenSearchParams`: `query`: `String` — "Token name, symbol, or contract address (e.g. \"ETH\", \"USDC\", \"0x...\")"; `chains`: `Option<String>` — "Comma-separated chain names, e.g. \"ethereum,solana\" (optional, searches all)"; `limit`: `Option<String>` — "Number of results per page (default: 20, max: 100). Use cursor for pagination."; `cursor`: `Option<String>` — "Pagination cursor. Pass the cursor value from the last item of the previous response to fetch the next page. Omit for first page."; `max_results`: `Option<String>` — "Auto-paginate up to N total entries (1..=500, max 10 pages). Returns {items,nextCursor,fetchedCount} in one call instead of manual cursor-chasing. Omit for a single page (default behavior)."
- `TokenAddressParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name, e.g. \"ethereum\", \"solana\" (optional, defaults to ethereum)"
- `MarketTokenParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional, defaults to ethereum)"
- `MarketPricesParams`: `tokens`: `String` — "Comma-separated \"chain:address\" pairs, e.g. \"ethereum:0xabc...,solana:1111...\""; `chain`: `Option<String>` — "Default chain if not specified per token (optional)"
- `MarketKlineParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional)"; `bar`: `Option<String>` — "Bar size: 1s, 1m, 5m, 15m, 30m, 1H (default), 4H, 1D, 1W"; `limit`: `Option<u32>` — "Number of data points, max 299 (default 100)"
- `TokenTradesParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional)"; `limit`: `Option<u32>` — "Number of trades, max 500 (default 100)"; `tag_filter`: `Option<String>` — "Filter by trader tag: 1=KOL, 2=Developer, 3=Smart Money, 4=Whale, 5=Fresh Wallet, 6=Insider, 7=Sniper, 8=Suspicious Phishing, 9=Bundler"; `wallet_filter`: `Option<String>` — "Filter by wallet address (comma-separated, max 10)"
- `TokenTagAddressParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional, defaults to ethereum)"; `tag_filter`: `Option<u8>` — "Filter by tag: 1=KOL, 2=Developer, 3=Smart Money, 4=Whale, 5=Fresh Wallet, 6=Insider, 7=Sniper, 8=Suspicious Phishing, 9=Bundler"; `limit`: `Option<String>` — "Number of results per page (default: 20, max: 100). Use cursor for pagination."; `cursor`: `Option<String>` — "Pagination cursor. Pass the cursor value from the last item of the previous response to fetch the next page. Omit for first page."; `max_results`: `Option<String>` — "Auto-paginate up to N total entries (1..=500, max 10 pages). Returns {items,nextCursor,fetchedCount} in one call instead of manual cursor-chasing. Omit for a single page (default behavior)."
- `MemepumpWalletParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional, defaults to solana)"; `wallet_address`: `Option<String>` — "Wallet address for position data (optional)"
- `PortfolioPnlOverviewParams`: `address`: `String` — "Wallet address"; `chain`: `String` — "Chain name (e.g. ethereum, solana)"; `time_frame`: `Option<String>` — "Time frame: 1=1D, 2=3D, 3=7D, 4=1M, 5=3M (default: 4 = 1M)"
- `PortfolioPnlDexHistoryParams`: `address`: `String` — "Wallet address"; `chain`: `String` — "Chain name (e.g. ethereum, solana)"; `begin`: `Option<String>` — "Start timestamp (milliseconds). Supply with `end`, OR use `since` instead."; `end`: `Option<String>` — "End timestamp (milliseconds). Supply with `begin`, OR use `since` instead."; `since`: `Option<String>` — "Relative time window: <positive-int><s|m|h|d>, e.g. \"24h\", \"7d\". Supply this OR begin+end."; `limit`: `Option<String>` — "Page size (1-100, default 20)"; `cursor`: `Option<String>` — "Pagination cursor from previous response"; `token`: `Option<String>` — "Filter by token contract address"; `tx_type`: `Option<String>` — "Transaction type: 1=BUY, 2=SELL, 3=Transfer In, 4=Transfer Out (comma-separated)"
- `PortfolioPnlRecentPnlParams`: `address`: `String` — "Wallet address"; `chain`: `String` — "Chain name (e.g. ethereum, solana)"; `limit`: `Option<String>` — "Page size (1-100, default 20)"; `cursor`: `Option<String>` — "Pagination cursor from previous response"
- `PortfolioPnlTokenPnlParams`: `address`: `String` — "Wallet address"; `chain`: `String` — "Chain name (e.g. ethereum, solana)"; `token`: `String` — "Token contract address"
- `MarketSignalListParams`: `chain`: `String` — "Chain name, e.g. \"ethereum\", \"solana\" (required)"; `wallet_type`: `Option<String>` — "Wallet type: 1=Smart Money, 2=KOL, 3=Whales (comma-separated, optional)"; `min_amount_usd`: `Option<String>` — "Min transaction amount in USD (optional)"; `max_amount_usd`: `Option<String>` — "Max transaction amount in USD (optional)"; `min_address_count`: `Option<String>` — "Min triggering wallet count (optional)"; `max_address_count`: `Option<String>` — "Max triggering wallet count (optional)"; `token_address`: `Option<String>` — "Filter for a specific token address (optional)"; `min_market_cap_usd`: `Option<String>` — "Min token market cap in USD (optional)"; `max_market_cap_usd`: `Option<String>` — "Max token market cap in USD (optional)"; `min_liquidity_usd`: `Option<String>` — "Min token liquidity in USD (optional)"; `max_liquidity_usd`: `Option<String>` — "Max token liquidity in USD (optional)"; `limit`: `Option<String>` — "Number of results per page (default: 20, max: 100). Use cursor for pagination."; `cursor`: `Option<String>` — "Pagination cursor. Pass the cursor value from the last item of the previous response to fetch the next page. Omit for first page."
- `AddressTrackerActivitiesParams`: `tracker_type`: `String` — "Tracker type: smart_money (or 1), kol (or 2), multi_address (or 3)"; `wallet_address`: `Option<String>` — "Wallet addresses, comma-separated (required when tracker_type=multi_address, max 20)"; `trade_type`: `Option<String>` — "Trade type: 0=all (default), 1=buy, 2=sell"; `chain`: `Option<String>` — "Chain filter (e.g. ethereum, solana). Omit for all chains"; `min_volume`: `Option<String>` — "Minimum trade volume in USD"; `max_volume`: `Option<String>` — "Maximum trade volume in USD"; `min_holders`: `Option<String>` — "Minimum number of holding addresses"; `min_market_cap`: `Option<String>` — "Minimum market cap in USD"; `max_market_cap`: `Option<String>` — "Maximum market cap in USD"; `min_liquidity`: `Option<String>` — "Minimum liquidity in USD"; `max_liquidity`: `Option<String>` — "Maximum liquidity in USD"
- `SwapQuoteParams`: `from`: `String` — "Source token contract address"; `to`: `String` — "Destination token contract address"; `amount`: `String` — "Amount in minimal units (wei/lamports)"; `chain`: `String` — "Chain name, e.g. \"ethereum\", \"solana\""; `swap_mode`: `Option<String>` — "Swap mode: exactIn (default) or exactOut"
- `SwapSwapParams`: `from`: `String` — "Source token contract address"; `to`: `String` — "Destination token contract address"; `amount`: `String` — "Amount in minimal units"; `chain`: `String` — "Chain name"; `slippage`: `Option<String>` — "Slippage tolerance in percent, e.g. \"1\" for 1%. Omit to use autoSlippage."; `wallet`: `String` — "User wallet address"; `gas_level`: `Option<String>` — "Gas priority: slow, average (default), fast"; `swap_mode`: `Option<String>` — "Swap mode: exactIn (default) or exactOut"; `tips`: `Option<String>` — "Jito tips in SOL for Solana MEV protection (range: 0.0000000001–2)"; `max_auto_slippage`: `Option<String>` — "Max auto slippage percent cap when autoSlippage is enabled (e.g. \"0.5\")"
- `SwapApproveParams`: `token`: `String` — "Token contract address to approve"; `amount`: `String` — "Approval amount in minimal units"; `chain`: `String` — "Chain name"
- `ChainParam`: `chain`: `String` — "Chain name, e.g. \"ethereum\", \"solana\", \"xlayer\""
- `PortfolioTotalValueParams`: `address`: `String` — "Wallet address"; `chains`: `String` — "Comma-separated chain names, e.g. \"ethereum,solana,xlayer\""; `asset_type`: `Option<String>` — "Asset type: 0=all (default), 1=tokens only, 2=DeFi only"; `exclude_risk`: `Option<String>` — "Exclude risky tokens: \"true\"=exclude (default), \"false\"=include. Only ETH/BSC/SOL/BASE"
- `PortfolioAllBalancesParams`: `address`: `String` — "Wallet address"; `chains`: `String` — "Comma-separated chain names, e.g. \"ethereum,solana\""; `exclude_risk`: `Option<String>` — "Exclude risky tokens: 0=filter out (default), 1=include"; `filter`: `Option<String>` — "Token filter level: 0=default (filters risk/custom/passive tokens), 1=return all tokens. Use 1 when you need the full token list including risk tokens (e.g. for security scanning)."
- `PortfolioTokenBalancesParams`: `address`: `String` — "Wallet address"; `tokens`: `String` — "Comma-separated \"chainName:tokenAddress\" pairs, e.g. \"ethereum:0xabc...,xlayer:\" Use empty address for native token (e.g. \"xlayer:\")"; `exclude_risk`: `Option<String>` — "Exclude risky tokens: 0=filter out (default), 1=include"
- `LeaderboardListParams`: `chain`: `String` — "Chain name, e.g. \"ethereum\", \"solana\" (required)"; `time_frame`: `String` — "Time frame (required): 1=1D, 2=3D, 3=7D, 4=1M, 5=3M"; `sort_by`: `String` — "Sort by (required): 1=PnL, 2=Win Rate, 3=Tx count, 4=Volume, 5=ROI"; `wallet_type`: `Option<String>` — "Wallet type (optional, single select): smartMoney, influencer, sniper, dev, fresh, pump"; `min_realized_pnl_usd`: `Option<String>` — "Minimum realized PnL in USD (optional)"; `max_realized_pnl_usd`: `Option<String>` — "Maximum realized PnL in USD (optional)"; `min_win_rate_percent`: `Option<String>` — "Minimum win rate percentage 0-100 (optional)"; `max_win_rate_percent`: `Option<String>` — "Maximum win rate percentage 0-100 (optional)"; `min_txs`: `Option<String>` — "Minimum number of transactions (optional)"; `max_txs`: `Option<String>` — "Maximum number of transactions (optional)"; `min_tx_volume`: `Option<String>` — "Minimum transaction volume in USD (optional)"; `max_tx_volume`: `Option<String>` — "Maximum transaction volume in USD (optional)"
- `ClusterAddressParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional, defaults to ethereum)"
- `ClusterTopHoldersParams`: `address`: `String` — "Token contract address"; `chain`: `Option<String>` — "Chain name (optional, defaults to ethereum)"; `range_filter`: `String` — "Holder rank tier: 1 = top 10, 2 = top 50, 3 = top 100"
- `GatewayGasLimitParams`: `from`: `String` — "Sender address"; `to`: `String` — "Recipient / contract address"; `amount`: `Option<String>` — "Transfer value in minimal units (default \"0\")"; `data`: `Option<String>` — "Encoded calldata hex for contract interactions (optional)"; `chain`: `String` — "Chain name"
- `GatewaySimulateParams`: `from`: `String` — "Sender address"; `to`: `String` — "Recipient / contract address"; `amount`: `Option<String>` — "Transfer value in minimal units (default \"0\")"; `data`: `String` — "Encoded calldata hex"; `chain`: `String` — "Chain name"
- `GatewayBroadcastParams`: `signed_tx`: `String` — "Fully signed transaction (hex for EVM, base58 for Solana)"; `address`: `String` — "Sender wallet address"; `chain`: `String` — "Chain name"; `mev_protection`: `bool` #[serde(default)] — "Enable MEV protection (supported on Base and other EVM chains)"
- `GatewayOrdersParams`: `address`: `String` — "Wallet address"; `chain`: `String` — "Chain name"; `order_id`: `Option<String>` — "Specific order ID from broadcast response (optional)"
- `WorkflowTokenResearchParams`: `address`: `Option<String>` — "Token contract address (use this OR query)"; `query`: `Option<String>` — "Token symbol or name to search (use this OR address). When provided without address, returns top 5 search results for user selection. After user selects, call again with the chosen address."; `chain`: `Option<String>` — "Chain name (e.g. \"solana\", \"ethereum\"). Defaults to solana if omitted."
- `WorkflowSmartMoneyParams`: `chain`: `Option<String>` — "Chain name (e.g. \"solana\", \"ethereum\"). Defaults to solana."
- `WorkflowNewTokensParams`: `chain`: `Option<String>` — "Chain name (e.g. \"solana\"). Defaults to solana."; `stage`: `Option<String>` — "Launchpad stage: \"MIGRATED\" (default) or \"MIGRATING\""
- `WorkflowWalletAnalysisParams`: `address`: `String` — "Wallet address to analyse"; `chain`: `Option<String>` — "Chain name (e.g. \"solana\", \"ethereum\"). Defaults to solana."
- `WorkflowPortfolioParams`: `address`: `String` — "Wallet address"; `chains`: `Option<String>` — "Comma-separated chain names or indexes (e.g. \"ethereum,solana\"). Defaults to \"1,501\"."
- `CrossChainQuoteParams`: `from`: `String` — "Source token contract address or alias (e.g. \"usdc\", \"eth\", \"0x...\")"; `to`: `String` — "Destination token contract address or alias"; `from_chain`: `String` — "Source chain name (e.g. \"ethereum\", \"arbitrum\", \"base\")"; `to_chain`: `String` — "Destination chain name (e.g. \"optimism\", \"solana\")"; `readable_amount`: `String` — "Human-readable amount (e.g. \"10\" for 10 USDC)"; `receive_address`: `Option<String>` — "Destination receive address. Required for heterogeneous bridges (EVM ⇌ non-EVM, e.g. EVM → Solana); family must match `to_chain`."; `sort`: `Option<String>` — "Sort preference: 0=optimal (default), 1=fastest, 2=max output"
- `CrossChainStatusParams`: `tx_hash`: `Option<String>` — "Source chain transaction hash returned by cross-chain execute. Provide this OR `order_id` (mutually exclusive)."; `order_id`: `Option<String>` — "Order id from a prior cross_chain_execute (e.g. swapOrderId, approveOrderId). Use this OR `tx_hash`. Resolved internally to a tx hash via the authenticated wallet `/order/detail` endpoint (login required)."; `bridge_id`: `String` — "Bridge id (required by server — returns 50014 if absent). Get it from the `bridgeId` field of the prior `cross_chain_execute` / `cross_chain_quote` result, or from `cross_chain_bridges`."; `from_chain`: `String` — "Source chain name or chainIndex (e.g. \"ethereum\" or \"1\"). Required — server returns 50014 (chainIndex) without it."
- `CrossChainBridgesParams`: `from_chain`: `Option<String>` — "Source chain (independently optional). See tool description for the four combinations of from_chain / to_chain."; `to_chain`: `Option<String>` — "Destination chain (independently optional)."
- `PaymentQuoteParams`: `url`: `String` — "The A2MCP / merchant endpoint URL to probe."; `param`: `Vec<String>` #[serde(default)] — "Known business params as \"key=value\" strings (optional, repeatable)."; `method`: `String` #[serde(default = "default_quote_method")] — "HTTP method to probe with (\"GET\" by default). Use \"POST\"/\"PUT\"/\"PATCH\" for A2MCP endpoints whose paid call is not a GET — known params then ride in the JSON body instead of the query string."
- `PaymentPayParams`: `payment_id`: `String` — "The paymentId returned by payment_quote."; `selected_index`: `Option<usize>` — "User-confirmed 0-based index into accepts[] (optional)."; `param`: `Vec<String>` #[serde(default)] — "Additional business params as \"key=value\" strings (optional)."; `yes`: `bool` #[serde(default)] — "Approve the fund-moving payment (bypass the confirming gate). Default false."
- `PaymentDecodeReceiptParams`: `header`: `Option<String>` — "x402 PAYMENT-RESPONSE header value (base64/base64url). Provide this OR receipt."; `receipt`: `Option<String>` — "Raw charge receipt JSON string. Provide this OR header."
- `PaymentSessionParams`: `action`: `String` — "Operation: \"open\" | \"voucher\" | \"topup\" | \"close\"."; `channel_id`: `Option<String>` — "Channel id (required for voucher/topup/close)."; `challenge`: `Option<String>` — "WWW-Authenticate / 402 challenge value (as required by the op)."; `unit_amount`: `Option<String>` — "Per-voucher unit amount (atomic string), for voucher."; `cumulative_amount`: `Option<String>` — "Prior authorized cumulative amount (atomic string). The decision layer adds unit_amount to this; omit for the first voucher (treated as 0). NOTE: this is the PRIOR cumulative (unit_amount is added on top), NOT the absolute new cumulative — the opposite of the CLI's `payment session voucher --cumulative-amount`, which takes the absolute new cumulative and derives `unit = new − prior` internally (the CLI has persisted session state; this stateless MCP entry does not)."; `escrow`: `Option<String>` — "Escrow address (op-dependent)."; `chain_id`: `Option<u64>` — "Chain id (op-dependent)."; `deposit`: `Option<String>` — "Deposit amount for open/topup (atomic string)."; `from`: `Option<String>` — "Payer address (optional; defaults to selected account)."; `reuse_signature`: `Option<String>` — "Existing voucher signature to reuse (reuse-vs-sign signal)."; `server_cumulative`: `Option<String>` — "Seller-reported cumulative from a 70015 drift error; forces a resign."
- `PaymentA2aStatusParams`: `payment_id`: `String` — "The a2a payment id."; `wait`: `bool` #[serde(default)] — "Poll to terminal state (3s interval, 60s ceiling). Default false = one-shot."

Parameter structs defined outside `mcp/mod.rs` (fields in declaration order; `String` = required, `Option<…>` = optional):
- `memepump::MemepumpTokenListParams` (memepump.rs:551): `chain: String` + optional strings `stage, wallet_address, protocol_id_list, quote_token_address_list, min/max_top10_holdings_percent, min/max_dev_holdings_percent, min/max_insiders_percent, min/max_bundlers_percent, min/max_snipers_percent, min/max_fresh_wallets_percent, min/max_suspected_phishing_wallet_percent, min/max_bot_traders, min/max_dev_migrated, min/max_market_cap, min/max_volume, min/max_tx_count, min/max_bonding_percent, min/max_holders, min/max_token_age, min/max_buy_tx_count, min/max_sell_tx_count, min/max_token_symbol_length, has_at_least_one_social_link, has_x, has_telegram, has_website, website_type_list, dex_screener_paid, live_on_pump_fun, dev_sell_all, dev_still_holding, community_takeover, bags_fee_claimed, min/max_fees_native, keywords_include, keywords_exclude` (stage default `NEW` inside fetch).
- `token::HotTokensParams` (token.rs:734): `ranking_type: String` + optional strings `chain, rank_by, time_frame, risk_filter, stable_token_filter, project_id, price_change_min/max, volume_min/max, market_cap_min/max, liquidity_min/max, transaction_min/max, txs_min/max, unique_trader_min/max, holders_min/max, inflow_min/max, fdv_min/max, mentioned_count_min/max, social_score_min/max, top10_hold_percent_min/max, dev_hold_percent_min/max, bundle_hold_percent_min/max, suspicious_hold_percent_min/max, is_lp_burnt, is_mint, is_freeze, limit, cursor, max_results`.
- `social::SocialNewsLatestParams`: optional `token_symbols, begin, end, importance, platform, limit, cursor, detail_level, language, since, max_results`.
- `social::SocialNewsBySymbolParams`: `token_symbols: String` + optional `sort_by, sentiment, importance, platform, limit, cursor, detail_level, begin, end, language, since, max_results`.
- `social::SocialNewsSearchParams`: `keyword: String` + optional `sort_by, sentiment, importance, platform, token_symbols, begin, end, detail_level, limit, cursor, language, since, max_results`.
- `social::SocialNewsDetailParams`: `article_id: String`, optional `language`.
- `social::SocialSentimentRankingParams`: optional `time_frame, sort_by, limit`.
- `social::SocialSentimentSymbolParams`: `token_symbols: String`, optional `time_frame, trend_points`.
- `social::SocialVibeTimelineParams`: `chain: String, token_address: String`, optional `time_frame`.
- `social::SocialVibeTopKolsParams`: `chain: String, token_address: String`, optional `sort_by, time_frame, limit`.

### `onchainos workflow token-research`  (hidden: no)
- Handler: `commands/workflows/token_research.rs:167` `run` (core logic `fetch_and_assemble` :21, `search_and_select` :125, `assemble` :208)
- Options: `--address <ADDRESS>` optional; `--query <QUERY>` optional; `--chain <CHAIN>` optional (local arg, shadows the global `--chain`; help: "Chain (e.g. solana, ethereum, base). Auto-detects from global --chain if omitted").
- Auth: jwt-optional.
- Steps:
  1. `ensure!(address.is_some() || query.is_some(), "token-research requires --address or --query")` (before any client/network).
  2. `client = ctx.client_async()` (may refresh JWT).
  3. `chain_index = resolve_chain(--chain)` else `ctx.chain_index_or("solana")` (global `--chain` → config `default_chain` → `501`).
  4. If `--query` given and `--address` absent → `search_and_select`:
     - `GET /api/v6/dex/market/token/search?chains=<resolve_chains(chain_index)>&search=<query>&limit=5` (`token::fetch_search`, token.rs:614; `cursor` absent).
     - `items = data as array` (non-array → empty). Empty → error `token-research: no tokens found for query '<query>' on chain <chain_index>`.
     - candidates[i] = `{"address": tokenContractAddress ?? address ?? null, "chain": chainIndex ?? chain ?? null, "index": i+1, "logoUrl": logoUrl ?? null, "marketCap": marketCap ?? null, "name": tokenName ?? name ?? null, "price": price ?? null, "symbol": tokenSymbol ?? symbol ?? null}` (key present with JSON null counts as present).
     - Output `{"ok":true,"data":{"candidates":[..],"message":"Multiple tokens found. Please select one by number (1-5) to continue the full research workflow.","query":"<query>","step":"select-token","workflow":"token-research"}}` (message text is fixed even for a single result).
  5. Else (address given; query ignored) → `fetch_and_assemble(address, chain_index)`:
     - Step 1 (`token::fetch_report`, token.rs:1119; 4 concurrent requests):
       a. `POST /api/v6/dex/market/token/basic-info` body `[{"chainIndex":ci,"tokenContractAddress":addr}]`
       b. `POST /api/v6/dex/market/price-info` body `[{"chainIndex":ci,"tokenContractAddress":addr}]`
       c. `GET /api/v6/dex/market/token/advanced-info?chainIndex=<ci>&tokenContractAddress=<addr>`
       d. `POST /api/v6/security/token-scan` body `{"source":"onchain_os_cli","tokenList":[{"chainId":ci,"contractAddress":addr}]}`
       All four failed → error `token report: all sub-calls failed for address <addr> on chain <ci>` (exit 1). Individual failures → null.
     - Step 2 (4 concurrent, each failure → null):
       e. `GET /api/v6/dex/market/token/holder?chainIndex=<ci>&tokenContractAddress=<addr>&limit=100` (`tagFilter` empty → dropped)
       f. `GET /api/v6/dex/market/token/cluster/overview?chainIndex=<ci>&tokenContractAddress=<addr>`
       g. `GET /api/v6/dex/market/token/top-trader?chainIndex=<ci>&tokenContractAddress=<addr>&limit=20`
       h. `POST /api/v6/dex/market/signal/list` body `{"chainIndex":ci,"limit":"20","tokenAddress":addr}`
     - Step 3 only if `is_launchpad_token(advancedInfo)` (4 concurrent, failures → null): `GET /api/v6/dex/market/memepump/tokenDetails`, `/tokenDevInfo`, `/tokenBundleInfo`, `/similarToken`, each `?chainIndex=<ci>&tokenContractAddress=<addr>`.
     - `assemble` (defensive all-null check with message `token-research: all Step 1 sub-calls failed for address <a> on chain <c>` — unreachable via CLI).
- Output: `{"ok":true,"data":{"address":addr,"chain":ci,"core":{"contract":advancedInfo,"info":basicInfo,"price":priceInfo,"security":tokenScan},"launchpad":null | {"bundleInfo":..,"devInfo":..,"similarTokens":..,"tokenDetails":..},"structure":{"cluster":..,"holders":..,"signals":..,"topTraders":..},"workflow":"token-research"}}`. All leaf values are the API `data` passthrough (or null).
- Errors: exit 1 for ensure failure, no search results, all-Step-1 failure, client creation failure, search API error (search path propagates errors).
- Side effects: read-only.
- Nondeterminism: request ordering within each step is concurrent (compare as a set per step; steps are sequential); passthrough data.
- Parity test cases: `workflow token-research` → `token-research requires --address or --query` (SAFE); `workflow token-research --query BONK --chain solana` (SAFE); `workflow token-research --address DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --chain solana` (SAFE); `workflow token-research --address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum` (SAFE).

### `onchainos workflow smart-money`  (hidden: no)
- Handler: `commands/workflows/smart_money.rs:120` `run` → `fetch_and_assemble` (:22)
- Options: `--chain <CHAIN>` optional (local; "defaults to solana").
- Auth: jwt-optional.
- Steps:
  1. `chain_index = resolve_chain(--chain)` else `ctx.chain_index_or("solana")`; then `client_async`.
  2. Step 1: `POST /api/v6/dex/market/signal/list` body `{"chainIndex":ci,"limit":"20"}`; failure → `rawSignals = null` (not an error).
  3. `top = extract_top_tokens(rawSignals, 5)`.
  4. Step 2: per top token concurrently (each token task runs 3 concurrent requests, then optional 2):
     - `POST /api/v6/dex/market/price-info` body `[{"chainIndex":ci,"tokenContractAddress":addr}]`
     - `GET /api/v6/dex/market/token/advanced-info?chainIndex=<ci>&tokenContractAddress=<addr>`
     - `POST /api/v6/security/token-scan` body `{"source":"onchain_os_cli","tokenList":[{"chainId":ci,"contractAddress":addr}]}`
     - if `is_launchpad_token(advanced)`: `GET /api/v6/dex/market/memepump/tokenDevInfo` and `/tokenBundleInfo` (`?chainIndex&tokenContractAddress`).
     Results re-ordered to the `top` order; a panicked task is dropped from the list.
- Output: `{"ok":true,"data":{"chain":ci,"rawSignals":<signal list data or null>,"topTokens":[{"address":addr,"data":{"contract":advanced,"launchpad":null|{"bundleInfo":..,"devInfo":..},"price":..,"security":..,"signal":<original signal item>}}],"workflow":"smart-money"}}`.
- Errors: only client creation errors (exit 1).
- Side effects: read-only. Nondeterminism: concurrent request order; passthrough data.
- Parity test cases: `workflow smart-money --chain solana` (SAFE); `workflow smart-money --chain ethereum` (SAFE); `--chain base workflow smart-money` style via global flag (SAFE).

### `onchainos workflow new-tokens`  (hidden: no)
- Handler: `commands/workflows/new_tokens.rs:117` `run` → `fetch_and_assemble` (:21)
- Options: `--chain <CHAIN>` optional (local; default solana); `--stage <STAGE>` optional, default `MIGRATED`.
- Auth: jwt-optional.
- Steps:
  1. chain_index as above; `client_async` (note: client created **before** stage validation).
  2. `stage_norm = stage.to_ascii_uppercase()`; not in `["MIGRATED","MIGRATING"]` → error `stage must be one of ["MIGRATED", "MIGRATING"] (case-insensitive), got: <original stage>`.
  3. Step 1: `GET /api/v6/dex/market/memepump/tokenList?chainIndex=<ci>&stage=<STAGE>` (direct `client.get`); failure → `tokenList = null`.
  4. `top = new_tokens::extract_top_tokens(tokenList, 10)`.
  5. Step 2 per token concurrently (4 concurrent each): `POST /api/v6/security/token-scan` (body as above), `GET /api/v6/dex/market/token/advanced-info`, `GET /api/v6/dex/market/memepump/tokenDevInfo`, `GET /api/v6/dex/market/memepump/tokenBundleInfo` (each `?chainIndex&tokenContractAddress`). Re-ordered to `top` order.
- Output: `{"ok":true,"data":{"chain":ci,"enriched":[{"address":addr,"data":{"bundleInfo":..,"contract":..,"devInfo":..,"security":..,"token":<list item>}}],"stage":"MIGRATED","tokenList":<list data or null>,"workflow":"new-tokens"}}`.
- Errors: invalid stage (exit 1), client creation.
- Side effects: read-only. Nondeterminism: concurrent order, passthrough data.
- Parity test cases: `workflow new-tokens --chain solana` (SAFE); `workflow new-tokens --chain solana --stage migrating` (SAFE, output stage `MIGRATING`); `workflow new-tokens --stage foo` → error (SAFE).

### `onchainos workflow wallet-analysis`  (hidden: no)
- Handler: `commands/workflows/wallet_analysis.rs:69` `run` → `fetch_and_assemble` (:17)
- Options: `--address <ADDRESS>` required; `--chain <CHAIN>` optional (local; default solana).
- Auth: jwt-optional.
- Steps:
  1. `client_async`; chain_index as above.
  2. Step 1 concurrently: `GET /api/v6/dex/market/portfolio/overview?chainIndex=<ci>&walletAddress=<addr>&timeFrame=3`; same with `timeFrame=4`; `GET /api/v6/dex/balance/all-token-balances-by-address?address=<addr>&chains=<resolve_chains(ci)>`.
  3. Step 2: `GET /api/v6/dex/market/portfolio/recent-pnl?chainIndex=<ci>&walletAddress=<addr>`.
  4. Step 3: `GET /api/v6/dex/market/address-tracker/trades?trackerType=3&walletAddress=<addr>&chainIndex=<ci>`.
  Every failure → null; never errors on API failure.
- Output: `{"ok":true,"data":{"activities":..,"address":addr,"balances":..,"chain":ci,"performance":{"30d":<timeFrame 4>,"7d":<timeFrame 3>},"recentPnl":..,"workflow":"wallet-analysis"}}`.
- Errors: missing `--address` → clap exit 2; client creation → exit 1.
- Side effects: read-only. Nondeterminism: Step-1 request order.
- Parity test cases: `workflow wallet-analysis --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum` (SAFE); `workflow wallet-analysis --address <sol addr> --chain solana` (SAFE); `workflow wallet-analysis` → clap error (SAFE).

### `onchainos workflow portfolio`  (hidden: no)
- Handler: `commands/workflows/portfolio.rs:52` `run` → `fetch_and_assemble` (:15)
- Options: `--address <ADDRESS>` required; `--chains <CHAINS>` optional (comma list); global `--chain` honoured.
- Auth: jwt-optional.
- Steps:
  1. `client_async`.
  2. `chains_str = ctx.resolve_chains_or(--chains, "1,501")`: explicit `--chains` **verbatim** (e.g. `ethereum,solana`), else `resolve_chain(global --chain)`, else `1,501`.
  3. `primary = chains_str.split(',').next()` if non-empty → `resolve_chain` (not trimmed), else `501`.
  4. Concurrently: `GET /api/v6/dex/balance/all-token-balances-by-address?address=<addr>&chains=<resolve_chains(chains_str)>`; `GET /api/v6/dex/balance/total-value-by-address?address=<addr>&chains=<resolve_chains(chains_str)>`; `GET /api/v6/dex/market/portfolio/overview?chainIndex=<primary>&walletAddress=<addr>&timeFrame=4`. Failures → null.
- Output: `{"ok":true,"data":{"address":addr,"balances":..,"chains":<chains_str as given>,"overview":..,"totalValue":..,"workflow":"portfolio"}}` (CLI echoes unresolved names; MCP echoes indexes).
- Errors: missing `--address` → clap exit 2.
- Side effects: read-only. Nondeterminism: request order.
- Parity test cases: `workflow portfolio --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (SAFE, chains `1,501`); `workflow portfolio --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chains ethereum` (SAFE, output chains `ethereum`); `--chain base workflow portfolio --address 0xd8dA…` (SAFE, chains `8453`).

### `onchainos upgrade`  (hidden: no)
- Handler: `commands/upgrade.rs:31` `execute`
- Options: none (no `--check`/`--force`; test `upgrade_help_has_no_legacy_flags`).
- Auth: anonymous.
- Steps: run `npx -y @okxweb3/onchainos-installer install` via `std::process::Command::status()` (stdin/stdout/stderr inherited; the installer's own output streams to the terminal).
- Output: on success **nothing is printed by onchainos** (exit 0).
- Errors: spawn failure → `failed to start \`npx -y @okxweb3/onchainos-installer install\`: <io error>`; non-zero exit → `` `npx -y @okxweb3/onchainos-installer install` exited with <ExitStatus Display> `` (unix `exit status: 1`, Windows `exit code: 1`); exit 1 with JSON on stdout. On Windows `Command::new("npx")` does not resolve `npx.cmd`, so it likely fails to start.
- Side effects: local-only (installs/updates software via npm; network to npm registry).
- Nondeterminism: installer output.
- Parity test cases: `upgrade --help` (SAFE); `upgrade` (UNSAFE — modifies installation).

### `onchainos preflight`  (hidden: no — about text "Deprecated compatibility command")
- Handler: `commands/upgrade.rs:44` `preflight`
- Options: none (any extra arg → clap `unexpected argument` error, exit 2 — test `preflight_rejects_legacy_arguments`).
- Auth: anonymous.
- Steps: always fails.
- Output/Errors: stdout `{"ok":false,"error":"`onchainos preflight` is deprecated; use `npx -y @okxweb3/onchainos-installer install`"}`, exit 1.
- Side effects: local-only (audit entry). Nondeterminism: none.
- Parity test cases: `preflight` (SAFE); `preflight --force` → clap error exit 2 (SAFE).


---

## Open questions

1. `tests/cli_preflight.rs::preflight_reports_deprecation` asserts the deprecation text is on **stderr**, but `upgrade::preflight` returns an `Err` that `main.rs` prints via `output::error` to **stdout** (`{"ok":false,"error":"..."}`, exit 1). Either the test is stale or a path was missed; the lite should follow the source (stdout JSON) unless the harness shows otherwise.
2. Exact bytes of MCP `inputSchema` objects (schemars 1.2.1, draft 2020-12 via rmcp `schema_for_type`): whether `$schema`/`title` are kept, how multi-line `///` doc comments are joined (newline vs space), `Option<String>` rendering (`"type":["string","null"]`), integer formats (`uint8`/`uint32`/`int64`/`uint` + `minimum`), `default` for `#[serde(default)]` fields. Needs a capture from the real binary (`tools/list`).
3. `CallToolResult` serialization in rmcp 1.3.0 was not read from source: assumed `{"content":[{"type":"text","text":..}],"isError":false|true}` (no `structuredContent`). Verify with a live capture.
4. rmcp default handling of non-tool methods (`resources/list`, `prompts/list`, `logging/setLevel`, `ping`) is not specified by this code; capture from the binary if the lite must match.
5. WS server frame formats are inferred from the client code only: the login ack must carry `"code"` as a JSON **string** (`"0"`) — a numeric `0` would be treated as failure (`login error: ...`); `{"event":"error"}` during login is ignored until the 10 s timeout. Confirm against the real wsdex server / mock.
6. The WS URL is compile-time: default `wss://wsdex.okx.com/ws/v6/dex`, but the current checkout's `cli/.env` sets `ONCHAINOS_WS_URL=ws://127.0.0.1:18899/ws/v6/dex` (and `OKX_BASE_URL=http://127.0.0.1:18899`), i.e. the parity build targets a local mock. The lite needs an equivalent build/config switch.
7. `workflow smart-money` relies on signal-list items exposing top-level `tokenContractAddress`/`address` and numeric `walletCount`/`addressCount`; if the live API nests the token or returns counts as strings, `topTokens` is empty or ordered only by address. The spec reproduces the code; the real response shape is unverified.
8. Whether any dependency enables `serde_json/arbitrary_precision` (features are not visible in Cargo.lock). If enabled, passthrough numbers would be preserved verbatim; if not (assumed), floats are re-printed by ryu.
9. clap id collision: workflow subcommands define a local `--chain` with the same id as the global `--chain`. When both `onchainos --chain X workflow smart-money --chain Y` are given, which value the local field receives (expected Y) is not verified.
10. `onchainos upgrade` on Windows: `std::process::Command::new("npx")` does not resolve `npx.cmd`; it likely always fails with `failed to start ...`. Unverified.
11. The relayed user request mentions "support the muse"; the meaning of "muse" (beyond the repo name `muse-research`) is unclear for this partition.
