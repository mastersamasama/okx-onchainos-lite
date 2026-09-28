// Buyer-side auto-trade consent record + trusted delivery contexts — upstream autotrade/consent.rs.
//   <home>/autotrade/consent/<jobId>.md (legacy fixed-field ConsentFile in the markdown container,
//   or the older raw `<jobId>.json`), <home>/autotrade/delivery-context/<jobId>/<deliveryId>.json,
//   <home>/autotrade/pending/<jobId>.json, <home>/autotrade/plugin-approved/<jobId>/<plugin>.
import { join } from 'node:path';
import { mkdirSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs';
import { F64, stringify, struct } from '../../../../core/json.mjs';
import { Decimal } from './amount.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { parseMarkdown, renderMarkdown } from './guide.mjs';
import { TradeEnvironment } from './trade-kit.mjs';
import { fromStr, fromSlice, firstValue, T } from './_serde-json.mjs';
import { onchainosHome, exists, readBytes, readToString, writeSecure, removeFileQuiet, nowSecs, u64Le, ioError } from './_fs.mjs';
import { SubscriptionTradePath } from '../config.mjs';
import { Lang } from '../user-lang.mjs';
import { isObj, isNum, numText, trim, asciiLower, isControl, cloneValue } from '../../../_rs.mjs';

// upstream: consent.rs::CONSENT_VERSION
export const CONSENT_VERSION = 6;

const MAX_DYNAMIC_SETTINGS_BYTES = 16 * 1024;
const MAX_DYNAMIC_SETTING_COUNT = 64;
const MAX_DYNAMIC_SETTING_KEY_LEN = 64;
const MAX_DYNAMIC_SETTING_STRING_LEN = 1024;
const MAX_DYNAMIC_SETTING_DEPTH = 4;
const MAX_DYNAMIC_SETTING_COLLECTION_LEN = 64;

const RESERVED_CONSENT_FIELDS = ['version', 'jobId', 'mode', 'capU', 'tradeAmountU', 'quoteToken', 'tradeEnvironment', 'marginMode',
  'orderPolicy', 'authMode', 'guideHash', 'requiredFields', 'extra', 'createdAt', 'expiresAt', 'status', 'lifecycle'];
const KNOWN_FLAT_SETTING_FIELDS = ['tradeAmountMode', 'tradeAmountRatio', 'tradeAmountBasis', 'leverageMode', 'leverage', 'maxLeverage',
  'takeProfitRatio', 'stopLossRatio', 'slippage', 'maxAutoSlippage', 'gasLevel', 'mevProtection', 'orderSize', 'sellShares', 'orderType',
  'tradeAmountType', 'tradeAmountPercent'];
const EXTRA_FIELD_TYPES = ['boolean', 'integer', 'decimal', 'string', 'enum', 'array', 'object'];
const EXTRA_FIELD_METADATA = ['label', 'type', 'value', 'description', 'constraints', 'options', 'appliesWhen', 'confirmedAt', 'unit'];

const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedKeys = (o) => Object.keys(o).sort(cmpBytes);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const chars = (s) => [...s];
const isStr = (v) => typeof v === 'string';
const isInt = (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';
const asU64 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n) ? v : undefined;

// ── dynamic settings validation ───────────────────────────────────────
// upstream: consent.rs::dynamic_setting_key_is_safe
function dynamicSettingKeyIsSafe(key) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && Buffer.byteLength(key) <= MAX_DYNAMIC_SETTING_KEY_LEN && !RESERVED_CONSENT_FIELDS.includes(key);
}
// upstream: consent.rs::dynamic_setting_key_is_sensitive
function dynamicSettingKeyIsSensitive(key) {
  const n = chars(key).filter((c) => /^[0-9A-Za-z]$/.test(c)).join('').toLowerCase();
  return ['password', 'passphrase', 'privatekey', 'secretkey', 'apikey', 'accesstoken', 'refreshtoken', 'credential', 'jwt'].some((w) => n.includes(w));
}
// upstream: consent.rs::validate_dynamic_setting_name
export function validateDynamicSettingName(key) {
  if (!KNOWN_FLAT_SETTING_FIELDS.includes(key) && !dynamicSettingKeyIsSafe(key)) throw new Error(`invalid or reserved dynamic consent setting key: ${key}`);
  if (dynamicSettingKeyIsSensitive(key)) throw new Error(`credentials must not be stored in consent settings: ${key}`);
}
// upstream: consent.rs::bounded_nonempty_text
function boundedNonemptyText(value, field, maxChars) {
  if (!isStr(value)) throw new Error(`${field} must be a string`);
  if (trim(value) === '') throw new Error(`${field} must not be empty`);
  if (chars(value).length > maxChars || chars(value).some(isControl)) throw new Error(`${field} is invalid or too long`);
}
// upstream: consent.rs::validate_string_or_string_array
function validateStringOrStringArray(value, field) {
  if (isStr(value)) return boundedNonemptyText(value, field, 64);
  if (Array.isArray(value) && value.length) {
    if (value.length > MAX_DYNAMIC_SETTING_COLLECTION_LEN) throw new Error(`${field} contains too many values`);
    for (const v of value) boundedNonemptyText(v, field, 64);
    return;
  }
  throw new Error(`${field} must be a string or non-empty string array`);
}
// upstream: consent.rs::decimal_setting_value
function decimalSettingValue(value, field) {
  const raw = isStr(value) ? value : isNum(value) ? numText(value) : undefined;
  if (raw === undefined) throw new Error(`${field} must be a decimal string or number`);
  try { return Decimal.parse(raw); } catch { throw new Error(`${field} must be a valid decimal`); }
}
// upstream: consent.rs::validate_extra_field_value
function validateExtraFieldValue(fieldType, value, field) {
  if (value === null) throw new Error(`extra.${field}.value is required and must not be null`);
  let valid;
  switch (fieldType) {
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'integer': valid = isInt(value); break;
    case 'decimal': valid = isStr(value) && (() => { try { Decimal.parse(value); return true; } catch { return false; } })(); break;
    case 'string': case 'enum': valid = isStr(value); break;
    case 'array': valid = Array.isArray(value); break;
    case 'object': valid = isObj(value); break;
    default: valid = false;
  }
  if (!valid) throw new Error(`extra.${field}.value does not match type ${fieldType}`);
  validateDynamicSettingValue(value, 0);
}
// upstream: consent.rs::validate_extra_constraints
function validateExtraConstraints(field, fieldType, value, constraints) {
  for (const key of sortedKeys(constraints)) {
    if (!['min', 'max', 'minExclusive', 'maxExclusive', 'minLength', 'maxLength'].includes(key)) throw new Error(`unsupported extra.${field}.constraints field: ${key}`);
  }
  if (fieldType === 'integer' || fieldType === 'decimal') {
    const actual = decimalSettingValue(value, `extra.${field}.value`);
    for (const key of ['min', 'max', 'minExclusive', 'maxExclusive']) {
      if (!hasOwn(constraints, key)) continue;
      const limit = decimalSettingValue(constraints[key], `extra.${field}.constraints.${key}`);
      const valid = key === 'min' ? limit.le(actual) : key === 'max' ? actual.le(limit)
        : key === 'minExclusive' ? limit.le(actual) && !limit.eq(actual) : actual.le(limit) && !actual.eq(limit);
      if (!valid) throw new Error(`extra.${field}.value violates ${key}`);
    }
  } else if (Object.keys(constraints).some((k) => ['min', 'max', 'minExclusive', 'maxExclusive'].includes(k))) {
    throw new Error(`numeric constraints require integer or decimal type for extra.${field}`);
  }
  const length = isStr(value) ? chars(value).length : Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : undefined;
  for (const key of ['minLength', 'maxLength']) {
    if (!hasOwn(constraints, key)) continue;
    const limit = asU64(constraints[key]);
    if (limit === undefined) throw new Error(`extra.${field}.constraints.${key} must be a non-negative integer`);
    if (length === undefined) throw new Error(`length constraints require string, array, or object type for extra.${field}`);
    const valid = key === 'minLength' ? BigInt(length) >= BigInt(limit) : BigInt(length) <= BigInt(limit);
    if (!valid) throw new Error(`extra.${field}.value violates ${key}`);
  }
}
// upstream: consent.rs::validate_extra_field
function validateExtraField(field, value) {
  if (!dynamicSettingKeyIsSafe(field) || dynamicSettingKeyIsSensitive(field)) throw new Error(`invalid or reserved extra consent field: ${field}`);
  if (!isObj(value)) throw new Error(`extra.${field} must be an object`);
  const metadata = value;
  for (const key of sortedKeys(metadata)) if (!EXTRA_FIELD_METADATA.includes(key)) throw new Error(`unsupported extra.${field} metadata field: ${key}`);
  if (!hasOwn(metadata, 'label')) throw new Error(`extra.${field}.label is required`);
  boundedNonemptyText(metadata.label, `extra.${field}.label`, 128);
  const fieldType = isStr(metadata.type) ? metadata.type : undefined;
  if (fieldType === undefined) throw new Error(`extra.${field}.type is required`);
  if (!EXTRA_FIELD_TYPES.includes(fieldType)) throw new Error(`extra.${field}.type must be one of: ${EXTRA_FIELD_TYPES.join(' | ')}`);
  if (!hasOwn(metadata, 'value')) throw new Error(`extra.${field}.value is required`);
  const confirmed = metadata.value;
  validateExtraFieldValue(fieldType, confirmed, field);
  if (hasOwn(metadata, 'description') && metadata.description !== null) boundedNonemptyText(metadata.description, `extra.${field}.description`, 1024);
  if (hasOwn(metadata, 'unit') && metadata.unit !== null) boundedNonemptyText(metadata.unit, `extra.${field}.unit`, 64);
  if (hasOwn(metadata, 'constraints') && metadata.constraints !== null) {
    if (!isObj(metadata.constraints)) throw new Error(`extra.${field}.constraints must be an object or null`);
    validateExtraConstraints(field, fieldType, confirmed, metadata.constraints);
  }
  if (hasOwn(metadata, 'options') && metadata.options !== null) {
    const options = metadata.options;
    if (!Array.isArray(options)) throw new Error(`extra.${field}.options must be an array or null`);
    if (!options.length || options.length > MAX_DYNAMIC_SETTING_COLLECTION_LEN) throw new Error(`extra.${field}.options must be a non-empty bounded array`);
    if (fieldType !== 'enum') throw new Error(`extra.${field}.options is only valid for enum fields`);
    if (options.some((o) => !isStr(o))) throw new Error(`extra.${field}.options entries must be strings`);
    if (!options.some((o) => o === confirmed)) throw new Error(`extra.${field}.value must be listed in options`);
  }
  if (hasOwn(metadata, 'appliesWhen') && metadata.appliesWhen !== null) {
    const aw = metadata.appliesWhen;
    if (!isObj(aw)) throw new Error(`extra.${field}.appliesWhen must be an object or null`);
    for (const key of sortedKeys(aw)) if (key !== 'venue' && key !== 'operation') throw new Error(`unsupported extra.${field}.appliesWhen field: ${key}`);
    for (const key of sortedKeys(aw)) validateStringOrStringArray(aw[key], `extra.${field}.appliesWhen.${key}`);
  }
  if (hasOwn(metadata, 'confirmedAt') && metadata.confirmedAt !== null && asU64(metadata.confirmedAt) === undefined) {
    throw new Error(`extra.${field}.confirmedAt must be a non-negative integer or null`);
  }
}
// upstream: consent.rs::validate_extra_settings
function validateExtraSettings(value, allowRemovals) {
  if (!isObj(value)) throw new Error('extra must be a JSON object');
  if (Object.keys(value).length > MAX_DYNAMIC_SETTING_COUNT) throw new Error('extra contains too many fields');
  for (const field of sortedKeys(value)) {
    const v = value[field];
    if (allowRemovals && v === null) {
      if (!dynamicSettingKeyIsSafe(field) || dynamicSettingKeyIsSensitive(field)) throw new Error(`invalid or reserved extra consent field: ${field}`);
      continue;
    }
    validateExtraField(field, v);
  }
}
// upstream: consent.rs::validate_dynamic_setting_value
function validateDynamicSettingValue(value, depth) {
  if (depth > MAX_DYNAMIC_SETTING_DEPTH) throw new Error('dynamic consent setting exceeds maximum nesting depth');
  if (value === null || typeof value === 'boolean' || isNum(value)) return;
  if (isStr(value)) {
    if (chars(value).length > MAX_DYNAMIC_SETTING_STRING_LEN) throw new Error('dynamic consent setting string is too long');
    if (chars(value).some(isControl)) throw new Error('dynamic consent setting contains control characters');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DYNAMIC_SETTING_COLLECTION_LEN) throw new Error('dynamic consent setting array is too large');
    for (const v of value) validateDynamicSettingValue(v, depth + 1);
    return;
  }
  if (Object.keys(value).length > MAX_DYNAMIC_SETTING_COLLECTION_LEN) throw new Error('dynamic consent setting object is too large');
  for (const key of sortedKeys(value)) {
    if (!dynamicSettingKeyIsSafe(key) || dynamicSettingKeyIsSensitive(key)) throw new Error(`invalid dynamic consent setting key: ${key}`);
    validateDynamicSettingValue(value[key], depth + 1);
  }
}
// upstream: consent.rs::validate_dynamic_settings_impl
function validateDynamicSettingsImpl(settings, allowRemovals) {
  if (Object.keys(settings).length > MAX_DYNAMIC_SETTING_COUNT) throw new Error('too many dynamic consent settings');
  if (Buffer.byteLength(stringify(settings)) > MAX_DYNAMIC_SETTINGS_BYTES) throw new Error('dynamic consent settings are too large');
  for (const key of sortedKeys(settings)) {
    const value = settings[key];
    if (key === 'extra') { if (value === null) continue; validateExtraSettings(value, allowRemovals); continue; }
    if (key === 'requiredFields') {
      if (!Array.isArray(value)) throw new Error('requiredFields must be an array');
      if (value.length > MAX_DYNAMIC_SETTING_COUNT) throw new Error('requiredFields contains too many fields');
      for (const f of value) { if (!isStr(f)) throw new Error('requiredFields entries must be strings'); validateRequiredFieldName(f); }
      continue;
    }
    if (!KNOWN_FLAT_SETTING_FIELDS.includes(key)) throw new Error(`unknown top-level consent setting ${key}; put service-specific fields under extra`);
    validateDynamicSettingName(key);
    validateDynamicSettingValue(value, 0);
    if (value === null) continue;
    switch (key) {
      case 'tradeAmountMode': if (!['fixed_amount', 'available_balance_ratio'].includes(value)) throw new Error('tradeAmountMode must be one of: fixed_amount | available_balance_ratio'); break;
      case 'tradeAmountRatio': { const r = decimalSettingValue(value, 'tradeAmountRatio'); if (r.isZero() || !r.le(Decimal.parse('1'))) throw new Error('tradeAmountRatio must be greater than 0 and at most 1'); break; }
      case 'tradeAmountBasis': if (!['notional', 'margin'].includes(value)) throw new Error('tradeAmountBasis must be one of: notional | margin'); break;
      case 'leverageMode': if (!['keep_account', 'fixed', 'signal_capped'].includes(value)) throw new Error('leverageMode must be one of: keep_account | fixed | signal_capped'); break;
      case 'leverage': case 'maxLeverage': case 'orderSize': case 'sellShares': if (decimalSettingValue(value, key).isZero()) throw new Error(`${key} must be greater than 0`); break;
      case 'mevProtection': if (typeof value !== 'boolean') throw new Error('mevProtection must be a boolean'); break;
      case 'orderType': boundedNonemptyText(value, 'orderType', 32); break;
      case 'tradeAmountType': if (!['fixed', 'percentage'].includes(value)) throw new Error('tradeAmountType must be one of: fixed | percentage'); break;
      case 'tradeAmountPercent': { const p = decimalSettingValue(value, 'tradeAmountPercent'); if (p.isZero() || !p.le(Decimal.parse('100'))) throw new Error('tradeAmountPercent must be greater than 0 and at most 100'); break; }
      case 'takeProfitRatio': case 'stopLossRatio': if (decimalSettingValue(value, key).isZero()) throw new Error(`${key} must be greater than 0`); break;
      default: break;
    }
  }
  if (hasOwn(settings, 'tradeAmountMode') && hasOwn(settings, 'tradeAmountType')) throw new Error('use tradeAmountMode; do not combine it with legacy tradeAmountType');
  if (hasOwn(settings, 'tradeAmountRatio') && hasOwn(settings, 'tradeAmountPercent')) throw new Error('use tradeAmountRatio; do not combine it with legacy tradeAmountPercent');
  const lm = isStr(settings.leverageMode) && hasOwn(settings, 'leverageMode') ? settings.leverageMode : undefined;
  const hasLev = hasOwn(settings, 'leverage') || hasOwn(settings, 'maxLeverage');
  if (lm === 'fixed' && !hasOwn(settings, 'leverage')) throw new Error('leverage is required when leverageMode=fixed');
  if (lm === 'signal_capped' && !hasOwn(settings, 'maxLeverage')) throw new Error('maxLeverage is required when leverageMode=signal_capped');
  if (lm === 'keep_account' && hasLev) throw new Error('leverage and maxLeverage are not valid when leverageMode=keep_account');
  if (lm === undefined && hasLev) throw new Error('leverageMode is required when leverage or maxLeverage is present');
}
// upstream: consent.rs::validate_dynamic_settings
export const validateDynamicSettings = (settings) => validateDynamicSettingsImpl(settings, false);
// upstream: consent.rs::validate_dynamic_setting_updates
const validateDynamicSettingUpdates = (settings) => validateDynamicSettingsImpl(settings, true);

