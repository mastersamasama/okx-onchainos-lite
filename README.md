# onchainos-lite

A drop-in, zero-dependency version of the OKX **onchainos** skills: the same commands,
flags, JSON output and HTTP traffic as the official Rust CLI (parity-locked to
**v4.6.3**), shipped as one self-contained skill folder that runs anywhere Node.js ≥ 18 runs —
including sandboxed agent VMs such as Meta Muse.

| | official onchainos-skills | onchainos-lite |
|---|---|---|
| Runtime | 17 MB Rust binary per platform, installed by `npx @okxweb3/onchainos-installer` every thread | ~Node.js scripts inside the skill folder, no install step |
| TLS | compiled-in root store → fails behind TLS-inspecting egress (Muse: `UnknownIssuer`) | bundled + system CA store, HTTPS_PROXY, automatic curl fallback |
| Egress | API + DoH CDNs + DoH proxy nodes + npm + sentry | only the OKX API hosts listed by `ocl doctor` |
| Login | social-login link | same flow (link → approve on OKX page → poll); credentials never pass through the chat |
| Skills | 7 skills, shared files copied into each | 1 skill, every rule stated once, command docs generated |

## Use

```bash
node skill/onchainos-lite/bin/ocl.mjs market price --address 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee --chain ethereum
node skill/onchainos-lite/bin/ocl.mjs doctor          # environment, hosts to allow, login state
node skill/onchainos-lite/bin/ocl.mjs wallet login    # prints the login link
```
Install as a skill: copy `skill/onchainos-lite/` into the agent's skills directory
(e.g. `~/.claude/skills/`), or upload `dist/onchainos-lite.zip` (`node tools/package.mjs`).
`bin/ocl` / `bin/ocl.cmd` are optional PATH shims. State lives in `~/.onchainos-lite`
(`OCL_HOME` to override).

## Layout

```
skill/onchainos-lite/   the deliverable: SKILL.md, references/, bin/ocl.mjs, lib/
spec/                   upstream command tree, extracted behaviour specs, partitions, lock, drift reports
tools/                  dump-cli-tree, gen-spec, gen-docs, gen-endpoints, check, sync-upstream, package
test/unit/              node:test — crypto vectors from a Rust oracle, helpers
test/parity/            recording proxy + runner comparing upstream vs lite byte for byte
test/oracle*/           Rust crates that generate vectors with upstream's exact crates
upstream/               git checkout of okx/onchainos-skills at the locked commit
docs/                   DESIGN, IMPLEMENTING (contract), SYNC (upgrade playbook), PARITY (divergences)
```

## Verify

```bash
node tools/check.mjs            # every upstream command has a handler with exactly the upstream options
node --test test/unit/          # crypto + helper vectors
node test/parity/run.mjs        # upstream CLI vs lite: requests, stdout, exit code, state files
```
The parity runner needs the upstream reference binaries in `.cache/bin/` (built from
`upstream/cli` — see docs/SYNC.md). It never lets the upstream CLI move funds: state/fund
endpoints are answered by fixtures, only read-only endpoints reach the real API.

## Follow upstream

```bash
node tools/sync-upstream.mjs --ref <new tag>           # drift report → spec/drift/
node tools/sync-upstream.mjs --ref <new tag> --apply   # adopt surface, re-record parity, list failures
```
Then port per docs/SYNC.md (optionally with `tools/sync-port.workflow.js`).
