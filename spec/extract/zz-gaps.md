# zz-gaps — completeness pass over the extracted command specs

Upstream: onchainos 4.6.3 (`upstream/cli/Cargo.toml`). Method: parsed every `#[derive(Subcommand)]` enum under
`upstream/cli/src`, walked the tree from `main.rs::Commands`, and compared the result with `spec/cli-tree.json`
(`leaves`, 290 entries) and with every `### \`onchainos …\`` heading in `spec/extract/*.md`.

## Result

- Source tree: 306 leaf paths = 290 visible (identical to `cli-tree.json`) + 16 hidden (`hide = true`).
- Every one of the 306 paths has a spec section (some share a combined heading, e.g. `wallet utxo user-ignored` /
  `unavailable` / `available`, `agent stake` / `increase-stake`). **No command section needed to be added here.**
- `cli-tree.json` has no path that is missing from the source.

## Hidden subcommands (add to the tree with `hidden: true`)

| Path | Source | Build | Spec section |
|---|---|---|---|
| `ws run-daemon` | commands/ws.rs:118 | release | g10-ws-watch-mcp-workflow.md:235 |
| `agent get` | commands/agent_commerce/mod.rs:38 | release | g11b-agent-identity.md:661 |
| `agent get-by-address` | agent_commerce/mod.rs:54 | release | g11b-agent-identity.md:749 |
| `agent xmtp-sign` | agent_commerce/mod.rs:94 | release | g11b-agent-identity.md:981 |
| `agent validate-listing` | agent_commerce/mod.rs:98 | release | g11b-agent-identity.md:999 |
| `agent autotrade-grant-write` | agent_commerce/mod.rs:736 | **debug only** (`#[cfg(debug_assertions)]`) | g13-agent-autotrade.md:943 |
| `agent autotrade-consent-request` | agent_commerce/mod.rs:777 | release | g13:724, g11a:949 |
| `agent autotrade-once-authorize` | agent_commerce/mod.rs:791 | release | g13:873 |
| `agent autotrade-guide-prepare` | agent_commerce/mod.rs:802 | release | g13:789 |
| `agent autotrade-direct-claim` | agent_commerce/mod.rs:813 | release | g13:813 |
| `agent autotrade-direct-finalize` | agent_commerce/mod.rs:824 | release | g13:840 |
| `agent autotrade-outcome-flush` | agent_commerce/mod.rs:845 | release | g13:899 |
| `agent autotrade-delivery-report` | agent_commerce/mod.rs:853 | release | g13:747 |
| `agent autotrade-cap-adjust-request` | agent_commerce/mod.rs:868 | release | g13:911, g11a:955 |
| `agent cache-notify` | agent_commerce/mod.rs:1011 | release | g12:639, g11a:907 |
| `agent cache-rating` | agent_commerce/mod.rs:1027 | release | g12:644, g11a:914 |

A release-parity port exposes 15 of these. `autotrade-grant-write` must be absent in release mode; a release binary
rejects it with clap's unknown-subcommand error (exit 2).

## Paths that are not commands

- `agent autotrade-consent-set`: the enum variant is not declared; the dispatch arm at agent_commerce/mod.rs:2288 and
  the test module at :3134 are under `#[cfg(any())]`, so they are always compiled out. Documented in
  g13-agent-autotrade.md:955 as not compiled. Playbook strings in `task/common/autotrade/continuation.rs:841,846` and
  `card.rs:65` still print this command, so parity means printing those strings and rejecting the command.
- `agent next-action (--role user branch)` is one branch of `agent next-action`, not a separate path.
- Internal enums that derive `Subcommand` but are not mounted in the CLI: `agentic_wallet::chain::ChainCommand`
  (backs `wallet chains`), `task::asp::ProviderCommand` and `task::user::TaskCommand` (dispatch shims that
  `AgentCommand` arms build). They add no paths.

## Hidden flags and aliases (option-level, already covered in the specs)

| Item | Source | Spec |
|---|---|---|
| global `--dev` (hidden bool, beta base URL, DoH off) | main.rs:43 | g01-core-runtime.md:148 |
| `wallet status --include-subscriptions` (hidden, no-op) | agentic_wallet/mod.rs:67 | g02:674, g06:101 |
| `agent funding-notice --image-dir <PATH>` (hidden) | task/common/funding_notice.rs:48 | g12:611, g11a:253 |
| `agent next-action --agent-id` (hidden alias of `--agentId`) | agent_commerce/mod.rs:1275 | g11a:295 |
| visible alias `agent feedbacksubmit` → `feedback-submit` | agent_commerce/mod.rs:82 | g11b:929 |
| visible alias `agent list` → `tasks` | agent_commerce/mod.rs:375 | g12:502 |
| visible alias `agent stakingconfig` → `staking-config` | agent_commerce/mod.rs:1237 | g15:1037 |
| visible alias `agent mystake` → `my-stake` | agent_commerce/mod.rs:1246 | g15:1058 |

Debug-only environment gates (not flags; compiled out of release): `ONCHAINOS_TEST_MOCK_SUBSCRIPTION`,
`ONCHAINOS_TEST_MOCK_SUBSTATUS`, `ONCHAINOS_TEST_MOCK_JOB_ID` in `task/asp/deliver.rs:96-110` and
`task/asp/subscription.rs:257-335`. A release-parity port ignores them.

## Thin sections (full template fields spread across files)

These sections are short, but together with the section they point to they cover every template field:
`wallet login/add/switch/status/addresses/logout/geoblock/report-plugin-info` in g06 (full versions in g02);
`wallet contract-call` in g06 (full in g07); `payment a2a-pay …` / `payment subscription …` in g09a:877 (full in g09b);
`defi tvl-chart` (inherits from `rate-chart`, g08:685); `agent dispute upload` in g15:860 (full in g12).
