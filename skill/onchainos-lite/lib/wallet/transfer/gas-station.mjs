// Gas Station two-phase flow for `wallet send` / contract-call — upstream
// agentic_wallet/transfer/gas_station.rs. (Distinct from lib/wallet/gas-station.mjs, the
// `wallet gas-station` management subcommands.)
//
// Success emitters return the `data` value upstream prints with output::success; the command
// handler (or any other caller, e.g. `wallet gas-station setup`) returns it to main.
import { Confirming, SetupRequired, context } from '../../core/errors.mjs';
import { struct, stringify } from '../../core/json.mjs';
import { chainDisplayName } from '../../core/chains.mjs';
import { WalletApiClient, gsStatus, hasSignMaterial, autoPickGasToken, GasStationStatus } from '../api.mjs';
import * as store from '../store.mjs';
import { ensureTokensRefreshed, formatApiError } from '../auth.mjs';
import { getChainByRealChainIndex } from '../chain.mjs';
import { ERR_NOT_LOGGED_IN, handleConfirmingError } from '../common.mjs';
import { sessionKeyOrNotLoggedIn } from '../shared/common/session.mjs';
import { hpkeDecryptSessionSk, ed25519SignEncoded, ed25519SignHex } from '../../core/crypto.mjs';
import { isObject } from '../../core/rs/value.mjs';
import { parseU64 } from '../../core/rs/num.mjs';
import { resolveAddress } from './index.mjs';

// `addr_info.chain_index.parse::<u64>().unwrap_or(1)`
const chainIndexOr1 = (ci) => parseU64(ci) ?? 1;
const executeOk = (u) => (typeof u.executeResult === 'boolean' ? u.executeResult : true);
const simulationFailed = (u) => new Error(`transaction simulation failed: ${u.executeErrorMsg === '' ? 'transaction simulation failed' : u.executeErrorMsg}`);

// upstream: gas_station.rs::gas_station_send — Phase 2 with a chosen gas token → success data.
export async function gasStationSend(amt, recipient, chain, from, contractToken, force, gasTokenAddress, relayerId, enableGasStation) {
  const accessToken = await ensureTokensRefreshed();
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const entry = await getChainByRealChainIndex(chain);
  if (!entry) throw new Error(`unsupported chain: ${chain}`);
  if (typeof entry.chainName !== 'string') throw new Error('missing chainName');
  const [accountId, addrInfo] = resolveAddress(wallets, from, entry.chainName);
  const chainIndexNum = chainIndexOr1(addrInfo.chainIndex);
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);

  const client = new WalletApiClient();
  let unsigned;
  try {
    unsigned = await client.preTransactionUnsignedInfo(accessToken, addrInfo.chainPath, chainIndexNum, addrInfo.address, recipient, amt, contractToken,
      session.sessionCert, undefined, undefined, undefined, undefined, undefined, undefined, null, enableGasStation ? true : undefined, gasTokenAddress, relayerId);
  } catch (e) {
    throw formatApiError(e);
  }
  if (gsStatus(unsigned) === GasStationStatus.NotSupportIntention && !hasSignMaterial(unsigned)) throw gsNotSupportedErr(addrInfo.address);
  if (!unsigned.gasStationUsed) throw new Error('Gas Station not activated by backend for this transaction');
  if (unsigned.hasPendingTx) return emitGsPendingTxState();
  if (unsigned.insufficientAll) return emitGsInsufficientAllState(unsigned, addrInfo.address);
  if (!executeOk(unsigned)) throw simulationFailed(unsigned);

  const material = unsigned.unsignedTxHash !== '' || unsigned.hash !== '' || unsigned.eip712MessageHash !== '';
  if (!material) {
    if (gasTokenAddress !== undefined && gasTokenAddress !== null) {
      throw new Error(`Gas Station returned no signing material despite a pinned token (status: ${unsigned.gasStationStatus}). Activation did not complete; retry or pick another token.`);
    }
    const decision = classifyGsPhase1(unsigned);
    switch (decision.kind) {
      case 'FirstTime': throw buildGsFirstTimePrompt(addrInfo, unsigned);
      case 'Reenable': throw buildGsReenablePrompt(addrInfo, unsigned);
      case 'AutoPick':
        return gasStationSend(amt, recipient, chain, from, contractToken, force, decision.feeTokenAddress, decision.relayerId, decision.needsEnable);
      default: throw buildGsTokenSelectionPrompt(unsigned);
    }
  }
  const resp = await gasStationSignAndBroadcast(client, accessToken, accountId, addrInfo, session, unsigned, force, recipient, amt, contractToken);
  return { txHash: resp.txHash, orderId: resp.orderId, gasStationUsed: true, serviceCharge: unsigned.serviceCharge, serviceChargeSymbol: unsigned.serviceChargeSymbol };
}

