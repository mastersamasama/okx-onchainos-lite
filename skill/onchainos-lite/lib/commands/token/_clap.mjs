// PRIVATE — clap parse behaviours that lib/core/cli.mjs does not reproduce yet, shared by the
// token / security / portfolio / gateway handlers (requested for promotion into core/cli.mjs):
//   1. A `-<digit>…` token is a short flag to clap, not a value: `unexpected argument '-<c>' found`
//      (exit 2) unless the option taking it has `allow_hyphen_values` (`--opt=-5` is always fine).
//   2. Typed value parsers with clap's exact wording and no Usage block:
//      u8/u16/u32/i32/i64 → RangedI64ValueParser (`300 is not in 0..=255`), u64 → RangedU64ValueParser,
//      or a custom value_parser fn (throws Error(msg)).
//   3. `conflicts_with` (first conflicting arg in argv order; smart usage line).
//   4. A *required* leaf arg that shares its id with the global `--chain` is not satisfied by the
//      global given before the subcommand (the core parser merges the two).
// clap order: parse-time errors (1, 2) in argv order → conflicts (3) → missing required (4).
import { UsageError } from '../../core/errors.mjs';
import { spec } from '../../core/cli.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const nodes = () => spec().nodes;
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const isOptionToken = (t) => t.startsWith('-') && t.length > 1 && !/^-\d/.test(t);
const usageOf = (node) => ((node.help || '').match(/Usage: (.*)/) || [])[1] || 'onchainos';

// Every option occurrence in argv, walked exactly like core/cli.mjs parse():
// [{ path, opt, raw?, inline, index }] — `path` = command level the option was matched at.
export function occurrences(argv) {
  const all = nodes();
  const root = all[''];
  const globals = new Map(root.opts.map((o) => [o.long, o]));
  globals.set('--dev', { name: 'dev', long: '--dev', flag: true });
  let path = '', node = root;
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') break;
    if (isOptionToken(tok)) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(0, eq) : tok;
      const o = node.opts.find((x) => x.long === name || x.short === name) || globals.get(name);
      if (!o) continue;
      if (o.flag) out.push({ path, opt: o, inline: false, index: i });
      else if (eq > 0) out.push({ path, opt: o, raw: tok.slice(eq + 1), inline: true, index: i });
      else { out.push({ path, opt: o, raw: argv[i + 1], inline: false, index: i }); i++; }
      continue;
    }
    if (node.subs && node.subs.includes(tok)) {
      path = path ? `${path} ${tok}` : tok;
      node = all[path];
    }
  }
  return out;
}

const RANGED = {
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n],
  i32: [-2147483648n, 2147483647n], i64: [-9223372036854775808n, 9223372036854775807n],
};
const I64 = RANGED.i64;
const U64_MAX = 18446744073709551615n;
const num = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// clap value_parser!(<int>) → value (number, BigInt beyond 2^53); throws Error(<clap reason>).
export function parseClapInt(raw, type) {
  const s = String(raw);
  if (s === '') throw new Error('cannot parse integer from empty string');
  if (type === 'u64' || type === 'usize') {         // RangedU64ValueParser: <u64 as FromStr>
    if (!/^\+?\d+$/.test(s)) throw new Error('invalid digit found in string');
    const v = BigInt(s);
    if (v > U64_MAX) throw new Error('number too large to fit in target type');
    return num(v);
  }
  const range = RANGED[type];
  if (!range) throw new Error(`unsupported integer type ${type}`);
  if (!/^[+-]?\d+$/.test(s)) throw new Error('invalid digit found in string');   // <i64 as FromStr>
  const v = BigInt(s);
  if (v > I64[1]) throw new Error('number too large to fit in target type');
  if (v < I64[0]) throw new Error('number too small to fit in target type');
  if (v < range[0] || v > range[1]) throw new Error(`${v} is not in ${range[0]}..=${range[1]}`);
  return num(v);
}

function invalidValue(opt, raw, why) {
  return new UsageError(`error: invalid value '${raw}' for '${display(opt)}': ${why}\n${TAIL}`);
}

