// PRIVATE — clap validations lib/core/cli.mjs does not model for the transfer/sign commands
// (requested for promotion into core/cli.mjs via lib/spec.json):
//   • `conflicts_with` — `wallet send --amt/--readable-amount`, `wallet contract-call
//     --sui-tx-bytes` vs `--input-data`/`--unsigned-tx`;
//   • `requires` — `wallet send --brc20-outpoint` requires `--contract-token`;
//   • a *required* leaf `--chain` is not satisfied by the global `--chain` given before the
//     subcommand (the core parser merges the two values).
// clap reports these on stderr with exit 2 before main.rs runs (so no audit record).
import { UsageError } from '../../core/errors.mjs';
import { spec } from '../../core/cli.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const isOptionToken = (t) => t.startsWith('-') && t.length > 1 && !/^-\d/.test(t);

// Every option occurrence in argv, attributed to the command level it was parsed at.
export function occurrences(argv) {
  const nodes = spec().nodes;
  const globals = new Map(nodes[''].opts.map((o) => [o.long, o]));
  globals.set('--dev', { name: 'dev', long: '--dev', flag: true });
  let path = '', node = nodes[''];
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') break;
    if (isOptionToken(tok)) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(0, eq) : tok;
      const o = node.opts.find((x) => x.long === name || x.short === name) || globals.get(name);
      if (!o) continue;
      if (o.flag) out.push({ path, opt: o, index: i });
      else if (eq > 0) out.push({ path, opt: o, raw: tok.slice(eq + 1), index: i });
      else { out.push({ path, opt: o, raw: argv[i + 1], index: i }); i++; }
      continue;
    }
    if (node.subs && node.subs.includes(tok)) { path = path ? `${path} ${tok}` : tok; node = nodes[path]; }
  }
  return out;
}

// clap 4.6 Usage::create_usage_with_title(incls) ("smart usage"): the command's required-arg
// graph (declaration order, plus any `requires` it gained) followed by `incls`, first
// occurrence wins. clap passes the *used* args in ArgMatcher order — the order in which they
// first appeared on the command line — not in declaration order.
function smartUsage(path, requiredGraph, incls) {
  const node = spec().nodes[path];
  const names = [];
  for (const n of [...requiredGraph, ...incls]) if (!names.includes(n)) names.push(n);
  return ['onchainos', path, ...names.map((n) => display(node.opts.find((o) => o.name === n)))].join(' ');
}

// Validate; throws UsageError with clap's text. conflicts: [[a, b]] (symmetric), requires:
// [[arg, needed]], leafRequired: [names that must be given at the leaf level].
// Order and wording follow clap_builder 4.6 Validator::validate: conflicts first
// (validate_conflicts → build_conflict_err / build_conflict_err_usage), then required args
// (validate_required → missing_required_error).
export function clapValidate(ctx, { conflicts = [], requires = [], leafRequired = [] } = {}) {
  const all = occurrences(ctx.argv);
  // Parse-time (argv order): `--opt -5` — clap reads `-5` as a short flag, not a value.
  for (const x of all) {
    if (!x.opt.flag && x.raw !== undefined && !ctx.argv[x.index].includes('=') && /^-\d/.test(x.raw)) {
      const help = spec().nodes[x.path].help || '';
      throw new UsageError(`error: unexpected argument '${x.raw.slice(0, 2)}' found\n\nUsage: ${(help.match(/Usage: (.*)/) || [])[1] || 'onchainos'}\n${TAIL}`);
    }
  }
  const node = spec().nodes[ctx.path];
  // ArgMatcher order: every explicitly given leaf arg once, at its first occurrence (the hidden
  // global --dev never appears in a usage line).
  const present = [];
  for (const x of all) if (x.path === ctx.path && x.opt.name !== 'dev' && !present.includes(x.opt.name)) present.push(x.opt.name);
  const optOf = (n) => node.opts.find((o) => o.name === n);
  const partnersOf = (n) => conflicts.filter((p) => p.includes(n)).flatMap((p) => p.filter((m) => m !== n));
  const requiresOf = (n) => requires.filter(([a]) => a === n).map(([, b]) => b);
  const declaredRequired = node.opts.filter((o) => o.required).map((o) => o.name);

  // validate_conflicts: the first present arg (matcher order) conflicting with other present
  // args; those are listed in matcher order (a "with:" list when there are several).
  for (const name of present) {
    const others = present.filter((p) => p !== name && partnersOf(name).includes(p));
    if (!others.length) continue;
    const withText = others.length === 1
      ? ` with '${display(optOf(others[0]))}'`
      : ` with:${others.map((n) => `\n  ${display(optOf(n))}`).join('')}`;
    // build_conflict_err_usage: the used args minus the conflicting ones, preceded by the args
    // they require that were not given.
    const used = present.filter((n) => !others.includes(n));
    const required = used.flatMap(requiresOf).filter((n) => !used.includes(n) && !others.includes(n));
    throw new UsageError(`error: the argument '${display(optOf(name))}' cannot be used${withText}\n\nUsage: ${smartUsage(ctx.path, declaredRequired, [...required, ...used])}\n${TAIL}`);
  }

  // validate_required: the required graph gains the `requires` of present args (matcher order);
  // missing args are listed in graph order and the usage adds the used args, then the missing.
  const graph = [...declaredRequired];
  for (const n of present) for (const r of requiresOf(n)) if (!graph.includes(r)) graph.push(r);
  const checked = new Set([...leafRequired, ...present.flatMap(requiresOf)]);
  const missing = graph.filter((n) => checked.has(n) && !present.includes(n));
  if (missing.length) {
    const list = missing.map((n) => `  ${display(optOf(n))}`).join('\n');
    throw new UsageError(`error: the following required arguments were not provided:\n${list}\n\nUsage: ${smartUsage(ctx.path, graph, [...present, ...missing])}\n${TAIL}`);
  }
}

// All raw values of a repeatable option given at the leaf (clap `Vec<String>` append action).
export function leafValues(ctx, name) {
  return occurrences(ctx.argv).filter((x) => x.path === ctx.path && x.opt.name === name && typeof x.raw === 'string').map((x) => x.raw);
}

// Handler entry: clap exits 2 before dispatch (no audit record, nothing on stdout).
export function clap(ctx, rules) {
  try {
    clapValidate(ctx, rules);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message);
    process.exit(2);
  }
}
