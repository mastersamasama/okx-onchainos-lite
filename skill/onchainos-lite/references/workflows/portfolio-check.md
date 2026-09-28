# Portfolio Check

> Token balances, total value and per-token PnL for one wallet address. Needs wallet and market data ([portfolio](../commands/portfolio.md), [market](../commands/market.md), [token](../commands/token.md) commands).

Triggers: "portfolio", "check my holdings", "my wallet", "what tokens do I have", "my assets".

| Input | Required | Default |
|---|---|---|
| `wallet_address` | Yes | — For "my wallet", take it from `ocl wallet addresses`, choosing the EVM or Solana address that matches the chains. If the user is not logged in, run [Login](../../SKILL.md#login) or ask for an address. |
| `chain` | No | All supported chains. The composite defaults to `1,501` (Ethereum, Solana). |

`ocl workflow portfolio --address <addr> [--chains <chains>]` ([workflow commands](../commands/workflow.md)) runs **Step 1 only**. It returns `balances`, `totalValue` and `overview`, where `overview` is the 30-day PnL for the first chain in `--chains`. Step 2 is orchestrated by the agent.

## Step 1 — Overview [required] (parallel)

- `ocl portfolio all-balances --address <wallet> --chains <chain>`
- `ocl portfolio total-value --address <wallet> --chains <chain>`
- `ocl market portfolio-overview --address <wallet> --chain <chain>`

Present: total value, token balances, PnL, win rate.

## Step 2 — Per-token detail [recommended] (parallel per holding)

Run this step only when the user asks for a deeper per-token view. Loop over each holding from Step 1, using its `tokenContractAddress` and `chainIndex`:

- `ocl market portfolio-token-pnl --address <wallet> --chain <chain> --token <addr>`
- `ocl token price-info --address <addr> --chain <chain>`

Present per token: price, 24h change, realized / unrealized PnL, avg cost.

## Output Template

```
PORTFOLIO — {short_addr}
Total: ${x}  |  PnL(30d): ${x}  |  Win Rate: {x}%

--- HOLDINGS ---
#1  {sym}  Balance: {n}  |  Value: ${x}  |  24h: {x}%  |  PnL: ${x}  |  AvgCost: ${x}
#2  {sym}  ...
```

## Actions

- "research [symbol]" → [Token Research](token-research.md)
