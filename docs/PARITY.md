# Parity with upstream onchainos 4.6.3

What "1:1" means here, how it is enforced, and every known difference.

## Enforced

| Guard | Tool | What it proves |
|---|---|---|
| Command surface | `lib/spec.json` generated from the upstream binary's `--help` | same commands, options, defaults, possible values, help text; clap-identical usage errors (exit 2) |
| Coverage | `node tools/check.mjs` | every upstream command has exactly one handler consuming exactly the upstream options |
| Traffic + output | `node test/parity/run.mjs` | ~4000 cases, per case: identical HTTP requests (method, path, query order, body bytes, headers), stdout bytes, exit code and state files (`session.json`, `wallets.json`, caches, …) vs the upstream binary |
| Clap surface | `node test/parity/run.mjs --cases gaps` | the parser before any handler runs: `help` subcommand (nested, aliases, hidden, `help help`), `--help`/`-h`/`-V` placement and short clusters, "similar …" tips, missing values, `--`, repeated globals, bare groups — stdout, stderr and exit code byte-compared |
| Crypto | `node tools/test-unit.mjs` | keccak, secp256k1 (RFC 6979, low-s, recovery id), ed25519, x25519, HPKE (X25519/HKDF-SHA256/AES-256-GCM), EIP-712/3009, base58, file keyring — byte-equal to vectors produced by upstream's own crates (`test/oracle`) |
| MCP catalogue | `lib/mcp-tools.json` dumped from the upstream `mcp` server | identical tool names, descriptions and input schemas |

## Intentional differences

| Area | Upstream | Lite | Why |
|---|---|---|---|
| Distribution | Rust binary installed via `npx @okxweb3/onchainos-installer` | Node scripts inside the skill folder | no install step; works in sandboxes |
| State dir | `~/.onchainos` (`ONCHAINOS_HOME`) | `~/.onchainos-lite` (`OCL_HOME`; `ONCHAINOS_HOME` also honoured) | coexist with the official CLI; file formats are identical, so a state dir can be copied either way |
| Credential store | OS keychain on macOS/Windows, encrypted file on Linux | encrypted file everywhere (same format as upstream Linux) | no native modules; works in containers/VMs |
| TLS trust | compiled-in webpki roots | bundled + system store + `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`; curl fallback | TLS-inspecting egress (Muse Sentinel) |
| DoH failover | downloads `okx-pilot` binary, resolves via DoH, rotates proxy nodes | not implemented (also no DoH step in `mcp` startup) | extra hosts + binary download; only matters where web3.okx.com is DNS-blocked. `doh-cache.json` is never written |
| API origin override | compile time (`cli/.env`) | `OCL_BASE_URL` / `OCL_WS_URL` / `OCL_AGENT_WS_URL` env | parity harness and staging |
| Transport error text | reqwest error chain after the context (`Network unavailable — …: error sending request for url (…): …`) | data commands: Node's error message after the same context; wallet endpoints: reqwest's chain for DNS / connect / timeout / reset / truncated body, Node's text for TLS and rarer failures | different HTTP stacks; context text and exit code identical |
| `upgrade` | runs the npx installer | returns an error explaining lite is updated by replacing the skill folder | installing the Rust CLI defeats the purpose |
| `preflight` | deprecated error | same error | — |
| Extra commands | — | `doctor`, `auth status`, `auth api-key set/clear`, `auth transfer init/seal/open` | sandbox diagnostics; API-key auth without the Rust CLI; moving credentials into a VM without exposing them in chat |
| `help doctor`, `help auth …` | `error: unrecognized subcommand` (exit 2) | the lite command's help | the extra commands are documented where they exist; they stay out of subcommand lists and "similar" tips, so every upstream message is unchanged |
| API-key (HMAC) auth | removed after v3.3.15 (only wallet JWT or anonymous) | restored with v3.3.15 wire format: `OK-ACCESS-KEY/SIGN/PASSPHRASE/TIMESTAMP`, `ok-client-type: cli`; precedence wallet JWT > API key > anonymous | lets data commands run with a developer key where a wallet login is not wanted; inactive unless a key is configured, so parity runs are unaffected |
| Concurrent keyring writers | read-modify-write without a lock (Linux file store) | exclusive `keyring.lock` around every read-modify-write | agents run commands in parallel (observed in Muse): without the lock a pending login and a pending transfer overwrote each other |
| Proxy transport | reqwest proxy support | raw CONNECT (Basic proxy auth) + own HTTP/1.1 over the tunnel | Node ≥ 24.20 with `NODE_USE_ENV_PROXY=1` ignores `createConnection` and dials the proxy with TLS (`EPROTO`) — observed in the Muse VM |
| Client identity | UA `OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`, `ok-client-version: 4.6.3` | identical | server treats lite exactly like the parity version; change in `lib/config.mjs` if lite traffic should be distinguishable |

