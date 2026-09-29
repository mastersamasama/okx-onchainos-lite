// Spec-driven argument parser reproducing clap's accept/reject behaviour and
// messages for the upstream command surface (lib/spec.json).
import { readFileSync } from 'node:fs';
import { UsageError } from './errors.mjs';

let SPEC;
export function spec() {
  if (!SPEC) {
    SPEC = JSON.parse(readFileSync(new URL('../spec.json', import.meta.url), 'utf8'));
    // lite-only commands (e.g. `doctor`) are appended to the upstream surface
    const lite = JSON.parse(readFileSync(new URL('../lite-spec.json', import.meta.url), 'utf8'));
    for (const [path, node] of Object.entries(lite.nodes)) {
      SPEC.nodes[path] = node;
      const parent = path.split(' ').slice(0, -1).join(' ');
      const subs = (SPEC.nodes[parent].subs ||= []);
      if (!subs.includes(path.split(' ').at(-1))) subs.push(path.split(' ').at(-1));
    }
  }
  return SPEC;
}

const usageOf = (node) => ((node.help.match(/Usage: (.*)/) || [])[1] || 'onchainos');
// clap "required usage": only the required pieces, used in missing-argument errors.
function requiredUsage(path, node) {
  const req = node.opts.filter((o) => o.required).map((o) => `${o.long} <${o.value}>`);
  const pos = (node.args || []).filter((a) => a.required).map((a) => `<${a.name}>`);
  return ['onchainos', path, ...req, ...pos].filter(Boolean).join(' ');
}

function usageError(msg, path, node, { tip, usage } = {}) {
  return new UsageError(`error: ${msg}\n${tip ? `\n  tip: ${tip}\n` : ''}\nUsage: ${usage ?? usageOf(node)}\n\nFor more information, try '--help'.\n`);
}

// strsim::jaro, as clap uses for "similar ..." tips (threshold > 0.7, ascending order).
function jaro(a, b) {
  if (a === b) return 1;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++)
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  t = Math.floor(t / 2);   // strsim 0.11: `transpositions /= 2` on usize
  return (m / a.length + m / b.length + (m - t) / m) / 3;
}
function similar(name, candidates) {
  return candidates.map((c) => [jaro(name, c), c]).filter(([s]) => s > 0.7).sort((x, y) => x[0] - y[0]).map(([, c]) => c);
}

const quoteList = (xs) => xs.map((x) => `'${x}'`).join(', ');
const childPath = (path, s) => (path ? `${path} ${s}` : s);
// clap Command::all_subcommand_names: every subcommand in declaration order (hidden included),
// each followed by its aliases, then the auto-generated `help`. Lite-only extensions are left
// out so upstream's messages stay byte-identical.
function allSubcommandNames(path, node) {
  const { nodes } = spec();
  const out = [];
  for (const s of node.subs || []) {
    if (nodes[childPath(path, s)]?.lite) continue;
    out.push(s, ...Object.keys(node.subAliases || {}).filter((a) => node.subAliases[a] === s));
  }
  out.push('help');
  return out;
}
// clap Command::find_subcommand: name or alias; the auto `help` subcommand is a child too
function findSubcommand(node, tok) {
  if (node.subs?.includes(tok)) return tok;
  if (node.subAliases?.[tok]) return node.subAliases[tok];
  return tok === 'help' ? 'help' : undefined;
}
const helpSubcommandUsage = (path) => `onchainos ${childPath(path, 'help')} [COMMAND]...`;
const helpSubcommandHelp = (path) => `Print this message or the help of the given subcommand(s)\n\nUsage: ${helpSubcommandUsage(path)}\n\nArguments:\n  [COMMAND]...  Print help for the subcommand(s)\n`;
// clap Parser::parse_help_subcommand: walks every word (names + aliases; flags are words too);
// an unknown word is `unrecognized subcommand` with the usage of the level reached (no tip).
// Prints the long help of the node reached.
function helpSubcommand(path, node, words) {
  const { nodes } = spec();
  let inHelp = false;
  for (const w of words) {
    const sub = inHelp ? undefined : findSubcommand(node, w);
    // the help subcommand has no --help flag, so clap prints no "For more information" line there
    if (!sub && inHelp) throw new UsageError(`error: unrecognized subcommand '${w}'\n\nUsage: ${helpSubcommandUsage(path)}\n`);
    if (!sub) throw usageError(`unrecognized subcommand '${w}'`, path, node);
    if (sub === 'help') { inHelp = true; continue; }
    path = childPath(path, sub);
    node = nodes[path];
  }
  return { help: inHelp ? helpSubcommandHelp(path) : node.help, path };
}

