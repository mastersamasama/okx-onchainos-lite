// Locally persisted, guide-driven copy-trading contract — upstream autotrade/guide.rs.
// Service Guide `<home>/autotrade/guide/<jobId>.md` and Guide Consent
// `<home>/autotrade/consent/<jobId>.md`, both in the markdown document container.
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { fromStr, T } from './_serde-json.mjs';
import { onchainosHome, exists, readToString, writeSecure, nowSecs, satAdd, u64Le, sha256Hex } from './_fs.mjs';
import { ctx } from './_err.mjs';
import { trim, asciiLower } from '../../../_rs.mjs';
import * as consent from './consent.mjs';
import * as subscriptionConfig from './subscription-config.mjs';

// upstream: guide.rs constants
export const GUIDE_VERSION = 1;
export const GUIDE_CONSENT_VERSION = 1;
const MAX_GUIDE_CHARS = 48 * 1024;
export const MISSING_CONSENT_RECOVERY_MESSAGE = 'The consent file is missing. Ask the user for the configuration parameters based on the Guide file, then call autotrade-guide-consent-new to generate a new consent.';
const CONSENT_BODY = '# Service Consent\n\nValues in this document are defined exclusively by the matching Service Guide.\n';

// upstream: guide.rs::GuideConsentLifecycle (wire strings)
export const GuideConsentLifecycle = Object.freeze({ Prepared: 'prepared', Active: 'active', Aborted: 'aborted' });

// upstream: guide.rs::GuideFile / GuideConsentFile (deny_unknown_fields)
export const GUIDE_FILE_T = T.struct('GuideFile', [
  ['version', T.u32], ['jobId', T.string], ['serviceId', T.string], ['providerAgentId', T.option(T.string)],
  ['sourceHash', T.string], ['createdAt', T.u64],
], { denyUnknown: true });
const LIFECYCLE_T = T.enum('GuideConsentLifecycle', [['prepared', 'prepared'], ['active', 'active'], ['aborted', 'aborted']]);
export const GUIDE_CONSENT_FILE_T = T.struct('GuideConsentFile', [
  ['version', T.u32], ['jobId', T.string], ['guideHash', T.string], ['lifecycle', LIFECYCLE_T],
  ['values', T.map(T.value), () => ({})], ['createdAt', T.u64], ['expiresAt', T.u64],
], { denyUnknown: true });

// serde Serialize (struct field order; skip_serializing_if Option::is_none)
export const guideFileJson = (f) => struct({
  version: f.version, jobId: f.jobId, serviceId: f.serviceId,
  providerAgentId: f.providerAgentId === null || f.providerAgentId === undefined ? undefined : f.providerAgentId,
  sourceHash: f.sourceHash, createdAt: f.createdAt,
});
export const guideConsentFileJson = (f) => struct({
  version: f.version, jobId: f.jobId, guideHash: f.guideHash, lifecycle: f.lifecycle, values: f.values ?? {},
  createdAt: f.createdAt, expiresAt: f.expiresAt,
});

const isSha256Hex = (v) => typeof v === 'string' && /^[0-9A-Fa-f]{64}$/.test(v);

// upstream: guide.rs::parse_draft → { source, sourceHash } | null
export function parseDraft(source, sourceHash) {
  if (source === undefined || source === null) return null;
  if (trim(source) === '' || [...source].length > MAX_GUIDE_CHARS) {
    throw new Error(`--service-guide must be between 1 and ${MAX_GUIDE_CHARS} characters`);
  }
  const computed = sha256Hex(source);
  const supplied = trim(sourceHash ?? computed);
  const hash = asciiLower(supplied.startsWith('sha256:') ? supplied.slice('sha256:'.length) : supplied);
  if (!isSha256Hex(hash)) throw new Error('--service-guide-hash must be a lowercase SHA-256 hex digest');
  if (hash !== computed) throw new Error('--service-guide-hash does not match --service-guide');
  return { source: String(source), sourceHash: hash };
}

// upstream: guide.rs::GuideDraft::into_file
export function draftIntoFile(draft, jobId, serviceId, providerAgentId) {
  return {
    version: GUIDE_VERSION, jobId, serviceId, providerAgentId: providerAgentId ?? null,
    sourceHash: draft.sourceHash, createdAt: nowSecs(),
  };
}

// upstream: guide.rs::field_key_is_sensitive
export function fieldKeyIsSensitive(key) {
  const n = [...String(key)].filter((c) => /^[0-9A-Za-z]$/.test(c)).join('').toLowerCase();
  return ['password', 'passphrase', 'privatekey', 'secretkey', 'apikey', 'accesstoken', 'refreshtoken', 'credential', 'jwt'].some((w) => n.includes(w));
}

// upstream: guide.rs::validate_consent_values (BTreeMap iteration: sorted keys)
export function validateConsentValues(values) {
  for (const key of sortedKeys(values)) {
    if (fieldKeyIsSensitive(key)) throw new Error(`credentials must not be stored in Guide Consent: ${key}`);
  }
}
const sortedKeys = (o) => Object.keys(o ?? {}).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