// upstream: consent.rs::validate_required_field_name
export function validateRequiredFieldName(field) {
  if (['mode', 'tradeAmount', 'tradeAmountU', 'cap', 'quote', 'environment', 'marginMode', 'orderPolicy', 'authMode'].includes(field) || KNOWN_FLAT_SETTING_FIELDS.includes(field)) return;
  if (field.startsWith('extra.')) return validateDynamicSettingName(field.slice('extra.'.length));
  throw new Error(`unknown required consent field: ${field}`);
}
// upstream: consent.rs::dynamic_setting_present
export function dynamicSettingPresent(settings, field) {
  if (field.startsWith('extra.')) {
    const extra = settings.extra;
    return isObj(extra) && hasOwn(extra, field.slice('extra.'.length));
  }
  return hasOwn(settings, field) && settings[field] !== null;
}
// upstream: consent.rs::dynamic_decimal_setting → Decimal | null
export function dynamicDecimalSetting(settings, field) {
  return hasOwn(settings, field) ? decimalSettingValue(settings[field], field) : null;
}
// upstream: consent.rs::uses_percentage_amount
export const usesPercentageAmount = (settings) => settings.tradeAmountMode === 'available_balance_ratio' || settings.tradeAmountType === 'percentage';
// upstream: consent.rs::validate_amount_policy
export function validateAmountPolicy(tradeAmountU, settings) {
  const mode = isStr(settings.tradeAmountMode) ? settings.tradeAmountMode : undefined;
  if (mode === 'fixed_amount' && (tradeAmountU === null || tradeAmountU === undefined)) throw new Error('tradeAmountU is required when tradeAmountMode=fixed_amount');
  if (mode === 'available_balance_ratio' && !hasOwn(settings, 'tradeAmountRatio')) throw new Error('tradeAmountRatio is required when tradeAmountMode=available_balance_ratio');
  if (mode === undefined && hasOwn(settings, 'tradeAmountRatio')) throw new Error('tradeAmountMode=available_balance_ratio is required when tradeAmountRatio is present');
  const type = isStr(settings.tradeAmountType) ? settings.tradeAmountType : undefined;
  if (type === 'fixed' && (tradeAmountU === null || tradeAmountU === undefined)) throw new Error('tradeAmountU is required when tradeAmountType=fixed');
  if (type === 'percentage' && !hasOwn(settings, 'tradeAmountPercent')) throw new Error('tradeAmountPercent is required when tradeAmountType=percentage');
  if (type === undefined && hasOwn(settings, 'tradeAmountPercent')) throw new Error('tradeAmountType=percentage is required when tradeAmountPercent is present');
}
// upstream: consent.rs::parse_dynamic_settings_json
export function parseDynamicSettingsJson(input, flag) {
  if (input === undefined || input === null) return {};
  if (Buffer.byteLength(input) > MAX_DYNAMIC_SETTINGS_BYTES) throw new Error(`${flag} is too large`);
  let value;
  try { value = fromStr(input, T.value); } catch { throw new Error(`${flag} must be a JSON object`); }
  if (!isObj(value)) throw new Error(`${flag} must be a JSON object`);
  validateDynamicSettingUpdates(value);
  return value;
}
// upstream: consent.rs::merge_dynamic_settings (mutates target)
export function mergeDynamicSettings(target, updates) {
  for (const key of sortedKeys(updates)) {
    const value = updates[key];
    if (value === null) delete target[key];
    else if (key === 'extra') {
      const merged = isObj(target[key]) ? cloneValue(target[key]) : {};
      if (isObj(value)) for (const f of sortedKeys(value)) { if (value[f] === null) delete merged[f]; else merged[f] = cloneValue(value[f]); }
      if (!Object.keys(merged).length) delete target[key]; else target[key] = merged;
    } else target[key] = cloneValue(value);
  }
}

