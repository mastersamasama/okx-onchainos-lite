// ASP lifecycle operations (escrow simplified flow) — upstream task/user/asp_ops.rs:
// asp-match, task-service-select, set-asp, reset-asp, user-reject. Handlers print exactly what
// upstream prints; JSON results are returned as `{ json }` for the command layer to envelope.
import { createHash } from 'node:crypto';
import { f64 } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { fromStr } from '../../../core/serde.mjs';
import { get, asStr, asI64, asU64, asF64, asBool, asArray, isObject, isNumber, numText, cloneValue } from '../../../core/rs/value.mjs';
import { trim, eqIgnoreAsciiCase } from '../../../core/rs/str.mjs';
import { formatFixed } from '../../../core/rs/num.mjs';
import { selfOutput, utf8Lossy } from '../../_proc.mjs';
import * as signing from '../signing.mjs';
import { AGENT_ROLE_USER } from '../common/index.mjs';
import { PaymentMode } from '../common/payment-mode.mjs';
import { isCliMode } from '../common/config.mjs';
import { sessionDelete } from '../common/okx-a2a.mjs';
import { fetchActiveBuyerSubscriptionsForAgent, existingSubscriptionForService, existingSubscriptionValue } from './subscription-ops.mjs';
import { getDesignatedProvider, saveDesignatedProvider } from './flow-lifecycle/_peers.mjs';

const out = (s) => process.stdout.write(s);

