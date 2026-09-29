// Buyer create-and-broadcast protocol for a subscription task — upstream
// task/user/v2/create_subscription.rs (called by `agent create-subscribe`). FUNDS.
import { context } from '../../../../core/errors.mjs';
import { get, asStr, asBool, isObject } from '../../../../core/rs/value.mjs';
import { trim } from '../../../../core/rs/str.mjs';
import * as signing from '../../signing.mjs';
import { bindJobProviderToCurrentRuntime } from '../../common/a2a-binding.mjs';
import { abortPreparedConsent } from '../../common/autotrade/guide.mjs';
import { copyAttachmentsToJobWithManifest } from '../flow-lifecycle/_peers.mjs';
// upstream keeps a private copy of create_subscribe.rs::SUBSCRIBE_API_PREFIX here; lite has one definition.
import { SUBSCRIBE_API_PREFIX } from '../create-subscribe.mjs';

const CREATE_SUBSCRIPTION_BIZ_TYPE = 204;

// upstream: create_subscription.rs::build_confirm_body (json! → sorted)
export const buildConfirmBody = (input) => ({
  serviceId: input.serviceId, autoRenew: input.autoRenew, useTrial: input.useTrial, subId: 0, providerAgentId: input.providerAgentId,
});

// upstream: create_subscription.rs::parse_confirmation → [terms, typedData, effectiveUseTrial]
export function parseConfirmation(value, requestedUseTrial) {
  if (!isObject(value) || Object.keys(value).length === 0) throw new Error('providerConfirmStatus returned empty terms; the service may not support subscription');
  const typedData = get(value, 'typedData');
  if (!isObject(typedData) || Object.keys(typedData).length === 0) throw new Error('providerConfirmStatus response missing typedData');
  const terms = { ...value };
  delete terms.typedData;
  const effective = asBool(get(value, 'useTrial')) ?? requestedUseTrial;
  return [terms, typedData, effective];
}

// upstream: create_subscription.rs::build_create_body (json! → sorted)
export const buildCreateBody = (input, effectiveUseTrial, terms, termsSig) => ({
  serviceId: input.serviceId, useTrial: effectiveUseTrial, providerAgentId: input.providerAgentId, serviceInterval: input.serviceInterval,
  serviceParams: input.serviceParams, deviceList: null, serviceTokenAmount: input.serviceTokenAmount, serviceTokenAddress: input.serviceTokenAddress,
  autoRenew: input.autoRenew, title: input.title, description: input.description, terms, termsSig,
});

// upstream: create_subscription.rs::validate_create_response → [jobId, bizType]
export function validateCreateResponse(value) {
  const raw = asStr(get(value, 'jobId'));
  const jobId = raw === undefined ? '' : trim(raw);
  if (jobId === '') throw new Error('createSubscription response missing jobId');
  if (get(value, 'uopData') === undefined || get(value, 'uopData') === null) throw new Error('createSubscription response missing uopData');
  const bizType = signing.extractBizType(value);
  if (Number(bizType) !== CREATE_SUBSCRIPTION_BIZ_TYPE) throw new Error(`unexpected bizType ${bizType}; expected ${CREATE_SUBSCRIPTION_BIZ_TYPE}`);
  return [jobId, bizType];
}

// upstream: create_subscription.rs::execute → { jobId, effectiveUseTrial, broadcast, attachments }
// input: { serviceId, useTrial, serviceParams, serviceTokenAmount, serviceTokenAddress, autoRenew, title, description,
//          providerAgentId, serviceInterval, attachments }
export async function execute(client, input, accountId, address, userAgentId, establishLocalReadiness) {
  let confirmation;
  try { confirmation = await client.postWithIdentity(`${SUBSCRIBE_API_PREFIX}/providerConfirmStatus`, buildConfirmBody(input), userAgentId); } catch (e) {
    throw context('providerConfirmStatus failed', e);
  }
  const [terms, typedData, effectiveUseTrial] = parseConfirmation(confirmation, input.useTrial);
  let termsSig;
  try { termsSig = await signing.signTypedData(typedData, address); } catch (e) { throw context('EIP-712 subscription terms signing failed', e); }
  const body = buildCreateBody(input, effectiveUseTrial, terms, termsSig);
  let response;
  try { response = await client.postMutationWithIdentity(`${SUBSCRIBE_API_PREFIX}/createSubscription`, body, userAgentId); } catch (e) {
    throw context('createSubscription failed or returned an unknown network result', e);
  }
  const [jobId, bizType] = validateCreateResponse(response);
  const attachments = await copyAttachmentsToJobWithManifest(jobId, input.attachments ?? []);
  try { await establishLocalReadiness(jobId); } catch (e) { throw context('subscription local execution configuration could not be persisted', e); }
  const prebind = await bindJobProviderToCurrentRuntime(jobId);
  let broadcast;
  try {
    broadcast = await signing.signUopAndBroadcastFull(client, get(response, 'uopData'), accountId, address, jobId, bizType, userAgentId, undefined);
  } catch (e) {
    if (prebind) await prebind.rollbackIfCreated();
    abortPreparedConsent(jobId);
    throw context(`broadcast failed or returned an unknown result for jobId=${jobId}`, e);
  }
  if (broadcast === null || broadcast === undefined) {
    if (prebind) await prebind.rollbackIfCreated();
    abortPreparedConsent(jobId);
    throw new Error(`broadcast returned no receipt for jobId=${jobId}`);
  }
  return { jobId, effectiveUseTrial, broadcast, attachments };
}

// upstream: v2/mod.rs `execute as execute_create_subscription`
export { execute as executeCreateSubscription };
