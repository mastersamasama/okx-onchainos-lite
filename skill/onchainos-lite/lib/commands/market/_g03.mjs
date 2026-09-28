// Private helpers shared by the g03 market-data command groups
// (market, signal, social, memepump, leaderboard, tracker). Not a handler file.
import { writeSync } from 'node:fs';
import { F64 } from '../../core/json.mjs';
import { spec } from '../../core/cli.mjs';

// Rust Option::is_some for an optional CLI/MCP value (undefined/null ≡ None).
export const some = (v) => v !== undefined && v !== null;

// serde field name of a camelCase CLI option (`minTop10HoldingsPercent` → `min_top10_holdings_percent`).
export const snakeCase = (camel) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// Build a Rust `*Params` struct (serde snake_case field names, None → null) from the parsed CLI
// options — what upstream's execute() does when it moves the clap fields into the struct.
// Shared fetch functions read ONLY these serde names, exactly like serde deserialising MCP args.
export function rustParams(o, camelNames) {
  const p = {};
  for (const n of camelNames) p[snakeCase(n)] = some(o[n]) ? o[n] : null;
  return p;
}

// serde_json Value::is_object / as_object_mut — a JSON object (not array, number, string, null).
export const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && typeof v !== 'bigint';

// clap's integer value parsers: u8/u16/u32/i8/i16/i32/i64 use RangedI64ValueParser — `i64::from_str`
// first (Rust ParseIntError wording), then a bounds check reported as "<v> is not in <lo>..=<hi>".
const I64 = [-9223372036854775808n, 9223372036854775807n];
const RANGED_I64 = {
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n],
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: I64,
};

// <i64 as FromStr>::from_str → { value } | { why } (digits scanned left to right, overflow checked per digit).
export function parseI64(s) {
  if (s === '') return { why: 'cannot parse integer from empty string' };
  let i = 0, neg = false;
  if (s[0] === '+' || s[0] === '-') {
    if (s.length === 1) return { why: 'invalid digit found in string' };
    neg = s[0] === '-';
    i = 1;
  }
  let v = 0n;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return { why: 'invalid digit found in string' };
    v = v * 10n + (neg ? -BigInt(c - 48) : BigInt(c - 48));
    if (v > I64[1]) return { why: 'number too large to fit in target type' };
    if (v < I64[0]) return { why: 'number too small to fit in target type' };
  }
  return { value: v };
}

// clap value_parser!(<int>) → { value } | { message } (the exact clap error text, no Usage line).
export function clapInt(path, name, raw, type) {
  const node = spec().nodes[path];
  const o = node?.opts.find((x) => x.name === name);
  const display = o ? `${o.long} <${o.value}>` : name;
  const fail = (why) => ({ message: `error: invalid value '${raw}' for '${display}': ${why}\n\nFor more information, try '--help'.\n` });
  const r = parseI64(raw);
  if (r.why) return fail(r.why);
  const [lo, hi] = RANGED_I64[type];
  if (r.value < lo || r.value > hi) return fail(`${r.value} is not in ${lo}..=${hi}`);
  return { value: type === 'i64' && !Number.isSafeInteger(Number(r.value)) ? r.value : Number(r.value) };
}

// clap reports a bad value from Cli::parse() and exits 2 before Context::new / audit::log run, so
// nothing reaches stdout or the state dir. core/main.mjs audits every handler-thrown error
// (UsageError included) and core typed() adds a Usage line and uses FromStr wording instead of
// RangedI64ValueParser's, hence this private fallback prints clap's text and exits directly.
export function clapTyped(ctx, name, raw, type) {
  if (raw === undefined || raw === null) return raw;
  const r = clapInt(ctx.path, name, String(raw), type);
  if (r.message === undefined) return r.value;
  writeSync(2, r.message);
  process.exit(2);
}
