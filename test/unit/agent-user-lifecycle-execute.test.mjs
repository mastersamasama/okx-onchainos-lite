// `agent refund-execute --confirm` past the reconciliation journal (upstream
// task/user/refund.rs::handle_execute → execute_operation → sign_response), unit A4.
//
// Why this exists: write_pending_mutation fsyncs the journal through a read-only handle
// (`File::open(path)?.sync_all()`), which Windows rejects (os error 5). Upstream 4.6.3 on
// Windows therefore always stops at `refund_reconciliation_guard_unavailable`, lite mirrors
// that, and the parity suite — recorded on a Windows host — can never reach the lifecycle
// POST, EIP-712 signing, broadcast, receipt journal and local cleanup. On unix (Muse, CI)
// those paths are the normal outcome, so they are pinned here.
//
// Each scenario runs the real CLI (`bin/ocl.mjs`) against a local fixture server built from
// the parity fixtures of this unit, with a preload that gives fsync unix semantics (EPERM on a
// read-only handle is ignored — the only platform difference involved). Expected values follow
// the upstream source. No network, no okx-a2a (PATH holds only node), fake credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ENTRY = join(ROOT, 'skill', 'onchainos-lite', 'bin', 'ocl.mjs');
const FIXTURES = join(ROOT, 'test', 'parity', 'fixtures');
const WALLET_HOME = join(ROOT, 'test', 'parity', 'homes', 'wallet');
const SCRATCH = mkdtempSync(join(tmpdir(), 'ocl-unit-refund-execute-'));
after(() => { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

const JOB = '0x' + 'ab'.repeat(32);
const SUB = '0x' + 'cd'.repeat(32);
const USER = '1001';

// fsync with unix semantics (see header). Applied only to the top-level CLI process.
const PRELOAD = join(SCRATCH, 'unix-fsync.mjs');
writeFileSync(PRELOAD, [
  "import fs from 'node:fs';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'const orig = fs.fsyncSync;',
  "fs.fsyncSync = (fd) => { try { return orig(fd); } catch (e) { if (e.code === 'EPERM') return undefined; throw e; } };",
  'syncBuiltinESMExports();',
].join('\n'));

// ── fixture server (same matching rules as test/parity/run.mjs::loadFixtures) ──
let server, base, active = [], used = new Map(), requests = [];
const subset = (want, have) => (want && typeof want === 'object'
  ? have && typeof have === 'object' && Object.entries(want).every(([k, v]) => subset(v, have[k]))
  : String(want) === String(have));
before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers };
      requests.push(entry);
      for (const [i, f] of active.entries()) {
        if (f.method && f.method !== req.method) continue;
        if (f.path && f.path !== url.pathname && !(f.pathRegex && new RegExp(f.pathRegex).test(url.pathname))) continue;
        if (!f.path && f.pathRegex && !new RegExp(f.pathRegex).test(url.pathname)) continue;
        if (f.match && !subset(f.match, { query: entry.query, body })) continue;
        const n = used.get(i) || 0;
        if (f.times && n >= f.times) continue;
        used.set(i, n + 1);
        const r = f.response;
        res.writeHead(r.status ?? 200, r.headers ?? { 'content-type': 'application/json' });
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: '404', msg: `no fixture for ${req.method} ${url.pathname}`, data: null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

function runCli(args, fixtureNames) {
  active = fixtureNames.flatMap((n) => JSON.parse(readFileSync(join(FIXTURES, `agent-user-lifecycle-${n}.json`), 'utf8')));
  used = new Map();
  requests = [];
  const home = mkdtempSync(join(SCRATCH, 'home-'));
  cpSync(WALLET_HOME, home, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(OCL_|ONCHAINOS_|CLAUDECODE$|CODEX_)/.test(k)) delete env[k];
  Object.assign(env, {
    PATH: dirname(process.execPath), OCL_HOME: home, ONCHAINOS_HOME: home, OCL_BASE_URL: base,
    ONCHAINOS_CREDENTIAL_STORE: 'file', ONCHAINOS_FORCE_FILE_KEYRING: '1', ONCHAINOS_NO_BROWSER: '1', NO_COLOR: '1',
  });
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    const t = setTimeout(() => p.kill(), 60000);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      const stdout = Buffer.concat(out).toString('utf8');
      let json;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr: Buffer.concat(err).toString('utf8'), json, home, requests: [...requests] });
    });
  });
}

