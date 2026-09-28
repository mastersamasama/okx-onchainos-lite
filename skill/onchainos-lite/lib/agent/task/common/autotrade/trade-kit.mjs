// Local OKX Agent Trade Kit discovery + capability parsing — upstream autotrade/trade_kit.rs.
// Local-only: finds the `okx` CLI on PATH / common npm bin dirs and runs `okx list-tools --json`
// (bounded). Never checks authentication, account permissions or network availability.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { struct } from '../../../../core/json.mjs';
import { AssetClass } from '../../../../core/asset-class.mjs';
import { isSkillInstalledIn } from '../../../../commands/upgrade/upgrade.mjs';
import { parse as parseJson } from '../../../../core/json.mjs';
import { isObj, trim, asciiLower } from '../../../_rs.mjs';
import { isFile } from './_fs.mjs';

// upstream: trade_kit.rs constants
export const SKILL_REPOSITORY = 'okx/agent-skills';
export const TRADE_SKILL_ID = 'okx-cex-trade';
export const CLI_BINARY = 'okx';
export const CLI_PACKAGE = '@okx_ai/okx-trade-cli';
export const MIN_COMPATIBLE_CLI_VERSION = '1.3.2';
export const INSTALL_COMMAND = 'npm install -g @okx_ai/okx-trade-cli@latest';
export const READINESS_SCHEMA_VERSION = 3;
export const READINESS_SCOPE = 'local_compatibility';
const DISCOVERY_TIMEOUT_MS = 5000;
const KILL_REAP_TIMEOUT_MS = 1000;
const MAX_DISCOVERY_STDOUT = 1024 * 1024;
const MAX_CHILD_STDERR = 64 * 1024;

// upstream: trade_kit.rs::LocalReadiness
export const LocalReadiness = Object.freeze({ Missing: 'Missing', VerificationUnknown: 'VerificationUnknown' });

// upstream: trade_kit.rs::probe_local → { cliPath, skillInstalled }
export const probeLocal = () => probeLocalWith(homedir(), process.env.PATH ?? process.env.Path ?? '');

// upstream: trade_kit.rs::probe_local_with
export function probeLocalWith(home, pathVar) {
  let skillInstalled = false;
  try { skillInstalled = isSkillInstalledIn(home, TRADE_SKILL_ID); } catch { skillInstalled = false; }
  return { cliPath: findCli(home, pathVar), skillInstalled };
}
// upstream: trade_kit.rs::LocalProbe::readiness
export const localReadiness = (probe) => (probe.cliPath === undefined || probe.cliPath === null ? LocalReadiness.Missing : LocalReadiness.VerificationUnknown);

const executableNames = () => (process.platform === 'win32' ? ['okx.exe', 'okx.cmd', 'okx.bat', 'okx'] : [CLI_BINARY]);

// std::env::split_paths (Windows: ';' separated, double quotes removed; Unix: ':')
export function splitPaths(pathVar, platform = process.platform) {
  if (platform !== 'win32') return String(pathVar).split(':');
  const out = [];
  let cur = '', inQuote = false;
  for (const ch of String(pathVar)) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ';' && !inQuote) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// upstream: trade_kit.rs::find_cli
