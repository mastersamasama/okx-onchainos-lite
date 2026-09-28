// PRIVATE fallback — clap's `conflicts_with_all` validation as the strategy args use it
// (handlers.rs::CancelArgs). commands/token/_clap.mjs reports only the FIRST conflicting partner;
// clap (validator.rs::validate_conflicts / build_conflict_err) lists EVERY partner present:
//   error: the argument '--order-id <ORDER_ID>' cannot be used with:
//     --order-ids <ORDER_IDS>
//     --all
// Requested for promotion into core/cli.mjs (or token/_clap.mjs) — then this file goes away.
//
// clap order: parse-time errors (hyphen values, value parsers) → conflicts → missing required.
import { UsageError } from '../../core/errors.mjs';
import { spec } from '../../core/cli.mjs';
import { clapPass, occurrences } from '../token/_clap.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);

// clap smart usage for a conflict error: required args (declaration order), then the explicitly
// used leaf args (first-occurrence order) minus the conflicting ones; hidden `--dev` never shows.
function conflictUsage(path, used) {
  const node = spec().nodes[path];
  const seen = new Set();
  const parts = [];
  for (const o of [...node.opts.filter((x) => x.required && !x.global), ...used]) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    parts.push(display(o));
  }
  return ['onchainos', path, ...parts].join(' ');
}

// validator.rs::validate_conflicts — `withAll` maps an arg name to its conflicts_with_all list.
// Args are visited in matcher order (first occurrence in argv); the partners of the first arg
// that has any are gathered in matcher order (either side may declare the conflict), de-duplicated.
export function validateConflicts(ctx, withAll) {
  const leaf = [];
  for (const x of occurrences(ctx.argv)) {
    if (x.path === ctx.path && !leaf.some((y) => y.name === x.opt.name)) leaf.push(x.opt);
  }
  const declares = (a, b) => (withAll[a] ?? []).includes(b);
  for (const arg of leaf) {
    const partners = leaf.filter((o) => o.name !== arg.name && (declares(arg.name, o.name) || declares(o.name, arg.name)));
    if (!partners.length) continue;
    const msg = partners.length === 1
      ? `the argument '${display(arg)}' cannot be used with '${display(partners[0])}'`
      : `the argument '${display(arg)}' cannot be used with:${partners.map((p) => `\n  ${display(p)}`).join('')}`;
    const names = new Set(partners.map((p) => p.name));
    const used = leaf.filter((o) => !names.has(o.name) && o.name !== 'dev');
    throw new UsageError(`error: ${msg}\n\nUsage: ${conflictUsage(ctx.path, used)}\n${TAIL}`);
  }
}

// token/_clap.mjs::clap with the conflict step replaced by validateConflicts. Prints clap's
// error and exits 2 before anything else runs; on success forces the AppConfig load
// (commands/mod.rs::Context::new) exactly like the shared helper.
export function clap(ctx, o, opts = {}, conflictsWithAll = {}) {
  let typed;
  try {
    typed = clapPass(ctx, o, { ...opts, conflicts: [], leafRequired: [] });
    validateConflicts(ctx, conflictsWithAll);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message);
    process.exit(2);
  }
  void ctx.config;
  return typed;
}
