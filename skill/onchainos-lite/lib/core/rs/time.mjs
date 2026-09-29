// Time semantics: SystemTime::now, chrono 0.4.44 (the version upstream 4.6.3 links) formatting,
// `DateTime::parse_from_rfc3339` and `DateTime::from_str`, and tokio::time::timeout_at.

// ── SystemTime ──────────────────────────────────────────────────────

// SystemTime::now() since the epoch: nanoseconds (BigInt; 100 ns resolution on Windows), whole
// seconds, milliseconds.
export function nowNanos() {
  const ms = performance.timeOrigin + performance.now();
  let nanos = BigInt(Math.floor(ms)) * 1000000n + BigInt(Math.floor((ms % 1) * 1e6));
  if (process.platform === 'win32') nanos -= nanos % 100n;
  return nanos;
}
export const nowSecs = () => Math.floor(Date.now() / 1000);
export const nowMs = () => Date.now();
const splitNanos = (ns) => {
  const b = BigInt(ns);
  const secs = b >= 0n ? b / 1000000000n : -((-b + 999999999n) / 1000000000n);
  return [secs, Number(b - secs * 1000000000n)];
};

// ── chrono: broken-down time ────────────────────────────────────────

const MIN_YEAR = -262144, MAX_YEAR = 262143;
const p2 = (n) => String(n).padStart(2, '0');
// `%Y`: 4-digit zero pad inside 0..=9999, else an explicit sign.
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));
// Civil date from days since 1970-01-01 (proleptic Gregorian; exact for any safe integer).
function civil(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
// Days since 1970-01-01 of a civil date (H. Hinnant's days_from_civil).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
// UTC broken-down time of Unix seconds (number / BigInt) + nanos; undefined when chrono rejects
// the timestamp (outside the NaiveDateTime range).
export function utcParts(secs, nanos = 0) {
  const s = BigInt(secs);
  const days = s >= 0n ? s / 86400n : -((-s + 86399n) / 86400n);
  const sod = Number(s - days * 86400n);
  if (days > 200000000n || days < -200000000n) return undefined;
  const { y, m, d } = civil(Number(days));
  if (y < MIN_YEAR || y > MAX_YEAR) return undefined;
  return { y, m, d, hh: Math.floor(sod / 3600), mm: Math.floor((sod % 3600) / 60), ss: sod % 60, nanos };
}
// chrono::Local broken-down time (system TZ) + `off` seconds east of UTC.
export function localParts(secs, nanos = 0) {
  const s = Number(secs);
  if (!Number.isFinite(s) || Math.abs(s) > 8.64e12) {
    const u = utcParts(secs, nanos);
    return u ? { ...u, off: 0 } : undefined;
  }
  const dt = new Date(s * 1000);
  if (Number.isNaN(dt.getTime())) return undefined;
  const off = -dt.getTimezoneOffset() * 60;
  const u = utcParts(BigInt(s) + BigInt(off), nanos);
  return u ? { ...u, off } : undefined;
}
// Local::now() broken-down
export function localNow() { const [s, n] = splitNanos(nowNanos()); return localParts(s, n); }

// ── chrono: formatting ──────────────────────────────────────────────

// AutoSi fraction: "", ".mmm", ".uuuuuu" or ".nnnnnnnnn".
function fraction(nanos) {
  if (!nanos) return '';
  if (nanos % 1000000 === 0) return '.' + String(nanos / 1000000).padStart(3, '0');
  if (nanos % 1000 === 0) return '.' + String(nanos / 1000).padStart(6, '0');
  return '.' + String(nanos).padStart(9, '0');
}
// FixedOffset Display (`%:z`, seconds when non-zero); "Z" for UTC where `useZ`.
function offsetText(off, useZ = false) {
  if (off === 0 && useZ) return 'Z';
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const base = `${sign}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}`;
  return a % 60 ? `${base}:${p2(a % 60)}` : base;
}
const dateTimeText = (p) => `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)}T${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)}${fraction(p.nanos)}`;
// DateTime::to_rfc3339 of broken-down parts (with `off`); `useZ` = DateTime<Utc> serde form.
export const rfc3339Of = (p, useZ = false) => dateTimeText(p) + offsetText(p.off ?? 0, useZ);
// Utc.timestamp_opt(secs, 0).single().map(|d| d.to_rfc3339()) → string | undefined
export function utcRfc3339(secs) { const p = utcParts(secs); return p ? rfc3339Of({ ...p, off: 0 }) : undefined; }
// Utc::now().to_rfc3339() → "…+00:00"
export function utcNowRfc3339() { const [s, n] = splitNanos(nowNanos()); return rfc3339Of({ ...utcParts(s, n), off: 0 }); }
// DateTime<Utc> of a nanosecond timestamp: serde form ("…Z") / to_rfc3339 ("…+00:00")
export function utcNanosSerde(ns) { const [s, n] = splitNanos(ns); return rfc3339Of({ ...utcParts(s, n), off: 0 }, true); }
export function utcNanosRfc3339(ns) { const [s, n] = splitNanos(ns); return rfc3339Of({ ...utcParts(s, n), off: 0 }); }
// Local `%m-%d %H:%M` / `%Y-%m-%d %H:%M (UTC%:z)` / Utc `%Y-%m-%d %H:%M (UTC+00:00)` — undefined
// when the timestamp is unrepresentable.
export function fmtLocalMdHm(secs) { const p = localParts(secs); return p ? `${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)}` : undefined; }
export function fmtLocalYmdHmOffset(secs) {
  const p = localParts(secs);
  if (!p) return undefined;
  const a = Math.abs(p.off);
  return `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} (UTC${p.off < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))})`;
}
export function fmtUtcYmdHm(secs) { const p = utcParts(secs); return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)} (UTC+00:00)` : undefined; }
// Local `%Y-%m-%d %H:%M:%S %Z` (`%Z` of Local renders the fixed offset, e.g. `+08:00`)
export function fmtLocalYmdHmsZ(secs) {
  const p = localParts(secs);
  return p ? `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)} ${offsetText(p.off)}` : undefined;
}
// Local `%Y%m%d_%H%M%S` + zero-padded milliseconds of broken-down parts
export function localStamp(p) { return `${yearText(p.y)}${p2(p.m)}${p2(p.d)}_${p2(p.hh)}${p2(p.mm)}${p2(p.ss)}${String(Math.floor(p.nanos / 1000000)).padStart(3, '0')}`; }

// ── chrono: parsing ─────────────────────────────────────────────────
// DateTime::parse_from_rfc3339 (format/parse.rs::parse_rfc3339) checks, in order (each failure
// is a ParseError whose Display text is thrown):
//   length ≥ 19 → fixed digits/separators "YYYY-MM-DD" → calendar date → 'T'|'t'|' ' →
//   "HH:MM:SS" digits → optional ".fraction" (1–9 digits kept, the rest skipped) → hour/min/sec
//   range (sec 60 = leap second) → offset (Z|z|±HH:MM, U+2212 minus allowed) → trailing input →
//   offset range.

const PARSE_ERROR = {
  OutOfRange: 'input is out of range', Invalid: 'input contains invalid characters',
  TooShort: 'premature end of input', TooLong: 'trailing input',
};
const fail = (k) => { throw new Error(PARSE_ERROR[k]); };
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const SCALE = [0, 100_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 100, 10, 1];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

// → { secs: BigInt (Unix `timestamp()`, may be negative), nanos: number (sub-second part; ≥ 1e9
// only for a leap second ":60") }. Throws Error(<ParseError Display>).
export function parseFromRfc3339(input) {
  const b = Buffer.from(String(input), 'utf8');
  if (b.length < 19) fail('TooShort');
  const digit = (i) => (isDigit(b[i]) ? b[i] - 0x30 : fail('Invalid'));
  const year = digit(0) * 1000 + digit(1) * 100 + digit(2) * 10 + digit(3);
  if (b[4] !== 0x2d) fail('Invalid');
  const month = digit(5) * 10 + digit(6);
  if (b[7] !== 0x2d) fail('Invalid');
  const day = digit(8) * 10 + digit(9);
  if (month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) fail('OutOfRange');
  if (b[10] !== 0x54 && b[10] !== 0x74 && b[10] !== 0x20) fail('Invalid');
  const hour = digit(11) * 10 + digit(12);
  if (b[13] !== 0x3a) fail('Invalid');
  const min = digit(14) * 10 + digit(15);
  if (b[16] !== 0x3a) fail('Invalid');
  let sec = digit(17) * 10 + digit(18);
  let extra = 0;
  if (sec === 60) { sec = 59; extra = 1_000_000_000; }
  let i, nano;
  if (b[19] === 0x2e) {
    // scan::nanosecond(&s[20..]) = scan::number(s, 1, 9) scaled, further digits skipped
    i = 20;
    if (b.length - i < 1) fail('TooShort');
    let v = 0, k = 0;
    for (; k < 9 && i + k < b.length; k++) {
      if (!isDigit(b[i + k])) { if (k < 1) fail('Invalid'); break; }
      v = v * 10 + (b[i + k] - 0x30);
    }
    i += k;
    v *= SCALE[k];
    while (i < b.length && isDigit(b[i])) i++;
    nano = extra + v;
  } else { i = 19; nano = extra; }
  // NaiveTime::from_hms_nano_opt
  if (hour >= 24 || min >= 60 || sec >= 60 || (nano >= 1_000_000_000 && sec !== 59) || nano >= 2_000_000_000) fail('OutOfRange');
  // scan::timezone_offset(s, |s| scan::char(s, b':'), allow_zulu, !allow_missing_minutes, allow_tz_minus_sign)
  let offset;
  if (b[i] === 0x5a || b[i] === 0x7a) { offset = 0; i++; }
  else {
    let neg;
    if (i >= b.length) fail('TooShort');
    if (b[i] === 0x2b) { neg = false; i += 1; }
    else if (b[i] === 0x2d) { neg = true; i += 1; }
    else if (b[i] === 0xe2 && b[i + 1] === 0x88 && b[i + 2] === 0x92) { neg = true; i += 3; }   // U+2212 MINUS SIGN
    else fail('Invalid');
    if (b.length - i < 2) fail('TooShort');
    if (!isDigit(b[i]) || !isDigit(b[i + 1])) fail('Invalid');
    const hh = (b[i] - 0x30) * 10 + (b[i + 1] - 0x30);
    i += 2;
    if (i >= b.length) fail('TooShort');
    if (b[i] !== 0x3a) fail('Invalid');
    i += 1;
    if (b.length - i < 2) fail('TooShort');
    const [m1, m2] = [b[i], b[i + 1]];
    let mm;
    if (m1 >= 0x30 && m1 <= 0x35 && isDigit(m2)) mm = (m1 - 0x30) * 10 + (m2 - 0x30);
    else if (m1 >= 0x36 && m1 <= 0x39 && isDigit(m2)) fail('OutOfRange');
    else fail('Invalid');
    i += 2;
    offset = (hh * 3600 + mm * 60) * (neg ? -1 : 1);
  }
  if (i < b.length) fail('TooLong');
  if (!(offset > -86_400 && offset < 86_400)) fail('OutOfRange');   // FixedOffset::east_opt
  const local = BigInt(daysFromCivil(year, month, day)) * 86400n + BigInt(hour * 3600 + min * 60 + sec);
  return { secs: local - BigInt(offset), nanos: nano };
}

// chrono `impl FromStr for DateTime<FixedOffset>` (format/parse.rs::parse_rfc3339_relaxed — the
// serde form of DateTime<Utc>) → UTC nanoseconds (BigInt) | undefined. Relaxed where
// parse_from_rfc3339 is strict: surrounding whitespace, any fraction length, `±HHMM` offsets.
export function dateTimeFromStr(s) {
  const m = /^\s*([+-]?\d{4,6})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,}))?\s*(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/.exec(String(s));
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo) || h > 23 || mi > 59 || se > 60) return undefined;
  const frac = m[7] ? BigInt((m[7] + '000000000').slice(0, 9)) : 0n;
  const off = m[8] ? 0 : (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 3600 + Number(m[11]) * 60);
  const secs = BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + Math.min(se, 59)) - BigInt(off);
  return secs * 1000000000n + frac;
}

// `t <= Utc::now()` for a parsed DateTime: (secs, nanos) compare lexicographically, so a leap
// second ":60" sorts after every instant of its ":59".
export function isAtOrBeforeNow(t, nowMsValue = Date.now()) {
  const secs = BigInt(Math.floor(nowMsValue / 1000));
  const nanos = (((nowMsValue % 1000) + 1000) % 1000) * 1_000_000;
  return t.secs < secs || (t.secs === secs && t.nanos <= nanos);
}

// ── tokio::time::timeout_at ─────────────────────────────────────────

// Race `promise` against an absolute deadline (ms epoch) → { ok: true, value } | { ok: true, error }
// (the future settled) | { ok: false } (Elapsed); never rejects.
export function timeoutAt(promise, deadlineMs) {
  let timer;
  const delay = Math.max(0, deadlineMs - Date.now());
  const elapsed = new Promise((res) => { timer = setTimeout(() => res({ ok: false }), delay); });
  return Promise.race([promise.then((value) => ({ ok: true, value }), (error) => ({ ok: true, error })), elapsed])
    .finally(() => clearTimeout(timer));
}
