// Fund-moving transaction pipeline for EVM / Solana / other account chains — upstream
// agentic_wallet/transfer/mod.rs: address resolution, unsignedInfo → session-key signing →
// broadcast (single and batch), the transfer funding scenes, `wallet send` and
// `wallet contract-call` (non-SUI) entry points.
//
// Entry points that upstream finishes with output::success(..) return that `data` value here;
// the command handler returns it to main (which prints the {"ok":true,"data":…} envelope).
import { context, FundingBlocked } from '../../core/errors.mjs';
import { stringify } from '../../core/json.mjs';
import { isEvmChain, nativeTokenSymbol } from '../../core/chains.mjs';
import { validateAddressForChain } from '../../core/token-alias.mjs';
import { validateAmount, validateNonNegativeInteger } from '../../core/validators.mjs';
import { buildFundingBundle, readableShortfall, FUNDING_OPERATION_TRANSFER } from '../../core/funding.mjs';
import { WalletApiClient, ApiCodeError, gsStatus, hasSignMaterial, freeGas, GasStationStatus } from '../api.mjs';
import * as store from '../store.mjs';
import { ensureTokensRefreshed, formatApiError } from '../auth.mjs';
import { getChainByRealChainIndex } from '../chain.mjs';
import { resolve as resolveChainProfile } from '../chain-profile.mjs';
import { ERR_NOT_LOGGED_IN, handleConfirmingError } from '../common.mjs';
import { sessionKeyOrNotLoggedIn } from '../shared/common/session.mjs';
import { minimalToReadable } from '../shared/common/amount.mjs';
import { hpkeDecryptSessionSk, ed25519SignEip191, ed25519SignHex, ed25519SignEncoded } from '../shared/_crypto.mjs';
import { ensureWalletAccountsFresh, queryTokenReadable, queryTokenMetadata } from '../shared/_balance.mjs';
import { eqIgnoreAsciiCase, isObject, parseU64, u64Json, strDebug, downcast } from '../shared/_rust.mjs';
import {
  gasStationSend, gsNotSupportedErr, gsApplyExtraDataFields, classifyGsPhase1, buildGsFirstTimePrompt, buildGsReenablePrompt,
  buildGsTokenSelectionPrompt, forceSetupRequiredForTxParams, forceSetupRequiredForSend, emitGsPendingTxState,
  emitGsInsufficientAllState, handleGsAutoSignBroadcast,
} from './gas-station.mjs';

const some = (v) => v !== undefined && v !== null;
const executeOk = (u) => (typeof u.executeResult === 'boolean' ? u.executeResult : true);
const simulationFailedMessage = (u) => (u.executeErrorMsg === '' ? 'transaction simulation failed' : u.executeErrorMsg);

// ── resolve_address ─────────────────────────────────────────────────

// upstream: mod.rs::resolve_address → [accountId, AddressInfo]. With `fromAddr`, every
// account's addresses are scanned (upstream HashMap order; here wallets.json order).
export function resolveAddress(wallets, fromAddr, chain) {
  if (some(fromAddr)) {
    for (const [accountId, entry] of Object.entries(wallets.accountsMap)) {
      for (const addr of entry.addressList) {
        if (eqIgnoreAsciiCase(addr.address, fromAddr) && addr.chainName === chain) return [accountId, { ...addr }];
      }
    }
    throw new Error(`no address matches from=${fromAddr} chain=${chain}`);
  }
  const acctId = wallets.selectedAccountId;
  if (acctId === '') throw new Error('no currentAccountId');
  if (!Object.prototype.hasOwnProperty.call(wallets.accountsMap, acctId)) throw new Error('not found currentAccountId');
  for (const addr of wallets.accountsMap[acctId].addressList) if (addr.chainName === chain) return [acctId, { ...addr }];
  throw new Error(`no address for chain=${chain} in account=${acctId}`);
}

