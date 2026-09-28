// Buyer create-and-fund entry point for a one-time A2A task — upstream task/user/create.rs.
import { context } from '../../../core/errors.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { parseRustF64 } from '../../../core/cli.mjs';
import { buildFundingBundleForAddress, FUNDING_OPERATION_TASK_CREATION } from '../../../core/funding.mjs';
import { displayF64, toValue } from '../../../core/json.mjs';
import { loadSession } from '../../../wallet/store.mjs';
import { ensureTokensRefreshed } from '../../../wallet/auth.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { fromStr, T } from '../../../wallet/_serde-json.mjs';
import { ensureTaskStateWritable } from '../../_home.mjs';
import { get, at, asStr, asI64, trim, charCount } from '../../_rs.mjs';
import { fetchMyAgentsByRoleStrict, AGENT_ROLE_USER, XLAYER_CHAIN_ID, ensureSufficientBalance } from '../common/index.mjs';
import { sanitizeTitleForShell } from '../common/util.mjs';
import { InsufficientBalanceError, resolveCurrentDepositInfo } from '../common/deposit-qr.mjs';
import { initialCreationDisplay } from '../common/lifecycle.mjs';
import { resolveWalletByAgentId } from '../signing.mjs';
import { validateAttachmentSources } from './attachments.mjs';
import { execute as createAndFundExecute } from './v2/create-and-fund.mjs';
import * as guide from '../common/autotrade/guide.mjs';
import { DEFAULT_AUTOTRADE_TTL_SEC } from '../common/autotrade/index.mjs';

// upstream: create.rs constants
export const MAX_BUDGET = 10000000;
export const MIN_DESCRIPTION_CHARS = 20;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_DESCRIPTION_SUMMARY_CHARS = 200;
export const MAX_BUDGET_DECIMALS = 6;
export const MAX_TITLE_CHARS = 30;

// anyhow `downcast_ref::<InsufficientBalanceError>()` over the context chain.
export function findInsufficientBalance(err) {
  let e = err;
  while (e && !(e instanceof InsufficientBalanceError)) e = e.cause;
  return e;
}

// upstream: create.rs::normalize_currency
export function normalizeCurrency(currency) {
  const normalized = String(currency).split('₮').join('T').toUpperCase();
  if (normalized === 'USDT' || normalized === 'USDT0') return 'USDT';
  if (normalized === 'USDG') return 'USDG';
  throw new Error(`unsupported token: ${currency}; only USDT (USD₮0) and USDG are supported`);
}

// upstream: create.rs::validate_decimal_amount (private)
export function validateDecimalAmount(value, flag) {
  const v = trim(value);
  if (v === '' || v.startsWith('-') || v.startsWith('+')) throw new Error(`--${flag} must be a non-negative decimal string`);
  const parts = v.split('.');
  const [whole, fraction] = parts;
  const digits = (s) => /^[0-9]+$/.test(s);
  if (parts.length > 2 || whole === '' || !digits(whole)
    || (fraction !== undefined && (fraction === '' || Buffer.byteLength(fraction) > MAX_BUDGET_DECIMALS || !digits(fraction)))) {
    throw new Error(`--${flag} must be a decimal string with at most ${MAX_BUDGET_DECIMALS} decimal places`);
  }
}

// upstream: create.rs::validate_budget
export function validateBudget(budget) {
  if (budget < 0) throw new Error('budget must be a non-negative amount');
  if (budget > MAX_BUDGET) throw new Error(`per-task budget may not exceed ${MAX_BUDGET} USDT/USDG`);
}

// upstream: create.rs::validate_budget_decimals
export function validateBudgetDecimals(budget) {
  const value = displayF64(budget);
  const dot = value.indexOf('.');
  if (dot >= 0) {
    const fraction = value.slice(dot + 1).replace(/0+$/, '');
    if (fraction.length > MAX_BUDGET_DECIMALS) throw new Error(`budget precision is limited to ${MAX_BUDGET_DECIMALS} decimal places, currently ${fraction.length}`);
  }
}

// upstream: create.rs::validate_title (private)
export function validateTitle(title) {
  if (trim(title) === '') throw new Error('title must not be empty');
  const n = charCount(title);
  if (n > MAX_TITLE_CHARS) throw new Error(`title may not exceed ${MAX_TITLE_CHARS} characters (currently ${n})`);
}

// upstream: create.rs::validate_description_body (private)
function validateDescriptionBody(description) {
  const n = charCount(description);
  if (n < MIN_DESCRIPTION_CHARS) throw new Error(`description is too short (minimum ${MIN_DESCRIPTION_CHARS} chars, currently ${n})`);
  if (n > MAX_DESCRIPTION_CHARS) throw new Error(`description may not exceed ${MAX_DESCRIPTION_CHARS} chars (currently ${n})`);
}