// ── asp-match ──
// upstream: asp_ops.rs::scalar_display
function scalarDisplay(value) {
  const s = asStr(value);
  if (s !== undefined && trim(s) !== '') return trim(s);
  return isNumber(value) ? numText(value) : undefined;
}
// upstream: asp_ops.rs::supports_trial
const supportsTrial = (service) => asBool(get(service, 'supportTrial')) ?? false;
// upstream: asp_ops.rs::selected_subscription
export function selectedSubscription(service) {
  const subs = asArray(get(service, 'subscription'));
  if (!subs) return undefined;
  return subs.find((e) => asStr(get(e, 'interval')) === 'month') ?? subs[0];
}
// upstream: asp_ops.rs::selected_subscription_fee
export function selectedSubscriptionFee(service) {
  const fee = get(selectedSubscription(service), 'fee');
  if (fee === undefined || fee === null) return undefined;
  if (typeof fee === 'string' && trim(fee) === '') return undefined;
  return cloneValue(fee);
}
// upstream: asp_ops.rs::normalize_subscription_fee
function normalizeSubscriptionFee(service) {
  const fee = selectedSubscriptionFee(service);
  if (fee !== undefined && isObject(service)) service.feeAmount = fee;
}
// upstream: asp_ops.rs::build_subscription_info
export function buildSubscriptionInfo(service) {
  const info = get(service, 'subscriptionInfo');
  if (isObject(info)) return cloneValue(info);
  const subscription = selectedSubscription(service);
  const fee = selectedSubscriptionFee(service);
  const support = subscription !== undefined || (asBool(get(service, 'supportSubscription')) ?? false);
  if (!support) return null;
  const interval = get(subscription, 'interval');
  const freeTrial = get(service, 'freeTrial');
  return {
    interval: interval === undefined ? null : cloneValue(interval), feeAmount: fee === undefined ? null : fee,
    supportTrial: supportsTrial(service), freeTrial: freeTrial === undefined ? 0 : cloneValue(freeTrial),
  };
}
// upstream: asp_ops.rs::copy_field
function copyField(target, source, key) {
  const v = get(source, key);
  if (v !== undefined) target[key] = cloneValue(v);
}
// upstream: asp_ops.rs::add_service_guide_hash
function addServiceGuideHash(target, source) {
  const guide = asStr(get(source, 'serviceGuide'));
  if (guide === undefined || trim(guide) === '') return;
  target.serviceGuideHash = `sha256:${createHash('sha256').update(guide, 'utf8').digest('hex')}`;
}
// upstream: asp_ops.rs::compact_service_for_ai
export function compactServiceForAi(service) {
  const subscriptionInfo = buildSubscriptionInfo(service);
  const support = subscriptionInfo !== null;
  const compact = {};
  for (const key of ['serviceId', 'serviceName', 'serviceType', 'serviceDescription', 'serviceGuide', 'feeToken', 'feeTokenSymbol', 'endpoint']) copyField(compact, service, key);
  addServiceGuideHash(compact, service);
  if (!support) copyField(compact, service, 'feeAmount');
  compact.supportSubscription = support;
  compact.subscriptionInfo = subscriptionInfo;
  return compact;
}
// upstream: asp_ops.rs::compact_recommendation_for_ai
function compactRecommendationForAi(rec) {
  const compact = {};
  for (const key of ['providerAgentId', 'providerAgentName', 'securityRate', 'feedbackRate', 'soldCount', 'supportA2MCP']) copyField(compact, rec, key);
  compact.services = (asArray(get(rec, 'services')) ?? []).map(compactServiceForAi);
  return compact;
}
// upstream: asp_ops.rs::compact_asp_match_response
export function compactAspMatchResponse(resp) {
  const compact = { recommendations: (asArray(get(resp, 'recommendations')) ?? []).map(compactRecommendationForAi) };
  const next = get(resp, 'nextPage');
  if (next !== undefined) compact.nextPage = cloneValue(next);
  return compact;
}
// upstream: asp_ops.rs::service_online
const serviceOnline = (service) => asI64(get(get(service, 'asp'), 'onlineStatus')) === 1;
// upstream: asp_ops.rs::offline_x402_service
function offlineX402Service(service) {
  const t = asStr(get(service, 'serviceType')), endpoint = asStr(get(service, 'endpoint'));
  return !serviceOnline(service) && t !== undefined && eqIgnoreAsciiCase(t, 'A2MCP') && endpoint !== undefined && trim(endpoint) !== '';
}
// upstream: asp_ops.rs::compact_task_service_for_ai
export function compactTaskServiceForAi(service) {
  const subscriptionInfo = buildSubscriptionInfo(service);
  const support = subscriptionInfo !== null;
  const asp = get(service, 'asp') ?? null;
  const compact = {};
  const pick = (...vals) => vals.find((v) => v !== undefined);
  const pid = pick(get(asp, 'aspAgentId'), get(service, 'providerAgentId'), get(service, 'aspAgentId'));
  if (pid !== undefined) compact.providerAgentId = cloneValue(pid);
  const pname = pick(get(asp, 'aspName'), get(service, 'providerAgentName'), get(service, 'aspName'));
  if (pname !== undefined) compact.providerAgentName = cloneValue(pname);
  for (const key of ['securityRate', 'feedbackRate', 'soldCount']) {
    const v = pick(get(asp, key), get(service, key));
    if (v !== undefined) compact[key] = cloneValue(v);
  }
  for (const key of ['sid', 'serviceId', 'serviceName', 'serviceType', 'serviceDescription', 'serviceGuide', 'feeToken', 'feeTokenSymbol', 'endpoint']) copyField(compact, service, key);
  addServiceGuideHash(compact, service);
  if (!support) copyField(compact, service, 'feeAmount');
  compact.online = serviceOnline(service);
  compact.supportSubscription = support;
  compact.subscriptionInfo = subscriptionInfo;
  return compact;
}
// upstream: asp_ops.rs::compact_task_service_select_response
export function compactTaskServiceSelectResponse(resp) {
  const services = asArray(get(resp, 'services')) ?? [];
  const eligible = services.filter((s) => serviceOnline(s) || offlineX402Service(s));
  const compactServices = (eligible.length ? eligible : services).map(compactTaskServiceForAi);
  const matchStatus = !services.length ? 'no_match' : !eligible.length ? 'no_online_service' : 'matched';
  const compact = { matchStatus, services: compactServices };
  for (const key of ['searchAfter', 'hasMore', 'unmatchReason']) { const v = get(resp, key); if (v !== undefined) compact[key] = cloneValue(v); }
  return compact;
}
// upstream: asp_ops.rs::apply_existing_subscription_annotations
function applyExistingSubscriptionAnnotations(compact, existing) {
  let blocking = 0;
  for (const service of asArray(get(compact, 'services')) ?? []) {
    if (asBool(get(service, 'supportSubscription')) !== true) continue;
    const serviceId = asStr(get(service, 'serviceId')) ?? '';
    const item = existingSubscriptionForService(existing, serviceId);
    if (item !== undefined) blocking += 1;
    if (isObject(service)) service.existingSubscription = item !== undefined ? existingSubscriptionValue(item) : null;
  }
  compact.subscriptionCheck = { status: 'checked', blockingServiceCount: blocking };
}
// upstream: asp_ops.rs::service_scalar_string
function serviceScalarString(service, key) {
  const v = get(service, key);
  if (v === undefined) return undefined;
  const s = asStr(v);
  if (s !== undefined && trim(s) !== '') return trim(s);
  const i = asI64(v);
  if (i !== undefined) return String(i);
  const u = asU64(v);
  return u === undefined ? undefined : String(u);
}
// upstream: asp_ops.rs::build_duplicate_subscription_resolution
function buildDuplicateSubscriptionResolution(compact) {
  const first = (asArray(get(compact, 'services')) ?? [])[0];
  if (first === undefined || get(first, 'existingSubscription') === undefined || get(first, 'existingSubscription') === null) return undefined;
  const existing = get(first, 'existingSubscription');
  const serviceId = serviceScalarString(first, 'serviceId') ?? '';
  const serviceName = serviceScalarString(first, 'serviceName') ?? serviceId;
  const jobId = serviceScalarString(existing, 'jobId') ?? '';
  const canRestore = asBool(get(existing, 'restoreListeningAvailable')) ?? false;
  const base = `Service "${serviceName}" already has a subscription task, jobId: ${jobId}. It cannot be created again.`;
  const resolution = { userFacingPrompt: canRestore ? `${base} Would you like to restore listening?` : base };
  if (canRestore) resolution.nextAfterUserChoice = ['restore-listening'];
  return resolution;
}
// upstream: asp_ops.rs::minimize_selected_duplicate_service
function minimizeSelectedDuplicateService(compact) {
  const first = (asArray(get(compact, 'services')) ?? [])[0];
  if (!isObject(first)) return;
  const keep = new Set(['providerAgentId', 'serviceId', 'serviceName', 'serviceType', 'supportSubscription', 'existingSubscription']);
  for (const k of Object.keys(first)) if (!keep.has(k)) delete first[k];
}
// upstream: asp_ops.rs::apply_duplicate_subscription_resolution
function applyDuplicateSubscriptionResolution(compact) {
  const resolution = buildDuplicateSubscriptionResolution(compact);
  if (resolution === undefined) return;
  compact.duplicateSubscription = resolution;
  minimizeSelectedDuplicateService(compact);
}
// upstream: asp_ops.rs::service_match_data_from_stdout
export function serviceMatchDataFromStdout(stdout) {
  const value = fromStr(stdout);
  if (asBool(get(value, 'ok')) === true || asI64(get(value, 'code')) === 0) return get(value, 'data') ?? null;
  return value;
}