// ── delivery context ──────────────────────────────────────────────────
// upstream: consent.rs::DELIVERY_CONTEXT_VERSION
export const DELIVERY_CONTEXT_VERSION = 2;
const TRADE_PATH_T = T.enum('SubscriptionTradePath', [['agent_direct', SubscriptionTradePath.AgentDirect], ['legacy_wrapper', SubscriptionTradePath.LegacyWrapper]]);
// upstream: consent.rs::DeliveryContext (deny_unknown_fields)
export const DELIVERY_CONTEXT_T = T.struct('DeliveryContext', [
  ['version', T.u32], ['jobId', T.string], ['agentId', T.string], ['providerAgentId', T.string],
  ['originSessionKey', T.option(T.string), null], ['deliveryId', T.string], ['savedPath', T.string],
  ['deliverableType', T.string], ['receivedAtMs', T.u64], ['executionPath', TRADE_PATH_T, SubscriptionTradePath.LegacyWrapper],
], { denyUnknown: true });
// serde Serialize (struct order, originSessionKey skipped when None)
export const deliveryContextJson = (c) => struct({
  version: c.version, jobId: c.jobId, agentId: c.agentId, providerAgentId: c.providerAgentId,
  originSessionKey: c.originSessionKey === null || c.originSessionKey === undefined ? undefined : c.originSessionKey,
  deliveryId: c.deliveryId, savedPath: c.savedPath, deliverableType: c.deliverableType, receivedAtMs: c.receivedAtMs, executionPath: c.executionPath,
});
// derive(PartialEq)
export const deliveryContextEq = (a, b) => a.version === b.version && a.jobId === b.jobId && a.agentId === b.agentId
  && a.providerAgentId === b.providerAgentId && (a.originSessionKey ?? null) === (b.originSessionKey ?? null) && a.deliveryId === b.deliveryId
  && a.savedPath === b.savedPath && a.deliverableType === b.deliverableType && BigInt(a.receivedAtMs) === BigInt(b.receivedAtMs)
  && a.executionPath === b.executionPath;

