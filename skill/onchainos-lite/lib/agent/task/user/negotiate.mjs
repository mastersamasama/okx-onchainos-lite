// Local negotiation state — upstream task/user/negotiate.rs.
// State file `<ONCHAINOS_HOME>/task/{jobId}/negotiate-state.json` (pretty JSON, struct order) and
// `designated-provider.json`. Job ids are joined without sanitisation, exactly like upstream.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { onchainosHome } from '../../_home.mjs';
import { rustJoin as join } from '../../../core/qr.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { struct, f64, stringify } from '../../../core/json.mjs';
import { fromStr } from '../../../wallet/_serde-json.mjs';
import { S, fromValue } from '../../_serde.mjs';
import { asStr, get, ioErrorText, utcNowRfc3339 } from '../../_rs.mjs';

const STATE_FILE = 'negotiate-state.json';
const DESIGNATED_FILE = 'designated-provider.json';

// `?` on a std::io::Error → anyhow Display of the io error.
function io(fn) {
  try { return fn(); } catch (e) { if (e?.code && e?.syscall) throw new Error(ioErrorText(e)); throw e; }
}

// upstream: negotiate.rs::ServiceInfo (Deserialize)
const SERVICE_INFO = S.struct('ServiceInfo', [
  ['serviceId', S.string], ['serviceName', S.string], ['serviceDescription', S.string, { default: '' }], ['serviceType', S.string],
  ['sortOrder', S.i64, { default: 0 }], ['feeAmount', S.option(S.f64), { default: null }], ['feeTokenSymbol', S.string, { default: '' }],
  ['feeToken', S.string, { default: '' }],
]);
// upstream: negotiate.rs::ProviderInfo (Deserialize)
const PROVIDER_INFO = S.struct('ProviderInfo', [
  ['providerAddress', S.string], ['providerAgentId', S.string], ['providerName', S.string, { default: '' }], ['matchScore', S.f64],
  ['creditScore', S.i64], ['capabilitySummary', S.string], ['completedTaskCount', S.i64], ['services', S.vec(SERVICE_INFO), { default: () => [] }],
]);
// upstream: negotiate.rs::NegotiateState (Deserialize)
const NEGOTIATE_STATE = S.struct('NegotiateState', [
  ['jobId', S.string], ['providers', S.vec(PROVIDER_INFO)], ['currentIndex', S.usize], ['createdAt', S.string],
  ['page', S.usize, { default: 0 }], ['failedProviders', S.vec(S.string), { default: () => [] }],
]);

// upstream: negotiate.rs::ServiceInfo (Serialize, declaration order)
export const serviceInfoStruct = (s) => struct({
  serviceId: s.serviceId, serviceName: s.serviceName, serviceDescription: s.serviceDescription ?? '', serviceType: s.serviceType,
  sortOrder: s.sortOrder ?? 0, feeAmount: s.feeAmount === null || s.feeAmount === undefined ? null : f64(s.feeAmount),
  feeTokenSymbol: s.feeTokenSymbol ?? '', feeToken: s.feeToken ?? '',
});
// upstream: negotiate.rs::ProviderInfo (Serialize, declaration order)
export const providerInfoStruct = (p) => struct({
  providerAddress: p.providerAddress, providerAgentId: p.providerAgentId, providerName: p.providerName ?? '', matchScore: f64(p.matchScore),
  creditScore: p.creditScore, capabilitySummary: p.capabilitySummary, completedTaskCount: p.completedTaskCount,
  services: (p.services ?? []).map(serviceInfoStruct),
});
// upstream: negotiate.rs::NegotiateState (Serialize; failedProviders skipped when empty)
export const negotiateStateStruct = (s) => struct({
  jobId: s.jobId, providers: s.providers.map(providerInfoStruct), currentIndex: s.currentIndex, createdAt: s.createdAt, page: s.page ?? 0,
  failedProviders: s.failedProviders && s.failedProviders.length ? [...s.failedProviders] : undefined,
});

// upstream: home.rs::task_state_dir — PathBuf::join (no normalisation; an absolute jobId replaces the root).
const stateDir = (jobId) => join(onchainosHome(), 'task', String(jobId));
const statePath = (jobId) => join(stateDir(jobId), STATE_FILE);
const writeState = (jobId, state) => io(() => writeFileSync(statePath(jobId), stringify(negotiateStateStruct(state), true)));

