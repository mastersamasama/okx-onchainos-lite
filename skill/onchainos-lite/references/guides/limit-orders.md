# Limit orders

Price-triggered limit orders on the agentic wallet: `ocl strategy create-limit | cancel | list | resume` ([strategy commands](../commands/strategy.md)). Orders are stored on the TEE and execute automatically when the trigger fires. Requires login. Output is JSON only (no `--format`); render every user-facing table from it.

Contents: [Boundary](#boundary) · [Supported chains](#supported-chains) · [Create](#create-two-step-confirmation) · [Display labels](#display-labels) · [List](#list) · [Cancel and resume](#cancel-and-resume) · [Async wait](#async-wait) · [Enums](#enums) · [Errors and events](#errors-and-events) · [Limitations](#limitations)

## Boundary

| User intent | Route |
|---|---|
| "Swap X for Y now", "Buy 0.5 ETH with USDC" (market order, immediate) | [swap-bridge.md](swap-bridge.md) |
| "Buy ETH if it dips to $2000", "Sell when ETH hits $5000", take profit, stop loss, buy above a price; "Cancel my pending order", "What limit orders do I have?" | here |
| A venue is named (Uniswap, PancakeSwap, Raydium, …) | [dapp-discovery.md](dapp-discovery.md) (this is OKX-aggregated limit orders only) |

- `--from-token` / `--to-token` take contract addresses; the strategy CLI never resolves symbols, so resolve them via [token-research.md](token-research.md) first.
- Trader Mode (SA) activation is transparent: on `create-limit` / `resume`, backend `60018` (`UPGRADE_REQUIRED`) makes the CLI activate Trader Mode and retry once; the user sees `Trader Mode activated.` then normal output. Never ask the user to activate it. If activation fails the command aborts with the activation error; suggest `ocl wallet status`.

## Supported chains

Ethereum (`1`), BSC (`56`), X Layer (`196`), Solana (`501`), Base (`8453`), Arbitrum (`42161`) only. Resolve a named chain to its chainIndex and check. Anything else (Polygon, Optimism, Avalanche, Linea, Sui, Tron, …): reply directly, with no CLI call and no Step 1:

> Strategy orders are only supported on Ethereum / BSC / X Layer / Solana / Base / Arbitrum right now. `<requested chain>` is not supported — pick one of these to continue.

## Create: two-step confirmation

`create-limit` is a write: summarize, and call the CLI only after explicit confirmation. Never pass or compute the strategy type; the CLI derives it from `--direction`, `--trigger-price` and the current price ([Enums](#enums)).

**Step 0: from-token USD price** (for the Value line). Stablecoin (USDT/USDC/USDG/USDe/DAI/FDUSD/…) → `from_price ≈ 1.0`, no call. Otherwise `ocl market price --chain <chain> --address <from_token>`, read `data[0].price`. Run no client-side $1-minimum gate; the CLI enforces it.

**Step 1: summary.** Five categories, none dropped (prose free): **1 Chain**, the human-readable name from `--chain-id`; **2 Order Type**, the translated strategyType label; **3 From**, symbol + raw `--amount`; **4 To**, symbol, Trigger Price (USD), Estimated Amount, Value (est. USD); **5 Slippage**, `Default 15%` or `User-specified X%`.

- Buy (Buy Dip / Buy Above): Estimated Amount = `from_amount ÷ trigger_price`; Value = `from_amount × from_price` (stablecoin ≈ `from_amount`).
- Sell (Take Profit / Stop Loss): Estimated Amount = `from_amount × trigger_price`; Value = `from_amount × trigger_price` (when the to-token is a stablecoin).
- These are agent estimates from the trigger price, not backend quotes; never present them as fill amounts. Make clear the trigger price is a USD price, not an exchange rate.
- Slippage: user silent → show `Default 15%` and omit `--slippage` (CLI default 15). User says "slippage X%" → show `User-specified X%` and pass `--slippage X` as a plain number (`20%` → `20`; `0.05` means 0.05%, not 5%).

After the five categories, add the expiry line, then the reply prompt:

```
1. Chain: Arbitrum
2. Order Type: Buy Dip
3. From: USDC 10
4. To:
   - Symbol: ARB
   - Trigger Price: $0.10
   - Estimated Amount: 100 ARB
   - Value: $10
5. Slippage: 15% (default)

If the trigger condition is not met within 7 days, this order auto-expires.

Reply confirm / change / cancel.
```

**Step 2: reply.** confirm / yes / submit → `ocl strategy create-limit …`. change ("amount = 5", "trigger to 0.08") → update the field and re-render Step 1. cancel / abort → no CLI call; say the order was discarded.

Flag notes (full list in the card): `--direction buy|sell` (case-insensitive, there is no `--type`); `--chain-id` takes the id or alias (`1`, `solana`, `bsc`, `arbitrum`, `base`, `xlayer`); `--current-price` is the USD price of the comparison token (to-token for buy, from-token for sell), and the CLI fetches it when omitted; `--mev-protection default` lets the backend pick. TTL is fixed at `604800` s (7 days) and no flag changes it.

**Result**: `{orderId, status, statusLabel, estimatedWaitTime, eventCursor}`. If `data.belowMinimum == true` (below the $1 USD minimum: exit 0, no order created, same `{belowMinimum, minFromAmount, fromSymbol}` shape whether the local pre-check or backend `100010` caught it; `minFromAmount = ceil(1.0 / from_token_price)` as an integer string), output exactly the line `Minimum order amount: <minFromAmount> <fromSymbol>` and nothing else (no math, no $1 mention, no echo, no apology). Copy both values verbatim and translate only the prefix. Then wait for a larger `--amount` and re-submit.

## Display labels

Show the user only the canonical labels, translated into the conversation language at output time. strategyType (4): Buy Dip · Take Profit · Stop Loss · Buy Above. status (9): Expired · Cancelling · Cancelled · Failed · Trading · Completed · Creating · Active · Suspended. Status arrives as `statusLabel`; look up the strategyType label in the [enum table](#enums). Never mix two languages in one label, never show enum names (`BUY_DIP`, `COMPLETED`, …) or flag values (`buy_dip`, `completed`, …), and never pass raw `statusLabel` untranslated to a non-English user. `CHASE_HIGH` is **Buy Above** (not "Chase High"). `SPEEDING_UP` (-4) is not a valid filter or display value.

## List

General "show my orders" (no status named): run `ocl strategy list --limit 10`, always with `--limit 10`. Without `--status`, the server applies the non-terminal set `[-3,0,2,3,4]`. Render `data.list` with exactly these 8 columns:

| Order id | Order Status | Order Type | Estimated Amount | To Token addr | Value | Trigger price | Expire after |
|---|---|---|---|---|---|---|---|

Order id = `orderId`. Order Status = `statusLabel` and Order Type = the strategyType label, both translated. Estimated Amount = `toToken.tokenAmount` + space + `toToken.tokenSymbol`. To Token addr = `toToken.tokenContractAddress` as first 6 + `...` + last 4 (EVM `0x1234...cdef`, base58 the same; shorter than 10 chars → verbatim). Value = `toToken.tokenUsd` as `<n> USD`. Trigger price = `$` + `triggerInfo.triggerPrice` (empty → `triggerInfo.triggerRate`). Expire after = `expireTime` (13-digit ms UTC) in the user's local timezone, `MM/DD/YYYY HH:MM:SS`, 24-hour. Sample:
`| 17262791359882688 | Active | Take Profit | 0.2 SOL | 9xQeWv...vEjz | 16 USD | $80 | 05/15/2026 17:50:49 |`

Footer (translated; include the "next page" line only when `nextCursor` is non-empty):
> Showing live orders by default (10 per page).
> - Reply "next page" to load more.
> - To filter by a specific state, ask for orders by their Display label — e.g. `Completed`, `Cancelled`, `Failed`, `Expired`.

- "next page" → the same command + `--cursor <nextCursor>`, same table.
- User names one of the 9 status labels → `ocl strategy list --limit 10 --status <value>` ([status enum](#enums)), same table, without the filter bullet. Terminal orders appear only with an explicit `--status`.
- `--order-id <id>` returns one order's detail. `--status` / `--chain-id` take comma lists. `--token` takes one address (for several tokens, call once per token and merge). The page size max is 100.

## Cancel and resume

Cancel takes exactly one selector: `--order-id <id>`, `--order-ids id1,id2,…` or `--all`. Never combine `--all` with `--wait`: the CLI rejects it before any cancel is sent (`code: invalid_input`, `field: wait`, exit 1). Use `--order-id` / `--order-ids` with `--wait`, or bulk-cancel without `--wait`. Without `--wait` the result is `{updateNum, estimatedWaitTime}`; `updateNum` counts accepted cancels, not terminal ones, so re-query with `list`.

`ocl strategy resume` with no ids auto-discovers every `SUSPENDED` + `canResume=true` order on the active wallet; `--order-ids id1,id2` targets specific ones. Afterwards, warn that orders whose trigger is already met may execute immediately, and re-query with `list` to confirm.

## Async wait

`create-limit`, `cancel` and `resume` return once the request is accepted, not at terminal state.
- `--wait`: the CLI sleeps a fixed 3 s (all chains, never keyed to `estimatedWaitTime`), re-queries each affected order and merges `settled`, `status`, `statusLabel`. Only when settled does it add `transactionInfo`, `executionHistoryList`, `fromToken`, `toToken` and `orderStatusUpdateTime`. Cancel/resume return `{settled, orders:[{orderId, settled, status, statusLabel, …}]}`, where the top-level `settled` is the AND across orders. `settled == false` → surface the partial state; do not loop.
- Without `--wait` the response only confirms acceptance; when terminal state matters, run `ocl strategy list --order-id <orderId>`. Solana settles immediately (`estimatedWaitTime=0`).

## Enums

strategyType is derived by the CLI; a tie (trigger = current) goes to the aggressive side (CHASE_HIGH / STOP_LOSS).

| int | Enum | Direction | Trigger vs current | Label | Meaning |
|---|---|---|---|---|---|
| 2 | BUY_DIP | buy | trigger < current | Buy Dip | buy when price falls to trigger |
| 5 | CHASE_HIGH | buy | trigger ≥ current | Buy Above | buy when price rises above trigger |
| 3 | TAKE_PROFIT | sell | trigger > current | Take Profit | sell when price rises to trigger |
| 4 | STOP_LOSS | sell | trigger ≤ current | Stop Loss | sell when price falls to trigger |

| Set | int · Enum · `--status` value · Label |
|---|---|
| Non-terminal (default when `--status` is omitted) | -3 CANCELLING `cancelling` Cancelling · 0 TRADING `processing`/`trading` Trading · 2 CREATING `creating` Creating · 3 ACTIVE `active` Active · 4 SUSPENDED `suspended` Suspended |
| Terminal (only with an explicit `--status`; for "all, including terminal" pass all 9) | -7 EXPIRED `expired` Expired · -2 CANCELLED `cancelled` Cancelled · -1 FAILED `failed` Failed · 1 COMPLETED `completed` Completed |

## Errors and events

Map any backend code from `create-limit` / `cancel` / `list` / `resume` by integer code, never by message text.

| Code | Name | Action |
|---|---|---|
| 100 | REQUEST_PARAM_ERROR | Surface the backend message; ask the user to fix the flag |
| 10019 | INSUFFICIENT_NATIVE_GAS_BALANCE | Native gas below minimum (msg has `minAmount`); prompt a top-up (deposit / transfer / swap a stablecoin to native via `ocl swap execute`); no auto-retry |
| 10026 | JWT_TOKEN_VERIFY_FAILED | `ocl wallet login`, then retry |
| 10106 | CHAIN_NOT_SUPPORT_ERROR | Suggest a [supported chain](#supported-chains) |
| 60002 | NO_ORDER_FOUND | Id wrong or already terminal; suggest `list` |
| 60003 | LIMIT_ORDER_NO_AUTHORITY | Trader Mode not active yet; the next call activates it, so retry once |
| 60006 | LIMIT_ORDER_OUT_LIMIT_FAIL | At the 100 pending-order max per account; ask the user to cancel some, then retry |
| 60009 | LIMIT_ORDER_ILLIQUIDITY_ERROR | No liquidity at the trigger; suggest another pair or a wider trigger |
| 60014 / 60015 / 60017 | …EXPIRED / PENDING / SUCCESS_CANNOT_OPERATE | Already expired / mid-lifecycle (wait for terminal state) / already completed |
| 60018 | UPGRADE_REQUIRED | Handled by the CLI; if it leaks, retry the same command |
| 60030 | QUOTA_EXCEEDED | Account-level quota reached |
| 100005 | WALLET_ADDRESS_BLACKLISTED | Address flagged; contact support, no retry |
| 100007 / 100008 | TEE_SIGN_FAILURE / TEE_SERVICE_UNAVAILABLE | Transient, retry once / unavailable, retry later |
| 100010 | ORDER_AMOUNT_TOO_SMALL | Below the $1 minimum (`create-limit` returns `belowMinimum` instead); increase `--amount` and retry |
| 100012 | LIMIT_ORDER_INSUFFICIENT_BALANCE | Suggest `ocl wallet balance` |

**Execution events** (`executionHistoryList[].code`, from the TEE swap-trade engine on an active order). For each recognised code the CLI adds `name` (internal, never show), `message` (show verbatim, translated) and `terminal`. For an unrecognised code, show the raw backend `msg`, or `event code <N>` if there is none.

- The latest entry wins, so read it first. `terminal=true` → stop polling and surface it. `terminal=false` → safe to wait, but if it repeats 3+ times, treat it as user-actionable. The same code every ~10 s with no `txHash` is a soft retry loop: show the latest message + repeat count and ask whether to wait, cancel or adjust.
- Codes: `0` success (show `txHash` + explorer link) · `3013` top up the from-token or use a smaller amount · `3014` fund the native fee token · `3015` widen `--slippage` · `3016` non-transient (different pair / smaller amount / wider trigger / different chain) · `3017` engine retries (3+ recurrences → treat like 3016) · `3019` terminal, destination token blocklisted · `3020` terminal, wallet flagged · `3023` fixed TTL expired, so ask whether to create a new order · any other code: follow the CLI's `terminal` field.

## Limitations

The CLI does not resolve symbols to addresses. Only the default preset is available (no fee tiers or dexId filter); MEV is set via `--mev-protection`. `eventCursor` is surfaced verbatim and nothing consumes it yet. `cancel --all` uses the backend's default channel filter. Only the active account is covered, with no multi-account batch. There is no account-status call: SA activation/expiry is handled inside the `60018` flow.