// upstream: consent.rs::delivery_id_is_safe — 1..=96 bytes [A-Za-z0-9_:-]
const deliveryIdIsSafe = (d) => typeof d === 'string' && d.length > 0 && d.length <= 96 && /^[A-Za-z0-9_:-]+$/.test(d);
// upstream: consent.rs::delivery_context_path
function deliveryContextPath(jobId, deliveryId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  if (!deliveryIdIsSafe(deliveryId)) throw new Error('invalid delivery id');
  return join(onchainosHome(), 'autotrade', 'delivery-context', jobId, `${deliveryId}.json`);
}
// upstream: consent.rs::pending_delivery_path
function pendingDeliveryPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'pending', `${jobId}.json`);
}

// upstream: consent.rs::register_delivery_context
export const registerDeliveryContext = (jobId, agentId, providerAgentId, originSessionKey, deliveryId, savedPath, deliverableType, receivedAtMs) =>
  registerDeliveryContextWithPath(jobId, agentId, providerAgentId, originSessionKey, deliveryId, savedPath, deliverableType, receivedAtMs, SubscriptionTradePath.LegacyWrapper);

// upstream: consent.rs::register_delivery_context_with_path
export function registerDeliveryContextWithPath(jobId, agentId, providerAgentId, originSessionKey, deliveryId, savedPath, deliverableType, receivedAtMs, executionPath) {
  const path = deliveryContextPath(jobId, deliveryId);
  if (exists(path)) {
    const e = loadDeliveryContext(jobId, deliveryId);
    if (e.agentId !== agentId || e.providerAgentId !== providerAgentId || e.deliveryId !== deliveryId || e.savedPath !== savedPath || e.deliverableType !== deliverableType) {
      throw new Error('delivery context identity mismatch');
    }
    return e;
  }
  const context = {
    version: DELIVERY_CONTEXT_VERSION, jobId, agentId, providerAgentId, originSessionKey: originSessionKey ?? null,
    deliveryId, savedPath, deliverableType, receivedAtMs, executionPath,
  };
  writeSecure(path, stringify(deliveryContextJson(context), true));
  return context;
}

// upstream: consent.rs::load_delivery_context
export function loadDeliveryContext(jobId, deliveryId) {
  const path = deliveryContextPath(jobId, deliveryId);
  const context = fromSlice(readBytes(path), DELIVERY_CONTEXT_T);
  if (!(context.version >= 1 && context.version <= DELIVERY_CONTEXT_VERSION) || context.jobId !== jobId || context.deliveryId !== deliveryId) {
    throw new Error('delivery context mismatch');
  }
  return context;
}

// upstream: consent.rs::activate_delivery_context
export function activateDeliveryContext(jobId, deliveryId) {
  const context = loadDeliveryContext(jobId, deliveryId);
  writeSecure(pendingDeliveryPath(jobId), stringify(deliveryContextJson(context), true));
  return context;
}

// upstream: consent.rs::activate_delivery_context_exclusive → { kind: 'Activated'|'AlreadyPending'|'Conflict', context }
export function activateDeliveryContextExclusive(jobId, deliveryId) {
  const context = loadDeliveryContext(jobId, deliveryId);
  const path = pendingDeliveryPath(jobId);
  const parent = join(path, '..');
  try { mkdirSync(parent, { recursive: true }); } catch (e) { throw ioError(e); }
  if (process.platform !== 'win32') { try { chmodSync(parent, 0o700); } catch {} }
  const body = stringify(deliveryContextJson(context), true);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') {
      const pending = loadPendingDeliveryContext(jobId);
      if (!pending) throw new Error('pending delivery disappeared during activation');
      return { kind: pending.deliveryId === deliveryId ? 'AlreadyPending' : 'Conflict', context: pending };
    }
    throw ioError(e);
  }
  try { writeSync(fd, body); } catch (e) { throw ioError(e); } finally { try { closeSync(fd); } catch {} }
  return { kind: 'Activated', context };
}

