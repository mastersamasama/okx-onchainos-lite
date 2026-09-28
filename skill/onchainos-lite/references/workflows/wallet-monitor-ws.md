# Wallet Monitor (WebSocket)

Configure and start a background WebSocket session that tracks wallets' trades and keeps running without the conversation.

- Triggers: "background monitor", "offline monitor", "WebSocket monitor", "monitor in background", "long-running wallet watch" / 后台监控, 挂ws盯着, 挂一个ws盯着, 离线监控, 长期盯着这个钱包.
- Guides: [websocket](../guides/websocket.md) (the API-key env vars the session needs, poll output, troubleshooting), [token-research](../guides/token-research.md), [security](../guides/security.md). Cards: [ws](../commands/ws.md), [token](../commands/token.md), [security](../commands/security.md).
- Inputs: `wallet_addresses` (required, max 10); `chain` (optional, auto). No `ocl workflow` composite: run the steps yourself.

| Mode | Runs in | AI presence | Latency | Token cost | Best for |
|---|---|---|---|---|---|
| [Polling](wallet-monitor.md) | AI in-session loop | required | `polling_interval` (default 60 s) | each poll round | online, real-time discussion |
| WebSocket (this) | background WS session | not needed after setup | real-time push | setup + on-demand poll only | background / offline / scripting |

The session stops itself when nothing polls it for 30 m (`ws start` default `--idle-timeout`). For offline use or long gaps between polls, add `--idle-timeout` with a longer duration (`2h`) or `0` (never) in Step 2.

| Step | Run | Present |
|---|---|---|
| 1 Channels [required] (sequential) | `ocl ws channels` · `ocl ws channel-info --channel address-tracker-activity` | Available channels; subscription parameters of `address-tracker-activity`. Pass `ws start` the channel name exactly as `channel-info` returns it |
| 2 Start [required] (sequential) | `ocl ws start --channel address-tracker-activity --wallet-addresses "<addr1>,<addr2>" --chain-index <chainIndex>` | Session ID, subscription confirmation |
| 3 Verify [required] (sequential) | `ocl ws list` | Active sessions; confirm the new session is running |
| 4 Consumption [required] (sequential) | — | The options below |

- Manual: `ocl ws poll --id <session_id>`.
- Scripted (example): `while true; do ocl ws poll --id <session_id> --limit 50; sleep 30; done`. A script runs outside the agent, so write `node <skill-dir>/bin/ocl.mjs` in place of `ocl`.
- Enrichment (optional): when a `ws poll` the user asks for returns new events, run for each event token (`tokenContractAddress`, `chainIndex`): `ocl token price-info --address <event_token> --chain <chain>` · `ocl security token-scan --tokens "<chainIndex>:<event_token>"`.
- Muse VM: the session collects events inside the VM, and nothing reaches the chat on its own. Poll when the user asks, or offer a scheduled check on the host that runs `ws poll`. Keep `--idle-timeout` longer than that check's interval.

## Output template

```
WS MONITOR STARTED
Session: {session_id}
Channel: address-tracker-activity
Addresses: {addr1}, {addr2}...
Status: Active
To check events:      ocl ws poll --id {session_id}
To stop:              ocl ws stop --id {session_id}
To list all sessions: ocl ws list
```

Actions: "research [symbol]" (a token seen in poll events) → [Token Research](token-research.md); "stop monitoring" / 停止监控 → `ocl ws stop --id <session_id>` (Muse: also cancel the scheduled check).
