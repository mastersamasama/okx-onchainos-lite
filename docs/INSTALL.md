# Install & set up onchainos-lite

onchainos-lite is one folder — `skill/onchainos-lite/` — containing `SKILL.md`, the docs it
loads on demand, and a zero-dependency Node.js runtime (`bin/ocl.mjs`). Nothing to build,
no package manager, no binary download.

**Requirement:** Node.js ≥ 18 (`node --version`).

## 1. Install the skill

Get the folder (either way):
```bash
git clone https://github.com/mastersamasama/okx-onchainos-lite
# or download the release zip (onchainos-lite.zip) and unzip it
```

| Agent | Where the folder goes |
|---|---|
| Claude Code | `~/.claude/skills/onchainos-lite/` (all projects) or `<project>/.claude/skills/onchainos-lite/` |
| Codex CLI | `~/.codex/skills/onchainos-lite/` |
| OpenClaw | `~/.openclaw/skills/onchainos-lite/` |
| Cursor / other agents that read `SKILL.md` | their skills directory, or tell the agent to read `…/onchainos-lite/SKILL.md` |
| claude.ai | Settings → Capabilities → Skills → upload `onchainos-lite.zip` (`node tools/package.mjs` builds it) |
| Meta Muse | see [section 4](#4-meta-muse) |

```bash
# example: Claude Code, all projects
cp -r okx-onchainos-lite/skill/onchainos-lite ~/.claude/skills/
```
Optional shell shortcut: put `skill/onchainos-lite/bin` on `PATH` to run `ocl …` directly
(`bin/ocl` for POSIX shells, `bin/ocl.cmd` for Windows). Agents call
`node <skill-dir>/bin/ocl.mjs …` and need no PATH changes.

Check the environment:
```bash
node ~/.claude/skills/onchainos-lite/bin/ocl.mjs doctor
```
`doctor` prints Node/TLS/proxy details, test-connects every host the runtime uses, and
shows the login state. It never prints secrets.

## 2. Authenticate

Commands that only read public market data work without login (note: OKX may charge
anonymous market-API calls via x402 once free quota is used — the CLI returns a
`confirming` prompt with the price, exactly like the official CLI). Choose one:

### A. Wallet login link (same flow as the official onchainos)
```bash
ocl wallet login                 # prints loginUrl
# open loginUrl on any device and sign in with Email, Google, Apple — or "API Key"
# (paste API key, secret key and passphrase on OKX's own page)
ocl wallet login --phase poll    # finishes the login and stores the session
```
Credentials are typed on OKX's page, never into the agent chat. The session (tokens + an
X25519 session key) is stored encrypted in `~/.onchainos-lite/keyring.enc`. This enables
everything: wallet balances, transfers, swaps, DeFi, payments, OKX.AI agents.

### B. API key only (HMAC, no wallet)
For data commands (market, token, swap quotes, portfolio, security scans, DeFi discovery)
you can use an OKX Web3 API key (create one in the OKX Web3 developer portal). Either export
`OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` (optional `OKX_PROJECT_ID`), or store them
encrypted:
```bash
ocl auth api-key set --from-env          # reads the variables above once, stores them encrypted
printf 'OKX_API_KEY=…\nOKX_SECRET_KEY=…\nOKX_PASSPHRASE=…\n' | ocl auth api-key set --stdin
ocl auth status                          # which mode requests will use (secrets masked)
```
Precedence: a valid wallet login > API key > anonymous. Keys are never accepted as
command-line arguments (they would land in shell history and logs).

### C. Move credentials into another machine or sandbox (no secrets in chat)
```bash
# on the target (e.g. the agent's VM)
ocl auth transfer init                      # prints a one-time recipient code (30 min)
# on your machine, where the API key / login lives
ocl auth transfer seal --to <recipient>     # add --session to also move the wallet login
# back on the target
ocl auth transfer open <sealed>             # decrypts into the target's encrypted keyring
```
The sealed value is HPKE-encrypted (X25519/HKDF-SHA256/AES-256-GCM) to the target's
one-time key: whoever relays it (an agent, a chat) only ever sees ciphertext, and it opens
once. `--session` moves a wallet session — use it on one machine only, because the next
token refresh on either side invalidates the other copy.

## 3. Use it

Ask the agent in natural language ("what's the price of OKB", "swap 10 USDC to ETH on
Base", "show my wallet"). The skill routes to the right guide, runs `ocl`, asks you before
anything that moves funds (confirm → `--force`), and never shows secrets.

## 4. Meta Muse

Muse runs each user's agent in a sandbox VM whose only egress is an authenticated,
TLS-inspecting proxy. onchainos-lite handles that automatically (system CA bundle from
`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, CONNECT tunnelling with the proxy credentials from
`HTTPS_PROXY`, independent of `NODE_USE_ENV_PROXY`). Verified on Muse with Node 24.20.

Muse discovers personal skills in `~/workspace/skills/<name>/SKILL.md` (no registration;
its `skill_search` matches the SKILL.md description, which already lists OKX / wallet /
swap / 链上 trigger words).

1. Attach `onchainos-lite.zip` in the Muse chat (or ask Muse to `git clone` the repo —
   Muse will ask you to approve github.com) and ask:
   *"Unzip this so the skill folder is ~/workspace/skills/onchainos-lite (SKILL.md at its
   top level), then run `node ~/workspace/skills/onchainos-lite/bin/ocl.mjs doctor`."*
2. Approve **okx.com** when Muse shows the network approval card
   ("Always allow this site" covers web3.okx.com and wsdex.okx.com; rpc.xlayer.tech is asked
   separately the first time). `doctor`'s `hostChecks` should all be `ok: true` and
   `reachability.ok: true`.
3. Log in with **A** (open the link on your phone or computer — Muse cannot see what you
   type there; the page also offers "API Key" login), or bring an API key with **C** (run
   `seal` on your computer; paste only the sealed value into Muse). Do not paste raw keys
   into the chat — Muse's rules forbid the agent from handling raw credentials.
4. From then on just ask Muse ("OKB 价格多少", "check my OKX wallet"); it finds the skill by
   its description and runs `node ~/workspace/skills/onchainos-lite/bin/ocl.mjs …`.

## 5. Update / uninstall

Update: replace the folder with a newer release (state in `~/.onchainos-lite` is kept).
Uninstall: delete the folder; `ocl wallet logout` (or delete `~/.onchainos-lite`) removes
stored credentials.
