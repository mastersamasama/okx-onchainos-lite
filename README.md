# onchainos-lite

A drop-in, zero-dependency version of the OKX **Onchain OS** agent skills
([okx/onchainos-skills](https://github.com/okx/onchainos-skills)). It has the same 305 commands,
flags, JSON output, exit codes, HTTP traffic and state files as the official Rust CLI
(parity-locked to **v4.6.3**). It ships as **one self-contained skill folder** that runs
wherever Node.js ≥ 18 runs, including sandboxed agent VMs such as Meta Muse.

> Unofficial community project, not affiliated with or endorsed by OKX. MIT licensed; the
> command surface and skill guidance derive from okx/onchainos-skills (MIT).

| | official onchainos-skills | onchainos-lite |
|---|---|---|
| Runtime | 17 MB Rust binary per platform, installed by `npx @okxweb3/onchainos-installer` | Node.js scripts inside the skill folder, nothing to install |
| Sandboxes / TLS | compiled-in root store fails behind TLS-inspecting egress (Muse: `UnknownIssuer`) | bundled + system CA store, `HTTPS_PROXY` CONNECT tunnelling, curl fallback |
| Egress | API + DoH CDNs + DoH proxy nodes + npm + sentry | only the OKX API hosts (`ocl doctor` lists them) |
| Login | social-login link | the same link flow, plus OKX API-key (HMAC) mode and sealed credential transfer into a VM |
| Skills | 7 skills with shared files copied into each | 1 skill; every rule stated once; per-command cards generated from the CLI |

## Quick start

```bash
git clone https://github.com/mastersamasama/okx-onchainos-lite
cp -r okx-onchainos-lite/skill/onchainos-lite ~/.claude/skills/     # or your agent's skills dir
node ~/.claude/skills/onchainos-lite/bin/ocl.mjs doctor           # environment + hosts + login state
```
Then ask your agent: *"what's the price of OKB"*, *"log in to my OKX wallet"*, *"swap 10 USDC to
ETH on Base"*. The agent reads `SKILL.md` and runs `node <skill>/bin/ocl.mjs …` (`ocl` below).
It asks before anything that moves funds.

**Full install guide for Claude Code, Codex, OpenClaw, claude.ai and Meta Muse:
[docs/INSTALL.md](docs/INSTALL.md).**

## Authentication

| Mode | How | Enables |
|---|---|---|
| Wallet login (same as official) | `ocl wallet login` prints a link. Open it on any device and sign in with Email / Google / Apple / API Key on OKX's own page. `ocl wallet login --phase poll` finishes. | everything: wallet, transfers, swaps, DeFi, payments, OKX.AI agents |
| API key (lite extension) | `ocl auth api-key set --from-env` (reads `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`) or `--stdin` | data commands (market, token, quotes, portfolio, security, DeFi discovery) |
| Sealed transfer into a VM | target: `ocl auth transfer init` → your machine: `ocl auth transfer seal --to <code> [--session]` → target: `ocl auth transfer open <sealed>` | brings a local API key (and optionally a wallet login) into a sandbox; only ciphertext passes through the chat |

Credentials are stored encrypted (scrypt + AES-256-GCM file keyring) in `~/.onchainos-lite`
(`OCL_HOME` overrides it). They are never accepted as command-line arguments, never printed, and
never typed into the agent chat. Precedence: wallet login > API key > anonymous.

## Meta Muse

1. Attach `onchainos-lite.zip` (from [Releases](https://github.com/mastersamasama/okx-onchainos-lite/releases),
   or build it with `node tools/package.mjs`) in a Muse chat. Ask Muse to unzip it so that
   `~/workspace/skills/onchainos-lite/SKILL.md` exists, then to run
   `node ~/workspace/skills/onchainos-lite/bin/ocl.mjs doctor`.
2. Approve **okx.com** on the network card ("Always allow").
3. Say *"log in to my OKX wallet"*. Open the link Muse shows, on your phone or computer, and sign
   in there. Muse never sees what you type. To use an API key or a login you already have on your
   own computer, use the sealed transfer above.

Muse finds the skill by its description from then on. The runtime handles Muse's
authenticated, TLS-inspecting egress proxy automatically. Details:
[docs/INSTALL.md › Meta Muse](docs/INSTALL.md#4-meta-muse).

## How "1:1" is enforced

| Guard | Command | Proves |
|---|---|---|
| Command surface | `lib/spec.json`, generated from the upstream binary's help tree and its exact clap model (`tools/dump-clap-model.mjs`) | same commands, options, defaults, value parsers, aliases, conflicts/requires and help text. Usage errors are byte-identical (exit 2) |
| Coverage gate | `node tools/check.mjs` | each of the 305 upstream commands has exactly one handler consuming exactly the upstream options |
| Parity harness | `node test/parity/run.mjs` | ~4,000 recorded cases: identical HTTP requests (method, path, query order, body bytes, headers), stdout bytes, exit codes, stderr and state files vs the upstream binary |
| Unit + crypto vectors | `node tools/test-unit.mjs` | keccak, secp256k1, ed25519, x25519, HPKE, EIP-712/3009, base58, QR, file keyring are byte-equal to vectors from upstream's own crates |

The parity runner needs the upstream reference binaries in `.cache/bin/`, built from the pinned
upstream commit (see [docs/SYNC.md](docs/SYNC.md)). The binaries are compiled so they can never
read a real OS-keychain login. State-changing and fund-moving endpoints are answered by fixtures;
only read-only endpoints reach the real API. Known, intentional differences are listed in
[docs/PARITY.md](docs/PARITY.md).

## Following upstream releases

```bash
node tools/sync-upstream.mjs --ref <tag>            # drift report → spec/drift/<old>..<new>.md
node tools/sync-upstream.mjs --ref <tag> --apply    # adopt the surface, re-record parity, list what to port
```
Every changed upstream source file maps to the lite files that mirror it (`spec/partitions.json`).
Porting follows [docs/SYNC.md](docs/SYNC.md) and [docs/IMPLEMENTING.md](docs/IMPLEMENTING.md),
and the gates above prove the port is complete.

## Layout

```
skill/onchainos-lite/   the deliverable: SKILL.md, references/ (guides, workflows, generated command cards), bin/, lib/
spec/                   upstream command tree + clap model, extracted behaviour specs, partitions, lock, drift reports
tools/                  spec/doc generators, coverage gate, upstream sync, packaging, secret scan
test/unit/              node:test suites and crypto vectors
test/parity/            recording proxy + runner comparing upstream vs lite, cases, fixtures, template homes
test/oracle*/           Rust crates that generate vectors with upstream's exact crates
docs/                   DESIGN, IMPLEMENTING, SYNC, PARITY, INSTALL
```
