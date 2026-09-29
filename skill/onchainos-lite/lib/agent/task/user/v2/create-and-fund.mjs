// Buyer create-and-fund protocol for a one-time A2A task — upstream
// task/user/v2/create_and_fund.rs (called by `agent create-task`). FUNDS.
import { context } from '../../../../core/errors.mjs';
import { f64 } from '../../../../core/json.mjs';
import { auditLog } from '../../../../core/audit.mjs';
import { get, asStr, asI64, asU64 } from '../../../../core/rs/value.mjs';
import { trim } from '../../../../core/rs/str.mjs';
import { parseI64, parseU64 } from '../../../../core/rs/num.mjs';
import { utcRfc3339, parseFromRfc3339 } from '../../../../core/rs/time.mjs';
import * as signing from '../../signing.mjs';
import { bindJobProviderToCurrentRuntimeRequired } from '../../common/a2a-binding.mjs';
import { abortPreparedConsent } from '../../common/autotrade/guide.mjs';
import { copyAttachmentsToJobWithManifest } from '../flow-lifecycle/_peers.mjs';

const CREATE_AND_FUND_BIZ_TYPE = 201;

// upstream: create_and_fund.rs::build_confirm_body (json! → sorted)
export const buildConfirmBody = (input) => ({
  providerAgentId: input.providerAgentId, tokenSymbol: input.tokenSymbol, amount: input.amount, chainId: input.chainId, serviceId: input.serviceId,
});

// upstream: create_and_fund.rs::required_string
function requiredString(value, name) {
  const s = asStr(get(value, name));
  const t = s === undefined ? '' : trim(s);
  if (t === '') throw new Error(`createAndFundConfirmStatus response missing ${name}`);
  return t;
}
// upstream: create_and_fund.rs::required_u64
function requiredU64(value, name) {
  const v = get(value, name);
  const n = asU64(v) ?? (asStr(v) === undefined ? undefined : parseU64(asStr(v)));
  if (n === undefined) throw new Error(`createAndFundConfirmStatus response missing or invalid ${name}`);
  return n;
}
// upstream: create_and_fund.rs::normalize_expired_at → RFC 3339 text
export function normalizeExpiredAt(value) {
  const ts = asI64(value) ?? (asStr(value) === undefined ? undefined : parseI64(asStr(value)));
  if (ts !== undefined) {
    const r = utcRfc3339(ts);
    if (r === undefined) throw new Error(`invalid expiredAt: ${ts}`);
    return r;
  }
  const s = asStr(value);
  if (s !== undefined) { try { parseFromRfc3339(s); return s; } catch {} }
  throw new Error('createAndFundConfirmStatus response missing or invalid expiredAt');
}

// upstream: create_and_fund.rs::parse_confirmation → ConfirmContext
export function parseConfirmation(value) {
  return {
    jobId: requiredString(value, 'jobId'), taskSalt: requiredString(value, 'taskSalt'), provider: requiredString(value, 'provider'),
    receiver: requiredString(value, 'receiver'), evaluator: requiredString(value, 'evaluator'), currency: requiredString(value, 'currency'),
    recipient: requiredString(value, 'recipient'), amount: requiredString(value, 'amount'), submitWindow: requiredU64(value, 'submitWindow'),
    disputeWindow: requiredU64(value, 'disputeWindow'), evaluateWindow: requiredU64(value, 'evaluateWindow'),
    completedWindow: requiredU64(value, 'completedWindow'), hook: requiredString(value, 'hook'), hookData: requiredString(value, 'hookData'),
    salt: requiredString(value, 'salt'), expiredAt: normalizeExpiredAt(get(value, 'expiredAt') ?? null),
  };
}

const parseSignedU64 = (s, label) => {
  const n = parseU64(String(s));
  if (n === undefined) throw context(label, new Error(String(s) === '' ? 'cannot parse integer from empty string' : 'invalid digit found in string'));
  return n;
};

// upstream: create_and_fund.rs::build_create_and_fund_body (json! → sorted)
export function buildCreateAndFundBody(input, confirmation, signature, validAfter, validBefore) {
  const body = {
    visibility: input.visibility, jobId: confirmation.jobId, taskSalt: confirmation.taskSalt, signature,
    validAfter: parseSignedU64(validAfter, 'invalid signed validAfter'), validBefore: parseSignedU64(validBefore, 'invalid signed validBefore'),
    title: input.title, description: input.description, paymentTokenSymbol: input.tokenSymbol, paymentTokenAmount: input.amount,
    chainId: input.chainId, providerAgentId: input.providerAgentId, serviceId: input.serviceId, serviceParams: input.serviceParams,
    serviceTokenAddress: input.serviceTokenAddress, serviceTokenAmount: input.serviceTokenAmount,
  };
  if (input.descriptionSummary !== undefined && input.descriptionSummary !== null) body.descriptionSummary = input.descriptionSummary;
  if (input.categoryCode !== undefined && input.categoryCode !== null) body.categoryCode = input.categoryCode;
  if (input.minCreditScore !== undefined && input.minCreditScore !== null) body.minCreditScore = f64(input.minCreditScore);
  return body;
}

