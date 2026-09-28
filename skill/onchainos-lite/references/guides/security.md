# Security scanning

Five scans: `token-scan`, `dapp-scan`, `tx-scan`, `sig-scan`, `approvals` ([security commands](../commands/security.md)). None needs login and each works on any address. Verdict handling (block/pause/warn/safe, failed scans) lives in [SKILL.md](../../SKILL.md); this guide covers inputs, fields and display.

## Token risk / honeypot: `ocl security token-scan`

| Context | `--trade-direction` | Output |
|---|---|---|
| Token being received (`--to` in a swap) | `buy` | `{ tokens, combinedAction, tradeDirection }` |
| Token being spent (`--from` in a swap) | `sell` | same |
| Standalone, no trade | omit | raw array, no `action` |

- Swap pair: pass every token in one `--tokens` call and use `combinedAction` as the pair verdict. It is already the strictest `action` across non-native tokens (`safe` when none), so never reduce it yourself.
- Raw fields per token: `chainId`, `tokenAddress`, `isChainSupported`, `riskLevel`, `buyTaxes`/`sellTaxes` (string|null) and the boolean labels. With a direction, each token also gets `normalizedRiskLevel` (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`), `action` (`block`/`pause`/`warn`/`safe`) and `isNative`, and `tradeDirection` echoes the flag. The exit code is 0 even on `block`, so always read the fields.
- A missing, `null` or unrecognized `riskLevel` counts as `HIGH`. The CLI applies this in `normalizedRiskLevel`.
- `isChainSupported: false`: skip that token with a warning and do not block.
- In a swap, a token-scan API failure continues with a warning, overriding the general fail-safe because trades are time-sensitive. A standalone scan follows the general fail-safe.
- Native tokens (ETH/BNB/SOL/OKB) have no contract address and are skipped silently.

Choose the tokens by fetching holdings first, showing them, then scanning with `--tokens "<chainIndex>:<addr>,..."` (cards: [wallet](../commands/wallet.md), [portfolio](../commands/portfolio.md), [token](../commands/token.md)):

| Input | Steps |
|---|---|
| Own logged-in wallet | `ocl wallet balance [--chain <chain>]`, take the non-native ERC-20/SPL tokens, then scan |
| Other or public address | `ocl portfolio all-balances --address <addr> --chains "..." --filter 1` with EVM and Solana as separate calls; display, then scan |
| `chainId:contractAddress` given | pass it straight to `--tokens` |
| Name or symbol | `ocl token search`; the user confirms the match, then scan |

### Display

Per token, show the symbol (or address) and chain, the overall risk level only (`normalizedRiskLevel`, or `riskLevel` in standalone output; never per-label levels), the triggered labels without level prefixes, buy/sell tax % when non-null (omit when both are null), and the `action`. A standalone scan shows the raw result: every triggered label, with no buy/sell logic.

- `riskLevel` is authoritative. Collect the labels that are `true`, and include `isHasAssetEditAuth` only on Solana (`chainId 501`).
- If `riskLevel` is not LOW but no label is `true`, say "flagged by composite analysis, no specific label identified".
- Taxes already feed `riskLevel` on the server, so never recompute: ≥50% gives CRITICAL, 21–50% HIGH, 0–21% MEDIUM, and 0/null means no tax risk.
- Buy is stricter than sell, but that mapping belongs to the CLI. The matrix below is for reference only; never apply it by hand.

| riskLevel | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| buy | block | pause | warn | safe |
| sell | warn | warn | warn | safe |

| Label tier | Labels |
|---|---|
| Critical (block buy) | `isHoneypot` (cannot sell after buying), `isRubbishAirdrop` (spam/scam airdrop), `isAirdropScam` (gas-mint scam) |
| High (pause buy for confirmation) | `isHasAssetEditAuth` (privileged address, Solana only), `isLowLiquidity`, `isDumping`, `isLiquidityRemoval`, `isPump`, `isWash`, `isFakeLiquidity`, `isWash2`, `isFundLinkage` (rugpull gang), `isVeryLowLpBurn`, `isVeryHighLpHolderProp`, `isHasBlockingHis` (freeze history), `isOverIssued`, `isCounterfeit`, `isNotOpenSource` |
| Medium (info) | `isMintable`, `isHasFrozenAuth` (freeze authority), `isNotRenounced` (ownership retained) |

After a token-scan, offer the workflow hint for [New Token Screening](../workflows/new-token-screening.md), [Smart Money Signals](../workflows/smart-money-signals.md), [Token Research](../workflows/token-research.md) or [Wallet Monitor](../workflows/wallet-monitor.md).

## DApp / URL phishing: `ocl security dapp-scan`

- `isMalicious: false`: report "No risk was detected within the checks performed."
- `isMalicious: true`: never open or interact with the site, and return the phishing warning immediately.

## Transaction and signature pre-checks: `ocl security tx-scan` / `sig-scan`

`sig-scan` is EVM only. `--sig-method` is one of `personal_sign`, `eth_sign`, `eth_signTypedData`, `eth_signTypedData_v3` or `eth_signTypedData_v4`, and `--message` takes the message or the typed-data JSON.

Both scans return `action` (`""`, `warn` or `block`, whichever is highest across `riskItemDetail`), `riskItemDetail[]` (`name`, `description` map, `reason[]`, `action`), `simulator` (`gasLimit`/`gasUsed`, `revertReason`) and `warnings[]`.

| `action` | Level | Show |
|---|---|---|
| empty | Low | "No risk was detected within the checks performed." (successful response only) |
| `warn` | Medium | the risk details, then ask for explicit confirmation |
| `block` | High | the risk details; do not proceed and recommend cancelling |

- The verdict stands even when simulation failed; `simulator.revertReason` may give the cause.
- Non-empty `warnings[]` means the scan completed but the data may be incomplete. Still present the risk information you have.
- `TRANSFER_TO_SIMILAR_ADDRESS`: show the full intended and flagged addresses side by side and require explicit confirmation.
- `ACCOUNT_IN_RISK`: the account already has malicious approvals. List them (below) and revoke them now.

| Action | Level | Risk items |
|---|---|---|
| block | CRITICAL | `black_tag` (target/asset/receiving address blacklisted), `from_risk_reject` (sender blacklisted), `SPENDER_ADDRESS_BLACK` (approval target blacklisted), `ASSET_RECEIVE_ADDRESS_BLACK`, `purchase_malicious_token`, `ACCOUNT_IN_RISK`, `evm_7702_risk` (EIP-7702 high-risk sub-tx, ≈ permanent control / unlimited approval), `evm_7702_auth_address_not_in_whitelist` (delegates to an unverified contract), `evm_okx7702_loop_calls_are_not_allowed` (recursive call / re-entrancy drain) |
| warn | HIGH | `TRANSFER_TO_SIMILAR_ADDRESS` (vanity-address phishing), `SOLANA_SIGN_ALL_TRANSACTIONS`, `multicall_phishing_risk` (approval via multicall), `approve_anycall_contract` |
| warn | MEDIUM | `to_is_7702_address`, `TRANSFER_TO_CONTRACT_ADDRESS`, `TRANSFER_TO_MULTISIGN_ADDRESS` (Tron), `approve_eoa` |
| warn | LOW | `increase_allowance`, `ACCOUNT_INSUFFICIENT_PERMISSIONS` (Tron) |

## Approvals: list and revoke

Approvals are EVM only. When logged in, pass the active account's EVM address from `ocl wallet addresses`; ask the user only when there is no session. Run `ocl security approvals --address <0x…>`. Without `--chain` it covers all supported EVM chains; page with the returned `cursor`.

It returns `approvalList[]` (`tokenSymbol`, `tokenAddress`, `chainIndex`, `spenderAddress`, `allowance`, `riskLevel`) and `cursor`. `allowance` is raw, and `"unlimited"` means max uint256.

To revoke a risky approval:
1. Build `approve(spender, 0)` calldata for the token contract.
2. Always run `ocl security tx-scan` on the revoke calldata first.
3. Agentic Wallet: `ocl wallet contract-call --to <token_contract> --chain <chain> --input-data <revoke_calldata>`. External wallet: the user signs it, then `ocl gateway broadcast` ([gateway commands](../commands/gateway.md)).