const journalPath = (home, job) => join(home, 'refund-v2', `${createHash('sha256').update(`${USER}\0${job}`).digest('hex')}.json`);
const readJournal = (home, job) => JSON.parse(readFileSync(journalPath(home, job), 'utf8'));
const posts = (r, suffix) => r.requests.filter((q) => q.method === 'POST' && q.path.endsWith(suffix));
const execArgs = (job, op, ctx, extra = []) => ['agent', 'refund-execute', job, '--operation', op, '--refund-context-id', ctx, ...extra, '--confirm'];
const DIRECT_CTX = 'refundctx_8b6be3815cf6f6af7a97b73799898a3d4a985b077b05ed84866f567d14435453';
const reconcileActions = (job) => [{ id: 'view_refund_status', params: { jobId: job }, recommend: true }, { id: 'watch_task', params: { jobId: job }, recommend: false }];
const prepareAgain = (job) => [{ id: 'prepare_refund', params: { jobId: job }, recommend: true }];
// every key of the struct-ordered journal, in upstream PendingRefundMutation field order
const JOURNAL_KEYS = ['schemaVersion', 'journalRevision', 'jobId', 'userAgentId', 'snapshotId', 'operation', 'state', 'jobType', 'trialType',
  'periodIndex', 'periodStartTime', 'periodEndTime', 'pkgId', 'orderId', 'orderType', 'bizUniqKey', 'txHash', 'accountId', 'address',
  'chainIndex', 'bizType', 'originalAmount', 'tokenAddress', 'tokenSymbol', 'providerAgentId', 'serviceId', 'serviceName', 'paymentMode', 'updatedAt'];

test('direct-refund: close → sign uop → broadcast → receipt journal → ready', async () => {
  const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', 'close-ok', 'broadcast']);
  assert.equal(r.code, 0, r.stderr);
  const d = r.json.data;
  assert.equal(r.json.ok, true);
  assert.deepEqual([d.phase, d.decision, d.reason], ['refund_settlement', 'ready', 'refund_broadcast_submitted']);
  assert.deepEqual(d.nextAction, reconcileActions(JOB));
  assert.equal(d.payload.settlement.state, 'broadcast_submitted');
  assert.equal(d.payload.settlement.txHash, null);
  assert.deepEqual(d.payload.settlement.broadcastReceipt, {
    bizType: 200, bizUniqKey: `refund-${JOB}`, orderId: 'order-1', orderType: 'AA', pkgId: 'pkg-1', txHash: '0x' + 'ef'.repeat(32),
  });
  // wire: close carries the session cert and the buyer identity; broadcast carries bizContext
  const [close] = posts(r, `/task/${JOB}/close`);
  assert.equal(close.headers.agenticid, USER);
  assert.deepEqual(Object.keys(close.body), ['sessionCert']);
  const [bc] = posts(r, '/task/broadcast');
  assert.deepEqual(bc.body.bizContext, { bizType: 200, jobId: JOB });
  assert.equal(bc.body.chainIndex, '196');
  assert.equal(typeof bc.body.extraData, 'string');
  assert.ok(bc.body.sessionCert);
  // journal: struct order, receipt handles persisted
  const raw = readFileSync(journalPath(r.home, JOB), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)), JOURNAL_KEYS);
  const j = readJournal(r.home, JOB);
  assert.deepEqual([j.state, j.operation, j.pkgId, j.orderId, j.orderType, j.bizType, j.txHash, j.chainIndex, j.journalRevision],
    ['broadcast_submitted', 'direct-refund', 'pkg-1', 'order-1', 'AA', 200, '0x' + 'ef'.repeat(32), '196', 3]);
});