const displayOf = (o) => (o.flag ? o.long : `${o.long} <${o.value}>`);
const VALUE_TAIL = "\nFor more information, try '--help'.\n";
// clap value errors (invalid value / value parser) print no Usage block.
const valueError = (msg, tip) => new UsageError(`error: ${msg}\n${tip ? `\n  tip: ${tip}\n` : ''}${VALUE_TAIL}`);
// clap Error::empty_value: "a value is required …" plus the visible possible values, no Usage block
const missingValue = (o) => valueError(`a value is required for '${displayOf(o)}' but none was supplied${o.possible?.length ? `\n  [possible values: ${o.possible.join(', ')}]` : ''}`);
// clap Usage::create_smart_usage(used): required args (declaration order), then the used
// (non-hidden) args, de-duplicated; `<COMMAND>` when a subcommand is required.
function smartUsageFor(path, node, used) {
  const seen = new Set(), parts = [];
  for (const o of [...node.opts.filter((x) => x.required && !x.global), ...used]) {
    if (!o || o.hidden || seen.has(o.name)) continue;
    seen.add(o.name);
    parts.push(displayOf(o));
  }
  return ['onchainos', path, ...parts, ...(node.args || []).filter((a) => a.required).map((a) => `<${a.name}>`), ...(node.subs ? ['<COMMAND>'] : [])].filter(Boolean).join(' ');
}
const HELP_ARG = { name: 'help', long: '--help', flag: true };
const VERSION_ARG = { name: 'version', long: '--version', flag: true };

