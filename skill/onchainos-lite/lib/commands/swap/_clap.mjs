// PRIVATE — clap parse behaviours lib/core/cli.mjs does not model, used by the swap and
// cross-chain handlers (requested for promotion into core/cli.mjs via lib/spec.json):
//   1. A `-<digit>…` token after a value option is a short flag to clap, not a value:
//      `unexpected argument '-<c>' found` (exit 2); `--opt=-5` is always a value.
//   2. Typed value parsers (`--route-index`: usize) with clap's wording, in argv order.
//   3. `conflicts_with` (first conflicting leaf arg in argv order; clap "smart usage" line).
//   4. A *required* leaf `--chain` is not satisfied by the global `--chain` given before the
//      subcommand (the core parser merges the two values).
//   5. `required_unless_present` pairs (`cross-chain status --tx-hash | --order-id`).
// clap order: parse-time errors (1, 2) in argv order → conflicts (3) → missing required (4, 5).
// clap reports these on stderr with exit 2 before main.rs runs (so no audit record).
import { UsageError } from '../../core/errors.mjs';
import { spec } from '../../core/cli.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const nodes = () => spec().nodes;
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const isOptionToken = (t) => t.startsWith('-') && t.length > 1 && !/^-\d/.test(t);
const usageOf = (node) => ((node.help || '').match(/Usage: (.*)/) || [])[1] || 'onchainos';

// Every option occurrence in argv, walked like core/cli.mjs parse():
// [{ path, opt, raw?, inline, index }] — `path` = the command level the option was matched at.
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

const U64_MAX = 18446744073709551615n;

// clap value_parser for usize / u64 (`<u64 as FromStr>` wording) → number (BigInt beyond 2^53).
export function parseUsize(raw) {
  const s = String(raw);
  if (s === '') throw new Error('cannot parse integer from empty string');
  if (!/^\+?\d+$/.test(s)) throw new Error('invalid digit found in string');
  const v = BigInt(s);
  if (v > U64_MAX) throw new Error('number too large to fit in target type');
  return Number.isSafeInteger(Number(v)) ? Number(v) : v;
}

const PARSERS = { usize: parseUsize };

// clap smart usage: required args (declaration order), then the given/missing args, de-duplicated.
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

function missingError(path, leaf, missOpts) {
  const used = [...leaf.filter((x) => x.opt.name !== 'dev').map((x) => x.opt), ...missOpts];
  return new UsageError(`error: the following required arguments were not provided:\n${missOpts.map((m) => `  ${display(m)}`).join('\n')}\n\nUsage: ${smartUsage(path, used)}\n${TAIL}`);
}

// Run clap's checks for the handler's command; returns the typed values of `types` (by name).
// rules: { types: {name: 'usize'}, conflicts: [[a, b], …], leafRequired: [names], oneOf: [[a, b], …] }
export function clapPass(ctx, o, { types = {}, conflicts = [], leafRequired = [], oneOf = [] } = {}) {
  const occ = occurrences(ctx.argv);
  const leaf = occ.filter((x) => x.path === ctx.path);
  const node = nodes()[ctx.path];
  const typed = {};
  const parse = (opt, raw) => {
    try {
      return PARSERS[types[opt.name]](raw);
    } catch (e) {
      throw new UsageError(`error: invalid value '${raw}' for '${display(opt)}': ${e.message}\n${TAIL}`);
    }
  };
  for (const x of occ) {
    if (!x.opt.flag && !x.inline && typeof x.raw === 'string' && /^-\d/.test(x.raw)) {
      throw new UsageError(`error: unexpected argument '${x.raw.slice(0, 2)}' found\n\nUsage: ${usageOf(nodes()[x.path])}\n${TAIL}`);
    }
    if (x.path === ctx.path && types[x.opt.name] !== undefined && !x.opt.flag) typed[x.opt.name] = parse(x.opt, x.raw);
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
  // required: leaf args shadowing a global, then required_unless_present groups
  const given = (n) => leaf.some((x) => x.opt.name === n);
  const missing = leafRequired.filter((n) => !given(n));
  for (const group of oneOf) if (!group.some(given)) missing.push(...group);
  if (missing.length) throw missingError(ctx.path, leaf, missing.map((n) => node.opts.find((x) => x.name === n)));
  return typed;
}

// Handler entry point: clap reports its errors and exits(2) before main.rs runs anything (in
// particular before the audit log). Once clap accepts argv, main.rs builds `Context::new`,
// which loads AppConfig eagerly (incl. the one-time legacy config migration) — forced here
// because core/context.mjs loads it lazily.
export function clap(ctx, o, rules) {
  let typed;
  try {
    typed = clapPass(ctx, o, rules);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message);
    process.exit(2);
  }
  void ctx.config;   // upstream: commands/mod.rs::Context::new → AppConfig::load()
  return typed;
}
