# Token Research

Price, contract, security, holders, top traders and smart-money signals for one token in one flow. Syntax: [workflow](../commands/workflow.md) · [token](../commands/token.md) · [security](../commands/security.md) · [signal](../commands/signal.md) · [memepump](../commands/memepump.md); field names: [token-research › Return fields](../guides/token-research.md#return-fields).

- Triggers: "analyze token", "research [address]", "is this token safe", "what is this token", "token deep dive". Sub-intents: 看聚类列表 / 看同车钱包 (show cluster list / co-invested wallets) → Step 2 cluster data; 查 dev 其他项目 / dev 跑路记录 (dev projects / dev rug history) → Step 3.
- Input: token address or symbol/name (one required); chain optional (auto-detect).

## Run

- **Step 0 — Token resolution** (conditional: symbol/name, no address): `ocl workflow token-research --query <symbol> [--chain <chain>]` returns up to 5 `candidates` (index, symbol, name, address, chain, price, market cap). Show them as a numbered list, even a single match; the user picks; re-run with that candidate's `--address` (and `--chain`) and continue from Step 1. Never auto-pick.
- Address known: `ocl workflow token-research --address <addr> [--chain <chain>]` runs Steps 1–3 in one call → `core` = Step 1 (`info`, `price`, `contract` = advanced-info, `security`), `structure` = Step 2 (`holders`, `cluster`, `topTraders`, `signals`), `launchpad` = Step 3 (`tokenDetails`, `devInfo`, `bundleInfo`, `similarTokens`; `null` when skipped).
- For a sub-intent or when the composite is unavailable, run the steps individually; each command takes `--address <addr> --chain <chain>` unless shown otherwise.

## Steps

**Step 1 — Core data [required] (parallel).** Prefer `ocl token report`. Fallback, all 4 in parallel: `ocl token info`, `ocl token price-info`, `ocl token advanced-info`, `ocl security token-scan --tokens "<chainIndex>:<addr>"`.
- Liquidity comes from `price-info.liquidity`. `security token-scan` returns boolean risk flags only; combine with `advanced-info.tokenTags` for tax info.
- Present: name, symbol, age (from `advanced-info.createTime`), price, mcap, 24h vol, 24h change, honeypot, buy/sell tax flags, mint/freeze authority, liquidity, LP burned %.

**Step 2 — On-chain structure [recommended] (parallel).** `ocl token holders`, `ocl token cluster-overview`, `ocl token top-trader`, `ocl signal list --chain <chain> --token-address <addr>`.
- `cluster-overview` may return HTTP 500 for brand-new tokens: skip it gracefully and omit cluster data.
- Present: holder count, Top 10 holding %, tag distribution (SM / Whale / Insider), linked cluster groups + supply %, top-trader PnL breakdown (profitable / losing / holding / exited), SM signal wallet count.

**Step 3 — Launchpad supplement [recommended] (conditional: `contract.protocolId` from Step 1 non-empty).** `ocl memepump token-details`, `ocl memepump token-dev-info`, `ocl memepump token-bundle-info`, `ocl memepump similar-tokens`. Empty `protocolId` (not a launchpad token) → skip the step entirely.
- Present: bonding curve progress, dev tokens created, dev rug count, dev holding %, bundle rate, dev's other projects.

## Output template

```
TOKEN: {symbol} ({chain})
Address: {addr}  |  Age: {n}d
--- PRICE & MARKET ---
Price: ${x}  |  MCap: ${x}  |  24h Vol: ${x}
1h: {x}%  |  4h: {x}%  |  24h: {x}%
--- SECURITY ---
Honeypot: {Y/N}  |  Buy Tax: {x}%  |  Sell Tax: {x}%
Mint: {Active/Revoked}  |  Freeze: {Active/Revoked}
Risk Level: {1-5}  |  Tags: {list}
--- LIQUIDITY ---
Total Pool Value: ${x}  |  LP Burned: {x}%
--- HOLDERS ---
Total: {n}  |  Top10: {x}%
SM: {n}  Whales: {n}  Insiders: {n}
Linked Groups: {n} ({x}% of supply)
--- TOP TRADERS (by PnL) ---
Total: {n}  |  Profitable: {n}  |  Losing: {n}
Still Holding: {n}  |  Fully Exited: {n}
Avg PnL: {x}%  |  Best: +{x}%  |  Worst: {x}%
--- SMART MONEY ---
SM Buy Signals (24h): {n} wallets
[if protocolId non-empty]
--- DEV / LAUNCHPAD ---
Dev Rug History: {n}  |  Dev Holding: {x}%
Bundle: {x}%  |  Dev Other Projects: {n} (Survival: {x}%)
```

## Actions

- "show cluster list" / "show co-invested wallets" → cluster details (`ocl token cluster-list`).
- "show dev projects" → dev project history (`ocl memepump token-dev-info`, `ocl memepump similar-tokens`).
- "watch this token" → [Wallet Monitor](wallet-monitor.md).
