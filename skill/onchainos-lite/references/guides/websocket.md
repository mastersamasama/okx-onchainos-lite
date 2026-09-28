# Real-time DEX data (WebSocket)

| Approach | Best for |
|---|---|
| `ocl ws` background session with incremental polling ([ws commands](../commands/ws.md)) | monitoring and agent-driven workflows |
| Custom WebSocket client script (Python/Node/Rust) | bots and custom logic |

## CLI sessions: `ocl ws`

The session daemon logs in with a developer API key (the HMAC login below), not the wallet login. It reads `OKX_PROD_API_KEY`, `OKX_PROD_SECRET_KEY` and `OKX_PROD_PASSPHRASE` from the environment (`--env pre` reads `OKX_PRE_*`). If one is missing, `ws start` fails with `<VAR> is not set`. The user exports them in the shell that runs `ocl`.

1. Discover the channels. `ocl ws channels` lists all 9, and `ocl ws channel-info --channel <name>` shows one channel's parameters and an example. Use the channel name exactly as it is returned.
2. Start a session with `ocl ws start --channel <channel> <required param>`, which returns the session `id` (`status: starting`). If a session with the same config is already running, you get `already_running` and its `id`.
3. Pull new events with `ocl ws poll --id <id> [--channel <ch>]`, which returns `daemon_status`, `new_count` and `events` (`trades` on tracker channels). Without `--channel` it reads the session's first channel. The tracker-only filters are listed on the card.
4. `ocl ws list` lists the sessions. `ocl ws stop --id <id>` stops one (`--flush` returns unread events first), and `ocl ws stop` with no `--id` stops them all.

| Channel | Group | Scope | Required param |
|---|---|---|---|
| `kol_smartmoney-tracker-activity` | signal | global | none |
| `address-tracker-activity` | signal | per-wallet | `--wallet-addresses` |
| `dex-market-new-signal-openapi` | signal | per-chain | `--chain-index` |
| `price` | market | per-token | `--token-pair` |
| `dex-token-candle{period}` | market | per-token | `--token-pair` |
| `price-info` | token | per-token | `--token-pair` |
| `trades` | token | per-token | `--token-pair` |
| `dex-market-memepump-new-token-openapi` | trenches | per-chain | `--chain-index` |
| `dex-market-memepump-update-metrics-openapi` | trenches | per-chain | `--chain-index` |

| Goal | `ocl ws start` flags |
|---|---|
| Smart-money / KOL trade feed | `--channel kol_smartmoney-tracker-activity` |
| Track specific wallets | `--channel address-tracker-activity --wallet-addresses 0xAAA,0xBBB` |
| Token price | `--channel price --token-pair 1:0xdac17f958d2ee523a2206206994597c13d831ec7` |
| Detailed metrics / trade feed | `--channel price-info --token-pair …` / `--channel trades --token-pair …` |
| Buy signals on Ethereum and Solana | `--channel dex-market-new-signal-openapi --chain-index 1,501` |
| New meme launches on Solana | `--channel dex-market-memepump-new-token-openapi --chain-index 501` |
| Meme metric updates | `--channel dex-market-memepump-update-metrics-openapi --chain-index 501` |
| 1-minute candles | `--channel dex-token-candle1m --token-pair …` |