// upstream: mod.rs::resolve_address_with_refresh — one refresh + retry; `wallets` is replaced
// in place by the refreshed value (upstream `*wallets = refresh().await?`).
export async function resolveAddressWithRefresh(wallets, from, chainName, refresh) {
  try { return resolveAddress(wallets, from, chainName); } catch { /* refresh once */ }
  const fresh = await refresh();
  for (const k of Object.keys(wallets)) delete wallets[k];
  Object.assign(wallets, fresh);
  return resolveAddress(wallets, from, chainName);
}

// ── extraData assembly ─────────────────────────────────────────────

// upstream: mod.rs::apply_broadcast_core — checkBalance = !freeGas, uopHash, encoding, signType, msgForSign.
export function applyBroadcastCore(ed, unsigned, msgForSign) {
  ed.checkBalance = !freeGas(unsigned);
  ed.uopHash = unsigned.uopHash;
  ed.encoding = unsigned.encoding;
  ed.signType = unsigned.signType;
  ed.msgForSign = msgForSign;
}

// Standard (non-GS) msgForSign — upstream sign_and_broadcast / sign_and_build_extra_data share
// the branch set; `withEip712` adds the eip712MessageHash → sessionSignature step.
function buildMsgForSign(unsigned, signingSeed, sessionCert, { withEip712, withJito }) {
  const seedB64 = Buffer.from(signingSeed).toString('base64');
  const m = {};
  if (unsigned.hash !== '') m.signature = ed25519SignEip191(unsigned.hash, signingSeed, 'hex');
  if (unsigned.authHashFor7702 !== '') m.authSignatureFor7702 = ed25519SignHex(unsigned.authHashFor7702, seedB64);
  if (unsigned.unsignedTxHash !== '') {
    const sig = ed25519SignEncoded(unsigned.unsignedTxHash, seedB64, unsigned.encoding);
    m.unsignedTxHash = unsigned.unsignedTxHash;
    m.sessionSignature = sig;
  }
  if (withEip712 && unsigned.eip712MessageHash !== '') m.sessionSignature = ed25519SignEncoded(unsigned.eip712MessageHash, seedB64, unsigned.encoding);
  if (unsigned.unsignedTx !== '') m.unsignedTx = unsigned.unsignedTx;
  if (withJito && unsigned.jitoUnsignedTx !== '') {
    const sig = ed25519SignEncoded(unsigned.jitoUnsignedTx, seedB64, unsigned.encoding);
    m.jitoUnsignedTx = unsigned.jitoUnsignedTx;
    m.jitoSessionSignature = sig;
  }
  if (sessionCert !== '') m.sessionCert = sessionCert;
  return m;
}

const serializeExtraData = (ed) => {
  try { return stringify(ed); } catch (e) { throw context('failed to serialize extraData', e); }
};

// upstream: mod.rs::sign_and_build_extra_data (private upstream) → serialized extraData
export function signAndBuildExtraData(unsigned, sessionCert, encryptedSessionSk, sessionKey, isContractCall, mevProtection, force) {
  const seed = hpkeDecryptSessionSk(encryptedSessionSk, sessionKey);
  const msgForSign = buildMsgForSign(unsigned, seed, sessionCert, { withEip712: false, withJito: true });
  const ed = isObject(unsigned.extraData) ? { ...unsigned.extraData } : {};
  applyBroadcastCore(ed, unsigned, msgForSign);
  if (!isContractCall) ed.txType = 2;
  if (mevProtection) ed.isMEV = true;
  if (force) ed.skipWarning = true;
  return serializeExtraData(ed);
}

// ── sign_and_broadcast ──────────────────────────────────────────────

// upstream: mod.rs::TxParams (all optional fields undefined = None)
export function txParams({ toAddr, value, contractAddr, inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, jitoUnsignedTx, gasTokenAddress, relayerId, enableGasStation = false }) {
  return { toAddr, value, contractAddr, inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, jitoUnsignedTx, gasTokenAddress, relayerId, enableGasStation: !!enableGasStation };
}

