// Shared deterministic helpers for the "sink-to-CLI" optimization — upstream commands/sink.rs.
// No floats: hex→decimal and decimal sums use string arithmetic so values beyond u128 stay exact.
//   FR-1 parseDurationMs / resolveSinceWindow   FR-3 autoPaginate
//   FR-4 normalizeAmount / hexToDecimalString   FR-5 sumPrizePool / addDecimalStrings / formatThousands
import { CodedError } from './errors.mjs';
import { struct, F64, formatF64 } from './json.mjs';
import { trim, parseUnsigned, eqIgnoreAsciiCase } from './_rust-str.mjs';

// upstream: sink.rs::CodedError — the same class main.mjs downcasts to `error_coded` (exit 1).
// CodedError::new(code, field, msg) ≡ new CodedError(code, field ?? undefined, msg);
// .with_data / .with_next_steps ≡ the { data, nextSteps } constructor option.
export { CodedError };

// upstream: sink.rs::CodedError::invalid_input
export const invalidInput = (field, message) => new CodedError('invalid_input', field, message);

// ── FR-1: duration + relative window ────────────────────────────────

const UNITS = [['d', 86400000n], ['h', 3600000n], ['m', 60000n], ['s', 1000n]];
const U64_MAX = 18446744073709551615n;
const toU64 = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

// upstream: sink.rs::parse_duration_ms — `<int><s|m|h|d>` (or bare `0`) → milliseconds.
// Returns a number (BigInt beyond 2^53, like every u64 in this runtime).
export function parseDurationMs(s, flag, allowZero) {
  const t = trim(s);
  if (t === '0') {
    if (allowZero) return 0;
    throw new Error(`invalid --${flag} '${s}'; duration must be positive`);
  }
  const unit = UNITS.find(([u]) => t.endsWith(u));
  if (!unit) throw new Error(`invalid --${flag} '${s}'; use e.g. 300s, 30m, 24h, 7d`);
  const n = parseUnsigned(t.slice(0, -1), 'u64');
  if (n === undefined) throw new Error(`invalid --${flag} '${s}'; use e.g. 300s, 30m, 24h, 7d`);
  if (BigInt(n) === 0n) {
    if (allowZero) return 0;
    throw new Error(`invalid --${flag} '${s}'; duration must be positive`);
  }
  const ms = BigInt(n) * unit[1];
  if (ms > U64_MAX) throw new Error(`--${flag} '${s}' overflows`);
  return toU64(ms);
}

// upstream: sink.rs::ResolvedWindow — serialises as {"begin":..,"end":..}.
export const resolvedWindow = ({ begin, end }) => struct({ begin, end });

// upstream: sink.rs::resolve_since_window — end = nowMs, begin = end - dur (saturating).
export function resolveSinceWindow(since, nowMs) {
  const dur = parseDurationMs(since, 'since', false);
  const now = BigInt(nowMs);
  const begin = now > BigInt(dur) ? now - BigInt(dur) : 0n;
  return resolvedWindow({ end: toU64(now), begin: toU64(begin) });
}

// upstream: sink.rs::now_ms — wall-clock Unix milliseconds.
export const nowMs = () => Date.now();

// ── FR-3: cursor auto-pagination ────────────────────────────────────

// upstream: sink.rs::CursorMode
export const CursorMode = Object.freeze({ PerItem: 'PerItem', PageLevel: 'PageLevel' });

// upstream: sink.rs::PageShape — { itemsKey, cursorKey, mode }.
export const pageShape = (itemsKey, cursorKey, mode) => Object.freeze({ itemsKey, cursorKey, mode });

// upstream: sink.rs::MAX_PAGES — hard cap on page requests per autoPaginate call.
export const MAX_PAGES = 10;

// upstream: sink.rs::PartialError (struct order; field / nextCursor skipped when None).
export const partialError = ({ code, field, message, nextCursor }) =>
  struct({ code, field: field ?? undefined, message, nextCursor: nextCursor ?? undefined });

// upstream: sink.rs::Aggregated (struct order; partial skipped when false, error when None).
export const aggregated = ({ items, nextCursor, fetchedCount, partial, error }) =>
  struct({ items, nextCursor: nextCursor ?? null, fetchedCount, partial: partial ? true : undefined, error: error ?? undefined });

