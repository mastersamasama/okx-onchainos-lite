# Wallet Monitor

Poll up to 10 wallets in-session and alert on their new trades. It only watches: it never executes a trade.

- Triggers: "watch wallet", "monitor this wallet", "watch [address]", "alert me when this wallet trades" / 盯着这个钱包, 监控地址, 盯着这个币 (watch this token). 停止监控 = "stop monitoring": exit the loop.
- Guides: [market-data](../guides/market-data.md), [security](../guides/security.md). Cards: [tracker](../commands/tracker.md), [token](../commands/token.md), [security](../commands/security.md).
- Inputs: `wallet_addresses` (required, max 10); `chain` (optional, auto); `polling_interval` (optional, default 60 s).
- No `ocl workflow` composite: you run the polling loop, enrich each new event and keep the diff state between ticks. For a session that keeps running without the conversation use [Wallet Monitor (WS)](wallet-monitor-ws.md).
- Muse VM: nothing runs between turns, so there is no in-session loop. Offer a scheduled check on the host at the chosen interval; each run executes Step 2 once and diffs against the trades saved by the previous run.

| Step | Run | Present |
|---|---|---|
| 1 Setup [required] (sequential) | — | Confirm the address list and polling interval with the user before starting |
| 2 Poll loop [required] (sequential, repeat every `interval` s) | `ocl tracker activities --tracker-type multi_address --wallet-address <addr1,addr2,…> --chain <chain>` | Diff against the previous poll to find new transactions (new `txHash`); the first poll is the baseline |
| 2 (on each new buy) | `ocl token price-info --address <new_token> --chain <chain>` · `ocl security token-scan --tokens "<chainIndex>:<new_token>"` | Alert below; stop when the user says "stop monitoring" |

## Alert templates

```
[{time}] ALERT — {label/addr}
{Buy/Sell} {symbol} — ${amount}
Price: ${x}  |  MCap: ${x}
Honeypot: {Y/N}  |  Tax: {x}/{x}%
→ "research [symbol]"  |  → "buy [amount] [native_token] of [symbol]"
```

Multi-wallet convergence (several monitored wallets bought the same token): `[MULTI-WALLET] {n} wallets bought {symbol}`

## Actions

- "research [symbol]" → [Token Research](token-research.md).
- "buy [amount] [native_token] of [symbol]" → only when the user sends it: a normal swap via [swap-bridge](../guides/swap-bridge.md). The monitor never buys on its own.
- "stop monitoring" / 停止监控 → exit the poll loop (Muse: cancel the scheduled check).
