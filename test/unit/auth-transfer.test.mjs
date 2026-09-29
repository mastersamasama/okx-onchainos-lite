// lite-only `auth transfer`: init on the target, seal on the source, open on the target (stdin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OCL = fileURLToPath(new URL('../../skill/onchainos-lite/bin/ocl.mjs', import.meta.url));
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OKX_|OCL_|ONCHAINOS_)/.test(k)));
const run = (home, args, { env = {}, input } = {}) => {
  const r = spawnSync(process.execPath, [OCL, ...args], { env: { ...CLEAN, OCL_HOME: home, ONCHAINOS_HOME: home, OCL_NO_BROWSER: '1', ...env }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

test('auth transfer: sealed API key opens once on the target, from stdin', () => {
  const src = mkdtempSync(join(tmpdir(), 'ocl-src-')), dst = mkdtempSync(join(tmpdir(), 'ocl-dst-'));
  try {
    const init = run(dst, ['auth', 'transfer', 'init']);
    assert.equal(init.code, 0);
    const recipient = init.out.data.recipient;
    assert.match(recipient, /^ocl-rcpt-v1\.[A-Za-z0-9_-]{43}$/);

    const key = { OKX_API_KEY: 'ak-test-0000000000000000', OKX_SECRET_KEY: 'sk-test-0000000000000000', OKX_PASSPHRASE: 'pp-test' };
    const sealed = run(src, ['auth', 'transfer', 'seal', '--to', recipient], { env: key });
    assert.equal(sealed.code, 0);
    assert.deepEqual(sealed.out.data.contains, ['api-key']);
    const blob = sealed.out.data.sealed;
    assert.match(blob, /^ocl-seal-v1\./);
    assert.ok(!blob.includes('ak-test') && !Buffer.from(blob.slice(12), 'base64url').toString('latin1').includes('sk-test'), 'no plaintext secret in the blob');

    const opened = run(dst, ['auth', 'transfer', 'open', '-'], { input: `${blob}\n` });
    assert.equal(opened.code, 0, opened.err);
    assert.deepEqual(opened.out.data.imported, ['api-key']);
    const status = JSON.stringify(run(dst, ['auth', 'status']).out);
    assert.ok(!status.includes('sk-test') && !status.includes('pp-test'), 'status never prints secrets');

    const again = run(dst, ['auth', 'transfer', 'open', blob]);
    assert.equal(again.code, 1);
    assert.match(again.out.error, /no pending transfer/);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('auth transfer: a blob sealed for another recipient does not open', () => {
  const a = mkdtempSync(join(tmpdir(), 'ocl-a-')), b = mkdtempSync(join(tmpdir(), 'ocl-b-'));
  try {
    const ra = run(a, ['auth', 'transfer', 'init']).out.data.recipient;
    run(b, ['auth', 'transfer', 'init']);
    const blob = run(a, ['auth', 'transfer', 'seal', '--to', ra], { env: { OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p' } }).out.data.sealed;
    const r = run(b, ['auth', 'transfer', 'open', blob]);
    assert.equal(r.code, 1);
    assert.match(r.out.error, /could not open the sealed value/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
