# Gas Station (Solana)

Pay Solana gas with USDT / USDC / USDG instead of SOL. Load when a Solana `ocl wallet send`, `ocl wallet contract-call`, `ocl swap execute`, `ocl cross-chain execute` or DeFi-plugin result carries a `gs_*` `scene`, `gasStationUsed`, or `serviceCharge`, or when the user asks about Gas Station. Signatures: [wallet commands](../commands/wallet.md).

Contents: [What it is](#what-it-is) · [Rules](#rules) · [Scene map](#scene-map) · [Scene A](#scene-a-first-time-consent) · [Scene B/D](#scene-bd-silent-auto-path) · [Scene C](#scene-c-default-token-short) · [Scene E](#scene-e-all-stablecoins-short) · [Success reply](#success-reply) · [Check order](#check-order) · [Management](#management) · [Intents](#intents) · [Third-party plugins](#third-party-plugins) · [Edge cases](#edge-cases) · [Failures](#failures) · [FAQ](#faq)

## What it is
- Solana only (chainIndex `501`, native SOL); accepts USDT, USDC, USDG. The Relayer is the native fee payer; the stablecoin fee is collected via an SPL token transfer inside the same multi-signer transaction — no account upgrade, no per-chain setup, no 7702.
- Covers all SPL token transfers and contract interactions (swaps, DeFi supply / borrow / redeem / claim, bridge initiation, any SPL / program interaction); the backend decides eligibility per request ([Edge case 8](#edge-cases)). Native SOL transfers never use it.
- Not a separate command: the backend dispatches it inside the `wallet send` / `wallet contract-call` response. First-time / token-switch → Confirming (exit `2`, Scene A / C); pinned default → silent (Scene B / D). State (enable flag, default token) is scoped to `(account, Solana)`.
- Per-tx token set: only from the response's `gasStationTokenList` (backend-authoritative); the static list above serves FAQ answers and unsupported-chain detection only. Token priority (list order + auto-select): balance descending; ties USDT > USDC > USDG.

## Rules
- Backend dispatches; you react. Never check SOL balance or decide on Gas Station yourself: run send / contract-call as normal, read the CLI `scene` (and `gasStationUsed`), dispatch via the [scene map](#scene-map). Never re-derive the scene from raw backend fields; never author copy.
- Never pass `--gas-token-address` / `--relayer-id` / `--enable-gas-station` on the first call — they are second-phase values, used only after the user picks a token from a Confirming, copied exactly from its `next`. Never fabricate token addresses or relayer IDs.
- Always surface Gas Station when SOL is insufficient but a supported stablecoin has enough balance — on a fresh attempt and on a "why did my transfer fail?" follow-up. Default token short but another stablecoin held → propose switching (Scene C, zero-cost) before "reduce amount" or "top up default token".
- Never push Gas Station proactively while the user browses or asks unrelated questions. Never call it "free": there is a service charge in the selected stablecoin; show `serviceCharge` + `serviceChargeSymbol` when present. Never combine it with Jito Bundler — hard block ([Edge case 2](#edge-cases)).

**Output discipline** (every template in this guide): product copy — render the body verbatim, substituting only `{slots}`. For a non-English user translate at output time, keeping structure, every fact and every clause (e.g. "now set as the default Gas token"); render "Solana" as-is; no leading setup line, no trailing notes. Call the feature only "Gas Station" and the choice "which stablecoin to pay gas". Never surface internal field names (`gasStationFirstTimePrompt`, `gasStationUsed`, `autoSelectedToken`, `hasPendingTx`, `insufficientAll`, `signType`, `multiSignerTx`, `Phase 1/2`, `DB flag`), numeric error codes, debug/log paths or raw CLI commands.

## Scene map
| CLI result | Render | Then |
|---|---|---|
| `scene: gs_first_time` | Scene A | Consent + pick → follow `next` (re-run with `--enable-gas-station --gas-token-address <pick> --relayer-id <pick>`); success → Scene A two-step |
| `scene: gs_reenable` | Scene A (re-enable) | Same; backend overwrites the previous default |
| `scene: gs_token_switch` | Scene C | Choice 1 / 2 / 3 → follow `next`; success → Scene C echo |
| `scene: gs_insufficient_all` | Scene E | Bail; never re-run |
| `scene: gs_pending_tx` | Edge case 4 | Bail; never auto-retry |
| success + `gasStationUsed=true`, no `scene` | [Success reply](#success-reply) | — |

On a Confirming, `next` carries the exact re-run command. Agent-detected (no scene): Jito hard block, tx cap, async hash, native SOL — see [Edge cases](#edge-cases).

## Scene A: first-time consent
Trigger: `gasStationFirstTimePrompt=true` + `gasStationTokenList` with ≥1 `sufficient=true` (none → Scene E).
```
Your SOL balance is not enough to pay Gas. Two ways to proceed:

1. Top up SOL and pay with the native token.
2. Enable "Gas Station" and pay Gas directly with a stablecoin.

About Gas Station: Gas Station aggregates third-party services, automatically compares rates and picks the cheapest one to cover Gas on your behalf. It accepts USDT, USDC, or USDG — you do not need to hold Solana. Learn more: https://web3.okx.com/learn/wallet-gas-station

- Once enabled, whenever the native token is insufficient, the system will automatically pay Gas with the stablecoin — no manual confirmation needed.
- By default the token with the highest balance is used; you can also pin a specific token as the default for every transaction. Tokens supported on this chain: USDT, USDC, USDG.

Confirm enabling Gas Station and paying this transaction's Gas with stablecoin?
```
Never modify the body, drop the academy link, the two bullets or the "Tokens supported on this chain" line, or reduce it to a bare yes/no.
- Pick → follow `next` with that token's `--gas-token-address` + `--relayer-id`; confirmed without naming one → highest-balance sufficient token. Decline → do not re-run; tell them to top up SOL at `{fromAddr}`. Ambiguous / token not in list → re-prompt once; never guess.
- After every Scene A success (mandatory): 1) pin silently, once — `ocl wallet gas-station update-default-token --chain solana --gas-token-address {chosen_token_address}` (address from `serviceChargeFeeTokenAddress`, else the phase-2 `--gas-token-address`; non-zero exit = soft failure, continue); 2) echo verbatim, every sentence (`{chosen_token}` = symbol actually used), then append the success reply: `Gas Station enabled. This transaction will pay Gas with {chosen_token}, and {chosen_token} is now set as the default Gas token. Whenever the native token is insufficient from now on, {chosen_token} will be used automatically — no further confirmation needed. You can change the default Gas token at any time.`

## Scene B/D: silent auto-path
`gasStationUsed=true` + `autoSelectedToken=true` + non-empty `hash`; the CLI signs and broadcasts silently. **B**: a default token is set and sufficient. **D**: no default, exactly one stablecoin sufficient — backend auto-selects; do not prompt. Reply with the success reply only; for D add a one-line note that the auto-selected token was used.

## Scene C: default token short
Trigger: `gasStationUsed=true` + empty `hash` + `gasStationFirstTimePrompt=false` + `insufficientAll=false`; default token `sufficient=false`, ≥1 alternative `sufficient=true`; CLI returns Confirming.
```
The default Gas token {prev_token} has insufficient balance (need ${serviceChargeUsd}, current balance ${prev_balance_usd}).
The following stablecoins in your account have enough balance to pay this transaction's Gas:

- {alt_token_1} (balance ${alt_balance_1_usd})
- {alt_token_2} (balance ${alt_balance_2_usd})

How would you like to proceed?
1. Change the default Gas token to {alt_token_X} and use it for this transaction (this chain will default to {alt_token_X} going forward).
2. Use {alt_token_X} for this transaction only; keep the default as {prev_token}.
3. Top up {prev_token} and continue using it.
```
Slots: `{prev_token}` = token at `defaultGasTokenAddress`; `{serviceChargeUsd}` / `{prev_balance_usd}` from the response; `{alt_token_N}` = each `sufficient=true` entry other than the default, in token-priority order; `{alt_token_X}` = the single alternative's symbol, else `<your-pick>`. Always all three choices; no leading/trailing lines.

| Choice | Action | Echo, then success reply |
|---|---|---|
| 1 — alt + make default | Re-run with `--gas-token-address <alt_addr> --relayer-id <alt_relayer_id>`; after broadcast succeeds, silently `ocl wallet gas-station update-default-token --chain solana --gas-token-address <alt_addr>` | `Done — this transaction will pay Gas with {chosen_token}, and the default Gas token is now {chosen_token}.` |
| 2 — alt, this tx only | Re-run with those two flags only (no `--enable-gas-station`, no `update-default-token`) | `Done — this transaction will pay Gas with {chosen_token}. The default token remains {prev_token}, unchanged.` |
| 3 — top up / cancel | Do not re-run; tell them to top up at `{fromAddr}` and retry | — |
| Ambiguous / not in list / default not addressed | Re-prompt once: change the default? yes → 1, no → 2. Never guess | — |

## Scene E: all stablecoins short
`insufficientAll=true`, every entry `sufficient=false`, `fromAddr` present; CLI bails. Do not proceed; do not propose Gas Station.
```
You don't have enough balance to pay Gas. Please top up first:
  Top-up address: {fromAddr}
  Accepted tokens: SOL, USDT, USDC
```

## Success reply
Any tx paid via Gas Station (send, contract-call, swap, bridge, any DeFi plugin; detect via `gasStationUsed=true` or non-empty `serviceCharge` + `serviceChargeSymbol`) must contain all four:
1. Acknowledgment — gas was paid via Gas Station with a stablecoin, not SOL; never imply "free".
2. Service charge — `{serviceCharge} {serviceChargeSymbol}` plus USD equivalent, e.g. `Network fee: 0.8 USDC (≈ $0.80, paid via Gas Station)`.
3. orderId — verbatim; never omit or truncate.
4. Follow-up — `You can tell me: **check order {orderId}** to check the status.` (translate, keep the literal `check order {orderId}`).

Fee row: when output carries `networkFeeLabel` (`Network fee` or `Network fee and Rent fee`), that string is the label of exactly one fee row (translated) — no separate row, no extra `Gas fee` title; absent → `Network fee`. Empty `txHash` (usual on the first response): say it was submitted and the on-chain hash returns asynchronously; ask them to check again shortly. Never fabricate a `txHash`.
```
Sent 100 USDC to CYXWm...

- Network fee: 0.8 USDC (≈ $0.80, paid via Gas Station)
- orderId: ord_ghi789rst
- txHash: submitted, on-chain hash will be returned asynchronously by the Relayer — check again shortly.

You can tell me: **check order ord_ghi789rst** to check the status.
```

## Check order
"check order {orderId}" / "is that last transaction done?" (any language) → run `ocl wallet history --chain solana --order-id <orderId>` internally (never shown), render one. **Completed:**
```
✅ Order {orderId} completed.

- txHash: {txHash}
- Status: success
- Chain: Solana
- {networkFeeLabel}: {network_fee_line}
```
`{networkFeeLabel}` is CLI-provided — render verbatim (translated), no separate rent row. `{network_fee_line}`, first that fits: 1) `serviceChargeSymbol` present → `{serviceCharge_readable} {serviceChargeSymbol} (≈ ${serviceChargeUsd}, paid via Gas Station)` with `{serviceCharge_readable}` = `serviceCharge` ÷ `10^serviceChargeDecimal` (never the raw integer or field names); 2) only `serviceChargeUsd` → `≈ ${serviceChargeUsd} (paid via Gas Station)`; 3) neither → `paid via Gas Station (amount not returned)`.

**Still processing:** `Order {orderId} is still being processed by the Relayer. Please check again shortly — tell me **check order {orderId}** and I'll fetch the latest status.` **Failed / timed out** (10-min Relayer TTL; never fabricate `txHash`):
```
⚠️ Order {orderId} did not complete.

The transaction was broadcast via Gas Station, but the Relayer did not finalize it on-chain within 10 minutes; it has been marked as failed.

Your funds are untouched — the stablecoin Gas fee was NOT deducted, and the {amount} {tokenSymbol} you tried to send is still in your account.

You can retry now, or top up SOL and pay Gas with the native token instead.
```

## Management
All `ocl wallet gas-station <sub> --chain solana`; signatures in [wallet commands](../commands/wallet.md#wallet-gas-station-status).
- `status` — read-only probe (never broadcasts; safe to repeat). `recommendation`: `READY` (proceed) · `ENABLE_GAS_STATION` (Scene A) · `INSUFFICIENT_ALL` (Scene E) · `HAS_PENDING_TX` (tell the user to wait). Also `gasStationEnabled`, `gasStationDefaultToken`, `tokenList[]` (`symbol`, `feeTokenAddress`, `relayerId`, `balance`, `serviceCharge`, `sufficient`).
- `setup` — standalone first-time activation; idempotent (same default again → `alreadyActivated=true`); proceeds only when the probe state is first-time-eligible.
- `enable` / `disable` / `update-default-token` — backend DB flags, no on-chain action. Success → render `data.message` verbatim. Failure → show the error; never auto-retry (common: invalid token address, chain not supported, not logged in).
- Before `disable`, ask: "Once disabled, transactions on Solana will pay Gas with SOL again. You can re-enable any time. If you only want to switch the Gas-payment token, use 'change default Gas token' instead of disabling. Confirm disabling?"

## Intents
| User says | Do |
|---|---|
| Send, but lacks SOL (any wording) | Run `ocl wallet send` as normal; Gas Station activates automatically |
| Can stablecoins pay gas? / any Gas Station question | Matching [FAQ](#faq) template verbatim; then proceed if a tx was given |
| Change default gas token / enable / disable (stop paying with stablecoin) | `ocl wallet gas-station update-default-token --chain solana --gas-token-address <addr>` / `enable --chain solana` / confirm, then `disable --chain solana`; if they only want another token, suggest `update-default-token` |
| Jito Bundle + stablecoin gas · tx blocked as unsupported type · hash not returned / slow | Edge case 2 · Edge case 8 (never re-run via Gas Station) · Edge case 3 |
| Why didn't it kick in? | Check pending tx, > 100,000 U, Jito Bundle, native SOL, unsupported type → matching template |

## Third-party plugins
Solana DeFi plugins (`kamino-plugin`, `raydium-plugin`, …) run `wallet contract-call --force` as a subprocess. **Pre-flight** before a plugin write (`--confirm` / `execute` / `--broadcast`): resolve `<from>` from the invocation, run `ocl wallet gas-station status --chain solana [--from <solana_address>]`, branch on `data.recommendation`:
- `READY` → invoke the plugin. `INSUFFICIENT_ALL` → Scene E. `HAS_PENDING_TX` → tell the user to wait for the pending Gas Station tx to clear.
- `ENABLE_GAS_STATION` → Scene A from `data.tokenList`; on consent `ocl wallet gas-station enable --chain solana`, and to pin the pick `ocl wallet gas-station update-default-token --chain solana --gas-token-address <picked>`; then invoke the plugin.
- Skip pre-flight when the invocation is dry-run / simulation, the command is read-only (e.g. `kamino-plugin positions`, `health-factor`, `reserves`, `quickstart`), or `status` already returned `READY` for this `(solana, from)` in the conversation.

**Bail recovery** (plugin already failed; authoritative). Exit codes seen through a plugin:

| Exit | Meaning | Do |
|---|---|---|
| `0` | Success | Continue |
| `1` | Real error | Surface it |
| `2` | Confirming: stdout JSON `"confirming": true` + `scene` (Scene A / C); recoverable | Read `scene`, dispatch via the scene map (render, get consent, run any management command it calls for — e.g. `update-default-token` on a Scene C choice 1), then re-invoke the same plugin command verbatim |
| `3` | `GAS_STATION_SETUP_REQUIRED` (first-time under `--force`; `data.scene` `A` / `B'` + `data.tokenList`) | Render Scene A; on pick `ocl wallet gas-station setup --chain solana --gas-token-address <feeTokenAddress> --relayer-id <relayerId>`; re-invoke verbatim |

Always parse the JSON before calling it recoverable (real failures differ). Always get consent for Scene A / C token selection. The bail is pre-broadcast, so re-running is idempotent — never hand-rebuild the plugin's calldata. `gs_insufficient_all` / `gs_pending_tx` → never retry. Vague error with stdout swallowed → run `status` and branch as in pre-flight.

## Edge cases
Handle explicitly; never fall through to generic error handling.
1. **Tx value > 100,000 USD** — backend silently falls back (`gasStationUsed=false`, no Confirming). Never mention Gas Station unprompted; only if asked whether stablecoins can pay gas for this tx: "This transaction exceeds the Gas Station per-transaction cap (100,000 U), so Gas cannot be paid with a stablecoin. Top up the native token and retry the full transfer, or split it into smaller transactions."
2. **Jito Bundler (hard block)** — `--jito-unsigned-tx` supplied or the user wants a Jito Bundle. Even with SOL short and stablecoin available, never route silently to Gas Station:
```
Sorry, Gas Station does not support Jito Bundler transactions.

You can continue either way:

- Use Jito Bundle: switch the network fee to the native token (SOL); the Bundle transaction can be sent normally.
- Use stablecoin Gas: switch to a normal transaction (no Jito Bundle).
```
3. **Hash not yet returned** (`txHash` empty, `orderId` known): "The transaction is being submitted on-chain. Please check again shortly." Why others return a hash at once: "This one is paid via Gas Station, so the hash comes back slightly later than for normal transactions."
4. **Pending Gas Station tx** (`scene: gs_pending_tx`) — never auto-retry:
```
A previous Gas Station transaction is still processing — you can't start a new one yet. Wait for the previous one to finish and retry, or top up SOL and use the native token instead.
(To check the previous one, tell me: **check order {prev_orderId}**)
```
5. **Order status** — see [Check order](#check-order).
6. **Native SOL transfer** — `gasStationUsed=false` regardless of balance. If asked: "Gas Station only applies to SPL token transfers and contract interactions. Native SOL transfers do not go through Gas Station."
7. **History display** — for a Gas Station tx in `wallet history` show the user's intended transfer, the fee in the stablecoin actually used (not SOL), and the user's `from` (never the Relayer's address).
8. **Type not supported** — send / contract-call bails with "Gas Station does not support this transaction type" (deposit, staking…). Never retry via Gas Station; never assert SOL is short (the top-up line is conditional). `{fromAddr}` = the bail message's "Top up SOL at: ..." or the user's known Solana address:
```
This transaction type isn't eligible for Gas Station — the network fee must be paid in native SOL.

Gas Station currently supports only transfers and swaps. Other types such as deposits and staking can't pay gas with a stablecoin yet — they must be paid with SOL.

If your SOL balance isn't enough to cover the network fee, top up first, then retry:
  Top-up address: {fromAddr}
```

## Failures
Diagnosis, not user copy. Dispatch on `scene`; never re-derive from raw booleans.

| Failure (after token pick) | Detect | Response |
|---|---|---|
| Token selection rejected | non-2xx, or `gasStationUsed=false` with error | Say it failed, ask to retry; re-run phase 1 to refresh `gasStationTokenList` (balance changed, `relayerId` expired, token unsupported) |
| Invalid `gasTokenAddress` | backend error | Never fabricate; re-run phase 1, use values from `next` |
| Simulation failed (`executeResult=false`) | `transaction simulation failed: <msg>` | Show `<msg>`; never broadcast |
| Balance changed between phases | phase 2 returns `insufficientAll` or simulation fails | Re-run phase 1 |
| Empty `hash` on phase 2 | backend bug | Surface the error; never sign |
| `signType` ≠ `multiSignerTx` | backend bug | Fatal (no multi-signer tx possible); surface the error |

Fee shown in SOL instead of the stablecoin, or `from`/history showing the Relayer address → report as a backend bug; never convert manually.

## FAQ
Output the matching template alone — nothing before or after, only translation. The "never free" rule does not apply here.

**What is Gas Station?**
```
Gas Station aggregates third-party services,
  automatically comparing rates and picking the cheapest one to pay Gas for you.
  You can pay with USDT, USDC, or USDG —
  no need to hold SOL or any other native token.
  ──────────────────────────────
  Supported network and tokens: Solana (USDT, USDC, USDG)
  ──────────────────────────────
```
**How does it work under the hood?**
```
[Solana] Gas Station needs no account upgrade or setup.
A third-party service pays the network fee on your behalf,
and the fee is automatically deducted from the stablecoin you choose.
```
**Are there extra fees for enabling it?**
```
[Solana] No. Gas Station on Solana requires no account upgrade;
you can pay Gas with a stablecoin on the very first use.
```
**Does each network need to be upgraded before use?**
```
No. Solana has no setup step;
once Gas Station is enabled it can be used directly.
```
**Which tokens can pay Gas?**
```
USDC, USDT, USDG. By default the token with the highest balance is used;
when balances tie, the order is USDT > USDC > USDG.
You can also pin a specific token as the default Gas token.
```
**Which networks are supported?** `Solana only, for now.` **Which transaction types are supported?**
```
Gas Station currently lets you pay gas with a stablecoin for two transaction types:
- Transfers
- Swaps
Other types (e.g. deposits, staking) are not supported yet and must pay gas with SOL.
```
**Which scenarios do NOT trigger Gas Station?**
```
- Native SOL transfers (Gas Station only covers SPL token transfers and contract interactions).
- Transaction types other than transfers and swaps (e.g. deposits, staking).
- Transactions sent via Jito Bundle.
- A single transaction value above 100,000 U.
- A previous Gas Station transaction is still being processed.
```
**Why did I receive a small amount of SOL from this transaction?** Gated — never render on the keyword alone: (1) resolve the tx (given txHash, else `ocl wallet history --chain solana` → the recent SOL-inflow record); (2) fetch detail `ocl wallet history --chain solana --tx-hash <hash>` (or `--order-id <id>`); (3) require both `serviceChargeSymbol` ∈ {USDT, USDC, USDG} and `networkFeeLabel == "Network fee and Rent fee"`. Both present → render:
```
[Solana] This transaction was settled via Gas Station and involves an account rent (rent):
- Within the same transaction, the Relayer first sends a small amount of SOL to cover the account rent for this transaction.
- Within the same transaction, you repay the Relayer in the stablecoin you selected (covering both the rent and the network fee).
- The small amount of SOL you ended up receiving is the leftover after the rent was paid.
```
Otherwise explain from the tx data: a real swap (e.g. `USDC → SOL` in the asset change) → a normal swap; dusting (1 lamport from an unknown address, `txHash` often null) → Solana network noise, ignorable. Never invent a Gas Station explanation.
