// Create a subscription task — upstream task/user/create_subscribe.rs.
// Flow: providerConfirmStatus → EIP-712 sign terms → createSubscription → local readiness → broadcast(bizType=204).
import { DuplicateSubscription } from '../../../core/errors.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { get, asStr } from '../../../core/rs/value.mjs';
import { charCount, trim } from '../../../core/rs/str.mjs';
import { ensureSufficientBalance, XLAYER_CHAIN_INDEX } from '../common/index.mjs';
import { resolveTokenSymbolByAddress } from '../common/util.mjs';
import { resolveCurrentDepositInfo } from '../common/deposit-qr.mjs';
import { selectSubscriptionAgentId } from '../common/subscription-identity.mjs';
import { probeOfflineReplayCapability, fixCommandsOrDefault } from '../common/okx-a2a.mjs';
import { resolveWalletByAgentId } from '../signing.mjs';
import { validateAttachmentSources } from './attachments.mjs';
import {
  resolveUserAgent, requireFreshSessionWithCert, buildTaskCreationFundingResult, parseGuideConsentValues, prepareGuideConsent, findInsufficientBalance,
} from './create.mjs';
import { execute as executeCreateSubscription } from './v2/create-subscription.mjs';
import { fetchActiveBuyerSubscriptionsForAgent, existingSubscriptionForService, existingSubscriptionValue } from './subscription-ops.mjs';
import * as guide from '../common/autotrade/guide.mjs';
import { ExecutionMode, executionMode } from '../common/autotrade/subscription-config.mjs';

// upstream: create_subscribe.rs::SUBSCRIBE_API_PREFIX
export const SUBSCRIBE_API_PREFIX = '/priapi/v1/aieco/task/subscribe';
const MAX_TITLE_CHARS = 30;
const MAX_DESCRIPTION_CHARS = 4096;

// upstream: CreateSubscribeParams::validated_guide_consent (private)
function validatedGuideConsent(p) {
  const draft = guide.parseDraft(p.serviceGuide, p.serviceGuideHash);
  if (draft === undefined || draft === null) {
    if (p.serviceGuideHash !== undefined || p.guideConsentJson !== undefined) throw new Error('guide-driven signal execution requires --service-guide');
    return undefined;
  }
  if (p.guideConsentJson === undefined) throw new Error('guide-driven signal execution requires --guide-consent-json, including {} when the Guide declares no consent fields');
  const consentValues = parseGuideConsentValues(p.guideConsentJson);
  guide.validateConsentValues(consentValues);
  return { draft, consentValues };
}

