# Daily Brief

Market pulse, smart money activity, new token launches and optional portfolio alerts in one morning report.

- Triggers: "daily brief", "morning brief", "market overview", "what's the market doing today".
- Guides: [market-data](../guides/market-data.md), [token-research](../guides/token-research.md), [wallet](../guides/wallet.md). Cards: [market](../commands/market.md), [token](../commands/token.md), [signal](../commands/signal.md), [tracker](../commands/tracker.md), [memepump](../commands/memepump.md), [portfolio](../commands/portfolio.md).
- Inputs (both optional): `chain` (default Solana); `wallet_address` (enables Step 4).
- No `ocl workflow` composite: run each step's atomic commands yourself and summarise the outputs in prose.

| Step | Run | Present |
|---|---|---|
| 1 Market pulse [required] (parallel) | `ocl market prices --tokens "<chainIndex>:<SOL_addr>,<chainIndex>:<BTC_addr>,<chainIndex>:<ETH_addr>"` · `ocl token hot-tokens --chain <chain>` · `ocl market kline --address <SOL_addr> --chain solana --bar 1D --limit 7` (`<…_addr>` from `ocl token search`) | SOL / BTC / ETH prices; SOL 7-day trend (the 7 daily candles); top 10 trending tokens (hot-tokens returns up to 100) |
| 2 Smart money activity [recommended] (parallel) | `ocl signal list --chain <chain>` · `ocl tracker activities --tracker-type smart_money --chain <chain>` | SM signal tokens grouped by wallet count (`triggerWalletCount`); recent SM/KOL buys and sells |
| 3 New token activity [recommended] (sequential) | `ocl memepump tokens --chain <chain> --stage MIGRATED` | Top 10 recently migrated tokens (no `--limit`: trim yourself) with holder count, volume, SM count |
| 4 Portfolio alerts [recommended] (conditional: `wallet_address` given) | `ocl portfolio all-balances --address <wallet> --chains <chain>` · `ocl market portfolio-overview --address <wallet> --chain <chain>` | Holdings summary, overall PnL, notable 24h changes in held tokens |

## Output template

```
DAILY BRIEF — {chain} — {date}
MARKET
BTC ${x}  |  ETH ${x}  |  SOL ${x}
SOL 7D: {trend summary}
HOT TOKENS
#  Symbol  Price  24h%  Vol
1  {sym}   ${x}   {x}%  ${x}
SMART MONEY
Buying: {sym} ({n} wallets), {sym} ({n})...
Selling: {sym} ({n} wallets)...
Notable: {addr} bought ${x} of {sym}
NEW TOKENS
Token  MCap  Holders  SM
{sym}  ${x}  {n}      {n}
[If wallet provided] PORTFOLIO
Total: ${x}  |  PnL(24h): ${x}
Moves: {sym} {+/-x}%, {sym} {+/-x}%
```

Follow-ups: "research [symbol]" → [Token Research](token-research.md); "what is smart money buying" → [Smart Money Signals](smart-money-signals.md).
