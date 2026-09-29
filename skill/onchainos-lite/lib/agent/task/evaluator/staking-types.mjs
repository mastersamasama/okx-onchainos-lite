// Evaluator staking / arbitration-config domain types + API wrappers — upstream
// task/evaluator/staking_types.rs (`StakingConfig`, `MyStake`, get_staking_config, get_my_stake).
import { context } from '../../../core/errors.mjs';
import { T, fromValue, SerdeError } from '../../../core/serde.mjs';
import { strDebug } from '../../../core/rs/str.mjs';
import { formatFixed } from '../../../core/rs/num.mjs';

const U64_MAX = 18446744073709551615n;

// `<u64 as FromStr>` → value (number | BigInt) or throws ParseIntError Display text.
function parseU64Str(raw) {
  if (raw === '') throw new Error('cannot parse integer from empty string');
  if (!/^\+?[0-9]+$/.test(raw) || raw === '+') throw new Error('invalid digit found in string');
  const v = BigInt(raw);
  if (v > U64_MAX) throw new Error('number too large to fit in target type');
  return Number.isSafeInteger(Number(v)) ? Number(v) : v;
}

// upstream: staking_types.rs::de_str_u64 — a JSON string parsed as u64
const STR_U64 = T.with(T.string, (s) => {
  try { return parseU64Str(s); } catch (e) { throw new SerdeError(`expected u64 string, got ${strDebug(s)}: ${e.message}`); }
});

// upstream: staking_types.rs::StakingConfig (serde rename_all = camelCase; all fields required)
export const STAKING_CONFIG = T.struct('StakingConfig', [
  ['minCumulativeStakeOkb', T.string],
  ['partialUnstakeMinRetainOkb', T.string],
  ['unstakeCooldownSeconds', STR_U64],
  ['arbitrationFeeBps', T.string],
  ['commitPhaseSeconds', STR_U64],
  ['revealPhaseSeconds', STR_U64],
  ['slashMinorityBps', T.string],
  ['slashTimeoutBps', T.string],
  ['slashedCooldownSeconds', STR_U64],
]);

// upstream: staking_types.rs::MyStake
export const MY_STAKE = T.struct('MyStake', [
  ['voterAddress', T.string],
  ['agentId', T.string],
  ['activeStake', T.string],
  ['pendingUnstake', T.string],
  ['validStake', T.string],
  ['activeDisputes', T.string],
  ['cooldownEndsAt', T.i64, 0],
  ['unstakeAvailableAt', T.i64, 0],
  ['registered', T.bool, false],
]);

// upstream: staking_types.rs::format_fractional_unit — `{value:.2}` / `{value:.4}` round the
// exact f64 half-to-even (450 s / 3600 → "0.12", not JS toFixed's "0.13").
export function formatFractionalUnit(seconds, unitSeconds) {
  const s = BigInt(seconds), u = BigInt(unitSeconds);
  if (s === 0n) return '0';
  if (s % u === 0n) return (s / u).toString();
  const value = Number(s) / Number(u);
  // `trim_end_matches('0').trim_end_matches('.')`
  const trimZeros = (t) => t.replace(/0+$/, '').replace(/\.+$/, '');
  const two = trimZeros(formatFixed(value, 2));
  if (two !== '0') return two;
  return trimZeros(formatFixed(value, 4));
}

// upstream: StakingConfig::{unstake_cooldown_days, commit_phase_hours, reveal_phase_hours, slashed_cooldown_hours}
export const unstakeCooldownDays = (cfg) => formatFractionalUnit(cfg.unstakeCooldownSeconds, 86400);
export const commitPhaseHours = (cfg) => formatFractionalUnit(cfg.commitPhaseSeconds, 3600);
export const revealPhaseHours = (cfg) => formatFractionalUnit(cfg.revealPhaseSeconds, 3600);
export const slashedCooldownHours = (cfg) => formatFractionalUnit(cfg.slashedCooldownSeconds, 3600);

// upstream: staking_types.rs::get_staking_config (agentId used as passed)
export async function getStakingConfig(client, agentId) {
  const data = await client.getWithIdentity('/priapi/v1/aieco/task/staking/config', agentId);
  try { return fromValue(data, STAKING_CONFIG); } catch (e) { throw context('failed to parse staking config response', e); }
}

// upstream: staking_types.rs::get_my_stake (agentId used as passed)
export async function getMyStake(client, agentId) {
  const data = await client.getWithIdentity('/priapi/v1/aieco/task/staking/myStake', agentId);
  try { return fromValue(data, MY_STAKE); } catch (e) { throw context('failed to parse myStake response', e); }
}