## Per-area notes

Every other observable difference, one per line: what differs — when you can see it — why.
"(upstream random)" marks places where upstream itself varies run to run and lite picks one
stable outcome; parity cases mask or avoid those values.

**Parser / clap**
- Usage lines (help on stdout, errors on stderr) name `onchainos`; upstream echoes its executable file name (`onchainos.exe`, …) — always — lite runs as `node ocl.mjs`, there is no binary name to echo; the runner normalises it.
- Otherwise none known: `core/cli.mjs` reproduces clap 4.6 (gaps suite + every group's usage-error cases).

**Transport & error texts** (see also *Transport error text*, *TLS trust*)
- Payment hosts (merchant, A2MCP endpoint, X Layer RPC): anyhow `{:#}` chains stop at `error sending request for url (…)`, upstream continues with the hyper / io source — on network failure, e.g. the stderr `Permit2 allowance pre-check unavailable … (…)` warning — the wallet client's reqwest-chain mapping is not applied to these hosts.
- TLS failures carry OpenSSL wording (`unable to get local issuer certificate`; WS: `TLS error: <node message>`) instead of rustls's (`invalid peer certificate: UnknownIssuer`) — on a bad chain — Node TLS stack.
- Parallel steps (`token report`, `workflow *`, `agent asp list-tasks`) start requests in source order; upstream's `tokio::join!` wire order varies — same request set and output; the runner reports `request-order` as a pass (upstream random).
- `security token-scan` with > 50 tokens posts the batches one after another; upstream spawns them behind a FIFO mutex and sometimes sends batch 2 first (upstream random).
- Multipart file names (`agent upload`, `file-upload`) are sent verbatim; reqwest backslash-escapes `"`, `\`, CR, LF — only for such names.

**OS-localized io::Error texts**
- `… (os error N)` texts are English (Windows FormatMessage en-US, Unix strerror); upstream on a non-English Windows prints the system language (`系統找不到指定的檔案。 (os error 2)`) — file, socket and DNS errors on localized Windows; the code is identical — Node exposes errno names, not the localized text. Cases that hit OS errors compare the code only (`osErrorText: "code"`).
- errno values outside lite's tables print Node's message instead of the OS text — rare socket / fs errors.

**State files**
- Rust HashMaps are written in a fixed order: sorted keys for `wallets.json` `accountsMap`, `balance_cache.json` `accounts`, `payment_cache.json` `endpoints`; insertion order for `subscriptions.json` `by_host` (upstream random).
- Same root cause where upstream iterates those maps: first-key fallback of `resolve_active_account_id` (no selected/default account), `wallet send --from` when several accounts match, `accountIds` order in `wallet balance --all` / login summary, and the `--all` total's f64 summation order (last bit) (upstream random).
- Hand-edited files with a duplicate key — `payments/*.json`, `payment_cache.json`, `subscriptions.json`, `a2mcp/a2free_*.json` — are accepted (last wins); upstream's serde derive rejects them and reports the entry missing/expired. Files decoded through `core/serde.mjs` reject duplicates like serde.
- `payments/*.json` and `<state dir>/.env` (the `EVM_PRIVATE_KEY` fallback) with invalid UTF-8 are decoded lossily; upstream's `read_to_string` fails.
- Everything upstream writes under `~/.onchainos` — including the funding-QR PNG fallback `tmp/funding-qr` printed in `qr` output — lands in the lite state dir (*State dir*).

**Wallet & DeFi**
- Where upstream panics (`panic=abort`: no JSON, exit 0xC0000409 / SIGABRT) lite prints `{"ok":false,…}` and exits 1: wallet API error body without `msg` truncated to 200 bytes inside a multi-byte character (lite shows U+FFFD); `defi invest` inserting a warning/`rebalance` into a non-object `data`; V3 `--range` with `tickSpacing` 0; DeFi amount helpers on non-ASCII input (lite slices UTF-16, Rust slices bytes).
- Panics lite does reproduce (`receive.rs` `unreachable!`, UTXO BRC-20 `expect`): same text and exit status, but `thread '<unnamed>' (<id>)` shows the Node pid and the source path uses the host separator.
- QR display mode: in mintty/MSYS without winpty (outside Codex) upstream sees a terminal (`terminal-unicode`), lite picks `image-notify` — Node `isatty` cannot detect pty pipes; piped and agent use are identical.
- QR PNG temp-dir edges: set-but-blank `TMP`/`TEMP` gives upstream a random one-char junk dir (lite always `\0`, which fails); drive-relative `TMP=Q:rel` resolves to the drive root (Node has no per-drive cwd); on Unix a deleted cwd is still used (Node caches `process.cwd()`).
- Post-login steps (4 s heartbeat, 4 s preparation, 15 s subscription setup): a timed-out request is abandoned, not cancelled — same output, but the process can linger until that request's HTTP timeout.

**Payment**
- An x402 402 inside a parallel step (`token report`, `workflow *`): upstream's `notifications` order/count and payment-config fetches vary (shared PaymentState); lite follows request order (upstream random).
- A2MCP endpoint URL errors: WHATWG `URL` + `domainToASCII`/NFKC mapped onto the `url` crate's ParseError texts (24 recorded endpoints match); hosts where node:url and idna 1.1 disagree may be accepted or worded differently — only via hand-made intents or `agent a2mcp-probe`.
- `payment a2a-pay pay` expiry (`expires_at <= now`) compares at millisecond precision, upstream at nanoseconds — only within the expiring millisecond.

**WS / watch**
- `wss://` goes through the lite transport (bundled + system CAs, `HTTPS_PROXY`/`NO_PROXY` CONNECT); upstream dials directly with webpki roots — behind a proxy or TLS-inspecting egress — Muse.
- The handshake times out after `HTTP_TIMEOUT_MS`; upstream can wait forever on a silent server.
- `ws run-daemon` credentials error: upstream races its heartbeat's first status write against the final one on the same `.status.tmp`, so the final status (even the stdout error) varies; lite always ends `stopped|…|credentials:…` (upstream random).
- Fragmented text messages are UTF-8-checked at reassembly, tungstenite per fragment — same error, possibly later when a stream dies mid-message.
- The handshake response head must use CRLF (httparse also takes bare LF); the 64 KiB `Attack attempt detected` limit applies to the head buffer only.

**MCP**
- With several requests in flight upstream's reply order is nondeterministic (multi-threaded runtime); lite replies in completion order and runs shared-client tools FIFO. Parity cases keep one request in flight after the handshake (upstream random).
- Pre-initialize handshake errors (`expect initialized …, but received: Some(…)`): a CreateMessageResult-shaped client response prints as `CustomResult(…)` (upstream: the typed struct); `completion/complete` with ≥ 2 context arguments prints them sorted (upstream random).
- Rust `{:?}` escaping in error texts uses Node's Unicode property tables — a few rare code points may escape differently.
- Framing: each read takes everything buffered, upstream ≤ 8 KiB — differs only when > 8 KiB is buffered at an ignorable line at end of input (the `decode_eof` quirk).

**Agent**
- fs2 `flock` (Node has none): `pending-decisions-new.lock` and the refund journal use an exclusive `.lock.held` marker (pid-checked, removed on release; files after a command are identical); `delivery_queue` and `service-param-update` only create the lock file, so concurrent processes on the same job are not serialised.
- `agent refund-execute --confirm` on Windows: upstream and lite both stop at `refund_reconciliation_guard_unavailable` (the journal is fsynced through a read-only handle → os error 5). Not a difference, but parity (recorded on Windows) never reaches the POST / sign / broadcast path; `test/unit/agent-user-lifecycle-execute.test.mjs` pins it with unix fsync semantics.
- The local `~/.okx-agent-task` SQLite history is read with `node:sqlite`; on a Node without it the history counts as unreadable (upstream's missing-store outcome).
- chrono `Local` timestamps outside the JS Date range (±8.64e12 s) print in UTC.