// clap smart usage: required args (declaration order), then the given args, de-duplicated.
function smartUsage(path, used) {
  const node = nodes()[path];
  const seen = new Set();
  const parts = [];
  for (const o of [...node.opts.filter((x) => x.required && !x.global), ...used]) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    parts.push(display(o));
  }
  return ['onchainos', path, ...parts].join(' ');
}

// Run clap's parse-time checks for the handler's command and return the typed values of `types`
// (defaults included). Options: types {name: 'u8'|'u32'|'u64'|fn(raw)}, hyphen [names allowing
// hyphen values], conflicts [[a, b], …], leafRequired [names].
export function clapPass(ctx, o, { types = {}, hyphen = [], conflicts = [], leafRequired = [] } = {}) {
  const occ = occurrences(ctx.argv);
  const leaf = occ.filter((x) => x.path === ctx.path);
  const typed = {};
  const parse = (opt, raw) => {
    const t = types[opt.name];
    try {
      return typeof t === 'function' ? t(raw) : parseClapInt(raw, t);
    } catch (e) {
      throw invalidValue(opt, raw, e.message);
    }
  };
  for (const x of occ) {
    if (!x.opt.flag && !x.inline && typeof x.raw === 'string' && /^-\d/.test(x.raw)
      && !(x.path === ctx.path && hyphen.includes(x.opt.name))) {
      throw new UsageError(`error: unexpected argument '${x.raw.slice(0, 2)}' found\n\nUsage: ${usageOf(nodes()[x.path])}\n${TAIL}`);
    }
    if (x.path === ctx.path && types[x.opt.name] !== undefined && !x.opt.flag) typed[x.opt.name] = parse(x.opt, x.raw);
  }
  for (const name of Object.keys(types)) {
    if (!(name in typed) && o[name] !== undefined && o[name] !== null) {
      const opt = nodes()[ctx.path].opts.find((x) => x.name === name);
      typed[name] = parse(opt, o[name]);
    }
  }
  // conflicts_with
  for (const x of leaf) {
    const partners = conflicts.filter((p) => p.includes(x.opt.name)).map((p) => p.find((n) => n !== x.opt.name));
    const other = leaf.find((y) => partners.includes(y.opt.name));
    if (!other) continue;
    const conflicting = new Set(partners.filter((n) => leaf.some((y) => y.opt.name === n)));
    const used = leaf.filter((y) => !conflicting.has(y.opt.name) && y.opt.name !== 'dev').map((y) => y.opt);
    throw new UsageError(`error: the argument '${display(x.opt)}' cannot be used with '${display(other.opt)}'\n\nUsage: ${smartUsage(ctx.path, used)}\n${TAIL}`);
  }
  // required leaf args shadowing a global
  const missing = leafRequired.filter((n) => !leaf.some((x) => x.opt.name === n));
  if (missing.length) {
    const node = nodes()[ctx.path];
    const missOpts = missing.map((n) => node.opts.find((x) => x.name === n));
    const used = [...leaf.filter((x) => x.opt.name !== 'dev').map((x) => x.opt), ...missOpts];
    throw new UsageError(`error: the following required arguments were not provided:\n${missOpts.map((m) => `  ${display(m)}`).join('\n')}\n\nUsage: ${smartUsage(ctx.path, used)}\n${TAIL}`);
  }
  return typed;
}

// Handler entry point: clap reports its errors and exits(2) before main.rs runs anything — in
// particular before the audit log is written (core main.mjs audits every handler error).
// Once clap accepts argv, main.rs builds `Context::new`, which loads AppConfig eagerly —
// including the one-time `./.onchainos/config.json` → home migration (file write + stderr line)
// — even for commands that never read the config. core/context.mjs loads it lazily, so the
// handler forces the load here (requested for core: load in createContext / main.mjs).
export function clap(ctx, o, opts) {
  let typed;
  try {
    typed = clapPass(ctx, o, opts);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message);
    process.exit(2);
  }
  void ctx.config;   // upstream: commands/mod.rs::Context::new → AppConfig::load()
  return typed;
}
