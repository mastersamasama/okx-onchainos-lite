# Syncing with a new official onchainos-skills release

Goal: every upstream release becomes a small, mechanical work list, and the 1:1 guard
proves the port is complete. Typical patch release: minutes of tooling plus porting only the
partitions that changed.

## 1. Produce the work list

```bash
node tools/sync-upstream.mjs                 # latest stable tag vs spec/upstream.lock.json
node tools/sync-upstream.mjs --ref v4.7.0    # or a specific tag / commit / origin/main
```
Writes `spec/drift/<old>..<new>.md` (+ `.json`):
- **Command surface** — commands added/removed; per command options added/removed/changed
  (value, required, default, possible values) and help-text changes. Built by dumping the new
  binary's `--help` tree.
- **API paths** — string-literal endpoint paths added/removed in the Rust source.
- **Changed source by partition** — every changed `cli/src` file mapped through
  `spec/partitions.json` to its extracted spec and the lite files it owns, with the exact
  `git diff` command to read.
- **Changed skill docs** — upstream `skills/**` and `workflows/**` files that changed.

## 2. Adopt the new surface

```bash
node tools/sync-upstream.mjs --ref v4.7.0 --apply
```
This builds the new upstream binaries (production + parity-proxy origin, both compiled with
`ONCHAINOS_FORCE_FILE_KEYRING=1` so they can never read a real login from the OS keychain),
checks out the new commit in `upstream/`, dumps the exact clap model
(`tools/dump-clap-model.mjs` → `spec/clap-model.json`; it also lists every
`requires`/`required_unless_present` attribute so `spec/overrides.json` can be updated),
regenerates `spec/cli-tree.json` → `lib/spec.json` → command docs →
parity endpoint policy, bumps `UPSTREAM_VERSION` in `lib/config.mjs` (the only place the
version lives), rewrites the lock, re-records every parity cassette against the new binary and
runs the coverage gate. Whatever fails now is exactly the porting work.

## 3. Port (per partition in the drift report)

For each partition listed under "Changed source":
1. Read the `git diff` shown in the report.
2. Update `spec/extract/<partition>.md` for the changed behaviour (keep the template).
3. Port the change into the lite files listed for the partition, following
   `docs/IMPLEMENTING.md` (mirror names, exact strings, JSON byte rules).
4. New commands: add handlers (the coverage gate lists them). Removed commands: delete handlers
   (the gate reports `unknown-command`). New options: extend `uses` and the handler.
5. Add or adjust parity cases for every changed branch.

Doc changes: update the matching `references/guides/*.md` / `references/workflows/*.md`
(command cards regenerate automatically). Keep the guides free of anything already in
`SKILL.md` or the generated cards.

Agents can do step 3 in parallel — one per partition — with `tools/sync-port.workflow.js`:
run the Workflow tool with `scriptPath: tools/sync-port.workflow.js` and
`args: <contents of spec/drift/<old>..<new>.json>`.

## 4. Done when

```bash
node tools/check.mjs                      # coverage/options: no problems
node test/parity/run.mjs                  # all cases pass against the new upstream
node tools/test-unit.mjs                    # unit + crypto vectors pass
```
Then update `docs/PARITY.md` if a divergence was added or removed.