// upstream: gas_station.rs::gs_build_msg_for_sign — TEE-flow sessionSignature (+7702 auth).
export function gsBuildMsgForSign(unsigned, session, signingSeed) {
  const m = {};
  const seedB64 = Buffer.from(signingSeed).toString('base64');
  if (unsigned.eip712MessageHash !== '') m.sessionSignature = ed25519SignEncoded(unsigned.eip712MessageHash, seedB64, unsigned.encoding);
  if (unsigned.hash !== '' && unsigned.eip712MessageHash === '') m.sessionSignature = ed25519SignEncoded(unsigned.hash, seedB64, unsigned.encoding);
  if (unsigned.unsignedTxHash !== '') {
    const sig = ed25519SignEncoded(unsigned.unsignedTxHash, seedB64, unsigned.encoding);
    m.unsignedTxHash = unsigned.unsignedTxHash;
    m.sessionSignature = sig;
  }
  if (unsigned.unsignedTx !== '') m.unsignedTx = unsigned.unsignedTx;
  if (unsigned.authHashFor7702 !== '') m.authSignatureFor7702 = ed25519SignHex(unsigned.authHashFor7702, seedB64);
  if (session.sessionCert !== '') m.sessionCert = session.sessionCert;
  return m;
}

// upstream: gas_station.rs::gs_apply_extra_data_fields — GS core fields onto extraData (mutates).
export function gsApplyExtraDataFields(ed, unsigned) {
  ed.paymentType = 'token';
  ed.serviceCharge = unsigned.serviceCharge;
  ed.feeTokenAddress = unsigned.serviceChargeFeeTokenAddress;
  if (unsigned.contractNonce !== '') ed.contractNonce = unsigned.contractNonce;
  const selected = unsigned.gasStationTokenList.find((t) => t.feeTokenAddress === unsigned.serviceChargeFeeTokenAddress);
  if (selected) {
    ed.relayerId = selected.relayerId;
    ed.context = selected.context;
  }
  if (unsigned.user712Data !== null && unsigned.user712Data !== undefined) ed.user712Data = unsigned.user712Data;
  if (unsigned.authHashFor7702 !== '') {
    if (unsigned.eoaNonce !== '') ed.nonce = unsigned.eoaNonce;
    if (unsigned.user7702Data !== null && unsigned.user7702Data !== undefined) ed.user7702Data = unsigned.user7702Data;
  }
}

// upstream: gas_station.rs::gs_apply_transfer_info (dead code upstream; kept for parity of the API)
export function gsApplyTransferInfo(ed, toAddr, coinAmount, tokenAddress) {
  if (toAddr !== undefined && toAddr !== null) ed.toAdr = toAddr;
  ed.coinAmount = coinAmount;
  if (tokenAddress !== undefined && tokenAddress !== null) ed.tokenAddress = tokenAddress;
}

// upstream: gas_station.rs::gs_build_extra_data — backend passthrough + master fields + GS fields.
export function gsBuildExtraData(unsigned, msgForSign, toAddr, coinAmount, tokenAddress, force) {
  const ed = isObject(unsigned.extraData) ? { ...unsigned.extraData } : {};
  ed.checkBalance = true;
  ed.uopHash = unsigned.uopHash;
  ed.encoding = unsigned.encoding;
  ed.signType = unsigned.signType;
  ed.msgForSign = msgForSign;
  if (force) ed.skipWarning = true;
  gsApplyExtraDataFields(ed, unsigned);
  return ed;
}