// upstream: consent.rs::load_pending_delivery_context → context | null
export function loadPendingDeliveryContext(jobId) {
  const path = pendingDeliveryPath(jobId);
  if (!exists(path)) return null;
  const context = fromSlice(readBytes(path), DELIVERY_CONTEXT_T);
  if (!(context.version >= 1 && context.version <= DELIVERY_CONTEXT_VERSION) || context.jobId !== jobId) {
    throw new Error('pending delivery context mismatch');
  }
  return context;
}

// upstream: consent.rs::clear_pending_signal
export function clearPendingSignal(jobId) {
  if (!jobIdIsSafe(jobId)) return;
  let home;
  try { home = onchainosHome(); } catch { return; }
  removeFileQuiet(join(home, 'autotrade', 'pending', `${jobId}.json`));
}

// upstream: consent.rs::clear_pending_delivery
export function clearPendingDelivery(jobId, deliveryId) {
  let p = null;
  try { p = loadPendingDeliveryContext(jobId); } catch { p = null; }
  if (p && p.deliveryId === deliveryId) clearPendingSignal(jobId);
}

// ── decision summary ──────────────────────────────────────────────────
// upstream: consent.rs::bounded_json_after_marker
function boundedJsonAfterMarker(raw) {
  const MARKER = '[ACTIONABLE_TRADING_SIGNAL]';
  const i = raw.indexOf(MARKER);
  const tail = i >= 0 ? raw.slice(i + MARKER.length) : raw;
  const start = tail.indexOf('{');
  if (start < 0) return undefined;
  return firstValue(tail.slice(start));
}
// upstream: consent.rs::short_display
function shortDisplay(value, max) {
  const kept = chars(value).filter((c) => !isControl(c));
  const s = kept.slice(0, max).join('');
  return kept.length > max ? `${s}…` : s;
}
// serde_json::Value::pointer
function pointer(value, ptr) {
  if (ptr === '') return value;
  if (!ptr.startsWith('/')) return undefined;
  let v = value;
  for (const raw of ptr.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (isObj(v)) { if (!hasOwn(v, token)) return undefined; v = v[token]; }
    else if (Array.isArray(v)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const idx = Number(token);
      if (idx >= v.length) return undefined;
      v = v[idx];
    } else return undefined;
  }
  return v;
}
// Path::file_name → string | undefined
function pathFileName(p) {
  const trimmed = p.replace(/[\\/]+$/, '');
  if (trimmed === '') return undefined;
  const name = process.platform === 'win32' ? trimmed.split(/[\\/]/).pop() : trimmed.split('/').pop();
  return name === '..' || name === '.' || name === '' ? undefined : name;
}

// upstream: consent.rs::delivery_decision_summary
export function deliveryDecisionSummary(context, lang) {
  let raw;
  try { raw = chars(readToString(context.savedPath)).slice(0, 64 * 1024).join(''); } catch { raw = undefined; }
  const signal = raw === undefined ? undefined : boundedJsonAfterMarker(raw);
  const field = (ptr) => {
    if (signal === undefined) return undefined;
    const v = pointer(signal, ptr);
    let s;
    if (isStr(v)) s = v;
    else if (isNum(v)) s = numText(v);
    else return undefined;
    if (trim(s) === '') return undefined;
    return shortDisplay(trim(s), 128);
  };
  const signalId = field('/signalId');
  const signalType = field('/signalType') ?? context.deliverableType;
  const side = field('/params/side');
  const amount = field('/params/amount');
  const amountUnit = field('/params/amountUnit');
  const quote = field('/params/quoteCurrency');
  const chain = field('/params/chainIndex');
  const token = field('/params/tokenAddress');
  const fn = pathFileName(context.savedPath);
  const fileName = fn === undefined ? undefined : shortDisplay(fn, 96);
  const zh = lang === Lang.Zh;
  const lines = [zh ? '[对应交付物]' : '[Deliverable for this decision]'];
  const push = (z, e, v) => { if (v !== undefined) lines.push(zh ? `${z}: ${v}` : `${e}: ${v}`); };
  push('交付 ID', 'Delivery ID', shortDisplay(context.deliveryId, 128));
  push('信号 ID', 'Signal ID', signalId);
  push('信号类型', 'Signal type', signalType);
  push('方向', 'Side', side);
  push('信号金额', 'Signal amount', amount === undefined ? undefined : [amount, amountUnit, quote].filter((x) => x !== undefined).join(' '));
  push('链', 'Chain', chain);
  push('Token', 'Token', token);
  if (signal === undefined) push('文件', 'File', fileName);
  return lines.join('\n');
}

// upstream: consent.rs::pending_delivery_decision_summary → string | undefined
export function pendingDeliveryDecisionSummary(jobId, lang) {
  let c = null;
  try { c = loadPendingDeliveryContext(jobId); } catch { return undefined; }
  return c ? deliveryDecisionSummary(c, lang) : undefined;
}

// ── consent file ──────────────────────────────────────────────────────
// upstream: consent.rs::ConsentMode / TradeKitAuthMode / MarginMode / OrderPolicy / ConsentLifecycle (wire strings)
export const ConsentMode = Object.freeze({ Auto: 'auto', Manual: 'manual', Decline: 'decline' });
export const TradeKitAuthMode = Object.freeze({
  OAuth: 'oauth', ApiKey: 'api_key',
  parse(value) {
    const v = asciiLower(value);
    if (v === 'oauth') return 'oauth';
    if (v === 'api_key' || v === 'api-key') return 'api_key';
    throw new Error('auth mode must be one of: oauth | api_key');
  },
});
export const MarginMode = Object.freeze({
  Cross: 'cross', Isolated: 'isolated',
  parse(value) { const v = asciiLower(value); if (v === 'cross' || v === 'isolated') return v; throw new Error('margin mode must be one of: cross | isolated'); },
});
export const OrderPolicy = Object.freeze({
  Market: 'market', SignalPriceLimit: 'signal_price_limit',
  parse(value) { const v = asciiLower(value); if (v === 'market' || v === 'signal_price_limit') return v; throw new Error('order policy must be one of: market | signal_price_limit'); },
});
export const ConsentLifecycle = Object.freeze({ Prepared: 'prepared', Active: 'active', Aborted: 'aborted' });

