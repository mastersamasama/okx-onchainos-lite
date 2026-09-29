// Deterministic checks between Service confirmation and task field collection —
// upstream task/user/task_create_prepare.rs. Every outcome is a success decision object.
import { context } from '../../../core/errors.mjs';
import { buildFundingBundleForAddress, FUNDING_OPERATION_TASK_CREATION } from '../../../core/funding.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { fromStr } from '../../../core/serde.mjs';
import { selfOutput, utf8Lossy } from '../../_proc.mjs';
import { get, asBool, asF64, isObject, isNumber } from '../../../core/rs/value.mjs';
import { trim, eqIgnoreAsciiCase } from '../../../core/rs/str.mjs';
import { spawnErrorText } from '../../../core/rs/process.mjs';
import { currentAccountXlayerAddress, ensureSufficientBalance } from '../common/index.mjs';
import { resolveCurrentDepositInfo } from '../common/deposit-qr.mjs';
import { resolveUserAgent, findInsufficientBalance } from './create.mjs';
import { scalarString } from './service-detail.mjs';
import { compactTaskServiceForAi } from './asp-ops.mjs';
import { fetchActiveBuyerSubscriptionsForAgent, existingSubscriptionForService } from './subscription-ops.mjs';

const PHASE_LOGIN_VALIDATION = 'login_validation';
const PHASE_IDENTITY_VALIDATION = 'identity_validation';
const PHASE_SERVICE_VALIDATION = 'service_validation';
const PHASE_SERVICE_ROUTING = 'service_routing';
const PHASE_SUBSCRIPTION_VALIDATION = 'subscription_validation';
const PHASE_CREATION = 'creation';

// upstream: task_create_prepare.rs::decision_with_payload (Map → sorted keys)
export const decisionWithPayload = (phase, decision, reason, nextAction, payload) => ({ phase, decision, reason, nextAction, payload });
// upstream: task_create_prepare.rs::next_action (private)
const nextAction = (id, recommend) => [{ id, recommend }];

// upstream: task_create_prepare.rs::required_service_string (private)
function requiredServiceString(service, key) {
  const v = scalarString(get(service, key));
  if (v === undefined) throw new Error(`selected Service is missing required field \`${key}\``);
  return v;
}

// upstream: task_create_prepare.rs::fetch_service_detail (private; child `agent service-detail`)
async function fetchServiceDetail(userAgentId, sid) {
  const o = await selfOutput(['agent', 'service-detail', '--sid', sid, '--agentic-id', userAgentId]);
  if (o.spawnError) throw context('failed to invoke service-detail', new Error(spawnErrorText(o.spawnError)));
  if (o.code !== 0) throw new Error(`service-detail failed: ${trim(utf8Lossy(o.stderr))}`);
  let response;
  try { response = fromStr(o.stdout); } catch (e) { throw context('failed to parse service-detail JSON output', e); }
  if (asBool(get(response, 'ok')) !== true) throw new Error('service-detail returned a non-success response');
  const service = get(response, 'data');
  if (service === undefined) throw new Error('service-detail response is missing data');
  if (!isObject(service)) throw new Error('service-detail response data must be a Service object');
  return service;
}

// upstream: task_create_prepare.rs::decimal (private) → number | undefined
function decimal(value, field) {
  if (value === undefined) return undefined;
  let parsed = isNumber(value) ? asF64(value) : undefined;
  if (parsed === undefined && typeof value === 'string') { try { parsed = parseRustF64(trim(value)); } catch { parsed = undefined; } }
  if (parsed === undefined) throw new Error(`selected Service field \`${field}\` must be a number`);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`selected Service field \`${field}\` must be a non-negative number`);
  return parsed;
}

// upstream: task_create_prepare.rs::effective_fee (private)
function effectiveFee(service) {
  if (asBool(get(service, 'supportSubscription')) === true) {
    const fee = decimal(get(get(service, 'subscriptionInfo'), 'feeAmount'), 'subscriptionInfo.feeAmount');
    if (fee === undefined) throw new Error('selected subscription Service has no subscription fee');
    return fee;
  }
  const fee = decimal(get(service, 'feeAmount'), 'feeAmount');
  if (fee === undefined) throw new Error('selected Service has no feeAmount');
  return fee;
}

