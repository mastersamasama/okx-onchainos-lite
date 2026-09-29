// Confirm-accept + fund — upstream task/user/accept.rs (`set-payment-mode`, `confirm-accept`).
import { FundingBlocked } from '../../../core/errors.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import * as out from '../../../core/output.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { signEscrow } from '../../../payment/a2a-pay.mjs';
import { at, asStr, asI64 } from '../../../core/rs/value.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { utcRfc3339 } from '../../../core/rs/time.mjs';
import { PaymentMode, XLAYER_CHAIN_ID, ensureSufficientBalance } from '../common/index.mjs';
import { jsonStr, jsonU64 } from '../common/util.mjs';
import { Status } from '../common/state-machine.mjs';
import { balanceWarningJson } from '../common/deposit-qr.mjs';
import { fundingBlockedEnvelope } from '../common/funding-notice.mjs';
import {
  resolveWalletAndAgentForTask, resolveWallet, signUopAndBroadcast, signUopAndBroadcastWithPayment, extractBizType,
} from '../signing.mjs';
import { findInsufficientBalance } from './create.mjs';
import * as negotiate from './negotiate.mjs';

// `payment_mode as i32` of a task field (i64 → i32 wrap).
const i32 = (v) => Number(BigInt.asIntN(32, BigInt(v ?? 0)));
// Rust `str.parse::<f64>().unwrap_or(0.0)`
const f64Or0 = (s) => { try { return parseRustF64(s); } catch { return 0; } };

// upstream: accept.rs::resolve_symbol_and_amount (private)
function resolveSymbolAndAmount(tokenSymbol, tokenAmount, modeLabel) {
  if (tokenSymbol === undefined || tokenSymbol === null) throw new Error(`${modeLabel} requires --token-symbol`);
  if (tokenAmount === undefined || tokenAmount === null) throw new Error(`${modeLabel} requires --token-amount`);
  return [String(tokenSymbol), String(tokenAmount)];
}

// upstream: accept.rs::fetch_provider_confirm_status (private) — query values are not URL-encoded.
async function fetchProviderConfirmStatus(client, jobId, providerAgentId, tokenSymbol, amount, agentId) {
  const path = `/priapi/v1/aieco/task/${jobId}/providerConfirmStatus?providerAgentId=${providerAgentId}&tokenSymbol=${tokenSymbol}&amount=${amount}`;
  try { return await client.getWithAgentId(path, agentId); } catch (e) { throw new Error(`providerConfirmStatus query failed: ${displayTop(e)}`); }
}

// upstream: accept.rs::print_payment_funding_block_from_error (private) → throws
async function paymentFundingBlockFromError(err, agentId, action) {
  const ib = findInsufficientBalance(err);
  if (!ib) throw err;
  const [warning] = await balanceWarningJson(ib, agentId);
  throw new FundingBlocked(fundingBlockedEnvelope(warning, 'task-payment', action));
}

// upstream: accept.rs::handle_set_payment_mode — prints its own output (exit 0 on both paths).
export async function handleSetPaymentMode(client, jobId, paymentMode, tokenSymbol, tokenAmount) {
  const [accountId, address, agentId] = await resolveWalletAndAgentForTask(client, jobId, undefined);
  const taskResp = await client.getWithIdentity(client.taskPath(jobId), agentId);
  const taskStatus = Status.fromInt(i32(asI64(at(taskResp, 'status')) ?? -1));
  if (taskStatus !== Status.Created) {
    throw new Error(`current task status is ${statusDebug(taskStatus)}; setting the payment mode is only allowed in \`created\` status`);
  }
  const explicit = paymentMode !== undefined && paymentMode !== null;
  let mode;
  if (explicit) mode = PaymentMode.fromStr(paymentMode);
  else {
    const m = PaymentMode.fromInt(i32(asI64(at(taskResp, 'paymentMode')) ?? 0));
    mode = m === PaymentMode.None ? PaymentMode.Escrow : m;
  }
  if (mode === PaymentMode.X402) throw new Error('legacy task-based A2MCP/x402 payment was removed; use the invoke_a2mcp direct-invocation flow');
  const current = PaymentMode.fromInt(i32(asI64(at(taskResp, 'paymentMode')) ?? 0));
  const alreadySet = explicit && current === mode && current !== PaymentMode.None;

  const [sym, amtStr] = resolveSymbolAndAmount(tokenSymbol, tokenAmount, 'set-payment-mode');
  const amt = f64Or0(amtStr);
  if (amt > 0) {
    try { await ensureSufficientBalance(amt, sym); } catch (e) { await paymentFundingBlockFromError(e, agentId, 'Payment mode update'); }
  }

  if (!alreadySet) {
    const resp = await client.postWithIdentity(client.endpoint(jobId, 'setPaymentMode'), { paymentMode: PaymentMode.asInt(mode) }, agentId);
    const txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
    auditLog('cli', 'user/payment_mode_set', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `paymentMode=${PaymentMode.asStr(mode)}`, `txHash=${txHash}`]);
  } else {
    auditLog('cli', 'user/payment_mode_already_set', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `paymentMode=${PaymentMode.asStr(mode)}`]);
  }
  const modeStr = PaymentMode.asStr(mode);
  if (alreadySet) {
    process.stdout.write(`✓ Payment mode is already ${modeStr}; skipping on-chain call.\n`);
    out.success({
      alreadySet: true, paymentMode: modeStr,
      next: 'Payment mode already on-chain. Call next-action with `event=job_payment_mode_changed` in --message to get the script; then wait for the provider to submit their apply on-chain before confirm-accept.',
    });
  } else {
    process.stdout.write(`✓ Payment mode set to ${modeStr}; awaiting on-chain confirmation...\n`);
    out.confirming(`setPaymentMode(${modeStr}) complete.`, 'Wait for the on-chain confirmation, then the system will proceed automatically.');
  }
}

