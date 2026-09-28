#!/usr/bin/env node
// Coverage gate — the "1:1 restriction". Fails (exit 1) when:
//   1. a command in lib/spec.json (upstream surface) has no handler;
//   2. a handler exists for a path upstream does not have;
//   3. a handler's `uses` + `ignores` differ from the upstream option set for that command;
//   4. generated command docs are stale (when references/commands exists).
// Usage: node tools/check.mjs [--json] [--top <name>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'skill', 'onchainos-lite');
const spec = JSON.parse(readFileSync(join(SKILL, 'lib', 'spec.json'), 'utf8'));
const liteNodes = JSON.parse(readFileSync(join(SKILL, 'lib', 'lite-spec.json'), 'utf8')).nodes; // lite-only extensions
const args = process.argv.slice(2);
const onlyTop = args.includes('--top') ? args[args.indexOf('--top') + 1] : null;

const leaves = Object.entries(spec.nodes).filter(([p, n]) => p && !n.subs).map(([p]) => p).filter((p) => !onlyTop || p.split(' ')[0] === onlyTop);
const handlers = {};
const loadErrors = [];
const cmdDir = join(SKILL, 'lib', 'commands');
for (const top of existsSync(cmdDir) ? readdirSync(cmdDir) : []) {
  if (onlyTop && top !== onlyTop) continue;
  for (const f of readdirSync(join(cmdDir, top)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))) {
    let mod;
    try { mod = await import(pathToFileURL(join(cmdDir, top, f)).href); }
    catch (e) { loadErrors.push({ kind: 'load-error', file: `${top}/${f}`, detail: e.message.split(/\r?\n/)[0] }); continue; }
    for (const [path, def] of Object.entries(mod.default || {})) {
      if (handlers[path]) handlers[path].dup = `${handlers[path].file} & ${top}/${f}`;
      else handlers[path] = { ...def, file: `${top}/${f}` };
    }
  }
}

const problems = [...loadErrors];
const missing = leaves.filter((p) => !handlers[p]);
for (const p of missing) problems.push({ kind: 'missing-handler', path: p });
for (const [p, h] of Object.entries(handlers)) {
  if (liteNodes[p]) continue;
  if (!spec.nodes[p] || spec.nodes[p].subs) { problems.push({ kind: 'unknown-command', path: p, file: h.file }); continue; }
  if (h.dup) problems.push({ kind: 'duplicate-handler', path: p, files: h.dup });
  if (typeof h.run !== 'function') problems.push({ kind: 'no-run', path: p, file: h.file });
  const want = new Set(spec.nodes[p].opts.filter((o) => !o.global).map((o) => o.name).concat((spec.nodes[p].args || []).map((a) => a.name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase()))));
  const have = new Set([...(h.uses || []), ...(h.ignores || [])].map((u) => u.split(':')[0]));
  const notHandled = [...want].filter((x) => !have.has(x));
  const extra = [...have].filter((x) => !want.has(x));
  if (notHandled.length || extra.length) problems.push({ kind: 'option-mismatch', path: p, file: h.file, notHandled, extra });
}

// generated docs freshness
const docsDir = join(SKILL, 'references', 'commands');
if (existsSync(docsDir) && existsSync(join(ROOT, 'tools', 'gen-docs.mjs'))) {
  try { execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-docs.mjs'), '--check'], { stdio: 'pipe' }); }
  catch (e) { problems.push({ kind: 'stale-docs', detail: String(e.stdout || e.message).trim() }); }
}

const implemented = leaves.length - missing.length;
if (args.includes('--json')) console.log(JSON.stringify({ leaves: leaves.length, implemented, problems }, null, 2));
else {
  const byKind = problems.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
  for (const p of problems.filter((p) => p.kind !== 'missing-handler')) console.log(`✖ ${p.kind} ${p.path ?? ''} ${p.file ?? ''} ${p.notHandled ? 'missing=' + p.notHandled.join(',') : ''} ${p.extra?.length ? 'extra=' + p.extra.join(',') : ''} ${p.detail ?? ''}`);
  if (missing.length) console.log(`… ${missing.length} commands without handler${missing.length <= 20 ? ': ' + missing.join(' | ') : ''}`);
  console.log(`coverage ${implemented}/${leaves.length} upstream commands (${spec.upstream}); problems: ${JSON.stringify(byKind)}`);
}
process.exitCode = problems.length ? 1 : 0;
