#!/usr/bin/env node
// Build test/parity/endpoints.json (the parity proxy's safety policy) from the endpoint
// classification tables in spec/extract/*.md. When specs disagree, the most dangerous
// class wins (funds > state > auth > read). Only "read" endpoints are ever forwarded.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(ROOT, 'spec', 'extract');
const RANK = { read: 0, auth: 1, state: 2, funds: 3 };
const map = {};
const sources = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    // | GET | `/api/...` | read | ...   (also tolerates "GET/POST", "ANY", missing backticks)
    const m = line.match(/^\|\s*(GET|POST|PUT|DELETE|PATCH|GET\/POST|POST\/GET)\s*\|\s*`?(\/(?:api|priapi)\/[^`|\s]+)`?[^|]*\|\s*\**(read|auth|state|funds)\**\s*\|/i);
    if (!m) continue;
    const cls = m[3].toLowerCase();
    for (const method of m[1].toUpperCase().split('/')) {
      const key = `${method} ${m[2].replace(/\?.*$/, '')}`;
      if (map[key] === undefined || RANK[cls] > RANK[map[key]]) map[key] = cls;
      (sources[key] ||= new Set()).add(f);
    }
  }
}
// structured classifications returned by the extraction agents (spec/endpoints.extracted.json)
try {
  const extracted = JSON.parse(readFileSync(join(ROOT, 'spec', 'endpoints.extracted.json'), 'utf8'));
  for (const [key, cls] of Object.entries(extracted)) if (RANK[cls] !== undefined && (map[key] === undefined || RANK[cls] > RANK[map[key]])) map[key] = cls;
} catch {}
const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
writeFileSync(join(ROOT, 'test', 'parity', 'endpoints.json'), JSON.stringify(sorted, null, 2) + '\n');
const count = Object.values(map).reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), {});
console.log(`endpoints.json: ${Object.keys(map).length} endpoints`, count);