// upstream: asp_ops.rs::handle_task_service_select → { json } | { text }
// args: { keywords, aspAgentId, aspName, serviceName, sid, minPaymentTokenAmount, maxPaymentTokenAmount, searchAfter, limit }
export async function handleTaskServiceSelect(client, args, agenticId, format) {
  const cmd = ['agent', 'service-match'];
  const keywords = (args.keywords ?? []).filter((k) => trim(k) !== '');
  if (keywords.length) cmd.push('--keywords', ...keywords);
  const opt = (flag, v) => { if (v !== undefined && v !== null && v !== '') cmd.push(flag, v); };
  opt('--asp-agent-id', args.aspAgentId);
  opt('--asp-name', args.aspName);
  opt('--service-name', args.serviceName);
  opt('--sid', args.sid);
  opt('--min-payment-token-amount', args.minPaymentTokenAmount);
  opt('--max-payment-token-amount', args.maxPaymentTokenAmount);
  opt('--search-after', args.searchAfter);
  cmd.push('--limit', String(args.limit));
  const o = await selfOutput(cmd);
  if (o.spawnError) throw new Error(o.spawnError.message);
  if (o.code !== 0) throw new Error(`service-match failed: ${trim(utf8Lossy(o.stderr))}`);
  const data = serviceMatchDataFromStdout(o.stdout);
  // upstream attaches `autoTradePreflight` to every service here; compaction drops the field.
  const compact = compactTaskServiceSelectResponse(data);
  const hasSubscription = (asArray(get(compact, 'services')) ?? []).some((s) => asBool(get(s, 'supportSubscription')) === true);
  if (hasSubscription) {
    if (agenticId === undefined || agenticId === null || trim(agenticId) === '') {
      throw new Error('--agentic-id is required to check existing subscriptions before selecting a subscription service');
    }
    const existing = await fetchActiveBuyerSubscriptionsForAgent(client, agenticId);
    applyExistingSubscriptionAnnotations(compact, existing);
    applyDuplicateSubscriptionResolution(compact);
  }
  if (eqIgnoreAsciiCase(format, 'json') || format === '') return { json: compact };
  return { text: `${asStr(get(compact, 'matchStatus')) ?? 'no_match'}\n` };
}