// upstream: create.rs::validate_draft_fields (json! → sorted keys)
export function validateDraftFields(description, title, budget, maxBudget, currency) {
  const checks = [], errors = [];
  const check = (field, fn) => {
    try { fn(); checks.push({ field, ok: true }); } catch (e) { checks.push({ field, ok: false, error: e.message }); errors.push(e.message); }
  };
  const given = (v) => v !== undefined && v !== null;
  if (given(description)) check('description', () => validateDescriptionBody(description));
  if (given(title)) check('title', () => validateTitle(title));
  if (given(currency)) {
    try { checks.push({ field: 'currency', ok: true, normalized: normalizeCurrency(currency) }); } catch (e) { checks.push({ field: 'currency', ok: false, error: e.message }); errors.push(e.message); }
  }
  if (given(budget)) check('budget', () => { validateBudget(budget); validateBudgetDecimals(budget); });
  if (given(maxBudget)) check('max_budget', () => { validateBudget(maxBudget); validateBudgetDecimals(maxBudget); });
  if (given(budget) && given(maxBudget) && maxBudget < budget) errors.push(`max_budget (${displayF64(maxBudget)}) must be >= budget (${displayF64(budget)})`);
  return { ok: errors.length === 0, checks, errors };
}

// upstream: create.rs::resolve_user_agent → [agentId, ownerAddress]
export async function resolveUserAgent() {
  const agents = await fetchMyAgentsByRoleStrict('user');
  const user = agents.find((a) => asI64(at(a, 'role')) === AGENT_ROLE_USER);
  if (!user) throw new Error('the current account has no user identity; run `onchainos agent create --role user` first');
  const agentId = asStr(at(user, 'agentId'));
  if (agentId === undefined) throw new Error('agent is missing the agentId field');
  return [agentId, asStr(at(user, 'ownerAddress')) ?? ''];
}

// Guide + Consent input shared by create-task / create-subscribe (upstream GuideConsentInput).
export function parseGuideConsentValues(raw) {
  try { return fromStr(raw, T.map(T.value)); } catch (e) { throw context('--guide-consent-json must be a JSON object', e); }
}

// upstream: CreateTaskParams::validated_guide_consent (private)
function validatedGuideConsent(p) {
  const draft = guide.parseDraft(p.serviceGuide, p.serviceGuideHash);
  if (draft === undefined || draft === null) {
    if (p.serviceGuideHash !== undefined || p.guideConsentJson !== undefined) throw new Error('Guide Consent requires --service-guide');
    return undefined;
  }
  if (p.guideConsentJson === undefined) throw new Error('--guide-consent-json is required with --service-guide, including {} when the Guide declares no consent fields');
  const consentValues = parseGuideConsentValues(p.guideConsentJson);
  guide.validateConsentValues(consentValues);
  return { draft, consentValues };
}

// upstream: CreateTaskParams::validate (private) → { title, tokenSymbol, visibility, guideConsent }
export function validateCreateTaskParams(p) {
  validateTitle(p.title);
  const descriptionLen = charCount(p.description);
  if (trim(p.description) === '') throw new Error('--description must not be empty');
  if (descriptionLen > MAX_DESCRIPTION_CHARS) throw new Error(`--description may not exceed ${MAX_DESCRIPTION_CHARS} characters (currently ${descriptionLen})`);
  if (p.descriptionSummary !== undefined && charCount(p.descriptionSummary) > MAX_DESCRIPTION_SUMMARY_CHARS) {
    throw new Error(`--description-summary may not exceed ${MAX_DESCRIPTION_SUMMARY_CHARS} characters`);
  }
  if (trim(p.providerAgentId) === '') throw new Error('--provider-agent-id is required; use the confirmed Service result unchanged');
  if (trim(p.serviceId) === '') throw new Error('--service-id is required; use the confirmed Service result unchanged');
  if (trim(p.serviceTokenAddress) === '') throw new Error('--service-token-address must not be empty');
  try { fromStr(p.serviceParams); } catch (e) { throw new Error(`--service-params must be valid JSON: ${e.message}`); }
  const tokenSymbol = normalizeCurrency(p.paymentTokenSymbol);
  validateDecimalAmount(p.paymentTokenAmount, 'payment-token-amount');
  validateDecimalAmount(p.serviceTokenAmount, 'service-token-amount');
  if (BigInt(p.chainId) !== BigInt(XLAYER_CHAIN_ID)) throw new Error(`--chain-id currently supports X Layer (${XLAYER_CHAIN_ID}) only`);
  if (p.minCreditScore !== undefined && p.minCreditScore !== null && !(p.minCreditScore >= 0 && p.minCreditScore <= 1)) {
    throw new Error('--min-credit-score must be between 0 and 1');
  }
  let visibility;
  if (p.visibility === 'private') visibility = 1;
  else if (p.visibility === 'public') visibility = 0;
  else throw new Error('--visibility must be private or public');
  validateAttachmentSources(p.attachments ?? []);
  return { title: sanitizeTitleForShell(p.title), tokenSymbol, visibility, guideConsent: validatedGuideConsent(p) };
}