function findCli(home, pathVar) {
  for (const dir of splitPaths(pathVar)) {
    if (dir === '') continue;
    for (const name of executableNames()) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  const NPM_BIN_DIRS = ['.npm-global/bin', '.npm/bin', '.local/bin', '.yarn/bin', '.config/yarn/global/node_modules/.bin'];
  for (const rel of NPM_BIN_DIRS) {
    for (const name of executableNames()) {
      const candidate = join(home, rel, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// upstream: trade_kit.rs::CapabilitySnapshot::from_list_tools_json → { version, toolNames:Set } (throws code)
export function capabilitySnapshotFromListToolsJson(raw) {
  const INVALID = 'trade_kit_capabilities_invalid';
  let value;
  try { value = parseJson(raw); } catch { throw new Error(INVALID); }
  const version = isObj(value) && typeof value.version === 'string' && value.version !== '' ? value.version : undefined;
  if (version === undefined) throw new Error(INVALID);
  const modules = isObj(value) && Array.isArray(value.modules) ? value.modules : undefined;
  if (!modules) throw new Error(INVALID);
  const toolNames = new Set();
  for (const module of modules) {
    const commands = isObj(module) && Array.isArray(module.commands) ? module.commands : undefined;
    if (!commands) throw new Error(INVALID);
    for (const command of commands) {
      const name = isObj(command) && typeof command.toolName === 'string' && command.toolName !== '' ? command.toolName : undefined;
      if (name !== undefined) toolNames.add(name);
    }
  }
  return { version, toolNames };
}

// upstream: trade_kit.rs::required_capabilities
export function requiredCapabilities(cls) {
  switch (cls) {
    case AssetClass.Spot: return ['market_get_ticker', 'spot_place_order'];
    case AssetClass.Perp: return ['market_get_ticker', 'market_get_instruments', 'account_get_config', 'swap_get_leverage', 'swap_set_leverage',
      'swap_place_order', 'swap_close_position', 'futures_get_leverage', 'futures_set_leverage', 'futures_place_order', 'futures_close_position'];
    case AssetClass.Prediction: return ['event_browse', 'event_get_series', 'event_get_events', 'event_get_markets', 'event_place_order'];
    case AssetClass.Option: return ['option_get_instruments', 'option_get_greeks', 'option_place_order'];
    default: return [];
  }
}

// upstream: trade_kit.rs::parse_runtime_asset_class
export function parseRuntimeAssetClass(value) {
  if (['spot', 'perp', 'prediction', 'option'].includes(value)) return value;
  throw new Error('asset class must be spot, perp, prediction, or option');
}
// upstream: trade_kit.rs::parse_runtime_asset_classes (de-duplicated, first-seen order)
export function parseRuntimeAssetClasses(values) {
  if (!values || !values.length) throw new Error('at least one --asset-class is required');
  const classes = [];
  for (const v of values) {
    const c = parseRuntimeAssetClass(v);
    if (!classes.includes(c)) classes.push(c);
  }
  return classes;
}

// upstream: trade_kit.rs::TradeEnvironment (wire strings)
export const TradeEnvironment = Object.freeze({
  Configured: 'configured', Live: 'live', Demo: 'demo',
  parse(value) {
    if (value === 'configured' || value === 'live' || value === 'demo') return value;
    throw new Error('environment must be configured, live, or demo');
  },
  asStr: (e) => e,
  isExplicit: (e) => e === 'live' || e === 'demo',
});

// upstream: trade_kit.rs::RuntimeState / RuntimeReason (wire strings)
export const RuntimeState = Object.freeze({ Ready: 'ready', Missing: 'missing', VerificationUnknown: 'verification_unknown', Incompatible: 'incompatible' });
export const RuntimeReason = Object.freeze({
  Ready: 'ready', CliMissing: 'cli_missing', DiscoveryTimeout: 'discovery_timeout', DiscoveryFailed: 'discovery_failed',
  UpgradeRequired: 'upgrade_required', CapabilityMissing: 'capability_missing',
});

// upstream: trade_kit.rs::AssetReadinessCheck::new (struct order)
const assetCheck = (assetClass, readiness, reason, missingCapabilities) => struct({
  assetClass, readiness, ready: readiness === RuntimeState.Ready, reason, missingCapabilities,
});

const statePriority = (s) => ({ missing: 3, incompatible: 2, verification_unknown: 1, ready: 0 })[s];

// upstream: trade_kit.rs::aggregate_result — Iterator::max_by_key (last maximum wins)
export function aggregateResult(checks) {
  let best;
  for (const c of checks) if (best === undefined || statePriority(c.readiness) >= statePriority(best.readiness)) best = c;
  return best ? [best.readiness, best.reason] : [RuntimeState.VerificationUnknown, RuntimeReason.DiscoveryFailed];
}

// upstream: trade_kit.rs::remediation_for → RuntimeRemediation | null
export function remediationFor(reason) {
  if (reason === RuntimeReason.CliMissing) return struct({ install: INSTALL_COMMAND, upgrade: undefined });
  if (reason === RuntimeReason.UpgradeRequired || reason === RuntimeReason.CapabilityMissing) return struct({ install: undefined, upgrade: INSTALL_COMMAND });
  return null;
}

// chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
export const checkedAtNow = () => new Date().toISOString();

// upstream: trade_kit.rs::RuntimeReadiness::from_checks
export function readinessFromChecks(classes, environment, version, assetChecks) {
  const [readiness, reason] = aggregateResult(assetChecks);
  const missing = [];
  for (const c of assetChecks) for (const m of c.missingCapabilities) if (!missing.includes(m)) missing.push(m);
  return struct({
    schemaVersion: READINESS_SCHEMA_VERSION, tool: 'trade_kit', scope: READINESS_SCOPE, authenticationChecked: false,
    assetClasses: [...classes], environment, readiness, ready: readiness === RuntimeState.Ready, reason,
    checkedAt: checkedAtNow(), version: version ?? null, missingCapabilities: missing, remediation: remediationFor(reason), assetChecks,
  });
}
// upstream: trade_kit.rs::RuntimeReadiness::all
export const readinessAll = (classes, environment, readiness, reason, version) =>
  readinessFromChecks(classes, environment, version, classes.map((c) => assetCheck(c, readiness, reason, [])));

// upstream: trade_kit.rs::version_at_least
export function versionAtLeast(current, minimum) {
  const core = (value) => {
    const t = trim(value).replace(/^v+/, '');
    const plus = t.indexOf('+');
    const normalized = plus >= 0 ? t.slice(0, plus) : t;
    const dash = normalized.indexOf('-');
    const base = dash >= 0 ? normalized.slice(0, dash) : normalized;
    const isPre = dash >= 0;
    const parts = base.split('.');
    if (parts.length !== 3) return undefined;
    const nums = [];
    for (const p of parts) {
      if (!/^\+?[0-9]+$/.test(p)) return undefined;
      const n = BigInt(p.replace(/^\+/, ''));
      if (n > 18446744073709551615n) return undefined;
      nums.push(n);
    }
    return [nums, isPre];
  };
  const c = core(current), m = core(minimum);
  if (!c || !m) return false;
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return 1; if (a[i] < b[i]) return -1; } return 0; };
  const r = cmp(c[0], m[0]);
  return r > 0 || (r === 0 && (!c[1] || m[1]));
}

// upstream: trade_kit.rs::trade_kit_command + run_bounded → { kind: 'Finished'|'TimedOut'|'Unavailable', ... }
export function runBounded(executable, args, timeoutMs, stdoutCap) {
  return new Promise((resolve) => {
    let program = executable, argv = args;
    if (process.platform === 'win32') {
      const ext = asciiLower(extname(executable).slice(1));
      if (ext === 'cmd' || ext === 'bat') { program = 'cmd'; argv = ['/C', executable, ...args]; }
    }
    let child;
    try {
      child = spawn(program, argv, {
        env: { ...process.env, OKX_UPDATE_CHECK: 'false' },
        stdio: ['ignore', stdoutCap !== undefined ? 'pipe' : 'ignore', 'pipe'], windowsHide: true,
      });
    } catch { resolve({ kind: 'Unavailable' }); return; }
    const out = [], err = [];
    let outLen = 0, errLen = 0, outTrunc = false, errTrunc = false, settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const cap = (chunks, len, max, chunk) => {
      const remaining = Math.max(0, max - len);
      if (remaining > 0) chunks.push(chunk.subarray(0, Math.min(chunk.length, remaining)));
      return [Math.min(max, len + chunk.length), chunk.length > remaining];
    };
    if (child.stdout) child.stdout.on('data', (c) => { const [l, t] = cap(out, outLen, stdoutCap, c); outLen = l; outTrunc ||= t; });
    child.stderr.on('data', (c) => { const [l, t] = cap(err, errLen, MAX_CHILD_STDERR, c); errLen = l; errTrunc ||= t; });
    const timer = setTimeout(() => {
      // tokio Child::start_kill = SIGKILL on Unix (TerminateProcess on Windows); Node's default
      // kill() sends SIGTERM, which a stuck `okx` could ignore and outlive the probe.
      try { child.kill('SIGKILL'); } catch {}
      setTimeout(() => done({ kind: 'TimedOut' }), Math.min(KILL_REAP_TIMEOUT_MS, 50));
    }, timeoutMs);
    child.on('error', () => done({ kind: 'Unavailable' }));
    child.on('close', (code) => done({
      kind: 'Finished', success: code === 0, stdout: Buffer.concat(out), stderr: Buffer.concat(err), stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
    }));
  });
}

// upstream: trade_kit.rs::evaluate_discovery → snapshot (throws { reason })
export function evaluateDiscovery(d) {
  const fail = (reason) => Object.assign(new Error(reason), { reason });
  if (d.kind === 'TimedOut') throw fail(RuntimeReason.DiscoveryTimeout);
  if (d.kind === 'Unavailable') throw fail(RuntimeReason.DiscoveryFailed);
  if (!d.success || d.stdoutTruncated) throw fail(RuntimeReason.DiscoveryFailed);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(d.stdout); } catch { throw fail(RuntimeReason.DiscoveryFailed); }
  try { return capabilitySnapshotFromListToolsJson(text); } catch { throw fail(RuntimeReason.DiscoveryFailed); }
}

// upstream: trade_kit.rs::probe_runtime_with_cli
async function probeRuntimeWithCli(cliPath, classes, environment) {
  let snapshot;
  try { snapshot = evaluateDiscovery(await runBounded(cliPath, ['list-tools', '--json'], DISCOVERY_TIMEOUT_MS, MAX_DISCOVERY_STDOUT)); } catch (e) {
    return readinessAll(classes, environment, RuntimeState.VerificationUnknown, e.reason ?? RuntimeReason.DiscoveryFailed, null);
  }
  if (!versionAtLeast(snapshot.version, MIN_COMPATIBLE_CLI_VERSION)) {
    return readinessAll(classes, environment, RuntimeState.Incompatible, RuntimeReason.UpgradeRequired, snapshot.version);
  }
  const checks = classes.map((c) => {
    const missing = requiredCapabilities(c).filter((n) => !snapshot.toolNames.has(n));
    return missing.length ? assetCheck(c, RuntimeState.Incompatible, RuntimeReason.CapabilityMissing, missing) : assetCheck(c, RuntimeState.Ready, RuntimeReason.Ready, []);
  });
  return readinessFromChecks(classes, environment, snapshot.version, checks);
}

// upstream: trade_kit.rs::probe_runtime
export async function probeRuntime(classes, environment) {
  const unique = [];
  for (const c of classes) if (c !== AssetClass.Defi && !unique.includes(c)) unique.push(c);
  if (!unique.length) return readinessAll([], environment, RuntimeState.VerificationUnknown, RuntimeReason.DiscoveryFailed, null);
  const local = probeLocal();
  if (local.cliPath === undefined) return readinessAll(unique, environment, RuntimeState.Missing, RuntimeReason.CliMissing, null);
  return probeRuntimeWithCli(local.cliPath, unique, environment);
}