test('direct-refund: HTTP-2xx API rejection is definitive → journal cleared, refund_write_rejected', async () => {
  const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', 'close-rejected']);
  const d = r.json.data;
  assert.deepEqual([d.phase, d.decision, d.reason], ['refund_execution', 'blocked', 'refund_write_rejected']);
  assert.deepEqual(d.nextAction, prepareAgain(JOB));
  assert.equal(d.payload.capability.clientOperation, null);
  assert.equal(d.payload.capability.diagnostic, 'close result is unknown');
  assert.equal(existsSync(journalPath(r.home, JOB)), false);
  assert.equal(posts(r, '/task/broadcast').length, 0);
});

test('direct-refund: non-2xx lifecycle failure → outcome unknown, journal kept as unknown', async () => {
  const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', 'close-5xx']);
  const d = r.json.data;
  assert.deepEqual([d.phase, d.decision, d.reason], ['refund_settlement', 'blocked', 'refund_outcome_unknown']);
  assert.deepEqual(d.nextAction, reconcileActions(JOB));
  assert.equal(d.payload.settlement.error, 'close result is unknown');
  assert.equal(d.payload.settlement.retrySafe, false);
  assert.equal(d.payload.settlement.diagnostic, 'query_authoritative_state_before_retry');
  assert.equal(readJournal(r.home, JOB).state, 'unknown');
});

test('direct-refund: receipt missing a durable handle → outcome unknown', async () => {
  const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', 'close-ok', 'broadcast-noreceipt']);
  const d = r.json.data;
  assert.equal(d.reason, 'refund_outcome_unknown');
  assert.equal(d.payload.settlement.error, 'broadcast receipt result is unknown');
  assert.equal(readJournal(r.home, JOB).state, 'unknown');
});

test('direct-refund: failed backend preflight / mismatched jobId → prebroadcast failure, journal cleared', async () => {
  for (const [fx, diag] of [['close-preflight', /^backend transaction preflight failed: /], ['close-wrongjob', /^lifecycle endpoint returned a mismatched jobId$/]]) {
    const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', fx]);
    const d = r.json.data;
    assert.deepEqual([d.phase, d.decision, d.reason], ['refund_execution', 'blocked', 'refund_prebroadcast_failed'], fx);
    assert.match(d.payload.capability.diagnostic, diag);
    assert.equal(existsSync(journalPath(r.home, JOB)), false, fx);
  }
});

test('request-refund (one-time): pre-reject → EIP-712 sign → reject → broadcast with the reason', async () => {
  const reason = 'not delivered as agreed';
  const r = await runCli(execArgs(JOB, 'request-refund', 'refundctx_82e0f564da8234952ed659b34054e9bf3e95bafd9bb8f1f49a55d4514156d3a0', ['--reason', reason]),
    ['identity', 'task-submitted', 'reject-ok', 'sign', 'broadcast']);
  assert.equal(r.code, 0, r.stderr);
  const d = r.json.data;
  assert.deepEqual([d.phase, d.decision, d.reason], ['refund_settlement', 'ready', 'refund_request_broadcast_submitted']);
  assert.deepEqual(d.nextAction, [{ id: 'view_refund_status', params: { jobId: JOB }, recommend: false }]);
  assert.deepEqual(d.payload.request.providerNotification, { email: 'unknown', system: 'unknown' });
  const [pre] = posts(r, `/task/${JOB}/pre-reject`);
  const [rej] = posts(r, `/task/${JOB}/reject`);
  assert.deepEqual(Object.keys(pre.body).sort(), ['deadline', 'sessionCert']);
  assert.equal(rej.body.signatureData.deadline, pre.body.deadline);
  assert.equal(rej.body.signatureData.signature, '0x' + 'ee'.repeat(65));
  assert.equal(typeof rej.body.signatureData.nonce, 'string');
  assert.equal(posts(r, '/pre-transaction/gen-msg-hash').length, 1);
  assert.equal(posts(r, '/pre-transaction/sign-msg').length, 1);
  const [bc] = posts(r, '/task/broadcast');
  assert.deepEqual(bc.body.bizContext, { bizType: 202, jobId: JOB, reason });
  assert.equal(readJournal(r.home, JOB).state, 'broadcast_submitted');
});

