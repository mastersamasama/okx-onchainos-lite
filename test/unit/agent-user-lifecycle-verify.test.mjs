// Verifier regressions for unit A4 (agent user lifecycle): behaviours the parity host cannot
// reach or that need exact oracles derived from the upstream crates.
//   • refund.rs::acquire_pending_lock — fs2 `lock_exclusive` really excludes a second process
//     and is released when its owner exits (stale holders are reclaimed).
//   • flow_lifecycle/core.rs::a2a_transport_identity_from_json — `serde_jcs::to_vec`: members
//     ordered by the bytes of the serialized key, exact i64/u64 digits, ECMAScript floats.
//   • subscription_list.rs::decode_cursor — `serde_json::from_slice::<SubscriptionCursor>`:
//     duplicate fields / BOM / trailing characters rejected, sequence and map-variant forms accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'skill', 'onchainos-lite', 'lib');
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-a4-verify-'));
process.env.OCL_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const refundUrl = pathToFileURL(join(LIB, 'agent', 'task', 'user', 'refund.mjs')).href;
const { _internal: refund, pendingStatePath } = await import(refundUrl);
const { a2aTransportIdentityFromJson } = await import(pathToFileURL(join(LIB, 'agent', 'task', 'user', 'flow-lifecycle', 'core.mjs')).href);
const { jcs } = await import(pathToFileURL(join(LIB, 'core', 'rs', 'jcs.mjs')).href);
const { decodeCursor, encodeCursor } = await import(pathToFileURL(join(LIB, 'agent', 'task', 'user', 'subscription-list.mjs')).href);
const { parse } = await import(pathToFileURL(join(LIB, 'core', 'json.mjs')).href);

const JOB = '0x' + 'ab'.repeat(32);
const lockPathFor = (job, user) => pendingStatePath(job, user).replace(/\.json$/, '.lock');

// A child process that takes the lock, reports it, and releases when told to (or on exit).
function holder(job, user) {
  const script = [
    `const { _internal } = await import(${JSON.stringify(refundUrl)});`,
    `const release = await _internal.acquirePendingLock(${JSON.stringify(job)}, ${JSON.stringify(user)});`,
    "process.stdout.write('locked\\n');",
    "process.stdin.once('data', () => { release(); process.stdout.write('released\\n'); process.exit(0); });",
  ].join('\n');
  return spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OCL_HOME: HOME }, stdio: ['pipe', 'pipe', 'inherit'] });
}
const waitFor = (child, marker) => new Promise((resolve, reject) => {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; if (buf.includes(marker)) resolve(); });
  child.once('exit', (code) => { if (!buf.includes(marker)) reject(new Error(`child exited ${code} before ${marker}`)); });
});

