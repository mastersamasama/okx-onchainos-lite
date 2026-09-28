// PRIVATE — clap 4.6 argument relations for the wallet-rest commands (receive, funding-check,
// inscription create|status, utxo *, gas-station *) that lib/spec.json does not model yet:
// `conflicts_with[_all]`, `requires`, `required_unless_present`, and "a leaf's own required
// --chain is not satisfied by the global --chain". Candidate for core (the core parser is
// gaining a clap model); until then the handlers validate here, after the core parse.
//
// Mirrors clap_builder 4.6 `Validator::validate` for a leaf command:
//   1. validate_conflicts — for each explicitly present arg in ArgMatcher order (first
//      occurrence on the command line), gather the present args it conflicts with (either
//      direction) and fail on the first one that has any: "the argument 'A' cannot be used with
//      'B'" (or "with:\n  B\n  C" when several). Usage = smart usage of the used args minus the
//      conflicting ones, preceded by the args those require that were not given.
//   2. validate_required — the required graph (declared-required args, declaration order) gains
//      the `requires` of present args; missing = graph args not present at the leaf, then the
//      `required_unless_present` args whose alternatives are all absent (declaration order).
//      Listed = graph + missing, minus present; usage = graph + used (matcher order) + missing.
// clap prints to stderr and exits 2 before main.rs runs (no audit record, nothing on stdout).
import { UsageError } from '../../core/errors.mjs';
import { spec } from '../../core/cli.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const isOptionToken = (t) => t.length > 1 && t[0] === '-' && !/^-\d/.test(t);

// Option names explicitly given at the leaf, in ArgMatcher order (first occurrence), excluding
// hidden args (clap filters hidden ones out of every usage line).
export function leafPresent(ctx) {
  const nodes = spec().nodes;
  const globals = new Map(nodes[''].opts.map((o) => [o.long, o]));
  let path = '', node = nodes[''];
  const present = [];
  for (let i = 0; i < ctx.argv.length; i++) {
    const tok = ctx.argv[i];
    if (tok === '--') break;
    if (isOptionToken(tok)) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(0, eq) : tok;
      const o = node.opts.find((x) => x.long === name || x.short === name) || globals.get(name);
      if (!o) continue;
      if (path === ctx.path && !o.hidden && !present.includes(o.name) && node.opts.includes(o)) present.push(o.name);
      if (!o.flag && eq < 0) i++;
      continue;
    }
    if (node.subs && node.subs.includes(tok)) { path = path ? `${path} ${tok}` : tok; node = nodes[path]; }
  }
  return present;
}

// Validate; throws UsageError with clap's exact text.
//   conflicts:      [[a, b], …]      (symmetric, as clap's gather_conflicts treats them)
//   requires:       [[arg, needed]]
//   requiredUnless: [[arg, [alternatives…]], …] (declaration order)
export function clapValidate(ctx, { conflicts = [], requires = [], requiredUnless = [] } = {}) {
  const node = spec().nodes[ctx.path];
  const optOf = (n) => node.opts.find((o) => o.name === n);
  const present = leafPresent(ctx);
  const partnersOf = (n) => conflicts.filter((p) => p.includes(n)).flatMap((p) => p.filter((m) => m !== n));
  const requiresOf = (n) => requires.filter(([a]) => a === n).map(([, b]) => b);
  const declared = node.opts.filter((o) => o.required).map((o) => o.name);
  const smartUsage = (graph, incls) => {
    const names = [];
    for (const n of [...graph, ...incls]) if (!names.includes(n)) names.push(n);
    return ['onchainos', ctx.path, ...names.map((n) => display(optOf(n)))].join(' ');
  };

  // 1. validate_conflicts
  for (const name of present) {
    const others = present.filter((p) => p !== name && partnersOf(name).includes(p));
    if (!others.length) continue;
    const withText = others.length === 1
      ? ` with '${display(optOf(others[0]))}'`
      : ` with:${others.map((n) => `\n  ${display(optOf(n))}`).join('')}`;
    const used = present.filter((n) => !others.includes(n));
    const needed = used.flatMap(requiresOf).filter((n) => !used.includes(n) && !others.includes(n));
    throw new UsageError(`error: the argument '${display(optOf(name))}' cannot be used${withText}\n\nUsage: ${smartUsage(declared, [...needed, ...used])}\n${TAIL}`);
  }

  // 2. validate_required
  const graph = [...declared];
  for (const n of present) for (const r of requiresOf(n)) if (!graph.includes(r)) graph.push(r);
  const missing = graph.filter((n) => !present.includes(n));
  for (const [arg, alternatives] of requiredUnless) {
    if (!present.includes(arg) && !alternatives.some((a) => present.includes(a)) && !missing.includes(arg)) missing.push(arg);
  }
  if (missing.length) {
    const listed = [...graph, ...missing].filter((n, i, all) => all.indexOf(n) === i && !present.includes(n));
    throw new UsageError(`error: the following required arguments were not provided:\n${listed.map((n) => `  ${display(optOf(n))}`).join('\n')}\n\nUsage: ${smartUsage(graph, [...present, ...missing])}\n${TAIL}`);
  }
}

// Handler entry: print clap's error and exit 2 (as clap does before dispatch).
export function clap(ctx, rules) {
  try {
    clapValidate(ctx, rules);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message);
    process.exit(2);
  }
}