// Refresh closure used by sign_and_broadcast / batch_sign_and_broadcast.
const refreshWallets = (accessToken) => async () => {
  const fresh = store.loadWallets();
  if (!fresh) throw new Error(ERR_NOT_LOGGED_IN);
  await ensureWalletAccountsFresh(new WalletApiClient(), accessToken, fresh, true);
  return fresh;
};

// `addr_info.chain_index.parse::<u64>()`
function chainIndexNumber(ci) {
  const v = parseU64(ci);
  if (v === undefined) throw new Error(`chain id '${ci}' is not a valid number`);
  return u64Json(v);
}

// Trace headers for contract calls (cached swap trace id) — fresh timestamp per call.
const traceHeaders = (tid) => (tid ? [['ok-client-tid', tid], ['ok-client-timestamp', String(Date.now())]] : null);

// upstream: mod.rs::sign_and_broadcast → BroadcastResponse {pkgId, orderId, orderType, txHash}
export async function signAndBroadcast(chain, from, tx, isContractCall, mevProtection, force, txSource, agentBizType, agentSkillName) {
  const accessToken = await ensureTokensRefreshed();
  const entry = await getChainByRealChainIndex(chain);
  if (!entry) throw new Error(`unsupported chain: ${chain}`);
  if (typeof entry.chainName !== 'string') throw new Error(`chain entry missing chainName for chain ${chain}`);
  const chainName = entry.chainName;
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [accountId, addrInfo] = await resolveAddressWithRefresh(wallets, from, chainName, refreshWallets(accessToken));
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  const sessionCert = session.sessionCert;
  const encryptedSessionSk = session.encryptedSessionSk;
  const sessionKey = sessionKeyOrNotLoggedIn();
  const chainIndexNum = chainIndexNumber(addrInfo.chainIndex);

  const ci = addrInfo.chainIndex;
  validateAddressForChain(ci, tx.toAddr, 'to');
  if (some(tx.contractAddr)) validateAddressForChain(ci, tx.contractAddr, 'contract-token');
  if (some(tx.aaDexTokenAddr)) validateAddressForChain(ci, tx.aaDexTokenAddr, 'aa-dex-token-addr');
  if (some(tx.gasLimit)) validateNonNegativeInteger(tx.gasLimit, 'gas-limit');
  if (some(tx.aaDexTokenAmount)) validateNonNegativeInteger(tx.aaDexTokenAmount, 'aa-dex-token-amount');

  const client = new WalletApiClient();
  let cachedTid = null;
  if (isContractCall) { try { cachedTid = store.getSwapTraceId(); } catch { cachedTid = null; } }
  const traceRef = traceHeaders(cachedTid);
  const unsignedInfo = async (enable, gasToken, relayer) => {
    try {
      return await client.preTransactionUnsignedInfo(accessToken, addrInfo.chainPath, chainIndexNum, addrInfo.address, tx.toAddr, tx.value, tx.contractAddr,
        sessionCert, tx.inputData, tx.unsignedTx, tx.gasLimit, tx.aaDexTokenAddr, tx.aaDexTokenAmount, tx.jitoUnsignedTx, traceRef, enable ? true : undefined, gasToken, relayer);
    } catch (e) {
      throw formatApiError(e);
    }
  };
  let unsigned = await unsignedInfo(tx.enableGasStation, tx.gasTokenAddress, tx.relayerId);

  if (!executeOk(unsigned)) throw new Error(`transaction simulation failed: ${simulationFailedMessage(unsigned)}`);
  if (gsStatus(unsigned) === GasStationStatus.NotSupportIntention && !hasSignMaterial(unsigned)) throw gsNotSupportedErr(addrInfo.address);

  if (unsigned.gasStationUsed) {
    if (unsigned.hasPendingTx) {
      throw new Error('Gas Station has a pending transaction. Wait for it to complete, or run `wallet gas-station disable --chain <chain>` to use native token path.');
    }
    if (unsigned.insufficientAll) {
      throw new Error(`Gas Station cannot proceed — all supported tokens (USDT/USDC/USDG) are below the service charge. Top up at: ${addrInfo.address}`);
    }
    if (unsigned.hash === '' && unsigned.eip712MessageHash === '' && unsigned.unsignedTxHash === '') {
      const decision = classifyGsPhase1(unsigned);
      switch (decision.kind) {
        case 'FirstTime':
          if (force) throw forceSetupRequiredForTxParams(false, isContractCall, chain, from, tx, addrInfo, unsigned);
          throw buildGsFirstTimePrompt(addrInfo, unsigned);
        case 'Reenable':
          if (force) throw forceSetupRequiredForTxParams(true, isContractCall, chain, from, tx, addrInfo, unsigned);
          throw buildGsReenablePrompt(addrInfo, unsigned);
        case 'AutoPick':
          unsigned = await unsignedInfo(decision.needsEnable, decision.feeTokenAddress, decision.relayerId);
          break;
        default:
          throw buildGsTokenSelectionPrompt(unsigned);
      }
    }
  }

  const hasSignData = unsigned.hash !== '' || unsigned.eip712MessageHash !== '' || unsigned.unsignedTxHash !== ''
    || unsigned.unsignedTx !== '' || unsigned.authHashFor7702 !== '' || unsigned.jitoUnsignedTx !== '';
  if (!hasSignData) {
    switch (gsStatus(unsigned)) {
      case GasStationStatus.FirstTimePrompt:
      case GasStationStatus.ReenableOnly:
        throw new Error(`Gas Station activation required (status: ${unsigned.gasStationStatus}), but backend did not return a token list. Re-run with \`--enable-gas-station --gas-token-address <addr> --relayer-id <id>\` after picking a token, or first activate Gas Station via a small \`wallet send\` ERC-20 transfer.`);
      case GasStationStatus.PendingUpgrade:
        throw new Error('Gas Station activation is pending on-chain. Wait ~30s and retry. If this persists, the account may be stuck — contact support to reset.');
      case GasStationStatus.InsufficientAll:
        throw new Error(`Insufficient balance across native token and all Gas Station stablecoins (USDT / USDC / USDG). Top up at: ${addrInfo.address}`);
      case GasStationStatus.HasPendingTx:
        throw new Error('A pending Gas Station transaction is blocking this request. Wait for it to complete, or run `wallet gas-station disable --chain <chain>` to bypass.');
      case GasStationStatus.NotSupportIntention:
        throw gsNotSupportedErr(addrInfo.address);
      default:
        throw new Error(`Backend returned empty signing materials with gasStationStatus="${unsigned.gasStationStatus}". This is unexpected — likely a backend/environment issue.`);
    }
  }

  const seed = hpkeDecryptSessionSk(encryptedSessionSk, sessionKey);
  const msgForSign = buildMsgForSign(unsigned, seed, sessionCert, { withEip712: true, withJito: true });
  const ed = isObject(unsigned.extraData) ? { ...unsigned.extraData } : {};
  applyBroadcastCore(ed, unsigned, msgForSign);
  if (!isContractCall) ed.txType = 2;
  if (mevProtection) ed.isMEV = true;
  if (force) ed.skipWarning = true;
  if (some(txSource)) ed.txSource = txSource;
  if (some(agentBizType)) ed.agentBizType = agentBizType;
  if (some(agentSkillName)) ed.agentSkillName = agentSkillName;
  if (unsigned.gasStationUsed) gsApplyExtraDataFields(ed, unsigned);
  const extraDataStr = serializeExtraData(ed);

  let resp;
  try {
    resp = await client.broadcastTransaction(accessToken, accountId, addrInfo.address, addrInfo.chainIndex, extraDataStr, traceHeaders(cachedTid));
  } catch (e) {
    throw handleConfirmingError(e, force);
  }
  if (isContractCall) { try { store.clearSwapTraceId(); } catch { /* ignored upstream */ } }
  return resp;
}

