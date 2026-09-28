# onchainos-lite — design

A drop-in, zero-dependency reimplementation of the OKX `onchainos` CLI + skills.
Same commands, same flags, same JSON output, same HTTP requests — without the
180k-line Rust binary, the installer, telemetry, or DoH/binary downloads.

Parity target: upstream `okx/onchainos-skills` **v4.6.3** (commit `9de8161`).

## 1. Goals and non-goals

| Goal | How |
|---|---|
| 1:1 command parity | Command surface generated from the upstream binary; traffic + stdout parity harness against the real upstream CLI |
| Lightweight | Node.js ≥ 18, no npm dependencies, no build step, one self-contained skill folder |
| Runs in Muse (and other sandboxes) | System CA trust + curl transport fallback, HTTPS_PROXY support, file-only credential store, minimal egress hosts, no telemetry |
| Same auth mechanism | Upstream login flows re-implemented natively (session key, HPKE, JWT refresh); own state dir `~/.onchainos-lite` with upstream-identical file formats |
| DRY | Every constant defined once (`lib/config.mjs`); command reference docs generated from the same spec the parser uses; no copy-synced `_shared` files |
| Token-efficient skill | Small router `SKILL.md`, progressive disclosure, generated compact command cards |
| Fast upstream sync | `tools/sync-upstream.mjs`: build upstream → regenerate spec → drift report → coverage gate → parity suite |

Non-goals: the Rust-specific transport layer (DoH resolver failover, binary
self-update, sentry telemetry) is intentionally dropped; each drop is listed in
`docs/PARITY.md` with its user-visible effect.

## 2. Layout

```
onchainos-lite/
├─ skill/onchainos-lite/        ← THE deliverable. Copy this folder anywhere.
│  ├─ SKILL.md                  router + core contract (defines `ocl` once)
│  ├─ bin/ocl.mjs               entry: `node bin/ocl.mjs <args>` ≡ `onchainos <args>`
│  ├─ bin/ocl, bin/ocl.cmd      optional PATH shims
│  ├─ references/
│  │  ├─ guides/*.md            domain behaviour rules (condensed from upstream skills)
│  │  ├─ workflows/*.md         multi-step recipes (condensed from upstream workflows)
│  │  └─ commands/*.md          GENERATED command cards (one per top-level command)
│  └─ lib/
│     ├─ config.mjs             single source of every constant
│     ├─ spec.json              GENERATED command surface (from upstream --help)
│     ├─ core/                  cli parser/help, output, errors, http, transport, ws,
│     │                         auth, keyring, home/state, device, chains, tokens …
│     ├─ crypto/                keccak, secp256k1, hpke, eip712, abi, encodings
│     └─ commands/<top>/*.mjs   handlers, auto-discovered per top-level command
├─ spec/                        cli-tree.json, hidden.json, extract/*.md, upstream.lock.json
├─ tools/                       dump-cli-tree, gen-spec, gen-docs, check, sync-upstream
├─ test/unit/                   node:test — crypto vectors, parser, keyring, …
├─ test/parity/                 recording proxy, runner, cases, cassettes
├─ upstream/                    git clone of okx/onchainos-skills (sync source)
└─ docs/                        DESIGN.md, SYNC.md (porting playbook), PARITY.md
```

## 3. Runtime

### 3.1 Single source of constants — `lib/config.mjs`
Base URL, WebSocket URLs, X Layer RPC, client-version string, header names,
state-dir name, egress host list. Nothing else in the code or the docs repeats
a URL. Env overrides exist for tests/dev only (`OCL_BASE_URL`, `OCL_WS_URL`,
`OCL_AGENT_WS_URL`, `OCL_HOME`). `ocl doctor` prints the effective values —
this is how an agent (or a Muse egress approval) learns them, on demand.

### 3.2 Command surface — `lib/spec.json` (generated, never hand-edited)
Produced by `tools/gen-spec.mjs` from `spec/cli-tree.json` (+ `spec/hidden.json`),
which `tools/dump-cli-tree.mjs` extracts from the upstream binary's `--help`.
The parser (`core/cli.mjs`) is driven entirely by it: option names, value/flag
kinds, defaults, required, possible values, positional args, help text.
`--help` output is rendered from it, so help stays identical to upstream.
Upstream adds a flag → regenerate → the parser accepts it; the coverage gate
then fails until a handler consumes it.

