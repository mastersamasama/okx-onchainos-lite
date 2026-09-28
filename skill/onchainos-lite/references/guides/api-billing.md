# Market API billing notifications

Read this only when a response from a market, token, signal or memepump (trenches) command carries a non-empty `notifications[]`. Some Market API endpoints are charged per call (x402) once the monthly free quota is used up. After login the CLI signs these payments itself and reports billing events in `notifications[]`. Handle them before formatting any result.

## Handling

1. `notifications[]` absent or empty: proceed normally.
2. For each entry, take the copy for its `code` (below) and fill the placeholders. Render every entry. Each OVER_QUOTA entry carries its own `data.tier`.
3. Envelope has `confirming: true`: follow the blocking procedure. `message`/`next` are empty, so this is not the `--force` path.
4. Otherwise (`{ok, data, notifications:[{code, data}]}`): print the filled copy once, then render `data` as usual.

## Blocking procedure (OVER_QUOTA)

The shape is `{confirming: true, notifications: [{code: "MARKET_API_*_OVER_QUOTA", data: {tier, payment: [{amount, asset, name, symbol, network, chainId, payTo, isDefault}]}}]}`. The request was paused, so there is no result data.

Entries are display-ready. `amount` is a decimal string in UI units; show it as is. `network` is the chain display name (the raw CAIP-2 string when the chain cache missed). `chainId` is the numeric EVM chain id for `--chain`, and `asset` goes to `--asset`. `name` is the full name (`Global Dollar`) and `symbol` the ticker (`USDG`); older servers put the ticker in `name` and leave `symbol` as `""`. `isDefault` marks the entry matching the saved default (asset, network), at most one, and is false on all entries when no default is saved.

**Label**: `<symbol> (<name>)` when both are present and differ, else `<name>`.

- **Never auto-retry.** The user confirms every first-time tier charge, even with a saved default, so they can switch asset or cancel.
- **2 or more entries**: `{paymentOptions}` is a numbered list from `1`, one line per entry `<idx>. <label>  <amount>  <network>`, with `  (default)` appended to the `isDefault` line. Examples: `1. USDG (Global Dollar)  0.0005  X Layer`, `2. USDT (Tether USD)  0.0005  X Layer  (default)`, legacy `1. USDG  0.0005  X Layer`. Never put the `0.` line inside it, because the copy appends it. Wait for the pick.
- **Exactly 1 entry**: skip the list. Name that asset, amount and network, and ask the user to confirm (`yes`/`proceed`/`confirm`) or cancel (`0`/`no`).
- **Pick (number or asset name) or confirm**: run `ocl payment default set --asset <entry.asset> --chain <entry.chainId> --name <entry.symbol, else entry.name> --tier <data.tier>`. Then rerun the original command verbatim; the CLI matches the saved default against the 402 accepts and signs automatically. Re-saving an unchanged default is idempotent. `--tier` is what moves the tier from `charging_unconfirmed` to `charging_confirmed`, so it is mandatory on every OVER_QUOTA action. Only the named tier is promoted. Syntax: [payment commands](../commands/payment.md).
- **`0` or any refusal**: do not run `payment default set` and do not rerun. Stop and acknowledge. The next request prompts again.

## Deduplication

- Never track "already shown" state yourself. The CLI keeps per-code `*_shown` flags in `payment_cache.json` in its state dir (path from `ocl doctor`); trust them.
- One-shot codes (INTRO, GRACE, POST_GRACE_INTRO) fire at most once per account lifetime. `ocl wallet logout` clears the cache, so they fire again after the next login.
- OVER_QUOTA codes fire on each per-tier charging 0→1 flip. When a tier's flag drops back to 0 (server-side quota reset), its shown flag resets too. Basic and Premium each need their own acknowledgement, even when the same default applies to both.
- The saved default persists until `ocl payment default unset` or a new pick on a later OVER_QUOTA event.

## Codes and copy

