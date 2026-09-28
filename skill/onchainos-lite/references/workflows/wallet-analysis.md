# Wallet Analysis

Pull a wallet's performance metrics, trading behaviour, current holdings and recent activity. Triggers: analyze wallet, check this address, is this wallet worth following, what's this wallet's trading style. Background: [market-data guide](../guides/market-data.md) (portfolio, tracker, return fields).

**Inputs:** `wallet_address` (required) · `chain` (optional, auto-detect).

**One command:** `ocl workflow wallet-analysis --address <addr> [--chain <chain>]` ([workflow commands](../commands/workflow.md)). The composite defaults to `solana`, so pass `--chain` for any other chain.

## Steps

| Step | Run | Present |
|---|---|---|
| 1 Performance [required] (parallel) | `ocl market portfolio-overview --address <wallet> --chain <chain> --time-frame 3` (7D) · same with `--time-frame 4` (1M) · `ocl portfolio all-balances --address <wallet> --chains <chain>` | 7d vs 30d PnL, win rate, realized profit, trade count, current holdings |
| 2 Trading behaviour [recommended] (sequential) | `ocl market portfolio-recent-pnl --address <wallet> --chain <chain>` | per-token PnL, trading frequency |
| 3 Recent activity [recommended] (sequential) | `ocl tracker activities --tracker-type multi_address --wallet-address <wallet> --chain <chain>` | most recent trades: time, token, direction, amount |

Syntax: [market](../commands/market.md) · [portfolio](../commands/portfolio.md) · [tracker](../commands/tracker.md).

## Output template

```
WALLET: {short_addr} ({chain})

PERFORMANCE   7d       30d
PnL:          ${x}     ${x}
Win Rate:     {x}%     {x}%
Realized:     ${x}     ${x}
Trades:       {n}      {n}

HOLDINGS    Token | Balance | Value | Unrealized
BEHAVIOR    Avg Hold: {duration}  |  Avg Size: ${x}  |  Freq: {n}/day
            Most Traded: {sym1}, {sym2}, {sym3}
TOKEN PnL   Token | Realized | Unrealized
RECENT      Time | Token | Action (Buy/Sell) | Amount (${x})
```

## Actions

- "watch [address]" → [Wallet Monitor](wallet-monitor.md)
- "research [token they hold]" → [Token Research](token-research.md)