### 3.3 Handlers — `lib/commands/<top>/*.mjs`
```js
export default {
  'market price': {
    uses: ['address', 'chain'],          // options consumed (checked against spec)
    auth: 'optional',                    // none | optional | required
    async run(ctx, o) { return ctx.api.get('/api/v6/…', { … }) },  // return value → data
  },
}
```
The dispatcher lazily imports only `lib/commands/<argv[0]>/` — startup stays
fast regardless of how many commands exist. Files inside a top-level dir are
auto-discovered, so parallel work never edits a shared registry.

### 3.4 Output and errors
Byte-compatible with upstream `output.rs`: compact `{"ok":true,"data":…}` /
`{"ok":false,"error":…}` plus `notifications`; `ONCHAINOS_PRETTY=1` pretty-prints.
Exit codes and the special result types (confirming, setup-required,
funding-blocked, bespoke `{ok,reason}`) mirror `main.rs`.

### 3.5 Transport (the Muse fix)
- `node:https` with CA = bundled roots + **system store**
  (`tls.getCACertificates('system')` when available, else `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, distro bundles) + `NODE_EXTRA_CA_CERTS`. A TLS-inspecting
  egress proxy with its own CA (Muse Sentinel) is therefore trusted exactly like
  `curl` trusts it.
- `HTTPS_PROXY`/`NO_PROXY` honoured via CONNECT tunnelling.
- `OCL_TRANSPORT=auto|node|curl`. In `auto`, a certificate-verification failure
  retries once through `curl` (OS trust store).
- WebSocket: a small RFC 6455 client over `tls.connect` using the same CA list
  and proxy logic (the built-in WebSocket cannot take a custom CA).

### 3.6 Auth and state
- Login flows re-implemented natively from `agentic_wallet/auth` (session
  x25519 key, HPKE-wrapped session secret, ed25519/secp256k1 signing, JWT
  refresh-on-expiry and refresh-and-retry on invalid token).
- State dir `~/.onchainos-lite` (`OCL_HOME`), same file names and schemas as
  upstream (`keyring.enc`, `machine-identity`, `session.json`, `wallets.json`,
  caches). The credential store is always the encrypted file keyring
  (scrypt N=2^15 r=8 p=1 → AES-256-GCM), the same format upstream uses on
  Linux — works in containers/VMs with no OS keychain.
- Egress: only the OKX API origin and the endpoints upstream itself calls.
  No telemetry, update checks or binary downloads.

### 3.7 Crypto (no dependencies)
`node:crypto` provides ed25519, x25519, AES-GCM, HKDF, scrypt, SHA-2.
Pure JS supplies keccak-256, secp256k1 (RFC 6979 deterministic ECDSA with
recovery id), EIP-712 hashing, ABI encoding, base58/bech32 as needed.
Every primitive is pinned by the upstream Rust test vectors.

## 4. The 1:1 guard (restrictions)

1. **Surface lock** — `lib/spec.json` is generated from the upstream binary;
   the parser accepts/rejects exactly what upstream does.
2. **Coverage gate** — `tools/check.mjs` fails when a spec command has no
   handler, a handler's `uses` differs from its spec options, a handler exists
   for a command upstream no longer has, or generated docs are stale.
3. **Traffic parity** — `test/parity`: an official CLI built with its API
   origin pointed at a local recording proxy runs each case against the real
   API; the proxy **never forwards state/fund endpoints** (they get canned
   responses), so write flows are exercised without moving funds. Lite replays
   the cassette; the runner diffs HTTP requests (method, path, query, body,
   header set), stdout and exit code.
4. **Crypto vectors** — unit tests reproduce upstream Rust test vectors.
5. **Upstream lock** — `spec/upstream.lock.json` pins commit, version and a
   hash per extracted source partition.

## 5. Upstream sync (see docs/SYNC.md)
`node tools/sync-upstream.mjs [--ref <tag|commit>]`:
fetch → build upstream (prod + proxy variants) → regenerate tree/spec →
drift report (commands/options added/removed/changed, API paths added/removed,
changed Rust partitions → affected command groups, changed upstream skill docs
→ affected guides) → coverage gate → parity suite → lock update.
The drift report is the work list; an agent (or human) ports each item.

## 6. Skill documentation
- `SKILL.md` (always loaded): what the skill does, how to run `ocl`, envelope
  and exit codes, the confirm-then-`--force` protocol, safety rules, and a
  router table (intent → guide + command card). Core rules live only here.
- `references/guides/*.md`: domain behaviour, loaded on demand; never repeat
  core rules.
- `references/commands/*.md`: generated from `lib/spec.json` — one compact line
  per command. Regenerated by `tools/gen-docs.mjs`; `check` fails if stale.
- One skill folder instead of seven — no duplicated shared files, one
  description to trigger on, and it works as a single unit in Claude Code,
  Codex, OpenClaw and Muse.
