# Transfers and signing

Moving value and signing with the TEE wallet: `ocl wallet send | contract-call | sign-message | history` ([wallet commands](../commands/wallet.md)), plus the raw-transaction gateway `ocl gateway …` ([gateway commands](../commands/gateway.md)). The Confirming/`--force` protocol, pre-execution scans, simulation failure and Funding entry live in [SKILL.md](../../SKILL.md).

Contents: [Send or contract-call](#send-or-contract-call) · [Transfers](#transfers) · [Contract calls](#contract-calls) · [Approvals](#approvals) · [MEV protection](#mev-protection) · [Message signing](#message-signing) · [History and order status](#history-and-order-status) · [Raw-transaction gateway](#raw-transaction-gateway) · [Troubleshooting](#troubleshooting)

## Send or contract-call

Funds-loss risk: determine intent before any write.

| Intent | Command |
|---|---|
| Token transfer (native or token) | `ocl wallet send --chain <chain>` |
| Contract call (EVM calldata, Solana program tx, SUI PTB) | `ocl wallet contract-call --chain <chain>` |

A user-supplied address starting with `XKO` / `xko` is unsupported. Reply verbatim:
> "XKO address format is not supported yet. Please find the 0x address by switching to your commonly used address, then you can continue."

## Transfers

`ocl wallet send`: `--recipient` and `--chain` required.
- Amount: `--readable-amount <human amount>` (the CLI converts). It is required for Bitcoin and SUI and preferred everywhere else. Use `--amt` only for raw minimal units on supported account-model chains; the two are mutually exclusive.
- `--contract-token`: contract address, SUI Coin Type, or `btc-brc20-<ticker>`; omit it for the native coin. The token must exist on `--chain`.
- Bitcoin only: `--fee-rate` (sat/vB, this transaction only; the future default is unchanged) and repeatable `--brc20-outpoint` (current transferable inscription selection). Flows: [btc-utxo.md](btc-utxo.md).
- `--gas-token-address` / `--relayer-id` / `--enable-gas-station` (Solana Gas Station): second-phase values copied from a Confirming response, never on the first call. See [gas-station.md](gas-station.md).
- Between the user's confirmation and the `--force` re-run, do not query `ocl wallet balance`; the server validates balance and gas.
- Result: `txHash`. Gas Station responses (`gasStationUsed`, `orderId`, Confirming scenes) follow [gas-station.md](gas-station.md). A simulation failure never broadcasts. If a fresh balance query independently confirms the asset is insufficient, the CLI returns the common Funding result ([wallet.md](wallet.md)); otherwise it surfaces `executeErrorMsg`.

## Contract calls

`ocl wallet contract-call` signs in the TEE and broadcasts. Pass exactly one chain-native payload:

| Chain | Payload | `--to` |
|---|---|---|
| EVM | `--input-data <hex>` | required (contract) |
| Solana | `--unsigned-tx <base58>` | required (program) |
| SUI | `--sui-tx-bytes <base64>`: BCS TransactionData/PTB for the current wallet, from the maintained integration or SDK. Never display or log it. | optional service metadata; never invent it |

- `--amt`: native value for payable functions, in minimal units (default `"0"`; EVM 18, SOL 9 decimals). Take it from the flow that produced the payload; never compute minimal units by hand.
- `--biz-type`: service metadata; set it only when the matched flow requires it. Gas Station flags: second phase only, as for `send`.
- Result: `txHash` and `orderId`.
- SUI PTBs cannot be scanned. Never claim the transaction is safe; require an integration preview, explicit user confirmation and a successful backend simulation.

## Approvals

Approvals go through `contract-call`. Never set the approve amount to `type(uint256).max`, `2^256-1` or any "infinite" value, and never call `setApprovalForAll(operator, true)`. If the user explicitly asks for an unlimited approval, warn that it is irreversible and lets the spender drain all of that token, require a second explicit confirmation, and even then cap the amount to what is needed (e.g. swap amount + 10%). If the user still insists on unlimited, refuse and suggest they execute it manually via a block explorer.

## MEV protection

`--mev-protection` exists on `contract-call` only; `wallet send` has no such flag. Read this section when the user asks for it, or before a high-value or DEX-swap `contract-call`. With the flag, the broadcast passes `isMEV: true` in `extraData`, which routes the transaction through MEV-protected channels (front-running, sandwich attacks, other MEV).

- Enable it for high-value transfers or swaps with significant front-running risk, for DEX swap transactions executed via `contract-call`, or on explicit request.
- Chains: Ethereum, BSC and Base. Solana too, but it also requires `--jito-unsigned-tx <base58>` (the Jito bundle tx), without which the command fails. No other chain, and never with `--sui-tx-bytes`.
- Never substitute `--unsigned-tx` for `--jito-unsigned-tx`: they are different parameters. If Jito bundle data is unavailable, stop and ask the user whether to proceed without MEV protection or cancel.
- Solana form: `ocl wallet contract-call --to <program_id> --chain 501 --unsigned-tx <base58_tx> --mev-protection --jito-unsigned-tx <jito_base58_tx>`.

## Message signing

`ocl wallet sign-message --chain <chain> --from <signer> --message <message> [--type …]`

| `--type` | Standard | Chains | `--message` |
|---|---|---|---|
| `personal` (default) | personalSign (EIP-191) | EVM + Solana | arbitrary string |
| `eip712` | typed data | EVM only (Solana returns an error) | JSON typed-data string |

Result: `signature`, hex on EVM and base58 on Solana (Solana also returns `publicKey`).

## History and order status

`ocl wallet history` has two modes:

| Mode | Selected by | Rules |
|---|---|---|
| Detail (one record) | any of `--order-id`, `--tx-hash` (optional `--address`), `--uop-hash` | `--chain` required; ask which chain if unknown. No `--limit`. |
| List (paged) | none of those | optional `--account-id`, `--chain`, `--begin` / `--end` (Unix ms), `--cursor`, `--limit` (page size, default 20) |

- Paging: omit `--cursor` for the first page, then pass the exact `cursor` from the previous response. Never synthesize one from a page number. An empty cursor means there are no more pages.
- Right after a Gas Station broadcast, poll by `--order-id`, because `txHash` may arrive asynchronously.
- List fields: `cursor`, `orderList[]` with `txHash`, `txStatus`, `txTime`, `direction` (send/receive), `chainSymbol`, `coinSymbol`, `coinAmount`, `serviceCharge`, `confirmedCount`, `assetChange[]` (`coinSymbol` / `coinAmount` / `direction` in/out). Detail adds `failReason`, `explorerUrl`, `input[]`, `output[]`.
- `txStatus` is normalized by the CLI: `PENDING` (service `1` or `2`), `ERROR` (`3`), `SUCCESS` (`4`), `CANCELLED` (`6`). Unrecognized values pass through unchanged. `txTime` is Unix ms; convert it for display.
- No records: display "No transactions found". This is not an error.
- BRC-20: direct transfers appear here; transfer-inscription status comes from `ocl wallet inscription status` ([btc-utxo.md](btc-utxo.md)).

## Raw-transaction gateway

`ocl gateway` estimates gas, simulates, broadcasts a **pre-signed** transaction and tracks orders. It does not sign, does not generate swap calldata and does not make token transfers (use [swap-bridge.md](swap-bridge.md) or `ocl wallet send` for those). Six commands: `chains`, `gas`, `gas-limit`, `simulate`, `broadcast`, `orders`. `ocl gateway chains` (fields `chainIndex`, `name`, `shortName`, `logoUrl`) is the authoritative list of 20+ chains.

Resolve Chinese or slang phrasing first: estimate / current gas (估算 gas) → `gas` or `gas-limit`; broadcast, send a tx on-chain (广播, 上链) → `broadcast`; simulate, dry-run (模拟) → `simulate`; is the tx on-chain / confirmed (确认了吗) → `orders`; signed transaction (已签名交易) → `--signed-tx` on `broadcast`; supported chains → `chains`.

- If the chain is missing, recommend X Layer (`--chain xlayer`: low gas, fast), then ask.
- If `--signed-tx` is missing, remind the user to sign first; this CLI does not sign.
- `gas-limit` needs `--from` and `--to` (`--data` for contract interactions). `simulate` needs `--from`, `--to` and `--data`. `orders` needs `--address` and `--chain`, optionally `--order-id`.
- Gateway amounts are in minimal units (wei/lamports).

| Step | Command | Read |
|---|---|---|
| Gas price | `gateway gas` | legacy `normal` / `min` / `max`, `supporteip1559`, `eip1559Protocol.{suggestBaseFee, baseFee, proposePriorityFee, safePriorityFee, fastPriorityFee}`. Solana: `proposePriorityFee`, `safePriorityFee`, `fastPriorityFee`, `extremePriorityFee` |
| Gas limit | `gateway gas-limit` | `gasLimit` |
| Simulate | `gateway simulate` | `intention`, `assetChange[]` (`symbol`, `rawValue`), `gasUsed`, `failReason` (empty = success), `risks[]`; check revert vs success |
| Broadcast | `gateway broadcast` (`--signed-tx` hex on EVM, base58 on Solana; `--address` = sender) | `orderId` (for status queries), `txHash` |
| Track | `gateway orders` | `cursor`, `orders[]`: `orderId`, `txHash`, `chainIndex`, `address`, `txStatus` (`1` Pending, `2` Success, `3` Failed), `failReason` |

- MEV at broadcast: the swap path decides, and the gateway applies it by adding the boolean `--mev-protection` to `gateway broadcast` (sent as `enableMevProtection: true`; there are no per-chain tip or priority-fee params). It applies to Ethereum, BSC and Base. Solana MEV is not handled here; the swap path uses Jito tips.
- Display: gas price in Gwei (`18.5 Gwei`), never raw wei. Show gas limit as an integer, a USD gas-cost estimate when possible, and tx values in UI units. EIP-1559 chains show `eip1559Protocol.suggestBaseFee` + `proposePriorityFee`; legacy chains show `normal`.

## Troubleshooting

| Symptom | Action |
|---|---|
| `send`: token not on the chain | `--contract-token` must exist on `--chain` |
| `contract-call`: missing payload | EVM needs `--input-data`, Solana `--unsigned-tx`, SUI `--sui-tx-bytes` |
| `contract-call`: mixed payload flags | never combine them; keep the one for the target chain |
| Node return failed (insufficient gas, nonce too low, contract revert) | retry with corrected parameters |
| Already broadcast | re-broadcasting the same `--signed-tx` may error or return the same `txHash`; handle it idempotently |
| Approve + swap batch | approve failed: do NOT broadcast the swap. Approve succeeded but swap failed: the approval is on-chain and reusable, so retry only the swap |
| Wallet type mismatch | the address format doesn't match the chain (e.g. EVM address on a Solana chain); use the chain's own address |
| Solana encoding | `--signed-tx` must be base58, not hex |
| Chain not supported | run `ocl gateway chains` first |
| SUI: missing address or sender mismatch | refresh `ocl wallet addresses` and use the current account's SUI address |
| SUI: address, Coin Type, amount or status-lookup error | use a canonical SUI address, the complete returned `<package>::<module>::<type>` Coin Type, a positive `--readable-amount`, and one complete tx hash or order ID |
| SUI `PRE_EXECUTION_FAILED` | relay the service reason; end the operation |
| SUI `confirming=true` | [Confirm then --force](../../SKILL.md#confirm-then---force) |
| SUI `LOCAL_SIGNING_FAILED` | end the operation and report the error |
| SUI, any other failure | show the returned service message and re-establish facts with a new query; keep raw codes for diagnostics only |