// upstream: CreateSubscribeParams::validate (private) → guide consent | undefined
export function validateCreateSubscribeParams(p) {
  if (p.serviceId === '') throw new Error('--service-id is required');
  if (p.serviceTokenAmount === '') throw new Error('--service-token-amount is required');
  if (p.serviceTokenAddress === '') throw new Error('--service-token-address is required');
  if (p.autoRenew !== 0 && p.autoRenew !== 1) throw new Error(`--auto-renew must be 0 (off) or 1 (on), got ${p.autoRenew}`);
  if (trim(p.providerAgentId) === '') throw new Error('--provider-agent-id is required; use the confirmed Service result unchanged');
  if (p.title === '') throw new Error('--title is required');
  if (charCount(p.title) > MAX_TITLE_CHARS) throw new Error(`--title exceeds ${MAX_TITLE_CHARS} characters`);
  if (p.description === '') throw new Error('--description is required');
  if (charCount(p.description) > MAX_DESCRIPTION_CHARS) throw new Error(`--description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  validateAttachmentSources(p.attachments ?? []);
  return validatedGuideConsent(p);
}

// upstream: create_subscribe.rs::require_subscription_execution_mode (private)
function requireSubscriptionExecutionMode(userAgentId, serviceId) {
  const mode = executionMode(userAgentId, serviceId);
  if (mode === undefined || mode === null) {
    throw new Error('subscription execution configuration is required; based on the Service Guide, save signal_only for pure signals or guide_direct for automatic copy-trading before create-subscribe');
  }
  return mode;
}

// upstream: create_subscribe.rs::build_duplicate_subscription_block (json! → sorted)
export function buildDuplicateSubscriptionBlock(serviceId, existing) {
  const base = `Service ${serviceId} already has a subscription task, jobId: ${existing.jobId}. It cannot be created again.`;
  const block = {
    blockedReason: 'duplicate-subscription',
    userFacingPrompt: existing.restoreListeningAvailable ? `${base} Would you like to restore listening?` : base,
    existingSubscription: existingSubscriptionValue(existing),
  };
  if (existing.restoreListeningAvailable) block.nextAfterUserChoice = ['restore-listening'];
  return block;
}

// upstream: create_subscribe.rs::subscribe_balance_shortfall (private) → InsufficientBalanceError | undefined
async function subscribeBalanceShortfall(serviceTokenAmount, serviceTokenAddress) {
  let required;
  try { required = parseRustF64(serviceTokenAmount); } catch { required = 0; }
  if (required <= 0) return undefined;
  let symbol;
  try { symbol = await resolveTokenSymbolByAddress(XLAYER_CHAIN_INDEX, serviceTokenAddress); } catch { return undefined; }
  try { await ensureSufficientBalance(required, symbol); } catch (e) {
    const insufficient = findInsufficientBalance(e);
    if (insufficient) return insufficient;
    throw e;
  }
  return undefined;
}

// upstream: create_subscribe.rs::handle_create_subscribe → success data
export async function handleCreateSubscribe(client, params) {
  const guideConsent = validateCreateSubscribeParams(params);
  await requireFreshSessionWithCert('create-subscribe');
  const [resolved] = await resolveUserAgent();
  const userAgentId = selectSubscriptionAgentId(resolved, '');

  const mode = requireSubscriptionExecutionMode(userAgentId, params.serviceId);
  if (mode === ExecutionMode.GuideDirect && guideConsent === undefined) {
    throw new Error('automatic copy-trading requires --service-guide and --guide-consent-json before create-subscribe');
  }

  const existing = existingSubscriptionForService(await fetchActiveBuyerSubscriptionsForAgent(client, userAgentId), params.serviceId);
  if (existing) throw new DuplicateSubscription(buildDuplicateSubscriptionBlock(params.serviceId, existing));

  const insufficient = await subscribeBalanceShortfall(params.serviceTokenAmount, params.serviceTokenAddress);
  if (insufficient) {
    const deposit = await resolveCurrentDepositInfo(userAgentId);
    if (!deposit) throw new Error('failed to resolve the funding address');
    return buildTaskCreationFundingResult(insufficient, deposit, params.serviceTokenAddress);
  }

  const [accountId, address] = await resolveWalletByAgentId(userAgentId);
  const receipt = await executeCreateSubscription(client, {
    serviceId: params.serviceId, useTrial: params.useTrial, serviceParams: params.serviceParams, serviceTokenAmount: params.serviceTokenAmount,
    serviceTokenAddress: params.serviceTokenAddress, autoRenew: params.autoRenew, title: params.title, description: params.description,
    providerAgentId: params.providerAgentId, serviceInterval: params.serviceInterval, attachments: params.attachments ?? [],
  }, accountId, address, userAgentId, (jobId) => {
    if (guideConsent) prepareGuideConsent(jobId, params.serviceId, params.providerAgentId, guideConsent);
  });

  const offlineReplay = await probeOfflineReplayCapability();
  const txHash = asStr(get(receipt.broadcast, 'txHash')) ?? 'pending';
  let active = false;
  if (guideConsent) {
    try { guide.activatePreparedConsent(receipt.jobId); active = true; } catch (e) {
      process.stderr.write(`[guide-execution] subscription created, but Guide Consent could not be activated: ${displayTop(e)}\n`);
    }
  }
  const status = active ? 'active' : 'none';
  auditLog('cli', 'user/create_subscribe', true, 0, [
    `jobId=${receipt.jobId}`, `agentId=${userAgentId}`, `serviceId=${params.serviceId}`, `useTrial=${receipt.effectiveUseTrial}`,
    `autoRenew=${params.autoRenew}`, 'bizType=204', `guideStatus=${status}`, `consentStatus=${status}`, `txHash=${txHash}`,
  ]);
  const payload = {
    jobId: receipt.jobId, type: 204, bizType: 204, status: 'broadcast_submitted', providerAgentId: params.providerAgentId, serviceId: params.serviceId,
    useTrial: receipt.effectiveUseTrial, autoRenew: params.autoRenew, runtimeBound: true, attachments: receipt.attachments,
    guideStatus: status, consentStatus: status, executionProfileSaved: active, offlineReplaySupported: offlineReplay.supported, broadcast: receipt.broadcast,
  };
  if (!offlineReplay.supported) payload.offlineReplayFixCommands = fixCommandsOrDefault(offlineReplay);
  return {
    phase: 'creation', decision: 'ready', reason: 'broadcast_submitted',
    nextAction: [{ id: 'watch_task', recommend: true, params: { jobId: receipt.jobId } }],
    payload,
  };
}