// ── build_broadcast_body ───────────────────────────────────────────

// upstream: mod.rs::build_broadcast_body → {accountId, address, chainIndex, extraData} (agent-commerce)
export async function buildBroadcastBody(unsigned, accountId, address, chainIndex, isContractCall, mevProtection, force) {
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  const sessionKey = sessionKeyOrNotLoggedIn();
  const extraData = signAndBuildExtraData(unsigned, session.sessionCert, session.encryptedSessionSk, sessionKey, isContractCall, mevProtection, force);
  return { accountId, address, chainIndex, extraData };
}

// ── batch_sign_and_broadcast ───────────────────────────────────────

// upstream: mod.rs::validate_batch_unsigned_responses
export function validateBatchUnsignedResponses(unsignedResponses) {
  unsignedResponses.forEach((u, i) => {
    if (!executeOk(u)) throw new Error(`batch element ${i}: ${simulationFailedMessage(u)}`);
  });
  unsignedResponses.forEach((u, i) => {
    const has = u.hash !== '' || u.eip712MessageHash !== '' || u.unsignedTxHash !== '' || u.unsignedTx !== '' || u.authHashFor7702 !== '';
    if (!has) throw new Error(`batch element ${i}: backend returned empty signing materials                  (gasStationStatus=${strDebug(u.gasStationStatus)})`);
  });
}

