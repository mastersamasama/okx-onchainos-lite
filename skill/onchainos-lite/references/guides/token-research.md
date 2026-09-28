# Token research

Read-only token intelligence and meme-launchpad (trenches) research. Syntax: [token commands](../commands/token.md) · [memepump commands](../commands/memepump.md). Token-safety and honeypot verdicts live in [security.md](security.md); prices, K-lines and smart-money signals in [market-data.md](market-data.md).

Contents: [Command choice](#command-choice) · [Parameters](#parameters) · [Display and safety](#display-and-safety) · [Return fields](#return-fields) · [Token glossary](#token-glossary) · [Troubleshooting](#troubleshooting) · [Meme launchpads](#meme-launchpads) · [Memepump display and fields](#memepump-display-and-fields) · [Next actions and workflow hints](#next-actions-and-workflow-hints)

## Command choice

| Need | Command |
|---|---|
| Find a token by name, symbol or address | `ocl token search` |
| Metadata: name, symbol, decimals, logo | `ocl token info` |
| Price, market cap, liquidity, volume, change over 5m/1h/4h/24h | `ocl token price-info` |
| Holder distribution (top 100, optional tag filter such as KOL, whale, smart money) | `ocl token holders` |
| Top 5 liquidity pools | `ocl token liquidity` |
| Hot or trending list, by trending score or X mentions (max 100) | `ocl token hot-tokens` |
| Risk level, creator, dev stats, holder concentration | `ocl token advanced-info` |
| Top traders and profit addresses for a token | `ocl token top-trader` |
| DEX trade history with optional tag or wallet filters | `ocl token trades` |
| Holder cluster concentration: cluster level, rug-pull %, new-address % | `ocl token cluster-overview` |
| Top 10/50/100 holder overview: avg PnL, cost, trend | `ocl token cluster-top-holders --range-filter <1\|2\|3>` (1 = top 10, 2 = top 50, 3 = top 100; required) |
| Clusters of the top 300 holders with address details | `ocl token cluster-list` |
| Chains that support cluster analysis | `ocl token cluster-supported-chains` |
| One-call overview, outside the 13 core commands: info + price-info + advanced-info + security scan → `{address, chain, info, priceInfo, advancedInfo, security}` (a failed part is `null`; errors only if all four fail) | `ocl token report` |

## Parameters

- Missing chain on an address command: ask the user which chain before running it. Never assume one, because the CLI silently falls back to `ethereum`.
- `token search --chains` defaults to `1,501` (Ethereum + Solana) and takes names or IDs, comma-separated (`ethereum,solana`, `196,501`). `--limit` defaults to 20, max 100.
- Cluster commands: if the user is unsure whether the chain is supported, run `ocl token cluster-supported-chains` before `cluster-overview` / `cluster-top-holders` / `cluster-list`.
- Pagination (`search`, `hot-tokens`, `holders`, `top-trader`): pass `--max-results <N>` (1–500) to auto-paginate in one call. `data` then becomes `{items, nextCursor, fetchedCount}`, with `nextCursor` null when exhausted. Do not chase per-item cursors yourself. For manual single-page control use `--limit` (default 20, max 100) plus `--cursor` set to the `cursor` of the LAST item of the previous page. Use one paging style or the other, never both.

| User asks | Run | Show |
|---|---|---|
| "Search for xETH on X Layer" | `ocl token search --query xETH --chains xlayer` | `xETH (0xe7b0...) - XLayer` / `Price: $X,XXX.XX \| 24h: +X% \| Market Cap: $XXM \| Liquidity: $XXM` / `Community Recognized: Yes` |
| "What's trending on Solana by volume?" | `ocl token hot-tokens --chain solana --rank-by 5 --time-frame 4` | ranked list `#1 SOL - Vol: $1.2B \| Change: +3.5% \| MC: $80B` |
| "Who are the top holders of this token?" | `ocl token holders --address <addr> --chain xlayer` | top 100 holders with amounts and addresses |

## Display and safety

- Search rows: name, symbol, chain, price, 24h change and `communityRecognized` status.
- `communityRecognized` is informational only. It means the token is listed on a Top 10 CEX or is community-verified. It does NOT guarantee safety, legitimacy or investment suitability, so show it with that context and never as an endorsement.
- When `communityRecognized = false`, show a prominent warning: "This token is not community-recognized. Exercise caution — verify the contract address independently before trading."
- The contract address is the only reliable identifier because names and symbols can be spoofed. When a search returns several matches, emphasize each contract address and warn that a name or symbol alone is not enough to identify the token.
- `price-info`: show market cap, liquidity and volume together.

## Return fields

| Command | Fields |
|---|---|
| `search` | `tokenContractAddress`, `tokenSymbol`, `tokenName`, `tokenLogoUrl`, `chainIndex`, `decimal`, `price` (USD), `change` (24h %), `marketCap`, `liquidity`, `holders`, `explorerUrl`, `tagList.communityRecognized` (true = Top 10 CEX or community-verified), `cursor` (per item) |
| `info` | `tokenName`, `tokenSymbol`, `tokenLogoUrl`, `decimal`, `tokenContractAddress`, `tagList.communityRecognized` |
| `price-info` | `price`, `time` (ms), `marketCap`, `liquidity`, `circSupply`, `holders`, `tradeNum` (24h trades), `priceChange5M/1H/4H/24H`, `volume5M/1H/4H/24H` (USD), `txs5M/1H/4H/24H`, `maxPrice`/`minPrice` (24h high/low) |
| `holders` (top 100) | `holderWalletAddress`, `holdAmount`, `holdPercent`, `nativeTokenBalance`, `boughtAmount`, `avgBuyPrice`, `totalSellAmount`, `avgSellPrice`, `totalPnlUsd`, `realizedPnlUsd`, `unrealizedPnlUsd`, `fundingSource` |
| `top-trader` | same fields as `holders`, but `soldAmount` in place of `totalSellAmount` |
| `liquidity` (top 5 pools) | `pool` (e.g. `Punch/SOL`), `protocolName`, `liquidityUsd`, `liquidityAmount[].tokenAmount/tokenSymbol`, `liquidityProviderFeePercent`, `poolAddress`, `poolCreator` |
| `hot-tokens` | `chainIndex`, `tokenSymbol`, `tokenLogoUrl`, `tokenContractAddress`, `marketCap`, `volume`, `firstTradeTime` (ms), `change` (selected time frame), `liquidity`, `price`, `holders`, `uniqueTraders`, `txsBuy`, `txsSell`, `txs`, `inflowUsd`, `riskLevelControl`, `devHoldPercent`, `top10HoldPercent`, `insiderHoldPercent`, `bundleHoldPercent`, `vibeScore`, `mentionsCount` |
| `advanced-info` | `riskControlLevel`, `tokenTags`, `totalFee`, `lpBurnedPercent`, `isInternal`, `protocolId`, `progress` (e.g. bonding curve %), `createTime`, `creatorAddress`, `devRugPullTokenCount`, `devCreateTokenCount`, `devLaunchedTokenCount`, `top10HoldPercent`, `devHoldingPercent`, `bundleHoldingPercent`, `suspiciousHoldingPercent`, `sniperHoldingPercent`, `snipersClearAddressCount`, `snipersTotal` |
| `trades` | `id`, `type` (buy/sell), `price` (USD), `volume` (USD), `time` (ms), `dexName`, `txHashUrl`, `userAddress`, `isFiltered` (`"1"` = matched the tag/wallet filter, `"0"` otherwise), `poolLogoUrl`, `changedTokenInfo[].tokenSymbol/tokenAddress/tokenLogoUrl/amount` |
| `cluster-overview` | `clusterConcentration` (Low/Medium/High), `top100HoldingsPercent`, `rugPullPercent` (rug-pull probability %), `holderNewAddressPercent` (% of top 1,000 holders created in the last 3 days), `holderSameFundSourcePercent` (% of top 1,000 with mutual mainstream token transfers), `holderSameCreationTimePercent` (% of top 1,000 created at about the same time) |
| `cluster-top-holders` | `holdingAmount` (excludes blackhole and LP addresses), `holdingPercent`, `clusterTrendType` (array of buy/sell/neutral/transfer/transferIn; may be absent), `averageHoldingPeriod`, `averagePnlUsd`, `averageBuyPriceUsd`, `averageBuyPricePercent` (vs current price), `averageSellPriceUsd`, `averageSellPricePercent` |
| `cluster-list` | `clusterList` (top 100 clusters of the top 300 holders): `holdingAmount`, `holdingValueUsd`, `holdingPercent`, `trendType` (object with nested `trendType` buy/sell/neutral/transfer), `averageHoldingPeriod`, `pnlUsd`, `pnlPercent`, `buyVolume`, `averageBuyPriceUsd`, `sellVolume`, `averageSellPriceUsd`, `lastActiveTimestamp`, `clusterAddressList[]` (`address`, `holdingAmount`, `holdingValueUsd`, `holdingPercent`, `averageHoldingPeriod`, `lastActiveTimestamp`, `isContract`, `isExchange`, `isKol`, `addressRank`) |
| `cluster-supported-chains` (no params) | `chainIndex`, `chainName`, `chainLogo` |

Enums:
- `hot-tokens --rank-by`: 1 price, 2 price change, 3 txs, 4 unique traders, 5 volume, 6 market cap, 7 liquidity, 8 created time, 9 OKX search count, 10 holders, 11 mention count, 12 social score, 14 net inflow, 15 token score. `--time-frame`: 1 = 5 min, 2 = 1 h, 3 = 4 h, 4 = 24 h. At most 100 results.
- `advanced-info` `riskControlLevel`: 0 Undefined, 1 Low Risk, 2 Medium Risk, 3 Medium-High Risk, 4 High Risk, 5 High Risk (manual).
- `advanced-info` `tokenTags`: `honeypot`, `dexBoost`, `lowLiquidity`, `communityRecognized`, `devHoldingStatusSell`, `devHoldingStatusSellAll`, `devHoldingStatusBuy`, `initialHighLiquidity`, `smartMoneyBuy`, `devAddLiquidity`, `devBurnToken`, `volumeChangeRateHoldersPlunge`, `holdersChangeRateHoldersSurge`, `dexScreenerTokenCommunityTakeOver`, `dexScreenerPaid`.

## Token glossary

| Chinese | Meaning → action |
|---|---|
| 代币分排名 | token-score ranking → `ocl token hot-tokens --ranking-type 4` |
| Xmentioned榜 | X-mention ranking → `ocl token hot-tokens --ranking-type 5` |
| 烧池子 | burned LP → `ocl token hot-tokens --is-lp-burnt true` |
| 风控 | advanced risk metadata → `ocl token advanced-info` |
| 貔貅盘 | honeypot risk → `ocl security token-scan` ([security.md](security.md)) |
| 内盘 / 内盘代币 | internal launch-platform token → `advanced-info` field `isInternal` |
| 开发者跑路 | developer rug history → `advanced-info` field `devRugPullTokenCount` |
| 老鼠仓 | insider wallets → `--tag-filter 6` on `ocl token top-trader` or `ocl token holders` |

## Troubleshooting

- Token not found: suggest verifying the contract address, because symbols can collide.
- Same symbol on several chains: show every match with its chain name.
- Too many results: name/symbol search caps at 100, so suggest searching by exact contract address.

## Meme launchpads

**Step 0 — run before any `ocl memepump` command.** Trenches research is read-only, so re-classify the intent as read or write first.

- Write (buy/sell/swap/snipe/ape a pump.fun-style token): stop and route per the [SKILL.md](../../SKILL.md) router.
- Snipe disambiguation: a bare "snipe + token/address" request is a write. It stays here only when paired with an analytical noun such as "bundle/sniper detection" or "who sniped this token".
- Read (the default for every memepump command): developer reputation, launch or rug history; bundle/sniper detection or who sniped a token; bonding-curve progress, similar tokens by the same developer, co-investor wallets; launch scans via `memepump tokens`.
- If you realise mid-flow, after commands already ran, that the intent is a write, halt and route to [dapp-discovery.md](dapp-discovery.md). Never run a swap or execute from this flow.

Command choice (`ocl memepump …`): `chains` = supported chains and protocols · `tokens` = browse/filter launches by stage · `token-details` = deep-dive into one meme token · `token-dev-info` = developer reputation and holdings · `similar-tokens` = similar tokens by the same creator · `token-bundle-info` = bundle/sniper analysis · `aped-wallet` = aped / co-investor ("same-car") wallets.

- Missing chain: use `--chain solana`, which is also the per-token commands' CLI default. Check support with `ocl memepump chains` first. Supported chains are Solana (501), BSC (56), X Layer (196) and TRON (195); confirm them with the command.
- `memepump tokens` requires `--chain`. `--stage` takes `NEW` | `MIGRATING` | `MIGRATED` and defaults to `NEW`; ask only when the intent clearly points to another stage. It returns up to 30 tokens per request and has no `--limit`.
- Stage windows: `NEW` and `MIGRATING` cover tokens created in the last 24 h. `MIGRATED` covers tokens whose migration completed in the last 3 days (72 h). Tokens outside these windows are not returned.
- Named protocol (pump.fun, fourmeme…): get its ID from `ocl memepump chains`, then pass `--protocol-id-list <id>` to `memepump tokens`. Never look up a protocol name as a token with `token search`.
- User-specific data: `memepump tokens --wallet-address` adds position data. `--wallet` on `token-details` adds position and P&L; on `aped-wallet` it highlights that wallet if present. `--protocol-id-list` and `--quote-token-address-list` are comma-separated.

| User asks | Run | Show |
|---|---|---|
| "Show me new meme tokens on Solana" | `ocl memepump tokens --chain solana --stage NEW` | list with market data and audit tags |
| "Is this meme token safe? Check the developer" | `ocl memepump token-dev-info --address <a> --chain solana` | rug pull count, migration count, golden gems, dev holding |
| "Check if this token has bundler activity" | `ocl memepump token-bundle-info --address <a> --chain solana` | bundler count, bundled value, bundled token amount |
| "Who else has bought this meme token?" | `ocl memepump aped-wallet --address <a> --chain solana` | wallet type, holding %, PnL |

Chinese terms apply only when a pump.fun-style token or trenches context is already present:

| Chinese | Meaning → action |
|---|---|
| 捆绑狙击者 / 狙击者分析 | read: bundle/sniper analysis → `ocl memepump token-bundle-info` |
| 扫链 / 战壕 / 打狗 | read: scan meme launches → `ocl memepump tokens` |
| 同车 | read: co-invested wallets → `ocl memepump aped-wallet` |
| 新盘 | newly launched token → `ocl memepump tokens --stage NEW` |

## Memepump display and fields

- Translate field names and never dump raw JSON keys: `top10HoldingsPercent` → "top-10 holder concentration", `rugPullCount` → "rug pull count", `bondingPercent` → "bonding curve progress".
- Present `token-dev-info` as a developer reputation report and `token-details` as a token safety summary that highlights red and green flags.
- When listing `memepump tokens`, never merge or deduplicate entries that share a symbol. Different tokens can share one, so show each separately and always include its contract address.

| Command | Fields |
|---|---|
| `chains` (no params) | `data[].chainIndex`, `chainName`, `protocolList[].protocolId/protocolName` (e.g. `pumpfun`, `fourmeme`) |
| `tokens` | array of token objects with the same structure as `token-details` |
| `token-details` | `chainIndex`, `protocolId` (e.g. `"120596"` = pumpfun), `quoteTokenAddress`, `tokenAddress`, `symbol`, `name`, `logoUrl`, `creatorAddress`, `createdTimestamp`, `migratedBeginTimestamp`/`migratedEndTimestamp` (empty if not migrating/migrated), `market.marketCapUsd/volumeUsd1h/txCount1h/buyTxCount1h/sellTxCount1h`, `bondingPercent` (0–100), `tags.top10HoldingsPercent`, `tags.devHoldingsPercent/insidersPercent/bundlersPercent/snipersPercent/freshWalletsPercent/suspectedPhishingWalletPercent` (null if the token is < 2 s old), `tags.totalHolders`, `social.x/telegram/website/dexScreenerPaid/communityTakeover/liveOnPumpFun`, `bagsFeeClaimed`, `aped` (same-car wallet count) |
| `token-dev-info` | `devLaunchedInfo.totalTokens/rugPullCount/migratedCount/goldenGemCount`; `devHoldingInfo.devHoldingPercent/devAddress/fundingAddress/devBalance/lastFundedTimestamp` (`devHoldingInfo` is null when the creator address is unavailable) |
| `similar-tokens` | same developer, at most 2, may be `[]`: `data[].tokenAddress`, `tokenSymbol`, `tokenLogo`, `marketCapUsd`, `lastTxTimestamp`, `createdTimestamp` |
| `token-bundle-info` | `bundlerAthPercent` (0–100), `totalBundlers`, `bundledValueNative`, `bundledTokenAmount` |
| `aped-wallet` | `data[].walletAddress`, `walletType` (e.g. Smart Money, KOL, Whale), `holdingUsd`, `holdingPercent` (0–100), `totalPnl` (USD), `pnlPercent`; `[]` = no co-holders |

Protocol ID fallback: use it ONLY when `ocl memepump chains` is unavailable. Prefer the command, because the list changes.

| Chain | Protocol IDs |
|---|---|
| Solana | pumpfun `120596` · bonk `136266` · bonkers `139661` · jupStudio `137346` · believe `134788` · bags `129813` · moonshotMoney `133933` · launchlab `136137` · moonshot `121201` · meteoradbc `136460` · mayhem `139048` |
| BNB Chain | fourmeme `135086` · flap `129826` |
| Base | clanker `130981` · bankr `134522` |
| X Layer | dyorfun `137823` · flap `129826` |
| TRON | sunpump `121263` |

Troubleshooting: an invalid stage means the value must be exactly `NEW`, `MIGRATING` or `MIGRATED`. If `token-details` returns null data, the token is not in the meme pump ranking data and may trade on a standard DEX, so research it with the `token` commands.

## Next actions and workflow hints

Follow-ups after a successful command (after → suggest; all are `ocl` commands):

- `token search`, `token info` → `token price-info`, `token holders` · `token price-info` → `token holders`, `market kline`, `swap execute` · `token holders` → `token advanced-info`, `token top-trader` · `token liquidity` → `token holders`, `token advanced-info` · `token hot-tokens` → `token price-info`, `token liquidity`, `token advanced-info`
- `token advanced-info` → `token holders`, `token top-trader`, `token cluster-overview` · `token top-trader` → `token advanced-info`, `token trades` · `token trades` → `token top-trader`, `token advanced-info`
- `token cluster-supported-chains` → `token cluster-overview` · `token cluster-overview` → `token cluster-top-holders`, `token cluster-list`, `token advanced-info` · `token cluster-top-holders` → `token cluster-list`, `token holders` · `token cluster-list` → `token top-trader`, `token advanced-info`
- `memepump chains` → `memepump tokens` · `memepump tokens` → `memepump token-details`, `memepump token-dev-info` · `memepump token-details` → `memepump token-dev-info`, `memepump similar-tokens`, `memepump token-bundle-info` · `memepump token-dev-info` → `memepump token-bundle-info`, `market kline`
- `memepump similar-tokens` → `memepump token-details` · `memepump token-bundle-info` → `memepump aped-wallet` · `memepump aped-wallet` → `token advanced-info`, `market kline`, `swap execute`

Workflow hints (offer them with the SKILL.md sentence after the command's result):

- [Token Research](../workflows/token-research.md) after `token info`, `token price-info`, `token report`, `token holders`, `token cluster-overview`, `token top-trader`, `signal list --token-address`, `memepump token-details`, `memepump token-dev-info`, `memepump token-bundle-info`.
- [New Token Screening](../workflows/new-token-screening.md) after `token advanced-info`, `memepump tokens`.
- For the other hints on these commands (Daily Brief, Portfolio Check, Smart Money Signals), see [market-data.md](market-data.md#next-actions-and-workflow-hints).