// upstream: negotiate.rs::save — providers are ProviderInfo objects; index resets to 0.
export function save(jobId, providers, page) {
  io(() => mkdirSync(stateDir(jobId), { recursive: true }));
  let failed = [];
  try { failed = load(jobId).failedProviders; } catch {}
  writeState(jobId, { jobId, providers, currentIndex: 0, createdAt: utcNowRfc3339(), page, failedProviders: failed });
}

// upstream: negotiate.rs::load
export function load(jobId) {
  const path = statePath(jobId);
  if (!existsSync(path)) throw new Error(`Negotiation state not found; run \`onchainos agent asp-match --job-id ${jobId}\` first`);
  const raw = io(() => readFileSync(path, 'utf8'));
  return fromValue(NEGOTIATE_STATE, fromStr(raw));
}

// upstream: negotiate.rs::current → ProviderInfo | undefined
export function current(jobId) {
  const state = load(jobId);
  return state.providers[state.currentIndex];
}

// upstream: negotiate.rs::next → ProviderInfo | undefined (advances and rewrites the state)
export function next(jobId) {
  const state = load(jobId);
  state.currentIndex += 1;
  writeState(jobId, state);
  return state.providers[state.currentIndex];
}

// upstream: negotiate.rs::save_designated_provider
export function saveDesignatedProvider(jobId, providerAgentId) {
  const dir = stateDir(jobId);
  io(() => mkdirSync(dir, { recursive: true }));
  io(() => writeFileSync(join(dir, DESIGNATED_FILE), stringify({ agentId: providerAgentId }, true)));
}

// upstream: negotiate.rs::has_designated_provider
export function hasDesignatedProvider(jobId) {
  try { return existsSync(join(stateDir(jobId), DESIGNATED_FILE)); } catch { return false; }
}

// upstream: negotiate.rs::get_designated_provider → agentId | undefined (throws on read/parse errors)
export function getDesignatedProvider(jobId) {
  const path = join(stateDir(jobId), DESIGNATED_FILE);
  if (!existsSync(path)) return undefined;
  const raw = io(() => readFileSync(path, 'utf8'));
  const v = fromStr(raw);
  const id = asStr(get(v, 'agentId'));
  return id !== undefined && id !== '' ? id : undefined;
}

// upstream: negotiate.rs::clear_designated_provider
export function clearDesignatedProvider(jobId) {
  const path = join(stateDir(jobId), DESIGNATED_FILE);
  if (existsSync(path)) io(() => rmSync(path));
}

// upstream: negotiate.rs::mark_failed — prints the confirmation line itself.
export function markFailed(jobId, providerAgentId) {
  let state;
  try { state = load(jobId); } catch {
    io(() => mkdirSync(stateDir(jobId), { recursive: true }));
    state = { jobId, providers: [], currentIndex: 0, createdAt: utcNowRfc3339(), page: 0, failedProviders: [] };
  }
  const pid = String(providerAgentId);
  if (!state.failedProviders.includes(pid)) state.failedProviders.push(pid);
  writeState(jobId, state);
  auditLog('cli', 'user/provider_marked_failed', true, 0, [`jobId=${jobId}`, `provider=${providerAgentId}`]);
  process.stdout.write(`✓ Marked provider ${providerAgentId} as failed negotiation (job=${jobId})\n`);
  let dp;
  try { dp = getDesignatedProvider(jobId); } catch { dp = undefined; }
  if (dp !== undefined && dp === providerAgentId) { try { clearDesignatedProvider(jobId); } catch {} }
}

// upstream: negotiate.rs::load_failed
export function loadFailed(jobId) {
  try { return load(jobId).failedProviders; } catch { return []; }
}

// upstream: negotiate.rs::cleanup — delete regular files; keep the dir while attachments/ exists.
export function cleanup(jobId) {
  const dir = stateDir(jobId);
  if (!existsSync(dir)) return;
  for (const entry of io(() => readdirSync(dir, { withFileTypes: true }))) {
    if (entry.isFile()) io(() => rmSync(join(dir, entry.name)));
  }
  if (!existsSync(join(dir, 'attachments'))) { try { rmdirSync(dir); } catch {} }
}
