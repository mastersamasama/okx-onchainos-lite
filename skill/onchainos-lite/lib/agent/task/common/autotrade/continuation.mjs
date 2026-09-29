// Short-lived state for incomplete auto-trade configuration — upstream autotrade/continuation.rs.
// `<home>/autotrade/consent-continuation/<jobId>.json`. The release binary has no writer
// (start_or_update is only reached from cfg'd-out code); the read/clear surface is ported.
import { join } from 'node:path';
import { jobIdIsSafe } from './grants.mjs';
import { dynamicSettingPresent } from './consent.mjs';
import { fromStr, T } from '../../../../core/serde.mjs';
import { home as onchainosHome } from '../../../../core/home.mjs';
import { exists, readToString, removeFileQuiet } from '../../../../core/rs/fs.mjs';
import { nowSecs } from '../../../../core/rs/time.mjs';

const VERSION = 6;

// upstream: continuation.rs::SelectedMode / Origin (wire strings)
export const SelectedMode = Object.freeze({
  Auto: 'auto', Manual: 'notify_only',
  parse(value) {
    if (value === 'auto') return 'auto';
    if (['notify_only', 'notify-only', 'manual', 'decline'].includes(value)) return 'notify_only';
    throw new Error('--mode must be one of: auto | notify_only');
  },
});
export const Origin = Object.freeze({
  PreDelivery: 'pre_delivery', Delivery: 'delivery', SubscriptionRestore: 'subscription_restore',
  parse(value) {
    const v = { 'pre-delivery': 'pre_delivery', delivery: 'delivery', 'subscription-restore': 'subscription_restore' }[value];
    if (v === undefined) throw new Error('--origin must be one of: pre-delivery | delivery | subscription-restore');
    return v;
  },
});

const enumT = (name, values, aliases = []) => T.enum(name, values.map((v) => [v, v]), aliases);
// upstream: continuation.rs::ConsentContinuation (deny_unknown_fields)
const CONTINUATION_T = T.struct('ConsentContinuation', [
  ['version', T.u32], ['continuationId', T.string], ['jobId', T.string], ['agentId', T.string],
  ['selectedMode', enumT('SelectedMode', ['auto', 'notify_only'], [['manual', 'notify_only']])], ['modeConfirmed', T.bool, false],
  ['seededFromNotifyOnly', T.bool, false], ['draftReviewRequired', T.bool, false], ['draftReviewConfirmed', T.bool, false],
  ['origin', enumT('Origin', ['pre_delivery', 'delivery', 'subscription_restore'])], ['signalType', T.string],
  ['originalDeliveryId', T.option(T.string)], ['requiredFields', T.vec(T.string)], ['serviceGuideHash', T.option(T.string), null],
  ['serviceGuideHashResolved', T.bool, false], ['tradeAmountU', T.option(T.string)], ['capU', T.option(T.string)],
  ['quoteToken', T.option(T.string)], ['tradeEnvironment', T.option(enumT('TradeEnvironment', ['configured', 'live', 'demo']))],
  ['marginMode', T.option(enumT('MarginMode', ['cross', 'isolated']))], ['orderPolicy', T.option(enumT('OrderPolicy', ['market', 'signal_price_limit']))],
  ['authMode', T.option(enumT('TradeKitAuthMode', ['oauth', 'api_key'], [['o_auth', 'oauth']]))], ['dynamicSettings', T.map(T.value), () => ({})],
  ['createdAt', T.u64], ['expiresAt', T.u64],
], { denyUnknown: true });

// upstream: continuation.rs::continuation_path
function continuationPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'consent-continuation', `${jobId}.json`);
}
// upstream: continuation.rs::continuation_id_is_safe
export const continuationIdIsSafe = (v) => typeof v === 'string' && v.length === 36 && v.startsWith('atc_') && /^[0-9A-Fa-f]{32}$/.test(v.slice(4));

// upstream: ConsentContinuation::draft_review_pending
export const draftReviewPending = (f) => f.draftReviewRequired && !f.draftReviewConfirmed;
// upstream: ConsentContinuation::missing_fields
export function missingFields(f) {
  const restoreUnconfirmed = f.origin === Origin.SubscriptionRestore && !f.modeConfirmed;
  if (f.selectedMode === SelectedMode.Manual) return restoreUnconfirmed ? ['mode'] : [];
  const none = (v) => v === null || v === undefined;
  const missing = f.requiredFields.filter((field) => {
    switch (field) {
      case 'mode': return restoreUnconfirmed;
      case 'tradeAmount': return none(f.tradeAmountU);
      case 'cap': return none(f.capU);
      case 'quote': return none(f.quoteToken);
      case 'environment': return none(f.tradeEnvironment);
      case 'marginMode': return none(f.marginMode);
      case 'orderPolicy': return none(f.orderPolicy);
      case 'authMode': return none(f.authMode);
      default: return !dynamicSettingPresent(f.dynamicSettings, field);
    }
  });
  if (restoreUnconfirmed && !missing.includes('mode')) missing.unshift('mode');
  return missing;
}

// upstream: continuation.rs::read_live → continuation | null
function readLive(jobId) {
  const path = continuationPath(jobId);
  if (!exists(path)) return null;
  let raw;
  try { raw = readToString(path); } catch { throw new Error('consent continuation is unreadable'); }
  let file;
  try { file = fromStr(raw, CONTINUATION_T); } catch { throw new Error('consent continuation is unreadable'); }
  if (file.version > VERSION || file.jobId !== jobId) throw new Error('consent continuation is unreadable');
  if (file.version < VERSION && file.origin === Origin.SubscriptionRestore && file.selectedMode === SelectedMode.Auto) {
    file.seededFromNotifyOnly = true;
    file.draftReviewRequired = true;
    file.draftReviewConfirmed = false;
  }
  file.version = VERSION;
  if (file.expiresAt <= nowSecs()) { removeFileQuiet(path); return null; }
  return file;
}

// upstream: continuation.rs::load_for_resume
export function loadForResume(jobId, agentId, continuationId) {
  if (!continuationIdIsSafe(continuationId)) throw new Error('invalid consent continuation id');
  const file = readLive(jobId);
  if (!file) throw new Error('no live consent continuation for this job');
  if (file.agentId !== agentId) throw new Error('consent continuation agent does not match');
  if (continuationId !== file.continuationId) throw new Error('consent continuation id does not match');
  return file;
}
// upstream: continuation.rs::load_live_for_job → continuation | null
export function loadLiveForJob(jobId, agentId) {
  const file = readLive(jobId);
  if (!file) return null;
  if (file.agentId !== agentId) throw new Error('consent continuation agent does not match');
  return file;
}
// upstream: continuation.rs::clear
export function clear(jobId) {
  let path;
  try { path = continuationPath(jobId); } catch { return; }
  removeFileQuiet(path);
}
// upstream: continuation.rs::cancel
export function cancel(jobId, agentId, continuationId) {
  if (!continuationIdIsSafe(continuationId)) throw new Error('invalid consent continuation id');
  const file = readLive(jobId);
  if (!file) return;
  if (file.agentId !== agentId) throw new Error('consent continuation agent does not match');
  if (continuationId !== file.continuationId) throw new Error('consent continuation id does not match');
  clear(jobId);
}
