#!/usr/bin/env node
// spec/cli-tree.json (dumped from the upstream binary) → skill/onchainos-lite/lib/spec.json
// The runtime parser and --help are driven only by lib/spec.json. Never edit it by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tree = JSON.parse(readFileSync(join(ROOT, 'spec', 'cli-tree.json'), 'utf8'));

const camel = (long) => long.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const nodes = {};
const rootHelp = new Map(tree.tree.options.map((o) => [o.long, o.help]));
(function walk(n) {
  const opts = n.options.filter((o) => o.long !== '--help' && o.long !== '--version').map((o) => {
    const e = { name: camel(o.long), long: o.long };
    if (o.short && o.short !== '-h') e.short = o.short;
    if (o.value) e.value = o.value; else e.flag = true;
    if (o.required) e.required = true;
    if (o.default !== undefined) e.default = o.default;
    if (o.possible) e.possible = o.possible;
    if (o.multiple) e.multiple = true;
    if (o.optionalValue) e.optionalValue = true;
    // clap `global = true` args re-rendered on every subcommand with the root's help text
    if (n.path && rootHelp.has(o.long) && rootHelp.get(o.long) === o.help) e.global = true;
    return e;
  });
  // clap ArgGroup(required) renders as <--a <A>|--b <B>> in usage: exactly one of them.
  const usage = (n.help.match(/Usage: (.*)/) || [])[1] || '';
  const groups = [...usage.matchAll(/<(--[\w-]+ <[^>]+>(?:\|--[\w-]+ <[^>]+>)+)>/g)].map((m) => m[1].split('|').map((p) => camel(p.split(' ')[0])));
  for (const g of groups) for (const o of opts) if (g.includes(o.name)) delete o.required;
  const node = { help: n.help, opts };
  if (n.helpShort) node.helpShort = n.helpShort;
  if (groups.length) node.requiredGroups = groups;
  if (n.args?.length) node.args = n.args.map((a) => ({ name: a.name.replace(/[<>\[\]]|\.\.\./g, ''), required: a.required, multiple: a.name.endsWith('...') }));
  if (n.children.length) node.subs = n.children.map((c) => c.path.split(' ').at(-1));
  if (n.hidden) node.hidden = true;
  nodes[n.path] = node;
  n.children.forEach(walk);
})(tree.tree);