// upstream: mod.rs::BatchTxParams
export const batchTxParams = ({ toAddr = '', value = '', contractAddr, inputData, gasLimit, aaDexTokenAddr, aaDexTokenAmount } = {}) =>
  ({ toAddr, value, contractAddr, inputData, gasLimit, aaDexTokenAddr, aaDexTokenAmount });

// upstream: mod.rs::build_batch_element_msg_for_sign (no jito)
export function buildBatchElementMsgForSign(unsigned, signingSeed, sessionCert) {
  return buildMsgForSign(unsigned, signingSeed, sessionCert, { withEip712: true, withJito: false });
}

// upstream: mod.rs::batch_sign_and_broadcast → BroadcastResponse[] (EVM only)
export async function batchSignAndBroadcast(chain, from, txs, isContractCall, mevProtection, force, txSource, agentBizType, agentSkillName) {
  if (!txs.length) throw new Error('batch_sign_and_broadcast: empty txs');
  if (txs.length > 5) throw new Error(`batch_sign_and_broadcast: backend allows up to 5 elements, got ${txs.length}`);
  const accessToken = await ensureTokensRefreshed();
  const entry = await getChainByRealChainIndex(chain);
  if (!entry) throw new Error(`unsupported chain: ${chain}`);
  if (typeof entry.chainName !== 'string') throw new Error(`chain entry missing chainName for chain ${chain}`);
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [accountId, addrInfo] = await resolveAddressWithRefresh(wallets, from, entry.chainName, refreshWallets(accessToken));
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  const sessionKey = sessionKeyOrNotLoggedIn();
  const chainIndexNum = chainIndexNumber(addrInfo.chainIndex);
  const ci = addrInfo.chainIndex;
  for (const tx of txs) {
    validateAddressForChain(ci, tx.toAddr, 'to');
    if (some(tx.contractAddr)) validateAddressForChain(ci, tx.contractAddr, 'contract-token');
    if (some(tx.aaDexTokenAddr)) validateAddressForChain(ci, tx.aaDexTokenAddr, 'aa-dex-token-addr');
    if (some(tx.gasLimit)) validateNonNegativeInteger(tx.gasLimit, 'gas-limit');
    if (some(tx.aaDexTokenAmount)) validateNonNegativeInteger(tx.aaDexTokenAmount, 'aa-dex-token-amount');
  }
  const elements = txs.map((tx) => ({
    chainPath: addrInfo.chainPath, chainIndex: chainIndexNum, fromAddr: addrInfo.address, toAddr: tx.toAddr, amount: tx.value,
    contractAddr: tx.contractAddr, sessionCert: session.sessionCert, inputData: tx.inputData, unsignedTx: undefined,
    gasLimit: tx.gasLimit, aaDexTokenAddr: tx.aaDexTokenAddr, aaDexTokenAmount: tx.aaDexTokenAmount, transactionType: undefined,
  }));
  const client = new WalletApiClient();
  let responses;
  try { responses = await client.batchPreTransactionUnsignedInfo(accessToken, elements, null); } catch (e) { throw formatApiError(e); }
  if (!responses.length) throw new Error('batch unsignedInfo: empty response');
  if (responses.length > txs.length) throw new Error(`batch unsignedInfo: response length ${responses.length} exceeds request length ${txs.length}`);
  validateBatchUnsignedResponses(responses);
  const seed = hpkeDecryptSessionSk(session.encryptedSessionSk, sessionKey);

  const broadcastElements = responses.map((unsigned) => {
    const msgForSign = buildBatchElementMsgForSign(unsigned, seed, session.sessionCert);
    const ed = isObject(unsigned.extraData) ? { ...unsigned.extraData } : {};
    applyBroadcastCore(ed, unsigned, msgForSign);
    if (!isContractCall) ed.txType = 2;
    if (mevProtection) ed.isMEV = true;
    if (force) ed.skipWarning = true;
    if (some(txSource)) ed.txSource = txSource;
    if (some(agentBizType)) ed.agentBizType = agentBizType;
    if (some(agentSkillName)) ed.agentSkillName = agentSkillName;
    const extJson = isObject(ed.extJson) ? { ...ed.extJson } : {};
    extJson.batchBroadcastType = 1;
    ed.extJson = extJson;
    ed.from7702Address = false;
    ed.walletMainSaveConfirming = true;
    return { accountId, address: addrInfo.address, chainIndex: addrInfo.chainIndex, extraData: serializeExtraData(ed) };
  });

  try {
    if (broadcastElements.length === 1) {
      const el = broadcastElements[0];
      return [await client.broadcastTransaction(accessToken, el.accountId, el.address, el.chainIndex, el.extraData, null)];
    }
    return await client.batchBroadcastTransaction(accessToken, broadcastElements, null);
  } catch (e) {
    throw handleConfirmingError(e, force);
  }
}

