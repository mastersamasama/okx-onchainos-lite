// Explicit local automatic-copy preference per (User Agent, Service) —
// upstream autotrade/subscription_config.rs. Stored at
// `<home>/autotrade/subscription-config/<agentId>/<serviceId>.json` (pretty JSON).
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { fromSlice, T } from './_serde-json.mjs';
import { onchainosHome, exists, readBytes, writeSecure, nowMs } from './_fs.mjs';
import { ctx } from './_err.mjs';
import { trim } from '../../../_rs.mjs';

const CONFIG_VERSION = 1;

// upstream: subscription_config.rs::ExecutionMode (wire strings)
export const ExecutionMode = Object.freeze({
  SignalOnly: 'signal_only',
  GuideDirect: 'guide_direct',
  // upstream: <ExecutionMode as FromStr>::from_str
  fromStr(value) {
    const v = trim(String(value));
    if (v === 'signal_only' || v === 'guide_direct') return v;
    throw new Error('--execution-mode must be signal_only or guide_direct');
  },
  asStr: (m) => m,
});

// upstream: subscription_config.rs::SaveOutcome (wire strings)
export const SaveOutcome = Object.freeze({ Created: 'created', Repaired: 'repaired', Replaced: 'replaced' });

const EXECUTION_MODE_T = T.enum('ExecutionMode', [['signal_only', 'signal_only'], ['guide_direct', 'guide_direct']]);
const CONFIG_T = T.struct('SubscriptionExecutionConfig', [
  ['version', T.u32], ['agentId', T.string], ['serviceId', T.string],
  ['executionMode', T.option(EXECUTION_MODE_T), null], ['updatedAtMs', T.u64],
]);

// upstream: subscription_config.rs::config_path
export function configPath(agentId, serviceId) {
  if (!jobIdIsSafe(agentId) || !jobIdIsSafe(serviceId)) throw new Error('invalid subscription AgentId or ServiceId');
  return join(onchainosHome(), 'autotrade', 'subscription-config', agentId, `${serviceId}.json`);
}

// upstream: subscription_config.rs::load_config → config | null
export function loadConfig(agentId, serviceId) {
  const path = configPath(agentId, serviceId);
  if (!exists(path)) return null;
  let bytes;
  try { bytes = readBytes(path); } catch (e) { throw ctx(`subscription execution configuration is unreadable: ${path}`, e); }
  let config;
  try { config = fromSlice(bytes, CONFIG_T); } catch (e) { throw ctx('subscription execution configuration is invalid', e); }
  if (config.version > CONFIG_VERSION || config.agentId !== agentId || config.serviceId !== serviceId) {
    throw new Error('subscription execution configuration is invalid');
  }
  return config;
}

// upstream: subscription_config.rs::execution_mode → 'signal_only' | 'guide_direct' | null
export function executionMode(agentId, serviceId) {
  const c = loadConfig(agentId, serviceId);
  return c ? (c.executionMode ?? null) : null;
}

// upstream: subscription_config.rs::save_execution_mode → SaveOutcome
export function saveExecutionMode(agentId, serviceId, mode, replace) {
  const existing = loadConfig(agentId, serviceId);
  const current = existing ? existing.executionMode ?? null : null;
  let outcome;
  if (current === null) outcome = existing ? SaveOutcome.Repaired : SaveOutcome.Created;
  else if (replace) outcome = SaveOutcome.Replaced;
  else throw new Error(`subscription automatic-copy preference is already ${current}; use --replace only after a new user confirmation`);
  const config = struct({ version: CONFIG_VERSION, agentId, serviceId, executionMode: mode, updatedAtMs: nowMs() });
  const path = configPath(agentId, serviceId);
  try { writeSecure(path, stringify(config, true)); } catch (e) {
    throw new Error(`failed to persist subscription execution configuration at ${path}: ${e.message}`);
  }
  return outcome;
}