function gsSeed(session) {
  return hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKeyOrNotLoggedIn());
}

// upstream: gas_station.rs::gs_broadcast_with_7702_upgrade (needUpdate7702 = true)
export async function gsBroadcastWith7702Upgrade(client, accessToken, accountId, addrInfo, session, unsigned, force, toAddr, coinAmount, tokenAddress) {
  const seed = gsSeed(session);
  const msgForSign = gsBuildMsgForSign(unsigned, session, seed);
  const ed = gsBuildExtraData(unsigned, msgForSign, toAddr, coinAmount, tokenAddress, force);
  return gsDoBroadcast(client, accessToken, accountId, addrInfo, ed, force);
}

// upstream: gas_station.rs::gs_broadcast_transaction (needUpdate7702 = false) — same body as Flow 1.
export async function gsBroadcastTransaction(client, accessToken, accountId, addrInfo, session, unsigned, force, toAddr, coinAmount, tokenAddress) {
  const seed = gsSeed(session);
  const msgForSign = gsBuildMsgForSign(unsigned, session, seed);
  const ed = gsBuildExtraData(unsigned, msgForSign, toAddr, coinAmount, tokenAddress, force);
  return gsDoBroadcast(client, accessToken, accountId, addrInfo, ed, force);
}

// upstream: gas_station.rs::gs_do_broadcast → BroadcastResponse
export async function gsDoBroadcast(client, accessToken, accountId, addrInfo, extraDataObj, force) {
  let extraDataStr;
  try { extraDataStr = stringify(extraDataObj); } catch (e) { throw context('failed to serialize extraData', e); }
  try {
    return await client.broadcastTransaction(accessToken, accountId, addrInfo.address, addrInfo.chainIndex, extraDataStr, null);
  } catch (e) {
    throw handleConfirmingError(e, force);
  }
}

// upstream: gas_station.rs::gas_station_sign_and_broadcast — routes on needUpdate7702.
export function gasStationSignAndBroadcast(client, accessToken, accountId, addrInfo, session, unsigned, force, toAddr, coinAmount, tokenAddress) {
  return unsigned.needUpdate7702
    ? gsBroadcastWith7702Upgrade(client, accessToken, accountId, addrInfo, session, unsigned, force, toAddr, coinAmount, tokenAddress)
    : gsBroadcastTransaction(client, accessToken, accountId, addrInfo, session, unsigned, force, toAddr, coinAmount, tokenAddress);
}

// upstream: gas_station.rs::emit_gs_pending_tx_state → success data
export const emitGsPendingTxState = () => ({ scene: 'gs_pending_tx', gasStationUsed: true, hasPendingTx: true });

// upstream: gas_station.rs::emit_gs_insufficient_all_state → success data
export function emitGsInsufficientAllState(unsigned, fromAddr) {
  return { scene: 'gs_insufficient_all', gasStationUsed: true, insufficientAll: true, gasStationTokenList: tokenListValue(unsigned), fromAddr };
}

// upstream: gas_station.rs::gs_not_supported_err
export function gsNotSupportedErr(fromAddr) {
  return new Error(`Gas Station does not support this transaction type — only transfers and swaps can pay gas with a stablecoin. Pay with native SOL instead, then retry. Top up SOL at: ${fromAddr}`);
}

// Vec<GasStationToken> through to_value (a Value: keys sorted on output).
const tokenListValue = (unsigned) => unsigned.gasStationTokenList.map((t) => ({ ...t }));

// upstream: gas_station.rs::token_list_json — serde_json::to_string(Vec<GasStationToken>) in struct order.
export function tokenListJson(unsigned) {
  return stringify(unsigned.gasStationTokenList.map((t) => struct({
    feeCoinId: t.feeCoinId, symbol: t.symbol, feeTokenAddress: t.feeTokenAddress, serviceCharge: t.serviceCharge,
    balance: t.balance, sufficient: t.sufficient, relayerId: t.relayerId, context: t.context,
  })));
}

