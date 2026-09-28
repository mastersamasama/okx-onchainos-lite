// PRIVATE — clap validations lib/core/cli.mjs does not model for the payment commands
// (requested for promotion into core/cli.mjs via lib/spec.json):
//   • `required_unless_present` + `conflicts_with` — `payment pay --payload/--payment-id`,
//     `payment decode-receipt --header/--receipt`;
//   • a *required* leaf `--chain` (`payment default set`) is not satisfied by the global
//     `--chain` given before the subcommand (the core parser merges the two values);
//   • `--opt -5`: clap reads `-5` as an unexpected short flag, not as the option's value.
// clap reports these on stderr with exit 2 before main.rs dispatches (no stdout, no audit).
import { UsageError } from '../core/errors.mjs';
import { spec, typed } from '../core/cli.mjs';

const TAIL = "\nFor more information, try '--help'.\n";
const display = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const isOptionToken = (t) => t.startsWith('-') && t.length > 1 && !/^-\d/.test(t);
const usageLine = (path) => ((spec().nodes[path].help || '').match(/Usage: (.*)/) || [])[1] || 'onchainos';

// Every option occurrence in argv with the command level it was parsed at.
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
      else if (eq > 0) out.push({ path, opt: o, raw: tok.slice(eq + 1), index: i, inline: true });
      else { out.push({ path, opt: o, raw: argv[i + 1], index: i }); i++; }
      continue;
    }
    if (node.subs && node.subs.includes(tok)) { path = path ? `${path} ${tok}` : tok; node = nodes[path]; }
  }
  return out;
}

// clap "smart usage": the required args (declaration order) followed by the used ones.
function usage(path, used) {
  const node = spec().nodes[path];
  const names = new Set(used.map((o) => o.name));
  const req = node.opts.filter((o) => o.required);
  const rest = node.opts.filter((o) => !o.required && names.has(o.name));
  return ['onchainos', path, ...[...req, ...rest].map(display)].join(' ');
}

const stripUsage = (e) => { if (e instanceof UsageError) e.message = e.message.replace(/\nUsage: [^\n]*\n/, ''); return e; };

// conflicts: [[a, b]]; required: names that must be given at the leaf level;
// typed: {name: 'usize' | 'u64' | …} value parsers — parse-time, so checked before the
// conflict / required validation (a ValueValidation error prints no Usage line).
// Returns the converted typed values.
export function validate(ctx, { conflicts = [], required = [], typed: types = {} } = {}) {
  const all = occurrences(ctx.argv);
  for (const x of all) {
    if (!x.opt.flag && x.raw !== undefined && !x.inline && /^-\d/.test(x.raw)) {
      throw new UsageError(`error: unexpected argument '${x.raw.slice(0, 2)}' found\n\nUsage: ${usageLine(x.path)}\n${TAIL}`);
    }
  }
  const values = {};
  for (const [name, type] of Object.entries(types)) {
    try { values[name] = typed(ctx.path, name, ctx.opts[name], type); } catch (e) { throw stripUsage(e); }
  }
  const leaf = all.filter((x) => x.path === ctx.path && x.opt.name !== 'dev');
  for (const x of leaf) {
    const partners = conflicts.filter((p) => p.includes(x.opt.name)).map((p) => p.find((n) => n !== x.opt.name));
    const other = leaf.find((y) => partners.includes(y.opt.name));
    if (!other) continue;
    const used = leaf.filter((y) => !partners.includes(y.opt.name)).map((y) => y.opt);
    throw new UsageError(`error: the argument '${display(x.opt)}' cannot be used with '${display(other.opt)}'\n\nUsage: ${usage(ctx.path, used)}\n${TAIL}`);
  }
  const given = new Set(leaf.map((x) => x.opt.name));
  const node = spec().nodes[ctx.path];
  const missing = node.opts.filter((o) => required.includes(o.name) && !given.has(o.name));
  if (missing.length) {
    const used = [...leaf.map((x) => x.opt), ...missing];
    throw new UsageError(`error: the following required arguments were not provided:\n${missing.map((m) => `  ${display(m)}`).join('\n')}\n\nUsage: ${usage(ctx.path, used)}\n${TAIL}`);
  }
  return values;
}

function exitUsage(e) {
  if (!(e instanceof UsageError)) throw e;
  process.stderr.write(e.message);
  process.exit(2);
}

// Handler entry: clap exits 2 before dispatch (nothing on stdout, no audit record).
export function clap(ctx, rules) {
  try { return validate(ctx, rules); } catch (e) { return exitUsage(e); }
}

// All raw values of a repeatable (clap `Vec<String>` Append) option given at the leaf. lib/spec.json
// does not mark `--param` as repeatable yet, so the parsed value may be a single string.
export function leafValues(ctx, name) {
  const vals = occurrences(ctx.argv).filter((x) => x.path === ctx.path && x.opt.name === name && typeof x.raw === 'string').map((x) => x.raw);
  if (vals.length) return vals;
  const v = ctx.opts?.[name];
  return v === undefined ? [] : [].concat(v);
}