// Rust `{:?}` of state_machine::Status (variant names; Other("status_n")).
function statusDebug(st) {
  const names = { init: 'Init', created: 'Created', accepted: 'Accepted', submitted: 'Submitted', rejected: 'Rejected', disputed: 'Disputed',
    admin_stopped: 'AdminStopped', completed: 'Completed', close: 'Close', expired: 'Expired', failed: 'Failed' };
  return names[st] ?? `Other(${JSON.stringify(st)})`;
}

// upstream: accept.rs::handle_confirm_accept — `prefetched` (PreFetchedTaskContext) skips the task GETs.
export async function handleConfirmAccept(client, jobId, prefetched) {
  let accountId, address, agentId, provider, tokenSymbol, tokenAmount, paymentMode, tokenAddress;
  if (prefetched) {
    const userAddr = prefetched.userAgentAddress;
    if (userAddr === undefined || userAddr === null) throw new Error('prefetched missing buyerAgentAddress');
    if (prefetched.userAgentId === undefined || prefetched.userAgentId === null) throw new Error('prefetched missing buyerAgentId');
    agentId = prefetched.userAgentId;
    [accountId, address] = await resolveWallet(undefined, userAddr);
    provider = prefetched.providerAgentId;
    if (provider === undefined || provider === null || provider === '') throw new Error(`task ${jobId} has no providerAgentId; cannot confirm-accept`);
    if (prefetched.tokenSymbol === '?' || prefetched.tokenSymbol === '') throw new Error(`task ${jobId} has no tokenSymbol`);
    tokenSymbol = prefetched.tokenSymbol;
    if (prefetched.tokenAmount === '') throw new Error(`task ${jobId} has no tokenAmount`);
    tokenAmount = prefetched.tokenAmount;
    paymentMode = PaymentMode.fromInt(i32(prefetched.paymentMode ?? 0));
    tokenAddress = prefetched.tokenAddress ?? undefined;
  } else {
    [accountId, address, agentId] = await resolveWalletAndAgentForTask(client, jobId, undefined);
    const taskResp = await client.getWithIdentity(client.taskPath(jobId), agentId);
    const nonEmpty = (k) => { const s = asStr(at(taskResp, k)); return s === undefined || s === '' ? undefined : s; };
    provider = nonEmpty('providerAgentId');
    if (provider === undefined) throw new Error(`task ${jobId} has no providerAgentId; cannot confirm-accept`);
    tokenSymbol = nonEmpty('tokenSymbol');
    if (tokenSymbol === undefined) throw new Error(`task ${jobId} has no tokenSymbol`);
    tokenAmount = nonEmpty('tokenAmount');
    if (tokenAmount === undefined) throw new Error(`task ${jobId} has no tokenAmount`);
    paymentMode = PaymentMode.fromInt(i32(asI64(at(taskResp, 'paymentMode')) ?? 0));
    tokenAddress = asStr(at(taskResp, 'tokenAddress'));
  }

  if (paymentMode === PaymentMode.None) {
    throw new Error(`task has no payment mode set yet (paymentMode=0); first run:\n  onchainos agent set-payment-mode ${jobId} --payment-mode escrow --token-symbol <sym> --token-amount <amt>\nthen wait for the job_payment_mode_changed system notification and re-run confirm-accept`);
  }
  if (paymentMode !== PaymentMode.Escrow) throw new Error('confirm-accept only supports A2A escrow; legacy task-based A2MCP/x402 payment was removed');

  const amt = f64Or0(tokenAmount);
  if (amt > 0) {
    try { await ensureSufficientBalance(amt, tokenSymbol); } catch (e) { await paymentFundingBlockFromError(e, agentId, 'Task payment'); }
  }
  await confirmAcceptEscrow(client, jobId, provider, tokenSymbol, tokenAmount, accountId, address, agentId, tokenAddress);
  try { negotiate.cleanup(jobId); } catch {}
}