const MODE_T = T.enum('ConsentMode', [['auto', 'auto'], ['manual', 'manual'], ['decline', 'decline']]);
const ENV_T = T.enum('TradeEnvironment', [['configured', 'configured'], ['live', 'live'], ['demo', 'demo']]);
const MARGIN_T = T.enum('MarginMode', [['cross', 'cross'], ['isolated', 'isolated']]);
const ORDER_T = T.enum('OrderPolicy', [['market', 'market'], ['signal_price_limit', 'signal_price_limit']]);
const AUTH_T = T.enum('TradeKitAuthMode', [['oauth', 'oauth'], ['api_key', 'api_key']], [['o_auth', 'oauth']]);
const LIFECYCLE_T = T.enum('ConsentLifecycle', [['prepared', 'prepared'], ['active', 'active'], ['aborted', 'aborted']]);
// upstream: consent.rs::ConsentFile (dynamic settings flattened)
export const CONSENT_FILE_T = T.struct('ConsentFile', [
  ['version', T.u32], ['jobId', T.string], ['mode', MODE_T], ['capU', T.option(T.string)],
  ['tradeAmountU', T.option(T.string), null], ['quoteToken', T.option(T.string), null], ['tradeEnvironment', T.option(ENV_T), null],
  ['marginMode', T.option(MARGIN_T), null], ['orderPolicy', T.option(ORDER_T), null], ['authMode', T.option(AUTH_T), null],
  ['guideHash', T.option(T.string), null], ['lifecycle', LIFECYCLE_T, ConsentLifecycle.Active],
  ['createdAt', T.u64], ['expiresAt', T.u64],
], { flatten: 'dynamicSettings' });

const optNone = (v) => (v === null || v === undefined ? undefined : v);
// ConsentFile Serialize (serialize_map with the flattened settings in BTreeMap order)
export function consentFileJson(f) {
  const out = struct({
    version: f.version, jobId: f.jobId, mode: f.mode, capU: optNone(f.capU), tradeAmountU: optNone(f.tradeAmountU),
    quoteToken: optNone(f.quoteToken), tradeEnvironment: optNone(f.tradeEnvironment), marginMode: optNone(f.marginMode),
    orderPolicy: optNone(f.orderPolicy), authMode: optNone(f.authMode), guideHash: optNone(f.guideHash), lifecycle: f.lifecycle,
  });
  for (const k of sortedKeys(f.dynamicSettings ?? {})) out[k] = f.dynamicSettings[k];
  out.createdAt = f.createdAt;
  out.expiresAt = f.expiresAt;
  return out;
}
// serde_json::to_value(&ConsentFile) → plain (sorted) object
export function consentFileValue(f) {
  const j = consentFileJson(f);
  const out = {};
  for (const k of Object.keys(j)) if (j[k] !== undefined) out[k] = cloneValue(j[k]);
  return out;
}

// upstream: consent.rs quote constants
export const DEFAULT_QUOTE = 'usdt';
export const QUOTE_WHITELIST = Object.freeze(['usdc', 'usdt']);

// upstream: consent.rs failure codes
export const CONSENT_UNREADABLE = 'consent_unreadable';
export const CONSENT_VERSION_TOO_NEW = 'consent_version_too_new';
export const CONSENT_JOB_MISMATCH = 'consent_job_mismatch';

// upstream: consent.rs::ConsentError — Display is the code.
export class ConsentError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// upstream: consent.rs::ConsentDecision
export const ConsentDecision = Object.freeze({ FirstTime: 'FirstTime', Declined: 'Declined', Manual: 'Manual', AutoAllow: 'AutoAllow', AutoOverCap: 'AutoOverCap' });

// upstream: consent.rs::persisted_required_fields_are_complete
function persistedRequiredFieldsAreComplete(file) {
  const fields = file.dynamicSettings.requiredFields;
  if (!Array.isArray(fields)) return true;
  return fields.every((f) => {
    if (!isStr(f)) return false;
    switch (f) {
      case 'mode': return true;
      case 'tradeAmount': case 'tradeAmountU': return file.tradeAmountU !== null && file.tradeAmountU !== undefined;
      case 'cap': return file.capU !== null && file.capU !== undefined;
      case 'quote': return file.quoteToken !== null && file.quoteToken !== undefined;
      case 'environment': return file.tradeEnvironment !== null && file.tradeEnvironment !== undefined;
      case 'marginMode': return file.marginMode !== null && file.marginMode !== undefined;
      case 'orderPolicy': return file.orderPolicy !== null && file.orderPolicy !== undefined;
      case 'authMode': return file.authMode !== null && file.authMode !== undefined;
      default: return dynamicSettingPresent(file.dynamicSettings, f);
    }
  });
}
// upstream: consent.rs::inferred_extra_type
function inferredExtraType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (isInt(value)) return 'integer';
  if (value instanceof F64) return 'decimal';
  if (isStr(value)) return 'string';
  if (Array.isArray(value)) return 'array';
  if (isObj(value)) return 'object';
  return 'string';
}
// upstream: consent.rs::migrate_legacy_flat_settings (mutates file)
function migrateLegacyFlatSettings(file) {
  const ds = file.dynamicSettings;
  if (file.guideHash === null || file.guideHash === undefined) {
    const v = ds.serviceGuideHash;
    const had = hasOwn(ds, 'serviceGuideHash');
    delete ds.serviceGuideHash;
    file.guideHash = had && isStr(v) ? asciiLower(v) : null;
  }
  const legacyKeys = sortedKeys(ds).filter((k) => !KNOWN_FLAT_SETTING_FIELDS.includes(k) && k !== 'requiredFields' && k !== 'extra');
  if (!legacyKeys.length) return;
  const extra = isObj(ds.extra) ? cloneValue(ds.extra) : {};
  for (const key of legacyKeys) {
    let value = ds[key];
    delete ds[key];
    const fieldType = inferredExtraType(value);
    if (value instanceof F64) value = numText(value);
    if (!hasOwn(extra, key)) extra[key] = { label: key, type: fieldType, value };
  }
  ds.extra = extra;
}

// upstream: consent.rs::consent_path / legacy_consent_path
function consentPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new ConsentError(CONSENT_UNREADABLE);
  let home;
  try { home = onchainosHome(); } catch { throw new ConsentError(CONSENT_UNREADABLE); }
  return join(home, 'autotrade', 'consent', `${jobId}.md`);
}
function legacyConsentPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new ConsentError(CONSENT_UNREADABLE);
  let home;
  try { home = onchainosHome(); } catch { throw new ConsentError(CONSENT_UNREADABLE); }
  return join(home, 'autotrade', 'consent', `${jobId}.json`);
}