// ── transfer_insufficient_balance scenes ───────────────────────────

// upstream: mod.rs::is_transfer_funding_covered_chain
export const isTransferFundingCoveredChain = (chainIndex) => isEvmChain(chainIndex) || chainIndex === '501';

// upstream: mod.rs::transfer_funding_input → funding::FundingBlockedInput
export function transferFundingInput(assetSymbol, tokenAddress, requested, balance, errorCode, errorMessage) {
  return {
    asset: some(assetSymbol) ? assetSymbol : tokenAddress, tokenAddress, required: requested, balance: some(balance) ? balance : undefined,
    operation: FUNDING_OPERATION_TRANSFER, errorCode: some(errorCode) ? errorCode : undefined, errorMessage: some(errorMessage) ? errorMessage : undefined,
  };
}

// upstream: mod.rs::try_transfer_insufficient_balance_scene → FundingBlocked | null
// ctx = { chainIndex, contractToken, amountMinimal, requestedReadable }
export async function tryTransferInsufficientBalanceScene(err, ctx) {
  const api = downcast(err, ApiCodeError);
  if (!api || api.code !== '10004') return null;
  if (!isTransferFundingCoveredChain(ctx.chainIndex)) return null;
  const tokenAddress = some(ctx.contractToken) ? ctx.contractToken : '';
  let balance = null, assetSymbol, decimals;
  try {
    const matched = await queryTokenReadable(ctx.chainIndex, tokenAddress);
    if (matched) { balance = matched.balance; assetSymbol = matched.symbol; decimals = matched.decimals; }
    else balance = '0';
  } catch { balance = null; }
  if (tokenAddress === '') {
    assetSymbol = nativeTokenSymbol(ctx.chainIndex);
    if (decimals === undefined) {
      try { decimals = (await resolveChainProfile(ctx.chainIndex)).nativeDecimals; } catch { decimals = undefined; }
    }
  } else if (decimals === undefined || assetSymbol === undefined) {
    try {
      const metadata = await queryTokenMetadata(ctx.chainIndex, tokenAddress);
      if (decimals === undefined) decimals = metadata.decimals;
      if (some(metadata.symbol) && assetSymbol === undefined) assetSymbol = metadata.symbol;
    } catch { /* ignored */ }
  }
  let requested;
  if (some(ctx.requestedReadable)) requested = ctx.requestedReadable;
  else {
    if (decimals === undefined) return null;
    try { requested = minimalToReadable(ctx.amountMinimal, decimals); } catch { return null; }
  }
  let value;
  try {
    value = await buildFundingBundle(ctx.chainIndex, transferFundingInput(assetSymbol, tokenAddress, requested, balance, api.code, api.msg));
  } catch { return null; }
  return new FundingBlocked(value);
}