// upstream: asp_ops.rs::format_provider
const formatProvider = (pid, pname) => (pname === '' ? `Agent ${pid}` : `Agent ${pid}(${pname})`);

// upstream: asp_ops.rs::handle_asp_match → { json } | { text }
export async function handleAspMatch(client, jobId, providerAgentId, paymentTokenAmount, page, explicitAgentId, format) {
  if (trim(jobId) === '') throw new Error('--job-id cannot be empty');
  const jsonMode = eqIgnoreAsciiCase(format, 'json');
  const agentId = explicitAgentId !== undefined && explicitAgentId !== null ? explicitAgentId : await signing.resolveAgentIdByRole(AGENT_ROLE_USER);
  const body = { jobId, page };
  if (providerAgentId !== undefined && providerAgentId !== null) body.providerAgentId = providerAgentId;
  if (paymentTokenAmount !== undefined && paymentTokenAmount !== null) body.paymentTokenAmount = f64(paymentTokenAmount);
  let resp = await client.postWithIdentity('/priapi/v1/aieco/task/asp/match', body, agentId);
  if (resp === null) resp = {};
  for (const rec of asArray(get(resp, 'recommendations')) ?? []) for (const svc of asArray(get(rec, 'services')) ?? []) normalizeSubscriptionFee(svc);
  const recs = asArray(get(resp, 'recommendations')) ?? [];
  const nextPage = asU64(get(resp, 'nextPage'));
  auditLog('cli', 'user/asp_match', true, 0, [`agentId=${agentId}`, `jobId=${jobId}`, `page=${page}`, `results=${recs.length}`]);
  if (jsonMode) return { json: compactAspMatchResponse(resp) };
  if (!recs.length) return { text: 'No matching ASPs found for this task.\n' };
  let t = `Matched ASPs (page ${page}, ${recs.length} results):\n\n`;
  recs.forEach((rec, i) => {
    const pid = asStr(get(rec, 'providerAgentId')) ?? '?';
    const pname = asStr(get(rec, 'providerAgentName')) ?? '';
    const sec = asF64(get(rec, 'securityRate')) ?? 0;
    const fb = asF64(get(rec, 'feedbackRate')) ?? 0;
    const sold = asU64(get(rec, 'soldCount')) ?? 0;
    const a2mcp = asBool(get(rec, 'supportA2MCP')) ?? false;
    t += `━━━ ${i + 1}. ${formatProvider(pid, pname)} ━━━\n`;
    t += `  security: ${formatFixed(sec, 2)} | feedback: ${formatFixed(fb, 2)} | sold: ${sold} | A2MCP: ${a2mcp}\n`;
    for (const svc of asArray(get(rec, 'services')) ?? []) {
      const sid = asStr(get(svc, 'serviceId')) ?? '?';
      const sname = asStr(get(svc, 'serviceName')) ?? '';
      const sdesc = asStr(get(svc, 'serviceDescription')) ?? '';
      const stype = asStr(get(svc, 'serviceType')) ?? '';
      const feeAmt = scalarDisplay(get(svc, 'feeAmount') ?? null);
      const feeSym = asStr(get(svc, 'feeTokenSymbol')) ?? '';
      t += `  Service: ${sid}`;
      if (sname !== '') t += ` — ${sname}`;
      t += ` [${stype}]\n`;
      if (sdesc !== '') t += `    ${sdesc}\n`;
      t += feeAmt !== undefined ? `    Fee: ${feeAmt} ${feeSym}\n` : '    Fee: (no price — negotiation required)\n';
      for (const sub of asArray(get(svc, 'subscription')) ?? []) {
        const interval = asStr(get(sub, 'interval')) ?? 'month';
        const fee = scalarDisplay(get(sub, 'fee') ?? null) ?? '?';
        t += `    Subscription: ${fee} ${feeSym}/${interval}`;
        if (supportsTrial(svc)) t += ' (trial available)';
        t += '\n';
      }
    }
    t += '\n';
  });
  if (nextPage !== undefined) t += `Next page: ${nextPage}\n`;
  return { text: t };
}

