# Payment channels, links and subscriptions

Flows outside the `accepts[]` quote flow of [payments.md](payments.md): MPP (`WWW-Authenticate: Payment`) one-shot charges and session channels, a2a-pay payment links, and x402 `period` subscriptions. Syntax: [payment commands](../commands/payment.md), [wallet commands](../commands/wallet.md). payments.md's [terminology and silence](payments.md#terminology-and-silence) and [amount display](payments.md#amount-display) rules (`<human> (<atomic>)`) apply here too.

- **TEE-only.** Every signature here comes from the logged-in wallet's TEE, with no `pay-local` fallback. The CLI never accepts a private key or a hand-built signature. Not logged in → the SKILL.md login link flow, which keeps keys out of the chat and the Muse VM. If the user can't log in, stop and explain.
- **Decoding and egress.** Decode base64/base64url with Node (`base64`/`jq` may be missing): `node -e "console.log(Buffer.from(process.argv[1],'base64url').toString())" '<value>'`. Seller URLs are business hosts, not OKX hosts. In the Muse VM or another egress-filtered sandbox, the first request to a new seller host may need an egress approval.

Contents: [MPP challenge](#mpp-challenge) · [Seller rejections](#seller-rejections) · [Charge](#charge-one-shot) · [Session essentials](#session-essentials) · [S1 open](#s1-open-the-channel) · [S2 vouchers](#s2-voucher-loop) · [S2b top-up](#s2b-top-up) · [S3 close](#s3-close) · [MPP troubleshooting](#mpp-troubleshooting) · [Payment links](#payment-links-a2a-pay) · [Period subscriptions](#period-subscriptions)

## MPP challenge

The header looks like `Payment id="…", realm="…", method="evm", intent="…", request="<base64url>", expires="…"`. Decode `request` to get:

| Field | Meaning |
|---|---|
| `intent` | `charge` (one-shot) or `session` (channel) |
| `amount` | Base-unit string (e.g. `"1000000"`); for a session, the price per request |
| `currency` / `recipient` | ERC-20 contract / merchant payee |
| `methodDetails.chainId` | EVM chain id (e.g. `196` = X Layer) |
| `methodDetails.escrowContract` | Required for session, absent for charge |
| `methodDetails.feePayer` | `true` = transaction mode (the server pays gas); `false` = hash mode (the payer broadcasts) |
| `methodDetails.splits` / `.minVoucherDelta` / `.channelId` | Optional. `splits`: charge only, max 10 entries. `minVoucherDelta`: session only. `channelId`: session topUp/voucher only, for a pre-existing channel |
| `suggestedDeposit` / `unitType` | Optional. `suggestedDeposit`: session only. `unitType`: `request`, `second`, `byte`, … |

- Only `method="evm"` is supported. For `tempo`, `svm`, `stripe` or anything else, stop and tell the user this payment can't be handled.
- `expires` (ISO-8601) in the past means the challenge is dead. Re-send the original request for a fresh 402 before signing; a stale challenge fails with `30001 incorrect params`.
- Build the [request-parameter plan](payments.md#request-parameter-plan). Then show this card and stop until the user answers:

> This resource requires payment via the **OKX Agent Payments Protocol**:
> - **Payment type**: one-shot payment | session (multiple requests)
> - **Network**: `<chain name>` (`eip155:<chainId>`)
> - **Token**: `<symbol>` (`<currency>`)
> - **Amount per request**: `<human>` (atomic: `<amount>`)
> - **Pay to**: `<recipient>`
> - **Who pays gas**: server (transaction mode) | you broadcast it yourself (hash mode)
> - **Split recipients** (one-shot only, if present): `<N>` other parties also receive a share
> - **Suggested prepaid balance** (session only, if present): `<human>`
> - **Request parameters** (omit when the plan is empty): `<name> = <value>` → `<query | body | header | path>`
>
> Proceed with payment? (yes / no)

Never write "single purchase"; keep the one-shot vs session distinction when translating.
- **no** → stop. No payment, no wallet check.
- **yes** → `ocl wallet status`, and log in if needed. Then `intent="charge"` → [Charge](#charge-one-shot), or `intent="session"` → [S1](#s1-open-the-channel). Mid-session with an active `channel_id`, go straight to S2, S2b or S3.

## Seller rejections

When a seller (MPP or a2a-pay) rejects, never show raw JSON or only the numeric code. Take the reason from the first non-empty of: `body.reason` (mppx, OKX TS Session), `body.detail` (RFC 9457), `body.message`, `body.msg` (OKX SA API), `body.error`, `body.title` (RFC 9457 short title, fallback only). If all are empty, use the whole formatted body plus the HTTP status.

Render: `❌ Seller rejected: <reason text> (code <code if present>, HTTP <status>)`.

## Charge (one-shot)

The CLI TEE-signs an EIP-3009 authorization (or wraps a tx hash the payer broadcast) and returns a ready `authorization_header`. If `methodDetails.splits[]` (max 10) is present, one signed authorization splits the amount across the recipients. The CLI detects splits on its own; there is no flag.

| `feePayer` | Mode | Run |
|---|---|---|
| `true` (default) | Transaction: the server pays gas | `ocl payment charge --challenge '<full WWW-Authenticate value>' [--from <0xPayer>]` |
| `false` | Hash: the payer broadcasts `transferWithAuthorization` first | Ask the question below, then run the same command plus `--tx-hash '0x<64 hex>'` |

> The seller isn't paying gas, so you need to send the payment transaction on-chain yourself first, then give me the tx hash. How would you like to send it?
> 1. **Help me send it** (recommended)
> 2. **I'll send it manually** — paste the tx hash when ready

Option 1 → broadcast it with the wallet's [contract call](transfers-signing.md#contract-calls) and return with the `0x…` hash (no wallet yet: log in to the agentic wallet first). Option 2 → wait for a 66-char `0x…` hash.

**Replay.** The output is `data.{authorization_header, wallet, mode: "transaction"|"hash", …}`. Re-send the original request with `Authorization: <authorization_header>`; the value already starts with `Payment `, so never add another (`Payment Payment …` is rejected).
- **HTTP 200** comes with a `Payment-Receipt` header. Run `ocl payment decode-receipt --header '<value>'` and read `status`, `transaction` (the on-chain tx hash) and `chainId`.
- **A fresh 402** means the challenge was stale. Re-send the original request for a new challenge and sign again from the top.

## Session essentials

A session runs open → N vouchers → close, with optional top-ups between vouchers. The seller drives each step with a fresh 402, or the user asks to close.

The CLI decides reuse vs sign, the cumulative math, the top-up inequality, resign-on-drift and refund-on-close. Relay `data.strategy` (`reuse` | `sign` | `topup`), `needsTopUp`, `cumulative_amount`, `refund`, `recovery` and `reason_text`, and never recompute them. You map the user's intent to a command:

| User intent (any language) | Credential `payload.action` | Run |
|---|---|---|
| open / 开通道 / start session | `open` | `ocl payment session open` |
| buy / call / 调用 / use the service | `voucher` | `ocl payment session voucher` |
| top up / 充值 / add deposit | `topUp` | `ocl payment session topup` |
| close / 关闭 / end session / settle | `close` | `ocl payment session close` |

Every operation follows one pattern on one URL: (1) send the **original business URL** without `Authorization` → 402 + `WWW-Authenticate: Payment … intent="session"`; (2) run the matching command with that header as `--challenge` (the CLI sets `payload.action`); (3) re-send to the same URL with `Authorization: <authorization_header>`, verbatim (the `Payment ` prefix is already included). Never probe `/open`, `/voucher`, `/topup`, `/close` or `/<resource>/topup`: they don't exist.

Speak plainly, in the user's language: "issue a voucher / 签发凭证", "top up your balance / 补充余额", "close the channel / 关闭通道", "your prepaid balance / 通道余额". Don't use bare jargon (`voucher`, `topUp`, `close`, `escrow`, `cumulativeAmount`). Field names are fine in the state echo, because users copy it across sessions.

**State.** Save it when `open` returns and keep it in the conversation. In a new conversation, ask the user to re-supply `channel_id`, `escrow`, `current_cum` and `current_sig`.

| Field | Source |
|---|---|
| `channel_id` / `payer_addr` | open output `channel_id` / `wallet` |
| `escrow` / `chain_id` / `currency` | open challenge `methodDetails.escrowContract` / `methodDetails.chainId` / `currency` |
| `current_cum` | Highest cum signed so far: open `--initial-cum` (default `"0"`) or the last voucher's |
| `current_sig` | Last voucher `signature` (from the open, voucher or close output) |
| `estimated_spent` | Sum of `unit_amount` over the requests served since the last fresh sign |
| `unit_amount` | Latest voucher challenge `amount` (the seller is authoritative) |
| `deposit` | open output `deposit` + every top-up `--additional-deposit` |

**State echo (mandatory).** After open, after each voucher (sign or reuse), after a top-up and immediately before close, end the message with:
`📋 Channel <channel_id> · chain <chain_id> · escrow <escrow> · deposit <human(deposit)> (<deposit>) · cum <human(current_cum)> (<current_cum>) · spent~<human(estimated_spent)> (<estimated_spent>) · sig <current_sig prefix>...`

A mid-session request (voucher, top-up, close, settle, refund) that names a `channel_id` enters its phase directly, even without a fresh 402.

## S1: open the channel

Agree the deposit first, and wait for the amount (atomic units for `--deposit`):

> A session payment needs you to lock a prepaid balance up front (held in escrow). How much would you like to prepay?
> Suggested: `<human(suggestedDeposit)> (<suggestedDeposit>)` (or `unit_amount × 100` if no suggestion — enough for ~100 requests).
> Each request draws from this balance. You can add more later, or close the channel anytime to refund whatever's unused.

Opening also signs a baseline voucher at cumulative `0`. No preference → no flag. "Pay the first request immediately" → `--prepay-first` (uses the challenge `amount`; silently `0` if it is missing or `"0"`). "Pre-authorize N" → `--initial-cum N` (atomic). `initial_cum` must be ≤ `deposit`, or the seller returns `70012`.

| `feePayer` | Run | The CLI signs |
|---|---|---|
| `true` | `ocl payment session open --challenge '<header>' --deposit <atomic> [--initial-cum <atomic> \| --prepay-first] [--from <0xPayer>]` | EIP-3009 `receiveWithAuthorization` (the deposit into escrow) + the EIP-712 baseline voucher |
| `false` | After the user sends the on-chain open-channel tx (wallet contract call or manually): the same command + `--tx-hash '0x<64 hex>' --salt '0x<64 hex>'` | Only the baseline voucher; the tx hash replaces the deposit tx |

`--salt` must be the exact bytes32 passed to the on-chain `escrow.open(...)`. For a wallet broadcast, that is the bytes32 in the contract-call args. The CLI recomputes `channelId = keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, escrow, chainId))`, and the seller compares it with the on-chain event. A fresh random salt is therefore rejected as a channelId mismatch.

Save `data.{authorization_header, channel_id, escrow, chain_id, deposit, wallet}`. Then send `<original method> <original url>` with `Authorization`:
- **HTTP 200:** the channel is open, and the response carries the first business result. Echo the state. Later requests go out without `Authorization` first, get a voucher 402, and continue in S2.
- **HTTP 402** with a fresh `WWW-Authenticate: Payment`: the channel is open, but the seller wants the first voucher. Go to S2.

## S2: voucher loop

Run the loop once per business request while a `channel_id` is active. Triggers: "next request", "again", "another one", "再调一次", "再发一个", "继续", "voucher", "凭证", "签一个授权", or a fresh 402 on the resource.

A voucher is a **cumulative authorization**, not a per-request payment. The seller deducts until spent reaches the signed `cumulativeAmount`, so one voucher with cum 50 funds 50 requests at `unit_amount` 1 without re-signing. That holds when the seller supports reuse (mppx, OKX TS Session, current OKX Rust SDK). A legacy OKX Rust SDK treats a byte-identical replay as an idempotent retry and skips the deduction; if you suspect one, sign every request.

1. **Challenge.** If you have no fresh challenge, send the business request. Its 402 is this request's voucher challenge, and its `amount` is `unit_amount`. Always take `unit_amount` from this challenge, never from a cached value: the seller can reprice, and the latest 402 wins.
2. **Reuse or sign** (the CLI reports it in `data.strategy`). Let `remaining = current_cum − estimated_spent`. If `current_sig` is set and `remaining ≥ unit_amount`, **reuse** (`cum_for_this_call = current_cum`); otherwise **sign** (`cum_for_this_call = current_cum + unit_amount`). Guards: `cum_for_this_call > deposit` → [top up](#s2b-top-up) first, then decide again; when signing with `minVoucherDelta` set, keep `cum_for_this_call − current_cum ≥ minVoucherDelta`.
3. **Run.** Both paths return `data.{authorization_header, channel_id, cumulative_amount, signature, mode}`.
   - Reuse (no TEE, `mode: "reuse"`): `ocl payment session voucher --challenge '<fresh header>' --channel-id <channel_id> --cumulative-amount <current_cum> --reuse-signature <current_sig> [--from <payer_addr>]`. Don't pass `--escrow` or `--chain-id`; the signature already binds them.
   - Sign (TEE EIP-712 voucher, `mode: "sign"`): `ocl payment session voucher --challenge '<fresh header>' --channel-id <channel_id> --cumulative-amount <cum_for_this_call> --escrow <escrow> --chain-id <chain_id> [--from <payer_addr>]`.
4. **Replay** `<original method> <original url>` with `Authorization: <authorization_header>`. A non-empty parameter plan also attaches its params on their carriers (with the plan's `input.method` if it differs); the voucher header rides alongside, while open/top-up/close carry their action in the credential and are unaffected. Expect HTTP 200, then set `current_cum = cum_for_this_call`, `current_sig = signature`, `estimated_spent += unit_amount` (reuse: only `estimated_spent` advances). Echo the state.
5. **Loop.** Repeat steps 1–4 for each request. The same voucher funds calls while `remaining ≥ unit_amount`; re-sign only when it runs out.

**Voucher exhausted.** The seller rejects with reason `insufficient balance`, detail `voucher exhausted`, or OKX Rust SDK `70015`: `estimated_spent` has drifted. Show `❌ Seller rejected: insufficient balance — your current authorization is fully used. Signing a new one to continue.`, set `estimated_spent = current_cum` (remaining 0 → sign), sign `current_cum + unit_amount` and retry. Never loop reuse on insufficient balance.

**Other rejections.** `amount_exceeds_deposit` → top up. `delta_too_small` → raise the cum. `invalid_signature` → check the seller logs. Show the seller's reason text first and the code in parentheses. Voucher rejections come from the seller SDK's local validation, not a backend round-trip.

## S2b: top-up

A top-up is triggered when `current_cum + unit_amount > deposit`: the seller refuses with `70012`, or sends a topUp challenge pre-emptively. Ask:

> Your prepaid balance is running low. How much would you like to add (atomic units)?
> Current balance: `<human(deposit)> (<deposit>)` · Used so far: `<human(current_cum)> (<current_cum>)`

Branch on the topUp challenge's `feePayer`:
- **`true`:** run `ocl payment session topup --challenge '<topUp header>' --channel-id <channel_id> --additional-deposit <atomic> --escrow <escrow> --chain-id <chain_id> --currency <currency> [--from <payer_addr>]`. The CLI TEE-signs `receiveWithAuthorization`. Its nonce is `keccak256(abi.encode(channelId, additionalDeposit, from, topUpSalt))` and must match the on-chain contract.
- **`false`:** the user broadcasts the top-up tx first; then run the same command with `--tx-hash '0x<64 hex>'`. `--currency` is optional here, since nothing is EIP-3009-signed.

Afterwards set `deposit += additional_deposit`, echo the state, and resume S2.

## S3: close

Close when the user is done ("close the channel / 关闭通道 / end the session") or after the final request. Always close; otherwise the prepaid balance stays escrowed until the seller's timeout (typically 12–24 h).

1. Set `final_cum = current_cum`, the highest cum sent. Never add `unit_amount`: closing delivers no new service.
2. Echo the state. Then run `ocl payment session close --challenge '<close challenge or fresh 402>' --channel-id <channel_id> --cumulative-amount <final_cum> --escrow <escrow> --chain-id <chain_id> [--from <payer_addr>]`. It signs an EIP-712 voucher in the TEE and returns `data.{authorization_header, channel_id, cumulative_amount}` (plus `refund` when the deposit is known).
3. Send `<original method> <original url>` with `Authorization`. Use a dedicated close endpoint (e.g. `/session/manage`) only if the seller names one; never guess. The seller settles on-chain (`final_cum` to the merchant, the rest refunded to the payer) and returns `Payment-Receipt`. Decode it with `ocl payment decode-receipt --header '<value>'` for `status`, `transaction` and `chainId`, then clear the session state.
4. Confirm:

> ✅ Channel closed. Charged `<human(final_cum)> (<final_cum>)` of your `<human(deposit)> (<deposit>)` prepaid balance. Refund of `<human(deposit − final_cum)> (<deposit − final_cum>)` returned to your wallet.
> On-chain tx: `<transaction>`

Follow-ups: a replay that gets an expired 402 → retry with a fresh signature. A channel still open → issue another voucher for the next request, and close it when done.

## MPP troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not logged in` / `session expired` | Wallet session missing or expired | Log in, then retry |
| `30001 incorrect params` | Stale challenge, wrong base URL, or `http://` redirect | Get a fresh 402; the backend must be `https://` |
| `--tx-hash` rejected (`0x` + 64 hex) | Malformed hash | Copy the full 66-char hash |
| `chain not found` (charge or open) | Unsupported chainId | `ocl wallet chains` |
| `70012 amount_exceeds_deposit` | cum > channel deposit | [Top up](#s2b-top-up) first |
| `70000 invalid_params` | new cum ≤ current cum (it must strictly increase) | Increase strictly; track `current_cum` |
| `70013 voucher_delta_too_small` | Increase below `minVoucherDelta` | Raise cum by at least the minimum |
| `InsufficientBalance` (HTTP 402; OKX Rust SDK `70015`) | Seller's spent + new amount > highest voucher | Voucher-exhausted fallback ([S2](#s2-voucher-loop)) |
| 402 keeps repeating after a voucher | `channel_id` / `escrow` / `chain_id` differ from the open | All three must match the open |
| `70004 invalid signature` | EIP-3009 typename or domain mismatch | Check seller logs; usually the CLI is older than the spec |
| `70008 channel finalized` | Channel already closed on-chain | Session is done; never retry close |
| `70010 channel not found` | Wrong `channel_id`, or the seller has no record | Verify against the open output |
| Seller `ETIMEOUT` or hang | Payment (SA) backend down or slow | Wait and retry (SDK timeout 30 s) |

## Payment links (a2a-pay)

Payment links are not triggered by a 402. They are invoked by name: a paymentId or `a2a_…` link, a create-link request, or a status question.

| User says | Role | Go to |
|---|---|---|
| "create payment link", "generate payment", gives amount/recipient | Seller | [Seller: create](#seller-create) |
| Gives a paymentId / `a2a_…` to pay | Buyer | [Buyer: pay](#buyer-pay) |
| Gives a paymentId and asks for status | Either | [Status and polling](#status-and-polling) |

If the user says only "I want to pay" without a paymentId, stop and ask for the seller-issued paymentId; do nothing else. Create and pay need a live wallet session: run `ocl wallet status` first and log in if needed. Never sign without a live session.

### Seller: create

`ocl payment a2a-pay create --type charge --amount <decimal> --symbol <SYMBOL> --recipient <0x seller wallet> [--description <shown to buyer>] [--realm <seller domain>] [--expires-in <seconds, default 1800>]`

`charge` is the only `--type`, and `--recipient` is the EIP-3009 `to`. The response carries only `payment_id` and an optional `deliveries.url`, not the amount or currency, so echo the seller's inputs:

> Payment link created.
> • paymentId: `<payment_id>`
> • Amount: `<amount input> <symbol input>` (decimal as submitted)
> • Recipient: `<recipient input>`
> • Share with buyer: `<deliveries.url>` (if returned) or `paymentId=<payment_id>`

Then offer to check the status once the buyer is expected to have paid.

### Buyer: pay

**Trust model.** The buyer signs the seller's on-server challenge. Verifying that it matches the deal is the caller's job: before paying, the user or upstream flow must cross-check the paymentId or `deliveries.url` against the out-of-band agreement (chat, task spec, prior negotiation). There is no separate preview or yes/no gate; the explicit request to pay that paymentId is the approval.

Run `ocl payment a2a-pay pay --payment-id <id> --amount <atomic> --currency <token contract> --recipient-address <0x payee>`. The CLI checks these agreed terms against the challenge before signing:
- `--amount` is in minimal units and must match byte-for-byte; convert the agreed decimal with the token decimals. Addresses are compared case-insensitively.
- If a term is missing, ask; never guess.
- `amount mismatch`, `currency mismatch` or `recipient address mismatch` means nothing was signed. Show the expected and challenge values, and have the user verify with the seller.

Outcomes:
- **Accepted:** `ok:true`, exit 0, `data.{payment_id, status, tx_hash?, valid_after, valid_before, signature}` → [poll](#status-and-polling).
- **Rejected** (server `success:false`): `ok:false`, exit 1, `payment a2a_… rejected (reason=<errorReason>)`. The paymentId is now terminal. Never retry pay on it: every retry burns a fresh nonce and signature for the same outcome.
- **`insufficient_balance` with structured `data`** (`phase: funding_required`, `decision: blocked`, empty `nextAction`, `payload.operation: a2a_payment` with `fundingTarget`, `qr`, `fundingNeed`): go at once to [wallet › Insufficient balance](wallet.md#insufficient-balance) and show balance, shortfall, address and QR in the same reply. The payload has no paymentId or payment state; use the conversation. After funding is verified, continuing needs a NEW seller-issued paymentId/link (ask if the original payment is unclear); it re-enters this section and its result replaces the old funding result.
- **Any other rejection, or no structured data:** relay what failed, suggest the obvious remedy (usually a new link from the seller), and stop.

### Status and polling

`ocl payment a2a-pay status --payment-id <id> --wait` polls inside the CLI (every 3 s, up to 60 s) until the status is terminal. Never sleep or poll yourself. Read `data.status`, `data.terminal` and `data.timed_out`.

`pending` and `settling` are non-terminal; `completed`, `failed`, `expired` and `cancelled` are terminal. If pay already returned a terminal status, render it and stop; otherwise run the `--wait` status. On `timed_out`, return the status and the paymentId: "Status is still `<status>` after 60s; you can run status again later."

| `status` | After pay | Status query |
|---|---|---|
| `pending` | — | ⏳ Awaiting buyer signature. |
| `settling` | — | 🔄 Settling on-chain (credential submitted, awaiting confirmation). |
| `completed` | ✅ Payment confirmed on-chain. tx_hash: `<tx_hash>` block: `<block_number>` | ✅ Confirmed on-chain. tx_hash: `<tx_hash>` block: `<block_number>` fee: `<fee_decimal> <fee_symbol>` |
| `failed` | ❌ Payment failed. (+ server reason, if any) | ❌ Failed. (+ server reason) |
| `expired` | ⌛ Payment link expired before settlement. Ask the seller for a new one. | ⌛ Expired before settlement. |
| `cancelled` | 🚫 Seller cancelled this payment. | 🚫 Cancelled by seller. |

- **Values.** Fill `tx_hash`, `block_number` and the fee only from output that carries them (pay returns `tx_hash`). Omit anything absent; never invent it.
- **Fee.** The output has `fee_amount` (string, minimal units) and `fee_bps`. `fee_decimal` is `fee_amount` converted with the token decimals. `fee_symbol` is the `--symbol` the seller passed to create for that paymentId; status does not echo it. If neither is available, show `fee_amount` in minimal units as is.
- **Amounts** follow [amount display](payments.md#amount-display), except for an unlisted symbol: don't look it up and don't block. Use the unknown-decimals fallback directly: `<atomic> <symbol>` plus a double-check note.
- **Follow-ups.** `pending`/`settling`: check again shortly. `completed`: verify the balance change ([wallet.md](wallet.md)). `failed`: check the buyer's balance, and if there is a `tx_hash`, inspect it with `ocl security tx-scan` ([security.md](security.md)).

### Link edge cases

| Case | Handling |
|---|---|
| `payment … not payable`, an expired challenge, or an unsupported intent (pay handles `charge` links only) | Relay it verbatim as a terminal failure; never retry signing |
| paymentId not found / 404 | Relay it, and ask the user to confirm the paymentId with the seller or upstream caller |
| Server 5xx | Show the status code and any `errorMessage` verbatim. Never auto-retry pay: each retry makes a fresh EIP-3009 nonce and signature, so let upstream decide. Status is read-only and safe to retry manually |
| `--expires-in` was too short and the link is past its window | Status is `expired`; ask the seller for a new link |
| Pay succeeded but status is still `pending`/`settling` after 60 s | Return the status verbatim with the paymentId and the "Status is still …" line |

Return fields: create → `payment_id`, `deliveries` (`url` when issued); pay → `payment_id`, `status`, `tx_hash?`, `valid_after`, `valid_before`, `signature`; status → `status`, `terminal`, `timed_out`, plus `tx_hash`, `block_number`, `block_timestamp`, `fee_amount`, `fee_bps` when present.

## Period subscriptions

Use this only when a 402 `accepts[]` entry has `scheme: "period"` (a.k.a. `permit2_subscription`), or when the user manages an existing HTTP-payment subscription. One-shot `exact`, `aggr_deferred` and `upto` offers go to [payments.md](payments.md).

The buyer subscribes once by signing a Permit2 `PermitSingle` (a bounded allowance to the subscription contract) plus a `SubscriptionTerms` EIP-712 authorization. After that, a lightweight `APP-Access` proof header serves the resource without re-paying. The buyer self-manages: change (upgrade/downgrade), cancel, cancel-pending (revoke a scheduled downgrade), and my-subscriptions / allowance-status to inspect.
- **Signs or reads only.** No subcommand broadcasts or moves funds; the seller or facilitator executes on-chain, bounded by the signed `permit.amount` / `permit.expiration`.
- **No confirming gate.** The envelope is `{ok, data|error}`, exit 0/1 only, with no `--force`. Still confirm subscribe, change, cancel and cancel-pending in conversation.
- **EVM only** (Permit2 / EIP-712 / EIP-191). Solana (501) and other non-EVM chains are out of scope.

| Situation | Run `ocl payment subscription …` |
|---|---|
| New `period` offer, no active subscription for this host | `subscribe --accepts '<json>' --url <url>` |
| Resource already has an active subscription (check `my-subscriptions` first) | `access --url <url>`; never re-subscribe |
| Upgrade/downgrade (change-offer 402 with `extra.changeFrom`) | `access` → proof-carrying probe → `change --accepts '<offer>' --sub-id <current>` |
| Cancel | `cancel --sub-id <s> --contract <c>` |
| Revoke a scheduled downgrade | `cancel-pending --sub-id <s> --new-sub-id <n> --contract <c>` |
| Inspect or reconcile | `my-subscriptions` · `allowance-status --token <t>` |

Flags (defaults in the card): `--accepts` = the 402 `accepts` array (or one object) as verbatim JSON containing a `period` entry, from the decoded `PAYMENT-REQUIRED` header or v1 body. `--url` = the resource URL (`resource.url`); its host is the subId cache key. `--sub-id` overrides the cache on `access` (`source: "override"`) and `extra.changeFrom.fromSubId` on `change`. `--contract` = the subscription contract's EIP-712 verifying domain, looked up via allowance-status from `--token` when omitted. `--chain` defaults to X Layer (196), `--from` to the selected account.

**Change probe.** The change endpoint returns a full change-offer (`extra.changeFrom` with `direction` + `fromSubId`) only to a probe that proves ownership; a naked probe gets an offer without it, `change` fails, and you must re-probe. Always: (1) `access --url <change endpoint>` and send `.data.accessHeaderValue` as the `APP-Access` header; (2) probe the change endpoint with that header → 402 change-offer; (3) `change --accepts '<that offer>' --sub-id <current>`.

**Allowance pre-flight** (subscribe/change). Right before signing, the CLI reads allowance-status for a fresh `nonce`, `reservedAmount` and `permit2Allowance`. The signed Permit2 needs `permit.amount ≥ reservedAmount + this subscription's total commitment` and a `permit.expiration` covering the service window (`fixed_seconds`: `startAt + maxPeriods × periodSec`; `calendar_month`: `addMonths(effective_start, maxPeriods)`). If `permit2Allowance` is insufficient (first payment in that token, or a longer window), the command errors with `allowance_expired` guidance. Do the one-time ERC-20 → Permit2 approve ([Permit2 approve](payments.md#permit2-one-time-approve), not a subscription verb), then retry.

| Command | Read the result |
|---|---|
| subscribe / change | Replay `.data.paymentHeaderValue` under `.data.paymentHeaderName` (`PAYMENT-SIGNATURE`). Keep `.data.subId`; the CLI also caches host → subId |
| access | Replay `.data.accessHeaderValue` under `APP-Access`. `.data.source` (`cache` \| `override`) says where the subId came from |
| cancel / cancel-pending | Relay `.data.cancelAuth` / `.data.pendingChangeCancelAuth` to the seller. The sub stays active and billable until the contract executes, and the local cache is not flipped to canceled (my-subscriptions corrects it). `--new-sub-id` must equal the on-chain pending `newSubId` (`my-subscriptions` → `pendingPlanChange.newSubId`) |
| my-subscriptions | `.data.subscriptions[].state`: `0` pending, `1` active, `2` completed, `3` canceled, `4` changed, `99` failed; the local cache is reconciled from it |
| allowance-status | Always all 10 fields (`approvedAmount`, `reservedAmount`, `permit2Allowance`, `subscriptionContract`, `permit2Contract`, …) |

**Contract mismatch = security stop.** Before signing, subscribe and change compare the seller's `extra.contracts.subscription` / `extra.contracts.permit2` with the authoritative allowance-status `subscriptionContract` / `permit2Contract` (EVM checksum-insensitive).
- Any mismatch, or a missing authoritative value → `{"ok":false,"error":"… contract mismatch: …"}`, exit 1, before any signature or approve. The contract may have been tampered with: never retry, re-probe or force; abort and tell the user.
- On a match, the authoritative values become the Permit2 spender, the EIP-712 verifying contracts and the approve target.
- cancel/cancel-pending resolve the contract via allowance-status with `--token`, or take a caller-supplied `--contract` verbatim without a cross-check. That is acceptable because a `CancelAuth` / `PendingChangeCancelAuth` carries no transfer authority.

Edge cases:
- `access` with no cached subscription and no `--sub-id`: the error names the host. Run `my-subscriptions` to reconcile the cache, or pass `--sub-id`.
- `fixed_seconds` needs `periodSec > 0`, and `calendar_month` needs `periodSec == 0`; an inconsistency errors out.
- Exposure is capped by the signed `permit.amount` / `permit.expiration`, which the pre-sign allowance check enforces. Never re-subscribe an active resource; access or change it instead.
