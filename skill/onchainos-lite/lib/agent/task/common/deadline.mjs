// Decision / review deadline helpers — upstream task/common/deadline.rs.
import { asI64, asU64, asStr, get } from '../../../core/rs/value.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { fmtLocalMdHm, fmtLocalYmdHmOffset, fmtUtcYmdHm, parseFromRfc3339 } from '../../../core/rs/time.mjs';

// upstream: deadline.rs::REVIEW_WINDOW_SECONDS
export const REVIEW_WINDOW_SECONDS = 3 * 86400;
const I64_MAX = 9223372036854775807n;

// upstream: deadline.rs::normalize_timestamp_seconds → number | undefined
export function normalizeTimestampSeconds(value) {
  if (value === undefined || value === null) return undefined;
  const v = BigInt(value);
  const abs = v < 0n ? -v : v;
  const seconds = abs >= 100000000000n ? v / 1000n : v;
  if (seconds <= 0n) return undefined;
  return Number.isSafeInteger(Number(seconds)) ? Number(seconds) : seconds;
}

// upstream: deadline.rs::parse_timestamp_seconds
export function parseTimestampSeconds(value) {
  const t = trim(String(value));
  const n = parseI64(t);
  const a = n === undefined ? undefined : normalizeTimestampSeconds(n);
  if (a !== undefined) return a;
  let dateTime;
  try { dateTime = parseFromRfc3339(t); } catch { return undefined; }
  return normalizeTimestampSeconds(dateTime.secs);
}

// upstream: deadline.rs::parse_timestamp_value
export function parseTimestampValue(value) {
  const i = asI64(value);
  const a = i === undefined ? undefined : normalizeTimestampSeconds(i);
  if (a !== undefined) return a;
  const u = asU64(value);
  if (u !== undefined && BigInt(u) <= I64_MAX) {
    const b = normalizeTimestampSeconds(u);
    if (b !== undefined) return b;
  }
  const s = asStr(value);
  return s === undefined ? undefined : parseTimestampSeconds(s);
}

// upstream: deadline.rs::first_timestamp
export function firstTimestamp(detail, keys) {
  for (const key of keys) {
    const v = get(detail, key);
    if (v === undefined) continue;
    const t = parseTimestampValue(v);
    if (t !== undefined) return t;
  }
  return undefined;
}

// upstream: deadline.rs::review_deadline_from_detail
export function reviewDeadlineFromDetail(detail) {
  const exact = firstTimestamp(detail, ['reviewDeadlineAt', 'reviewWindowEndsAt', 'expireTime']);
  if (exact !== undefined) return exact;
  const submitted = firstTimestamp(detail, ['submittedAt', 'submitTime']);
  if (submitted === undefined) return undefined;
  const sum = BigInt(submitted) + BigInt(REVIEW_WINDOW_SECONDS);
  if (sum > I64_MAX) return undefined;
  return Number.isSafeInteger(Number(sum)) ? Number(sum) : sum;
}

// upstream: deadline.rs::DeadlineKind
export const DeadlineKind = Object.freeze({ Review: 'Review', Decision: 'Decision' });

// upstream: deadline.rs::days_left
export function daysLeft(expireTime, now) {
  const remaining = Number(expireTime) - Number(now);
  if (remaining <= 0) return 0;
  return Math.floor(remaining / 86400) + (remaining % 86400 > 0 ? 1 : 0);
}

// upstream: deadline.rs::format_local_deadline (`%m-%d %H:%M`)
export function formatLocalDeadline(expireTime) {
  const t = normalizeTimestampSeconds(expireTime);
  return t === undefined ? undefined : fmtLocalMdHm(t);
}

// upstream: deadline.rs::format_local_timestamp_with_offset
export function formatLocalTimestampWithOffset(timestamp) {
  if (timestamp === undefined || timestamp === null) return undefined;
  const t = normalizeTimestampSeconds(timestamp);
  return t === undefined ? undefined : fmtLocalYmdHmOffset(t);
}

// upstream: deadline.rs::format_utc_timestamp
export function formatUtcTimestamp(timestamp) {
  if (timestamp === undefined || timestamp === null) return undefined;
  const t = normalizeTimestampSeconds(timestamp);
  return t === undefined ? undefined : fmtUtcYmdHm(t);
}

// upstream: deadline.rs::deadline_reminder_line
export function deadlineReminderLine(expireTime, now, kind) {
  if (expireTime === undefined || expireTime === null) return undefined;
  const expire = normalizeTimestampSeconds(expireTime);
  if (expire === undefined) return undefined;
  const when = formatLocalDeadline(expire);
  if (when === undefined) return undefined;
  const passed = Number(expire) <= Number(now);
  if (passed && kind === DeadlineKind.Review) return `⏰ Review deadline has passed (${when}). The system may auto-accept at any time.`;
  if (passed) return `⏰ Decision deadline has passed (${when}). The system may auto-refund to the buyer at any time.`;
  if (kind === DeadlineKind.Review) return `⏰ Review deadline: ${daysLeft(expire, now)} day(s) (by ${when}). If not reviewed in time, the system will auto-accept and release payment to the ASP — irreversible.`;
  return `⏰ Decision deadline: ${daysLeft(expire, now)} day(s) (by ${when}). If not decided in time, the system will auto-refund to the buyer — irreversible.`;
}