// upstream: guide.rs::guide_path
export function guidePath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'guide', `${jobId}.md`);
}
// upstream: guide.rs::consent_path
export function consentPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'consent', `${jobId}.md`);
}
// upstream: guide.rs::legacy_consent_path
function legacyConsentPath(jobId) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(onchainosHome(), 'autotrade', 'consent', `${jobId}.json`);
}

// upstream: guide.rs::render_markdown (metadata = pretty JSON of the serialised struct)
export const renderMarkdown = (kind, metadata, body) => `<!-- onchainos-autotrade:${kind}\n${stringify(metadata, true)}\n-->\n\n${body}`;

// upstream: guide.rs::parse_markdown_document → [metadata, body]
export function parseMarkdownDocument(kind, raw, type) {
  const prefix = `<!-- onchainos-autotrade:${kind}\n`;
  if (!raw.startsWith(prefix)) throw new Error('local autotrade document header is invalid');
  const rest = raw.slice(prefix.length);
  const i = rest.indexOf('\n-->\n');
  if (i < 0) throw new Error('local autotrade document metadata is invalid');
  const metadata = rest.slice(0, i);
  let body = rest.slice(i + '\n-->\n'.length);
  if (body.startsWith('\n')) body = body.slice(1);
  let parsed;
  try { parsed = fromStr(metadata, type); } catch (e) { throw ctx('local autotrade document metadata is invalid', e); }
  return [parsed, body];
}
// upstream: guide.rs::parse_markdown
export const parseMarkdown = (kind, raw, type) => parseMarkdownDocument(kind, raw, type)[0];

// upstream: guide.rs::validate_file
function validateFile(file) {
  if (file.version > GUIDE_VERSION || !jobIdIsSafe(file.jobId) || trim(file.serviceId) === '') throw new Error('service guide metadata is invalid');
  if (!isSha256Hex(file.sourceHash)) throw new Error('service guide hash is invalid');
}

// upstream: guide.rs::write_guide
export function writeGuide(file, source) {
  validateFile(file);
  if (sha256Hex(source) !== file.sourceHash) throw new Error('service guide content does not match its hash');
  writeSecure(guidePath(file.jobId), renderMarkdown('guide', guideFileJson(file), source));
}

// upstream: guide.rs::load_guide
export function loadGuide(jobId) {
  const path = guidePath(jobId);
  let raw;
  try { raw = readToString(path); } catch (e) { throw ctx('service guide is not available locally', e); }
  const [file] = parseMarkdownDocument('guide', raw, GUIDE_FILE_T);
  validateFile(file);
  if (file.jobId !== jobId) throw new Error('service guide job id mismatch');
  return file;
}

// upstream: guide.rs::write_guide_consent
function writeGuideConsent(file) {
  if (file.version !== GUIDE_CONSENT_VERSION || !jobIdIsSafe(file.jobId) || !isSha256Hex(file.guideHash)) {
    throw new Error('Guide Consent metadata is invalid');
  }
  writeSecure(consentPath(file.jobId), renderMarkdown('consent', guideConsentFileJson(file), CONSENT_BODY));
}

// upstream: guide.rs::read_guide_consent → file | null
export function readGuideConsent(jobId) {
  const path = consentPath(jobId);
  if (!exists(path)) return null;
  let raw;
  try { raw = readToString(path); } catch (e) { throw ctx('Guide Consent is not readable', e); }
  const consent = parseMarkdown('consent', raw, GUIDE_CONSENT_FILE_T);
  if (consent.version !== GUIDE_CONSENT_VERSION || consent.jobId !== jobId || !isSha256Hex(consent.guideHash)) {
    throw new Error('Guide Consent metadata is invalid');
  }
  return consent;
}

// upstream: guide.rs::load_active_consent → file | null
export function loadActiveConsent(jobId) {
  const c = readGuideConsent(jobId);
  if (!c) return null;
  if (c.lifecycle !== GuideConsentLifecycle.Active || u64Le(c.expiresAt, nowSecs())) return null;
  return c;
}

// upstream: guide.rs::guide_contract_hash
const guideContractHash = (guide) => guide.sourceHash;

// upstream: guide.rs::write_prepared_consent
export function writePreparedConsent(jobId, guide, values, ttlSec) {
  validateConsentValues(values);
  const now = nowSecs();
  writeGuideConsent({
    version: GUIDE_CONSENT_VERSION, jobId, guideHash: guideContractHash(guide), lifecycle: GuideConsentLifecycle.Prepared,
    values, createdAt: now, expiresAt: satAdd(now, ttlSec),
  });
}

// upstream: guide.rs::activate_prepared_consent
export function activatePreparedConsent(jobId) {
  const consent = readGuideConsent(jobId);
  if (!consent) throw new Error('prepared Guide Consent is not available');
  if (consent.lifecycle !== GuideConsentLifecycle.Prepared) throw new Error('Guide Consent is not prepared');
  consent.lifecycle = GuideConsentLifecycle.Active;
  writeGuideConsent(consent);
}

