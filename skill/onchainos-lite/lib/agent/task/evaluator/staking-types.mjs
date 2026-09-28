// Evaluator staking / arbitration-config domain types + API wrappers — upstream
// task/evaluator/staking_types.rs (`StakingConfig`, `MyStake`, get_staking_config, get_my_stake).
import { context } from '../../../core/errors.mjs';
import { S, fromValue, SerdeError, unexpected } from '../../_serde.mjs';
import { rustDebugStr } from '../../_rs.mjs';
import { rustFixed } from './_fixed.mjs';

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
const STR_U64 = {
  expecting: 'a string',
  de(v) {
    if (typeof v !== 'string') throw new SerdeError(`invalid type: ${unexpected(v)}, expected a string`);
    try { return parseU64Str(v); } catch (e) { throw new SerdeError(`expected u64 string, got ${rustDebugStr(v)}: ${e.message}`); }
  },
};

// upstream: staking_types.rs::StakingConfig (serde rename_all = camelCase; all fields required)
export const STAKING_CONFIG = S.struct('StakingConfig', [
  ['minCumulativeStakeOkb', S.string],
  ['partialUnstakeMinRetainOkb', S.string],
  ['unstakeCooldownSeconds', STR_U64],
  ['arbitrationFeeBps', S.string],
  ['commitPhaseSeconds', STR_U64],
  ['revealPhaseSeconds', STR_U64],
  ['slashMinorityBps', S.string],
  ['slashTimeoutBps', S.string],
  ['slashedCooldownSeconds', STR_U64],
]);

// upstream: staking_types.rs::MyStake
export const MY_STAKE = S.struct('MyStake', [
  ['voterAddress', S.string],
  ['agentId', S.string],
  ['activeStake', S.string],
  ['pendingUnstake', S.string],
  ['validStake', S.string],
  ['activeDisputes', S.string],
  ['cooldownEndsAt', S.i64, { default: 0 }],
  ['unstakeAvailableAt', S.i64, { default: 0 }],
  ['registered', S.bool, { default: false }],
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
  const two = trimZeros(rustFixed(value, 2));
  if (two !== '0') return two;
  return trimZeros(rustFixed(value, 4));
}

// upstream: StakingConfig::{unstake_cooldown_days, commit_phase_hours, reveal_phase_hours, slashed_cooldown_hours}
export const unstakeCooldownDays = (cfg) => formatFractionalUnit(cfg.unstakeCooldownSeconds, 86400);
export const commitPhaseHours = (cfg) => formatFractionalUnit(cfg.commitPhaseSeconds, 3600);
export const revealPhaseHours = (cfg) => formatFractionalUnit(cfg.revealPhaseSeconds, 3600);
export const slashedCooldownHours = (cfg) => formatFractionalUnit(cfg.slashedCooldownSeconds, 3600);

// upstream: staking_types.rs::get_staking_config (agentId used as passed)
export async function getStakingConfig(client, agentId) {
  const data = await client.getWithIdentity('/priapi/v1/aieco/task/staking/config', agentId);
  try { return fromValue(STAKING_CONFIG, data); } catch (e) { throw context('failed to parse staking config response', e); }
}

// upstream: staking_types.rs::get_my_stake (agentId used as passed)
export async function getMyStake(client, agentId) {
  const data = await client.getWithIdentity('/priapi/v1/aieco/task/staking/myStake', agentId);
  try { return fromValue(MY_STAKE, data); } catch (e) { throw context('failed to parse myStake response', e); }
}