// upstream: consent.rs::read_consent_file → ConsentFile | null (throws ConsentError)
function readConsentFile(jobId) {
  if (!jobIdIsSafe(jobId)) throw new ConsentError(CONSENT_UNREADABLE);
  const path = consentPath(jobId);
  const legacyPath = legacyConsentPath(jobId);
  if (!exists(path) && !exists(legacyPath)) return null;
  let raw;
  try { raw = readToString(exists(path) ? path : legacyPath); } catch { throw new ConsentError(CONSENT_UNREADABLE); }
  let file;
  try {
    file = raw.startsWith('<!-- onchainos-autotrade:consent\n') ? parseMarkdown('consent', raw, CONSENT_FILE_T) : fromStr(raw, CONSENT_FILE_T);
  } catch { throw new ConsentError(CONSENT_UNREADABLE); }
  if (file.version > CONSENT_VERSION) throw new ConsentError(CONSENT_VERSION_TOO_NEW);
  if (file.jobId !== jobId) throw new ConsentError(CONSENT_JOB_MISMATCH);
  migrateLegacyFlatSettings(file);
  const ok = (() => {
    try { validateDynamicSettings(file.dynamicSettings); } catch { return false; }
    if (Object.values(file.dynamicSettings).some((v) => v === null)) return false;
    try { validateAmountPolicy(file.tradeAmountU, file.dynamicSettings); } catch { return false; }
    return persistedRequiredFieldsAreComplete(file);
  })();
  if (!ok) throw new ConsentError(CONSENT_UNREADABLE);
  if (file.tradeEnvironment !== null && file.tradeEnvironment !== undefined && !TradeEnvironment.isExplicit(file.tradeEnvironment)) {
    throw new ConsentError(CONSENT_UNREADABLE);
  }
  return file;
}

// upstream: consent.rs::load_consent → ConsentFile | null (throws ConsentError)
export function loadConsent(jobId) {
  const file = readConsentFile(jobId);
  if (!file) return null;
  if (file.lifecycle !== ConsentLifecycle.Active) return null;
  if (u64Le(file.expiresAt, nowSecs())) return null;
  return file;
}

// upstream: consent.rs::ConsentSnapshotStatus (wire strings)
export const ConsentSnapshotStatus = Object.freeze({ NotSet: 'not_set', Active: 'active', Unreadable: 'unreadable' });

// upstream: consent.rs::consent_snapshot → ConsentSnapshot (struct order, flattened settings)
export function consentSnapshot(jobId) {
  let file;
  try { file = loadConsent(jobId); } catch { return struct({ status: ConsentSnapshotStatus.Unreadable }); }
  if (!file) return struct({ status: ConsentSnapshotStatus.NotSet });
  const out = struct({
    status: ConsentSnapshotStatus.Active, version: file.version, mode: file.mode, capU: optNone(file.capU), tradeAmountU: optNone(file.tradeAmountU),
    quoteToken: optNone(file.quoteToken), tradeEnvironment: optNone(file.tradeEnvironment), marginMode: optNone(file.marginMode),
    orderPolicy: optNone(file.orderPolicy), authMode: optNone(file.authMode), guideHash: optNone(file.guideHash),
  });
  for (const k of sortedKeys(file.dynamicSettings)) out[k] = file.dynamicSettings[k];
  out.createdAt = file.createdAt;
  out.expiresAt = file.expiresAt;
  return out;
}

// upstream: consent.rs::quote_token
export function quoteToken(jobId) {
  let file = null;
  try { file = loadConsent(jobId); } catch { file = null; }
  const q = file?.quoteToken;
  return q !== null && q !== undefined && QUOTE_WHITELIST.includes(q) ? q : DEFAULT_QUOTE;
}

// upstream: consent.rs::evaluate_consent(job, buyAmount: Decimal | null) → ConsentDecision (throws ConsentError)
export function evaluateConsent(jobId, buyAmount) {
  const file = loadConsent(jobId);
  if (!file) return ConsentDecision.FirstTime;
  if (file.mode === ConsentMode.Decline) return ConsentDecision.Declined;
  if (file.mode === ConsentMode.Manual) return ConsentDecision.Manual;
  if (buyAmount === null || buyAmount === undefined) return ConsentDecision.AutoAllow;
  let within = false;
  if (file.capU !== null && file.capU !== undefined) {
    try { within = buyAmount.le(Decimal.parse(file.capU)); } catch { within = false; }
  }
  return within ? ConsentDecision.AutoAllow : ConsentDecision.AutoOverCap;
}

// ── consent writers (retained compatibility API; no release command writes this format) ──
const U64_MOD = 1n << 64n;
const wrapAdd = (a, b) => { const v = (BigInt(a) + BigInt(b)) % U64_MOD; return Number.isSafeInteger(Number(v)) ? Number(v) : v; };

