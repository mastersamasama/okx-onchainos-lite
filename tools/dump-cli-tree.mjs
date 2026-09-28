#!/usr/bin/env node
// Walk `onchainos <path> --help` recursively and emit the full command tree as JSON.
// Usage: node tools/dump-cli-tree.mjs <onchainos-binary> [spec/hidden.json] > spec/cli-tree.json
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BIN = process.argv[2] || 'onchainos';

function help(path, flag = '--help') {
  try {
    return execFileSync(BIN, [...path, flag], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ONCHAINOS_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

// Parse clap help: sections "Commands:", "Options:", "Arguments:".
function parse(text) {
  const lines = text.split(/\r?\n/);
  const out = { about: '', usage: '', commands: [], options: [], args: [] };
  let section = 'about';
  const aboutLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Usage:/.test(line)) { out.usage = line.replace(/^Usage:\s*/, '').trim(); section = 'usage'; continue; }
    if (/^Commands:/.test(line)) { section = 'commands'; continue; }
    if (/^Options:/.test(line)) { section = 'options'; continue; }
    if (/^Arguments:/.test(line)) { section = 'args'; continue; }
    if (/^\S.*:$/.test(line) && section !== 'about') { section = 'other'; continue; }
    if (section === 'about') { aboutLines.push(line); continue; }
    if (section === 'commands') {
      const m = line.match(/^ {2}([a-z0-9][\w-]*)(?:,\s*[\w-]+)?\s{2,}(.*)$/i) || line.match(/^ {2}([a-z0-9][\w-]*)\s*$/i);
      if (m) out.commands.push({ name: m[1], about: (m[2] || '').trim() });
      else if (/^ {6,}\S/.test(line) && out.commands.length) out.commands.at(-1).about += ' ' + line.trim();
      continue;
    }
    if (section === 'options') {
      // Compact form: "  -h, --help   Print help" / "      --address <ADDRESS>  Token address"
      // Long form: option on its own line, help indented by 10 spaces on following lines.
      const m = line.match(/^ {2,6}(?:(-\w),\s+)?(--[\w-]+)(?:[ =](<[^>]+>|\[<?[^\]>]+>?\])(\.\.\.)?)?(?:\s{2,}(.*))?$/);
      if (m) {
        const raw = m[3] || null;
        out.options.push({
          short: m[1] || null,
          long: m[2],
          value: raw ? raw.replace(/[<>\[\]]/g, '') : null,
          optionalValue: raw ? raw.startsWith('[') : false,
          multiple: !!m[4],
          help: (m[5] || '').trim(),
        });
      } else if (/^ {7,}Possible values:\s*$/.test(line) && out.options.length) {
        out.options.at(-1).possibleBlock = [];
      } else if (/^ {7,}- [^:\s]+(:|$)/.test(line) && out.options.at(-1)?.possibleBlock) {
        out.options.at(-1).possibleBlock.push(line.trim().replace(/^- /, '').split(':')[0].trim());
      } else if (/^ {7,}\S/.test(line) && out.options.length) {
        out.options.at(-1).help += (out.options.at(-1).help ? ' ' : '') + line.trim();
      }
      continue;
    }
    if (section === 'args') {
      const m = line.match(/^ {2,6}([<\[][^>\]]+[>\]](?:\.\.\.)?)(?:\s{2,}(.*))?$/);
      if (m) out.args.push({ name: m[1], required: m[1].startsWith('<'), help: (m[2] || '').trim() });
      else if (/^ {7,}\S/.test(line) && out.args.length) out.args.at(-1).help += ' ' + line.trim();
    }
  }
  out.about = aboutLines.join('\n').trim();
  const required = new Set((out.usage.match(/(?<!\[)--[\w-]+(?= <)/g) || []));
  for (const o of out.options) {
    const d = o.help.match(/\[default: ([^\]]+)\]/); if (d) o.default = d[1];
    const p = o.help.match(/\[possible values: ([^\]]+)\]/); if (p) o.possible = p[1].split(/,\s*/);
    if (o.possibleBlock) { if (o.possibleBlock.length) o.possible = o.possibleBlock; delete o.possibleBlock; }
    const a = o.help.match(/\[aliases?: ([^\]]+)\]/); if (a) o.aliases = a[1].split(/,\s*/);
    o.required = required.has(o.long);
  }
  out.usage = out.usage.replace(/^\S+/, 'onchainos');
  return out;
}

const HIDDEN = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : [];

function walk(path) {
  const raw = help(path);
  const node = parse(raw);
  node.path = path.join(' ');
  node.help = raw.replace(/\r\n/g, '\n').replace(/Usage: \S+/g, 'Usage: onchainos');
  // `-h` prints clap's short help, which differs when options carry long help text
  const short = help(path, '-h').replace(/\r\n/g, '\n').replace(/Usage: \S+/g, 'Usage: onchainos');
  if (short !== node.help) node.helpShort = short;
  node.children = [];
  const names = node.commands.filter((c) => c.name !== 'help').map((c) => c.name);
  // Hidden subcommands (clap hide = true) are not listed by --help but still answer it.
  for (const h of HIDDEN) {
    const parts = h.split(' ');
    if (parts.length === path.length + 1 && parts.slice(0, -1).join(' ') === path.join(' ') && !names.includes(parts.at(-1))) names.push(parts.at(-1));
  }
  for (const name of names) {
    // hidden commands compiled only into debug builds answer with a clap error — skip them
    if (!node.commands.some((c) => c.name === name) && /^error: unrecognized subcommand/m.test(help([...path, name]))) continue;
    const child = walk([...path, name]);
    if (!node.commands.some((c) => c.name === name)) child.hidden = true;
    node.children.push(child);
  }
  delete node.commands;
  return node;
}

const tree = walk([]);
const leaves = [];
(function collect(n) { if (!n.children.length && n.path) leaves.push(n.path); n.children.forEach(collect); })(tree);
const version = execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ version, leafCount: leaves.length, leaves, tree }, null, 2) + '\n');
