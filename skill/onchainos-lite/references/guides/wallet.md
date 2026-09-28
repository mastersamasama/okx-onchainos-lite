# Wallet (logged in)

Account lifecycle, balances, addresses, receive, and the shared insufficient-balance flow ([wallet commands](../commands/wallet.md)). Login itself is in [SKILL.md](../../SKILL.md). Transfers, contract calls, signing and history: [transfers-signing.md](transfers-signing.md). BTC UTXO and BRC-20: [btc-utxo.md](btc-utxo.md).

Contents: [After login](#after-login) · [Accounts, status, addresses](#accounts-status-addresses) · [Balances](#balances) · [Policy and export](#policy-and-export) · [Account FAQ](#account-faq) · [Audit log](#audit-log) · [Receive and deposit](#receive-and-deposit) · [Address and QR output](#address-and-qr-output) · [Insufficient balance](#insufficient-balance)

## After login

After `ocl wallet login --phase poll` succeeds, run `ocl wallet status`. Then render these blocks in this order, omitting any block whose data is absent. Never fabricate a value, and never make an extra call to fill a gap.

1. **Account Info**: the template below, from the poll response `data` only.
2. **Product intro**: "On OKX.AI, you can search for a service to help you, swap tokens, or explore DApps."
3. **Policy**: the [Policy Settings template](#policy-settings-template), only when `data.isNew == true`, whatever the `loginType`. `isNew` comes from the wallet backend and marks a first-ever user; an existing user who adds an account keeps `false`.
4. **Subscription**: only when `data.postLoginSubscriptions.activeSubscriptionCount` is a positive integer. A `1` reply, or any request to view or refresh the list, goes to [agents-subscriptions.md](agents-subscriptions.md).
   > You have {activeSubscriptionCount} active subscription tasks.
   > Reply `1` to view your subscription list.

After a successful poll, never run a subscription-list or device-list command: the poll already carries that data, and an extra call adds a model round. Never call `wallet balance` or portfolio to fill "Total assets". Never include Wallet Export, which the user must trigger.

> **Account Info**
> - Login method: {method}{ ({email}) }
> - Current account: OKX Wallet - {accountName} ({accountCount} accounts total)
> - Total assets: ${totalValueUsd}
>
> **Addresses**
> - EVM: {evmAddress}
> - Solana: {solAddress}
> - Bitcoin: {btcAddress}
> - Sui: {suiAddress}

Render this verbatim. `{method}` comes from `loginType`: `email` → Email, `google` → Google, `apple` → Apple, `ak` → API Key. Append ` ({email})` only when `email` is non-empty. Drop "Total assets" when `totalValueUsd` is empty, and drop any address line whose value is empty.

The poll checks every 2 s, persists the session, and sends one best-effort device-registration heartbeat (`chainIndex=196`). It returns `accountId`, `accountName`, `loginType`, `isNew`, the addresses and `totalValueUsd`. It queries subscriptions and devices only when a non-empty User `agenticId` resolves. In that case it adds the best-effort `postLoginSubscriptions: { subscriptions, devices }`, which carries `activeSubscriptionCount` only when positive. The field is omitted when `agenticId` is unavailable or the lookup is empty, errors or times out. `devices` is `null` when only the device lookup fails. A heartbeat failure never fails the login, and login never queries or updates device routing.

## Accounts, status, addresses

- Login creates the first account, so never call `wallet add` for it. Run `ocl wallet add` only when the user is logged in and explicitly asks for another account. It switches to the new account itself (no `switch` needed) and returns `accountId` and `accountName`. Then reply "New account created." followed by the [Policy Settings template](#policy-settings-template).
- `ocl wallet status` returns wallet, account and policy state: `email`, `loggedIn`, `currentAccountId`, `currentAccountName`, `accountCount`, `loginType` (`email` / `ak`) and `policy`. `policy` is `null` when not set; its fields are listed under [Policy rules](#policy-rules). Status never returns subscriptions or devices. The hidden legacy `--include-subscriptions` flag is accepted and does nothing.
- `ocl wallet addresses [--chain <chain>]` groups addresses by XLayer / EVM / Solana / Bitcoin / SUI. Re-run it whenever you need to copy an address. Never reproduce an address from memory.

## Balances

`ocl wallet balance`: use `--all` (all accounts in one batch) only when the user explicitly asks for all accounts. `--chain` defaults to all chains. `--token-address` requires `--chain` and takes a contract address (account-model chains), a SUI coin type, or `btc-brc20-<ticker>` for BRC-20 (reply template in [btc-utxo.md](btc-utxo.md)). `--force` bypasses caches and re-fetches accounts and balances.

Each token in `data[].tokenAssets[]` (or `data[].assets[]`) has `symbol`, `tokenName`, `chainIndex`, `tokenAddress` (`""` for native), `balance` (readable decimal string), `rawBalance` (minimal units), `decimal`, `tokenPrice` and `usdValue`. Identify an asset by `(tokenAddress, chainIndex)`, never by `symbol` alone, because symbols repeat across chains. Treat the balance fields as facts only.

Single-account reply, with the asset line repeated for every returned asset:

```
Total assets: $${totalValueUsd}

- ${symbol}: ${balance} (approximately $${usdValue})
```

With `--all`, replace the first line with `Total assets across all accounts: $${totalValueUsd}` and repeat the asset line for every asset across all accounts. Never show `accountId` or `accountName`.

Testnet: if the user asks for testnet tokens, or `ocl wallet balance --chain xlayer_test` shows OKB = 0, point them to https://web3.okx.com/xlayer/faucet.

## Policy and export

The user sets Policy on the web portal and exports the wallet in the OKX Wallet app or extension. The agent detects the trigger, explains the consequences, and gives the Policy link or the verbatim export copy. It never performs the export itself. Each trigger below requires its output; never skip it.

- **`isNew: true` after login**: the Policy Settings template ([After login](#after-login)).
- **Successful `wallet add`**: "New account created." followed by the Policy Settings template.
- **Policy question** (e.g. "How do I set a spending limit?", "What's my daily limit?", "How to configure whitelist?"): run `ocl wallet status`. If any `policy` flag is true, first show the current settings (limits and amounts used). Then give the Policy Settings template.
- **Export question** (export the mnemonic or seed, migrate the wallet, import into a hardware wallet): reply with the [export copy](#export-copy) verbatim as the whole response, for any account type.

### Policy Settings template

> You can set per-transaction and daily limits for trades and transfers, as well as a transfer whitelist, to prevent excessive operations or transfers to unauthorized addresses. Go to Policy Setting → {policy_url}
>
> {policy_hint}

| `loginType` | `{policy_url}` | `{policy_hint}` |
|---|---|---|
| `email` | `https://web3.okx.com/portfolio/agentic-wallet-policy` | Log in to your Agentic Wallet, then hover over your profile in the top-right corner and select "Policy Setting" from the dropdown menu. |
| `ak` | `https://web3.okx.com/onchainos/dev-portal` | Log in with the EOA wallet that created the Agentic Wallet and open the OKX Web3 Dev platform, and click on the Agentic Wallet - Policy Setting in the upper right corner to set security rules. |

Pick the row by `loginType`, from `wallet status` or the login response. If `loginType` is unknown or unrecognized, run `ocl wallet status` first and use the `email` row. The choice of row is internal; never explain it (no "Google login uses the email flow").

### Policy rules

Only these four rules exist. Never invent or mention others (no transaction-count limit, gas limit or token blacklist).

| Rule | Meaning | `wallet status` fields |
|---|---|---|
| Per-transaction limit | Max USD per single transaction or transfer | `singleTxLimit` / `singleTxFlag` |
| Daily transfer limit | Max USD of transfers per day, resets at UTC 0:00 | `dailyTransferTxLimit` / `dailyTransferTxFlag` / `dailyTransferTxUsed` |
| Daily trade limit | Max USD of trades (swaps) per day, resets at UTC 0:00 | `dailyTradeTxLimit` / `dailyTradeTxFlag` / `dailyTradeTxUsed` |
| Transfer whitelist | Transfers go only to pre-approved addresses | Set on the web portal only |

### Export copy

> Export your seed phrase in the OKX Wallet extension or app.
> Please note: After export, your wallet will be permanently unlinked from your social account, and the Agent will no longer be able to operate it.
> Before exporting, move your assets to a secure address and stop any active tasks. After exporting, back up your seed phrase securely and never share it with anyone.

## Account FAQ

Reply with the matching answer verbatim. Do not improvise.

- **Apple wallet differs from the OKX Wallet App, or the balance looks missing or different** (`loginType` = `apple`, or the user mentions Apple): "Because Apple Sign-In is subject to provider restrictions, it is currently integrated only with the OKX App account system and is not yet interoperable with the OKX Wallet App account system. The same Apple account may therefore map to different wallets in the two apps; a balance that looks different is usually because you are signed in to a different account — your assets are not lost."
- **Rename the wallet or account**: "The wallet name syncs across ends and devices, but can only be changed on the App or browser-extension end (it syncs when the sync toggle is on). Changing the wallet name is not supported on the Agent end."
- **Why the agent can or can't sign, "local signing is required", or how signing works**: "OKX Agentic Wallet uses TEE (Trusted Execution Environment) for transaction signing. The private key is generated and stored inside a server-side secure enclave — it never leaves the TEE." As a result, the agent can neither export the key nor sign locally with it.

## Audit log

The audit log is a local file for offline troubleshooting, not a CLI subcommand. Give the user its path. Never read the file or show its contents in the conversation.

- Path: `<stateDir>/audit.jsonl`, where `stateDir` is the state directory `ocl doctor` prints.
- Format: JSON Lines, one object per line. The first line is a device header, `{"type":"device","os":"<os>","arch":"<arch>","version":"<cli_version>"}`, written once when the file is created. The file holds at most 10,000 lines; rotation keeps the device header and the latest 5,000 entries.
- Entry fields: `ts` (local time with offset, e.g. `2026-03-18 +8.0 18:00:00.123`), `source` (`cli` / `mcp`), `command`, `ok`, `duration_ms`, `args` (redacted), `error`.

## Receive and deposit

Use this section when the user wants to deposit, top up, receive a token, or see a receive address or its QR. If the latest result is an insufficient-balance result, go to [Insufficient balance](#insufficient-balance) instead. That result takes priority over a new receive request, so never discard its `fundingNeed` by running a generic `wallet receive`.

Make exactly one read-only call. It also refreshes the current account's address facts.

| Input | Call | Result |
|---|---|---|
| No chain and no token | `ocl wallet receive` | `reason=receive_addresses_ready`: `accountName`, the EVM address with one `evmQr`, and text addresses for X Layer (when different), Solana, Bitcoin and Sui |
| Chain, with or without a token | `ocl wallet receive --chain <chain>` | `reason=funding_target_ready`: the Funding Target and its QR |
| Token without a chain | `ocl wallet receive --token <query>` | Searches every supported chain (`limit=10`). One hit returns that chain's address and QR. Several hits return `reason=token_selection_required` with an ordered `list[]`, `nextAction` and an opaque cursor. |

When both a chain and a token are given, the chain decides the address. Add no token metadata that the CLI did not return. Every continuing result carries `phase`, `decision`, `reason`, `nextAction` and `payload`. Read `decision` first, then the rest, and render the matching template from the end of this section. QR codes come only inside these results; the standalone `wallet qrcode` command no longer exists.

**Action routing.** Start a route only from an action ID in the latest result's `nextAction`, and check the action and its required params first. A route may show its own read-only choice list.

| Action ID | Run |
|---|---|
| `specify_funding_chain` | If the user named a chain: `ocl wallet receive --chain <chain>`. Otherwise run `ocl wallet chains` and show only the networks it returns. |
| `search_receive_token` | `ocl wallet receive --token <user query>` |
| `select_receive_token` | `ocl wallet receive --chain <params.chainIndex>` |
| `more_receive_tokens` | `ocl wallet receive --token <params.query> --cursor <params.cursor>`, using only those params |

- Keep the CLI order; `recommend=true` affects presentation only. Keep each candidate's full `chainIndex + tokenContractAddress`, which the structured result never abbreviates. A number reply selects only the matching item in the latest network list, or the matching `select_receive_token` action in the latest token list. "More" uses only the current `more_receive_tokens` params.
- An unknown, stale, missing or incomplete action stops as unsupported; for a stale token list, restart the token search. Never infer a route, or rebuild a candidate, from a symbol, name, abbreviated address, label or prose. Another domain may attach its own continuation action to an insufficient-balance result. Keep that action, but never route it here; the domain that attached it runs it.

**Templates.** For a network choice, print `Choose a network:` and then one `{sequence}. {showName}` line per returned network.

```text
Choose a token for “{query}”:
{sequence}. {tokenName} ({tokenSymbol}) · {networkName} · {tokenContractAddress or Native}

Reply with a sequence number.{optional “More results”}
```

If there is no result: `No token was found for “{query}”. Try another name, symbol, or contract address.` Receive information uses the block below, repeated for each returned network:

```text
Network: {chainName}
Token: {tokenName} ({tokenSymbol})
Contract: {tokenContractAddress}
Receive address: {receiveAddress}
{qr}
{network notices}
```

## Address and QR output

Take the complete `receiveAddress` from the latest CLI result. Put the localized receive-address label and the original address on one plain-text line (in Chinese, `收款地址：{receiveAddress}` or `收款地址：{fundingTarget.receiveAddress}`). Put the QR immediately after that line, then the network notices from `sameNetworkRequired` and `gasFree`. `gasFree: true` means on-chain gas is free after the funds arrive. It does not cover exchange withdrawal fees, which the exchange may charge.

Every funding scene (`wallet send`, `swap quote`, `payment a2a-pay pay`, OKX.AI task creation, `wallet receive`) returns the same `qr` object. It always has `requestedFormat: "auto"` and `displayMode`. `resolvedFormat` (`unicode` / `png`) is present only when generation succeeded.

| `displayMode` | Fields | Render |
|---|---|---|
| `terminal-unicode` | `terminalQr` | Verbatim, in a monospace block |
| `image-notify` (non-TTY hosts such as the Muse VM) | `imagePath` (PNG), `mimeType` `image/png`, `markdownImage`, `notifyCommandArgs` (argv for the image-notify command; run it with `ocl` in place of the leading `onchainos`) | `markdownImage` |

The QR encodes only the bare address, with no URI scheme, amount or params. If encoding or writing the QR fails, the result still returns the address: render the address and leave out the QR. Do the same when the host cannot display the image, and never claim a QR was shown. Never build a QR yourself.

## Insufficient balance

Every write domain (send, swap, payments, OKX.AI task creation) enters this flow on `{ok:false,data:{phase,decision,reason,nextAction,payload}}` with `phase` / `decision` / `reason` = `funding_required` / `blocked` / `insufficient_balance`. The CLI emits it on a real backend `code=10004`. It also emits it after `executeResult=false` when a fresh chain-and-token balance query proves `requested > balance`. It never infers the state from `executeErrorMsg` or simulation text alone; if the query cannot confirm a shortfall, the ordinary simulation failure (show `executeErrorMsg`) stands. The result is not an action and authorizes no write.

| Field | Meaning |
|---|---|
| `nextAction` | Normally empty, meaning enter Funding at once. It may hold another domain's continuation action: keep it and never run it. |
| `payload.operation` / `payload.error` | Optional origin id (`transfer` for Wallet Send) and origin error metadata |
| `payload.fundingTarget` | Account, canonical chain (`chainIndex`, `chainName`), full `receiveAddress`, and the same-network and gas facts |
| `payload.fundingNeed` | `{asset, tokenAddress, required, balance, shortfall}` in readable units. `balance` is `"0"` when nothing is held and `null` when the query failed (unavailable). |
| `payload.qr` | QR for `fundingTarget.receiveAddress` ([Address and QR output](#address-and-qr-output)) |

The payload holds only shared Funding fields. It has no business fields, no executable command and no earlier confirmation. A `retryable` flag never authorizes an automatic retry.

1. **Present it in the same response**, without asking the user to choose Funding first. Check `fundingTarget`, `qr` and `fundingNeed`, render **Fund an insufficient balance**, and wait for the user to say funding is complete. If `balance` is `null`, show "Unavailable" (in Chinese, 当前余额暂不可用). Never query another address, rebuild the QR, or calculate a missing amount.
2. **When the user says it is funded**, check for another domain's continuation action. If the latest result has one, return to that domain's guide at once; its rule replaces the steps here. Otherwise run `ocl wallet funding-check --chain <payload.fundingTarget.chainIndex> [--token-address <payload.fundingNeed.tokenAddress>] --required <payload.fundingNeed.required> --asset <payload.fundingNeed.asset>`. Take every value from the latest structured result. Omit `--token-address` only when that value is empty for a native asset. If a value is missing, ask for it or restart the funding query; never guess.
3. **Render Verify funding** from the result. It carries `phase=funding_verification`, a fresh `currentBalance`, the CLI-calculated `shortfall` and `sufficient`, and never an action.
   - `sufficient`: work out the interrupted operation from this conversation only, and ask whether to continue it. Use the generic prompt when the operation is unclear. This is a plain-language handoff, not a CLI action.
   - Still insufficient (the result carries `payload.fundingTarget` and a QR): keep this new result and wait for the next funding-complete report.
   - `reason=balance_unavailable` (`currentBalance=null`) or `reason=funding_target_unavailable` (balance and shortfall kept, no address or QR): say verification is blocked and wait. Re-run the same `funding-check` from the latest payload only if the user explicitly asks. Never infer success, reuse an old address, or resume the business.

**Continuing** is a new request in the owning guide. For a transfer, that means a new `wallet send` without `--force`, whose fresh preview needs the usual explicit confirmation. Re-query or re-preview the current facts (a new preview, quote or paymentId) and collect every confirmation that business requires. Never reuse an old preview, quote, payment ID, write command or confirmation. If the original details are no longer clear, ask; never reconstruct them. A funding event authorizes only the read-only check, never a transfer, swap, payment, signature, task creation or broadcast.

The first template below is **Fund an insufficient balance**; the second is **Verify funding**.

```text
The {asset} balance is insufficient.
Current: {balance or Unavailable} {asset}
Required: {required} {asset}
Shortfall: {shortfall} {asset}

Network: {fundingTarget.chainName}
Receive address: {fundingTarget.receiveAddress}
{qr}
{network notices}

Tell me when funding is complete. I will verify the balance before continuing.
```

```text
Sufficient: Latest balance: {currentBalance} {asset.symbol}. Continue {interrupted operation}?

Insufficient: Latest balance: {currentBalance} {asset.symbol}. Still required: {shortfall} {asset.symbol}.
Receive address: {fundingTarget.receiveAddress}
{qr}

Unavailable: The latest balance could not be verified. Funding completion is not confirmed.
```