// upstream: consent.rs::write_consent_file
function writeConsentFile(file) {
  let path;
  try { path = consentPath(file.jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  writeSecure(path, renderMarkdown('consent', consentFileJson(file), '# Subscription Consent\n\nThis record contains user-confirmed settings for the matching local service Guide.\n'));
}

// upstream: consent.rs::write_consent_policy_with_dynamic_settings
export function writeConsentPolicyWithDynamicSettings(jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, marginMode, orderPolicy, authMode, dynamicUpdates, ttlSec) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  if (BigInt(ttlSec) === 0n) throw new Error('--ttl-sec must be > 0');
  let existing = null;
  try { existing = readConsentFile(jobId); } catch { existing = null; }
  let cap;
  if (mode === ConsentMode.Auto) {
    if (capU !== null && capU !== undefined) {
      let parsed;
      try { parsed = Decimal.parse(capU); } catch { throw new Error('--cap is not a valid decimal'); }
      if (parsed.isZero()) throw new Error('--cap must be greater than 0');
      cap = capU;
    } else cap = null;
  } else {
    if (capU !== null && capU !== undefined) throw new Error('--cap is only valid with --mode auto');
    cap = existing?.capU ?? null;
  }
  let amount;
  if (tradeAmountU !== null && tradeAmountU !== undefined) {
    let parsed;
    try { parsed = Decimal.parse(tradeAmountU); } catch { throw new Error('--trade-amount is not a valid decimal'); }
    if (parsed.isZero()) throw new Error('--trade-amount must be greater than 0');
    amount = tradeAmountU;
  } else amount = existing?.tradeAmountU ?? null;
  let quoteToken;
  if (quote !== null && quote !== undefined) {
    const q = asciiLower(quote);
    if (!QUOTE_WHITELIST.includes(q)) throw new Error('--quote must be one of: usdc | usdt');
    quoteToken = q;
  } else quoteToken = existing?.quoteToken ?? null;
  if (tradeEnvironment !== null && tradeEnvironment !== undefined && !TradeEnvironment.isExplicit(tradeEnvironment)) throw new Error('trade environment must be live or demo');
  const env = tradeEnvironment ?? existing?.tradeEnvironment ?? null;
  const dynamicSettings = existing ? cloneValue(existing.dynamicSettings) : {};
  if (dynamicUpdates !== null && dynamicUpdates !== undefined) {
    validateDynamicSettingUpdates(dynamicUpdates);
    mergeDynamicSettings(dynamicSettings, dynamicUpdates);
  }
  validateDynamicSettings(dynamicSettings);
  validateAmountPolicy(amount, dynamicSettings);
  const createdAt = nowSecs();
  const file = {
    version: CONSENT_VERSION, jobId, mode, capU: cap, tradeAmountU: amount, quoteToken, tradeEnvironment: env,
    marginMode: marginMode ?? existing?.marginMode ?? null, orderPolicy: orderPolicy ?? existing?.orderPolicy ?? null,
    authMode: authMode ?? existing?.authMode ?? null, guideHash: existing?.guideHash ?? null,
    lifecycle: existing ? existing.lifecycle : ConsentLifecycle.Active, dynamicSettings, createdAt, expiresAt: wrapAdd(createdAt, ttlSec),
  };
  if (!persistedRequiredFieldsAreComplete(file)) throw new Error('requiredFields contains a setting without a confirmed value');
  writeConsentFile(file);
}
// upstream: consent.rs::write_consent_policy_with_settings / write_consent_policy / write_consent_with_trade_amount / write_consent
export const writeConsentPolicyWithSettings = (jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, marginMode, orderPolicy, authMode, ttlSec) =>
  writeConsentPolicyWithDynamicSettings(jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, marginMode, orderPolicy, authMode, null, ttlSec);
export const writeConsentPolicy = (jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, ttlSec) =>
  writeConsentPolicyWithSettings(jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, null, null, null, ttlSec);
export const writeConsentWithTradeAmount = (jobId, mode, capU, tradeAmountU, quote, ttlSec) => writeConsentPolicy(jobId, mode, capU, tradeAmountU, quote, null, ttlSec);
export const writeConsent = (jobId, mode, capU, quote, ttlSec) => writeConsentWithTradeAmount(jobId, mode, capU, null, quote, ttlSec);

// upstream: consent.rs::write_prepared_consent_policy_with_dynamic_settings
export function writePreparedConsentPolicyWithDynamicSettings(jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, marginMode, orderPolicy, authMode, dynamicUpdates, guideHash, ttlSec) {
  if (!/^[0-9A-Fa-f]{64}$/.test(guideHash)) throw new Error('service guide hash is invalid');
  writeConsentPolicyWithDynamicSettings(jobId, mode, capU, tradeAmountU, quote, tradeEnvironment, marginMode, orderPolicy, authMode, dynamicUpdates, ttlSec);
  let file;
  try { file = readConsentFile(jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  if (!file) throw new Error('prepared consent could not be read');
  file.guideHash = asciiLower(guideHash);
  file.lifecycle = ConsentLifecycle.Prepared;
  writeConsentFile(file);
}
// upstream: consent.rs::activate_prepared_consent
export function activatePreparedConsent(jobId) {
  let file;
  try { file = readConsentFile(jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  if (!file) throw new Error('prepared consent is not available');
  if (file.lifecycle !== ConsentLifecycle.Prepared || file.guideHash === null || file.guideHash === undefined) throw new Error('prepared consent is invalid');
  file.version = CONSENT_VERSION;
  file.lifecycle = ConsentLifecycle.Active;
  writeConsentFile(file);
}
// upstream: consent.rs::abort_prepared_consent
export function abortPreparedConsent(jobId) {
  let file;
  try { file = readConsentFile(jobId); } catch { return; }
  if (file && file.lifecycle === ConsentLifecycle.Prepared) {
    file.lifecycle = ConsentLifecycle.Aborted;
    try { writeConsentFile(file); } catch {}
  }
}
// upstream: consent.rs::write_trade_environment
export function writeTradeEnvironment(jobId, tradeEnvironment) {
  if (!TradeEnvironment.isExplicit(tradeEnvironment)) throw new Error('trade environment must be live or demo');
  let file;
  try { file = loadConsent(jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  if (!file) throw new Error('no live consent');
  file.version = CONSENT_VERSION;
  file.tradeEnvironment = tradeEnvironment;
  writeConsentFile(file);
  return file;
}
// upstream: consent.rs::write_trade_settings_with_dynamic
export function writeTradeSettingsWithDynamic(jobId, tradeEnvironment, marginMode, orderPolicy, authMode, dynamicUpdates) {
  const none = (v) => v === null || v === undefined;
  if (none(tradeEnvironment) && none(marginMode) && none(orderPolicy) && none(authMode) && (none(dynamicUpdates) || !Object.keys(dynamicUpdates).length)) {
    throw new Error('at least one consent setting is required');
  }
  if (!none(tradeEnvironment) && !TradeEnvironment.isExplicit(tradeEnvironment)) throw new Error('trade environment must be live or demo');
  let file;
  try { file = loadConsent(jobId); } catch (e) { throw new Error(e.code ?? e.message); }
  if (!file) throw new Error('no live consent');
  file.version = CONSENT_VERSION;
  if (!none(tradeEnvironment)) file.tradeEnvironment = tradeEnvironment;
  if (!none(marginMode)) file.marginMode = marginMode;
  if (!none(orderPolicy)) file.orderPolicy = orderPolicy;
  if (!none(authMode)) file.authMode = authMode;
  if (!none(dynamicUpdates)) {
    validateDynamicSettingUpdates(dynamicUpdates);
    mergeDynamicSettings(file.dynamicSettings, dynamicUpdates);
    validateDynamicSettings(file.dynamicSettings);
  }
  validateAmountPolicy(file.tradeAmountU, file.dynamicSettings);
  if (!persistedRequiredFieldsAreComplete(file)) throw new Error('requiredFields contains a setting without a confirmed value');
  writeConsentFile(file);
  return file;
}
// upstream: consent.rs::write_trade_settings
export const writeTradeSettings = (jobId, tradeEnvironment, marginMode, orderPolicy, authMode) => writeTradeSettingsWithDynamic(jobId, tradeEnvironment, marginMode, orderPolicy, authMode, null);

// upstream: consent.rs::clear_consent
export function clearConsent(jobId) {
  try { removeFileQuiet(consentPath(jobId)); } catch {}
  try { removeFileQuiet(legacyConsentPath(jobId)); } catch {}
}

// ── plugin-install approval markers ───────────────────────────────────
// upstream: consent.rs::plugin_approved_path
function pluginApprovedPath(jobId, plugin) {
  if (!jobIdIsSafe(jobId)) throw new ConsentError(CONSENT_UNREADABLE);
  const safe = chars(String(plugin)).filter((c) => /^[A-Za-z0-9_-]$/.test(c)).join('');
  if (safe === '') throw new ConsentError(CONSENT_UNREADABLE);
  let home;
  try { home = onchainosHome(); } catch { throw new ConsentError(CONSENT_UNREADABLE); }
  return join(home, 'autotrade', 'plugin-approved', jobId, safe);
}
// upstream: consent.rs::plugin_approved
export function pluginApproved(jobId, plugin) {
  try { return exists(pluginApprovedPath(jobId, plugin)); } catch { return false; }
}
// upstream: consent.rs::write_plugin_approved
export function writePluginApproved(jobId, plugin) {
  const path = pluginApprovedPath(jobId, plugin);
  try { writeSecure(path, '1'); } catch { throw new ConsentError(CONSENT_UNREADABLE); }
}

