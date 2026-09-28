// PRIVATE fallback for upstream task/user/create.rs::validate_draft_fields (owned by the
// user-create unit). `prepare-create` loads lib/agent/task/user/create.mjs first and uses this
// port only when that module is not available.
import { displayF64, charCount, trim } from '../../_rs.mjs';

const MIN_DESCRIPTION_CHARS = 20, MAX_DESCRIPTION_CHARS = 2000, MAX_TITLE_CHARS = 30;
const MAX_BUDGET = 10000000.0, MAX_BUDGET_DECIMALS = 6;

function normalizeCurrency(currency) {
  const n = String(currency).split('₮').join('T').toUpperCase();
  if (n === 'USDT' || n === 'USDT0') return 'USDT';
  if (n === 'USDG') return 'USDG';
  throw new Error(`unsupported token: ${currency}; only USDT (USD₮0) and USDG are supported`);
}
function validateBudget(b) {
  if (b < 0) throw new Error('budget must be a non-negative amount');
  if (b > MAX_BUDGET) throw new Error(`per-task budget may not exceed ${MAX_BUDGET} USDT/USDG`);
}
function validateBudgetDecimals(b) {
  const v = displayF64(b);
  const dot = v.indexOf('.');
  if (dot >= 0) {
    const fraction = v.slice(dot + 1).replace(/0+$/, '');
    if (fraction.length > MAX_BUDGET_DECIMALS) throw new Error(`budget precision is limited to ${MAX_BUDGET_DECIMALS} decimal places, currently ${fraction.length}`);
  }
}
function validateTitle(t) {
  if (trim(t) === '') throw new Error('title must not be empty');
  if (charCount(t) > MAX_TITLE_CHARS) throw new Error(`title may not exceed ${MAX_TITLE_CHARS} characters (currently ${charCount(t)})`);
}
function validateDescriptionBody(d) {
  const n = charCount(d);
  if (n < MIN_DESCRIPTION_CHARS) throw new Error(`description is too short (minimum ${MIN_DESCRIPTION_CHARS} chars, currently ${n})`);
  if (n > MAX_DESCRIPTION_CHARS) throw new Error(`description may not exceed ${MAX_DESCRIPTION_CHARS} chars (currently ${n})`);
}

// upstream: create.rs::validate_draft_fields (json! → sorted keys)
export function validateDraftFields(description, title, budget, maxBudget, currency) {
  const checks = [], errors = [];
  const check = (field, fn) => {
    try { fn(); checks.push({ field, ok: true }); } catch (e) { checks.push({ field, ok: false, error: e.message }); errors.push(e.message); }
  };
  if (description !== undefined && description !== null) check('description', () => validateDescriptionBody(description));
  if (title !== undefined && title !== null) check('title', () => validateTitle(title));
  if (currency !== undefined && currency !== null) {
    try { checks.push({ field: 'currency', ok: true, normalized: normalizeCurrency(currency) }); } catch (e) { checks.push({ field: 'currency', ok: false, error: e.message }); errors.push(e.message); }
  }
  if (budget !== undefined && budget !== null) check('budget', () => { validateBudget(budget); validateBudgetDecimals(budget); });
  if (maxBudget !== undefined && maxBudget !== null) check('max_budget', () => { validateBudget(maxBudget); validateBudgetDecimals(maxBudget); });
  if (budget !== undefined && budget !== null && maxBudget !== undefined && maxBudget !== null && maxBudget < budget) {
    errors.push(`max_budget (${displayF64(maxBudget)}) must be >= budget (${displayF64(budget)})`);
  }
  return { ok: errors.length === 0, checks, errors };
}
