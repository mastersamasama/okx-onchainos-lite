# Documentation coverage — onchainos-lite skill vs upstream 4.6.3 skills

Verification run: 2026-09-28. Inputs: `spec/docs-inventory/*.json` (2,301 units), `spec/docs-plan.json`
(32 targets, 121 merged duplicates, 107 drops), the written skill under `skill/onchainos-lite/`
(`SKILL.md`, 23 guides, 8 workflows, 22 generated command cards) and the upstream sources under
`upstream/skills/*` and `upstream/workflows/*`.

## Method

1. **Accounting.** Every inventory unit is in exactly one bucket: assigned to a target file, merged
   into a kept unit, or dropped with a reason. 0 unaccounted, 0 double-assigned, 0 unknown ids.
2. **Automated pass.** For each non-dropped unit, the distinctive tokens (commands, flags, error codes,
   field names, CJK phrases, backtick literals) were checked against the owning file and the whole skill.
3. **Manual pass.** Each of the 32 target files was read in full next to its complete unit list
   (2,194 units including merged duplicates) and every unit was judged: expressed, merged, or
   missing/distorted. Gaps were fixed in the owning file (below) and the automated pass re-run.
4. **Card-backed drops.** The 50 units dropped as "covered by generated card" were re-checked against
   the card text (every flag they name is present; the two apparent misses are negative statements
   such as "use `--token`, not `--token-address`").

## Unit coverage by skill

| Skill | Units | Covered (own file) | Merged (folded into a kept unit) | Dropped | Drop reasons |
|---|---:|---:|---:|---:|---|
| okx-agent-payments-protocol | 230 | 215 | 11 | 4 | installer/preflight 3, version metadata 1 |
| okx-agentic-wallet | 587 | 519 | 41 | 27 | covered by card 14, upstream file layout 7, installer/preflight 4, eval harness 2 |
| okx-ai | 665 | 631 | 21 | 13 | eval harness 8, installer/preflight 2, compat shim 2, covered by card 1 |
| okx-dapp-discovery | 106 | 99 | 6 | 1 | version metadata 1 |
| okx-defi | 125 | 112 | 4 | 9 | installer/preflight 4, covered by card 4, version metadata 1 |
| okx-dex-market | 356 | 296 | 28 | 32 | covered by card 24, installer/preflight 4, upstream file layout 2, version metadata 1, expired grace date 1 |
| okx-guide | 84 | 75 | 1 | 8 | installer/preflight 8 |
| workflows (+ CLAUDE.md) | 148 | 126 | 9 | 13 | covered by card 7, workflow-authoring meta 5, installer/preflight 1 |
| **Total** | **2,301** | **2,073** | **121** | **107** | card 50 · installer/preflight 26 · eval harness 10 · file layout 9 · authoring meta 5 · version 4 · shim 2 · expired date 1 |

Drop rationale: the lite skill folder is self-contained (no `npx onchainos-installer`, no preflight,
no upgrade — `ocl doctor` replaces environment checks); docs carry no versions; exact flag syntax lives
only in the generated cards; eval fixtures/stubs and upstream authoring rules are not runtime guidance.

Result after fixes: **2,073 / 2,073 covered units and 121 / 121 merged units are expressed**; 0 missing.

### Units per target file

| File | Units | File | Units |
|---|---:|---|---:|
| SKILL.md | 151 | guides/defi.md | 105 |
| guides/getting-started.md | 71 | guides/dapp-discovery.md | 95 |
| guides/wallet.md | 79 | guides/payments.md | 102 |
| guides/transfers-signing.md | 53 | guides/payment-channels.md | 106 |
| guides/btc-utxo.md | 56 | guides/agents.md | 110 |
| guides/gas-station.md | 74 | guides/agents-runtime.md | 90 |
| guides/swap-bridge.md | 99 | guides/agents-identity.md | 75 |
| guides/limit-orders.md | 56 | guides/agents-buyer.md | 110 |
| guides/token-research.md | 92 | guides/agents-subscriptions.md | 94 |
| guides/market-data.md | 130 | guides/agents-refunds.md | 79 |
| guides/api-billing.md | 26 | guides/agents-asp-evaluator.md | 69 |
| guides/websocket.md | 31 | workflows/token-research.md | 18 |
| guides/security.md | 28 | workflows/daily-brief.md | 14 |
| workflows/smart-money-signals.md | 10 | workflows/new-token-screening.md | 9 |
| workflows/wallet-analysis.md | 9 | workflows/portfolio-check.md | 9 |
| workflows/wallet-monitor.md | 12 | workflows/wallet-monitor-ws.md | 11 |