- **Missing required parameter.** Each channel has its own: `--token-pair` for per-token channels (`chainIndex:tokenContractAddress`), `--chain-index` for per-chain channels, and `--wallet-addresses` for the address tracker.
- **`ws poll` returns no events.** This is not an error. Nothing new has arrived since the last poll, and low-traffic channels (such as one token's `trades`) can be quiet for minutes. Poll again later instead of restarting the session.
- **Session not found on `ws poll` / `ws stop`.** The session most likely hit its idle timeout (30m without a poll by default) and stopped itself. Check `ocl ws list` and restart it with `ws start`. For monitoring with long gaps, pass a larger `--idle-timeout` (`1h`, `2h`) or `0` to disable it.
- **Muse VM and other sandboxes.** The daemon runs inside the VM and only collects events; nothing reaches the chat on its own. Poll when the user asks, or from a scheduled check on the host. Its WebSocket host is one of the egress hosts that `ocl doctor` lists.

After `ws start`, `ws poll` or `ws stop`, offer the workflow hint for [Wallet Monitor (WebSocket)](../workflows/wallet-monitor-ws.md).

## Custom client

- **Endpoint:** the DEX WebSocket URL printed by `ocl doctor`. It uses TLS, so any standard TLS WebSocket client works. Never hard-code a different one.
- **Auth:** HMAC-SHA256 API-key login, the same scheme as the OKX REST API. Get the API Key, Secret Key and Passphrase from the OKX Developer Portal. Load them from environment variables or a `.env` file listed in `.gitignore`. Never hard-code them in source and never commit them.

Connection lifecycle:
1. Connect over TLS.
2. Log in before sending any subscribe: `{"op":"login","args":[{"apiKey":"…","passphrase":"…","timestamp":"<unix SECONDS, string>","sign":"…"}]}`. The signature is `sign = Base64(HMAC-SHA256(secretKey, timestamp + "GET/users/self/verify"))`; in Node, `crypto.createHmac('sha256', secretKey).update(prehash).digest('base64')`.
3. Wait up to 10 s for the ACK `{"event":"login","code":"0","msg":""}`. `code` `"0"` means success; any other code is a failure, and `msg` says why.
4. Send one subscribe message that carries every arg: `{"op":"subscribe","args":[{…},{…}]}`.
5. Wait up to 10 s for N ACKs, one per arg, each `{"event":"subscribe","arg":{…},"connId":"…"}`. The session is active only once all N have arrived. An arg that fails returns `{"event":"error","code":"…","msg":"…"}`.
6. Receive pushes shaped `{"arg":{"channel":"…",…},"data":[{…}]}`. `arg` echoes the subscription params, and `data` is an array of payload objects (see Channel payloads).
7. Send a plain-text `"ping"` every 25 s. The server replies `"pong"`; if no pong arrives within 25 s, reconnect.
8. On disconnect, reconnect and repeat from step 1, including the full login and subscribe. Make at most 20 attempts, 3 s apart, and surface an error to the user when they run out.

- **Unsubscribe without disconnecting:** send `{"op":"unsubscribe","args":[…]}` with the same arg objects as the subscribe. Success is `{"event":"unsubscribe","arg":{…},"connId":"…"}`; failure is `{"event":"error","code":"…","msg":"…"}`.
- **Upgrade notice:** `{"event":"notice",…}` arrives before a server upgrade. Disconnect gracefully and reconnect after a short delay.
- **Cannot connect, or auth fails:** check the endpoint, check that login happens before subscribe, and check the 25 s ping (the server closes idle unauthenticated connections). If events stop after about 30 s, a missing heartbeat is almost always the cause.

## Channel payloads

These fields describe each object in `data[]`, which is also what a `ws poll` event contains. Per-token args are `{"channel","chainIndex","tokenContractAddress"}`, with `chainIndex` as a string (`"1"` Ethereum, `"501"` Solana) and EVM addresses in lowercase.

- **`price`** pushes on every update: `time` (ms), `price` (USD).
- **`dex-token-candle{period}`** pushes at most once per second. Periods: `1s 1m 3m 5m 15m 30m 1H 2H 4H 6H 12H 1D 2D 3D 5D 1W 1M 3M`, plus the UTC variants `6Hutc 12Hutc 1Dutc 2Dutc 3Dutc 5Dutc 1Wutc 1Mutc 3Mutc` (for example `dex-token-candle1m`). Fields: `ts` (open time, ms), `o`, `h`, `l`, `c`, `vol` (base currency), `volUsd`, `confirm` (`"0"` still forming, `"1"` completed).
- **`price-info`** pushes at most once per second. Fields: `time`, `price`, `marketCap`, `priceChange5M/1H/4H/24H` (%), `volume5M/1H/4H/24H` (USD), `txs5M/1H/4H/24H`, `maxPrice`/`minPrice` (24h), `liquidity` (USD), `circSupply`, `holders`, `tradeNum` (24h).
- **`trades`** pushes once per trade. Fields: `id`, `txHashUrl`, `userAddress`, `dexName`, `poolLogoUrl`, `type` (`"buy"`/`"sell"`), `changedTokenInfo[]` (`amount`, `tokenSymbol`, `tokenContractAddress`), `price`, `volume` (USD), `time` (ms), `isFiltered` (`"0"` not filtered, `"1"` filtered out of price/K-line calculation). This differs from REST `token trades`, where `isFiltered` `"1"` means the trade matched the tag/wallet filter and the address field is `tokenAddress`.
- **`dex-market-new-signal-openapi`** carries aggregated buy signals from smart money, KOLs and whales, one chain per arg (`{"channel","chainIndex"}`; the CLI's `--chain-index 1,501` sends one arg per chain). Fields: `timestamp`, `chainIndex`, `token{tokenAddress, symbol, name, logo, marketCapUsd, holders, top10HolderPercentage}`, `price`, `walletType` (`"1"` Smart Money, `"2"` KOL/Influencer, `"3"` Whale; comma-separated when there are several), `triggerWalletCount`, `triggerWalletAddress` (comma-separated), `amountUsd`, `soldRatioPercentage` (lower means the wallets are still holding). REST `signal list` names these `top10HolderPercent` and `soldRatioPercent`.
- **Trackers.** `kol_smartmoney-tracker-activity` is public: the arg is `{"channel"}` with no wallet param, and it streams trades from OKX-tracked KOL and smart-money wallets. `address-tracker-activity` takes one arg per address, `{"channel","walletAddress"}`, for EVM (`0x…`) or Solana (base58) addresses. It allows up to 200 addresses per connection (open more connections for more), and its push `arg` includes `walletAddress`. Trade event fields: `walletAddress`, `tokenSymbol`, `tokenContractAddress`, `chainIndex`, `tokenPrice` (USD), `marketCap` (USD), `quoteTokenSymbol` (e.g. USDT, SOL, ETH), `quoteTokenAmount`, `realizedPnlUsd`, `tradeType` (`"1"` Buy, `"2"` Sell), `tradeTime` (ms), `trackerType` (number array: `1` Smart Money, `2` KOL), `txHash` (may be absent).
- **`dex-market-memepump-new-token-openapi`** carries newly launched meme tokens on supported launchpads (Pump.fun, Bonk, Believe, …), with a full snapshot the first time a token appears. One chain per arg (`{"channel","chainIndex"}`). Fields: `chainIndex`, `protocolId` (e.g. `"120596"` Pump.fun), `quoteTokenAddress`, `tokenContractAddress`, `symbol`, `name`, `logoUrl`, `createdTimestamp`, `market{marketCapUsd, volumeUsd1h, txCount1h, buyTxCount1h, sellTxCount1h}`, `bondingPercent`, `tags{top10HoldingsPercent, devHoldingsPercent, insidersPercent, bundlersPercent, snipersPercent, freshWalletsPercent, suspectedPhishingWalletPercent, totalHolders}`, `social{x, telegram, website, dexScreenerPaid, communityTakeover, liveOnPumpFun}`, `bagsFeeClaimed`.
- **`dex-market-memepump-update-metrics-openapi`** carries incremental updates, pushed whenever a tracked token's market, holder or social metric changes on the subscribed chain. One chain per arg. It has the new-token fields plus `mayhemModeTimeRemaining` (Pump.fun Mayhem Mode time left; empty when the token is not in Mayhem Mode). A push may carry only some of the fields.