// Parse argv → { path, node, opts } or { help } / { version: true }.
// Semantics verified against clap 4.6 in the upstream binary:
//  - a global option may be given at several levels (deepest wins), but not twice at one level;
//  - a leaf's own required option (e.g. a local required --chain) must be given at the leaf;
//  - a value starting with '-' is a short-flag token ("unexpected argument '-5' found")
//    unless the option allows hyphen values;
//  - value parsers run as each value is consumed (argv order, before any relation check);
//  - relations from the clap model (conflicts, requires, required-unless, groups) are enforced.
// An upstream `value_parser = <fn>` (spec type 'custom') is the command's own code:
// `valueParsers(path)` resolves the leaf's { name: fn } (its handler's `parsers`), and the
// option's value in `opts` is that fn's output, as clap hands it to the command.
export async function parse(argv, { valueParsers } = {}) {
  const { nodes } = spec();
  const root = nodes[''];
  const globals = new Map(root.opts.map((o) => [o.long, o]));
  globals.set('--dev', { name: 'dev', long: '--dev', flag: true });
  let path = '', node = root, level = 0;
  const values = {}, positionals = [];
  const givenAt = new Map();   // option name → set of levels it was given at
  const given = new Map();     // option name → spec entry (for messages)
  const order = [];            // every option occurrence in argv order: { opt, level }
  let i = 0, rest = false;
  let pendingEmpty;            // option left without a value by a following `--` (clap pending arg)
  const deferred = [];         // duplicate-option errors clap raises only after the subcommand parsed

  const optFor =(tok) => node.opts.find((o) => o.long === tok || o.short === tok || (o.aliases || []).includes(tok)) || (globals.has(tok) ? globals.get(tok) : undefined);
  const record = (o, v) => {
    const levels = givenAt.get(o.name) || new Set();
    if (levels.has(level) && !o.multiple) throw usageError(`the argument '${displayOf(o)}' cannot be used multiple times`, path, node);
    levels.add(level);
    order.push({ opt: o, level });
    givenAt.set(o.name, levels);
    given.set(o.name, o);
    if (o.multiple) {
      const parts = o.delimiter ? String(v).split(o.delimiter) : [v];
      (values[o.name] ||= []).push(...parts);
    } else values[o.name] = o.delimiter && !o.flag ? String(v).split(o.delimiter) : v;
  };
  const shortToken = (t) => t.length > 1 && t[0] === '-' && t[1] !== '-';
  // clap value parsers run while parsing: a bad value fails before any required-arg check.
  // Returns the value the command receives (the raw string unless the parser is custom).
  const parseValue = async (o, v) => {
    switch (o.type) {
      case undefined: return v;
      case 'path':   // PathBufValueParser: an empty value is Error::empty_value
        if (v === '') throw missingValue(o);
        return v;
      case 'custom': {
        const fn = (await valueParsers?.(path))?.[o.name];
        if (!fn) throw new Error(`no value parser for '${displayOf(o)}' of '${path}'`);
        try { return fn(v); }
        catch (e) { throw valueError(`invalid value '${v}' for '${displayOf(o)}': ${e.message}`); }
      }
      default:
        for (const part of o.delimiter ? String(v).split(o.delimiter) : [v]) {
          try { parseTyped(part, o); }
          catch (e) { throw valueError(`invalid value '${part}' for '${displayOf(o)}': ${e.message}`); }
        }
        return v;
    }
  };
  // clap num_args(1..): one occurrence takes values until the next flag-like token
  const moreValues = async (o) => {
    while (o.multiValue && i < argv.length && argv[i] !== '--' && !(argv[i].length > 1 && argv[i][0] === '-' && !o.allowHyphen)) {
      (values[o.name] ||= []).push(await parseValue(o, argv[i]));
      i++;
    }
  };
  // clap Parser::did_you_mean_error: best similar long of this command (hidden, aliases, --help,
  // root --version included; highest confidence, last declared on ties). The suggested arg joins
  // the used args, and a non-empty used list switches the Usage line to smart usage.
  const unknownLong = (name) => {
    const cands = [...node.opts, ...[...globals.values()].filter((g) => !node.opts.some((x) => x.name === g.name)), HELP_ARG, ...(path === '' ? [VERSION_ARG] : [])];
    const longs = cands.flatMap((x) => [x.long, ...(x.aliases || [])].filter(Boolean).map((l) => [l.slice(2), x]));
    const best = similar(name.slice(2), longs.map(([l]) => l)).pop();
    const used = [];
    for (const x of order) if (x.level === level && !used.includes(x.opt)) used.push(x.opt);
    const sugOpt = best !== undefined ? longs.find(([l]) => l === best)[1] : undefined;
    if (sugOpt && !used.includes(sugOpt)) used.push(sugOpt);
    const shown = used.filter((x) => !x.hidden && x.name !== 'dev');
    const tip = best !== undefined ? `a similar argument exists: '--${best}'` : node.args?.length ? `to pass '${name}' as a value, use '-- ${name}'` : undefined;
    return usageError(`unexpected argument '${name}' found`, path, node, { tip, usage: shown.length ? smartUsageFor(path, node, shown) : undefined });
  };
  // clap unknown short: full usage; a command with positionals adds the `--` tip
  const unknownShort = (s) => usageError(`unexpected argument '${s}' found`, path, node, { tip: node.args?.length && !rest ? `to pass '${s}' as a value, use '-- ${s}'` : undefined });
  const isSub = (t) =>t !== undefined && node.subs && findSubcommand(node, t) !== undefined;

  while (i < argv.length) {
    const tok = argv[i];
    if (!rest && tok === '--') { rest = true; i++; continue; }
    if (!rest && tok === '--help') return { help: node.help, path };
    if (!rest && tok === '-h') return { help: node.helpShort ?? node.help, path };
    if (!rest && path === '' && (tok === '-V' || tok === '--version')) return { version: true };
    if (!rest && tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(0, eq) : tok;
      const o = optFor(name);
      if (!o) throw unknownLong(name);
      if (o.flag) {
        if (eq > 0) throw usageError(`unexpected value '${tok.slice(eq + 1)}' for '${o.long}' found; no more were expected`, path, node);
        record(o, true);
        i++;
        continue;
      }
      let v;
      if (eq > 0) { v = tok.slice(eq + 1); i++; }
      else {
        const next = argv[i + 1];
        const nextLong = next !== undefined && !o.allowHyphen && next.startsWith('--') && next.length > 2;
        const nextTerm = next === '--' && !o.allowHyphen;
        if (next === undefined || nextLong || nextTerm) {
          if (o.optionalValue) { record(o, ''); i++; continue; }
          // clap leaves the option pending: an unknown long flag is reported instead of the
          // missing value; `--` switches to positionals and the empty value surfaces only when
          // a positional is accepted or nothing follows.
          if (nextLong && !optFor(next.split('=')[0])) { i++; continue; }
          if (nextTerm && argv[i + 2] !== undefined) { pendingEmpty = o; rest = true; i += 2; continue; }
          throw missingValue(o);
        }
        if (!o.allowHyphen && shortToken(next)) {
          // a known short (-h, root -V) resolves the pending option first
          if (next[1] === 'h' || (next[1] === 'V' && path === '')) throw missingValue(o);
          throw unknownShort(next.slice(0, 2));
        }
        // clap resolves a repeated option's separate value only after a following subcommand
        // has parsed, so that subcommand's own errors (or help) win
        if (!o.multiple && givenAt.get(o.name)?.has(level) && !rest && isSub(argv[i + 2])) {
          deferred.unshift(usageError(`the argument '${displayOf(o)}' cannot be used multiple times`, path, node));
          i += 2;
          continue;
        }
        v = next; i += 2;
      }
      if (o.possible && o.type !== 'boolish' && !o.possible.includes(v) && !o.accept?.includes(v)) {
        const tip = similar(v, o.possible)[0];
        throw valueError(`invalid value '${v}' for '${displayOf(o)}'\n  [possible values: ${o.possible.join(', ')}]`, tip ? `a similar value exists: '${tip}'` : undefined);
      }
      record(o, await parseValue(o, v));
      if (eq < 0) await moreValues(o);
      continue;
    }
    if (!rest && shortToken(tok)) {
      // clap walks a short cluster left to right: -h / root -V act at once (`-hV` prints help)
      if (tok[1] === 'h') return { help: node.helpShort ?? node.help, path };
      if (tok[1] === 'V' && path === '') return { version: true };
      const o = optFor(tok.slice(0, 2));
      if (!o) throw unknownShort(tok.slice(0, 2));
      if (o.flag) { record(o, true); i++; continue; }
      const v = tok.length > 2 ? tok.slice(tok[2] === '=' ? 3 : 2) : argv[i + 1];
      if (v === undefined) throw missingValue(o);
      record(o, v);
      i += tok.length > 2 ? 1 : 2;
      continue;
    }
    // subcommand or positional
    if (node.subs && rest) {
      // clap match_arg_error after `--`: a subcommand name gets the remove-the-dashes tip; any
      // other word is still an unrecognized subcommand (with similar-name tips)
      if (isSub(tok)) throw usageError(`unexpected argument '${tok}' found`, path, node, { tip: `subcommand '${tok}' exists; to use it, remove the '--' before it` });
      const sims = similar(tok, allSubcommandNames(path, node));
      throw usageError(`unrecognized subcommand '${tok}'`, path, node, { tip: sims.length ? (sims.length === 1 ? `a similar subcommand exists: '${sims[0]}'` : `some similar subcommands exist: ${quoteList(sims)}`) : undefined });
    }
    if (node.subs && !rest) {
      if (tok === 'help') return helpSubcommand(path, node, argv.slice(i + 1));
      const sub = node.subs.includes(tok) ? tok : node.subAliases?.[tok];
      if (!sub) {
        const sims = similar(tok, allSubcommandNames(path, node));
        throw usageError(`unrecognized subcommand '${tok}'`, path, node, { tip: sims.length ? (sims.length === 1 ? `a similar subcommand exists: '${sims[0]}'` : `some similar subcommands exist: ${quoteList(sims)}`) : undefined });
      }
      path = path ? `${path} ${sub}` : sub;
      node = nodes[path];
      level++;
      i++;
      continue;
    }
    const argSpec = node.args || [];
    if (positionals.length >= argSpec.length && !argSpec.at(-1)?.multiple) throw usageError(`unexpected argument '${tok}' found`, path, node);
    if (pendingEmpty) throw missingValue(pendingEmpty);
    positionals.push(tok);
    i++;
  }
  if (pendingEmpty) throw missingValue(pendingEmpty);

  if (node.subs) {
    if (![...givenAt.values()].some((levels) => levels.has(level))) return { help: node.helpShort ?? node.help, path, missingSubcommand: true };
    throw usageError(`'${['onchainos', path].filter(Boolean).join(' ')}' requires a subcommand but one was not provided\n  [subcommands: ${allSubcommandNames(path, node).join(', ')}]`, path, node);
  }

  const has = (n) => values[n] !== undefined;
  const leafLevel = level;
  const displayName = (n) => { const o = node.opts.find((x) => x.name === n) || given.get(n); return o ? displayOf(o) : `<${n.toUpperCase()}>`; };

  // clap "smart usage" in relation errors: required leaf args (declaration order), then the
  // args that were used, de-duplicated (verified against the binary by the token unit).
  const leafUsed = order.filter((x) => x.level === leafLevel && x.opt.name !== 'dev').map((x) => x.opt);
  const byName = (n) => node.opts.find((x) => x.name === n);
  const requiresOf = (o) => (o.requires || []).map(byName).filter(Boolean);
  const initialRequired = node.opts.filter((x) => x.required && !x.global);
  // clap Usage::get_required_usage_from(incls): the required graph (each required arg preceded by
  // the args it requires), then `incls`, de-duplicated; required positionals last.
  const smartUsage = (incls, graph = initialRequired) => {
    const seen = new Set(), parts = [];
    for (const o of [...graph.flatMap((a) => [...requiresOf(a), a]), ...incls]) {
      if (!o || seen.has(o.name)) continue;
      seen.add(o.name);
      parts.push(displayOf(o));
    }
    return ['onchainos', path, ...parts, ...(node.args || []).filter((a) => a.required).map((a) => `<${a.name}>`)].join(' ');
  };
  // clap Validator::validate_conflicts: present args in matcher (argv) order; for each, every
  // present arg it conflicts with or that conflicts with it, in the same order
  const present = [...new Set(leafUsed)];
  const direct = (o) => o.conflicts || [];
  for (const x of present) {
    const found = [...new Set(present.filter((y) => y !== x && (direct(x).includes(y.name) || direct(y).includes(x.name))))];
    if (!found.length) continue;
    // build_conflict_err_usage: used (non-hidden, not conflicting) preceded by what they require
    const usedF = present.filter((y) => !y.hidden && !found.includes(y));
    const reqs = [...new Set(usedF.flatMap(requiresOf))].filter((r) => !usedF.includes(r) && !found.includes(r));
    const with_ = found.length === 1 ? ` '${displayOf(found[0])}'` : `:${found.map((f) => `\n  ${displayOf(f)}`).join('')}`;
    throw usageError(`the argument '${displayOf(x)}' cannot be used with${with_}`, path, node, { usage: smartUsage([...reqs, ...usedF]) });
  }
  for (const g of node.groups || []) {
    if (g.multiple) continue;
    const present = g.args.filter(has);
    if (present.length > 1) throw usageError(`the argument '${displayName(present[0])}' cannot be used with '${displayName(present[1])}'`, path, node);
  }

  const missing = [];
  for (const o of node.opts) {
    if (!o.required || o.global) continue;
    const atLeaf = givenAt.get(o.name)?.has(leafLevel);
    if (!atLeaf && !(o.requiredUnless || []).some(has)) missing.push(displayOf(o));
  }
  for (const o of node.opts) {
    if (o.required || !o.requiredUnless?.length) continue;
    if (!has(o.name) && !o.requiredUnless.some(has)) missing.push(displayOf(o));
  }
  for (const o of node.opts) {
    if (!has(o.name)) continue;
    for (const r of o.requires || []) if (!has(r)) missing.push(displayName(r));
  }
  const argSpec = node.args || [];
  argSpec.forEach((a, k) => { if (a.required && positionals[k] === undefined) missing.push(`<${a.name}>`); });
  for (const g of [...(node.requiredGroups || []).map((args) => ({ args, required: true })), ...(node.groups || []).filter((g) => g.required)]) {
    if (!g.args.some(has)) missing.push(`<${g.args.map(displayName).join('|')}>`);
  }
  if (missing.length) {
    const missOpts = node.opts.filter((o) => missing.includes(displayOf(o)));
    // Validator::missing_required_error: the required graph grows by what present args require
    // (gather_requires, argv order); usage = that graph, then used (non-hidden) + missing args
    const gathered = [...new Set(present.flatMap(requiresOf))].filter((r) => !initialRequired.includes(r));
    const usage = argSpec.some((a) => a.required && positionals.length < argSpec.length) ? requiredUsage(path, node) : smartUsage([...present.filter((y) => !y.hidden), ...missOpts], [...initialRequired, ...gathered]);
    throw usageError(`the following required arguments were not provided:\n  ${[...new Set(missing)].join('\n  ')}`, path, node, { usage });
  }
  for (const o of node.opts) if (values[o.name] === undefined && o.default !== undefined) values[o.name] = o.multiple ? [o.default] : o.default;
  for (const o of node.opts) if (o.flag && values[o.name] === undefined) values[o.name] = false;
  argSpec.forEach((a, k) => { values[a.name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = a.multiple ? positionals.slice(k) : positionals[k]; });
  if (deferred.length) throw deferred[0];   // deepest level resolves its pending value first
  return { path, node, opts: values };
}

// clap value parsers used by handlers (upstream types → clap's parsers):
//   u8/u16/u32/i8/i16/i32/i64 → RangedI64ValueParser (parse i64, then range check)
//   u64/usize → RangedU64ValueParser (<u64 as FromStr>)
//   f32/f64 → <f64 as FromStr> (accepts inf, infinity, nan, a leading '+')
// Errors print clap's value-error shape (no Usage block) and exit 2 via UsageError.
const RANGED = { u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: [-9223372036854775808n, 9223372036854775807n] };
const U64 = [0n, 18446744073709551615n];
const asNum = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v);