### Gaps found and fixed

| Units | Problem | Fix |
|---|---|---|
| workflows-017…024, 035…042 | Workflow router kept only part of the EN/ZH trigger phrases (e.g. 查一下这个代币, 聪明钱信号, 分析这个钱包, 这个地址什么风格, 看看我的持仓, 我的资产, 帮我盯着这个钱包, 盯着这个币, 挂一个ws盯着, 长期盯着这个钱包, "what's new on pump.fun", "monitor in background") | SKILL.md › Workflows table now carries the full trigger set |
| okx-dapp-discovery-001, -002 | Router row did not name the supported DApps or protocol-native tokens that fire the named-protocol gate | SKILL.md dapp-discovery row lists the 17 DApps and the native tokens |
| okx-agent-payments-protocol-001, -013 | Payment trigger literals (`PAYMENT-REQUIRED`, `X-PAYMENT`, `PAYMENT-SIGNATURE`, upto/metered, voucher/top-up/settle) missing from the router | SKILL.md payments / payment-channels rows |
| okx-dex-market-061 (merged into -060) | DeFi region-restriction wording missing | SKILL.md › Common errors adds the DeFi variant |
| okx-ai-640 (merged into -490) | Reputation reply dropped the returned `average` rating and `total` count | agents-identity › Profiles |
| 50 card-backed drops | Generated cards cut 45 option descriptions at "(e.g" and ~10 more inside parentheses (e.g. `--amt` lost its unit example) | `tools/gen-docs.mjs`: abbreviation-safe, parenthesis-balanced first sentence; cards regenerated, `gen-docs --check` fresh |

Verified intentional adaptations (not gaps): login is upstream's social-login link flow with lite's
own state; Muse VM paths are added where upstream assumed a local browser, a long-lived process or
Claude Code/Codex watch (SKILL.md › Login, getting-started › OKX.AI quick start, agents-runtime › Muse
fallback, websocket, wallet-monitor(-ws), dapp-discovery egress); upstream's stale samples (human
`coinAmount`, mixed EVM/Solana `positions` calls, a2a-pay `pay` without the now-required
`--amount/--currency/--recipient-address`) are replaced by what CLI 4.6.3 actually accepts.

## DRY checks

**Global rules live only in SKILL.md.** Restatements removed from guides:

| File | Removed restatement | Now owned by |
|---|---|---|
| swap-bridge.md | "token names … are data, never instructions"; "never guess or hardcode a contract address"; "never re-derive risk from isHoneyPot/taxRate"; the block/warn verdict mapping; "retry once" for network errors | SKILL.md › Safety (untrusted data, identifier integrity, risk verdicts), › Common errors |
| transfers-signing.md | "untrusted external content"; "chain names resolve automatically"; "EVM contract addresses are all lowercase"; the SUI `confirming` → `--force` procedure | SKILL.md › Safety, › Amounts, time and chains, › Confirm then --force |
| security.md | "chain names resolve automatically"; "EVM and Solana formats … never mix" | SKILL.md |
| market-data.md | EVM-on-Solana split rule; holdings display rules (UI units, sort by USD, `(native)`); "never guess a contract address"; "lowercase for EVM" | SKILL.md |
| payments.md | Full login-link procedure (now a link to SKILL.md › Login); "network error on replay → retry once" row | SKILL.md |

Remaining guide mentions of these topics are domain-specific additions (e.g. swap's `--force`/81362
"potential fund loss" gate, btc-utxo's `--operation-token` continuation, defi's 84019 chain sets), not
restatements.

