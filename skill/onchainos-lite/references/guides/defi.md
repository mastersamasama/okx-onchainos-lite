# DeFi

OKX-aggregated, venue-agnostic DeFi across protocols and chains: yield discovery, APY/TVL/depth charts, deposit, withdraw, reward claims and positions ([defi commands](../commands/defi.md)). A request that names a protocol or DApp belongs to [dapp-discovery.md](dapp-discovery.md). Write commands only return **unsigned calldata**. They never broadcast, and the CLI never holds private keys. Signing is a separate step ([Sign and broadcast](#sign-and-broadcast-datalist)).

Contents: [Capability map](#capability-map) · [Address resolution](#address-resolution) · [Address-chain compatibility](#address-chain-compatibility) · [Product types](#product-types) · [Search, list, detail](#search-list-detail) · [Charts](#charts) · [Deposit](#deposit) · [Withdraw and claim](#withdraw-and-claim) · [Sign and broadcast](#sign-and-broadcast-datalist) · [Positions display](#positions-display) · [Low-level path](#low-level-path) · [Return fields](#return-fields) · [Next steps](#next-steps) · [Troubleshooting](#troubleshooting)

## Capability map

| Capability | Commands | Covers |
|---|---|---|
| Invest | `support-chains`, `support-platforms`, `list`, `search`, `detail`, `invest`, `withdraw`, `collect`, `rate-chart`, `tvl-chart`, `depth-price-chart` | product search and best APY; detail (APY, TVL, accepted tokens); deposit, stake or provide liquidity; full or partial withdraw/redeem; reward claims (platform, investment, V3 fee, bonus, unlocked principal); APY and TVL history; V3 depth and price |
| Portfolio (read-only) | `positions`, `position-detail` | "positions / portfolio / holdings" → `positions`; "detail for a protocol" → `position-detail`; redeem or claim after viewing → Invest |
| Low-level | `prepare`, `deposit`, `redeem`, `claim`, `calculate-entry` | only what the high-level path cannot express ([Low-level path](#low-level-path)) |

- `invest` / `withdraw` / `collect` are the recommended write path. The CLI handles prepare, precision conversion, position lookup, the reward check, multi-step orchestration and validation.
- Typical chain: positions → redeem or claim. `positions` / `position-detail` are mandatory pre-steps before every `withdraw` / `collect`, so apply both the Portfolio and Invest sections when a request chains them.

## Address resolution

Resolve the address before any defi command that takes `--address`:

1. The user gave an address → use it and skip the rest.
2. `ocl wallet status` → logged in? active account. Not logged in → log in ([SKILL.md](../../SKILL.md) login flow) or ask for an address.
3. `ocl wallet addresses` → addresses grouped XLayer / EVM / Solana. EVM chain → EVM address, Solana → Solana address, X Layer → XLayer address.
4. Several addresses of the same type → confirm the pick with the user before proceeding.
5. "All accounts / all wallets" → `ocl wallet balance --all` for the account IDs, then per account `ocl wallet switch <id>` + `ocl wallet addresses`.

Other missing inputs: chains → ask, or suggest ethereum, bsc, solana; platform id → run `ocl defi positions` first, because `position-detail` needs its `analysisPlatformId` as `--platform-id`.

## Address-chain compatibility

`--address` and the chain parameter must be compatible. Mixing them returns 84019 (Address format error). `0x…` → only `ethereum,bsc,polygon,arbitrum,base,xlayer,avalanche,optimism,fantom,linea,scroll,zksync`; base58 → only `solana`; Sui → only `sui`; Tron (`T…`) → only `tron`; TON → only `ton`.

DeFi chain aliases → chainIndex: `ethereum`/`eth` 1 · `bsc`/`bnb` 56 · `polygon`/`matic` 137 · `arbitrum`/`arb` 42161 · `base` 8453 · `xlayer`/`okb` 196 · `avalanche`/`avax` 43114 · `optimism`/`op` 10 · `fantom`/`ftm` 250 · `sui` 784 · `tron`/`trx` 195 · `ton` 607 · `linea` 59144 · `scroll` 534352 · `zksync` 324 · `solana`/`sol` 501.

## Product types

`--product-group`: `SINGLE_EARN` (search default; single-token yield: savings, staking, vaults) · `DEX_POOL` (liquidity pools: Uniswap V2/V3, PancakeSwap, …) · `LENDING` (lending/borrowing: Aave, Compound, …).

`investType` (detail, position-detail): 1 Save (savings/yield), 2 Pool (liquidity pool), 3 Farm (yield farming), 4 Vaults, 5 Stake, 6 Borrow, 7 Staking, 8 Locked, 9 Deposit, 10 Vesting. `invest` treats a Pool product (2) as a V3 entry.

## Search, list, detail

- `ocl defi search` needs at least one of `--token` / `--platform`, and the CLI errors if both are missing. Both take comma-separated keywords (`USDC,ETH`, `Aave,Compound`); `--chain` is a chain name; page size is fixed at 20. `ocl defi list` returns top products by APY with no filters.
- Render search/list as:

| # | Platform | Chain | investmentId | Name | APY | TVL |
|---|---|---|---|---|---|---|
| 1 | Aave V3 | ETH | 9502 | USDC | 1.89% | $3.52B |

- `investmentId` is mandatory in every row. `rate` is a decimal APY: ×100 and append `%` (`"0.01820"` → 1.82%); `tvl` is USD: $3.52B, $537M. Display data as-is; never editorialize on APY values.
- If any product has APY > 50% (`rate` > 0.5), you must show: "WARNING: This product shows APY above 50%, which indicates elevated risk (potential impermanent loss, smart contract risk, or unsustainable rewards). Proceed with caution." Never display high-APY products silently. A write result with `highApyWarning: true` gets the same warning.
- `ocl defi detail --investment-id <id>`: confirm APY/TVL and the gates before any write. `isInvestable` false → no deposit (`invest` refuses); `isSupportRedeem` false → no withdraw (`withdraw` refuses); `isSupportClaim` → claims possible; `hasBonus` → bonus rewards. `underlyingToken[]` carries `tokenAddress` + `tokenPrecision`, `rateDetails[]` the APY breakdown, and `analysisPlatformId` feeds positions/claims.

## Charts

Use them to check trends before investing or to monitor a held position. Before a V3 deposit, read DEPTH to see where liquidity concentrates and pick tickLower/tickUpper.

| Command | `--time-range` | Returns per point |
|---|---|---|
| `ocl defi rate-chart` (APY history) | `WEEK` (default), `MONTH`, `SEASON` (3 months), `YEAR`; `DAY` V3 Pool only | `timestamp` (ms), `rate` (APY = base + mining), `bonusRate` (extra reward APY: OKX Bonus / Merkl), `limitValue` (1 peak, -1 trough, null normal), `totalReward` (fee + bonus for the period) |
| `ocl defi tvl-chart` (pool-size stability) | same as rate-chart | `data.chartVos[]` {`timestamp` ms, `tvl` USD, `limitValue`}, `data.text` (nullable) |
| `ocl defi depth-price-chart` (V3 Pool only; `--chart-type DEPTH` default) | no effect: always the current snapshot | per tick: `tick`, `liquidity`, `liquidityNet`, `token0Price`, `token1Price` |
| `ocl defi depth-price-chart --chart-type PRICE` | `DAY` (default), `WEEK` | `token0Price`, `token1Price`, `timestamp` (ms) |

## Deposit

Standard products:

1. `ocl defi search --token USDC --chain ethereum` → pick the `investmentId`.
2. `ocl defi detail --investment-id <id>` → confirm APY/TVL; take `underlyingToken[].tokenAddress`.
3. Decimals: `underlyingToken[].tokenPrecision`, or `ocl token search --query <tokenAddress> --chains <chain>` → `decimal` (same as DEX swap).
4. Ask for the amount and convert it to minimal units: userAmount × 10^precision, integer only (0.1 USDC at precision 6 → `100000`; 100 USDC → `100000000`). Decimal or UI-unit values are rejected.
5. **Balance check (required)**: verify the deposit-token balance with `ocl wallet balance` before generating calldata. If it is insufficient, STOP and warn ([wallet.md](wallet.md) funding). Skipping this wastes gas on failed transactions.
6. Confirm, then `ocl defi invest --investment-id <id> --address <addr> --token USDC --amount 100000000` → `dataList` (e.g. APPROVE + DEPOSIT).
7. Sign and broadcast each step in order.

`--token` is a symbol or address from the product's accepted tokens (a miss lists the available ones). `--slippage` (invest, withdraw, deposit, redeem) defaults to `0.01` (1%; `0.1` = 10%); suggest `0.03`–`0.05` for volatile V3 pools. The CLI warns above 10% and `invest` refuses above 20%.

V3 pool: `ocl defi search --token USDT --platform PancakeSwap --chain bsc --product-group DEX_POOL` → `ocl defi detail --investment-id <id>` → optional `ocl defi depth-price-chart --investment-id <id>` to choose the range → ask for the amount and range → balance check (stop if short) → confirm → `ocl defi invest --investment-id <id> --address <addr> --token USDT --amount 100000000 --range 5` (the CLI runs calculate-entry internally) → sign each step.

- New position: `--range <pct>` (0 < pct ≤ 100; `5` = ±5%) or `--tick-lower` + `--tick-upper`. Write negative ticks with `=`: `--tick-lower=-11`.
- Add to an existing position: `--token-id <NFT tokenId>` from position-detail, with no range.
- Single token: the CLI computes the other side. Dual token: `--token2 <symbol|address> --amount2 <minimal units>` (`0` = single-sided; `--amount2` alone auto-picks the pool's other token). The CLI rebalances to the pool ratio and reports leftovers in `rebalance` {`surplusToken`, `surplusAmount`, `message`}. Tell the user that amount stays in the wallet.

## Withdraw and claim

**Run a fresh `position-detail` immediately before every `withdraw` and every `collect`**, even if position data exists from earlier in the conversation. Rewards, investmentId, platformId and tokenId change after each on-chain operation (withdraw, previous collect), and stale data gives wrong params or failed transactions. Never skip it or reuse earlier results.

Withdraw: `ocl defi positions --address <addr> --chains ethereum` → `ocl defi position-detail --address <addr> --chain ethereum --platform-id <pid>` (fresh: `investmentId`, `tokenPrecision`, `coinAmount` = current balance, V3 `tokenId`) → confirm → `ocl defi withdraw --investment-id <id> --address <addr> --chain ethereum <exit flags>` → sign.

| Exit | Flags |
|---|---|
| Full | `--ratio 1 --platform-id <pid>` |
| Partial (non-V3) | `--amount <minimal units> --platform-id <pid>`: floor(coinAmount × 10^tokenPrecision), e.g. `"2.3792"` at precision 6 → `2379200`. The card says "human-readable", but the CLI rejects decimals and amounts above the balance. |
| V3 pool | `--token-id <tokenId> --ratio <0–1>` (`--ratio 1` = full exit; `--ratio` required) |
| Lending repay | exact amount only, never `--ratio 1` (see [redeem rules](#low-level-path)) |

Claim: `positions` → fresh `position-detail` → confirm → `ocl defi collect --address <addr> --chain ethereum --reward-type REWARD_INVESTMENT --investment-id <id> --platform-id <pid>` → calldata, or an error when every reward is zero (nothing to claim) → sign.

| `--reward-type` | Use for | Required |
|---|---|---|
| `REWARD_PLATFORM` | protocol-level rewards (e.g. AAVE from the Aave safety module) | `--platform-id` |
| `REWARD_INVESTMENT` | product mining/staking rewards | `--investment-id` + `--platform-id` |
| `V3_FEE` | Uniswap V3 / PancakeSwap V3 trading fees | `--investment-id` + `--token-id` |
| `REWARD_OKX_BONUS` | OKX bonus rewards | `--investment-id` + `--platform-id` |
| `REWARD_MERKLE_BONUS` | Merkle proof-based bonus / airdrop claims | `--investment-id` + `--platform-id` |
| `UNLOCKED_PRINCIPAL` | principal unlocked after the lock period | `--investment-id` + `--principal-index` |

Aave borrow returns `callDataType=WITHDRAW` (borrow = withdraw from pool) and Aave repay returns `DEPOSIT` (repay = deposit back). This is normal; never expose these labels to the user.

## Sign and broadcast dataList

- Confirm with the user before every invest / withdraw / collect execution. The address used to generate the calldata must be the signing address.
- Execute `dataList[0]`, then `dataList[1]`, … strictly in order, never in parallel. Wait for each confirmation (Path A: `txStatus` 2; Path B: `contract-call` returns a txHash). If a step fails, stop all remaining steps and report which ones succeeded and which failed.
- `--chain` for `wallet contract-call` and `gateway broadcast` is the realChainIndex: 1 Ethereum, 56 BSC, 137 Polygon, 196 X Layer, 501 Solana.
- `--amt` = `dataList[N].valueNormalized`, passed as-is. It is already a minimal-unit decimal integer string (hex → decimal; `""`/null/`"0x0"` → `"0"`). A step carrying `valueNormalizeError` has `valueNormalized` `"0"` (not guessed): do not execute it; relay the error and stop.
- **Solana**: the base58 VersionedTransaction's blockhash expires in ~60 s. Right after receiving Solana calldata, before anything else, say: "This Solana transaction must be signed and broadcast within 60 seconds or it will expire. Please sign immediately."

Path B, the agentic wallet (`contract-call` signs in the TEE and broadcasts, so there is no separate broadcast step; [wallet commands](../commands/wallet.md)):

| Family | Command per step |
|---|---|
| EVM (Ethereum, BSC, Polygon, Arbitrum, Base, X Layer `196`, …) | `ocl wallet contract-call --to <to> --chain <realChainIndex> --input-data <serializedData> --amt <valueNormalized> --biz-type defi` |
| Solana | `ocl wallet contract-call --to <to> --chain 501 --unsigned-tx <serializedData> --biz-type defi` |

Path A, a user-provided/external wallet ([gateway commands](../commands/gateway.md)): the user signs with `to`, `serializedData` and `value` → `ocl gateway broadcast --signed-tx <signed_hex> --address <addr> --chain <realChainIndex>` → poll `ocl gateway orders --address <addr> --chain <realChainIndex> --order-id <orderId>` until `txStatus` 2 → next step. Signer handling of `serializedData`:

| Chain | Encoding | Handling |
|---|---|---|
| EVM | hex (`0x`) | use as `tx.data`, `to` as target |
| Solana | base58 | bs58 decode → skip first 65 bytes (signature placeholder) → `VersionedMessage.deserialize()` → sign → broadcast within 60 s |
| Sui | base64 BCS | base64 decode → prepend intent `[0,0,0]` → blake2b-256 → Ed25519 sign → submit |
| Aptos | `transactionPayload` (JSON) | build via SDK `build.simple()` → sign → submit |

## Positions display

Overview `ocl defi positions --address <addr> --chains ethereum,bsc,avalanche` (per-chain platform list with `totalValue`, `analysisPlatformId`), then `ocl defi position-detail --address <addr> --chain ethereum --platform-id <analysisPlatformId>`. Apply the [compatibility](#address-chain-compatibility) split: Solana goes in its own call with the Solana address.

`positions`: use exactly these columns, in this order, with no substitutions or omissions:

| # | Platform | analysisPlatformId | Chains | Positions | Value(USD) |
|---|---|---|---|---|---|
| 1 | Aave V3 | 12345 | ETH,BSC | 2 | $120.00 |

- Each `walletIdPlatformList[*].platformList[*]` is one row: `platformName` → Platform, `analysisPlatformId` → analysisPlatformId, `networkBalanceList[*].network` comma-joined → Chains, `investmentCount` → Positions, `currencyAmount` → Value(USD).
- `analysisPlatformId` is mandatory in every row (users copy it for position-detail). Never omit, hide or replace it.
- Never group platforms. Each platform gets its own row regardless of value.

`position-detail` output is `{"ok": true, "data": [ {"walletIdPlatformDetailList": [...]}, ... ]}`. `data` is an **array**: iterate it (calling `.get()` on it is a client bug, not an API error). Render all tokens in a single flat table with these exact columns:

| Type | Asset | Amount | Value(USD) | investmentId | aggregateProductId | Token Contract | Rewards |
|---|---|---|---|---|---|---|---|
| Supply | USDT | 1.002285 | $1.0025 | 127 | 71931 | `<full address>` | 0.000080 AVAX |
| Pending | sAVAX | 0.00000091 | $0.000012 | - | - | - | Platform reward |

- One row per token; merge `investmentId` and `aggregateProductId` from its parent investment entry. `investmentId` is mandatory in every row (withdraw/claim need it); `aggregateProductId` if present, else `-`.
- Token Contract: the FULL contract address, never truncated; `-` if native/empty. Rewards: pending amount + symbol, `-` if none, `Platform reward` for platform rewards. Type: investType → Supply/Borrow/Stake/Farm/Pool…; pending-reward rows use `Pending`.
- Lending `healthRate`: show it separately below the table, with a warning when < 1.5.
- V3 (`positionList` present): add a section per position `tokenId | Status | Range | tickLower | tickUpper` from `positionList[].tokenId`, `positionStatus` (`ACTIVE`/`INACTIVE`), `positionList[].range` (e.g. `0.892 - 0.992 USDC/DAI`) and `positionList[].rangeInfo.tickLower` / `.tickUpper`. These fields drive every V3 operation (add liquidity, withdraw, V3 fee collection).

## Low-level path

Prefer invest/withdraw/collect. In every `--user-input` entry, `coinAmount` must be in minimal units (integer = userAmount × 10^tokenPrecision) and `tokenPrecision` is required. The CLI converts internally and rejects decimal amounts or missing precision.

- `ocl defi prepare --investment-id <id>` supplies `tokenAddress`, `chainIndex` and `tokenPrecision` (`investWithTokenList[]`), plus `currentTick`, `tickSpacing` and `underlyingTokenList[]` for pools.
- `ocl defi deposit --investment-id <id> --address <addr> --user-input '[{"tokenAddress":"0x...","chainIndex":"1","coinAmount":"50000","tokenPrecision":"6"}]'`. V3: `--token-id` adds to an existing position; `--tick-lower=` / `--tick-upper=` are required for a new one.
- `ocl defi calculate-entry --id <id> --address <addr> --input-token <addr> --input-amount <minimal units> --token-decimal <n> [--tick-lower=<n> --tick-upper=<n>]` must run after `prepare` for V3 pools. One token amount goes in; exact amounts for BOTH pool tokens come out for `deposit --user-input`. The CLI takes `--input-amount` as an integer in minimal units and returns `investWithTokenList[]` (upstream docs say `tokenList[]`) with minimal-unit `coinAmount` + `tokenPrecision`.
- `ocl defi redeem --id <id> --address <addr>`: always run `position-detail` first (investmentId, underlying token). `--ratio "1"` = 100%, `"0.5"` = 50%. The single-token shorthand `--token/--symbol/--amount/--precision` takes an LP/receipt token with a human-readable amount + decimals and needs `--chain`; `--user-input` `[{"tokenAddress":"<underlying>","chainIndex":"<id>","coinAmount":"<amount>","tokenPrecision":"<n>"}]` takes precedence over it.

| Redeem case | Flags |
|---|---|
| Full exit | `--ratio 1`, plus `--user-input` when token info is available (preferred) |
| Partial exit | `--user-input` with the underlying token address and exact amount (required) |
| Liquid staking (Jito/JitoSOL, Lido/stETH), other non-lending non-V3 exits | `--user-input` (required) |
| Lending repay | `--user-input` with the exact repay amount; never `--ratio 1` |
| V3 remove liquidity | `--token-id` only; no `--user-input` or `--ratio` |

- `ocl defi claim --address <addr> --reward-type <type>`: `--id` is required for `REWARD_INVESTMENT`, `REWARD_OKX_BONUS`, `REWARD_MERKLE_BONUS` and `V3_FEE`. `--platform-id` is required for `REWARD_PLATFORM` and also enables auto-fetch of expectOutputList. `--token-id` is required for `V3_FEE`, `--principal-index` for `UNLOCKED_PRINCIPAL`. For `--expect-output '[{"tokenAddress":"0x...","chainIndex":"1","coinAmount":"0.01"}]'`, pass the position-detail `rewardDefiTokenInfo` entries of that `rewardType` directly (tokenAddress, chainIndex, coinAmount as shown; preferred); auto-fetch via `--platform-id` is the fallback. `V3_FEE` and `UNLOCKED_PRINCIPAL` need no `--expect-output`.

| Goal | Sequence |
|---|---|
| Deposit | `search --token USDC --chain ethereum --product-group SINGLE_EARN` → `detail --investment-id 9502` (check `isInvestable`) → `prepare --investment-id 9502` → `deposit --investment-id 9502 --address <addr> --user-input '[…]'` → sign `dataList` |
| V3 entry | `search --token USDT --platform PancakeSwap --chain bsc --product-group DEX_POOL` → `prepare` (currentTick, tickSpacing, underlyingTokenList) → `calculate-entry … --tick-lower=-32150 --tick-upper=-31350` → `deposit --user-input '[tokenA, tokenB]'` with the same ticks |
| Full Aave redeem | `positions --address <addr> --chains ethereum` (Aave `analysisPlatformId` e.g. 44) → `position-detail --chain ethereum --platform-id 44` (investmentId, coinAmount) → `redeem --id 9502 --chain ethereum --address <addr> --ratio 1 --user-input '[…]'` → `[WITHDRAW]` → sign |
| Claim `REWARD_INVESTMENT` | `position-detail` (must) → `claim --address <addr> --chain ethereum --reward-type REWARD_INVESTMENT --id 9502 --platform-id 44 --expect-output '[…rewardDefiTokenInfo]'` |
| Claim V3 fees | `position-detail` (tokenId, investmentId) → `claim --address <addr> --chain ethereum --reward-type V3_FEE --id <investmentId> --token-id <tokenId>` |

Some upstream samples are stale. Do not copy their human-readable `coinAmount` without `tokenPrecision` in `deposit`/`redeem` `--user-input` (rejected), their human-readable `--input-amount` (decimals are rejected; an integer is read as minimal units), or their `solana` mixed into one `positions` call with a `0x` address (84019).

## Return fields

| Command | Fields |
|---|---|
| `support-chains` | array {`chainIndex` ("1" Ethereum, "56" BSC, "137" POLYGON, "42161" ARBITRUM, "8453" BASE), `network` ("ETH", "BSC", "POLYGON")} |
| `support-platforms` | array {`analysisPlatformId` (= `--platform-id` elsewhere), `platformName` ("Aave V3", "Lido"), `investmentCount`} |
| `search` / `list` | `data` {`total`, `list[]` {`investmentId` (detail/prepare/deposit), `name`, `platformName`, `rate` (APY decimal string), `tvl` (USD), `chainIndex`, `feeRate`?, `detailPath`?}} |
| `detail` | `investmentId`, `investmentName`, `platformName`, `platformLogo`, `investType` (1 Save, 2 Pool, 3 Farm, 5 Stake, 6 Borrow, …), `chainIndex`, `network`, `rate`, `tvl`, `feeRate` (DEX_POOL), `hasBonus`, `isSupportClaim`, `isInvestable`, `isSupportRedeem`, `analysisPlatformId`, `subscriptionMethod`/`redeemMethod` (DEX_POOL/LENDING), `detailPath`, `underlyingToken[]` {`tokenSymbol`, `tokenAddress`, `chainIndex`, `tokenPrecision`, `tokenLogo`}, `aboutToken[]` (same + `marketCap`, `price`), `rateDetails[]` {`tokenAddress`, `tokenSymbol`, `rate`, `title`} |
| `prepare` | `investWithTokenList[]` {`tokenId`, `tokenSymbol`, `tokenName`, `tokenAddress`, `tokenPrecision`, `chainIndex`, `network`, `coinAmount` (balance), `currencyAmount` (USD)}; DEX_POOL adds `feeRate`, `currentTick`, `currentPrice` (token0 price ratio), `tickSpacing`, `underlyingTokenList[]` (index 0 = token0, 1 = token1; token fields + `isBaseToken` = native) |
| write commands (all six) | `data.dataList[]`, executed in order: `callDataType`, `from` (user wallet), `to` (target contract), `value` (native, e.g. "0x0"), `valueNormalized`, `valueNormalizeError` (only when unparseable), `serializedData` (EVM hex / Solana base58 / Sui base64 BCS), `originalData` (EVM ABI JSON), `signatureData` (permit), `transactionPayload` (Aptos JSON), `gas` (non-EVM) |
| `positions` | per platform: `analysisPlatformId` (position-detail, claim `--platform-id`), `platformName`, `chainIndex`, `totalValue`, `investedValue`, `profitValue` (unrealized P/L, USD), `platformLogo`, `investTypeList[]`, `rewardDefiTokenInfo[]` (pending claimable) |
| `position-detail` | per position: `investmentId` (withdraw/claim), `investmentName`, `investType`, `coinAmount` (redeemable, token units), `coinUsdValue`, `tokenAddress`/`tokenSymbol` (receipt/LP), `apy`, `earnedTokenList[]` (pending rewards), `tokenId` (V3 NFT), `tickLower`, `tickUpper`, `healthRate` (LENDING) |

- `callDataType`: `APPROVE` (ERC-20 approve), `DEPOSIT`, `SWAP,DEPOSIT` (V3: single token into a dual-token pool), `WITHDRAW`, `WITHDRAW,SWAP` (V3: withdraw, then swap back to the target token). Redeem patterns: `[WITHDRAW]` standard; `[APPROVE, WITHDRAW]` aToken approval first; `[WITHDRAW, SWAP]` V3 remove + swap back; `[DEPOSIT]` Aave repay.
- position-detail nesting: `data[].walletIdPlatformDetailList[].networkHoldVoList[]` → `investTokenBalanceVoList[]` (direct positions) or `investMarketTokenBalanceVoList[].assetMap.SUPPLY|BORROW[]` (lending). Each entry's `assetsTokenList[]` holds `tokenAddress`, `chainIndex`, `tokenPrecision`, `coinAmount`, `tokenSymbol`; rewards are `rewardDefiTokenInfo[]` {`rewardType`, `baseDefiTokenInfos[]`}.

## Next steps

- `list` / `search` → product detail, or start the deposit flow. `detail` → APY/TVL trend (`rate-chart` / `tvl-chart`) or invest; for a V3 Pool, liquidity depth (`depth-price-chart`) and price history (`--chart-type PRICE`).
- `invest` success → view positions or search more. `withdraw` success → check positions or wallet balance. `collect` success → check positions or swap the rewards ([swap-bridge.md](swap-bridge.md)).
- `positions` → position detail, redeem, claim rewards. `position-detail` → redeem with the table's investmentId, claim rewards, add more; for a V3 Pool, `depth-price-chart --investment-id <id>` and `--chart-type PRICE`.

## Troubleshooting

| Code | Meaning | Handling |
|---|---|---|
| 84400 | Parameter null | check required params; a partial exit needs `--amount` or `--ratio` |
| 84021 | Asset syncing | tell the user "Position data is syncing, please retry shortly" |
| 84023 | Invalid expectOutputList | the CLI builds it from position-detail; retry or pass `--platform-id` |
| 84014 | Balance check failed | insufficient balance; check with `ocl wallet balance` |
| 84018 | V3 balancing failed | adjust the price range or increase slippage |
| 84010 | Token not supported | check accepted tokens via `ocl defi detail` |
| 84001 | Platform not supported | the platform is not supported (`ocl defi support-platforms`) |
| 84016 | Contract execution failed | check parameters and retry |
| 84019 | Address format mismatch | `--address` and the chain are incompatible (EVM `0x` vs Solana base58 vs Sui/Tron/TON); apply the [compatibility rule](#address-chain-compatibility) and split EVM and Solana into two calls |

- Calldata generated but the tx fails on-chain: the position changed between position-detail and the write call (another withdraw/claim landed first). Re-run `position-detail` and regenerate; never reuse stale calldata.
- Solana calldata expired (~60 s blockhash): if signing took too long, regenerate. Never retry the expired payload.
- `--amount` rejected: it must be an integer in minimal units (userAmount × 10^tokenPrecision). Decimal or UI-unit values fail with parameter errors (84400).
- `--chains` vs `--chain`: `positions` takes `--chains`, `position-detail` takes `--chain`. The wrong one is a parameter error, not an empty result.
- Empty positions but the user insists on holdings: check the address/chain pairing first (84019 class), then protocol support (`ocl defi support-platforms`). Positions on unsupported platforms never appear.
