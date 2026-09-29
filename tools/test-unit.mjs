#!/usr/bin/env node
// Run every test/unit/*.test.mjs with node:test. Explicit file arguments behave the same on
// Node 18–24 (a directory argument or a glob does not). Extra args are passed to `node --test`.
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'unit');
const files = readdirSync(DIR).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => join(DIR, n));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
