#!/usr/bin/env node
// Dump the exact upstream clap model (every arg's type, action, conflicts, groups, hidden
// flags, hyphen values, delimiters …) into spec/clap-model.json.
//   node tools/dump-clap-model.mjs [--ref <commit|tag>]   (default: the locked commit)
// How: a throwaway git worktree of upstream at <ref> gets tools/clap-dump/ocl_dump.rs and a
// 4-line entry in main.rs (only active with OCL_DUMP_CLAP=1), is built in debug mode (value-parser
// type names are only printable there) with the OS keychain disabled, and run once.
// Also lists clap `requires` / `required_unless_present` attributes, which clap keeps private,
// so spec/overrides.json can be checked for completeness.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UP = join(ROOT, 'upstream');
const args = process.argv.slice(2);
const lock = JSON.parse(readFileSync(join(ROOT, 'spec', 'upstream.lock.json'), 'utf8'));
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : lock.commit;
const git = (...a) => execFileSync('git', ['-C', UP, ...a], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', `${ref}^{commit}`);
const wt = join(ROOT, '.cache', `clap-dump-${commit.slice(0, 8)}`);

if (!existsSync(wt)) git('worktree', 'add', '--detach', wt, commit);
const main = join(wt, 'cli', 'src', 'main.rs');
let src = readFileSync(main, 'utf8');
if (!src.includes('mod ocl_dump;')) {
  src = src.replace(/^mod client;/m, 'mod client;\nmod ocl_dump;');
  src = src.replace(/^fn main\(\) \{/m, 'fn main() {\n    if std::env::var_os("OCL_DUMP_CLAP").is_some() {\n        ocl_dump::dump();\n        return;\n    }');
  writeFileSync(main, src);
}
copyFileSync(join(ROOT, 'tools', 'clap-dump', 'ocl_dump.rs'), join(wt, 'cli', 'src', 'ocl_dump.rs'));

const target = join(ROOT, '.cache', 'cargo-target-dump');
console.error('building clap dumper (debug)…');
const b = spawnSync('cargo', ['build'], { cwd: join(wt, 'cli'), env: { ...process.env, CARGO_TARGET_DIR: target, ONCHAINOS_FORCE_FILE_KEYRING: '1' }, stdio: 'inherit' });
if (b.status !== 0) process.exit(1);
const exe = join(target, 'debug', process.platform === 'win32' ? 'onchainos.exe' : 'onchainos');
const out = execFileSync(exe, [], { env: { ...process.env, OCL_DUMP_CLAP: '1' }, encoding: 'utf8', maxBuffer: 1 << 28 });
writeFileSync(join(ROOT, 'spec', 'clap-model.json'), out);

// completeness check for spec/overrides.json
const grep = spawnSync('git', ['-C', wt, 'grep', '-n', '-E', 'requires *=|required_unless_present', '--', 'cli/src'], { encoding: 'utf8' });
const found = (grep.stdout || '').split('\n').filter(Boolean);
const overrides = JSON.parse(readFileSync(join(ROOT, 'spec', 'overrides.json'), 'utf8'));
const known = Object.values(overrides.requires || {}).length + Object.values(overrides.requiredUnless || {}).length;
console.log(`spec/clap-model.json written (${commit.slice(0, 8)}); ${found.length} requires/required_unless attribute lines upstream, ${known} commands covered by spec/overrides.json`);
for (const l of found) console.log('  ' + l);