// upstream: create_and_fund.rs::validate_create_response → [jobId, bizType]
export function validateCreateResponse(expectedJobId, value) {
  const jobId = asStr(get(value, 'jobId'));
  if (jobId === undefined || jobId === '') throw new Error('createAndFund response missing jobId');
  if (jobId !== expectedJobId) throw new Error(`createAndFund returned jobId ${jobId}, expected ${expectedJobId}`);
  if (get(value, 'uopData') === undefined || get(value, 'uopData') === null) throw new Error('createAndFund response missing uopData');
  const bizType = signing.extractBizType(value);
  if (Number(bizType) !== CREATE_AND_FUND_BIZ_TYPE) throw new Error(`unexpected bizType ${bizType}; expected ${CREATE_AND_FUND_BIZ_TYPE}`);
  return [jobId, bizType];
}

// upstream: create_and_fund.rs::execute → CreationReceipt { jobId, broadcast, attachments }
// input: { title, description, descriptionSummary, tokenSymbol, amount, providerAgentId, serviceId, serviceParams,
//          serviceTokenAddress, serviceTokenAmount, categoryCode, minCreditScore, visibility, chainId, attachments }
export async function execute(client, input, accountId, address, userAgentId, establishLocalReadiness) {
  let confirmationValue;
  try { confirmationValue = await client.postWithIdentity('/priapi/v1/aieco/task/createAndFundConfirmStatus', buildConfirmBody(input), userAgentId); } catch (e) {
    throw context('createAndFundConfirmStatus failed', e);
  }
  const confirmation = parseConfirmation(confirmationValue);
  auditLog('cli', 'user/task_create_and_fund_confirmed', true, 0, [`jobId=${confirmation.jobId}`, `agentId=${userAgentId}`,
    `providerAgentId=${input.providerAgentId}`, `serviceId=${input.serviceId}`]);
  const { signEscrow } = await import('../../../../payment/a2a-pay.mjs');
  let authorization;
  try {
    authorization = await signEscrow({
      chainId: input.chainId, provider: confirmation.hook, receiver: confirmation.receiver, arbitrator: confirmation.evaluator,
      currency: confirmation.currency, escrowContract: confirmation.recipient, amount: confirmation.amount, submitWindow: confirmation.submitWindow,
      disputeWindow: confirmation.disputeWindow, arbitrationWindow: confirmation.evaluateWindow, terminationWindow: confirmation.completedWindow,
      hook: confirmation.hook, hookData: confirmation.hookData, salt: confirmation.salt, expiredAt: confirmation.expiredAt,
    });
  } catch (e) { throw context('EIP-3009 create-and-fund signing failed', e); }
  const body = buildCreateAndFundBody(input, confirmation, authorization.signature, authorization.authorization.validAfter, authorization.authorization.validBefore);
  let response;
  try { response = await client.postMutationWithIdentity('/priapi/v1/aieco/task/createAndFund', body, userAgentId); } catch (e) {
    throw context(`createAndFund failed or returned an unknown network result for jobId=${confirmation.jobId}`, e);
  }
  const [jobId, bizType] = validateCreateResponse(confirmation.jobId, response);
  const attachments = await copyAttachmentsToJobWithManifest(jobId, input.attachments ?? []);
  try { await establishLocalReadiness(jobId); } catch (e) { throw context('task local Guide/Consent configuration could not be persisted', e); }
  let prebind;
  try { prebind = await bindJobProviderToCurrentRuntimeRequired(jobId); } catch (e) {
    abortPreparedConsent(jobId);
    throw context('cannot bind task to the current AI runtime; creation was not broadcast', e);
  }
  let broadcast;
  try {
    broadcast = await signing.signUopAndBroadcastFull(client, get(response, 'uopData'), accountId, address, jobId, bizType, userAgentId, undefined);
  } catch (e) {
    await prebind.rollbackIfCreated();
    abortPreparedConsent(jobId);
    throw context(`broadcast failed or returned an unknown result for jobId=${jobId}`, e);
  }
  if (broadcast === null || broadcast === undefined) {
    await prebind.rollbackIfCreated();
    abortPreparedConsent(jobId);
    throw new Error('broadcast returned no receipt');
  }
  return { jobId, broadcast, attachments };
}