// upstream: mod.rs::try_transfer_simulation_insufficient_balance_scene → FundingBlocked | null
export async function tryTransferSimulationInsufficientBalanceScene(unsigned, ctx) {
  if (unsigned.executeResult !== false) return null;
  if (!isTransferFundingCoveredChain(ctx.chainIndex)) return null;
  const tokenAddress = some(ctx.contractToken) ? ctx.contractToken : '';
  let matched;
  try { matched = await queryTokenReadable(ctx.chainIndex, tokenAddress); } catch { return null; }
  if (!matched) return null;
  let requested;
  if (some(ctx.requestedReadable)) requested = ctx.requestedReadable;
  else {
    if (matched.decimals === undefined) return null;
    try { requested = minimalToReadable(ctx.amountMinimal, matched.decimals); } catch { return null; }
  }
  if (!hasConfirmedReadableShortfall(requested, matched.balance)) return null;
  const assetSymbol = tokenAddress === '' ? nativeTokenSymbol(ctx.chainIndex) : matched.symbol;
  const errorMessage = unsigned.executeErrorMsg !== '' ? unsigned.executeErrorMsg : undefined;
  let value;
  try {
    value = await buildFundingBundle(ctx.chainIndex, transferFundingInput(assetSymbol, tokenAddress, requested, matched.balance, undefined, errorMessage));
  } catch { return null; }
  return new FundingBlocked(value);
}

// upstream: mod.rs::has_confirmed_readable_shortfall
export function hasConfirmedReadableShortfall(requested, balance) {
  const s = readableShortfall(requested, balance);
  return s !== null && s !== '0';
}

// ── send ────────────────────────────────────────────────────────────

// upstream: mod.rs::cmd_send — minimal-amount entry (used by `wallet gas-station setup`) → data
export function cmdSend(amt, recipient, chain, from, contractToken, force, gasTokenAddress, relayerId, enableGasStation) {
  return cmdSendWithReadable(amt, undefined, recipient, chain, from, contractToken, force, gasTokenAddress, relayerId, enableGasStation);
}

// `addr_info.chain_index.parse::<u64>().unwrap_or(1)`
const chainIndexOr1 = (ci) => { const v = parseU64(ci); return v === undefined ? 1 : u64Json(v); };