// upstream: create.rs::prepare_guide_consent (private)
export function prepareGuideConsent(jobId, serviceId, providerAgentId, execution) {
  const file = guide.draftIntoFile(execution.draft, jobId, serviceId, providerAgentId);
  guide.writeGuide(file, execution.draft.source);
  guide.writePreparedConsent(jobId, file, execution.consentValues, DEFAULT_AUTOTRADE_TTL_SEC);
}

// upstream: create.rs::build_task_creation_funding_result
export function buildTaskCreationFundingResult(insufficient, deposit, tokenAddress) {
  return buildFundingBundleForAddress('', deposit.chainIndex, deposit.address, {
    asset: insufficient.currency, tokenAddress, required: insufficient.required, balance: insufficient.available,
    operation: FUNDING_OPERATION_TASK_CREATION, errorCode: null, errorMessage: null,
  });
}

// Shared session precondition of create-task / create-subscribe.
export async function requireFreshSessionWithCert(command) {
  try { await ensureTokensRefreshed(); } catch (e) { throw new Error(`session has expired; run \`onchainos wallet login\` first: ${displayTop(e)}`); }
  const session = loadSession();
  if (!session || trim(session.sessionCert) === '') throw new Error(`current login has no sessionCert; run \`onchainos wallet login\` again before ${command}`);
}

// upstream: create.rs::handle_create → success data (task-created decision or funding bundle)
export async function handleCreate(client, params) {
  const validated = validateCreateTaskParams(params);
  try { ensureTaskStateWritable(); } catch (e) { throw context('task state storage is not writable; set ONCHAINOS_HOME to a writable directory', e); }
  await requireFreshSessionWithCert('create-task');
  const [userAgentId] = await resolveUserAgent();

  let required;
  try { required = parseRustF64(params.paymentTokenAmount); } catch (e) { throw context('--payment-token-amount is outside the supported numeric range', e); }
  try { await ensureSufficientBalance(required, validated.tokenSymbol); } catch (e) {
    const insufficient = findInsufficientBalance(e);
    if (insufficient) {
      const deposit = await resolveCurrentDepositInfo(userAgentId);
      if (!deposit) throw new Error('failed to resolve the funding address');
      return buildTaskCreationFundingResult(insufficient, deposit, params.serviceTokenAddress);
    }
  }

  const [accountId, address] = await resolveWalletByAgentId(userAgentId);
  const receipt = await createAndFundExecute(client, {
    title: validated.title, description: params.description, descriptionSummary: params.descriptionSummary, tokenSymbol: validated.tokenSymbol,
    amount: params.paymentTokenAmount, providerAgentId: params.providerAgentId, serviceId: params.serviceId, serviceParams: params.serviceParams,
    serviceTokenAddress: params.serviceTokenAddress, serviceTokenAmount: params.serviceTokenAmount, categoryCode: params.categoryCode,
    minCreditScore: params.minCreditScore, visibility: validated.visibility, chainId: Number(params.chainId), attachments: params.attachments ?? [],
  }, accountId, address, userAgentId, (jobId) => {
    if (validated.guideConsent) prepareGuideConsent(jobId, params.serviceId, params.providerAgentId, validated.guideConsent);
  });

  const txHash = asStr(get(receipt.broadcast, 'txHash')) ?? 'pending';
  let active = false;
  if (validated.guideConsent) {
    try { guide.activatePreparedConsent(receipt.jobId); active = true; } catch (e) {
      process.stderr.write(`[guide-execution] task created, but Guide Consent could not be activated: ${displayTop(e)}\n`);
    }
  }
  const status = active ? 'active' : 'none';
  auditLog('cli', 'user/task_create_and_fund_submitted', true, 0, [
    `jobId=${receipt.jobId}`, `agentId=${userAgentId}`, `paymentTokenSymbol=${validated.tokenSymbol}`, `paymentTokenAmount=${params.paymentTokenAmount}`,
    `designatedProvider=${params.providerAgentId}`, 'bizType=201', `guideStatus=${status}`, `consentStatus=${status}`, `txHash=${txHash}`,
  ]);
  return {
    phase: 'creation', decision: 'ready', reason: 'broadcast_submitted',
    nextAction: [{ id: 'watch_task', recommend: true, params: { jobId: receipt.jobId } }],
    payload: {
      jobId: receipt.jobId, type: 201, bizType: 201, status: 'broadcast_submitted', providerAgentId: params.providerAgentId,
      paymentTokenSymbol: validated.tokenSymbol, paymentTokenAmount: params.paymentTokenAmount, runtimeBound: true,
      initialLifecycle: { taskType: 'one_time', display: toValue(initialCreationDisplay()) },
      guideStatus: status, consentStatus: status, attachments: receipt.attachments, broadcast: receipt.broadcast,
    },
  };
}