// ── set-asp ──
// upstream: asp_ops.rs::service_type_to_payment_mode
function serviceTypeToPaymentMode(serviceType) {
  const up = String(serviceType).replace(/[a-z]/g, (c) => c.toUpperCase());
  if (up === 'A2A') return PaymentMode.Escrow;
  if (up === 'A2MCP') return PaymentMode.X402;
  throw new Error(`unsupported --service-type "${serviceType}"; valid values: A2A, A2MCP`);
}

// upstream: asp_ops.rs::handle_set_asp (prints its own output)
export async function handleSetAsp(client, jobId, providerAgentId, serviceId, serviceType, serviceParams, serviceTokenAddress, serviceTokenAmount, paymentTokenSymbol, explicitAgentId) {
  const desired = serviceTypeToPaymentMode(serviceType);
  const [accountId, address, agentId] = await signing.resolveWalletAndAgentForTask(client, jobId, explicitAgentId ?? null);
  const task = await client.getWithIdentity(client.taskPath(jobId), agentId);
  const current = PaymentMode.fromInt(Number(BigInt.asIntN(32, BigInt(asI64(get(task, 'paymentMode')) ?? 0))));
  if (current !== desired) {
    const resp = await client.postWithIdentity(client.endpoint(jobId, 'setPaymentMode'), { paymentMode: PaymentMode.asInt(desired) }, agentId);
    const txHash = await signing.signUopAndBroadcast(client, get(resp, 'uopData') ?? null, accountId, address, jobId, signing.extractBizType(resp), agentId, undefined);
    auditLog('cli', 'user/set_asp_payment_mode_sync', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `from=${PaymentMode.asStr(current)}`, `to=${PaymentMode.asStr(desired)}`, `txHash=${txHash}`]);
    out(`✓ Payment mode synced on-chain: ${PaymentMode.asStr(current)} → ${PaymentMode.asStr(desired)} (txHash ${txHash})\n`);
  }
  const body = { providerAgentId, serviceId, serviceType, serviceParams, serviceTokenAddress, serviceTokenAmount };
  if (paymentTokenSymbol !== undefined && paymentTokenSymbol !== null) body.paymentTokenSymbol = paymentTokenSymbol;
  await client.postWithIdentity(client.endpoint(jobId, 'set/asp'), body, agentId);
  const old = await getDesignatedProvider(jobId);
  if (old !== undefined && old !== providerAgentId) {
    try { await sessionDelete(jobId, old); out(`✓ Old job session deleted (provider ${old}).\n`); } catch (e) {
      process.stderr.write(`⚠ Old job session delete failed (provider ${old}): ${displayTop(e)}\n`);
    }
  }
  await saveDesignatedProvider(jobId, providerAgentId);
  auditLog('cli', 'user/set_asp', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `providerAgentId=${providerAgentId}`, `serviceId=${serviceId}`,
    `serviceType=${serviceType}`, `serviceTokenAmount=${serviceTokenAmount}`]);
  const waiting = isCliMode() ? '' : ' Waiting for job_created event.';
  out(`✓ ASP and service updated (off-chain).${waiting}\n  providerAgentId: ${providerAgentId}\n  serviceId: ${serviceId}\n  serviceType: ${serviceType}\n  serviceTokenAmount: ${serviceTokenAmount}\n`);
}

// upstream: asp_ops.rs::resolve_agent
async function resolveAgent(client, jobId, explicitAgentId) {
  if (explicitAgentId !== undefined && explicitAgentId !== null) return explicitAgentId;
  const [, , id] = await signing.resolveWalletAndAgentForTask(client, jobId, null);
  return id;
}

// upstream: asp_ops.rs::handle_reset_asp (prints its own output)
export async function handleResetAsp(client, jobId, explicitAgentId) {
  const agentId = await resolveAgent(client, jobId, explicitAgentId);
  await client.postWithIdentity(client.endpoint(jobId, 'reset/asp'), {}, agentId);
  auditLog('cli', 'user/reset_asp', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`]);
  out('✓ ASP and service fields cleared (off-chain).\n');
}

// upstream: asp_ops.rs::handle_user_reject (prints its own output)
export async function handleUserReject(client, jobId, explicitAgentId) {
  const agentId = await resolveAgent(client, jobId, explicitAgentId);
  await client.postWithIdentity(client.endpoint(jobId, 'user/reject'), {}, agentId);
  auditLog('cli', 'user/user_reject', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`]);
  out('✓ Current ASP rejected (off-chain). ASP and service fields cleared.\n  Backend will trigger job_user_reject notification.\n');
}