// upstream: task_create_prepare.rs::trial_available (private)
export function trialAvailable(service) {
  const info = get(service, 'subscriptionInfo');
  const supports = asBool(get(info, 'supportTrial')) === true;
  let trial;
  try { trial = decimal(get(info, 'freeTrial'), 'subscriptionInfo.freeTrial'); } catch { trial = undefined; }
  return supports && trial !== undefined && trial > 0;
}

// upstream: task_create_prepare.rs::duplicate_subscription_context (private)
function duplicateSubscriptionContext(existing) {
  const jobId = trim(existing.jobId);
  if (jobId === '') throw new Error('blocking buyer subscription is missing required field `jobId`');
  const title = trim(existing.title ?? '');
  if (title === '') throw new Error('blocking buyer subscription is missing required field `title`');
  return { jobId, title, restoreListeningAvailable: existing.restoreListeningAvailable };
}

// upstream: task_create_prepare.rs::handle_task_create_prepare → decision object (success data)
export async function handleTaskCreatePrepare(client, sid) {
  let loggedIn = currentAccountXlayerAddress() !== undefined;
  if (loggedIn) { try { await ensureTokensRefreshed(); } catch { loggedIn = false; } }
  if (!loggedIn) return decisionWithPayload(PHASE_LOGIN_VALIDATION, 'blocked', 'login_required', nextAction('login', true), {});

  let userAgentId;
  try { [userAgentId] = await resolveUserAgent(); } catch {
    return decisionWithPayload(PHASE_IDENTITY_VALIDATION, 'blocked', 'user_identity_required', nextAction('register_user_agent', true), {});
  }

  const selectedSid = trim(sid);
  if (selectedSid === '') throw new Error('--sid must not be blank');
  const raw = await fetchServiceDetail(userAgentId, selectedSid);
  requiredServiceString(raw, 'serviceId');
  const serviceType = requiredServiceString(raw, 'serviceType');
  if (eqIgnoreAsciiCase(serviceType, 'A2MCP')) {
    return decisionWithPayload(PHASE_SERVICE_ROUTING, 'ready', 'a2mcp_service_confirmed', nextAction('invoke_a2mcp', true), { schemaVersion: 1, serviceSnapshot: raw });
  }
  if (!eqIgnoreAsciiCase(serviceType, 'A2A')) {
    return decisionWithPayload(PHASE_SERVICE_VALIDATION, 'blocked', 'unsupported_service_type', nextAction('stop', true), compactTaskServiceForAi(raw));
  }
  const service = compactTaskServiceForAi(raw);

  let duplicate;
  if (asBool(get(service, 'supportSubscription')) === true) {
    const existing = await fetchActiveBuyerSubscriptionsForAgent(client, userAgentId);
    const serviceId = requiredServiceString(service, 'serviceId');
    const hit = existingSubscriptionForService(existing, serviceId);
    if (hit) duplicate = duplicateSubscriptionContext(hit);
  }
  if (duplicate) {
    const actions = duplicate.restoreListeningAvailable
      ? [{ id: 'restore_subscription', recommend: true }, { id: 'stop', recommend: false }]
      : nextAction('stop', true);
    return decisionWithPayload(PHASE_SUBSCRIPTION_VALIDATION, 'blocked', 'duplicate_subscription', actions,
      { jobId: duplicate.jobId, title: duplicate.title, restoreListeningAvailable: duplicate.restoreListeningAvailable });
  }

  const ready = () => decisionWithPayload(PHASE_CREATION, 'ready', 'all_checks_passed', nextAction('open_create_playbook', true), service);
  const required = effectiveFee(service);
  if (trialAvailable(service) || required === 0) return ready();

  const currency = requiredServiceString(service, 'feeTokenSymbol');
  try { await ensureSufficientBalance(required, currency); } catch (e) {
    const insufficient = findInsufficientBalance(e);
    if (!insufficient) throw context('failed to check the selected Service balance', e);
    const deposit = await resolveCurrentDepositInfo(userAgentId);
    if (!deposit) throw new Error('failed to resolve the funding address');
    const feeToken = requiredServiceString(service, 'feeToken');
    return buildFundingBundleForAddress('', deposit.chainIndex, deposit.address, {
      asset: insufficient.currency, tokenAddress: feeToken, required: insufficient.required, balance: insufficient.available,
      operation: FUNDING_OPERATION_TASK_CREATION, errorCode: null, errorMessage: null,
    });
  }
  return ready();
}