test('refund lock: a second process blocks until the holder releases (fs2 lock_exclusive)', async () => {
  const a = holder(JOB, 'u-block');
  await waitFor(a, 'locked');
  let acquired = false;
  const pending = refund.acquirePendingLock(JOB, 'u-block').then((release) => { acquired = true; return release; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(acquired, false, 'lock must be exclusive while another process holds it');
  a.stdin.write('go\n');
  const release = await pending;
  assert.equal(acquired, true);
  assert.ok(existsSync(`${lockPathFor(JOB, 'u-block')}.held`), 'held marker exists while locked');
  release();
  assert.equal(existsSync(`${lockPathFor(JOB, 'u-block')}.held`), false, 'released lock leaves no marker');
  assert.ok(existsSync(lockPathFor(JOB, 'u-block')), 'the upstream `.lock` file persists');
});

test('refund lock: a holder that exited without releasing is reclaimed (flock is dropped on exit)', async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  const held = `${lockPathFor(JOB, 'u-stale')}.held`;
  mkdirSync(dirname(held), { recursive: true });
  mkdirSync(held);
  writeFileSync(join(held, 'pid'), String(deadPid));
  const started = Date.now();
  const release = await refund.acquirePendingLock(JOB, 'u-stale');
  assert.ok(Date.now() - started < 2000, 'stale holder must not block');
  release();
  // an ownerless marker (crash between mkdir and pid write) is reclaimed once it is old
  mkdirSync(held);
  const old = new Date(Date.now() - 60_000);
  utimesSync(held, old, old);
  const release2 = await refund.acquirePendingLock(JOB, 'u-stale');
  release2();
  assert.deepEqual(readdirSync(dirname(held)).filter((n) => n.endsWith('.held')), []);
});

test('refund lock: reconcile paths release the lock (prepare → execute in one process)', async () => {
  const r1 = await refund.acquirePendingLock(JOB, 'u-seq');
  r1();
  const r2 = await refund.acquirePendingLock(JOB, 'u-seq');
  r2();
  r2();   // idempotent release
});

test('a2a transport identity: serde_jcs canonical bytes', () => {
  // Members sort by serialized-key bytes: `"a "` (22 61 20 22) precedes `"a"` (22 61 22).
  assert.equal(jcs(parse('{"a":1,"a ":2,"a!":3}')), '{"a ":2,"a!":3,"a":1}');
  // UTF-8 byte order, not UTF-16: U+FF61 (EF BD A1) before U+1F600 (F0 9F 98 80).
  assert.equal(jcs(parse('{"\\ud83d\\ude00":1,"\\uff61":2}')), '{"｡":2,"😀":1}');
  // Escaped control characters sort by their escaped form (`\\n` = 5C 6E after `A` = 41).
  assert.equal(jcs(parse('{"a\\n":1,"aA":2}')), '{"aA":2,"a\\n":1}');
  // i64/u64 print exactly (itoa); floats use the ECMAScript form (ryu-js); ±0.0 → 0.
  assert.equal(jcs(parse('[12345678901234567891,-9223372036854775808,1.0,-0.0,1e21,1e-7,0.1,100000000000000000000000]')),
    '[12345678901234567891,-9223372036854775808,1,0,1e+21,1e-7,0.1,1e+23]');
  const id = a2aTransportIdentityFromJson(parse('{"b":1,"a":{"nano":1700000000123456789}}'));
  const expected = createHash('sha256').update('{"a":{"nano":1700000000123456789},"b":1}').digest('hex');
  assert.deepEqual(id, { value: expected, source: 'envelope_hash', originSessionKey: null });
});

test('subscription-list cursor: serde_json::from_slice struct semantics', () => {
  const b64 = (t) => Buffer.from(t, 'utf8').toString('base64url');
  const good = '{"version":1,"stage":"active","page":1,"offset":0,"page_size":2,"active_count":2,"ended_count":5}';
  const want = { version: 1, stage: 'active', page: 1, offset: 0, pageSize: 2, activeCount: 2, endedCount: 5 };
  assert.deepEqual(decodeCursor(b64(good)), want);
  assert.deepEqual(decodeCursor(b64('[1,"active",1,0,2,2,5]')), want);
  assert.deepEqual(decodeCursor(b64(good.replace('"active"', '{"active":null}'))), want);
  for (const bad of [good.replace('}', ',"version":1}'), `﻿${good}`, `${good} x`, good.replace('"active"', '{"active":1}'),
    '[1,"active",1,0,2,2,5,9]', good.replace('"page":1', '"page":1.0')]) {
    assert.throws(() => decodeCursor(b64(bad)), /invalid subscription cursor/, bad);
  }
  assert.equal(encodeCursor({ version: 1, stage: 'ended', page: 2, offset: 3, pageSize: 10, activeCount: 11, endedCount: 12 }),
    'eyJ2ZXJzaW9uIjoxLCJzdGFnZSI6ImVuZGVkIiwicGFnZSI6Miwib2Zmc2V0IjozLCJwYWdlX3NpemUiOjEwLCJhY3RpdmVfY291bnQiOjExLCJlbmRlZF9jb3VudCI6MTJ9');
});
