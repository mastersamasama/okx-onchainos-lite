// Rating: 0.00–5.00 stars (CLI surface) ↔ 0–100 score (backend wire) — upstream
// commands/agent_commerce/identity/parts/rating.rs (re-exported through ../utils.mjs).
import { F64 } from '../../../core/json.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { isObject, asU64 } from '../../../core/rs/value.mjs';

// upstream: rating.rs::parse_stars_arg(value, flag) → 0..=100 wire score (round-half-up)
export function parseStarsArg(value, flag) {
  const t = trim(value);
  const error = () => new Error(`invalid value for ${flag}: expected 0.00–5.00 (up to 2 decimal places)`);
  let intStr = t, fracStr = '';
  const dot = t.indexOf('.');
  if (dot >= 0) {
    intStr = t.slice(0, dot);
    fracStr = t.slice(dot + 1);
    if (fracStr === '' || Buffer.byteLength(fracStr, 'utf8') > 2) throw error();
  }
  if (intStr === '' || !/^[0-9]+$/.test(intStr)) throw error();
  if (!/^[0-9]*$/.test(fracStr)) throw error();
  const intVal = BigInt(intStr);
  if (intVal > 4294967295n) throw error();
  const fracVal = fracStr.length === 0 ? 0n : fracStr.length === 1 ? BigInt(fracStr) * 10n : BigInt(fracStr);
  const cents = intVal * 100n + fracVal;
  if (cents > 4294967295n) throw error();
  if (cents > 500n) throw new Error(`invalid value for ${flag}: must be between 0.00 and 5.00`);
  return Number((cents + 2n) / 5n);
}

// upstream: rating.rs::score_to_stars — min(score, 100) × 5 / 100 (f64)
export function scoreToStars(score) {
  const s = BigInt(score) < 100n ? Number(score) : 100;
  return (s * 5) / 100.0;
}

// upstream: rating.rs::convert_feedback_list_scores — in place, u64 scores → f64 stars
export function convertFeedbackListScores(v) {
  if (!isObject(v)) return;
  const convert = (score) => new F64(scoreToStars(score));
  const avg = asU64(v.average);
  if (Object.prototype.hasOwnProperty.call(v, 'average') && avg !== undefined) v.average = convert(avg);
  for (const key of ['items', 'list']) {
    const arr = v[key];
    if (!Object.prototype.hasOwnProperty.call(v, key) || !Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!isObject(entry) || !Object.prototype.hasOwnProperty.call(entry, 'score')) continue;
      const s = asU64(entry.score);
      if (s !== undefined) entry.score = convert(s);
    }
  }
}
