// Local negotiation state — upstream task/user/negotiate.rs.
// State file `<ONCHAINOS_HOME>/task/{jobId}/negotiate-state.json` (pretty JSON, struct order) and
// `designated-provider.json`. Job ids are joined without sanitisation, exactly like upstream.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { home as onchainosHome } from '../../../core/home.mjs';
import { rustJoin as join } from '../../../core/qr.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { struct, f64, stringify } from '../../../core/json.mjs';
import { fromStr, T } from '../../../core/serde.mjs';
import { asStr, get } from '../../../core/rs/value.mjs';
import { io } from '../../../core/rs/fs.mjs';
import { utcNowRfc3339 } from '../../../core/rs/time.mjs';

const STATE_FILE = 'negotiate-state.json';
const DESIGNATED_FILE = 'designated-provider.json';

// upstream: negotiate.rs::ServiceInfo (Deserialize)
const SERVICE_INFO = T.struct('ServiceInfo', [
  ['serviceId', T.string], ['serviceName', T.string], ['serviceDescription', T.string, ''], ['serviceType', T.string],
  ['sortOrder', T.i64, 0], ['feeAmount', T.option(T.f64), null], ['feeTokenSymbol', T.string, ''],
  ['feeToken', T.string, ''],
]);
// upstream: negotiate.rs::ProviderInfo (Deserialize)
const PROVIDER_INFO = T.struct('ProviderInfo', [
  ['providerAddress', T.string], ['providerAgentId', T.string], ['providerName', T.string, ''], ['matchScore', T.f64],
  ['creditScore', T.i64], ['capabilitySummary', T.string], ['completedTaskCount', T.i64], ['services', T.vec(SERVICE_INFO), () => []],
]);
// upstream: negotiate.rs::NegotiateState (Deserialize)
const NEGOTIATE_STATE = T.struct('NegotiateState', [
  ['jobId', T.string], ['providers', T.vec(PROVIDER_INFO)], ['currentIndex', T.usize], ['createdAt', T.string],
  ['page', T.usize, 0], ['failedProviders', T.vec(T.string), () => []],
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
  return fromStr(raw, NEGOTIATE_STATE);
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