// upstream: library/core/src/num/mod.rs::from_str_radix (radix 10) — an optional '+' ('-' only for
// a signed type), then digits scanned left to right; an overflow is reported at the digit causing
// it, so it wins over a bad digit further right (`99999999999999999999x` is "too large").
function fromStrRadix(s, [min, max]) {
  if (s === '') throw new Error('cannot parse integer from empty string');
  const neg = s[0] === '-' && min < 0n;
  const digits = neg || s[0] === '+' ? s.slice(1) : s;
  if (digits === '') throw new Error('invalid digit found in string');
  let v = 0n;
  for (const c of digits) {
    if (c < '0' || c > '9') throw new Error('invalid digit found in string');
    v = v * 10n + (neg ? -BigInt(c) : BigInt(c));
    if (v > max) throw new Error('number too large to fit in target type');
    if (v < min) throw new Error('number too small to fit in target type');
  }
  return v;
}

export function parseClapInt(raw, type) {
  if (type === 'u64' || type === 'usize') return asNum(fromStrRadix(String(raw), U64));
  const range = RANGED[type];
  if (!range) throw new Error(`unsupported integer type ${type}`);
  const v = fromStrRadix(String(raw), RANGED.i64);
  if (v < range[0] || v > range[1]) throw new Error(`${v} is not in ${range[0]}..=${range[1]}`);
  return asNum(v);
}