// upstream: gas_station.rs::format_sufficient_tokens
export function formatSufficientTokens(unsigned) {
  return unsigned.gasStationTokenList.filter((t) => t.sufficient)
    .map((t, i) => `${i + 1}. ${t.symbol} (balance: ${t.balance}, fee: ${t.serviceCharge})`).join('\n');
}

// upstream: gas_station.rs::build_gs_first_time_prompt → Confirming (scene gs_first_time)
export function buildGsFirstTimePrompt(addrInfo, unsigned) {
  const display = chainDisplayName(addrInfo.chainIndex);
  const message = `Gas Station first-time setup required on ${display}. Render the user-facing prompt via the Scene A template in \`skills/okx-agentic-wallet/references/gas-station.md\` (do NOT paraphrase). Sufficient stablecoins now:\n${formatSufficientTokens(unsigned)}`;
  const next = 'On user pick `1` (decline): do not re-run; the user must top up native token.\n'
    + 'On user pick `N` (N >= 2, one per sufficient token above): re-run `wallet send --enable-gas-station --gas-token-address <addr> --relayer-id <id>` with the chosen token.\n'
    + `Token list: ${tokenListJson(unsigned)}`;
  return new Confirming({ message, next, scene: 'gs_first_time' });
}

// upstream: gas_station.rs::build_gs_reenable_prompt → Confirming (scene gs_reenable)
export function buildGsReenablePrompt(addrInfo, unsigned) {
  const display = chainDisplayName(addrInfo.chainIndex);
  const prev = unsigned.defaultGasTokenAddress === '' ? '(none)' : unsigned.defaultGasTokenAddress;
  const message = `Gas Station re-enable required on ${display} — the user previously disabled it. Render the user-facing prompt via the Scene B' template in \`skills/okx-agentic-wallet/references/gas-station.md\` (do NOT paraphrase). Previous default gas token address: ${prev}. Sufficient stablecoins now:\n${formatSufficientTokens(unsigned)}`;
  const next = 'On user pick `1` (decline): do not re-run; the user must top up native token.\n'
    + 'On user pick `N` (N >= 2, one per sufficient token above): re-run `wallet send --enable-gas-station --gas-token-address <addr> --relayer-id <id>` with the chosen token. Backend will overwrite the previous default with the picked token.\n'
    + `Token list: ${tokenListJson(unsigned)}`;
  return new Confirming({ message, next, scene: 'gs_reenable' });
}

const opt = (v) => (v === undefined ? null : v);

// upstream: gas_station.rs::force_setup_required_for_tx_params → SetupRequired
export function forceSetupRequiredForTxParams(isReenable, isContractCall, chain, from, tx, addrInfo, unsigned) {
  const originalArgs = {
    chain, from: opt(from), toAddr: tx.toAddr, value: tx.value, contractAddr: opt(tx.contractAddr), inputData: opt(tx.inputData), force: true,
  };
  return buildGsSetupRequired(addrInfo, unsigned, isReenable, isContractCall ? 'wallet contract-call' : 'wallet send', originalArgs);
}

// upstream: gas_station.rs::force_setup_required_for_send → SetupRequired
export function forceSetupRequiredForSend(isReenable, chain, from, recipient, amount, contractToken, addrInfo, unsigned) {
  const originalArgs = { chain, from: opt(from), recipient, amount, contractToken: opt(contractToken), force: true };
  return buildGsSetupRequired(addrInfo, unsigned, isReenable, 'wallet send', originalArgs);
}