// upstream: accept.rs::confirm_accept_escrow (private)
async function confirmAcceptEscrow(client, jobId, provider, tokenSymbol, tokenAmount, accountId, address, agentId, prefetchedTokenAddress) {
  const [symbol, amount] = resolveSymbolAndAmount(tokenSymbol, tokenAmount, 'escrow');
  const confirm = await fetchProviderConfirmStatus(client, jobId, provider, symbol, amount, agentId);
  const amountMinimal = asStr(at(confirm, 'amount'));
  if (amountMinimal === undefined) throw new Error('providerConfirmStatus response missing `amount`');
  const currency = asStr(at(confirm, 'currency'));
  if (currency === undefined) throw new Error('providerConfirmStatus response missing `currency`');

  let taskTokenAddress;
  if (prefetchedTokenAddress !== undefined && prefetchedTokenAddress !== null) taskTokenAddress = prefetchedTokenAddress.toLowerCase();
  else {
    const taskResp = await client.getWithIdentity(client.taskPath(jobId), agentId);
    taskTokenAddress = (asStr(at(taskResp, 'tokenAddress')) ?? '').toLowerCase();
  }
  if (taskTokenAddress !== '' && currency.toLowerCase() !== taskTokenAddress) {
    throw new Error(`token mismatch: providerConfirmStatus returned currency=${currency} but task tokenAddress=${taskTokenAddress}. Please check that the negotiated token matches the task's published token (--token-symbol).`);
  }

  const escrow = at(confirm, 'escrow');
  const escrowContract = jsonStr(escrow, 'escrowContract');
  const providerAddr = jsonStr(escrow, 'provider');
  const arbitrator = jsonStr(escrow, 'arbitrator');
  const receiver = jsonStr(escrow, 'receiver');
  const submitWindow = jsonU64(escrow, 'submitWindow');
  const disputeWindow = jsonU64(escrow, 'disputeWindow');
  const arbitrationWindow = jsonU64(escrow, 'arbitrationWindow');
  const terminationWindow = jsonU64(escrow, 'terminationWindow');
  const expiredAtRaw = jsonStr(escrow, 'expiredAt');
  const ts = parseI64(expiredAtRaw);
  let expiredAt = expiredAtRaw;
  if (ts !== undefined) {
    expiredAt = utcRfc3339(ts);
    if (expiredAt === undefined) throw new Error(`expiredAt unix timestamp is invalid: ${expiredAtRaw}`);
  }
  const hook = jsonStr(escrow, 'hook');
  const hookData = jsonStr(escrow, 'hookData');
  const salt = jsonStr(escrow, 'salt');

  const sign = await signEscrow({
    chainId: XLAYER_CHAIN_ID, provider: providerAddr, receiver, arbitrator, currency, escrowContract, amount: amountMinimal,
    submitWindow, disputeWindow, arbitrationWindow, terminationWindow, hook, hookData, salt, expiredAt,
  });
  const body = {
    providerAddress: providerAddr, providerAgentId: provider,
    signatureData: { signature: sign.signature, validAfter: sign.authorization.validAfter, validBefore: sign.authorization.validBefore },
    tokenSymbol: symbol, tokenAmount: amount,
  };
  const resp = await client.postWithIdentity(client.endpoint(jobId, 'accept'), body, agentId);
  const paymentVerify = {
    authorizationType: 'receive', from: sign.authorization.from, to: sign.authorization.to, value: sign.authorization.value,
    validAfter: sign.authorization.validAfter, validBefore: sign.authorization.validBefore, nonce: sign.authorization.nonce,
    signature: sign.signature, tokenAddress: currency, chainIndex: XLAYER_CHAIN_ID,
  };
  const txHash = await signUopAndBroadcastWithPayment(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, paymentVerify);
  auditLog('cli', 'user/confirm_accept_completed', true, 0, [
    `jobId=${jobId}`, `agentId=${agentId}`, `provider=${provider}`, 'paymentMode=escrow', `tokenSymbol=${symbol}`, `tokenAmount=${amount}`, `txHash=${txHash}`,
  ]);
}