// clap value_parser!(uN).range(lo..=hi): RangedI64ValueParser checks the bounds on the i64,
// then converts to the target type.
export function parseRangedInt(raw, type, [lo, hi]) {
  const v = BigInt(parseClapInt(raw, 'i64'));
  if (v < BigInt(lo) || v > BigInt(hi)) throw new Error(`${v} is not in ${lo}..=${hi}`);
  const r = RANGED[type];
  if (r && (v < r[0] || v > r[1])) throw new Error('out of range integral type conversion attempted');
  return asNum(v);
}

// clap BoolishValueParser (util::str_to_bool)
const TRUE_LITERALS = ['y', 'yes', 't', 'true', 'on', '1'], FALSE_LITERALS = ['n', 'no', 'f', 'false', 'off', '0'];
export function parseBoolish(raw) {
  const v = String(raw).toLowerCase();
  if (TRUE_LITERALS.includes(v)) return true;
  if (FALSE_LITERALS.includes(v)) return false;
  throw new Error('value was not a boolean');
}

// One value through the spec entry's clap value parser (type, range, boolish).
function parseTyped(raw, o) {
  if (o.type === 'boolish') return parseBoolish(raw);
  if (o.type === 'f64' || o.type === 'f32') return parseRustF64(raw);
  if (o.range) return parseRangedInt(raw, o.type, o.range);
  return parseClapInt(raw, o.type);
}

export function parseRustF64(raw) {
  const s = String(raw);
  if (s === '') throw new Error('cannot parse float from empty string');
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error('invalid float literal');
  return Number(s);
}

export function typed(path, name, raw, type) {
  if (raw === undefined || raw === null) return raw;
  if (Array.isArray(raw)) return raw.map((r) => typed(path, name, r, type));
  const node = spec().nodes[path];
  const o = node?.opts.find((x) => x.name === name);
  const display = o ? displayOf(o) : name;
  try {
    if (o?.range || o?.type === 'boolish') return parseTyped(raw, o);
    if (RANGED[type] || type === 'u64' || type === 'usize') return parseClapInt(raw, type);
    if (type === 'f64' || type === 'f32') return parseRustF64(raw);
    if (type === 'bool') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error('value was not a boolean');
    }
  } catch (e) {
    throw valueError(`invalid value '${raw}' for '${display}': ${e.message}`);
  }
  return raw;
}