// upstream: gas_station.rs::build_gs_setup_required → SetupRequired (GAS_STATION_SETUP_REQUIRED, exit 3)
export function buildGsSetupRequired(addrInfo, unsigned, isReenable, originalCommand, originalArgs) {
  const display = chainDisplayName(addrInfo.chainIndex);
  const tokenList = unsigned.gasStationTokenList.map((t) => ({
    symbol: t.symbol, feeTokenAddress: t.feeTokenAddress, relayerId: t.relayerId, balance: t.balance, serviceCharge: t.serviceCharge, sufficient: t.sufficient,
  }));
  const scene = isReenable ? "B'" : 'A';
  const setupHint = `onchainos wallet gas-station setup --chain ${addrInfo.chainIndex} --gas-token-address <picked> --relayer-id <picked>`;
  const message = `Gas Station first-time setup required on ${display}. Cannot proceed under \`--force\` because first-time activation needs explicit user consent. Run \`${setupHint}\` first (after rendering Scene ${scene} to the user), then re-invoke the same command.`;
  const data = {
    chainId: addrInfo.chainIndex,
    chainName: display,
    fromAddress: addrInfo.address,
    scene,
    gasStationStatus: unsigned.gasStationStatus,
    defaultGasTokenAddress: unsigned.defaultGasTokenAddress,
    tokenList,
    originalRequest: { command: originalCommand, args: originalArgs },
    retryGuidance: [
      `1) Render Scene ${scene} via \`skills/okx-agentic-wallet/references/gas-station.md\` using \`data.tokenList\`.`,
      '2) On user pick, run `wallet gas-station setup --chain <chainId> --gas-token-address <picked.feeTokenAddress> --relayer-id <picked.relayerId>`.',
      '3) Re-invoke the original command verbatim (it will succeed because Gas Station is now active).',
    ],
  };
  return new SetupRequired({ errorCode: 'GAS_STATION_SETUP_REQUIRED', message, data });
}

// upstream: gas_station.rs::build_gs_token_selection_prompt → Confirming (scene gs_token_switch)
export function buildGsTokenSelectionPrompt(unsigned) {
  const message = `Gas Station needs a token pick on this chain (default is missing or insufficient). Render the user-facing prompt via the Scene C template in \`skills/okx-agentic-wallet/references/gas-station.md\` (do NOT paraphrase). Sufficient stablecoins now:\n${formatSufficientTokens(unsigned)}`;
  const next = 'On user pick (this-time-only option): re-run with `--gas-token-address <addr> --relayer-id <id>`.\n'
    + 'On user pick (set-as-new-default option): same re-run, then call `wallet gas-station update-default-token --chain <chain> --gas-token-address <addr>` after the tx completes.\n'
    + `Token list: ${tokenListJson(unsigned)}`;
  return new Confirming({ message, next, scene: 'gs_token_switch' });
}

// upstream: gas_station.rs::GsPhase1Decision
export const GsPhase1Decision = Object.freeze({
  FirstTime: Object.freeze({ kind: 'FirstTime' }),
  Reenable: Object.freeze({ kind: 'Reenable' }),
  autoPick: (feeTokenAddress, relayerId, needsEnable) => ({ kind: 'AutoPick', feeTokenAddress, relayerId, needsEnable }),
  NeedsUserPick: Object.freeze({ kind: 'NeedsUserPick' }),
});

// upstream: gas_station.rs::classify_gs_phase1
export function classifyGsPhase1(unsigned) {
  const status = gsStatus(unsigned);
  if (unsigned.gasStationFirstTimePrompt || status === GasStationStatus.FirstTimePrompt) return GsPhase1Decision.FirstTime;
  if (status === GasStationStatus.ReenableOnly) return GsPhase1Decision.Reenable;
  const token = autoPickGasToken(unsigned);
  if (token) return GsPhase1Decision.autoPick(token.feeTokenAddress, token.relayerId, status === GasStationStatus.PendingUpgrade);
  return GsPhase1Decision.NeedsUserPick;
}

// upstream: gas_station.rs::handle_gs_auto_sign_broadcast → success data
export async function handleGsAutoSignBroadcast(client, accessToken, accountId, addrInfo, session, unsigned, force, recipient, amt, contractToken) {
  const resp = await gasStationSignAndBroadcast(client, accessToken, accountId, addrInfo, session, unsigned, force, recipient, amt, contractToken);
  return {
    txHash: resp.txHash, orderId: resp.orderId, gasStationUsed: true, autoSelectedToken: unsigned.autoSelectedToken,
    serviceCharge: unsigned.serviceCharge, serviceChargeSymbol: unsigned.serviceChargeSymbol, gasStationTokenList: tokenListValue(unsigned),
  };
}