test('subscription operations: request-refund / cancel-trial-conversion / close-created-subscription', async () => {
  const cases = [
    [execArgs(SUB, 'request-refund', 'refundctx_3c1b51c2b3fb3a36ec1200bac5b2c98c49591aca3cee935b5544400fb8839ef6', ['--reason', 'signals were wrong']),
      ['identity', 'sub-active', 'sub-reject', 'broadcast'], 'refund_request_broadcast_submitted', `/subscribe/${SUB}/reject`, 206],
    [execArgs(SUB, 'cancel-trial-conversion', 'refundctx_732cfe9fa8be340dea932ef0e3dfa600439e6cf5ff60f89eca59fc83ea054257'),
      ['identity', 'sub-trial', 'sub-cancel', 'broadcast'], 'trial_conversion_cancel_broadcast_submitted', `/subscribe/${SUB}/cancel`, 205],
    [execArgs(SUB, 'close-created-subscription', 'refundctx_7827e326a6bf15880aea7ece6bf22f0e59c32ab543488a31ea6e9087b1d68bba'),
      ['identity', 'sub-created', 'sub-cancel', 'broadcast'], 'created_subscription_close_broadcast_submitted', `/subscribe/${SUB}/cancel`, 205],
  ];
  for (const [args, fx, reason, path, bizType] of cases) {
    const r = await runCli(args, fx);
    assert.equal(r.code, 0, r.stderr);
    const d = r.json.data;
    assert.deepEqual([d.phase, d.decision, d.reason], ['refund_settlement', 'ready', reason], reason);
    assert.equal(posts(r, path).length, 1, reason);
    const [bc] = posts(r, '/task/broadcast');
    assert.equal(bc.body.bizContext.bizType, bizType, reason);
    assert.equal(d.payload.settlement.broadcastReceipt.bizType, bizType, reason);
    assert.equal(readJournal(r.home, SUB).state, 'broadcast_submitted', reason);
  }
});

test('close-zero: free created task closes through the same lifecycle endpoint', async () => {
  const r = await runCli(execArgs(JOB, 'close-zero', 'refundctx_718a7743ee11389cfd9320f3b677aa23509d50b8bee0c42829bc528f5b6ea761'),
    ['identity', 'task-free-created', 'close-ok', 'broadcast']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.data.reason, 'zero_amount_close_broadcast_submitted');
  assert.equal(readJournal(r.home, JOB).operation, 'close-zero');
});

test('a second prepare after a submitted broadcast reports pending reconciliation (journal replay guard)', async () => {
  const r = await runCli(execArgs(JOB, 'direct-refund', DIRECT_CTX), ['identity', 'task-direct', 'close-ok', 'broadcast']);
  assert.equal(r.json.data.reason, 'refund_broadcast_submitted');
  // Same home, task still Created(0): the journal must block a repeat and surface the receipt.
  active = ['identity', 'task-direct'].flatMap((n) => JSON.parse(readFileSync(join(FIXTURES, `agent-user-lifecycle-${n}.json`), 'utf8')));
  used = new Map();
  const env = { ...process.env, PATH: dirname(process.execPath), OCL_HOME: r.home, ONCHAINOS_HOME: r.home, OCL_BASE_URL: base, ONCHAINOS_CREDENTIAL_STORE: 'file', ONCHAINOS_FORCE_FILE_KEYRING: '1' };
  delete env.CLAUDECODE; delete env.CODEX_THREAD_ID;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, ENTRY, 'agent', 'refund-prepare', JOB], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const o = [];
    p.stdout.on('data', (c) => o.push(c));
    p.on('close', () => resolve(Buffer.concat(o).toString('utf8')));
  });
  const d = JSON.parse(out).data;
  assert.deepEqual([d.phase, d.decision, d.reason], ['refund_reconciliation', 'blocked', 'refund_operation_pending_reconciliation']);
  assert.equal(d.payload.settlement.state, 'broadcast_submitted');
  assert.equal(d.payload.settlement.broadcastReceipt.orderId, 'order-1');
  assert.equal(d.payload.capability.clientOperation, null);
});