// ── Merge the exact clap model (spec/clap-model.json, dumped by tools/dump-clap-model.mjs)
// and the relations clap does not expose (spec/overrides.json). The help text stays the
// source for --help; the model is the source for parse-time semantics.
const INT_TYPES = new Set(['u8', 'u16', 'u32', 'u64', 'usize', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64']);
// bounds of clap's default integer parsers (value_parser!(uN) = RangedI64ValueParser over the type)
const TYPE_BOUNDS = { u8: '0..=255', u16: '0..=65535', u32: '0..=4294967295', i8: '-128..=127', i16: '-32768..=32767', i32: '-2147483648..=2147483647' };
let merged = 0;
try {
  const model = JSON.parse(readFileSync(join(ROOT, 'spec', 'clap-model.json'), 'utf8'));
  const overrides = JSON.parse(readFileSync(join(ROOT, 'spec', 'overrides.json'), 'utf8'));
  const byPath = new Map();
  (function walk(n) { byPath.set(n.path, n); n.subcommands.forEach(walk); })(model);
  for (const [path, node] of Object.entries(nodes)) {
    const cm = byPath.get(path);
    if (!cm) continue;
    // subcommands in clap declaration order (suggestion ties, `[subcommands: …]` lists); names the
    // help tree does not have (debug-only commands, the auto `help`) are skipped
    if (node.subs) {
      const decl = cm.subcommands.map((s) => s.name).filter((n) => node.subs.includes(n));
      node.subs = [...decl, ...node.subs.filter((n) => !decl.includes(n))];
    }
    // subcommand aliases (clap alias / visible_alias) resolve to the canonical name
    if (path && cm.aliases?.length) {
      const parent = nodes[path.split(' ').slice(0, -1).join(' ')];
      for (const al of cm.aliases) (parent.subAliases ||= {})[al] = path.split(' ').at(-1);
    }
    const idToName = new Map();
    for (const a of cm.args) if (a.long) idToName.set(a.id, camel(a.long));
    const nameOf = (id) => idToName.get(id) ?? camel(id.replace(/_/g, '-'));
    for (const a of cm.args) {
      if (a.positional || !a.long || a.long === 'help' || a.long === 'version') continue;
      let o = node.opts.find((x) => x.long === `--${a.long}`);
      if (!o) {
        if (a.id === 'dev') continue;                        // hidden global, handled by the parser
        o = { name: camel(a.long), long: `--${a.long}`, hidden: true };
        if (a.action === 'SetTrue' || a.action === 'SetFalse' || a.action === 'Count') o.flag = true;
        else o.value = (a.valueNames && a.valueNames[0]) || a.id.toUpperCase();
        if (a.defaults.length && !o.flag) o.default = a.defaults[0];
        node.opts.push(o);
      }
      if (a.action === 'Append' || /\.\./.test(a.numArgs || '')) o.multiple = true;
      // num_args(1..): several values per occurrence (`--keywords a b`)
      if (/^\d+\.\.(=?\d+)?$/.test(a.numArgs || '') && !/\.\.=?[01]$/.test(a.numArgs)) o.multiValue = true;
      // the model's default is exact (help renders default_value = "" as '""')
      if (!o.flag && a.defaults.length === 1) o.default = a.defaults[0];
      if (a.allowHyphen || a.allowNegative) o.allowHyphen = true;
      if (a.delimiter) o.delimiter = a.delimiter;
      if (a.aliases && a.aliases.length) o.aliases = a.aliases.map((x) => `--${x}`);
      if (a.required) o.required = true;
      if (a.possible.length && !o.possible) o.possible = a.possible.filter((x) => !(a.possibleHidden || []).includes(x));
      const accept = [...(a.possibleHidden || []), ...(a.possibleAliases || [])];
      if (accept.length && !a.boolish) o.accept = accept;
      // a custom value_parser fn returning an integer (e.g. strategy --direction) has the int type
      // id too; only clap's own integer parsers answer the probe with their range/digit errors
      const builtin = !a.rangeProbe || /: (-?\d+ is not in |invalid digit found in string|number too (large|small))/.test(a.rangeProbe);
      if (INT_TYPES.has(a.valueParser) && builtin) o.type = a.valueParser;
      if (a.boolish) o.type = 'boolish';
      // value_parser!(uN).range(..): bounds as clap prints them (from the dumper's parser probe)
      const bounds = /is not in (-?\d+\.\.=-?\d+)/.exec(a.rangeProbe || '')?.[1];
      if (bounds && bounds !== TYPE_BOUNDS[a.valueParser]) o.range = bounds.split('..=');
      const conflicts = a.conflicts.map(nameOf).filter((c) => c !== o.name);
      if (conflicts.length) o.conflicts = conflicts;
    }
    const groups = cm.groups.filter((g) => g.required || !g.multiple).map((g) => ({ args: g.args.map(nameOf), required: g.required, multiple: g.multiple }));
    if (groups.length) { node.groups = groups; delete node.requiredGroups; }
    for (const [id, deps] of Object.entries(overrides.requires?.[path] || {})) { const o = node.opts.find((x) => x.name === nameOf(id)); if (o) o.requires = deps.map(nameOf); }
    for (const [id, deps] of Object.entries(overrides.requiredUnless?.[path] || {})) { const o = node.opts.find((x) => x.name === nameOf(id)); if (o) o.requiredUnless = deps.map(nameOf); }
    merged++;
  }
} catch (e) {
  console.error(`warning: clap model not merged (${e.message}); run node tools/dump-clap-model.mjs`);
}

const spec = { upstream: tree.version.replace(/^onchainos\s+/, ''), generated: 'tools/gen-spec.mjs from spec/cli-tree.json + spec/clap-model.json + spec/overrides.json — do not edit', nodes };
if (merged) console.log(`clap model merged into ${merged} nodes`);
writeFileSync(join(ROOT, 'skill', 'onchainos-lite', 'lib', 'spec.json'), JSON.stringify(spec));
const leaves = Object.entries(nodes).filter(([, n]) => !n.subs).length;
console.log(`lib/spec.json: ${Object.keys(nodes).length} nodes, ${leaves} leaf commands, upstream ${spec.upstream}`);