// upstream: mod.rs::cmd_send_with_readable — user-facing `wallet send` (account chains) → data
export async function cmdSendWithReadable(amt, requestedReadable, recipient, chain, from, contractToken, force, gasTokenAddress, relayerId, enableGasStation) {
  validateAmount(amt);
  if (recipient === '' || chain === '') throw new Error('recipient and chain are required');
  if (some(gasTokenAddress) || enableGasStation) {
    return gasStationSend(amt, recipient, chain, from, contractToken, force, gasTokenAddress, relayerId, enableGasStation);
  }

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
  const fundingCtx = { chainIndex: chain, contractToken, amountMinimal: amt, requestedReadable };
  let unsigned;
  try {
    unsigned = await client.preTransactionUnsignedInfo(accessToken, addrInfo.chainPath, chainIndexNum, addrInfo.address, recipient, amt, contractToken,
      session.sessionCert, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, undefined, undefined);
  } catch (e) {
    const scene = await tryTransferInsufficientBalanceScene(e, fundingCtx);
    if (scene) throw scene;
    throw formatApiError(e);
  }
  const simScene = await tryTransferSimulationInsufficientBalanceScene(unsigned, fundingCtx);
  if (simScene) throw simScene;
  if (gsStatus(unsigned) === GasStationStatus.NotSupportIntention && !hasSignMaterial(unsigned)) throw gsNotSupportedErr(addrInfo.address);

  if (unsigned.gasStationUsed) {
    if (unsigned.hasPendingTx) return emitGsPendingTxState();
    if (unsigned.insufficientAll) return emitGsInsufficientAllState(unsigned, addrInfo.address);
    if (unsigned.hash !== '' || unsigned.eip712MessageHash !== '' || unsigned.unsignedTxHash !== '') {
      return handleGsAutoSignBroadcast(client, accessToken, accountId, addrInfo, session, unsigned, force, recipient, amt, contractToken);
    }
    const decision = classifyGsPhase1(unsigned);
    switch (decision.kind) {
      case 'FirstTime':
        if (force) throw forceSetupRequiredForSend(false, chain, from, recipient, amt, contractToken, addrInfo, unsigned);
        throw buildGsFirstTimePrompt(addrInfo, unsigned);
      case 'Reenable':
        if (force) throw forceSetupRequiredForSend(true, chain, from, recipient, amt, contractToken, addrInfo, unsigned);
        throw buildGsReenablePrompt(addrInfo, unsigned);
      case 'AutoPick':
        return gasStationSend(amt, recipient, chain, from, contractToken, force, decision.feeTokenAddress, decision.relayerId, decision.needsEnable);
      default:
        throw buildGsTokenSelectionPrompt(unsigned);
    }
  }

  const resp = await signAndBroadcast(chain, from, txParams({ toAddr: recipient, value: amt, contractAddr: contractToken }),
    false, false, force, undefined, 'transfer', undefined);
  return { txHash: resp.txHash, orderId: resp.orderId };
}

// ── contract-call ───────────────────────────────────────────────────

// upstream: mod.rs::cmd_contract_call → data {orderId, txHash}
export async function cmdContractCall(to, chain, amt, inputData, unsignedTx, gasLimit, from, aaDexTokenAddr, aaDexTokenAmount, mevProtection,
  jitoUnsignedTx, force, gasTokenAddress, relayerId, enableGasStation, bizType, strategy) {
  const resp = await executeContractCall(to, chain, amt, inputData, unsignedTx, gasLimit, from, aaDexTokenAddr, aaDexTokenAmount, mevProtection,
    jitoUnsignedTx, force, undefined, gasTokenAddress, relayerId, enableGasStation, bizType, strategy);
  return { txHash: resp.txHash, orderId: resp.orderId };
}

// upstream: mod.rs::execute_contract_call → BroadcastResponse (also used by swap / cross-chain)
export async function executeContractCall(to, chain, amt, inputData, unsignedTx, gasLimit, from, aaDexTokenAddr, aaDexTokenAmount, mevProtection,
  jitoUnsignedTx, force, txSource, gasTokenAddress, relayerId, enableGasStation, agentBizType, agentSkillName) {
  if (to === '' || chain === '') throw new Error('to and chain are required');
  validateNonNegativeInteger(amt, 'amt');
  if (!some(inputData) && !some(unsignedTx)) throw new Error('either --input-data (EVM) or --unsigned-tx (SOL) is required');
  return signAndBroadcast(chain, from, txParams({
    toAddr: to, value: amt, contractAddr: to, inputData, unsignedTx, gasLimit, aaDexTokenAddr, aaDexTokenAmount, jitoUnsignedTx,
    gasTokenAddress, relayerId, enableGasStation,
  }), true, mevProtection, force, txSource, agentBizType, agentSkillName);
}
