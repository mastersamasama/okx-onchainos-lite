// Verifier regressions for the autotrade partition (A2-agent-autotrade).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, opendirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDirPaths } from '../../skill/onchainos-lite/lib/agent/task/common/autotrade/_fs.mjs';
import { CliBespokeExit } from '../../skill/onchainos-lite/lib/agent/task/common/autotrade/index.mjs';
import { BespokeExit } from '../../skill/onchainos-lite/lib/core/errors.mjs';

// upstream mod.rs::CliBespokeExit Display = "bespoke exit: {code}" — the `error` text audit::log
// writes for autotrade-grant-check denials; main.rs still exits with the code silently.
test('CliBespokeExit keeps core exit handling and upstream Display text', () => {
  const e = new CliBespokeExit(1);
  assert.ok(e instanceof BespokeExit);
  assert.equal(e.code, 1);
  assert.equal(e.message, 'bespoke exit: 1');
});

// Rust std::fs::read_dir yields raw readdir(3)/getdents (Unix) or FindNextFileW (Windows) order.
// fs.readdirSync goes through uv_fs_scandir, which strcmp-sorts on Unix, so the outcome-flush
// array order / 32-entry cap / maintenance scan order diverged on Linux (e.g. Muse). The port
// must iterate the directory stream exactly like opendir does.
test('readDirPaths keeps raw directory-stream order (not scandir-sorted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-autotrade-readdir-'));
  try {
    const names = ['zeta.json', 'b.json', '10.json', '9.json', '_x.json', '.hidden.json', 'M.json', 'c.lease-1', 'alpha.txt', 'é.json'];
    for (const n of names) writeFileSync(join(dir, n), '');
    const raw = [];
    const d = opendirSync(dir);
    for (let e = d.readSync(); e !== null; e = d.readSync()) raw.push(e.name);
    d.closeSync();
    assert.deepEqual(readDirPaths(dir).map((p) => p.slice(dir.length + 1)), raw);
    assert.equal(new Set(raw).size, names.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readDirPaths on a regular file fails with the io::Error Display text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-autotrade-readdir-'));
  try {
    const file = join(dir, 'outcomes');
    writeFileSync(file, 'x');
    const expected = process.platform === 'win32' ? 'The directory name is invalid. (os error 267)' : 'Not a directory (os error 20)';
    assert.throws(() => readDirPaths(file), (e) => e.message === expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
