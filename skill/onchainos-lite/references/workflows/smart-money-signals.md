# Smart Money Signals

Collect smart-money buy signals, aggregate them by token, then run due diligence on each of the top 5 signal tokens.

- **Triggers:** "smart money", "what are whales buying", "copy trading signals", "what is smart money buying", "KOL buys".
- **Uses:** [signal](../commands/signal.md) · [token](../commands/token.md) · [security](../commands/security.md) · [memepump](../commands/memepump.md) cards; field meanings in [market-data.md](../guides/market-data.md), [token-research.md](../guides/token-research.md), [security.md](../guides/security.md).
- **Input:** `chain`, optional, default Solana.
- **One command:** `ocl workflow smart-money [--chain <chain>]` ([workflow card](../commands/workflow.md)) runs both steps and returns `rawSignals` plus `topTokens[]` (`address`, `data.signal` / `price` / `contract` / `security` / `launchpad`; `launchpad` is null for non-launchpad tokens).

## Step 1 — Collect signals [required] (sequential)

`ocl signal list --chain <chain>` → aggregate by token: count distinct SM wallet addresses per token, sort descending by wallet count, take the top 5.
Present: the token list with the SM wallet count per token.

## Step 2 — Per-token due diligence [required] (parallel per token, max 5)

```
ocl token price-info --address <token> --chain <chain>
ocl token advanced-info --address <token> --chain <chain>
ocl security token-scan --tokens "<chainIndex>:<token>"
# only if advanced-info.protocolId is a non-empty string (launchpad token), also in parallel:
ocl memepump token-dev-info --address <token> --chain <chain>
ocl memepump token-bundle-info --address <token> --chain <chain>
```

Present per token: price, mcap, mint/freeze, honeypot, tax flags, dev rug history, bundle rate.

## Output template

```
SMART MONEY SIGNALS — {chain} — {timestamp}
Scanned: {n} signal tokens → Top {m} by SM wallet count

#1  {name} ({symbol})
    SM Wallets: {n}  |  Price: ${x}  |  MCap: ${x}
    Honeypot: {Y/N}  |  Tax: {x}/{x}%  |  Mint: {A/R}  |  Freeze: {A/R}
    [If protocolId non-empty]
    Dev Rugs: {n}  |  Dev Holding: {x}%  |  Bundle: {x}%

#2  ...
```

## Actions

- "research [symbol]" → [Token Research](token-research.md).