// upstream: guide.rs::update_active_consent_values → updated file
export function updateActiveConsentValues(jobId, values) {
  validateConsentValues(values);
  const consent = readGuideConsent(jobId);
  if (!consent) throw new Error(MISSING_CONSENT_RECOVERY_MESSAGE);
  if (consent.lifecycle !== GuideConsentLifecycle.Active || u64Le(consent.expiresAt, nowSecs())) {
    throw new Error('active Guide Consent is not available locally');
  }
  consent.values = values;
  writeGuideConsent(consent);
  return consent;
}

// upstream: guide.rs::create_active_consent_from_guide → created file
export function createActiveConsentFromGuide(jobId, values, ttlSec) {
  if (BigInt(ttlSec) === 0n) throw new Error('--ttl-sec must be > 0');
  validateConsentValues(values);
  if (loadActiveConsent(jobId)) throw new Error('active Guide Consent already exists; use autotrade-guide-consent-update to replace values');
  const guide = loadGuide(jobId);
  const now = nowSecs();
  const consent = {
    version: GUIDE_CONSENT_VERSION, jobId, guideHash: guideContractHash(guide), lifecycle: GuideConsentLifecycle.Active,
    values, createdAt: now, expiresAt: satAdd(now, ttlSec),
  };
  writeGuideConsent(consent);
  return consent;
}

// upstream: guide.rs::abort_prepared_consent
export function abortPreparedConsent(jobId) {
  let consent;
  try { consent = readGuideConsent(jobId); } catch { return; }
  if (!consent) return;
  if (consent.lifecycle === GuideConsentLifecycle.Prepared) {
    consent.lifecycle = GuideConsentLifecycle.Aborted;
    try { writeGuideConsent(consent); } catch {}
  }
}

// upstream: guide.rs::migrate_legacy_json_consent_if_needed
export function migrateLegacyJsonConsentIfNeeded(jobId, agentId, serviceId) {
  const currentPath = consentPath(jobId);
  const legacyPath = legacyConsentPath(jobId);
  let path;
  if (exists(currentPath)) path = currentPath;
  else if (exists(legacyPath)) path = legacyPath;
  else return;
  let raw;
  try { raw = readToString(path); } catch (e) { throw ctx('local Consent is not readable', e); }
  if (raw.startsWith('<!-- onchainos-autotrade:consent\n')) {
    readGuideConsent(jobId);
    return;
  }
  let legacy;
  try { legacy = fromStr(raw, consent.CONSENT_FILE_T); } catch (e) { throw ctx('local Consent is neither current Guide Consent nor legacy JSON', e); }
  if (legacy.version > consent.CONSENT_VERSION || legacy.jobId !== jobId) throw new Error('legacy Consent metadata is invalid');
  if (legacy.lifecycle !== consent.ConsentLifecycle.Active || u64Le(legacy.expiresAt, nowSecs())) return;
  const guide = loadGuide(jobId);
  // serde_json::to_value(&legacy) → object; drop the core fields
  const values = consent.consentFileValue(legacy);
  for (const f of ['version', 'jobId', 'mode', 'requiredFields', 'serviceGuideHash', 'guideHash', 'lifecycle', 'createdAt', 'expiresAt']) delete values[f];
  validateConsentValues(values);
  if (subscriptionConfig.executionMode(agentId, serviceId) === null) {
    const mode = legacy.mode === consent.ConsentMode.Auto ? subscriptionConfig.ExecutionMode.GuideDirect : subscriptionConfig.ExecutionMode.SignalOnly;
    subscriptionConfig.saveExecutionMode(agentId, serviceId, mode, false);
  }
  writeGuideConsent({
    version: GUIDE_CONSENT_VERSION, jobId, guideHash: guideContractHash(guide), lifecycle: GuideConsentLifecycle.Active,
    values, createdAt: legacy.createdAt, expiresAt: legacy.expiresAt,
  });
}

// upstream: guide.rs::consent_snapshot → GuideConsentSnapshot { status, guideHash? }
export function consentSnapshot(jobId) {
  let c = null;
  try { c = loadActiveConsent(jobId); } catch { c = null; }
  return c ? struct({ status: 'active', guideHash: c.guideHash }) : struct({ status: 'unavailable', guideHash: undefined });
}

// upstream: guide.rs::load_guide_and_consent
function loadGuideAndConsent(jobId) {
  const guide = loadGuide(jobId);
  const consent = loadActiveConsent(jobId);
  if (!consent) throw new Error('active Guide Consent is not available locally');
  return [guide, consent];
}

// upstream: guide.rs::has_active_execution_contract
export function hasActiveExecutionContract(jobId) {
  try { loadGuideAndConsent(jobId); return true; } catch { return false; }
}