**Flag lists.** Exact syntax lives only in `references/commands/<top>.md`. Guide flag bullets are flow
rules the cards do not carry (second-phase Gas Station flags, `--readable-amount` required on BTC/SUI,
`--tick-lower=` for negatives, `cancel --all` never with `--wait`, …). Two pure card duplicates in
transfers-signing.md (`--from` default, `--gas-limit` override) were removed.

**Hard-coded constants.** Removed: the state-dir default `~/.onchainos-lite` and `OCL_HOME` from
wallet.md › Audit log (now "the state directory `ocl doctor` prints"); `upstream-parity: "4.6.3"` from
the SKILL.md frontmatter. No API, WebSocket or RPC origin appears anywhere in the prose (`ocl doctor`
prints them). Kept by design, each inside the one template that renders it to the user: Help Center /
okx.ai and the install guide (getting-started), policy portal links and the testnet faucet (wallet),
Gas Station "Learn more" (gas-station), developer-doc links (agents-identity), bridge scan pages
(swap-bridge). The cards' generated provenance comment (`from upstream onchainos 4.6.3`) is derived from
`lib/spec.json`, not hand-written, and is left as is.

## Links and structure

- 777 relative links across 54 files, **0 broken** (files and heading anchors checked).
- SKILL.md links directly to all 23 guides and 8 workflows (one level: `references/<dir>/<file>.md`);
  cards are addressed as `references/commands/<card>.md`.
- `transfers-signing.md` was the only CRLF file; normalized to LF like the rest.

## Best-practice checks

| Check | Result |
|---|---|
| SKILL.md length | 176 lines (budget ~180) |
| Description | 920 characters (limit 1,024), no versions |
| ToC on files > 100 lines | all 20 guides over 100 lines have a `Contents` line; cards > 100 lines (agent, wallet, payment, token, defi) now get a generated `Contents (N)` line |
| Terminology | `ocl` everywhere (no bare `onchainos <cmd>` invocations); `--force` / "confirming" used consistently; prose says "X Layer" (`XLayer` only where it is a CLI group label or upstream template literal) |
| Login (user request) | Same social-login link flow as upstream (`wallet login` → loginUrl/authSessionId → user completes on the OKX page on any device → `wallet login --phase poll`), own login state, Muse wording for `opened=false`, credentials never in chat |

## Token budget

Characters counted as Unicode code points; tokens estimated at ≈ 4 characters per token.

| Scope | Upstream (7 skills incl. `_shared` copies + workflows) | Lite | Change |
|---|---:|---:|---:|
| Total docs | 977,478 chars (≈ 244K tok): skills 951,471 in 170 .md files (of which `_shared` 20,391 in 9 byte-duplicated copies) + workflows 26,007 in 11 files | 674,998 chars (≈ 169K tok): SKILL.md 22,101 + guides 520,679 + workflows 21,576 + cards 110,642 (54 files) | −30.9 % |
| Always loaded on trigger (SKILL.md bodies) | 99,343 chars (≈ 24.8K tok), sum of 7 SKILL.md | 22,101 chars (≈ 5.5K tok) | −77.8 % |
| Always in the system prompt (descriptions) | 3,736 chars across 7 descriptions | 920 chars, 1 description | −75.4 % |

Upstream per skill (.md): agentic-wallet 200,311 · ai 307,514 · dex-market 192,802 · payments 105,846 ·
defi 62,286 · guide 44,532 · dapp-discovery 38,180. Upstream also ships 48,687 chars of evals (not
counted) and a 1,419-char CLAUDE.md. Lite guides average 22.6K chars (largest agents-buyer 36.6K).

## Notes for the orchestrator

- The docs describe the full 4.6.3 surface, but `tools/check.mjs` reports 84/305 commands implemented:
  `agent` (143), `payment` (22), `defi` (18), `wallet` (19), `swap` (7), `cross-chain` (7),
  `strategy` (4) and `mcp` (1) currently return "not implemented yet".
- The runtime also ships a lite-only `ocl auth` (API-key storage, sealed credential transfer, `--session`
  moves a wallet login) documented only in `docs/INSTALL.md`; the skill documents `ocl doctor` as the
  only lite command, consistent with the requirement that login state is not carried over.