// upstream: sink.rs::parse_max_results — undefined/null → null; else 1..=500 or CodedError.
export function parseMaxResults(raw) {
  if (raw === undefined || raw === null) return null;
  const s = trim(raw);
  const n = parseUnsigned(s, 'u32');
  if (n === undefined) throw invalidInput('max-results', `--max-results must be an integer between 1 and 500, got '${s}'`);
  if (n < 1 || n > 500) throw invalidInput('max-results', `--max-results must be between 1 and 500, got ${n}`);
  return n;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
// serde_json `value[key]`: the field of an object, else Null.
const index = (v, key) => (isObject(v) && Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined ? v[key] : null);

// upstream: sink.rs::extract_items — page[itemsKey] → page-as-array → first array field (BTreeMap order).
function extractItems(page, itemsKey) {
  const direct = index(page, itemsKey);
  if (Array.isArray(direct)) return [...direct];
  if (Array.isArray(page)) return [...page];
  if (isObject(page)) {
    for (const k of Object.keys(page).filter((k) => page[k] !== undefined).sort(byteOrder)) {
      if (Array.isArray(page[k])) return [...page[k]];
    }
  }
  return [];
}

// serde_json Number Display: integers as digits, f64 as serde_json formats it ("-0" parses as f64 -0.0).
const numberText = (v) => (v instanceof F64 ? formatF64(v.valueOf()) : typeof v === 'bigint' ? v.toString()
  : Number.isInteger(v) && !Object.is(v, -0) ? String(v) : formatF64(v));
const isNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || v instanceof F64;

// upstream: sink.rs::cursor_as_string — non-empty string or number → string, else null.
function cursorAsString(v) {
  if (typeof v === 'string') return v === '' ? null : v;
  if (isNumber(v)) return numberText(v);
  return null;
}

// upstream: sink.rs::auto_paginate — drives `fetchPage(cursor|null) → Promise<page>`.
// Stops at the first of: maxResults reached / empty cursor / MAX_PAGES / page error
// (→ partial with a continuation cursor) / a cursor that does not advance.
export async function autoPaginate(startCursor, maxResults, shape, fetchPage) {
  let items = [];
  let cursor = startCursor ?? null;
  let pages = 0;
  let lastContinuation = null;
  for (;;) {
    if (pages >= MAX_PAGES) break;
    const attempted = cursor;
    let page;
    try {
      page = await fetchPage(cursor);
    } catch (e) {
      const pe = partialError({ code: 'upstream_error', message: `page ${pages + 1} request failed: ${e?.message ?? String(e)}`, nextCursor: attempted });
      return aggregated({ items, nextCursor: attempted, fetchedCount: items.length, partial: true, error: pe });
    }
    pages += 1;
    const pageItems = extractItems(page, shape.itemsKey);
    const cont = shape.mode === CursorMode.PerItem
      ? (pageItems.length ? cursorAsString(index(pageItems[pageItems.length - 1], shape.cursorKey)) : null)
      : cursorAsString(index(page, shape.cursorKey));

    // Cursor-advancement guard: an empty page that still hands back a forward cursor would spin.
    if (pageItems.length === 0 && cont) break;

    items.push(...pageItems);
    lastContinuation = cont;
    if (items.length >= maxResults) break;
    if (cont) {
      if (attempted === cont) {
        return aggregated({
          items, nextCursor: cont, fetchedCount: items.length, partial: true,
          error: partialError({
            code: 'cursor_not_advancing',
            message: `upstream returned the same cursor '${cont}' it was queried with; stopping to avoid re-fetching the same page`,
            nextCursor: cont,
          }),
        });
      }
      cursor = cont;
    } else break;
  }

  if (shape.mode === CursorMode.PerItem && items.length > maxResults) {
    items = items.slice(0, maxResults);
    const next = items.length ? cursorAsString(index(items[items.length - 1], shape.cursorKey)) : null;
    return aggregated({ items, nextCursor: next, fetchedCount: items.length, partial: false });
  }
  return aggregated({ items, nextCursor: lastContinuation, fetchedCount: items.length, partial: false });
}

// ── FR-4: amount normalization ──────────────────────────────────────

// serde_json Number::is_u64
const isU64 = (v) => (typeof v === 'bigint' ? v >= 0n && v <= U64_MAX : typeof v === 'number' && Number.isInteger(v) && v >= 0 && !Object.is(v, -0));

// upstream: sink.rs::normalize_amount → { value: "<decimal>" } | { error: "<message>" } (AmountNorm).
export function normalizeAmount(raw) {
  if (raw === null || raw === undefined) return { value: '0' };
  if (isNumber(raw)) {
    if (isU64(raw)) return { value: numberText(raw) };
    return { error: `value must be a non-negative integer minimal unit, got '${numberText(raw)}'` };
  }
  if (typeof raw === 'string') {
    const t = trim(raw);
    if (t === '' || t === '0' || eqIgnoreAsciiCase(t, '0x0')) return { value: '0' };
    if (t.startsWith('0x') || t.startsWith('0X')) {
      try { return { value: hexToDecimalString(t) }; } catch (e) { return { error: e.message }; }
    }
    if (/^[0-9]+$/.test(t)) {
      const stripped = t.replace(/^0+/, '');
      return { value: stripped === '' ? '0' : stripped };
    }
    return { error: `unparseable value '${t}'` };
  }
  return { error: 'unparseable value (unexpected JSON type)' };
}

// upstream: sink.rs::hex_to_decimal_string — exact, arbitrary length, optional 0x/0X.
// Throws Error("invalid hex digit '<c>' in '<hex>'") (upstream Err(String)).
export function hexToDecimalString(hex) {
  const t = trim(hex);
  const h = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t;
  if (h === '') return '0';
  for (const c of h) if (!/^[0-9A-Fa-f]$/.test(c)) throw new Error(`invalid hex digit '${c}' in '${hex}'`);
  return BigInt('0x' + h).toString(10);
}

// ── FR-5: prize-pool summation ──────────────────────────────────────

// upstream: sink.rs::PrizePoolEntry / TotalPrizePool (struct order; partial skipped when false).
export const prizePoolEntry = ({ amount, rewardUnit }) => struct({ amount, rewardUnit });
export const totalPrizePool = ({ amountByUnit, display, partial }) => struct({ amountByUnit, display, partial: partial ? true : undefined });

// upstream: sink.rs::sum_prize_pool — group `totalReward` by `rewardUnit` (first-seen order);
// null when `distributions` is empty; unparseable entries are skipped and set partial.
export function sumPrizePool(distributions) {
  if (!distributions.length) return null;
  const order = [];
  const sums = new Map();
  let partial = false;
  for (const d of distributions) {
    const u = index(d, 'rewardUnit');
    const unit = typeof u === 'string' ? u : '';
    const r = isObject(d) && Object.prototype.hasOwnProperty.call(d, 'totalReward') ? d.totalReward : undefined;
    let reward;
    if (typeof r === 'string') reward = trim(r);
    else if (isNumber(r)) reward = numberText(r);
    else { partial = true; continue; }
    const running = sums.has(unit) ? sums.get(unit) : '0';
    let sum;
    try { sum = addDecimalStrings(running, reward); } catch { partial = true; continue; }
    if (!sums.has(unit)) order.push(unit);
    sums.set(unit, sum);
  }
  const amountByUnit = order.map((u) => prizePoolEntry({ amount: sums.get(u), rewardUnit: u }));
  const display = amountByUnit
    .map((e) => (e.rewardUnit === '' ? formatThousands(e.amount) : `${formatThousands(e.amount)} ${e.rewardUnit}`))
    .join(' + ');
  return totalPrizePool({ amountByUnit, display, partial });
}

// upstream: sink.rs::split_decimal — (integer digits, fractional digits); throws Err(String) text.
function splitDecimal(s) {
  const t = trim(s);
  if (t === '') throw new Error(`empty decimal string '${s}'`);
  const dot = t.indexOf('.');
  const [int, frac] = dot >= 0 ? [t.slice(0, dot), t.slice(dot + 1)] : [t, ''];
  if (!/^[0-9]+$/.test(int) || !/^[0-9]*$/.test(frac)) throw new Error(`unparseable decimal '${s}'`);
  return [int, frac];
}

// upstream: sink.rs::add_decimal_strings — exact decimal addition; trailing fractional zeros trimmed.
export function addDecimalStrings(a, b) {
  const [ai, af] = splitDecimal(a);
  const [bi, bf] = splitDecimal(b);
  const flen = Math.max(af.length, bf.length);
  const sum = (BigInt(ai + af.padEnd(flen, '0')) + BigInt(bi + bf.padEnd(flen, '0'))).toString();
  if (flen === 0) return sum;
  const padded = sum.padStart(flen + 1, '0');
  const split = padded.length - flen;
  const intPart = padded.slice(0, split);
  const fracPart = padded.slice(split).replace(/0+$/, '');
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}

// upstream: sink.rs::format_thousands — commas every 3 integer digits (byte-wise), fraction kept.
export function formatThousands(decimal) {
  const dot = decimal.indexOf('.');
  const [int, frac] = dot >= 0 ? [decimal.slice(0, dot), decimal.slice(dot + 1)] : [decimal, undefined];
  const bytes = Buffer.from(int, 'utf8');
  let grouped = '';
  bytes.forEach((b, idx) => {
    if (idx > 0 && (bytes.length - idx) % 3 === 0) grouped += ',';
    grouped += String.fromCharCode(b);
  });
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
