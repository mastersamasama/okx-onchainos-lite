# New Token Screening

Scan new launchpad tokens, enrich the top 10 with safety and dev data, and surface actionable candidates.

- **Triggers:** "scan new tokens", "new token screening", "pump.fun tokens", "what's new on pump.fun", "meme token scan".
- **Uses:** [workflow](../commands/workflow.md) · [memepump](../commands/memepump.md) · [security](../commands/security.md) · [token](../commands/token.md) cards. Stage windows and protocol IDs: [token-research › Meme launchpads](../guides/token-research.md#meme-launchpads). Fields: [› Memepump display and fields](../guides/token-research.md#memepump-display-and-fields). Scan display: [security › Display](../guides/security.md#display).
- **Input** (all optional; an unset filter keeps the CLI default): `chain` (default Solana) · `protocol` (default all → `--protocol-id-list`) · `min_holders` → `--min-holders` · `min_bonding_percent` → `--min-bonding-percent` · `top10_hold_percent_max` → `--max-top10-holdings-percent`. Map natural-language overrides to these flags or to `--min-market-cap` ("only show tokens with 100+ holders" → `--min-holders 100`).
- **One command:** `ocl workflow new-tokens [--chain <chain>] [--stage MIGRATED|MIGRATING]` (defaults: solana, MIGRATED) runs both steps and returns `tokenList` plus `enriched[]` (`address`, `data.token` / `security` / `contract` = advanced-info / `devInfo` / `bundleInfo`). It accepts only `--chain` and `--stage`. If the user sets any filter, run the steps below yourself.

## Step 1 — Fetch [required] (sequential)

`ocl memepump tokens --chain <chain> --stage MIGRATED`, plus the filter flags from Input. There is no `--limit`, so take the first 10 tokens in returned order as the top 10.
Present: the token list with name, symbol, mcap, holders, volume, SM count and creation time.

## Step 2 — Safety + dev enrichment [recommended] (parallel per token, top 10)

```
ocl security token-scan --tokens "<chainIndex>:<addr>"
ocl token advanced-info --address <addr> --chain <chain>
ocl memepump token-dev-info --address <addr> --chain <chain>
ocl memepump token-bundle-info --address <addr> --chain <chain>
```

Present per token: honeypot, tax flags, mint/freeze, dev rug count, dev holding % and bundle rate.

## Output template

```
NEW TOKENS — {chain} — {timestamp}

#1  {name} ({symbol})
    MCap: ${x}  |  Holders: {n}  |  SM: {n}  |  Age: {n}h
    Honeypot: {Y/N}  |  Tax: {x}/{x}%  |  Mint: {A/R}  |  Freeze: {A/R}
    Dev Rugs: {n}  |  Dev Holding: {x}%  |  Bundle: {x}%

#2  {name} ({symbol})
    ...
```

## Actions

- "research [symbol]" → [Token Research](token-research.md).
- "show dev projects for [symbol]" → dev project history (`ocl memepump token-dev-info`, `ocl memepump similar-tokens`).
