# Swap and bridge

OKX-aggregated same-chain swaps over 500+ DEX sources ([swap commands](../commands/swap.md)) and cross-chain bridges via Stargate, Across, Relay, Gas.zip, Mayan and ButterSwap ([cross-chain commands](../commands/cross-chain.md)). Confirmation, risk-verdict, untrusted-data and error-wording rules live in [SKILL.md](../../SKILL.md).

Contents: [Scope](#scope) · [Token resolution](#token-resolution) · [Swap](#swap) · [Calldata and approvals](#calldata-and-approvals) · [Risk matrix](#risk-matrix) · [Fund-action gates](#fund-action-gates) · [MEV protection](#mev-protection) · [Silent mode](#silent-mode) · [Insufficient balance](#insufficient-balance) · [Bridge path A](#bridge-path-a-bridge-a-token) · [Bridge path B](#bridge-path-b-track-arrival) · [No-route fallback](#no-route-fallback) · [Bridge facts](#bridge-facts) · [Errors and retries](#errors-and-retries) · [Diagnostic summaries](#diagnostic-summaries)

## Scope

- Aggregated routes only. A named venue ("swap on PancakeSwap", "SOL for USDC on Raydium", "USDT on Curve") goes to [dapp-discovery.md](dapp-discovery.md).
- Bridge: exactly 7 `cross-chain` subcommands (`bridges`, `tokens`, `quote`, `approve`, `swap`, `execute`, `status`); invent none. Unsure of a flag → `ocl cross-chain <subcommand> --help`. Path A = `quote` + `execute`; path B = `status`; `bridges` is the optional pre-check; `approve` / `swap` are manual calldata only.

## Token resolution

The same symbol has a different contract on each chain. For a bridge, resolve `--from` on `--from-chain` and `--to` on `--to-chain` separately. Native tokens need no `token search`: EVM (Ethereum, BSC, Polygon, Arbitrum, Base, …) `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` · Solana `11111111111111111111111111111111` · Sui `0x2::sui::SUI` · Tron `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb` · Ton `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c`.

Other tokens, in order:
1. CLI symbol map, passed directly as `--from` / `--to`: natives `sol eth bnb okb matic pol avax ftm trx sui`; stablecoins `usdc usdt dai`; wrapped `weth wbtc wbnb wmatic`.
2. `ocl token search --query <symbol> --chains <chain>` on the correct chain ([token commands](../commands/token.md)); use `tokenContractAddress` as `--from` / `--to` (`decimal` comes with it).
3. A full contract address from the user. EVM mixed case → convert, show only the lowercase form, and say "EVM contract addresses must be all lowercase — converted for you."

Confirm every search pick before quoting: several results → numbered list (name / symbol / CA / chain / marketCap) and wait; single match → show its details to verify. Never skip: wrong token = permanent fund loss.

## Swap

**Parameters**
- Chain missing → recommend X Layer (`--chain xlayer`, zero gas, fast).
- `--wallet`: `ocl wallet addresses --chain <chain>`, the active account's address on that chain; if it says login is required, run `ocl wallet login`.
- Amount: `--readable-amount <amt>` (CLI converts; `--amount` takes raw minimal units; pass one of the two).
- Slippage: omit for autoSlippage; `--slippage <pct>` only on explicit request, never on `swap quote`. `--max-auto-slippage <pct>` caps autoSlippage (meaningful only without `--slippage`).
- Gas level: `average` default; `fast` for meme / time-sensitive; `slow` for cost-sensitive, non-urgent.
- Presets (slippage / gas): Meme / low-cap (new, low-liquidity) autoSlippage ref 5%–20%, `fast` · Mainstream (BTC / ETH / SOL / majors) ref 0.5%–1%, `average` · Stablecoin (USDC / USDT / DAI) ref 0.1%–0.3%, `average` · Large trade (priceImpact ≥10% AND value ≥$1,000 AND pair liquidity ≥$10,000) autoSlippage, `average`.
- `--swap-mode exactOut` only on Ethereum (`1`), Base (`8453`), BSC (`56`), Arbitrum (`42161`).

**Quote**: `ocl swap quote --from <addr> --to <addr> --readable-amount <amt> --chain <chain>` (read-only). Returns `toTokenAmount`, `fromTokenAmount`, `estimateGasFee`, `tradeFee` (USD), `priceImpactPercent`, `dexRouterList[]` (`dexName`, `percentage`), per-side `fromToken` / `toToken` (`isHoneyPot`, `taxRate`, `decimal`, `tokenUnitPrice`), and per route `action` (`ok` / `warn` / `block`) + `reason` (semicolon-joined, deduplicated, `""` when `ok`).
- Show expected output, gas (USD), price impact (%), routing path, and every route's `action` / `reason`; `minReceiveAmount` in UI units and USD.
- `walletBalance` (from-token balance) is always present: a string, or JSON `null` when the balance query failed → show "balance unavailable"; never treat `null` as `0`.
- Run the [MEV assessment](#mev-protection) and the [risk matrix](#risk-matrix). A short balance returns a funding result instead ([Insufficient balance](#insufficient-balance)).

**Confirm**: impact >5% → warn prominently. Route `action` / `reason` follow the [SKILL.md risk verdicts](../../SKILL.md#safety) (`block` never broadcasts). More than 10 s before the user confirms → re-quote; price diff ≥ slippage → warn and re-confirm.

**Execute**: `ocl swap execute --from <addr> --to <addr> --readable-amount <amt> --chain <chain> --wallet <addr> [--slippage <pct>] [--gas-level <level>] [--mev-protection] [--force]`. One shot: quote → approve (if needed) → sign → broadcast; the CLI itself blocks honeypots and price impact >10%. Returns `approveTxHash?`, `swapTxHash`, `fromAmount`, `toAmount`, `priceImpact`, `gasUsed`, `nextSteps`. Errors → [Errors and retries](#errors-and-retries).

**Report as broadcast**, never "complete" / "successful" (broadcast ≠ landed). Translate the labels; `<swapTxHash>` and `<nextSteps.checkSwapStatus>` are verbatim; build `<explorerUrl>` from the chain's canonical explorer, and omit that line if unknown:

```
Swap broadcast — final on-chain result pending.
Tx hash: <swapTxHash>

1. Reply 1 — query on-chain status on Agent:
  <nextSteps.checkSwapStatus>

2. Explorer (click to open):
  <explorerUrl>
```

On "1", run `nextSteps.checkSwapStatus` verbatim. `txStatus` not `SUCCESS` / `FAIL` (empty, `PENDING`, no record) → say it hasn't landed yet and they can reply `1` again. Never auto-poll.

## Calldata and approvals

- `ocl swap swap … --wallet <addr>` (optional `--slippage`, `--swap-mode`, `--tips`, `--max-auto-slippage`) returns unsigned data and neither signs nor broadcasts: `routerResult` (quote shape incl. per-route `action` / `reason`) and `tx` (`to`, `data`, `gas`, `gasPrice`, `value`, `minReceiveAmount`). The user signs; never `ocl gateway broadcast` it. Calldata expires in minutes, so re-run it when stale. Present the pair summary plus tx fields (minReceive in UI units + USD, impact %, gas USD). EVM non-native from-token → run `swap approve` first and present its calldata separately. Solana: `--tips` embeds Jito calldata. EVM: no `--mev-protection` here, so recommend a MEV-protected RPC.
- `ocl swap approve --token <addr> --amount <minimal_units> --chain <chain>` (advanced / manual) returns `data` (send the tx to the **token contract**, not `dexContractAddress`), `dexContractAddress` (the spender, already encoded in `data`), `gasLimit`, `gasPrice`.
- `ocl swap chains` → per chain `chainIndex`, `chainName`, `dexTokenApproveAddress` (router address for approvals). `ocl swap liquidity --chain <chain>` → `id`, `name` (e.g. `Uniswap V3`), `logo`.

## Risk matrix

Agent-side signals the CLI does not classify; judge them from quote data and [security scans](security.md):

| Risk | Buy | Sell | Notes |
|---|---|---|---|
| No quote available | CANNOT | CANNOT | unlisted / zero liquidity |
| Black / flagged address | BLOCK | BLOCK | flagged by security services |
| New token (<24 h) | WARN | PROCEED | on buy require explicit confirmation |
| Insufficient liquidity | CANNOT | CANNOT | too low to execute |
| Token type not supported | CANNOT | CANNOT | suggest an alternative |
| Pair `liquidity` (when known) < $10K / < $1K | WARN | WARN | < $10K: high slippage risk, user confirms before the swap; < $1K: strong warning of significant losses, proceed only on explicit confirmation |

BLOCK = halt, require explicit override · WARN = warn + ask · CANNOT = impossible · PROCEED = allow with info.

## Fund-action gates

Every flag that broadcasts or widens spending authority needs an explicit yes/no. When in doubt, ask: a delayed confirm beats a wrong broadcast.

| Flag | Gate |
|---|---|
| `--wallet` | active account's address from `ocl wallet addresses --chain <chain>` (bridge: the from-chain), or the user's explicit address |
| `--slippage` | default autoSlippage (bridge: CLI default); override only on explicit request |
| `--mev-protection` / `--tips` | set per [MEV protection](#mev-protection); user override allowed |
| `--gas-token-address` / `--relayer-id` / `--enable-gas-station` | Solana Gas Station; only after the user is informed / opted in ([gas-station.md](gas-station.md)) |
| `--bridge-id` / `--route-index` | only when the user picked a table row or named a bridge |
| `--allow-bridges` / `--deny-bridges` | only when the user said "use only X" / "don't use X" |
| `--receive-address` ≠ wallet | say "Wrong destination = permanent fund loss" and get a second confirmation of the address |
| `--force` | bypasses backend risk warning 81362 (possible honeypot / poisoned contract); only after telling the user the risk is "potential fund loss" and they confirm, then re-run the same command |

## MEV protection

- **Swap**: enable if EITHER potential loss (`toTokenAmount × toTokenPrice × slippage`) ≥ $50, OR amount (`fromTokenAmount × fromTokenPrice`) ≥ the chain threshold. Disable only when both are below; a price that is unavailable or 0 → enable.
- **Bridge**: the CLI auto-forces MEV protection for relay / mayan / butterswap. Other bridges: pass `--mev-protection` when `txValueUsd = fromTokenAmount × fromTokenPrice` ≥ the threshold; `fromTokenPrice` unavailable → enable.

| Chain | Swap threshold | Swap flag | Bridge threshold |
|---|---|---|---|
| Ethereum | $2,000 | `--mev-protection` | $2,000 |
| Solana | $1,000 | `--tips <sol>` (0.0000000001–2 SOL; CLI adds Jito calldata) | — |
| BNB Chain | $200 | `--mev-protection` | $200 |
| Base | $200 | `--mev-protection` | $200 |
| Other chains | — | not supported | other EVM $100: no MEV option; above it warn the broadcast is unprotected, then proceed |

Solana: `--tips` and `computeUnitPrice` are mutually exclusive (the CLI sets `computeUnitPrice=0` with `--tips`). Re-evaluate on every amount change; never carry a decision over.

## Silent mode

Automated execution only after the user explicitly authorized it; never assume it. BLOCK-level risks (including `receiveAddress != wallet`) still halt and notify. Log every silent tx (timestamp, pair, amount, slippage or route, `txHash` / `fromTxHash`, status) and present the log on request or at session end.

## Insufficient balance

- `swap quote` may return `{ok:false,data:{phase,decision,reason,nextAction,payload}}` with `funding_required` / `blocked` / `insufficient_balance` and an empty `nextAction` instead of a quote. Enter the shared funding flow in [wallet.md](wallet.md) at once; its template shows balance, shortfall, address and QR in the same reply. `payload.operation` = `swap`; `fundingTarget` / `fundingNeed` / `qr` come from the CLI funding helper. For `exactOut` the required amount is the quote's `fromTokenAmount`, not the requested output.
- The result holds no saved quote, resume token, executable command or prior confirmation. When funding is verified and the user continues, treat it as a new swap intent: get a new quote from current inputs (ask if unclear). Another insufficient result re-enters funding; a normal quote needs the ordinary fresh confirmation. Quote display uses the swap template, not the funding one.
- Bridges: no manual balance / gas pre-check; `execute` gates it (`action=blocked`, below).

## Bridge path A: bridge a token

**Step 1: tokens.** [Token resolution](#token-resolution), per chain.

**Step 2: parameters.** `--from-chain` and `--to-chain` both required (ask if missing); `--readable-amount`; `--slippage` only on request; `--wallet` = the active account's from-chain address (log in if required). Omit `--bridge-id` for the optimal route. Receive address: same family (EVM→EVM) defaults to the wallet (display "Sender / Receiver"); heterogeneous (EVM↔non-EVM) requires `--receive-address` in the `--to-chain` family; any address ≠ wallet → fund-action gate.

**Step 3: pre-check.** `ocl cross-chain bridges --from-chain <X> --to-chain <Y>`. Non-empty → go on. Empty → no bridge connects the pair: skip the quote, localize the gap with `--from-chain <X>` alone (source supported?) then `--to-chain <Y>` alone (destination reachable?), and suggest a supported chain or a two-hop via Ethereum. To show `bridges`: `# | Bridge | Supported Chains | Native Fee` (`requireOtherNativeFee` → Yes/No); no `logo` or raw ID fields.

**Step 4: quote.** `ocl cross-chain quote --from <addr> --to <addr> --from-chain <chain> --to-chain <chain> --readable-amount <amt> --wallet <addr> --check-approve` (`--wallet --check-approve` makes `needApprove` accurate). `--sort`: `0` optimal (default) · `1` fastest · `2` max output; add `--bridge-id` / `--allow-bridges` / `--deny-bridges` only per the gates. Render `routerList[]` in exactly these 7 columns every time, one row per entry, never collapsed (translate headers; the sample row names source fields, don't print it; empty/zero/null → default, never drop a column):

```
| # | Bridge       | Est. Receive    | Min. Receive      | Fee             | Est. Time      | Approve       |
|---|--------------|-----------------|-------------------|-----------------|----------------|---------------|
| n | `bridgeName` | `toTokenAmount` | `minimumReceived` | `crossChainFee` | `estimateTime` | `needApprove` |
```

Receive / Fee in UI units + symbol, Fee adding `otherNativeFee` when non-zero (default `0`); Est. Time from seconds (`~43s`, `~6min`); Approve `Yes`/`No` (default `No`), glossed below the table (Yes = first-time approval to the {bridgeName} router; No = allowance sufficient). Recommend route #1 with a one-line reason (lowest fee / fastest / max output). Empty `routerList` → [No-route fallback](#no-route-fallback).

**Step 5: confirm.** `priceImpactPercentage` > 10% → warn prominently (empty in pre-prod → 0%). Receive address ≠ wallet → gate. Freshness: the last user-confirmed quote is the baseline; after >10 s re-quote and compare the new `toTokenAmount` against the baseline's `minimumReceived`; a freshly confirmed quote becomes the baseline. More than one row → use the route the user points to, else re-prompt with the rows; never auto-pick (a single-row quote may take a plain "yes").

**Step 6: execute.** `ocl cross-chain execute --from <addr> --to <addr> --from-chain <chain> --to-chain <chain> --readable-amount <amt> --wallet <addr> [--bridge-id <id> | --route-index <n>] [--receive-address <addr>] [--mev-protection]`. Pin the chosen route, apply freshness right before broadcasting, decide MEV per the rules. Outcomes:
- `action=execute`: success; carries `nextSteps.checkBridgeStatus`, `fromTxHash`, `swapOrderId`, `bridgeId`, `bridgeName`, `fromChainIndex` (+ `approveTxHash` if an approval ran) → step 7.
- `action=blocked` (`insufficient_balance` / `insufficient_gas`): relay `message` and stop; nothing was broadcast.
- `action=fallback`: no direct route → [No-route fallback](#no-route-fallback). Error → [Errors and retries](#errors-and-retries); a risk warning still needs the `--force` gate.

**Step 7: report** on `action=execute` with this exact template (translate; no tables, reordering or dropped lines):

```
Cross-chain transfer broadcast.

Route: {bridgeName}
From: {fromAmount} {fromTokenSymbol} on {fromChain}
Expected arrival: ~{toTokenAmount} {toTokenSymbol} on {toChain}
Minimum guaranteed: {minimumReceived} {toTokenSymbol}
Bridge fee: {crossChainFee} {fromTokenSymbol}
Estimated time: ~{estimateTime} seconds

Source TX: {fromTxHash}
Order ID: {swapOrderId}
Bridge: {bridgeName} (id={bridgeId})
Source chain: {fromChain} ({fromChainIndex})

To check arrival status, choose either:
  - Tell me in chat with the tx hash, e.g. "check if tx {fromTxHash} has arrived". I will run the command for you.
  - Run directly in terminal — paste verbatim (--bridge-id and --from-chain are REQUIRED):
    {nextSteps.checkBridgeStatus}
```

Keep BOTH status options, never command-only. The chat phrasing embeds the real `fromTxHash`; the command is `nextSteps.checkBridgeStatus` verbatim (CLI-assembled; never hand-assemble it). Throughout, amounts are in UI units and both chains and both tokens are shown.

## Bridge path B: track arrival

`ocl cross-chain status --tx-hash <fromTxHash> --bridge-id <bridgeId> --from-chain <fromChainIndex>`, or `--order-id <swapOrderId>` in place of `--tx-hash`. Reuse the last `nextSteps.checkBridgeStatus` verbatim when available, else ask for the missing values. The full triple is always required or the call returns 50014. `to*` fields stay empty/zero until `SUCCESS`.
- `SUCCESS`: "Cross-chain transfer complete. {toAmount} {toTokenSymbol} arrived on {toChain}. Destination TX: {toTxHash}"
- `PENDING`: "Transfer in progress. Bridge: {bridgeName}. Check again shortly. Estimated arrival: ~{estimateTime}."
- `NOT_FOUND`: first seconds: "Bridge has not yet indexed your transaction. Wait 10–30s and re-check."; persisting >5min: "Source chain may not have confirmed it. Verify on the explorer."

One check per request; never `sleep`-loop in chat. Not `SUCCESS` → report and say when to ask again (~`estimateTime`). Not atomic: never say "complete" before `SUCCESS`. Long PENDING / NOT_FOUND → [edge cases](#errors-and-retries). Polling script only when the user asks for one: backoff 10→20→40→60→60 s, stop on `SUCCESS` or after `estimateTime × 5`; in zsh never name the loop variable `status` (read-only), use `st`.

## No-route fallback

Empty `routerList` / `action=fallback` is a normal branch, not an error. The backend already probed transit assets, so run no discovery loop yourself. `quote` gives `data[0]` = `{routerList:[], fallback:{...}}`; `execute` gives `data` = `{action:"fallback", routerList:[], fallback:{...}}`. Branch on `fallback.outcome`:

- `transit_available`: `fallback.transitOptions[]` amounts already include the source→transit swap and the bridge leg; display them directly with the template below (format `toTokenAmount` / `minimumReceived` / `crossChainFee` with `toTokenDecimals`). Let the user pick, then run each leg; the bridge leg is a same-token bridge (`--from {transitToken} --to {transitToken}`).
- `no_path`: relay `fallback.message` translated; optionally suggest a manual two-hop via Ethereum / Arbitrum.
- `env_unavailable`: the bridge adapter is offline here (empty backend `msg` on every transit probe). Say the route is temporarily unavailable and to retry later; never imply the pair is permanently unsupported.

```
{fromToken} cannot be bridged directly from {fromChain} to {toChain}. These transit tokens work:

| # | Transit Token  | Est. Receive    | Fee             | Est. Time      |
|---|----------------|-----------------|-----------------|----------------|
| 1 | {transitToken} | {toTokenAmount} | {crossChainFee} | {estimateTime} |

Pick a transit token. Steps:
1. Swap {fromToken} → {transitToken} on {fromChain} (use the swap flow)
2. Bridge {transitToken} from {fromChain} to {toChain}
3. Swap {transitToken} → {targetToken} on {toChain} (use the swap flow) — only when target ≠ transit
```

## Bridge facts

- Bridges and chains are decided at runtime (`ocl cross-chain bridges --from-chain <X> --to-chain <Y>`); no static list. Seen so far: Stargate/LayerZero, Across V3, Relay, Gas.zip, Mayan, ButterSwap.
- `bridgeId` is a stable openApiCode: take it from `quote.routerList[].bridgeId` or `bridges`, never hardcode it. `status` may echo a different `bridgeId`; trust your own quote/execute record.
- Fees: `crossChainFee` (bridge fee in the source token, raw units of `crossChainFeeTokenAddress`) + source-chain gas; some bridges add `otherNativeFee` (raw native units, 0 for most).
- exactIn only: the user sets the source amount and the bridge determines the output. Never attempt exactOut.
- No atomicity and no refund/failure sub-state in `status`; for a stuck transfer verify on the destination chain / bridge scan page first.
- `needApprove` is reliable only with `--check-approve`. `needCancelApprove` = USDT-pattern token (revoke before re-approve; `execute` does it automatically; backend may omit it → false). `estimateTime` is seconds (string). `priceImpactPercentage` / `estimateGasFee` may be empty in pre-prod (impact 0%).
- `bridges` (one entry per protocol; empty with both chain flags = no bridge for the pair): `bridgeId`, `bridgeName` (e.g. `STARGATE V2 BUS MODE`, `ACROSS V3`), `requireOtherNativeFee` (extra native fee on top of `crossChainFee`), `supportedChains` (chainIndex values). `tokens` (one per bridgeable from-token): `chainIndex`, `tokenContractAddress` (canonical; EVM lowercase; native may be `""` or `0xeee…`), `tokenName`, `tokenSymbol` (may be an alias like `ARB_ETH`), `decimals`.
- `quote` `data` = array of one object: `fromChainIndex`, `toChainIndex`, `fromTokenAmount`, `fromToken` / `toToken` (`decimals`, `tokenContractAddress`, `tokenSymbol`), `routerList[]` of {`bridgeId`, `bridgeName`, `toTokenAmount`, `minimumReceived`, `estimateGasFee`, `estimateTime`, `priceImpactPercentage`, `needApprove`, `needCancelApprove`, `crossChainFee`, `crossChainFeeTokenAddress`, `otherNativeFee`}.
- `execute` success is the only one-shot success (after any approval + USDT revoke confirmed on-chain), identified by `nextSteps`: `action:"execute"`, `fromTxHash`, `swapOrderId` / `approveTxHash` / `approveOrderId` (when non-empty / an approval ran), `bridgeId`, `bridgeName`, `fromChainIndex`, echoed `minimumReceived` / `toTokenAmount` / `crossChainFee` / `estimateTime`, `nextSteps.checkBridgeStatus` (a `cross-chain status --tx-hash … --bridge-id … --from-chain …` line). `status`: `chainIndex`, `txHash`, `toChainIndex`, `toTxHash`, `toTokenAddress`, `toAmount`, `bridgeId`, `status` (`SUCCESS` / `PENDING` / `NOT_FOUND`).
- Manual calldata (external wallet signs): `quote` → `approve` (sign + broadcast its `tx`) → `swap` (sign + broadcast its `tx`) → `status --tx-hash <swap_hash> --bridge-id <id> --from-chain <idx>`; `--bridge-id` must match across `approve` and `swap` (spender). `approve` returns `chainIndex`, `tokenContractAddress`, `approveAddress` (bridge router, encoded in `tx.data`), `needApprove` (meaningful only with `--check-allowance`), `tx` {`from`, `to` = token contract, `data`, `value` always `"0"`, `gasLimit`, `gasPrice`, `maxPriorityFeePerGas`}, or `tx: null` / `needApprove: false` when allowance suffices. `MAX` is unsupported: pass a number (`"0"` revokes). Never `ocl gateway broadcast` bridge calldata (it bypasses TEE signing); use `execute` for the signed flow.
- Scan pages for long-stuck cases (map `bridgeId` → name via `bridges`): Stargate / LayerZero https://layerzeroscan.com/ · ACROSS V3 https://across.to/transactions · Relay https://relay.link/transactions · Gas.zip https://www.gas.zip/scan

## Errors and retries

**Swap** (after `swap execute` errors), in this order:
1. `81104` first: show "⚠️ This chain does not currently support swap. Please try a different chain." and stop.
2. A pending approval may be the cause: wait by block time (Ethereum ~15s · BSC ~5s · Arbitrum / Base ~3s · X Layer ~3s · other EVM ~10s) and tell the user, e.g. "Swap failed, possibly due to a pending approval — waiting for on-chain confirmation before retrying."
3. `82000` / `51006`: dead / rugged / no-liquidity token; retrying may not help. Stop after 5 consecutive errors for the same `(wallet, fromToken, toToken)`; run `ocl token advanced-info` and warn if `devRugPullTokenCount > 0` or `tokenTags` contains `lowLiquidity`.
4. `81362` (swap or bridge): never auto-retry; after the `--force` gate re-run the same `execute` with `--force` (swap sends `skipWarning: true`).
5. Anything else: retry once, then surface it. A network error (swap or bridge) that persists after the SKILL.md retry → the diagnostic summary, then ask.

**Bridge codes**

| Code | Do |
|---|---|
| 82000 | no liquidity / route: surface the translated `msg` (empty when the adapter is offline); quote/execute wrap it into `fallback`, and empty `msg` on all transits = `env_unavailable` |
| 82104 | token unsupported: transit fallback, or say it is unsupported |
| 82105 | "This chain pair isn't currently supported by any bridge." |
| 82106 | bad bridge id: re-run `quote` without `--bridge-id` |
| 82200 | address blacklisted: BLOCK, never retry |
| 82201 / 82202 | wallet address format invalid: check it, lowercase a mixed-case EVM address / receive address invalid (family mismatch): ask for the right format |
| 82500 / 5000 | calldata build failed (bridge server) / system error: retry once; if persistent, escalate (82500) or surface (5000) |

**Bridge edge cases**
- Approval failed inside `execute`: nothing bridged. Check source-chain gas and re-run the same `execute` (re-quotes, re-approves; auto revoke→approve when `needCancelApprove=true`).
- Approval wait timed out: the CLI bailed but the tx may be pending. Check `ocl wallet history --tx-hash <approveTxHash>` (or `--order-id <approveOrderId>`; pre-prod often returns an empty `approveTxHash`). Stuck EVM tx → a 0-value tx with the same nonce cancels it.
- Reverts at the swap step after approving: TEE pre-execution failed (allowance not reflected yet, or price moved). Never `--force` (that is for 81362). Wait 1–3 min, re-run the same `execute` (its re-quote shows `needApprove=false`); if repeated, check on-chain allowance and re-run `quote --check-approve`.
- `fromTxHash` not on the public chain: maybe never broadcast. Check the source explorer; if it truly never happened, escalate to OKX support with `fromTxHash` + bridge name + amount.
- `NOT_FOUND`: first 30 s expected; 30 s–5 min → check the source explorer; >5 min → likely bridge-side delay, point to the scan page and wait up to `estimateTime × 5`; >4 h → escalate with `fromTxHash` + `bridgeName`.
- Stuck `PENDING`: `status` follows a lagging fill-event listener. In flight → wait up to `estimateTime × 10` and check the scan page. Already filled (mainly ACROSS V3): the destination balance rose by ~`minimumReceived` (`ocl wallet balance --chain <toChain>` or explorer) → tell the user the funds arrived, with that evidence, and stop waiting. Long PENDING with no on-chain fill → escalate.

## Diagnostic summaries

Produce one before reporting any swap or bridge failure (broadcast error, revert, timeout, persistent network error). Use the lines tagged for the flow plus the untagged ones, in this order, and drop the tags:

```
Diagnostic Summary:
  txHash:        <hash or "simulation failed">              [swap]
  fromTxHash:    <source hash or "not yet broadcast">       [bridge]
  approveTxHash: <approve hash or "not needed / not run">   [bridge]
  chain:         <chain name (chainIndex)>                  [swap]
  fromChain:     <chain name (chainIndex)>                  [bridge]
  toChain:       <chain name (chainIndex)>                  [bridge]
  errorCode:     <API or on-chain error code>
  errorMessage:  <human-readable error>
  tokenPair:     <fromToken symbol> → <toToken symbol>
  amount:        <amount in UI units>
  slippage:      <value used, or "auto">                    [swap]
  bridgeId:      <selected bridge id>                       [bridge]
  bridgeName:    <bridge protocol name>                     [bridge]
  mevProtection: <on|off>
  walletAddress: <address>
  receiveAddress:<address (if different from wallet)>       [bridge]
  timestamp:     <ISO 8601>
  cliVersion:    <ocl --version>
```
