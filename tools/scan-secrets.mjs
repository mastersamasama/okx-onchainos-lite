#!/usr/bin/env node
// Pre-publish scan: fail if any file that git would commit contains secrets or
// personal data from this machine (wallet addresses, device ids, e-mail, tokens, keys).
//   node tools/scan-secrets.mjs [--personal <file with extra literals, one per line>]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);

// Literals that must never be published: harvested from this machine's real state.
const literals = new Set();
const add = (v) => { if (v && String(v).length >= 8) literals.add(String(v).toLowerCase()); };
for (const dir of ['.onchainos', '.onchainos-lite']) {
  const w = join(homedir(), dir, 'wallets.json');
  if (existsSync(w)) {
    const text = readFileSync(w, 'utf8');
    for (const m of text.matchAll(/"(?:address|email|accountId|projectId)"\s*:\s*"([^"]+)"/g)) add(m[1]);
  }
  const s = join(homedir(), dir, 'session.json');
  if (existsSync(s)) for (const m of readFileSync(s, 'utf8').matchAll(/"(\w+)"\s*:\s*"([^"]{16,})"/g)) add(m[2]);
  const mi = join(homedir(), dir, 'machine-identity');
  if (existsSync(mi)) add(readFileSync(mi, 'utf8').trim());
}
add(hostname());
const idx = process.argv.indexOf('--personal');
if (idx > 0) for (const l of readFileSync(process.argv[idx + 1], 'utf8').split(/\r?\n/)) add(l.trim());

const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key block'],
  [/(?:api[_-]?key|secret[_-]?key|passphrase|password)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}/i, 'credential assignment'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
];
const ALLOW = [/test\/unit\/vectors\.json$/, /test\/parity\/homes\//, /test\/parity\/fixtures\//, /test\/parity\/make-home\.mjs$/, /\.test\.mjs$/];

// Test JWTs outside the allow-listed dirs are fine only when their claims are obviously fake
// (the jwt.io sample subject, or parity-* identities).
function syntheticJwt(t) {
  try {
    const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return claims.sub === '1234567890' || /parity/i.test(JSON.stringify(claims));
  } catch { return false; }
}

const findings = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  const lower = text.toLowerCase();
  for (const lit of literals) if (lower.includes(lit)) findings.push({ file: f, kind: 'personal literal', sample: lit.slice(0, 6) + '…' });
  if (ALLOW.some((re) => re.test(f))) continue;   // fabricated test credentials live here
  for (const [re, kind] of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
      if (kind === 'JWT' && syntheticJwt(m[0])) continue;
      findings.push({ file: f, kind, sample: m[0].slice(0, 12) + '…' });
      break;
    }
  }
}
console.log(`scanned ${files.length} files against ${literals.size} personal literals`);
for (const x of findings) console.log(`✖ ${x.kind}: ${x.file} (${x.sample})`);
process.exitCode = findings.length ? 1 : 0;