**`MARKET_API_NEW_USER_INTRO`**: new user (UserType=1), first call, Basic=0 Premium=0. Fires once per account. Non-blocking.
```
Welcome to Market API. Your monthly free quota has been allocated:
- Basic endpoints: {basicFreeQuota}
- Premium endpoints: {premiumFreeQuota}

Once exceeded, per-call pricing applies (Basic {basicUnitPrice}/call, Premium {premiumUnitPrice}/call). After you log in, the CLI will sign automatically when charging kicks in — no manual steps required. We recommend keeping a balance of a supported payment asset on X Layer ahead of time — you'll be asked to pick one when the CLI first charges, so service stays uninterrupted.

Full rules → [Pricing documentation]({docUrl})
```
**`MARKET_API_OLD_USER_GRACE`**: old user (UserType=0), first call within the grace period. Fires once per account. Non-blocking.
```
Market API pricing is now in effect. As an existing user, you have a {graceDays}-day free grace period during which all calls remain free. The grace period ends on {graceExpiresAt}, after which regular billing begins. Once billing is active: Basic endpoints {basicFreeQuota} free / Premium endpoints {premiumFreeQuota} free, with overage priced at Basic {basicUnitPrice}/call and Premium {premiumUnitPrice}/call.

Full rules → [Pricing documentation]({docUrl})
```
**`MARKET_API_OLD_USER_POST_GRACE_INTRO`**: old user, first call after grace ends (now ≥ graceExpiresAt, Basic=0 Premium=0). Fires once per account. Non-blocking.
```
Your {graceDays}-day free grace period has ended, and Market API has entered the regular billing phase. Your monthly free quota has been reallocated:
- Basic endpoints: {basicFreeQuota}
- Premium endpoints: {premiumFreeQuota}

Once exceeded, per-call pricing applies (Basic {basicUnitPrice}/call, Premium {premiumUnitPrice}/call). After you log in, the CLI will sign automatically when charging kicks in. We recommend keeping a balance of a supported payment asset on X Layer — you'll be asked to pick one when the CLI first charges, so service stays uninterrupted.

Full rules → [Pricing documentation]({docUrl})
```
**`MARKET_API_NEW_USER_OVER_QUOTA`**: new user, a tier's charging flag flips 0→1. **`MARKET_API_OLD_USER_POST_GRACE_OVER_QUOTA`**: old user after grace, same flip. Both fire on each flip, per tier, and are **blocking**. For the post-grace code, the first line becomes `Your {tier} free quota for this month has been used up (the first overage after the grace period), and this request has been paused.`
```
Your {tier} free quota has been used up, and this request has been paused.

Per-call pricing ({tier} {unitPrice}/call) is now in effect. Please pick which asset you'd like to pay with — the CLI will save it as your default and auto-sign future payments:

{paymentOptions}
0. Cancel — don't pay, abort this request

Reply with the number (or asset name) to continue, or `0` to cancel. We recommend keeping enough of your chosen asset in the matching chain wallet to avoid transaction failures.
```

## Placeholders

| Placeholder | Value |
|---|---|
| `{basicFreeQuota}` / `{premiumFreeQuota}` | `1M/month` / `100K/month`. The payload carries raw counts (`1000000` / `100000`). |
| `{basicUnitPrice}` / `{premiumUnitPrice}` | `0.0001 $` / `0.005 $` |
| `{graceDays}` | `data.graceDays`, else `30` |
| `{graceExpiresAt}` | `data.graceExpiresAt` only, rendered as a human date. Never supply a date yourself. |
| `{docUrl}` | `data.docUrl`, kept as the copy's pricing link. Drop the "Full rules" line when it is absent. |
| `{tier}` / `{unitPrice}` | `data.tier` shown capitalized (`Basic`/`Premium`) / that tier's unit price |

## Payment failures

A charge that still fails after signing returns `ok:false` with an error ending in `HTTP 402 Payment Required: <reason>`. Tell the user the outcome in plain language, not the reason string. Retry only when the user asks, never in a loop.

| Reason | Tell the user | Next |
|---|---|---|
| `insufficient_balance` | Not enough of the payment asset in the wallet on that network. The request was not paid. | Funding flow in the [wallet guide](wallet.md), then rerun on request |
| `payer_blocked`, `risk_address` | Risk controls refused payments from this wallet | Stop; do not retry |
| `expired`, `not_yet_valid`, `nonce_used` | The payment authorization was out of its validity window or already used | Rerun once if the user wants (the CLI signs a new one); stop if it repeats |
| `invalid payment header` | The payment signature was rejected | Rerun once; if it persists, the service is temporarily unavailable |
| `onchain_error` | The payment could not be settled on-chain | Suggest trying again later |
| `payment processing` | A payment is still settling | Wait a few seconds, then rerun once if the user wants |
| anything else | Payment for this data failed | Stop; offer to try again later |
