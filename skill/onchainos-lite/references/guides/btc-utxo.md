# Bitcoin UTXOs and BRC-20

Bitcoin specifics: BTC transfer fee rate, UTXO queries, asset protection (unlock / lock), mempool-input reclaim, BRC-20 balance, transfer and inscriptions. Wallet addresses, total BTC balance, general send rules and history live in [wallet.md](wallet.md) and [transfers-signing.md](transfers-signing.md). Syntax: [wallet commands](../commands/wallet.md). Every UTXO, BRC-20 and inscription command takes `--chain bitcoin`.

Contents: [BTC transfers](#btc-transfers) · [UTXO views](#utxo-views) · [Asset protection](#asset-protection) · [BRC-20](#brc-20) · [Inscriptions](#inscriptions) · [UTXO FAQ](#utxo-faq) · [Errors](#errors) · [Templates](#templates)

## BTC transfers

- `ocl wallet send --chain bitcoin` needs a complete mainnet recipient, a positive `--readable-amount`, and any outpoint as a current `<txHash>:<voutIndex>` from a UTXO query.
- After the initial preview, ask the user to confirm the current fee rate. A new sat/vB value → rerun the initial command (no `--force`) with `--fee-rate <value>`, show the fresh preview plus [Custom Fee Rate](#templates), and wait for confirmation. The custom rate applies to that transaction only.

## UTXO views

| Command | Returns | Rules |
|---|---|---|
| `ocl wallet utxo available --chain bitcoin` | Currently spendable UTXOs | Available BTC = returned `sumSats`; never derive it from total holdings |
| `ocl wallet utxo user-ignored --chain bitcoin` | UTXOs whose asset occupancy the user removed from asset protection | Source for `lock` |
| `ocl wallet utxo unavailable --chain bitcoin` | Locked or otherwise unavailable UTXOs, by category | Use only returned categories, amounts and UTXOs, no inference; run it before replying when the user follows a BTC balance answer by asking what the remaining or unavailable BTC is |

- Inactive branches may be `null`. An empty `USER_IGNORED_LIST` means no user-ignored UTXOs; an empty `AVAILABLE_UTXO_LIST` means zero available BTC. Never subtract one view from another (or from total holdings) locally.
- These three views and `wallet utxo brc20-transferable` return `assets` for UTXOs carrying BRC-20: append the [Bound BRC-20 Asset](#templates) lines once per returned asset.

## Asset protection

| Intent | Command | Resolve against |
|---|---|---|
| Remove protection (unlock) | `ocl wallet utxo unlock --chain bitcoin` with repeated `--outpoint <txHash:voutIndex>` or `--all` (every currently protected UTXO) | Latest `unavailable` view |
| Restore protection (lock) | `ocl wallet utxo lock --chain bitcoin` with repeated `--outpoint` or `--all` (every current user-ignored UTXO) | Latest `user-ignored` view |
| Reclaim still-unspent inputs of `MEMPOOL_REMOVED` transactions | `ocl wallet utxo reclaim --chain bitcoin --tx-hash <hash>` (repeat per transaction) | Transaction hashes returned by the latest `unavailable` view |

- Query the matching view first and resolve the user's reference against its current outpoints. A single amount or asset reference must match exactly one outpoint; zero or several matches → show them and wait for the user's decision.
- `--operation-token`: only when supplied by the exact `next` returned after the preview. `--force`: only through the exact `next` returned after explicit confirmation. The same applies to BRC-20 `wallet send` and `wallet inscription create`.

## BRC-20

Token id is the synthetic address `btc-brc20-<ticker>` (the CLI lowercases the ticker and converts `--readable-amount` to token minimal units). Never supply a contract address from another chain. Direct transfers use complete service-returned inscription UTXOs whose token amounts sum to the requested amount.

**Balance** — `ocl wallet balance --chain bitcoin --token-address btc-brc20-<ticker>`; add `--force` only when the user explicitly asks to refresh or sync. Reply with [BRC-20 Balance](#templates).

**Transferable inscriptions** — `ocl wallet utxo brc20-transferable --chain bitcoin --token-address btc-brc20-<ticker>`; with `--readable-amount <amount>` it returns up to three exact combinations in `selectionPlan`:

| `selectionPlan.status` | Do |
|---|---|
| `EXACT_MATCH` | Use a returned combination; if the user must choose between several, show them and wait |
| `NO_EXACT_MATCH` | Show the denominations and refresh the ticker balance; offer another amount or an inscription only when that fresh `wallet balance` shows sufficient `remainingInscribableAmount` |
| `SEARCH_LIMIT_EXCEEDED` | Show the returned choices and call the result incomplete (never claim no exact match); continue with a user-selected exact combination or a simpler amount |

**Direct transfer** (BRC-20 `wallet send`):
1. Run without `--force`: `ocl wallet send --chain bitcoin --contract-token btc-brc20-<ticker> --readable-amount <amount> --recipient <address> --brc20-outpoint <txHash:voutIndex>`, repeating `--brc20-outpoint` for every item of one current combination. Optional `--fee-rate` (this transaction only, service default, minimum `0.1` sat/vB) and `--from` (defaults to the active wallet).
2. The CLI refreshes the selected outpoints, validates availability, uniqueness and amount sum, signs, and returns ordinary `confirming` before broadcast. Show the complete confirmation plus [BRC-20 Transfer Confirmation](#templates).
3. New sat/vB → rerun step 1 with `--fee-rate`, still without `--force`; show the fresh preview plus [Custom Fee Rate](#templates).
4. Execute `next` only after explicit confirmation. It returns `state=PENDING`, `txHash`, `orderId`.
5. Status goes through wallet history, not inscription status: `ocl wallet history --chain bitcoin --tx-hash <hash>` or `--order-id <id>`.

## Inscriptions

**Create** — only on an explicit user request; creates an asynchronous transfer inscription to the current Bitcoin address. If no direct-transfer combination exists, refresh the ticker balance before offering it.
1. Run without `--force`: `ocl wallet inscription create --chain bitcoin --token-address btc-brc20-<ticker> --readable-amount <amount>` (optional `--fee-rate`, this inscription only, minimum `0.1` sat/vB; `--from`).
2. It stops after `unsignedInfo` and returns ordinary `confirming` with `scene="btc_inscription"`; `preview.feeReadable` is nullable; nothing is signed or submitted. Show the complete preview with the same fee-rate prompt and one-transaction fee statement as the BRC-20 send. A new sat/vB value needs a fresh preview without `--force`.
3. The confirmed `next` signs, calls `sign-tx` and batch-broadcasts the ordered inscription transactions. Show the returned `state=INSCRIBING`, `txHash`, `orderId`, `broadcasts` and `nextSteps.checkInscriptionStatus` verbatim, render [Inscription Submission](#templates), and stop.

**Status** — `ocl wallet inscription status --chain bitcoin` with exactly one of `--tx-hash <reveal tx hash>` or `--order-id <reveal order ID>`. Run it once, only after the user asks for the result. Pending → show the returned status and continuation, then stop; never loop, poll, sleep or promise automatic checks. `READY_TO_TRANSFER` gives read-only `nextSteps.queryBrc20TransferableUtxos` to refresh the transferable list; never auto-send after it.

## UTXO FAQ

For any semantic equivalent, reply with the matching template translated to the user's language, with no extra explanation.

| Question (triggers) | Reply |
|---|---|
| Available balance: `available balance`, `available BTC`, `spendable balance`, `spendable BTC` asking for the definition, not the current amount | Available balance is the amount currently available for BTC transfers and network fees. It excludes locked and dust UTXOs. |
| Locked UTXO: `locked UTXO`, `protected UTXO`, why a UTXO is locked | A locked UTXO is excluded from ordinary BTC transactions to protect the inscription assets it carries. You can explicitly unlock that UTXO. |
| Unlock risk: `unlock UTXO risk`, `is unlocking safe`, what happens after unlocking | After unlocking, the UTXO is treated as ordinary BTC. If it is spent, the inscription assets it carries will be permanently lost. |
| Dust UTXO: `dust`, `dust UTXO`, `small UTXO`, why a small BTC UTXO is unavailable | A dust UTXO contains a very small amount of BTC. Spending it increases transaction data size and network fees, so it is excluded from the available balance. |

**Unavailable balance** (`unavailable balance`, `unavailable BTC`, `locked balance`, `what is the remaining BTC?`, `why is it unavailable?`, what it means or how much): run `ocl wallet utxo unavailable --chain bitcoin` (never a stored balance or a figure derived from total holdings). First reply: "Unavailable balance is BTC that currently cannot be used for BTC transfers or network fees, including locked and dust UTXOs." Then append one line from the current `unavailable.unavailableBreakdown`:

| Breakdown | Append |
|---|---|
| `totalUnavailableCount` is `0` | You currently have no unavailable BTC balance. |
| `assetLocked` has UTXOs | You currently have {unavailableBalance} BTC unavailable. The following UTXOs are locked: then one `- {txHash}:{voutIndex}: {amount} BTC` line each; if `feeUneconomic` also has UTXOs add: The remaining {dustBalance} BTC is dust UTXOs. Spending them increases network fees. |
| `assetLocked` empty, `feeUneconomic` the only non-empty category | You currently have {unavailableBalance} BTC unavailable, all of which is dust UTXOs. Spending them increases network fees. |
| Any other non-empty category | Show its returned category, UTXOs and amounts; never describe it as locked or dust |

`{unavailableBalance}` = returned `totalUnavailableSumSats`; `{amount}` / `{dustBalance}` = returned UTXO amounts. A required amount is absent → omit that aggregate sentence; never calculate or infer it.

## Errors

| Error | Recovery |
|---|---|
| Missing BTC address / sender mismatch | Re-run `ocl wallet addresses`; use the current account's Bitcoin address |
| Address, amount, outpoint or BRC-20 ticker error | Complete mainnet recipient, positive `--readable-amount`, current `<txHash>:<voutIndex>` from a UTXO query; ticker as `btc-brc20-<ticker>`, never another chain's contract address |
| `44001` / `INSUFFICIENT_UTXO` | Offer `ocl wallet utxo available --chain bitcoin` to show currently available UTXOs and BTC |
| `STATE_CHANGED` | Rerun the relevant read or management preview; for an inscription, start a new inscription preview if the user still wants the write |
| `PREVIEW_INTENT_MISMATCH` / `INCOMPLETE_TRANSACTION_PREVIEW` | Stop and report the error (transfers and inscriptions) |
| `MEMPOOL_REMOVED` | Run `ocl wallet utxo unavailable --chain bitcoin`; reclaim only after explicit confirmation; a new transfer is required |
| `82001` / `UTXO_PERMISSION_DENIED` | Refresh account facts before a new request |
| `82002` / `UTXO_NOT_FOUND`, `82005` / `UTXO_ALREADY_SPENT` | Refresh unavailable UTXOs |
| `82003` / `INVALID_UTXO_REQUEST` | Stop and show the service message |
| `UTXO_MANAGE_REJECTED` / `UTXO_MANAGE_PARTIAL_FAILURE` | Report the returned batch results; the returned UTXO state is authoritative |
| BRC-20 transfer selection error | Repeat `--brc20-outpoint <txHash:voutIndex>` for every item in one current CLI-returned combination |
| Selected UTXO no longer transferable | Show the refreshed amount-aware plan; get a fresh selection before `unsignedInfo` |
| Transfer-inscription amount error | Positive exact decimal string in `--readable-amount`; the CLI converts it with the token metadata decimal before `unsignedInfo` |
| BRC-20 recipient / status error | Complete Bitcoin mainnet recipient; one complete transaction hash or order ID |
| `44003` / `NEED_INSCRIBE` | Preserve the service response and end the transfer; offer an inscription only on explicit request, confirmed separately |
| `44002` / `INSUFFICIENT_BTC_FOR_INSCRIPTION` | Relay the service message; use the returned read-only address and BTC-balance next steps; never recast it as a BRC-20 balance error |
| `INSCRIBING` / `WAITING_CONFIRMATION` / `WAITING_INDEXER` | Show returned `orderId`, `txHash` and the complete `nextSteps.checkInscriptionStatus`; run it once only when the user asks |
| `READY_TO_TRANSFER` | Show returned `nextSteps.queryBrc20TransferableUtxos`; a transfer needs a separate fresh request and confirmation |

## Templates

```text
[Custom Fee Rate]
The custom fee rate applies only to this transaction and does not change the default fee rate for future transactions.

[Bound BRC-20 Asset]
This UTXO carries: ${readableAmount} ${symbol} (${protocol}).
Spending this UTXO can permanently lose these assets.

[BRC-20 Balance]  (count = 0 → second line: Currently transferable (already inscribed): 0 ${ticker}, worth approximately $${transferableUsd}, with no transferable inscriptions)
Total balance: ${totalAmount} ${ticker}, worth approximately $${totalUsd}
Currently transferable (already inscribed): ${transferableAmount} ${ticker}, worth approximately $${transferableUsd}, across ${count} transferable inscriptions with denominations ${denominations}
Remaining available to inscribe: ${remainingInscribableAmount} ${ticker}, worth approximately $${remainingInscribableUsd}

[BRC-20 Transfer Confirmation]
Confirm broadcasting and creating this inscription at the current fee rate? To change it, reply with a new sat/vB value.

[Inscription Submission]  (returned values plus the fee from the confirmed preview; omit unavailable lines)
The inscription transaction was submitted but is not fully confirmed:

- Asset: ${readableAmount} ${ticker}
- Current status: ${state}
- Bitcoin confirmations: ${confirmations}
- Reveal order ID: ${orderId}
- Reveal txHash: ${txHash}
- Current inscription fee: ${inscriptionFeeSats} sats
- Transferability: ${transferability}

You can reply "Check the result", and I will run this complete command for you:

${nextSteps.checkInscriptionStatus}
```
