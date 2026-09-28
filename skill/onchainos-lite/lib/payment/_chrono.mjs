// PRIVATE — chrono 0.4.44 `DateTime::parse_from_rfc3339` (format/parse.rs::parse_rfc3339), the
// exact version upstream 4.6.3 links. Used by a2a-pay (`challenge.data.expires`, `expired_at`) and
// a2mcp (`parse_challenge_expiry`). payment/_rs.mjs::parseRfc3339 follows the older scan-based
// chrono grammar (range checks in field order, no U+2212 offset sign, whole seconds only), which
// reports different ParseError kinds for malformed input — requested for promotion/replacement.
//
// Order of checks (each failure is a chrono ParseError whose Display text is thrown):
//   length ≥ 19 → fixed digits/separators "YYYY-MM-DD" → calendar date → 'T'|'t'|' ' →
//   "HH:MM:SS" digits → optional ".fraction" (1–9 digits kept, the rest skipped) → hour/min/sec
//   range (sec 60 = leap second) → offset (Z|z|±HH:MM, U+2212 minus allowed) → trailing input →
//   offset range.

const TEXT = {
  OutOfRange: 'input is out of range', Invalid: 'input contains invalid characters',
  TooShort: 'premature end of input', TooLong: 'trailing input',
};
const fail = (k) => { throw new Error(TEXT[k]); };
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const SCALE = [0, 100_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 100, 10, 1];

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

// Proleptic-Gregorian days since 1970-01-01 (H. Hinnant's days_from_civil).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// chrono DateTime::parse_from_rfc3339 → { secs: BigInt (Unix `timestamp()`, may be negative),
// nanos: number (sub-second part; ≥ 1e9 only for a leap second ":60") }. Throws Error(<Display>).
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

// `DateTime<Utc>` ordering against the current time: `t <= Utc::now()` compares (secs, nanos)
// lexicographically (a leap-second ":60" sorts after every instant of its ":59").
export function isAtOrBeforeNow(t, nowMs = Date.now()) {
  const nowSecs = BigInt(Math.floor(nowMs / 1000));
  const nowNanos = (((nowMs % 1000) + 1000) % 1000) * 1_000_000;
  return t.secs < nowSecs || (t.secs === nowSecs && t.nanos <= nowNanos);
}
