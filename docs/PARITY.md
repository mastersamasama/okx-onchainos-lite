# Parity with upstream onchainos 4.6.3

What "1:1" means here, how it is enforced, and every known difference.

## Enforced

| Guard | Tool | What it proves |
|---|---|---|
| Command surface | `lib/spec.json` generated from the upstream binary's `--help` | same commands, options, defaults, possible values, help text; clap-identical usage errors (exit 2) |
| Coverage | `node tools/check.mjs` | every upstream command has exactly one handler consuming exactly the upstream options |
| Traffic + output | `node test/parity/run.mjs` | per case: identical HTTP requests (method, path, query order, body bytes, headers), stdout bytes, exit code and state files (`session.json`, `wallets.json`, caches, …) vs the upstream binary |
| Crypto | `node --test test/unit/` | keccak, secp256k1 (RFC 6979, low-s, recovery id), ed25519, x25519, HPKE (X25519/HKDF-SHA256/AES-256-GCM), EIP-712/3009, base58, file keyring — byte-equal to vectors produced by upstream's own crates (`test/oracle`) |
| MCP catalogue | `lib/mcp-tools.json` dumped from the upstream `mcp` server | identical tool names, descriptions and input schemas |

## Intentional differences

| Area | Upstream | Lite | Why |
|---|---|---|---|
| Distribution | Rust binary installed via `npx @okxweb3/onchainos-installer` | Node scripts inside the skill folder | no install step; works in sandboxes |
| State dir | `~/.onchainos` (`ONCHAINOS_HOME`) | `~/.onchainos-lite` (`OCL_HOME`; `ONCHAINOS_HOME` also honoured) | coexist with the official CLI; file formats are identical, so a state dir can be copied either way |
| Credential store | OS keychain on macOS/Windows, encrypted file on Linux | encrypted file everywhere (same format as upstream Linux) | no native modules; works in containers/VMs |
| TLS trust | compiled-in webpki roots | bundled + system store + `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`; curl fallback | TLS-inspecting egress (Muse Sentinel) |
| DoH failover | downloads `okx-pilot` binary, resolves via DoH, rotates proxy nodes | not implemented | extra hosts + binary download; only matters where web3.okx.com is DNS-blocked. `doh-cache.json` is never written |
| API origin override | compile time (`cli/.env`) | `OCL_BASE_URL` / `OCL_WS_URL` / `OCL_AGENT_WS_URL` env | parity harness and staging |
| Transport error text | reqwest error chain after `Network unavailable — …:` | Node error message after the same prefix | different HTTP stacks; prefix and exit code identical |
| `upgrade` | runs the npx installer | returns an error explaining lite is updated by replacing the skill folder | installing the Rust CLI defeats the purpose |
| `preflight` | deprecated error | same error | — |
| Extra commands | — | `doctor`, `auth status`, `auth api-key set/clear`, `auth transfer init/seal/open` | sandbox diagnostics; API-key auth without the Rust CLI; moving credentials into a VM without exposing them in chat |
| API-key (HMAC) auth | removed after v3.3.15 (only wallet JWT or anonymous) | restored with v3.3.15 wire format: `OK-ACCESS-KEY/SIGN/PASSPHRASE/TIMESTAMP`, `ok-client-type: cli`; precedence wallet JWT > API key > anonymous | lets data commands run with a developer key where a wallet login is not wanted; inactive unless a key is configured, so parity runs are unaffected |
| Concurrent keyring writers | read-modify-write without a lock (Linux file store) | exclusive `keyring.lock` around every read-modify-write | agents run commands in parallel (observed in Muse): without the lock a pending login and a pending transfer overwrote each other |
| Proxy transport | reqwest proxy support | raw CONNECT (Basic proxy auth) + own HTTP/1.1 over the tunnel | Node ≥ 24.20 with `NODE_USE_ENV_PROXY=1` ignores `createConnection` and dials the proxy with TLS (`EPROTO`) — observed in the Muse VM |
| Client identity | UA `OKX/@okx_ai/onchainos-cli/4.6.3 (<os>; <arch>)`, `ok-client-version: 4.6.3` | identical | server treats lite exactly like the parity version; change in `lib/config.mjs` if lite traffic should be distinguishable |

## Per-command notes

Filled in from the implementation and verification reports (see `.cache/` reports and
`spec/extract/*.md`).
